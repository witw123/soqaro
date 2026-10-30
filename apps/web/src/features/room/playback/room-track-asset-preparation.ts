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
import type { AudioDecodeTaskPriority } from "@/features/library/audio-decode-queue";
import { appSettingsChangeEvent, getAppSettings } from "@/features/settings/settings-store";
import {
  extensionForImportedMimeType,
  resolveImportedAudioMimeType,
  sanitizeFileName
} from "@/features/upload/upload-import-helpers";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getRoomUpcomingPreparationTracks } from "./room-queue-preload";

export type TrackUnavailableReason = "source-missing" | "asset-corrupt" | "permission-denied";

const autoPreparationRetryCooldownMs = 60_000;
const maxAutoPreparationAttempts = 2;

const inFlightPreparations = new Map<string, Promise<TrackMeta | null>>();
const trackPreparationStates = new Map<string, RoomTrackDistributionState>();
const trackUnavailableReasons = new Map<string, TrackUnavailableReason>();
const autoPreparationFailures = new Map<string, { attempts: number; lastFailedAtMs: number }>();
const listeners = new Set<() => void>();
let preparationStoreRevision = 0;

function notifyListeners() {
  preparationStoreRevision += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Ignore listener errors
    }
  }
}

function recordAutoPreparationFailure(trackId: string, nowMs = Date.now()) {
  const previous = autoPreparationFailures.get(trackId);
  autoPreparationFailures.set(trackId, {
    attempts: (previous?.attempts ?? 0) + 1,
    lastFailedAtMs: nowMs
  });
}

function clearAutoPreparationFailure(trackId: string) {
  autoPreparationFailures.delete(trackId);
}

export function shouldSkipBackgroundAssetPreparation(trackId: string, nowMs = Date.now()): boolean {
  const failure = autoPreparationFailures.get(trackId);
  if (!failure) return false;
  if (failure.attempts >= maxAutoPreparationAttempts) return true;
  return nowMs - failure.lastFailedAtMs < autoPreparationRetryCooldownMs;
}

export function getNextAutoPreparationRetryDelayMs(
  trackIds: readonly string[],
  nowMs = Date.now()
): number | null {
  let minDelayMs: number | null = null;
  for (const trackId of trackIds) {
    const failure = autoPreparationFailures.get(trackId);
    if (!failure || failure.attempts >= maxAutoPreparationAttempts) continue;
    const remainingMs = autoPreparationRetryCooldownMs - (nowMs - failure.lastFailedAtMs);
    if (remainingMs > 0 && (minDelayMs === null || remainingMs < minDelayMs)) {
      minDelayMs = remainingMs;
    }
  }
  return minDelayMs;
}

export function pruneStaleTrackPreparationRecords(activeTrackIds: ReadonlySet<string>): void {
  let changed = false;
  for (const trackId of trackPreparationStates.keys()) {
    if (!activeTrackIds.has(trackId) && !inFlightPreparations.has(trackId)) {
      trackPreparationStates.delete(trackId);
      changed = true;
    }
  }
  for (const trackId of trackUnavailableReasons.keys()) {
    if (!activeTrackIds.has(trackId) && !inFlightPreparations.has(trackId)) {
      trackUnavailableReasons.delete(trackId);
      changed = true;
    }
  }
  for (const trackId of autoPreparationFailures.keys()) {
    if (!activeTrackIds.has(trackId) && !inFlightPreparations.has(trackId)) {
      autoPreparationFailures.delete(trackId);
    }
  }
  if (changed) {
    notifyListeners();
  }
}

