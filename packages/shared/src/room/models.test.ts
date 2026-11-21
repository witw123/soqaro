import { describe, expect, it } from "vitest";
import {
  defaultRoomMemberPermissions,
  getNewMemberPermissions,
  getRoomMemberPermissions,
  hasCompleteRoomAsset,
  isProviderTrackMeta,
  resolveTrackDistributionStatus,
  roomSnapshotSchema
} from "./models";
import type { TrackMeta } from "../playlist/models";

describe("roomSnapshotSchema", () => {
  it("parses a valid room snapshot", () => {
    const result = roomSnapshotSchema.safeParse({
      room: {
        id: "room_1",
        hostId: "guest_1",
        joinCode: "ABC123",
        visibility: "private",
        roomType: "interactive",
        radioAutopilot: { enabled: false },
        members: [
          {
            id: "guest_1",
            nickname: "Host",
            role: "host",
            joinedAt: new Date().toISOString(),
            peerId: null
          }
        ],
        playback: {
          status: "paused",
          currentTrackId: null,
          currentQueueItemId: null,
          sourceSessionId: "guest_1",
          sourcePeerId: null,
          sourceTrackId: null,
          positionMs: 0,
          startedAt: null,
          queueVersion: 1,
          mediaEpoch: 0
        },
        roomRevision: 0
      },
      tracks: [],
      queue: [],
      playlists: []
    });

    expect(result.success).toBe(true);
  });

  it("fills permissions for legacy members and keeps the host unrestricted", () => {
    expect(
      getRoomMemberPermissions({ role: "member", permissions: { queue: false } })
    ).toEqual({ ...defaultRoomMemberPermissions, queue: false });
    expect(
      getRoomMemberPermissions({ role: "host", permissions: { library: false } })
    ).toEqual(defaultRoomMemberPermissions);
  });

  it("falls back to enabled permissions for legacy rooms", () => {
    expect(getNewMemberPermissions({})).toEqual(defaultRoomMemberPermissions);
    expect(getNewMemberPermissions({
      newMemberPermissions: { library: false, queue: true, player: false }
    })).toEqual({ library: false, queue: true, player: false });
  });

  describe("hasCompleteRoomAsset", () => {
    it("recognizes local track with fileHash as complete", () => {
      expect(hasCompleteRoomAsset({
        id: "t1",
        title: "Test",
        artist: "Artist",
        durationMs: 1000,
        sourceType: "local_upload",
        fileHash: "hash123",
        ownerSessionId: "u1",
        ownerNickname: "User"
      } as unknown as TrackMeta)).toBe(true);
    });

    it("requires playbackAsset and fileHash for provider tracks", () => {
      const providerTrack = {
        id: "t2",
        title: "Provider Track",
        artist: "Artist",
        durationMs: 1000,
        sourceType: "netease",
        sourceRef: { provider: "netease", trackId: "123" },
        ownerSessionId: "u1",
        ownerNickname: "User"
      } as unknown as TrackMeta;

      expect(hasCompleteRoomAsset(providerTrack)).toBe(false);

      expect(hasCompleteRoomAsset({
        ...providerTrack,
        fileHash: "hash123",
        playbackAsset: {
          assetId: "asset-1",
          codec: "opus",
          sampleRate: 48000,
          channels: 2,
          segmentDurationMs: 2000,
          totalSegments: 10,
          segments: []
        } as unknown as TrackMeta["playbackAsset"]
      })).toBe(true);
    });

    it("recognizes bilibili and alist tracks as provider tracks requiring complete assets", () => {
      const bilibiliTrack = {
        id: "t-bili",
        title: "Bili Track",
        artist: "UP",
        durationMs: 1000,
        sourceType: "bilibili",
        sourceRef: { provider: "bilibili", trackId: "BV1xx411c7mD" },
        ownerSessionId: "u1",
        ownerNickname: "User"
      } as unknown as TrackMeta;
      const alistTrack = {
        id: "t-alist",
        title: "Alist Track",
        artist: "Singer",
        durationMs: 1000,
        sourceType: "alist",
        sourceRef: { provider: "alist", trackId: "/music/song.flac" },
        ownerSessionId: "u1",
        ownerNickname: "User"
      } as unknown as TrackMeta;
      const localTrack = {
        id: "t-local",
        title: "Local Track",
        artist: "Artist",
        durationMs: 1000,
        sourceType: "local_upload",
        fileHash: "hash-local",
        ownerSessionId: "u1",
        ownerNickname: "User"
      } as unknown as TrackMeta;

      expect(isProviderTrackMeta(bilibiliTrack)).toBe(true);
      expect(isProviderTrackMeta(alistTrack)).toBe(true);
      expect(isProviderTrackMeta(localTrack)).toBe(false);
      expect(hasCompleteRoomAsset(bilibiliTrack)).toBe(false);
      expect(hasCompleteRoomAsset(alistTrack)).toBe(false);

      const completePlaybackAsset = {
        assetId: "asset-provider-1",
        codec: "opus",
        sampleRate: 48000,
        channels: 2,
        segmentDurationMs: 2000,
        totalSegments: 10,
        segments: []
      } as unknown as TrackMeta["playbackAsset"];

      expect(hasCompleteRoomAsset({
        ...bilibiliTrack,
        fileHash: "hash-bili",
        playbackAsset: completePlaybackAsset
      })).toBe(true);
      expect(hasCompleteRoomAsset({
        ...alistTrack,
        fileHash: "hash-alist",
        playbackAsset: completePlaybackAsset
      })).toBe(true);
    });

    it("returns false for undefined track", () => {
      expect(hasCompleteRoomAsset(undefined)).toBe(false);
    });
  });

  describe("resolveTrackDistributionStatus", () => {
    const track = {
      id: "t1",
      title: "Song",
      artist: "Singer",
      durationMs: 1000,
      sourceType: "local_upload",
      fileHash: "hash123",
      playbackAsset: { assetId: "asset-1" } as unknown as TrackMeta["playbackAsset"],
      ownerSessionId: "u1",
      ownerNickname: "User 1"
    } as unknown as TrackMeta;

    it("returns ready when complete and owner is online", () => {
      const status = resolveTrackDistributionStatus({
        track,
        members: [{ id: "u1", presenceState: "online" }]
      });
      expect(status.state).toBe("ready");
      expect(status.trackId).toBe("t1");
      expect(status.sourceSessionId).toBe("u1");
    });

    it("returns source-offline when owner is offline", () => {
      const status = resolveTrackDistributionStatus({
        track,
        members: [{ id: "u1", presenceState: "offline" }]
      });
      expect(status.state).toBe("source-offline");
      expect(status.sourceSessionId).toBe("u1");
    });

    it("returns source-missing when asset is missing and local file not available", () => {
      const incompleteTrack = { ...track, fileHash: "" };
      const status = resolveTrackDistributionStatus({
        track: incompleteTrack,
        members: [{ id: "u1", presenceState: "online" }],
        currentSessionId: "u1",
        localFileAvailable: false
      });
      expect(status.state).toBe("source-missing");
      expect(status.sourceSessionId).toBe("u1");
    });

    it("returns preparing when asset is incomplete but owner can prepare", () => {
      const incompleteTrack = { ...track, fileHash: "" };
      const status = resolveTrackDistributionStatus({
        track: incompleteTrack,
        members: [{ id: "u1", presenceState: "online" }],
        currentSessionId: "u1",
        localFileAvailable: true
      });
      expect(status.state).toBe("preparing");
    });

    it("respects assetUnavailableReason explicitly reported", () => {
      const statusMissing = resolveTrackDistributionStatus({
        track,
        members: [{ id: "u1", presenceState: "online" }],
        assetUnavailableReason: "source-missing"
      });
      expect(statusMissing.state).toBe("source-missing");
      expect(statusMissing.errorCode).toBe("source-missing");

      const statusCorrupt = resolveTrackDistributionStatus({
        track,
        members: [{ id: "u1", presenceState: "online" }],
        assetUnavailableReason: "asset-corrupt"
      });
      expect(statusCorrupt.state).toBe("failed");
      expect(statusCorrupt.errorCode).toBe("asset-corrupt");

      const statusDenied = resolveTrackDistributionStatus({
        track,
        members: [{ id: "u1", presenceState: "online" }],
        assetUnavailableReason: "permission-denied"
      });
      expect(statusDenied.state).toBe("failed");
      expect(statusDenied.errorCode).toBe("permission-denied");
    });
  });
});

