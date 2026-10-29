import type {
  CachedLibraryTrackRecord,
  CachedLibraryTrackSummaryRecord
} from "@/features/library/indexeddb";
import type { TrackMeta } from "@soqaro/shared";
import type {
  CachedLibraryTrack,
  UploadedTrack
} from "@/features/library/audio-utils";
import { isCachedLibraryTrackUsableForRoomTrack } from "@/features/library/cached-library-track-policy";
import { toCachedLibraryFile } from "@/features/library/cache-library";

type UploadedTracksState = Record<string, UploadedTrack>;
type UploadedTracksStateSetter = (updater: (current: UploadedTracksState) => UploadedTracksState) => void;

type MissingOwnedRoomTrack = Pick<
  TrackMeta,
  "id" | "fileHash" | "sourceType"
> &
  Partial<Pick<TrackMeta, "durationMs" | "sizeBytes">>;

export async function rehydrateOwnedUploadedTracksFromCache(input: {
  missingOwnedTracks: MissingOwnedRoomTrack[];
  cachedLibraryTracksByHash: Map<string, CachedLibraryTrack>;
  getCachedLibraryTrackSummary: (
    fileHash: string
  ) => Promise<CachedLibraryTrackSummaryRecord | null | undefined>;
  getCachedLibraryTrack: (
    fileHash: string
  ) => Promise<CachedLibraryTrackRecord | null | undefined>;
  getLocalAudioCacheFile?: (fileHash: string) => Promise<File | null | undefined>;
  getLocalAudioFile?: (fileHash: string) => Promise<File | null | undefined>;
  createObjectUrl?: (file: File) => string;
}): Promise<{
  uploads: Record<string, UploadedTrack>;
  createdObjectUrls: string[];
}> {
  const uploads: Record<string, UploadedTrack> = {};
  const createdObjectUrls: string[] = [];

  for (const track of input.missingOwnedTracks) {
    const cachedSummary =
      input.cachedLibraryTracksByHash.get(track.fileHash) ??
      (await input.getCachedLibraryTrackSummary(track.fileHash));
    if (
      !isCachedLibraryTrackUsableForRoomTrack({
        cachedTrack: cachedSummary,
        roomTrack: track
      })
    ) {
      continue;
    }

    if (!input.createObjectUrl) {
      uploads[track.id] = {
        origin: track.sourceType === "netease"
          ? "netease-import"
          : track.sourceType === "local_upload"
            ? "live-upload"
            : track.sourceType === "bilibili"
              ? "bilibili-import"
              : "qqmusic-import"
      };
      continue;
    }

    const cachedRecord = await input.getCachedLibraryTrack(track.fileHash);
    const usableCachedRecord = isCachedLibraryTrackUsableForRoomTrack({
      cachedTrack: cachedRecord,
      roomTrack: track
    })
      ? cachedRecord
      : null;
    const cachedFile = usableCachedRecord
      ? toCachedLibraryFile({
          file: usableCachedRecord.file,
          title: usableCachedRecord.title,
          mimeType: usableCachedRecord.mimeType,
          fileHash: usableCachedRecord.fileHash
        })
      : await input.getLocalAudioCacheFile?.(track.fileHash) ??
        await input.getLocalAudioFile?.(track.fileHash);
    if (!cachedFile) {
      continue;
    }

    const objectUrl = input.createObjectUrl(cachedFile);
    createdObjectUrls.push(objectUrl);
    uploads[track.id] = {
      file: cachedFile,
      objectUrl,
      origin: track.sourceType === "netease"
        ? "netease-import"
        : track.sourceType === "local_upload"
          ? "live-upload"
          : "qqmusic-import"
    };
  }

  return {
    uploads,
    createdObjectUrls
  };
}

export function applyOwnedUploadRehydrationResult(input: {
  cancelled: boolean;
  result: {
    uploads: UploadedTracksState;
    createdObjectUrls: string[];
  };
  setUploadedTracks: UploadedTracksStateSetter;
  revokeObjectUrl: (objectUrl: string) => void;
}) {
  if (input.cancelled || Object.keys(input.result.uploads).length === 0) {
    for (const objectUrl of input.result.createdObjectUrls) {
      input.revokeObjectUrl(objectUrl);
    }
    return false;
  }

  input.setUploadedTracks((current) => {
    let changed = false;
    const next = { ...current };
    for (const [trackId, upload] of Object.entries(input.result.uploads)) {
      if (next[trackId]) {
        if (upload.objectUrl) {
          input.revokeObjectUrl(upload.objectUrl);
        }
        continue;
      }
      next[trackId] = upload;
      changed = true;
    }
    return changed ? next : current;
  });
  return true;
}
