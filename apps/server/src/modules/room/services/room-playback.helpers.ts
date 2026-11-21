import {
  hasCompleteRoomAsset,
  isProviderTrackMeta,
  type GaplessTransition,
  type PlaybackSnapshot,
  type TrackMeta
} from "@soqaro/shared";
import type { RoomRecord } from "../room.types";

export type SourceCandidate = {
  sessionId: string;
  peerId: string | null;
};

export function isProviderTrack(track: TrackMeta | undefined): track is TrackMeta & {
  sourceType: Exclude<TrackMeta["sourceType"], "local_upload">;
  sourceRef: NonNullable<TrackMeta["sourceRef"]>;
} {
  return isProviderTrackMeta(track);
}

export function clampPositionMs(record: RoomRecord, trackId: string | null, positionMs: number): number {
  const normalized = Math.max(0, Math.floor(positionMs));
  if (!trackId) {
    return normalized;
  }

  const track = record.tracks.find((item) => item.id === trackId);
  if (!track?.durationMs || track.durationMs <= 0) {
    return normalized;
  }

  return Math.min(normalized, track.durationMs);
}

export function getTrackDurationMs(record: RoomRecord, trackId: string | null): number {
  if (!trackId) {
    return 0;
  }
  const track = record.tracks.find((item) => item.id === trackId);
  return track?.durationMs && track.durationMs > 0 ? track.durationMs : 0;
}

export function getEffectivePlaybackPositionMs(record: RoomRecord, playback: PlaybackSnapshot): number {
  const anchor = playback.startedAt ?? playback.startAt;
  if (
    playback.status !== "playing" ||
    !playback.currentTrackId ||
    !anchor
  ) {
    return clampPositionMs(record, playback.currentTrackId, playback.positionMs);
  }

  const startedAtMs = new Date(anchor).getTime();
  if (!Number.isFinite(startedAtMs)) {
    return clampPositionMs(record, playback.currentTrackId, playback.positionMs);
  }

  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  return clampPositionMs(record, playback.currentTrackId, playback.positionMs + elapsedMs);
}

export function getCurrentQueueIndex(record: RoomRecord): number {
  const currentQueueItemId = record.room.playback.currentQueueItemId;
  if (currentQueueItemId) {
    const byQueueItemId = record.queue.findIndex((item) => item.id === currentQueueItemId);
    if (byQueueItemId >= 0) {
      return byQueueItemId;
    }
  }

  const currentTrackId = record.room.playback.currentTrackId;
  if (!currentTrackId) {
    return -1;
  }

  return record.queue.findIndex((item) => item.trackId === currentTrackId);
}

export function getGaplessTransitionAt(record: RoomRecord): number | null {
  const playback = record.room.playback;
  if (
    playback.status !== "playing" ||
    playback.playbackMode !== "sequence" ||
    !playback.currentTrackId ||
    !playback.startAt ||
    !playback.sourceSessionId ||
    playback.nextQueueItemId
  ) {
    return null;
  }

  const currentDurationMs = getTrackDurationMs(record, playback.currentTrackId);
  const startAtMs = Date.parse(playback.startAt);
  if (currentDurationMs <= 0 || !Number.isFinite(startAtMs)) {
    return null;
  }

  return startAtMs + Math.max(0, currentDurationMs - playback.positionMs);
}

/**
 * Pure, mutation-free predicate for the playback watchdog: returns true when
 * the current track has finished or a gapless transition is due. Mirrors the
 * conditions checked by RoomPlaybackService.advanceIfTrackEnded /
 * advanceGaplessIfDue so the watchdog can skip rooms that need no work
 * without paying for a full record re-load.
 */
export function isPlaybackAdvanceDue(record: RoomRecord): boolean {
  const playback = record.room.playback;
  if (playback.status !== "playing" || !playback.currentTrackId) {
    return false;
  }

  const gaplessTransitionAtMs = getGaplessTransitionAt(record);
  if (gaplessTransitionAtMs !== null && Date.now() >= gaplessTransitionAtMs) {
    return true;
  }

  const durationMs = getTrackDurationMs(record, playback.currentTrackId);
  if (durationMs <= 0) {
    return false;
  }

  return getEffectivePlaybackPositionMs(record, playback) >= durationMs;
}

export function canPreserveMediaEpoch(playback: PlaybackSnapshot, transition: GaplessTransition): boolean {
  return (
    playback.sourceSessionId === transition.sourceSessionId &&
    playback.sourcePeerId === transition.sourcePeerId
  );
}

export function bumpPlaybackVersion(playback: PlaybackSnapshot): void {
  playback.playbackRevision += 1;
}

export function assertRequestedPlaybackAsset(
  track: TrackMeta | undefined,
  requestedPlaybackAssetId?: string
): void {
  if (
    requestedPlaybackAssetId !== undefined &&
    requestedPlaybackAssetId !== (track?.playbackAsset?.assetId ?? null)
  ) {
    throw new Error("Playback asset does not belong to the selected track.");
  }
}

export function pickTrackSourceCandidate(
  track: TrackMeta,
  activePresence: Map<string, string>,
  options?: {
    preferredSessionId?: string | null;
    excludedSessionIds?: Set<string>;
  }
): SourceCandidate | null {
  // Tracks must have a complete room distribution asset to be broadcast.
  if (!hasCompleteRoomAsset(track)) {
    return null;
  }

  const excludedSessionIds = options?.excludedSessionIds ?? new Set<string>();
  const preferredSessionId = options?.preferredSessionId ?? null;
  const isSessionAvailable = (sessionId: string | null | undefined) =>
    !!sessionId && !excludedSessionIds.has(sessionId) && activePresence.has(sessionId);

  // Preferred session is only accepted when it is the track owner. Other members
  // never hold the local playback asset, so they cannot become the media source.
  if (
    isSessionAvailable(preferredSessionId) &&
    preferredSessionId === track.ownerSessionId
  ) {
    return {
      sessionId: preferredSessionId as string,
      peerId: activePresence.get(preferredSessionId as string) as string
    };
  }

  if (isSessionAvailable(track.ownerSessionId)) {
    return {
      sessionId: track.ownerSessionId,
      peerId: activePresence.get(track.ownerSessionId) as string
    };
  }

  // If the owner is not online, there is no broadcast source. Never return a fake peerId: null.
  return null;
}

export function pausePlaybackAt(
  record: RoomRecord,
  positionMs: number,
  options: {
    sourceCandidate?: SourceCandidate | null;
    bumpMediaEpoch: boolean;
    clearSourcePeer?: boolean;
    keepSourceSessionId?: boolean;
  }
): void {
  const playback = record.room.playback;
  playback.status = "paused";
  playback.positionMs = clampPositionMs(record, playback.currentTrackId, positionMs);
  playback.startedAt = null;
  playback.startAt = null;

  if (options.sourceCandidate) {
    playback.sourceSessionId = options.sourceCandidate.sessionId;
    playback.sourcePeerId = options.sourceCandidate.peerId;
  } else if (options.clearSourcePeer) {
    playback.sourcePeerId = null;
    if (!options.keepSourceSessionId) {
      playback.sourceSessionId = null;
    }
  }

  if (options.bumpMediaEpoch) {
    playback.mediaEpoch += 1;
  }
}
