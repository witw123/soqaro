"use client";

import type { RepositoryDirectoryHandle as FileSystemDirectoryHandle } from "./directory-handle";
import { hasNativeStorage } from "./native-storage";
import { hydrateLocalRepository } from "./local-repository-hydration";
import { storageRootChangingEvent, storageRootChangedEvent } from "./storage-root-events";

import type {
  OriginalAssetManifest,
  PlaybackAssetManifest,
  TrackLoudness
} from "@soqaro/shared";
import {
  deleteAudioAsset,
  deleteCachedLibraryTrack,
  deleteCachedLibraryTrackFile,
  deleteOriginalAssetForTrack,
  deleteLocalAudioCacheFileRecord,
  getLocalAudioDirectory,
  getLocalAudioFileRecord,
  getLocalPlaylistDirectory,
  getLocalAudioCacheFileRecord,
  getCachedLibraryTrack,
  getCachedLibraryTrackByProviderTrack,
  getCachedLibraryTrackSummaryByProviderTrack,
  getAssetManifest,
  getAssetUnits,
  getTrackAssetLink,
  getCachedLibraryTrackSummary,
  listCachedLibraryTrackHashes,
  listCachedLibraryTrackSummaries,
  listLocalAudioCacheFiles,
  listLocalAudioFiles,
  deleteLocalAudioFileRecord,
  saveLocalAudioCacheFileRecord,
  saveLocalAudioDirectory,
  saveLocalAudioFileRecord,
  markLocalRepositoryIndexReady,
  type LocalAudioFileRecord
} from "./indexeddb";
import {
  createRepositoryTrackRecord,
  LocalRepository,
  type LocalRepositoryTrackRecord
} from "./local-repository";

// Surface cached-library lookups used by view code (e.g. artwork) without
// exposing the low-level IndexedDB storage module directly.
export {
  getCachedLibraryTrackByProviderTrack,
  getCachedLibraryTrackSummaryByProviderTrack,
  getCachedLibraryTrackSummary
} from "./indexeddb";
import { enqueueLocalRepositoryWrite } from "./local-repository-queue";
import { resolveLocalArtworkUrl } from "./audio-metadata";
import { soqaroApi } from "@/lib/network/soqaro-api";
import {
  asPermissionedHandle,
  buildLocalAudioFileName,
  createFrameBudgetYielder,
  forEachWithConcurrency,
  getFileByPath,
  hasDirectoryReadPermission,
  isAbortError,
  isAudioFile,
  localOtherFilePrefixes,
  requestDirectoryPermission,
  resolveLocalFileConcurrency,
  supportsLocalAudioDirectory,
  type DirectoryPickerWindow,
  type IterableDirectoryHandle,
  type LocalAudioCacheStats,
  type LocalAudioStorageState,
  type LocalAudioStorageStats,
  type SelectedLocalAudioFile
} from "./local-audio-storage-helpers";

export * from "./local-audio-storage-helpers";

export async function chooseLocalAudioDirectory() {
  if (hasNativeStorage()) throw new Error("客户端使用固定的应用根目录，不能更改。");
  const picker = typeof window === "undefined"
    ? undefined
    : (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) {
    throw new Error("当前浏览器不支持选择本地文件夹，请使用 Chrome 或 Edge。 ");
  }

  const handle = await picker({ mode: "readwrite" });
  // Initialization creates only the manifest; child directories are created on write.
  const repository = await LocalRepository.initialize(handle);
  window.dispatchEvent(new Event(storageRootChangingEvent));
  try {
    await enqueueLocalRepositoryWrite(async () => {
      await saveLocalAudioDirectory({
        handle,
        name: handle.name,
        repositoryId: repository.manifest.repositoryId,
        schemaVersion: repository.manifest.schemaVersion
      });
      await hydrateLocalRepository(repository);
      await markLocalRepositoryIndexReady(repository.manifest.repositoryId);
    });
  } finally {
    window.dispatchEvent(new Event(storageRootChangedEvent));
  }
  return handle.name;
}

export async function initializeLocalStorage() {
  const directory = await getLocalAudioDirectory();
  if (!directory || !(await hasDirectoryReadPermission(directory.handle))) return false;
  const repository = await LocalRepository.open(directory.handle, { recover: false });
  if (!directory.indexReady) {
    await hydrateLocalRepository(repository);
    await markLocalRepositoryIndexReady(repository.manifest.repositoryId);
  }
  return true;
}

export async function getConfiguredLocalRepository() {
  const directory = await getLocalAudioDirectory();
  if (!directory) return null;
  try {
    return await LocalRepository.open(directory.handle, { recover: false });
  } catch {
    // A directory handle can become unavailable after the folder is moved or deleted.
    // Browser storage remains usable until the user selects a new folder.
    return null;
  }
}

