"use client";
import { ImmersivePositionProvider, useImmersivePositionMs } from "./ImmersivePositionProvider";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProviderTrackCandidate, QueueItem, RoomMember, TrackMeta } from "@soqaro/shared";
import { formatDuration } from "@/lib/domain/soqaro-ui";
import { VinylTonearm } from "@/components/room/VinylTonearm";
import { RoomLyricsPanel } from "@/components/room/RoomLyricsPanel";
import { fetchProviderLyricsCached, hasWordSyncedRoomLyrics, selectRoomLyrics } from "@/features/playback/lyrics";
import { useMaybeDesktopLyrics } from "@/features/playback/desktop-lyrics-context";
import { useTrackLyricsOffset } from "@/features/playback/lyrics-offset-store";
import { PlayerQueueDrawer } from "./PlayerQueueDrawer";
import { Slider } from "@/components/ui/slider";
import { useBackHandler } from "@/lib/desktop/use-back-handler";
import { getArtworkSourceUrl, useArtworkPalette, type ArtworkPalette } from "./artwork-colors";
import { type PlaybackMode } from "./playback-mode";
import { SquareAlbumCover } from "./PlayerArtwork";
import { VinylAuraVisualizer } from "@/components/room/VinylAuraVisualizer";
import { appSettingsChangeEvent, getAppSettings, updateAppSettings } from "@/features/settings/settings-store";
import { usePlayerStyle } from "@/features/settings/use-player-style";
import { FavoriteTrackButton } from "@/components/ui/FavoriteTrackButton";
import { QualityBadge, PlaybackModeIcon } from "./bottom-player-layout";

