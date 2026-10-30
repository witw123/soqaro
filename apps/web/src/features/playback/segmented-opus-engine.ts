"use client";

import type { AudioAssetUnitRecord } from "@/features/library/indexeddb";
import type { GaplessTransition, PlaybackAssetManifest, PlaybackSnapshot } from "@soqaro/shared";
import { roomAudioOutput } from "./room-audio-output";
import { playbackUnitIndexAt } from "./playback-segment-scheduler";

type ScheduledSource = {
  source: AudioBufferSourceNode;
  gain: GainNode;
  revision: number;
  endAt: number;
};

type AheadScheduleQueue = {
  nextUnitIndex: number;
  units: Map<number, AudioAssetUnitRecord>;
  decoded: Map<number, Promise<AudioBuffer>>;
  running: boolean;
};

type SyncInput = {
  manifest: PlaybackAssetManifest;
  playback: PlaybackSnapshot;
  serverNowMs: number;
  volume: number;
  loudnessGainDb?: number;
  broadcast?: boolean;
  getUnit: (unitIndex: number, signal?: AbortSignal) => Promise<AudioAssetUnitRecord | null>;
  gaplessNext?: {
    transition: GaplessTransition;
    manifest: PlaybackAssetManifest;
    getUnit: (unitIndex: number, signal?: AbortSignal) => Promise<AudioAssetUnitRecord | null>;
  } | null;
};

type SyncResult = {
  state: "idle" | "awaiting-unlock" | "paused" | "buffering" | "live" | "ended";
  bufferedUnits: number;
};

export type SourceHealthState =
  | "source-ready"
  | "source-underrun"
  | "source-silent"
  | "source-ended";

const scheduleLeadSeconds = 0.08;
const targetBufferedAheadMs = 12_000;
const scheduleAheadMs = 20_000;
const underrunGuardMs = 1_000;
const fadeDurationSeconds = 0.02;
const assetOperationTimeoutMs = 5_000;

export class SegmentedOpusEngine {
  private timelineKey: string | null = null;
  private readonly scheduled = new Map<string, ScheduledSource>();
  private readonly completed = new Set<string>();
  private readonly decoded = new Map<string, Promise<AudioBuffer>>();
  private readonly unitRecords = new Map<string, AudioAssetUnitRecord>();
  private readonly unitLoads = new Map<string, Promise<AudioAssetUnitRecord | null>>();
  private readonly aheadQueues = new Map<string, AheadScheduleQueue>();
  private readonly gaplessScheduleTasks = new Map<string, Promise<void>>();
  private wasmDecoder: import("ogg-opus-decoder").OggOpusDecoder | null = null;
  private mixBus: GainNode | null = null;
  private playbackGate: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private loudnessGain: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private broadcastGain: GainNode | null = null;
  private limiterInputAnalyser: AnalyserNode | null = null;
  private broadcastAnalyser: AnalyserNode | null = null;
  private masterGainContext: AudioContext | null = null;
  private lastAppliedVolume: number | null = null;
  private lastAppliedLoudnessGain: number | null = null;
  private contextAnchorTime: number | null = null;
  private playbackAnchorPositionMs = 0;
  private pendingTransition: {
    assetId: string;
    transitionAt: string;
    contextTime: number;
  } | null = null;
  private timelineStarted = false;
  private revision = 0;
  private destroyed = false;
  private sourceHealth: SourceHealthState = "source-underrun";
  private sourceEnergy = 0;
  private decodedPeak = 0;
  private decodedRms = 0;
  private maxSampleDelta = 0;
  private limiterInputPeak = 0;
  private limiterInputRms = 0;
  private limiterInputMaxSampleDelta = 0;
  private limiterOutputPeak = 0;
  private limiterOutputRms = 0;
  private limiterOutputMaxSampleDelta = 0;
  private underrunCount = 0;
  private lastUnderrunAt: string | null = null;
  private underrunActive = false;
  private lastDecodeError: string | null = null;
  private syncInFlight: Promise<SyncResult> | null = null;
  private syncAbortController: AbortController | null = null;
  private queuedSyncInput: SyncInput | null = null;
  private activeSyncWorkKey: string | null = null;
  private timelineGeneration = 0;
  private wasmDecodeChain: Promise<void> = Promise.resolve();
  private broadcastEnabled = true;
  private latestPlaybackRevision: number | null = null;
  private lastSyncResult: SyncResult = { state: "idle", bufferedUnits: 0 };

  async sync(input: SyncInput): Promise<SyncResult> {
    if (this.syncInFlight) {
      this.queuedSyncInput = input;
      // Scheduler ticks reuse the same timeline. Aborting a decode pass for
      // every 100 ms tick makes IndexedDB/WASM work restart repeatedly on
      // slower devices, which can turn a healthy stream into an underrun.
      // Timeline changes still cancel stale work immediately.
      if (this.activeSyncWorkKey !== getSyncWorkKey(input)) {
        this.syncAbortController?.abort();
      }
      return this.syncInFlight;
    }

    const run = this.runSyncLoop(input);
    this.syncInFlight = run;
    try {
      const result = await run;
      this.lastSyncResult = result;
      return result;
    } finally {
      if (this.syncInFlight === run) {
        this.syncInFlight = null;
      }
    }
  }

  private async runSyncLoop(input: SyncInput): Promise<SyncResult> {
    let nextInput: SyncInput | null = input;
    let result: SyncResult = { state: "idle", bufferedUnits: 0 };
    while (nextInput && !this.destroyed) {
      const controller = new AbortController();
      this.syncAbortController = controller;
      const workKey = getSyncWorkKey(nextInput);
      this.activeSyncWorkKey = workKey;
      try {
        result = await this.syncOnce(nextInput, controller.signal);
      } finally {
        if (this.syncAbortController === controller) {
          this.syncAbortController = null;
        }
        if (this.activeSyncWorkKey === workKey) {
          this.activeSyncWorkKey = null;
        }
      }
      nextInput = this.queuedSyncInput;
      this.queuedSyncInput = null;
    }
    return result;
  }

