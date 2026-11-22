"use client";

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  AuthSession,
  PeerDiagnosticsSnapshot,
  PeerSignalMessage,
  RoomSubscribeAckPayload,
  RoomClockAckPayload,
  RoomPlaybackReadinessPayload,
  RoomTrackDeletedPayload,
  RoomSnapshotMissingPayload,
  RoomSnapshot,
  RoomChatMessage
} from "@soqaro/shared";
import { createRoomSocket, type RoomSocket } from "@/lib/network/ws-client";
import type { P2PMesh, RemoteAudioTrackListener } from "@/features/p2p";
import { createRoomDataMeshRuntime } from "./use-room-data-mesh";
import type { RoomSnapshotResyncReason } from "@/features/room/room-snapshot-resync";
import type { RoomStateEvent } from "@/features/room/room-state-reducer";
import { calibrateRoomPlaybackClock } from "@/features/playback/room-playback-clock";
import {
  notifyRoomQueueTrackAdded,
  notifyRoomTrackAddedToLibrary,
  notifyRoomChatMessage,
  notifyRoomMemberPresence
} from "@/features/playback/system-notifications";
import {
  setTrackAssetPreparationState,
  setTrackUnavailableReason
} from "@/features/room/playback/room-track-asset-preparation";
import type {
  PlaybackRecoveryRecommendation,
  RoomDataMeshDiagnosticsRefs,
  RoomRecoveryMode,
  RoomRecoveryState
} from "./room-runtime-types";
import {
  buildRoomSubscribePayload,
  createRoomRealtimeEventGate,
  shouldAcceptIncomingPeerSignal,
  shouldExitRoomOnSnapshotMissing,
  shouldResyncSnapshotForPlaybackPatch
} from "./room-realtime-policy";

const subscribeAckTimeoutMs = 4_000;
const subscribeRetryBackoffMs = [200, 500, 1_000, 2_000, 4_000] as const;
const socketDisconnectGraceMs = 6_000;

function compareReadinessUpdates(left: string, right: string) {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    return leftMs - rightMs;
  }
  return left.localeCompare(right);
}

// The room playback clock is a one-shot offset calibrated only at subscribe
// time. Client clocks drift and the offset is never re-converged, which makes
// a member's shared position estimate diverge from the audible audio (progress
// bar runs ahead of / behind sound). Recalibrate on an interval so the offset
// tracks the server clock instead of drifting until the next resubscribe.
const roomClockCalibrationIntervalMs = 60_000;
function applyRoomSubscribeBootstrap(input: {
  ack: RoomSubscribeAckPayload;
  activeRouteRoomIdRef: MutableRefObject<string | null>;
  currentRoomRef: MutableRefObject<RoomSnapshot | null>;
  lastSubscribeAckAtRef: MutableRefObject<number | null>;
  recoveryGenerationRef: MutableRefObject<number | null>;
  recoveryModeRef: MutableRefObject<RoomRecoveryMode>;
  dispatchRoomStateEvent: Dispatch<RoomStateEvent>;
  setRoomRecoveryState: Dispatch<SetStateAction<RoomRecoveryState>>;
  audioUnlocked: boolean;
}) {
  if (!input.ack.bootstrap || input.ack.bootstrap.roomId !== input.activeRouteRoomIdRef.current) {
    return false;
  }

  input.lastSubscribeAckAtRef.current = Date.now();
  const nextRecoveryMode =
    input.recoveryGenerationRef.current === null ? "late-join" : "rejoin";
  input.recoveryGenerationRef.current = input.ack.recoveryGeneration ?? null;
  input.recoveryModeRef.current = nextRecoveryMode;

  const currentMembers = input.currentRoomRef.current?.room.members ?? [];
  const mergedMembers = input.ack.bootstrap.members.map((member) => {
    const existing = currentMembers.find((entry) => entry.id === member.id);
    return {
      id: member.id,
      nickname: existing?.nickname ?? (member.role === "host" ? "房主" : "成员"),
      role: member.role,
      joinedAt: existing?.joinedAt ?? new Date().toISOString(),
      peerId: member.peerId ?? null,
      presenceState: member.presenceState
    };
  });

  input.dispatchRoomStateEvent({
    type: "subscribe-bootstrap",
    roomId: input.ack.bootstrap.roomId,
    members: mergedMembers,
    playback: input.ack.bootstrap.playback,
    presenceRevision: input.ack.bootstrap.presenceRevision,
    roomRevision: input.ack.bootstrap.roomRevision
  });

  input.setRoomRecoveryState((current) => ({
    ...current,
    phase: "resyncing",
    mode: nextRecoveryMode,
    generation: input.ack.recoveryGeneration ?? null,
    bootstrapStartedAt: input.ack.serverNow ?? new Date().toISOString(),
    bootstrapSourcePeerId: input.ack.bootstrap?.playback.sourcePeerId ?? null,
    pendingSnapshot: true,
    pendingData: false,
    pendingMedia: false,
    listenerBootstrapAttempts: current.listenerBootstrapAttempts ?? 0,
  }));

  return true;
}

