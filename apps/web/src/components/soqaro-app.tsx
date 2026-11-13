"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { usePeerDiagnostics } from "@/features/p2p";
import { RoomAppShell } from "@/components/room/RoomAppShell";
import { useRouter } from "next/navigation";
import { useSessionIdentity } from "@/features/session/use-session-identity";
import { useTrackUploads } from "@/features/upload/use-track-uploads";
import { useRoomRuntime } from "@/features/room/hooks/use-room-runtime";
import { initialRoomStateStore, roomStateReducer } from "@/features/room/room-state-reducer";
import { useRoomPageDerived } from "@/features/room/hooks/use-room-page-derived";
import { useRoomPlaybackEffects } from "@/components/room/hooks/use-room-playback-effects";
import { useRoomPlaybackActions } from "@/features/room/hooks/use-room-playback-actions";
import { isSegmentedAudioOutputReady } from "@/features/room/hooks/use-room-playback-actions";
import { useRoomPageRoomActions } from "@/features/room/hooks/use-room-page-room-actions";
import { useRoomPageState } from "@/features/room/hooks/use-room-page-state";
import { useRoomWorkspaceViewModel } from "@/components/room/hooks/use-room-workspace-view-model";
import { useRoomClipboardActions } from "@/components/room/hooks/use-room-clipboard-actions";
import { useRoomAppEntries } from "@/components/room/hooks/use-room-app-entries";
import { useRoomAppRefs } from "@/components/room/hooks/use-room-app-refs";
import { useRoomSegmentedPlaybackRuntime } from "@/features/room/hooks/use-room-segmented-playback-runtime";
import { useRoomTrackAssetAutoPreparation } from "@/features/room/playback/room-track-asset-preparation";
import { getCurrentRoomMemberPermissions, isRoomHost } from "@/features/room/room-permissions";
import type { Route } from "next";
import type { RoomPlaybackReadinessInputPayload } from "@soqaro/shared";
import {
  awayRoomChangeEvent,
  clearAwayRoomId,
  readAwayRoomId,
  readAwayRoomResumeId,
  shouldCommitAwayRoomResume,
  storeAwayRoomId
} from "@/lib/domain/away-room";
import { peekRoomSnapshotHandoff } from "@/lib/domain/room-snapshot-handoff";
import { runRoomViewTransition } from "@/components/room-home/room-view-transition";

const lastRoomStorageKey = "soqaro-last-room";
const peerStorageKey = "soqaro-peer-id";

type SoqaroAppProps = {
  workspaceOnly?: boolean;
  initialRoomId?: string | null;
  backgroundOnly?: boolean;
};

