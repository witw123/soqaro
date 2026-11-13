"use client";

import { flushSync } from "react-dom";
import { readAwayRoomId } from "@/lib/domain/away-room";

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

type ViewTransitionUpdateCallback = () => void | Promise<void>;

type ViewTransitionCapableDocument = Document & {
  startViewTransition?: (
    callbackOrOptions:
      | ViewTransitionUpdateCallback
      | { update: ViewTransitionUpdateCallback; types?: string[] }
  ) => ViewTransitionHandle;
};

const MAX_ASYNC_ROUTE_WAIT_MS = 1500;

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

function hasVisibleDomMatch(selector: string): boolean {
  const candidates = document.querySelectorAll<HTMLElement>(selector);
  if (candidates.length > 0) {
    for (const candidate of candidates) {
      if (candidate.closest('[aria-hidden="true"]:not([data-aria-hidden="true"]), .hidden')) continue;
      return true;
    }
    return false;
  }
  const single = document.querySelector<HTMLElement>(selector);
  if (!single) return false;
  return !single.closest?.('[aria-hidden="true"]:not([data-aria-hidden="true"]), .hidden');
}

function isHomeDirectorySettled(): boolean {
  if (typeof document === "undefined") return true;
  const pathname = typeof window !== "undefined" ? window.location?.pathname : undefined;
  if (pathname === "/app" || pathname === "/rooms") {
    return hasVisibleDomMatch(
      '[data-testid="room-directory-grid"], [data-testid="room-directory-empty"]'
    );
  }
  if (pathname === "/app/discover") {
    return hasVisibleDomMatch(
      '[data-discover-ready], [data-discover-room-id], [data-discover-empty]'
    );
  }
  const mosaicTray = document.querySelector('[data-testid="room-mosaic-canvas-tray"]');
  if (!mosaicTray) return true;
  return hasVisibleDomMatch(
    '[data-testid="room-directory-grid"], [data-testid="room-directory-empty"]'
  );
}

function isElementVisibleInViewport(el: HTMLElement): boolean {
  if (el.getClientRects().length === 0) return false;
  if (
    typeof el.getBoundingClientRect !== "function" ||
    typeof window === "undefined" ||
    !Number.isFinite(window.innerWidth) ||
    !Number.isFinite(window.innerHeight) ||
    window.innerWidth <= 0 ||
    window.innerHeight <= 0
  ) {
    return true;
  }

  const rect = el.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

function classifyMorphRole(el: HTMLElement | null): "pill" | "card" | null {
  if (!el) return null;
  return el.dataset?.testid === "resume-away-room" ? "pill" : "card";
}

function findFirstVisibleCandidate(selector: string): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(selector);
  for (const candidate of candidates) {
    // Ignore hidden cached routes in PersistentAppRouteViews, but do not skip
    // visible routes whose Radix `data-aria-hidden="true"` cleanup runs passively.
    if (candidate.closest('[aria-hidden="true"]:not([data-aria-hidden="true"]), .hidden')) continue;
    if (isElementVisibleInViewport(candidate)) {
      return candidate;
    }
  }
  return null;
}

