import {
  hashAudioBlob,
  localPlaylistTrackId,
  providerTrackKey,
  toProviderTrackRecord,
  type ProviderTrack
} from "@/features/playlist/local-playlist";
import {
  normalizeLocalAudioMimeType,
  saveCachedAudioFileToLocalDirectory
} from "@/features/library/local-audio-storage";
import { resolveLocalArtworkUrl } from "@/features/library/audio-metadata";
import {
  deleteCachedLibraryTrack,
  deleteCachedLibraryTrackFile,
  getCachedLibraryTrack,
  getCachedLibraryTrackSummary,
  getLocalAudioFileRecord,
  getLocalAudioCacheFileRecord,
  listCachedLibraryTrackSummaries,
  listLocalAudioCacheFiles,
  listLocalAudioFiles,
  upsertCachedLibraryTrack,
  updateCachedLibraryTrackMetadata,
  type CachedLibraryTrackSummaryRecord,
  type LocalPlaylistTrackRecord
} from "@/features/library/indexeddb";
import { soqaroApi } from "@/lib/network/soqaro-api";
import { getAppSettings } from "@/features/settings/settings-store";
import { analyzeAudioBlobLoudness } from "./loudness";
import { downloadTrackWithFallback } from "./source-fallback-resolver";

export const providerPlaybackCacheChangedEvent = "soqaro-provider-playback-cache-changed";

export type ProviderPlaybackCacheChangeKind = "add" | "remove";

/** Download a provider track into the disposable playback cache, never the saved library. */
export async function cacheProviderTrackForPlayback(
  track: ProviderTrack,
  signal?: AbortSignal
): Promise<LocalPlaylistTrackRecord> {
  signal?.throwIfAborted();
  const existingCache = await findReusableProviderPlaybackCache(track);
  signal?.throwIfAborted();
  if (existingCache) return existingCache;

  const preferredQuality = getAppSettings().playback.preferredAudioQuality;
  const { response, actualTrack } = await downloadTrackWithFallback({
    track,
    preferredQuality,
    signal
  });
  signal?.throwIfAborted();
  const fileHash = await hashAudioBlob(response.blob);
  signal?.throwIfAborted();
  const mimeType = normalizeLocalAudioMimeType(response.contentType || response.blob.type);
  await upsertCachedLibraryTrack({
    fileHash,
    title: track.title,
    artist: track.artist,
    album: track.album,
    artworkUrl: track.artworkUrl,
    lyrics: null,
    translatedLyrics: null,
    romanizedLyrics: null,
    provider: actualTrack.provider,
    providerTrackId: actualTrack.providerTrackId,
    mimeType,
    durationMs: track.durationMs,
    sizeBytes: response.blob.size,
    file: response.blob,
    sourceTrackIds: [],
    sourceRoomIds: [],
    lastSourceTrackId: null,
    lastSourceRoomId: null,
    lastOwnerNickname: null
  });

  signal?.throwIfAborted();
  notifyProviderPlaybackCacheChanged([fileHash], "add");

  // Keep the Blob in IndexedDB until the directory copy has committed.
  // Yield a task so playback can bind its audio before optional work starts.
  setTimeout(async () => {
    await completePlaybackMetadata(actualTrack, response.blob, fileHash).catch(() => undefined);
    const saved = await saveCachedAudioFileToLocalDirectory({
      file: response.blob,
      fileHash,
      title: actualTrack.title,
      mimeType,
      provider: actualTrack.provider
    }).catch(() => null);
    if (saved) {
      await deleteCachedLibraryTrackFile(fileHash).catch(() => undefined);
    }
  }, 0);

  return {
    ...toProviderTrackRecord(track),
    id: localPlaylistTrackId(track),
    fileHash,
    fileName: null,
    sizeBytes: response.blob.size,
    mimeType,
    lyrics: null,
    translatedLyrics: null,
    romanizedLyrics: null,
    availableOffline: false,
    updatedAt: new Date().toISOString()
  };
}