export async function getLocalAudioStorageState(options?: { verifyFiles?: boolean }): Promise<LocalAudioStorageState> {
  const [directory, files, cachedFiles] = await Promise.all([
    getLocalAudioDirectory(),
    listLocalAudioFiles("saved"),
    listLocalAudioCacheFiles()
  ]);
  let permission: PermissionState | null = null;
  if (directory) {
    permission = await asPermissionedHandle(directory.handle)
      .queryPermission({ mode: "read" })
      .catch(() => null);
  }
  if (!directory || permission !== "granted") {
    return {
      supported: supportsLocalAudioDirectory(),
      fixedRoot: hasNativeStorage(),
      directoryName: directory?.name ?? null,
      savedFileHashes: [],
      cachedFileHashes: [],
      permission
    };
  }

  if (!options?.verifyFiles) {
    return {
      supported: supportsLocalAudioDirectory(),
      fixedRoot: hasNativeStorage(),
      directoryName: directory.name,
      savedFileHashes: files.map((file) => file.fileHash),
      cachedFileHashes: cachedFiles.map((file) => file.fileHash),
      permission
    };
  }
  // Explicit verification shares one repository for both storage kinds.
  const repository = await LocalRepository.open(directory.handle, { recover: false }).catch(() => null);
  const [availableSavedFiles, availableCachedFiles] = await Promise.all([
    filterReadableLocalFiles(directory.handle, files, true, repository),
    filterReadableLocalFiles(directory.handle, cachedFiles, false, repository)
  ]);
  return {
    supported: supportsLocalAudioDirectory(),
    fixedRoot: hasNativeStorage(),
    directoryName: directory?.name ?? null,
    savedFileHashes: availableSavedFiles,
    cachedFileHashes: availableCachedFiles,
    permission
  };
}

export async function requestLocalAudioDirectoryPermission(mode: "read" | "readwrite" = "readwrite"): Promise<boolean> {
  const directory = await getLocalAudioDirectory();
  if (!directory) return false;
  try {
    const handle = asPermissionedHandle(directory.handle);
    const result = await handle.requestPermission({ mode });
    return result === "granted";
  } catch {
    return false;
  }
}

