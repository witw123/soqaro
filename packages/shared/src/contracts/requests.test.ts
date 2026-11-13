import { describe, expect, it } from "vitest";
import {
  createPlaylistRequestSchema,
  createRoomRequestSchema,
  createRoomSongRequestSchema,
  insertRadioAutopilotNextTrackRequestSchema,
  joinRoomByCodeRequestSchema,
  joinRoomRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
  registerTrackRequestSchema,
  registerTracksRequestSchema,
  updatePlaylistRequestSchema,
  updateRadioAutopilotRequestSchema,
  updateRoomRequestSchema,
  updatePlaybackRequestSchema,
  reportTrackAssetUnavailableRequestSchema
} from "./requests";
import { personalizationTrackSchema } from "../personalization/models";
import { neteaseTrackCandidateSchema } from "../providers/netease";
import { qqMusicTrackCandidateSchema } from "../providers/qqmusic";
import { bilibiliTrackCandidateSchema } from "../providers/bilibili";

describe("request contracts", () => {
  it("trims auth input and rejects unknown fields", () => {
    expect(
      registerRequestSchema.parse({
        username: " Alice_1 ",
        password: "secret12",
        nickname: " Alice "
      })
    ).toEqual({
      username: "Alice_1",
      password: "secret12",
      nickname: "Alice"
    });

    expect(() =>
      registerRequestSchema.parse({
        username: "alice",
        password: "secret1",
        nickname: "Alice",
        role: "admin"
      })
    ).toThrow();

    expect(() =>
      loginRequestSchema.parse({
        username: "invalid account",
        password: "secret1"
      })
    ).toThrow();
  });

  it("validates room creation and join code payloads", () => {
    expect(createRoomRequestSchema.parse({
      visibility: "private",
      roomType: "interactive",
      name: "  Study Room ",
      description: "  For late night listening  ",
      password: "secret"
    })).toEqual({
      visibility: "private",
      roomType: "interactive",
      name: "Study Room",
      description: "For late night listening",
      password: "secret"
    });
    expect(joinRoomByCodeRequestSchema.parse({ joinCode: "abc123", password: "secret" })).toEqual({
      joinCode: "ABC123",
      password: "secret"
    });
    expect(joinRoomByCodeRequestSchema.parse({ joinCode: "abc123" })).toEqual({
      joinCode: "ABC123"
    });
    expect(() => createRoomRequestSchema.parse({ visibility: "friends", roomType: "interactive" })).toThrow();
    expect(() => createRoomRequestSchema.parse({ visibility: "public" })).toThrow();
    expect(() => createRoomRequestSchema.parse({
      visibility: "public",
      roomType: "radio",
      radioAutopilot: { enabled: false },
      newMemberPermissions: { library: true, queue: true, player: true }
    })).toThrow();
    expect(updateRoomRequestSchema.parse({
      visibility: "public",
      name: "Room",
      description: null,
      password: "",
      newMemberPermissions: { library: false, queue: true, player: false }
    }).newMemberPermissions).toEqual({ library: false, queue: true, player: false });
    expect(() => updateRoomRequestSchema.parse({
      visibility: "public",
      roomType: "radio",
      radioAutopilot: { enabled: false },
      name: "Room"
    })).toThrow();
    expect(updateRadioAutopilotRequestSchema.parse({ enabled: true })).toEqual({ enabled: true });
    expect(() => updateRadioAutopilotRequestSchema.parse({ enabled: true, seedTrackId: "track_seed" })).toThrow();
    expect(insertRadioAutopilotNextTrackRequestSchema.parse({ trackId: "track_next" })).toEqual({
      trackId: "track_next"
    });
    expect(() => insertRadioAutopilotNextTrackRequestSchema.parse({ trackIds: ["track_next"] })).toThrow();
  });

  it("validates track registration numeric bounds", () => {
    const validTrack = {
      title: "Song",
      artist: "Artist",
      album: null,
      durationMs: 120_000,
      bitrate: 320_000,
      sizeBytes: 5_000_000,
      fileHash: "hash",
      artworkUrl: null,
      sourceType: "local_upload" as const,
      originalAsset: {
        assetId: "a".repeat(64),
        kind: "original" as const,
        fileHash: "b".repeat(64),
        mimeType: "audio/flac",
        sizeBytes: 5_000_000,
        unitSize: 1_048_576 as const,
        unitCount: 5,
        merkleRoot: "c".repeat(64)
      },
      playbackAsset: {
        assetId: "d".repeat(64),
        kind: "playback" as const,
        sourceFileHash: "b".repeat(64),
        profileId: "opus-music-v4" as const,
        codec: "opus" as const,
        container: "audio/ogg" as const,
        sampleRate: 48_000 as const,
        channels: 2 as const,
        bitrate: 256_000 as const,
        durationMs: 120_000,
        segmentDurationMs: 2_000 as const,
        seekPrerollMs: 80 as const,
        unitCount: 60,
        merkleRoot: "e".repeat(64),
        encoder: { name: "@audio/opus-encode" as const, version: "3.4.0" as const }
      }
    };

    expect(registerTrackRequestSchema.parse(validTrack)).toMatchObject(validTrack);
    expect(
      registerTrackRequestSchema.parse({
        ...validTrack,
        lyrics: "  [00:01.00]Lyrics  ",
        translatedLyrics: "  [00:01.00]Translation  ",
        romanizedLyrics: "  [00:01.00]Romanized  "
      })
    ).toMatchObject({
      lyrics: "[00:01.00]Lyrics",
      translatedLyrics: "[00:01.00]Translation",
      romanizedLyrics: "[00:01.00]Romanized"
    });
    expect(() =>
      registerTrackRequestSchema.parse({
        ...validTrack,
        durationMs: -1
      })
    ).toThrow();
    expect(() => registerTrackRequestSchema.parse({ ...validTrack, audioPayload: "base64" })).toThrow();
    expect(() => registerTrackRequestSchema.parse({
      ...validTrack,
      playbackAsset: { ...validTrack.playbackAsset, payload: "base64" }
    })).toThrow();

    expect(
      registerTrackRequestSchema.parse({
        ...validTrack,
        sourceType: "netease",
        sourceRef: { provider: "netease", trackId: "123456" }
      })
    ).toMatchObject({
      sourceType: "netease",
      sourceRef: { provider: "netease", trackId: "123456" }
    });
    expect(
      registerTrackRequestSchema.parse({
        ...validTrack,
        sourceType: "qqmusic",
        sourceRef: { provider: "qqmusic", trackId: "003abc" }
      })
    ).toMatchObject({
      sourceType: "qqmusic",
      sourceRef: { provider: "qqmusic", trackId: "003abc" }
    });
    expect(() =>
      registerTrackRequestSchema.parse({
        ...validTrack,
        sourceType: "netease"
      })
    ).toThrow();
    expect(() =>
      registerTrackRequestSchema.parse({
        ...validTrack,
        sourceRef: { provider: "netease", trackId: "not-numeric" }
      })
    ).toThrow();
    expect(() =>
      registerTrackRequestSchema.parse({
        ...validTrack,
        sourceRef: null
      })
    ).toThrow();
    expect(() =>
      registerTrackRequestSchema.parse({
        ...validTrack,
        sourceType: "qqmusic",
        sourceRef: { provider: "netease", trackId: "123" }
      })
    ).toThrow();
    expect(() =>
      registerTrackRequestSchema.parse({
        ...validTrack,
        sourceType: "local_upload",
        sourceRef: { provider: "qqmusic", trackId: "123" }
      })
    ).toThrow();
  });

  it("requires positive playback expectedVersion", () => {
    expect(
      updatePlaybackRequestSchema.parse({
        action: "seek",
        positionMs: 1000,
        actorPeerId: "peer_1",
        expectedVersion: 1
      })
    ).toEqual({
      action: "seek",
      positionMs: 1000,
      actorPeerId: "peer_1",
      expectedVersion: 1
    });

    expect(() =>
      updatePlaybackRequestSchema.parse({
        action: "seek",
        positionMs: -1,
        expectedVersion: 1
      })
    ).toThrow();

    expect(() =>
      updatePlaybackRequestSchema.parse({
        action: "play",
        playbackAssetId: "not-an-asset-id",
        expectedVersion: 1
      })
    ).toThrow();
  });

  it("validates reportTrackAssetUnavailableRequestSchema", () => {
    expect(
      reportTrackAssetUnavailableRequestSchema.parse({
        trackId: "track_123",
        reason: "source-missing"
      })
    ).toEqual({
      trackId: "track_123",
      reason: "source-missing"
    });

    expect(
      reportTrackAssetUnavailableRequestSchema.parse({
        trackId: "track_123",
        reason: "asset-corrupt"
      })
    ).toEqual({
      trackId: "track_123",
      reason: "asset-corrupt"
    });

    expect(
      reportTrackAssetUnavailableRequestSchema.parse({
        trackId: "track_123",
        reason: "permission-denied"
      })
    ).toEqual({
      trackId: "track_123",
      reason: "permission-denied"
    });

    expect(() =>
      reportTrackAssetUnavailableRequestSchema.parse({
        trackId: "track_123",
        reason: "invalid-reason"
      })
    ).toThrow();
  });

  it("caps registerTracks batch size, trackIdListSchema size, and joinRoom password length", () => {
    expect(joinRoomRequestSchema.parse({})).toEqual({});
    expect(joinRoomRequestSchema.parse({ password: "  secret  " })).toEqual({ password: "secret" });
    expect(() => joinRoomRequestSchema.parse({ password: "x".repeat(129) })).toThrow();
    expect(() => joinRoomRequestSchema.parse({ password: "ok", extra: true })).toThrow();

    expect(() =>
      createPlaylistRequestSchema.parse({
        title: "Cap",
        trackIds: Array.from({ length: 1001 }, (_, index) => `track_${index}`)
      })
    ).toThrow();

    const minimalTrack = {
      title: "Track",
      artist: "Artist",
      album: null,
      durationMs: 120000,
      bitrate: null,
      sizeBytes: 1024,
      mimeType: "audio/mpeg",
      fileHash: "a".repeat(64),
      artworkUrl: null,
      sourceType: "local_upload" as const
    };
    expect(() =>
      registerTracksRequestSchema.parse({
        tracks: Array.from({ length: 501 }, () => minimalTrack)
      })
    ).toThrow();
  });

  it("validates artworkUrl/coverUrl and provider URLs against unsafe schemes", () => {
    const allowedArtworkUrls = [
      "https://cdn.example.com/cover.jpg",
      "http://localhost:3000/cover.png",
      "/v1/assets/asset_1/artwork",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    ];
    for (const url of allowedArtworkUrls) {
      expect(
        createPlaylistRequestSchema.parse({ title: "Safe", coverUrl: url }).coverUrl
      ).toBe(url);
      expect(
        updatePlaylistRequestSchema.parse({ coverUrl: url }).coverUrl
      ).toBe(url);
      expect(
        createRoomSongRequestSchema.parse({
          provider: "netease",
          providerTrackId: "1",
          title: "Song",
          artist: "Artist",
          durationMs: 1000,
          artworkUrl: url
        }).artworkUrl
      ).toBe(url);
      expect(
        registerTrackRequestSchema.parse({
          title: "Song",
          artist: "Artist",
          album: null,
          durationMs: 1000,
          bitrate: null,
          sizeBytes: 128,
          mimeType: "audio/mpeg",
          fileHash: "b".repeat(64),
          sourceType: "local_upload",
          artworkUrl: url
        }).artworkUrl
      ).toBe(url);
      expect(
        personalizationTrackSchema.parse({
          provider: "netease",
          providerTrackId: "1",
          access: "free",
          quality: null,
          title: "Song",
          artist: "Artist",
          album: null,
          durationMs: 1000,
          artworkUrl: url
        }).artworkUrl
      ).toBe(url);
    }

    const blockedArtworkUrls = [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+",
      "//evil.example/cover.png",
      "/\\evil.example/cover.png"
    ];
    for (const url of blockedArtworkUrls) {
      expect(() =>
        createPlaylistRequestSchema.parse({ title: "Bad", coverUrl: url })
      ).toThrow();
      expect(() =>
        createRoomSongRequestSchema.parse({
          provider: "netease",
          providerTrackId: "1",
          title: "Song",
          artist: "Artist",
          durationMs: 1000,
          artworkUrl: url
        })
      ).toThrow();
      expect(() =>
        registerTrackRequestSchema.parse({
          title: "Song",
          artist: "Artist",
          album: null,
          durationMs: 1000,
          bitrate: null,
          sizeBytes: 128,
          mimeType: "audio/mpeg",
          fileHash: "b".repeat(64),
          sourceType: "local_upload",
          artworkUrl: url
        })
      ).toThrow();
      expect(() =>
        personalizationTrackSchema.parse({
          provider: "netease",
          providerTrackId: "1",
          access: "free",
          quality: null,
          title: "Song",
          artist: "Artist",
          album: null,
          durationMs: 1000,
          artworkUrl: url
        })
      ).toThrow();
      expect(() =>
        bilibiliTrackCandidateSchema.parse({
          provider: "bilibili",
          providerTrackId: "BV1xx411c7mD",
          bvid: "BV1xx411c7mD",
          cid: 1,
          title: "Song",
          artist: "Artist",
          durationMs: 1000,
          artworkUrl: url
        })
      ).toThrow();
    }

    expect(() =>
      neteaseTrackCandidateSchema.parse({
        provider: "netease",
        providerTrackId: "1",
        access: "free",
        quality: "high",
        title: "Song",
        artist: "Artist",
        album: null,
        durationMs: 1000,
        artworkUrl: "javascript:alert(1)"
      })
    ).toThrow();

    expect(() =>
      qqMusicTrackCandidateSchema.parse({
        provider: "qqmusic",
        providerTrackId: "mid_1",
        access: "free",
        quality: "high",
        title: "Song",
        artist: "Artist",
        album: null,
        durationMs: 1000,
        artworkUrl: "data:image/svg+xml,<svg/>"
      })
    ).toThrow();
  });
});
