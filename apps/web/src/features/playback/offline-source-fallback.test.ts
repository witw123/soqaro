import { beforeEach, describe, expect, it, vi } from "vitest";

const indexedDbMocks = vi.hoisted(() => ({
  upsertCachedLibraryTrack: vi.fn()
}));

const apiMocks = vi.hoisted(() => ({
  soqaroApi: {
    downloadNeteaseTrack: vi.fn(),
    downloadQqMusicTrack: vi.fn(),
    getNeteaseLyrics: vi.fn(),
    getQqMusicLyrics: vi.fn()
  },
  resolveDownloadedAudioMimeType: vi.fn()
}));

const storageMocks = vi.hoisted(() => ({
  saveCachedAudioFileToLocalDirectory: vi.fn()
}));

const cacheLibraryMocks = vi.hoisted(() => ({
  buildCachedLibraryTrackUpsertRecord: vi.fn(),
  notifyCacheLibraryChanged: vi.fn()
}));

vi.mock("@/features/library/indexeddb", () => indexedDbMocks);
vi.mock("@/lib/network/soqaro-api", () => apiMocks);
vi.mock("@/features/library/local-audio-storage", () => storageMocks);
vi.mock("@/features/library/cache-library", () => cacheLibraryMocks);
import type { RoomSnapshot, TrackMeta } from "@soqaro/shared";
import { ensureOfflineProviderPlaybackAsset } from "./offline-source-fallback";

function buildTrack(overrides: Partial<TrackMeta> = {}) {
  return {
    id: "track_1",
    title: "Song",
    artist: "Artist",
    album: null,
    durationMs: 2_000,
    bitrate: null,
    sizeBytes: 5,
    codec: "mp3",
    mimeType: "audio/mpeg",
    fileHash: "b".repeat(64),
    artworkUrl: null,
    ownerSessionId: "owner_1",
    ownerNickname: "Owner",
    sourceType: "netease" as const,
    sourceRef: { provider: "netease" as const, trackId: "123" },
    ...overrides
  } satisfies TrackMeta;
}

function buildRoomSnapshot(track = buildTrack()) {
  return {
    room: {
      id: "room_1",
      playback: {
        status: "playing",
        currentTrackId: track.id,
        currentQueueItemId: null,
        sourceSessionId: track.ownerSessionId,
        sourcePeerId: "peer_owner",
        sourceTrackId: track.id,
        playbackAssetId: track.playbackAsset?.assetId ?? null,
        positionMs: 0,
        startedAt: "2026-07-24T00:00:00.000Z",
        startAt: "2026-07-24T00:00:00.000Z",
        playbackRevision: 1,
        mediaEpoch: 1,
        playbackMode: "sequence",
        queueVersion: 1,
        mediaState: "playing"
      },
      members: []
    },
    tracks: [track],
    queue: []
  } as unknown as RoomSnapshot;
}

function buildSource() {
  return {
    provider: "netease" as const,
    trackId: "123",
    label: "网易云音乐"
  };
}

function buildInput(overrides: Partial<Parameters<typeof ensureOfflineProviderPlaybackAsset>[0]> = {}) {
  return {
    roomSnapshot: buildRoomSnapshot(),
    track: buildTrack(),
    source: buildSource(),
    ...overrides
  };
}

describe("offline provider fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.soqaroApi.getNeteaseLyrics.mockResolvedValue({ plainLyric: null });
    apiMocks.resolveDownloadedAudioMimeType.mockResolvedValue("audio/mpeg");
    storageMocks.saveCachedAudioFileToLocalDirectory.mockResolvedValue(null);
    cacheLibraryMocks.buildCachedLibraryTrackUpsertRecord.mockReturnValue({});
  });

  it("falls back to streaming when provider caching fails", async () => {
    apiMocks.soqaroApi.downloadNeteaseTrack.mockRejectedValue(
      new Error("NetEase account is not available.")
    );

    await expect(ensureOfflineProviderPlaybackAsset({
      ...buildInput(),
      forceDownload: true
    })).resolves.toEqual({
      fileHash: "b".repeat(64),
      file: null
    });
  });

  it("keeps a shared download alive when the first caller is cancelled", async () => {
    let resolveDownload!: (value: { blob: Blob; contentType: string }) => void;
    const download = new Promise<{ blob: Blob; contentType: string }>((resolve) => {
      resolveDownload = resolve;
    });
    apiMocks.soqaroApi.downloadNeteaseTrack.mockReturnValue(download);

    const controller = new AbortController();
    const first = ensureOfflineProviderPlaybackAsset({
      ...buildInput(),
      signal: controller.signal
    });
    await vi.waitFor(() => expect(apiMocks.soqaroApi.downloadNeteaseTrack).toHaveBeenCalledOnce());
    controller.abort();

    const second = ensureOfflineProviderPlaybackAsset(buildInput());
    resolveDownload({
      blob: new Blob(["audio"], { type: "audio/mpeg" }),
      contentType: "audio/mpeg"
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.file).toBeInstanceOf(File);
    expect(secondResult.file).toBe(firstResult.file);
    expect(apiMocks.soqaroApi.downloadNeteaseTrack).toHaveBeenCalledOnce();
  });

  it("notifies active callers via onStatus and suppresses status callbacks after abort", async () => {
    apiMocks.soqaroApi.downloadNeteaseTrack.mockResolvedValue({
      blob: new Blob(["audio"], { type: "audio/mpeg" }),
      contentType: "audio/mpeg"
    });
    const statuses: string[] = [];

    const result = await ensureOfflineProviderPlaybackAsset({
      ...buildInput(),
      forceDownload: true,
      onStatus: (msg) => statuses.push(msg)
    });

    expect(result.file).toBeInstanceOf(File);
    expect(statuses).toEqual([
      "正在从网易云音乐下载并缓存《Song》…",
      "已从网易云音乐缓存《Song》，正在使用缓存音频播放。"
    ]);
  });
});
