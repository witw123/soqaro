import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeAudioBlobLoudness,
  maxLoudnessFullDecodeBytes,
  resetLoudnessAnalysisCacheForTests,
  resolveLoudnessGainDb
} from "./loudness";

describe("resolveLoudnessGainDb", () => {
  it("uses the track gain only when normalization is enabled", () => {
    const track = { loudness: { gainDb: -8 } };

    expect(resolveLoudnessGainDb(track, true)).toBe(-8);
    expect(resolveLoudnessGainDb(track, false)).toBe(0);
  });

  it("clamps invalid or extreme track gains", () => {
    expect(resolveLoudnessGainDb({ loudness: { gainDb: 30 } }, true)).toBe(12);
    expect(resolveLoudnessGainDb({ loudness: { gainDb: -30 } }, true)).toBe(-24);
    expect(resolveLoudnessGainDb({ loudness: undefined }, true)).toBe(0);
  });
});

describe("analyzeAudioBlobLoudness", () => {
  const originalOfflineAudioContext = globalThis.OfflineAudioContext;

  afterEach(() => {
    resetLoudnessAnalysisCacheForTests();
    if (originalOfflineAudioContext) {
      globalThis.OfflineAudioContext = originalOfflineAudioContext;
    } else {
      delete (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext;
    }
    vi.restoreAllMocks();
  });

  it("deduplicates concurrent loudness analysis across distinct File instances sharing a cacheKey", async () => {
    const samples = Float32Array.from({ length: 48_000 }, (_, i) => Math.sin(i / 13) * 0.25);
    const decodeAudioData = vi.fn(async () => ({
      duration: 1,
      sampleRate: 48_000,
      numberOfChannels: 1,
      length: samples.length,
      getChannelData: () => samples
    })) as unknown as OfflineAudioContext["decodeAudioData"];

    globalThis.OfflineAudioContext = class MockOfflineAudioContext {
      decodeAudioData = decodeAudioData;
    } as unknown as typeof OfflineAudioContext;

    const firstFile = new File([new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70])], "a.m4a", {
      type: "audio/mp4"
    });
    const secondFile = new File([new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70])], "b.m4a", {
      type: "audio/mp4"
    });

    const [firstResult, secondResult] = await Promise.all([
      analyzeAudioBlobLoudness(firstFile, { cacheKey: "same-track-hash" }),
      analyzeAudioBlobLoudness(secondFile, { cacheKey: "same-track-hash" })
    ]);

    expect(decodeAudioData).toHaveBeenCalledTimes(1);
    expect(firstResult).not.toBeNull();
    expect(secondResult).toEqual(firstResult);
  });

  it("skips full-buffer decoding when an M4A blob exceeds maxLoudnessFullDecodeBytes", async () => {
    const decodeAudioData = vi.fn();
    globalThis.OfflineAudioContext = class MockOfflineAudioContext {
      decodeAudioData = decodeAudioData;
    } as unknown as typeof OfflineAudioContext;

    const oversizedBlob = {
      size: maxLoudnessFullDecodeBytes + 1,
      type: "audio/mp4",
      slice: () => new Blob([new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70])]),
      arrayBuffer: vi.fn(async () => new ArrayBuffer(0))
    } as unknown as Blob;

    await expect(analyzeAudioBlobLoudness(oversizedBlob)).resolves.toBeNull();
    expect(decodeAudioData).not.toHaveBeenCalled();
    expect(oversizedBlob.arrayBuffer).not.toHaveBeenCalled();
  });
});
