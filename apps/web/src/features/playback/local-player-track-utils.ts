import {
  synchronizeShuffleBagTrackIds,
  takeNextShuffleTrack,
  type PlaybackMode,
  type PlaybackSnapshot,
  type TrackMeta
} from "@soqaro/shared";
import {
  getCachedLibraryTrack,
  upsertCachedLibraryTrack,
  upsertLocalPlaylistTrack,
  type LocalPlaylistTrackRecord
} from "@/features/library/indexeddb";
import {
  getLocalAudioCacheFile,
  getLocalAudioFile
} from "@/features/library/local-audio-storage";
import { readEmbeddedAudioMetadata } from "@/features/library/audio-metadata";
import { analyzeAudioBlobLoudness } from "./loudness";

export const localQueueOwnerId = "local-playlist";

export function buildLocalQueueItemId(trackId: string) {
  return `local-queue:${trackId}`;
}

export function firstMetadataText(...values: Array<string | null | undefined>) {
  return values.find((value) => Boolean(value?.trim()))?.trim() ?? null;
}

export function isBrowserLocalArtwork(value: string | null | undefined) {
  return Boolean(value && /^(?:data|blob):/i.test(value));
}

export function mergeLocalTrackRecord(
  track: LocalPlaylistTrackRecord,
  libraryRecords: readonly LocalPlaylistTrackRecord[]
): LocalPlaylistTrackRecord {
  const libraryTrack = libraryRecords.find(
    (candidate) =>
      candidate.id === track.id ||
      (!!track.fileHash && candidate.fileHash === track.fileHash) ||
      (!!track.providerTrackId &&
        candidate.provider === track.provider &&
        candidate.providerTrackId === track.providerTrackId)
  );
  if (!libraryTrack) {
    return {
      ...track,
      title: firstMetadataText(track.title) ?? "未命名歌曲",
      artist: firstMetadataText(track.artist) ?? "本地歌曲",
      album: track.album ?? null
    };
  }

  return {
    ...libraryTrack,
    ...track,
    title: firstMetadataText(track.title) ?? firstMetadataText(libraryTrack.title) ?? "未命名歌曲",
    artist: firstMetadataText(track.artist) ?? firstMetadataText(libraryTrack.artist) ?? "本地歌曲",
    album: track.album ?? libraryTrack.album,
    durationMs: track.durationMs || libraryTrack.durationMs,
    mimeType: track.mimeType || libraryTrack.mimeType,
    sizeBytes: track.sizeBytes || libraryTrack.sizeBytes,
    artworkUrl: isBrowserLocalArtwork(libraryTrack.artworkUrl)
      ? libraryTrack.artworkUrl
      : track.artworkUrl ?? libraryTrack.artworkUrl,
    lyrics: track.lyrics ?? libraryTrack.lyrics,
    translatedLyrics: track.translatedLyrics ?? libraryTrack.translatedLyrics,
    romanizedLyrics: track.romanizedLyrics ?? libraryTrack.romanizedLyrics,
    loudness: track.loudness ?? libraryTrack.loudness,
    fileHash: track.fileHash ?? libraryTrack.fileHash,
    fileName: track.fileName ?? libraryTrack.fileName,
    sourceDirectoryId: track.sourceDirectoryId ?? libraryTrack.sourceDirectoryId,
    availableOffline: track.availableOffline || libraryTrack.availableOffline
  };
}

export function toTrackMeta(track: LocalPlaylistTrackRecord): TrackMeta {
  const sourceRef =
    track.provider === "local_upload"
      ? undefined
      : { provider: track.provider, trackId: track.providerTrackId ?? track.id };

  return {
    id: track.id,
    title: firstMetadataText(track.title) ?? "未命名歌曲",
    artist: firstMetadataText(track.artist) ?? "本地歌曲",
    album: track.album ?? null,
    durationMs: Number.isFinite(track.durationMs) ? track.durationMs : 0,
    bitrate: null,
    sizeBytes: track.sizeBytes,
    codec: null,
    mimeType: track.mimeType,
    lyrics: track.lyrics,
    translatedLyrics: track.translatedLyrics ?? null,
    romanizedLyrics: track.romanizedLyrics ?? null,
    fileHash: track.fileHash ?? track.id,
    artworkUrl: track.artworkUrl,
    ownerSessionId: localQueueOwnerId,
    ownerNickname: "本地歌单",
    sourceType: track.provider,
    sourceRef,
    ...(track.loudness ? { loudness: track.loudness } : {})
  };
}

