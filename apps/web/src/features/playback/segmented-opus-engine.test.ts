import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PlaybackAssetManifest,
  PlaybackSnapshot
} from "@soqaro/shared";
import type { AudioAssetUnitRecord } from "@/features/library/indexeddb";
import { roomAudioOutput } from "./room-audio-output";
import { SegmentedOpusEngine } from "./segmented-opus-engine";

class FakeSource {
  buffer: AudioBuffer | null = null;
  playbackRate = { value: 1 };
  onended: (() => void) | null = null;
  starts: Array<{ when: number; offset: number }> = [];
  connectedTo: unknown = null;
  stopped = false;
  disconnectCount = 0;

  connect(target: unknown) {
    this.connectedTo = target;
    return target;
  }
  disconnect() {
    this.disconnectCount += 1;
  }
  start(when = 0, offset = 0) {
    this.starts.push({ when, offset });
  }
  stop() {
    this.stopped = true;
  }
}

function createContext() {
  const sources: FakeSource[] = [];
  const gains: Array<{
    gain: {
      value: number;
      setValueAtTime: ReturnType<typeof vi.fn>;
      linearRampToValueAtTime: ReturnType<typeof vi.fn>;
    };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  const createGain = vi.fn(() => {
    const gain = {
      value: 1,
      setValueAtTime: vi.fn((value: number) => {
        gain.value = value;
      }),
      linearRampToValueAtTime: vi.fn((value: number) => {
        gain.value = value;
      })
    };
    const next = {
      gain,
      connect: vi.fn(),
      disconnect: vi.fn()
    };
    gains.push(next);
    return next;
  });
  const buffer = {
    duration: 2,
    sampleRate: 48_000,
    length: 96_000,
    numberOfChannels: 2,
    getChannelData: () => new Float32Array(96_000)
  } as unknown as AudioBuffer;
  const context = {
    state: "running",
    currentTime: 10,
    destination: {},
    createGain,
    createBufferSource: vi.fn(() => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    }),
    decodeAudioData: vi.fn(async () => buffer),
    createBuffer: vi.fn((channels: number, length: number, sampleRate: number) => ({
      duration: length / sampleRate,
      sampleRate,
      length,
      numberOfChannels: channels,
      getChannelData: () => new Float32Array(length),
      copyToChannel: vi.fn()
    }))
  } as unknown as AudioContext;
  return { context, sources, gains };
}

const manifest = {
  assetId: "a".repeat(64),
  kind: "playback",
  sourceFileHash: "b".repeat(64),
  profileId: "opus-music-v4",
  codec: "opus",
  container: "audio/ogg",
  sampleRate: 48_000,
  channels: 2,
  bitrate: 256_000,
  durationMs: 10_000,
  segmentDurationMs: 2_000,
  seekPrerollMs: 80,
  unitCount: 5,
  merkleRoot: "c".repeat(64),
  encoder: { name: "@audio/opus-encode", version: "3.4.0" }
} as PlaybackAssetManifest;

function playback(serverNowMs: number): PlaybackSnapshot {
  return {
    status: "playing",
    currentTrackId: "track_1",
    currentQueueItemId: null,
    positionMs: 0,
    startAt: new Date(serverNowMs + 1_000).toISOString(),
    sourcePeerId: "peer_a",
    sourceSessionId: "user_a",
    mediaEpoch: 1,
    revision: 1,
    queueVersion: 1
  } as unknown as PlaybackSnapshot;
}

