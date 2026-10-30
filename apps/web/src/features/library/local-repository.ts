"use client";

import {
  playbackEncoderVersion,
  playbackProfileId,
  type AssetUnitDescriptor,
  type OriginalAssetManifest,
  type PlaybackAssetManifest,
  type RoomSnapshot,
  type TrackMeta,
  type TrackLoudness
} from "@soqaro/shared";
import { forEachWithConcurrency, resolveLocalFileConcurrency } from "./local-audio-storage-helpers";
import type {
  RepositoryDirectoryHandle as FileSystemDirectoryHandle,
  RepositoryFileHandle as FileSystemFileHandle
} from "./directory-handle";
export const localRepositoryDirectoryName = ".soqaro";
export const localRepositoryFormat = "soqaro-local-repository" as const;
export const localRepositorySchemaVersion = 1 as const;

const repositoryManifestFileName = "repository.json";
const playbackWriteConcurrency = 2;

function dataUrlToBlob(dataUrl: string): Blob | null {
  try {
    const parts = dataUrl.split(",");
    const header = parts[0] || "";
    const mimeMatch = header.match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
    const base64Data = parts[1] || "";
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

export type LocalRepositoryManifest = {
  format: typeof localRepositoryFormat;
  schemaVersion: typeof localRepositorySchemaVersion;
  repositoryId: string;
  hashAlgorithm: "sha256";
  playbackProfiles: Record<string, {
    encoderVersion: string;
    segmentDurationMs: number;
  }>;
  createdAt: string;
  updatedAt: string;
};

export type LocalRepositoryTrackRecord = {
  schemaVersion: 1;
  fileHash: string;
  title: string;
  artist: string;
  album?: string | null;
  artworkUrl?: string | null;
  lyrics?: string | null;
  translatedLyrics?: string | null;
  romanizedLyrics?: string | null;
  durationMs: number;
  mimeType: string;
  sizeBytes: number;
  loudness?: TrackLoudness;
  sourceType?: "netease" | "qqmusic" | "bilibili" | "alist" | "local_upload";
  sourceRef?: { provider: "netease" | "qqmusic" | "bilibili" | "alist"; trackId: string } | null;
  source: {
    kind: "managed" | "external";
    relativePath: string;
    sizeBytes?: number;
    lastModified?: number;
  };
  originalAsset?: {
    assetId: string;
    manifestPath: string;
  } | null;
  playbackAsset?: {
    assetId: string;
    profileId: string;
    manifestPath: string;
  } | null;
  artworkPath?: string | null;
  lyricsPath?: string | null;
  retention: "library" | "cache";
  roomRefs?: Array<{
    roomId: string;
    trackId: string;
    ownerSessionId: string;
    ownerNickname: string;
  }>;
  createdAt: string;
  updatedAt: string;
};

export type LocalRepositoryRoomRecord = {
  schemaVersion: 1;
  roomId: string;
  room: RoomSnapshot["room"];
  tracks: TrackMeta[];
  queue: RoomSnapshot["queue"];
  playlists: RoomSnapshot["playlists"];
  createdAt: string;
  updatedAt: string;
};

export type LocalRepositoryPlaylistRecord = {
  schemaVersion: 1;
  id: string;
  title: string;
  description: string | null;
  sourceDirectoryId?: string | null;
  sourceDirectoryName?: string | null;
  trackRefs: Array<
    | { kind: "content"; fileHash: string; trackId?: string }
    | { kind: "provider"; provider: "netease" | "qqmusic"; trackId: string }
  >;
  createdAt: string;
  updatedAt: string;
};

type LocalRepositoryPlaybackUnit = {
  descriptor: AssetUnitDescriptor;
  relativePath: string;
};

type LocalRepositoryPlaybackManifest = {
  storageSchemaVersion: 1;
  manifest: PlaybackAssetManifest;
  units: LocalRepositoryPlaybackUnit[];
};

type LocalRepositoryOriginalManifest = {
  storageSchemaVersion: 1;
  manifest: OriginalAssetManifest;
  sourcePath: string;
};

type LocalRepositoryTempWrite = {
  storageSchemaVersion: 1;
  id: string;
  kind: "playback-asset";
  targetPath: string;
};

type LocalRepositoryTrashEntry = {
  storageSchemaVersion: 1;
  id: string;
  targetPath: string;
};

export type LocalRepositoryTranscodeJob = {
  sourceFileHash: string;
  kind: "original-reindex" | "playback-transcode";
  profileId: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  errorMessage: string | null;
  updatedAt: string;
};

type DirectoryHandleWithValues = FileSystemDirectoryHandle & {
  values?: () => AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
};

export type LocalRepositoryFileEntry = {
  relativePath: string;
  sizeBytes: number;
};

export class LocalRepository {
  private constructor(
    public readonly root: FileSystemDirectoryHandle,
    public readonly dataDirectory: FileSystemDirectoryHandle,
    public readonly manifest: LocalRepositoryManifest
  ) {}

  static async initialize(root: FileSystemDirectoryHandle) {
    const dataDirectory = await root.getDirectoryHandle(localRepositoryDirectoryName, {
      create: true
    });
    const existing = await readJsonFile<LocalRepositoryManifest>(
      dataDirectory,
      repositoryManifestFileName
    );
    const manifest = existing ?? createRepositoryManifest();
    validateRepositoryManifest(manifest);
    if (existing && !hasCurrentPlaybackProfile(manifest)) {
      manifest.playbackProfiles = currentPlaybackProfiles();
      await writeJsonFile(dataDirectory, repositoryManifestFileName, manifest);
    }
    if (!existing) {
      await writeJsonFile(dataDirectory, repositoryManifestFileName, manifest);
    }
    return new LocalRepository(root, dataDirectory, manifest);
  }

  static async open(root: FileSystemDirectoryHandle, options?: { recover?: boolean }) {
    const dataDirectory = await root.getDirectoryHandle(localRepositoryDirectoryName);
    const manifest = await readJsonFile<LocalRepositoryManifest>(dataDirectory, repositoryManifestFileName);
    if (!manifest) throw new Error("Soqaro 仓库未初始化或无法读取。");
    validateRepositoryManifest(manifest);
    const repository = new LocalRepository(root, dataDirectory, manifest);
    if (options?.recover !== false) {
      await repository.cleanupTemporaryWrites();
      await repository.cleanupTrash();
      await repository.cleanupObsoletePlaybackAssets();
    }
    return repository;
  }

  async touch() {
    this.manifest.updatedAt = new Date().toISOString();
    await writeJsonFile(this.dataDirectory, repositoryManifestFileName, this.manifest);
  }

  async listFiles(prefixes: readonly string[] = [localRepositoryDirectoryName]) {
    const groups = await Promise.all(prefixes.map(async (prefix) => {
      const directory = await getDirectoryByPath(this.root, prefix.replace(/\/$/, ""), false);
      return directory ? listFilesFromDirectory(directory, prefix.replace(/\/$/, "")) : [];
    }));
    return groups.flat();
  }

  async writeManagedSource(input: {
    file: Blob;
    fileHash: string;
    mimeType: string;
  }) {
    const relativePath = this.getManagedSourcePath(input);
    await this.writeBlob(relativePath, input.file);
    return relativePath;
  }

  getManagedSourcePath(input: { fileHash: string; mimeType: string }) {
    const extension = inferFileExtension(input.mimeType);
    return `${localRepositoryDirectoryName}/library/sources/${input.fileHash.slice(0, 2)}/${input.fileHash}${extension ? `.${extension}` : ""}`;
  }

  async writeCachedSource(input: {
    file: Blob;
    fileHash: string;
    mimeType: string;
    provider?: "netease" | "qqmusic" | "bilibili" | "alist" | "local_upload";
  }, options?: { reuseExisting?: boolean }) {
    const relativePath = this.getCachedSourcePath(input);
    if (options?.reuseExisting && await getFileByPath(this.root, relativePath, false)) {
      return relativePath;
    }
    await this.writeBlob(relativePath, input.file);
    return relativePath;
  }

  getCachedSourcePath(input: {
    fileHash: string;
    mimeType: string;
    provider?: "netease" | "qqmusic" | "bilibili" | "alist" | "local_upload";
  }) {
    const extension = inferFileExtension(input.mimeType);
    const provider = input.provider ?? "local_upload";
    return `${localRepositoryDirectoryName}/cache/provider/${provider}/${input.fileHash.slice(0, 2)}/${input.fileHash}${extension ? `.${extension}` : ""}`;
  }

  async writeLyrics(fileHash: string, lyrics: string) {
    const relativePath = this.getLyricsPath(fileHash);
    await this.writeBlob(
      relativePath,
      new Blob([lyrics], { type: "text/plain;charset=utf-8" })
    );
    return relativePath;
  }

  getLyricsPath(fileHash: string) {
    return `${localRepositoryDirectoryName}/library/lyrics/${fileHash}.lrc`;
  }

  async writeArtworkBlob(input: {
    fileHash: string;
    blob: Blob;
    retention: "library" | "cache";
    provider?: "netease" | "qqmusic" | "bilibili" | "alist" | "local_upload";
  }) {
    if (input.blob.size <= 0) return null;
    const extension = inferArtworkExtension(input.blob.type, "");
    const baseDirectory = input.retention === "library"
      ? `${localRepositoryDirectoryName}/library/artwork`
      : `${localRepositoryDirectoryName}/cache/artwork/${input.provider ?? "local_upload"}`;
    const relativePath = `${baseDirectory}/${input.fileHash}${extension ? `.${extension}` : ""}`;
    await this.writeBlob(relativePath, input.blob);
    return relativePath;
  }

  async writeArtworkFromUrl(input: {
    fileHash: string;
    artworkUrl: string;
    retention: "library" | "cache";
    provider?: "netease" | "qqmusic" | "bilibili" | "alist" | "local_upload";
  }) {
    const normalizedUrl = input.artworkUrl.trim();
    if (!normalizedUrl) return null;

    let artwork: Blob | null = null;
    if (normalizedUrl.startsWith("data:")) {
      artwork = dataUrlToBlob(normalizedUrl);
    } else {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4_000);
        try {
          artwork = await fetch(normalizedUrl, { signal: controller.signal }).then(async (response) => {
            if (!response.ok) throw new Error(`Artwork request failed with ${response.status}.`);
            return response.blob();
          });
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        return null;
      }
    }
    if (!artwork || artwork.size <= 0 || (artwork.type && !artwork.type.startsWith("image/"))) return null;

    return this.writeArtworkBlob({
      fileHash: input.fileHash,
      blob: artwork,
      retention: input.retention,
      provider: input.provider
    });
  }

  getArtworkPath(input: {
    fileHash: string;
    retention: "library" | "cache";
    provider?: "netease" | "qqmusic" | "bilibili" | "alist" | "local_upload";
    extension?: string;
  }) {
    const baseDirectory = input.retention === "library"
      ? `${localRepositoryDirectoryName}/library/artwork`
      : `${localRepositoryDirectoryName}/cache/artwork/${input.provider ?? "local_upload"}`;
    return `${baseDirectory}/${input.fileHash}${input.extension ? `.${input.extension}` : ""}`;
  }

  async readPath(relativePath: string) {
    const fileHandle = await getFileByPath(this.root, relativePath, false);
    return fileHandle ? fileHandle.getFile() : null;
  }

  async removePath(relativePath: string) {
    const parts = splitSafePath(relativePath);
    const fileName = parts.pop();
    if (!fileName) return;
    const directory = await getDirectoryByParts(this.root, parts, false);
    if (!directory) return;
    try {
      await directory.removeEntry(fileName);
    } catch (error) {
      if ((error as DOMException).name !== "NotFoundError") throw error;
    }
  }

  async removeDirectory(relativePath: string) {
    const parts = splitSafePath(relativePath);
    const directoryName = parts.pop();
    if (!directoryName) return;
    const parent = await getDirectoryByParts(this.root, parts, false);
    if (!parent) return;
    try {
      await parent.removeEntry(directoryName, { recursive: true });
    } catch (error) {
      if ((error as DOMException).name !== "NotFoundError") throw error;
    }
  }

  async deleteOriginalAsset(assetId: string) {
    const targetPath = `${localRepositoryDirectoryName}/assets/original/${assetId}`;
    await this.queueTrash(targetPath);
    await this.removeDirectory(targetPath);
    await this.touch();
  }

  async writeTrack(
    record: LocalRepositoryTrackRecord,
    options?: { touchManifest?: boolean }
  ) {
    const existing = await this.readTrack(record.fileHash);
    const roomRefs = record.roomRefs ?? existing?.roomRefs;
    const nextRecord: LocalRepositoryTrackRecord = {
      ...record,
      ...(roomRefs && roomRefs.length > 0 ? { roomRefs } : {})
    };
    if (record.roomRefs !== undefined && record.roomRefs.length === 0) {
      delete nextRecord.roomRefs;
    }
    await this.writeJson(
      `${localRepositoryDirectoryName}/catalog/tracks/${nextRecord.fileHash}.json`,
      nextRecord
    );
    if (options?.touchManifest !== false) {
      await this.touch();
    }
  }

  async readTrack(fileHash: string) {
    return this.readJson<LocalRepositoryTrackRecord>(
      `${localRepositoryDirectoryName}/catalog/tracks/${fileHash}.json`
    );
  }

  async deleteTrack(fileHash: string, options?: { touchManifest?: boolean }) {
    await this.removePath(`${localRepositoryDirectoryName}/catalog/tracks/${fileHash}.json`);
    if (options?.touchManifest !== false) {
      await this.touch();
    }
  }

  async listTracks() {
    return this.listJsonFiles<LocalRepositoryTrackRecord>(
      `${localRepositoryDirectoryName}/catalog/tracks`
    );
  }

  async writeRoomSnapshot(snapshot: RoomSnapshot) {
    const now = new Date().toISOString();
    const existingRoom = await this.readRoom(snapshot.room.id);
    await this.writeJson(
      `${localRepositoryDirectoryName}/catalog/rooms/${encodeURIComponent(snapshot.room.id)}.json`,
      {
        schemaVersion: 1,
        roomId: snapshot.room.id,
        room: snapshot.room,
        tracks: snapshot.tracks,
        queue: snapshot.queue,
        playlists: snapshot.playlists,
        createdAt: existingRoom?.createdAt ?? now,
        updatedAt: now
      } satisfies LocalRepositoryRoomRecord
    );

    const tracks = await this.listTracks();
    const tracksByHash = new Map(tracks.map((record) => [record.fileHash, record]));
    const activeTrackIdsByHash = new Map<string, Set<string>>();
    for (const track of snapshot.tracks) {
      let ids = activeTrackIdsByHash.get(track.fileHash);
      if (!ids) {
        ids = new Set();
        activeTrackIdsByHash.set(track.fileHash, ids);
      }
      ids.add(track.id);
    }

    for (const record of tracks) {
      const existingRefs = record.roomRefs;
      if (!existingRefs || existingRefs.length === 0) continue;
      const activeIds = activeTrackIdsByHash.get(record.fileHash);
      const roomRefs = existingRefs.filter(
        (ref) => ref.roomId !== snapshot.room.id || Boolean(activeIds?.has(ref.trackId))
      );
      if (roomRefs.length !== existingRefs.length) {
        await this.writeTrack({ ...record, roomRefs }, { touchManifest: false });
        const nextCached: LocalRepositoryTrackRecord = { ...record };
        if (roomRefs.length > 0) {
          nextCached.roomRefs = roomRefs;
        } else {
          delete nextCached.roomRefs;
        }
        tracksByHash.set(record.fileHash, nextCached);
      }
      // Room membership is metadata, not cache ownership. Cached audio stays
      // available after a room snapshot no longer references the track.
    }

    for (const track of snapshot.tracks) {
      const existing = tracksByHash.get(track.fileHash);
      const existingRoomRefs = existing?.roomRefs ?? [];
      const hasCurrentRoomRef = existingRoomRefs.some(
        (ref) =>
          ref.roomId === snapshot.room.id &&
          ref.trackId === track.id &&
          ref.ownerSessionId === track.ownerSessionId &&
          ref.ownerNickname === track.ownerNickname
      );
      if (existing && hasCurrentRoomRef) {
        continue;
      }
      const roomRefs = [
        ...existingRoomRefs.filter((ref) => !(ref.roomId === snapshot.room.id && ref.trackId === track.id)),
        {
          roomId: snapshot.room.id,
          trackId: track.id,
          ownerSessionId: track.ownerSessionId,
          ownerNickname: track.ownerNickname
        }
      ];
      const lyricsPath = track.lyrics?.trim() && !existing?.lyricsPath
        ? await this.writeLyrics(track.fileHash, track.lyrics)
        : existing?.lyricsPath ?? null;
      if (!lyricsPath && existing?.lyricsPath) {
        await this.removePath(existing.lyricsPath);
      }
      const nextTrackRecord: LocalRepositoryTrackRecord = {
        schemaVersion: 1,
        fileHash: track.fileHash,
        title: track.title,
        artist: track.artist,
        album: track.album,
        artworkUrl: track.artworkUrl,
        lyrics: track.lyrics ?? null,
        durationMs: track.durationMs,
        mimeType: track.mimeType ?? "audio/mpeg",
        sizeBytes: track.sizeBytes ?? 0,
        loudness: track.loudness,
        sourceType: track.sourceType,
        sourceRef: track.sourceRef ?? null,
        source: existing?.source ?? { kind: "external", relativePath: "" },
        originalAsset: track.originalAsset
          ? {
              assetId: track.originalAsset.assetId,
              manifestPath: existing?.originalAsset?.manifestPath
                ?? this.getOriginalManifestPath(track.originalAsset.assetId)
            }
          : existing?.originalAsset ?? null,
        playbackAsset: await this.resolveRoomPlaybackAssetReference(
          existing?.playbackAsset,
          track.playbackAsset
        ),
        artworkPath: existing?.artworkPath ?? null,
        lyricsPath,
        retention: existing?.retention ?? "cache",
        roomRefs,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      await this.writeTrack(nextTrackRecord, { touchManifest: false });
      tracksByHash.set(track.fileHash, nextTrackRecord);
    }
    await this.touch();
  }

  async readRoom(roomId: string) {
    return this.readJson<LocalRepositoryRoomRecord>(
      `${localRepositoryDirectoryName}/catalog/rooms/${encodeURIComponent(roomId)}.json`
    );
  }

  async listRooms() {
    return this.listJsonFiles<LocalRepositoryRoomRecord>(
      `${localRepositoryDirectoryName}/catalog/rooms`
    );
  }

  async deleteRoom(roomId: string) {
    await this.removePath(
      `${localRepositoryDirectoryName}/catalog/rooms/${encodeURIComponent(roomId)}.json`
    );
    await this.touch();
  }

  async removeRoomTrackReferences(roomId: string, trackIds?: readonly string[]) {
    const removed = trackIds ? new Set(trackIds) : null;
    const tracks = await this.listTracks();
    for (const record of tracks) {
      const roomRefs = record.roomRefs?.filter(
        (ref) => ref.roomId !== roomId || (removed ? !removed.has(ref.trackId) : false)
      ) ?? [];
      if (roomRefs.length === (record.roomRefs?.length ?? 0)) continue;
      await this.writeTrack({ ...record, roomRefs }, { touchManifest: false });
    }
    await this.touch();
  }

  async writeProviderTrack(id: string, record: unknown) {
    await this.writeJson(
      `${localRepositoryDirectoryName}/catalog/provider-tracks/${encodeURIComponent(id)}.json`,
      record
    );
    await this.touch();
  }

  async listProviderTracks<T>() {
    return this.listJsonFiles<T>(
      `${localRepositoryDirectoryName}/catalog/provider-tracks`
    );
  }

  async writePlaylist(record: LocalRepositoryPlaylistRecord) {
    await this.writeJson(
      `${localRepositoryDirectoryName}/catalog/playlists/${record.id}.json`,
      record
    );
    await this.touch();
  }

  async readPlaylist(id: string) {
    return this.readJson<LocalRepositoryPlaylistRecord>(
      `${localRepositoryDirectoryName}/catalog/playlists/${id}.json`
    );
  }

  async listPlaylists() {
    return this.listJsonFiles<LocalRepositoryPlaylistRecord>(
      `${localRepositoryDirectoryName}/catalog/playlists`
    );
  }

  async deletePlaylist(id: string) {
    await this.removePath(`${localRepositoryDirectoryName}/catalog/playlists/${id}.json`);
    await this.touch();
  }

  async writeTranscodeJob(job: LocalRepositoryTranscodeJob) {
    await this.writeJson(
      `${localRepositoryDirectoryName}/jobs/${job.sourceFileHash}-${job.kind}.json`,
      { storageSchemaVersion: 1, ...job }
    );
    await this.touch();
  }

  async listTranscodeJobs() {
    return this.listJsonFiles<LocalRepositoryTranscodeJob>(
      `${localRepositoryDirectoryName}/jobs`
    );
  }

  async deleteTranscodeJobs(sourceFileHash: string) {
    const jobs = await this.listTranscodeJobs();
    await Promise.all(
      jobs
        .filter((job) => job.sourceFileHash === sourceFileHash)
        .map((job) => this.removePath(
          `${localRepositoryDirectoryName}/jobs/${job.sourceFileHash}-${job.kind}.json`
        ))
    );
    await this.touch();
  }

  async writeOriginalManifest(
    manifest: OriginalAssetManifest,
    sourcePath: string
  ) {
    const relativePath = this.getOriginalManifestPath(manifest.assetId);
    await this.writeJson(relativePath, {
      storageSchemaVersion: 1,
      manifest,
      sourcePath
    } satisfies LocalRepositoryOriginalManifest);
    return relativePath;
  }

  getOriginalManifestPath(assetId: string) {
    return `${localRepositoryDirectoryName}/assets/original/${assetId}/manifest.json`;
  }

  async readOriginalManifest(assetId: string) {
    return this.readJson<LocalRepositoryOriginalManifest>(
      `${localRepositoryDirectoryName}/assets/original/${assetId}/manifest.json`
    );
  }

  async listOriginalAssets() {
    return this.listJsonFilesRecursively<LocalRepositoryOriginalManifest>(
      `${localRepositoryDirectoryName}/assets/original`
    );
  }

  async beginPlaybackAssetWrite(manifest: PlaybackAssetManifest) {
    const basePath = this.getPlaybackAssetPath(manifest.assetId, manifest.profileId);
    const existing = await this.readPlaybackAsset(manifest.assetId, manifest.profileId);
    if (existing && existing.units.length === manifest.unitCount) {
      return null;
    }

    const journalId = `playback-${manifest.profileId}-${manifest.assetId}`;
    const journalPath = `${localRepositoryDirectoryName}/tmp/${journalId}.json`;
    await this.writeJson(journalPath, {
      storageSchemaVersion: 1,
      id: journalId,
      kind: "playback-asset",
      targetPath: basePath
    } satisfies LocalRepositoryTempWrite);

    const unitDescriptors: Array<LocalRepositoryPlaybackUnit | undefined> = new Array(
      manifest.unitCount
    );
    let unitsDirectory: FileSystemDirectoryHandle;
    try {
      const resolvedUnitsDirectory = await getDirectoryByParts(
        this.root,
        splitSafePath(`${basePath}/units`),
        true
      );
      if (!resolvedUnitsDirectory) throw new Error("无法创建播放分片目录。");
      unitsDirectory = resolvedUnitsDirectory;
    } catch (error) {
      await this.removeDirectory(basePath).catch(() => undefined);
      await this.removePath(journalPath).catch(() => undefined);
      throw error;
    }

    const abort = async () => {
      await this.removeDirectory(basePath).catch(() => undefined);
      await this.removePath(journalPath).catch(() => undefined);
    };

    return {
      writeUnits: async (
        units: ReadonlyArray<{ descriptor: AssetUnitDescriptor; payload: ArrayBuffer }>
      ) => {
        if (units.length === 0) return;
        let nextBatchOffset = 0;
        await Promise.all(
          Array.from(
            { length: Math.min(playbackWriteConcurrency, units.length) },
            async () => {
              while (true) {
                const batchOffset = nextBatchOffset++;
                if (batchOffset >= units.length) return;
                const unit = units[batchOffset]!;
                const unitIndex = unit.descriptor.unitIndex;
                if (unitIndex < 0 || unitIndex >= manifest.unitCount) {
                  throw new Error("播放资产分片索引超出清单范围。");
                }
                const fileName = `${String(unitIndex).padStart(6, "0")}.opus`;
                const relativePath = `${basePath}/units/${fileName}`;
                const fileHandle = await unitsDirectory.getFileHandle(fileName, { create: true });
                const writable = await fileHandle.createWritable();
                try {
                  await writable.write(
                    new Blob([new Uint8Array(unit.payload)], {
                      type: "audio/ogg"
                    })
                  );
                  await writable.close();
                } catch (err) {
                  await writable.abort().catch(() => undefined);
                  throw err;
                }
                unitDescriptors[unitIndex] = {
                  descriptor: unit.descriptor,
                  relativePath
                };
              }
            }
          )
        );
      },
      commit: async () => {
        const finalizedUnits = unitDescriptors.map((unit) => {
          if (!unit) {
            throw new Error("播放资产分片数量与清单不一致。");
          }
          return unit;
        });
        await this.writeJson(`${basePath}/manifest.json`, {
          storageSchemaVersion: 1,
          manifest,
          units: finalizedUnits
        } satisfies LocalRepositoryPlaybackManifest);
        await this.removePath(journalPath);
        await this.touch();
        return `${basePath}/manifest.json`;
      },
      abort
    };
  }

  async writePlaybackAsset(input: {
    manifest: PlaybackAssetManifest;
    units: Array<{ descriptor: AssetUnitDescriptor; payload: ArrayBuffer }>;
  }) {
    if (input.units.length !== input.manifest.unitCount) {
      throw new Error("播放资产分片数量与清单不一致。");
    }
    const basePath = this.getPlaybackAssetPath(input.manifest.assetId, input.manifest.profileId);
    const writer = await this.beginPlaybackAssetWrite(input.manifest);
    if (!writer) {
      return `${basePath}/manifest.json`;
    }
    try {
      await writer.writeUnits(input.units);
      return await writer.commit();
    } catch (error) {
      await writer.abort();
      throw error;
    }
  }

  getPlaybackAssetPath(assetId: string, profileId: string) {
    return `${localRepositoryDirectoryName}/assets/playback/${profileId}/${assetId}`;
  }

  getPlaybackManifestPath(assetId: string, profileId: string) {
    return `${this.getPlaybackAssetPath(assetId, profileId)}/manifest.json`;
  }

  async readPlaybackAsset(assetId: string, profileId: string) {
    return this.readJson<LocalRepositoryPlaybackManifest>(
      `${localRepositoryDirectoryName}/assets/playback/${profileId}/${assetId}/manifest.json`
    );
  }

  async deletePlaybackAsset(assetId: string, profileId: string) {
    const targetPath = this.getPlaybackAssetPath(assetId, profileId);
    await this.queueTrash(targetPath);
    await this.removeDirectory(targetPath);
    await this.touch();
  }

  async cleanupObsoletePlaybackAssets() {
    const assets = await this.listPlaybackAssets();
    const obsolete = assets.filter((asset) =>
      asset.manifest.profileId !== playbackProfileId ||
      asset.manifest.encoder?.version !== playbackEncoderVersion
    );
    if (obsolete.length === 0) return;

    const obsoleteAssetIds = new Set(obsolete.map((asset) => asset.manifest.assetId));
    const tracks = await this.listTracks();
    await Promise.all(
      tracks
        .filter((track) => track.playbackAsset && obsoleteAssetIds.has(track.playbackAsset.assetId))
        .map((track) => this.writeTrack({ ...track, playbackAsset: null }, { touchManifest: false }))
    );
    await Promise.all(obsolete.map((asset) => this.removeDirectory(
      this.getPlaybackAssetPath(asset.manifest.assetId, asset.manifest.profileId)
    )));
    await this.touch();
  }

  async listPlaybackAssets() {
    return this.listJsonFilesRecursively<LocalRepositoryPlaybackManifest>(
      `${localRepositoryDirectoryName}/assets/playback`
    );
  }

  async readPlaybackUnit(unit: LocalRepositoryPlaybackUnit) {
    return this.readPath(unit.relativePath);
  }

  private async resolveRoomPlaybackAssetReference(
    existing: LocalRepositoryTrackRecord["playbackAsset"] | undefined,
    incoming: TrackMeta["playbackAsset"] | undefined
  ) {
    const incomingReference = incoming
      ? {
          assetId: incoming.assetId,
          profileId: incoming.profileId,
          manifestPath: this.getPlaybackManifestPath(incoming.assetId, incoming.profileId)
        }
      : null;
    if (!existing) return incomingReference;

    const existingManifest = await this.readPlaybackAsset(existing.assetId, existing.profileId);
    const hasUsableExistingManifest = !!existingManifest &&
      existingManifest.units.length === existingManifest.manifest.unitCount;
    if (!incomingReference) {
      return hasUsableExistingManifest ? existing : null;
    }
    const incomingManifest = await this.readPlaybackAsset(
      incomingReference.assetId,
      incomingReference.profileId
    );
    const hasUsableIncomingManifest = !!incomingManifest &&
      incomingManifest.units.length === incomingManifest.manifest.unitCount;
    return hasUsableExistingManifest && !hasUsableIncomingManifest
      ? existing
      : incomingReference;
  }

  private async cleanupTemporaryWrites() {
    const writes = await this.listJsonFiles<LocalRepositoryTempWrite>(
      `${localRepositoryDirectoryName}/tmp`
    );
    for (const write of writes) {
      if (write.kind !== "playback-asset" || !write.id || !write.targetPath) continue;
      await this.removeDirectory(write.targetPath);
      await this.removePath(`${localRepositoryDirectoryName}/tmp/${write.id}.json`);
    }
  }

  private async queueTrash(targetPath: string) {
    const id = globalThis.crypto?.randomUUID?.()
      ?? `trash-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await this.writeJson(`${localRepositoryDirectoryName}/trash/${id}.json`, {
      storageSchemaVersion: 1,
      id,
      targetPath
    } satisfies LocalRepositoryTrashEntry);
  }

  private async cleanupTrash() {
    const entries = await this.listJsonFiles<LocalRepositoryTrashEntry>(
      `${localRepositoryDirectoryName}/trash`
    );
    for (const entry of entries) {
      if (!entry.id || !entry.targetPath) continue;
      await this.removeDirectory(entry.targetPath);
      await this.removePath(`${localRepositoryDirectoryName}/trash/${entry.id}.json`);
    }
  }

  private async writeBlob(relativePath: string, blob: Blob) {
    const parts = splitSafePath(relativePath);
    const fileName = parts.pop();
    if (!fileName) throw new Error("本地仓库文件路径为空。");
    const directory = await getDirectoryByParts(this.root, parts, true);
    if (!directory) throw new Error("无法创建本地仓库目录。");
    const fileHandle = await directory.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
  }

  private async writeJson(relativePath: string, value: unknown) {
    await this.writeBlob(
      relativePath,
      new Blob([JSON.stringify(value, null, 2)], { type: "application/json" })
    );
  }

  private async readJson<T>(relativePath: string) {
    const file = await this.readPath(relativePath);
    if (!file) return null;
    try {
      return JSON.parse(await file.text()) as T;
    } catch {
      return null;
    }
  }

  private async listJsonFiles<T>(relativeDirectory: string) {
    const directory = await getDirectoryByPath(this.root, relativeDirectory, false);
    if (!directory || !("values" in directory)) return [];
    const records: T[] = [];
    for await (const entry of (directory as DirectoryHandleWithValues).values!()) {
      if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
      try {
        records.push(JSON.parse(await entry.getFile().then((file) => file.text())) as T);
      } catch {
        // Ignore one corrupt record and allow the rest of the repository to load.
      }
    }
    return records;
  }

  private async listJsonFilesRecursively<T>(relativeDirectory: string) {
    const directory = await getDirectoryByPath(this.root, relativeDirectory, false);
    if (!directory || !("values" in directory)) return [];
    const records: T[] = [];
    for await (const entry of (directory as DirectoryHandleWithValues).values!()) {
      if (entry.kind === "file" && entry.name.endsWith(".json")) {
        try {
          records.push(JSON.parse(await entry.getFile().then((file) => file.text())) as T);
        } catch {
          // Ignore one corrupt record and allow the rest of the repository to load.
        }
        continue;
      }
      if (entry.kind !== "directory") continue;
      const childRecords = await listJsonFilesFromDirectory<T>(entry);
      records.push(...childRecords);
    }
    return records;
  }
}

export function createRepositoryTrackRecord(input: {
  fileHash: string;
  title: string;
  artist: string;
  album?: string | null;
  artworkUrl?: string | null;
  lyrics?: string | null;
  translatedLyrics?: string | null;
  romanizedLyrics?: string | null;
  provider?: "netease" | "qqmusic" | "bilibili" | "alist" | "local_upload";
  providerTrackId?: string | null;
  mimeType: string;
  durationMs: number;
  sizeBytes: number;
  loudness?: TrackLoudness;
  source: LocalRepositoryTrackRecord["source"];
  originalAsset?: LocalRepositoryTrackRecord["originalAsset"];
  playbackAsset?: LocalRepositoryTrackRecord["playbackAsset"];
  artworkPath?: string | null;
  lyricsPath?: string | null;
  retention: LocalRepositoryTrackRecord["retention"];
  roomRefs?: LocalRepositoryTrackRecord["roomRefs"];
  createdAt?: string;
  updatedAt?: string;
}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    fileHash: input.fileHash,
    title: input.title,
    artist: input.artist,
    ...(input.album !== undefined ? { album: input.album } : {}),
    ...(input.artworkUrl !== undefined ? { artworkUrl: input.artworkUrl } : {}),
    ...(input.lyrics !== undefined ? { lyrics: input.lyrics } : {}),
    ...(input.translatedLyrics !== undefined ? { translatedLyrics: input.translatedLyrics } : {}),
    ...(input.romanizedLyrics !== undefined ? { romanizedLyrics: input.romanizedLyrics } : {}),
    durationMs: input.durationMs,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    ...(input.loudness ? { loudness: input.loudness } : {}),
    ...(input.provider !== undefined ? { sourceType: input.provider } : {}),
    ...(input.providerTrackId && (input.provider === "netease" || input.provider === "qqmusic" || input.provider === "bilibili" || input.provider === "alist")
      ? { sourceRef: { provider: input.provider, trackId: input.providerTrackId } }
      : { sourceRef: null }),
    source: input.source,
    originalAsset: input.originalAsset ?? null,
    playbackAsset: input.playbackAsset ?? null,
    artworkPath: input.artworkPath ?? null,
    lyricsPath: input.lyricsPath ?? null,
    retention: input.retention,
    ...(input.roomRefs ? { roomRefs: input.roomRefs } : {}),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  } satisfies LocalRepositoryTrackRecord;
}

function createRepositoryManifest(): LocalRepositoryManifest {
  const now = new Date().toISOString();
  return {
    format: localRepositoryFormat,
    schemaVersion: localRepositorySchemaVersion,
    repositoryId: globalThis.crypto?.randomUUID?.() ?? `repository-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    hashAlgorithm: "sha256",
    playbackProfiles: currentPlaybackProfiles(),
    createdAt: now,
    updatedAt: now
  };
}

function currentPlaybackProfiles() {
  return {
    [playbackProfileId]: {
      encoderVersion: playbackEncoderVersion,
      segmentDurationMs: 2_000
    }
  };
}

function hasCurrentPlaybackProfile(manifest: LocalRepositoryManifest) {
  const profile = manifest.playbackProfiles?.[playbackProfileId];
  return profile?.encoderVersion === playbackEncoderVersion && profile.segmentDurationMs === 2_000;
}

function validateRepositoryManifest(manifest: LocalRepositoryManifest) {
  if (
    manifest.format !== localRepositoryFormat ||
    manifest.schemaVersion !== localRepositorySchemaVersion ||
    manifest.hashAlgorithm !== "sha256" ||
    typeof manifest.repositoryId !== "string"
  ) {
    throw new Error("所选文件夹不是兼容的 Soqaro 本地仓库，或仓库版本过旧。 ");
  }
}

async function writeJsonFile(
  directory: FileSystemDirectoryHandle,
  fileName: string,
  value: unknown
) {
  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(JSON.stringify(value, null, 2));
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

async function readJsonFile<T>(directory: FileSystemDirectoryHandle, fileName: string) {
  try {
    const handle = await directory.getFileHandle(fileName);
    return JSON.parse(await (await handle.getFile()).text()) as T;
  } catch {
    return null;
  }
}

async function getDirectoryByPath(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean
) {
  return getDirectoryByParts(root, splitSafePath(path), create);
}

async function getDirectoryByParts(
  root: FileSystemDirectoryHandle,
  parts: string[],
  create: boolean
) {
  let directory = root;
  for (const part of parts) {
    try {
      directory = await directory.getDirectoryHandle(part, { create });
    } catch (error) {
      if ((error as DOMException).name === "NotFoundError" && !create) return null;
      throw error;
    }
  }
  return directory;
}

async function getFileByPath(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean
) {
  const parts = splitSafePath(path);
  const fileName = parts.pop();
  if (!fileName) throw new Error("本地仓库文件路径为空。");
  const directory = await getDirectoryByParts(root, parts, create);
  if (!directory) return null;
  try {
    return await directory.getFileHandle(fileName, { create });
  } catch (error) {
    if ((error as DOMException).name === "NotFoundError" && !create) return null;
    throw error;
  }
}

async function listJsonFilesFromDirectory<T>(directory: FileSystemDirectoryHandle) {
  const iterable = directory as DirectoryHandleWithValues;
  if (!iterable.values) return [] as T[];
  const records: T[] = [];
  for await (const entry of iterable.values()) {
    if (entry.kind === "file" && entry.name.endsWith(".json")) {
      try {
        records.push(JSON.parse(await entry.getFile().then((file) => file.text())) as T);
      } catch {
        // Ignore one corrupt record and allow the rest of the repository to load.
      }
      continue;
    }
    if (entry.kind === "directory") {
      if (entry.name === "units") continue;
      records.push(...await listJsonFilesFromDirectory<T>(entry));
    }
  }
  return records;
}

async function listFilesFromDirectory(
  directory: FileSystemDirectoryHandle,
  relativeDirectory: string
): Promise<LocalRepositoryFileEntry[]> {
  const iterable = directory as DirectoryHandleWithValues;
  if (!iterable.values) return [];

  const files: LocalRepositoryFileEntry[] = [];
  const pending: Array<{ recordIndex: number; relativePath: string; handle: FileSystemFileHandle }> = [];
  for await (const entry of iterable.values()) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.kind === "file") {
      pending.push({ recordIndex: files.length, relativePath, handle: entry });
      // Placeholder, counted as present until `getFile()` says otherwise, so
      // the result keeps directory-iteration order.
      files.push({ relativePath, sizeBytes: 0 });
      continue;
    }
    if (entry.kind === "directory") {
      files.push(...await listFilesFromDirectory(entry, relativePath));
    }
  }

  // `getFile()` is what costs here, and doing it one file at a time is what
  // made listing a full library slow; run it with a bounded fan-out instead.
  const missing = new Set<number>();
  await forEachWithConcurrency(
    pending,
    resolveLocalFileConcurrency(pending.length),
    async (file) => {
      try {
        files[file.recordIndex] = {
          relativePath: file.relativePath,
          sizeBytes: file.handle.getSize
            ? await file.handle.getSize()
            : (await file.handle.getFile()).size
        };
      } catch {
        // Ignore files that disappear while the directory is being inspected.
        missing.add(file.recordIndex);
      }
    }
  );
  return missing.size === 0 ? files : files.filter((_, index) => !missing.has(index));
}

function splitSafePath(path: string) {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error("本地仓库路径必须是相对路径。");
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
    throw new Error("本地仓库路径包含非法片段。");
  }
  return parts;
}

function inferFileExtension(mimeType: string) {
  switch (mimeType.toLowerCase()) {
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/flac":
      return "flac";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/mp4":
    case "audio/m4a":
    case "audio/x-m4a":
    case "audio/aac":
    case "video/mp4":
      return "m4a";
    case "audio/ogg":
      return "ogg";
    default:
      return "";
  }
}

function inferArtworkExtension(mimeType: string, sourceUrl: string) {
  const normalizedMimeType = mimeType.toLowerCase().split(";", 1)[0];
  if (normalizedMimeType === "image/jpeg") return "jpg";
  if (normalizedMimeType === "image/png") return "png";
  if (normalizedMimeType === "image/webp") return "webp";
  if (normalizedMimeType === "image/gif") return "gif";
  const extension = sourceUrl.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i)?.[1]?.toLowerCase();
  return extension && ["jpg", "jpeg", "png", "webp", "gif"].includes(extension)
    ? extension === "jpeg" ? "jpg" : extension
    : "bin";
}
