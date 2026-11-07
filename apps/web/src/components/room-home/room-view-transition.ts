"use client";

import { flushSync } from "react-dom";

export type RoomTransitionKind = "gallery" | "card-open" | "card-close" | "room-enter";
export type RoomTransitionDirection = "forward" | "backward";

export type RoomViewTransitionOptions = {
  direction?: RoomTransitionDirection;
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
 * Runs a synchronous React state update inside a native View Transition scoped
 * via `html[data-room-transition]`, preventing interference with the theme
 * circular reveal rules while degrading cleanly when unsupported or reduced.
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
    options.beforeCapture?.();

    const transition = doc.startViewTransition(() => {
      flushSync(() => {
        commitUpdate();
      });
    });

    void transition.finished
      .catch(() => {
        // Ignore skipped or superseded view transitions during rapid clicks.
      })
      .finally(() => {
        if (root.dataset.roomTransition === kind) {
          delete root.dataset.roomTransition;
          delete root.dataset.roomDirection;
        }
        options.onFinished?.();
      });
  } catch {
    delete root.dataset.roomTransition;
    delete root.dataset.roomDirection;
    commitUpdate();
    options.onFinished?.();
  }
}

let roomRuntimePreloadPromise: Promise<unknown> | null = null;

/**
 * Warms the ~1MB SoqaroApp realtime room chunk on hover/threshold open so
 * clicking "进入房间" hands off immediately without a cold-bundle spinner gap.
 */
export function prewarmRoomRuntimeChunk(): void {
  if (typeof window === "undefined" || roomRuntimePreloadPromise) return;
  roomRuntimePreloadPromise = import("@/components/soqaro-app").catch(() => {
    roomRuntimePreloadPromise = null;
  });
}