function unit(unitIndex: number): AudioAssetUnitRecord {
  return {
    unitId: `${manifest.assetId}:${unitIndex}`,
    assetId: manifest.assetId,
    kind: "playback",
    unitIndex,
    payloadBytes: 1,
    contentHash: "d".repeat(64),
    proof: [],
    startMs: unitIndex * 2_000,
    durationMs: 2_000,
    trimStartSamples: 0,
    trimEndSamples: 0,
    payload: new Uint8Array([unitIndex]).buffer,
    lastAccessedAt: new Date(0).toISOString(),
    protectedUntil: null
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SegmentedOpusEngine", () => {
  it("starts from the current segment without waiting for the next segment", async () => {
    const { context, sources } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    const engine = new SegmentedOpusEngine();
    let releaseNextUnit!: (value: AudioAssetUnitRecord | null) => void;
    const nextUnit = new Promise<AudioAssetUnitRecord | null>((resolve) => {
      releaseNextUnit = resolve;
    });

    const result = await engine.sync({
      manifest,
      playback: playback(Date.now()),
      serverNowMs: Date.now(),
      volume: 0.7,
      getUnit: async (unitIndex) => unitIndex === 0 ? unit(unitIndex) : nextUnit
    });

    expect(result.state).toBe("buffering");
    expect(context.createBuffer).not.toHaveBeenCalled();
    expect(sources).toHaveLength(1);
    expect(sources[0]?.starts).toHaveLength(1);
    releaseNextUnit(null);
    engine.destroy();
  });

  it("re-reads the room clock after the current segment finishes loading", async () => {
    const { context, sources } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    const engine = new SegmentedOpusEngine();
    const serverNowMs = Date.now();

    await engine.sync({
      manifest,
      playback: {
        ...playback(serverNowMs),
        startAt: new Date(serverNowMs).toISOString(),
        startedAt: new Date(serverNowMs).toISOString()
      },
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => {
        if (unitIndex === 0) {
          Object.defineProperty(context, "currentTime", {
            configurable: true,
            value: 11.25
          });
        }
        return unit(unitIndex);
      }
    });

    expect(sources[0]?.starts[0]?.offset).toBeCloseTo(1.25, 5);
    engine.destroy();
  });

  it("schedules the current segment before decode-ahead work finishes", async () => {
    const { context, sources } = createContext();
    let releaseDecodeAhead!: () => void;
    const decodeAhead = new Promise<AudioBuffer>((resolve) => {
      releaseDecodeAhead = () => resolve({
        duration: 2,
        sampleRate: 48_000,
        length: 96_000,
        numberOfChannels: 2,
        getChannelData: () => new Float32Array(96_000)
      } as unknown as AudioBuffer);
    });
    vi.mocked(context.decodeAudioData).mockImplementation(async (payload) =>
      new Uint8Array(payload)[0] === 0
        ? {
            duration: 2,
            sampleRate: 48_000,
            length: 96_000,
            numberOfChannels: 2,
            getChannelData: () => new Float32Array(96_000)
          } as unknown as AudioBuffer
        : decodeAhead
    );
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    const engine = new SegmentedOpusEngine();

    const syncing = engine.sync({
      manifest,
      playback: playback(Date.now()),
      serverNowMs: Date.now(),
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex)
    });
    await vi.waitFor(() => expect(sources).toHaveLength(1));

    releaseDecodeAhead();
    await vi.waitFor(() => expect(sources).toHaveLength(5));
    await syncing;
    expect(sources).toHaveLength(5);
    engine.destroy();
  });

  it("starts the current window before a future unit read completes", async () => {
    const { context, sources } = createContext();
    let releaseFutureReads!: (value: AudioAssetUnitRecord | null) => void;
    const blockedFutureRead = new Promise<AudioAssetUnitRecord | null>((resolve) => {
      releaseFutureReads = resolve;
    });
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    const engine = new SegmentedOpusEngine();
    const serverNowMs = Date.now();

    const result = await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unitIndex < 2 ? unit(unitIndex) : blockedFutureRead
    });

    expect(result.state).toBe("buffering");
    expect(sources).toHaveLength(2);
    releaseFutureReads(null);
    engine.destroy();
  });

  it("parallel-decodes ahead and schedules one contiguous master-gain timeline", async () => {
    const { context, sources, gains } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    const engine = new SegmentedOpusEngine();
    const serverNowMs = Date.now();

    const result = await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs,
      volume: 0.65,
      getUnit: async (unitIndex) => unit(unitIndex)
    });

    expect(result).toEqual({ state: "live", bufferedUnits: 5 });
    expect(context.decodeAudioData).toHaveBeenCalledTimes(5);
    expect(context.createGain).toHaveBeenCalledTimes(9);
    expect(gains[3]?.gain.value).toBe(0.65);
    expect(gains[5]?.gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    expect(sources).toHaveLength(5);
    expect(sources.every((source) => source.connectedTo !== gains[3])).toBe(true);
    expect(sources.map((source) => source.starts[0]?.when)).toEqual([11, 13, 15, 17, 19]);

    await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs,
      volume: 0.4,
      getUnit: async (unitIndex) => unit(unitIndex)
    });
    expect(context.createBufferSource).toHaveBeenCalledTimes(5);
    expect(gains[3]?.gain.value).toBe(0.4);
    sources.forEach((source) => source.onended?.());
    const ended = await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs: serverNowMs + 11_000,
      volume: 0.4,
      getUnit: async (unitIndex) => unit(unitIndex)
    });
    expect(ended.state).toBe("ended");
    engine.destroy();
  });

  it("keeps playback live while the current scheduled unit covers a short asset gap", async () => {
    const { context, sources } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    vi.spyOn(roomAudioOutput, "getBroadcastStream").mockReturnValue({
      getAudioTracks: () => [{ readyState: "live" }]
    } as unknown as MediaStream);
    const engine = new SegmentedOpusEngine();
    const serverNowMs = Date.now();

    await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unitIndex < 2 ? unit(unitIndex) : null
    });

    Object.defineProperty(context, "currentTime", {
      configurable: true,
      value: 12.5
    });
    const result = await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs: serverNowMs + 3_500,
      volume: 0.7,
      getUnit: async (unitIndex) => unitIndex < 2 ? unit(unitIndex) : null
    });

    expect(sources).toHaveLength(2);
    expect(result).toEqual({ state: "live", bufferedUnits: 1 });
    expect(engine.getSourceHealth().state).toBe("source-ready");
    engine.destroy();
  });

  it("does not stop scheduled audio during a short boundary read gap", async () => {
    const { context, sources } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    vi.spyOn(roomAudioOutput, "getBroadcastStream").mockReturnValue({
      getAudioTracks: () => [{ readyState: "live" }]
    } as unknown as MediaStream);
    const engine = new SegmentedOpusEngine();
    const serverNowMs = Date.now();

    await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unitIndex < 2 ? unit(unitIndex) : null
    });

    Object.defineProperty(context, "currentTime", {
      configurable: true,
      value: 14.2
    });
    const buffering = await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs: serverNowMs + 5_000,
      volume: 0.7,
      getUnit: async (unitIndex) => unitIndex < 2 ? unit(unitIndex) : null
    });

    expect(buffering.state).toBe("buffering");
    expect(sources[1]?.stopped).toBe(false);
    expect(engine.getSourceHealth().underrunCount).toBe(1);

    const recovered = await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs: serverNowMs + 5_000,
      volume: 0.7,
      getUnit: async (unitIndex) => unitIndex < 3 ? unit(unitIndex) : null
    });

    expect(recovered.state).toBe("live");
    expect(sources).toHaveLength(3);
    engine.destroy();
  });

  it("keeps the timeline soft when an underrun has an in-flight unit read", async () => {
    const { context, sources } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    vi.spyOn(roomAudioOutput, "getBroadcastStream").mockReturnValue({
      getAudioTracks: () => [{ readyState: "live" }]
    } as unknown as MediaStream);
    const engine = new SegmentedOpusEngine();
    const serverNowMs = Date.now();

    let holdUnit4 = false;
    let unit4Held = false;
    let releaseUnit4: () => void = () => undefined;
    let unit3Available = false;
    const getUnit = vi.fn(async (unitIndex: number): Promise<AudioAssetUnitRecord | null> => {
      if (unitIndex === 3 && unit3Available) {
        return unit(3);
      }
      if (unitIndex === 4 && holdUnit4 && !unit4Held) {
        unit4Held = true;
        await new Promise<void>((resolve) => {
          releaseUnit4 = () => resolve();
        });
        unit4Held = false;
      }
      return unitIndex < 2 ? unit(unitIndex) : null;
    });

    // Start the timeline with the first two units.
    await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs,
      volume: 0.7,
      getUnit
    });

    // Let every scheduled source finish, advance the room clock to unit 3,
    // and make the next required unit (3) fail while unit 4 is still loading.
    Object.defineProperty(context, "currentTime", {
      configurable: true,
      value: 16
    });
    holdUnit4 = true;
    const underrun = await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs: serverNowMs + 7_000,
      volume: 0.7,
      getUnit
    });

    expect(underrun.state).toBe("buffering");
    expect(engine.getSourceHealth().underrunCount).toBe(1);
    // The in-flight unit 4 read keeps the engine in the soft underrun path:
    // already-created sources are not torn down and the timeline survives.
    expect(sources[0]?.stopped).toBe(false);
    expect(sources[1]?.stopped).toBe(false);

    // Unit 4 resolves and unit 3 becomes readable. Because the timeline was
    // not hard-reset, a single unit is enough to recover to live immediately.
    releaseUnit4();
    await Promise.resolve();
    holdUnit4 = false;
    unit3Available = true;
    const recovered = await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs: serverNowMs + 7_000,
      volume: 0.7,
      getUnit
    });

    expect(recovered.state).toBe("live");
    engine.destroy();
  });

  it("keeps a live media track healthy when the song segment is silent", async () => {
    const { context } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    vi.spyOn(roomAudioOutput, "getBroadcastStream").mockReturnValue({
      getAudioTracks: () => [{ readyState: "live" }]
    } as unknown as MediaStream);
    const engine = new SegmentedOpusEngine();
    const serverNowMs = Date.now();

    await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex)
    });

    expect(engine.getSourceHealth()).toMatchObject({
      state: "source-ready",
      energy: 0
    });
    engine.destroy();
  });

  it("does not reread cached units on every scheduler tick", async () => {
    const { context } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    const engine = new SegmentedOpusEngine();
    const getUnit = vi.fn(async (unitIndex: number) => unit(unitIndex));
    const serverNowMs = Date.now();

    await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs,
      volume: 0.7,
      getUnit
    });
    await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs: serverNowMs + 100,
      volume: 0.7,
      getUnit
    });

    expect(getUnit).toHaveBeenCalledTimes(manifest.unitCount);
    engine.destroy();
  });

  it("bounds encoded and decoded caches after playback advances", async () => {
    const { context, sources } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    const engine = new SegmentedOpusEngine();
    const serverNowMs = Date.now();

    await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex)
    });
    sources.forEach((source) => source.onended?.());
    Object.defineProperty(context, "currentTime", {
      configurable: true,
      value: 18
    });

    await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs: serverNowMs + 9_000,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex)
    });

    const internals = engine as unknown as {
      decoded: Map<string, unknown>;
      unitRecords: Map<string, unknown>;
    };
    expect([...internals.unitRecords.keys()]).toEqual([`${manifest.assetId}:4`]);
    expect([...internals.decoded.keys()]).toEqual([`${manifest.assetId}:4`]);
    engine.destroy();
  });

  it("stops the old timeline and schedules a seek target immediately", async () => {
    const { context, sources } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    const engine = new SegmentedOpusEngine();
    const serverNowMs = Date.now();

    await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex)
    });
    const previousSources = [...sources];

    await engine.sync({
      manifest,
      playback: {
        ...playback(serverNowMs),
        positionMs: 4_000,
        startAt: new Date(serverNowMs).toISOString(),
        startedAt: new Date(serverNowMs).toISOString(),
        playbackRevision: 2
      },
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex)
    });

    expect(previousSources.every((source) => source.stopped)).toBe(true);
    expect(previousSources.every((source) => source.disconnectCount === 0)).toBe(true);
    expect(sources).toHaveLength(8);
    expect(sources[5]?.starts[0]).toEqual({ when: 10.08, offset: 0 });
    engine.destroy();
  });

  it("does not replay the seek target between the pending and confirmed timelines", async () => {
    const { context, sources } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    const engine = new SegmentedOpusEngine();
    const serverNowMs = Date.now();

    await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex)
    });
    const previousSources = [...sources];

    await engine.sync({
      manifest,
      playback: {
        ...playback(serverNowMs),
        positionMs: 4_000,
        startAt: null,
        startedAt: null,
        playbackRevision: 2
      },
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex)
    });

    expect(previousSources.every((source) => source.stopped)).toBe(true);
    expect(sources).toHaveLength(previousSources.length);

    const confirmedPlayback = {
      ...playback(serverNowMs),
      positionMs: 4_000,
      startAt: new Date(serverNowMs).toISOString(),
      startedAt: new Date(serverNowMs).toISOString(),
      playbackRevision: 2
    };
    await engine.sync({
      manifest,
      playback: confirmedPlayback,
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex)
    });
    const sourceCountAfterConfirmation = sources.length;

    await engine.sync({
      manifest,
      playback: confirmedPlayback,
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex)
    });

    expect(sources).toHaveLength(sourceCountAfterConfirmation);
    expect(sources.slice(previousSources.length).filter((source) =>
      source.starts.some((start) => start.offset === 0)
    )).toHaveLength(3);
    engine.destroy();
  });

  it("keeps scheduled audio when only playback order changes", async () => {
    const { context, sources } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    const engine = new SegmentedOpusEngine();
    const serverNowMs = Date.now();

    await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex)
    });
    const scheduledSources = [...sources];

    await engine.sync({
      manifest,
      playback: {
        ...playback(serverNowMs),
        playbackMode: "shuffle",
        playbackRevision: 2
      },
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex)
    });

    expect(scheduledSources.every((source) => !source.stopped)).toBe(true);
    engine.destroy();
  });

  it("pre-schedules the next timeline even when the queue repeats the same asset", async () => {
    const { context, sources, gains } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    const engine = new SegmentedOpusEngine();
    const serverNowMs = Date.now();
    const transitionAt = new Date(serverNowMs + 11_000).toISOString();

    await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex),
      gaplessNext: {
        transition: {
          trackId: "track_2",
          queueItemId: "queue_2",
          playbackAssetId: manifest.assetId,
          durationMs: manifest.durationMs,
          transitionAt,
          sourceSessionId: "user_a",
          sourcePeerId: "peer_a"
        },
        manifest,
        getUnit: async (unitIndex) => unit(unitIndex)
      }
    });

    expect(sources).toHaveLength(manifest.unitCount * 2);
    expect(sources.slice(manifest.unitCount).map((source) => source.starts[0]?.when)).toEqual([
      21,
      23,
      25,
      27,
      29
    ]);
    const previousFinalGain = gains[gains.length - manifest.unitCount - 1];
    const nextFirstGain = gains[gains.length - manifest.unitCount];
    expect(previousFinalGain?.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 21);
    expect(nextFirstGain?.gain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 21.02);
    engine.destroy();
  });

  it("schedules the ready prefix of a next track without waiting for a slow tail unit", async () => {
    const { context, sources } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    const engine = new SegmentedOpusEngine();
    const serverNowMs = Date.now();
    const nextManifest = {
      ...manifest,
      assetId: "e".repeat(64)
    } as PlaybackAssetManifest;
    const transitionAt = new Date(serverNowMs + 11_000).toISOString();
    let releaseTail!: (value: AudioAssetUnitRecord | null) => void;
    const blockedTail = new Promise<AudioAssetUnitRecord | null>((resolve) => {
      releaseTail = resolve;
    });

    await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex),
      gaplessNext: {
        transition: {
          trackId: "track_2",
          queueItemId: "queue_2",
          playbackAssetId: nextManifest.assetId,
          durationMs: nextManifest.durationMs,
          transitionAt,
          sourceSessionId: "user_a",
          sourcePeerId: "peer_a"
        },
        manifest: nextManifest,
        getUnit: async (unitIndex) => unitIndex === 4
          ? blockedTail
          : { ...unit(unitIndex), assetId: nextManifest.assetId, unitId: `${nextManifest.assetId}:${unitIndex}` }
      }
    });

    await vi.waitFor(() => expect(sources).toHaveLength(manifest.unitCount + 4));
    releaseTail(null);
    engine.destroy();
  });

  it("retains gapless-prefetched units across scheduler ticks", async () => {
    const { context } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    const engine = new SegmentedOpusEngine();
    const serverNowMs = Date.now();
    const nextManifest = {
      ...manifest,
      assetId: "f".repeat(64)
    } as PlaybackAssetManifest;
    const nextGetUnit = vi.fn(async (unitIndex: number) => ({
      ...unit(unitIndex),
      assetId: nextManifest.assetId,
      unitId: `${nextManifest.assetId}:${unitIndex}`
    }));
    const transitionAt = new Date(serverNowMs + 11_000).toISOString();
    const roomPlayback = playback(serverNowMs);
    const gaplessNext = {
      transition: {
        trackId: "track_2",
        queueItemId: "queue_2",
        playbackAssetId: nextManifest.assetId,
        durationMs: nextManifest.durationMs,
        transitionAt,
        sourceSessionId: "user_a",
        sourcePeerId: "peer_a"
      },
      manifest: nextManifest,
      getUnit: nextGetUnit
    };

    await engine.sync({
      manifest,
      playback: roomPlayback,
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex),
      gaplessNext
    });
    await engine.sync({
      manifest,
      playback: roomPlayback,
      serverNowMs: serverNowMs + 100,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex),
      gaplessNext
    });

    expect(nextGetUnit).toHaveBeenCalledTimes(nextManifest.unitCount);
    engine.destroy();
  });

  it("clears a pending gapless transition when the timeline is reset", async () => {
    const { context } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    const engine = new SegmentedOpusEngine();
    const serverNowMs = Date.now();
    const transitionAt = new Date(serverNowMs + 11_000).toISOString();

    await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex),
      gaplessNext: {
        transition: {
          trackId: "track_2",
          queueItemId: "queue_2",
          playbackAssetId: manifest.assetId,
          durationMs: manifest.durationMs,
          transitionAt,
          sourceSessionId: "user_a",
          sourcePeerId: "peer_a"
        },
        manifest,
        getUnit: async (unitIndex) => unit(unitIndex)
      }
    });
    await engine.sync({
      manifest,
      playback: {
        ...playback(serverNowMs),
        status: "paused",
        startAt: null
      },
      serverNowMs,
      volume: 0.7,
      getUnit: async () => null
    });

    expect((engine as unknown as { pendingTransition: unknown }).pendingTransition).toBeNull();
    engine.destroy();
  });

  it("cancels a blocked sync before applying a newer pause", async () => {
    const { context, sources } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    const engine = new SegmentedOpusEngine();
    const blocked = new Promise<AudioAssetUnitRecord | null>(() => undefined);
    const serverNowMs = Date.now();

    const playing = engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs,
      volume: 0.7,
      getUnit: async () => blocked
    });
    await Promise.resolve();

    const paused = await engine.sync({
      manifest,
      playback: {
        ...playback(serverNowMs),
        status: "paused",
        startAt: null
      },
      serverNowMs,
      volume: 0.7,
      getUnit: async () => null
    });

    await playing;
    expect(paused.state).toBe("paused");
    expect(sources).toHaveLength(0);
    engine.destroy();
  });

  it("does not abort an in-flight decode for a same-timeline scheduler tick", async () => {
    const { context } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    const engine = new SegmentedOpusEngine();
    const serverNowMs = Date.now();
    let release!: (value: AudioAssetUnitRecord | null) => void;
    let released = false;
    const blocked = new Promise<AudioAssetUnitRecord | null>((resolve) => {
      release = resolve;
    });
    let firstSignal: AbortSignal | undefined;
    const getUnit = async (_unitIndex: number, signal?: AbortSignal) => {
      firstSignal ??= signal;
      return released ? null : blocked;
    };

    const firstSync = engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs,
      volume: 0.7,
      getUnit
    });
    await Promise.resolve();
    const nextSync = engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs: serverNowMs + 100,
      volume: 0.7,
      getUnit
    });

    expect(firstSignal?.aborted).toBe(false);
    released = true;
    release(null);
    await Promise.all([firstSync, nextSync]);
    engine.destroy();
  });

  it("reuses decoded units when pausing and resuming the same track", async () => {
    const { context, sources } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    const engine = new SegmentedOpusEngine();
    const serverNowMs = Date.now();
    const getUnit = vi.fn(async (unitIndex: number) => unit(unitIndex));
    const decodeAudioData = vi.mocked(context.decodeAudioData);

    await engine.sync({
      manifest,
      playback: playback(serverNowMs),
      serverNowMs,
      volume: 0.7,
      getUnit
    });
    const initialDecodeCount = decodeAudioData.mock.calls.length;

    await engine.sync({
      manifest,
      playback: {
        ...playback(serverNowMs),
        status: "paused",
        positionMs: 2_000,
        startAt: null,
        startedAt: null,
        playbackRevision: 2
      },
      serverNowMs,
      volume: 0.7,
      getUnit
    });
    await engine.sync({
      manifest,
      playback: {
        ...playback(serverNowMs),
        positionMs: 2_000,
        startAt: new Date(serverNowMs).toISOString(),
        startedAt: new Date(serverNowMs).toISOString(),
        playbackRevision: 3
      },
      serverNowMs,
      volume: 0.7,
      getUnit
    });

    expect(decodeAudioData.mock.calls.length).toBe(initialDecodeCount);
    expect(sources.length).toBeGreaterThan(5);
    engine.destroy();
  });

  it("ignores an older playing timeline that arrives after resume", async () => {
    const { context, sources } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    const engine = new SegmentedOpusEngine();
    const serverNowMs = Date.now();
    const initial = playback(serverNowMs);
    const resumed = {
      ...initial,
      startAt: new Date(serverNowMs + 2_000).toISOString(),
      startedAt: new Date(serverNowMs + 2_000).toISOString(),
      playbackRevision: 2
    };

    await engine.sync({
      manifest,
      playback: initial,
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex)
    });
    await engine.sync({
      manifest,
      playback: resumed,
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex)
    });
    const sourceCountAfterResume = sources.length;

    await engine.sync({
      manifest,
      playback: initial,
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex)
    });

    expect(sources).toHaveLength(sourceCountAfterResume);
    engine.destroy();
  });

  it("prunes stale completed keys and ahead queues when promoting a gapless loop", async () => {
    const { context } = createContext();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext").mockReturnValue(context);
    const engine = new SegmentedOpusEngine();
    const serverNowMs = Date.now();
    const transitionAt = new Date(serverNowMs + 12_000).toISOString();
    const initialPlayback = playback(serverNowMs);

    await engine.sync({
      manifest,
      playback: initialPlayback,
      serverNowMs,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex),
      gaplessNext: {
        transition: {
          trackId: "track_1",
          queueItemId: "queue_1",
          playbackAssetId: manifest.assetId,
          durationMs: manifest.durationMs,
          transitionAt,
          sourceSessionId: "user_a",
          sourcePeerId: "peer_a"
        },
        manifest,
        getUnit: async (unitIndex) => unit(unitIndex)
      }
    });

    const internals = engine as unknown as {
      completed: Set<string>;
      aheadQueues: Map<string, { units: Map<number, unknown>; decoded: Map<number, unknown> }>;
    };
    const staleCompletedKey = `${manifest.assetId}:${initialPlayback.startAt}:0`;
    const promotedCompletedKey = `${manifest.assetId}:${transitionAt}:0`;
    internals.completed.add(staleCompletedKey);
    internals.completed.add(promotedCompletedKey);
    internals.aheadQueues.set(`${manifest.assetId}:1:${initialPlayback.startAt}`, {
      units: new Map([[5, unit(5)]]),
      decoded: new Map()
    });

    await engine.sync({
      manifest,
      playback: {
        ...initialPlayback,
        mediaEpoch: 2,
        playbackRevision: 2,
        startAt: transitionAt,
        startedAt: transitionAt
      },
      serverNowMs: serverNowMs + 12_000,
      volume: 0.7,
      getUnit: async (unitIndex) => unit(unitIndex)
    });

    expect(internals.completed.has(staleCompletedKey)).toBe(false);
    expect(internals.completed.has(promotedCompletedKey)).toBe(true);
    expect(internals.aheadQueues.has(`${manifest.assetId}:1:${initialPlayback.startAt}`)).toBe(false);
    engine.destroy();
  });
});
