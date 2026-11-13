import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PlaybackSnapshot, RoomSnapshot } from "@soqaro/shared";
import {
  buildRoomSubscribePayload,
  createRoomRealtimeEventGate,
  createRoomRealtimeRuntime,
  isSocketDisconnectGraceActive,
  shouldExitRoomOnSnapshotMissing,
  resolvePresenceRepairAction,
  resolveRoomRealtimeSnapshotInputs,
  resolveRoomSnapshotWatchdogAction,
  shouldResubscribeAfterPresenceOutcome,
  shouldResyncSnapshotForPlaybackPatch,
  shouldSuppressPlaybackWatchdogEscalation
} from "./use-room-realtime-connection";
import { resolveRoomSnapshotWatchdogAction as resolveRoomSnapshotWatchdogActionFromPolicy } from "./room-realtime-policy";
import { createRoomRealtimeRuntime as createRoomRealtimeRuntimeFromRuntime } from "./room-realtime-runtime";
import { useRoomRealtimeConnectionEffects } from "./room-realtime-effects";

const readRoomRealtimeConnectionSource = () =>
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "use-room-realtime-connection.ts"),
    "utf8"
  ).replace(/\r\n/g, "\n");

function createPlayback(overrides: Partial<PlaybackSnapshot> = {}): PlaybackSnapshot {
  return {
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
    mediaEpoch: 1,
    ...overrides
  };
}

function createSnapshot(overrides: {
  tracks?: RoomSnapshot["tracks"];
  playback?: Partial<PlaybackSnapshot>;
} = {}): RoomSnapshot {
  return {
    room: {
      id: "room_1",
      hostId: "host",
      joinCode: "ABC123",
      visibility: "public",
      roomType: "interactive",
      radioAutopilot: { enabled: false },
      members: [],
      presenceRevision: 1,
      roomRevision: 1,
      playback: createPlayback(overrides.playback)
    },
    tracks: overrides.tracks ?? [],
    queue: [],
    playlists: []
  };
}

describe("room realtime module boundaries", () => {
  it("hosts policy, runtime and effect orchestration outside the main hook module", () => {
    expect(resolveRoomSnapshotWatchdogActionFromPolicy).toBe(resolveRoomSnapshotWatchdogAction);
    expect(createRoomRealtimeRuntimeFromRuntime).toBe(createRoomRealtimeRuntime);
    expect(typeof useRoomRealtimeConnectionEffects).toBe("function");
  });
});
describe("room realtime event gate", () => {
  it("rejects stale side effects even before the React snapshot ref catches up", () => {
    const currentSnapshot = createSnapshot();
    const gate = createRoomRealtimeEventGate(currentSnapshot);
    const newerPlayback = createPlayback({ playbackRevision: 3, queueVersion: 3 });
    const stalePlayback = createPlayback({ playbackRevision: 2, queueVersion: 2 });

    expect(gate.acceptRoomRevision(3, currentSnapshot)).toBe(true);
    expect(gate.acceptRoomRevision(2, currentSnapshot)).toBe(false);
    expect(gate.acceptPresenceRevision(3, currentSnapshot)).toBe(true);
    expect(gate.acceptPresenceRevision(2, currentSnapshot)).toBe(false);
    expect(gate.acceptPresenceRevision(10, currentSnapshot, false, 0)).toBe(false);
    expect(gate.acceptPlayback(newerPlayback, currentSnapshot).accepted).toBe(true);
    expect(gate.acceptPlayback(stalePlayback, currentSnapshot).accepted).toBe(false);
  });
});
describe("isSocketDisconnectGraceActive", () => {
  it("stays active before the grace window expires", () => {
    expect(isSocketDisconnectGraceActive(12_000, 10_000)).toBe(true);
  });

  it("stops being active after the grace window expires", () => {
    expect(isSocketDisconnectGraceActive(12_000, 12_001)).toBe(false);
    expect(isSocketDisconnectGraceActive(null, 12_001)).toBe(false);
  });
});
describe("shouldSuppressPlaybackWatchdogEscalation", () => {
  it("suppresses watchdog escalation while the page is backgrounded", () => {
    expect(
      shouldSuppressPlaybackWatchdogEscalation({
        recoverySuppressedReason: "page-hidden",
        socketDisconnectGraceActive: false
      })
    ).toBe(true);
  });

  it("suppresses watchdog escalation during socket disconnect grace", () => {
    expect(
      shouldSuppressPlaybackWatchdogEscalation({
        recoverySuppressedReason: null,
        socketDisconnectGraceActive: true
      })
    ).toBe(true);
  });

  it("allows escalation once no suppression signal remains", () => {
    expect(
      shouldSuppressPlaybackWatchdogEscalation({
        recoverySuppressedReason: null,
        socketDisconnectGraceActive: false
      })
    ).toBe(false);
  });
});

