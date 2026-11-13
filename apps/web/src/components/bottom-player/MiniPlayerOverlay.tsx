"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Slider } from "@/components/ui/slider";
import { useBackHandler } from "@/lib/desktop/use-back-handler";
import { getArtworkSourceUrl, useArtworkPalette } from "@/components/bottom-player/artwork-colors";

type DocumentPictureInPictureApi = {
  requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>;
};

type WindowWithDocumentPictureInPicture = Window & {
  documentPictureInPicture?: DocumentPictureInPictureApi;
};

/** Request a top-level floating window when the browser supports Document PiP. */
export function requestMiniPlayerWindow() {
  if (typeof window === "undefined") {
    return Promise.resolve<Window | null>(null);
  }

  const documentPictureInPicture = (window as WindowWithDocumentPictureInPicture).documentPictureInPicture;
  return documentPictureInPicture
    ? documentPictureInPicture.requestWindow({ width: 640, height: 760 })
    : Promise.resolve<Window | null>(null);
}

type MiniPlayerOverlayProps = {
  isOpen: boolean;
  isPlaying: boolean;
  canControlPlayback: boolean;
  canSeekPlayback: boolean;
  playbackTrackId: string | null | undefined;
  title: string;
  artist: string;
  positionMs: number;
  durationMs: number;
  artworkUrl: string | null;
  setSeekDraft: (value: number | null) => void;
  commitSeek: () => void;
  onPrev: () => void;
  onNext: () => void;
  onTogglePlay: () => void;
  onOpenImmersive: () => void;
  onClose: () => void;
  pipWindow?: Window | null;
};

type FloatingPosition = {
  left: number;
  top: number;
};

const floatingInset = 12;

