import type { TrackLoudness } from "@soqaro/shared";

export const loudnessTargetLufs = -14 as const;
export const loudnessVersion = 1 as const;

type PcmInput = {
  sampleRate: number;
  channels: ReadonlyArray<Float32Array>;
};

type BiquadCoefficients = {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
};

type BiquadState = {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
};

const loudnessBlockMs = 400;
const loudnessStepMs = 100;
const absoluteGateLufs = -70;
const relativeGateOffsetLufs = -10;
const truePeakFloorDbtp = -120;
const maxBoostDb = 12;
const maxCutDb = -24;
const truePeakCeilingDbtp = -1;

const asyncChunkSeconds = 8;

export function analyzeAudioBuffer(input: {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  getChannelData: (channel: number) => Float32Array;
}): TrackLoudness {
  const analyzer = new LoudnessAnalyzer(input.sampleRate, input.numberOfChannels);
  const channels = Array.from(
    { length: input.numberOfChannels },
    (_, channelIndex) => input.getChannelData(channelIndex)
  );
  analyzer.push({ sampleRate: input.sampleRate, channels });
  return analyzer.finish();
}

export async function analyzeAudioBufferAsync(
  input: {
    sampleRate: number;
    numberOfChannels: number;
    length: number;
    getChannelData: (channel: number) => Float32Array;
  },
  signal?: AbortSignal
): Promise<TrackLoudness> {
  const analyzer = new LoudnessAnalyzer(input.sampleRate, input.numberOfChannels);
  const fullChannels = Array.from(
    { length: input.numberOfChannels },
    (_, channelIndex) => input.getChannelData(channelIndex)
  );
  const chunkFrames = Math.max(4_096, Math.round(input.sampleRate * asyncChunkSeconds));
  for (let offset = 0; offset < input.length; offset += chunkFrames) {
    if (signal?.aborted) {
      throw new DOMException("Audio loudness analysis was cancelled.", "AbortError");
    }
    const end = Math.min(input.length, offset + chunkFrames);
    analyzer.push({
      sampleRate: input.sampleRate,
      channels: fullChannels.map((channel) => channel.subarray(offset, end))
    });
    if (end < input.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  return analyzer.finish();
}

export class LoudnessAnalyzer {
  private readonly blockSamples: number;
  private readonly stepSamples: number;
  private readonly ring: Float64Array;
  private readonly shelfStates: BiquadState[];
  private readonly highPassStates: BiquadState[];
  private readonly shelf: BiquadCoefficients;
  private readonly highPass: BiquadCoefficients;
  private readonly blockEnergies: number[] = [];
  private ringOffset = 0;
  private ringCount = 0;
  private ringEnergy = 0;
  private sampleCount = 0;
  private lastBlockEnd = 0;
  private peak = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly channelCount: number
  ) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error("响度分析采样率无效。");
    }
    if (channelCount < 1 || channelCount > 2) {
      throw new Error("响度分析仅支持单声道或双声道。");
    }
    this.blockSamples = Math.max(1, Math.round(sampleRate * loudnessBlockMs / 1000));
    this.stepSamples = Math.max(1, Math.round(sampleRate * loudnessStepMs / 1000));
    this.ring = new Float64Array(this.blockSamples);
    this.shelf = designHighShelf(sampleRate);
    this.highPass = designHighPass(sampleRate);
    this.shelfStates = Array.from({ length: channelCount }, () => createBiquadState());
    this.highPassStates = Array.from({ length: channelCount }, () => createBiquadState());
  }

  push(input: PcmInput) {
    if (input.sampleRate !== this.sampleRate) {
      throw new Error("响度分析输入采样率发生变化。");
    }
    if (input.channels.length !== this.channelCount) {
      throw new Error("响度分析输入声道数发生变化。");
    }
    const frameCount = input.channels[0]?.length ?? 0;
    if (input.channels.some((channel) => channel.length !== frameCount)) {
      throw new Error("响度分析输入声道长度不一致。");
    }

    const ch0 = input.channels[0];
    if (!ch0 || frameCount === 0) return;

    const sb0 = this.shelf.b0;
    const sb1 = this.shelf.b1;
    const sb2 = this.shelf.b2;
    const sa1 = this.shelf.a1;
    const sa2 = this.shelf.a2;
    const hb0 = this.highPass.b0;
    const hb1 = this.highPass.b1;
    const hb2 = this.highPass.b2;
    const ha1 = this.highPass.a1;
    const ha2 = this.highPass.a2;

    const s0 = this.shelfStates[0]!;
    const h0 = this.highPassStates[0]!;
    let s0x1 = s0.x1, s0x2 = s0.x2, s0y1 = s0.y1, s0y2 = s0.y2;
    let h0x1 = h0.x1, h0x2 = h0.x2, h0y1 = h0.y1, h0y2 = h0.y2;
    let peak = this.peak;

    if (this.channelCount === 1) {
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        const sample = ch0[frameIndex]!;
        const abs = sample < 0 ? -sample : sample;
        if (abs > peak) peak = abs;

        const shelfOut = sb0 * sample + sb1 * s0x1 + sb2 * s0x2 - sa1 * s0y1 - sa2 * s0y2;
        s0x2 = s0x1; s0x1 = sample; s0y2 = s0y1; s0y1 = shelfOut;

        const weighted = hb0 * shelfOut + hb1 * h0x1 + hb2 * h0x2 - ha1 * h0y1 - ha2 * h0y2;
        h0x2 = h0x1; h0x1 = shelfOut; h0y2 = h0y1; h0y1 = weighted;

        this.appendEnergy(weighted * weighted);
      }
    } else {
      const ch1 = input.channels[1]!;
      const s1 = this.shelfStates[1]!;
      const h1 = this.highPassStates[1]!;
      let s1x1 = s1.x1, s1x2 = s1.x2, s1y1 = s1.y1, s1y2 = s1.y2;
      let h1x1 = h1.x1, h1x2 = h1.x2, h1y1 = h1.y1, h1y2 = h1.y2;

      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        const sample0 = ch0[frameIndex]!;
        const abs0 = sample0 < 0 ? -sample0 : sample0;
        if (abs0 > peak) peak = abs0;
        const shelf0 = sb0 * sample0 + sb1 * s0x1 + sb2 * s0x2 - sa1 * s0y1 - sa2 * s0y2;
        s0x2 = s0x1; s0x1 = sample0; s0y2 = s0y1; s0y1 = shelf0;
        const weighted0 = hb0 * shelf0 + hb1 * h0x1 + hb2 * h0x2 - ha1 * h0y1 - ha2 * h0y2;
        h0x2 = h0x1; h0x1 = shelf0; h0y2 = h0y1; h0y1 = weighted0;

        const sample1 = ch1[frameIndex]!;
        const abs1 = sample1 < 0 ? -sample1 : sample1;
        if (abs1 > peak) peak = abs1;
        const shelf1 = sb0 * sample1 + sb1 * s1x1 + sb2 * s1x2 - sa1 * s1y1 - sa2 * s1y2;
        s1x2 = s1x1; s1x1 = sample1; s1y2 = s1y1; s1y1 = shelf1;
        const weighted1 = hb0 * shelf1 + hb1 * h1x1 + hb2 * h1x2 - ha1 * h1y1 - ha2 * h1y2;
        h1x2 = h1x1; h1x1 = shelf1; h1y2 = h1y1; h1y1 = weighted1;

        this.appendEnergy(weighted0 * weighted0 + weighted1 * weighted1);
      }

      s1.x1 = s1x1; s1.x2 = s1x2; s1.y1 = s1y1; s1.y2 = s1y2;
      h1.x1 = h1x1; h1.x2 = h1x2; h1.y1 = h1y1; h1.y2 = h1y2;
    }

    s0.x1 = s0x1; s0.x2 = s0x2; s0.y1 = s0y1; s0.y2 = s0y2;
    h0.x1 = h0x1; h0.x2 = h0x2; h0.y1 = h0y1; h0.y2 = h0y2;
    this.peak = peak;
  }

  finish(): TrackLoudness {
    if (this.ringCount > 0 && this.lastBlockEnd !== this.sampleCount) {
      this.blockEnergies.push(this.ringEnergy / this.ringCount);
      this.lastBlockEnd = this.sampleCount;
    }

    const absoluteBlocks = this.blockEnergies.filter((energy) =>
      toLufs(energy) >= absoluteGateLufs
    );
    const ungatedEnergy = average(absoluteBlocks);
    const ungatedLufs = toLufs(ungatedEnergy);
    const relativeGate = ungatedLufs + relativeGateOffsetLufs;
    const gatedBlocks = absoluteBlocks.filter((energy) => toLufs(energy) >= relativeGate);
    const integratedLufs = toLufs(average(gatedBlocks.length > 0 ? gatedBlocks : absoluteBlocks));
    const truePeakDbtp = this.peak > 0
      ? 20 * Math.log10(this.peak)
      : truePeakFloorDbtp;
    const requestedGainDb = loudnessTargetLufs - integratedLufs;
    const peakLimitedGainDb = truePeakCeilingDbtp - truePeakDbtp;
    const gainDb = clamp(
      Math.min(requestedGainDb, peakLimitedGainDb),
      maxCutDb,
      maxBoostDb
    );

    return {
      integratedLufs: roundMetric(integratedLufs),
      truePeakDbtp: roundMetric(truePeakDbtp),
      gainDb: roundMetric(gainDb),
      targetLufs: loudnessTargetLufs,
      version: loudnessVersion
    };
  }

  private appendEnergy(energy: number) {
    if (this.ringCount < this.blockSamples) {
      const index = (this.ringOffset + this.ringCount) % this.blockSamples;
      this.ring[index] = energy;
      this.ringCount += 1;
      this.ringEnergy += energy;
    } else {
      const removed = this.ring[this.ringOffset] ?? 0;
      this.ring[this.ringOffset] = energy;
      this.ringOffset = (this.ringOffset + 1) % this.blockSamples;
      this.ringEnergy += energy - removed;
    }

    this.sampleCount += 1;
    if (
      this.ringCount === this.blockSamples &&
      this.sampleCount - this.lastBlockEnd >= this.stepSamples
    ) {
      this.blockEnergies.push(this.ringEnergy / this.blockSamples);
      this.lastBlockEnd = this.sampleCount;
    }
  }
}

