import Dexie, { type Table } from "dexie";
import {
  playbackEncoderVersion,
  playbackProfileId,
  type AssetKind,
  type AssetUnitDescriptor,
  type AudioAssetManifest,
  type TrackLoudness
} from "@soqaro/shared";

export type { AssetUnitDescriptor };

export type CachedLibraryTrackRecord = {
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
  file: Blob;
  cachedAt: string;
  sourceTrackIds: string[];
  sourceRoomIds: string[];
  lastSourceTrackId: string | null;
  lastSourceRoomId: string | null;
  lastOwnerNickname: string | null;
};

export type CachedLibraryTrackSummaryRecord = Omit<CachedLibraryTrackRecord, "file">;


export type AudioAssetManifestRecord = {
  assetId: string;
  kind: AssetKind;
  sourceFileHash: string;
  manifest: AudioAssetManifest;
  complete: boolean;
  createdAt: string;
  lastAccessedAt: string;
};

export type AudioAssetUnitRecord = AssetUnitDescriptor & {
  unitId: string;
  payload: ArrayBuffer;
  lastAccessedAt: string;
  protectedUntil: string | null;
};

export type PlaybackAssetDraftUnitRecord = {
  draftUnitId: string;
  draftId: string;
  unitIndex: number;
  descriptor: Omit<AssetUnitDescriptor, "assetId" | "contentHash" | "proof">;
  contentHash: string;
  payload: ArrayBuffer;
  createdAt: string;
};

export type TrackAssetLinkRecord = {
  trackId: string;
  originalAssetId: string;
  playbackAssetId: string;
  linkedAt: string;
};

export type TranscodeJobRecord = {
  sourceFileHash: string;
  kind: "original-reindex" | "playback-transcode";
  profileId: typeof playbackProfileId;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  errorMessage: string | null;
  updatedAt: string;
};

export type LocalAudioDirectoryRecord = {
  id: "default";
  kind: "selected" | "native";
  indexReady?: boolean;
  handle?: FileSystemDirectoryHandle;
  name: string;
  repositoryId?: string;
  schemaVersion?: number;
  updatedAt: string;
};

export type LocalPlaylistDirectoryRecord = {
  id: string;
  handle: FileSystemDirectoryHandle;
  name: string;
  updatedAt: string;
};

export type LocalAudioStorageKind = "cache" | "saved";

export type LocalAudioFileRecord = {
  fileHash: string;
  sizeBytes: number;
  fileName: string;
  lastModified?: number;
  relativePath?: string;
  storageKind?: LocalAudioStorageKind;
  source?: "directory-scan";
  sourceDirectoryId?: string;
  savedAt: string;
};

export type LocalAudioCacheFileRecord = {
  fileHash: string;
  fileName: string;
  relativePath?: string;
  sizeBytes?: number;
  cachedAt: string;
};

export type LocalPlaylistTrackRecord = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationMs: number;
  mimeType: string;
  sizeBytes: number;
  artworkUrl: string | null;
  lyrics: string | null;
  translatedLyrics?: string | null;
  romanizedLyrics?: string | null;
  loudness?: TrackLoudness;
  provider: "netease" | "qqmusic" | "bilibili" | "alist" | "local_upload";
  providerTrackId: string | null;
  fileHash: string | null;
  fileName: string | null;
  lastModified?: number;
  sourceDirectoryId?: string | null;
  availableOffline: boolean;
  source?: "directory-scan";
  createdAt: string;
  updatedAt: string;
};

export type FavoriteProviderAlbumRecord = {
  id: string;
  userId: string;
  provider: "netease" | "qqmusic";
  providerAlbumId: string;
  title: string;
  artist: string;
  artworkUrl: string | null;
  description: string | null;
  releaseTime: string | null;
  trackCount: number;
  createdAt: string;
  updatedAt: string;
};