export async function listSelectedLocalAudioFiles(options?: { signal?: AbortSignal }): Promise<SelectedLocalAudioFile[] | null> {
  const directory = await getLocalAudioDirectory();
  if (!directory) return [];

  const permission = await asPermissionedHandle(directory.handle)
    .queryPermission({ mode: "read" })
    .catch(() => "denied" as PermissionState);
  if (permission !== "granted") return null;

  const files: SelectedLocalAudioFile[] = [];
  try {
    await collectSelectedLocalAudioFiles(directory.handle, "", files, options?.signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }
  return files;
}

export async function chooseLocalAudioSourceDirectory() {
  const picker = typeof window === "undefined"
    ? undefined
    : (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) {
    throw new Error("当前浏览器不支持选择本地文件夹，请使用 Chrome 或 Edge。 ");
  }
  return picker({ mode: "read" });
}

export async function listLocalAudioFilesInDirectory(
  directory: FileSystemDirectoryHandle,
  options?: { signal?: AbortSignal }
): Promise<SelectedLocalAudioFile[] | null> {
  const permission = await asPermissionedHandle(directory)
    .queryPermission({ mode: "read" })
    .catch(() => "denied" as PermissionState);
  if (permission !== "granted") return null;

  const files: SelectedLocalAudioFile[] = [];
  try {
    await collectSelectedLocalAudioFiles(directory, "", files, options?.signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }
  return files;
}

async function getWritableLocalAudioDirectory() {
  const directory = await getLocalAudioDirectory();
  if (!directory) {
    throw new Error("请先选择 Soqaro 根目录。");
  }

  const permission = await requestDirectoryPermission(
    asPermissionedHandle(directory.handle),
    "readwrite"
  );
  if (!permission) {
    throw new Error("没有获得 Soqaro 本地存储文件夹写入权限，请重新选择根文件夹。 ");
  }
  return directory;
}

export async function ensureLocalAudioDirectoryWriteAccess() {
  return !!(await getWritableLocalAudioDirectory());
}

/**
 * Resolve a stored record to the `File` it points at.
 *
 * Split out of `getLocalAudioFile` so callers that already hold the record (and
 * possibly an open repository) can skip re-reading both.
 */
async function resolveLocalAudioFile(
  fileRecord: LocalAudioFileRecord | null,
  options?: {
    sourceDirectoryId?: string | null;
    sourceFileName?: string | null;
    // Only consulted for records living in the app root; a record carrying
    // `sourceDirectoryId` belongs to a user-picked source folder and is
    // resolved through that handle instead. Omit it to open one on demand;
    // pass `null` to say "this root has none".
    repository?: LocalRepository | null;
  }
): Promise<File | null> {
  const sourceDirectoryId = options?.sourceDirectoryId;
  const sourceFileName = options?.sourceFileName;

  if (sourceDirectoryId) {
    const sourceDirectory = await getLocalPlaylistDirectory(sourceDirectoryId);
    if (!sourceDirectory) return null;
    if (!(await hasDirectoryReadPermission(sourceDirectory.handle))) return null;
    const fileName = sourceFileName ?? fileRecord?.fileName;
    return fileName
      ? getFileByPath(sourceDirectory.handle, fileName).catch(() => null)
      : null;
  }

  if (!fileRecord) {
    return null;
  }

  if (fileRecord.sourceDirectoryId) {
    const sourceDirectory = await getLocalPlaylistDirectory(fileRecord.sourceDirectoryId);
    if (!sourceDirectory || !(await hasDirectoryReadPermission(sourceDirectory.handle))) return null;
    return getFileByPath(sourceDirectory.handle, sourceFileName ?? fileRecord.fileName).catch(() => null);
  }

  const directory = await getLocalAudioDirectory();
  if (!directory) return null;

  if (!(await hasDirectoryReadPermission(directory.handle))) {
    return null;
  }

  // `undefined` means "caller supplied nothing, open one"; `null` means "this
  // library genuinely has no repository". The two must stay distinct — folding
  // `null` into the default would restore the per-track re-open this hoist
  // exists to remove.
  const repository =
    options?.repository === undefined
      ? await LocalRepository.open(directory.handle, { recover: false }).catch(() => null)
      : options.repository;
  const repositoryFile = fileRecord.relativePath && repository
    ? await repository.readPath(fileRecord.relativePath)
    : null;
  if (repositoryFile) return repositoryFile;
  if (fileRecord.source !== "directory-scan") return null;
  return getFileByPath(directory.handle, fileRecord.fileName).catch(() => null);
}

export async function getLocalAudioFile(
  fileHash: string,
  sourceDirectoryId?: string | null,
  sourceFileName?: string | null,
  repository?: LocalRepository | null
) {
  const fileRecord = await getLocalAudioFileRecord(fileHash, "saved");
  return resolveLocalAudioFile(fileRecord, { sourceDirectoryId, sourceFileName, repository });
}

export async function getOriginalAssetFile(input: {
  assetId: string;
  fileHash: string;
  title: string;
  mimeType: string;
}) {
  const repository = await getConfiguredLocalRepository();
  const persisted = repository ? await repository.readOriginalManifest(input.assetId) : null;
  if (
    repository &&
    persisted?.manifest.kind === "original" &&
    persisted.manifest.fileHash === input.fileHash
  ) {
    const source = await repository.readPath(persisted.sourcePath);
    if (source) {
      return new File(
        [source],
        buildLocalAudioFileName({
          title: input.title,
          mimeType: input.mimeType,
          fileHash: input.fileHash
        }),
        { type: input.mimeType }
      );
    }
  }

  const assetRecord = await getAssetManifest(input.assetId);
  if (
    assetRecord?.manifest.kind === "original" &&
    assetRecord.complete &&
    assetRecord.manifest.fileHash === input.fileHash
  ) {
    const unitIndexes = Array.from({ length: assetRecord.manifest.unitCount }, (_, index) => index);
    const units = await getAssetUnits(input.assetId, unitIndexes);
    if (units.length === unitIndexes.length) {
      units.sort((left, right) => left.unitIndex - right.unitIndex);
      return new File(
        units.map((unit) => unit.payload),
        buildLocalAudioFileName({
          title: input.title,
          mimeType: input.mimeType,
          fileHash: input.fileHash
        }),
        { type: input.mimeType }
      );
    }
  }

  return null;
}

/** Resolve a room track to the original local file without decoding or transcoding it. */
export async function getRoomLocalAudioFile(input: {
  trackId: string;
  fileHash: string;
  title: string;
  mimeType: string;
  originalAssetId?: string | null;
  provider?: "netease" | "qqmusic" | "bilibili" | "alist";
  providerTrackId?: string | null;
}) {
  const repository = await getConfiguredLocalRepository();
  const savedFile = await getLocalAudioFile(input.fileHash, null, null, repository).catch(() => null);
  if (savedFile) return savedFile;
  const cachedFile = await getLocalAudioCacheFile(input.fileHash, repository).catch(() => null);
  if (cachedFile) return cachedFile;

  const browserCache = await getCachedLibraryTrack(input.fileHash).catch(() => null);
  if (browserCache?.file) return browserCache.file;

  const linkedAssets = await getTrackAssetLink(input.trackId).catch(() => null);
  const originalAssetId = input.originalAssetId ?? linkedAssets?.originalAssetId ?? null;
  if (originalAssetId) {
    const originalFile = await getOriginalAssetFile({
      assetId: originalAssetId,
      fileHash: input.fileHash,
      title: input.title,
      mimeType: input.mimeType
    });
    if (originalFile) return originalFile;
  }

  // Provider playback caches are content-addressed, while a room track may
  // have been registered from a different provider download and carry another
  // file hash. Match the member's own cache by provider identity as well.
  if (input.provider && input.providerTrackId) {
    const providerSummary = typeof getCachedLibraryTrackSummaryByProviderTrack === "function"
      ? await getCachedLibraryTrackSummaryByProviderTrack(
          input.provider,
          input.providerTrackId
        ).catch(() => null)
      : null;
    if (providerSummary) {
      const [localProviderCache, localProviderFile, browserProviderFile] = await Promise.all([
        getLocalAudioCacheFile(providerSummary.fileHash, repository).catch(() => null),
        getLocalAudioFile(providerSummary.fileHash, null, null, repository).catch(() => null),
        getCachedLibraryTrack(providerSummary.fileHash).catch(() => null)
      ]);
      if (localProviderCache) return localProviderCache;
      if (localProviderFile) return localProviderFile;
      if (browserProviderFile?.file) return browserProviderFile.file;
    }

    const providerCache = await getCachedLibraryTrackByProviderTrack(
      input.provider,
      input.providerTrackId
    ).catch(() => null);
    if (providerCache?.file) return providerCache.file;
  }

  return null;
}

export async function getLocalAudioCacheFile(fileHash: string, openedRepository?: LocalRepository | null) {
  const [directory, fileRecord] = await Promise.all([
    getLocalAudioDirectory(),
    getLocalAudioCacheFileRecord(fileHash)
  ]);
  if (!directory || !fileRecord) {
    return null;
  }

  if (!(await hasDirectoryReadPermission(directory.handle))) {
    return null;
  }

  const repository = openedRepository === undefined
    ? await LocalRepository.open(directory.handle, { recover: false }).catch(() => null)
    : openedRepository;
  const repositoryFile = fileRecord.relativePath && repository
    ? await repository.readPath(fileRecord.relativePath)
    : null;
  return repositoryFile;
}

export async function saveAudioFileToLocalDirectory(input: {
  file: Blob;
  fileHash: string;
  title: string;
  mimeType: string;
  trackId?: string;
  track?: {
    artist: string;
    album?: string | null;
    artworkUrl?: string | null;
    lyrics?: string | null;
    translatedLyrics?: string | null;
    romanizedLyrics?: string | null;
    provider?: "netease" | "qqmusic" | "bilibili" | "alist" | "local_upload";
    providerTrackId?: string | null;
    durationMs: number;
    sizeBytes?: number;
    loudness?: TrackLoudness;
    originalAsset?: OriginalAssetManifest;
    playbackAsset?: PlaybackAssetManifest;
  };
}) {
  return enqueueLocalRepositoryWrite(async () => {
    const directory = await getWritableLocalAudioDirectory();
  const fileName = buildLocalAudioFileName(input);
    const repository = await LocalRepository.open(directory.handle, { recover: false });
  const existingTrack = await repository.readTrack(input.fileHash);
  const relativePath = await repository.writeManagedSource({
    file: input.file,
    fileHash: input.fileHash,
    mimeType: input.mimeType
  });

  const originalAsset = input.track?.originalAsset
    ?? (input.trackId
    ? await getTrackOriginalAssetManifest(input.trackId)
    : null)
    ?? (existingTrack?.originalAsset
      ? (await getAssetManifest(existingTrack.originalAsset.assetId).catch(() => null))?.manifest.kind === "original"
        ? (await getAssetManifest(existingTrack.originalAsset.assetId))?.manifest as OriginalAssetManifest
        : null
      : null);
  let savedOriginalAsset = existingTrack?.originalAsset ?? null;
  if (originalAsset) {
    savedOriginalAsset = {
      assetId: originalAsset.assetId,
      manifestPath: await repository.writeOriginalManifest(originalAsset, relativePath)
    };
    await deleteAudioAsset(originalAsset.assetId).catch(() => undefined);
  }
  let savedPlaybackAsset = existingTrack?.playbackAsset ?? null;
  const playbackAsset = input.track?.playbackAsset
    ?? (existingTrack?.playbackAsset
      ? (await getAssetManifest(existingTrack.playbackAsset.assetId).catch(() => null))?.manifest.kind === "playback"
        ? (await getAssetManifest(existingTrack.playbackAsset.assetId))?.manifest as PlaybackAssetManifest
        : null
      : null);
  if (playbackAsset) {
    const manifestPath = await persistPlaybackAssetToRepository(
      repository,
      playbackAsset
    );
    if (manifestPath) {
      savedPlaybackAsset = {
        assetId: playbackAsset.assetId,
        profileId: playbackAsset.profileId,
        manifestPath
      };
      await deleteAudioAsset(playbackAsset.assetId).catch(() => undefined);
    }
  }
  const remoteArtworkUrl = input.track?.artworkUrl?.trim() || null;
  const isDataOrBlobUrl = Boolean(remoteArtworkUrl && /^(?:data|blob):/i.test(remoteArtworkUrl));
  const downloadedArtwork = !isDataOrBlobUrl && input.track?.provider === "qqmusic" && remoteArtworkUrl && /^https?:\/\//i.test(remoteArtworkUrl)
    ? await (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3_000);
        try {
          return await soqaroApi.downloadQqMusicArtwork(remoteArtworkUrl, controller.signal).then((response) => response.blob).catch(() => null);
        } finally {
          clearTimeout(timer);
        }
      })()
    : null;
  const artworkUrl = remoteArtworkUrl
    ? (isDataOrBlobUrl ? remoteArtworkUrl : await resolveLocalArtworkUrl(input.file, remoteArtworkUrl, downloadedArtwork).catch(() => null))
    : existingTrack?.artworkUrl ?? null;
  const artworkProvider = input.track?.provider;
  const artworkPath = artworkUrl
    ? await repository.writeArtworkFromUrl({
        fileHash: input.fileHash,
        artworkUrl,
        retention: "library",
        provider: artworkProvider === "netease" || artworkProvider === "qqmusic" || artworkProvider === "bilibili" || artworkProvider === "alist"
          ? artworkProvider
          : "local_upload"
      }).catch(() => null) ?? existingTrack?.artworkPath ?? null
    : existingTrack?.artworkPath ?? null;
  const lyricsPath = input.track?.lyrics?.trim()
    ? await repository.writeLyrics(input.fileHash, input.track.lyrics)
    : existingTrack?.lyricsPath ?? null;
  if (!lyricsPath && existingTrack?.lyricsPath) {
    await repository.removePath(existingTrack.lyricsPath);
  }

  if (input.track) {
    const sizeBytes = input.track.sizeBytes ?? input.file.size;
    await repository.writeTrack(createRepositoryTrackRecord({
      fileHash: input.fileHash,
      title: input.title,
      artist: input.track.artist,
      album: input.track.album,
      artworkUrl,
      lyrics: input.track.lyrics,
      translatedLyrics: input.track.translatedLyrics,
      romanizedLyrics: input.track.romanizedLyrics,
      provider: input.track.provider,
      providerTrackId: input.track.providerTrackId,
      mimeType: input.mimeType,
      durationMs: input.track.durationMs,
      sizeBytes,
      loudness: input.track.loudness,
      source: { kind: "managed", relativePath, sizeBytes },
      originalAsset: savedOriginalAsset,
      playbackAsset: savedPlaybackAsset,
      artworkPath,
      lyricsPath,
      retention: "library",
      createdAt: existingTrack?.createdAt
    }));
  } else {
    await persistCachedTrackRecord(repository, input.fileHash, relativePath, "library");
  }
  await saveLocalAudioFileRecord({
    fileHash: input.fileHash,
    sizeBytes: input.file.size,
    fileName,
    relativePath,
    storageKind: "saved"
  });
  await deleteLocalAudioCacheFile(input.fileHash, { repository });
  await deleteCachedLibraryTrack(input.fileHash);
  if (savedOriginalAsset?.assetId) {
    await deleteAudioAsset(savedOriginalAsset.assetId).catch(() => undefined);
  }
  if (savedPlaybackAsset?.assetId) {
    await deleteAudioAsset(savedPlaybackAsset.assetId).catch(() => undefined);
  }
  if (input.trackId) {
    const link = await getTrackAssetLink(input.trackId).catch(() => null);
    if (link) {
      await deleteAudioAsset(link.originalAssetId).catch(() => undefined);
      await deleteAudioAsset(link.playbackAssetId).catch(() => undefined);
    }
    await deleteOriginalAssetForTrack(input.trackId).catch(() => undefined);
  }
    return { fileName, artworkUrl };
  });
}