function designHighShelf(sampleRate: number): BiquadCoefficients {
  const f0 = 1681.974450955533;
  const gain = 3.999843853973347;
  const q = 0.7071752369554196;
  const k = Math.tan(Math.PI * f0 / sampleRate);
  const v = 10 ** (gain / 20);
  const rootV = v ** 0.499666774455;
  const a0 = 1 + k / q + k * k;
  return {
    b0: (v + rootV * k / q + k * k) / a0,
    b1: 2 * (k * k - v) / a0,
    b2: (v - rootV * k / q + k * k) / a0,
    a1: 2 * (k * k - 1) / a0,
    a2: (1 - k / q + k * k) / a0
  };
}

function designHighPass(sampleRate: number): BiquadCoefficients {
  const f0 = 38.13547087602444;
  const q = 0.5003270373238773;
  const k = Math.tan(Math.PI * f0 / sampleRate);
  const a0 = 1 + k / q + k * k;
  return {
    b0: 1 / a0,
    b1: -2 / a0,
    b2: 1 / a0,
    a1: 2 * (k * k - 1) / a0,
    a2: (1 - k / q + k * k) / a0
  };
}

function createBiquadState(): BiquadState {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

function toLufs(energy: number) {
  return energy > 0 ? -0.691 + 10 * Math.log10(energy) : absoluteGateLufs;
}

function average(values: readonly number[]) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundMetric(value: number) {
  return Math.round(value * 100) / 100;
}
