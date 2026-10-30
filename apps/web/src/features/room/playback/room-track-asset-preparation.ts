import {
  hasCompleteRoomAsset,
  type RoomSnapshot,
  type RoomTrackDistributionState,
  type TrackMeta
} from "@soqaro/shared";
import { soqaroApi } from "@/lib/network/soqaro-api";
import { getRoomLocalAudioFile, hasDirectoryReadPermission } from "@/features/library/local-audio-storage";
import {
  getCachedLibraryTrack,
  getCachedLibraryTrackByProviderTrack,
  getAssetManifest,
  getLocalAudioDirectory,
  linkTrackAssets,
  soqaroDatabase
} from "@/features/library/indexeddb";
import { notifyCacheLibraryChanged, toCachedLibraryFile } from "@/features/library/cache-library";
import { prepareAudioAssets } from "@/features/library/audio-asset-builder";
import { appSettingsChangeEvent, getAppSettings } from "@/features/settings/settings-store";
import {
  extensionForImportedMimeType,
  resolveImportedAudioMimeType,
  sanitizeFileName
} from "@/features/upload/upload-import-helpers";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getRoomQueuePreloadTracks } from "./room-queue-preload";

export type TrackUnavailableReason = "source-missing" | "asset-corrupt" | "permission-denied";

const inFlightPreparations = new Map<string, Promise<TrackMeta | null>>();
const trackPreparationStates = new Map<string, RoomTrackDistributionState>();
const trackUnavailableReasons = new Map<string, TrackUnavailableReason>();
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Ignore listener errors
    }
  }
}

export function getTrackAssetPreparationState(trackId: string): RoomTrackDistributionState | null {
  return trackPreparationStates.get(trackId) ?? null;
}

export function setTrackAssetPreparationState(trackId: string, state: RoomTrackDistributionState): void {
  trackPreparationStates.set(trackId, state);
  notifyListeners();
}

export function getTrackUnavailableReason(trackId: string): TrackUnavailableReason | null {
  return trackUnavailableReasons.get(trackId) ?? null;
}

export function setTrackUnavailableReason(trackId: string, reason: TrackUnavailableReason | null): void {
  if (reason) {
    trackUnavailableReasons.set(trackId, reason);
  } else {
    trackUnavailableReasons.delete(trackId);
  }
  notifyListeners();
}

export function subscribeTrackAssetPreparation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTrackAssetPreparationState(trackId: string | null | undefined): RoomTrackDistributionState | null {
  return useSyncExternalStore(
    subscribeTrackAssetPreparation,
    () => (trackId ? trackPreparationStates.get(trackId) ?? null : null),
    () => null
  );
}

export function useTrackUnavailableReason(trackId: string | null | undefined): TrackUnavailableReason | null {
  return useSyncExternalStore(
    subscribeTrackAssetPreparation,
    () => (trackId ? trackUnavailableReasons.get(trackId) ?? null : null),
    () => null
  );
}

/**
 * Verifies that all audio segments for the specified playback asset exist in IndexedDB.
 */
export async function verifyPlaybackAssetIntegrity(playbackAssetId: string | null | undefined): Promise<boolean> {
  if (!playbackAssetId) return false;
  try {
    const manifestRecord = await getAssetManifest(playbackAssetId);
    if (!manifestRecord) return false;
    if (manifestRecord.complete) return true;
    const count = await soqaroDatabase.assetUnits.where("assetId").equals(playbackAssetId).count();
    return count >= manifestRecord.manifest.unitCount;
  } catch {
    return false;
  }
}

/**
 * Resolves an audio File for the given track according to the strict priority:
 * 1. Local saved songs / local directory cache
 * 2. Local IndexedDB browser cache
 * 3. Third-party provider download
 */