export function createRoomSocketRuntime(input: {
  socketRef: MutableRefObject<RoomSocket | null>;
  recordPeerDiagnosticRef: RoomDataMeshDiagnosticsRefs["recordPeerDiagnosticRef"];
}) {
  const socket = createRoomSocket();
  input.socketRef.current = socket;

  const emitPeerSignal = (payload: PeerSignalMessage) => {
    const linkKind = payload.linkKind ?? "data";
    input.recordPeerDiagnosticRef.current({
      peerId: payload.toPeerId,
      channelKind: linkKind,
      direction: "sent",
      event: payload.type,
      summary: `向 ${payload.toPeerId} 发送 ${linkKind} ${payload.type}`,
      update: (snapshot: PeerDiagnosticsSnapshot) => ({
        ...snapshot,
        signalStats: {
          ...snapshot.signalStats,
          sentOffers: snapshot.signalStats.sentOffers + (payload.type === "offer" ? 1 : 0),
          sentAnswers: snapshot.signalStats.sentAnswers + (payload.type === "answer" ? 1 : 0),
          sentCandidates:
            snapshot.signalStats.sentCandidates + (payload.type === "candidate" ? 1 : 0)
        }
      })
    });
    socket.emit("peer.signal", payload);
  };

  const handleSignalFailure = (payload: PeerSignalMessage, error: unknown) => {
    const linkKind = payload.linkKind ?? "data";
    input.recordPeerDiagnosticRef.current({
      peerId: payload.fromPeerId,
      channelKind: linkKind,
      direction: "local",
      event: "signal-handle-failed",
      summary: `Failed to apply ${linkKind} ${payload.type} from ${payload.fromPeerId}: ${String(error)}`,
      level: "error"
    });
  };

  return {
    socket,
    emitPeerSignal,
    handleSignalFailure
  };
}

type RoomRealtimeRuntimeInput = {
  roomId: string;
  peerId: string;
  iceServersRef: MutableRefObject<RTCIceServer[]>;
  socketRef: MutableRefObject<RoomSocket | null>;
  meshRef: MutableRefObject<P2PMesh | null>;
  localAudibleRef: MutableRefObject<boolean | null>;
  currentRoomRef: MutableRefObject<RoomSnapshot | null>;
  updatePeerBufferedAmountRef: MutableRefObject<(peerId: string, bufferedAmountBytes: number) => void>;
  setConnectedPeers: Dispatch<SetStateAction<string[]>>;
  isPageVisible: boolean;
  playbackStatus: RoomSnapshot["room"]["playback"]["status"] | null | undefined;
  currentTrackId: string | null | undefined;
  bufferHealth: "healthy" | "low" | "critical";
  queuePlaybackRecoveryRecommendation?: (recommendation: PlaybackRecoveryRecommendation) => void;
  resubscribeRoomRef: MutableRefObject<(() => void) | null>;
  activeSessionRef: MutableRefObject<AuthSession | null>;
  activeRouteRoomIdRef: MutableRefObject<string | null>;
  requestRoomSnapshotResyncRef: MutableRefObject<
    (reason: RoomSnapshotResyncReason, roomId?: string | null) => Promise<void>
  >;
  deleteRoomTrackArtifactsRef: MutableRefObject<(trackIds: string[], roomId?: string, deleteRoomSnapshot?: boolean) => Promise<void> | void>;
  lastRealtimeRoomEventAtRef: MutableRefObject<number>;
  recoveryGenerationRef: MutableRefObject<number | null>;
  lastSubscribeAckAtRef: MutableRefObject<number | null>;
  recoveryModeRef: MutableRefObject<RoomRecoveryMode>;
  socketDisconnectGraceUntilRef: MutableRefObject<number | null>;
  socketDisconnectGraceTimeoutRef: MutableRefObject<number | null>;
  stopPresenceHeartbeat: () => void;
  clearSocketDisconnectGrace: () => void;
  dispatchRoomStateEvent: Dispatch<RoomStateEvent>;
  setRoomRecoveryState: Dispatch<SetStateAction<RoomRecoveryState>>;
  setMediaConnectedPeers: Dispatch<SetStateAction<string[]>>;
  setPlaybackReadiness: Dispatch<SetStateAction<RoomPlaybackReadinessPayload[]>>;
  setStatusMessage: (value: string) => void;
  audioUnlocked: boolean;
  startPresenceHeartbeatRef: MutableRefObject<() => void>;
  exitCurrentRoomRef: MutableRefObject<(message: string) => void>;
  shouldAcceptIncomingPeerSignalRecoveryGeneration: (input: {
    payloadRecoveryGeneration: number | null | undefined;
    currentRecoveryGeneration: number | null;
  }) => boolean;
  onRemoteAudioTrack?: RemoteAudioTrackListener;
} & RoomDataMeshDiagnosticsRefs;

