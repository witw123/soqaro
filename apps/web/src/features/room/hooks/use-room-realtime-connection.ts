"use client";

import { useRoomRealtimeConnectionEffects } from "./room-realtime-effects";

export {
  buildRoomSubscribePayload,
  createRoomRealtimeEventGate,
  isSoloRoomPlaybackOverdue,
  resolvePresenceRepairAction,
  resolveRoomRealtimeSnapshotInputs,
  resolveRoomSnapshotWatchdogAction,
  shouldAcceptIncomingPeerSignal,
  shouldExitRoomOnSnapshotMissing,
  shouldResubscribeAfterPresenceOutcome,
  shouldResyncSnapshotForPlaybackPatch
} from "./room-realtime-policy";
export {
  createRoomRealtimeRuntime,
  createRoomSocketRuntime
} from "./room-realtime-runtime";

export function useRoomRealtimeConnection(
  input: Parameters<typeof useRoomRealtimeConnectionEffects>[0]
) {
  return useRoomRealtimeConnectionEffects(input);
}
