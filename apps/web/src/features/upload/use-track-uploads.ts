"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import type {
  BilibiliTrackCandidate,
  GuestSession,
  QqMusicTrackCandidate,
  NeteaseTrackCandidate,
  RoomSnapshot,
  TrackMeta
} from "@soqaro/shared";
import type { RoomStateEvent } from "@/features/room/room-state-reducer";
import {
  deleteLocalTrackDataForTracks,
  getCachedLibraryTrack,
  listCachedLibraryTrackSummaries,
} from "@/features/library/indexeddb";
import type { CachedLibraryTrack, UploadedTrack } from "@/features/library/audio-utils";
import {
  buildCachedLibraryFileName,
  cacheLibraryChangedEventName,
  buildCachedLibraryTrackUpsertRecord,
  createInFlightCachedLibraryTrackFileLoader,
  hasUsableCachedLibraryFileForRoomTrack,
  loadCacheLibrarySnapshot,
  toCachedLibraryFile
} from "@/features/library/cache-library";
import { resolveProviderTrackSource } from "@/features/library/provider-track-identity";
import {
  buildLocalAudioFileName,
  chooseLocalAudioDirectory,
  clearLocalAudioCache,
  getLocalAudioCacheFile,
  getLocalAudioCacheStats,
  getLocalAudioFile,
  getLocalAudioStorageState,
  getOriginalAssetFile,
  normalizeLocalAudioMimeType,
  saveAudioFileToLocalDirectory
} from "@/features/library/local-audio-storage";
import { useUploadRuntimeEffects } from "./upload-runtime-effects";
import { useUploadPipelineActions } from "./use-upload-pipeline-actions";
import {
  deleteRoomSnapshotFromLocalRepository
} from "@/features/library/local-room-storage";
import {
  playlistsChangedEventName,
  playlistsChangedStorageKey,
  soqaroApi
} from "@/lib/network/soqaro-api";
import {
  ensureDefaultLocalPlaylist,
  getDefaultLocalPlaylistTrackIds,
  listMergedLocalPlaylistTracks,
  cancelSelectedLocalDirectorySync,
  restoreLocalPlaylistsFromRepository
} from "@/features/playlist/local-playlist";
import type { LocalPlaylistRecord } from "@/features/playlist/local-playlist";
import type { LocalPlaylistTrackRecord } from "@/features/library/indexeddb";

export type LocalStorageSummary = {
  cacheBytes: number;
  quotaBytes: number | null;
  cachedTrackCount: number;
  cachedLibraryTracks: CachedLibraryTrack[];
  localPlaylists: LocalPlaylistRecord[];
  localPlaylistTracks: LocalPlaylistTrackRecord[];
  localFolderName: string | null;
  localCachedFileHashes: string[];
  localSavedFileHashes: string[];
  supportsLocalFolder: boolean;
};

export {
  buildRegisterTrackPayload,
  processSelectedTrackFiles
} from "./upload-pipeline";
export {
  buildCachedLibraryFileName,
  createInFlightCachedLibraryTrackFileLoader,
  hasUsableCachedLibraryFileForRoomTrack,
  toCachedLibraryFile,
  toCachedLibraryFileFromBlob,
  toCachedLibraryTrack,
  toCachedLibraryTrackFile
} from "@/features/library/cache-library";

