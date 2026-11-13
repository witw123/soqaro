"use client";

import type { PeerSignalMessage, PlaybackSnapshot, RoomSnapshot } from "@soqaro/shared";
import { shouldReplacePlaybackSnapshot } from "@/lib/domain/soqaro-ui";

export function createRoomRealtimeEventGate(initialSnapshot?: RoomSnapshot | null) {
  let latestRoomRevision = initialSnapshot?.room.roomRevision ?? 0;
  let latestPresenceRevision = initialSnapshot?.room.presenceRevision ?? 0;
  let latestPlayback: PlaybackSnapshot | null = initialSnapshot?.room.playback ?? null;

  const syncCurrentSnapshot = (snapshot: RoomSnapshot | null | undefined) => {
    if (!snapshot) {
      return;
    }
    latestRoomRevision = Math.max(latestRoomRevision, snapshot.room.roomRevision ?? 0);
    latestPresenceRevision = Math.max(
      latestPresenceRevision,
      snapshot.room.presenceRevision ?? 0
    );
    if (shouldReplacePlaybackSnapshot(latestPlayback, snapshot.room.playback)) {
      latestPlayback = snapshot.room.playback;
    }
  };

  return {
    acceptRoomRevision(
      incomingRevision: number | null | undefined,
      currentSnapshot?: RoomSnapshot | null
    ) {
      syncCurrentSnapshot(currentSnapshot);
      if (incomingRevision === null || incomingRevision === undefined) {
        return true;
      }
      if (incomingRevision < latestRoomRevision) {
        return false;
      }
      latestRoomRevision = incomingRevision;
      return true;
    },
    acceptPresenceRevision(
      incomingRevision: number,
      currentSnapshot?: RoomSnapshot | null,
      allowEqual = false,
      incomingRoomRevision?: number | null
    ) {
      syncCurrentSnapshot(currentSnapshot);
      if (
        incomingRoomRevision !== null &&
        incomingRoomRevision !== undefined &&
        incomingRoomRevision < latestRoomRevision
      ) {
        return false;
      }
      const accepted = allowEqual
        ? incomingRevision >= latestPresenceRevision
        : incomingRevision > latestPresenceRevision;
      if (accepted) {
        latestPresenceRevision = incomingRevision;
      }
      return accepted;
    },
    acceptPlayback(
      incomingPlayback: PlaybackSnapshot,
      currentSnapshot?: RoomSnapshot | null
    ) {
      syncCurrentSnapshot(currentSnapshot);
      const previousPlayback = latestPlayback;
      if (!shouldReplacePlaybackSnapshot(previousPlayback, incomingPlayback)) {
        return { accepted: false as const, previousPlayback };
      }
      latestPlayback = incomingPlayback;
      return { accepted: true as const, previousPlayback };
    }
  };
}
export function isSocketDisconnectGraceActive(disconnectGraceUntilMs: number | null, now = Date.now()) {
  return typeof disconnectGraceUntilMs === "number" && disconnectGraceUntilMs > now;
}

export function shouldSuppressPlaybackWatchdogEscalation(input: {
  recoverySuppressedReason: string | null;
  socketDisconnectGraceActive: boolean;
}) {
  return input.recoverySuppressedReason !== null || input.socketDisconnectGraceActive;
}

export function shouldResyncSnapshotForPlaybackPatch(input: {
  currentSnapshot: RoomSnapshot | null | undefined;
  playback: RoomSnapshot["room"]["playback"];
}) {
  const trackId = input.playback.currentTrackId;
  if (!trackId) {
    return false;
  }

  return !input.currentSnapshot?.tracks.some((track) => track.id === trackId);
}

export function shouldAcceptIncomingPeerSignal(input: {
  payload: PeerSignalMessage;
}) {
  return input.payload.channelKind === "data" &&
    (input.payload.linkKind === "data" || input.payload.linkKind === "media");
}

export function buildRoomSubscribePayload(input: {
  roomId: string;
  peerId: string;
  sessionId: string;
}) {
  return {
    roomId: input.roomId,
    sessionId: input.sessionId,
    peerId: input.peerId,
    protocolVersion: 4 as const,
    capabilities: ["webrtc-opus-v1" as const],
    buildId: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.3.1"
  };
}