async function completePlaybackMetadata(track: ProviderTrack, file: Blob, fileHash: string) {
  const artwork = async () => {
    const resolved = await resolveProviderTrack(track);
    const downloaded = resolved.provider === "qqmusic" && resolved.artworkUrl && /^https?:\/\//i.test(resolved.artworkUrl)
      ? await soqaroApi.downloadQqMusicArtwork(resolved.artworkUrl).catch(() => null)
      : null;
    return resolveLocalArtworkUrl(file, resolved.artworkUrl, downloaded?.blob);
  };
  const [artworkUrl, lyricPayload, loudness] = await Promise.all([
    artwork().catch(() => track.artworkUrl),
    (track.provider === "netease"
      ? soqaroApi.getNeteaseLyrics(track.providerTrackId)
      : track.provider === "qqmusic"
        ? soqaroApi.getQqMusicLyrics(track.providerTrackId)
        : soqaroApi.getBilibiliLyrics(track.providerTrackId)
    ).catch(() => null),
    analyzeAudioBlobLoudness(file, { cacheKey: fileHash }).catch(() => null)
  ]);
  await updateCachedLibraryTrackMetadata(fileHash, {
    artworkUrl,
    ...(lyricPayload ? {
      lyrics: lyricPayload.wordSyncedLyric ?? lyricPayload.plainLyric ?? null,
      translatedLyrics: lyricPayload.translatedLyric ?? null,
      romanizedLyrics: lyricPayload.romanizedLyric ?? null
    } : {}),
    ...(loudness ? { loudness } : {})
  });
  notifyProviderPlaybackCacheChanged([fileHash], "add");
}

/** Look up an existing playback-cache entry for a provider track without downloading anything. */
export async function findCachedProviderPlaybackRecord(track: ProviderTrack): Promise<LocalPlaylistTrackRecord | null> {
  return findReusableProviderPlaybackCache(track);
}

/** Remove one provider playback cache unless it has become a saved local file. */
export async function releaseProviderTrackPlaybackCache(fileHash: string | null | undefined) {
  if (!fileHash) return false;
  const [cached, summary, savedFile, localCacheFile] = await Promise.all([
    getCachedLibraryTrack(fileHash),
    getCachedLibraryTrackSummary(fileHash),
    getLocalAudioFileRecord(fileHash, "saved"),
    getLocalAudioCacheFileRecord(fileHash)
  ]);
  const record = cached ?? summary;
  if (!isDisposableProviderPlaybackCache(record) || savedFile) return false;

  // Queue lifecycle only owns the browser copy. A configured local cache is
  // intentionally retained so the next playback can reuse it.
  if (cached) {
    await deleteCachedLibraryTrackFile(fileHash);
  }
  if (!localCacheFile && (cached || summary)) {
    await deleteCachedLibraryTrack(fileHash);
  }
  if (cached || (!localCacheFile && summary)) {
    notifyProviderPlaybackCacheChanged([fileHash], "remove");
    return true;
  }
  return false;
}

export async function hasProviderTrackPlaybackCache(fileHash: string | null | undefined) {
  if (!fileHash) return false;
  const [browserCache, localCache] = await Promise.all([
    getCachedLibraryTrack(fileHash).catch(() => null),
    getLocalAudioCacheFileRecord(fileHash).catch(() => null)
  ]);
  return Boolean(browserCache || localCache);
}

/**
 * Provider+track keys (`provider:netease:123`) whose audio already sits in
 * the playback cache. Playlist rows only carry provider identity, not a
 * fileHash, so cache availability for their queueable/playable state has to
 * be resolved by provider key instead.
 */
export async function listCachedProviderPlaybackTrackKeys() {
  const summaries = await listCachedLibraryTrackSummaries().catch(() => []);
  const keys = new Set<string>();
  for (const summary of summaries) {
    if (
      (summary.provider === "netease" ||
        summary.provider === "qqmusic" ||
        summary.provider === "bilibili") &&
      summary.providerTrackId
    ) {
      keys.add(providerTrackKey(summary.provider, summary.providerTrackId));
    }
  }
  return keys;
}

