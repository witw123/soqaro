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

  it("handles card-open by tagging source card and clearing inside callback", async () => {
    const cardEl = createMockElement("card-open-1", { visibleRect: true });
    let capturedOldTransitionName = "";
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });

    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false }),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis)
    });

    vi.stubGlobal("document", {
      documentElement: { dataset: {} },
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("data-mosaic-slot-id")) return [cardEl];
        return [];
      },
      startViewTransition: vi.fn((cb: () => void | Promise<void>) => {
        capturedOldTransitionName = cardEl.style.viewTransitionName;
        cb();
        return { finished };
      })
    });

    let commitCalled = false;
    runRoomViewTransition(
      "card-open",
      () => {
        commitCalled = true;
      },
      { roomId: "room_open_1" }
    );

    expect(capturedOldTransitionName).toBe("active-room-shell");
    expect(commitCalled).toBe(true);
    expect(cardEl.style.viewTransitionName).toBe("");

    resolveFinished();
    await finished;
    await Promise.resolve();
    expect(cardEl.style.viewTransitionName).toBe("");
  });

  it("handles card-close by tagging target card inside callback for morph shrink", async () => {
    const cardEl = createMockElement("card-close-1", { visibleRect: true });
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });

    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false }),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis)
    });

    vi.stubGlobal("document", {
      documentElement: { dataset: {} },
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("data-mosaic-slot-id")) return [cardEl];
        return [];
      },
      startViewTransition: vi.fn((cb: () => void | Promise<void>) => {
        cb();
        return { finished };
      })
    });

    let commitCalled = false;
    runRoomViewTransition(
      "card-close",
      () => {
        commitCalled = true;
      },
      { roomId: "room_close_1" }
    );

    expect(commitCalled).toBe(true);
    expect(cardEl.style.viewTransitionName).toBe("active-room-shell");

    resolveFinished();
    await finished;
    await Promise.resolve();
    expect(cardEl.style.viewTransitionName).toBe("");
  });

  it("skips off-viewport cards in favor of an in-viewport away pill and returns null if none are onscreen", () => {
    const offscreenCard = {
      ...createMockElement("offscreen-card", { visibleRect: true }),
      getBoundingClientRect: () => ({ width: 320, height: 180, top: 1200, bottom: 1380, left: 40, right: 360 })
    } as unknown as HTMLElement;
    const visiblePill = {
      ...createMockElement("visible-pill", { visibleRect: true }),
      dataset: { testid: "resume-away-room" },
      getBoundingClientRect: () => ({ width: 40, height: 40, top: 16, bottom: 56, left: 88, right: 128 })
    } as unknown as HTMLElement;

    vi.stubGlobal("window", { innerWidth: 1280, innerHeight: 800 });
    vi.stubGlobal("document", {
      documentElement: { dataset: {} },
      querySelectorAll: (selector: string) => {
        if (selector.includes("data-mosaic-slot-id")) return [offscreenCard];
        if (selector.includes("resume-away-room")) return [visiblePill];
        return [];
      }
    });

    expect(findRoomCardElement("room_offscreen")?.id).toBe("visible-pill");

    vi.stubGlobal("document", {
      documentElement: { dataset: {} },
      querySelectorAll: (selector: string) => {
        if (selector.includes("data-mosaic-slot-id")) return [offscreenCard];
        return [];
      }
    });
    expect(findRoomCardElement("room_offscreen")).toBeNull();
  });

  it("tags sheet origin on room-enter when threshold sheet is open and clears transition metadata on finish", async () => {
    const dataset: Record<string, string | undefined> = {};
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });

    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false }),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis)
    });

    vi.stubGlobal("document", {
      documentElement: { dataset },
      querySelector: (selector: string) => {
        if (selector === '[data-dialog-backdrop="room-threshold"]') return {} as Element;
        if (selector === '[data-custom-layout-room-host="true"]') return {} as Element;
        return null;
      },
      querySelectorAll: () => [],
      startViewTransition: vi.fn((cb: () => void | Promise<void>) => {
        cb();
        return { finished };
      })
    });

    runRoomViewTransition("room-enter", () => {}, { roomId: "room_sheet" });

    expect(dataset.roomTransition).toBe("room-enter");
    expect(dataset.roomTransitionOrigin).toBe("sheet");

    resolveFinished();
    await finished;
    await Promise.resolve();
    expect(dataset.roomTransition).toBeUndefined();
    expect(dataset.roomTransitionOrigin).toBeUndefined();
  });

  it("settles room-exit immediately once home grid renders without stalling on non-away missing cards", async () => {
    const dataset: Record<string, string | undefined> = {};
    let roomHostMounted = true;
    let homeGridSettled = false;
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });

    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false }),
      sessionStorage: { getItem: () => null },
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
      documentElement: { dataset },
      body: {},
      querySelector: (selector: string) => {
        if (selector === '[data-custom-layout-room-host="true"]') {
          return roomHostMounted ? ({} as Element) : null;
        }
        if (selector === '[data-testid="room-mosaic-canvas-tray"]') {
          return roomHostMounted ? null : ({} as Element);
        }
        if (selector.includes("room-directory-grid")) {
          return homeGridSettled ? ({} as Element) : null;
        }
        return null;
      },
      querySelectorAll: () => [],
      startViewTransition: vi.fn((cb: () => void | Promise<void>) => {
        const result = cb();
        return { finished, result };
      })
    });

    let callbackPromise: Promise<void> | undefined;
    const startMock = document.startViewTransition as unknown as ReturnType<typeof vi.fn>;
    startMock.mockImplementation((cb: () => void | Promise<void>) => {
      callbackPromise = cb() as Promise<void>;
      return { finished };
    });

    runRoomViewTransition(
      "room-exit",
      () => {
        roomHostMounted = false;
        globalThis.setTimeout(() => {
          homeGridSettled = true;
        }, 12);
      },
      { roomId: "deleted_or_private_room" }
    );

    const startedAt = Date.now();
    await callbackPromise;
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(homeGridSettled).toBe(true);

    resolveFinished();
    await finished;
  });

  it("ignores Radix transient data-aria-hidden wrappers on card-close while skipping real aria-hidden cached routes", () => {
    const cachedRouteCard = {
      ...createMockElement("cached-route-card", { visibleRect: true }),
      closest: (selector: string) =>
        selector.includes('[aria-hidden="true"]:not([data-aria-hidden="true"])') ? ({} as Element) : null
    } as unknown as HTMLElement;
    const radixMaskedVisibleCard = {
      ...createMockElement("radix-masked-card", { visibleRect: true }),
      closest: (selector: string) =>
        selector.includes('[aria-hidden="true"]:not([data-aria-hidden="true"])') ? null : ({} as Element)
    } as unknown as HTMLElement;

    vi.stubGlobal("document", {
      documentElement: { dataset: {} },
      querySelectorAll: (selector: string) => {
        if (selector.includes("data-mosaic-slot-id")) return [cachedRouteCard, radixMaskedVisibleCard];
        return [];
      }
    });

    expect(findRoomCardElement("room_radix_close")?.id).toBe("radix-masked-card");
  });
});