export function useTrackUploads(options: {
  activeSession: GuestSession | null;
  roomSnapshot: RoomSnapshot | null;
  dispatchRoomStateEvent: Dispatch<RoomStateEvent>;
  setStatusMessage: (message: string) => void;
}) {
  const {
    activeSession,
    roomSnapshot,
    dispatchRoomStateEvent,
    setStatusMessage
  } = options;
  const [uploadedTracks, setUploadedTracks] = useState<Record<string, UploadedTrack>>({});
  const [cacheLibraryVersion, setCacheLibraryVersion] = useState(0);
  const [localStorageSummary, setLocalStorageSummary] = useState<LocalStorageSummary>({
    cacheBytes: 0,
    quotaBytes: null,
    cachedTrackCount: 0,
    cachedLibraryTracks: [],
    localPlaylists: [],
    localPlaylistTracks: [],
    localFolderName: null,
    localCachedFileHashes: [],
    localSavedFileHashes: [],
    supportsLocalFolder: false
  });
  const uploadedTrackUrlsRef = useRef<Map<string, string>>(new Map());
  const cacheLibraryTracksRef = useRef<Map<string, CachedLibraryTrack>>(new Map());
  const inFlightUploadHashesRef = useRef<Set<string>>(new Set());
  const refreshCacheLibraryPromiseRef = useRef<Promise<void> | null>(null);
  const refreshCacheLibraryQueuedRef = useRef(false);
  const refreshCacheLibraryRef = useRef<(() => Promise<void>) | null>(null);
  const roomTrackIdsKey = [...new Set(roomSnapshot?.tracks.map((track) => track.id) ?? [])]
    .sort()
    .join("|");
  const roomCatalogKey = roomSnapshot
    ? `${roomSnapshot.room.id}:${roomSnapshot.room.roomRevision ?? 0}:${roomSnapshot.tracks.length}:${roomSnapshot.queue.length}:${roomSnapshot.playlists.length}`
    : "";

  const refreshCacheLibrary = useCallback(async () => {
    const activeRefresh = refreshCacheLibraryPromiseRef.current;
    if (activeRefresh) {
      refreshCacheLibraryQueuedRef.current = true;
      return activeRefresh;
    }

    const refreshPromise = (async () => {
      const localStorageState = await getLocalAudioStorageState();
      const [snapshot, localPlaylistTracks, cacheStats] = await Promise.all([
        loadCacheLibrarySnapshot({ listCachedLibraryTrackSummaries }),
        listMergedLocalPlaylistTracks(),
        getLocalAudioCacheStats()
      ]);
      await restoreLocalPlaylistsFromRepository();
      const localPlaylists = ensureDefaultLocalPlaylist({
        trackIds: getDefaultLocalPlaylistTrackIds(
          localPlaylistTracks,
          new Set(localStorageState.savedFileHashes)
        ),
        sourceDirectoryName: localStorageState.directoryName
      });
      cacheLibraryTracksRef.current = snapshot.tracksByHash;
      setCacheLibraryVersion((current) => current + 1);
      const localCachedFileHashes = localStorageState.directoryName
        ? new Set(localStorageState.cachedFileHashes)
        : new Set<string>();
      setLocalStorageSummary({
        cacheBytes: cacheStats.bytes,
        quotaBytes: null,
        cachedTrackCount: cacheStats.fileCount,
        cachedLibraryTracks: snapshot.tracks.filter((track) =>
          localCachedFileHashes.has(track.fileHash)
        ),
        localPlaylists,
        localPlaylistTracks,
        localFolderName: localStorageState.directoryName,
        localCachedFileHashes: localStorageState.cachedFileHashes,
        localSavedFileHashes: localStorageState.savedFileHashes,
        supportsLocalFolder: localStorageState.supported
      });
    })();
    refreshCacheLibraryPromiseRef.current = refreshPromise;
    try {
      await refreshPromise;
    } finally {
      if (refreshCacheLibraryPromiseRef.current === refreshPromise) {
        refreshCacheLibraryPromiseRef.current = null;
      }
      if (refreshCacheLibraryQueuedRef.current) {
        refreshCacheLibraryQueuedRef.current = false;
        void refreshCacheLibraryRef.current?.();
      }
    }
  }, []);
  refreshCacheLibraryRef.current = refreshCacheLibrary;

  useUploadRuntimeEffects({
    activeSession,
    cacheLibraryVersion,
    cacheLibraryTracksRef,
    inFlightUploadHashesRef,
    roomCatalogKey,
    roomSnapshot,
    roomTrackIdsKey,
    setUploadedTracks,
    uploadedTrackUrlsRef,
    uploadedTracks
  });

  const {
    syncRoomSnapshot,
    handleFilesSelected,
    handleNeteaseTrackImport,
    handleQqMusicTrackImport,
    handleBilibiliTrackImport,
    handleNeteaseTrackImports,
    handleQqMusicTrackImports,
    handleBilibiliTrackImports
  } = useUploadPipelineActions({
    activeSession,
    dispatchRoomStateEvent,
    inFlightUploadHashesRef,
    refreshCacheLibrary,
    roomSnapshot,
    setStatusMessage,
    setUploadedTracks,
    uploadedTracks
  });

  const importCachedTrack = useCallback(async (cachedTrack: CachedLibraryTrack) => {
    setStatusMessage(`正在导入《${cachedTrack.title}》到当前房间曲库…`);
    try {
      const localFile =
        (await getLocalAudioCacheFile(cachedTrack.fileHash)) ??
        (await getLocalAudioFile(
          cachedTrack.fileHash,
          cachedTrack.sourceDirectoryId,
          cachedTrack.sourceFileName
        ));
      const indexedDbRecord = localFile
        ? null
        : await getCachedLibraryTrack(cachedTrack.fileHash);
      const sourceFile = localFile ?? indexedDbRecord?.file ?? null;
      if (!sourceFile) {
        setStatusMessage(`《${cachedTrack.title}》的本地缓存文件不可读取，请重新选择存储文件夹。`);
        return;
      }

      const file = new File([sourceFile], buildCachedLibraryFileName({
        title: cachedTrack.title,
        mimeType: cachedTrack.mimeType || sourceFile.type || "audio/mpeg",
        fileHash: cachedTrack.fileHash
      }), {
        type: cachedTrack.mimeType || sourceFile.type || "audio/mpeg"
      });
      await handleFilesSelected([file], new Map([[cachedTrack.fileHash, cachedTrack]]));
    } catch (error) {
      const detail = error instanceof Error && error.message
        ? `：${error.message}`
        : "，请重试";
      setStatusMessage(`《${cachedTrack.title}》导入失败${detail}`);
    }
  }, [handleFilesSelected, setStatusMessage]);

  const deleteUploadedTrackArtifacts = useCallback(async (trackId: string) => {
    setUploadedTracks((current) => {
      if (!current[trackId]) {
        return current;
      }
      const next = { ...current };
      delete next[trackId];
      return next;
    });
    void (async () => {
      await deleteLocalTrackDataForTracks([trackId]);
      await refreshCacheLibrary();
    })().catch(() => undefined);
  }, [refreshCacheLibrary]);

  const deleteRoomTrackArtifacts = useCallback(async (
    trackIds: string[],
    roomId?: string,
    deleteRoomSnapshot = false
  ) => {
    const removed = new Set(trackIds);
    setUploadedTracks((current) => {
      const next = { ...current };
      for (const trackId of removed) {
        delete next[trackId];
      }
      return next;
    });
    void (async () => {
      await deleteLocalTrackDataForTracks([...removed], roomId ? { roomId } : undefined);
      if (roomId && deleteRoomSnapshot) {
        await deleteRoomSnapshotFromLocalRepository(roomId).catch(() => undefined);
      }
      await refreshCacheLibrary();
    })().catch(() => undefined);
  }, [refreshCacheLibrary]);

  const chooseLocalFolder = useCallback(async () => {
    try {
      cancelSelectedLocalDirectorySync();
      await chooseLocalAudioDirectory();
      window.location.reload();
    } catch (error) {
      setStatusMessage(error instanceof Error && error.name === "AbortError"
        ? "已取消选择本地音频文件夹。"
        : toLocalAudioErrorMessage(error));
    }
  }, [setStatusMessage]);

  const saveTrackToLocal = useCallback(async (track: TrackMeta) => {
    try {
      const localStorageState = await getLocalAudioStorageState();
      if (!localStorageState.directoryName) {
        setStatusMessage("请先在“我的”页面选择本地音频文件夹，再使用此按钮保存曲库歌曲。");
        return;
      }

      let file: Blob | null = null;
      if (track.sourceRef) {
        const providerName = track.sourceRef.provider === "netease"
          ? "网易云音乐"
          : track.sourceRef.provider === "bilibili"
            ? "哔哩哔哩"
            : "QQ 音乐";
        setStatusMessage(`正在从${providerName}下载《${track.title}》...`);
        const downloaded = track.sourceRef.provider === "netease"
          ? await soqaroApi.downloadNeteaseTrack(track.sourceRef.trackId, "exhigh")
          : track.sourceRef.provider === "bilibili"
            ? await soqaroApi.downloadBilibiliTrack(track.sourceRef.trackId)
            : await soqaroApi.downloadQqMusicTrack(track.sourceRef.trackId, "exhigh");
        const downloadedMimeType = normalizeLocalAudioMimeType(downloaded.contentType);
        file = new File(
          [downloaded.blob],
          buildLocalAudioFileName({
            title: track.title,
            mimeType: downloadedMimeType,
            fileHash: track.fileHash
          }),
          { type: downloadedMimeType }
        );
      } else {
        file = uploadedTracks[track.id]?.file ?? null;
        if (!file) {
          const cachedRecord = await getCachedLibraryTrack(track.fileHash);
          if (cachedRecord) {
            file = toCachedLibraryFile({
              file: cachedRecord.file,
              title: cachedRecord.title,
              mimeType: cachedRecord.mimeType,
              fileHash: cachedRecord.fileHash
            });
          }
        }
        if (!file) {
          const localCachedFile = await getLocalAudioCacheFile(track.fileHash);
          if (localCachedFile) file = localCachedFile;
        }
        if (!file) {
          const localFile = await getLocalAudioFile(track.fileHash);
          if (localFile) file = localFile;
        }
        if (!file && track.originalAsset) {
          const originalFile = await getOriginalAssetFile({
            assetId: track.originalAsset.assetId,
            fileHash: track.fileHash,
            title: track.title,
            mimeType: track.mimeType ?? track.originalAsset.mimeType
          });
          if (originalFile) file = originalFile;
        }
      }
      if (!file) {
        throw new Error(track.sourceType === "local_upload"
          ? "本地上传歌曲没有平台下载地址，请由上传者先保存到本地后再导入。"
          : "当前歌曲没有可用的下载地址，请稍后重试。");
      }

      const mimeType = normalizeLocalAudioMimeType(track.mimeType ?? file.type);
      const providerLyrics = track.sourceRef
        ? await (track.sourceRef.provider === "netease"
            ? soqaroApi.getNeteaseLyrics(track.sourceRef.trackId)
            : track.sourceRef.provider === "bilibili"
              ? soqaroApi.getBilibiliLyrics(track.sourceRef.trackId)
              : soqaroApi.getQqMusicLyrics(track.sourceRef.trackId)
          ).catch(() => null)
        : null;
      const lyrics = providerLyrics?.wordSyncedLyric
        || providerLyrics?.plainLyric
        || track.lyrics?.trim()
        || null;
      await saveAudioFileToLocalDirectory({
        file,
        fileHash: track.fileHash,
        title: track.title,
        mimeType,
        trackId: track.id,
        track: {
          artist: track.artist,
          album: track.album,
          artworkUrl: track.artworkUrl,
          lyrics,
          translatedLyrics: providerLyrics?.translatedLyric ?? null,
          romanizedLyrics: providerLyrics?.romanizedLyric ?? null,
          provider: resolveProviderTrackSource(track)?.provider ?? "local_upload",
          providerTrackId: resolveProviderTrackSource(track)?.trackId ?? null,
          loudness: track.loudness,
          durationMs: track.durationMs,
          sizeBytes: file.size,
          originalAsset: track.originalAsset,
          playbackAsset: track.playbackAsset
        }
      });
      await refreshCacheLibrary();
      setStatusMessage(`《${track.title}》已保存到本地文件夹，浏览器缓存中的源文件已释放。`);
    } catch (error) {
      setStatusMessage(toLocalAudioErrorMessage(error));
    }
  }, [refreshCacheLibrary, setStatusMessage, uploadedTracks]);

  const cleanLocalStorage = useCallback(async () => {
    try {
      const result = await clearLocalAudioCache();
      await refreshCacheLibrary();
      setStatusMessage(
        result.failedEntryCount > 0
          ? `已清理 ${result.deletedEntryCount} 个缓存音频，${result.failedEntryCount} 个缓存因目录权限未能清理。`
          : result.deletedEntryCount > 0
            ? `已清理 ${result.deletedEntryCount} 个缓存音频。`
            : "没有发现缓存音频。"
      );
    } catch (error) {
      setStatusMessage("本机存储清理失败，请重试。");
      throw error;
    }
  }, [refreshCacheLibrary, setStatusMessage]);

  useEffect(() => {
    void refreshCacheLibrary();
    const refreshWhenActive = () => {
      if (document.visibilityState === "visible") {
        void refreshCacheLibrary();
      }
    };
    const refreshWhenPlaylistsChange = () => {
      void refreshCacheLibrary();
    };
    const refreshWhenCacheLibraryChanges = () => {
      void refreshCacheLibrary();
    };
    const refreshWhenPlaylistStorageChanges = (event: StorageEvent) => {
      if (event.key === playlistsChangedStorageKey) {
        refreshWhenPlaylistsChange();
      }
    };
    const refreshInterval = window.setInterval(refreshWhenActive, 10_000);
    window.addEventListener("focus", refreshWhenActive);
    window.addEventListener(playlistsChangedEventName, refreshWhenPlaylistsChange);
    window.addEventListener(cacheLibraryChangedEventName, refreshWhenCacheLibraryChanges);
    window.addEventListener("storage", refreshWhenPlaylistStorageChanges);
    document.addEventListener("visibilitychange", refreshWhenActive);
    return () => {
      window.clearInterval(refreshInterval);
      window.removeEventListener("focus", refreshWhenActive);
      window.removeEventListener(playlistsChangedEventName, refreshWhenPlaylistsChange);
      window.removeEventListener(cacheLibraryChangedEventName, refreshWhenCacheLibraryChanges);
      window.removeEventListener("storage", refreshWhenPlaylistStorageChanges);
      document.removeEventListener("visibilitychange", refreshWhenActive);
    };
  }, [refreshCacheLibrary, roomSnapshot?.room.id]);

  return {
    uploadedTracks,
    setUploadedTracks,
    refreshCacheLibrary,
    importCachedTrack,
    localStorageSummary,
    cleanLocalStorage,
    chooseLocalFolder,
    saveTrackToLocal,
    handleFilesSelected,
    handleNeteaseTrackImport: (candidate: NeteaseTrackCandidate) =>
      handleNeteaseTrackImport(candidate),
    handleQqMusicTrackImport: (candidate: QqMusicTrackCandidate) =>
      handleQqMusicTrackImport(candidate),
    handleBilibiliTrackImport: (candidate: BilibiliTrackCandidate) =>
      handleBilibiliTrackImport(candidate),
    handleNeteaseTrackImports: (candidates: NeteaseTrackCandidate[]) =>
      handleNeteaseTrackImports(candidates),
    handleQqMusicTrackImports: (candidates: QqMusicTrackCandidate[]) =>
      handleQqMusicTrackImports(candidates),
    handleBilibiliTrackImports: (candidates: BilibiliTrackCandidate[]) =>
      handleBilibiliTrackImports(candidates),
    syncRoomSnapshot,
    deleteUploadedTrackArtifacts,
    deleteRoomTrackArtifacts,
    hasUsableCachedLibraryFileForRoomTrack,
    createInFlightCachedLibraryTrackFileLoader,
    buildCachedLibraryTrackUpsertRecord
  };
}

function toLocalAudioErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "本地音频保存失败，请重试。";
}
