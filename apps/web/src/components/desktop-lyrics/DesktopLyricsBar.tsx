"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import {
  getActiveRoomLyricIndex,
  alignRoomLyricLines,
  getRoomLyricDisplayWords,
  getRoomLyricWordProgress,
  parseRoomLyrics
} from "@/features/playback/lyrics";
import { toCssUrlValue } from "@/lib/domain/url-safety";
import { formatDuration } from "@/lib/domain/soqaro-ui";
import { appSettingsChangeEvent, getAppSettings } from "@/features/settings/settings-store";

export type DesktopLyricsBarLyrics = {
  plainLyric: string | null;
  translatedLyric?: string | null;
  romanizedLyric?: string | null;
};

export type DesktopLyricsBarProps = {
  title: string;
  artist?: string | null;
  artworkUrl: string | null;
  durationMs?: number | null;
  plainLyric: string | null;
  wordSyncedLyric?: string | null;
  translatedLyric?: string | null;
  romanizedLyric?: string | null;
  showTranslation?: boolean;
  showRomanized?: boolean;
  offsetMs?: number;
  onToggleTranslation?: () => void;
  onToggleRomanized?: () => void;
  /** Latest playback position reported by the host; interpolated with rAF. */
  progressMs: number;
  /** Host wall-clock time (Date.now()) when progressMs was sampled. */
  anchorAt: number;
  isPlaying: boolean;
  status: "idle" | "loading" | "ready" | "error";
  canControl: boolean;
  onPrev: () => void;
  onTogglePlay: () => void;
  onNext: () => void;
  onClose: () => void;
  /** Optional host drag hook (Tauri native window dragging). */
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onScaleChange?: (scale: number) => void;
};

/**
 * Floating desktop lyrics bar.
 * - Center lyrics container stays fixed in the center, preventing layout jumps when expanding/closing.
 * - Word-by-word karaoke rendering 1:1 aligned with immersive lyrics (RoomLyricsPanel).
 * - Smooth requestAnimationFrame interpolation with zero DOM-mutation race conditions.
 */
