import type { PlaybackSnapshot, TrackMeta } from "@soqaro/shared";
import type { RoomRecord } from "../room.types";
import { RoomPlaybackService } from "./room-playback.service";

function playbackAsset(assetId: string, durationMs: number) {
  return {
    assetId,
    kind: "playback" as const,
    sourceFileHash: "b".repeat(64),
    profileId: "opus-music-v4" as const,
    codec: "opus" as const,
    container: "audio/ogg" as const,
    sampleRate: 48_000 as const,
    channels: 2 as const,
    bitrate: 256_000 as const,
    durationMs,
    segmentDurationMs: 2_000 as const,
    seekPrerollMs: 80 as const,
    unitCount: Math.ceil(durationMs / 2_000),
    merkleRoot: "c".repeat(64),
    encoder: {
      name: "@audio/opus-encode" as const,
      version: "3.4.0" as const
    }
  };
}

function track(id: string, ownerSessionId: string, durationMs: number): TrackMeta {
  return {
    id,
    title: id,
    artist: "Artist",
    album: null,
    durationMs,
    bitrate: null,
    fileHash: id,
    artworkUrl: null,
    ownerSessionId,
    ownerNickname: ownerSessionId,
    sourceType: "local_upload",
    playbackAsset: playbackAsset(id === "track_1" ? "1".repeat(64) : "2".repeat(64), durationMs)
  };
}

function record(positionMs: number, nextOwnerSessionId = "owner"): RoomRecord {
  const first = track("track_1", "owner", 5_000);
  const second = track("track_2", nextOwnerSessionId, 6_000);
  const startAt = "2026-07-20T00:00:00.000Z";
  const playback: PlaybackSnapshot = {
    status: "playing",
    currentTrackId: first.id,
    currentQueueItemId: "queue_1",
    playbackAssetId: first.playbackAsset!.assetId,
    startAt,
    sourceSessionId: "owner",
    sourcePeerId: "peer-owner",
    sourceTrackId: first.id,
    positionMs,
    startedAt: startAt,
    queueVersion: 1,
    playbackRevision: 1,
    mediaEpoch: 1,
    playbackMode: "sequence"
  };

  return {
    room: {
      id: "room_1",
      hostId: "owner",
      joinCode: "ROOM01",
      name: "Room",
      description: null,
      hasPassword: false,
      visibility: "private",
      roomType: "interactive",
      radioAutopilot: { enabled: false },
      members: [],
      playback,
      presenceRevision: 1,
      roomRevision: 1
    },
    tracks: [first, second],
    queue: [
      {
        id: "queue_1",
        trackId: first.id,
        requestedBy: "owner",
        requestedById: "owner",
        source: "manual" as const,
        sourceSeedTrackId: null,
        position: 0,
        createdAt: "2026-07-19T00:00:00.000Z"
      },
      {
        id: "queue_2",
        trackId: second.id,
        requestedBy: "owner",
        requestedById: "owner",
        source: "manual" as const,
        sourceSeedTrackId: null,
        position: 1,
        createdAt: "2026-07-19T00:00:01.000Z"
      }
    ]
  };
}

