import { afterEach, describe, expect, it, vi } from "vitest";
import { roomAudioOutput } from "./room-audio-output";

function createAudioContextMock() {
  const source = {
    connect: vi.fn(),
    disconnect: vi.fn()
  };
  const gain = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: {
      value: 0.72,
      cancelScheduledValues: vi.fn(),
      setTargetAtTime: vi.fn(),
      setValueAtTime: vi.fn()
    }
  };
  const track = {
    id: "broadcast-track",
    readyState: "live" as MediaStreamTrackState,
    stop: vi.fn()
  };
  const broadcastDestination = {
    context: null as unknown,
    disconnect: vi.fn(),
    stream: {
      id: "broadcast-stream",
      getAudioTracks: () => [track],
      getTracks: () => [track]
    }
  };
  const context = {
    currentTime: 12,
    destination: {},
    createGain: vi.fn(() => gain),
    createMediaElementSource: vi.fn(() => source),
    createMediaStreamDestination: vi.fn(() => broadcastDestination),
    state: "running"
  };
  broadcastDestination.context = context;
  return { broadcastDestination, context, gain, source, track };
}

describe("room audio output", () => {
  afterEach(() => {
    roomAudioOutput.releaseRoomAudioSession();
    vi.restoreAllMocks();
  });

  it("keeps member volume local while broadcasting the source at full level", () => {
    const { broadcastDestination, context, gain, source } = createAudioContextMock();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext")
      .mockReturnValue(context as unknown as AudioContext);
    const audio = { volume: 0.35 } as HTMLAudioElement;

    expect(roomAudioOutput.hasLocalAudioElementSource(audio)).toBe(false);
    expect(roomAudioOutput.bindLocalAudioElement(audio)).toBe(broadcastDestination.stream);
    expect(roomAudioOutput.hasLocalAudioElementSource(audio)).toBe(true);
    expect(source.connect).toHaveBeenCalledWith(gain);
    expect(source.connect).toHaveBeenCalledWith(broadcastDestination);
    expect(gain.connect).toHaveBeenCalledWith(context.destination);
    expect(audio.volume).toBe(1);

    roomAudioOutput.applyVolume({ localAudio: audio, volume: 0.2 });

    expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0.2, 12);
    expect(audio.volume).toBe(1);
  });

  it("does not clear graph loudness when a volume update omits normalization", () => {
    const { context, gain } = createAudioContextMock();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext")
      .mockReturnValue(context as unknown as AudioContext);
    const audio = { volume: 1 } as HTMLAudioElement;

    roomAudioOutput.bindLocalAudioElement(audio, {
      broadcast: false,
      loudnessGainDb: 6
    });
    roomAudioOutput.applyVolume({ localAudio: audio, volume: 0.4 });

    expect(gain.gain.setValueAtTime).toHaveBeenCalledTimes(1);
    expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0.4, 12);
  });

  it("keeps normalization for native elements when the graph is unavailable", () => {
    const audio = { volume: 1 } as HTMLAudioElement;

    roomAudioOutput.applyVolume({
      localAudio: audio,
      volume: 0.4,
      loudnessGainDb: 6
    });
    roomAudioOutput.applyVolume({ localAudio: audio, volume: 0.2 });

    expect(audio.volume).toBeCloseTo(0.398, 2);
  });

  it("disconnects the local graph before a new source is bound", () => {
    const { context, gain, source } = createAudioContextMock();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext")
      .mockReturnValue(context as unknown as AudioContext);
    const firstAudio = { volume: 1 } as HTMLAudioElement;
    const secondAudio = { volume: 1 } as HTMLAudioElement;

    roomAudioOutput.bindLocalAudioElement(firstAudio);
    roomAudioOutput.bindLocalAudioElement(secondAudio);

    expect(source.disconnect).toHaveBeenCalled();
    expect(gain.disconnect).toHaveBeenCalled();
  });

  it("restores the requested volume after the local graph is rebound", () => {
    const { context, gain } = createAudioContextMock();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext")
      .mockReturnValue(context as unknown as AudioContext);
    const audio = { volume: 1 } as HTMLAudioElement;

    roomAudioOutput.bindLocalAudioElement(audio, { broadcast: false, volume: 0.24 });
    roomAudioOutput.unbindLocalAudioElement(audio);
    audio.volume = 1;
    roomAudioOutput.bindLocalAudioElement(audio, { broadcast: false });

    expect(gain.gain.value).toBe(0.24);
  });

  it("remembers elements that must stay on the Web Audio graph after cleanup", () => {
    const { context } = createAudioContextMock();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext")
      .mockReturnValue(context as unknown as AudioContext);
    const audio = { volume: 1 } as HTMLAudioElement;

    roomAudioOutput.bindLocalAudioElement(audio);
    roomAudioOutput.releaseRoomAudioSession();

    expect(roomAudioOutput.hasLocalAudioElementSource(audio)).toBe(true);
    roomAudioOutput.bindLocalAudioElement(audio, { broadcast: false });
    expect(roomAudioOutput.hasLocalAudioElementSource(audio)).toBe(true);
  });

  it("notifies subscribers when the broadcast stream is created and released", () => {
    const { context, broadcastDestination } = createAudioContextMock();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext")
      .mockReturnValue(context as unknown as AudioContext);
    const listener = vi.fn();
    const unsubscribe = roomAudioOutput.subscribeBroadcastStream(listener);

    expect(roomAudioOutput.getBroadcastStream()).toBeNull();
    roomAudioOutput.getBroadcastDestination();
    expect(listener).toHaveBeenNthCalledWith(1, broadcastDestination.stream);

    roomAudioOutput.releaseRoomAudioSession();
    expect(listener).toHaveBeenNthCalledWith(2, null);

    unsubscribe();
    roomAudioOutput.getBroadcastDestination();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("recreates a broadcast destination after its audio track ends", () => {
    const { context, broadcastDestination, track } = createAudioContextMock();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext")
      .mockReturnValue(context as unknown as AudioContext);
    roomAudioOutput.getBroadcastDestination();
    track.readyState = "ended";

    const nextDestination = roomAudioOutput.getBroadcastDestination();

    expect(nextDestination).toBe(broadcastDestination);
    expect(context.createMediaStreamDestination).toHaveBeenCalledTimes(2);
    expect(track.stop).toHaveBeenCalled();
  });

  it("fades graph volume smoothly over duration", async () => {
    const { context, gain } = createAudioContextMock();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext")
      .mockReturnValue(context as unknown as AudioContext);
    const audio = { volume: 1 } as HTMLAudioElement;
    roomAudioOutput.bindLocalAudioElement(audio, { broadcast: false });

    await roomAudioOutput.fadeOutAudio(50);
    expect(gain.gain.cancelScheduledValues).toHaveBeenCalled();
    expect(gain.gain.setTargetAtTime).toHaveBeenCalledWith(0, 12, expect.any(Number));

    await roomAudioOutput.fadeInAudio(0.8, 50);
    expect(gain.gain.setTargetAtTime).toHaveBeenCalledWith(0.8, 12, expect.any(Number));
  });

  it("supports setting equalizer gains and inserting equalizer filters when available", () => {
    const filters: Array<{
      type: string;
      gain: { value: number };
      frequency: { value: number };
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }> = [];
    const baseMock = createAudioContextMock();
    const contextWithFilters = {
      ...baseMock.context,
      createBiquadFilter: vi.fn(() => {
        const filter = {
          type: "peaking",
          gain: { value: 0 },
          frequency: { value: 1000 },
          connect: vi.fn(),
          disconnect: vi.fn()
        };
        filters.push(filter);
        return filter;
      })
    };
    vi.spyOn(roomAudioOutput, "getSharedAudioContext")
      .mockReturnValue(contextWithFilters as unknown as AudioContext);

    roomAudioOutput.setEqualizerGains([3, 2, 0, -1, 4]);
    expect(roomAudioOutput.getEqualizerGains()).toEqual([3, 2, 0, -1, 4]);

    const audio = { volume: 1 } as HTMLAudioElement;
    roomAudioOutput.bindLocalAudioElement(audio, { broadcast: false });

    expect(contextWithFilters.createBiquadFilter).toHaveBeenCalledTimes(5);
    expect(filters[0].gain.value).toBe(3);
    expect(filters[1].gain.value).toBe(2);
    expect(filters[4].gain.value).toBe(4);

    // Dynamic gain update while bound
    roomAudioOutput.setEqualizerGains([0, 0, 0, 0, 0]);
    expect(filters[0].gain.value).toBe(0);

    roomAudioOutput.releaseRoomAudioSession();
    expect(filters[0].disconnect).toHaveBeenCalled();
  });

  it("scales output volume during local audio focus interruptions without mutating the requested volume", () => {
    const { context, gain } = createAudioContextMock();
    vi.spyOn(roomAudioOutput, "getSharedAudioContext")
      .mockReturnValue(context as unknown as AudioContext);
    const audio = { volume: 1 } as HTMLAudioElement;

    roomAudioOutput.bindLocalAudioElement(audio, { broadcast: false });
    roomAudioOutput.applyVolume({ localAudio: audio, volume: 0.8 });
    expect(gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0.8, 12);

    roomAudioOutput.setSystemAudioScale(0);
    expect(gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0, 12);

    roomAudioOutput.setSystemAudioScale(0.25);
    expect(gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0.2, 12);

    roomAudioOutput.setSystemAudioScale(1);
    expect(gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0.8, 12);
  });
});