export function shouldExitRoomOnSnapshotMissing(input: {
  currentRoomId: string;
  missingRoomId?: string | null;
}) {
  return !input.missingRoomId || input.missingRoomId === input.currentRoomId;
}

export function resolveRoomRealtimeSnapshotInputs(input: {
  roomSnapshot: RoomSnapshot | null;
  activeSessionId: string | null | undefined;
  fallbackUploadedTrackIds: string[];
}) {
  const localMemberPresence =
    input.roomSnapshot?.room.members.find((member) => member.id === input.activeSessionId) ??
    null;
  const snapshotTrackIds =
    input.roomSnapshot?.tracks.map((track) => track.id) ?? input.fallbackUploadedTrackIds;

  return {
    snapshotRoomId: input.roomSnapshot?.room.id ?? null,
    snapshotMembersCount: input.roomSnapshot?.room.members.length ?? 0,
    snapshotPresenceRevision: input.roomSnapshot?.room.presenceRevision ?? null,
    hasLocalMemberPresence: !!localMemberPresence,
    localMemberPeerId: localMemberPresence?.peerId ?? null,
    localMemberPresenceState: localMemberPresence?.presenceState ?? null,
    snapshotTrackIds,
    snapshotTrackIdsKey: snapshotTrackIds.join("|")
  };
}

export function resolvePresenceRepairAction(input: {
  snapshotRoomId: string | null;
  activeSessionId: string | null | undefined;
  peerId: string;
  hasLocalMemberPresence: boolean;
  localMemberPeerId: string | null;
  localMemberPresenceState: string | null;
  snapshotPresenceRevision: number | null;
  previousRepairKey: string | null;
  socketConnected: boolean;
}) {
  const idleAction = {
    nextRepairKey: null,
    shouldEmitPresence: false,
    shouldRequestResync: false,
    shouldStartHeartbeat: false
  };

  if (
    !input.snapshotRoomId ||
    !input.activeSessionId ||
    !input.peerId ||
    !input.hasLocalMemberPresence
  ) {
    return idleAction;
  }
  if (input.localMemberPresenceState === "online" && input.localMemberPeerId === input.peerId) {
    return idleAction;
  }

  const nextRepairKey = [
    input.snapshotRoomId,
    input.snapshotPresenceRevision,
    input.localMemberPeerId ?? "none",
    input.localMemberPresenceState,
    input.peerId
  ].join("|");
  if (input.previousRepairKey === nextRepairKey || !input.socketConnected) {
    return {
      ...idleAction,
      nextRepairKey
    };
  }

  return {
    nextRepairKey,
    shouldEmitPresence: true,
    shouldRequestResync: true,
    shouldStartHeartbeat: true
  };
}

export function resolveRoomSnapshotWatchdogAction(input: {
  activeRouteRoomId: string | null;
  socketConnected: boolean;
  snapshotRoomId: string | null;
  lastRealtimeRoomEventAtMs: number;
  nowMs: number;
  staleAfterMs: number;
}) {
  const idleAction = {
    nextLastRealtimeRoomEventAtMs: input.lastRealtimeRoomEventAtMs,
    resyncRoomId: null,
    shouldRequestResync: false
  };

  if (
    !input.activeRouteRoomId ||
    input.activeRouteRoomId !== input.snapshotRoomId ||
    !input.socketConnected
  ) {
    return idleAction;
  }
  if (input.nowMs - input.lastRealtimeRoomEventAtMs < input.staleAfterMs) {
    return idleAction;
  }

  return {
    nextLastRealtimeRoomEventAtMs: input.nowMs,
    resyncRoomId: input.snapshotRoomId,
    shouldRequestResync: true
  };
}

export function shouldResubscribeAfterPresenceOutcome(input: {
  timedOut: boolean;
  ack?: { ok?: boolean; reason?: string } | null;
  socketConnected: boolean;
  lastResubscribeAtMs: number | null;
  nowMs: number;
  cooldownMs: number;
}) {
  if (!input.socketConnected) {
    return false;
  }
  if (!input.timedOut && input.ack?.ok === true) {
    return false;
  }
  if (
    input.lastResubscribeAtMs !== null &&
    input.nowMs - input.lastResubscribeAtMs < input.cooldownMs
  ) {
    return false;
  }
  return true;
}
