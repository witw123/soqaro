import type { TrackLoudness } from "@soqaro/shared";
import {
  assertDecodedPcmWithinMemoryBudget,
  resolveSupportedUploadFormat,
  streamAudioBlobPcmChunks,
  type SupportedAudioUploadFormat
} from "@/features/library/audio-asset-builder";
import { runExclusiveAudioDecodeTask } from "@/features/library/audio-decode-queue";
import { analyzeAudioBufferAsync, LoudnessAnalyzer } from "@/features/library/loudness-analysis";

export const maxLoudnessFullDecodeBytes = 24 * 1024 * 1024;
const maxCachedLoudnessEntries = 64;
const loudnessDecodeSampleRate = 48_000;

type LoudnessTrack = {
  loudness?: {
    gainDb?: number | null;
  } | null;
};

export type AnalyzeAudioBlobLoudnessOptions = {
  cacheKey?: string | null;
  signal?: AbortSignal;
};

type InFlightLoudnessEntry = {
  attach: (signal?: AbortSignal) => Promise<TrackLoudness | null>;
};

const completedLoudnessByBlob = new WeakMap<Blob, TrackLoudness | null>();
const completedLoudnessByKey = new Map<string, TrackLoudness>();
const inFlightByBlob = new WeakMap<Blob, InFlightLoudnessEntry>();
const inFlightByKey = new Map<string, InFlightLoudnessEntry>();

function readCachedLoudnessByKey(key: string): TrackLoudness | undefined {
  const existing = completedLoudnessByKey.get(key);
  if (!existing) {
    return undefined;
  }
  completedLoudnessByKey.delete(key);
  completedLoudnessByKey.set(key, existing);
  return existing;
}

function storeCachedLoudnessByKey(key: string, loudness: TrackLoudness) {
  if (completedLoudnessByKey.has(key)) {
    completedLoudnessByKey.delete(key);
  } else if (completedLoudnessByKey.size >= maxCachedLoudnessEntries) {
    const oldestKey = completedLoudnessByKey.keys().next().value;
    if (oldestKey !== undefined) {
      completedLoudnessByKey.delete(oldestKey);
    }
  }
  completedLoudnessByKey.set(key, loudness);
}

async function detectAudioBlobFormat(blob: Blob): Promise<SupportedAudioUploadFormat | null> {
  const byMetadata = resolveSupportedUploadFormat({
    name: blob instanceof File ? blob.name : "",
    type: blob.type
  });
  if (byMetadata) {
    return byMetadata;
  }
  if (blob.size < 2) {
    return null;
  }
  const header = new Uint8Array(await blob.slice(0, Math.min(blob.size, 16)).arrayBuffer());
  if (
    header.length >= 4 &&
    header[0] === 0x66 &&
    header[1] === 0x4c &&
    header[2] === 0x61 &&
    header[3] === 0x43
  ) {
    return "flac";
  }
  if (
    header.length >= 12 &&
    header[0] === 0x52 &&
    header[1] === 0x49 &&
    header[2] === 0x46 &&
    header[3] === 0x46 &&
    header[8] === 0x57 &&
    header[9] === 0x41 &&
    header[10] === 0x56 &&
    header[11] === 0x45
  ) {
    return "wav";
  }
  if (
    (header.length >= 3 && header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) ||
    (header.length >= 2 && header[0] === 0xff && (header[1]! & 0xe0) === 0xe0)
  ) {
    return "mp3";
  }
  if (
    header.length >= 8 &&
    header[4] === 0x66 &&
    header[5] === 0x74 &&
    header[6] === 0x79 &&
    header[7] === 0x70
  ) {
    return "m4a";
  }
  return null;
}

async function analyzeStreamingAudioBlobLoudness(
  blob: Blob,
  format: "flac" | "wav" | "mp3",
  signal: AbortSignal
): Promise<TrackLoudness | null> {
  let analyzer: LoudnessAnalyzer | null = null;
  let channelCount: number | null = null;
  let sampleRate: number | null = null;
  await streamAudioBlobPcmChunks(blob, format, signal, (chunk) => {
    if (chunk.channels.length < 1 || chunk.channels.length > 2) {
      throw new Error("Unsupported channel count for streaming loudness analysis.");
    }
    if (!analyzer) {
      channelCount = chunk.channels.length;
      sampleRate = chunk.sampleRate;
      analyzer = new LoudnessAnalyzer(chunk.sampleRate, chunk.channels.length);
    } else if (channelCount !== chunk.channels.length || sampleRate !== chunk.sampleRate) {
      throw new Error("Inconsistent audio format during streaming loudness analysis.");
    }
    analyzer.push({
      sampleRate: chunk.sampleRate,
      channels: chunk.channels
    });
  });
  return analyzer ? (analyzer as LoudnessAnalyzer).finish() : null;
}