export async function loadLocalAudioFile(track: LocalPlaylistTrackRecord): Promise<Blob | null> {
  if (!track.fileHash) return null;

  const localFile = await getLocalAudioFile(
    track.fileHash,
    track.sourceDirectoryId,
    track.fileName
  );
  if (localFile) return localFile;

  const cachedRecord = await getCachedLibraryTrack(track.fileHash);
  if (cachedRecord?.file) return cachedRecord.file;

  const cachedFile = await getLocalAudioCacheFile(track.fileHash);
  if (cachedFile) return cachedFile;

  // Support Alist online streaming: fetch via stream endpoint
  if (track.provider === "alist" && track.fileName && (track.fileName.startsWith("/") || track.fileName.startsWith("http"))) {
    try {
      const res = await fetch(track.fileName);
      if (res.ok) return await res.blob();
    } catch {
      // ignore
    }
  }

  return null;
}

export async function enrichTrackMetadata(
  track: LocalPlaylistTrackRecord,
  file: Blob,
  metadataEnrichedHashes: Set<string>
): Promise<LocalPlaylistTrackRecord> {
  const needsMetadata =
    !track.title?.trim() ||
    !track.artist?.trim() ||
    !track.album ||
    !Number.isFinite(track.durationMs) ||
    track.durationMs <= 0 ||
    !track.artworkUrl ||
    !track.lyrics;
  if (!needsMetadata || (track.fileHash && metadataEnrichedHashes.has(track.fileHash))) {
    return track;
  }

  const [embedded, cached] = await Promise.all([
    readEmbeddedAudioMetadata(file),
    track.fileHash ? getCachedLibraryTrack(track.fileHash).catch(() => null) : Promise.resolve(null)
  ]);
  const loudness = track.loudness ?? cached?.loudness ?? null;
  if (!loudness && track.fileHash) {
    void analyzeAudioBlobLoudness(file).then((result) => {
      if (result && track.fileHash) {
        getCachedLibraryTrack(track.fileHash).then((record) => {
          if (record) {
            upsertCachedLibraryTrack({ ...record, loudness: result });
          }
        }).catch(() => undefined);
      }
    }).catch(() => undefined);
  }
  if (track.fileHash) metadataEnrichedHashes.add(track.fileHash);
  const preferEmbedded = track.provider === "local_upload";
  const nextTrack: LocalPlaylistTrackRecord = {
    ...track,
    title:
      firstMetadataText(
        preferEmbedded ? embedded.title : null,
        cached?.title,
        track.title,
        embedded.title
      ) ?? "未命名歌曲",
    artist:
      firstMetadataText(
        preferEmbedded ? embedded.artist : null,
        cached?.artist,
        track.artist,
        embedded.artist
      ) ?? "本地歌曲",
    album: firstMetadataText(
      preferEmbedded ? embedded.album : null,
      cached?.album,
      track.album,
      embedded.album
    ),
    durationMs:
      (preferEmbedded ? embedded.durationMs : null) ??
      cached?.durationMs ??
      (track.durationMs > 0 ? track.durationMs : null) ??
      embedded.durationMs ??
      0,
    artworkUrl: firstMetadataText(
      preferEmbedded ? embedded.artworkUrl : null,
      cached?.artworkUrl,
      track.artworkUrl,
      embedded.artworkUrl
    ),
    lyrics: firstMetadataText(
      preferEmbedded ? embedded.lyrics : null,
      cached?.lyrics,
      track.lyrics,
      embedded.lyrics
    ),
    ...(loudness ? { loudness } : {}),
    mimeType: track.mimeType || file.type || cached?.mimeType || track.mimeType,
    sizeBytes: track.sizeBytes || file.size || cached?.sizeBytes || track.sizeBytes
  };

  const changed =
    nextTrack.title !== track.title ||
    nextTrack.artist !== track.artist ||
    nextTrack.album !== track.album ||
    nextTrack.durationMs !== track.durationMs ||
    nextTrack.artworkUrl !== track.artworkUrl ||
    nextTrack.lyrics !== track.lyrics ||
    nextTrack.mimeType !== track.mimeType ||
    nextTrack.sizeBytes !== track.sizeBytes;
  const loudnessChanged = nextTrack.loudness?.gainDb !== track.loudness?.gainDb;
  if (!changed && !loudnessChanged) return nextTrack;

  const persistedTrack = {
    ...nextTrack,
    updatedAt: new Date().toISOString()
  };
  void upsertLocalPlaylistTrack(persistedTrack).catch(() => {
    if (track.fileHash) metadataEnrichedHashes.delete(track.fileHash);
  });
  return persistedTrack;
}

