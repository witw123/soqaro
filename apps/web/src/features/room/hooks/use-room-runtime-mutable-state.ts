"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import type { AuthSession, RoomSnapshot } from "@soqaro/shared";
import type { P2PMesh } from "@/features/p2p";
import type { PeerDiagnosticRecorder } from "@/features/p2p/use-peer-diagnostics";

export function useRoomRuntimeMutableState(input: {
  initialRoomId: string | null;
  roomSnapshot: RoomSnapshot | null;
  currentRoomRef: MutableRefObject<RoomSnapshot | null>;
  activeSession: AuthSession | null;
  activeSessionRef: MutableRefObject<AuthSession | null>;
  deleteRoomTrackArtifacts: (trackIds: string[], roomId?: string, deleteRoomSnapshot?: boolean) => Promise<void> | void;
  resetPlayerSurface: () => void;
  recordPeerDiagnostic: PeerDiagnosticRecorder;
}) {
  const meshRef = useRef<P2PMesh | null>(null);
  const initialRecoveryAttemptRef = useRef<string | null>(null);
  const previousInitialRoomIdRef = useRef<string | null>(input.initialRoomId);
  const activeRouteRoomIdRef = useRef<string | null>(input.initialRoomId);
  const resubscribeRoomRef = useRef<(() => void) | null>(null);
  const recoveryGenerationRef = useRef<number | null>(null);
  const lastRealtimeRoomEventAtRef = useRef<number>(Date.now());
  const deleteRoomTrackArtifactsRef = useRef(input.deleteRoomTrackArtifacts);
  const resetPlayerSurfaceRef = useRef(input.resetPlayerSurface);
  const recordPeerDiagnosticRef = useRef(input.recordPeerDiagnostic);

  useEffect(() => {
    input.activeSessionRef.current = input.activeSession;
  }, [input.activeSession, input.activeSessionRef]);

  useEffect(() => {
    input.currentRoomRef.current = input.roomSnapshot;
  }, [input.roomSnapshot, input.currentRoomRef]);

  useEffect(() => {
    deleteRoomTrackArtifactsRef.current = input.deleteRoomTrackArtifacts;
  }, [input.deleteRoomTrackArtifacts]);

  useEffect(() => {
    resetPlayerSurfaceRef.current = input.resetPlayerSurface;
  }, [input.resetPlayerSurface]);

  useEffect(() => {
    recordPeerDiagnosticRef.current = input.recordPeerDiagnostic;
  }, [input.recordPeerDiagnostic]);

  return {
    meshRef,
    initialRecoveryAttemptRef,
    previousInitialRoomIdRef,
    activeRouteRoomIdRef,
    resubscribeRoomRef,
    recoveryGenerationRef,
    lastRealtimeRoomEventAtRef,
    deleteRoomTrackArtifactsRef,
    resetPlayerSurfaceRef,
    recordPeerDiagnosticRef
  };
}
