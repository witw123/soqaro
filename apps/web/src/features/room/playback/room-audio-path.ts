/**
 * Room audio path resolution for the segmented playback runtime.
 *
 * These helpers decide which audio source a member should play (local file,
 * local segmented source, broadcast stream, or remote listener stream) and how
 * the room clock maps to the local audio timeline, including provider-cache
 * transitions and the shared AudioContext requirements of the source.
 */

import {
  hasCompleteRoomAsset,
  type PlaybackSnapshot,
  type RoomPlaybackReadinessInputPayload,
  type RoomSnapshot,
  type TrackLoudness,
  type TrackMeta
} from "@soqaro/shared";
import {
  getRoomPlaybackClockNowMs,
  resolveRoomPlaybackPositionMs,
  type RoomPlaybackBarrierClock
} from "@/features/playback/room-playback-clock";
import type { OfflineProviderSource } from "@/features/playback/offline-source-fallback";
import type { PlaybackAudioPath } from "@/features/playback/use-segmented-opus-playback";
import { resolveProviderTrackSource } from "@/features/library/provider-track-identity";
import { providerDisplayName } from "@/lib/domain/provider-labels";

export const localAudioSeekToleranceSeconds = 0.35;
const localAudioMetadataTimeoutMs = 8_000;

export type LocalAudioResolutionStatus = "idle" | "checking" | "available" | "missing";

export type LocalAudioResolution = {
  key: string | null;
  status: LocalAudioResolutionStatus;
  file: Blob | null;
  loudness?: TrackLoudness;
  error: string | null;
};

export function hasCurrentLocalAudio(
  resolution: LocalAudioResolution,
  requestedKey: string | null
) {
  return requestedKey !== null &&
    resolution.key === requestedKey &&
    resolution.status === "available" &&
    resolution.file !== null;
}

export type LocalAudioObjectUrl = {
  key: string;
  url: string;
};

export function resolveRoomAudioPositionMs(
  playback: Pick<PlaybackSnapshot, "status" | "positionMs" | "startedAt" | "startAt">,
  nowMs = getRoomPlaybackClockNowMs(),
  barrier?: Pick<RoomPlaybackBarrierClock, "holdPositionMs" | "resumeAtMs"> | null
) {
  return resolveRoomPlaybackPositionMs(playback, 0, nowMs, barrier);
}

export function alignLocalAudioToRoom(
  audio: Pick<HTMLAudioElement, "currentTime" | "duration">,
  playback: Pick<PlaybackSnapshot, "status" | "positionMs" | "startedAt" | "startAt">,
  options: { force?: boolean; durationMs?: number; nowMs?: number } = {}
) {
  const durationMs = Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration * 1000
    : options.durationMs ?? 0;
  const targetSeconds = resolveRoomPlaybackPositionMs(
    playback,
    durationMs,
    options.nowMs ?? getRoomPlaybackClockNowMs()
  ) / 1000;
  if (
    options.force ||
    !Number.isFinite(audio.currentTime) ||
    Math.abs(audio.currentTime - targetSeconds) >= localAudioSeekToleranceSeconds
  ) {
    audio.currentTime = targetSeconds;
  }
}

export function resolveLocalAudioTrackKey(
  track: TrackMeta | null | undefined
) {
  if (!track) {
    return null;
  }

  const providerSource = resolveProviderTrackSource(track);
  return [
    track.id,
    track.fileHash,
    track.originalAsset?.assetId ?? "no-orig",
    providerSource?.provider ?? "local",
    providerSource?.trackId ?? "none"
  ].join(":");
}

export function isProviderTrack(track: TrackMeta | null | undefined) {
  return !!resolveProviderTrackSource(track);
}

export type RoomProviderCacheMode = "none" | "provider-cache" | "offline-fallback";

export type RoomProviderCachePlan = {
  mode: RoomProviderCacheMode;
  source: OfflineProviderSource | null;
  isSourceMemberOffline: boolean;
};

