import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertDecodedPcmWithinMemoryBudget,
  estimateDecodedPcmBytes,
  maxDecodedPcmBytes,
  maxFullDecodeFileBytes,
  playbackEncoderVersion,
  playbackProfileId,
  prepareIndependentOpusSegment,
  resolveDecodePath,
  resolveEncodingConcurrency,
  resolveSupportedUploadFormat,
  slicePcmSegment,
  StreamingSincResampler
} from "./audio-asset-builder";

describe("audio asset preparation", () => {
  it("routes FLAC/WAV/MP3 to streaming decode and guards M4A full decode memory", () => {
    const source = readFileSync(new URL("./audio-asset-builder.ts", import.meta.url), "utf8");

    expect(source).toContain("const audioBuffer = await decodeAudioFile(input.file);");
    expect(source).toContain("return await encodePlaybackAsset(input, audioBuffer);");
    expect(source).toContain("prepareStreamingPlaybackAsset");
    expect(source).toContain("maxDecodedPcmBytes = 256 * 1024 * 1024");
    expect(source).toContain("FLACDecoderWebWorker");
    expect(source).toContain("MPEGDecoderWebWorker");
    expect(source).toContain("runExclusiveAudioDecodeTask");
    expect(source).toContain("beginPlaybackAssetWrite");
    expect(source).not.toContain("const allUnits");
    expect(maxFullDecodeFileBytes).toBe(64 * 1024 * 1024);
    expect(resolveDecodePath(maxDecodedPcmBytes)).toBe("full");
    expect(resolveDecodePath(maxDecodedPcmBytes + 1)).toBe("streaming");
    expect(resolveDecodePath(1024, "flac")).toBe("streaming");
    expect(resolveDecodePath(1024, "wav")).toBe("streaming");
    expect(resolveDecodePath(1024, "mp3")).toBe("streaming");
    expect(resolveDecodePath(1024, "m4a")).toBe("full");
    expect(resolveDecodePath(maxDecodedPcmBytes + 1, "m4a")).toBe("streaming");
  });

  it("publishes the server-compatible playback profile", () => {
    expect(playbackProfileId).toBe("opus-music-v4");
    expect(playbackEncoderVersion).toBe("3.4.0");
  });

  it("keeps streaming resampling in the encoder worker and batches draft writes", () => {
    const source = readFileSync(new URL("./audio-asset-builder.ts", import.meta.url), "utf8");

    expect(source).toContain("sampleRate: inputUnit.sampleRate");
    expect(source).toContain("pcm!.append(decoded.channels, false)");
    expect(source).toContain("putPlaybackAssetDraftUnits");
    expect(source).not.toContain("resampler = decoded.sampleRate");
  });

  it("accepts only the supported room source formats", () => {
    expect(resolveSupportedUploadFormat({ name: "song.flac", type: "" })).toBe("flac");
    expect(resolveSupportedUploadFormat({ name: "song", type: "audio/wav" })).toBe("wav");
    expect(resolveSupportedUploadFormat({ name: "song.mp3", type: "audio/mpeg" })).toBe("mp3");
    expect(resolveSupportedUploadFormat({ name: "song.m4a", type: "audio/mp4" })).toBe("m4a");
    expect(resolveSupportedUploadFormat({ name: "song.exe", type: "application/octet-stream" })).toBeNull();
  });

  it("keeps seek preroll as overlap metadata without shifting the room timeline", () => {
    const channel = Float32Array.from({ length: 48_000 * 5 }, (_, index) => index);
    const audioBuffer = {
      duration: 5,
      sampleRate: 48_000,
      numberOfChannels: 1,
      length: channel.length,
      getChannelData: () => channel
    };
    const firstSegment = slicePcmSegment(audioBuffer, 0);
    expect(firstSegment.channels[0]).toHaveLength(48_000 * 2 + 312);
    expect(firstSegment.trimStartSamples).toBe(0);
    expect(firstSegment.channels[0]?.[0]).toBe(0);
    expect(firstSegment.channels[0]?.[3_839]).toBe(channel[3_839]);
    expect(firstSegment.channels[0]?.[3_840]).toBe(channel[3_840]);
    expect(firstSegment.channels[0]?.[48_000 * 2]).toBe(channel[48_000 * 2]);

    const laterSegment = slicePcmSegment(audioBuffer, 1);
    expect(laterSegment.channels[0]).toHaveLength(48_000 * 2 + 3_840 + 312);
    expect(laterSegment.trimStartSamples).toBe(3_840);
    expect(laterSegment.channels[0]?.[0]).toBe(48_000 * 2 - 3_840);
    expect(laterSegment.channels[0]?.[3_840 + 48_000 * 2]).toBe(channel[48_000 * 4]);
  });

  it("keeps real post-roll and only repeats the last sample at EOF", () => {
    const postRoll = Float32Array.from({ length: 48_000 * 2 + 312 }, (_, index) =>
      index < 48_000 * 2 ? Math.sin(index / 11) : 0.25
    );
    const prepared = prepareIndependentOpusSegment({
      channels: [postRoll],
      trimStartSamples: 0,
      contentSamples: 48_000 * 2
    });

    expect(prepared.channels[0]).toHaveLength(postRoll.length);
    expect(prepared.channels[0]?.at(-1)).toBe(0.25);
    expect(prepared.trimStartSamples).toBe(0);
    expect(prepared.trimEndSamples).toBe(648);

    const eof = prepareIndependentOpusSegment({
      channels: [postRoll.subarray(0, 48_000 * 2)],
      trimStartSamples: 0,
      contentSamples: 48_000 * 2
    });
    expect(eof.channels[0]).toHaveLength(48_000 * 2 + 312);
    expect(eof.channels[0]?.at(-1)).toBe(eof.channels[0]?.at(-2));
  });

  it("rejects audio whose decoded PCM would exceed the browser memory budget", () => {
    expect(estimateDecodedPcmBytes({ durationSeconds: 600, channels: 2 }))
      .toBeLessThan(maxDecodedPcmBytes);
    expect(() =>
      assertDecodedPcmWithinMemoryBudget({ durationSeconds: 720, channels: 2 })
    ).toThrow(/256 MB/);
  });

  it("bounds segment encoding concurrency by work and available CPU", () => {
    expect(resolveEncodingConcurrency(1, 16)).toBe(1);
    expect(resolveEncodingConcurrency(20, 16)).toBe(4);
    expect(resolveEncodingConcurrency(20, 2)).toBe(1);
  });

  it("keeps resampling state across input chunks", () => {
    const resampler = new StreamingSincResampler(1, 44_100, 48_000);
    const first = resampler.append([
      Float32Array.from({ length: 44_100 }, (_, index) => Math.sin(index / 17))
    ]);
    const second = resampler.append([Float32Array.from({ length: 44_100 }, (_, index) => Math.sin((index + 44_100) / 17))]);
    const tail = resampler.finish();
    const output = [...(first[0] ?? []), ...(second[0] ?? []), ...(tail[0] ?? [])];

    expect(output).toHaveLength(Math.round(88_200 * 48_000 / 44_100));
    expect(output.every(Number.isFinite)).toBe(true);
    expect(Math.abs((second[0]?.[0] ?? 0) - (first[0]?.at(-1) ?? 0))).toBeLessThan(0.2);
  });
});
