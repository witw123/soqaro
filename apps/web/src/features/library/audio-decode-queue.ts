export type AudioDecodeTaskPriority = "high" | "low";

type QueuedWaiter = {
  grant: () => void;
  cleanup: () => void;
};

let activeTasks = 0;
const highPriorityQueue: QueuedWaiter[] = [];
const lowPriorityQueue: QueuedWaiter[] = [];

function createAbortError(reason?: unknown) {
  if (reason instanceof Error) {
    return reason;
  }
  return new DOMException("Audio decode task was cancelled.", "AbortError");
}

function releaseSlot() {
  while (highPriorityQueue.length > 0 || lowPriorityQueue.length > 0) {
    const next = highPriorityQueue.shift() ?? lowPriorityQueue.shift();
    if (!next) {
      break;
    }
    next.cleanup();
    next.grant();
    return;
  }
  activeTasks = Math.max(0, activeTasks - 1);
}

/**
 * Serializes heavy PCM decoding, WASM transcoding, and loudness analysis so
 * concurrent imports, room auto-preparation, and playback normalization never
 * stack multiple full-song decode buffers in renderer memory simultaneously.
 */
export async function runExclusiveAudioDecodeTask<T>(
  task: () => Promise<T>,
  options?: {
    priority?: AudioDecodeTaskPriority;
    signal?: AbortSignal;
  }
): Promise<T> {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }

  const priority = options?.priority ?? "high";
  if (activeTasks === 0) {
    activeTasks = 1;
  } else {
    await new Promise<void>((resolve, reject) => {
      const queue = priority === "high" ? highPriorityQueue : lowPriorityQueue;
      const onAbort = () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) {
          queue.splice(index, 1);
        }
        waiter.cleanup();
        reject(createAbortError(signal?.reason));
      };
      const waiter: QueuedWaiter = {
        grant: resolve,
        cleanup: () => {
          signal?.removeEventListener("abort", onAbort);
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(waiter);
    });
    if (signal?.aborted) {
      releaseSlot();
      throw createAbortError(signal.reason);
    }
  }

  try {
    return await task();
  } finally {
    releaseSlot();
  }
}