export function MiniPlayerOverlay({
  isOpen,
  isPlaying,
  canControlPlayback,
  canSeekPlayback,
  playbackTrackId,
  title,
  artist,
  positionMs,
  durationMs,
  artworkUrl,
  setSeekDraft,
  commitSeek,
  onPrev,
  onNext,
  onTogglePlay,
  onOpenImmersive,
  onClose,
  pipWindow = null
}: MiniPlayerOverlayProps) {
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const [position, setPosition] = useState<FloatingPosition | null>(null);
  const palette = useArtworkPalette(artworkUrl);

  useEffect(() => {
    if (!pipWindow) {
      return;
    }

    copyStylesToPictureInPictureWindow(pipWindow);
    const syncPipTheme = () => {
      const theme = document.documentElement.dataset.theme ?? "dark";
      pipWindow.document.documentElement.dataset.theme = theme;
      pipWindow.document.documentElement.style.colorScheme = theme;
    };
    syncPipTheme();
    const themeObserver = new MutationObserver(syncPipTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"]
    });
    const handlePageHide = () => onClose();
    pipWindow.addEventListener("pagehide", handlePageHide);
    return () => {
      themeObserver.disconnect();
      pipWindow.removeEventListener("pagehide", handlePageHide);
    };
  }, [onClose, pipWindow]);

  useEffect(() => {
    if (!isOpen) {
      dragRef.current = null;
      setPosition(null);
      return;
    }

    const clampPosition = () => {
      const panel = panelRef.current;
      if (!panel) return;
      setPosition((current) => current ? clampFloatingPosition(current, panel) : current);
    };

    const ownerWindow = pipWindow ?? window;
    ownerWindow.addEventListener("resize", clampPosition);
    return () => ownerWindow.removeEventListener("resize", clampPosition);
  }, [isOpen, pipWindow]);

  useBackHandler(onClose, isOpen);

  if (!isOpen) return null;

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !panel) return;
    const nextPosition = {
      left: event.clientX - drag.offsetX,
      top: event.clientY - drag.offsetY
    };
    setPosition(clampFloatingPosition(nextPosition, panel));
  };

  const stopDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const panelPositionStyle = position ? { left: position.left, top: position.top } : undefined;
  const artworkSource = artworkUrl ? getArtworkSourceUrl(artworkUrl) : null;
  const coverBackdrop = artworkSource ? palette.accent : palette.background;

  const player = (
    <section
      ref={panelRef}
      aria-label="迷你播放器"
      className={`fixed z-[70] text-foreground ${pipWindow
        ? "inset-0 h-[calc(100*var(--app-dvh))] w-full overflow-hidden rounded-none border-0 shadow-none"
        : `max-h-[calc(100*var(--app-dvh)-1.5rem)] w-[min(640px,calc(100dvw-1rem))] overflow-hidden rounded-xl border shadow-xl ${position ? "" : "left-1/2 top-[calc(env(safe-area-inset-top)+0.75rem)] -translate-x-1/2"}`}`}
      data-testid="mini-player-overlay"
      role="dialog"
      style={{
        ...panelPositionStyle,
        backgroundColor: palette.surface,
        borderColor: palette.border
      }}
    >
      {!pipWindow ? (
        <div
          data-player-header="true"
          className="flex h-14 cursor-grab touch-none items-center gap-3 border-b border-white/10 px-4 active:cursor-grabbing sm:h-[76px] sm:px-6"
          style={{ borderColor: palette.border }}
          onPointerCancel={stopDragging}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDragging}
        >
          <span style={{ color: palette.accent }}>
            <DragHandleIcon />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-white sm:text-[21px]">迷你播放器</span>
          <button
            aria-label="打开沉浸式播放"
            className="light-overlay-control inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white/75 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:h-10 sm:w-10"
            onClick={onOpenImmersive}
            style={{ color: palette.accent }}
            title="打开沉浸式播放"
            type="button"
          >
            <ExpandIcon />
          </button>
          <button
            aria-label="关闭迷你播放器"
            className="light-overlay-control inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white/75 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:h-10 sm:w-10"
            onClick={onClose}
            style={{ color: palette.accent }}
            title="关闭迷你播放器"
            type="button"
          >
            <CloseIcon />
          </button>
        </div>
      ) : null}

      <div className={pipWindow ? "flex h-full min-h-0 flex-col px-2 pb-2 pt-0 sm:px-2 sm:pb-3 sm:pt-0" : "p-2 sm:p-3"}>
        <div
          className={`group relative overflow-hidden rounded-[16px] border border-white/10 ${pipWindow ? "min-h-0 flex-1" : "aspect-[1.25] shrink-0"}`}
          data-testid="mini-player-cover"
          style={{ backgroundColor: coverBackdrop, transition: "background-color 500ms ease" }}
        >
          {artworkSource ? (
            // External provider artwork is intentionally rendered without Next image optimization.
            // eslint-disable-next-line @next/next/no-img-element
            <img loading="lazy"
              alt=""
              className="absolute left-1/2 top-1/2 h-full w-auto max-w-full -translate-x-1/2 -translate-y-1/2 object-cover"
              src={artworkSource}
            />
          ) : null}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-black/45 opacity-100 transition-opacity duration-200 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
            style={{
              background: `linear-gradient(180deg, rgba(0,0,0,0.18), ${palette.accentSoft} 48%, rgba(0,0,0,0.8) 100%)`
            }}
          />
          <div className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center gap-8 opacity-100 transition-opacity duration-200 sm:pointer-events-none sm:opacity-0 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100 sm:group-focus-within:pointer-events-auto sm:group-focus-within:opacity-100 sm:gap-12">
            <div className="flex items-center justify-center gap-3 text-white sm:gap-6" style={{ color: palette.accent }}>
              <MiniTransportButton ariaLabel="上一首" disabled={!canControlPlayback || !playbackTrackId} onClick={onPrev}>
                <PreviousIcon />
              </MiniTransportButton>
              <MiniTransportButton ariaLabel={isPlaying ? "暂停" : "播放"} disabled={!canControlPlayback || !playbackTrackId} onClick={onTogglePlay} prominent>
                {isPlaying ? <PauseIcon /> : <PlayIcon />}
              </MiniTransportButton>
              <MiniTransportButton ariaLabel="下一首" disabled={!canControlPlayback || !playbackTrackId} onClick={onNext}>
                <NextIcon />
              </MiniTransportButton>
            </div>

            <div className="flex w-full items-center gap-2 px-3 sm:px-6">
              <span className="w-10 shrink-0 text-right text-xs tabular-nums text-white/80">{formatTime(positionMs)}</span>
              <Slider
                aria-label="迷你播放器进度"
                data-testid="mini-player-seek-slider"
                value={positionMs}
                max={durationMs || 1}
                accentColor={palette.accent}
                className="[&_.bg-white\/10]:bg-white/35"
                disabled={!durationMs || !canSeekPlayback}
                onChange={(event) => setSeekDraft(Number(event.target.value))}
                onPointerUp={commitSeek}
                onKeyUp={commitSeek}
              />
              <span className="w-10 shrink-0 text-xs tabular-nums text-white/80">{formatTime(durationMs)}</span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-start justify-between gap-4 px-3 pb-1 pt-2 sm:px-5 sm:pb-2 sm:pt-3">
          <div className="min-w-0">
            <h2 className="truncate text-[1.25rem] font-bold leading-[1.1] text-white sm:text-[1.5rem]">{title}</h2>
            <p className="mt-1 truncate text-xs leading-tight text-white/55 sm:text-sm">{artist}</p>
          </div>
        </div>
      </div>
    </section>
  );

  return pipWindow ? createPortal(player, pipWindow.document.body) : player;
}