type RoomSocketHandlersInput = RoomRealtimeRuntimeInput & {
  socket: RoomSocket;
  mesh: P2PMesh;
  resyncRealtimePeers: (members?: Array<{ peerId: string | null }>) => void;
  handleSignalFailure: (payload: PeerSignalMessage, error: unknown) => void;
};

export function createRoomRealtimeRuntime(input: RoomRealtimeRuntimeInput) {
  const { socket, emitPeerSignal, handleSignalFailure } = createRoomSocketRuntime({
    socketRef: input.socketRef,
    recordPeerDiagnosticRef: input.recordPeerDiagnosticRef
  });
  const { mesh, resyncRealtimePeers } = createRoomDataMeshRuntime({
    roomId: input.roomId,
    peerId: input.peerId,
    emitPeerSignal,
    iceServersRef: input.iceServersRef,
    meshRef: input.meshRef,
    localAudibleRef: input.localAudibleRef,
    currentRoomRef: input.currentRoomRef,
    recordPeerDiagnosticRef: input.recordPeerDiagnosticRef,
    updatePeerBufferedAmountRef: input.updatePeerBufferedAmountRef,
    updateDataTransportStatsRef: input.updateDataTransportStatsRef,
    updateMediaTransportStatsRef: input.updateMediaTransportStatsRef,
    connectionSupervisorStatesRef: input.connectionSupervisorStatesRef,
    updateConnectionSupervisorSignalState: input.updateConnectionSupervisorSignalState,
    updateConnectionSupervisorTransportStats: input.updateConnectionSupervisorTransportStats,
    withResolvedTransportHealth: input.withResolvedTransportHealth,
    withSupervisorDiagnosticPatch: input.withSupervisorDiagnosticPatch,
    setConnectedPeers: input.setConnectedPeers,
    setMediaConnectedPeers: input.setMediaConnectedPeers,
    isPageVisible: input.isPageVisible,
    playbackStatus: input.playbackStatus,
    currentTrackId: input.currentTrackId,
    bufferHealth: input.bufferHealth,
    queuePlaybackRecoveryRecommendation: input.queuePlaybackRecoveryRecommendation,
    onRemoteAudioTrack: input.onRemoteAudioTrack,
    reportMeshResyncFailure: (error) => {
      input.recordPeerDiagnosticRef.current({
        peerId: "system",
        channelKind: "system",
        direction: "local",
        event: "mesh-resync-failed",
        summary: `Failed to resync data peers: ${String(error)}`,
        level: "error"
      });
    }
  });

  return attachRoomSocketHandlers({
    ...input,
    socket,
    mesh,
    resyncRealtimePeers,
    handleSignalFailure
  });
}