  private async syncOnce(input: SyncInput, signal: AbortSignal): Promise<SyncResult> {
    if (this.destroyed || signal.aborted) {
      return { state: "idle" as const, bufferedUnits: 0 };
    }
    const incomingPlaybackRevision = Math.floor(
      input.playback.playbackRevision ?? input.playback.queueVersion ?? 0
    );
    if (
      this.latestPlaybackRevision !== null &&
      incomingPlaybackRevision < this.latestPlaybackRevision
    ) {
      return this.lastSyncResult;
    }
    this.latestPlaybackRevision = Math.max(
      this.latestPlaybackRevision ?? incomingPlaybackRevision,
      incomingPlaybackRevision
    );
    const timelineId = input.playback.startAt;
    if (input.playback.status !== "playing" || !timelineId) {
      this.resetTimeline({ preserveCache: true });
      this.pruneDecodedCache(
        input.manifest.assetId,
        playbackUnitIndexAt(input.manifest, input.playback.positionMs),
        input.manifest.segmentDurationMs
      );
      this.sourceHealth = "source-ended";
      return { state: "paused" as const, bufferedUnits: 0 };
    }

    this.setBroadcastEnabled(input.broadcast !== false);

    const timelineKey = [
      input.manifest.assetId,
      input.playback.mediaEpoch,
      timelineId
    ].join(":");
    if (timelineKey !== this.timelineKey) {
      // Pause, resume, seek, and media changes create a new room timeline.
      // Playback-order changes only bump the room revision, so keep audio
      // already scheduled for the current timeline intact.
      const pendingTransition = this.pendingTransition;
      const canPromoteGapless = pendingTransition?.assetId === input.manifest.assetId &&
        pendingTransition.transitionAt === timelineId;
      if (canPromoteGapless) {
        this.prunePromotedTimelineState(input.manifest.assetId, timelineId, timelineKey);
        this.timelineKey = timelineKey;
        this.contextAnchorTime = pendingTransition.contextTime;
        this.playbackAnchorPositionMs = 0;
        this.timelineStarted = true;
        this.pendingTransition = null;
      } else {
        this.resetTimeline({ preserveCache: true });
      }
      this.timelineKey = timelineKey;
      this.timelineGeneration += 1;
    }
    const generation = this.timelineGeneration;

    const context = roomAudioOutput.getSharedAudioContext();
    if (!context || context.state !== "running") {
      this.sourceHealth = "source-silent";
      return { state: "awaiting-unlock" as const, bufferedUnits: 0 };
    }
    this.ensureMasterGain(context, input.volume, input.loudnessGainDb ?? 0);

    const startAtMs = Date.parse(timelineId);
    const syncContextTime = context.currentTime;
    const resolveCurrentRoomClock = () => {
      const elapsedDuringPreparationMs = Math.max(
        0,
        (context.currentTime - syncContextTime) * 1_000
      );
      const serverNowMs = input.serverNowMs + elapsedDuringPreparationMs;
      return {
        serverNowMs,
        positionMs: Math.min(
          input.manifest.durationMs,
          input.playback.positionMs + Math.max(0, serverNowMs - startAtMs)
        )
      };
    };
    let currentRoomClock = resolveCurrentRoomClock();
    let roomPositionMs = currentRoomClock.positionMs;
    let currentIndex = playbackUnitIndexAt(input.manifest, roomPositionMs);
    this.pruneDecodedCache(input.manifest.assetId, currentIndex, input.manifest.segmentDurationMs);
    if (
      roomPositionMs >= input.manifest.durationMs &&
      this.scheduled.size === 0 &&
      this.completed.has(timelineUnitKey(
        input.manifest.assetId,
        timelineId,
        input.manifest.unitCount - 1
      ))
    ) {
      this.sourceHealth = "source-ended";
      return { state: "ended" as const, bufferedUnits: 0 };
    }
    const decodeAheadUnitCount = Math.max(
      1,
      Math.ceil(scheduleAheadMs / input.manifest.segmentDurationMs)
    );
    const unitIndexes = Array.from(
      {
        length: Math.min(
          decodeAheadUnitCount,
          input.manifest.unitCount - currentIndex
        )
      },
      (_, offset) => currentIndex + offset
    );
    // The room clock is already running. Only the segment containing the
    // current position may block first sound; all future segments remain
    // parallel prefetch work and must never become a startup gate.
    const requiredUnits = 1;
    const unitPromises = unitIndexes.map((unitIndex) =>
      this.loadUnit(input, unitIndex, signal)
    );
    const units: Array<AudioAssetUnitRecord | null> = [];
    for (let index = 0; index < Math.min(requiredUnits, unitPromises.length); index += 1) {
      try {
        const loaded = await unitPromises[index]!;
        units.push(loaded);
        if (!loaded) break;
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          return { state: "idle" as const, bufferedUnits: 0 };
        }
        units.push(null);
        break;
      }
    }
    // Include any future units that have already completed in the cache. The
    // remaining reads stay in unitLoads and are picked up by the next tick.
    for (let index = units.length; index < unitIndexes.length; index += 1) {
      units.push(this.unitRecords.get(unitKey(input.manifest.assetId, unitIndexes[index]!)) ?? null);
    }
    if (signal.aborted) {
      return { state: "idle" as const, bufferedUnits: 0 };
    }
    if (this.destroyed || this.timelineKey !== timelineKey || generation !== this.timelineGeneration) {
      return { state: "idle" as const, bufferedUnits: 0 };
    }

    const contiguousUnits: AudioAssetUnitRecord[] = [];
    for (const unit of units) {
      if (!unit) break;
      contiguousUnits.push(unit);
    }
    const timelineWasStarted = this.timelineStarted;
    const currentTimelineUnitKey = timelineUnitKey(
      input.manifest.assetId,
      timelineId,
      currentIndex
    );
    const hasSafeScheduledAudio = this.hasSafeScheduledAudio(
      currentTimelineUnitKey,
      context
    );
    if (contiguousUnits.length < requiredUnits) {
      if (this.timelineStarted && hasSafeScheduledAudio) {
        this.updateSourceHealth();
        return {
          state: "live" as const,
          bufferedUnits: this.countContiguousScheduledUnits(
            input.manifest.assetId,
            timelineId,
            currentIndex
          )
        };
      }
      if (
        this.timelineStarted &&
        !hasSafeScheduledAudio &&
        roomPositionMs + underrunGuardMs < input.manifest.durationMs
      ) {
        this.enterUnderrun();
      }
      this.sourceHealth = "source-underrun";
      return { state: "buffering" as const, bufferedUnits: contiguousUnits.length };
    }

