import { useEffect, useRef, type MutableRefObject, type SetStateAction, type Dispatch } from "react";
import type { GuestSession, RoomSnapshot } from "@soqaro/shared";
import {
  getCachedLibraryTrack,
  getCachedLibraryTrackSummary
} from "@/features/library/indexeddb";
import { getLocalAudioCacheFile, getLocalAudioFile } from "@/features/library/local-audio-storage";
import type { CachedLibraryTrack, UploadedTrack } from "@/features/library/audio-utils";
import {
  applyOwnedUploadRehydrationResult,
  rehydrateOwnedUploadedTracksFromCache
} from "./upload-rehydration";
import {
  applyUploadRuntimePruneForActiveTracks,
  cleanupUploadRuntimeRefs,
  syncUploadedTrackObjectUrls
} from "./upload-runtime-cleanup";
import { persistRoomSnapshotToLocalRepository } from "@/features/library/local-room-storage";

type UploadRuntimeEffectsInput = {
  activeSession: GuestSession | null;
  cacheLibraryVersion: number;
  cacheLibraryTracksRef: MutableRefObject<Map<string, CachedLibraryTrack>>;
  inFlightUploadHashesRef?: MutableRefObject<Set<string>>;
  roomSnapshot: RoomSnapshot | null;
  roomCatalogKey: string;
  roomTrackIdsKey: string;
  setUploadedTracks: Dispatch<SetStateAction<Record<string, UploadedTrack>>>;
  uploadedTrackUrlsRef: MutableRefObject<Map<string, string>>;
  uploadedTracks: Record<string, UploadedTrack>;
};

export function useUploadRuntimeEffects({
  activeSession,
  cacheLibraryVersion,
  cacheLibraryTracksRef,
  inFlightUploadHashesRef,
  roomSnapshot,
  roomCatalogKey,
  roomTrackIdsKey,
  setUploadedTracks,
  uploadedTrackUrlsRef,
  uploadedTracks
}: UploadRuntimeEffectsInput) {
  const latestRoomSnapshotRef = useRef(roomSnapshot);
  latestRoomSnapshotRef.current = roomSnapshot;

  useEffect(() => {
    uploadedTrackUrlsRef.current = syncUploadedTrackObjectUrls({
      currentUrls: uploadedTrackUrlsRef.current,
      uploadedTracks,
      revokeObjectUrl: (objectUrl) => URL.revokeObjectURL(objectUrl)
    });
  }, [uploadedTrackUrlsRef, uploadedTracks]);

  useEffect(() => {
    if (!roomSnapshot?.room.id) {
      return;
    }
    const activeTrackIds = new Set(roomTrackIdsKey ? roomTrackIdsKey.split("|") : []);
    applyUploadRuntimePruneForActiveTracks({
      activeTrackIds,
      setUploadedTracks
    });

  }, [roomSnapshot?.room.id, roomTrackIdsKey, setUploadedTracks]);

  useEffect(() => {
    if (!roomSnapshot?.room.id || !activeSession) {
      return;
    }

    if (inFlightUploadHashesRef && inFlightUploadHashesRef.current.size > 0) {
      return;
    }

    const missingOwnedTracks = roomSnapshot.tracks.filter(
      (track) =>
        track.ownerSessionId === activeSession.userId &&
        !uploadedTracks[track.id]
    );
    if (missingOwnedTracks.length === 0) {
      return;
    }

    let cancelled = false;
    void (async () => {
      const result = await rehydrateOwnedUploadedTracksFromCache({
        missingOwnedTracks,
        cachedLibraryTracksByHash: cacheLibraryTracksRef.current,
        getCachedLibraryTrackSummary,
        getCachedLibraryTrack,
        getLocalAudioCacheFile,
        getLocalAudioFile
      });

      applyOwnedUploadRehydrationResult({
        cancelled,
        result,
        setUploadedTracks,
        revokeObjectUrl: (objectUrl) => URL.revokeObjectURL(objectUrl)
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeSession,
    cacheLibraryVersion,
    cacheLibraryTracksRef,
    inFlightUploadHashesRef,
    roomSnapshot?.room.id,
    roomSnapshot?.tracks,
    setUploadedTracks,
    uploadedTracks
  ]);

  useEffect(() => {
    const snapshot = latestRoomSnapshotRef.current;
    if (!snapshot?.room.id || !roomCatalogKey) {
      return;
    }

    void persistRoomSnapshotToLocalRepository(snapshot).catch(() => undefined);
  }, [roomCatalogKey]);

  useEffect(() => {
    return () => {
      cleanupUploadRuntimeRefs({
        uploadedTrackUrlsRef,
        cacheLibraryTracksRef,
        revokeObjectUrl: (objectUrl) => URL.revokeObjectURL(objectUrl)
      });
    };
  }, [cacheLibraryTracksRef, uploadedTrackUrlsRef]);
}
