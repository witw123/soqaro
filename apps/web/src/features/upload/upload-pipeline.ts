import type { TrackMeta } from "@soqaro/shared";
import type { UploadedTrack } from "@/features/library/audio-utils";

type TrackRegistrationDraft = Omit<TrackMeta, "id"> & {
  id?: string;
  lyrics?: string | null;
};

// The room API accepts artwork URLs up to 4096 characters. Provider artwork
// is also kept locally as a data URL, which can be much larger than that
// limit, so never send an oversized local representation to the server.
const maxRegisterArtworkUrlLength = 4096;

export function buildRegisterTrackPayload(track: Omit<TrackMeta, "id"> & { id?: string }) {
  const artworkUrl = track.artworkUrl?.trim() || null;
  return {
    ...(track.id ? { id: track.id } : {}),
    title: track.title,
    artist: track.artist,
    album: track.album,
    lyrics: track.lyrics ?? null,
    translatedLyrics: track.translatedLyrics ?? null,
    romanizedLyrics: track.romanizedLyrics ?? null,
    durationMs: track.durationMs,
    bitrate: track.bitrate,
    sizeBytes: track.sizeBytes,
    codec: track.codec,
    mimeType: track.mimeType,
    fileHash: track.fileHash,
    artworkUrl: artworkUrl && artworkUrl.length <= maxRegisterArtworkUrlLength
      ? artworkUrl
      : null,
    ownerSessionId: track.ownerSessionId,
    ownerNickname: track.ownerNickname,
    sourceType: track.sourceType,
    ...(track.sourceRef ? { sourceRef: track.sourceRef } : {}),
    ...(track.loudness ? { loudness: track.loudness } : {}),
    originalAsset: track.originalAsset,
    playbackAsset: track.playbackAsset
  };
}

export function buildCachedLibraryTrackRegisterPayload(
  track: Omit<TrackMeta, "id"> & { id?: string }
) {
  return buildRegisterTrackPayload(track);
}

export async function processSelectedTrackFiles(input: {
  files: File[];
  activeSession: { userId: string; nickname: string } | null;
  roomId: string | null | undefined;
  roomTracks: TrackMeta[];
  inFlightUploadHashes: Set<string>;
  createObjectUrl: (file: File) => string;
  revokeObjectUrl: (objectUrl: string) => void;
  buildTrackMeta: (file: File, objectUrl: string) => Promise<TrackRegistrationDraft>;
  buildRegisterTrackPayload: (track: TrackRegistrationDraft) => unknown;
  registerTrack: (roomId: string, payload: unknown) => Promise<TrackMeta>;
  persistTrackIntoLibrary: (input: {
    track: TrackMeta;
    roomId: string;
    file: File;
    lyrics?: string | null;
  }) => Promise<void>;
  deleteTrack?: (roomId: string, trackId: string) => Promise<unknown>;
  deleteLocalTrackData?: (trackIds: readonly string[]) => Promise<void>;
  signal?: AbortSignal;
  onTrackStart?: (file: File, index: number, total: number) => void;
  onTrackReady?: (trackId: string, upload: UploadedTrack, track: TrackMeta) => Promise<void> | void;
}) {
  const uploads: Record<string, UploadedTrack> = {};
  const registeredTracks: TrackMeta[] = [];
  if (!input.activeSession || !input.roomId) {
    return {
      uploads,
      registeredTracks,
      importedCount: 0
    };
  }

  const currentTracksByHash = new Map(
    input.roomTracks
      .filter((track) => track.ownerSessionId === input.activeSession?.userId)
      .map((track) => [track.fileHash, track] as const)
  );

  for (let fileIndex = 0; fileIndex < input.files.length; fileIndex++) {
    if (input.signal?.aborted) {
      break;
    }
    const file = input.files[fileIndex];
    input.onTrackStart?.(file, fileIndex, input.files.length);
    const objectUrl = input.createObjectUrl(file);
    let objectUrlRevoked = false;
    // Cheap file-identity marker claimed before the expensive decode/encode:
    // two concurrent imports of the same file (double submit, cached-library
    // refresh racing a manual pick) must not both run through buildTrackMeta
    // and race past the content-hash check below.
    const fileIdentityKey = `${input.activeSession.userId}:file:${file.name}:${file.size}:${file.lastModified}`;
    let claimedFileSlot = false;
    try {
      if (input.inFlightUploadHashes.has(fileIdentityKey)) {
        continue;
      }
      input.inFlightUploadHashes.add(fileIdentityKey);
      claimedFileSlot = true;

      const track = await input.buildTrackMeta(file, objectUrl);
      input.revokeObjectUrl(objectUrl);
      objectUrlRevoked = true;
      const uploadHashKey = `${input.activeSession.userId}:${track.fileHash}`;

      if (input.inFlightUploadHashes.has(uploadHashKey)) {
        continue;
      }

      const existingTrack = currentTracksByHash.get(track.fileHash);
      if (existingTrack) {
        continue;
      }

      input.inFlightUploadHashes.add(uploadHashKey);
      let registered: TrackMeta;
      try {
        registered = await input.registerTrack(
          input.roomId,
          input.buildRegisterTrackPayload(track)
        );
      } finally {
        input.inFlightUploadHashes.delete(uploadHashKey);
      }

      const upload = {
        origin: "live-upload"
      } satisfies UploadedTrack;
      try {
        await input.persistTrackIntoLibrary({
          // Keep the server's normalized metadata while retaining an
          // embedded/local cover for the browser cache and local repository.
          track: {
            ...registered,
            artworkUrl: track.artworkUrl ?? registered.artworkUrl
          },
          roomId: input.roomId,
          file,
          lyrics: track.lyrics ?? null
        });
      } catch (error) {
        await Promise.allSettled([
          input.deleteTrack?.(input.roomId, registered.id),
          input.deleteLocalTrackData?.([registered.id])
        ]);
        throw error;
      }
      uploads[registered.id] = upload;
      await input.onTrackReady?.(registered.id, upload, registered);
      registeredTracks.push(registered);
      currentTracksByHash.set(registered.fileHash, registered);
    } finally {
      if (claimedFileSlot) {
        input.inFlightUploadHashes.delete(fileIdentityKey);
      }
      if (!objectUrlRevoked) {
        input.revokeObjectUrl(objectUrl);
      }
    }
  }

  return {
    uploads,
    registeredTracks,
    importedCount: Object.keys(uploads).length
  };
}

export async function applySelectedTrackFilesResult(input: {
  roomId: string;
  result: {
    uploads: Record<string, UploadedTrack>;
    registeredTracks: TrackMeta[];
    importedCount: number;
  };
  setUploadedTracks: (
    updater: (current: Record<string, UploadedTrack>) => Record<string, UploadedTrack>
  ) => void;
  syncRoomSnapshot: (roomId: string) => Promise<void>;
  setStatusMessage: (message: string) => void;
}) {
  input.setUploadedTracks((current) => ({
    ...current,
    ...input.result.uploads
  }));
  if (input.result.registeredTracks.length > 0) {
    await input.syncRoomSnapshot(input.roomId);
  }
  input.setStatusMessage(`${input.result.importedCount} 首本地歌曲已导入房间曲库。`);
}