export async function resolveTrackAudioFile(
  track: TrackMeta,
  signal?: AbortSignal
): Promise<File | null> {
  signal?.throwIfAborted();

  // 1. Local saved file or directory cache
  const localFile = await getRoomLocalAudioFile({
    trackId: track.id,
    fileHash: track.fileHash,
    title: track.title,
    mimeType: track.mimeType ?? "audio/mpeg",
    originalAssetId: track.originalAsset?.assetId,
    provider: track.sourceType !== "local_upload" ? track.sourceType : undefined,
    providerTrackId: track.sourceRef?.trackId
  }).catch(() => null);

  if (localFile) {
    if (localFile instanceof File) {
      return localFile;
    }
    const ext = extensionForImportedMimeType(localFile.type || track.mimeType || "audio/mpeg");
    return new File(
      [localFile],
      `${sanitizeFileName(track.title, track.sourceType)}.${ext}`,
      { type: localFile.type || track.mimeType || "audio/mpeg" }
    );
  }

  signal?.throwIfAborted();

  // 2. IndexedDB browser cache
  if (track.sourceType !== "local_upload" && track.sourceRef?.trackId) {
    const providerCache = await getCachedLibraryTrackByProviderTrack(
      track.sourceType,
      track.sourceRef.trackId
    ).catch(() => null);
    if (providerCache?.file) {
      const cachedFile = toCachedLibraryFile({
        file: providerCache.file,
        title: track.title,
        mimeType: providerCache.mimeType,
        fileHash: providerCache.fileHash
      });
      return new File([cachedFile], cachedFile.name, {
        type: await resolveImportedAudioMimeType(cachedFile)
      });
    }
  }

  const browserCache = await getCachedLibraryTrack(track.fileHash).catch(() => null);
  if (browserCache?.file) {
    const cachedFile = toCachedLibraryFile({
      file: browserCache.file,
      title: track.title,
      mimeType: browserCache.mimeType,
      fileHash: browserCache.fileHash
    });
    return new File([cachedFile], cachedFile.name, {
      type: await resolveImportedAudioMimeType(cachedFile)
    });
  }

  signal?.throwIfAborted();

  // 3. Third-party provider download
  if (track.sourceType !== "local_upload" && track.sourceRef?.trackId) {
    const preferredQuality = getAppSettings().playback.preferredAudioQuality;
    const download = track.sourceType === "netease"
      ? await soqaroApi.downloadNeteaseTrack(track.sourceRef.trackId, preferredQuality, signal)
      : track.sourceType === "qqmusic"
        ? await soqaroApi.downloadQqMusicTrack(track.sourceRef.trackId, preferredQuality, signal)
        : track.sourceType === "bilibili"
          ? await soqaroApi.downloadBilibiliTrack(track.sourceRef.trackId, signal)
          : null;

    if (download?.blob) {
      const mimeType = download.contentType || download.blob.type || "audio/mpeg";
      const ext = extensionForImportedMimeType(mimeType);
      return new File(
        [download.blob],
        `${sanitizeFileName(track.title, track.sourceType)}.${ext}`,
        { type: mimeType }
      );
    }
  }

  return null;
}

/**
 * Ensures the track has complete room distribution assets on the server.
 * Handles concurrency, audio acquisition, Opus transcoding, IndexedDB persistence,
 * and server registration.
 */
