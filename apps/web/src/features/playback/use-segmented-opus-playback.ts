"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  playbackEncoderVersion,
  playbackProfileId,
  type RoomSnapshot,
  type TrackMeta
} from "@soqaro/shared";
import {
  getAssetUnit,
  putAssetManifest
} from "@/features/library/indexeddb";
import {
  getRoomPlaybackClockNowMs,
  type RoomPlaybackBarrierClock
} from "./room-playback-clock";
import { resolveRoomTrackPlaybackAsset } from "./room-playback-asset";
import { SegmentedOpusEngine } from "./segmented-opus-engine";
import { roomAudioOutput } from "./room-audio-output";

export type SegmentedPlaybackState =
  | "idle"
  | "awaiting-unlock"
  | "buffering"
  | "live"
  | "paused"
  | "unavailable"
  | "ended";

export type PlaybackAudioPath =
  | "local-file"
  | "local-segmented"
  | "remote-stream"
  | "broadcast-segmented";

export type SegmentedPlaybackSnapshot = {
  state: SegmentedPlaybackState;
  audioPath?: PlaybackAudioPath;
  playbackIdentity?: string | null;
  bufferedMs: number;
  ownedUnitCount: number;
  totalUnitCount: number;
  audioContextState: AudioContextState | null;
  lastError: string | null;
  sourceHealth?: "source-ready" | "source-underrun" | "source-silent" | "source-ended";
  sourceEnergy?: number;
  decodedPeak?: number;
  decodedRms?: number;
  maxSampleDelta?: number;
  underrunCount?: number;
  lastUnderrunAt?: string | null;
  lastDecodeError?: string | null;
};

const idleSnapshot: SegmentedPlaybackSnapshot = {
  state: "idle",
  playbackIdentity: null,
  bufferedMs: 0,
  ownedUnitCount: 0,
  totalUnitCount: 0,
  audioContextState: null,
  lastError: null
};

const playbackSnapshotCommitIntervalMs = 250;

function isSegmentedSnapshotContentEqual(
  a: SegmentedPlaybackSnapshot,
  b: SegmentedPlaybackSnapshot
) {
  return a.state === b.state &&
    a.audioPath === b.audioPath &&
    a.playbackIdentity === b.playbackIdentity &&
    a.bufferedMs === b.bufferedMs &&
    a.ownedUnitCount === b.ownedUnitCount &&
    a.totalUnitCount === b.totalUnitCount &&
    a.audioContextState === b.audioContextState &&
    a.lastError === b.lastError &&
    a.sourceHealth === b.sourceHealth &&
    a.sourceEnergy === b.sourceEnergy &&
    a.decodedPeak === b.decodedPeak &&
    a.decodedRms === b.decodedRms &&
    a.maxSampleDelta === b.maxSampleDelta &&
    a.underrunCount === b.underrunCount &&
    a.lastUnderrunAt === b.lastUnderrunAt &&
    a.lastDecodeError === b.lastDecodeError;
}

