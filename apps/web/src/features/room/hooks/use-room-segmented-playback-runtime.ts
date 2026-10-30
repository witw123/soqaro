"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import type {
  RoomPlaybackReadinessInputPayload,
  RoomPlaybackReadinessPayload,
  RoomSnapshot,
  TrackMeta
} from "@soqaro/shared";
import type { PeerDiagnosticRecorder } from "@/features/p2p/use-peer-diagnostics";
import { preferredAudioRtpBitrateKbps } from "@/features/p2p/audio-bitrate-policy";
import {
  useSegmentedOpusPlayback,
  type SegmentedPlaybackSnapshot
} from "@/features/playback/use-segmented-opus-playback";
import type { RoomCoarsePlaybackState } from "@/features/room/playback/room-coarse-playback";
import { roomMediaPlaybackStore } from "@/features/room/playback/room-media-playback-store";
import { createPlaybackMediaSession } from "@/features/playback/playback-media-session";
import { roomAudioOutput } from "@/features/playback/room-audio-output";
import { getRoomPlaybackClockNowMs } from "@/features/playback/room-playback-clock";
import { getRoomLocalAudioFile } from "@/features/library/local-audio-storage";
import { cacheLibraryChangedEventName } from "@/features/library/cache-library";
import { storageRootChangedEvent } from "@/features/library/storage-root-events";
import { ensureOfflineProviderPlaybackAsset } from "@/features/playback/offline-source-fallback";
import { providerPlaybackCacheChangedEvent } from "@/features/playback/provider-track-cache";
import { resolveRoomPlaybackStrategy } from "@/features/room/playback/room-playback-strategy";
import { resolveProviderTrackSource } from "@/features/library/provider-track-identity";
import { getRoomQueuePreloadTracks, RoomAudioPreloader } from "@/features/room/playback/room-queue-preload";
import { resolveCurrentRoomPlaybackAsset } from "@/features/playback/room-playback-asset";
import {
  appSettingsChangeEvent,
  getAppSettings
} from "@/features/settings/settings-store";
import { analyzeAudioBlobLoudness, resolveLoudnessGainDb } from "@/features/playback/loudness";
import {
  idlePlaybackSnapshot,
  isSegmentedPlaybackAudible,
  uninterruptedRoomClock,
  toDiagnosticPlaybackState,
  toDiagnosticSourceStartState
} from "@/features/room/playback/playback-barrier";
import {
  receiverBufferingGraceMs,
  receiverRecoveryRetryMs,
  recordReceiverAudioProgress,
  resolveReceiverPlaybackState,
  shouldRecoverStalledReceiverAudio
} from "@/features/room/playback/receiver-audio-health";
import {
  alignLocalAudioToRoom,
  isAudioPlaybackBlockedError,
  hasCurrentLocalAudio,
  isRecoverableLocalAudioError,
  localAudioSeekToleranceSeconds,
  resolveCacheReadinessReport,
  resolveLocalAudioTimelineKey,
  resolveLocalAudioTrackKey,
  resolveRemoteAudioTimelineKey,
  resolveRoomAudioPath,
  resolveRoomAudioPositionMs,
  resolveRoomProviderCachePlan,
  shouldDisableSourcePlayback,
  shouldSkipUnavailableStreamingTrack,
  shouldWaitForLocalAudioContext,
  waitForLocalAudioMetadata,
  type LocalAudioObjectUrl,
  type LocalAudioResolution,
  type LocalAudioResolutionStatus
} from "@/features/room/playback/room-audio-path";
import { resolveCurrentSourcePeerId } from "@/features/room/hooks/use-room-page-derived";

const mediaPlaybackCommitIntervalMs = 500;

