"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type MutableRefObject
} from "react";
import type { AuthSession, RoomSnapshot } from "@soqaro/shared";
import type { RoomSocket } from "@/lib/network/ws-client";
import type { RoomSnapshotResyncReason } from "@/features/room/room-snapshot-resync";
import type { RoomRecoveryMode } from "./room-runtime-types";
import {
  resolvePresenceRepairAction,
  resolveRoomRealtimeSnapshotInputs,
  resolveRoomSnapshotWatchdogAction
} from "./room-realtime-policy";

const presenceHeartbeatIntervalMs = 10_000;
export function useRoomRealtimeConnectionEffects(input: {
  roomSnapshot: RoomSnapshot | null;
  initialRoomId: string | null;
  hydrated: boolean;
  activeSession: AuthSession | null;
  activeSessionRef: MutableRefObject<AuthSession | null>;
  currentRoomRef: MutableRefObject<RoomSnapshot | null>;
  activeRouteRoomIdRef: MutableRefObject<string | null>;
  peerId: string;
  socketRef: MutableRefObject<RoomSocket | null>;
  isNavigatingRoomExit: boolean;
  uploadedTrackIds: string[];
  lastRealtimeRoomEventAtRef: MutableRefObject<number>;
  lastSubscribeAckAtRef: MutableRefObject<number | null>;
  recoveryGenerationRef: MutableRefObject<number | null>;
  recoveryModeRef: MutableRefObject<RoomRecoveryMode>;
  resubscribeRoomRef: MutableRefObject<(() => void) | null>;
  meshRef: MutableRefObject<{ restartPeer: (peerId: string) => Promise<unknown> } | null>;
  socketDisconnectGraceUntilRef: MutableRefObject<number | null>;
  requestRoomSnapshotResync: (
    reason: RoomSnapshotResyncReason,
    roomId?: string | null
  ) => Promise<void>;
}) {
  const {
    activeRouteRoomIdRef,
    activeSession,
    activeSessionRef,
    currentRoomRef,
    hydrated,
    initialRoomId,
    isNavigatingRoomExit,
    lastRealtimeRoomEventAtRef,
    peerId,
    requestRoomSnapshotResync,
    roomSnapshot,
    socketRef,
    uploadedTrackIds
  } = input;
  const {
    hasLocalMemberPresence,
    localMemberPeerId,
    localMemberPresenceState,
    snapshotMembersCount,
    snapshotPresenceRevision,
    snapshotRoomId
  } = resolveRoomRealtimeSnapshotInputs({
    roomSnapshot,
    activeSessionId: activeSession?.userId,
    fallbackUploadedTrackIds: uploadedTrackIds
  });
  const presenceIntervalRef = useRef<number | null>(null);
  const roomSnapshotWatchdogIntervalRef = useRef<number | null>(null);
  const presenceRepairKeyRef = useRef<string | null>(null);
  const initialRoomSnapshotResyncKeyRef = useRef<string | null>(null);

  const stopPresenceHeartbeat = useCallback(() => {
    if (presenceIntervalRef.current !== null) {
      window.clearInterval(presenceIntervalRef.current);
      presenceIntervalRef.current = null;
    }
  }, []);

  const stopRoomSnapshotWatchdog = useCallback(() => {
    if (roomSnapshotWatchdogIntervalRef.current !== null) {
      window.clearInterval(roomSnapshotWatchdogIntervalRef.current);
      roomSnapshotWatchdogIntervalRef.current = null;
    }
  }, []);

  const emitPresence = useCallback(() => {
    const currentSession = activeSessionRef.current;
    const currentRoomId = currentRoomRef.current?.room.id;
    if (!currentRoomId || !currentSession?.userId || !peerId) {
      return;
    }

    const socket = socketRef.current;
    if (!socket) {
      return;
    }
    if (socket.connected === false && typeof socket.connect === "function") {
      socket.connect();
      return;
    }

    socket.emit("room.presence", {
      roomId: currentRoomId,
      sessionId: currentSession.userId,
      peerId
    });
  }, [activeSessionRef, currentRoomRef, peerId, socketRef]);

  const startPresenceHeartbeat = useCallback(() => {
    emitPresence();
    stopPresenceHeartbeat();
    presenceIntervalRef.current = window.setInterval(
      emitPresence,
      presenceHeartbeatIntervalMs
    );
  }, [emitPresence, stopPresenceHeartbeat]);

  useEffect(() => {
    return () => {
      stopPresenceHeartbeat();
      stopRoomSnapshotWatchdog();
    };
  }, [stopPresenceHeartbeat, stopRoomSnapshotWatchdog]);

  useEffect(() => {
    if (
      !snapshotRoomId ||
      !hydrated ||
      !activeSession?.userId ||
      isNavigatingRoomExit
    ) {
      stopPresenceHeartbeat();
      return;
    }

    // The server renews both the presence record and the realtime session
    // lease from room.presence. Keep this running for the entire room
    // lifetime, including the normal "already online" state. A heartbeat
    // that only starts after an offline snapshot lets a healthy socket expire
    // while a background tab is throttled.
    startPresenceHeartbeat();
    return stopPresenceHeartbeat;
  }, [
    activeSession?.userId,
    hydrated,
    isNavigatingRoomExit,
    snapshotRoomId,
    startPresenceHeartbeat,
    stopPresenceHeartbeat
  ]);

  useEffect(() => {
    if (
      !snapshotRoomId ||
      !hydrated ||
      !activeSession?.userId ||
      isNavigatingRoomExit ||
      snapshotMembersCount <= 1
    ) {
      stopRoomSnapshotWatchdog();
      return;
    }

    lastRealtimeRoomEventAtRef.current = Date.now();
    stopRoomSnapshotWatchdog();
    roomSnapshotWatchdogIntervalRef.current = window.setInterval(() => {
      const activeRoomId = activeRouteRoomIdRef.current;
      const socket = socketRef.current;
      const watchdogAction = resolveRoomSnapshotWatchdogAction({
        activeRouteRoomId: activeRoomId,
        socketConnected: !!socket?.connected,
        snapshotRoomId,
        lastRealtimeRoomEventAtMs: lastRealtimeRoomEventAtRef.current,
        nowMs: Date.now(),
        staleAfterMs: 8_000
      });
      lastRealtimeRoomEventAtRef.current = watchdogAction.nextLastRealtimeRoomEventAtMs;
      if (watchdogAction.shouldRequestResync) {
        void requestRoomSnapshotResync("stale-watchdog", watchdogAction.resyncRoomId);
      }
    }, 4_000);

    return () => stopRoomSnapshotWatchdog();
  }, [
    activeRouteRoomIdRef,
    activeSession?.userId,
    hydrated,
    isNavigatingRoomExit,
    lastRealtimeRoomEventAtRef,
    requestRoomSnapshotResync,
    snapshotMembersCount,
    snapshotRoomId,
    socketRef,
    stopRoomSnapshotWatchdog
  ]);

  useEffect(() => {
    const presenceRepairAction = resolvePresenceRepairAction({
      snapshotRoomId,
      activeSessionId: activeSession?.userId,
      peerId,
      hasLocalMemberPresence,
      localMemberPeerId,
      localMemberPresenceState,
      snapshotPresenceRevision,
      previousRepairKey: presenceRepairKeyRef.current,
      socketConnected: !!socketRef.current?.connected
    });
    presenceRepairKeyRef.current = presenceRepairAction.nextRepairKey;
    if (!presenceRepairAction.shouldStartHeartbeat) {
      if (presenceRepairAction.shouldEmitPresence) {
        emitPresence();
      }
      return;
    }
    startPresenceHeartbeat();
    if (presenceRepairAction.shouldRequestResync && snapshotRoomId) {
      void requestRoomSnapshotResync("subscribe-ack", snapshotRoomId);
    }
  }, [
    emitPresence,
    activeSession?.userId,
    hasLocalMemberPresence,
    localMemberPeerId,
    localMemberPresenceState,
    peerId,
    requestRoomSnapshotResync,
    snapshotPresenceRevision,
    snapshotRoomId,
    socketRef,
    startPresenceHeartbeat
  ]);

  useEffect(() => {
    if (
      !initialRoomId ||
      !hydrated ||
      !activeSession?.userId ||
      isNavigatingRoomExit ||
      snapshotRoomId !== initialRoomId
    ) {
      if (!initialRoomId || snapshotRoomId !== initialRoomId) {
        initialRoomSnapshotResyncKeyRef.current = null;
      }
      return;
    }
    const resyncKey = `${activeSession.userId}:${initialRoomId}`;
    if (initialRoomSnapshotResyncKeyRef.current === resyncKey) {
      return;
    }
    initialRoomSnapshotResyncKeyRef.current = resyncKey;
    void requestRoomSnapshotResync("subscribe-ack", initialRoomId);
  }, [
    activeSession?.userId,
    hydrated,
    initialRoomId,
    isNavigatingRoomExit,
    requestRoomSnapshotResync,
    snapshotRoomId
  ]);

  return {
    emitPresence,
    startPresenceHeartbeat,
    stopPresenceHeartbeat
  };
}