describe("buildRoomSubscribePayload", () => {
  it("includes the authenticated session id required by the signaling gateway", () => {
    expect(
      buildRoomSubscribePayload({
        roomId: "room_1",
        peerId: "peer_1",
        sessionId: "user_1"
      })
    ).toEqual({
      roomId: "room_1",
      peerId: "peer_1",
      sessionId: "user_1",
      protocolVersion: 4,
      capabilities: ["webrtc-opus-v1"],
      buildId: "0.3.1"
    });
  });
});


describe("shouldExitRoomOnSnapshotMissing", () => {
  it("exits the current room when the server reports its snapshot missing", () => {
    expect(
      shouldExitRoomOnSnapshotMissing({
        currentRoomId: "room_1",
        missingRoomId: "room_1"
      })
    ).toBe(true);
  });

  it("treats legacy missing payloads without a room id as current-room failures", () => {
    expect(
      shouldExitRoomOnSnapshotMissing({
        currentRoomId: "room_1",
        missingRoomId: null
      })
    ).toBe(true);
  });

  it("ignores missing snapshots for other rooms", () => {
    expect(
      shouldExitRoomOnSnapshotMissing({
        currentRoomId: "room_1",
        missingRoomId: "room_2"
      })
    ).toBe(false);
  });
});

describe("shouldResyncSnapshotForPlaybackPatch", () => {
  it("requests a snapshot when playback points at a track missing from local metadata", () => {
    expect(
      shouldResyncSnapshotForPlaybackPatch({
        currentSnapshot: createSnapshot(),
        playback: createPlayback({
          status: "playing",
          currentTrackId: "track_live",
          playbackRevision: 2,
          queueVersion: 2
        })
      })
    ).toBe(true);
  });

  it("requests a snapshot when playback has a track but no room snapshot is loaded yet", () => {
    expect(
      shouldResyncSnapshotForPlaybackPatch({
        currentSnapshot: null,
        playback: createPlayback({
          status: "playing",
          currentTrackId: "track_live",
          playbackRevision: 2,
          queueVersion: 2
        })
      })
    ).toBe(true);
  });

  it("skips snapshot resync when the playback track metadata is already present", () => {
    expect(
      shouldResyncSnapshotForPlaybackPatch({
        currentSnapshot: createSnapshot({
          tracks: [
            {
              id: "track_live",
              ownerSessionId: "host",
              title: "Live Track",
              artist: "Artist",
              album: null,
              durationMs: 120_000,
              bitrate: 320_000,
              fileHash: "hash_live",
              mimeType: "audio/flac",
              codec: "flac",
              sizeBytes: 1024,
              artworkUrl: null,
              ownerNickname: "Host",
              sourceType: "local_upload"
            }
          ]
        }),
        playback: createPlayback({
          status: "playing",
          currentTrackId: "track_live",
          playbackRevision: 2,
          queueVersion: 2
        })
      })
    ).toBe(false);
  });
});

describe("room realtime timer dependencies", () => {
  it("keeps watchdog and presence timers free of room snapshot object identity", () => {
    const source = readRoomRealtimeConnectionSource();
    const dependencySource = [...source.matchAll(/\n\s*\}, \[\n(?<deps>[\s\S]*?)\n\s*\]\);/g)]
      .map((match) => match.groups?.deps ?? "")
      .join("\n");

    expect(dependencySource).not.toMatch(/^\s+roomSnapshot,\s*$/m);
  });
});

describe("resolveRoomRealtimeSnapshotInputs", () => {
  it("keeps cloned room snapshots on the same scalar timer identity", () => {
    const snapshot = createSnapshot({
      tracks: [
        {
          id: "track_1",
          ownerSessionId: "host",
          title: "Track 1",
          artist: "Artist",
          album: null,
          durationMs: 120_000,
          bitrate: 320_000,
          fileHash: "hash_1",
          mimeType: "audio/flac",
          codec: "flac",
          sizeBytes: 1024,
          artworkUrl: null,
          ownerNickname: "Host",
          sourceType: "local_upload"
        }
      ]
    });
    snapshot.room.members = [
      {
        id: "user_1",
        nickname: "Listener",
        role: "member",
        joinedAt: "2026-01-01T00:00:00.000Z",
        peerId: "peer_1",
        presenceState: "online"
      }
    ];
    const clonedSnapshot = {
      ...snapshot,
      room: {
        ...snapshot.room,
        members: [...snapshot.room.members]
      },
      tracks: [...snapshot.tracks]
    };

    expect(
      resolveRoomRealtimeSnapshotInputs({
        roomSnapshot: clonedSnapshot,
        activeSessionId: "user_1",
        fallbackUploadedTrackIds: []
      })
    ).toEqual(
      resolveRoomRealtimeSnapshotInputs({
        roomSnapshot: snapshot,
        activeSessionId: "user_1",
        fallbackUploadedTrackIds: []
      })
    );
  });
});

