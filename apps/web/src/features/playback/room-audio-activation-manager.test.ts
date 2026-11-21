import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomAudioActivationManager } from "./room-audio-activation-manager";
import { alignLocalAudioToRoom } from "@/features/room/playback/room-audio-path";

function createAudioElementMock() {
  const audio = {
    src: "",
    srcObject: null,
    currentSrc: "",
    muted: false,
    volume: 0.72,
    preload: "none",
    paused: true,
    play: vi.fn(async () => undefined),
    pause: vi.fn(() => undefined),
    load: vi.fn(() => undefined),
    getAttribute: vi.fn((name: string) => (name === "src" ? audio.src : null)),
    removeAttribute: vi.fn((name: string) => {
      if (name === "src") {
        audio.src = "";
        audio.currentSrc = "";
      }
    })
  };

  return audio as unknown as HTMLAudioElement;
}

describe("RoomAudioActivationManager", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("primes empty audio elements with a silent source inside the click gesture", async () => {
    const manager = new RoomAudioActivationManager();
    const audio = createAudioElementMock();

    await expect(
      manager.activateOutputs({
        localAudio: audio
      })
    ).resolves.toEqual({
      ok: true,
      local: {
        ok: true,
        error: null
      }
    });

    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.pause).not.toHaveBeenCalled();
    expect(audio.load).toHaveBeenCalledTimes(1);
    expect(audio.removeAttribute).not.toHaveBeenCalled();
    expect(audio.src).toContain("data:audio/wav");
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBe(0.72);
    expect(audio.preload).toBe("none");
    expect(manager.isActivated()).toBe(true);
  });

  it("does not mark outputs activated when priming never actually plays", async () => {
    const manager = new RoomAudioActivationManager();
    const audio = createAudioElementMock();
    audio.play = vi.fn(async () => {
      throw new DOMException("blocked", "NotAllowedError");
    });

    await expect(
      manager.activateOutputs({
        localAudio: audio
      })
    ).resolves.toEqual({
      ok: false,
      local: {
        ok: false,
        error: "blocked"
      }
    });

    expect(manager.isActivated()).toBe(false);
  });

  it("does not reject when an embedded webview throws during priming", async () => {
    const manager = new RoomAudioActivationManager();
    const audio = createAudioElementMock();
    audio.load = vi.fn(() => {
      throw new DOMException("load failed", "InvalidStateError");
    });

    await expect(
      manager.activateOutputs({
        localAudio: audio
      })
    ).resolves.toEqual({
      ok: true,
      local: {
        ok: true,
        error: null
      }
    });
  });

  it("marks outputs activated after a successful play call", async () => {
    const manager = new RoomAudioActivationManager();
    const audio = createAudioElementMock();

    await expect(manager.playElement(audio)).resolves.toEqual({
      ok: true,
      error: null
    });
    expect(manager.isActivated()).toBe(true);
  });

  it("does not start an obsolete play request", async () => {
    const manager = new RoomAudioActivationManager();
    const audio = createAudioElementMock();

    await expect(manager.playElement(audio, {
      isCurrent: () => false
    })).resolves.toEqual({
      ok: false,
      error: "play-obsolete"
    });

    expect(audio.play).not.toHaveBeenCalled();
  });

  it("shares a pending play request for the same media source", async () => {
    const manager = new RoomAudioActivationManager();
    const audio = createAudioElementMock();
    let resolvePlay!: () => void;
    audio.play = vi.fn(() => new Promise<void>((resolve) => {
      resolvePlay = resolve;
    }));

    const first = manager.playElement(audio, { force: true });
    const second = manager.playElement(audio, { force: true });

    await Promise.resolve();
    await Promise.resolve();
    expect(audio.play).toHaveBeenCalledTimes(1);
    resolvePlay();

    await expect(first).resolves.toEqual({
      ok: true,
      error: null
    });
    await expect(second).resolves.toEqual({
      ok: true,
      error: null
    });
  });

  it("does not start playback when a request becomes obsolete during context resume", async () => {
    let notifyResumeStarted!: () => void;
    let finishResume!: () => void;
    const resumeStarted = new Promise<void>((resolve) => {
      notifyResumeStarted = resolve;
    });
    class DelayedAudioContext {
      state: AudioContextState = "suspended";
      resume = vi.fn(() => {
        notifyResumeStarted();
        return new Promise<void>((resolve) => {
          finishResume = () => {
            this.state = "running";
            resolve();
          };
        });
      });
      addEventListener = vi.fn();
    }
    vi.stubGlobal("window", {
      AudioContext: DelayedAudioContext,
      addEventListener: vi.fn()
    });

    const manager = new RoomAudioActivationManager();
    const audio = createAudioElementMock();
    let isCurrent = true;
    const playRequest = manager.playElement(audio, {
      isCurrent: () => isCurrent
    });

    await resumeStarted;
    isCurrent = false;
    finishResume();

    await expect(playRequest).resolves.toEqual({
      ok: false,
      error: "play-obsolete"
    });
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("aligns a completed cache to the room clock after asynchronous context resume", async () => {
    const manager = new RoomAudioActivationManager();
    const audio = createAudioElementMock();
    let finishResume!: (ready: boolean) => void;
    vi.spyOn(manager, "resumeSharedAudioContext").mockImplementation(
      () => new Promise<boolean>((resolve) => { finishResume = resolve; })
    );
    let nowMs = 10_000;
    const playback = {
      status: "playing" as const,
      positionMs: 12_000,
      startedAt: new Date(10_000).toISOString(),
      startAt: new Date(10_000).toISOString()
    };
    audio.currentTime = 12;
    const beforePlay = vi.fn(() => alignLocalAudioToRoom(audio, playback, {
      force: true, durationMs: 60_000, nowMs
    }));
    audio.play = vi.fn(async () => { expect(audio.currentTime).toBe(15); });
    const result = manager.playElement(audio, { beforePlay });
    expect(beforePlay).not.toHaveBeenCalled();
    nowMs = 13_000;
    finishResume(true);
    await expect(result).resolves.toEqual({ ok: true, error: null });
    expect(beforePlay).toHaveBeenCalledTimes(1);
  });

  it("does not realign an already-playing source on ordinary sync ticks", async () => {
    const manager = new RoomAudioActivationManager();
    const audio = createAudioElementMock();
    await manager.playElement(audio);
    Object.defineProperty(audio, "paused", { configurable: true, value: false });
    const beforePlay = vi.fn();
    await manager.playElement(audio, { beforePlay });
    expect(beforePlay).not.toHaveBeenCalled();
  });

  it("does not replay an already-playing element for the same source", async () => {
    const manager = new RoomAudioActivationManager();
    const audio = createAudioElementMock();
    audio.srcObject = {} as MediaStream;

    await manager.playElement(audio);
    vi.mocked(audio.play).mockClear();
    Object.defineProperty(audio, "paused", {
      configurable: true,
      value: false
    });

    await expect(manager.playElement(audio)).resolves.toEqual({
      ok: true,
      error: null
    });
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("plays again when a not-paused element has switched to a new media source", async () => {
    const manager = new RoomAudioActivationManager();
    const audio = createAudioElementMock();
    Object.defineProperty(audio, "paused", {
      configurable: true,
      value: false
    });
    audio.src = "blob:next-track";
    Object.defineProperty(audio, "currentSrc", {
      configurable: true,
      value: "blob:next-track"
    });

    await expect(manager.playElement(audio)).resolves.toEqual({
      ok: true,
      error: null
    });

    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(manager.isActivated()).toBe(true);
  });

  it("returns a structured failure when playback is rejected", async () => {
    const manager = new RoomAudioActivationManager();
    const audio = createAudioElementMock();
    audio.play = vi.fn(async () => {
      throw new DOMException("blocked", "NotAllowedError");
    });

    await expect(manager.playElement(audio)).resolves.toEqual({
      ok: false,
      error: "blocked"
    });
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBe(0.72);
    expect(manager.isActivated()).toBe(false);
    expect(manager.isAudioContextReady()).toBe(false);
  });

  it("recovers a blocked audible source by starting muted and restoring sound", async () => {
    const manager = new RoomAudioActivationManager();
    const audio = createAudioElementMock();
    audio.src = "blob:local-upload";
    audio.play = vi.fn(async () => {
      if (!audio.muted) {
        throw new DOMException("blocked", "NotAllowedError");
      }
    });

    await expect(manager.playElement(audio)).resolves.toEqual({
      ok: true,
      error: null
    });

    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBe(0.72);
    expect(manager.isActivated()).toBe(true);
  });

  it("does not treat muted autoplay as an audible remote-stream unlock", async () => {
    const manager = new RoomAudioActivationManager();
    const audio = createAudioElementMock();
    audio.srcObject = {} as MediaStream;
    audio.play = vi.fn(async () => {
      if (!audio.muted) {
        throw new DOMException("blocked", "NotAllowedError");
      }
    });

    await expect(manager.playElement(audio, {
      resumeAudioContext: false,
      allowMutedFallback: false
    })).resolves.toEqual({
      ok: false,
      error: "blocked"
    });

    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.muted).toBe(false);
    expect(manager.isActivated()).toBe(false);
  });

  it("does not report a graph-routed element as audible while its context is suspended", async () => {
    class SuspendedAudioContext {
      state: AudioContextState = "suspended";
      resume = vi.fn(async () => {
        throw new DOMException("blocked", "NotAllowedError");
      });
      addEventListener = vi.fn();
    }
    vi.stubGlobal("AudioContext", SuspendedAudioContext);

    const manager = new RoomAudioActivationManager();
    const audio = createAudioElementMock();

    await expect(manager.playElement(audio, {
      requireRunningAudioContext: true
    })).resolves.toEqual({
      ok: false,
      error: "audio-context-suspended"
    });

    expect(audio.play).not.toHaveBeenCalled();
  });

  it("forces play for a stalled element without changing its source", async () => {
    const manager = new RoomAudioActivationManager();
    const audio = createAudioElementMock();
    const stream = {} as MediaStream;
    audio.srcObject = stream;
    Object.defineProperty(audio, "paused", {
      configurable: true,
      value: false
    });

    await manager.activateOutputs({ localAudio: audio });
    vi.mocked(audio.play).mockClear();

    await expect(manager.playElement(audio, { force: true })).resolves.toEqual({
      ok: true,
      error: null
    });

    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.srcObject).toBe(stream);
  });

  it("calls play again when an active-key element has ended even if paused is false", async () => {
    const manager = new RoomAudioActivationManager();
    const audio = createAudioElementMock();
    audio.src = "blob:looped-track";
    Object.defineProperty(audio, "currentSrc", {
      configurable: true,
      value: "blob:looped-track"
    });

    await manager.playElement(audio);
    vi.mocked(audio.play).mockClear();

    Object.defineProperty(audio, "paused", {
      configurable: true,
      value: false
    });
    Object.defineProperty(audio, "ended", {
      configurable: true,
      value: true
    });

    await expect(manager.playElement(audio)).resolves.toEqual({
      ok: true,
      error: null
    });
    expect(audio.play).toHaveBeenCalledTimes(1);
  });
});
