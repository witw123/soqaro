"use client";

import type { MutableRefObject } from "react";
import type { PeerDiagnosticsSnapshot } from "@soqaro/shared";
import type { PeerConnectionStatsSample } from "@/features/p2p/connection-stats";
import type { PeerConnectionSupervisorState } from "@/features/p2p/connection-supervisor";
import type { PeerDiagnosticRecorder } from "@/features/p2p/use-peer-diagnostics";

export type DataTransportStatsInput = {
  peerId: string;
  sample?: PeerConnectionStatsSample &
    Partial<{
      connectionState: string | null;
      iceConnectionState: string | null;
      dataChannelState: string | null;
    }>;
};

export type ConnectionSupervisorSignalStateInput = {
  peerId: string;
  channelKind: "data" | "media";
  dataConnectionState?: string;
  dataIceState?: string;
  dataChannelState?: string;
  lastFailureReason?: string;
  mediaConnectionState?: string;
  mediaIceState?: string;
};

export type RoomDataMeshDiagnosticsRefs = {
  recordPeerDiagnosticRef: MutableRefObject<PeerDiagnosticRecorder>;
  updatePeerBufferedAmountRef: MutableRefObject<
    (peerId: string, bufferedAmountBytes: number) => void
  >;
  updateDataTransportStatsRef: MutableRefObject<(input: DataTransportStatsInput) => void>;
  updateMediaTransportStatsRef?: MutableRefObject<(input: DataTransportStatsInput) => void>;
  connectionSupervisorStatesRef: MutableRefObject<Map<string, PeerConnectionSupervisorState>>;
  updateConnectionSupervisorSignalState: (
    input: ConnectionSupervisorSignalStateInput
  ) => PeerConnectionSupervisorState | null;
  updateConnectionSupervisorTransportStats: (input: {
    peerId: string;
    sample: PeerConnectionStatsSample;
    channelKind: "data" | "media";
  }) => PeerConnectionSupervisorState | null;
  withResolvedTransportHealth: (
    snapshot: PeerDiagnosticsSnapshot
  ) => PeerDiagnosticsSnapshot;
  withSupervisorDiagnosticPatch: (
    snapshot: PeerDiagnosticsSnapshot,
    state: PeerConnectionSupervisorState | null
  ) => PeerDiagnosticsSnapshot;
};

export type PlaybackConnectionKey = string;

export type PlaybackRecoveryAction = {
  actionId: string;
  playbackConnectionKey: PlaybackConnectionKey;
  actionType: "restart-data-peer" | "full-resubscribe";
  peerId: string | null;
  startedAt: string;
  expiresAt: string;
  result: "running" | "completed" | "failed" | "dropped";
  reason: string;
};

export type PlaybackRecoveryDropReason =
  | "stale-connection-key"
  | "lower-priority-running"
  | "suppressed-by-guard"
  | "missing-peer";

export type PlaybackRecoveryRecommendation = {
  playbackConnectionKey: PlaybackConnectionKey | null;
  peerId: string | null;
  scope: "data" | "room";
  level: "soft" | "hard-recreate" | "full-resubscribe";
  reason: string;
  observedNoProgressMs: number | null;
};