export function DesktopLyricsBar({
  title,
  artist,
  artworkUrl,
  durationMs,
  plainLyric,
  wordSyncedLyric = null,
  translatedLyric = null,
  romanizedLyric = null,
  showTranslation = true,
  showRomanized = false,
  offsetMs = 0,
  onToggleTranslation,
  onToggleRomanized,
  progressMs,
  anchorAt,
  isPlaying,
  status,
  canControl,
  onPrev,
  onTogglePlay,
  onNext,
  onClose,
  onPointerDown
}: DesktopLyricsBarProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const textContentRef = useRef<HTMLDivElement | null>(null);
  const [surfaceHeight, setSurfaceHeight] = useState(76);
  const [isExpanded, setIsExpanded] = useState(false);
  const [overflowPx, setOverflowPx] = useState(0);
  const [lyricScale, setLyricScale] = useState(
    () => getAppSettings().playback.desktopLyricScale
  );
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const autoCollapseTimerRef = useRef<number | null>(null);

  // Auto-collapse panel after 5 seconds of inactivity
  const resetAutoCollapseTimer = useCallback(() => {
    if (autoCollapseTimerRef.current) {
      window.clearTimeout(autoCollapseTimerRef.current);
      autoCollapseTimerRef.current = null;
    }
    autoCollapseTimerRef.current = window.setTimeout(() => {
      setIsExpanded(false);
    }, 5000);
  }, []);

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => {
      const next = !prev;
      if (next) {
        resetAutoCollapseTimer();
      } else if (autoCollapseTimerRef.current) {
        window.clearTimeout(autoCollapseTimerRef.current);
        autoCollapseTimerRef.current = null;
      }
      return next;
    });
  }, [resetAutoCollapseTimer]);

  useEffect(() => {
    return () => {
      if (autoCollapseTimerRef.current) {
        window.clearTimeout(autoCollapseTimerRef.current);
      }
    };
  }, []);

  // Sync scale settings
  useEffect(() => {
    const syncScale = () => setLyricScale(getAppSettings().playback.desktopLyricScale);
    syncScale();
    window.addEventListener(appSettingsChangeEvent, syncScale);
    window.addEventListener("storage", syncScale);
    return () => {
      window.removeEventListener(appSettingsChangeEvent, syncScale);
      window.removeEventListener("storage", syncScale);
    };
  }, []);

  // Track bar surface height for responsive font scaling
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height && height > 0) setSurfaceHeight(height);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // Parse lyrics
  const lines = useMemo(() => parseRoomLyrics(
    wordSyncedLyric || plainLyric
  ), [plainLyric, wordSyncedLyric]);
  const translatedLines = useMemo(() => parseRoomLyrics(translatedLyric), [translatedLyric]);
  const romanizedLines = useMemo(() => parseRoomLyrics(romanizedLyric), [romanizedLyric]);

  // High precision position interpolation with requestAnimationFrame (identical to RoomLyricsPanel)
  const [smoothPositionMs, setSmoothPositionMs] = useState(progressMs);
  const anchorRef = useRef({
    baseMs: progressMs,
    receivedAt: typeof performance !== "undefined" ? performance.now() : Date.now()
  });

  useEffect(() => {
    const hostElapsed = anchorAt > 0 && isPlaying
      ? Math.max(0, Math.min(500, Date.now() - anchorAt))
      : 0;
    const currentBaseMs = progressMs + hostElapsed;
    anchorRef.current = {
      baseMs: currentBaseMs,
      receivedAt: typeof performance !== "undefined" ? performance.now() : Date.now()
    };
    setSmoothPositionMs(currentBaseMs);
  }, [progressMs, anchorAt, isPlaying]);

  useEffect(() => {
    if (!isPlaying) {
      setSmoothPositionMs(progressMs);
      return;
    }

    let animationFrameId = 0;
    let lastUpdateAt = 0;
    const tick = () => {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now - lastUpdateAt >= 32) {
        lastUpdateAt = now;
        const elapsed = Math.max(0, now - anchorRef.current.receivedAt);
        setSmoothPositionMs(anchorRef.current.baseMs + elapsed);
      }
      animationFrameId = window.requestAnimationFrame(tick);
    };

    animationFrameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(animationFrameId);
  }, [isPlaying, progressMs]);

  // Compute active lyric line and display words
  const effectivePositionMs = Math.max(0, smoothPositionMs + offsetMs);
  const activeIndex = useMemo(
    () => (lines.length > 0 ? Math.max(0, getActiveRoomLyricIndex(lines, effectivePositionMs)) : -1),
    [lines, effectivePositionMs]
  );
  const activeLine = activeIndex >= 0 ? lines[activeIndex] : null;
  const displayWords = useMemo(
    () => (activeIndex >= 0 ? getRoomLyricDisplayWords(lines, activeIndex) : []),
    [lines, activeIndex]
  );
  const displayLineKey = `${title}:${activeLine?.id ?? "empty"}`;

  const lineText =
    displayWords.length > 0
      ? displayWords.map((word) => word.text).join("")
      : activeLine?.text ?? null;
  const hasLyrics = lines.length > 0;

  // Sub-line: translation or romanization
  const alignedTranslatedLines = useMemo(
    () => alignRoomLyricLines(lines, translatedLines),
    [lines, translatedLines]
  );
  const alignedRomanizedLines = useMemo(
    () => alignRoomLyricLines(lines, romanizedLines),
    [lines, romanizedLines]
  );
  const subLineText = useMemo(() => {
    if (activeIndex < 0) return null;
    if (showTranslation && alignedTranslatedLines[activeIndex]?.text) {
      return alignedTranslatedLines[activeIndex].text;
    }
    if (showRomanized && alignedRomanizedLines[activeIndex]?.text) {
      return alignedRomanizedLines[activeIndex].text;
    }
    return null;
  }, [activeIndex, alignedRomanizedLines, alignedTranslatedLines, showRomanized, showTranslation]);
  const hasSubLine = Boolean(subLineText);

  // Dynamic font sizing based on scale setting
  const baseFontSize = hasSubLine
    ? Math.round(Math.min(90, Math.max(16, surfaceHeight * 0.30 * lyricScale)))
    : Math.round(Math.min(110, Math.max(18, surfaceHeight * 0.40 * lyricScale)));
  const subFontSize = Math.round(Math.max(12, baseFontSize * 0.56));

  // Check text overflow for horizontal auto-scrolling
  useEffect(() => {
    const container = containerRef.current;
    const text = textContentRef.current;
    if (!container || !text) {
      setOverflowPx(0);
      return;
    }
    const updateOverflow = () => {
      const diff = text.scrollWidth - container.clientWidth;
      setOverflowPx(diff > 4 ? diff : 0);
    };
    updateOverflow();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(container);
    observer.observe(text);
    return () => observer.disconnect();
  }, [activeIndex, lineText, baseFontSize, subLineText]);

  // Smooth auto-scroll offset for overflowing lines
  const scrollOffset = useMemo(() => {
    if (overflowPx <= 0 || displayWords.length === 0) return 0;
    const startMs = displayWords[0]?.timeMs ?? 0;
    const lastWord = displayWords[displayWords.length - 1];
    const endMs = (lastWord?.timeMs ?? 0) + (lastWord?.durationMs ?? 1000);
    const duration = Math.max(800, endMs - startMs);
    const lineProgress = Math.min(1, Math.max(0, (smoothPositionMs - startMs) / duration));
    return -Math.min(overflowPx, Math.round(lineProgress * (overflowPx + 24)));
  }, [overflowPx, displayWords, smoothPositionMs]);

  const message = status === "loading" && !hasLyrics
    ? "正在获取歌词…"
    : hasLyrics
      ? lineText ?? "暂无歌词"
      : status === "error"
        ? "歌词暂时不可用"
        : "等待选择歌曲";

  const handlePointerDownInternal = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragStartPosRef.current = { x: event.clientX, y: event.clientY };
    onPointerDown?.(event);
  };

  const handlePointerUpInternal = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) {
      return;
    }
    if (dragStartPosRef.current) {
      const dx = Math.abs(event.clientX - dragStartPosRef.current.x);
      const dy = Math.abs(event.clientY - dragStartPosRef.current.y);
      if (dx < 6 && dy < 6) {
        toggleExpanded();
      }
    }
    dragStartPosRef.current = null;
  };

  return (
    <div
      ref={rootRef}
      aria-label={`桌面歌词：${title}${artist ? ` - ${artist}` : ""}`}
      className="group relative flex h-full w-full min-w-0 items-center justify-center bg-transparent px-2 md:px-4 py-1 text-white select-none cursor-grab active:cursor-grabbing"
      data-testid="desktop-lyrics-bar"
      onPointerDown={handlePointerDownInternal}
      onPointerUp={handlePointerUpInternal}
      onPointerMove={() => {
        if (isExpanded) resetAutoCollapseTimer();
      }}
    >
      {/* Left: Album Cover Thumbnail + Song Name, Artist, and Duration Time (Floating Overlay) */}
      <div
        className={`absolute left-2 md:left-3 top-1/2 -translate-y-1/2 z-20 flex max-w-[calc(50vw-4rem)] md:max-w-xs items-center rounded-2xl bg-zinc-950/80 backdrop-blur-md border border-white/10 px-2.5 py-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.5)] transition-all duration-300 ease-out ${
          isExpanded
            ? "opacity-100 scale-100 pointer-events-auto"
            : "opacity-0 scale-95 pointer-events-none -translate-x-2"
        }`}
      >
        <div
          aria-hidden="true"
          className={`relative h-10 w-10 md:h-11 md:w-11 shrink-0 overflow-hidden rounded-xl border border-white/20 bg-black/40 bg-cover bg-center shadow-[0_4px_16px_rgba(0,0,0,0.6)] transition-transform duration-300 ${
            isPlaying ? "scale-100" : "scale-95 opacity-80"
          }`}
          style={{
            backgroundImage: toCssUrlValue(artworkUrl)
          }}
          title={artist ? `${title} - ${artist}` : title}
        >
          {!artworkUrl ? (
            <div className="grid h-full w-full place-items-center text-white/50">
              <MusicNoteIcon />
            </div>
          ) : null}
        </div>

        {/* Track Title, Artist, and Playback Time */}
        <div className="ml-2.5 flex min-w-0 flex-col justify-center text-left leading-tight">
          <span className="truncate text-xs md:text-sm font-bold text-white max-w-[8.5rem] md:max-w-[11rem]">
            {title || "等待选择歌曲"}
          </span>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-white/75 truncate max-w-[8.5rem] md:max-w-[11rem]">
            {artist ? <span className="truncate">{artist}</span> : null}
            <span className="shrink-0 tabular-nums text-white/50 font-medium">
              <span>{formatDuration(smoothPositionMs)}</span>
              {durationMs ? ` / ${formatDuration(durationMs)}` : ""}
            </span>
          </div>
        </div>
      </div>

      {/* Center: Pure Karaoke Lyric Line with Smooth Horizontal Auto-Scrolling (Layout Never Shifts) */}
      <div
        ref={containerRef}
        className="relative z-10 flex h-full w-full min-w-0 flex-col justify-center items-center overflow-hidden px-4 md:px-6 text-center select-none"
        data-testid="desktop-lyrics-line"
      >
        {/* Main Lyric Line Wrapper */}
        <div
          ref={textContentRef}
          className={`whitespace-nowrap ${
            overflowPx > 0 ? "self-start text-left" : "self-center text-center"
          } font-bold tracking-tight text-white leading-tight`}
          style={{
            fontSize: `${baseFontSize}px`,
            transform: overflowPx > 0 && scrollOffset !== 0 ? `translateX(${scrollOffset}px)` : undefined
          }}
        >
          {hasLyrics && displayWords.length > 0 ? (
            displayWords.map((word, wordIndex) => {
              if (!word.text.trim()) {
                return (
                  <span
                    className="inline whitespace-pre opacity-30 text-white font-bold"
                    key={`${displayLineKey}:${wordIndex}`}
                  >
                    {word.text}
                  </span>
                );
              }

              const progress = getRoomLyricWordProgress(word, effectivePositionMs);
              if (progress >= 1) {
                return (
                  <span
                    className="inline-block whitespace-pre opacity-100 text-white font-bold"
                    key={`${displayLineKey}:${wordIndex}`}
                  >
                    {word.text}
                  </span>
                );
              }
              if (progress <= 0) {
                return (
                  <span
                    className="inline-block whitespace-pre opacity-30 text-white font-bold"
                    key={`${displayLineKey}:${wordIndex}`}
                  >
                    {word.text}
                  </span>
                );
              }

              const fillPercent = `${(progress * 100).toFixed(1)}%`;
              return (
                <span
                  className="inline-block whitespace-pre text-transparent font-bold"
                  key={`${displayLineKey}:${wordIndex}`}
                  style={{
                    backgroundImage: `linear-gradient(to right, rgb(255 255 255) 0%, rgb(255 255 255) ${fillPercent}, rgb(255 255 255 / 0.3) ${fillPercent}, rgb(255 255 255 / 0.3) 100%)`,
                    backgroundClip: "text",
                    WebkitBackgroundClip: "text",
                    WebkitBoxDecorationBreak: "clone",
                    boxDecorationBreak: "clone"
                  }}
                >
                  {word.text}
                </span>
              );
            })
          ) : (
            <span
              className={`block truncate ${
                status === "loading" ? "animate-pulse text-white/70" : "text-white/85"
              }`}
            >
              {message}
            </span>
          )}
        </div>

        {/* Translation / Romanization Sub-line */}
        {hasSubLine ? (
          <div
            className="mt-1 max-w-full truncate text-white/75 font-medium tracking-wide"
            style={{ fontSize: `${subFontSize}px` }}
          >
            {subLineText}
          </div>
        ) : null}
      </div>

      {/* Right: Floating Controls (Floating Overlay) */}
      <div
        className={`absolute right-2 md:right-3 top-1/2 -translate-y-1/2 z-20 flex shrink-0 items-center rounded-full bg-zinc-950/80 backdrop-blur-md border border-white/10 px-2 py-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.5)] cursor-default transition-all duration-300 ease-out ${
          isExpanded
            ? "opacity-100 scale-100 pointer-events-auto"
            : "opacity-0 scale-95 pointer-events-none translate-x-2"
        }`}
      >
        <div className="flex items-center gap-1.5">
          {/* Playback Transport: Prev, Play/Pause, Next */}
          <TransportButton disabled={!canControl} label="上一首" onClick={onPrev}>
            <PrevIcon />
          </TransportButton>
          <TransportButton
            disabled={!canControl}
            label={isPlaying ? "暂停" : "播放"}
            onClick={onTogglePlay}
            primary
          >
            {isPlaying ? <PauseIcon /> : <PlayIcon />}
          </TransportButton>
          <TransportButton disabled={!canControl} label="下一首" onClick={onNext}>
            <NextIcon />
          </TransportButton>

          {/* Translation toggle (译) */}
          {translatedLines.length > 0 && onToggleTranslation ? (
            <button
              aria-label="切换翻译"
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold border-[0.5px] transition cursor-pointer ${
                showTranslation
                  ? "border-white/35 bg-white/20 text-white shadow-xs"
                  : "border-white/10 bg-black/20 text-white/70 hover:bg-white/15 hover:text-white"
              }`}
              onClick={onToggleTranslation}
              title={showTranslation ? "隐藏歌词翻译" : "显示歌词翻译"}
              type="button"
            >
              译
            </button>
          ) : null}

          {/* Romanization toggle (音) */}
          {romanizedLines.length > 0 && onToggleRomanized ? (
            <button
              aria-label="切换罗马音"
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold border-[0.5px] transition cursor-pointer ${
                showRomanized
                  ? "border-white/35 bg-white/20 text-white shadow-xs"
                  : "border-white/10 bg-black/20 text-white/70 hover:bg-white/15 hover:text-white"
              }`}
              onClick={onToggleRomanized}
              title={showRomanized ? "隐藏罗马音" : "显示罗马音"}
              type="button"
            >
              音
            </button>
          ) : null}

          {/* Close Button */}
          <button
            aria-label="关闭桌面歌词"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/10 bg-black/20 text-white/70 transition hover:border-red-400/50 hover:bg-red-500/30 hover:text-red-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            onClick={onClose}
            title="关闭桌面歌词"
            type="button"
          >
            <CloseIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