    if (!this.timelineStarted) {
      const currentUnit = contiguousUnits[0]!;
      let currentDecoded: AudioBuffer;
      try {
        currentDecoded = await this.getDecodedUnitWithRetry(context, currentUnit, signal);
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          return { state: "idle" as const, bufferedUnits: 0 };
        }
        this.enterUnderrun();
        return { state: "buffering" as const, bufferedUnits: 0 };
      }
      if (this.destroyed || this.timelineKey !== timelineKey || generation !== this.timelineGeneration) {
        return { state: "idle" as const, bufferedUnits: 0 };
      }
      currentRoomClock = resolveCurrentRoomClock();
      const preparedCurrentIndex = playbackUnitIndexAt(
        input.manifest,
        currentRoomClock.positionMs
      );
      if (preparedCurrentIndex !== currentIndex) {
        if (!this.queuedSyncInput) {
          this.queuedSyncInput = {
            ...input,
            serverNowMs: currentRoomClock.serverNowMs
          };
        }
        return { state: "buffering" as const, bufferedUnits: 0 };
      }
      roomPositionMs = currentRoomClock.positionMs;
      currentIndex = preparedCurrentIndex;
      this.establishTimelineAnchor({
        context,
        manifest: input.manifest,
        playback: input.playback,
        serverNowMs: currentRoomClock.serverNowMs,
        startAtMs,
        roomPositionMs,
        currentUnit
      });
      this.scheduleUnit({
        context,
        assetId: input.manifest.assetId,
        timelineId,
        decoded: currentDecoded,
        unit: currentUnit,
        roomPositionMs,
        currentIndex
      });
    }

    const decodeTargets = contiguousUnits.filter(
      (unit) => !this.scheduled.has(timelineUnitKey(
        input.manifest.assetId,
        timelineId,
        unit.unitIndex
      )) &&
        !this.completed.has(timelineUnitKey(
          input.manifest.assetId,
          timelineId,
          unit.unitIndex
        ))
    );
    const scheduleAheadTask = this.scheduleDecodedAhead({
      context,
      assetId: input.manifest.assetId,
      timelineId,
      timelineKey,
      generation,
      roomPositionMs,
      currentIndex,
      units: decodeTargets
    });
    if (scheduleAheadTask) {
      // Let already-cached/fast-decoded units drain before returning, while
      // yielding immediately when a real decoder is slow. This preserves the
      // cheap synchronous path without making a slow future segment block the
      // current one.
      await Promise.race([
        scheduleAheadTask,
        new Promise<void>((resolve) => setTimeout(resolve, 0))
      ]);
    }

    const bufferedUnits = this.countContiguousScheduledUnits(
      input.manifest.assetId,
      timelineId,
      currentIndex
    );
    if (input.gaplessNext) {
      try {
        const gaplessTask = this.scheduleGaplessNext(
          context,
          input.serverNowMs,
          input.gaplessNext,
          signal,
          generation
        );
        await Promise.race([
          gaplessTask,
          new Promise<void>((resolve) => setTimeout(resolve, 0))
        ]);
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          return { state: "idle" as const, bufferedUnits: 0 };
        }
        throw error;
      }
    } else {
      this.pendingTransition = null;
    }
    this.fadePlaybackGateTo(1);
    if (this.broadcastEnabled) {
      this.setBroadcastTrackEnabled(true);
    }
    this.sampleSourceEnergy(context);
    this.updateSourceHealth();
    const hasAudibleScheduledAudio = this.hasSafeScheduledAudio(
      currentTimelineUnitKey,
      context
    );
    return {
      state: (timelineWasStarted && hasAudibleScheduledAudio) || bufferedUnits * input.manifest.segmentDurationMs >= Math.min(
          targetBufferedAheadMs,
          Math.max(0, input.manifest.durationMs - roomPositionMs)
        )
        ? "live" as const
        : "buffering" as const,
      bufferedUnits,
    };
  }

  setVolume(volume: number) {
    if (this.masterGain) {
      const normalizedVolume = normalizeVolume(volume);
      if (this.lastAppliedVolume === normalizedVolume) {
        return;
      }
      rampAudioParam(this.masterGain.gain, normalizedVolume, this.masterGainContext);
      this.lastAppliedVolume = normalizedVolume;
    }
  }

  setLoudnessGainDb(gainDb: number) {
    if (this.loudnessGain) {
      const normalizedGain = normalizeGainDb(gainDb);
      if (this.lastAppliedLoudnessGain === normalizedGain) {
        return;
      }
      rampAudioParam(
        this.loudnessGain.gain,
        normalizedGain,
        this.masterGainContext
      );
      this.lastAppliedLoudnessGain = normalizedGain;
    }
  }

  setLoudnessGain(gainDb: number) {
    this.setLoudnessGainDb(gainDb);
  }

  setBroadcastEnabled(enabled: boolean) {
    if (this.broadcastEnabled === enabled) {
      return;
    }

    // A fallback engine must never leave a previously-created RTP destination
    // connected. Reset the timeline so the next sync rebuilds the graph with
    // the new output mode and keeps the room clock as the single anchor.
    this.resetTimeline({ preserveCache: true });
    this.disposeOutputGraph();
    this.broadcastEnabled = enabled;
  }

  destroy() {
    this.destroyed = true;
    this.syncAbortController?.abort();
    this.syncAbortController = null;
    this.queuedSyncInput = null;
    this.timelineGeneration += 1;
    this.resetTimeline();
    const decoder = this.wasmDecoder;
    this.wasmDecoder = null;
    if (decoder) {
      void this.wasmDecodeChain.then(() => decoder.free());
    }
    this.disposeOutputGraph();
  }

  private establishTimelineAnchor(input: {
    context: AudioContext;
    manifest: PlaybackAssetManifest;
    playback: PlaybackSnapshot;
    serverNowMs: number;
    startAtMs: number;
    roomPositionMs: number;
    currentUnit: AudioAssetUnitRecord;
  }) {
    this.playbackAnchorPositionMs = input.playback.positionMs;
    const serverAnchor =
      input.context.currentTime + (input.startAtMs - input.serverNowMs) / 1000;
    const roomPositionContextTime =
      serverAnchor + (input.roomPositionMs - input.playback.positionMs) / 1000;
    this.contextAnchorTime = roomPositionContextTime < input.context.currentTime + scheduleLeadSeconds
      ? input.context.currentTime + scheduleLeadSeconds -
        (input.roomPositionMs - input.playback.positionMs) / 1000
      : serverAnchor;
    this.timelineStarted = true;
  }

  private scheduleUnit(input: {
    context: AudioContext;
    assetId: string;
    timelineId: string;
    decoded: AudioBuffer;
    unit: AudioAssetUnitRecord;
    roomPositionMs: number;
    currentIndex: number;
    anchorTime?: number;
    anchorPositionMs?: number;
    fadeIn?: boolean;
  }) {
    const anchorTime = input.anchorTime ?? this.contextAnchorTime;
    if (anchorTime === null || anchorTime === undefined || !this.masterGain) return;
    const segmentStartMs = input.unit.startMs ?? input.unit.unitIndex * 2_000;
    const desiredSegmentStart =
      anchorTime + (segmentStartMs - (input.anchorPositionMs ?? this.playbackAnchorPositionMs)) / 1000;
    const timelineOffset = input.unit.unitIndex === input.currentIndex
      ? Math.max(0, (input.roomPositionMs - segmentStartMs) / 1000)
      : 0;
    const earliestStart = input.context.currentTime + scheduleLeadSeconds;
    const desiredAudibleStart = desiredSegmentStart + timelineOffset;
    const lateBy = Math.max(0, earliestStart - desiredAudibleStart);
    const offsetSeconds = timelineOffset + lateBy;
    const timelineKey = timelineUnitKey(input.assetId, input.timelineId, input.unit.unitIndex);
    if (offsetSeconds >= input.decoded.duration) {
      this.completed.add(timelineKey);
      return;
    }

    if (
      this.scheduled.has(timelineKey) ||
      this.completed.has(timelineKey)
    ) {
      return;
    }
    const source = input.context.createBufferSource();
    const sourceGain = input.context.createGain();
    source.buffer = input.decoded;
    source.playbackRate.value = 1;
    sourceGain.gain.value = 0;
    source.connect(sourceGain);
    const mixBus = this.mixBus ?? this.masterGain;
    if (!mixBus) {
      source.disconnect();
      sourceGain.disconnect();
      return;
    }
    sourceGain.connect(mixBus);
    const revision = this.revision;
    source.onended = () => {
      if (revision !== this.revision) return;
      this.scheduled.delete(timelineKey);
      this.completed.add(timelineKey);
      source.disconnect();
      sourceGain.disconnect();
    };
    const startAt = Math.max(earliestStart, desiredAudibleStart);
    if (
      input.fadeIn ||
      (input.unit.unitIndex === input.currentIndex && input.anchorTime === undefined)
    ) {
      // Only a timeline entry point needs a fade-in. Reapplying it to every
      // 2s continuation creates a periodic dip even when the buffers are
      // sample-contiguous.
      const fadeInEnd = startAt + fadeDurationSeconds;
      setAudioParamValueAt(sourceGain.gain, 0, startAt);
      rampAudioParamTo(sourceGain.gain, 1, fadeInEnd);
    } else {
      setAudioParamValueAt(sourceGain.gain, 1, startAt);
    }
    source.start(startAt, offsetSeconds);
    this.scheduled.set(timelineKey, {
      source,
      gain: sourceGain,
      revision,
      endAt: startAt + Math.max(0, input.decoded.duration - offsetSeconds)
    });
  }

  private loadUnit(
    input: SyncInput,
    unitIndex: number,
    signal: AbortSignal
  ) {
    const key = unitKey(input.manifest.assetId, unitIndex);
    const cached = this.unitRecords.get(key);
    if (cached) {
      return Promise.resolve<AudioAssetUnitRecord | null>(cached);
    }
    const existing = this.unitLoads.get(key);
    if (existing) {
      return existing;
    }
    const loading = withTimeout(
      input.getUnit(unitIndex, signal),
      assetOperationTimeoutMs,
      "Audio asset read timed out.",
      signal
    ).then((loaded) => {
      if (loaded) {
        this.unitRecords.set(key, loaded);
      }
      return loaded;
    }).catch(() => {
      // A missing or temporarily unreadable future unit is a buffering event,
      // not an engine-fatal error. The next scheduler tick retries it.
      return null;
    }).finally(() => {
      if (this.unitLoads.get(key) === loading) {
        this.unitLoads.delete(key);
      }
    });
    this.unitLoads.set(key, loading);
    return loading;
  }

  private scheduleDecodedAhead(input: {
    context: AudioContext;
    assetId: string;
    timelineId: string;
    timelineKey: string;
    generation: number;
    roomPositionMs: number;
    currentIndex: number;
    units: readonly AudioAssetUnitRecord[];
  }) {
    if (input.units.length === 0) return;
    const timelineKey = input.timelineKey;
    let queue = this.aheadQueues.get(timelineKey);
    if (!queue) {
      queue = {
        nextUnitIndex: input.units[0]!.unitIndex,
        units: new Map(),
        decoded: new Map(),
        running: false
      };
      this.aheadQueues.set(timelineKey, queue);
    }
    for (const unit of input.units) {
      if (unit.unitIndex < queue.nextUnitIndex) continue;
      queue.units.set(unit.unitIndex, unit);
      if (!queue.decoded.has(unit.unitIndex)) {
        queue.decoded.set(
          unit.unitIndex,
          this.getDecodedUnitWithRetry(input.context, unit)
        );
      }
    }
    if (queue.running) return;
    queue.running = true;
    const task = (async () => {
      while (
        !this.destroyed &&
        this.timelineKey === input.timelineKey &&
        this.timelineGeneration === input.generation
      ) {
        const unit = queue!.units.get(queue!.nextUnitIndex);
        const decodedPromise = queue!.decoded.get(queue!.nextUnitIndex);
        if (!unit || !decodedPromise) break;
        queue!.units.delete(queue!.nextUnitIndex);
        queue!.decoded.delete(queue!.nextUnitIndex);
        try {
          const decoded = await decodedPromise;
          if (
            this.destroyed ||
            this.timelineKey !== input.timelineKey ||
            this.timelineGeneration !== input.generation
          ) {
            break;
          }
          try {
            this.scheduleUnit({
              context: input.context,
              assetId: input.assetId,
              timelineId: input.timelineId,
              decoded,
              unit,
              roomPositionMs: input.roomPositionMs,
              currentIndex: input.currentIndex
            });
          } catch (error) {
            if (this.timelineKey === input.timelineKey && !isAbortError(error)) {
              this.lastDecodeError = formatDecodeError(error);
            }
          }
        } catch (error) {
          if (this.timelineKey === input.timelineKey && !isAbortError(error)) {
            this.lastDecodeError = formatDecodeError(error);
          }
        }
        queue!.nextUnitIndex += 1;
      }
    })();
    return task.catch((error) => {
      if (this.timelineKey === input.timelineKey && !isAbortError(error)) {
        this.lastDecodeError = formatDecodeError(error);
      }
    }).finally(() => {
      queue!.running = false;
      if (this.destroyed || this.timelineKey !== timelineKey) {
        queue!.units.clear();
        queue!.decoded.clear();
        if (this.aheadQueues.get(timelineKey) === queue) {
          this.aheadQueues.delete(timelineKey);
        }
        return;
      }
      if (
        this.aheadQueues.get(timelineKey) === queue &&
        queue!.units.size === 0 &&
        queue!.decoded.size === 0
      ) {
        this.aheadQueues.delete(timelineKey);
      }
    });
  }

  private async scheduleGaplessNext(
    context: AudioContext,
    serverNowMs: number,
    input: NonNullable<SyncInput["gaplessNext"]>,
    signal: AbortSignal,
    generation: number
  ) {
    const transitionContextTime = context.currentTime +
      (Date.parse(input.transition.transitionAt) - serverNowMs) / 1000;
    this.pendingTransition = {
      assetId: input.manifest.assetId,
      transitionAt: input.transition.transitionAt,
      contextTime: transitionContextTime
    };
    if (transitionContextTime < context.currentTime - 0.05) return;

    const taskKey = `${input.manifest.assetId}:${input.transition.transitionAt}`;
    const existing = this.gaplessScheduleTasks.get(taskKey);
    if (existing) {
      return existing;
    }

    const task = this.runGaplessSchedule({
      context,
      transitionContextTime,
      input,
      signal,
      generation
    });
    const settled = task.finally(() => {
      if (this.gaplessScheduleTasks.get(taskKey) === settled) {
        this.gaplessScheduleTasks.delete(taskKey);
      }
    });
    this.gaplessScheduleTasks.set(taskKey, settled);
    return settled;
  }

  private async runGaplessSchedule(input: {
    context: AudioContext;
    transitionContextTime: number;
    input: NonNullable<SyncInput["gaplessNext"]>;
    signal: AbortSignal;
    generation: number;
  }) {
    const { context, transitionContextTime, input: next, signal, generation } = input;
    const isCurrent = () => !this.destroyed &&
      this.timelineGeneration === generation &&
      this.pendingTransition?.transitionAt === next.transition.transitionAt;
    if (!isCurrent()) return;

    const unitCount = Math.min(
      Math.max(1, Math.ceil(scheduleAheadMs / next.manifest.segmentDurationMs)),
      next.manifest.unitCount
    );
    const decodedPromises = Array.from({ length: unitCount }, (_, unitIndex) => {
      const key = unitKey(next.manifest.assetId, unitIndex);
      const cached = this.unitRecords.get(key);
      const loaded = cached
        ? Promise.resolve<AudioAssetUnitRecord | null>(cached)
        : withTimeout(
            next.getUnit(unitIndex, signal),
            assetOperationTimeoutMs,
            "Gapless next-track audio asset read timed out.",
            signal
          ).then((record) => {
            if (record) {
              this.unitRecords.set(key, record);
            }
            return record;
          });
      return loaded.then(async (unit) => {
        if (!unit) return null;
        try {
          return {
            unit,
            decoded: await this.getDecodedUnitWithRetry(context, unit, signal)
          };
        } catch (error) {
          if (!isAbortError(error) && !signal.aborted) {
            this.lastDecodeError = formatDecodeError(error);
          }
          return null;
        }
      }).catch((error) => {
        if (!isAbortError(error) && !signal.aborted) {
          this.lastDecodeError = formatDecodeError(error);
        }
        return null;
      });
    });
    let boundaryFaded = false;
    for (const decodedPromise of decodedPromises) {
      const ready = await decodedPromise;
      if (!isCurrent() || signal.aborted) {
        return;
      }
      // Only a contiguous prefix can be scheduled on the next timeline. The
      // remaining reads/decodes continue in parallel, but never delay the
      // first ready units or make a slow tail reach the track boundary.
      if (!ready) break;
      if (!boundaryFaded) {
        const boundaryFadeStart = Math.max(
          context.currentTime,
          transitionContextTime - fadeDurationSeconds
        );
        for (const scheduled of this.scheduled.values()) {
          if (Math.abs(scheduled.endAt - transitionContextTime) > 0.1) {
            continue;
          }
          setAudioParamValueAt(scheduled.gain.gain, 1, boundaryFadeStart);
          rampAudioParamTo(scheduled.gain.gain, 0, transitionContextTime);
        }
        boundaryFaded = true;
      }
      try {
        this.scheduleUnit({
          context,
          assetId: next.manifest.assetId,
          timelineId: next.transition.transitionAt,
          decoded: ready.decoded,
          unit: ready.unit,
          roomPositionMs: 0,
          currentIndex: 0,
          anchorTime: transitionContextTime,
          anchorPositionMs: 0,
          fadeIn: ready.unit.unitIndex === 0
        });
      } catch (error) {
        this.lastDecodeError = formatDecodeError(error);
        break;
      }
    }
  }

  private getDecodedUnit(
    context: AudioContext,
    unit: AudioAssetUnitRecord,
    signal?: AbortSignal
  ) {
    const key = unitKey(unit.assetId, unit.unitIndex);
    const existing = this.decoded.get(key);
    if (existing) return existing;
    const decoding = this.decodeUnit(context, unit, signal).catch((error) => {
      if (this.decoded.get(key) === decoding) {
        this.decoded.delete(key);
      }
      throw error;
    });
    this.decoded.set(key, decoding);
    return decoding;
  }

  getSourceHealth() {
    return {
      state: this.sourceHealth,
      energy: this.sourceEnergy,
      decodedPeak: this.decodedPeak,
      decodedRms: this.decodedRms,
      maxSampleDelta: this.maxSampleDelta,
      limiterInputPeak: this.limiterInputPeak,
      limiterInputRms: this.limiterInputRms,
      limiterInputMaxSampleDelta: this.limiterInputMaxSampleDelta,
      limiterOutputPeak: this.limiterOutputPeak,
      limiterOutputRms: this.limiterOutputRms,
      limiterOutputMaxSampleDelta: this.limiterOutputMaxSampleDelta,
      underrunCount: this.underrunCount,
      lastUnderrunAt: this.lastUnderrunAt,
      lastDecodeError: this.lastDecodeError,
      trackState: roomAudioOutput.getBroadcastStream()?.getAudioTracks()[0]?.readyState ?? "ended",
      audioContextState: this.masterGainContext?.state ?? null
    } as const;
  }

  private getDecodedUnitWithRetry(
    context: AudioContext,
    unit: AudioAssetUnitRecord,
    signal?: AbortSignal
  ) {
    return this.getDecodedUnit(context, unit, signal).catch(async (firstError) => {
      if (isAbortError(firstError) || signal?.aborted) {
        throw firstError;
      }
      this.lastDecodeError = formatDecodeError(firstError);
      this.decoded.delete(unitKey(unit.assetId, unit.unitIndex));
      try {
        return await this.getDecodedUnit(context, unit, signal);
      } catch (retryError) {
        this.lastDecodeError = formatDecodeError(retryError);
        throw retryError;
      }
    });
  }

  private async decodeUnit(
    context: AudioContext,
    unit: AudioAssetUnitRecord,
    signal?: AbortSignal
  ) {
    let decoded: AudioBuffer;
    try {
      decoded = await withTimeout(
        context.decodeAudioData(unit.payload.slice(0)),
        assetOperationTimeoutMs,
        "Audio asset decode timed out.",
        signal
      );
      validateDecodedAudioBuffer(decoded, unit);
      // A 2s Opus segment can legitimately decode to digital silence during a
      // quiet passage. Treating that as a decoder failure forced a redundant
      // WASM re-decode on every such segment (audible stutter on quiet songs)
      // without ever distinguishing valid silence from a broken path, because
      // the WASM fallback result was only structurally validated. Let the
      // structure checks above stand as the decode-failure signal.
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        throw error;
      }
      const decoder = await this.getWasmDecoder();
      const result = await withTimeout(
        this.enqueueWasmDecode(decoder, new Uint8Array(unit.payload), signal),
        assetOperationTimeoutMs,
        "WASM audio asset decode timed out.",
        signal
      );
      decoded = context.createBuffer(
        result.channelData.length,
        result.samplesDecoded,
        result.sampleRate
      );
      result.channelData.forEach((channel, index) =>
        decoded.copyToChannel(Float32Array.from(channel), index)
      );
      validateDecodedAudioBuffer(decoded, unit);
    }
    const sampleScale = decoded.sampleRate / 48_000;
    const trimStart = Math.min(
      decoded.length,
      Math.max(0, Math.round((unit.trimStartSamples ?? 0) * sampleScale))
    );
    const trimEnd = Math.min(
      Math.max(0, decoded.length - trimStart),
      Math.max(0, Math.round((unit.trimEndSamples ?? 0) * sampleScale))
    );
    const availableLength = Math.max(0, decoded.length - trimStart - trimEnd);
    const targetLength = unit.durationMs
      ? Math.max(1, Math.round((unit.durationMs / 1000) * decoded.sampleRate))
      : availableLength;
    if (
      trimStart === 0 &&
      trimEnd === 0 &&
      availableLength === targetLength
    ) {
      return decoded;
    }

    // Every unit is normalized to its declared timeline length. New assets
    // have enough tail padding for this copy; zero-fill only protects playback
    // from malformed or truncated payloads without leaking the next segment.
    const normalized = context.createBuffer(
      decoded.numberOfChannels,
      targetLength,
      decoded.sampleRate
    );
    const copyLength = Math.min(targetLength, availableLength);
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      normalized.copyToChannel(
        decoded.getChannelData(channel).subarray(trimStart, trimStart + copyLength),
        channel
      );
    }
    return normalized;
  }

  private async getWasmDecoder() {
    if (this.destroyed) {
      throw createAbortError();
    }
    if (!this.wasmDecoder) {
      const { OggOpusDecoder } = await import("ogg-opus-decoder");
      this.wasmDecoder = new OggOpusDecoder();
      await this.wasmDecoder.ready;
    }
    return this.wasmDecoder;
  }

  private enqueueWasmDecode(
    decoder: import("ogg-opus-decoder").OggOpusDecoder,
    payload: Uint8Array,
    signal?: AbortSignal
  ) {
    const decode = this.wasmDecodeChain.then(() => {
      if (this.destroyed || this.wasmDecoder !== decoder || signal?.aborted) {
        throw createAbortError();
      }
      return decoder.decodeFile(payload);
    });
    this.wasmDecodeChain = decode.then(
      () => undefined,
      () => undefined
    );
    return decode;
  }

  private ensureMasterGain(context: AudioContext, volume: number, loudnessGainDb: number) {
    if (this.masterGain && this.masterGainContext === context) {
      const normalizedVolume = normalizeVolume(volume);
      const normalizedGain = normalizeGainDb(loudnessGainDb);
      if (this.lastAppliedVolume !== normalizedVolume) {
        rampAudioParam(this.masterGain.gain, normalizedVolume, context);
        this.lastAppliedVolume = normalizedVolume;
      }
      if (this.lastAppliedLoudnessGain !== normalizedGain) {
        rampAudioParam(this.loudnessGain!.gain, normalizedGain, context);
        this.lastAppliedLoudnessGain = normalizedGain;
      }
      return;
    }
    this.disposeOutputGraph();
    this.mixBus = context.createGain();
    this.playbackGate = context.createGain();
    this.playbackGate.gain.value = 0;
    this.mixBus.connect(this.playbackGate);
    this.limiter = typeof context.createDynamicsCompressor === "function"
      ? context.createDynamicsCompressor()
      : null;
    if (this.limiter) {
      this.limiter.threshold.value = -1;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.05;
      if (typeof context.createAnalyser === "function") {
        this.limiterInputAnalyser = context.createAnalyser();
        this.limiterInputAnalyser.fftSize = 1024;
        this.playbackGate.connect(this.limiterInputAnalyser);
        this.limiterInputAnalyser.connect(this.limiter);
      } else {
        this.playbackGate.connect(this.limiter);
      }
    }
    const output = this.limiter ?? this.playbackGate;
    this.loudnessGain = context.createGain();
    const normalizedGain = normalizeGainDb(loudnessGainDb);
    this.loudnessGain.gain.value = normalizedGain;
    output.connect(this.loudnessGain);
    this.masterGain = context.createGain();
    const normalizedVolume = normalizeVolume(volume);
    this.masterGain.gain.value = normalizedVolume;
    this.loudnessGain.connect(this.masterGain);
    this.masterGain.connect(context.destination);
    const broadcastDestination = this.broadcastEnabled
      ? roomAudioOutput.getBroadcastDestination(context)
      : null;
    if (broadcastDestination) {
      this.broadcastGain = context.createGain();
      this.broadcastGain.gain.value = 1;
      this.broadcastAnalyser = context.createAnalyser();
      this.broadcastAnalyser.fftSize = 1024;
      output.connect(this.broadcastGain);
      this.broadcastGain.connect(this.broadcastAnalyser);
      this.broadcastAnalyser.connect(broadcastDestination);
    } else {
      this.broadcastGain = null;
    }
    this.masterGainContext = context;
    this.lastAppliedVolume = normalizedVolume;
    this.lastAppliedLoudnessGain = normalizedGain;
  }

  private countContiguousScheduledUnits(assetId: string, timelineId: string, currentIndex: number) {
    let count = 0;
    for (let unitIndex = currentIndex; ; unitIndex += 1) {
      const key = timelineUnitKey(assetId, timelineId, unitIndex);
      if (!this.scheduled.has(key) && !this.completed.has(key)) break;
      count += 1;
    }
    return count;
  }

  private hasSafeScheduledAudio(timelineKey: string, context: AudioContext) {
    const scheduled = this.scheduled.get(timelineKey);
    return Boolean(
      scheduled &&
      scheduled.endAt > context.currentTime + underrunGuardMs / 1000
    );
  }

  private hasScheduledAudio(context: AudioContext) {
    return [...this.scheduled.values()].some((scheduled) =>
      scheduled.endAt > context.currentTime
    );
  }

  private hasInFlightUnitWork() {
    if (this.unitLoads.size > 0) {
      return true;
    }
    for (const queue of this.aheadQueues.values()) {
      if (queue.running && (queue.units.size > 0 || queue.decoded.size > 0)) {
        return true;
      }
    }
    return false;
  }

  private updateSourceHealth() {
    const trackState = this.broadcastEnabled
      ? roomAudioOutput.getBroadcastStream()?.getAudioTracks()[0]?.readyState
      : "live";
    // A live RTP track may legitimately carry zero-energy PCM during a quiet
    // or silent part of a song. Energy is useful telemetry, but it cannot
    // distinguish valid silence from a broken media path.
    this.sourceHealth = trackState === "live" ? "source-ready" : "source-silent";
    if (trackState === "live") {
      this.underrunActive = false;
    }
  }

  private pruneDecodedCache(assetId: string, currentIndex: number, segmentDurationMs: number) {
    const retainAheadUnitCount = Math.max(1, Math.ceil(scheduleAheadMs / segmentDurationMs) + 1);
    const lastRetainedIndex = currentIndex + retainAheadUnitCount;
    this.pruneUnitCache(this.decoded, assetId, currentIndex, lastRetainedIndex);
    this.pruneUnitCache(this.unitRecords, assetId, currentIndex, lastRetainedIndex);
  }

  private pruneUnitCache<T>(
    cache: Map<string, T>,
    currentAssetId: string,
    currentIndex: number,
    lastRetainedIndex: number
  ) {
    for (const key of cache.keys()) {
      const separatorIndex = key.lastIndexOf(":");
      if (separatorIndex <= 0) {
        continue;
      }
      const assetId = key.slice(0, separatorIndex);
      const unitIndex = Number(key.slice(separatorIndex + 1));
      if (!Number.isInteger(unitIndex)) {
        continue;
      }
      const isCurrentWindow = assetId === currentAssetId &&
        unitIndex >= currentIndex &&
        unitIndex <= lastRetainedIndex;
      if (
        !isCurrentWindow &&
        !this.isPendingTransitionAsset(assetId) &&
        !this.isScheduledForAnyTimeline(assetId, unitIndex)
      ) {
        cache.delete(key);
      }
    }
  }

  private isScheduledForAnyTimeline(assetId: string, unitIndex: number) {
    return [...this.scheduled.keys()].some((scheduledKey) =>
      scheduledKey.startsWith(`${assetId}:`) && scheduledKey.endsWith(`:${unitIndex}`)
    );
  }

  private isPendingTransitionAsset(assetId: string) {
    return this.pendingTransition?.assetId === assetId;
  }

  private enterUnderrun() {
    if (!this.underrunActive) {
      this.underrunCount += 1;
      this.lastUnderrunAt = new Date().toISOString();
    }
    this.underrunActive = true;
    const context = this.masterGainContext;
    // Keep already scheduled audio alive while a future read/decode is
    // catching up. Stopping the queue here turns a short storage or decoder
    // hiccup into a full audible gap and throws away useful prefetched audio.
    if (this.timelineStarted && context && this.hasScheduledAudio(context)) {
      this.sourceHealth = "source-underrun";
      return;
    }
    // Even when the scheduled cushion is exhausted, a unit read or decode
    // that is already in flight can refill the buffer on the next tick.
    // Hard-stopping here turns a slow IndexedDB/repository read (up to the
    // 5s asset timeout) into a full 4s startup re-buffer for every listener.
    // Only hard-stop when there is genuinely no in-flight work left to wait
    // on, so a transient stall recovers on the next tick instead of forcing
    // every listener through a full rebuffer.
    if (this.timelineStarted && this.hasInFlightUnitWork()) {
      this.sourceHealth = "source-underrun";
      return;
    }
    this.stopScheduledSources();
    this.aheadQueues.clear();
    this.completed.clear();
    this.contextAnchorTime = null;
    this.pendingTransition = null;
    this.timelineStarted = false;
    this.sourceHealth = "source-underrun";
    this.fadePlaybackGateTo(0);
  }

  private setBroadcastTrackEnabled(enabled: boolean) {
    for (const track of roomAudioOutput.getBroadcastStream()?.getAudioTracks() ?? []) {
      track.enabled = enabled;
    }
  }

  private sampleSourceEnergy(context: AudioContext) {
    const outputAnalyser = this.broadcastAnalyser;
    if (!outputAnalyser || context.state !== "running") {
      this.sourceEnergy = 0;
      return;
    }
    const outputMetrics = readAnalyserMetrics(outputAnalyser);
    const inputMetrics = this.limiterInputAnalyser
      ? readAnalyserMetrics(this.limiterInputAnalyser)
      : outputMetrics;
    this.sourceEnergy = outputMetrics.rms;
    this.decodedRms = outputMetrics.rms;
    this.decodedPeak = outputMetrics.peak;
    this.maxSampleDelta = outputMetrics.maxSampleDelta;
    this.limiterInputPeak = inputMetrics.peak;
    this.limiterInputRms = inputMetrics.rms;
    this.limiterInputMaxSampleDelta = inputMetrics.maxSampleDelta;
    this.limiterOutputPeak = outputMetrics.peak;
    this.limiterOutputRms = outputMetrics.rms;
    this.limiterOutputMaxSampleDelta = outputMetrics.maxSampleDelta;
  }

  private stopScheduledSources() {
    this.revision += 1;
    const scheduled = [...this.scheduled.values()];
    this.scheduled.clear();
    const context = this.masterGainContext;
    const now = context?.currentTime ?? 0;
    const stopAt = now + fadeDurationSeconds;
    for (const scheduledSource of scheduled) {
      const { source, gain: sourceGain } = scheduledSource;
      source.onended = null;
      setAudioParamValueAt(sourceGain.gain, sourceGain.gain.value, now);
      rampAudioParamTo(sourceGain.gain, 0, stopAt);
      const cleanup = () => {
        source.disconnect();
        sourceGain.disconnect();
      };
      source.onended = cleanup;
      try {
        source.stop(stopAt);
      } catch {
        // The source may already have ended.
        cleanup();
      }
    }
  }

  private prunePromotedTimelineState(
    assetId: string,
    timelineId: string,
    activeTimelineKey: string
  ) {
    for (const [queuedTimelineKey, queue] of this.aheadQueues.entries()) {
      if (queuedTimelineKey !== activeTimelineKey) {
        queue.units.clear();
        queue.decoded.clear();
        this.aheadQueues.delete(queuedTimelineKey);
      }
    }
    const activeCompletedPrefix = `${assetId}:${timelineId}:`;
    for (const completedKey of this.completed) {
      if (!completedKey.startsWith(activeCompletedPrefix)) {
        this.completed.delete(completedKey);
      }
    }
  }

  private resetTimeline(options: { preserveCache?: boolean } = {}) {
    this.stopScheduledSources();
    this.aheadQueues.clear();
    this.gaplessScheduleTasks.clear();
    this.pendingTransition = null;
    this.completed.clear();
    this.timelineKey = null;
    this.contextAnchorTime = null;
    this.playbackAnchorPositionMs = 0;
    this.timelineStarted = false;
    if (!options.preserveCache) {
      this.decoded.clear();
      this.unitRecords.clear();
    }
    this.sourceHealth = "source-underrun";
    this.sourceEnergy = 0;
    this.decodedPeak = 0;
    this.decodedRms = 0;
    this.maxSampleDelta = 0;
    this.limiterInputPeak = 0;
    this.limiterInputRms = 0;
    this.limiterInputMaxSampleDelta = 0;
    this.limiterOutputPeak = 0;
    this.limiterOutputRms = 0;
    this.limiterOutputMaxSampleDelta = 0;
    this.lastDecodeError = null;
    this.underrunActive = false;
    this.fadePlaybackGateTo(0);
  }

  private fadePlaybackGateTo(value: number) {
    if (!this.playbackGate || !this.masterGainContext) return;
    rampAudioParam(this.playbackGate.gain, value, this.masterGainContext);
  }

  private disposeOutputGraph() {
    this.mixBus?.disconnect();
    this.playbackGate?.disconnect();
    this.limiter?.disconnect();
    this.loudnessGain?.disconnect();
    this.masterGain?.disconnect();
    this.broadcastGain?.disconnect();
    this.limiterInputAnalyser?.disconnect();
    this.broadcastAnalyser?.disconnect();
    this.mixBus = null;
    this.playbackGate = null;
    this.limiter = null;
    this.loudnessGain = null;
    this.masterGain = null;
    this.broadcastGain = null;
    this.limiterInputAnalyser = null;
    this.broadcastAnalyser = null;
    this.masterGainContext = null;
    this.lastAppliedVolume = null;
    this.lastAppliedLoudnessGain = null;
  }
}