function attachRoomSocketHandlers(input: RoomSocketHandlersInput) {
  const socket = input.socket;
  const realtimeEventGate = createRoomRealtimeEventGate(input.currentRoomRef.current);
  let subscribeRetryId: number | null = null;
  let subscribeAckTimeoutId: number | null = null;
  let subscribeRequestSequence = 0;
  let clockCalibrationIntervalId: number | null = null;

  const stopClockCalibrationInterval = () => {
    if (clockCalibrationIntervalId !== null) {
      window.clearInterval(clockCalibrationIntervalId);
      clockCalibrationIntervalId = null;
    }
  };

  const startClockCalibrationInterval = () => {
    if (clockCalibrationIntervalId !== null) {
      return;
    }
    clockCalibrationIntervalId = window.setInterval(() => {
      const currentSocket = input.socketRef.current;
      if (!currentSocket?.connected) {
        return;
      }
      const requestStartedAtMs = Date.now();
      currentSocket.emit(
        "room.clock",
        { roomId: input.roomId },
        (ack?: RoomClockAckPayload) => {
          if (!ack?.serverNow) {
            return;
          }
          calibrateRoomPlaybackClock({
            serverNow: ack.serverNow,
            requestStartedAtMs,
            responseReceivedAtMs: Date.now()
          });
        }
      );
    }, roomClockCalibrationIntervalMs);
  };

  const clearSubscribeTimers = () => {
    if (subscribeRetryId !== null) {
      window.clearTimeout(subscribeRetryId);
      subscribeRetryId = null;
    }
    if (subscribeAckTimeoutId !== null) {
      window.clearTimeout(subscribeAckTimeoutId);
      subscribeAckTimeoutId = null;
    }
  };

  const scheduleSubscribeRetry = (attempt: number) => {
    if (subscribeRetryId !== null) {
      return;
    }
    const delayMs =
      subscribeRetryBackoffMs[Math.min(attempt, subscribeRetryBackoffMs.length - 1)] ??
      subscribeRetryBackoffMs[subscribeRetryBackoffMs.length - 1];
    subscribeRetryId = window.setTimeout(() => {
      subscribeRetryId = null;
      subscribeToRoom(attempt);
    }, delayMs);
  };

  const subscribeToRoom = (attempt = 0) => {
    const activeSessionId = input.activeSessionRef.current?.userId;
    if (!activeSessionId || input.activeRouteRoomIdRef.current !== input.roomId) {
      return;
    }

    if (subscribeAckTimeoutId !== null) {
      window.clearTimeout(subscribeAckTimeoutId);
    }
    subscribeAckTimeoutId = window.setTimeout(() => {
      subscribeAckTimeoutId = null;
      scheduleSubscribeRetry(attempt + 1);
    }, subscribeAckTimeoutMs);

    const subscribeStartedAtMs = Date.now();
    const requestSequence = ++subscribeRequestSequence;
    socket.emit(
      "room.subscribe",
      buildRoomSubscribePayload({
        roomId: input.roomId,
        peerId: input.peerId,
        sessionId: activeSessionId
      }),
      (ack: RoomSubscribeAckPayload) => {
        if (requestSequence !== subscribeRequestSequence) {
          return;
        }
        const subscribeCompletedAtMs = Date.now();
        calibrateRoomPlaybackClock({
          serverNow: ack.serverNow,
          requestStartedAtMs: subscribeStartedAtMs,
          responseReceivedAtMs: subscribeCompletedAtMs
        });
        if (subscribeAckTimeoutId !== null) {
          window.clearTimeout(subscribeAckTimeoutId);
          subscribeAckTimeoutId = null;
        }

        if (!ack.ok) {
          scheduleSubscribeRetry(attempt + 1);
          return;
        }

        const bootstrapApplied = applyRoomSubscribeBootstrap({
          ack,
          activeRouteRoomIdRef: input.activeRouteRoomIdRef,
          currentRoomRef: input.currentRoomRef,
          lastSubscribeAckAtRef: input.lastSubscribeAckAtRef,
          recoveryGenerationRef: input.recoveryGenerationRef,
          recoveryModeRef: input.recoveryModeRef,
          dispatchRoomStateEvent: input.dispatchRoomStateEvent,
          setRoomRecoveryState: input.setRoomRecoveryState,
          audioUnlocked: input.audioUnlocked
        });
        if (bootstrapApplied) {
          // The subscribe ack is the first authoritative source of live peer
          // ids after a join/reconnect. Sync immediately so media negotiation
          // does not depend on a later room snapshot or presence patch.
          input.resyncRealtimePeers(ack.bootstrap?.members ?? []);
          input.startPresenceHeartbeatRef.current();
          startClockCalibrationInterval();
        }
      }
    );
  };

  input.resubscribeRoomRef.current = () => {
    clearSubscribeTimers();
    if (!socket.connected) {
      // Socket.IO will perform the subscribe on its connect callback. Do not
      // buffer a second room.subscribe packet while the transport is down.
      socket.connect();
      return;
    }
    subscribeToRoom();
    void input.requestRoomSnapshotResyncRef.current("subscribe-ack", input.roomId);
  };

  socket.on("connect", () => {
    input.clearSocketDisconnectGrace();
    subscribeToRoom();
    input.resyncRealtimePeers();
    void input.requestRoomSnapshotResyncRef.current("socket-connect", input.roomId);
  });

  socket.on("room.snapshot", (snapshot: RoomSnapshot) => {
    if (snapshot.room.id !== input.roomId || input.activeRouteRoomIdRef.current !== input.roomId) {
      return;
    }

    const currentSnapshot = input.currentRoomRef.current;
    input.dispatchRoomStateEvent({
      type: "server-snapshot",
      snapshot
    });
    if (
      !realtimeEventGate.acceptRoomRevision(
        snapshot.room.roomRevision,
        currentSnapshot
      )
    ) {
      return;
    }
    realtimeEventGate.acceptPlayback(snapshot.room.playback, currentSnapshot);
    realtimeEventGate.acceptPresenceRevision(
      snapshot.room.presenceRevision,
      currentSnapshot,
      true,
      snapshot.room.roomRevision
    );
    input.lastRealtimeRoomEventAtRef.current = Date.now();
    // A full snapshot is authoritative for both room state and the live peer
    // topology. Reconcile it even when the React ref still contains the
    // previous snapshot, otherwise a missed presence event can leave the
    // media peer absent while the data peer remains visible.
    input.resyncRealtimePeers(snapshot.room.members);
    input.setRoomRecoveryState((current: RoomRecoveryState) => ({
      ...current,
      phase: "steady",
      pendingSnapshot: false,
      pendingData: false,
      pendingMedia: false
    }));
  });

  socket.on("room.playback.patch", ({ playback, roomRevision }) => {
    if (input.activeRouteRoomIdRef.current !== input.roomId) {
      return;
    }
    const currentSnapshot = input.currentRoomRef.current;
    input.dispatchRoomStateEvent({
      type: "server-playback-patch",
      roomId: input.roomId,
      playback,
      roomRevision
    });
    if (!currentSnapshot) {
      void input.requestRoomSnapshotResyncRef.current("realtime-room-event", input.roomId);
      return;
    }
    const playbackAcceptance = realtimeEventGate.acceptPlayback(playback, currentSnapshot);
    if (!playbackAcceptance.accepted) {
      return;
    }
    if (
      shouldResyncSnapshotForPlaybackPatch({
        currentSnapshot,
        playback
      })
    ) {
      void input.requestRoomSnapshotResyncRef.current("realtime-room-event", input.roomId);
    }
  });

function notifyNewlyAddedQueueItems(input: {
  incomingQueue: RoomSnapshot["queue"];
  currentSnapshot: RoomSnapshot | null;
  tracksPool?: RoomSnapshot["tracks"];
  currentUserId?: string | null;
}) {
  const { currentSnapshot, incomingQueue, tracksPool, currentUserId } = input;
  if (!currentSnapshot || incomingQueue.length === 0) return;
  const existingIds = new Set(currentSnapshot.queue.map((item) => item.id));
  const newItems = incomingQueue.filter((item) => !existingIds.has(item.id));
  if (newItems.length === 0) return;

  const tracks = tracksPool ?? currentSnapshot.tracks;
  for (const item of newItems) {
    const track = tracks.find((t) => t.id === item.trackId);
    notifyRoomQueueTrackAdded({
      title: track?.title ?? "新歌曲",
      artist: track?.artist ?? null,
      artworkUrl: track?.artworkUrl ?? null,
      requestedBy: item.requestedBy,
      requestedById: item.requestedById,
      currentUserId,
      roomTitle: currentSnapshot.room.name ?? null
    });
  }
}

function notifyNewlyAddedLibraryTracks(input: {
  incomingTracks: RoomSnapshot["tracks"];
  currentSnapshot: RoomSnapshot | null;
  currentUserId?: string | null;
}) {
  const { currentSnapshot, incomingTracks, currentUserId } = input;
  if (!currentSnapshot || incomingTracks.length === 0) return;
  const existingIds = new Set(currentSnapshot.tracks.map((t) => t.id));
  const newTracks = incomingTracks.filter((t) => !existingIds.has(t.id));
  if (newTracks.length === 0) return;

  for (const track of newTracks) {
    notifyRoomTrackAddedToLibrary({
      title: track.title,
      artist: track.artist ?? null,
      artworkUrl: track.artworkUrl ?? null,
      addedBy: track.ownerNickname ?? "房间成员",
      addedById: track.ownerSessionId ?? null,
      currentUserId,
      roomTitle: currentSnapshot.room.name ?? null
    });
  }
}

function notifyMemberPresenceChanges(input: {
  incomingMembers: RoomSnapshot["room"]["members"];
  currentSnapshot: RoomSnapshot | null;
  currentUserId?: string | null;
}) {
  const { currentSnapshot, incomingMembers, currentUserId } = input;
  if (!currentSnapshot) return;
  const currentMembers = currentSnapshot.room.members;
  const currentMemberMap = new Map(currentMembers.map((m) => [m.id, m]));
  const incomingMemberMap = new Map(incomingMembers.map((m) => [m.id, m]));

  for (const member of incomingMembers) {
    if (!currentMemberMap.has(member.id)) {
      notifyRoomMemberPresence({
        nickname: member.nickname,
        action: "joined",
        isHost: member.role === "host",
        memberId: member.id,
        currentUserId,
        roomTitle: currentSnapshot.room.name ?? null
      });
    } else {
      const prev = currentMemberMap.get(member.id);
      if (prev && prev.presenceState !== member.presenceState) {
        notifyRoomMemberPresence({
          nickname: member.nickname,
          action: member.presenceState === "online" ? "online" : "offline",
          isHost: member.role === "host",
          memberId: member.id,
          currentUserId,
          roomTitle: currentSnapshot.room.name ?? null
        });
      }
    }
  }

  for (const member of currentMembers) {
    if (!incomingMemberMap.has(member.id)) {
      notifyRoomMemberPresence({
        nickname: member.nickname,
        action: "left",
        isHost: member.role === "host",
        memberId: member.id,
        currentUserId,
        roomTitle: currentSnapshot.room.name ?? null
      });
    }
  }
}

  socket.on("room.queue.patch", ({ queue, playback, roomRevision }) => {
    if (input.activeRouteRoomIdRef.current !== input.roomId) {
      return;
    }
    const currentSnapshot = input.currentRoomRef.current;
    notifyNewlyAddedQueueItems({
      incomingQueue: queue,
      currentSnapshot,
      currentUserId: input.activeSessionRef.current?.userId
    });
    input.dispatchRoomStateEvent({
      type: "server-queue-patch",
      roomId: input.roomId,
      queue,
      playback,
      roomRevision
    });
    if (!currentSnapshot) {
      void input.requestRoomSnapshotResyncRef.current("realtime-room-event", input.roomId);
      return;
    }
    const topologyAccepted = realtimeEventGate.acceptRoomRevision(
      roomRevision,
      currentSnapshot
    );
    const playbackAcceptance = realtimeEventGate.acceptPlayback(playback, currentSnapshot);
    if (!topologyAccepted && !playbackAcceptance.accepted) {
      return;
    }
    input.lastRealtimeRoomEventAtRef.current = Date.now();
  });

  socket.on("room.presence.patch", ({ members, playback, presenceRevision, roomRevision }) => {
    if (input.activeRouteRoomIdRef.current !== input.roomId) {
      return;
    }
    const currentSnapshot = input.currentRoomRef.current;
    notifyMemberPresenceChanges({
      incomingMembers: members,
      currentSnapshot,
      currentUserId: input.activeSessionRef.current?.userId
    });
    if (!currentSnapshot) {
      void input.requestRoomSnapshotResyncRef.current("realtime-room-event", input.roomId);
      return;
    }
    const presenceAccepted = realtimeEventGate.acceptPresenceRevision(
      presenceRevision,
      currentSnapshot,
      false,
      roomRevision
    );
    const playbackAcceptance = realtimeEventGate.acceptPlayback(playback, currentSnapshot);
    if (!presenceAccepted && !playbackAcceptance.accepted) {
      return;
    }
    input.dispatchRoomStateEvent({
      type: "server-presence-patch",
      roomId: input.roomId,
      members: presenceAccepted ? members : currentSnapshot.room.members,
      playback,
      presenceRevision: presenceAccepted
        ? presenceRevision
        : currentSnapshot.room.presenceRevision,
      roomRevision
    });
    realtimeEventGate.acceptRoomRevision(roomRevision, currentSnapshot);
    input.lastRealtimeRoomEventAtRef.current = Date.now();
    if (presenceAccepted) {
      input.resyncRealtimePeers(members);
    }
  });

  socket.on("room.library.patch", ({ tracks, queue, playback, roomRevision }) => {
    if (input.activeRouteRoomIdRef.current !== input.roomId) {
      return;
    }
    const currentSnapshot = input.currentRoomRef.current;
    notifyNewlyAddedQueueItems({
      incomingQueue: queue,
      currentSnapshot,
      tracksPool: tracks,
      currentUserId: input.activeSessionRef.current?.userId
    });
    notifyNewlyAddedLibraryTracks({
      incomingTracks: tracks,
      currentSnapshot,
      currentUserId: input.activeSessionRef.current?.userId
    });
    if (currentSnapshot?.room.id === input.roomId) {
      const nextTrackIds = new Set(tracks.map((track) => track.id));
      const removedTrackIds = currentSnapshot.tracks
        .map((track) => track.id)
        .filter((trackId) => !nextTrackIds.has(trackId));
      if (removedTrackIds.length > 0) {
        void input.deleteRoomTrackArtifactsRef.current(removedTrackIds, input.roomId);
      }
    }
    input.dispatchRoomStateEvent({
      type: "server-library-patch",
      roomId: input.roomId,
      tracks,
      queue,
      playback,
      roomRevision
    });
    if (!currentSnapshot) {
      void input.requestRoomSnapshotResyncRef.current("realtime-room-event", input.roomId);
      return;
    }
    const topologyAccepted = realtimeEventGate.acceptRoomRevision(
      roomRevision,
      currentSnapshot
    );
    const playbackAcceptance = realtimeEventGate.acceptPlayback(playback, currentSnapshot);
    if (!topologyAccepted && !playbackAcceptance.accepted) {
      return;
    }
    input.lastRealtimeRoomEventAtRef.current = Date.now();
  });

  socket.on("room.track.asset.ready", (payload) => {
    if (
      payload.roomId !== input.roomId ||
      input.activeRouteRoomIdRef.current !== input.roomId
    ) {
      return;
    }
    setTrackAssetPreparationState(payload.trackId, "ready");
    setTrackUnavailableReason(payload.trackId, null);
  });

  socket.on("room.track.asset.unavailable", (payload) => {
    if (
      payload.roomId !== input.roomId ||
      input.activeRouteRoomIdRef.current !== input.roomId
    ) {
      return;
    }
    const state = payload.reason === "source-missing" ? "source-missing" : "failed";
    setTrackAssetPreparationState(payload.trackId, state);
    setTrackUnavailableReason(payload.trackId, payload.reason);
  });

  socket.on("room.chat", (message: RoomChatMessage) => {
    if (input.activeRouteRoomIdRef.current !== input.roomId) {
      return;
    }
    notifyRoomChatMessage({
      senderName: message.senderName,
      senderId: message.senderId,
      content: message.content,
      currentUserId: input.activeSessionRef.current?.userId,
      roomTitle: input.currentRoomRef.current?.room.name ?? null
    });
  });

  socket.on("room.playback.readiness", (payload) => {
    if (
      payload.roomId !== input.roomId ||
      input.activeRouteRoomIdRef.current !== input.roomId
    ) {
      return;
    }
    input.setPlaybackReadiness((current) => {
      const previous = current.find((item) => item.sessionId === payload.sessionId);
      if (previous && compareReadinessUpdates(payload.updatedAt, previous.updatedAt) <= 0) {
        return current;
      }
      return [
        ...current.filter((item) => item.sessionId !== payload.sessionId),
        payload
      ];
    });
  });

  socket.on("room.track.deleted", (payload: RoomTrackDeletedPayload) => {
    if (payload.roomId !== input.roomId || input.activeRouteRoomIdRef.current !== input.roomId) {
      return;
    }
    void input.deleteRoomTrackArtifactsRef.current([payload.trackId], input.roomId);
    input.dispatchRoomStateEvent({
      type: "server-track-deleted",
      roomId: input.roomId,
      trackId: payload.trackId,
      roomRevision: payload.roomRevision
    });
    input.lastRealtimeRoomEventAtRef.current = Date.now();
  });

  socket.on("peer.signal", (payload) => {
    if (payload.roomId !== input.roomId || input.activeRouteRoomIdRef.current !== input.roomId) {
      return;
    }
    if (!shouldAcceptIncomingPeerSignal({ payload })) {
      return;
    }
    if (
      !input.shouldAcceptIncomingPeerSignalRecoveryGeneration({
        payloadRecoveryGeneration: payload.recoveryGeneration,
        currentRecoveryGeneration: input.recoveryGenerationRef.current
      })
    ) {
      input.recordPeerDiagnosticRef.current({
        peerId: payload.fromPeerId,
        channelKind: payload.linkKind ?? "data",
        direction: "received",
        event: "stale-signal-dropped",
        summary: `丢弃旧恢复代次信令 ${payload.recoveryGeneration}`,
        level: "warning",
        recordEvent: false
      });
      return;
    }
    if (
      payload.type === "offer" &&
      !input.currentRoomRef.current?.room.members.some(
        (member) => member.peerId === payload.fromPeerId
      )
    ) {
      // The joining member may already have the authoritative subscribe
      // bootstrap while this browser missed its presence patch. Repair the
      // member list immediately; the mesh grants this offer only a short
      // provisional admission until the snapshot confirms it.
      void input.requestRoomSnapshotResyncRef.current(
        "realtime-room-event",
        input.roomId
      );
    }

    input.recordPeerDiagnosticRef.current({
      peerId: payload.fromPeerId,
      channelKind: payload.linkKind ?? "data",
      direction: "received",
      event: payload.type,
      summary: `收到 ${payload.fromPeerId} 的 ${payload.linkKind ?? "data"} ${payload.type}`,
      update: (snapshot: PeerDiagnosticsSnapshot) => ({
        ...snapshot,
        signalStats: {
          ...snapshot.signalStats,
          receivedOffers: snapshot.signalStats.receivedOffers + (payload.type === "offer" ? 1 : 0),
          receivedAnswers:
            snapshot.signalStats.receivedAnswers + (payload.type === "answer" ? 1 : 0),
          receivedCandidates:
            snapshot.signalStats.receivedCandidates + (payload.type === "candidate" ? 1 : 0)
        }
      })
    });
    if (!input.mesh) {
      return;
    }
    void input.mesh.handleSignal(payload).catch((error: unknown) => {
      input.handleSignalFailure(payload, error);
    });
  });

  socket.on("room.session.replaced", ({ roomId }) => {
    if (roomId === input.roomId) {
      input.exitCurrentRoomRef.current("当前账号已在其他窗口加入此房间。");
    }
  });

  socket.on("room.member.removed", ({ roomId, memberId }) => {
    if (roomId === input.roomId && memberId === input.activeSessionRef.current?.userId) {
      input.exitCurrentRoomRef.current("你已被房主移出房间。");
    }
  });

  socket.on("session.revoked", () => {
    // Server-side account invalidation must stop reconnect loops before the
    // regular auth hook clears localStorage and redirects the user.
    input.activeSessionRef.current = null;
    window.localStorage.removeItem("soqaro-session");
    window.dispatchEvent(new CustomEvent("soqaro-auth-expired", { detail: { reason: "session-revoked" } }));
    input.exitCurrentRoomRef.current("登录已被管理员撤销，请重新登录。");
  });

  socket.on("room.deleted", ({ roomId, trackIds }) => {
    if (roomId !== input.roomId) {
      return;
    }
    void input.deleteRoomTrackArtifactsRef.current(trackIds, roomId, true);
    input.exitCurrentRoomRef.current("这个房间已被删除。");
  });

  socket.on("room.snapshot.missing", (payload?: RoomSnapshotMissingPayload) => {
    if (
      shouldExitRoomOnSnapshotMissing({
        currentRoomId: input.roomId,
        missingRoomId: payload?.roomId
      })
    ) {
      input.exitCurrentRoomRef.current("这个房间已不可用，请重新创建或加入房间。");
      return;
    }

    void input.requestRoomSnapshotResyncRef.current("subscribe-ack", input.roomId);
  });

  socket.on("disconnect", () => {
    input.socketDisconnectGraceUntilRef.current = Date.now() + socketDisconnectGraceMs;
    if (input.socketDisconnectGraceTimeoutRef.current !== null) {
      window.clearTimeout(input.socketDisconnectGraceTimeoutRef.current);
    }
    input.socketDisconnectGraceTimeoutRef.current = window.setTimeout(() => {
      input.socketDisconnectGraceUntilRef.current = null;
      input.socketDisconnectGraceTimeoutRef.current = null;
    }, socketDisconnectGraceMs);
  });

  subscribeToRoom();

  return () => {
    clearSubscribeTimers();
    stopClockCalibrationInterval();
    input.stopPresenceHeartbeat();
    input.setPlaybackReadiness([]);
    input.resubscribeRoomRef.current = null;
    socket.emit("room.unsubscribe", { roomId: input.roomId });
    socket.removeAllListeners();
    input.mesh.destroy();
    input.meshRef.current = null;
    input.socketRef.current = null;
    socket.disconnect();
  };
}