/** Remove provider playback caches left behind by a previous page session. */
export async function cleanupProviderTrackPlaybackCache() {
  const [summaries, savedFiles, localCacheFiles] = await Promise.all([
    listCachedLibraryTrackSummaries(),
    listLocalAudioFiles("saved"),
    listLocalAudioCacheFiles()
  ]);
  const savedHashes = new Set(savedFiles.map((file) => file.fileHash));
  const localCacheHashes = new Set(localCacheFiles.map((file) => file.fileHash));
  const removable = summaries.filter((summary) =>
    isDisposableProviderPlaybackCache(summary) && !savedHashes.has(summary.fileHash)
  );
  const removedBrowserHashes: string[] = [];

  await Promise.all(removable.map(async (summary) => {
    const browserCache = await getCachedLibraryTrack(summary.fileHash).catch(() => null);
    if (browserCache) {
      await deleteCachedLibraryTrackFile(summary.fileHash);
      removedBrowserHashes.push(summary.fileHash);
    }
    if (!localCacheHashes.has(summary.fileHash)) {
      await deleteCachedLibraryTrack(summary.fileHash);
      if (!browserCache) removedBrowserHashes.push(summary.fileHash);
    }
  }));
  notifyProviderPlaybackCacheChanged(removedBrowserHashes, "remove");
  return removedBrowserHashes.length;
}

async function findReusableProviderPlaybackCache(track: ProviderTrack) {
  const summaries = await listCachedLibraryTrackSummaries().catch(() => []);
  const summary = summaries.find((candidate) =>
    candidate.provider === track.provider &&
    candidate.providerTrackId === track.providerTrackId
  );
  if (!summary) return null;

  const [browserCache, localCacheFile] = await Promise.all([
    getCachedLibraryTrack(summary.fileHash).catch(() => null),
    getLocalAudioCacheFileRecord(summary.fileHash).catch(() => null)
  ]);
  if (!browserCache && !localCacheFile) return null;
  return {
    ...toProviderTrackRecord(track),
    id: localPlaylistTrackId(track),
    fileHash: summary.fileHash,
    fileName: localCacheFile?.fileName ?? null,
    sizeBytes: summary.sizeBytes,
    mimeType: summary.mimeType,
    artworkUrl: summary.artworkUrl ?? track.artworkUrl,
    lyrics: summary.lyrics ?? null,
    translatedLyrics: summary.translatedLyrics ?? null,
    romanizedLyrics: summary.romanizedLyrics ?? null,
    ...(summary.loudness ? { loudness: summary.loudness } : {}),
    availableOffline: false,
    updatedAt: summary.cachedAt
  } satisfies LocalPlaylistTrackRecord;
}

function isDisposableProviderPlaybackCache(
  record: Pick<CachedLibraryTrackSummaryRecord, "provider" | "providerTrackId" | "sourceTrackIds" | "sourceRoomIds"> | null | undefined
) {
  return !!record
    && (record.provider === "netease" || record.provider === "qqmusic" || record.provider === "bilibili" || record.provider === "alist")
    && !!record.providerTrackId
    && record.sourceTrackIds.length === 0
    && record.sourceRoomIds.length === 0;
}

function notifyProviderPlaybackCacheChanged(
  fileHashes: string[],
  kind: ProviderPlaybackCacheChangeKind = "remove"
) {
  if (typeof window === "undefined" || fileHashes.length === 0) return;
  window.dispatchEvent(new CustomEvent(providerPlaybackCacheChangedEvent, {
    detail: { fileHashes, kind }
  }));
}

async function resolveProviderTrack(track: ProviderTrack): Promise<ProviderTrack> {
  if (track.artworkUrl) return track;
  try {
    if (track.provider === "netease") {
      return await soqaroApi.getNeteaseTrack(track.providerTrackId);
    }
    if (track.provider === "qqmusic") {
      return await soqaroApi.getQqMusicTrack(track.providerTrackId);
    }
    if (track.provider === "bilibili") {
      const bvid = track.bvid ?? track.providerTrackId.split(":")[0]!;
      const detail = await soqaroApi.getBilibiliView(bvid);
      return {
        ...track,
        artworkUrl: detail.pic
      };
    }
    return track;
  } catch {
    return track;
  }
}