describe("RoomPlaybackService gapless playback", () => {
  it("calculates the transition from the unplayed portion after a seek", async () => {
    const service = new RoomPlaybackService({} as never);
    const snapshot = await service.buildPlaybackForSnapshot(
      record(3_000),
      new Map([["owner", "peer-owner"]])
    );

    expect(snapshot.gaplessNext?.transitionAt).toBe("2026-07-20T00:00:02.000Z");
  });

  it("does not advertise a gapless transition when the next owner differs", async () => {
    const service = new RoomPlaybackService({} as never);
    const snapshot = await service.buildPlaybackForSnapshot(
      record(0, "another-owner"),
      new Map([
        ["owner", "peer-owner"],
        ["another-owner", "peer-another"]
      ])
    );

    expect(snapshot.gaplessNext).toBeNull();
  });

  it("pauses provider playback when its owner departs and no other source is available", async () => {
    const room = record(0);
    room.tracks[0] = {
      ...room.tracks[0]!,
      sourceType: "netease",
      sourceRef: { provider: "netease", trackId: "123" }
    };
    const service = new RoomPlaybackService({
      getActivePresence: async () => new Map([["owner", "peer-owner"]])
    } as never);

    await service.updatePlayback(room, {
      action: "play",
      trackId: "track_1"
    });

    expect(room.room.playback.status).toBe("playing");
    expect(room.room.playback.sourceSessionId).toBe("owner");
    expect(room.room.playback.sourcePeerId).toBe("peer-owner");

    service.handleSourceDeparture(room, "owner");
    expect(room.room.playback.status).toBe("paused");
    expect(room.room.playback.sourcePeerId).toBeNull();
  });

  it("plays the selected next item without changing queue order", async () => {
    const room = record(0);
    room.room.playback.nextQueueItemId = "queue_2";
    const originalQueueIds = room.queue.map((item) => item.id);
    const service = new RoomPlaybackService({
      getActivePresence: async () => new Map([[
        "owner",
        "peer-owner"
      ]])
    } as never);

    const snapshot = await service.updatePlayback(room, { action: "next" });

    expect(snapshot.currentQueueItemId).toBe("queue_2");
    expect(snapshot.currentTrackId).toBe("track_2");
    expect(snapshot.nextQueueItemId).toBeNull();
    expect(room.queue.map((item) => item.id)).toEqual(originalQueueIds);
    expect(room.queue.map((item) => item.position)).toEqual([0, 1]);
  });

  it("wraps sequence next from the final queue item to the first", async () => {
    const room = record(0);
    room.room.playback.currentTrackId = "track_2";
    room.room.playback.currentQueueItemId = "queue_2";
    room.room.playback.playbackAssetId = room.tracks[1]!.playbackAsset!.assetId;
    room.room.playback.sourceTrackId = "track_2";
    const service = new RoomPlaybackService({
      getActivePresence: async () => new Map([["owner", "peer-owner"]])
    } as never);

    const snapshot = await service.updatePlayback(room, { action: "next" });

    expect(snapshot.currentQueueItemId).toBe("queue_1");
    expect(snapshot.currentTrackId).toBe("track_1");
  });

  it("wraps sequence previous from the first queue item to the final", async () => {
    const room = record(0);
    const service = new RoomPlaybackService({
      getActivePresence: async () => new Map([["owner", "peer-owner"]])
    } as never);

    const snapshot = await service.updatePlayback(room, { action: "prev" });

    expect(snapshot.currentQueueItemId).toBe("queue_2");
    expect(snapshot.currentTrackId).toBe("track_2");
  });

  it("loops a one-item sequence queue", async () => {
    const room = record(0);
    room.queue = [room.queue[0]!];
    room.room.playback.currentTrackId = "track_1";
    room.room.playback.currentQueueItemId = "queue_1";
    const service = new RoomPlaybackService({
      getActivePresence: async () => new Map([["owner", "peer-owner"]])
    } as never);

    const snapshot = await service.updatePlayback(room, { action: "next" });

    expect(snapshot.currentQueueItemId).toBe("queue_1");
    expect(snapshot.currentTrackId).toBe("track_1");
    expect(snapshot.status).toBe("playing");
  });

  it("skips unavailable items while wrapping in sequence order", async () => {
    const room = record(0);
    room.room.playback.currentTrackId = "track_2";
    room.room.playback.currentQueueItemId = "queue_2";
    room.room.playback.playbackAssetId = room.tracks[1]!.playbackAsset!.assetId;
    room.room.playback.sourceTrackId = "track_2";
    room.tracks[0] = { ...room.tracks[0]!, ownerSessionId: "offline-owner" };
    const service = new RoomPlaybackService({
      getActivePresence: async () => new Map([["owner", "peer-owner"]])
    } as never);

    const snapshot = await service.updatePlayback(room, { action: "next" });

    expect(snapshot.currentQueueItemId).toBe("queue_2");
    expect(snapshot.currentTrackId).toBe("track_2");
  });

  it("advertises the first queue item after the final item for gapless playback", async () => {
    const room = record(0);
    const finalTrack = room.tracks[1]!;
    room.room.playback.currentTrackId = finalTrack.id;
    room.room.playback.currentQueueItemId = "queue_2";
    room.room.playback.playbackAssetId = finalTrack.playbackAsset!.assetId;
    room.room.playback.sourceTrackId = finalTrack.id;
    const service = new RoomPlaybackService({
      getActivePresence: async () => new Map([["owner", "peer-owner"]])
    } as never);

    const snapshot = await service.buildPlaybackForSnapshot(
      room,
      new Map([["owner", "peer-owner"]])
    );

    expect(snapshot.gaplessNext?.queueItemId).toBe("queue_1");
    expect(snapshot.gaplessNext?.trackId).toBe("track_1");
  });

  it("plays each unique track once per shuffle cycle and avoids a boundary repeat", async () => {
    const room = record(0);
    const extraTracks = ["track_3", "track_4"].map((id) => track(id, "owner", 7_000));
    room.tracks.push(...extraTracks);
    room.queue.push(
      ...extraTracks.map((item, index) => ({
        id: `queue_${index + 3}`,
        trackId: item.id,
        requestedBy: "owner",
        requestedById: "owner",
        source: "manual" as const,
        sourceSeedTrackId: null,
        position: index + 2,
        createdAt: `2026-07-19T00:00:0${index + 2}.000Z`
      }))
    );

    const service = new RoomPlaybackService({
      getActivePresence: async () => new Map([["owner", "peer-owner"]])
    } as never);
    await service.updatePlayback(room, { action: "set-mode", playbackMode: "shuffle" });

    const firstTrackId = room.room.playback.currentTrackId!;
    const cycle = [firstTrackId];
    for (let index = 0; index < room.queue.length - 1; index += 1) {
      const snapshot = await service.updatePlayback(room, { action: "next" });
      cycle.push(snapshot.currentTrackId!);
    }

    expect(new Set(cycle).size).toBe(room.queue.length);
    const lastTrackId = cycle.at(-1);
    const nextCycleTrack = await service.updatePlayback(room, { action: "next" });
    expect(nextCycleTrack.currentTrackId).not.toBe(lastTrackId);
    expect(cycle).toContain(nextCycleTrack.currentTrackId);
  });

  it("defers pausing at track end while a candidate source owner is reconnecting", async () => {
    const room = record(5_000);
    let presenceState: "reconnecting" | "offline" = "reconnecting";
    const service = new RoomPlaybackService({
      getActivePresence: async () => new Map<string, string>(),
      getPresenceSnapshot: async () =>
        new Map([["owner", { peerId: null, presenceState }]])
    } as never);

    await expect(service.advanceIfTrackEnded(room)).resolves.toBe(false);
    expect(room.room.playback.status).toBe("playing");

    presenceState = "offline";
    await expect(service.advanceIfTrackEnded(room)).resolves.toBe(true);
    expect(room.room.playback.status).toBe("paused");
  });

  it("advances to the next playable track when the active track is reported unavailable", async () => {
    const room = record(1_000);
    const service = new RoomPlaybackService({
      getActivePresence: async () => new Map([["owner", "peer-owner"]])
    } as never);

    await expect(service.advanceAfterUnavailableTrack(room, "track_1")).resolves.toBe(true);
    expect(room.room.playback.status).toBe("playing");
    expect(room.room.playback.currentTrackId).toBe("track_2");
    expect(room.room.playback.currentQueueItemId).toBe("queue_2");

    room.queue = [room.queue[1]!];
    await expect(service.advanceAfterUnavailableTrack(room, "track_2")).resolves.toBe(false);
  });
});