export async function saveCachedAudioFileToLocalDirectory(input: {
  file: Blob;
  fileHash: string;
  title: string;
  mimeType: string;
  provider?: "netease" | "qqmusic" | "bilibili" | "alist" | "local_upload";
  originalAsset?: OriginalAssetManifest;
  playbackAsset?: PlaybackAssetManifest;
  reuseExisting?: boolean;
}) {
  return enqueueLocalRepositoryWrite(async () => {
    const directory = await getWritableLocalAudioDirectory();
  const fileName = buildLocalAudioFileName(input);
    const repository = await LocalRepository.open(directory.handle, { recover: false });
  const relativePath = await repository.writeCachedSource({
    file: input.file,
    fileHash: input.fileHash,
    mimeType: input.mimeType,
    provider: input.provider
  }, { reuseExisting: input.reuseExisting ?? true });
  await saveLocalAudioCacheFileRecord({
    fileHash: input.fileHash,
    fileName,
    relativePath,
    sizeBytes: input.file.size
  });
  await persistCachedTrackRecord(repository, input.fileHash, relativePath, "cache", {
    provider: input.provider,
    originalAsset: input.originalAsset,
    playbackAsset: input.playbackAsset
  });
  await deleteCachedLibraryTrackFile(input.fileHash);
  if (input.originalAsset?.assetId) {
    await deleteAudioAsset(input.originalAsset.assetId).catch(() => undefined);
  }
  if (input.playbackAsset?.assetId) {
    await deleteAudioAsset(input.playbackAsset.assetId).catch(() => undefined);
  }
    return { fileName };
  });
}