export function useRoomSegmentedPlaybackRuntime(input: {
  roomSnapshot: RoomSnapshot | null;
  currentTrack: TrackMeta | null;
  peerId: string;
  isCurrentSource: boolean;
  audioRef: RefObject<HTMLAudioElement | null>;
  volume: number;
  audioUnlocked: boolean;
  setAudioUnlocked: Dispatch<SetStateAction<boolean>>;
  setLocalAudioStream: (
    stream: MediaStream | null,
    sourcePeerId: string | null,
    maxBitrateKbps?: number | null,
    mediaTrafficExpected?: boolean
  ) => void;
  setMediaPlaybackEnabled: (enabled: boolean) => void | Promise<void>;
  getPeerMediaState: (peerId: string) => {
    receiverTrackState: "none" | "live" | "ended" | "failed";
    receiverRtpActive?: boolean;
    remoteStream: MediaStream | null;
    remoteTrackId?: string | null;
  } | null;
  subscribeRemoteAudioTrack?: (listener: (payload: {
    peerId: string;
    stream: MediaStream;
    track: MediaStreamTrack;
  }) => void) => () => void;
  restartMediaPeer: (peerId: string, options?: { forceRecreate?: boolean }) => Promise<unknown>;
  onPlaybackEnded: () => void | Promise<void>;
  setMediaConnectionState: Dispatch<SetStateAction<"idle" | "connecting" | "live" | "buffering" | "reconnecting" | "failed">>;
  setSourceStartState: Dispatch<SetStateAction<"idle" | "awaiting-unlock" | "starting" | "live" | "failed">>;
  setLastSourceStartError: Dispatch<SetStateAction<string | null>>;
  setStatusMessage: (message: string) => void;
  recordPeerDiagnostic: PeerDiagnosticRecorder;
  audibleRef: MutableRefObject<boolean | null>;
  playbackReadiness: RoomPlaybackReadinessPayload[];
  publishPlaybackReadiness: (payload: RoomPlaybackReadinessInputPayload) => void;
  activeSessionId: string | null;
}) {
  const playbackStrategy = resolveRoomPlaybackStrategy(input.roomSnapshot?.room.roomType);
  const setStatusMessage = input.setStatusMessage;
  const onPlaybackEnded = input.onPlaybackEnded;
  const localPeerId = input.peerId;
  const roomSnapshot = input.roomSnapshot;
  const setLastSourceStartError = input.setLastSourceStartError;
  const setMediaConnectionState = input.setMediaConnectionState;
  const setSourceStartState = input.setSourceStartState;
  const setAudioUnlocked = input.setAudioUnlocked;
  const subscribeRemoteAudioTrack = input.subscribeRemoteAudioTrack;
  const [playbackPreferences, setPlaybackPreferences] = useState(
    () => getAppSettings().playback
  );

  useEffect(() => {
    const syncPlaybackPreferences = () => setPlaybackPreferences(getAppSettings().playback);
    syncPlaybackPreferences();
    window.addEventListener(appSettingsChangeEvent, syncPlaybackPreferences);
    window.addEventListener("storage", syncPlaybackPreferences);
    return () => {
      window.removeEventListener(appSettingsChangeEvent, syncPlaybackPreferences);
      window.removeEventListener("storage", syncPlaybackPreferences);
    };
  }, []);

  const {
    preventOfflineAutoLoad,
    streamingOnlyPlayback,
    fullyCachedPlayback,
    loudnessNormalization
  } = playbackPreferences;
  const [cacheRevision, setCacheRevision] = useState(0);
  const [localAudioPreloader] = useState(() => new RoomAudioPreloader((track) => {
    const source = resolveProviderTrackSource(track);
    return getRoomLocalAudioFile({
      trackId: track.id,
      fileHash: track.fileHash,
      title: track.title,
      mimeType: track.mimeType ?? "audio/mpeg",
      originalAssetId: track.originalAsset?.assetId ?? null,
      provider: source?.provider,
      providerTrackId: source?.trackId ?? null
    });
  }));
  useEffect(() => {
    const handleCacheInvalidate = () => {
      localAudioPreloader.clear();
      setCacheRevision((rev) => rev + 1);
    };
    const handleStorageRootChange = () => {
      failedLocalAudioKeysRef.current.clear();
      localAudioPreloader.clear();
      setCacheRevision((rev) => rev + 1);
    };
    window.addEventListener(cacheLibraryChangedEventName, handleCacheInvalidate);
    window.addEventListener(providerPlaybackCacheChangedEvent, handleCacheInvalidate);
    window.addEventListener(storageRootChangedEvent, handleStorageRootChange);
    return () => {
      window.removeEventListener(cacheLibraryChangedEventName, handleCacheInvalidate);
      window.removeEventListener(providerPlaybackCacheChangedEvent, handleCacheInvalidate);
      window.removeEventListener(storageRootChangedEvent, handleStorageRootChange);
    };
  }, [localAudioPreloader]);
  useEffect(() => {
    if (!input.roomSnapshot || streamingOnlyPlayback) {
      localAudioPreloader.update([]);
      return;
    }
    localAudioPreloader.update([
      ...(input.currentTrack ? [input.currentTrack] : []),
      ...getRoomQueuePreloadTracks(input.roomSnapshot)
    ]);
  }, [input.roomSnapshot, input.currentTrack, streamingOnlyPlayback, localAudioPreloader, cacheRevision]);
  useEffect(() => () => localAudioPreloader.update([]), [localAudioPreloader]);
  // Offline auto-cache prevention and stream-only playback take priority over
  // the provider-cache preference when multiple strategies are enabled.
  const sharedCacheEnabled = playbackStrategy.cache === "shared-library-and-provider";
  const segmentedStreamEnabled = playbackStrategy.stream === "segmented-opus-with-rtp-fallback";
  const providerCachePlan = resolveRoomProviderCachePlan({
    sharedCacheEnabled,
    segmentedStreamEnabled,
    streamingOnlyPlayback,
    fullyCachedPlayback,
    preventOfflineAutoLoad,
    isCurrentSource: input.isCurrentSource,
    roomSnapshot: input.roomSnapshot,
    track: input.currentTrack
  });
  const cacheBarrierEnabled = providerCachePlan.mode === "provider-cache";
  const localAudioTrackKey = resolveLocalAudioTrackKey(input.currentTrack);
  const [localAudioResolution, setLocalAudioResolution] = useState<LocalAudioResolution>({
    key: null,
    status: "idle",
    file: null,
    error: null
  });
  const [isPreparingProviderCache, setIsPreparingProviderCache] = useState(false);
  const [failedProviderCacheKey, setFailedProviderCacheKey] = useState<string | null>(null);
  const playbackBarrier = uninterruptedRoomClock;
  const readinessRoomId = input.roomSnapshot?.room.id;
  const readinessTrackId = input.roomSnapshot?.room.playback.currentTrackId ?? null;
  const readinessMediaEpoch = input.roomSnapshot?.room.playback.mediaEpoch ?? 0;
  const readinessPlaybackStatus = input.roomSnapshot?.room.playback.status;
  const readinessPlaybackRevision = input.roomSnapshot?.room.playback.playbackRevision ?? 0;
  const readinessActiveSessionId = input.activeSessionId;
  const readinessPeerId = input.peerId;
  const publishReadiness = input.publishPlaybackReadiness;
  const localAudioLoudness = localAudioResolution.key === localAudioTrackKey
    ? localAudioResolution.loudness
    : undefined;
  const loudnessGainDb = resolveLoudnessGainDb(
    input.currentTrack?.loudness
      ? input.currentTrack
      : localAudioLoudness
        ? { loudness: localAudioLoudness }
        : input.currentTrack,
    loudnessNormalization
  );
  const currentPlaybackAsset = resolveCurrentRoomPlaybackAsset(
    input.roomSnapshot,
    input.currentTrack
  );
  const currentLocalAudioAvailable = hasCurrentLocalAudio(
    localAudioResolution,
    localAudioTrackKey
  );
  const usesNativeLocalAudio = !streamingOnlyPlayback && currentLocalAudioAvailable;
  const nativeLocalAudioTimelineKey = useMemo(() => {
    const roomPlayback = input.roomSnapshot?.room.playback ?? null;
    return roomPlayback
      ? resolveLocalAudioTimelineKey(roomPlayback, playbackBarrier)
      : null;
  }, [input.roomSnapshot?.room.playback, playbackBarrier]);
  const runtimeInputRef = useRef({
    ...input,
    playbackAsset: null as TrackMeta["playbackAsset"] | null,
    streamingOnlyPlayback: false,
    usesNativeLocalAudio: false,
    isSourceMemberOffline: false,
    cacheBarrierEnabled: false,
    playbackBarrier,
    loudnessGainDb: 0,
    localAudioResolution: {
      key: null as string | null,
      status: "idle" as LocalAudioResolutionStatus,
      file: null as Blob | null,
      error: null as string | null
    } satisfies LocalAudioResolution
  });
  runtimeInputRef.current = {
    ...input,
    playbackAsset: currentPlaybackAsset,
    streamingOnlyPlayback,
    usesNativeLocalAudio,
    isSourceMemberOffline: providerCachePlan.isSourceMemberOffline,
    localAudioResolution,
    cacheBarrierEnabled,
    playbackBarrier,
    loudnessGainDb
  };
  const { audioRef, isCurrentSource, peerId: runtimePeerId } = input;
  const audioUnlocked = input.audioUnlocked;
  const missingMediaSinceRef = useRef<number | null>(null);
  const mediaEnsureKeyRef = useRef<string | null>(null);
  const lastMediaEnsureAtRef = useRef(0);
  const boundMediaKeyRef = useRef<string | null>(null);
  const lastSourceHealthRef = useRef<SegmentedPlaybackSnapshot["sourceHealth"]>(undefined);
  const receiverAudioHealthRef = useRef({
    boundAtMs: 0,
    lastProgressAtMs: 0,
    lastCurrentTime: null as number | null,
    hasStarted: false,
    waitingSinceMs: null as number | null,
    lastRecoveryAtMs: 0,
    recoveryCount: 0
  });
  const nativeAudioHealthRef = useRef({
    lastProgressAtMs: 0,
    lastCurrentTime: null as number | null,
    hasStarted: false
  });
  const localMediaBindingRef = useRef<string | null>(null);
  const localAudioObjectUrlRef = useRef<LocalAudioObjectUrl | null>(null);
  const localAudioReadyKeyRef = useRef<string | null>(null);
  const localAudioTimelineKeyRef = useRef<string | null>(null);
  // 元素已应用的最新时间线权威版本(playbackRevision 单调递增)。
  // 迟到/排队的旧快照比它旧时直接忽略,防止把刚播过的片段重seek回去重播。
  const localAudioAppliedRevisionRef = useRef<{ trackId: string; revision: number } | null>(null);
  const appliedPlaybackRevisionRef = useRef<{
    roomId: string;
    revision: number;
  } | null>(null);
  const nativeLocalAudioTimelineRef = useRef<string | null>(null);
  const remoteAudioTimelineKeyRef = useRef<string | null>(null);
  const skippedUnavailableStreamingTimelineRef = useRef<string | null>(null);
  const failedLocalAudioKeysRef = useRef<Set<string>>(new Set());
  const localAudioResolutionRef = useRef(localAudioResolution);
  localAudioResolutionRef.current = localAudioResolution;
  const syncMediaRef = useRef<(() => Promise<void>) | null>(null);
  const readinessPublishKeyRef = useRef<string | null>(null);
  const cacheBarrierParticipationRef = useRef(false);
  const roomId = input.roomSnapshot?.room.id ?? null;
  const [mediaPlayback, setMediaPlaybackState] = useState<SegmentedPlaybackSnapshot>(() => ({
    state: "idle",
    bufferedMs: 0,
    ownedUnitCount: 0,
    totalUnitCount: currentPlaybackAsset?.unitCount ?? 0,
    audioContextState: null,
    lastError: null
  }));
  const lastMediaPlaybackCommitAtRef = useRef(0);
  const mediaPlaybackRef = useRef(mediaPlayback);
  mediaPlaybackRef.current = mediaPlayback;

  const setMediaPlayback = useCallback((
    next: SetStateAction<SegmentedPlaybackSnapshot>
  ) => {
    const current = mediaPlaybackRef.current;
    const resolved = typeof next === "function" ? next(current) : next;
    mediaPlaybackRef.current = resolved;
    roomMediaPlaybackStore.setState(resolved);

    const immediate = current.state !== resolved.state ||
      current.playbackIdentity !== resolved.playbackIdentity ||
      current.audioContextState !== resolved.audioContextState ||
      current.sourceHealth !== resolved.sourceHealth ||
      current.lastError !== resolved.lastError ||
      current.lastDecodeError !== resolved.lastDecodeError;
    const now = Date.now();
    if (!immediate && now - lastMediaPlaybackCommitAtRef.current < mediaPlaybackCommitIntervalMs) {
      return;
    }
    lastMediaPlaybackCommitAtRef.current = now;
    setMediaPlaybackState(resolved);
  }, []);

  useEffect(() => {
    const roomPlayback = input.roomSnapshot?.room.playback;
    if (!shouldSkipUnavailableStreamingTrack({
      isCurrentSource: input.isCurrentSource,
      streamingOnlyPlayback,
      playback: roomPlayback,
      currentTrackId: input.currentTrack?.id,
      playbackAsset: currentPlaybackAsset
    })) {
      return;
    }

    const timelineKey = [
      input.roomSnapshot?.room.id,
      roomPlayback?.currentTrackId,
      roomPlayback?.mediaEpoch
    ].join(":");
    if (skippedUnavailableStreamingTimelineRef.current === timelineKey) {
      return;
    }
    skippedUnavailableStreamingTimelineRef.current = timelineKey;
    setStatusMessage(`《${input.currentTrack?.title ?? "当前歌曲"}》没有可用播放资产，已跳过。`);
    void onPlaybackEnded();
  }, [
    currentPlaybackAsset,
    input.currentTrack?.id,
    input.currentTrack?.title,
    input.isCurrentSource,
    input.roomSnapshot?.room.id,
    input.roomSnapshot?.room.playback,
    onPlaybackEnded,
    setStatusMessage,
    streamingOnlyPlayback
  ]);

  useEffect(() => {
    const track = input.currentTrack;
    if (!track || !localAudioTrackKey) {
      setLocalAudioResolution((current) => current.status === "idle" && current.key === null
        ? current
        : {
          key: null,
          status: "idle",
          file: null,
          loudness: undefined,
          error: null
        });
      return;
    }

    if (streamingOnlyPlayback) {
      setLocalAudioResolution((current) =>
        current.key === null && current.status === "missing" && current.file === null
          ? current
          : {
            key: null,
            status: "missing",
            file: null,
            loudness: undefined,
            error: null
          }
      );
      return;
    }

    if (failedLocalAudioKeysRef.current.has(localAudioTrackKey)) {
      setLocalAudioResolution({
        key: localAudioTrackKey,
        status: "missing",
        file: null,
        loudness: undefined,
        error: "本地音频文件不可播放。"
      });
      return;
    }

    const existingResolution = localAudioResolutionRef.current;
    if (
      existingResolution.key === localAudioTrackKey &&
      existingResolution.status === "available" &&
      existingResolution.file !== null
    ) {
      return;
    }

    let cancelled = false;
    const loudnessController = new AbortController();
    // Do not flip an already-resolved key back to "checking". That briefly
    // cleared the source media fanout on every redundant effect re-run.
    setLocalAudioResolution((current) => {
      if (
        current.key === localAudioTrackKey &&
        (current.status === "available" || current.status === "missing")
      ) {
        return current;
      }
      return {
        key: localAudioTrackKey,
        status: "checking",
        file: null,
        loudness: undefined,
        error: null
      };
    });
    void localAudioPreloader.get(track).then((file) => {
      if (cancelled) return;
      setLocalAudioResolution({
        key: localAudioTrackKey,
        status: file ? "available" : "missing",
        file,
        ...(track.loudness ? { loudness: track.loudness } : {}),
        error: null
      });
      if (!track.loudness && file) {
        void analyzeAudioBlobLoudness(file, {
          cacheKey: track.fileHash,
          signal: loudnessController.signal
        }).then((loudness) => {
          if (cancelled || !loudness) return;
          setLocalAudioResolution((current) => current.key === localAudioTrackKey
            ? { ...current, loudness }
            : current);
        });
      }
    }).catch((error) => {
      if (cancelled) return;
      setLocalAudioResolution({
        key: localAudioTrackKey,
        status: "missing",
        file: null,
        error: error instanceof Error && error.message.trim()
          ? error.message
          : "本地音频文件读取失败。"
      });
    });

    return () => {
      cancelled = true;
      loudnessController.abort();
    };
  }, [
    // currentTrack identity is stabilized by resolveStableCurrentTrack; keep it
    // in the dep list for exhaustive-deps without re-adding isCurrentSource,
    // which previously forced unnecessary "checking" resets.
    input.currentTrack,
    input.currentTrack?.fileHash,
    input.currentTrack?.id,
    input.currentTrack?.mimeType,
    input.currentTrack?.originalAsset?.assetId,
    input.currentTrack?.title,
    localAudioTrackKey,
    localAudioPreloader,
    streamingOnlyPlayback,
    cacheRevision
  ]);

  const providerCacheAttemptKey =
    providerCachePlan.mode !== "none" &&
    providerCachePlan.source &&
    localAudioTrackKey &&
    roomId
      ? [
          roomId,
          input.currentTrack?.id ?? "none",
          readinessMediaEpoch,
          localAudioTrackKey,
          providerCachePlan.mode
        ].join(":")
      : null;
  const providerCacheFailed =
    providerCacheAttemptKey !== null && failedProviderCacheKey === providerCacheAttemptKey;
  const providerCacheSourceProvider = providerCachePlan.source?.provider ?? null;
  const providerCacheSourceTrackId = providerCachePlan.source?.trackId ?? null;
  const providerCacheSourceLabel = providerCachePlan.source?.label ?? null;

  useEffect(() => {
    const snapshot = runtimeInputRef.current.roomSnapshot;
    const track = runtimeInputRef.current.currentTrack;
    if (
      !providerCacheAttemptKey ||
      !snapshot ||
      !track ||
      !localAudioTrackKey ||
      !providerCacheSourceProvider ||
      !providerCacheSourceTrackId ||
      !providerCacheSourceLabel ||
      providerCacheFailed ||
      failedLocalAudioKeysRef.current.has(localAudioTrackKey)
    ) {
      setIsPreparingProviderCache(false);
      return;
    }

    if (
      localAudioResolution.key !== localAudioTrackKey ||
      localAudioResolution.status !== "missing"
    ) {
      setIsPreparingProviderCache(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const activeAttemptKey = providerCacheAttemptKey;
    setIsPreparingProviderCache(true);

    void ensureOfflineProviderPlaybackAsset({
      roomSnapshot: snapshot,
      track,
      source: {
        provider: providerCacheSourceProvider,
        trackId: providerCacheSourceTrackId,
        label: providerCacheSourceLabel
      },
      forceDownload: providerCachePlan.mode === "provider-cache",
      onStatus: (message) => {
        if (!cancelled) {
          setStatusMessage(message);
        }
      },
      signal: controller.signal
    })
      .then((result) => {
        if (cancelled) return;
        setIsPreparingProviderCache(false);
        if (!result.file) {
          setFailedProviderCacheKey(activeAttemptKey);
          return;
        }
        setLocalAudioResolution({
          key: localAudioTrackKey,
          status: "available",
          file: result.file,
          ...(track.loudness
            ? { loudness: track.loudness }
            : result.loudness
              ? { loudness: result.loudness }
              : {}),
          error: null
        });
        if (!track.loudness && !result.loudness) {
          void analyzeAudioBlobLoudness(result.file, {
            cacheKey: track.fileHash,
            signal: controller.signal
          }).then((loudness) => {
            if (cancelled || !loudness) return;
            setLocalAudioResolution((current) =>
              current.key === localAudioTrackKey ? { ...current, loudness } : current
            );
          });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setIsPreparingProviderCache(false);
        setFailedProviderCacheKey(activeAttemptKey);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    localAudioResolution.key,
    localAudioResolution.status,
    localAudioTrackKey,
    providerCacheAttemptKey,
    providerCacheFailed,
    providerCachePlan.mode,
    providerCacheSourceLabel,
    providerCacheSourceProvider,
    providerCacheSourceTrackId,
    setStatusMessage
  ]);

  const cacheAttemptPending =
    isPreparingProviderCache ||
    (providerCachePlan.mode === "provider-cache" &&
      localAudioResolution.key === localAudioTrackKey &&
      localAudioResolution.status === "missing" &&
      !providerCacheFailed);

  useEffect(() => {
    const trackId = readinessTrackId;
    const mediaEpoch = readinessMediaEpoch;
    const cacheRequested = cacheBarrierEnabled && !!trackId;
    if (!readinessRoomId || !readinessActiveSessionId || !readinessPeerId) {
      return;
    }

    // Normal playback does not participate in the cache readiness barrier.
    // Send one leave notification when the setting is turned off, then stop
    // readiness traffic; room-wide hold/resume events remain observable.
    if (!cacheRequested) {
      if (cacheBarrierParticipationRef.current) {
        publishReadiness({
          roomId: readinessRoomId,
          sessionId: readinessActiveSessionId,
          peerId: readinessPeerId,
          trackId,
          mediaEpoch,
          cacheEnabled: false,
          state: "ready"
        });
      }
      cacheBarrierParticipationRef.current = false;
      readinessPublishKeyRef.current = null;
      return;
    }

    const localReady = currentLocalAudioAvailable;
    const report = resolveCacheReadinessReport({
      cacheRequested,
      localReady,
      cacheAttemptPending,
      localAudioStatus: localAudioResolution.status
    });
    cacheBarrierParticipationRef.current = report.cacheEnabled;
    const key = [
      readinessRoomId ?? "none",
      trackId ?? "none",
      mediaEpoch,
      readinessPlaybackRevision,
      report.cacheEnabled,
      report.state
    ].join(":");
    const payload: RoomPlaybackReadinessInputPayload = {
      roomId: readinessRoomId,
      sessionId: readinessActiveSessionId,
      peerId: readinessPeerId,
      trackId,
      mediaEpoch,
      cacheEnabled: report.cacheEnabled,
      state: report.state
    };
    if (readinessPublishKeyRef.current !== key) {
      readinessPublishKeyRef.current = key;
      publishReadiness(payload);
    }
    const interval = window.setInterval(
      () => publishReadiness(payload),
      4_000
    );
    return () => window.clearInterval(interval);
  }, [
    cacheBarrierEnabled,
    cacheAttemptPending,
    readinessActiveSessionId,
    readinessPeerId,
    publishReadiness,
    readinessRoomId,
    readinessTrackId,
    readinessMediaEpoch,
    readinessPlaybackStatus,
    readinessPlaybackRevision,
    localAudioResolution.status,
    currentLocalAudioAvailable
  ]);

  const ensureListenerMediaConnection = useCallback((input: {
    runtime: typeof runtimeInputRef.current;
    sourcePeerId: string;
    trackId: string;
    mediaEpoch: number;
    forceRecreate?: boolean;
    forceRecovery?: boolean;
  }) => {
    const recoveryKey = `${input.sourcePeerId}:${input.trackId}:${input.mediaEpoch}`;
    if (mediaEnsureKeyRef.current !== recoveryKey) {
      mediaEnsureKeyRef.current = recoveryKey;
      lastMediaEnsureAtRef.current = 0;
    }
    const now = Date.now();
    // Missing-track recovery stays one-shot. A stalled clock is different:
    // the old track can remain live after a soft recovery fails, so permit a
    // bounded retry while keeping the UI and signaling path rate-limited.
    if (
      mediaEnsureKeyRef.current === recoveryKey &&
      lastMediaEnsureAtRef.current > 0 &&
      (!input.forceRecovery || now - lastMediaEnsureAtRef.current < receiverRecoveryRetryMs)
    ) {
      return;
    }
    lastMediaEnsureAtRef.current = now;
    const remote = input.runtime.getPeerMediaState(input.sourcePeerId);
    const hasLiveReceiver = remote?.receiverTrackState === "live" && !!remote.remoteStream;
    const hasRecentReceiverRtp = hasLiveReceiver && remote?.receiverRtpActive === true;
    if (hasRecentReceiverRtp && !input.forceRecovery && !input.forceRecreate) {
      return;
    }
    input.runtime.setMediaConnectionState("reconnecting");
    input.runtime.recordPeerDiagnostic({
      peerId: input.sourcePeerId,
      channelKind: "media",
      direction: "local",
      event: "listener-media-ensure",
      summary: `监听端媒体连接或接收轨道缺失，确保媒体连接（${input.trackId}）`,
      level: "warning"
    });
    void input.runtime.restartMediaPeer(input.sourcePeerId, {
      // Never force-recreate from the poll path. Force recreate is reserved for
      // explicit source-side wedged-sender recovery and races empty media offers.
      forceRecreate: input.forceRecreate === true
    }).catch((error) => {
      if (mediaEnsureKeyRef.current === recoveryKey) {
        // A rejected request did not reach the lifecycle manager, so a later
        // poll may try again. A completed request stays latched until a live
        // receiver arrives or the room switches to a new media timeline.
        lastMediaEnsureAtRef.current = 0;
      }
      input.runtime.recordPeerDiagnostic({
        peerId: input.sourcePeerId,
        channelKind: "media",
        direction: "local",
        event: "listener-media-ensure-failed",
        summary: `监听端媒体连接确保失败：${String(error)}`,
        level: "error"
      });
    });
  }, []);

  const clearLocalAudioSource = useCallback((audio: HTMLAudioElement | null) => {
    // Disconnect before changing src. MediaElementAudioSourceNode is tied to
    // the element for the lifetime of the AudioContext; leaving the graph
    // connected across a failed decode or track switch can strand the next
    // source or keep stale audio flowing into the room broadcast.
    roomAudioOutput.unbindLocalAudioElement(audio);
    if (audio) {
      try {
        audio.pause();
        audio.srcObject = null;
        audio.removeAttribute("src");
        audio.load();
      } catch {
        // Media element cleanup is best effort during room transitions.
      }
    }

    const objectUrl = localAudioObjectUrlRef.current?.url;
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
    localAudioObjectUrlRef.current = null;
    localAudioReadyKeyRef.current = null;
    localAudioTimelineKeyRef.current = null;
  }, []);

  const markLocalAudioUnavailable = useCallback((key: string, error: string) => {
    failedLocalAudioKeysRef.current.add(key);
    setLocalAudioResolution((current) => current.key === key
      ? {
        key,
        status: "missing",
        file: null,
        error
      }
      : current);
  }, []);

  const playback = useSegmentedOpusPlayback({
    roomSnapshot: input.roomSnapshot,
    currentTrack: input.currentTrack,
    playbackAsset: currentPlaybackAsset,
    peerId: input.peerId,
    isCurrentSource: input.isCurrentSource,
    disableSourcePlayback: shouldDisableSourcePlayback({
      isCurrentSource: input.isCurrentSource,
      localAudioStatus: usesNativeLocalAudio ? "available" : "missing"
    }) || playbackBarrier.blocked,
    playbackBarrier,
    volume: input.volume,
    loudnessGainDb,
    audioUnlocked: input.audioUnlocked,
  });
  const usesSegmentedPlayback = input.isCurrentSource && !usesNativeLocalAudio;
  const visiblePlayback = usesSegmentedPlayback ? playback : mediaPlayback;

  useEffect(() => {
    roomMediaPlaybackStore.setState(visiblePlayback);
  }, [visiblePlayback]);

  useEffect(() => {
    if (readinessPlaybackStatus === "playing" && !playbackBarrier.blocked) {
      return;
    }
    audioRef.current?.pause();
  }, [
    audioRef,
    readinessPlaybackStatus,
    playbackBarrier.blocked
  ]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    roomAudioOutput.applyVolume({
      localAudio: audio,
      volume: input.volume,
      loudnessGainDb
    });
  }, [audioRef, input.volume, loudnessGainDb]);

  useEffect(() => {
    if (!usesNativeLocalAudio) {
      nativeLocalAudioTimelineRef.current = null;
      return;
    }

    const previousTimelineKey = nativeLocalAudioTimelineRef.current;
    nativeLocalAudioTimelineRef.current = nativeLocalAudioTimelineKey;
    if (
      previousTimelineKey !== null &&
      previousTimelineKey !== nativeLocalAudioTimelineKey
    ) {
      // Seeking keeps the room status as "playing" while the server assigns
      // a new clock anchor. Only a real timeline replacement may interrupt
      // the cached element; playbackRevision updates are routine sync data.
      audioRef.current?.pause();
    }
  }, [
    audioRef,
    usesNativeLocalAudio,
    nativeLocalAudioTimelineKey
  ]);

  useEffect(() => {
    if (usesNativeLocalAudio) {
      return;
    }

    const binding = localMediaBindingRef.current;
    const hasLocalAudioSource = !!localAudioObjectUrlRef.current ||
      binding?.startsWith("listener:local:") ||
      binding?.startsWith("source:local:");
    if (!hasLocalAudioSource) {
      return;
    }

    clearLocalAudioSource(audioRef.current);
    localMediaBindingRef.current = null;
  }, [audioRef, clearLocalAudioSource, usesNativeLocalAudio]);

  useEffect(() => {
    const runtime = runtimeInputRef.current;
    const roomPlayback = runtime.roomSnapshot?.room.playback ?? null;
    const sourcePeerId = resolveCurrentSourcePeerId(runtime.roomSnapshot, roomPlayback);
    const remote = sourcePeerId ? runtime.getPeerMediaState(sourcePeerId) : null;
    const usesNativeLocalAudio = runtime.usesNativeLocalAudio;
    const usesLocalAudio = !runtime.isCurrentSource && usesNativeLocalAudio;
    const usesSegmentedPlayback = runtime.isCurrentSource && !usesNativeLocalAudio;
    const visiblePlayback = usesSegmentedPlayback ? playback : mediaPlayback;
    const mediaSession =
      roomPlayback?.currentTrackId && runtime.playbackAsset
        ? createPlaybackMediaSession({
          trackId: roomPlayback.currentTrackId,
          playbackAssetId: runtime.playbackAsset.assetId,
          playback: roomPlayback,
          sourcePeerId,
          outputTrackId: runtime.isCurrentSource ? roomAudioOutput.getBroadcastTrackId() : null,
          remoteTrackId: usesLocalAudio ? null : remote?.remoteTrackId ?? null
        })
        : null;
    const playbackState = toDiagnosticPlaybackState(visiblePlayback.state);
    const isAudible = isSegmentedPlaybackAudible({
      state: visiblePlayback.state,
      isCurrentSource: runtime.isCurrentSource,
      sourceHealth: visiblePlayback.sourceHealth,
      nativeLocalAudio: usesNativeLocalAudio
    });
    runtime.audibleRef.current = isAudible;
    const isRecovering = visiblePlayback.state === "buffering" ||
      visiblePlayback.sourceHealth === "source-underrun" ||
      visiblePlayback.sourceHealth === "source-silent";

    runtime.recordPeerDiagnostic({
      peerId: "system",
      channelKind: "system",
      direction: "local",
      event: "segmented-playback-status",
      summary: "Segmented Opus playback status updated",
      recordEvent: false,
      update: (snapshot) => ({
        ...snapshot,
        segmentedPlaybackStatus: {
          playbackAssetId: runtime.playbackAsset?.assetId ?? null,
          mediaSessionKey: mediaSession?.sessionKey ?? null,
          sourcePeerId,
          isSourceOwner: runtime.isCurrentSource,
          listenerPlaybackState: playbackState,
          sourceStartState: toDiagnosticSourceStartState(visiblePlayback.state),
          audioContextState: visiblePlayback.audioContextState,
          outputTrackId: mediaSession?.outputTrackId ?? null,
          remoteTrackId: mediaSession?.remoteTrackId ?? null,
          bufferedAheadMs: usesSegmentedPlayback ? visiblePlayback.bufferedMs : 0,
          scheduledAheadMs: usesSegmentedPlayback ? visiblePlayback.bufferedMs : 0,
          underrunCount: visiblePlayback.underrunCount ?? 0,
          lastUnderrunAt: visiblePlayback.lastUnderrunAt ?? null,
          decodedPeak: usesSegmentedPlayback ? visiblePlayback.decodedPeak ?? null : null,
          decodedRms: usesSegmentedPlayback ? visiblePlayback.decodedRms ?? null : null,
          lastDecodeError: visiblePlayback.lastDecodeError ?? visiblePlayback.lastError,
          mediaRecoveryState: visiblePlayback.state === "unavailable"
            ? "failed"
            : isRecovering
              ? "recovering"
              : visiblePlayback.state === "live"
                ? "reconnected"
                : "idle"
        }
      })
    });
  }, [
    input.currentTrack?.id,
    currentPlaybackAsset?.assetId,
    input.isCurrentSource,
    input.peerId,
    input.roomSnapshot?.room.id,
    input.recordPeerDiagnostic,
    localAudioResolution.status,
    mediaPlayback.audioContextState,
    mediaPlayback.bufferedMs,
    mediaPlayback.lastError,
    mediaPlayback.state,
    mediaPlayback,
    playback.audioContextState,
    playback.bufferedMs,
    playback.decodedPeak,
    playback.decodedRms,
    playback.lastDecodeError,
    playback.lastError,
    playback.lastUnderrunAt,
    playback.sourceHealth,
    playback.state,
    playback.underrunCount,
    playback
  ]);

  useEffect(() => {
    let cancelled = false;
    const runSyncMedia = async () => {
      const runtime = runtimeInputRef.current;
      const roomPlayback = runtime.roomSnapshot?.room.playback ?? null;
      const roomId = runtime.roomSnapshot?.room.id ?? null;
      if (roomPlayback && roomId) {
        const incomingRevision = Math.floor(
          roomPlayback.playbackRevision ?? roomPlayback.queueVersion ?? 0
        );
        const appliedRevision = appliedPlaybackRevisionRef.current;
        if (
          appliedRevision &&
          appliedRevision.roomId === roomId &&
          incomingRevision < appliedRevision.revision
        ) {
          return;
        }
        appliedPlaybackRevisionRef.current = {
          roomId,
          revision: Math.max(appliedRevision?.revision ?? incomingRevision, incomingRevision)
        };
      }
      const operationTimelineKey = roomPlayback
        ? resolveLocalAudioTimelineKey(roomPlayback, runtime.playbackBarrier)
        : null;
      const sourcePeerId = resolveCurrentSourcePeerId(runtime.roomSnapshot, roomPlayback);
      const bitrateKbps = runtime.playbackAsset
        ? preferredAudioRtpBitrateKbps
        : null;
      const audio = audioRef.current;

      // A seek is first published as a pending timeline with no clock anchor.
      // Do not start either the original local element or the remote stream
      // against that optimistic state. Waiting for the authoritative anchor
      // prevents the old segment and the seek target from both being audible.
      const awaitingAuthoritativeTimeline = roomPlayback?.status === "playing" &&
        roomPlayback.currentTrackId === runtime.currentTrack?.id &&
        roomPlayback.startAt === null &&
        roomPlayback.startedAt === null;
      if (awaitingAuthoritativeTimeline) {
        if (audio) {
          // A seek creates a hard timeline boundary. Keeping the old remote
          // MediaStream attached lets its jitter buffer drain after the
          // authoritative clock arrives, replaying a fragment from before the
          // seek. Detach only the element; the media PeerConnection remains
          // alive and the confirmed timeline binds the same track again.
          audio.pause();
          if (!runtime.isCurrentSource && audio.srcObject) {
            audio.srcObject = null;
            boundMediaKeyRef.current = null;
            remoteAudioTimelineKeyRef.current = null;
            receiverAudioHealthRef.current = {
              boundAtMs: 0,
              lastProgressAtMs: 0,
              lastCurrentTime: null,
              hasStarted: false,
              waitingSinceMs: null,
              lastRecoveryAtMs: 0,
              recoveryCount: 0
            };
          }
        }
        runtime.setLocalAudioStream(
          runtime.isCurrentSource ? roomAudioOutput.getBroadcastStream() : null,
          runtime.isCurrentSource ? runtime.peerId : sourcePeerId,
          runtime.isCurrentSource ? bitrateKbps : null,
          false
        );
        if (!cancelled) {
          setMediaPlayback({
            state: "buffering",
            bufferedMs: 0,
            ownedUnitCount: 0,
            totalUnitCount: runtime.playbackAsset?.unitCount ?? 0,
            audioContextState: roomAudioOutput.getSharedAudioContext()?.state ?? null,
            lastError: "正在等待进度调整同步确认。"
          });
        }
        return;
      }

      if (runtime.isCurrentSource && !runtime.usesNativeLocalAudio) {
        const hasActiveRoomTrack = roomPlayback?.status === "playing" &&
          roomPlayback.currentTrackId === runtime.currentTrack?.id;
        if (runtime.streamingOnlyPlayback && hasActiveRoomTrack && !runtime.playbackAsset) {
          runtime.setMediaPlaybackEnabled(false);
          runtime.setLocalAudioStream(null, null, null, false);
          if (!cancelled) {
            setMediaPlayback({
              state: "unavailable",
              bufferedMs: 0,
              ownedUnitCount: 0,
              totalUnitCount: 0,
              audioContextState: roomAudioOutput.getSharedAudioContext()?.state ?? null,
              lastError: "当前歌曲缺少匹配的曲库播放资产，无法进行流式播放。"
            });
          }
          return;
        }
        runtime.setMediaPlaybackEnabled(true);
        missingMediaSinceRef.current = null;
        mediaEnsureKeyRef.current = null;
        boundMediaKeyRef.current = null;
        remoteAudioTimelineKeyRef.current = null;
        if (
          localAudioObjectUrlRef.current ||
          localMediaBindingRef.current?.endsWith(":local") ||
          localMediaBindingRef.current?.startsWith("listener:local:") ||
          localMediaBindingRef.current?.startsWith("source:local:")
        ) {
          roomAudioOutput.unbindLocalAudioElement(audio);
          clearLocalAudioSource(audio);
          localMediaBindingRef.current = null;
        }
        // The segmented engine is the continuity path while a local file is
        // being checked, downloaded, or rejected. Keep the source identity
        // stable and expose its broadcast destination as soon as the engine
        // creates it; clearing it here makes every listener wait for a new
        // media track during a normal cache transition.
        const sourceStream = roomPlayback?.currentTrackId === runtime.currentTrack?.id
          ? roomAudioOutput.getBroadcastStream()
          : null;
        const sourcePeerId = roomPlayback?.currentTrackId === runtime.currentTrack?.id
          ? runtime.peerId
          : null;
        runtime.setLocalAudioStream(
          sourceStream,
          sourcePeerId,
          sourcePeerId ? bitrateKbps : null,
          runtime.audibleRef.current === true
        );
        if (!cancelled) {
          setMediaPlayback({
            state: roomPlayback?.status === "playing" ? "buffering" : "paused",
            bufferedMs: 0,
            ownedUnitCount: 0,
            totalUnitCount: runtime.playbackAsset?.unitCount ?? 0,
            audioContextState: roomAudioOutput.getSharedAudioContext()?.state ?? null,
            lastError: null
          });
        }
        return;
      }

      const localAudio = runtime.usesNativeLocalAudio
        ? runtime.localAudioResolution.file
        : null;
      const localAudioKey = runtime.localAudioResolution.key;
      if (localAudio && localAudioKey) {
        runtime.setMediaPlaybackEnabled(runtime.isCurrentSource);
        const totalUnitCount = runtime.playbackAsset?.unitCount ?? 0;
        const hasActiveTimeline = roomPlayback?.currentTrackId === runtime.currentTrack?.id;
        missingMediaSinceRef.current = null;
        mediaEnsureKeyRef.current = null;
        boundMediaKeyRef.current = null;
        remoteAudioTimelineKeyRef.current = null;
        const localBindingKey = `${runtime.isCurrentSource ? "source" : "listener"}:local:${localAudioKey}`;
        if (localMediaBindingRef.current !== localBindingKey) {
          localMediaBindingRef.current = localBindingKey;
        }

        if (!audio || !hasActiveTimeline) {
          // A source keeps its media peer while actively playing. Clearing the
          // source stream before every local-file sync tick releases the media
          // topology and makes seek/playback look like a reconnect loop.
          runtime.setLocalAudioStream(null, null, null, false);
          if (audio) {
            audio.pause();
            audio.srcObject = null;
            if (runtime.isCurrentSource) {
              roomAudioOutput.unbindLocalAudioElement(audio);
            }
            if (localAudioObjectUrlRef.current) {
              clearLocalAudioSource(audio);
            }
          }
          if (!cancelled) {
            setMediaPlayback({
              state: roomPlayback ? "paused" : "idle",
              bufferedMs: 0,
              ownedUnitCount: 0,
              totalUnitCount,
              audioContextState: roomAudioOutput.getSharedAudioContext()?.state ?? null,
              lastError: null
            });
          }
          return;
        }

        try {
          const isCurrentLocalAudioRequest = () => {
            const current = runtimeInputRef.current;
            const currentPlayback = current.roomSnapshot?.room.playback ?? null;
            return !cancelled &&
              current.currentTrack?.id === runtime.currentTrack?.id &&
              current.localAudioResolution.key === localAudioKey &&
              current.usesNativeLocalAudio &&
              current.localAudioResolution.file === localAudio &&
              currentPlayback !== null &&
              resolveLocalAudioTimelineKey(
                currentPlayback,
                current.playbackBarrier
              ) === operationTimelineKey;
          };
          if (audio.srcObject) {
            audio.pause();
            audio.srcObject = null;
          }
          if (localAudioObjectUrlRef.current?.key !== localAudioKey) {
            clearLocalAudioSource(audio);
            localAudioObjectUrlRef.current = {
              key: localAudioKey,
              url: URL.createObjectURL(localAudio)
            };
          }
          const objectUrl = localAudioObjectUrlRef.current?.url;
          if (!objectUrl) {
            throw new Error("本地音频对象地址创建失败。");
          }
          if (audio.src !== objectUrl) {
            audio.pause();
            audio.preload = "auto";
            audio.src = objectUrl;
            localAudioReadyKeyRef.current = null;
            localAudioTimelineKeyRef.current = null;
            nativeAudioHealthRef.current = {
              lastProgressAtMs: 0,
              lastCurrentTime: null,
              hasStarted: false
            };
            const metadataReady = waitForLocalAudioMetadata(audio);
            audio.load();
            await metadataReady;
            if (!isCurrentLocalAudioRequest()) return;
            localAudioReadyKeyRef.current = localAudioKey;
          } else if (localAudioReadyKeyRef.current !== localAudioKey) {
            const metadataReady = waitForLocalAudioMetadata(audio);
            audio.load();
            await metadataReady;
            if (!isCurrentLocalAudioRequest()) return;
            localAudioReadyKeyRef.current = localAudioKey;
          }

          if (!isCurrentLocalAudioRequest()) return;
          const activeRuntime = runtimeInputRef.current;
          const activeRoomPlayback = activeRuntime.roomSnapshot?.room.playback ?? null;
          if (
            !activeRoomPlayback ||
            activeRoomPlayback.currentTrackId !== activeRuntime.currentTrack?.id
          ) {
            return;
          }
          if (audio.error) {
            throw new Error("本地音频文件无法解码。");
          }

          const timelineKey = resolveLocalAudioTimelineKey(
            activeRoomPlayback,
            activeRuntime.playbackBarrier
          );
          // 单调性守卫:进入房间后,entry 期间排队的旧同步可能在 resume 之后才落地;
          // 它携带的 playbackRevision 比元素已应用的更旧,若执行会把 currentTime
          // 回卷到已播位置,造成“同一片段播放两次”。直接忽略过期快照。
          const incomingRevision = Math.floor(activeRoomPlayback.playbackRevision ?? 0);
          const applied = localAudioAppliedRevisionRef.current;
          if (applied && applied.trackId === activeRoomPlayback.currentTrackId) {
            if (incomingRevision < applied.revision) {
              return;
            }
          }
          localAudioAppliedRevisionRef.current = {
            trackId: activeRoomPlayback.currentTrackId ?? "",
            revision: incomingRevision
          };
          const targetPositionMs = resolveRoomAudioPositionMs(
            activeRoomPlayback,
            getRoomPlaybackClockNowMs(),
            activeRuntime.playbackBarrier
          );
          const elementDurationSeconds = Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration
            : Math.max(0, (activeRuntime.currentTrack?.durationMs ?? 0) / 1000);
          const targetSeconds = elementDurationSeconds > 0
            ? Math.min(targetPositionMs / 1000, Math.max(0, elementDurationSeconds - 0.05))
            : targetPositionMs / 1000;
          const shouldForceSync = localAudioTimelineKeyRef.current !== timelineKey;
          if (
            shouldForceSync ||
            !Number.isFinite(audio.currentTime) ||
            Math.abs(audio.currentTime - targetSeconds) >= localAudioSeekToleranceSeconds
          ) {
            if (shouldForceSync) {
              audio.pause();
            }
            audio.currentTime = Math.max(0, targetSeconds);
          }
          localAudioTimelineKeyRef.current = timelineKey;

          if (activeRoomPlayback.status !== "playing") {
            // Pause the local timeline without tearing down the source's RTP
            // topology. The destination track remains live and carries
            // silence while the local element is paused, so resume/seek can
            // reuse the same ICE/DTLS session and receiver jitter buffer.
            const sourceBroadcastStream = activeRuntime.isCurrentSource
              ? roomAudioOutput.getBroadcastStream()
              : null;
            const activeMediaSourcePeerId = activeRuntime.isCurrentSource
              ? activeRuntime.peerId
              : null;
            activeRuntime.setLocalAudioStream(
              sourceBroadcastStream,
              activeMediaSourcePeerId,
              activeRuntime.isCurrentSource ? bitrateKbps : null,
              false
            );
            audio.pause();
            if (!cancelled) {
              setMediaPlayback({
                state: "paused",
                bufferedMs: 0,
                ownedUnitCount: 0,
                totalUnitCount,
                audioContextState: roomAudioOutput.getSharedAudioContext()?.state ?? null,
                lastError: null
              });
            }
            return;
          }

          const audioContextState = roomAudioOutput.getSharedAudioContext()?.state ?? null;
          let sourceBroadcastStream: MediaStream | null = null;
          if (activeRuntime.isCurrentSource) {
            sourceBroadcastStream = roomAudioOutput.bindLocalAudioElement(audio, {
              loudnessGainDb: activeRuntime.loudnessGainDb,
              broadcast: true,
              volume: activeRuntime.volume
            });
          } else if (
            roomAudioOutput.hasLocalAudioElementSource(audio) ||
            (activeRuntime.loudnessGainDb !== 0 && audioContextState === "running")
          ) {
            // A MediaElementAudioSourceNode permanently takes over the
            // element's output. Reuse it when normalization is active and running,
            // but leave a default listener on native media output so a cache
            // transition cannot strand the element in a disconnected or suspended graph.
            roomAudioOutput.bindLocalAudioElement(audio, {
              broadcast: false,
              loudnessGainDb: activeRuntime.loudnessGainDb,
              volume: activeRuntime.volume
            });
          }
          if (activeRuntime.isCurrentSource && !sourceBroadcastStream) {
            roomAudioOutput.unbindLocalAudioElement(audio);
            throw new Error("本地音频无法连接到房间广播音频图。");
          }
          const activeMediaSourcePeerId = activeRuntime.isCurrentSource
            ? activeRuntime.peerId
            : null;
          activeRuntime.setLocalAudioStream(
            sourceBroadcastStream,
            activeMediaSourcePeerId,
            activeRuntime.playbackAsset
              ? preferredAudioRtpBitrateKbps
              : null,
            activeRuntime.audibleRef.current === true
          );

          if (shouldWaitForLocalAudioContext({
            isCurrentSource: activeRuntime.isCurrentSource,
            audioUnlocked: activeRuntime.audioUnlocked,
            audioContextState
          })) {
            if (!cancelled) {
              setMediaPlayback({
                state: "awaiting-unlock",
                bufferedMs: 0,
                ownedUnitCount: 0,
                totalUnitCount,
                audioContextState,
                lastError: null
              });
            }
            return;
          }

          if (audio.ended && elementDurationSeconds > 0 && targetSeconds >= elementDurationSeconds - 0.1) {
            audio.pause();
            if (!cancelled) {
              setMediaPlayback({
                state: "paused",
                bufferedMs: 0,
                ownedUnitCount: 0,
                totalUnitCount,
                audioContextState,
                lastError: null
              });
            }
            return;
          }

          const alignCurrentLocalAudio = (force: boolean) => {
            if (!isCurrentLocalAudioRequest()) return;
            const current = runtimeInputRef.current;
            const playback = current.roomSnapshot!.room.playback;
            alignLocalAudioToRoom(audio, playback, {
              force,
              durationMs: current.currentTrack?.durationMs
            });
          };
          const result = await roomAudioOutput.playElement(audio, {
            // AudioContext resume can be asynchronous. Check again directly
            // before element.play() so a pause or seek cannot revive this old
            // local-cache request after the room timeline has moved on.
            isCurrent: isCurrentLocalAudioRequest,
            beforePlay: () => alignCurrentLocalAudio(true)
          });
          if (!isCurrentLocalAudioRequest()) {
            if (
              localAudioObjectUrlRef.current?.key === localAudioKey &&
              audio.src === objectUrl
            ) {
              audio.pause();
            }
            return;
          }
          if (!result.ok) {
            if (isAudioPlaybackBlockedError(result.error)) {
              setAudioUnlocked(false);
              setMediaPlayback({
                state: "awaiting-unlock",
                bufferedMs: 0,
                ownedUnitCount: 0,
                totalUnitCount,
                audioContextState: roomAudioOutput.getSharedAudioContext()?.state ?? null,
                lastError: result.error
              });
              return;
            }
            if (isRecoverableLocalAudioError(result.error)) {
              // A source switch or a competing media-element operation can
              // interrupt play(). Keep the resolved file and retry on the
              // next sync tick instead of poisoning this cache key until the
              // user re-enters the room.
              localAudioReadyKeyRef.current = localAudioKey;
              setMediaPlayback({
                state: "buffering",
                bufferedMs: 0,
                ownedUnitCount: 0,
                totalUnitCount,
                audioContextState: roomAudioOutput.getSharedAudioContext()?.state ?? null,
                lastError: result.error
              });
              return;
            }
            markLocalAudioUnavailable(localAudioKey, result.error ?? "本地音频播放失败。");
            clearLocalAudioSource(audio);
            return;
          }

          // Decode/buffering can continue after play() is requested. Catch up
          // to the room clock, not the position captured before that wait.
          alignCurrentLocalAudio(false);
          if (!activeRuntime.audioUnlocked) {
            // A direct listener cache does not require the shared AudioContext,
            // but it has still passed the browser's concrete media-element
            // autoplay check. Keep the unlock state from triggering a false
            // overlay while preserving the source-side context guard.
            setAudioUnlocked(true);
          }
          const now = Date.now();
          const nativeHealth = nativeAudioHealthRef.current;
          const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : null;
          const advanced = currentTime !== null && (
            nativeHealth.lastCurrentTime === null
              ? currentTime > 0.01
              : currentTime > nativeHealth.lastCurrentTime + 0.01
          );
          if (advanced) {
            nativeHealth.lastProgressAtMs = now;
          }
          nativeHealth.lastCurrentTime = currentTime;
          nativeHealth.hasStarted = nativeHealth.hasStarted || !audio.paused;
          const actuallyPlaying = !audio.paused &&
            audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            nativeHealth.hasStarted &&
            now - nativeHealth.lastProgressAtMs < 1_500;
          activeRuntime.setMediaConnectionState(actuallyPlaying ? "live" : "buffering");
          setMediaPlayback({
            state: actuallyPlaying ? "live" : "buffering",
            bufferedMs: 0,
            ownedUnitCount: 0,
            totalUnitCount,
            audioContextState: roomAudioOutput.getSharedAudioContext()?.state ?? null,
            lastError: actuallyPlaying ? null : "音频元素尚未产生实际播放进度。"
          });
        } catch (error) {
          if (cancelled) return;
          const detail = error instanceof Error && error.message.trim()
            ? error.message
            : "本地音频播放失败。";
          if (isRecoverableLocalAudioError(detail)) {
            localAudioReadyKeyRef.current = localAudioKey;
            setMediaPlayback({
              state: "buffering",
              bufferedMs: 0,
              ownedUnitCount: 0,
              totalUnitCount,
              audioContextState: roomAudioOutput.getSharedAudioContext()?.state ?? null,
              lastError: detail
            });
            return;
          }
          markLocalAudioUnavailable(localAudioKey, detail);
          clearLocalAudioSource(audio);
        }
        return;
      }

      if (
        localAudioObjectUrlRef.current ||
        localMediaBindingRef.current?.startsWith("listener:local:")
      ) {
        clearLocalAudioSource(audio);
      }

      runtime.setMediaPlaybackEnabled(true);

      const expectedSourcePeerId = roomPlayback?.status === "playing" ? sourcePeerId : null;
      const listenerBindingKey = `listener:${expectedSourcePeerId ?? "none"}`;
      if (localMediaBindingRef.current !== listenerBindingKey) {
        localMediaBindingRef.current = listenerBindingKey;
      }
      // Keep the media peer alive across pause/resume, but only let the
      // lifecycle manager treat missing RTP as a failure after this browser
      // has actually reached audible playback.
      runtime.setLocalAudioStream(
        null,
        expectedSourcePeerId,
        null,
        roomPlayback?.status === "playing" && runtime.audibleRef.current === true
      );
      const remote = sourcePeerId ? runtime.getPeerMediaState(sourcePeerId) : null;
      // Playback revisions and clock anchors can change while the negotiated
      // RTP track stays alive. The element binding follows only Track identity.
      const remoteTrackId = remote?.remoteTrackId ?? null;
      const totalUnitCount = runtime.playbackAsset?.unitCount ?? 0;
      const hasActiveTimeline = !!roomPlayback?.currentTrackId;
      if (boundMediaKeyRef.current !== remoteTrackId && audio) {
        audio.pause();
        audio.srcObject = null;
        boundMediaKeyRef.current = null;
        remoteAudioTimelineKeyRef.current = null;
        receiverAudioHealthRef.current = {
          boundAtMs: 0,
          lastProgressAtMs: 0,
          lastCurrentTime: null,
          hasStarted: false,
          waitingSinceMs: null,
          lastRecoveryAtMs: 0,
          recoveryCount: 0
        };
      }
      if (!hasActiveTimeline) {
        missingMediaSinceRef.current = null;
        mediaEnsureKeyRef.current = null;
        if (audio) {
          audio.pause();
          audio.srcObject = null;
        }
        boundMediaKeyRef.current = null;
        remoteAudioTimelineKeyRef.current = null;
        setMediaPlayback({
          state: roomPlayback ? "paused" : "idle",
          bufferedMs: 0,
          ownedUnitCount: 0,
          totalUnitCount,
          audioContextState: roomAudioOutput.getSharedAudioContext()?.state ?? null,
          lastError: null
        });
        return;
      }
      if (roomPlayback?.status !== "playing") {
        missingMediaSinceRef.current = null;
        mediaEnsureKeyRef.current = null;
        if (audio) {
          // Pausing is an authoritative timeline boundary. Leaving an RTP
          // MediaStream bound here can make Chromium/WebKit drain packets from
          // the pre-pause jitter buffer after resume, audibly replaying the
          // old segment. This resets only the element binding, not the live
          // media peer, so resume gets the current RTP timeline without a
          // new ICE/DTLS negotiation.
          audio.pause();
          if (audio.srcObject) {
            audio.srcObject = null;
            boundMediaKeyRef.current = null;
            remoteAudioTimelineKeyRef.current = null;
            receiverAudioHealthRef.current = {
              boundAtMs: 0,
              lastProgressAtMs: 0,
              lastCurrentTime: null,
              hasStarted: false,
              waitingSinceMs: null,
              lastRecoveryAtMs: 0,
              recoveryCount: 0
            };
          }
        }
        setMediaPlayback({
          state: "paused",
          bufferedMs: 0,
          ownedUnitCount: 0,
          totalUnitCount,
          audioContextState: roomAudioOutput.getSharedAudioContext()?.state ?? null,
          lastError: null
        });
        return;
      }
      if (remote?.remoteStream && remote.receiverTrackState === "live" && audio) {
        const now = Date.now();
        const health = receiverAudioHealthRef.current;
        const remoteTimelineKey = roomPlayback
          ? resolveRemoteAudioTimelineKey(roomPlayback)
          : null;
        const timelineChanged = remoteTimelineKey !== null &&
          remoteAudioTimelineKeyRef.current !== null &&
          remoteAudioTimelineKeyRef.current !== remoteTimelineKey;
        if (remoteTimelineKey !== null) {
          remoteAudioTimelineKeyRef.current = remoteTimelineKey;
        }
        if (timelineChanged) {
          // Pause, resume and seek intentionally interrupt the remote media
          // clock. Start a fresh health window instead of treating the old
          // timestamp as a stuck receiver and restarting the media peer.
          health.boundAtMs = now;
          health.lastProgressAtMs = now;
          health.lastCurrentTime = null;
          health.hasStarted = false;
          health.waitingSinceMs = null;
          // A user-initiated seek resumes the same MediaStream after the room
          // clock has moved. Do not mistake the short RTP/jitter-buffer gap
          // for a failed peer and restart it again while that transition is
          // still settling.
          health.lastRecoveryAtMs = now;
          missingMediaSinceRef.current = null;
        }
        // Some browsers keep firing `playing` while the MediaStream clock is
        // frozen. Poll the clock as well as listening for media events so a
        // connected-but-silent receiver cannot stay falsely healthy forever.
        recordReceiverAudioProgress({
          health,
          event: "progress",
          currentTime: audio.currentTime,
          nowMs: now
        });
        const hasObservedMediaProgress = health.lastCurrentTime !== null &&
          health.lastProgressAtMs > health.boundAtMs;
        const mediaClockStalled = remote.receiverRtpActive !== true && hasObservedMediaProgress &&
          now - health.lastProgressAtMs >= receiverBufferingGraceMs;
        // Only clear the one-shot recovery latch after the media clock is
        // moving again. A live track with a frozen clock must remain eligible
        // for recovery instead of resetting the latch every poll.
        if (remote.receiverRtpActive && !mediaClockStalled) {
          mediaEnsureKeyRef.current = null;
          lastMediaEnsureAtRef.current = 0;
        }
        const mediaElementStalled = audio.paused ||
          audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
          mediaClockStalled;
        if (
          roomPlayback?.status === "playing" &&
          !remote.receiverRtpActive &&
          mediaElementStalled &&
          (hasObservedMediaProgress || health.waitingSinceMs !== null)
        ) {
          missingMediaSinceRef.current ??= now;
        } else if (!mediaClockStalled) {
          missingMediaSinceRef.current = null;
          mediaEnsureKeyRef.current = null;
        }
        if (audio.srcObject !== remote.remoteStream) {
          audio.srcObject = remote.remoteStream;
          health.boundAtMs = Date.now();
          health.lastProgressAtMs = health.boundAtMs;
          health.lastCurrentTime = null;
          health.hasStarted = false;
          health.waitingSinceMs = null;
        }
        // An untouched listener element can use native MediaStream output,
        // which is the most reliable path on iPad Safari. Once an element
        // has been used as a MediaElementAudioSourceNode (for example while
        // this member was the source), its output is permanently routed
        // through Web Audio and it must stay connected to an audible graph.
        // Keep loudness normalization on the native volume path for new
        // remote elements rather than needlessly creating that permanent tie.
        const remoteUsesWebAudioGraph = roomAudioOutput.hasLocalAudioElementSource(audio);
        if (remoteUsesWebAudioGraph) {
          roomAudioOutput.bindLocalAudioElement(audio, {
            broadcast: false,
            loudnessGainDb: runtime.loudnessGainDb,
            volume: runtime.volume
          });
        }
        roomAudioOutput.applyVolume({
          localAudio: audio,
          volume: runtime.volume,
          loudnessGainDb: runtime.loudnessGainDb
        });
        boundMediaKeyRef.current = remoteTrackId;
        // A remote MediaStream is played directly by the media element. It
        // must not be blocked by the shared AudioContext unlock flag, which is
        // required by local Web Audio graphs but is not part of this path.
        const waitingTooLong = health.waitingSinceMs !== null &&
          now - health.waitingSinceMs >= 1_500 &&
          mediaElementStalled;
        const progressStalled = hasObservedMediaProgress && shouldRecoverStalledReceiverAudio({
          boundAtMs: health.boundAtMs,
          hasStarted: health.hasStarted,
          lastProgressAtMs: health.lastProgressAtMs,
          nowMs: now,
          receiverRtpActive: remote.receiverRtpActive,
          audioPaused: audio.paused
        });
        const shouldNudge = timelineChanged || waitingTooLong || progressStalled;
        if (shouldNudge && now - health.lastRecoveryAtMs >= receiverRecoveryRetryMs) {
          health.lastRecoveryAtMs = now;
          health.waitingSinceMs = null;
          health.recoveryCount += 1;
          // Keep the same MediaStream binding. Replacing srcObject here
          // destroys the browser jitter buffer and is a common source of
          // repeated silence during short packet-loss bursts.
          if (progressStalled && sourcePeerId && roomPlayback?.currentTrackId) {
            ensureListenerMediaConnection({
              runtime,
              sourcePeerId,
              trackId: roomPlayback.currentTrackId,
              mediaEpoch: roomPlayback.mediaEpoch,
              forceRecovery: true
            });
          }
        }
        const isCurrentRemoteAudioRequest = () => {
          const currentRuntime = runtimeInputRef.current;
          const currentRoomPlayback = currentRuntime.roomSnapshot?.room.playback ?? null;
          return !cancelled &&
            currentRoomPlayback?.status === "playing" &&
            resolveLocalAudioTimelineKey(
              currentRoomPlayback,
              currentRuntime.playbackBarrier
            ) === operationTimelineKey &&
            resolveCurrentSourcePeerId(
              currentRuntime.roomSnapshot,
              currentRoomPlayback
            ) === sourcePeerId &&
            audio.srcObject === remote.remoteStream;
        };
        const result = await roomAudioOutput.playElement(audio, {
          // Recovery must not keep replaying an already-playing MediaStream.
          // Force is only needed for an authoritative timeline replacement.
          force: timelineChanged,
          // New remote elements render natively. A previously graph-bound
          // element needs a running context; otherwise play() can advance on
          // iPad Safari while no audible route exists.
          resumeAudioContext: remoteUsesWebAudioGraph,
          requireRunningAudioContext: remoteUsesWebAudioGraph,
          allowMutedFallback: false,
          // Context resume can finish after a background pause. Revalidate the
          // room timeline immediately before play() so that obsolete work
          // cannot restart a paused remote stream when the page wakes up.
          isCurrent: isCurrentRemoteAudioRequest
        });
        if (!isCurrentRemoteAudioRequest()) {
          if (audio.srcObject === remote.remoteStream) {
            audio.pause();
          }
          return;
        }
        if (!cancelled && !result.ok) {
          const blocked = isAudioPlaybackBlockedError(result.error);
          if (blocked) {
            setAudioUnlocked(false);
          }
          setMediaPlayback({
            ...idlePlaybackSnapshot(),
            state: blocked ? "awaiting-unlock" : "buffering",
            audioContextState: roomAudioOutput.getSharedAudioContext()?.state ?? null,
            lastError: blocked ? null : result.error
          });
          return;
        }
        if (!cancelled && !runtime.audioUnlocked) {
          // The remote element can be autoplayable even when the shared
          // AudioContext has not been resumed. Remember that this concrete
          // playback path is usable without forcing a false unlock prompt.
          setAudioUnlocked(true);
        }
        if (cancelled) return;
        if (!cancelled) {
          setMediaPlayback({
            state: resolveReceiverPlaybackState({
              receiverRtpActive: remote?.receiverRtpActive,
              hasStarted: health.hasStarted,
              lastProgressAtMs: health.lastProgressAtMs,
              missingMediaSinceMs: missingMediaSinceRef.current,
              nowMs: now
            }),
            bufferedMs: 0,
            ownedUnitCount: 0,
            totalUnitCount,
            audioContextState: roomAudioOutput.getSharedAudioContext()?.state ?? null,
            lastError: null
          });
        }
        return;
      }

      if (!cancelled) {
        const isPlayingWithoutMedia = roomPlayback?.status === "playing" &&
          !!sourcePeerId &&
          !!roomPlayback.currentTrackId;
        if (isPlayingWithoutMedia && sourcePeerId && roomPlayback.currentTrackId) {
          ensureListenerMediaConnection({
            runtime,
            sourcePeerId,
            trackId: roomPlayback.currentTrackId,
            mediaEpoch: roomPlayback.mediaEpoch,
          });
        }
        setMediaPlayback({
          state: isPlayingWithoutMedia ? "buffering" : "idle",
          bufferedMs: 0,
          ownedUnitCount: 0,
          totalUnitCount,
          audioContextState: roomAudioOutput.getSharedAudioContext()?.state ?? null,
          lastError: null
        });
      }
    };

    let syncInFlight: Promise<void> | null = null;
    let syncRequestedWhileInFlight = false;
    const syncMedia = () => {
      if (syncInFlight) {
        syncRequestedWhileInFlight = true;
        return syncInFlight;
      }
      const operation = runSyncMedia();
      syncInFlight = operation;
      operation.then(
        () => {
          if (syncInFlight === operation) {
            syncInFlight = null;
            if (syncRequestedWhileInFlight && !cancelled) {
              syncRequestedWhileInFlight = false;
              void syncMedia();
            }
          }
        },
        () => {
          if (syncInFlight === operation) {
            syncInFlight = null;
            if (syncRequestedWhileInFlight && !cancelled) {
              syncRequestedWhileInFlight = false;
              void syncMedia();
            }
          }
        }
      );
      return operation;
    };

    syncMediaRef.current = syncMedia;
    void syncMedia();
    const interval = window.setInterval(() => void syncMedia(), 250);
    const unsubscribeRemoteAudioTrack = subscribeRemoteAudioTrack?.(() => {
      void syncMedia();
    });
    const unsubscribeBroadcastStream = runtimeInputRef.current.isCurrentSource
      ? roomAudioOutput.subscribeBroadcastStream(() => {
        void syncMedia();
      })
      : undefined;
    const mountedAudio = audioRef.current;
    return () => {
      cancelled = true;
      if (syncMediaRef.current === syncMedia) {
        syncMediaRef.current = null;
      }
      window.clearInterval(interval);
      unsubscribeRemoteAudioTrack?.();
      unsubscribeBroadcastStream?.();
      runtimeInputRef.current.setLocalAudioStream(null, null, null, false);
      runtimeInputRef.current.audibleRef.current = false;
      const audio = mountedAudio;
      roomAudioOutput.unbindLocalAudioElement(audio);
      clearLocalAudioSource(audio);
      receiverAudioHealthRef.current = {
        boundAtMs: 0,
        lastProgressAtMs: 0,
        lastCurrentTime: null,
        hasStarted: false,
        waitingSinceMs: null,
        lastRecoveryAtMs: 0,
        recoveryCount: 0
      };
      remoteAudioTimelineKeyRef.current = null;
      mediaEnsureKeyRef.current = null;
      lastMediaEnsureAtRef.current = 0;
      localMediaBindingRef.current = null;
      appliedPlaybackRevisionRef.current = null;
    };
  }, [
    audioRef,
    clearLocalAudioSource,
    markLocalAudioUnavailable,
    setAudioUnlocked,
    setMediaPlayback,
    isCurrentSource,
    roomId,
    input.roomSnapshot?.room.playback.currentTrackId,
    input.roomSnapshot?.room.playback.mediaEpoch,
    ensureListenerMediaConnection,
    subscribeRemoteAudioTrack
  ]);

  useEffect(() => {
    void syncMediaRef.current?.();
  }, [
    streamingOnlyPlayback,
    usesNativeLocalAudio,
    input.roomSnapshot?.room.playback.status,
    input.roomSnapshot?.room.playback.playbackRevision
  ]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || isCurrentSource) {
      return;
    }

    const health = receiverAudioHealthRef.current;
    const markPlaying = () => {
      recordReceiverAudioProgress({
        health,
        event: "playing",
        currentTime: audio.currentTime,
        nowMs: Date.now()
      });
    };
    const markProgress = () => {
      recordReceiverAudioProgress({
        health,
        event: "progress",
        currentTime: audio.currentTime,
        nowMs: Date.now()
      });
    };
    const markWaiting = () => {
      health.waitingSinceMs ??= Date.now();
    };

    audio.addEventListener("playing", markPlaying);
    audio.addEventListener("timeupdate", markProgress);
    audio.addEventListener("canplay", markProgress);
    audio.addEventListener("waiting", markWaiting);
    audio.addEventListener("stalled", markWaiting);
    audio.addEventListener("error", markWaiting);
    return () => {
      audio.removeEventListener("playing", markPlaying);
      audio.removeEventListener("timeupdate", markProgress);
      audio.removeEventListener("canplay", markProgress);
      audio.removeEventListener("waiting", markWaiting);
      audio.removeEventListener("stalled", markWaiting);
      audio.removeEventListener("error", markWaiting);
    };
  }, [audioRef, isCurrentSource]);

  useEffect(() => {
    const usesNativeLocalAudio = isCurrentSource &&
      !streamingOnlyPlayback &&
      currentLocalAudioAvailable;
    if (isCurrentSource && !usesNativeLocalAudio) {
      return;
    }
    roomAudioOutput.applyVolume({
      localAudio: audioRef.current,
      volume: input.volume,
      loudnessGainDb
    });
  }, [
    audioRef,
    input.volume,
    isCurrentSource,
    currentLocalAudioAvailable,
    loudnessGainDb,
    streamingOnlyPlayback
  ]);

  useEffect(() => {
    const restoreAudioOutput = () => {
      if (document.hidden) return;
      void roomAudioOutput.restoreAfterBackground({
        localAudio: audioRef.current,
        volume: input.volume,
        loudnessGainDb
      }).then((resumed) => {
        if (resumed && roomAudioOutput.isActivated() && roomAudioOutput.isAudioContextReady()) {
          setAudioUnlocked(true);
        }
      });
    };

    document.addEventListener("visibilitychange", restoreAudioOutput);
    window.addEventListener("pageshow", restoreAudioOutput);
    window.addEventListener("focus", restoreAudioOutput);
    return () => {
      document.removeEventListener("visibilitychange", restoreAudioOutput);
      window.removeEventListener("pageshow", restoreAudioOutput);
      window.removeEventListener("focus", restoreAudioOutput);
    };
  }, [audioRef, input.volume, loudnessGainDb, setAudioUnlocked]);

  const lastReportedErrorRef = useRef<string | null>(null);
  const completedTimelineRef = useRef<string | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || (!input.isCurrentSource && !providerCachePlan.isSourceMemberOffline)) {
      return;
    }

    const handleEnded = () => {
      const runtime = runtimeInputRef.current;
      const roomPlayback = runtime.roomSnapshot?.room.playback;
      if (
        (!runtime.isCurrentSource && !runtime.isSourceMemberOffline) ||
        !runtime.usesNativeLocalAudio ||
        roomPlayback?.status !== "playing" ||
        roomPlayback.currentTrackId !== runtime.currentTrack?.id
      ) {
        return;
      }
      const timelineKey = [
        roomPlayback.currentTrackId,
        roomPlayback.mediaEpoch,
        roomPlayback.startAt ?? roomPlayback.startedAt
      ].join(":");
      if (completedTimelineRef.current === timelineKey) return;
      completedTimelineRef.current = timelineKey;
      void onPlaybackEnded();
    };

    audio.addEventListener("ended", handleEnded);
    return () => audio.removeEventListener("ended", handleEnded);
  }, [
    audioRef,
    input.isCurrentSource,
    onPlaybackEnded,
    providerCachePlan.isSourceMemberOffline
  ]);

  useEffect(() => {
    if (
      !usesSegmentedPlayback ||
      !audioUnlocked ||
      playback.state !== "awaiting-unlock" ||
      playback.audioContextState === "running"
    ) {
      return;
    }

    let cancelled = false;
    void roomAudioOutput.resumeSharedAudioContext().then((resumed) => {
      if (cancelled || resumed) {
        return;
      }
      setAudioUnlocked(false);
      setStatusMessage("音频上下文已暂停，请点击播放或在房间内交互以恢复声音。");
    });

    return () => {
      cancelled = true;
    };
  }, [
    audioUnlocked,
    playback.audioContextState,
    playback.state,
    setAudioUnlocked,
    setStatusMessage,
    usesSegmentedPlayback
  ]);

  useEffect(() => {
    if (visiblePlayback.lastError && visiblePlayback.lastError !== lastReportedErrorRef.current) {
      lastReportedErrorRef.current = visiblePlayback.lastError;
      setLastSourceStartError(visiblePlayback.lastError);
      return;
    }
    if (!visiblePlayback.lastError && lastReportedErrorRef.current && visiblePlayback.state === "live") {
      lastReportedErrorRef.current = null;
      setLastSourceStartError(null);
    }
  }, [setLastSourceStartError, visiblePlayback.lastError, visiblePlayback.state]);

  useEffect(() => {
    if (!input.isCurrentSource) {
      lastSourceHealthRef.current = undefined;
      return;
    }
    if (playback.sourceHealth && playback.sourceHealth !== lastSourceHealthRef.current) {
      const previousSourceHealth = lastSourceHealthRef.current;
      lastSourceHealthRef.current = playback.sourceHealth;
      if (
        playback.sourceHealth === "source-silent" &&
        previousSourceHealth &&
        previousSourceHealth !== "source-silent"
      ) {
        // source-silent means that the broadcast RTP track is missing or
        // ended. A quiet song section remains source-ready and never reaches
        // this branch.
        setStatusMessage("WebRTC RTP Opus 媒体链路不可用，正在恢复。");
      }
    }
  }, [input.isCurrentSource, playback.sourceHealth, setStatusMessage]);

  useEffect(() => {
    if (input.isCurrentSource) {
      if (playback.sourceHealth === "source-underrun") {
        setMediaConnectionState("buffering");
      } else if (playback.sourceHealth === "source-silent") {
        setMediaConnectionState("reconnecting");
      } else if (playback.sourceHealth === "source-ready") {
        setMediaConnectionState("live");
      }
    }
  }, [input.isCurrentSource, playback.sourceHealth, setMediaConnectionState]);

  useEffect(() => {
    if (visiblePlayback.state === "live") {
      setSourceStartState("live");
      setMediaConnectionState(
        input.isCurrentSource && visiblePlayback.sourceHealth === "source-silent"
          ? "reconnecting"
          : "live"
      );
      setLastSourceStartError(null);
      return;
    }
    if (visiblePlayback.state === "buffering") {
      setSourceStartState("starting");
      setMediaConnectionState("buffering");
      if (visiblePlayback.lastError) {
        setLastSourceStartError(visiblePlayback.lastError);
      }
      return;
    }
    if (visiblePlayback.state === "awaiting-unlock") {
      setSourceStartState("awaiting-unlock");
      setMediaConnectionState("connecting");
      return;
    }
    if (visiblePlayback.state === "ended") {
      setSourceStartState("live");
      setMediaConnectionState("live");
      return;
    }
    if (visiblePlayback.state === "unavailable") {
      setSourceStartState("failed");
      setMediaConnectionState("failed");
      setLastSourceStartError(visiblePlayback.lastError ?? "当前播放源媒体轨道不可用。");
      return;
    }
    setSourceStartState("idle");
    setMediaConnectionState("idle");
  }, [
    input.isCurrentSource,
    setLastSourceStartError,
    setMediaConnectionState,
    setSourceStartState,
    visiblePlayback.lastError,
    visiblePlayback.sourceHealth,
    visiblePlayback.state
  ]);

  useEffect(() => {
    if (playback.state !== "ended" || !isCurrentSource) return;
    const room = roomSnapshot?.room;
    const activePlayback = room?.playback;
    if (!room || !activePlayback?.currentTrackId) return;
    if (localPeerId !== runtimePeerId) return;
    const timelineKey = [
      activePlayback.currentTrackId,
      activePlayback.mediaEpoch,
      activePlayback.startAt
    ].join(":");
    if (completedTimelineRef.current === timelineKey) return;
    completedTimelineRef.current = timelineKey;
    void onPlaybackEnded();
  }, [
    isCurrentSource,
    localPeerId,
    onPlaybackEnded,
    playback.state,
    roomSnapshot,
    runtimePeerId
  ]);

  const audioPath = resolveRoomAudioPath({
    isCurrentSource: input.isCurrentSource,
    nativeLocalAudio: usesNativeLocalAudio
  });
  const effectivePlayback = visiblePlayback;
  const coarsePlayback: RoomCoarsePlaybackState = useMemo(
    () => ({
      state: visiblePlayback.state,
      audioPath,
      sourceHealth: visiblePlayback.sourceHealth,
      lastError: visiblePlayback.lastError
    }),
    [visiblePlayback.state, audioPath, visiblePlayback.sourceHealth, visiblePlayback.lastError]
  );
  return useMemo(
    () => ({ ...effectivePlayback, audioPath, playbackBarrier, coarsePlayback }),
    [
      audioPath,
      effectivePlayback,
      playbackBarrier,
      coarsePlayback
    ]
  );
}
