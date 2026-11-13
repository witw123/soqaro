"use client";

import { useCallback } from "react";

type AudioUnlockOverlayProps = {
  visible: boolean;
  onUnlock: () => void;
};

/**
 * Full-screen overlay that prompts the user to tap/click to unlock audio playback.
 * Displayed when the browser's autoplay policy blocks audio and the user hasn't
 * interacted with the page yet. Uses the existing glassmorphism design language.
 */
export function AudioUnlockOverlay({ visible, onUnlock }: AudioUnlockOverlayProps) {
  const handleClick = useCallback(() => {
    onUnlock();
  }, [onUnlock]);

  if (!visible) {
    return null;
  }

  return (
    <div
      className="light-overlay-scrim fixed inset-0 z-[var(--z-max)] flex items-center justify-center bg-black/60 md:backdrop-blur-md"
      onClick={handleClick}
      onTouchStart={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          handleClick();
        }
      }}
      style={{ cursor: "pointer" }}
    >
      <div className="light-audio-surface pointer-events-none flex max-w-sm flex-col items-center gap-5 rounded-2xl border border-surface-border bg-white/5 px-10 py-10 text-center shadow-2xl backdrop-blur-xl">
        {/* Animated speaker icon */}
        <div className="relative flex h-20 w-20 items-center justify-center">
          <div className="absolute inset-0 animate-ping rounded-full bg-accent/20" />
          <div className="absolute inset-2 animate-pulse rounded-full bg-accent/10" />
          <svg
            className="relative z-10 h-10 w-10 text-accent"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z"
            />
          </svg>
        </div>

        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-white">
            点击激活音频
          </h2>
          <p className="text-sm leading-relaxed text-white/60">
            浏览器需要一次点击来解锁音频播放。
            <br />
            点击屏幕任意位置继续。
          </p>
        </div>

        <div className="mt-1 rounded-full border border-accent/30 bg-accent/10 px-6 py-2.5 text-sm font-medium text-accent transition-colors">
          点击继续播放
        </div>
      </div>
    </div>
  );
}