export async function ensureRoomTrackDistributionAsset(
  roomId: string,
  track: TrackMeta,
  signal?: AbortSignal
): Promise<TrackMeta | null> {
  if (track.playbackAsset?.assetId) {
    const isIntact = await verifyPlaybackAssetIntegrity(track.playbackAsset.assetId);
    if (isIntact) {
      trackPreparationStates.set(track.id, "ready");
      setTrackUnavailableReason(track.id, null);
      notifyListeners();
      return track;
    }
    trackPreparationStates.set(track.id, "failed");
    setTrackUnavailableReason(track.id, "asset-corrupt");
    notifyListeners();
    void soqaroApi.reportTrackAssetUnavailable(roomId, track.id, {
      trackId: track.id,
      reason: "asset-corrupt"
    }).catch(() => undefined);
    return null;
  }

  const inFlight = inFlightPreparations.get(track.id);
  if (inFlight) {
    return inFlight;
  }

  const preparationPromise = (async () => {
    trackPreparationStates.set(track.id, "preparing");
    notifyListeners();

    try {
      signal?.throwIfAborted();

      // Retrieve audio source
      const file = await resolveTrackAudioFile(track, signal);
      if (!file) {
        let reason: TrackUnavailableReason = "source-missing";
        if (track.sourceType === "local_upload") {
          try {
            const dir = await getLocalAudioDirectory();
            if (dir && !(await hasDirectoryReadPermission(dir.handle))) {
              reason = "permission-denied";
            }
          } catch {
            // ignore
          }
        }
        trackPreparationStates.set(track.id, reason === "source-missing" ? "source-missing" : "failed");
        setTrackUnavailableReason(track.id, reason);
        notifyListeners();
        void soqaroApi.reportTrackAssetUnavailable(roomId, track.id, {
          trackId: track.id,
          reason
        }).catch(() => undefined);
        return null;
      }

      signal?.throwIfAborted();

      // Transcode and prepare assets (computes genuine fileHash and writes to IndexedDB)
      const assets = await prepareAudioAssets({
        file,
        signal
      });

      signal?.throwIfAborted();

      // Register asset with the room server
      const updatedTrack = await soqaroApi.prepareTrackAsset(roomId, track.id, {
        trackId: track.id,
        fileHash: assets.fileHash,
        originalAsset: assets.originalAsset,
        playbackAsset: assets.playbackAsset
      });

      // Link assets locally for fast retrieval
      await linkTrackAssets({
        trackId: track.id,
        originalAssetId: assets.originalAsset.assetId,
        playbackAssetId: assets.playbackAsset.assetId
      }).catch(() => undefined);
      notifyCacheLibraryChanged();

      trackPreparationStates.set(track.id, "ready");
      setTrackUnavailableReason(track.id, null);
      notifyListeners();

      return updatedTrack;
    } catch (error) {
      if (signal?.aborted) {
        trackPreparationStates.delete(track.id);
      } else {
        let reason: TrackUnavailableReason = "asset-corrupt";
        if (
          error instanceof DOMException &&
          (error.name === "NotAllowedError" || error.name === "SecurityError")
        ) {
          reason = "permission-denied";
        }
        trackPreparationStates.set(track.id, "failed");
        setTrackUnavailableReason(track.id, reason);
        void soqaroApi.reportTrackAssetUnavailable(roomId, track.id, {
          trackId: track.id,
          reason
        }).catch(() => undefined);
      }
      notifyListeners();
      throw error;
    } finally {
      inFlightPreparations.delete(track.id);
    }
  })();

  inFlightPreparations.set(track.id, preparationPromise);
  return preparationPromise;
}

/**
 * Manually prepares a track using a user-selected local file.
 * Used when recovering from source-missing, permission-denied, or asset corruption.
 */
export async function prepareTrackWithLocalFile(
  roomId: string,
  track: TrackMeta,
  file: File,
  signal?: AbortSignal
): Promise<TrackMeta | null> {
  trackPreparationStates.set(track.id, "preparing");
  setTrackUnavailableReason(track.id, null);
  notifyListeners();

  try {
    signal?.throwIfAborted();
    const assets = await prepareAudioAssets({
      file,
      signal
    });

    signal?.throwIfAborted();
    const updatedTrack = await soqaroApi.prepareTrackAsset(roomId, track.id, {
      trackId: track.id,
      fileHash: assets.fileHash,
      originalAsset: assets.originalAsset,
      playbackAsset: assets.playbackAsset
    });

    await linkTrackAssets({
      trackId: track.id,
      originalAssetId: assets.originalAsset.assetId,
      playbackAssetId: assets.playbackAsset.assetId
    }).catch(() => undefined);
    notifyCacheLibraryChanged();

    trackPreparationStates.set(track.id, "ready");
    setTrackUnavailableReason(track.id, null);
    notifyListeners();

    return updatedTrack;
  } catch (error) {
    trackPreparationStates.set(track.id, "failed");
    setTrackUnavailableReason(track.id, "asset-corrupt");
    notifyListeners();
    throw error;
  }
}