export function useSegmentedOpusPlayback(input: {
  roomSnapshot: RoomSnapshot | null;
  currentTrack: TrackMeta | null;
  playbackAsset: TrackMeta["playbackAsset"] | null;
  peerId: string;
  isCurrentSource: boolean;
  disableSourcePlayback?: boolean;
  playbackBarrier?: RoomPlaybackBarrierClock | null;
  volume: number;
  loudnessGainDb?: number;
  audioUnlocked: boolean;
}) {
  const { roomSnapshot, peerId, isCurrentSource, volume, loudnessGainDb = 0 } = input;
  const engineRef = useRef<SegmentedOpusEngine | null>(null);
  const runtimeRef = useRef(input);
  runtimeRef.current = input;
  const tickingRef = useRef(false);
  const activePlaybackAssetIdRef = useRef<string | null>(null);
  const storedManifestAssetIdRef = useRef<string | null>(null);
  const playbackEngineIdentityRef = useRef<string | null>(null);
  const playbackGenerationRef = useRef(0);
  const [snapshot, setSnapshotState] = useState<SegmentedPlaybackSnapshot>(idleSnapshot);
  const lastSnapshotCommitAtRef = useRef(0);
  const setSnapshot = useCallback((next: Parameters<typeof setSnapshotState>[0]) => {
    setSnapshotState((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      const immediate = current.state !== resolved.state ||
        current.playbackIdentity !== resolved.playbackIdentity ||
        current.audioContextState !== resolved.audioContextState ||
        current.sourceHealth !== resolved.sourceHealth ||
        current.lastError !== resolved.lastError ||
        current.lastDecodeError !== resolved.lastDecodeError;
      if (immediate) {
        lastSnapshotCommitAtRef.current = Date.now();
        return resolved;
      }
      // Paused/idle rooms re-sample every 100ms without anything changing; skip the
      // commit entirely instead of re-rendering the runtime at a fixed cadence.
      if (isSegmentedSnapshotContentEqual(current, resolved)) {
        return current;
      }
      const now = Date.now();
      if (now - lastSnapshotCommitAtRef.current < playbackSnapshotCommitIntervalMs) {
        return current;
      }
      lastSnapshotCommitAtRef.current = now;
      return resolved;
    });
  }, [setSnapshotState]);
  const roomId = roomSnapshot?.room.id ?? null;
  const disableSourcePlayback = isCurrentSource && input.disableSourcePlayback === true;
  const activePlaybackAsset = input.playbackAsset;
  const sourcePlaybackAssetUnavailable = isCurrentSource &&
    !disableSourcePlayback &&
    roomSnapshot?.room.playback.status === "playing" &&
    roomSnapshot.room.playback.currentTrackId === input.currentTrack?.id &&
    !isSupportedPlaybackAsset(activePlaybackAsset);
  const hasActivePlayback = hasActiveSegmentedPlayback({
    isCurrentSource,
    currentTrackId: roomSnapshot?.room.playback.currentTrackId,
    hasPlaybackAsset: isSupportedPlaybackAsset(activePlaybackAsset),
    disableSourcePlayback
  });
  const playbackIdentity = resolveSegmentedPlaybackIdentity({
    playback: roomSnapshot?.room.playback,
    playbackAssetId: activePlaybackAsset?.assetId
  });
  const releaseEngine = useCallback(() => {
    playbackGenerationRef.current += 1;
    engineRef.current?.destroy();
    engineRef.current = null;
    activePlaybackAssetIdRef.current = null;
    storedManifestAssetIdRef.current = null;
    playbackEngineIdentityRef.current = null;
  }, []);

  useEffect(() => {
    if (hasActivePlayback) {
      return;
    }

    releaseEngine();
    setSnapshot(idleSnapshot);
  }, [hasActivePlayback, releaseEngine, setSnapshot]);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      if (cancelled || tickingRef.current) {
        return;
      }
      tickingRef.current = true;
      let generation = playbackGenerationRef.current;
      try {
        const runtime = runtimeRef.current;
        const currentPlaybackAsset = runtime.playbackAsset;
        const currentRoomPlayback = runtime.roomSnapshot?.room.playback;
        const currentPlayback = resolveBarrierPlaybackSnapshot(
          currentRoomPlayback,
          runtime.playbackBarrier
        );
        const nextTransition = currentPlayback?.gaplessNext ?? null;
        const nextPlaybackAsset = nextTransition
          ? resolveRoomTrackPlaybackAsset(
            runtime.roomSnapshot,
            nextTransition.trackId,
            nextTransition.playbackAssetId
          )
          : null;
        const currentPlaybackIdentity = resolveSegmentedPlaybackIdentity({
          playback: currentRoomPlayback,
          playbackAssetId: currentPlaybackAsset?.assetId
        });
        const currentPlaybackEngineIdentity = resolveSegmentedPlaybackEngineIdentity({
          playback: currentPlayback,
          playbackAssetId: currentPlaybackAsset?.assetId
        });
        if (runtime.playbackBarrier?.blocked === true) {
          setSnapshot({ ...idleSnapshot, playbackIdentity: currentPlaybackIdentity });
          return;
        }
        if (runtime.isCurrentSource && runtime.disableSourcePlayback) {
          setSnapshot({ ...idleSnapshot, playbackIdentity: currentPlaybackIdentity });
          return;
        }
        if (playbackEngineIdentityRef.current !== currentPlaybackEngineIdentity) {
          engineRef.current?.destroy();
          engineRef.current = null;
          activePlaybackAssetIdRef.current = null;
          storedManifestAssetIdRef.current = null;
          playbackEngineIdentityRef.current = currentPlaybackEngineIdentity;
          playbackGenerationRef.current += 1;
        }
        generation = playbackGenerationRef.current;
        if (!isSupportedPlaybackAsset(currentPlaybackAsset)) {
          setSnapshot({ ...idleSnapshot, playbackIdentity: currentPlaybackIdentity });
          return;
        }
        if (
          cancelled ||
          !currentPlaybackAsset ||
          !currentPlayback ||
          currentPlayback.currentTrackId !== runtime.currentTrack?.id
          || !runtime.isCurrentSource
        ) {
          setSnapshot({ ...idleSnapshot, playbackIdentity: currentPlaybackIdentity });
          return;
        }
        if (storedManifestAssetIdRef.current !== currentPlaybackAsset.assetId) {
          await putAssetManifest(currentPlaybackAsset);
          if (cancelled || generation !== playbackGenerationRef.current) {
            return;
          }
          storedManifestAssetIdRef.current = currentPlaybackAsset.assetId;
        }
        // A local file can take over while manifest storage is pending. Never
        // recreate the segmented output after that handoff, even before React
        // has run the previous effect's cleanup.
        const latest = runtimeRef.current;
        if (
          cancelled || generation !== playbackGenerationRef.current ||
          !latest.isCurrentSource || latest.disableSourcePlayback ||
          latest.playbackBarrier?.blocked ||
          latest.peerId !== runtime.peerId ||
          latest.roomSnapshot?.room.id !== runtime.roomSnapshot?.room.id ||
          latest.roomSnapshot?.room.playback !== currentRoomPlayback ||
          latest.currentTrack?.id !== runtime.currentTrack?.id ||
          latest.playbackAsset?.assetId !== currentPlaybackAsset.assetId
        ) {
          return;
        }
        const serverNowMs = getRoomPlaybackClockNowMs();
        const audioContextState = roomAudioOutput.getSharedAudioContext()?.state ?? null;

        if (!runtime.audioUnlocked || audioContextState !== "running") {
          if (cancelled || generation !== playbackGenerationRef.current) {
            return;
          }
          setSnapshot({
            state: "awaiting-unlock",
            bufferedMs: 0,
            ownedUnitCount: 0,
            totalUnitCount: currentPlaybackAsset.unitCount,
            audioContextState,
            lastError: null
          });
          return;
        }
        engineRef.current ??= new SegmentedOpusEngine();
        const engine = engineRef.current;
        engine.setBroadcastEnabled(true);
        const result = await engine.sync({
          manifest: currentPlaybackAsset,
          playback: currentPlayback,
          serverNowMs,
          volume: runtime.volume * (roomAudioOutput.getSystemAudioScale?.() ?? 1),
          loudnessGainDb: runtime.loudnessGainDb,
          broadcast: true,
          getUnit: (unitIndex, signal) => getPlayableAssetUnit(
            currentPlaybackAsset.assetId,
            unitIndex,
            signal
          ),
          gaplessNext:
            nextTransition && nextPlaybackAsset
              ? {
                  transition: nextTransition,
                  manifest: nextPlaybackAsset,
                  getUnit: (unitIndex, signal) => getPlayableAssetUnit(
                    nextPlaybackAsset.assetId,
                    unitIndex,
                    signal
                  )
                }
              : null
        });
        if (cancelled || generation !== playbackGenerationRef.current) {
          return;
        }
        const sourceHealth = engine.getSourceHealth();
        const activePlaybackError = result.state === "buffering" &&
          sourceHealth?.state === "source-underrun"
          ? sourceHealth.lastDecodeError
          : null;
        setSnapshot({
          state: result.state,
          playbackIdentity: currentPlaybackIdentity,
          bufferedMs: result.bufferedUnits * currentPlaybackAsset.segmentDurationMs,
          ownedUnitCount: result.bufferedUnits,
          totalUnitCount: currentPlaybackAsset.unitCount,
          audioContextState,
          lastError: activePlaybackError,
          sourceHealth: sourceHealth?.state,
          sourceEnergy: sourceHealth?.energy,
          decodedPeak: sourceHealth?.decodedPeak,
          decodedRms: sourceHealth?.decodedRms,
          maxSampleDelta: sourceHealth?.maxSampleDelta,
          underrunCount: sourceHealth?.underrunCount,
          lastUnderrunAt: sourceHealth?.lastUnderrunAt,
          lastDecodeError: sourceHealth?.lastDecodeError
        });
      } catch (error) {
        if (cancelled || generation !== playbackGenerationRef.current) {
          return;
        }
        const failedEngine = engineRef.current;
        engineRef.current = null;
        storedManifestAssetIdRef.current = null;
        failedEngine?.destroy();
        const runtime = runtimeRef.current;
        const totalUnitCount = runtime.playbackAsset?.unitCount ?? 0;
        const audioContextState = roomAudioOutput.getSharedAudioContext()?.state ?? null;
        const failedPlaybackIdentity = resolveSegmentedPlaybackIdentity({
          playback: runtime.roomSnapshot?.room.playback,
          playbackAssetId: runtime.playbackAsset?.assetId
        });
        if (!cancelled && generation === playbackGenerationRef.current) {
          setSnapshot((current) => buildSegmentedPlaybackFailureSnapshot({
            current,
            totalUnitCount,
            audioContextState,
            error,
            playbackIdentity: failedPlaybackIdentity
          }));
        }
      } finally {
        tickingRef.current = false;
      }
    };

    void tick();
    const playbackBarrierBlocked = input.playbackBarrier?.blocked === true;
    if (playbackBarrierBlocked) {
      return () => {
        cancelled = true;
        releaseEngine();
        setSnapshot({ ...idleSnapshot, playbackIdentity: null });
      };
    }
    const interval = window.setInterval(() => void tick(), 100);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      releaseEngine();
      setSnapshot({ ...idleSnapshot, playbackIdentity: null });
    };
  }, [
    roomId,
    peerId,
    isCurrentSource,
    disableSourcePlayback,
    input.playbackBarrier?.blocked,
    setSnapshot,
    releaseEngine
  ]);

  useEffect(() => {
    engineRef.current?.setVolume(volume);
  }, [volume]);

  useEffect(() => {
    engineRef.current?.setLoudnessGainDb(loudnessGainDb);
  }, [loudnessGainDb]);

  useEffect(() => () => engineRef.current?.destroy(), []);

  if (snapshot.playbackIdentity === playbackIdentity) {
    if (sourcePlaybackAssetUnavailable) {
      return {
        ...idleSnapshot,
        state: "unavailable" as const,
        playbackIdentity,
        audioContextState: roomAudioOutput.getSharedAudioContext()?.state ?? null,
        lastError: resolveSourcePlaybackAssetError(activePlaybackAsset)
      };
    }
    return snapshot;
  }

  if (sourcePlaybackAssetUnavailable) {
    return {
      ...idleSnapshot,
      state: "unavailable" as const,
      playbackIdentity,
      audioContextState: roomAudioOutput.getSharedAudioContext()?.state ?? null,
      lastError: resolveSourcePlaybackAssetError(activePlaybackAsset)
    };
  }

  return {
    ...idleSnapshot,
    playbackIdentity,
    totalUnitCount: input.playbackAsset?.unitCount ?? 0,
    audioContextState: roomAudioOutput.getSharedAudioContext()?.state ?? null
  };
}