type ImmersivePlayerOverlayProps = {
  roomId?: string | null;
  isOpen: boolean;
  isPlaying: boolean;
  playbackBarrierBlocked?: boolean;
  positionMs: number;
  /** seek 拖动中的草稿位置;非空时悬浮层直接展示草稿值,不自驱动推进。 */
  seekDraftMs?: number | null;
  currentTrack: TrackMeta | null;
  artworkUrl: string | null;
  canControlPlayback: boolean;
  canSeekPlayback: boolean;
  playbackTrackId: string | null | undefined;
  durationMs: number;
  volume: number;
  setSeekDraft: (value: number | null) => void;
  commitSeek: () => void;
  applyVolume: (value: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onTogglePlay: () => void;
  playbackMode: PlaybackMode;
  onCyclePlaybackMode: () => void | Promise<void>;
  queue: QueueItem[];
  tracks: TrackMeta[];
  members?: Array<Pick<RoomMember, "id" | "presenceState">> | null;
  currentSessionId?: string | null;
  currentQueueItemId: string | null;
  nextQueueItemId: string | null;
  canReorderQueue: boolean;
  canRemoveQueue: boolean;
  onPlayQueueItem: (queueItemId: string) => Promise<void>;
  onPlayNextQueueItem: (queueItemId: string) => Promise<void>;
  onRemoveQueueItem: (queueItemId: string) => Promise<void>;
  onRemoveQueueItems?: (queueItemIds: string[]) => Promise<void>;
  onReorderQueue: (queueItemIds: string[]) => Promise<void>;
  favoriteTrack: ProviderTrackCandidate | null;
  favoriteTrackIsFavorite: boolean;
  favoriteTrackIsPending: boolean;
  onToggleFavoriteTrack: () => void;
  onClose: () => void;
  onSeekToPosition?: (positionMs: number) => void;
};

/**
 * 沉浸层自驱动进度:BottomPlayer 以低频(normal cadence)传入权威锚点,
 * 这里在打开且播放中时以 50ms 自行推进显示值,
 * 使 BottomPlayer 本体不再因沉浸模式而以 20fps 整树重渲染。
 * seek 拖动 / barrier 阻塞 / 暂停时冻结,直接展示权威值。
 */
export function ImmersivePlayerOverlay({
  roomId,
  isOpen,
  isPlaying,
  playbackBarrierBlocked = false,
  positionMs: anchorPositionMs,
  seekDraftMs = null,
  currentTrack,
  artworkUrl,
  canControlPlayback,
  canSeekPlayback,
  playbackTrackId,
  durationMs,
  volume,
  setSeekDraft,
  commitSeek,
  applyVolume,
  onPrev,
  onNext,
  onTogglePlay,
  playbackMode,
  onCyclePlaybackMode,
  queue,
  tracks,
  members,
  currentSessionId,
  currentQueueItemId,
  nextQueueItemId,
  canReorderQueue,
  canRemoveQueue,
  onPlayQueueItem,
  onPlayNextQueueItem,
  onRemoveQueueItem,
  onRemoveQueueItems,
  onReorderQueue,
  favoriteTrack,
  favoriteTrackIsFavorite,
  favoriteTrackIsPending,
  onToggleFavoriteTrack,
  onClose,
  onSeekToPosition
}: ImmersivePlayerOverlayProps) {
  const [mobileView, setMobileView] = useState<"artwork" | "lyrics">("artwork");
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const touchStartYRef = useRef<number | null>(null);
  const touchStartXRef = useRef<number | null>(null);
  const isScrollingContentRef = useRef(false);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (typeof window !== "undefined" && window.innerWidth >= 768) return;
    touchStartYRef.current = e.touches[0].clientY;
    touchStartXRef.current = e.touches[0].clientX;
    const target = e.target as HTMLElement | null;
    const scrollable = target?.closest(".hide-scrollbar, [data-testid=\"room-lyrics-scroll\"]");
    if (scrollable && scrollable.scrollTop > 0) {
      isScrollingContentRef.current = true;
    } else {
      isScrollingContentRef.current = false;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartYRef.current === null || touchStartXRef.current === null || isScrollingContentRef.current) return;
    const currentY = e.touches[0].clientY;
    const deltaY = currentY - touchStartYRef.current;
    const deltaX = e.touches[0].clientX - touchStartXRef.current;

    // Only allow downward drag
    if (deltaY > 0 && deltaY > Math.abs(deltaX)) {
      setIsDragging(true);
      const dampedY = deltaY > 160 ? 160 + (deltaY - 160) * 0.4 : deltaY;
      setDragY(dampedY);
    } else if (deltaY <= 0 && isDragging) {
      setDragY(0);
      setIsDragging(false);
    }
  };

  const handleTouchEnd = () => {
    if (!isDragging && dragY === 0) {
      touchStartYRef.current = null;
      touchStartXRef.current = null;
      return;
    }
    const currentDrag = dragY;
    setIsDragging(false);
    touchStartYRef.current = null;
    touchStartXRef.current = null;

    if (currentDrag > 70) {
      setDragY(0);
      onClose();
    } else {
      setDragY(0);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  useBackHandler(onClose, isOpen);

  useEffect(() => {
    if (!isOpen) {
      setMobileView("artwork");
      setDragY(0);
      setIsDragging(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const html = document.documentElement;
    const body = document.body;
    const previousHtmlOverflow = html.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      html.style.overflow = previousHtmlOverflow;
      body.style.overflow = previousBodyOverflow;
    };
  }, [isOpen]);

  const sourceProvider = currentTrack?.sourceRef?.provider;
  const sourceTrackId = currentTrack?.sourceRef?.trackId;
  const artworkPalette = useArtworkPalette(artworkUrl);
  const playerStyle = usePlayerStyle();

  return (
    <ImmersivePositionProvider
      positionMs={anchorPositionMs}
      isPlaying={isPlaying}
      durationMs={durationMs}
      frozen={playbackBarrierBlocked || seekDraftMs !== null}
      active={isOpen}
    >
    <div
      aria-hidden={!isOpen}
      aria-label="沉浸式播放"
      aria-modal="true"
      className={`immersive-player-overlay fixed inset-0 z-[80] h-[calc(100*var(--app-dvh))] max-h-[calc(100*var(--app-dvh))] w-full overflow-hidden text-foreground ${
        isDragging
          ? "touch-none"
          : "transition-[opacity,transform,visibility,background-color] duration-350 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
      } ${
        isOpen
          ? "visible translate-y-0 opacity-100 md:scale-100"
          : "pointer-events-none invisible translate-y-full opacity-0 md:translate-y-[3%] md:scale-[0.985]"
      }`}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchMove}
      onTouchStart={handleTouchStart}
      role="dialog"
      style={{
        backgroundColor: artworkPalette.background,
        ...(isDragging ? { transform: `translateY(${dragY}px)`, transition: "none" } : {})
      }}
    >
      {artworkUrl ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-[8%] z-0 overflow-hidden scale-110 opacity-35 blur-3xl transition-[opacity,transform] duration-700 motion-reduce:transition-none"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img loading="lazy"
            alt=""
            className="h-full w-full object-cover"
            referrerPolicy="no-referrer"
            src={getArtworkSourceUrl(artworkUrl)}
          />
        </div>
      ) : null}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 backdrop-blur-3xl transition-[background-color,opacity] duration-500 motion-reduce:transition-none"
        data-immersive-wash="true"
        style={{ background: `linear-gradient(112deg, ${artworkPalette.background} 0%, rgba(0, 0, 0, 0.58) 52%, ${artworkPalette.surface} 100%)` }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 opacity-70 transition-opacity duration-500 motion-reduce:transition-none"
        data-immersive-accent="true"
        style={{ background: `linear-gradient(145deg, ${artworkPalette.accentSoft}, transparent 46%, ${artworkPalette.border})` }}
      />

      <MobileImmersivePlayer
        roomId={roomId}
        artworkPalette={artworkPalette}
        artworkUrl={artworkUrl}
        playbackBarrierBlocked={playbackBarrierBlocked}
        canControlPlayback={canControlPlayback}
        canRemoveQueue={canRemoveQueue}
        canReorderQueue={canReorderQueue}
        canSeekPlayback={canSeekPlayback}
        currentQueueItemId={currentQueueItemId}
        nextQueueItemId={nextQueueItemId}
        members={members}
        currentSessionId={currentSessionId}
        currentTrack={currentTrack}
        durationMs={durationMs}
        isOpen={isOpen}
        isPlaying={isPlaying}
        mobileView={mobileView}
        onClose={onClose}
        onCyclePlaybackMode={onCyclePlaybackMode}
        onNext={onNext}
        onPlayQueueItem={onPlayQueueItem}
        onPlayNextQueueItem={onPlayNextQueueItem}
        onPrev={onPrev}
        onRemoveQueueItem={onRemoveQueueItem}
        onRemoveQueueItems={onRemoveQueueItems}
        onReorderQueue={onReorderQueue}
        onSetMobileView={setMobileView}
        onSeekToPosition={onSeekToPosition}
        onTogglePlay={onTogglePlay}
        favoriteTrack={favoriteTrack}
        favoriteTrackIsFavorite={favoriteTrackIsFavorite}
        favoriteTrackIsPending={favoriteTrackIsPending}
        onToggleFavoriteTrack={onToggleFavoriteTrack}
        playbackMode={playbackMode}
        playbackTrackId={playbackTrackId}
        playerStyle={playerStyle}
        queue={queue}
        setSeekDraft={setSeekDraft}
        sourceProvider={sourceProvider}
        sourceTrackId={sourceTrackId}
        tracks={tracks}
        volume={volume}
        applyVolume={applyVolume}
        commitSeek={commitSeek}
      />

      <button
        type="button"
        aria-label="退出沉浸式播放"
        title="退出沉浸式播放"
        onClick={onClose}
        className="light-overlay-control absolute left-[calc(env(safe-area-inset-left)+1rem)] top-[calc(env(safe-area-inset-top)+1rem)] z-[60] hidden h-10 w-10 items-center justify-center rounded-full border-0 bg-transparent text-white/70 shadow-none backdrop-blur-md transition-[background-color,color,transform] duration-200 hover:bg-white/10 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 md:inline-flex"
        style={{ color: artworkPalette.accent }}
      >
        <svg aria-hidden="true" fill="none" height="20" viewBox="0 0 24 24" width="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>

      <main className="relative z-10 mx-auto hidden h-[calc(100*var(--app-dvh))] min-h-0 w-full max-w-[1560px] grid-cols-[minmax(0,44%)_minmax(0,56%)] lg:grid-cols-[minmax(0,42%)_minmax(0,58%)] items-center gap-10 overflow-hidden px-8 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-16 md:grid lg:gap-14 lg:px-12 xl:gap-20 xl:px-16">
        <div className="relative flex min-h-0 w-full min-w-0 items-center justify-center">
          <DesktopImmersivePlayer
            roomId={roomId}
            artworkPalette={artworkPalette}
            artworkUrl={artworkUrl}
            playbackBarrierBlocked={playbackBarrierBlocked}
            canControlPlayback={canControlPlayback}
            canSeekPlayback={canSeekPlayback}
            currentTrack={currentTrack}
            durationMs={durationMs}
            isPlaying={isPlaying}
            onCyclePlaybackMode={onCyclePlaybackMode}
            onNext={onNext}
            onPrev={onPrev}
            onTogglePlay={onTogglePlay}
            favoriteTrack={favoriteTrack}
            favoriteTrackIsFavorite={favoriteTrackIsFavorite}
            favoriteTrackIsPending={favoriteTrackIsPending}
            onToggleFavoriteTrack={onToggleFavoriteTrack}
            playbackMode={playbackMode}
            playbackTrackId={playbackTrackId}
            playerStyle={playerStyle}
            queue={queue}
            tracks={tracks}
            members={members}
            currentSessionId={currentSessionId}
            currentQueueItemId={currentQueueItemId}
            nextQueueItemId={nextQueueItemId}
            canReorderQueue={canReorderQueue}
            canRemoveQueue={canRemoveQueue}
            onPlayQueueItem={onPlayQueueItem}
            onPlayNextQueueItem={onPlayNextQueueItem}
            onRemoveQueueItem={onRemoveQueueItem}
            onRemoveQueueItems={onRemoveQueueItems}
            onReorderQueue={onReorderQueue}
            setSeekDraft={setSeekDraft}
            volume={volume}
            applyVolume={applyVolume}
            commitSeek={commitSeek}
          />
        </div>
        <section className="flex h-[min(78vh,52rem)] min-h-0 w-full max-w-[42rem] min-w-0 flex-col justify-center justify-self-start overflow-hidden" aria-label="歌曲信息与歌词">
          <ImmersiveLyrics desktop frozen={playbackBarrierBlocked} isOpen={isOpen} isPlaying={isPlaying} onSeekToPosition={onSeekToPosition} roomLyrics={currentTrack?.lyrics ?? null} translatedLyrics={currentTrack?.translatedLyrics ?? null} romanizedLyrics={currentTrack?.romanizedLyrics ?? null} sourceProvider={sourceProvider} sourceTrackId={sourceTrackId} />
        </section>
      </main>
    </div>
    </ImmersivePositionProvider>
  );
}

type MobileImmersivePlayerProps = Omit<ImmersivePlayerOverlayProps, "positionMs"> & {
  artworkPalette: ArtworkPalette;
  artworkUrl: string | null;
  mobileView: "artwork" | "lyrics";
  onSetMobileView: (view: "artwork" | "lyrics") => void;
  onSeekToPosition?: (positionMs: number) => void;
  playerStyle: "vinyl" | "square-cover";
  sourceProvider: string | undefined;
  sourceTrackId: string | undefined;
};

function MobileImmersivePlayer({
  roomId,
  artworkPalette,
  artworkUrl,
  canControlPlayback,
  canRemoveQueue,
  canReorderQueue,
  canSeekPlayback,
  commitSeek,
  currentQueueItemId,
  nextQueueItemId,
  members,
  currentSessionId,
  currentTrack,
  durationMs,
  favoriteTrack,
  favoriteTrackIsFavorite,
  favoriteTrackIsPending,
  isOpen,
  isPlaying,
  playbackBarrierBlocked = false,
  mobileView,
  onClose,
  onCyclePlaybackMode,
  onNext,
  onPlayQueueItem,
  onPlayNextQueueItem,
  onPrev,
  onRemoveQueueItem,
  onRemoveQueueItems,
  onReorderQueue,
  onSetMobileView,
  onSeekToPosition,
  onToggleFavoriteTrack,
  onTogglePlay,
  playbackMode,
  playbackTrackId,
  playerStyle,
  queue,
  setSeekDraft,
  sourceProvider,
  sourceTrackId,
  tracks,
  volume,
  applyVolume
}: MobileImmersivePlayerProps) {
  const positionMs = useImmersivePositionMs();
  const controlsDisabled = !canControlPlayback || !playbackTrackId;

  return (
    <section className="relative z-10 flex h-full min-h-0 flex-col px-8 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))] md:hidden">
      <header className="flex h-12 shrink-0 items-center justify-center cursor-grab active:cursor-grabbing">
        <button aria-label="退出沉浸式播放" className="inline-flex h-10 w-28 items-center justify-center rounded-full transition-[background-color,transform] duration-200 hover:bg-white/10 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80" onClick={onClose} title="退出沉浸式播放" type="button">
          <span className="h-1.5 w-12 rounded-full opacity-60 hover:opacity-100 transition-opacity" aria-hidden="true" style={{ backgroundColor: artworkPalette.accent }} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className={mobileView === "lyrics" ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "min-h-0 flex-none overflow-visible"}>
          {mobileView === "artwork" ? (
            <div className="mobile-player-panel flex flex-col items-center justify-start" key="artwork">
              <button aria-label="显示歌词" className="mt-[clamp(1.25rem,6vh,4rem)] rounded-[1.35rem] outline-none transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] active:scale-[0.985] focus-visible:ring-2 focus-visible:ring-white" onClick={() => onSetMobileView("lyrics")} title="显示歌词" type="button">
                <ImmersiveVinyl artworkUrl={artworkUrl} frozen={playbackBarrierBlocked} isPlaying={isPlaying} mobile palette={artworkPalette} playerStyle={playerStyle} />
              </button>
              <div className="mt-[clamp(1.5rem,4vh,3rem)] flex w-full items-start gap-3">
                <div className="min-w-0 flex-1"><TrackDetails currentTrack={currentTrack} mobile /></div>
                <div className="flex shrink-0 items-center">
                  <FavoriteTrackButton
                    accentColor={artworkPalette.accent}
                    isFavorite={favoriteTrackIsFavorite}
                    onToggle={onToggleFavoriteTrack}
                    pending={favoriteTrackIsPending}
                    size="large"
                    track={favoriteTrack}
                    className="text-white/70 hover:bg-white/10 hover:text-white focus-visible:ring-white"
                  />
                </div>
              </div>
            </div>
          ) : (
            <div
              className="mobile-player-panel flex min-h-0 flex-1 flex-col"
              key="lyrics"
              onClick={(event) => {
                // Music-app convention: tapping anywhere outside the
                // interactive lyric content collapses the lyrics back to the
                // cover. Lyric lines (two-tap seek targets), the translation
                // toggles, and the artwork row above keep their own actions,
                // so interactive elements are filtered before dismissing.
                const target = event.target as HTMLElement | null;
                if (target?.closest('button, [data-testid="room-lyrics-line"]')) return;
                onSetMobileView("artwork");
              }}
            >
              <button aria-label="显示专辑封面" className="mb-3 flex min-w-0 items-center gap-3 rounded-lg py-2 text-left outline-none transition-[background-color,transform] duration-200 active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-white" onClick={() => onSetMobileView("artwork")} title="显示专辑封面" type="button">
                <SquareAlbumCover artworkUrl={artworkUrl} className="h-11 w-11 shrink-0 rounded-md" />
                <span className="min-w-0"><span className="block truncate text-sm font-semibold text-white">{currentTrack?.title ?? "等待选择歌曲"}</span><span className="mt-0.5 block truncate text-xs text-white/55">{currentTrack?.artist ?? "从歌单中选择一首歌曲"}</span></span>
              </button>
              <div className="flex min-h-0 flex-1 items-stretch overflow-hidden">
                <ImmersiveLyrics frozen={playbackBarrierBlocked} isOpen={isOpen} isPlaying={isPlaying} mobile onSeekToPosition={onSeekToPosition} roomLyrics={currentTrack?.lyrics ?? null} translatedLyrics={currentTrack?.translatedLyrics ?? null} romanizedLyrics={currentTrack?.romanizedLyrics ?? null} sourceProvider={sourceProvider} sourceTrackId={sourceTrackId} />
              </div>
            </div>
          )}
        </div>

        <div className="shrink-0 pt-[clamp(1.25rem,3vh,2rem)]">
          <Slider
            accentColor={artworkPalette.accent}
            className="[&>div]:h-1.5"
            disabled={!durationMs || !canSeekPlayback}
            max={durationMs || 1}
            onChange={(event) => setSeekDraft(Number(event.target.value))}
            onKeyUp={commitSeek}
            onPointerUp={commitSeek}
            value={positionMs}
          />
          <div className="mt-2 grid grid-cols-3 items-center text-xs tabular-nums text-white/58">
            <span>{formatDuration(positionMs)}</span>
            <QualityBadge variant="capsule" popoverPlacement="center" />
            <span className="justify-self-end">-{formatDuration(Math.max(0, durationMs - positionMs))}</span>
          </div>
        </div>
      </div>

      <footer className="shrink-0 pt-[clamp(1.25rem,3vh,2rem)]">
        <div className="flex items-center justify-center gap-4">
          <TransportButton accentColor={artworkPalette.accent} ariaLabel="上一首" disabled={controlsDisabled} onClick={onPrev}>
            <svg aria-hidden="true" fill="currentColor" height="20" viewBox="0 0 24 24" width="20"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
          </TransportButton>
          <button
            aria-label={isPlaying ? "暂停" : "播放"}
            className="inline-flex h-12 w-12 items-center justify-center rounded-full text-white shadow-md transition-transform duration-150 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-40"
            disabled={controlsDisabled}
            onClick={onTogglePlay}
            style={{ backgroundColor: artworkPalette.accent }}
            title={isPlaying ? "暂停" : "播放"}
            type="button"
          >
            {isPlaying ? (
              <svg aria-hidden="true" fill="currentColor" height="18" viewBox="0 0 24 24" width="18"><path d="M6 19h4V5H6zm8-14v14h4V5z" /></svg>
            ) : (
              <svg aria-hidden="true" fill="currentColor" height="18" viewBox="0 0 24 24" width="18" className="translate-x-[0.5px]"><path d="M8 5v14l11-7z" /></svg>
            )}
          </button>
          <TransportButton accentColor={artworkPalette.accent} ariaLabel="下一首" disabled={controlsDisabled} onClick={onNext}>
            <svg aria-hidden="true" fill="currentColor" height="20" viewBox="0 0 24 24" width="20"><path d="M6 18l8.5-6L6 6zm10-12v12h2V6z" /></svg>
          </TransportButton>
        </div>

        <div className="mt-5 flex items-center gap-3 px-2 text-white/62" style={{ color: artworkPalette.accent }}>
          <SpeakerGlyph volume={volume} />
          <Slider accentColor={artworkPalette.accent} className="[&>div]:h-1" max={1} onChange={(event) => applyVolume(Number(event.target.value))} step={0.01} value={volume} />
        </div>

        <div className="mt-5 grid grid-cols-3 items-center justify-items-center" style={{ color: artworkPalette.accent }}>
          <button aria-label="歌词" className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-foreground-muted transition-colors hover:bg-white/10 active:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80" data-testid="immersive-player-lyrics-button" onClick={() => onSetMobileView("lyrics")} title="歌词" type="button"><LyricsGlyph /></button>
          <button aria-label="播放顺序" className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-foreground-muted transition-colors hover:bg-white/10 active:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 disabled:opacity-35" data-testid="immersive-player-playback-mode-button" disabled={!canControlPlayback} onClick={() => void onCyclePlaybackMode()} style={{ color: artworkPalette.accent }} title="播放顺序" type="button"><PlaybackModeIcon mode={playbackMode} /></button>
          <PlayerQueueDrawer
            roomId={roomId}
            accentColor={artworkPalette.accent}
            accentSoft={artworkPalette.accentSoft}
            canControlPlayback={canControlPlayback}
            canRemoveQueue={canRemoveQueue}
            canReorderQueue={canReorderQueue}
            compactMobile
            currentQueueItemId={currentQueueItemId}
            nextQueueItemId={nextQueueItemId}
            onPlayQueueItem={onPlayQueueItem}
            onPlayNextQueueItem={onPlayNextQueueItem}
            onRemoveQueueItem={onRemoveQueueItem}
            onRemoveQueueItems={onRemoveQueueItems}
            onReorderQueue={onReorderQueue}
            placement="bottom-sheet"
            queue={queue}
            tracks={tracks}
            members={members}
            currentSessionId={currentSessionId}
            testId="immersive-player-queue-button"
          />
        </div>
      </footer>
    </section>
  );
}

type DesktopImmersivePlayerProps = {
  roomId?: string | null;
  artworkPalette: ArtworkPalette;
  artworkUrl: string | null;
  playbackBarrierBlocked: boolean;
  canControlPlayback: boolean;
  canSeekPlayback: boolean;
  currentTrack: TrackMeta | null;
  durationMs: number;
  isPlaying: boolean;
  onCyclePlaybackMode: () => void | Promise<void>;
  onNext: () => void;
  onPrev: () => void;
  onTogglePlay: () => void;
  favoriteTrack: ProviderTrackCandidate | null;
  favoriteTrackIsFavorite: boolean;
  favoriteTrackIsPending: boolean;
  onToggleFavoriteTrack: () => void;
  playbackMode: PlaybackMode;
  playbackTrackId: string | null | undefined;
  playerStyle: "vinyl" | "square-cover";
  queue: QueueItem[];
  tracks: TrackMeta[];
  members?: Array<Pick<RoomMember, "id" | "presenceState">> | null;
  currentSessionId?: string | null;
  currentQueueItemId: string | null;
  nextQueueItemId: string | null;
  canReorderQueue: boolean;
  canRemoveQueue: boolean;
  onPlayQueueItem: (queueItemId: string) => Promise<void>;
  onPlayNextQueueItem: (queueItemId: string) => Promise<void>;
  onRemoveQueueItem: (queueItemId: string) => Promise<void>;
  onRemoveQueueItems?: (queueItemIds: string[]) => Promise<void>;
  onReorderQueue: (queueItemIds: string[]) => Promise<void>;
  setSeekDraft: (value: number | null) => void;
  volume: number;
  applyVolume: (value: number) => void;
  commitSeek: () => void;
};

function DesktopImmersivePlayer({
  roomId,
  artworkPalette,
  artworkUrl,
  playbackBarrierBlocked,
  canControlPlayback,
  canSeekPlayback,
  currentTrack,
  durationMs,
  isPlaying,
  onCyclePlaybackMode,
  onNext,
  onPrev,
  onTogglePlay,
  favoriteTrack,
  favoriteTrackIsFavorite,
  favoriteTrackIsPending,
  onToggleFavoriteTrack,
  playbackMode,
  playbackTrackId,
  playerStyle,
  queue,
  tracks,
  members,
  currentSessionId,
  currentQueueItemId,
  nextQueueItemId,
  canReorderQueue,
  canRemoveQueue,
  onPlayQueueItem,
  onPlayNextQueueItem,
  onRemoveQueueItem,
  onRemoveQueueItems,
  onReorderQueue,
  setSeekDraft,
  volume,
  applyVolume,
  commitSeek
}: DesktopImmersivePlayerProps) {
  const positionMs = useImmersivePositionMs();
  const controlsDisabled = !canControlPlayback || !playbackTrackId;

  return (
    <section className="flex min-h-0 w-[min(58vh,34rem)] max-w-full flex-col justify-center justify-self-center">
      <ImmersiveVinyl artworkUrl={artworkUrl} desktop frozen={playbackBarrierBlocked} isPlaying={isPlaying} palette={artworkPalette} playerStyle={playerStyle} />

      <div className="mt-5 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl sm:text-2xl font-semibold tracking-tight text-white leading-snug">
            {currentTrack?.title ?? "等待选择歌曲"}
          </h1>
          <div className="mt-1 flex items-center gap-2 truncate text-xs sm:text-sm text-white/70">
            <span className="truncate">{currentTrack?.artist ?? "从歌单中选择一首歌曲"}</span>
            {currentTrack?.album ? (
              <span className="truncate text-white/50">{currentTrack.album}</span>
            ) : null}
          </div>
        </div>
        <FavoriteTrackButton
          accentColor={artworkPalette.accent}
          isFavorite={favoriteTrackIsFavorite}
          onToggle={onToggleFavoriteTrack}
          pending={favoriteTrackIsPending}
          size="large"
          track={favoriteTrack}
          className="text-white/70 hover:bg-white/10 hover:text-white focus-visible:ring-white shrink-0"
        />
      </div>

      <div className="mt-5 flex items-center gap-3">
        <span className="w-9 shrink-0 text-xs tabular-nums text-white/45">{formatDuration(positionMs)}</span>
        <Slider
          accentColor={artworkPalette.accent}
          className="[&>div]:h-1"
          data-testid="immersive-player-seek-slider"
          disabled={!durationMs || !canSeekPlayback}
          max={durationMs || 1}
          onChange={(event) => setSeekDraft(Number(event.target.value))}
          onKeyUp={commitSeek}
          onPointerUp={commitSeek}
          value={positionMs}
        />
        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-white/45">{formatDuration(durationMs)}</span>
      </div>

      <div className="mt-4 flex items-center justify-center gap-2.5 sm:gap-3.5">
        <button
          aria-label="切换播放模式"
          className="inline-flex h-8.5 w-8.5 items-center justify-center rounded-lg text-foreground-muted transition-colors hover:bg-white/10 active:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-35 cursor-pointer"
          disabled={!canControlPlayback}
          onClick={() => void onCyclePlaybackMode()}
          style={{ color: artworkPalette.accent }}
          title="切换播放模式"
          type="button"
        >
          <PlaybackModeIcon mode={playbackMode} />
        </button>
        <TransportButton accentColor={artworkPalette.accent} ariaLabel="上一首" disabled={controlsDisabled} onClick={onPrev}>
          <svg aria-hidden="true" fill="currentColor" height="20" viewBox="0 0 24 24" width="20"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" /></svg>
        </TransportButton>
        <button
          aria-label={isPlaying ? "暂停" : "播放"}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full text-white shadow-md transition-transform duration-150 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
          disabled={controlsDisabled}
          onClick={onTogglePlay}
          style={{ backgroundColor: artworkPalette.accent }}
          title={isPlaying ? "暂停" : "播放"}
          type="button"
        >
          {isPlaying ? (
            <svg aria-hidden="true" fill="currentColor" height="18" viewBox="0 0 24 24" width="18"><path d="M6 19h4V5H6zm8-14v14h4V5z" /></svg>
          ) : (
            <svg aria-hidden="true" fill="currentColor" height="18" viewBox="0 0 24 24" width="18" className="translate-x-[0.5px]"><path d="M8 5v14l11-7z" /></svg>
          )}
        </button>
        <TransportButton accentColor={artworkPalette.accent} ariaLabel="下一首" disabled={controlsDisabled} onClick={onNext}>
          <svg aria-hidden="true" fill="currentColor" height="20" viewBox="0 0 24 24" width="20"><path d="M6 18l8.5-6L6 6zm10-12v12h2V6z" /></svg>
        </TransportButton>
        <PlayerQueueDrawer
          roomId={roomId}
          accentColor={artworkPalette.accent}
          accentSoft={artworkPalette.accentSoft}
          canControlPlayback={canControlPlayback}
          canRemoveQueue={canRemoveQueue}
          canReorderQueue={canReorderQueue}
          currentQueueItemId={currentQueueItemId}
          nextQueueItemId={nextQueueItemId}
          onPlayQueueItem={onPlayQueueItem}
          onPlayNextQueueItem={onPlayNextQueueItem}
          onRemoveQueueItem={onRemoveQueueItem}
          onRemoveQueueItems={onRemoveQueueItems}
          onReorderQueue={onReorderQueue}
          placement="immersive-desktop"
          queue={queue}
          tracks={tracks}
          members={members}
          currentSessionId={currentSessionId}
          testId="immersive-player-queue-button"
        />
      </div>

      <div className="mt-4 flex items-center gap-3 px-1 text-white/55" style={{ color: artworkPalette.accent }}>
        <SpeakerGlyph volume={volume} />
        <Slider
          accentColor={artworkPalette.accent}
          className="[&>div]:h-1"
          max={1}
          onChange={(event) => applyVolume(Number(event.target.value))}
          step={0.01}
          value={volume}
        />
      </div>
    </section>
  );
}

function TrackDetails({ currentTrack, mobile = false }: { currentTrack: TrackMeta | null; mobile?: boolean }) {
  return (
    <div className={`min-w-0 ${mobile ? "text-left" : "text-center md:text-left"}`}>
      <h1 className={`${mobile ? "text-[1.8rem] leading-[1.08]" : "text-3xl leading-[1.08] lg:text-4xl"} ${mobile ? "mx-0" : "mx-auto md:mx-0"} max-w-[24ch] break-words font-semibold text-foreground`}>
        {currentTrack?.title ?? "等待选择歌曲"}
      </h1>
      <p className={`${mobile ? "mt-1 text-lg leading-6" : "mt-3 text-lg"} truncate text-foreground-muted`}>{currentTrack?.artist ?? "从歌单中选择一首歌曲"}</p>
      {!mobile ? <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm text-foreground-muted/70"><span>专辑：{currentTrack?.album ?? "未知专辑"}</span>{currentTrack?.sourceType ? <span>来源：{getSourceLabel(currentTrack.sourceType)}</span> : null}</div> : null}
    </div>
  );
}

function TransportButton({
  accentColor,
  ariaLabel,
  children,
  disabled,
  onClick
}: {
  accentColor: string;
  ariaLabel: string;
  children: ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={ariaLabel}
      className="inline-flex h-8.5 w-8.5 items-center justify-center rounded-lg text-foreground-muted transition-colors hover:bg-white/10 hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-35 cursor-pointer"
      disabled={disabled}
      onClick={onClick}
      style={{ color: accentColor }}
      title={ariaLabel}
      type="button"
    >
      {children}
    </button>
  );
}

function LyricsGlyph() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      <path d="M5 6h14" />
      <path d="M5 10h10" />
      <path d="M5 14h14" />
      <path d="M5 18h8" />
    </svg>
  );
}

function SpeakerGlyph({ volume }: { volume: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      {volume <= 0.01 ? (
        <path d="m19 9-5 6m0-6 5 6" />
      ) : (
        <>
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 5.5a9 9 0 0 1 0 13" />
        </>
      )}
    </svg>
  );
}

function ImmersiveVinyl({
  artworkUrl,
  desktop = false,
  frozen = false,
  isPlaying,
  mobile = false,
  palette,
  playerStyle
}: {
  artworkUrl: string | null;
  desktop?: boolean;
  frozen?: boolean;
  isPlaying: boolean;
  mobile?: boolean;
  palette: ArtworkPalette;
  playerStyle: "vinyl" | "square-cover";
}) {
  const containerSizeClass = mobile
    ? "w-[min(68vw,calc(31*var(--app-dvh)),34rem)]"
    : desktop
      ? "h-[min(58vh,34rem)] w-auto"
      : "h-[min(calc(68*var(--app-dvh)),34rem)] w-auto";
  const discRingGradient = `conic-gradient(from 0deg at 50% 50%, ${palette.accentSoft} 0deg, transparent 90deg, ${palette.accentSoft} 180deg, transparent 270deg, ${palette.accentSoft} 360deg)`;

  return (
    <div className={`relative flex aspect-square max-w-full items-center justify-center ${containerSizeClass}`}>
      <div className={`relative flex aspect-square items-center justify-center overflow-visible ${desktop || playerStyle === "square-cover" ? "w-full" : "w-[86%]"}`}>
        {playerStyle === "square-cover" ? (
          <SquareAlbumCover
            artworkUrl={artworkUrl}
            className={`${desktop ? "rounded-[0.75rem]" : "rounded-[1.25rem]"} h-full w-full shadow-[0_26px_90px_rgba(0,0,0,0.35)]`}
          />
        ) : (
          <>
            <VinylAuraVisualizer accentColor={palette.accent} frozen={frozen} isPlaying={isPlaying} />
            <div
              className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-full border border-white/5 bg-gradient-to-tr from-[#020202] via-[#111111] to-[#1a1a1a] shadow-[0_26px_90px_rgba(0,0,0,0.55)] animate-spin-slow"
              style={{ animationPlayState: isPlaying ? "running" : "paused" }}
            >
              <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_70%_30%,rgba(255,255,255,0.1),transparent_40%)]" />
              <div className="absolute inset-0 rounded-full" style={{ background: discRingGradient }} />
              {artworkUrl ? (
                <div className="absolute z-10 aspect-square w-[48%] overflow-hidden rounded-full border border-white/10 shadow-[0_0_24px_rgba(0,0,0,0.35)]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    loading="lazy"
                    alt=""
                    className="h-full w-full object-cover"
                    referrerPolicy="no-referrer"
                    src={getArtworkSourceUrl(artworkUrl)}
                  />
                </div>
              ) : null}
            </div>
          </>
        )}
        {playerStyle === "vinyl" ? (
          <VinylTonearm frozen={frozen} isPlaying={isPlaying} accentColor={palette.accent} />
        ) : null}
      </div>
    </div>
  );
}