async function persistCachedTrackRecord(
  repository: LocalRepository,
  fileHash: string,
  relativePath: string,
  retention: "library" | "cache",
  assets?: {
    provider?: "netease" | "qqmusic" | "bilibili" | "alist" | "local_upload";
    originalAsset?: OriginalAssetManifest;
    playbackAsset?: PlaybackAssetManifest;
  }
) {
  const summary = await getCachedLibraryTrackSummary(fileHash);
  if (!summary) return;
  const existing = await repository.readTrack(fileHash);
  let originalAsset = existing?.originalAsset ?? null;
  if (assets?.originalAsset) {
    originalAsset = {
      assetId: assets.originalAsset.assetId,
      manifestPath: await repository.writeOriginalManifest(
        assets.originalAsset,
        relativePath
      )
    };
    await deleteAudioAsset(assets.originalAsset.assetId).catch(() => undefined);
  }
  let playbackAsset = existing?.playbackAsset ?? null;
  if (assets?.playbackAsset) {
    const manifestPath = await persistPlaybackAssetToRepository(
      repository,
      assets.playbackAsset
    );
    if (manifestPath) {
      playbackAsset = {
        assetId: assets.playbackAsset.assetId,
        profileId: assets.playbackAsset.profileId,
        manifestPath
      };
      await deleteAudioAsset(assets.playbackAsset.assetId).catch(() => undefined);
    }
  }
  const artworkPath = summary.artworkUrl?.trim()
    ? await repository.writeArtworkFromUrl({
        fileHash,
        artworkUrl: summary.artworkUrl,
        retention,
        provider: summary.provider ?? assets?.provider ?? "local_upload"
      }) ?? existing?.artworkPath ?? null
    : existing?.artworkPath ?? null;
  const storedProvider = summary.provider ?? assets?.provider ?? null;
  const storedProviderTrackId = summary.providerTrackId?.trim() || null;
  const storedProviderSource = storedProvider && storedProvider !== "local_upload" && storedProviderTrackId
    ? { provider: storedProvider, trackId: storedProviderTrackId }
    : null;
  const storedSourceType = storedProviderSource?.provider ?? summary.provider ?? assets?.provider;
  const record = {
    schemaVersion: 1 as const,
    fileHash: summary.fileHash,
    title: summary.title,
    artist: summary.artist,
    ...(summary.album !== undefined ? { album: summary.album } : {}),
    ...(summary.artworkUrl !== undefined ? { artworkUrl: summary.artworkUrl } : {}),
    ...(summary.lyrics !== undefined ? { lyrics: summary.lyrics } : {}),
    ...(summary.translatedLyrics !== undefined ? { translatedLyrics: summary.translatedLyrics } : {}),
    ...(summary.romanizedLyrics !== undefined ? { romanizedLyrics: summary.romanizedLyrics } : {}),
    durationMs: summary.durationMs,
    mimeType: summary.mimeType,
    sizeBytes: summary.sizeBytes,
    ...(summary.loudness ? { loudness: summary.loudness } : {}),
    ...(storedSourceType !== undefined
      ? { sourceType: storedSourceType }
      : {}),
    ...(storedProviderSource
      ? { sourceRef: storedProviderSource }
      : { sourceRef: null }),
    source: {
      kind: "managed" as const,
      relativePath,
      sizeBytes: summary.sizeBytes
    },
    originalAsset,
    playbackAsset,
    artworkPath,
    lyricsPath: existing?.lyricsPath ?? null,
    retention,
    createdAt: existing?.createdAt ?? summary.cachedAt,
    updatedAt: new Date().toISOString()
  };
  await repository.writeTrack(record);
}

