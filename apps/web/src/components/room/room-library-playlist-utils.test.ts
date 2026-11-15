import { describe, expect, it } from "vitest";
import type { Playlist, TrackMeta } from "@soqaro/shared";
import type {
  CachedLibraryTrackSummaryRecord,
  LocalPlaylistTrackRecord
} from "@/features/library/indexeddb";
import {
  buildFallbackPlaylistTracks,
  buildRoomTrackKeySet,
  extractLocalFileHash,
  getRoomPlaylistSource,
  getRoomPlaylistSourceKey,
  isTrackInRoom,
  parsePlaylistProviderTrack
} from "./room-library-playlist-utils";

function makePlaylist(tags: string[], trackIds: string[] = []): Playlist {
  return {
    id: "pl-1",
    ownerId: "user-1",
    title: "测试歌单",
    description: null,
    coverUrl: null,
    tags,
    isCollaborative: false,
    trackIds,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("room-library-playlist-utils", () => {
  it("resolves album, network, and direct playlist sources and stable keys", () => {
    const albumSource = getRoomPlaylistSource(makePlaylist(["album:qqmusic:00123"]));
    expect(albumSource).toEqual({ type: "album", provider: "qqmusic", albumId: "00123" });
    expect(getRoomPlaylistSourceKey(albumSource)).toBe("album:qqmusic:00123");

    const neteaseSource = getRoomPlaylistSource(makePlaylist(["network:netease:998877"]));
    expect(neteaseSource).toEqual({ type: "playlist", provider: "netease", playlistId: "998877" });
    expect(getRoomPlaylistSourceKey(neteaseSource)).toBe("playlist:netease:998877");

    const bilibiliSource = getRoomPlaylistSource(makePlaylist(["bilibili:BV1xx411c7mD"]));
    expect(bilibiliSource).toEqual({ type: "bilibili", bvid: "BV1xx411c7mD" });
    expect(getRoomPlaylistSourceKey(bilibiliSource)).toBe("bilibili:BV1xx411c7mD");

    expect(getRoomPlaylistSource(makePlaylist(["local_playlist"]))).toBeNull();
    expect(getRoomPlaylistSourceKey(null)).toBe("");
  });

  it("parses provider-prefixed track IDs without dropping bilibili cid or misclassifying local entries", () => {
    const netease = parsePlaylistProviderTrack("provider:netease:1859245776");
    expect(netease).toMatchObject({ provider: "netease", providerTrackId: "1859245776" });

    // Non-numeric netease IDs must be rejected instead of generating invalid NetEase requests.
    expect(parsePlaylistProviderTrack("provider:netease:abc")).toBeNull();

    const qq = parsePlaylistProviderTrack("qqmusic:0039MnYb0qxYhV");
    expect(qq).toMatchObject({ provider: "qqmusic", providerTrackId: "0039MnYb0qxYhV" });

    const biliWithCid = parsePlaylistProviderTrack("provider:bilibili:BV1xx411c7mD:987654");
    expect(biliWithCid).toMatchObject({
      provider: "bilibili",
      providerTrackId: "BV1xx411c7mD:987654",
      bvid: "BV1xx411c7mD",
      cid: 987654
    });

    const bareBvid = parsePlaylistProviderTrack("BV1xx411c7mD");
    expect(bareBvid).toMatchObject({
      provider: "bilibili",
      providerTrackId: "BV1xx411c7mD",
      bvid: "BV1xx411c7mD"
    });

    expect(parsePlaylistProviderTrack("local:deadbeef")).toBeNull();
    expect(extractLocalFileHash("local:deadbeef")).toBe("deadbeef");
    expect(extractLocalFileHash("provider:netease:123")).toBeNull();
  });

  it("matches room tracks across provider:, local:, and raw keys", () => {
    const roomTracks: TrackMeta[] = [
      {
        id: "track-1",
        title: "NetEase Song",
        artist: "Artist A",
        album: null,
        lyrics: null,
        artworkUrl: null,
        durationMs: 180_000,
        bitrate: null,
        codec: "mp3",
        mimeType: "audio/mpeg",
        fileHash: "hash-1",
        sizeBytes: 1024,
        ownerSessionId: "user-1",
        ownerNickname: "Tester",
        sourceType: "netease",
        sourceRef: { provider: "netease", trackId: "12345" }
      },
      {
        id: "track-2",
        title: "Local Song",
        artist: "Artist B",
        album: null,
        lyrics: null,
        artworkUrl: null,
        durationMs: 200_000,
        bitrate: null,
        codec: "flac",
        mimeType: "audio/flac",
        fileHash: "hash-local-only",
        sizeBytes: 2048,
        ownerSessionId: "user-1",
        ownerNickname: "Tester",
        sourceType: "local_upload"
      }
    ];

    const keySet = buildRoomTrackKeySet(roomTracks);
    expect(isTrackInRoom(keySet, "provider:netease:12345")).toBe(true);
    expect(isTrackInRoom(keySet, "netease:12345")).toBe(true);
    expect(isTrackInRoom(keySet, "local:hash-local-only")).toBe(true);
    expect(isTrackInRoom(keySet, "hash-local-only")).toBe(true);
    expect(isTrackInRoom(keySet, "local:missing-hash")).toBe(false);
    expect(isTrackInRoom(keySet, "provider:qqmusic:999")).toBe(false);
  });

  it("builds fallback tracks from local records, cached summaries, and raw provider IDs", () => {
    const localTracks: LocalPlaylistTrackRecord[] = [
      {
        id: "local-1",
        title: "Cached Provider Song",
        artist: "Singer",
        album: "Album",
        durationMs: 210_000,
        mimeType: "audio/mpeg",
        sizeBytes: 1000,
        artworkUrl: null,
        lyrics: null,
        provider: "qqmusic",
        providerTrackId: "001122",
        fileHash: null,
        fileName: null,
        availableOffline: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ];

    const cachedSummaries: CachedLibraryTrackSummaryRecord[] = [
      {
        fileHash: "hash-local-99",
        title: "Local Uploaded Song",
        artist: "Local Artist",
        album: "Local Album",
        artworkUrl: null,
        mimeType: "audio/flac",
        durationMs: 195_000,
        sizeBytes: 4096,
        cachedAt: "2026-01-01T00:00:00.000Z",
        sourceTrackIds: ["t-1"],
        sourceRoomIds: ["r-1"],
        lastSourceTrackId: "t-1",
        lastSourceRoomId: "r-1",
        lastOwnerNickname: "Tester"
      }
    ];

    const resolved = buildFallbackPlaylistTracks(
      [
        "provider:qqmusic:001122",
        "local:hash-local-99",
        "provider:bilibili:BV1ab411c7mD:5566",
        "local:missing-hash"
      ],
      localTracks,
      cachedSummaries
    );

    expect(resolved[0]).toMatchObject({
      key: "qqmusic:001122",
      title: "Cached Provider Song",
      cachedTrack: null
    });
    expect(resolved[0]?.providerTrack).toMatchObject({
      provider: "qqmusic",
      providerTrackId: "001122"
    });

    expect(resolved[1]).toMatchObject({
      key: "local:hash-local-99",
      title: "Local Uploaded Song",
      artist: "Local Artist",
      providerTrack: null
    });
    expect(resolved[1]?.cachedTrack).toMatchObject({
      fileHash: "hash-local-99",
      title: "Local Uploaded Song"
    });

    expect(resolved[2]?.providerTrack).toMatchObject({
      provider: "bilibili",
      providerTrackId: "BV1ab411c7mD:5566",
      bvid: "BV1ab411c7mD",
      cid: 5566
    });

    expect(resolved[3]).toMatchObject({
      key: "local:missing-hash",
      title: "曲目 4",
      providerTrack: null,
      cachedTrack: null
    });
  });
});