function copyStylesToPictureInPictureWindow(pipWindow: Window) {
  const pipDocument = pipWindow.document;
  if (pipDocument.head.querySelector("[data-mini-player-pip-styles]")) {
    return;
  }

  document.querySelectorAll('link[rel="stylesheet"], style').forEach((styleSheet) => {
    pipDocument.head.appendChild(styleSheet.cloneNode(true));
  });

  const baseStyle = pipDocument.createElement("style");
  baseStyle.dataset.miniPlayerPipStyles = "true";
  baseStyle.textContent = `
    :root, body { width: 100%; height: 100%; margin: 0; min-height: 100%; }
    body { overflow: hidden; background: transparent; }
  `;
  pipDocument.head.appendChild(baseStyle);
}

function clampFloatingPosition(position: FloatingPosition, panel: HTMLElement): FloatingPosition {
  const ownerWindow = panel.ownerDocument.defaultView ?? window;
  const maxLeft = Math.max(floatingInset, ownerWindow.innerWidth - panel.offsetWidth - floatingInset);
  const maxTop = Math.max(floatingInset, ownerWindow.innerHeight - panel.offsetHeight - floatingInset);
  return {
    left: Math.min(Math.max(floatingInset, position.left), maxLeft),
    top: Math.min(Math.max(floatingInset, position.top), maxTop)
  };
}

function formatTime(valueMs: number) {
  const totalSeconds = Math.max(0, Math.floor(valueMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function MiniTransportButton({
  ariaLabel,
  children,
  disabled,
  onClick,
  prominent = false
}: {
  ariaLabel: string;
  children: ReactNode;
  disabled: boolean;
  onClick: () => void;
  prominent?: boolean;
}) {
  return (
    <button
      aria-label={ariaLabel}
      className={prominent
        ? "inline-flex h-10 w-10 items-center justify-center rounded-full bg-white text-black shadow-lg transition-transform hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
        : "inline-flex h-10 w-10 items-center justify-center rounded-lg text-white/75 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"}
      disabled={disabled}
      onClick={onClick}
      title={ariaLabel}
      type="button"
    >
      {children}
    </button>
  );
}

function DragHandleIcon() {
  return <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8"><path d="M4 7h7" /><path d="M4 17h7" /><path d="M17 7h3" /><path d="M17 17h3" /><circle cx="15" cy="7" r="1.5" /><circle cx="15" cy="17" r="1.5" /></svg>;
}

function ExpandIcon() {
  return <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8"><path d="M9 4H4v5" /><path d="m4 4 6 6" /><path d="M15 20h5v-5" /><path d="m20 20-6-6" /></svg>;
}

function CloseIcon() {
  return <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8"><path d="m6 6 12 12" /><path d="m18 6-12 12" /></svg>;
}

function PreviousIcon() {
  return <svg aria-hidden="true" fill="currentColor" height="16" viewBox="0 0 24 24" width="16"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" /></svg>;
}

function NextIcon() {
  return <svg aria-hidden="true" fill="currentColor" height="16" viewBox="0 0 24 24" width="16"><path d="m6 18 8.5-6L6 6zm10-12v12h2V6z" /></svg>;
}

function PlayIcon() {
  return <svg aria-hidden="true" fill="currentColor" height="24" viewBox="0 0 24 24" width="24"><path d="M8 5v14l11-7z" /></svg>;
}

function PauseIcon() {
  return <svg aria-hidden="true" fill="currentColor" height="24" viewBox="0 0 24 24" width="24"><path d="M6 19h4V5H6zm8-14v14h4V5z" /></svg>;
}