export function SoqaroApp({
  workspaceOnly = true,
  initialRoomId = null,
  backgroundOnly = false
}: SoqaroAppProps) {
  const router = useRouter();
  const appEntries = useRoomAppEntries({
    initialRoomId
  });

  const [roomState, dispatchRoomStateEvent] = useReducer(
    roomStateReducer,
    initialRoomId,
    (roomId) => {
      if (!roomId) return initialRoomStateStore;
      const handoff = peekRoomSnapshotHandoff(roomId);
      if (!handoff) return initialRoomStateStore;
      return roomStateReducer(initialRoomStateStore, {
        type: "bootstrap-handoff",
        snapshot: handoff
      });
    }
  );
  const handoffSnapshot =
    initialRoomId && roomState.snapshot?.room.id !== initialRoomId
      ? peekRoomSnapshotHandoff(initialRoomId)
      : null;
  const roomSnapshot = handoffSnapshot ?? roomState.snapshot;
  const [peerId, setPeerId] = useState("");
  const [awayRoomId, setAwayRoomId] = useState<string | null>(null);
  const pendingRoomResumeRef = useRef<string | null>(null);
  const localAudibleRef = useRef<boolean | null>(null);
  const pageState = useRoomPageState({
    audioUnlocked: isSegmentedAudioOutputReady()
  });

  useEffect(() => {
    if (!initialRoomId) {
      setAwayRoomId(null);
      return;
    }

    const storedAwayRoomId = readAwayRoomId();
    if (storedAwayRoomId === initialRoomId) {
      setAwayRoomId(storedAwayRoomId);
    } else {
      setAwayRoomId(null);
      if (storedAwayRoomId) {
        clearAwayRoomId();
      }
    }

    const syncAwayRoomClear = () => {
      const latestAwayRoomId = readAwayRoomId();
      if (!latestAwayRoomId || latestAwayRoomId !== initialRoomId) {
        setAwayRoomId(null);
      }
    };

    window.addEventListener(awayRoomChangeEvent, syncAwayRoomClear);
    window.addEventListener("storage", syncAwayRoomClear);
    return () => {
      window.removeEventListener(awayRoomChangeEvent, syncAwayRoomClear);
      window.removeEventListener("storage", syncAwayRoomClear);
    };
  }, [initialRoomId]);

  const currentRoomId = roomSnapshot?.room.id ?? initialRoomId;
  const isRoomAway = Boolean(currentRoomId && awayRoomId === currentRoomId);

  function handleAwayRoom() {
    const targetRoomId = roomSnapshot?.room.id ?? initialRoomId;
    if (!targetRoomId) {
      return;
    }

    runRoomViewTransition(
      "room-exit",
      () => {
        storeAwayRoomId(targetRoomId);
        setStatusMessage("");
        router.push("/app" as Route);
      },
      { roomId: targetRoomId }
    );
  }

  const {
    activeSession,
    hasStoredSession,
    hydrated,
    statusMessage,
    setStatusMessage,
    clearIdentity,
    refreshSession
  } = useSessionIdentity({
    initialStatusMessage: "",
    sessionStorageKey: "soqaro-session"
  });

  useEffect(() => {
    if (!shouldCommitAwayRoomResume({
      backgroundOnly,
      initialRoomId,
      pendingRoomId: pendingRoomResumeRef.current,
      storedResumeRoomId: readAwayRoomResumeId()
    })) {
      return;
    }

    pendingRoomResumeRef.current = null;
    clearAwayRoomId();
    setAwayRoomId(null);
    setStatusMessage("已返回房间。");
  }, [backgroundOnly, initialRoomId, setStatusMessage]);

  const currentRoomPermissions = getCurrentRoomMemberPermissions(
    roomSnapshot,
    activeSession?.userId
  );
  const canControlPlayback = currentRoomPermissions?.player === true;
  const canDeleteRoom = isRoomHost(roomSnapshot, activeSession?.userId);
  const canReorderQueue = currentRoomPermissions?.queue === true;
  const pageDerived = useRoomPageDerived({
    activeSessionId: activeSession?.userId,
    peerId,
    roomSnapshot
  });
  const appRefs = useRoomAppRefs({
    roomPlayback: pageDerived.roomPlayback
  });
  const publishPlaybackReadiness = useCallback((payload: RoomPlaybackReadinessInputPayload) => {
    appRefs.socketRef.current?.emit("room.playback.readiness", payload);
  }, [appRefs.socketRef]);

  const { peerDiagnostics, peerRecentEvents, recordPeerDiagnostic, resetPeerDiagnostics } =
    usePeerDiagnostics({
      // Keep normal room rendering on the low-frequency diagnostics path.
      // Every stats sample updates the diagnostics object; flushing those
      // updates at 200ms while the room is open makes the whole workspace
      // re-render continuously and eventually starves button interaction.
      // The members/diagnostics surfaces opt into the faster view when open.
      highFrequencyEnabled:
        pageState.activeDashboardTab === "members" ||
        pageState.isDiagnosticsPanelOpen,
      highFrequencyFlushDelayMs: 200
    });

  const lastTelemetrySentAtRef = useRef(0);
  const lastTelemetryHealthKeyRef = useRef("");
  const telemetryDiagnosticsRef = useRef(peerDiagnostics);
  telemetryDiagnosticsRef.current = peerDiagnostics;
  useEffect(() => {
    const currentRoomId = roomSnapshot?.room.id;
    const currentUserId = activeSession?.userId;
    if (!currentRoomId || !currentUserId || !peerId || process.env.NEXT_PUBLIC_CLIENT_TELEMETRY_ENABLED === "false") return;
    const sendTelemetry = () => {
      const socket = appRefs.socketRef.current;
      if (!socket?.connected) return;
      const now = Date.now();
      if (now - lastTelemetrySentAtRef.current < 5_000) return;
      const peers = telemetryDiagnosticsRef.current.slice(0, 32).map((peer) => ({
        peerId: peer.peerId,
        updatedAt: peer.updatedAt,
        dataConnectionState: peer.dataConnectionState,
        mediaConnectionState: peer.mediaConnectionState,
        mediaIceState: peer.mediaIceState,
        dataIceState: peer.dataIceState,
        mediaCandidateType: peer.mediaCandidateType,
        mediaProtocol: peer.mediaProtocol,
        rttMs: peer.currentRoundTripTimeMs,
        sendBitrateKbps: peer.reportedSendRateKbps ?? peer.mediaSendBitrateKbps,
        receiveBitrateKbps: peer.reportedReceiveRateKbps ?? peer.mediaReceiveBitrateKbps,
        packetLossRate: peer.packetLossRate ?? null,
        jitterMs: peer.receiverJitterTargetMs ?? null,
        mediaTrackState: peer.remoteTrackStatus?.trackReadyState === "live" ? "live" as const : peer.remoteTrackStatus?.trackReadyState === "ended" ? "ended" as const : "none" as const,
        bufferedAheadMs: peer.segmentedPlaybackStatus?.bufferedAheadMs ?? null,
        scheduledAheadMs: peer.segmentedPlaybackStatus?.scheduledAheadMs ?? null,
        underrunCount: peer.segmentedPlaybackStatus?.underrunCount ?? null,
        playbackBitrateKbps: peer.targetAudioBitrateKbps ?? null,
        sourcePeerId: peer.segmentedPlaybackStatus?.sourcePeerId ?? null,
        playbackState: peer.segmentedPlaybackStatus?.listenerPlaybackState ?? null,
        audible: peer.reportedAudible ?? null,
        errorCode: peer.transportHealth === "failed" ? "media_failed" : null
      }));
      const payload = { protocolVersion: 1 as const, roomId: currentRoomId, sessionId: currentUserId, peerId, reportedAt: new Date().toISOString(), peers };
      try { socket.emit("diagnostics.report", payload); lastTelemetrySentAtRef.current = now; } catch { /* telemetry is best effort */ }
    };
    const intervalMs = document.visibilityState === "hidden" ? 30_000 : 15_000;
    const interval = window.setInterval(sendTelemetry, intervalMs);
    const healthKey = telemetryDiagnosticsRef.current.map((peer) => `${peer.peerId}:${peer.transportHealth}:${peer.mediaConnectionState}`).join("|");
    if (healthKey !== lastTelemetryHealthKeyRef.current) { lastTelemetryHealthKeyRef.current = healthKey; sendTelemetry(); }
    const onVisibility = () => { if (document.visibilityState === "visible") sendTelemetry(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", onVisibility); };
  }, [activeSession?.userId, appRefs.socketRef, peerId, roomSnapshot?.room.id]);
  const uploads = useTrackUploads({
    activeSession,
    roomSnapshot,
    dispatchRoomStateEvent,
    setStatusMessage
  });

  const roomActions = useRoomPageRoomActions({
    workspaceOnly,
    workspaceEntryHref: appEntries.workspaceEntryHref,
    authEntryHref: appEntries.authEntryHref,
    router,
    activeSession,
    audioRef: appRefs.audioRef,
    clearIdentity,
    currentPlaybackPositionRef: appRefs.currentPlaybackPositionRef,
    deleteRoomTrackArtifacts: uploads.deleteRoomTrackArtifacts,
    dispatchRoomStateEvent,
    peerId,
    peerStorageKey,
    resetPeerDiagnostics,
    roomSnapshot,
    setAvailableRooms: pageState.setAvailableRooms,
    setBufferHealth: pageState.setBufferHealth,
    setIsNavigatingRoomExit: pageState.setIsNavigatingRoomExit,
    setMediaConnectedPeers: pageState.setMediaConnectedPeers,
    setMediaConnectionState: pageState.setMediaConnectionState,
    setPeerId,
    setPlaybackStartRequest: pageState.setPlaybackStartRequest,
    setPlayerResetEpoch: pageState.setPlayerResetEpoch,
    setPlaylists: pageState.setPlaylists,
    setRoomRecoveryState: pageState.setRoomRecoveryState,
    setStatusMessage,
    setSuppressRoomRecovery: pageState.setSuppressRoomRecovery,
  });
  const roomRuntime = useRoomRuntime({
    workspaceOnly,
    initialRoomId,
    hydrated,
    authEntryHref: appEntries.authEntryHref,
    workspaceEntryHref: appEntries.workspaceEntryHref,
    router,
    lastRoomStorageKey,
    peerStorageKey,
    activeSession,
    hasStoredSession,
    activeSessionRef: appRefs.activeSessionRef,
    refreshSession,
    roomSnapshot,
    dispatchRoomStateEvent,
    currentRoomRef: appRefs.currentRoomRef,
    peerId,
    setPeerId,
    connectedPeers: pageState.connectedPeers,
    setConnectedPeers: pageState.setConnectedPeers,
    setMediaConnectedPeers: pageState.setMediaConnectedPeers,
    setPlaybackReadiness: pageState.setPlaybackReadiness,
    suppressRoomRecovery: pageState.suppressRoomRecovery,
    setSuppressRoomRecovery: pageState.setSuppressRoomRecovery,
    setIsRecoveringRoom: pageState.setIsRecoveringRoom,
    isNavigatingRoomExit: pageState.isNavigatingRoomExit,
    setIsNavigatingRoomExit: pageState.setIsNavigatingRoomExit,
    iceConfig: pageState.iceConfig,
    setIceConfig: pageState.setIceConfig,
    iceConfigResolved: pageState.iceConfigResolved,
    setIceConfigResolved: pageState.setIceConfigResolved,
    isPageVisible: pageState.isPageVisible,
    setIsPageVisible: pageState.setIsPageVisible,
    schedulerMode: pageState.schedulerMode,
    setSchedulerMode: pageState.setSchedulerMode,
    bufferHealth: pageState.bufferHealth,
    audioUnlocked: pageState.audioUnlocked,
    roomRecoveryState: pageState.roomRecoveryState,
    setRoomRecoveryState: pageState.setRoomRecoveryState,
    recordPeerDiagnostic,
    deleteUploadedTrackArtifacts: uploads.deleteUploadedTrackArtifacts,
    deleteRoomTrackArtifacts: uploads.deleteRoomTrackArtifacts,
    socketRef: appRefs.socketRef,
    localAudibleRef,
    resetPlayerSurface: roomActions.resetPlayerSurface,
    setStatusMessage,
    statusMessage,
    refreshPlaylists: roomActions.refreshPlaylists
  });
  const segmentedPlayback = useRoomSegmentedPlaybackRuntime({
    roomSnapshot, currentTrack: pageDerived.currentTrack, peerId,
    isCurrentSource: pageDerived.isCurrentSourceOwner,
    audioRef: appRefs.audioRef,
    volume: pageState.volume, audioUnlocked: pageState.audioUnlocked,
    setAudioUnlocked: pageState.setAudioUnlocked,
    setLocalAudioStream: roomRuntime.setLocalAudioStream,
    setMediaPlaybackEnabled: roomRuntime.setMediaPlaybackEnabled,
    getPeerMediaState: roomRuntime.getPeerMediaState,
    restartMediaPeer: roomRuntime.restartMediaPeer,
    subscribeRemoteAudioTrack: roomRuntime.subscribeRemoteAudioTrack,
    onPlaybackEnded: roomActions.nextTrack,
    setMediaConnectionState: pageState.setMediaConnectionState,
    setSourceStartState: pageState.setSourceStartState,
    setLastSourceStartError: pageState.setLastSourceStartError,
    setStatusMessage,
    recordPeerDiagnostic,
    audibleRef: localAudibleRef,
    playbackReadiness: pageState.playbackReadiness,
    publishPlaybackReadiness,
    activeSessionId: activeSession?.userId ?? null
  });
  useRoomTrackAssetAutoPreparation({
    roomId: roomSnapshot?.room.id,
    roomSnapshot,
    currentTrack: pageDerived.currentTrack,
    activeSessionId: activeSession?.userId ?? null
  });
  const playbackActions = useRoomPlaybackActions({
    currentPlaybackPositionRef: appRefs.currentPlaybackPositionRef,
    audioRef: appRefs.audioRef,
    roomSnapshot,
    currentPlaybackTrackId: pageDerived.currentPlaybackTrackId,
    playbackMediaEpoch: pageDerived.playbackMediaEpoch,
    playbackQueueVersion: pageDerived.playbackQueueVersion,
    playbackRevision: pageDerived.playbackRevision,
    playbackStatus: pageDerived.playbackStatus,
    isCurrentSourceOwner: pageDerived.isCurrentSourceOwner,
    audioUnlocked: pageState.audioUnlocked,
    handleTrackFilesSelected: uploads.handleFilesSelected,
    addToQueue: roomActions.addToQueue,
    playTrack: roomActions.playTrack,
    playQueueItem: roomActions.playQueueItem,
    prevTrack: roomActions.prevTrack,
    nextTrack: roomActions.nextTrack,
    recordPeerDiagnostic,
    setAudioBlockedOverlay: pageState.setAudioBlockedOverlay,
    setAudioUnlocked: pageState.setAudioUnlocked,
    setLastSourceStartError: pageState.setLastSourceStartError,
    setPlaybackStartRequest: pageState.setPlaybackStartRequest,
    setStatusMessage
  });
  useRoomPlaybackEffects({
    dispatchRoomStateEvent,
    initialRoomId
  });
  const clipboardActions = useRoomClipboardActions({
    roomSnapshot,
    setStatusMessage
  });

  const workspaceViewModel = useRoomWorkspaceViewModel({
    roomSnapshot,
    connectedPeers: pageState.connectedPeers,
    mediaConnectedPeers: pageState.mediaConnectedPeers,
    activeDashboardTab: pageState.activeDashboardTab,
    coarsePlayback: segmentedPlayback.coarsePlayback,
    peerDiagnostics,
    peerRecentEvents,
    canDeleteRoom,
    statusMessage,
    iceConfig: pageState.iceConfig,
    iceConfigResolved: pageState.iceConfigResolved,
    workspaceOnly,
    initialRoomId,
    activeSessionUserId: activeSession?.userId,
    suppressRoomRecovery: pageState.suppressRoomRecovery,
    isNavigatingRoomExit: pageState.isNavigatingRoomExit,
    isRecoveringRoom: pageState.isRecoveringRoom
  });

  return (
    <RoomAppShell
      activeSession={activeSession}
      audioRef={appRefs.audioRef}
      currentPlaybackPositionRef={appRefs.currentPlaybackPositionRef}
      authEntryHref={appEntries.authEntryHref}
      backgroundOnly={backgroundOnly}
      canControlPlayback={canControlPlayback}
      canDeleteRoom={canDeleteRoom}
      canReorderQueue={canReorderQueue}
      clipboardActions={clipboardActions}
      currentTrack={pageDerived.currentTrack}
      initialRoomId={initialRoomId}
      isSourceOwner={pageDerived.isCurrentSourceOwner}
      pageState={pageState}
      playbackActions={playbackActions}
      roomActions={roomActions}
      roomSnapshot={roomSnapshot}
      playbackBarrier={segmentedPlayback.playbackBarrier}
      socket={appRefs.socketRef.current}
      isRoomAway={isRoomAway}
      awayRoomId={isRoomAway ? currentRoomId : null}
      onAwayRoom={handleAwayRoom}
      statusMessage={statusMessage}
      uploads={uploads}
      workspaceEntryHref={appEntries.workspaceEntryHref}
      workspaceViewModel={workspaceViewModel}
    />
  );
}
