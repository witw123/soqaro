import { afterEach, describe, expect, it, vi } from "vitest";
import { findRoomCardElement, runRoomViewTransition } from "./room-view-transition";

function createMockElement(id: string, options?: { hidden?: boolean; visibleRect?: boolean }): HTMLElement {
  return {
    id,
    style: { viewTransitionName: "" },
    closest: (selector: string) =>
      options?.hidden && selector.includes(".hidden") ? ({} as Element) : null,
    getClientRects: () => (options?.visibleRect ? ([{}] as unknown as DOMRectList) : ([] as unknown as DOMRectList))
  } as unknown as HTMLElement;
}

describe("room-view-transition", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("finds visible room cards across mosaic and discover views while skipping hidden cached routes", () => {
    const hiddenCard = createMockElement("hidden-card", { hidden: true, visibleRect: false });
    const visibleCard = createMockElement("visible-discover-card", { hidden: false, visibleRect: true });

    vi.stubGlobal("document", {
      documentElement: { dataset: {} },
      querySelectorAll: (selector: string) => {
        if (selector.includes("data-mosaic-slot-id")) return [hiddenCard];
        if (selector.includes("data-discover-room-id")) return [visibleCard];
        return [];
      }
    });

    const found = findRoomCardElement("room_1");
    expect(found?.id).toBe("visible-discover-card");
  });

  it("tags the source card before capture and waits for the room host on async room-enter", async () => {
    const cardEl = createMockElement("card-42", { visibleRect: true });
    let roomHostMounted = false;
    let capturedOldTransitionName = "";
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });

    let callbackPromise: void | Promise<void> | undefined;

    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false }),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      requestAnimationFrame: (cb: FrameRequestCallback) => globalThis.setTimeout(() => cb(0), 5),
      cancelAnimationFrame: (id: number) => globalThis.clearTimeout(id)
    });

    vi.stubGlobal(
      "MutationObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );

    vi.stubGlobal("document", {
      documentElement: { dataset: {} },
      body: {},
      querySelector: (selector: string) => {
        if (selector === '[data-custom-layout-room-host="true"]') {
          return roomHostMounted ? ({} as Element) : null;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("data-mosaic-slot-id")) return [cardEl];
        return [];
      },
      startViewTransition: vi.fn((cb: () => void | Promise<void>) => {
        capturedOldTransitionName = cardEl.style.viewTransitionName;
        callbackPromise = cb();
        return { finished };
      })
    });

    runRoomViewTransition(
      "room-enter",
      () => {
        globalThis.setTimeout(() => {
          roomHostMounted = true;
        }, 10);
      },
      { roomId: "room_42" }
    );

    expect(capturedOldTransitionName).toBe("active-room-shell");
    expect(cardEl.style.viewTransitionName).toBe("");
    expect(callbackPromise).toBeInstanceOf(Promise);

    await callbackPromise;
    expect(roomHostMounted).toBe(true);

    resolveFinished();
    await finished;
  });

  it("waits for room host unmount on room-exit and tags the target card for shrink morph", async () => {
    const card99 = createMockElement("card-99", { visibleRect: true });
    let roomHostMounted = true;
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });

    let callbackPromise: void | Promise<void> | undefined;

    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false }),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      requestAnimationFrame: (cb: FrameRequestCallback) => globalThis.setTimeout(() => cb(0), 5),
      cancelAnimationFrame: (id: number) => globalThis.clearTimeout(id)
    });

    vi.stubGlobal(
      "MutationObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );

    vi.stubGlobal("document", {
      documentElement: { dataset: {} },
      body: {},
      querySelector: (selector: string) => {
        if (selector === '[data-custom-layout-room-host="true"]') {
          return roomHostMounted ? ({} as Element) : null;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (!roomHostMounted && selector.includes("data-mosaic-slot-id")) return [card99];
        return [];
      },
      startViewTransition: vi.fn((cb: () => void | Promise<void>) => {
        callbackPromise = cb();
        return { finished };
      })
    });

    runRoomViewTransition(
      "room-exit",
      () => {
        globalThis.setTimeout(() => {
          roomHostMounted = false;
        }, 10);
      },
      { roomId: "room_99" }
    );

    expect(callbackPromise).toBeInstanceOf(Promise);
    await callbackPromise;

    expect(card99.style.viewTransitionName).toBe("active-room-shell");

    resolveFinished();
    await finished;
    await Promise.resolve();
    expect(card99.style.viewTransitionName).toBe("");
  });
});
