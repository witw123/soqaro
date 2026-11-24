"use client";

import { useCallback, useRef } from "react";
import type { PeerDiagnosticsSnapshot } from "@soqaro/shared";
import type { PeerConnectionStatsSample } from "@/features/p2p/connection-stats";
import {
  createPeerConnectionSupervisorState,
  notePeerSignalState,
  observePeerTransport,
  resolveTransportHealth,
  toSupervisorDiagnosticPatch,
  type PeerConnectionSupervisorState
} from "@/features/p2p";
import type { ConnectionSupervisorSignalStateInput } from "./room-runtime-types";

export function withResolvedTransportHealth(
  snapshot: PeerDiagnosticsSnapshot
): PeerDiagnosticsSnapshot {
  return {
    ...snapshot,
    ...resolveTransportHealth(snapshot)
  };
}

export function withSupervisorDiagnosticPatch(
  snapshot: PeerDiagnosticsSnapshot,
  state: PeerConnectionSupervisorState | null
): PeerDiagnosticsSnapshot {
  return state ? { ...snapshot, ...toSupervisorDiagnosticPatch(state) } : snapshot;
}

export function useRoomConnectionSupervisor(input: { roomId?: string | null } = {}) {
  const connectionSupervisorStatesRef = useRef<Map<string, PeerConnectionSupervisorState>>(new Map());

  const ensureConnectionSupervisorState = useCallback((peerId: string) => {
    const existing = connectionSupervisorStatesRef.current.get(peerId);
    if (existing) {
      return existing;
    }
    const next = createPeerConnectionSupervisorState({
      peerId,
      roomId: input.roomId ?? "room"
    });
    connectionSupervisorStatesRef.current.set(peerId, next);
    return next;
  }, [input.roomId]);

  const commitConnectionSupervisorState = useCallback(
    (state: PeerConnectionSupervisorState | null | undefined) => {
      if (state) {
        connectionSupervisorStatesRef.current.set(state.peerId, state);
      }
      return state ?? null;
    },
    []
  );

  const updateConnectionSupervisorSignalState = useCallback(
    (value: ConnectionSupervisorSignalStateInput) => {
      const state = ensureConnectionSupervisorState(value.peerId);
      const next = notePeerSignalState({
        state,
        dataConnectionState: value.dataConnectionState,
        dataIceState: value.dataIceState,
        dataChannelState: value.dataChannelState,
        mediaConnectionState: value.mediaConnectionState,
        mediaIceState: value.mediaIceState,
        lastFailureReason: value.lastFailureReason
      });
      return commitConnectionSupervisorState(next);
    },
    [commitConnectionSupervisorState, ensureConnectionSupervisorState]
  );

  const updateConnectionSupervisorTransportStats = useCallback(
    (value: {
      peerId: string;
      sample: PeerConnectionStatsSample;
      channelKind?: "data" | "media";
      diagnostics?: Pick<
        PeerDiagnosticsSnapshot,
        | "dataChannelState"
        | "dataConnectionState"
        | "mediaConnectionState"
        | "dataIceState"
        | "mediaIceState"
      > | null;
      now?: number;
    }) => {
      const state = ensureConnectionSupervisorState(value.peerId);
      const channelKind = value.channelKind ?? "data";
      const next = observePeerTransport({
        state,
        sample: value.sample,
        diagnostics: value.diagnostics ?? {
          dataChannelState: channelKind === "data"
            ? value.sample.dataChannelState ?? state.dataChannelState
            : state.dataChannelState,
          dataConnectionState: channelKind === "data"
            ? value.sample.connectionState ?? state.dataConnectionState
            : state.dataConnectionState,
          dataIceState: channelKind === "data"
            ? value.sample.iceConnectionState ?? state.dataIceState
            : state.dataIceState,
          mediaConnectionState: channelKind === "media"
            ? value.sample.connectionState ?? state.mediaConnectionState
            : state.mediaConnectionState,
          mediaIceState: channelKind === "media"
            ? value.sample.iceConnectionState ?? state.mediaIceState
            : state.mediaIceState
        },
        now: value.now
      });
      return commitConnectionSupervisorState(next);
    },
    [commitConnectionSupervisorState, ensureConnectionSupervisorState]
  );

  return {
    connectionSupervisorStatesRef,
    ensureConnectionSupervisorState,
    commitConnectionSupervisorState,
    updateConnectionSupervisorSignalState,
    updateConnectionSupervisorTransportStats
  };
}