export function resolveSegmentedPlaybackIdentity(input: {
  playback:
    | Pick<
        RoomSnapshot["room"]["playback"],
        "currentTrackId" | "mediaEpoch" | "playbackRevision" | "startAt"
      >
    | null
    | undefined;
  playbackAssetId: string | null | undefined;
}) {
  if (!input.playbackAssetId || !input.playback?.currentTrackId) {
    return null;
  }

  return [
    input.playbackAssetId,
    input.playback.currentTrackId,
    input.playback.mediaEpoch,
    input.playback.startAt ?? "none"
  ].join(":");
}

function resolveBarrierPlaybackSnapshot(
  playback: RoomSnapshot["room"]["playback"] | null | undefined,
  barrier?: Pick<RoomPlaybackBarrierClock, "holdPositionMs" | "resumeAtMs"> | null
) {
  if (!playback || playback.status !== "playing") {
    return playback;
  }
  const holdPositionMs = barrier?.holdPositionMs;
  if (typeof holdPositionMs !== "number" || !Number.isFinite(holdPositionMs)) {
    return playback;
  }
  const resumeAtMs = barrier?.resumeAtMs;
  const resumeAt = typeof resumeAtMs === "number" && Number.isFinite(resumeAtMs)
    ? new Date(resumeAtMs).toISOString()
    : playback.startAt ?? null;
  return {
    ...playback,
    positionMs: holdPositionMs,
    startedAt: resumeAt,
    startAt: resumeAt
  };
}