export function resetTrackAssetPreparationStateForTests(): void {
  inFlightPreparations.clear();
  trackPreparationStates.clear();
  trackUnavailableReasons.clear();
  autoPreparationFailures.clear();
  notifyListeners();
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
    clearAutoPreparationFailure(trackId);
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
  signal?: AbortSignal,
  options?: { priority?: AudioDecodeTaskPriority }
): Promise<TrackMeta | null> {
  if (track.playbackAsset?.assetId) {
    const isIntact = await verifyPlaybackAssetIntegrity(track.playbackAsset.assetId);
    if (isIntact) {
      clearAutoPreparationFailure(track.id);
      trackPreparationStates.set(track.id, "ready");
      setTrackUnavailableReason(track.id, null);
      notifyListeners();
      return track;
    }
    recordAutoPreparationFailure(track.id);
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
        recordAutoPreparationFailure(track.id);
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
        signal,
        ...(options?.priority ? { priority: options.priority } : {})
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

      clearAutoPreparationFailure(track.id);
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
        recordAutoPreparationFailure(track.id);
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

    clearAutoPreparationFailure(track.id);
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

export function selectUpcomingTracksForAutoPreparation(input: {
  roomSnapshot: RoomSnapshot;
  activeSessionId: string;
  nowMs?: number;
}): TrackMeta[] {
  const { roomSnapshot, activeSessionId, nowMs = Date.now() } = input;
  const memberPresenceById = new Map(
    roomSnapshot.room.members.map((member) => [member.id, member.presenceState])
  );
  const candidates = getRoomUpcomingPreparationTracks(roomSnapshot);
  const selected: TrackMeta[] = [];
  let playableLookaheadCount = 0;
  let ownedAheadCount = 0;

  for (const track of candidates) {
    if (shouldSkipBackgroundAssetPreparation(track.id, nowMs)) {
      continue;
    }
    const ownerPresence = memberPresenceById.get(track.ownerSessionId);
    if (track.ownerSessionId !== activeSessionId && ownerPresence === "offline") {
      continue;
    }
    playableLookaheadCount += 1;
    const isOwnedByActiveMember = track.ownerSessionId === activeSessionId;
    if (isOwnedByActiveMember) {
      ownedAheadCount += 1;
    }
    const isReady = hasCompleteRoomAsset(track) || trackPreparationStates.get(track.id) === "ready";
    if (
      isOwnedByActiveMember &&
      !isReady &&
      (playableLookaheadCount <= 3 || ownedAheadCount <= 2)
    ) {
      selected.push(track);
      if (selected.length >= 3) {
        break;
      }
    }
  }

  return selected;
}

/**
 * React hook that automatically coordinates asset preparation for source members:
 * 1. Current track waiting for assets -> immediately prepared (high priority)
 * 2. Upcoming playable queue tracks -> sequentially prepared in background without
 *    stalling on failed or offline-owned items
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
  const [retryTick, setRetryTick] = useState(0);
  const storeRevision = useSyncExternalStore(
    subscribeTrackAssetPreparation,
    () => preparationStoreRevision,
    () => 0
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

  const upcomingTracks = roomSnapshot && activeSessionId && !streamingOnlyPlayback
    ? selectUpcomingTracksForAutoPreparation({
        roomSnapshot,
        activeSessionId
      })
    : [];
  const upcomingTracksRef = useRef(upcomingTracks);
  upcomingTracksRef.current = upcomingTracks;
  const upcomingPreparationKey = JSON.stringify(upcomingTracks.map((track) => [
    track.id, track.fileHash, track.originalAsset?.assetId, track.playbackAsset?.assetId
  ]));

  useEffect(() => {
    if (!roomSnapshot) return;
    pruneStaleTrackPreparationRecords(new Set(roomSnapshot.tracks.map((track) => track.id)));
  }, [roomSnapshot]);

  useEffect(() => {
    if (streamingOnlyPlayback || !roomSnapshot || !activeSessionId) return;
    const ownedCandidateIds = getRoomUpcomingPreparationTracks(roomSnapshot)
      .filter((track) => track.ownerSessionId === activeSessionId && !hasCompleteRoomAsset(track))
      .map((track) => track.id);
    const delayMs = getNextAutoPreparationRetryDelayMs(ownedCandidateIds);
    if (delayMs === null) return;
    const timer = window.setTimeout(() => {
      setRetryTick((tick) => tick + 1);
    }, delayMs + 50);
    return () => window.clearTimeout(timer);
  }, [roomSnapshot, activeSessionId, streamingOnlyPlayback, storeRevision, retryTick]);

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
          await ensureRoomTrackDistributionAsset(roomId, track, controller.signal, {
            priority: "low"
          });
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
