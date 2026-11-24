"use client";

import { useEffect, useMemo, useRef, useState, type RefObject, type SyntheticEvent } from "react";
import type { PlaybackSnapshot, TrackMeta } from "@soqaro/shared";
import { shouldReplacePlaybackSnapshot } from "@/lib/domain/soqaro-ui";
import {
  getRoomPlaybackClockNowMs,
  resolveRoomPlaybackPositionMs,
  type RoomPlaybackBarrierClock
} from "./room-playback-clock";
import { roomAudioOutput } from "./room-audio-output";
import { appSettingsChangeEvent, getAppSettings } from "@/features/settings/settings-store";
import { resolveLoudnessGainDb } from "./loudness";

const playbackProgressPollIntervalMs = 150;
const hiddenPlaybackProgressPollIntervalMs = 1_000;
const playingProgressCommitThresholdMs = 80;
const idleProgressCommitThresholdMs = 120;
const displayClockTransitionWindowMs = 100;
const monotonicProgressBacktrackToleranceMs = 180;
const audibleClockFallbackGraceMs = 1_500;

export type DisplayClockSource =
  | "local-audible"
  | "room-fallback";

type UseRoomPlaybackOptions = {
  audioRef: RefObject<HTMLAudioElement | null>;
  playback: PlaybackSnapshot | null | undefined;
  tracks: TrackMeta[];
  currentTrack?: TrackMeta | null;
  getLocalPlaybackPositionMs?: () => number | null;
  playbackBarrier?: RoomPlaybackBarrierClock | null;
};

type AudibleClockSample = {
  progressMs: number;
  source: DisplayClockSource;
};

type DisplayClockTransitionState = {
  source: DisplayClockSource;
  anchorDisplayMs: number;
  anchorAudibleMs: number;
  anchorAtMs: number;
  hardDriftSamples: number;
};

type AudibleClockContinuityState = {
  sample: AudibleClockSample;
  observedAtMs: number;
  sessionKey: string;
};

function clampProgressMs(progressMs: number, durationMs: number) {
  return durationMs > 0
    ? Math.min(Math.max(0, progressMs), durationMs)
    : Math.max(0, progressMs);
}

function isPlaybackBarrierHolding(
  barrier: Pick<RoomPlaybackBarrierClock, "blocked" | "holdPositionMs" | "resumeAtMs"> | null | undefined,
  nowMs: number
) {
  if (barrier?.blocked === true) {
    return true;
  }
  if (typeof barrier?.holdPositionMs !== "number" || !Number.isFinite(barrier.holdPositionMs)) {
    return false;
  }
  return typeof barrier.resumeAtMs !== "number" ||
    !Number.isFinite(barrier.resumeAtMs) ||
    nowMs < barrier.resumeAtMs;
}

export function resolveDisplayRoomPositionMs(input: {
  playback: PlaybackSnapshot;
  durationMs: number;
  nowMs: number;
  barrier?: RoomPlaybackBarrierClock | null;
  previousProgressMs: number;
  previousSessionKey: string;
}) {
  if (input.barrier?.blocked === true &&
    (typeof input.barrier.holdPositionMs !== "number" ||
      !Number.isFinite(input.barrier.holdPositionMs))) {
    return 0;
  }
  return getPlaybackEffectivePositionMs(
    input.playback,
    input.durationMs,
    input.nowMs,
    input.barrier
  );
}

export function resolveAudibleClockSample(input: {
  localAudioCurrentTimeSeconds?: number | null;
  localAudioPaused?: boolean | null;
  localPlaybackPositionMs?: number | null;
}): { sample: AudibleClockSample | null } {
  if (
    typeof input.localPlaybackPositionMs === "number" &&
    Number.isFinite(input.localPlaybackPositionMs)
  ) {
    return {
      sample: {
        progressMs: Math.max(0, Math.round(input.localPlaybackPositionMs)),
        source: "local-audible"
      }
    };
  }

  if (
    typeof input.localAudioCurrentTimeSeconds === "number" &&
    Number.isFinite(input.localAudioCurrentTimeSeconds) &&
    input.localAudioCurrentTimeSeconds >= 0 &&
    input.localAudioPaused === false
  ) {
    return {
      sample: {
        progressMs: Math.floor(input.localAudioCurrentTimeSeconds * 1000),
        source: "local-audible"
      }
    };
  }

  return {
    sample: null
  };
}