function normalizeVolume(volume: number) {
  return Math.min(1, Math.max(0, volume));
}

function normalizeGainDb(value: number) {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(4, Math.max(0.063, 10 ** (value / 20)));
}

function unitKey(assetId: string, unitIndex: number) {
  return `${assetId}:${unitIndex}`;
}

function timelineUnitKey(assetId: string, timelineId: string, unitIndex: number) {
  return `${assetId}:${timelineId}:${unitIndex}`;
}

function getSyncWorkKey(input: SyncInput) {
  return [
    input.manifest.assetId,
    input.playback.currentTrackId,
    input.playback.mediaEpoch,
    input.playback.status,
    input.playback.startAt ?? "none"
  ].join(":");
}

function formatDecodeError(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : String(error);
}

function validateDecodedAudioBuffer(
  decoded: AudioBuffer,
  unit: AudioAssetUnitRecord
) {
  if (
    decoded.numberOfChannels < 1 ||
    decoded.numberOfChannels > 2 ||
    decoded.length <= 0 ||
    !Number.isFinite(decoded.sampleRate) ||
    decoded.sampleRate <= 0
  ) {
    throw new Error("Audio asset decoder returned an invalid AudioBuffer.");
  }

  const sampleScale = decoded.sampleRate / 48_000;
  const trimStart = Math.min(
    decoded.length,
    Math.max(0, Math.round((unit.trimStartSamples ?? 0) * sampleScale))
  );
  const trimEnd = Math.min(
    Math.max(0, decoded.length - trimStart),
    Math.max(0, Math.round((unit.trimEndSamples ?? 0) * sampleScale))
  );
  if (decoded.length - trimStart - trimEnd <= 0) {
    throw new Error("Audio asset decoder returned an empty playable range.");
  }

  for (let channelIndex = 0; channelIndex < decoded.numberOfChannels; channelIndex += 1) {
    const channel = decoded.getChannelData(channelIndex);
    for (let index = 0; index < channel.length; index += 1) {
      if (!Number.isFinite(channel[index])) {
        throw new Error("Audio asset decoder returned non-finite PCM samples.");
      }
    }
  }
}