async function persistPlaybackAssetToRepository(
  repository: LocalRepository,
  manifest: PlaybackAssetManifest
) {
  const existing = await repository.readPlaybackAsset(manifest.assetId, manifest.profileId);
  if (existing && existing.units.length === manifest.unitCount) {
    return repository.getPlaybackManifestPath(manifest.assetId, manifest.profileId);
  }

  const unitIndexes = Array.from({ length: manifest.unitCount }, (_, index) => index);
  const units = await getAssetUnits(manifest.assetId, unitIndexes);
  if (units.length !== unitIndexes.length) {
    return null;
  }

  try {
    return await repository.writePlaybackAsset({
      manifest,
      units: units.map((unit) => ({
        descriptor: stripAssetUnitRecord(unit),
        payload: unit.payload
      }))
    });
  } catch (error) {
    await repository.removeDirectory(
      repository.getPlaybackAssetPath(manifest.assetId, manifest.profileId)
    ).catch(() => undefined);
    throw error;
  }
}

function stripAssetUnitRecord(unit: Awaited<ReturnType<typeof getAssetUnits>>[number]) {
  const {
    unitId: _unitId,
    payload: _payload,
    lastAccessedAt: _lastAccessedAt,
    protectedUntil: _protectedUntil,
    ...descriptor
  } = unit;
  return descriptor;
}

export async function deleteLocalAudioCacheFile(
  fileHash: string,
  options?: { requestPermission?: boolean; repository?: LocalRepository; deferTouch?: boolean }
) {
  const fileRecord = await getLocalAudioCacheFileRecord(fileHash);
  if (!fileRecord) {
    return false;
  }

  const directory = await getLocalAudioDirectory();
  if (!directory) {
    return false;
  }

  const permission = options?.requestPermission === false
    ? await asPermissionedHandle(directory.handle)
      .queryPermission({ mode: "readwrite" })
      .then((value) => value === "granted")
      .catch(() => false)
    : await requestDirectoryPermission(
      asPermissionedHandle(directory.handle),
      "readwrite"
    );
  if (!permission) {
    return false;
  }

  const repository = options?.repository ?? await LocalRepository.open(directory.handle, { recover: false });
  if (repository && fileRecord.relativePath) {
    await repository.removePath(fileRecord.relativePath);
  }
  await deleteLocalAudioCacheFileRecord(fileHash);
  if (!(await getLocalAudioFileRecord(fileHash, "saved"))) {
    if (repository) {
      await repository.deleteTrack(fileHash, { touchManifest: false });
    }
  }
  if (!options?.deferTouch) await repository.touch();
  return true;
}

async function getTrackOriginalAssetManifest(trackId: string) {
  const link = await getTrackAssetLink(trackId);
  if (!link) return null;
  const originalRecord = await getAssetManifest(link.originalAssetId);
  return originalRecord?.manifest.kind === "original"
    ? originalRecord.manifest as OriginalAssetManifest
    : null;
}