export function resolveRoomSourceMemberOffline(input: {
  isCurrentSource: boolean;
  roomSnapshot: RoomSnapshot | null | undefined;
  track: TrackMeta | null | undefined;
}) {
  if (input.isCurrentSource || !input.roomSnapshot || !input.track) {
    return false;
  }
  const playback = input.roomSnapshot.room.playback;
  const sourceSessionId =
    (playback.currentTrackId === input.track.id ? playback.sourceSessionId : null) ??
    input.track.ownerSessionId;
  if (!sourceSessionId) {
    return false;
  }
  const sourceMember = input.roomSnapshot.room.members.find(
    (member) => member.id === sourceSessionId
  );
  return !sourceMember || sourceMember.presenceState === "offline";
}

export function resolveRoomProviderCachePlan(input: {
  sharedCacheEnabled: boolean;
  segmentedStreamEnabled: boolean;
  streamingOnlyPlayback: boolean;
  fullyCachedPlayback: boolean;
  preventOfflineAutoLoad: boolean;
  isCurrentSource: boolean;
  roomSnapshot: RoomSnapshot | null | undefined;
  track: TrackMeta | null | undefined;
}): RoomProviderCachePlan {
  const isSourceMemberOffline = resolveRoomSourceMemberOffline({
    isCurrentSource: input.isCurrentSource,
    roomSnapshot: input.roomSnapshot,
    track: input.track
  });

  if (
    !input.sharedCacheEnabled ||
    !input.segmentedStreamEnabled ||
    input.streamingOnlyPlayback ||
    !input.roomSnapshot ||
    !input.track
  ) {
    return { mode: "none", source: null, isSourceMemberOffline };
  }

  const playback = input.roomSnapshot.room.playback;
  if (!playback || playback.currentTrackId !== input.track.id) {
    return { mode: "none", source: null, isSourceMemberOffline };
  }

  const providerSource = resolveProviderTrackSource(input.track);
  if (!providerSource) {
    return { mode: "none", source: null, isSourceMemberOffline };
  }

  const source: OfflineProviderSource = {
    provider: providerSource.provider,
    trackId: providerSource.trackId,
    label: providerDisplayName(providerSource.provider)
  };

  if (isSourceMemberOffline) {
    if (playback.status !== "playing" || input.preventOfflineAutoLoad) {
      return { mode: "none", source: null, isSourceMemberOffline };
    }
    return {
      mode: input.fullyCachedPlayback ? "provider-cache" : "offline-fallback",
      source,
      isSourceMemberOffline
    };
  }

  if (!input.fullyCachedPlayback) {
    return { mode: "none", source: null, isSourceMemberOffline };
  }

  // While the active source member is already preparing/transcoding its missing
  // room distribution asset, avoid firing a duplicate parallel download.
  if (input.isCurrentSource && !hasCompleteRoomAsset(input.track)) {
    return { mode: "none", source: null, isSourceMemberOffline };
  }

  return {
    mode: "provider-cache",
    source,
    isSourceMemberOffline
  };
}

export function resolveLocalAudioTimelineKey(
  playback: Pick<
    PlaybackSnapshot,
    "currentTrackId" | "mediaEpoch" | "status" | "startedAt" | "startAt" | "positionMs"
  >,
  barrier?: Pick<RoomPlaybackBarrierClock, "holdPositionMs" | "resumeAtMs"> | null
) {
  return [
    playback.currentTrackId ?? "none",
    playback.mediaEpoch,
    playback.status,
    playback.startedAt ?? playback.startAt ?? "none",
    playback.status === "playing" ? "playing" : playback.positionMs,
    barrier?.holdPositionMs ?? "no-hold",
    barrier?.resumeAtMs ?? "no-resume"
  ].join(":");
}