/**
 * Identifies the local media source, excluding timeline-only changes such as
 * pause/resume and seek. Those changes are handled inside the existing engine.
 */
export function resolveSegmentedPlaybackEngineIdentity(input: {
  playback:
    | Pick<
        RoomSnapshot["room"]["playback"],
        "currentTrackId" | "mediaEpoch" | "playbackRevision" | "startAt"
      >
    | null
    | undefined;
  playbackAssetId: string | null | undefined;
}) {
  if (!input.playbackAssetId || !input.playback?.currentTrackId) {
    return null;
  }

  return [
    input.playback.mediaEpoch,
    input.playbackAssetId,
    "broadcast"
  ].join(":");
}

export function hasActiveSegmentedPlayback(input: {
  isCurrentSource: boolean;
  currentTrackId: string | null | undefined;
  hasPlaybackAsset: boolean;
  disableSourcePlayback?: boolean;
}) {
  return Boolean(input.currentTrackId) && input.hasPlaybackAsset && (
    input.isCurrentSource && input.disableSourcePlayback !== true
  );
}

function isSupportedPlaybackAsset(asset: TrackMeta["playbackAsset"] | null | undefined) {
  return Boolean(
    asset &&
      asset.profileId === playbackProfileId &&
      asset.encoder.version === playbackEncoderVersion
  );
}

