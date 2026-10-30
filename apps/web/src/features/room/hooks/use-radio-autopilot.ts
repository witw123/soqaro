"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  NeteaseTrackCandidate,
  QqMusicTrackCandidate,
  RoomSnapshot
} from "@soqaro/shared";
import {
  getRadioRecommendationCandidates,
  type RadioRecommendationCandidate
} from "@/features/recommendations/radio-recommendations";
import { importRadioRecommendationCandidates } from "@/features/recommendations/radio-recommendation-import";
import { recordRadioRecommendationUnavailable } from "@/features/recommendations/radio-recommendation-feedback";

type UseRadioAutopilotOptions = {
  roomSnapshot: RoomSnapshot;
  isHost: boolean;
  userId: string | null;
  onImportNeteaseTrack: (track: NeteaseTrackCandidate) => Promise<void>;
  onImportQqMusicTrack: (track: QqMusicTrackCandidate) => Promise<void>;
  onRefreshRoom: () => Promise<RoomSnapshot | null>;
};

type RadioAutopilotState = {
  kind: "idle" | "refilling" | "paused";
  message: string | null;
};

export type RadioAutopilotNextTrack = {
  key: string;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  durationMs: number;
  provider: "netease" | "qqmusic" | "bilibili" | "alist";
  preloadStatus: "preloading" | "ready";
};

const maxAutomaticRetryAttempts = 2;
const automaticRetryDelayMs = 15_000;

