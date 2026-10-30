import { describe, expect, it } from "vitest";
import { runExclusiveAudioDecodeTask } from "./audio-decode-queue";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runExclusiveAudioDecodeTask", () => {
  it("serializes concurrent tasks with concurrency 1 and prioritizes high over low", async () => {
    const order: string[] = [];
    let activeCount = 0;
    let maxConcurrent = 0;
    const gate = deferred();

    const first = runExclusiveAudioDecodeTask(async () => {
      activeCount += 1;
      maxConcurrent = Math.max(maxConcurrent, activeCount);
      order.push("first-start");
      await gate.promise;
      order.push("first-end");
      activeCount -= 1;
      return "first";
    });

    const low = runExclusiveAudioDecodeTask(
      async () => {
        activeCount += 1;
        maxConcurrent = Math.max(maxConcurrent, activeCount);
        order.push("low");
        activeCount -= 1;
        return "low";
      },
      { priority: "low" }
    );

    const high = runExclusiveAudioDecodeTask(
      async () => {
        activeCount += 1;
        maxConcurrent = Math.max(maxConcurrent, activeCount);
        order.push("high");
        activeCount -= 1;
        return "high";
      },
      { priority: "high" }
    );

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    gate.resolve();

    await expect(Promise.all([first, low, high])).resolves.toEqual(["first", "low", "high"]);
    expect(maxConcurrent).toBe(1);
    expect(order).toEqual(["first-start", "first-end", "high", "low"]);
  });

  it("removes aborted waiters from the queue without executing them", async () => {
    const gate = deferred();
    const abortController = new AbortController();
    let abortedTaskRan = false;

    const blocker = runExclusiveAudioDecodeTask(async () => {
      await gate.promise;
      return "blocker";
    });

    const cancelled = runExclusiveAudioDecodeTask(
      async () => {
        abortedTaskRan = true;
        return "cancelled";
      },
      { priority: "low", signal: abortController.signal }
    );

    const follower = runExclusiveAudioDecodeTask(
      async () => "follower",
      { priority: "low" }
    );

    abortController.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });

    gate.resolve();
    await expect(blocker).resolves.toBe("blocker");
    await expect(follower).resolves.toBe("follower");
    expect(abortedTaskRan).toBe(false);
  });
});