function resolveSourcePlaybackAssetError(asset: TrackMeta["playbackAsset"] | null | undefined) {
  return asset
    ? "当前歌曲的曲库播放资产不受当前播放器支持，无法进行流式播放。"
    : "当前歌曲缺少匹配的曲库播放资产，无法进行流式播放。";
}

function formatSegmentedPlaybackError(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "分段音频读取或解码失败";
}

async function getPlayableAssetUnit(
  assetId: string,
  unitIndex: number,
  signal?: AbortSignal
) {
  const unit = await getAssetUnit(assetId, unitIndex);
  if (!unit || unit.payloadBytes <= 0 || unit.payload.byteLength !== unit.payloadBytes) {
    return null;
  }
  if (signal?.aborted) {
    const error = new Error("Audio asset read aborted.");
    error.name = "AbortError";
    throw error;
  }
  return unit;
}

export function buildSegmentedPlaybackFailureSnapshot(input: {
  current: SegmentedPlaybackSnapshot;
  totalUnitCount: number;
  audioContextState: AudioContextState | null;
  error: unknown;
  playbackIdentity?: string | null;
}): SegmentedPlaybackSnapshot {
  return {
    ...input.current,
    ...(input.playbackIdentity !== undefined
      ? { playbackIdentity: input.playbackIdentity }
      : {}),
    state: input.audioContextState === "running" ? "buffering" : "awaiting-unlock",
    totalUnitCount: input.totalUnitCount,
    audioContextState: input.audioContextState,
    lastError: formatSegmentedPlaybackError(input.error)
  };
}