function findNonHiddenCardElement(roomId: string | null | undefined): HTMLElement | null {
  if (typeof document === "undefined" || !roomId) return null;
  const escaped = escapeRoomSelectorValue(roomId);

  const cardSelectors = [
    `[data-mosaic-slot-id="${escaped}"] [data-testid="room-directory-card"]`,
    `[data-discover-room-id="${escaped}"]`
  ];

  for (const selector of cardSelectors) {
    const candidates = document.querySelectorAll<HTMLElement>(selector);
    for (const candidate of candidates) {
      if (candidate.closest('[aria-hidden="true"]:not([data-aria-hidden="true"]), .hidden')) continue;
      if (candidate.getClientRects().length > 0) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Finds the visible, in-viewport room card element corresponding to `roomId`
 * across the home mosaic grid, discover page sections, or floating away-room
 * pill, ignoring hidden cached routes inside `PersistentAppRouteViews`.
 */
export function findRoomCardElement(roomId: string | null | undefined): HTMLElement | null {
  if (typeof document === "undefined" || !roomId) return null;
  const escaped = escapeRoomSelectorValue(roomId);

  const cardSelectors = [
    `[data-mosaic-slot-id="${escaped}"] [data-testid="room-directory-card"]`,
    `[data-discover-room-id="${escaped}"]`
  ];

  for (const selector of cardSelectors) {
    const match = findFirstVisibleCandidate(selector);
    if (match) return match;
  }

  return findFirstVisibleCandidate('[data-testid="resume-away-room"]');
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
    let pollTimerId: number | null = null;
    let mutationCheckQueued = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timerId);
      if (pollTimerId !== null) {
        window.clearTimeout(pollTimerId);
      }
      resolve();
    };

    const runCheck = () => {
      mutationCheckQueued = false;
      if (!settled && predicate()) {
        finish();
      }
    };

    // Coalesce bursts of React commit / unmount mutations into a single check
    // instead of querying the DOM and calling `getClientRects()` per mutation record.
    const scheduleMutationCheck = () => {
      if (settled || mutationCheckQueued) return;
      mutationCheckQueued = true;
      if (typeof queueMicrotask === "function") {
        queueMicrotask(runCheck);
      } else {
        runCheck();
      }
    };

    const observer = new MutationObserver(scheduleMutationCheck);
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "class",
          "aria-hidden",
          "data-custom-layout-room-host",
          "data-discover-ready",
          "data-discover-empty"
        ]
      });
    }

    // Throttled safety poll for non-DOM state updates without running on every rAF frame.
    const schedulePoll = () => {
      pollTimerId = window.setTimeout(() => {
        if (settled) return;
        if (predicate()) {
          finish();
          return;
        }
        schedulePoll();
      }, 25);
    };
    schedulePoll();

    const timerId = window.setTimeout(finish, maxWaitMs);
  });
}