export function resolveRemoteAudioTimelineKey(playback: Pick<
  PlaybackSnapshot,
  | "currentTrackId"
  | "mediaEpoch"
  | "status"
  | "startAt"
  | "startedAt"
  | "playbackRevision"
  | "positionMs"
>) {
  return [
    playback.currentTrackId ?? "none",
    playback.mediaEpoch,
    playback.status,
    playback.startAt ?? playback.startedAt ?? "none",
    playback.status === "playing" ? playback.playbackRevision : playback.positionMs
  ].join(":");
}

export function resolveRoomAudioPath(input: {
  isCurrentSource: boolean;
  nativeLocalAudio: boolean;
  localFallback?: boolean;
}): PlaybackAudioPath {
  if (input.nativeLocalAudio) {
    return "local-file";
  }
  if (input.localFallback) {
    return "local-segmented";
  }
  return input.isCurrentSource ? "broadcast-segmented" : "remote-stream";
}

/**
 * A cache preference changes the preferred source, but it must not stop the
 * room source while that cache is being checked or downloaded. The segmented
 * source remains the continuity path until a playable local file exists.
 */
export function shouldDisableSourcePlayback(input: {
  isCurrentSource: boolean;
  localAudioStatus: LocalAudioResolutionStatus;
}) {
  return input.isCurrentSource && input.localAudioStatus === "available";
}

export function shouldSkipUnavailableStreamingTrack(input: {
  isCurrentSource: boolean;
  streamingOnlyPlayback: boolean;
  playback: Pick<PlaybackSnapshot, "status" | "currentTrackId"> | null | undefined;
  currentTrackId: string | null | undefined;
  playbackAsset: TrackMeta["playbackAsset"] | null | undefined;
}) {
  return input.isCurrentSource &&
    input.streamingOnlyPlayback &&
    input.playback?.status === "playing" &&
    input.playback.currentTrackId === input.currentTrackId &&
    !input.playbackAsset;
}

/**
 * A listener's cached file is played directly by the media element. Only a
 * source needs a running AudioContext because its local element is connected
 * to the room broadcast destination.
 */
export function shouldWaitForLocalAudioContext(input: {
  isCurrentSource: boolean;
  audioUnlocked: boolean;
  audioContextState: AudioContextState | null;
}) {
  return input.isCurrentSource && (
    !input.audioUnlocked || input.audioContextState !== "running"
  );
}

export function resolveCacheReadinessReport(input: {
  cacheRequested: boolean;
  localReady: boolean;
  cacheAttemptPending: boolean;
  localAudioStatus: LocalAudioResolutionStatus;
}): Pick<RoomPlaybackReadinessInputPayload, "cacheEnabled" | "state"> {
  if (!input.cacheRequested) {
    return { cacheEnabled: false, state: "ready" };
  }
  if (input.localReady) {
    return { cacheEnabled: true, state: "ready" };
  }
  // Keep participating from the first local lookup through the provider
  // request. This prevents a brief barrier open/close cycle between the two.
  if (input.cacheAttemptPending || input.localAudioStatus !== "missing") {
    return { cacheEnabled: true, state: "waiting" };
  }
  // This member cannot obtain a playable cache for the current timeline.
  // Leaving the cache participant set makes RTP streaming its active path.
  return { cacheEnabled: false, state: "ready" };
}

export function isAudioPlaybackBlockedError(error: string | null) {
  return !!error && /not\s*allowed|autoplay|user gesture|blocked|audio-context-suspended/i.test(error);
}

export function isRecoverableLocalAudioError(error: string | null) {
  return !!error && /abort|interrupted|cancelled|canceled|pause\(\)|playing request/i.test(error);
}

export function waitForLocalAudioMetadata(audio: HTMLAudioElement) {
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("error", onError);
      window.clearTimeout(timeout);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onLoadedMetadata = () => finish();
    const onError = () => finish(new Error("本地音频文件无法解码。"));
    const timeout = window.setTimeout(
      () => finish(new Error("本地音频文件读取超时。")),
      localAudioMetadataTimeoutMs
    );
    audio.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
    audio.addEventListener("error", onError, { once: true });

    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      finish();
    }
  });
}