export class SoqaroDatabase extends Dexie {
  cachedTrackLibrary!: Table<CachedLibraryTrackRecord, string>;
  cachedTrackLibraryMetadata!: Table<CachedLibraryTrackSummaryRecord, string>;
  assetManifests!: Table<AudioAssetManifestRecord, string>;
  assetUnits!: Table<AudioAssetUnitRecord, string>;
  playbackAssetDraftUnits!: Table<PlaybackAssetDraftUnitRecord, string>;
  trackAssetLinks!: Table<TrackAssetLinkRecord, string>;
  transcodeJobs!: Table<TranscodeJobRecord, string>;
  localAudioDirectory!: Table<LocalAudioDirectoryRecord, string>;
  localPlaylistDirectories!: Table<LocalPlaylistDirectoryRecord, string>;
  localAudioFiles!: Table<LocalAudioFileRecord, string>;
  localAudioCacheFiles!: Table<LocalAudioCacheFileRecord, string>;
  localPlaylistTracks!: Table<LocalPlaylistTrackRecord, string>;
  favoriteProviderAlbums!: Table<FavoriteProviderAlbumRecord, string>;

  constructor() {
    super("soqaro");
    this.version(2).stores({
      trackAssets: "&trackId, fileHash, cachedAt",
      trackPieces: "&pieceId, trackId, peerId, [trackId+peerId], createdAt"
    });
    this.version(3).stores({
      trackAssets: "&trackId, fileHash, cachedAt",
      trackPieces:
        "&pieceId, trackId, peerId, chunkIndex, [trackId+peerId], [trackId+peerId+chunkIndex], createdAt"
    });
    this.version(4).stores({
      trackAssets: "&trackId, fileHash, cachedAt",
      trackPieces:
        "&pieceId, trackId, peerId, chunkIndex, [trackId+peerId], [trackId+peerId+chunkIndex], createdAt",
      trackPieceManifests: "&trackId, fileHash, updatedAt"
    });
    this.version(5).stores({
      trackAssets: "&trackId, fileHash, cachedAt",
      trackPieces:
        "&pieceId, trackId, peerId, chunkIndex, [trackId+peerId], [trackId+peerId+chunkIndex], createdAt",
      trackPieceManifests: "&trackId, fileHash, updatedAt",
      cachedTrackLibrary: "&fileHash, cachedAt, *sourceTrackIds, *sourceRoomIds"
    });
    this.version(6)
      .stores({
        trackAssets: "&trackId, fileHash, cachedAt",
        trackPieces:
          "&pieceId, trackId, fileHash, peerId, ownerKey, chunkIndex, [trackId+peerId], [trackId+peerId+chunkIndex], [trackId+ownerKey], [trackId+ownerKey+chunkIndex], [fileHash+ownerKey], [fileHash+ownerKey+chunkIndex], createdAt",
        trackPieceManifests: "&trackId, fileHash, updatedAt",
        cachedTrackLibrary: "&fileHash, cachedAt, *sourceTrackIds, *sourceRoomIds",
        manualCacheTasks: "&taskKey, roomId, trackId, fileHash, status, updatedAt, [roomId+trackId]"
      })
      .upgrade(async (transaction) => {
        const pieces = transaction.table("trackPieces");
        await pieces.toCollection().modify((piece: Record<string, unknown>) => {
          piece.ownerKey ??= piece.peerId || "__local__";
          piece.fileHash ??= "";
        });
      });
    this.version(7)
      .stores({
        trackAssets: "&trackId, fileHash, cachedAt",
        trackPieces:
          "&pieceId, trackId, fileHash, peerId, ownerKey, chunkIndex, [trackId+peerId], [trackId+peerId+chunkIndex], [trackId+ownerKey], [trackId+ownerKey+chunkIndex], [fileHash+ownerKey], [fileHash+ownerKey+chunkIndex], createdAt",
        trackPieceManifests: "&trackId, fileHash, updatedAt",
        cachedTrackLibrary: "&fileHash, cachedAt, *sourceTrackIds, *sourceRoomIds",
        cachedTrackLibraryMetadata: "&fileHash, cachedAt, *sourceTrackIds, *sourceRoomIds",
        manualCacheTasks: "&taskKey, roomId, trackId, fileHash, status, updatedAt, [roomId+trackId]"
      })
      .upgrade(async (transaction) => {
        const library = transaction.table<CachedLibraryTrackRecord, string>("cachedTrackLibrary");
        const metadata = transaction.table<CachedLibraryTrackSummaryRecord, string>(
          "cachedTrackLibraryMetadata"
        );
        const summaries: CachedLibraryTrackSummaryRecord[] = [];
        await library.each((record) => {
          summaries.push(toCachedLibraryTrackSummaryRecord(record));
        });
        if (summaries.length > 0) {
          await metadata.bulkPut(summaries);
        }
      });
    this.version(8).stores({
      trackAssets: "&trackId, fileHash, cachedAt",
      trackPieces:
        "&pieceId, trackId, fileHash, peerId, ownerKey, chunkIndex, [trackId+peerId], [trackId+peerId+chunkIndex], [trackId+ownerKey], [trackId+ownerKey+chunkIndex], [fileHash+ownerKey], [fileHash+ownerKey+chunkIndex], createdAt",
      trackPieceManifests: "&trackId, fileHash, updatedAt",
      cachedTrackLibrary: "&fileHash, cachedAt, *sourceTrackIds, *sourceRoomIds",
      cachedTrackLibraryMetadata: "&fileHash, cachedAt, *sourceTrackIds, *sourceRoomIds",
      manualCacheTasks: "&taskKey, roomId, trackId, fileHash, status, updatedAt, [roomId+trackId]",
      cachedLibraryDeleteLeases: "&fileHash, leaseTrackId, requestedAt"
    });
    this.version(9)
      .stores({
        trackAssets: "&trackId, fileHash, cachedAt",
        trackPieces:
          "&pieceId, trackId, fileHash, peerId, ownerKey, chunkIndex, [trackId+peerId], [trackId+peerId+chunkIndex], [trackId+ownerKey], [trackId+ownerKey+chunkIndex], [fileHash+ownerKey], [fileHash+ownerKey+chunkIndex], createdAt",
        trackPieceManifests: "&trackId, fileHash, updatedAt",
        cachedTrackLibrary: "&fileHash, cachedAt, *sourceTrackIds, *sourceRoomIds",
        cachedTrackLibraryMetadata: "&fileHash, cachedAt, *sourceTrackIds, *sourceRoomIds",
        manualCacheTasks: "&taskKey, roomId, trackId, fileHash, status, updatedAt, [roomId+trackId]",
        cachedLibraryDeleteLeases: "&fileHash, leaseTrackId, requestedAt",
        assetManifests: "&assetId, kind, sourceFileHash, complete, lastAccessedAt",
        assetUnits: "&unitId, assetId, kind, unitIndex, [assetId+unitIndex], lastAccessedAt, protectedUntil",
        trackAssetLinks: "&trackId, originalAssetId, playbackAssetId, linkedAt",
        transcodeJobs: "&sourceFileHash, kind, status, updatedAt"
      })
      .upgrade(async (transaction) => {
        await Promise.all([
          transaction.table("trackAssets").clear(),
          transaction.table("trackPieces").clear(),
          transaction.table("trackPieceManifests").clear(),
          transaction.table("manualCacheTasks").clear(),
          transaction.table("cachedLibraryDeleteLeases").clear()
        ]);

        const library = transaction.table<CachedLibraryTrackRecord, string>("cachedTrackLibrary");
        const jobs = transaction.table<TranscodeJobRecord, string>("transcodeJobs");
        const now = new Date().toISOString();
        const queuedJobs: TranscodeJobRecord[] = [];
        await library.each((record) => {
          queuedJobs.push({
            sourceFileHash: record.fileHash,
            kind: "original-reindex",
            profileId: playbackProfileId,
            status: "queued",
            progress: 0,
            errorMessage: null,
            updatedAt: now
          });
        });
        if (queuedJobs.length > 0) {
          await jobs.bulkPut(queuedJobs);
        }
      });
    this.version(10).upgrade(async (transaction) => {
      const manifests = transaction.table<AudioAssetManifestRecord, string>("assetManifests");
      const units = transaction.table<AudioAssetUnitRecord, string>("assetUnits");
      const links = transaction.table<TrackAssetLinkRecord, string>("trackAssetLinks");
      const jobs = transaction.table<TranscodeJobRecord, string>("transcodeJobs");

      // IndexedDB has no runtime types, so old v1 records can still be present
      // while this migration runs even though the current model is v2-only.
      const obsoletePlaybackAssets = await manifests.filter((record) => {
        const manifest = record.manifest as { kind?: unknown; profileId?: unknown };
        return manifest.kind === "playback" && manifest.profileId !== playbackProfileId;
      }).toArray();
      const obsoleteAssetIds = obsoletePlaybackAssets.map((record) => record.assetId);

      if (obsoleteAssetIds.length > 0) {
        await Promise.all([
          units.where("assetId").anyOf(obsoleteAssetIds).delete(),
          links.where("playbackAssetId").anyOf(obsoleteAssetIds).delete(),
          manifests.bulkDelete(obsoleteAssetIds)
        ]);
      }
      await jobs.filter((job) =>
        (job as { profileId?: unknown }).profileId !== playbackProfileId
      ).delete();
    });
    this.version(11)
      .stores({
        cachedTrackLibrary: "&fileHash, cachedAt, *sourceTrackIds, *sourceRoomIds",
        cachedTrackLibraryMetadata: "&fileHash, cachedAt, *sourceTrackIds, *sourceRoomIds",
        assetManifests: "&assetId, kind, sourceFileHash, complete, lastAccessedAt",
        assetUnits: "&unitId, assetId, kind, unitIndex, [assetId+unitIndex], lastAccessedAt, protectedUntil",
        trackAssetLinks: "&trackId, originalAssetId, playbackAssetId, linkedAt",
        transcodeJobs: "&sourceFileHash, kind, status, updatedAt"
      })
      .upgrade(async (transaction) => {
        // Remove every pre-v11 room-transfer cache. Only upload-owned library
        // files and locally built audio assets survive this migration.
        await Promise.all([
          transaction.table("trackAssets").clear(),
          transaction.table("trackPieces").clear(),
          transaction.table("trackPieceManifests").clear(),
          transaction.table("manualCacheTasks").clear(),
          transaction.table("cachedLibraryDeleteLeases").clear()
        ]);
      });
    this.version(12).stores({
      // Remove the old room-transfer stores instead of leaving empty tables
      // behind in existing browser databases.
      trackAssets: null,
      trackPieces: null,
      trackPieceManifests: null,
      manualCacheTasks: null,
      cachedLibraryDeleteLeases: null,
      cachedTrackLibrary: "&fileHash, cachedAt, *sourceTrackIds, *sourceRoomIds",
      cachedTrackLibraryMetadata: "&fileHash, cachedAt, *sourceTrackIds, *sourceRoomIds",
      assetManifests: "&assetId, kind, sourceFileHash, complete, lastAccessedAt",
      assetUnits: "&unitId, assetId, kind, unitIndex, [assetId+unitIndex], lastAccessedAt, protectedUntil",
      trackAssetLinks: "&trackId, originalAssetId, playbackAssetId, linkedAt",
      transcodeJobs: "&sourceFileHash, kind, status, updatedAt"
    });
    this.version(13).stores({
      cachedTrackLibrary: "&fileHash, cachedAt, *sourceTrackIds, *sourceRoomIds",
      cachedTrackLibraryMetadata: "&fileHash, cachedAt, *sourceTrackIds, *sourceRoomIds",
      assetManifests: "&assetId, kind, sourceFileHash, complete, lastAccessedAt",
      assetUnits: "&unitId, assetId, kind, unitIndex, [assetId+unitIndex], lastAccessedAt, protectedUntil",
      trackAssetLinks: "&trackId, originalAssetId, playbackAssetId, linkedAt",
      transcodeJobs: "&sourceFileHash, kind, status, updatedAt",
      localAudioDirectory: "&id",
      localAudioFiles: "&fileHash, savedAt"
    });
    this.version(14).stores({
      cachedTrackLibrary: "&fileHash, cachedAt, *sourceTrackIds, *sourceRoomIds",
      cachedTrackLibraryMetadata: "&fileHash, cachedAt, *sourceTrackIds, *sourceRoomIds",
      assetManifests: "&assetId, kind, sourceFileHash, complete, lastAccessedAt",
      assetUnits: "&unitId, assetId, kind, unitIndex, [assetId+unitIndex], lastAccessedAt, protectedUntil",
      trackAssetLinks: "&trackId, originalAssetId, playbackAssetId, linkedAt",
      transcodeJobs: "&sourceFileHash, kind, status, updatedAt",
      localAudioDirectory: "&id",
      localAudioFiles: "&fileHash, savedAt",
      localAudioCacheFiles: "&fileHash, cachedAt"
    });
    this.version(15).stores({
      localPlaylistTracks: "&id, provider, providerTrackId, fileHash, updatedAt"
    });
    this.version(16).stores({
      localPlaylistDirectories: "&id, name, updatedAt"
    });
    this.version(17).stores({
      favoriteProviderAlbums: "&id, userId, provider, providerAlbumId, updatedAt"
    });
    this.version(18).upgrade(async (transaction) => {
      const manifests = transaction.table<AudioAssetManifestRecord, string>("assetManifests");
      const units = transaction.table<AudioAssetUnitRecord, string>("assetUnits");
      const links = transaction.table<TrackAssetLinkRecord, string>("trackAssetLinks");
      const jobs = transaction.table<TranscodeJobRecord, string>("transcodeJobs");
      const obsoletePlaybackAssets = await manifests.filter((record) => {
        const manifest = record.manifest as {
          kind?: unknown;
          profileId?: unknown;
          encoder?: { version?: unknown };
        };
        return manifest.kind === "playback" && (
          manifest.profileId !== playbackProfileId ||
          manifest.encoder?.version !== playbackEncoderVersion
        );
      }).toArray();
      const obsoleteAssetIds = obsoletePlaybackAssets.map((record) => record.assetId);

      if (obsoleteAssetIds.length > 0) {
        await Promise.all([
          units.where("assetId").anyOf(obsoleteAssetIds).delete(),
          links.where("playbackAssetId").anyOf(obsoleteAssetIds).delete(),
          manifests.bulkDelete(obsoleteAssetIds)
        ]);
      }
      await jobs.filter((job) =>
        (job as { profileId?: unknown }).profileId !== playbackProfileId
      ).delete();
    });
    this.version(19).stores({
      playbackAssetDraftUnits: "&draftUnitId, draftId, unitIndex, [draftId+unitIndex]"
    });
    this.version(20).stores({
      recommendationEvents: "&id, userId, candidateKey, artistKey, occurredAt, [userId+occurredAt]"
    });
    this.version(21).stores({ recommendationEvents: null });
    this.version(22).stores({
      cachedTrackLibraryMetadata:
        "&fileHash, cachedAt, [provider+providerTrackId], *sourceTrackIds, *sourceRoomIds"
    });
  }
}
export const soqaroDatabase = new SoqaroDatabase();


export function assetUnitId(assetId: string, unitIndex: number) {
  if (!assetId || !Number.isInteger(unitIndex) || unitIndex < 0) {
    throw new TypeError("A valid asset id and non-negative unit index are required.");
  }
  return `${assetId}:${unitIndex}`;
}



export function toCachedLibraryTrackSummaryRecord(
  record: CachedLibraryTrackRecord
): CachedLibraryTrackSummaryRecord {
  const {
    file: _file,
    ...summary
  } = record;
  return summary;
}


export async function backfillCachedLibraryTrackMetadataIfNeeded() {
  const metadataCount = await soqaroDatabase.cachedTrackLibraryMetadata.count();
  if (metadataCount > 0) {
    return;
  }

  const libraryCount = await soqaroDatabase.cachedTrackLibrary.count();
  if (libraryCount === 0) {
    return;
  }

  const summaries: CachedLibraryTrackSummaryRecord[] = [];
  await soqaroDatabase.cachedTrackLibrary.each((record) => {
    summaries.push(toCachedLibraryTrackSummaryRecord(record));
  });
  if (summaries.length > 0) {
    await soqaroDatabase.cachedTrackLibraryMetadata.bulkPut(summaries);
  }
}