export function buildLocalPlaybackSnapshot(input: {
  record: LocalPlaylistTrackRecord | null;
  status: PlaybackSnapshot["status"];
  positionMs: number;
  startedAt?: string | null;
  playbackMode: PlaybackMode;
  playbackRevision: number;
  mediaEpoch: number;
  nextQueueItemId: string | null;
  queue: readonly LocalPlaylistTrackRecord[];
}): PlaybackSnapshot | null {
  if (!input.record) return null;

  return {
    status: input.status,
    currentTrackId: input.record.id,
    currentQueueItemId: input.queue.some((track) => track.id === input.record?.id)
      ? buildLocalQueueItemId(input.record.id)
      : null,
    playbackAssetId: null,
    startAt: null,
    sourceSessionId: null,
    sourcePeerId: null,
    sourceTrackId: input.record.id,
    positionMs: Math.max(0, Math.round(input.positionMs)),
    startedAt: input.startedAt ?? null,
    queueVersion: 1,
    playbackRevision: input.playbackRevision,
    mediaEpoch: input.mediaEpoch,
    playbackMode: input.playbackMode,
    nextQueueItemId: input.nextQueueItemId
  };
}

export function resolveBatchPlaySelection(input: {
  tracks: readonly LocalPlaylistTrackRecord[];
  playbackMode: PlaybackMode;
  startIndex?: number;
  isPlayable: (track: LocalPlaylistTrackRecord) => boolean;
  random?: () => number;
}): { selectedIndex: number; shuffleBag: string[] } {
  const { tracks, playbackMode, startIndex, isPlayable, random = Math.random } = input;
  if (tracks.length === 0) {
    return { selectedIndex: -1, shuffleBag: [] };
  }

  if (typeof startIndex === "number" && Number.isFinite(startIndex)) {
    const selectedIndex = Math.min(Math.max(0, Math.floor(startIndex)), tracks.length - 1);
    return {
      selectedIndex,
      shuffleBag: playbackMode === "shuffle"
        ? synchronizeShuffleBagTrackIds(
            [],
            tracks.map((track) => track.id),
            tracks[selectedIndex]?.id ?? null,
            [],
            random
          )
        : []
    };
  }

  if (playbackMode === "shuffle") {
    const selection = takeNextShuffleTrack(tracks, [], null, isPlayable, random);
    const pickedIndex = selection.track
      ? tracks.findIndex((track) => track.id === selection.track?.id)
      : -1;
    return {
      selectedIndex: pickedIndex >= 0
        ? pickedIndex
        : Math.min(tracks.length - 1, Math.max(0, Math.floor(random() * tracks.length))),
      shuffleBag: selection.bag
    };
  }

  return { selectedIndex: 0, shuffleBag: [] };
}

export function pushPlayedTrackHistory(
  history: readonly string[],
  previousTrackId: string | null | undefined,
  nextTrackId: string,
  maxEntries = 50
): string[] {
  if (!previousTrackId || previousTrackId === nextTrackId) {
    return [...history];
  }
  const filtered = history.filter((id) => id !== previousTrackId);
  filtered.push(previousTrackId);
  if (filtered.length > maxEntries) {
    filtered.splice(0, filtered.length - maxEntries);
  }
  return filtered;
}

export function popPreviousPlayedTrackIndex(
  history: readonly string[],
  records: readonly LocalPlaylistTrackRecord[],
  currentTrackId: string | null | undefined
): { index: number; remainingHistory: string[] } {
  const remaining = [...history];
  while (remaining.length > 0) {
    const candidateId = remaining.pop();
    if (!candidateId || candidateId === currentTrackId) continue;
    const index = records.findIndex((track) => track.id === candidateId);
    if (index >= 0) {
      return { index, remainingHistory: remaining };
    }
  }
  return { index: -1, remainingHistory: remaining };
}
