import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomJoinResponse, RoomSnapshot } from "@soqaro/shared";
import { soqaroApi } from "@/lib/network/soqaro-api";
import { storeAwayRoomId, readAwayRoomId } from "@/lib/domain/away-room";

vi.mock("@/lib/ui/room-view-transition", () => ({
  awaitRoomRuntimePrewarm: vi.fn().mockResolvedValue(undefined)
}));

import {
  buildRoomJoinBootstrapSnapshot,
  consumeRoomSnapshotHandoff,
  peekRoomSnapshotHandoff,
  prepareRoomJoinHandoff,
  storeRoomSnapshotHandoff
} from "./room-snapshot-handoff";

function buildSnapshot(roomId = "room_1"): RoomSnapshot {
  return {
    room: {
      id: roomId,
      hostId: "user_host",
      joinCode: "ABC123",
      visibility: "public",
      roomType: "interactive",
      radioAutopilot: { enabled: false },
      members: [],
      presenceRevision: 0,
      playback: {
        status: "paused",
        currentTrackId: null,
        currentQueueItemId: null,
        sourceSessionId: null,
        sourcePeerId: null,
        sourceTrackId: null,
        positionMs: 0,
        startedAt: null,
        queueVersion: 1,
        playbackRevision: 1,
        mediaEpoch: 0
      }
    },
    tracks: [],
    queue: [],
    playlists: []
  };
}

describe("room snapshot handoff", () => {
  beforeEach(() => {
    const session = new Map<string, string>();
    const local = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        dispatchEvent: () => true,
        sessionStorage: {
          getItem: (key: string) => session.get(key) ?? null,
          setItem: (key: string, value: string) => {
            session.set(key, value);
          },
          removeItem: (key: string) => {
            session.delete(key);
          },
          clear: () => {
            session.clear();
          }
        },
        localStorage: {
          getItem: (key: string) => local.get(key) ?? null,
          setItem: (key: string, value: string) => {
            local.set(key, value);
          },
          removeItem: (key: string) => {
            local.delete(key);
          },
          clear: () => {
            local.clear();
          }
        }
      }
    });
  });

  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.sessionStorage.clear();
    window.localStorage.clear();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("stores, peeks synchronously for initial render, and consumes a matching room snapshot", () => {
    const snapshot = buildSnapshot();
    storeRoomSnapshotHandoff(snapshot);

    expect(peekRoomSnapshotHandoff(snapshot.room.id)).toEqual(snapshot);
    expect(consumeRoomSnapshotHandoff(snapshot.room.id)).toEqual(snapshot);
    expect(peekRoomSnapshotHandoff(snapshot.room.id)).toBeNull();
    expect(consumeRoomSnapshotHandoff(snapshot.room.id)).toBeNull();
  });

  it("builds a fast join bootstrap without library or queue payloads", () => {
    const snapshot = buildSnapshot();
    const joined = {
      roomId: snapshot.room.id,
      roomRevision: snapshot.room.roomRevision ?? 0,
      room: snapshot.room
    } satisfies RoomJoinResponse;

    expect(buildRoomJoinBootstrapSnapshot(joined)).toEqual({
      room: {
        ...snapshot.room,
        roomRevision: 0
      },
      tracks: [],
      queue: [],
      playlists: []
    });
  });

  it("ignores a handoff for another room", () => {
    storeRoomSnapshotHandoff(buildSnapshot("room_a"));
    expect(consumeRoomSnapshotHandoff("room_b")).toBeNull();
  });

  it("drops expired handoff snapshots", () => {
    vi.useFakeTimers();
    const snapshot = buildSnapshot();
    storeRoomSnapshotHandoff(snapshot);
    vi.advanceTimersByTime(60_001);

    expect(consumeRoomSnapshotHandoff(snapshot.room.id)).toBeNull();
  });

  it("prepares full snapshot handoff via syncRoom and falls back to bootstrap when sync fails", async () => {
    const baseSnapshot = buildSnapshot("room_full");
    const fullSnapshot: RoomSnapshot = {
      ...baseSnapshot,
      room: {
        ...baseSnapshot.room,
        roomRevision: 7
      }
    };
    const joined: RoomJoinResponse = {
      roomId: "room_full",
      roomRevision: 7,
      room: baseSnapshot.room
    };

    storeAwayRoomId("room_other");
    const prefetchRoom = vi.fn();
    vi.spyOn(soqaroApi, "syncRoom").mockResolvedValueOnce({
      roomId: "room_full",
      roomDeleted: false,
      roomRevision: 7,
      snapshot: fullSnapshot,
      deletedTracks: []
    });

    const resolved = await prepareRoomJoinHandoff(joined, {
      lastRoomStorageKey: "soqaro-last-room",
      prefetchRoom
    });

    expect(prefetchRoom).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual(fullSnapshot);
    expect(consumeRoomSnapshotHandoff("room_full")).toEqual(fullSnapshot);
    expect(readAwayRoomId()).toBeNull();
    expect(window.localStorage.getItem("soqaro-last-room")).toBe("room_full");

    vi.spyOn(soqaroApi, "syncRoom").mockRejectedValueOnce(new Error("network timeout"));
    const fallback = await prepareRoomJoinHandoff(joined);
    expect(fallback).toEqual(buildRoomJoinBootstrapSnapshot(joined));
  });
});