function ImmersiveLyrics({
  desktop = false,
  frozen = false,
  isOpen,
  isPlaying,
  mobile = false,
  onSeekToPosition,
  roomLyrics,
  translatedLyrics: storedTranslatedLyrics,
  romanizedLyrics: storedRomanizedLyrics,
  sourceProvider,
  sourceTrackId
}: {
  desktop?: boolean;
  frozen?: boolean;
  isOpen: boolean;
  isPlaying: boolean;
  mobile?: boolean;
  onSeekToPosition?: (positionMs: number) => void;
  roomLyrics: string | null;
  translatedLyrics?: string | null;
  romanizedLyrics?: string | null;
  sourceProvider: string | undefined;
  sourceTrackId: string | undefined;
}) {
  const positionMs = useImmersivePositionMs();
  const desktopLyricsContext = useMaybeDesktopLyrics();
  const trackKey = sourceProvider && sourceTrackId ? `${sourceProvider}:${sourceTrackId}` : sourceTrackId;
  const { offsetMs, setOffset } = useTrackLyricsOffset(trackKey);
  const [plainLyric, setPlainLyric] = useState<string | null>(null);
  const [translatedLyric, setTranslatedLyric] = useState<string | null>(null);
  const [romanizedLyric, setRomanizedLyric] = useState<string | null>(null);
  const [lyricsStatus, setLyricsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [lyricPreferences, setLyricPreferences] = useState(() => getAppSettings().playback);

  useEffect(() => {
    const syncPreferences = () => setLyricPreferences(getAppSettings().playback);
    syncPreferences();
    window.addEventListener(appSettingsChangeEvent, syncPreferences);
    window.addEventListener("storage", syncPreferences);
    return () => {
      window.removeEventListener(appSettingsChangeEvent, syncPreferences);
      window.removeEventListener("storage", syncPreferences);
    };
  }, []);

  useEffect(() => {
    if (desktopLyricsContext) {
      setPlainLyric(desktopLyricsContext.lyrics.plainLyric);
      setTranslatedLyric(desktopLyricsContext.lyrics.translatedLyric);
      setRomanizedLyric(desktopLyricsContext.lyrics.romanizedLyric);
      setLyricsStatus(desktopLyricsContext.lyrics.status);
      return;
    }

    if (!isOpen) {
      setPlainLyric(null);
      setTranslatedLyric(storedTranslatedLyrics?.trim() || null);
      setRomanizedLyric(storedRomanizedLyrics?.trim() || null);
      setLyricsStatus("idle");
      return;
    }
    const localLyrics = roomLyrics?.trim() || null;
    const localTranslated = storedTranslatedLyrics?.trim() || null;
    const localRomanized = storedRomanizedLyrics?.trim() || null;

    if (localLyrics) {
      setPlainLyric(localLyrics);
    }
    setTranslatedLyric(localTranslated);
    setRomanizedLyric(localRomanized);

    const hasWordSynced = hasWordSyncedRoomLyrics(localLyrics);
    if (
      (sourceProvider !== "netease" && sourceProvider !== "qqmusic" && sourceProvider !== "bilibili") ||
      !sourceTrackId ||
      (hasWordSynced && localTranslated && localRomanized)
    ) {
      setLyricsStatus(localLyrics ? "ready" : "idle");
      return;
    }

    let cancelled = false;
    setLyricsStatus(localLyrics ? "ready" : "loading");
    const request = fetchProviderLyricsCached(sourceProvider, sourceTrackId);
    void request.then((lyrics) => {
      if (!cancelled) {
        setPlainLyric(selectRoomLyrics({
          localLyrics,
          wordSyncedLyric: lyrics.wordSyncedLyric,
          plainLyric: lyrics.plainLyric
        }));
        setTranslatedLyric(lyrics.translatedLyric?.trim() || localTranslated || null);
        setRomanizedLyric(lyrics.romanizedLyric?.trim() || localRomanized || null);
        setLyricsStatus("ready");
      }
    }).catch(() => {
      if (!cancelled) {
        if (localLyrics) {
          setPlainLyric(localLyrics);
        }
        setLyricsStatus(localLyrics ? "ready" : "error");
      }
    });
    return () => { cancelled = true; };
  }, [desktopLyricsContext, desktopLyricsContext?.lyrics, isOpen, roomLyrics, sourceProvider, sourceTrackId, storedRomanizedLyrics, storedTranslatedLyrics]);

  if (!isOpen) return null;
  return (
    <div className={desktop || mobile ? "min-h-0 w-full flex-1" : "mt-4 min-h-0 border-t border-surface-border pt-4"}>
      <RoomLyricsPanel
        align={desktop ? "left" : "center"}
        frozen={frozen}
        immersive={desktop}
        mobile={mobile}
        visibleLines={desktop || mobile ? 7 : 3}
        fontScale="medium"
        isPlaying={isPlaying}
        lyrics={plainLyric}
        translatedLyrics={translatedLyric}
        romanizedLyrics={romanizedLyric}
        showControls
        showTranslation={lyricPreferences.showLyricTranslation}
        showRomanized={lyricPreferences.showLyricRomanized}
        offsetMs={offsetMs}
        onOffsetChange={setOffset}
        onToggleTranslation={() =>
          updateAppSettings({ playback: { showLyricTranslation: !lyricPreferences.showLyricTranslation } })
        }
        onToggleRomanized={() =>
          updateAppSettings({ playback: { showLyricRomanized: !lyricPreferences.showLyricRomanized } })
        }
        onSeek={onSeekToPosition}
        positionMs={positionMs}
        status={lyricsStatus}
      />
    </div>
  );
}

function getSourceLabel(sourceType: TrackMeta["sourceType"]) {
  if (sourceType === "netease") return "网易云音乐";
  if (sourceType === "qqmusic") return "QQ音乐";
  return "本地音频";
}