async function decodeAndAnalyzeAudioBlobLoudness(
  blob: Blob,
  signal: AbortSignal
): Promise<TrackLoudness | null> {
  if (
    blob.size <= 0 ||
    blob.size > maxLoudnessFullDecodeBytes ||
    (typeof OfflineAudioContext === "undefined" && typeof AudioContext === "undefined")
  ) {
    return null;
  }

  let offlineContext: OfflineAudioContext | null = null;
  if (typeof OfflineAudioContext === "function") {
    try {
      offlineContext = new OfflineAudioContext(1, 1, loudnessDecodeSampleRate);
    } catch {
      offlineContext = null;
    }
  }

  let audioContext: AudioContext | null = null;
  try {
    const buffer = await blob.arrayBuffer();
    if (signal.aborted) {
      return null;
    }
    let decoded: AudioBuffer;
    if (offlineContext) {
      decoded = await offlineContext.decodeAudioData(buffer);
    } else {
      audioContext = new AudioContext();
      decoded = await audioContext.decodeAudioData(buffer);
    }
    assertDecodedPcmWithinMemoryBudget({
      durationSeconds: decoded.duration,
      channels: decoded.numberOfChannels
    });
    return await analyzeAudioBufferAsync(decoded, signal);
  } catch {
    return null;
  } finally {
    await audioContext?.close().catch(() => undefined);
  }
}

async function computeAudioBlobLoudness(
  blob: Blob,
  signal: AbortSignal
): Promise<TrackLoudness | null> {
  return runExclusiveAudioDecodeTask(
    async () => {
      if (signal.aborted) {
        return null;
      }
      const format = await detectAudioBlobFormat(blob);
      if (signal.aborted) {
        return null;
      }
      if (format === "flac" || format === "wav" || format === "mp3") {
        try {
          const streamed = await analyzeStreamingAudioBlobLoudness(blob, format, signal);
          if (streamed) {
            return streamed;
          }
        } catch {
          if (signal.aborted) {
            return null;
          }
        }
      }
      return decodeAndAnalyzeAudioBlobLoudness(blob, signal);
    },
    {
      priority: "low",
      signal
    }
  ).catch(() => null);
}

/**
 * Analyze a downloaded audio blob once with serialized concurrency and streaming
 * decoders where supported so playback normalization never spikes renderer memory.
 */
export async function analyzeAudioBlobLoudness(
  blob: Blob,
  options?: AnalyzeAudioBlobLoudnessOptions
): Promise<TrackLoudness | null> {
  const signal = options?.signal;
  if (signal?.aborted || blob.size <= 0) {
    return null;
  }

  const cacheKey = options?.cacheKey?.trim() || undefined;
  if (cacheKey) {
    const cachedByKey = readCachedLoudnessByKey(cacheKey);
    if (cachedByKey) {
      return cachedByKey;
    }
  }
  if (completedLoudnessByBlob.has(blob)) {
    return completedLoudnessByBlob.get(blob) ?? null;
  }

  const existingInFlight =
    (cacheKey ? inFlightByKey.get(cacheKey) : undefined) ?? inFlightByBlob.get(blob);
  if (existingInFlight) {
    return existingInFlight.attach(signal);
  }

  const sharedController = new AbortController();
  let unabortableSubscribers = 0;
  let activeSignalSubscribers = 0;
  let settled = false;

  const maybeCancelSharedWork = () => {
    if (!settled && unabortableSubscribers === 0 && activeSignalSubscribers === 0) {
      sharedController.abort();
    }
  };

  const sharedPromise = computeAudioBlobLoudness(blob, sharedController.signal).finally(() => {
    settled = true;
    inFlightByBlob.delete(blob);
    if (cacheKey) {
      inFlightByKey.delete(cacheKey);
    }
  }).then((result) => {
    if (!sharedController.signal.aborted) {
      completedLoudnessByBlob.set(blob, result);
      if (cacheKey && result) {
        storeCachedLoudnessByKey(cacheKey, result);
      }
    }
    return result;
  });

  const entry: InFlightLoudnessEntry = {
    attach: (subscriberSignal?: AbortSignal) => {
      if (subscriberSignal?.aborted) {
        return Promise.resolve(null);
      }
      if (!subscriberSignal) {
        unabortableSubscribers += 1;
        return sharedPromise;
      }
      activeSignalSubscribers += 1;
      return new Promise<TrackLoudness | null>((resolve) => {
        let detached = false;
        const onAbort = () => {
          if (detached) return;
          detached = true;
          activeSignalSubscribers = Math.max(0, activeSignalSubscribers - 1);
          maybeCancelSharedWork();
          resolve(null);
        };
        subscriberSignal.addEventListener("abort", onAbort, { once: true });
        void sharedPromise.then((value) => {
          if (detached) return;
          detached = true;
          subscriberSignal.removeEventListener("abort", onAbort);
          activeSignalSubscribers = Math.max(0, activeSignalSubscribers - 1);
          resolve(value);
        });
      });
    }
  };

  inFlightByBlob.set(blob, entry);
  if (cacheKey) {
    inFlightByKey.set(cacheKey, entry);
  }

  return entry.attach(signal);
}

/** Resolve the per-track gain used by the device-local loudness normalizer. */
export function resolveLoudnessGainDb(
  track: LoudnessTrack | null | undefined,
  enabled: boolean
) {
  if (!enabled) {
    return 0;
  }

  const gainDb = track?.loudness?.gainDb;
  return typeof gainDb === "number" && Number.isFinite(gainDb)
    ? Math.min(12, Math.max(-24, gainDb))
    : 0;
}

export function resetLoudnessAnalysisCacheForTests() {
  completedLoudnessByKey.clear();
  inFlightByKey.clear();
}
