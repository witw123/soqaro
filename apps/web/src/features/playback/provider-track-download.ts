import type { LocalPlaylistTrackRecord } from "@/features/library/indexeddb";
import {
  hashAudioBlob,
  toProviderTrackRecord,
  upsertLocalPlaylistTrack,
  type ProviderTrack
} from "@/features/playlist/local-playlist";
import {
  ensureLocalAudioDirectoryWriteAccess,
  normalizeLocalAudioMimeType,
  saveAudioFileToLocalDirectory
} from "@/features/library/local-audio-storage";
import { soqaroApi } from "@/lib/network/soqaro-api";
import { getAppSettings } from "@/features/settings/settings-store";
import { analyzeAudioBlobLoudness } from "./loudness";
import { findCachedProviderPlaybackRecord } from "./provider-track-cache";
import { loadLocalAudioFile } from "./local-player-track-utils";
import { isProviderTrackInput } from "./provider-playback-preparation";

/**
 * Explicit "download to my local audio directory" flow. This is the only path
 * that writes into the user-managed library (plus its playlist metadata) -
 * pressing play never touches it.
 *
 * Before hitting the provider download API the disposable playback cache is
 * consulted: a cached blob is copied straight into the local directory, and a
 * cache miss downloads once from the provider.
 */
export async function downloadProviderTrackToLibrary(input: {
  track: ProviderTrack | LocalPlaylistTrackRecord;
  existing?: LocalPlaylistTrackRecord | null;
  onResolved?: (resolvedTrack: LocalPlaylistTrackRecord) => void;
}): Promise<LocalPlaylistTrackRecord> {
  const { track, existing } = input;
  const provider = track.provider === "netease" || track.provider === "qqmusic" || track.provider === "bilibili"
    ? track.provider
    : null;
  if (!provider || !track.providerTrackId) {
    throw new Error("这首歌不是在线歌曲，无法下载到本地目录。");
  }
  const providerTrackId = track.providerTrackId;
  const existingRecord = existing ?? (isProviderTrackInput(track) ? null : track);

  const baseTrack: ProviderTrack = isProviderTrackInput(track)
    ? track
    : {
        provider,
        providerTrackId,
        access: "unknown",
        quality: null,
        title: track.title,
        artist: track.artist,
        album: track.album,
        durationMs: track.durationMs,
        artworkUrl: track.artworkUrl
      };
  const resolvedTrack = await resolveProviderTrackArtwork(baseTrack);
  const recordForSave = toProviderTrackRecord(resolvedTrack, existingRecord ?? undefined);
  input.onResolved?.(recordForSave);

  if (!(await ensureLocalAudioDirectoryWriteAccess())) {
    throw new Error("请先在我的页面选择本地歌曲保存位置。");
  }

  // Reuse the playback cache when it already holds the full audio.
  const cachedRecord = await findCachedProviderPlaybackRecord(resolvedTrack).catch(() => null);
  const cachedBlob = cachedRecord
    ? await loadLocalAudioFile(cachedRecord).catch(() => null)
    : null;

  let blob: Blob;
  let fileHash: string;
  let mimeType: string;
  let loudness: NonNullable<LocalPlaylistTrackRecord["loudness"]> | undefined;
  let lyrics: string | null;
  let translatedLyrics: string | null;
  let romanizedLyrics: string | null;

  if (cachedRecord?.fileHash && cachedBlob) {
    blob = cachedBlob;
    fileHash = cachedRecord.fileHash;
    mimeType = cachedRecord.mimeType;
    loudness = cachedRecord.loudness;
    lyrics = existingRecord?.lyrics ?? cachedRecord.lyrics ?? null;
    translatedLyrics = cachedRecord.translatedLyrics ?? null;
    romanizedLyrics = cachedRecord.romanizedLyrics ?? null;
  } else {
    const preferredQuality = getAppSettings().playback.preferredAudioQuality;
    const response = provider === "netease"
      ? await soqaroApi.downloadNeteaseTrack(providerTrackId, preferredQuality)
      : provider === "bilibili"
        ? await soqaroApi.downloadBilibiliTrack(providerTrackId)
        : await soqaroApi.downloadQqMusicTrack(providerTrackId, preferredQuality);
    blob = response.blob;
    fileHash = await hashAudioBlob(blob);
    mimeType = normalizeLocalAudioMimeType(response.contentType || blob.type);
    loudness = (await analyzeAudioBlobLoudness(blob, { cacheKey: fileHash })) ?? undefined;
    const lyricPayload = existingRecord?.lyrics
      ? null
      : await (provider === "netease"
        ? soqaroApi.getNeteaseLyrics(providerTrackId)
        : provider === "bilibili"
          ? soqaroApi.getBilibiliLyrics(providerTrackId)
          : soqaroApi.getQqMusicLyrics(providerTrackId)
      ).catch(() => null);
    lyrics = existingRecord?.lyrics
      ?? lyricPayload?.wordSyncedLyric
      ?? lyricPayload?.plainLyric
      ?? null;
    translatedLyrics = lyricPayload?.translatedLyric ?? null;
    romanizedLyrics = lyricPayload?.romanizedLyric ?? null;
  }

  const saved = await saveAudioFileToLocalDirectory({
    file: blob,
    fileHash,
    title: resolvedTrack.title,
    mimeType,
    track: {
      artist: resolvedTrack.artist,
      album: resolvedTrack.album,
      artworkUrl: resolvedTrack.artworkUrl,
      lyrics,
      translatedLyrics,
      romanizedLyrics,
      provider,
      providerTrackId,
      durationMs: resolvedTrack.durationMs,
      sizeBytes: blob.size,
      ...(loudness ? { loudness } : {})
    }
  });

  const updatedTrack: LocalPlaylistTrackRecord = {
    ...recordForSave,
    artworkUrl: saved.artworkUrl ?? resolvedTrack.artworkUrl,
    fileHash,
    fileName: saved.fileName,
    sizeBytes: blob.size,
    mimeType,
    lyrics,
    translatedLyrics,
    romanizedLyrics,
    ...(loudness ? { loudness } : {}),
    availableOffline: true,
    updatedAt: new Date().toISOString()
  };
  await upsertLocalPlaylistTrack(updatedTrack);
  return updatedTrack;
}

async function resolveProviderTrackArtwork(track: ProviderTrack): Promise<ProviderTrack> {
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