/**
 * React hook that automatically coordinates asset preparation for source members:
 * 1. Current track waiting for assets -> immediately prepared (high priority)
 * 2. Next 2 queue tracks -> sequentially prepared in background (background priority)
 */
export function useRoomTrackAssetAutoPreparation(input: {
  roomId: string | null | undefined;
  roomSnapshot: RoomSnapshot | null | undefined;
  currentTrack: TrackMeta | null | undefined;
  activeSessionId: string | null | undefined;
}) {
  const { roomId, roomSnapshot, currentTrack, activeSessionId } = input;
  const [streamingOnlyPlayback, setStreamingOnlyPlayback] = useState(
    () => Boolean(getAppSettings().playback.streamingOnlyPlayback)
  );

  useEffect(() => {
    const syncSetting = () => {
      setStreamingOnlyPlayback(Boolean(getAppSettings().playback.streamingOnlyPlayback));
    };
    const changeEvent = appSettingsChangeEvent ?? "soqaro-settings-change";
    window.addEventListener(changeEvent, syncSetting);
    window.addEventListener("storage", syncSetting);
    return () => {
      window.removeEventListener(changeEvent, syncSetting);
      window.removeEventListener("storage", syncSetting);
    };
  }, []);

  const upcomingTracks = roomSnapshot && !streamingOnlyPlayback
    ? getRoomQueuePreloadTracks(roomSnapshot).filter((track) =>
        track.ownerSessionId === activeSessionId && !hasCompleteRoomAsset(track))
    : [];
  const upcomingTracksRef = useRef(upcomingTracks);
  upcomingTracksRef.current = upcomingTracks;
  const upcomingPreparationKey = JSON.stringify(upcomingTracks.map((track) => [
    track.id, track.fileHash, track.originalAsset?.assetId, track.playbackAsset?.assetId
  ]));

  // 1. Current track auto-preparation (high priority)
  useEffect(() => {
    if (streamingOnlyPlayback) return;
    if (!roomId || !activeSessionId || !currentTrack) return;
    if (currentTrack.ownerSessionId !== activeSessionId) return;
    if (hasCompleteRoomAsset(currentTrack)) return;

    const controller = new AbortController();
    void ensureRoomTrackDistributionAsset(roomId, currentTrack, controller.signal).catch((err) => {
      if (!controller.signal.aborted) {
        console.warn(`[AssetPreparation] Failed to prepare current track "${currentTrack.title}":`, err);
      }
    });

    return () => {
      controller.abort();
    };
  }, [roomId, activeSessionId, currentTrack, streamingOnlyPlayback]);

  // 2. Upcoming queue tracks auto-preparation (background priority)
  useEffect(() => {
    if (streamingOnlyPlayback) return;
    if (!roomId || !activeSessionId) return;
    const upcomingTracksToPrepare = upcomingTracksRef.current;

    if (upcomingTracksToPrepare.length === 0) return;

    const controller = new AbortController();
    void (async () => {
      for (const track of upcomingTracksToPrepare) {
        if (controller.signal.aborted) break;
        try {
          await ensureRoomTrackDistributionAsset(roomId, track, controller.signal);
        } catch (err) {
          if (!controller.signal.aborted) {
            console.warn(`[AssetPreparation] Background preparation failed for "${track.title}":`, err);
          }
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [
    roomId,
    activeSessionId,
    upcomingPreparationKey,
    streamingOnlyPlayback
  ]);
}