function createAbortError() {
  const error = new Error("Audio operation aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function readAnalyserMetrics(analyser: AnalyserNode) {
  const values = new Float32Array(analyser.fftSize);
  if (typeof analyser.getFloatTimeDomainData === "function") {
    analyser.getFloatTimeDomainData(values);
  } else {
    const bytes = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(bytes);
    for (let index = 0; index < bytes.length; index += 1) {
      values[index] = (bytes[index]! - 128) / 128;
    }
  }

  let sum = 0;
  let peak = 0;
  let maxSampleDelta = 0;
  let previous = 0;
  for (const value of values) {
    sum += value * value;
    peak = Math.max(peak, Math.abs(value));
    maxSampleDelta = Math.max(maxSampleDelta, Math.abs(value - previous));
    previous = value;
  }
  return {
    peak,
    rms: values.length > 0 ? Math.sqrt(sum / values.length) : 0,
    maxSampleDelta
  };
}

function setAudioParamValueAt(param: AudioParam, value: number, time: number) {
  if (typeof param.cancelScheduledValues === "function") {
    param.cancelScheduledValues(time);
  }
  if (typeof param.setValueAtTime === "function") {
    param.setValueAtTime(value, time);
  } else {
    param.value = value;
  }
}

function rampAudioParamTo(param: AudioParam, value: number, time: number) {
  if (typeof param.linearRampToValueAtTime === "function") {
    param.linearRampToValueAtTime(value, time);
  } else {
    param.value = value;
  }
}

function rampAudioParam(param: AudioParam, value: number, context: AudioContext | null) {
  const now = context?.currentTime ?? 0;
  setAudioParamValueAt(param, param.value, now);
  rampAudioParamTo(param, value, now + fadeDurationSeconds);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(createAbortError()));
    const timer = setTimeout(() => finish(() => reject(new Error(message))), timeoutMs);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}