function restoreRoomTransitionFocus(kind: RoomTransitionKind): void {
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") {
    return;
  }
  if (kind !== "room-enter" && kind !== "room-exit" && kind !== "card-close") {
    return;
  }

  const active = document.activeElement as HTMLElement | null;
  const activeLost =
    !active ||
    active === document.body ||
    active === document.documentElement ||
    active.isConnected === false ||
    Boolean(
      typeof active.closest === "function" &&
      active.closest('.hidden, [aria-hidden="true"], [data-morphed-to-modal="true"]')
    );

  if (!activeLost) {
    return;
  }

  const mains = Array.from(document.querySelectorAll<HTMLElement>("main"));
  const visibleMain = mains.find(
    (main) =>
      typeof main.closest !== "function" ||
      !main.closest('.hidden, [aria-hidden="true"]:not([data-aria-hidden="true"])')
  );
  if (!visibleMain) {
    return;
  }

  const target =
    (typeof visibleMain.querySelector === "function"
      ? visibleMain.querySelector<HTMLElement>("h1")
      : null) ?? visibleMain;

  if (typeof target.focus !== "function") {
    return;
  }

  if (typeof target.hasAttribute === "function" && !target.hasAttribute("tabindex") && target.tabIndex < 0) {
    target.setAttribute("tabindex", "-1");
  }
  target.focus({ preventScroll: true });
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
    restoreRoomTransitionFocus(kind);
    options.onFinished?.();
    return;
  }

  const doc = document as ViewTransitionCapableDocument;
  if (typeof doc.startViewTransition !== "function") {
    commitUpdate();
    restoreRoomTransitionFocus(kind);
    options.onFinished?.();
    return;
  }

  const root = document.documentElement;
  const clearRootTransitionAttrs = () => {
    delete root.dataset.roomTransition;
    delete root.dataset.roomDirection;
    delete root.dataset.roomTransitionOrigin;
    delete root.dataset.roomTransitionTarget;
  };

  root.dataset.roomTransition = kind;
  delete root.dataset.roomTransitionOrigin;
  delete root.dataset.roomTransitionTarget;
  if (options.direction) {
    root.dataset.roomDirection = options.direction;
  } else {
    delete root.dataset.roomDirection;
  }

  const tagRoomExitTarget = (targetRoomId: string | null | undefined) => {
    if (!targetRoomId) return;
    let target = findRoomCardElement(targetRoomId);
    if (!target || classifyMorphRole(target) === "pill") {
      const renderedCard = findNonHiddenCardElement(targetRoomId);
      if (renderedCard) {
        renderedCard.scrollIntoView?.({
          behavior: "instant" as ScrollBehavior,
          block: "nearest"
        });
        target = findRoomCardElement(targetRoomId) ?? renderedCard;
      }
    }
    tagElementForShellMorph(target);
    const role = classifyMorphRole(target);
    if (role) {
      root.dataset.roomTransitionTarget = role;
    }
  };

  try {
    if (kind === "card-open" && options.roomId) {
      tagElementForShellMorph(findRoomCardElement(options.roomId));
    } else if (kind === "room-enter") {
      if (isThresholdSheetOpen()) {
        root.dataset.roomTransitionOrigin = "sheet";
      } else if (options.roomId) {
        const origin = findRoomCardElement(options.roomId);
        tagElementForShellMorph(origin);
        const role = classifyMorphRole(origin);
        if (role) {
          root.dataset.roomTransitionOrigin = role;
        }
      }
    }

    options.beforeCapture?.();

    const runTransitionUpdate: ViewTransitionUpdateCallback = () => {
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
        const canResolveExitTarget = () => {
          if (isRoomHostMounted()) return false;
          if (!isHomeDirectorySettled()) return false;
          if (!targetRoomId) return true;
          if (findRoomCardElement(targetRoomId) || findNonHiddenCardElement(targetRoomId)) {
            return true;
          }
          // If the room is no longer marked away (leave/delete of a private room),
          // finish immediately so exit falls back cleanly instead of stalling.
          return readAwayRoomId() !== targetRoomId;
        };

        if (canResolveExitTarget()) {
          tagRoomExitTarget(targetRoomId);
          return;
        }
        return waitForDomCondition(canResolveExitTarget, MAX_ASYNC_ROUTE_WAIT_MS).then(() => {
          if (!isRoomHostMounted()) {
            tagRoomExitTarget(targetRoomId);
          }
        });
      }
    };

    const transitionTypes = options.direction ? [kind, options.direction] : [kind];
    const supportsTypedTransitions =
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("selector(:active-view-transition-type(forward))");

    const transition = supportsTypedTransitions
      ? doc.startViewTransition({ update: runTransitionUpdate, types: transitionTypes })
      : doc.startViewTransition(runTransitionUpdate);

    void transition.finished
      .catch(() => {
        // Ignore skipped or superseded view transitions during rapid interactions.
      })
      .finally(() => {
        clearActiveTaggedElement();
        if (root.dataset.roomTransition === kind) {
          clearRootTransitionAttrs();
        }
        restoreRoomTransitionFocus(kind);
        options.onFinished?.();
      });
  } catch {
    clearActiveTaggedElement();
    clearRootTransitionAttrs();
    commitUpdate();
    restoreRoomTransitionFocus(kind);
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

export async function awaitRoomRuntimePrewarm(): Promise<void> {
  prewarmRoomRuntimeChunk();
  if (!roomRuntimePreloadPromise || typeof window === "undefined") return;
  let timerId: number | undefined;
  try {
    await Promise.race([
      roomRuntimePreloadPromise,
      new Promise<void>((resolve) => {
        timerId = window.setTimeout(resolve, 1500);
      })
    ]);
  } finally {
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
    }
  }
}
