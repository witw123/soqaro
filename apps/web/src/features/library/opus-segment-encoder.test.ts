import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireOpusEncoderPool, OpusSegmentEncoder } from "./opus-segment-encoder";

class FakeWorker {
  static latest: FakeWorker | null = null;
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor() {
    FakeWorker.latest = this;
    FakeWorker.instances.push(this);
  }
}

describe("OpusSegmentEncoder", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
    FakeWorker.latest = null;
    FakeWorker.instances = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rejects and terminates an encoder worker that stops responding", async () => {
    const encoder = new OpusSegmentEncoder({ timeoutMs: 25 });
    const encodePromise = encoder.encode({
      sampleRate: 48_000,
      channels: [new Float32Array(960)],
      bitrateKbps: 128
    });
    const rejection = expect(encodePromise).rejects.toThrow("timed out after 25ms");

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(FakeWorker.latest?.terminate).toHaveBeenCalledOnce();
  });

  it("rejects pending work when the worker response cannot be decoded", async () => {
    const encoder = new OpusSegmentEncoder();
    const encodePromise = encoder.encode({
      sampleRate: 48_000,
      channels: [new Float32Array(960)],
      bitrateKbps: 128
    });

    FakeWorker.latest?.onmessageerror?.({} as MessageEvent);
    await expect(encodePromise).rejects.toThrow("unreadable response");
    expect(FakeWorker.latest?.terminate).toHaveBeenCalledOnce();
  });

  it("reuses pooled workers across leases and disposes them after the idle timeout", async () => {
    const firstLease = acquireOpusEncoderPool(2);
    expect(firstLease.encoders).toHaveLength(2);
    expect(FakeWorker.instances).toHaveLength(2);
    firstLease.release();

    const secondLease = acquireOpusEncoderPool(2);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(new Set(secondLease.encoders)).toEqual(new Set(firstLease.encoders));
    secondLease.release();

    expect(FakeWorker.instances.every((worker) => worker.terminate.mock.calls.length === 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(FakeWorker.instances.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
  });
});
