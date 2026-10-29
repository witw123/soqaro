"use client";

type PendingEncode = {
  resolve: (payload: ArrayBuffer) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type EncodeResponse =
  | { id: number; ok: true; payload: ArrayBuffer }
  | { id: number; ok: false; error: string };

export class OpusSegmentEncoder {
  private readonly worker: Worker;
  private readonly timeoutMs: number;
  private readonly pending = new Map<number, PendingEncode>();
  private sequence = 0;
  private disposed = false;

  constructor(options?: { timeoutMs?: number }) {
    this.timeoutMs = options?.timeoutMs ?? 30_000;
    this.worker = new Worker(new URL("./opus-segment-encoder.worker.ts", import.meta.url), {
      type: "module",
      name: "soqaro-opus-encoder"
    });
    this.worker.onmessage = (event: MessageEvent<EncodeResponse>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) {
        return;
      }
      this.pending.delete(event.data.id);
      clearTimeout(pending.timeoutId);
      if (event.data.ok) {
        pending.resolve(event.data.payload);
      } else {
        pending.reject(new Error(event.data.error));
      }
    };
    this.worker.onerror = (event) => {
      this.fail(new Error(event.message || "Opus encoder worker failed."));
    };
    this.worker.onmessageerror = () => {
      this.fail(new Error("Opus encoder worker returned an unreadable response."));
    };
  }

  encode(input: {
    sampleRate: number;
    channels: Float32Array[];
    bitrateKbps: 128 | 256;
  }) {
    if (this.disposed) {
      return Promise.reject(new Error("Opus encoder has been disposed."));
    }
    const id = ++this.sequence;
    const transfer = input.channels.map((channel) => channel.buffer);
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (!this.pending.has(id)) {
          return;
        }
        this.fail(new Error(`Opus encoding timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timeoutId });
      try {
        this.worker.postMessage({ id, ...input }, { transfer });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timeoutId);
        reject(error instanceof Error ? error : new Error("Unable to start Opus encoding."));
      }
    });
  }

  get isDisposed() {
    return this.disposed;
  }

  get hasPendingWork() {
    return this.pending.size > 0;
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      this.worker.postMessage({ type: "dispose" });
    } catch {
      // Fall through to hard termination below.
    }
    this.worker.terminate();
    this.rejectAll(new Error("Opus encoding was cancelled."));
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private fail(error: Error) {
    if (!this.disposed) {
      this.disposed = true;
      this.worker.terminate();
    }
    this.rejectAll(error);
  }
}

const MAX_POOLED_ENCODERS = 4;
const IDLE_ENCODER_TTL_MS = 15_000;
const idleEncoders: OpusSegmentEncoder[] = [];
let activePoolLeases = 0;
let idleCleanupTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIdleEncoderCleanup() {
  if (idleCleanupTimer) {
    clearTimeout(idleCleanupTimer);
    idleCleanupTimer = null;
  }
  if (activePoolLeases > 0 || idleEncoders.length === 0) {
    return;
  }
  idleCleanupTimer = setTimeout(() => {
    idleCleanupTimer = null;
    if (activePoolLeases > 0) return;
    while (idleEncoders.length > 0) {
      idleEncoders.pop()?.dispose();
    }
  }, IDLE_ENCODER_TTL_MS);
}

export function acquireOpusEncoderPool(count: number) {
  const desiredCount = Math.max(1, Math.min(MAX_POOLED_ENCODERS, Math.floor(count)));
  if (idleCleanupTimer) {
    clearTimeout(idleCleanupTimer);
    idleCleanupTimer = null;
  }
  activePoolLeases += 1;

  const encoders: OpusSegmentEncoder[] = [];
  while (encoders.length < desiredCount && idleEncoders.length > 0) {
    const candidate = idleEncoders.pop()!;
    if (!candidate.isDisposed && !candidate.hasPendingWork) {
      encoders.push(candidate);
    } else {
      candidate.dispose();
    }
  }
  while (encoders.length < desiredCount) {
    encoders.push(new OpusSegmentEncoder());
  }

  let released = false;
  return {
    encoders,
    release() {
      if (released) return;
      released = true;
      activePoolLeases = Math.max(0, activePoolLeases - 1);
      for (const encoder of encoders) {
        if (!encoder.isDisposed && !encoder.hasPendingWork && idleEncoders.length < MAX_POOLED_ENCODERS) {
          idleEncoders.push(encoder);
        } else {
          encoder.dispose();
        }
      }
      scheduleIdleEncoderCleanup();
    }
  };
}
