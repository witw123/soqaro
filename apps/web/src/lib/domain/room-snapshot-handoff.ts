"use client";

import type { RoomJoinResponse, RoomSnapshot } from "@soqaro/shared";
import { clearAwayRoomId, readAwayRoomId } from "@/lib/domain/away-room";
import { soqaroApi } from "@/lib/network/soqaro-api";
import { awaitRoomRuntimePrewarm } from "@/lib/ui/room-view-transition";

const roomSnapshotHandoffStorageKey = "soqaro-pending-room-snapshot";
const roomSnapshotHandoffTtlMs = 60_000;

type RoomSnapshotHandoffPayload = {
  roomId: string;
  snapshot: RoomSnapshot;
  savedAt: number;
};

export function buildRoomJoinBootstrapSnapshot(joined: RoomJoinResponse): RoomSnapshot {
  return {
    room: {
      ...joined.room,
      roomRevision: 0
    },
    tracks: [],
    queue: [],
    playlists: []
  };
}

/**
 * Fetches the full room snapshot and warms the room runtime bundle in parallel
 * before running the room-enter View Transition so entering a room never stalls
 * on empty bootstrap state or a cold chunk import.
 */
export async function prepareRoomJoinHandoff(
  joined: RoomJoinResponse,
  options?: {
    lastRoomStorageKey?: string;
    prefetchRoom?: () => void;
  }
): Promise<RoomSnapshot> {
  options?.prefetchRoom?.();
  const [syncResult] = await Promise.all([
    soqaroApi.syncRoom(joined.roomId, 0).catch(() => null),
    awaitRoomRuntimePrewarm()
  ]);

  const snapshot =
    syncResult && !syncResult.roomDeleted && syncResult.snapshot
      ? syncResult.snapshot
      : buildRoomJoinBootstrapSnapshot(joined);

  storeRoomSnapshotHandoff(snapshot);

  const awayRoomId = readAwayRoomId();
  if (awayRoomId && awayRoomId !== joined.roomId) {
    clearAwayRoomId();
  }

  if (options?.lastRoomStorageKey && typeof window !== "undefined") {
    try {
      window.localStorage.setItem(options.lastRoomStorageKey, joined.roomId);
    } catch {
      // Ignore storage errors in restricted WebView environments
    }
  }

  return snapshot;
}

export function storeRoomSnapshotHandoff(snapshot: RoomSnapshot) {
  if (typeof window === "undefined") {
    return;
  }

  const payload: RoomSnapshotHandoffPayload = {
    roomId: snapshot.room.id,
    snapshot,
    savedAt: Date.now()
  };

  try {
    window.sessionStorage.setItem(roomSnapshotHandoffStorageKey, JSON.stringify(payload));
  } catch {
    // Ignore storage errors in restricted WebView environments
  }
}

export function peekRoomSnapshotHandoff(roomId: string): RoomSnapshot | null {
  if (typeof window === "undefined" || !roomId) {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(roomSnapshotHandoffStorageKey);
    if (!raw) {
      return null;
    }

    const payload = JSON.parse(raw) as Partial<RoomSnapshotHandoffPayload>;
    const isExpired =
      typeof payload.savedAt === "number" &&
      Date.now() - payload.savedAt > roomSnapshotHandoffTtlMs;

    if (isExpired) {
      window.sessionStorage.removeItem(roomSnapshotHandoffStorageKey);
      return null;
    }

    if (payload.roomId !== roomId || !payload.snapshot) {
      return null;
    }

    return payload.snapshot;
  } catch {
    return null;
  }
}

export function consumeRoomSnapshotHandoff(roomId: string) {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(roomSnapshotHandoffStorageKey);
    if (!raw) {
      return null;
    }

    const payload = JSON.parse(raw) as Partial<RoomSnapshotHandoffPayload>;
    const isExpired =
      typeof payload.savedAt === "number" &&
      Date.now() - payload.savedAt > roomSnapshotHandoffTtlMs;

    if (isExpired) {
      window.sessionStorage.removeItem(roomSnapshotHandoffStorageKey);
      return null;
    }

    if (payload.roomId !== roomId || !payload.snapshot) {
      // A mismatched payload can never be consumed by this room; drop it now
      // instead of letting a stale snapshot leak into a later join.
      window.sessionStorage.removeItem(roomSnapshotHandoffStorageKey);
      return null;
    }

    window.sessionStorage.removeItem(roomSnapshotHandoffStorageKey);
    return payload.snapshot;
  } catch {
    try {
      window.sessionStorage.removeItem(roomSnapshotHandoffStorageKey);
    } catch {
      // Ignore storage errors
    }
    return null;
  }
}