export function useRadioAutopilot({
  roomSnapshot,
  isHost,
  userId,
  onImportNeteaseTrack,
  onImportQqMusicTrack,
  onRefreshRoom
}: UseRadioAutopilotOptions) {
  const [state, setState] = useState<RadioAutopilotState>({ kind: "idle", message: null });
  const [preloadingCandidate, setPreloadingCandidate] = useState<RadioRecommendationCandidate | null>(null);
  const runningRef = useRef(false);
  const pausedRef = useRef(false);
  const retryAttemptsRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const refillGenerationRef = useRef(0);
  const roomSnapshotRef = useRef(roomSnapshot);
  const callbacksRef = useRef({
    onImportNeteaseTrack,
    onImportQqMusicTrack,
    onRefreshRoom
  });
  const isAutopilotEnabled = roomSnapshot.room.radioAutopilot?.enabled === true;
  const currentSeedKey = getCurrentAutopilotSeed(roomSnapshot)?.key ?? null;
  const isPlayingLastQueueItem = isRadioPlaybackAtQueueEnd(roomSnapshot);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    roomSnapshotRef.current = roomSnapshot;
  }, [roomSnapshot]);

  useEffect(() => {
    callbacksRef.current = {
      onImportNeteaseTrack,
      onImportQqMusicTrack,
      onRefreshRoom
    };
  }, [onImportNeteaseTrack, onImportQqMusicTrack, onRefreshRoom]);

  useEffect(() => {
    refillGenerationRef.current += 1;
    clearRetryTimer();
    return () => {
      refillGenerationRef.current += 1;
      clearRetryTimer();
    };
  }, [clearRetryTimer, currentSeedKey, isAutopilotEnabled, isHost]);

  const refill = useCallback(async (mode: "automatic" | "manual") => {
    const snapshot = roomSnapshotRef.current;
    const autopilot = snapshot.room.radioAutopilot;
    const seed = getCurrentAutopilotSeed(snapshot);
    const isAutomatic = mode === "automatic";
    if (
      !isHost ||
      !userId ||
      !seed ||
      snapshot.room.playback.status !== "playing" ||
      !snapshot.room.playback.currentTrackId ||
      runningRef.current ||
      (isAutomatic && (
        autopilot?.enabled !== true ||
        pausedRef.current ||
        !isRadioPlaybackAtQueueEnd(snapshot)
      ))
    ) {
      return;
    }

    clearRetryTimer();
    const refillGeneration = refillGenerationRef.current;
    const isCurrentRefill = () => {
      const current = roomSnapshotRef.current;
      return refillGeneration === refillGenerationRef.current &&
        getCurrentAutopilotSeed(current)?.key === seed.key;
    };
    runningRef.current = true;
    setState({ kind: "refilling", message: "正在分析并准备下一首…" });
    try {
      const candidates = await getRadioRecommendationCandidates({
        userId,
        snapshot,
        provider: seed.provider,
        seed: {
          title: seed.track.title,
          artist: seed.track.artist
        }
      });
      if (!isCurrentRefill()) return;
      if (candidates.length === 0) {
        pausedRef.current = true;
        setPreloadingCandidate(null);
        setState({ kind: "paused", message: "没有找到可播放的相似歌曲。" });
        return;
      }

      const imported = await importRadioRecommendationCandidates({
        roomId: snapshot.room.id,
        candidates,
        isCurrent: isCurrentRefill,
        isSeedCurrent: (freshSnapshot) => getCurrentAutopilotSeed(freshSnapshot)?.key === seed.key,
        onCandidate: (candidate) => {
          setPreloadingCandidate(candidate);
          setState({ kind: "refilling", message: `正在预加载《${candidate.candidate.title}》…` });
        },
        onCandidateFailed: (candidate) => {
          void recordRadioRecommendationUnavailable({
            userId,
            roomId: snapshot.room.id,
            candidate: candidate.candidate
          }).catch(() => undefined);
        },
        onImportNeteaseTrack: callbacksRef.current.onImportNeteaseTrack,
        onImportQqMusicTrack: callbacksRef.current.onImportQqMusicTrack,
        onRefreshRoom: callbacksRef.current.onRefreshRoom
      });
      if (imported.kind === "cancelled") return;
      if (imported.kind === "failed") throw imported.error;

      retryAttemptsRef.current = 0;
      pausedRef.current = false;
      if (imported.refreshedSnapshot) roomSnapshotRef.current = imported.refreshedSnapshot;
      setState({ kind: "idle", message: `已将《${imported.candidate.candidate.title}》设为下一首。` });
    } catch (error) {
      setPreloadingCandidate(null);
      if (
        isAutomatic &&
        isCurrentRefill() &&
        retryAttemptsRef.current < maxAutomaticRetryAttempts
      ) {
        retryAttemptsRef.current += 1;
        setState({ kind: "refilling", message: "自动推荐遇到波动，即将重试…" });
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          if (isCurrentRefill()) {
            void refill("automatic");
          }
        }, automaticRetryDelayMs);
        return;
      }
      pausedRef.current = true;
      setState({ kind: "paused", message: toAutopilotErrorMessage(error) });
    } finally {
      runningRef.current = false;
    }
  }, [clearRetryTimer, isHost, userId]);

  useEffect(() => {
    retryAttemptsRef.current = 0;
    pausedRef.current = false;
    setPreloadingCandidate(null);
  }, [currentSeedKey]);

  useEffect(() => {
    if (!isHost || !isAutopilotEnabled) {
      clearRetryTimer();
      retryAttemptsRef.current = 0;
      pausedRef.current = false;
      setPreloadingCandidate(null);
      setState((current) => current.kind === "idle" && current.message === null
        ? current
        : { kind: "idle", message: null });
      return;
    }

    if (!currentSeedKey) {
      pausedRef.current = true;
      setState((current) => current.kind === "paused" && current.message === "请先从节目单播放一首网易云音乐或 QQ 音乐歌曲。"
        ? current
        : { kind: "paused", message: "请先从节目单播放一首网易云音乐或 QQ 音乐歌曲。" });
      return;
    }

    if (isPlayingLastQueueItem) void refill("automatic");
  }, [clearRetryTimer, currentSeedKey, isAutopilotEnabled, isHost, isPlayingLastQueueItem, refill]);

  useEffect(() => {
    if (!isHost || !isAutopilotEnabled || !currentSeedKey) return;
    const handleOnline = () => {
      if (!isRadioPlaybackAtQueueEnd(roomSnapshotRef.current)) return;
      clearRetryTimer();
      retryAttemptsRef.current = 0;
      pausedRef.current = false;
      void refill("automatic");
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [clearRetryTimer, currentSeedKey, isAutopilotEnabled, isHost, refill]);

  const refillNow = useCallback(async () => {
    clearRetryTimer();
    retryAttemptsRef.current = 0;
    pausedRef.current = false;
    await refill("manual");
  }, [clearRetryTimer, refill]);

  const queuedNextTrack = getNextAutopilotTrack(roomSnapshot);
  const queuedNextTrackKey = queuedNextTrack?.key ?? null;
  const nextTrack = queuedNextTrack ?? (preloadingCandidate
    ? toNextTrack(preloadingCandidate, "preloading")
    : null);

  useEffect(() => {
    if (queuedNextTrackKey) setPreloadingCandidate(null);
  }, [queuedNextTrackKey]);

  return { state, refillNow, nextTrack };
}

export function isRadioPlaybackAtQueueEnd(snapshot: RoomSnapshot) {
  const currentQueueItemId = snapshot.room.playback.currentQueueItemId;
  if (!currentQueueItemId || snapshot.room.playback.status !== "playing") return false;
  return snapshot.queue[snapshot.queue.length - 1]?.id === currentQueueItemId;
}

function getCurrentAutopilotSeed(snapshot: RoomSnapshot) {
  const currentQueueItemId = snapshot.room.playback.currentQueueItemId;
  const source = getCurrentProviderSource(snapshot);
  if (!currentQueueItemId || !source) return null;
  return {
    ...source,
    key: `${currentQueueItemId}:${source.key}`
  };
}

function getCurrentProviderSource(snapshot: RoomSnapshot) {
  const trackId = snapshot.room.playback.currentTrackId;
  const track = trackId ? snapshot.tracks.find((item) => item.id === trackId) : null;
  if (
    !track?.sourceRef ||
    (track.sourceRef.provider !== "netease" && track.sourceRef.provider !== "qqmusic") ||
    (track.sourceType !== "netease" && track.sourceType !== "qqmusic")
  ) {
    return null;
  }

  return {
    provider: track.sourceRef.provider,
    providerTrackId: track.sourceRef.trackId,
    track,
    key: `${track.sourceRef.provider}:${track.sourceRef.trackId}`
  };
}

function getNextAutopilotTrack(snapshot: RoomSnapshot): RadioAutopilotNextTrack | null {
  const currentQueueItemId = snapshot.room.playback.currentQueueItemId;
  const currentIndex = currentQueueItemId
    ? snapshot.queue.findIndex((item) => item.id === currentQueueItemId)
    : -1;
  const nextItem = currentIndex >= 0 ? snapshot.queue[currentIndex + 1] : null;
  if (nextItem?.source !== "autopilot") return null;
  const track = nextItem
    ? snapshot.tracks.find((item) => item.id === nextItem.trackId)
    : null;
  if (!track?.sourceRef) return null;

  return {
    key: nextItem?.id ?? track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    artworkUrl: track.artworkUrl,
    durationMs: track.durationMs,
    provider: track.sourceRef.provider,
    preloadStatus: track.playbackAsset ? "ready" : "preloading"
  };
}

function toNextTrack(
  recommendation: RadioRecommendationCandidate,
  preloadStatus: RadioAutopilotNextTrack["preloadStatus"]
): RadioAutopilotNextTrack {
  const candidate = recommendation.candidate;
  return {
    key: `${candidate.provider}:${candidate.providerTrackId}`,
    title: candidate.title,
    artist: candidate.artist,
    album: candidate.album,
    artworkUrl: candidate.artworkUrl,
    durationMs: candidate.durationMs,
    provider: candidate.provider,
    preloadStatus
  };
}

function toAutopilotErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return `自动推荐已暂停：${error.message}`;
  }
  return "自动推荐已暂停，可重试。";
}
