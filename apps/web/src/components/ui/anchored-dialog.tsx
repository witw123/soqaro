"use client";

import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBackHandler } from "@/lib/desktop/use-back-handler";

export type AnchoredDialogAnchor = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
};

export function getAnchoredDialogAnchor(element: Element): AnchoredDialogAnchor {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height
  };
}

export function AnchoredDialog({
  anchor,
  ariaLabelledBy,
  children,
  className,
  onClose,
  compact = false
}: {
  anchor: AnchoredDialogAnchor;
  ariaLabelledBy: string;
  children: ReactNode;
  className?: string;
  onClose: () => void;
  compact?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(() => getFallbackPosition(anchor, compact));
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(typeof window !== "undefined" && window.innerWidth < 640);
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  useBackHandler(onClose);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (!dialog.open) {
      try {
        dialog.showModal();
      } catch {
        // Ignore duplicate modal calls in non-DOM test environments.
      }
    }

    const updatePosition = () => {
      const surface = surfaceRef.current;
      if (!surface) return;

      const dialogRect = surface.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const viewportRight = viewportLeft + viewportWidth;
      const viewportBottom = viewportTop + viewportHeight;
      const margin = 12;
      const gap = 10;
      const fitsBelow = anchor.bottom + gap + dialogRect.height <= viewportBottom - margin;
      const fitsAbove = anchor.top - gap - dialogRect.height >= viewportTop + margin;
      const top = fitsBelow || !fitsAbove
        ? Math.min(anchor.bottom + gap, viewportBottom - margin - dialogRect.height)
        : anchor.top - gap - dialogRect.height;
      const left = Math.min(
        Math.max(viewportLeft + margin, anchor.right - dialogRect.width),
        Math.max(viewportLeft + margin, viewportRight - dialogRect.width - margin)
      );

      setPosition({
        top: Math.max(viewportTop + margin, top),
        left
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updatePosition);
    const surface = surfaceRef.current;
    if (surface) resizeObserver?.observe(surface);

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
      resizeObserver?.disconnect();
      if (dialog.open) {
        dialog.close();
      }
    };
  }, [anchor]);

  return (
    <dialog
      aria-labelledby={ariaLabelledBy}
      aria-modal="true"
      className="anchored-native-dialog fixed max-h-none max-w-none overflow-visible border-0 bg-transparent p-0 text-inherit shadow-none outline-none"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      ref={dialogRef}
      style={
        isMobile
          ? undefined
          : { left: position.left, top: position.top, margin: 0 }
      }
    >
      <div
        className={`light-dialog-surface custom-scrollbar max-h-[calc(100*var(--app-dvh)-env(safe-area-inset-top)-env(safe-area-inset-bottom)-2rem)] overflow-y-auto overscroll-contain rounded-xl border border-surface-border bg-background-secondary text-foreground shadow-xl ${compact ? "w-[min(18rem,calc(100dvw-1.5rem))] p-2" : "w-[min(28rem,calc(100dvw-1.5rem))] p-5 sm:p-6"} ${className ?? ""}`}
        ref={surfaceRef}
      >
        {children}
      </div>
    </dialog>
  );
}

function getFallbackPosition(anchor: AnchoredDialogAnchor, compact = false) {
  const estimatedWidth = compact ? 288 : 448;
  return {
    top: Math.max(12, anchor.bottom + 10),
    left: Math.max(12, anchor.right - estimatedWidth)
  };
}
