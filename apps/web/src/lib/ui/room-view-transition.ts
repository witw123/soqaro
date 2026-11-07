"use client";

import { flushSync } from "react-dom";

export type RoomTransitionKind = "gallery" | "card-open" | "card-close" | "room-enter" | "room-exit";
export type RoomTransitionDirection = "forward" | "backward";

export type RoomViewTransitionOptions = {
  direction?: RoomTransitionDirection;
  roomId?: string | null;
  beforeCapture?: () => void;
  onFinished?: () => void;
};

type ViewTransitionHandle = {
  finished: Promise<void>;
  ready?: Promise<void>;
};

type ViewTransitionCapableDocument = Document & {
  startViewTransition?: (updateCallback: () => void | Promise<void>) => ViewTransitionHandle;
};

const MAX_ASYNC_ROUTE_WAIT_MS = 280;

let activeTaggedElement: HTMLElement | null = null;

function clearActiveTaggedElement(): void {
  if (activeTaggedElement) {
    activeTaggedElement.style.viewTransitionName = "";
    activeTaggedElement = null;
  }
}

function tagElementForShellMorph(el: HTMLElement | null): void {
  clearActiveTaggedElement();
  if (el) {
    el.style.viewTransitionName = "active-room-shell";
    activeTaggedElement = el;
  }
}

function escapeRoomSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

function isRoomHostMounted(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(document.querySelector('[data-custom-layout-room-host="true"]'));
}

function isThresholdSheetOpen(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(document.querySelector('[data-dialog-backdrop="room-threshold"]'));
}

/**
 * Finds the visible room card element corresponding to `roomId` across the
 * home mosaic grid, discover page sections, or floating away-room pill,
 * ignoring hidden cached routes inside `PersistentAppRouteViews`.
 */
export function findRoomCardElement(roomId: string | null | undefined): HTMLElement | null {
  if (typeof document === "undefined" || !roomId) return null;
  const escaped = escapeRoomSelectorValue(roomId);

  const selectors = [
    `[data-mosaic-slot-id="${escaped}"] [data-testid="room-directory-card"]`,
    `[data-discover-room-id="${escaped}"]`,
    `[data-testid="resume-away-room"]`
  ];

  let domFallback: HTMLElement | null = null;
  for (const selector of selectors) {
    const candidates = document.querySelectorAll<HTMLElement>(selector);
    for (const candidate of candidates) {
      if (candidate.closest('[aria-hidden="true"], .hidden')) continue;
      if (candidate.getClientRects().length > 0) {
        return candidate;
      }
      if (!domFallback) {
        domFallback = candidate;
      }
    }
  }
  return domFallback;
}

function waitForDomCondition(
  predicate: () => boolean,
  maxWaitMs = MAX_ASYNC_ROUTE_WAIT_MS
): Promise<void> {
  if (typeof document === "undefined" || predicate()) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    let rafId: number | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timerId);
      if (rafId !== null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(rafId);
      }
      resolve();
    };

    const check = () => {
      if (predicate()) {
        finish();
      }
    };

    const observer = new MutationObserver(check);
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "aria-hidden", "data-custom-layout-room-host"]
      });
    }

    if (typeof window.requestAnimationFrame === "function") {
      const tick = () => {
        if (settled) return;
        if (predicate()) {
          finish();
          return;
        }
        rafId = window.requestAnimationFrame(tick);
      };
      rafId = window.requestAnimationFrame(tick);
    }

    const timerId = window.setTimeout(finish, maxWaitMs);
  });
}

export function isRoomMotionReduced(): boolean {
  if (typeof document === "undefined") return true;
  if (document.documentElement.dataset.reduceMotion === "true") return true;
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return true;
  }
  return false;
}

/**
 * Runs a React state or Next.js route update inside a native View Transition
 * scoped via `html[data-room-transition]`, coordinating shared-element card <->
 * room morphing (`active-room-shell`) across synchronous and asynchronous routes.
 */
export function runRoomViewTransition(
  kind: RoomTransitionKind,
  commitUpdate: () => void,
  optionsOrOnFinished?: (() => void) | RoomViewTransitionOptions
): void {
  const options: RoomViewTransitionOptions =
    typeof optionsOrOnFinished === "function"
      ? { onFinished: optionsOrOnFinished }
      : optionsOrOnFinished ?? {};

  clearActiveTaggedElement();

  if (typeof document === "undefined" || isRoomMotionReduced()) {
    commitUpdate();
    options.onFinished?.();
    return;
  }

  const doc = document as ViewTransitionCapableDocument;
  if (typeof doc.startViewTransition !== "function") {
    commitUpdate();
    options.onFinished?.();
    return;
  }

  const root = document.documentElement;
  root.dataset.roomTransition = kind;
  if (options.direction) {
    root.dataset.roomDirection = options.direction;
  } else {
    delete root.dataset.roomDirection;
  }

  try {
    if (kind === "card-open" && options.roomId) {
      tagElementForShellMorph(findRoomCardElement(options.roomId));
    } else if (kind === "room-enter" && options.roomId && !isThresholdSheetOpen()) {
      tagElementForShellMorph(findRoomCardElement(options.roomId));
    }

    options.beforeCapture?.();

    const transition = doc.startViewTransition(() => {
      if (kind === "card-open" || kind === "room-enter") {
        clearActiveTaggedElement();
      }

      flushSync(() => {
        commitUpdate();
      });

      if (kind === "card-close") {
        if (options.roomId) {
          tagElementForShellMorph(findRoomCardElement(options.roomId));
        }
        return;
      }

      if (kind === "room-enter") {
        if (isRoomHostMounted()) {
          return;
        }
        return waitForDomCondition(() => isRoomHostMounted());
      }

      if (kind === "room-exit") {
        const targetRoomId = options.roomId;
        if (!isRoomHostMounted()) {
          if (targetRoomId) {
            tagElementForShellMorph(findRoomCardElement(targetRoomId));
          }
          return;
        }
        return waitForDomCondition(() => !isRoomHostMounted()).then(() => {
          if (!isRoomHostMounted() && targetRoomId) {
            tagElementForShellMorph(findRoomCardElement(targetRoomId));
          }
        });
      }
    });

    void transition.finished
      .catch(() => {
        // Ignore skipped or superseded view transitions during rapid interactions.
      })
      .finally(() => {
        clearActiveTaggedElement();
        if (root.dataset.roomTransition === kind) {
          delete root.dataset.roomTransition;
          delete root.dataset.roomDirection;
        }
        options.onFinished?.();
      });
  } catch {
    clearActiveTaggedElement();
    delete root.dataset.roomTransition;
    delete root.dataset.roomDirection;
    commitUpdate();
    options.onFinished?.();
  }
}

let roomRuntimePreloadPromise: Promise<unknown> | null = null;

/**
 * Warms the SoqaroApp realtime room chunk and default library panel on hover or
 * threshold open so entering a room hands off on frame 0 without a cold-bundle gap.
 */
export function prewarmRoomRuntimeChunk(): void {
  if (typeof window === "undefined" || roomRuntimePreloadPromise) return;
  roomRuntimePreloadPromise = Promise.all([
    import("@/components/soqaro-app"),
    import("@/components/room/LibraryTabPanel")
  ]).catch(() => {
    roomRuntimePreloadPromise = null;
  });
}