export async function getLocalAudioCacheStats(): Promise<LocalAudioCacheStats> {
  const [summaries, browserHashes, localCacheFiles] = await Promise.all([
    listCachedLibraryTrackSummaries(),
    listCachedLibraryTrackHashes(),
    listLocalAudioCacheFiles()
  ]);
  const summariesByHash = new Map(summaries.map((summary) => [summary.fileHash, summary] as const));
  const localFilesByHash = new Map(localCacheFiles.map((file) => [file.fileHash, file] as const));
  const hashes = new Set([
    ...browserHashes,
    ...localCacheFiles.map((file) => file.fileHash)
  ]);
  const sizes = await Promise.all([...hashes].map(async (fileHash) => {
    const localFile = localFilesByHash.get(fileHash);
    if (localFile?.sizeBytes !== undefined) return localFile.sizeBytes;
    // The summary row carries the same byte count the blob would report:
    // `sizeBytes` is required on the record and
    // `toCachedLibraryTrackSummaryRecord` only strips `file`. Prefer it and
    // skip pulling the blob out of IndexedDB — this ran once per cached track.
    const summary = summariesByHash.get(fileHash);
    if (summary?.sizeBytes) return summary.sizeBytes;
    const browserRecord = await getCachedLibraryTrack(fileHash).catch(() => null);
    if (browserRecord?.file) return browserRecord.file.size;
    return summary?.sizeBytes ?? 0;
  }));

  return {
    fileCount: hashes.size,
    bytes: sizes.reduce((total, size) => total + size, 0)
  };
}

export async function clearLocalAudioCache() {
  return enqueueLocalRepositoryWrite(async () => {
  const [browserHashes, localCacheFiles] = await Promise.all([
    listCachedLibraryTrackHashes(),
    listLocalAudioCacheFiles()
  ]);
  const hashes = new Set([
    ...browserHashes,
    ...localCacheFiles.map((file) => file.fileHash)
  ]);

  const failedLocalFiles = new Set<string>();
  const repository = await getConfiguredLocalRepository();
  const removedTracks: LocalRepositoryTrackRecord[] = [];
  for (const file of localCacheFiles) {
    try {
      const track = repository ? await repository.readTrack(file.fileHash) : null;
      if (!(await deleteLocalAudioCacheFile(file.fileHash, {
        repository: repository ?? undefined, deferTouch: true
      }))) {
        failedLocalFiles.add(file.fileHash);
      } else if (track && !(await getLocalAudioFileRecord(file.fileHash, "saved"))) {
        removedTracks.push(track);
      }
    } catch {
      failedLocalFiles.add(file.fileHash);
    }
  }
  for (const fileHash of hashes) {
    if (!failedLocalFiles.has(fileHash) && !(await getLocalAudioFileRecord(fileHash, "saved"))) {
      await deleteCachedLibraryTrack(fileHash);
    } else if (!failedLocalFiles.has(fileHash)) {
      await deleteCachedLibraryTrackFile(fileHash);
    }
  }
  if (repository) {
    await removeUnreferencedTrackAssets(repository, removedTracks);
    if (removedTracks.length) await repository.touch();
  }

  return {
    deletedEntryCount: hashes.size - failedLocalFiles.size,
    failedEntryCount: failedLocalFiles.size
  };
  });
}

async function removeUnreferencedTrackAssets(repository: LocalRepository, removed: LocalRepositoryTrackRecord[]) {
  if (!removed.length) return;
  const [remaining, rooms] = await Promise.all([repository.listTracks(), repository.listRooms()]);
  const protectedIds = new Set([
    ...remaining.flatMap((track) => [track.originalAsset?.assetId, track.playbackAsset?.assetId]),
    ...rooms.flatMap((room) => room.tracks.flatMap((track) => [track.originalAsset?.assetId, track.playbackAsset?.assetId]))
  ]);
  for (const track of removed) {
    if (track.originalAsset && !protectedIds.has(track.originalAsset.assetId)) {
      await repository.removeDirectory(`.soqaro/assets/original/${track.originalAsset.assetId}`);
      await deleteAudioAsset(track.originalAsset.assetId);
    }
    if (track.playbackAsset && !protectedIds.has(track.playbackAsset.assetId)) {
      await repository.removeDirectory(repository.getPlaybackAssetPath(track.playbackAsset.assetId, track.playbackAsset.profileId));
      await deleteAudioAsset(track.playbackAsset.assetId);
    }
    for (const path of [track.artworkPath, track.lyricsPath]) {
      if (path && !remaining.some((other) => other.artworkPath === path || other.lyricsPath === path)) {
        await repository.removePath(path);
      }
    }
  }
}

export async function getLocalAudioStorageStats(): Promise<LocalAudioStorageStats> {
  const [cache, savedFiles, repository] = await Promise.all([
    getLocalAudioCacheStats(),
    listLocalAudioFiles("saved"),
    getConfiguredLocalRepository()
  ]);
  const managedFiles = savedFiles.filter((file) => !file.sourceDirectoryId && file.source !== "directory-scan");
  const otherFiles = repository
    ? await repository.listFiles(localOtherFilePrefixes)
    : [];

  return {
    cache,
    saved: {
      fileCount: managedFiles.length,
      bytes: managedFiles.reduce((total, file) => total + file.sizeBytes, 0)
    },
    other: {
      fileCount: otherFiles.length,
      bytes: otherFiles.reduce((total, file) => total + file.sizeBytes, 0)
    }
  };
}