function TransportButton({
  children,
  disabled,
  label,
  onClick,
  primary = false
}: {
  children: React.ReactNode;
  disabled: boolean;
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      aria-label={label}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer ${
        disabled
          ? "cursor-not-allowed opacity-30 text-white/30"
          : primary
            ? "bg-white text-zinc-950 shadow-lg hover:bg-white/90 hover:scale-105 active:scale-95"
            : "border border-white/10 bg-black/20 text-white/80 hover:bg-white/20 hover:text-white active:scale-95"
      }`}
      disabled={disabled}
      onClick={onClick}
      title={disabled ? "当前没有播放控制权限" : label}
      type="button"
    >
      {children}
    </button>
  );
}

function MusicNoteIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" height="18" viewBox="0 0 24 24" width="18">
      <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" height="12" viewBox="0 0 24 24" width="12">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" height="12" viewBox="0 0 24 24" width="12">
      <path d="M7 5h4v14H7zm6 0h4v14h-4z" />
    </svg>
  );
}

function PrevIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" height="12" viewBox="0 0 24 24" width="12">
      <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" height="12" viewBox="0 0 24 24" width="12">
      <path d="M6 18l8.5-6L6 6zm10-12v12h2V6z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
      <path d="m7 7 10 10M17 7 7 17" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}