export function resolveDisplayClockProgress(input: {
  audibleClockSample: AudibleClockSample | null;
  previousContinuity?: AudibleClockContinuityState | null;
  playbackStatus?: PlaybackSnapshot["status"] | null | undefined;
  roomClockMs: number;
  durationMs: number;
  previousDisplayMs: number;
  previousSource: DisplayClockSource;
  transitionState: DisplayClockTransitionState;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const roomClockMs = clampProgressMs(input.roomClockMs, input.durationMs);

  let targetSource: DisplayClockSource = "room-fallback";
  let targetProgressMs = roomClockMs;
  const continuityAgeMs = input.previousContinuity ? now - input.previousContinuity.observedAtMs : null;
  const localAudibleSample =
    input.audibleClockSample?.source === "local-audible" ? input.audibleClockSample : null;

  if (localAudibleSample) {
    targetSource = localAudibleSample.source;
    targetProgressMs = clampProgressMs(localAudibleSample.progressMs, input.durationMs);
  } else if (
    input.playbackStatus === "playing" &&
    input.previousContinuity &&
    continuityAgeMs !== null &&
    continuityAgeMs <= audibleClockFallbackGraceMs
  ) {
    targetSource = input.previousContinuity.sample.source;
    targetProgressMs = clampProgressMs(input.previousContinuity.sample.progressMs, input.durationMs);
  }

  let nextTransitionState = input.transitionState;
  const sourceChanged = input.previousSource !== targetSource;
  if (sourceChanged) {
    nextTransitionState = {
      source: targetSource,
      anchorDisplayMs: clampProgressMs(input.previousDisplayMs, input.durationMs),
      anchorAudibleMs: targetProgressMs,
      anchorAtMs: now,
      hardDriftSamples: 0
    };
  }

  const transitionElapsedMs = Math.max(0, now - nextTransitionState.anchorAtMs);
  const transitionRatio = Math.min(1, transitionElapsedMs / displayClockTransitionWindowMs);
  const anchoredTargetMs =
    nextTransitionState.anchorDisplayMs +
    (targetProgressMs - nextTransitionState.anchorAudibleMs);
  const nextProgressMs =
    anchoredTargetMs + (targetProgressMs - anchoredTargetMs) * transitionRatio;
  const boundedProgressMs = clampProgressMs(Math.round(nextProgressMs), input.durationMs);
  return {
    progressMs: boundedProgressMs,
    source: targetSource,
    displayDriftMs: Math.round(roomClockMs - boundedProgressMs),
    transitionState: nextTransitionState
  };
}

export function resolveAudibleClockContinuitySample(input: {
  audibleClockSample: AudibleClockSample | null;
  previousContinuity: AudibleClockContinuityState | null;
  playbackSessionKey: string;
  playbackStatus: PlaybackSnapshot["status"] | null | undefined;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  if (input.audibleClockSample) {
    return {
      sample: input.audibleClockSample,
      continuityState: {
        sample: input.audibleClockSample,
        observedAtMs: now,
        sessionKey: input.playbackSessionKey
      } satisfies AudibleClockContinuityState
    };
  }

  if (
    !input.previousContinuity ||
    input.previousContinuity.sessionKey !== input.playbackSessionKey
  ) {
    return {
      sample: null,
      continuityState: null
    };
  }

  return {
    sample: null,
    continuityState:
      input.playbackStatus === "playing" ? input.previousContinuity : null
  };
}

function getPlaybackProgressPollIntervalMs(input: {
  isPageVisible: boolean;
  playbackStatus: PlaybackSnapshot["status"] | null | undefined;
}) {
  if (!input.isPageVisible || input.playbackStatus !== "playing") {
    return hiddenPlaybackProgressPollIntervalMs;
  }

  return playbackProgressPollIntervalMs;
}

export function useRoomPlayback(options: UseRoomPlaybackOptions) {
  const {
    audioRef,
    playback,
    tracks,
    currentTrack,
    getLocalPlaybackPositionMs,
    playbackBarrier
  } = options;
  const [progressMs, setProgressMs] = useState(0);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const [audioDurationMs, setAudioDurationMs] = useState(0);
  const [volume, setVolume] = useState(0.72);
  const [loudnessNormalization, setLoudnessNormalization] = useState(false);
  const lastSettingsDefaultVolumeRef = useRef<number | null>(null);
  const [displayClockSource, setDisplayClockSource] = useState<DisplayClockSource>("room-fallback");
  const [displayDriftMs, setDisplayDriftMs] = useState(0);
  const [acceptedPlayback, setAcceptedPlayback] = useState<PlaybackSnapshot | null>(null);
  const [isPageVisible, setIsPageVisible] = useState(
    typeof document === "undefined" ? true : !document.hidden
  );
  const progressPollTimerRef = useRef<number | null>(null);
  const lastCommittedProgressRef = useRef(0);
  const lastCommittedSessionKeyRef = useRef("no-playback");
  const audibleClockContinuityRef = useRef<AudibleClockContinuityState | null>(null);
  const displayClockTransitionRef = useRef<DisplayClockTransitionState>({
    source: "room-fallback",
    anchorDisplayMs: 0,
    anchorAudibleMs: 0,
    anchorAtMs: 0,
    hardDriftSamples: 0
  });
  const acceptedPlaybackRef = useRef<PlaybackSnapshot | null>(null);
  acceptedPlaybackRef.current = acceptedPlayback;

  useEffect(() => {
    const syncVolume = () => {
      const settings = getAppSettings();
      const defaultVolumeChanged = lastSettingsDefaultVolumeRef.current === null ||
        lastSettingsDefaultVolumeRef.current !== settings.playback.defaultVolume;
      lastSettingsDefaultVolumeRef.current = settings.playback.defaultVolume;
      if (defaultVolumeChanged) {
        setVolume(settings.playback.defaultVolume);
      }
      setLoudnessNormalization(settings.playback.loudnessNormalization);
    };
    syncVolume();
    window.addEventListener(appSettingsChangeEvent, syncVolume);
    window.addEventListener("storage", syncVolume);
    return () => {
      window.removeEventListener(appSettingsChangeEvent, syncVolume);
      window.removeEventListener("storage", syncVolume);
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const handleVisibilityChange = () => {
      setIsPageVisible(!document.hidden);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (!playback) {
      setAcceptedPlayback(null);
      return;
    }

    setAcceptedPlayback((current) =>
      shouldReplacePlaybackSnapshot(current, playback) ? playback : current
    );
  }, [playback]);

  const progressTrack = useMemo(() => {
    if (currentTrack && (!acceptedPlayback?.currentTrackId || currentTrack.id === acceptedPlayback.currentTrackId)) {
      return currentTrack;
    }
    if (!acceptedPlayback?.currentTrackId) {
      return currentTrack ?? null;
    }

    return tracks.find((item) => item.id === acceptedPlayback.currentTrackId) ?? currentTrack ?? null;
  }, [acceptedPlayback?.currentTrackId, currentTrack, tracks]);
  const loudnessGainDb = resolveLoudnessGainDb(progressTrack, loudnessNormalization);

  useEffect(() => {
    if (!acceptedPlayback || !progressTrack) {
      setProgressMs(0);
      setDisplayClockSource("room-fallback");
      setDisplayDriftMs(0);
      lastCommittedSessionKeyRef.current = "no-playback";
      displayClockTransitionRef.current = {
        source: "room-fallback",
        anchorDisplayMs: 0,
        anchorAudibleMs: 0,
        anchorAtMs: Date.now(),
        hardDriftSamples: 0
      };
      audibleClockContinuityRef.current = null;
      return;
    }

    const commitProgress = (
      currentPlayback: PlaybackSnapshot,
      durationMs: number,
      nextProgressMs: number,
      nextSource: DisplayClockSource,
      nextDriftMs: number
    ) => {
      const currentSessionKey = getPlaybackClockSessionKey(currentPlayback);
      let normalizedProgressMs = clampProgressMs(nextProgressMs, durationMs);
      const sameSession = lastCommittedSessionKeyRef.current === currentSessionKey;
      if (
        currentPlayback.status === "playing" &&
        sameSession &&
        nextSource !== "room-fallback" &&
        normalizedProgressMs < lastCommittedProgressRef.current &&
        lastCommittedProgressRef.current - normalizedProgressMs <=
          monotonicProgressBacktrackToleranceMs
      ) {
        normalizedProgressMs = lastCommittedProgressRef.current;
      }
      const thresholdMs =
        currentPlayback.status === "playing"
          ? playingProgressCommitThresholdMs
          : idleProgressCommitThresholdMs;

      setDisplayClockSource((current) => (current === nextSource ? current : nextSource));
      setDisplayDriftMs((current) => (current === nextDriftMs ? current : nextDriftMs));

      if (
        Math.abs(normalizedProgressMs - lastCommittedProgressRef.current) < thresholdMs &&
        nextSource === displayClockTransitionRef.current.source
      ) {
        return;
      }

      lastCommittedProgressRef.current = normalizedProgressMs;
      lastCommittedSessionKeyRef.current = currentSessionKey;
      setProgressMs(normalizedProgressMs);
    };

    const tick = () => {
      const currentPlayback = acceptedPlaybackRef.current;
      if (!currentPlayback || !progressTrack) {
        return;
      }

      const now = getRoomPlaybackClockNowMs();
      const barrierHolding = isPlaybackBarrierHolding(playbackBarrier, now);
      const playbackSessionKey = getPlaybackClockSessionKey(currentPlayback);
      const roomClockMs = resolveDisplayRoomPositionMs({
        playback: currentPlayback,
        durationMs: progressTrack.durationMs,
        nowMs: now,
        barrier: playbackBarrier,
        previousProgressMs: lastCommittedProgressRef.current,
        previousSessionKey: lastCommittedSessionKeyRef.current
      });
      const audibleClockResolution =
        currentPlayback.status === "playing" && !barrierHolding
          ? resolveAudibleClockSample({
              localPlaybackPositionMs:
                typeof getLocalPlaybackPositionMs === "function" ? getLocalPlaybackPositionMs() : null
            })
          : { sample: null };
      const continuityResolution = resolveAudibleClockContinuitySample({
        audibleClockSample: audibleClockResolution.sample,
        previousContinuity: audibleClockContinuityRef.current,
        playbackSessionKey,
        playbackStatus: currentPlayback.status,
        now
      });
      audibleClockContinuityRef.current = continuityResolution.continuityState;
      const nextDisplayClock = resolveDisplayClockProgress({
        audibleClockSample: audibleClockResolution.sample,
        previousContinuity: continuityResolution.continuityState,
        playbackStatus: currentPlayback.status,
        roomClockMs,
        durationMs: progressTrack.durationMs,
        previousDisplayMs: lastCommittedProgressRef.current,
        previousSource: displayClockTransitionRef.current.source,
        transitionState: displayClockTransitionRef.current,
        now
      });

      displayClockTransitionRef.current = nextDisplayClock.transitionState;

      if (seekDraft === null || nextDisplayClock.source !== "room-fallback") {
        commitProgress(
          currentPlayback,
          progressTrack.durationMs,
          nextDisplayClock.progressMs,
          nextDisplayClock.source,
          nextDisplayClock.displayDriftMs
        );
      }
    };

    const pollProgress = () => {
      tick();
      progressPollTimerRef.current = window.setTimeout(
        pollProgress,
        getPlaybackProgressPollIntervalMs({
          isPageVisible,
          playbackStatus: acceptedPlaybackRef.current?.status
        })
      );
    };

    tick();

    if (
      acceptedPlayback.status === "playing" &&
      seekDraft === null &&
      isPageVisible &&
      !isPlaybackBarrierHolding(playbackBarrier, getRoomPlaybackClockNowMs())
    ) {
      progressPollTimerRef.current = window.setTimeout(
        pollProgress,
        getPlaybackProgressPollIntervalMs({
          isPageVisible,
          playbackStatus: acceptedPlayback.status
        })
      );
    }

    return () => {
      if (progressPollTimerRef.current !== null) {
        window.clearTimeout(progressPollTimerRef.current);
        progressPollTimerRef.current = null;
      }
    };
  }, [
    audioRef,
    acceptedPlayback,
    acceptedPlayback?.status,
    acceptedPlayback?.currentTrackId,
    acceptedPlayback?.mediaEpoch,
    progressTrack,
    progressTrack?.durationMs,
    
    getLocalPlaybackPositionMs,
    seekDraft,
    isPageVisible,
    playbackBarrier,
    playbackBarrier?.holdPositionMs,
    playbackBarrier?.resumeAtMs
  ]);

  useEffect(() => {
    roomAudioOutput.applyVolume({
      localAudio: audioRef.current,
      volume,
      loudnessGainDb
    });
  }, [audioRef, loudnessGainDb, volume]);

  function syncProgressFromAudio(event?: SyntheticEvent<HTMLAudioElement>) {
    const currentPlayback = acceptedPlaybackRef.current;
    if (!currentPlayback || !progressTrack) {
      return;
    }

    const currentSessionKey = getPlaybackClockSessionKey(currentPlayback);
    const localAudio = audioRef.current;

    if (
      event?.type === "timeupdate" &&
      event.currentTarget &&
      event.currentTarget !== localAudio
    ) {
      return;
    }

    const now = getRoomPlaybackClockNowMs();
    const barrierHolding = isPlaybackBarrierHolding(playbackBarrier, now);
    const playbackSessionKey = getPlaybackClockSessionKey(currentPlayback);
    const roomClockMs = resolveDisplayRoomPositionMs({
      playback: currentPlayback,
      durationMs: progressTrack.durationMs,
      nowMs: now,
      barrier: playbackBarrier,
      previousProgressMs: lastCommittedProgressRef.current,
      previousSessionKey: lastCommittedSessionKeyRef.current
    });
    const audibleClockResolution =
      currentPlayback.status === "playing" && !barrierHolding
        ? resolveAudibleClockSample({
            localPlaybackPositionMs:
              typeof getLocalPlaybackPositionMs === "function" ? getLocalPlaybackPositionMs() : null
          })
        : { sample: null };
    const continuityResolution = resolveAudibleClockContinuitySample({
      audibleClockSample: audibleClockResolution.sample,
      previousContinuity: audibleClockContinuityRef.current,
      playbackSessionKey,
      playbackStatus: currentPlayback.status,
      now
    });
    audibleClockContinuityRef.current = continuityResolution.continuityState;
    const nextDisplayClock = resolveDisplayClockProgress({
      audibleClockSample: audibleClockResolution.sample,
      previousContinuity: continuityResolution.continuityState,
      playbackStatus: currentPlayback.status,
      roomClockMs,
      durationMs: progressTrack.durationMs,
      previousDisplayMs: lastCommittedProgressRef.current,
      previousSource: displayClockTransitionRef.current.source,
      transitionState: displayClockTransitionRef.current,
      now
    });
    displayClockTransitionRef.current = nextDisplayClock.transitionState;
    setDisplayClockSource((current) =>
      current === nextDisplayClock.source ? current : nextDisplayClock.source
    );
    setDisplayDriftMs((current) =>
      current === nextDisplayClock.displayDriftMs ? current : nextDisplayClock.displayDriftMs
    );
    let nextProgressMs = nextDisplayClock.progressMs;
    const sameSession = lastCommittedSessionKeyRef.current === currentSessionKey;
    if (
      currentPlayback.status === "playing" &&
      sameSession &&
      nextDisplayClock.source !== "room-fallback" &&
      nextProgressMs < lastCommittedProgressRef.current &&
      lastCommittedProgressRef.current - nextProgressMs <=
        monotonicProgressBacktrackToleranceMs
    ) {
      nextProgressMs = lastCommittedProgressRef.current;
    }
    if (
      Math.abs(nextProgressMs - lastCommittedProgressRef.current) <
      playingProgressCommitThresholdMs &&
      nextDisplayClock.source === displayClockTransitionRef.current.source
    ) {
      return;
    }
    lastCommittedProgressRef.current = nextProgressMs;
    lastCommittedSessionKeyRef.current = currentSessionKey;
    setProgressMs(nextProgressMs);
  }

  function syncDurationFromAudio(event?: SyntheticEvent<HTMLAudioElement>) {
    if (progressTrack?.durationMs && progressTrack.durationMs > 0) {
      setAudioDurationMs(progressTrack.durationMs);
      return;
    }

    const audio =
      event?.currentTarget ?? audioRef.current;
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) {
      if (progressTrack?.durationMs) {
        setAudioDurationMs(progressTrack.durationMs);
      }
      return;
    }

    setAudioDurationMs(Math.round(audio.duration * 1000));
  }

  useEffect(() => {
    setSeekDraft(null);

    const currentPlayback = acceptedPlaybackRef.current;
    const nextProgressMs = progressTrack && currentPlayback
      ? resolveDisplayRoomPositionMs({
        playback: currentPlayback,
        durationMs: progressTrack.durationMs,
        nowMs: getRoomPlaybackClockNowMs(),
        barrier: playbackBarrier,
        previousProgressMs: lastCommittedProgressRef.current,
        previousSessionKey: lastCommittedSessionKeyRef.current
      })
      : 0;
    setProgressMs(nextProgressMs);
    setDisplayClockSource("room-fallback");
    setDisplayDriftMs(0);
    lastCommittedProgressRef.current = nextProgressMs;
    lastCommittedSessionKeyRef.current = getPlaybackClockSessionKey(currentPlayback);
    displayClockTransitionRef.current = {
      source: "room-fallback",
      anchorDisplayMs: nextProgressMs,
      anchorAudibleMs: nextProgressMs,
      anchorAtMs: Date.now(),
      hardDriftSamples: 0
    };
    audibleClockContinuityRef.current = null;
    setAudioDurationMs(progressTrack?.durationMs ?? 0);
  }, [
    progressTrack?.id,
    progressTrack?.durationMs,
    progressTrack,
    acceptedPlayback?.mediaEpoch,
    playbackBarrier,
    playbackBarrier?.holdPositionMs,
    playbackBarrier?.resumeAtMs
  ]);

  return {
    progressTrack,
    progressMs,
    setProgressMs,
    seekDraft,
    setSeekDraft,
    audioDurationMs,
    setAudioDurationMs,
    volume,
    setVolume,
    displayClockSource,
    displayDriftMs,
    syncProgressFromAudio,
    syncDurationFromAudio
  };
}

function getPlaybackClockSessionKey(playback: PlaybackSnapshot | null | undefined) {
  if (!playback) {
    return "no-playback";
  }

  return [
    playback.currentTrackId ?? "none",
    playback.mediaEpoch,
    playback.startedAt ?? "stopped",
    playback.status
  ].join("|");
}

export function getPlaybackEffectivePositionMs(
  playback: PlaybackSnapshot | null | undefined,
  durationMs: number,
  now = getRoomPlaybackClockNowMs(),
  barrier?: Pick<RoomPlaybackBarrierClock, "holdPositionMs" | "resumeAtMs"> | null
) {
  if (!playback) {
    return 0;
  }
  return resolveRoomPlaybackPositionMs(playback, durationMs, now, barrier);
}