export async function clearSavedLocalAudio() {
  return enqueueLocalRepositoryWrite(async () => {
  const savedFiles = await listLocalAudioFiles("saved");
  const repository = await getConfiguredLocalRepository();
  if (!repository) {
    return {
      deletedEntryCount: 0,
      failedEntryCount: savedFiles.length,
      skippedExternalCount: 0
    };
  }

  let deletedEntryCount = 0;
  let failedEntryCount = 0;
  let skippedExternalCount = 0;
  const removedTracks: LocalRepositoryTrackRecord[] = [];
  for (const file of savedFiles) {
    const track = await repository.readTrack(file.fileHash);
    const isExternalSource = file.source === "directory-scan" || !!file.sourceDirectoryId || track?.source.kind === "external";
    if (isExternalSource) {
      skippedExternalCount += 1;
      continue;
    }

    try {
      if (file.relativePath) {
        await repository.removePath(file.relativePath);
      }
      await repository.deleteTrack(file.fileHash, { touchManifest: false });
      await deleteLocalAudioFileRecord(file.fileHash, "saved");
      await deleteCachedLibraryTrack(file.fileHash);
      if (track) removedTracks.push(track);
      deletedEntryCount += 1;
    } catch {
      failedEntryCount += 1;
    }
  }
  await removeUnreferencedTrackAssets(repository, removedTracks);
  if (deletedEntryCount) await repository.touch();

  return { deletedEntryCount, failedEntryCount, skippedExternalCount };
  });
}

export async function clearLocalOtherFiles() {
  return enqueueLocalRepositoryWrite(async () => {
  const repository = await getConfiguredLocalRepository();
  if (!repository) {
    return { deletedEntryCount: 0, failedEntryCount: 0 };
  }

  const files = await repository.listFiles(localOtherFilePrefixes);
  const tracks = await repository.listTracks();
  let deletedEntryCount = 0;
  let failedEntryCount = 0;
  const removedPaths = new Set<string>();
  for (const file of files) {
    try {
      await repository.removePath(file.relativePath);
      removedPaths.add(file.relativePath);
      deletedEntryCount += 1;
    } catch {
      failedEntryCount += 1;
    }
  }

  for (const track of tracks) {
    const nextTrack = {
      ...track,
      artworkPath: track.artworkPath && removedPaths.has(track.artworkPath) ? null : track.artworkPath,
      lyricsPath: track.lyricsPath && removedPaths.has(track.lyricsPath) ? null : track.lyricsPath
    };
    if (nextTrack.artworkPath !== track.artworkPath || nextTrack.lyricsPath !== track.lyricsPath) {
      await repository.writeTrack(nextTrack, { touchManifest: false });
    }
  }
  if (files.length > 0) {
    await repository.touch();
  }

  return { deletedEntryCount, failedEntryCount };
  });
}



async function collectSelectedLocalAudioFiles(
  directory: FileSystemDirectoryHandle,
  parentPath: string,
  files: SelectedLocalAudioFile[],
  signal?: AbortSignal,
  // Threaded through the recursion so the whole walk shares one budget; a
  // per-directory yielder would reset the clock at every level. This replaced a
  // modulo-24 counter, whose only job was deciding when to yield.
  yieldIfFrameBudgetExhausted = createFrameBudgetYielder()
) {
  for await (const entry of (directory as IterableDirectoryHandle).values()) {
    if (signal?.aborted) {
      throw new DOMException("Local directory scan was cancelled.", "AbortError");
    }
    await yieldIfFrameBudgetExhausted();
    const fileName = parentPath ? `${parentPath}/${entry.name}` : entry.name;
    if (entry.kind === "file") {
      try {
        const file = await entry.getFile();
        if (isAudioFile(file)) {
          files.push({ file, fileName, lastModified: file.lastModified });
        }
      } catch {
        // Skip inaccessible file without failing the whole scan
      }
      continue;
    }

    // Skip hidden folders (e.g. .git, .soqaro, .vscode) and system subdirectories
    if (entry.name.startsWith(".")) {
      continue;
    }
    try {
      await collectSelectedLocalAudioFiles(entry, fileName, files, signal, yieldIfFrameBudgetExhausted);
    } catch {
      // Skip inaccessible directory without failing the whole scan
    }
  }
}



async function filterReadableLocalFiles(
  root: FileSystemDirectoryHandle,
  records: ReadonlyArray<{
    fileHash: string;
    fileName: string;
    relativePath?: string;
    source?: "directory-scan";
  }>,
  allowExternalRootFiles: boolean,
  // Required, not optional: this runs once per storage kind over the same
  // handle, so the caller opens the repository once and shares it. Passing
  // `null` is meaningful (no repository on this root) and must not re-open.
  repository: LocalRepository | null
) {
  const readable = new Array<boolean>(records.length).fill(false);
  const yieldIfFrameBudgetExhausted = createFrameBudgetYielder();
  await forEachWithConcurrency(
    records,
    resolveLocalFileConcurrency(records.length),
    async (record, index) => {
      await yieldIfFrameBudgetExhausted();
      if (record.relativePath && repository && await repository.readPath(record.relativePath)) {
        readable[index] = true;
        return;
      }
      if (allowExternalRootFiles && record.source === "directory-scan") {
        try {
          await getFileByPath(root, record.fileName);
          readable[index] = true;
        } catch {
          // The record points to a file that is no longer present.
        }
      }
    }
  );
  // Rebuilt in record order rather than completion order — the probes now
  // finish out of order, and callers treat this list as a stable snapshot.
  return records.flatMap((record, index) => (readable[index] ? [record.fileHash] : []));
}