describe("resolvePresenceRepairAction", () => {
  it("requests a repair once for a stale local presence record", () => {
    expect(
      resolvePresenceRepairAction({
        snapshotRoomId: "room_1",
        activeSessionId: "user_1",
        peerId: "peer_1",
        hasLocalMemberPresence: true,
        localMemberPeerId: "old_peer",
        localMemberPresenceState: "offline",
        snapshotPresenceRevision: 7,
        previousRepairKey: null,
        socketConnected: true
      })
    ).toEqual({
      nextRepairKey: "room_1|7|old_peer|offline|peer_1",
      shouldEmitPresence: true,
      shouldRequestResync: true,
      shouldStartHeartbeat: true
    });
  });

  it("does not repeat the same repair key or repair an already healthy local presence", () => {
    expect(
      resolvePresenceRepairAction({
        snapshotRoomId: "room_1",
        activeSessionId: "user_1",
        peerId: "peer_1",
        hasLocalMemberPresence: true,
        localMemberPeerId: "old_peer",
        localMemberPresenceState: "offline",
        snapshotPresenceRevision: 7,
        previousRepairKey: "room_1|7|old_peer|offline|peer_1",
        socketConnected: true
      })
    ).toEqual({
      nextRepairKey: "room_1|7|old_peer|offline|peer_1",
      shouldEmitPresence: false,
      shouldRequestResync: false,
      shouldStartHeartbeat: false
    });

    expect(
      resolvePresenceRepairAction({
        snapshotRoomId: "room_1",
        activeSessionId: "user_1",
        peerId: "peer_1",
        hasLocalMemberPresence: true,
        localMemberPeerId: "peer_1",
        localMemberPresenceState: "online",
        snapshotPresenceRevision: 8,
        previousRepairKey: "room_1|7|old_peer|offline|peer_1",
        socketConnected: true
      })
    ).toEqual({
      nextRepairKey: null,
      shouldEmitPresence: false,
      shouldRequestResync: false,
      shouldStartHeartbeat: false
    });
  });
});

describe("resolveRoomSnapshotWatchdogAction", () => {
  it("requests a stale-watchdog resync once realtime room events go stale", () => {
    expect(
      resolveRoomSnapshotWatchdogAction({
        activeRouteRoomId: "room_1",
        socketConnected: true,
        snapshotRoomId: "room_1",
        lastRealtimeRoomEventAtMs: 1_000,
        nowMs: 9_500,
        staleAfterMs: 8_000
      })
    ).toEqual({
      nextLastRealtimeRoomEventAtMs: 9_500,
      resyncRoomId: "room_1",
      shouldRequestResync: true
    });
  });

  it("holds the stale watchdog while the route, socket, or freshness gate is not ready", () => {
    expect(
      resolveRoomSnapshotWatchdogAction({
        activeRouteRoomId: "room_2",
        socketConnected: true,
        snapshotRoomId: "room_1",
        lastRealtimeRoomEventAtMs: 1_000,
        nowMs: 9_500,
        staleAfterMs: 8_000
      }).shouldRequestResync
    ).toBe(false);

    expect(
      resolveRoomSnapshotWatchdogAction({
        activeRouteRoomId: "room_1",
        socketConnected: false,
        snapshotRoomId: "room_1",
        lastRealtimeRoomEventAtMs: 1_000,
        nowMs: 9_500,
        staleAfterMs: 8_000
      }).shouldRequestResync
    ).toBe(false);

    expect(
      resolveRoomSnapshotWatchdogAction({
        activeRouteRoomId: "room_1",
        socketConnected: true,
        snapshotRoomId: "room_1",
        lastRealtimeRoomEventAtMs: 8_000,
        nowMs: 9_500,
        staleAfterMs: 8_000
      }).shouldRequestResync
    ).toBe(false);
  });
});

describe("shouldResubscribeAfterPresenceOutcome", () => {
  it("triggers resubscribe when presence ack fails or times out while connected", () => {
    expect(
      shouldResubscribeAfterPresenceOutcome({
        timedOut: false,
        ack: { ok: false, reason: "lease-missing" },
        socketConnected: true,
        lastResubscribeAtMs: null,
        nowMs: 10_000,
        cooldownMs: 5_000
      })
    ).toBe(true);

    expect(
      shouldResubscribeAfterPresenceOutcome({
        timedOut: true,
        ack: null,
        socketConnected: true,
        lastResubscribeAtMs: null,
        nowMs: 10_000,
        cooldownMs: 5_000
      })
    ).toBe(true);

    expect(
      shouldResubscribeAfterPresenceOutcome({
        timedOut: false,
        ack: { ok: true },
        socketConnected: true,
        lastResubscribeAtMs: null,
        nowMs: 10_000,
        cooldownMs: 5_000
      })
    ).toBe(false);

    expect(
      shouldResubscribeAfterPresenceOutcome({
        timedOut: false,
        ack: { ok: false, reason: "lease-missing" },
        socketConnected: true,
        lastResubscribeAtMs: 7_000,
        nowMs: 10_000,
        cooldownMs: 5_000
      })
    ).toBe(false);

    expect(
      shouldResubscribeAfterPresenceOutcome({
        timedOut: true,
        ack: null,
        socketConnected: false,
        lastResubscribeAtMs: null,
        nowMs: 10_000,
        cooldownMs: 5_000
      })
    ).toBe(false);
  });
});
