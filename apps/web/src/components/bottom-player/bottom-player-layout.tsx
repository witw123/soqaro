"use client";

import { useRef, useState, type CSSProperties } from "react";
import { formatDuration } from "@/lib/domain/soqaro-ui";
import type { ProviderTrackCandidate, QueueItem, RoomMember, TrackMeta } from "@soqaro/shared";
import { PlayerQueueDrawer } from "./PlayerQueueDrawer";
import { FavoriteTrackButton } from "@/components/ui/FavoriteTrackButton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getNextPlaybackMode, type PlaybackMode } from "./playback-mode";
import { SquareAlbumCover } from "./PlayerArtwork";
import { getArtworkSourceUrl, withAlpha } from "./artwork-colors";
import { ThemeAwarePlaybackModeGlyph, ThemeAwareVolumeGlyph } from "@/components/icons/ThemeIcons";
import {
  updateAppSettings,
  useAppSettings,
  type PlayerStyle,
  type AudioQualityPreference
} from "@/features/settings/settings-store";

type LayoutProps = {
  roomId?: string | null;
  isPlaying: boolean;
  canControlPlayback: boolean;
  canSeekPlayback: boolean;
  playbackTrackId: string | null | undefined;
  title: string;
  artist: string;
  album: string;
  boundedProgressMs: number;
  currentTrackDuration: number;
  volume: number;
  setSeekDraft: (value: number | null) => void;
  commitSeek: () => void;
  applyVolume: (value: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onTogglePlay: () => void;
  playbackMode: PlaybackMode;
  onCyclePlaybackMode: () => void;
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
  isImmersiveOpen: boolean;
  onToggleImmersive: () => void;
  isMiniOpen: boolean;
  onToggleMini: () => void;
  isLyricsOpen?: boolean;
  onToggleLyrics?: () => void;
  artworkAccent: string;
  artworkAccentSoft: string;
  artworkUrl: string | null;
  playerStyle: PlayerStyle;
  mobileVariant?: "compact" | "full";
  favoriteTrack?: ProviderTrackCandidate | null;
  favoriteTrackIsFavorite?: boolean;
  favoriteTrackIsPending?: boolean;
  onToggleFavoriteTrack?: () => void;
};

export function VinylBadge({
  isPlaying,
  compact = false,
  accentColor = "rgb(161 161 170)",
  accentSoft = "rgba(161, 161, 170, 0.16)",
  artworkUrl = null,
  playerStyle = "vinyl"
}: {
  isPlaying: boolean;
  compact?: boolean;
  accentColor?: string;
  accentSoft?: string;
  artworkUrl?: string | null;
  playerStyle?: PlayerStyle;
}) {
  const shellSize = compact ? "h-10 w-10" : "h-12 w-12";
  const centerSize = compact ? "h-3.5 w-3.5" : "h-4 w-4";

  if (playerStyle === "square-cover") {
    return <SquareAlbumCover artworkUrl={artworkUrl} className={`${shellSize} shrink-0 rounded-md shadow-sm border border-white/10`} />;
  }

  return (
    <div className={`relative flex ${shellSize} shrink-0 items-center justify-center`}>
      <div
        className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-full border border-white/5 bg-gradient-to-tr from-[#020202] via-[#111111] to-[#1a1a1a] shadow-2xl transition-transform duration-700 will-change-transform animate-spin-slow"
        style={{ animationPlayState: isPlaying ? "running" : "paused" }}
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_30%,rgba(255,255,255,0.1),transparent_40%)]" />
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: `conic-gradient(from 0deg at 50% 50%, ${withAlpha(accentColor, 0.1)} 0deg, transparent 90deg, ${withAlpha(accentColor, 0.1)} 180deg, transparent 270deg, ${withAlpha(accentColor, 0.1)} 360deg)`
          }}
        />
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="absolute rounded-full border border-white/[0.03]"
            style={{ width: `${100 - index * 18}%`, height: `${100 - index * 18}%` }}
          />
        ))}
        {artworkUrl ? (
          <div
            aria-hidden="true"
            className="absolute z-10 aspect-square w-[55%] overflow-hidden rounded-full border border-white/10 shadow-[0_0_12px_rgba(0,0,0,0.4)]"
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
          className={`absolute z-20 flex ${centerSize} items-center justify-center rounded-full border shadow-inner`}
          style={{ borderColor: accentSoft, backgroundColor: accentSoft, color: accentColor }}
        >
          <div className="h-1.5 w-1.5 rounded-full border border-white/5 bg-black shadow-inner" />
        </div>
      </div>
    </div>
  );
}

export function PlaybackModeIcon({ mode }: { mode: PlaybackMode }) {
  return <ThemeAwarePlaybackModeGlyph mode={mode} />;
}

const playbackModeLabels: Record<PlaybackMode, string> = {
  sequence: "列表循环",
  shuffle: "随机播放",
  single: "单曲循环"
};

export function PlaybackModeButton({
  mode,
  onCycle,
  disabled = false,
  accentColor = "rgb(0 148 255)",
  accentSoft = "rgba(0, 148, 255, 0.16)"
}: {
  mode: PlaybackMode;
  onCycle: () => void;
  disabled?: boolean;
  accentColor?: string;
  accentSoft?: string;
}) {
  const label = playbackModeLabels[mode];
  const nextMode = getNextPlaybackMode(mode);

  return (
    <button
      type="button"
      data-testid="playback-mode-button"
      data-playback-mode={mode}
      disabled={disabled}
      aria-label={`当前为${label}，点击切换到${playbackModeLabels[nextMode]}`}
      title={`当前：${label}，点击切换`}
      onClick={onCycle}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-foreground-muted transition-colors hover:text-[var(--hover-color)] hover:bg-[var(--hover-bg)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        color: accentColor,
        "--hover-color": accentColor,
        "--hover-bg": accentSoft
      } as CSSProperties}
    >
      <PlaybackModeIcon mode={mode} />
      <span className="sr-only">{label}</span>
    </button>
  );
}

export function LyricsToggleButton({
  isOpen,
  onToggle,
  disabled = false,
  accentColor = "rgb(0 148 255)",
  accentSoft = "rgba(0, 148, 255, 0.16)"
}: {
  isOpen: boolean;
  onToggle: () => void;
  disabled?: boolean;
  accentColor?: string;
  accentSoft?: string;
}) {
  return (
    <button
      type="button"
      data-testid="player-lyrics-toggle"
      aria-pressed={isOpen}
      aria-label={isOpen ? "关闭桌面歌词" : "打开桌面歌词"}
      title={isOpen ? "关闭桌面歌词" : "打开桌面歌词"}
      onClick={onToggle}
      disabled={disabled}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold leading-none transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40 ${
        isOpen
          ? "border shadow-sm active:scale-95"
          : "text-foreground-muted hover:text-[var(--hover-color)] hover:bg-[var(--hover-bg)] active:scale-95"
      }`}
      style={{
        "--hover-color": accentColor,
        "--hover-bg": accentSoft,
        ...(isOpen
          ? {
              color: accentColor,
              backgroundColor: accentSoft,
              borderColor: withAlpha(accentColor, 0.35)
            }
          : {})
      } as CSSProperties}
    >
      <span className="text-[13px] font-bold font-sans leading-none">词</span>
    </button>
  );
}

function VolumeIcon({ volume }: { volume: number }) {
  return <ThemeAwareVolumeGlyph muted={volume <= 0.01} />;
}

function VolumeControl({
  volume,
  onChange,
  accentColor = "rgb(0 148 255)",
  accentSoft = "rgba(0, 148, 255, 0.16)"
}: {
  volume: number;
  onChange: (value: number) => void;
  accentColor?: string;
  accentSoft?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const percentage = Math.round(Math.max(0, Math.min(1, volume)) * 100);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="player-volume-button"
          aria-expanded={isOpen}
          aria-label={`音量 ${percentage}%，点击${isOpen ? "收起" : "调整"}`}
          title={`音量 ${percentage}%`}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-foreground-muted transition-colors hover:text-[var(--hover-color)] hover:bg-[var(--hover-bg)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent cursor-pointer"
          style={{
            "--hover-color": accentColor,
            "--hover-bg": accentSoft,
            ...(isOpen ? { color: accentColor, backgroundColor: accentSoft } : {})
          } as CSSProperties}
        >
          <VolumeIcon volume={volume} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={8}
        className="light-popover-surface flex h-[9.25rem] w-14 flex-col items-center rounded-2xl border border-surface-border bg-background-secondary p-2.5 shadow-lg backdrop-blur-xl"
      >
        <div className="relative h-24 w-5 shrink-0">
          <div className="absolute left-1/2 top-0 h-full w-1.5 -translate-x-1/2 overflow-hidden rounded-full bg-white/10">
            <div
              className="absolute inset-x-0 bottom-0 rounded-full transition-[height,background-color] duration-150"
              style={{
                height: `${percentage}%`,
                backgroundColor: accentColor
              }}
            />
          </div>
          <div
            aria-hidden="true"
            className="absolute left-1/2 h-5 w-5 -translate-x-1/2 translate-y-1/2 rounded-full border border-white/20 bg-foreground shadow-[0_3px_9px_rgba(0,0,0,0.35)] transition-[bottom] duration-150"
            style={{ bottom: `${percentage}%` }}
          />
          <input
            aria-label="音量"
            data-testid="player-volume-slider"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(event) => onChange(Number(event.target.value))}
            className="absolute left-1/2 top-1/2 h-8 w-24 -translate-x-1/2 -translate-y-1/2 -rotate-90 cursor-pointer opacity-0 focus-visible:opacity-100 focus-visible:outline-none"
          />
        </div>
        <span className="mt-2 text-xs tabular-nums text-foreground-muted">{percentage}%</span>
      </PopoverContent>
    </Popover>
  );
}

export function MobileBottomPlayerLayout({
  roomId,
  isPlaying,
  canControlPlayback,
  playbackTrackId,
  title,
  artist,
  onTogglePlay,
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
  onToggleImmersive,
  artworkAccent,
  artworkAccentSoft,
  artworkUrl
}: LayoutProps) {
  const pointerStartY = useRef<number | null>(null);
  const pointerStartX = useRef<number | null>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") return;
    pointerStartY.current = e.clientY;
    pointerStartX.current = e.clientX;
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (pointerStartY.current === null || pointerStartX.current === null) return;
    const deltaY = e.clientY - pointerStartY.current;
    const deltaX = e.clientX - pointerStartX.current;
    pointerStartY.current = null;
    pointerStartX.current = null;

    // Upward swipe gesture (swipe up): upward drag > 25px with vertical dominance
    if (deltaY < -25 && Math.abs(deltaY) > Math.abs(deltaX)) {
      onToggleImmersive();
    }
  };

  return (
    <div
      className="relative mx-auto w-full max-w-[760px] md:hidden select-none"
      data-player-layout="mobile"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
    >
      {/* Subtle indicator showing swipe up affordance */}
      <div className="absolute -top-1 left-1/2 -translate-x-1/2 h-0.5 w-7 rounded-full bg-white/20 opacity-70 pointer-events-none" />

      <div className="flex h-12 items-center gap-2.5 px-1">
        {/* Click body to open full immersive sheet */}
        <button
          aria-label="打开播放详情"
          className="flex min-w-0 flex-1 items-center gap-2.5 py-1 text-left outline-none transition-transform duration-150 active:scale-[0.98] focus-visible:outline-none"
          onClick={onToggleImmersive}
          title="打开播放详情"
          type="button"
        >
          <SquareAlbumCover
            artworkUrl={artworkUrl}
            className="h-10 w-10 shrink-0 rounded-md border-0 shadow-sm"
          />

          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-foreground leading-tight">{title}</p>
            <p className="truncate text-xs text-foreground-muted mt-0.5 leading-tight">{artist}</p>
          </div>
        </button>

        {/* Action Controls */}
        <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <button
            aria-label={isPlaying ? "暂停" : "播放"}
            className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-transform duration-150 active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              canControlPlayback
                ? "bg-accent text-white shadow-sm hover:opacity-90 cursor-pointer"
                : "cursor-not-allowed bg-accent/40 text-white/50 opacity-40"
            }`}
            style={canControlPlayback ? { backgroundColor: artworkAccent || "var(--accent)" } : undefined}
            disabled={!canControlPlayback || !playbackTrackId}
            onClick={onTogglePlay}
            title={isPlaying ? "暂停" : "播放"}
            type="button"
          >
            {isPlaying ? (
              <svg aria-hidden="true" fill="currentColor" height="15" viewBox="0 0 24 24" width="15">
                <path d="M6 19h4V5H6zm8-14v14h4V5z" />
              </svg>
            ) : (
              <svg aria-hidden="true" fill="currentColor" height="15" viewBox="0 0 24 24" width="15" className="translate-x-[0.5px]">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          <PlayerQueueDrawer
            roomId={roomId}
            queue={queue}
            tracks={tracks}
            members={members}
            currentSessionId={currentSessionId}
            currentQueueItemId={currentQueueItemId}
            nextQueueItemId={nextQueueItemId}
            accentColor={artworkAccent}
            accentSoft={artworkAccentSoft}
            canControlPlayback={canControlPlayback}
            canReorderQueue={canReorderQueue}
            canRemoveQueue={canRemoveQueue}
            onPlayQueueItem={onPlayQueueItem}
            onPlayNextQueueItem={onPlayNextQueueItem}
            onRemoveQueueItem={onRemoveQueueItem}
            onRemoveQueueItems={onRemoveQueueItems}
            onReorderQueue={onReorderQueue}
            compactMobile
            placement="bottom-sheet"
          />
        </div>
      </div>
    </div>
  );
}

export function TopEdgeScrubber({
  progressMs,
  durationMs,
  canSeek,
  onSeekDraft,
  onCommitSeek,
  accentColor = "var(--accent)"
}: {
  progressMs: number;
  durationMs: number;
  canSeek: boolean;
  onSeekDraft: (value: number | null) => void;
  onCommitSeek: () => void;
  accentColor?: string;
}) {
  const [isHovering, setIsHovering] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [hoverData, setHoverData] = useState<{ ratio: number; timeMs: number } | null>(null);
  const scrubberRef = useRef<HTMLDivElement>(null);

  const effectiveDuration = durationMs > 0 ? durationMs : 1;
  const currentRatio = Math.max(0, Math.min(1, progressMs / effectiveDuration));
  const displayRatio = isDragging && hoverData ? hoverData.ratio : currentRatio;

  const calculateRatio = (clientX: number) => {
    if (!scrubberRef.current) return 0;
    const rect = scrubberRef.current.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!canSeek || durationMs <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
    const ratio = calculateRatio(event.clientX);
    const timeMs = Math.round(ratio * durationMs);
    setHoverData({ ratio, timeMs });
    onSeekDraft(timeMs);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (durationMs <= 0) return;
    const ratio = calculateRatio(event.clientX);
    const timeMs = Math.round(ratio * durationMs);
    setHoverData({ ratio, timeMs });
    if (isDragging) {
      onSeekDraft(timeMs);
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isDragging) {
      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      } catch (_err) {
        void _err;
      }
      setIsDragging(false);
      onCommitSeek();
    }
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isDragging) {
      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      } catch (_err) {
        void _err;
      }
      setIsDragging(false);
      onSeekDraft(null);
    }
  };

  return (
    <div
      ref={scrubberRef}
      role="slider"
      data-testid="player-seek-slider"
      aria-label="播放进度"
      aria-valuemin={0}
      aria-valuemax={durationMs}
      aria-valuenow={progressMs}
      aria-valuetext={`${formatDuration(progressMs)} / ${formatDuration(durationMs)}`}
      tabIndex={canSeek ? 0 : -1}
      className="group/scrubber absolute inset-x-0 -top-1.5 z-30 h-3.5 cursor-pointer select-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerEnter={() => setIsHovering(true)}
      onPointerLeave={() => {
        if (!isDragging) {
          setIsHovering(false);
          setHoverData(null);
        }
      }}
    >
      {/* Background track line: 2px normal, 3.5px on hover/drag */}
      <div className="absolute inset-x-0 top-1.5 h-[2px] bg-white/10 transition-[height,top] duration-150 group-hover/scrubber:top-[4.5px] group-hover/scrubber:h-[3.5px]">
        {/* Progress Fill */}
        <div
          className="relative h-full transition-[width] duration-75"
          style={{
            width: `${displayRatio * 100}%`,
            backgroundColor: accentColor
          }}
        >
          {/* Thumb circle on hover / drag */}
          <div
            className={`absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.5)] transition-all duration-150 ${
              isHovering || isDragging
                ? "h-3 w-3 opacity-100 scale-100"
                : "h-2 w-2 opacity-0 scale-75 pointer-events-none"
            }`}
          />
        </div>
      </div>

      {/* Floating time tooltip bubble: 00:53 / 05:00 */}
      {(isHovering || isDragging) && hoverData !== null && durationMs > 0 && (
        <div
          className="pointer-events-none absolute -top-8 -translate-x-1/2 rounded-full border border-surface-border bg-background-secondary px-2.5 py-0.5 text-xs font-medium tabular-nums text-foreground shadow-sm animate-fade-in"
          style={{
            left: `${Math.max(0.04, Math.min(0.96, hoverData.ratio)) * 100}%`
          }}
        >
          {formatDuration(hoverData.timeMs)} / {formatDuration(durationMs)}
        </div>
      )}
    </div>
  );
}

const AUDIO_QUALITY_OPTIONS: Array<{
  value: AudioQualityPreference;
  label: string;
  badge: string;
  bitrate: string;
}> = [
  { value: "hires", label: "Hi-Res", badge: "Hi-Res", bitrate: "高解析" },
  { value: "lossless", label: "无损", badge: "无损", bitrate: "FLAC" },
  { value: "exhigh", label: "极高", badge: "极高", bitrate: "320k" },
  { value: "high", label: "较高", badge: "较高", bitrate: "192k" },
  { value: "standard", label: "标准", badge: "标准", bitrate: "128k" }
];

export function QualityBadge({
  quality,
  variant = "default",
  popoverPlacement = "right",
  className = "",
  accentColor = "rgb(0 148 255)",
  accentSoft = "rgba(0, 148, 255, 0.16)"
}: {
  quality?: string | null;
  variant?: "default" | "capsule";
  popoverPlacement?: "right" | "center";
  className?: string;
  accentColor?: string;
  accentSoft?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const settings = useAppSettings();
  const preferredQuality = settings.playback.preferredAudioQuality;

  const activeQuality = (quality as AudioQualityPreference) || preferredQuality;
  const currentOption =
    AUDIO_QUALITY_OPTIONS.find((opt) => opt.value === activeQuality) ??
    AUDIO_QUALITY_OPTIONS.find((opt) => opt.value === "exhigh")!;

  const handleSelect = (val: AudioQualityPreference) => {
    updateAppSettings({
      playback: {
        preferredAudioQuality: val
      }
    });
    setIsOpen(false);
  };

  const isCapsule = variant === "capsule";

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`音频音质设置：当前${currentOption.label}`}
          aria-expanded={isOpen}
          title="点击切换首选音质"
          className={
            isCapsule
              ? `inline-flex h-8 items-center justify-center gap-1 rounded-lg bg-white/[0.12] px-2.5 text-xs font-medium leading-none text-white/80 active:scale-95 transition-all select-none hover:bg-white/[0.18] hover:text-white cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40 ${className}`
              : `inline-flex h-8 items-center justify-center gap-1 rounded-lg px-2 text-xs font-medium leading-none text-foreground-muted select-none transition-colors cursor-pointer hover:text-[var(--hover-color)] hover:bg-[var(--hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent active:scale-95 ${className}`
          }
          style={
            isCapsule
              ? undefined
              : ({
                  "--hover-color": accentColor,
                  "--hover-bg": accentSoft,
                  ...(isOpen
                    ? {
                        color: accentColor,
                        backgroundColor: accentSoft
                      }
                    : {})
                } as CSSProperties)
          }
        >
          <span className="leading-none">{currentOption.badge}</span>
          <svg
            width={10}
            height={10}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`opacity-60 transition-transform duration-150 ${isOpen ? "rotate-180" : ""}`}
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align={popoverPlacement === "center" ? "center" : "end"}
        sideOffset={8}
        className="light-popover-surface w-48 rounded-xl border border-surface-border bg-background-secondary p-1.5 shadow-lg"
      >
        <div className="px-2 py-1 text-xs font-medium text-foreground-muted">
          音质偏好
        </div>
        <div className="space-y-0.5">
          {AUDIO_QUALITY_OPTIONS.map((opt) => {
            const isSelected = opt.value === activeQuality;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleSelect(opt.value)}
                className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs transition-colors cursor-pointer ${
                  isSelected
                    ? "font-semibold shadow-xs"
                    : "text-foreground-secondary hover:bg-surface-hover hover:text-foreground"
                }`}
                style={
                  isSelected
                    ? {
                        backgroundColor: accentSoft,
                        color: accentColor
                      }
                    : undefined
                }
              >
                <div className="flex items-center gap-1.5">
                  <span>{opt.label}</span>
                  <span className="text-xs text-foreground-muted/70">({opt.bitrate})</span>
                </div>
                {isSelected && (
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function DesktopBottomPlayerLayout({
  roomId,
  isPlaying,
  canControlPlayback,
  canSeekPlayback,
  playbackTrackId,
  title,
  artist,
  boundedProgressMs,
  currentTrackDuration,
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
  isImmersiveOpen,
  onToggleImmersive,
  isMiniOpen,
  onToggleMini,
  isLyricsOpen = false,
  onToggleLyrics,
  artworkAccent,
  artworkAccentSoft,
  artworkUrl,
  playerStyle,
  favoriteTrack,
  favoriteTrackIsFavorite = false,
  favoriteTrackIsPending = false,
  onToggleFavoriteTrack
}: LayoutProps) {
  return (
    <div
      className="relative hidden h-full w-full items-center justify-between px-4 sm:px-6 md:flex"
      data-player-layout="desktop"
    >
      {/* Pinned Top-Edge Scrubber with hover expand, draggable thumb, and floating time bubble */}
      <TopEdgeScrubber
        progressMs={boundedProgressMs}
        durationMs={currentTrackDuration}
        canSeek={canSeekPlayback}
        onSeekDraft={setSeekDraft}
        onCommitSeek={commitSeek}
        accentColor={artworkAccent}
      />

      {/* Left: Album Cover + Track Title/Artist + Favorite Button */}
      <div className="flex min-w-0 items-center gap-3 w-[260px] lg:w-[320px] shrink-0">
        <button
          className={`group/cover relative outline-none focus-visible:ring-2 focus-visible:ring-accent shrink-0 ${
            playerStyle === "square-cover" ? "rounded-md" : "rounded-full"
          }`}
          onClick={onToggleImmersive}
          title="打开沉浸式播放"
          aria-label="打开沉浸式播放"
          type="button"
        >
          <VinylBadge
            compact
            accentColor={artworkAccent}
            accentSoft={artworkAccentSoft}
            artworkUrl={artworkUrl}
            isPlaying={isPlaying}
            playerStyle={playerStyle}
          />
          <div
            className={`absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover/cover:opacity-100 ${
              playerStyle === "square-cover" ? "rounded-md" : "rounded-full"
            }`}
          >
            <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          </div>
        </button>

        <div className="min-w-0 max-w-[140px] lg:max-w-[190px]">
          <h3
            className="truncate text-sm font-medium text-foreground hover:text-accent transition-colors cursor-pointer"
            onClick={onToggleImmersive}
            title={title}
          >
            {title}
          </h3>
          <p
            className="truncate text-xs text-foreground-muted hover:text-foreground transition-colors cursor-pointer"
            onClick={onToggleImmersive}
            title={artist}
          >
            {artist}
          </p>
        </div>

        {favoriteTrack && onToggleFavoriteTrack ? (
          <FavoriteTrackButton
            accentColor={artworkAccent}
            accentSoft={artworkAccentSoft}
            isFavorite={favoriteTrackIsFavorite}
            onToggle={onToggleFavoriteTrack}
            pending={favoriteTrackIsPending}
            track={favoriteTrack}
            className="shrink-0 ml-1"
          />
        ) : null}
      </div>

      {/* Center: Playback Mode + Prev + Circular Play/Pause + Next + Queue (Viewport Dead-Center) */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center gap-3 sm:gap-3.5 pointer-events-auto">
        <PlaybackModeButton
          mode={playbackMode}
          onCycle={onCyclePlaybackMode}
          disabled={!canControlPlayback}
          accentColor={artworkAccent}
          accentSoft={artworkAccentSoft}
        />
        <button
          type="button"
          data-testid="player-prev-button"
          disabled={!canControlPlayback || !playbackTrackId}
          onClick={onPrev}
          title="上一首"
          aria-label="上一首"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-foreground-muted transition-colors hover:text-[var(--hover-color)] hover:bg-[var(--hover-bg)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            "--hover-color": artworkAccent,
            "--hover-bg": artworkAccentSoft
          } as CSSProperties}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
          </svg>
        </button>

        <button
          data-testid="player-toggle-button"
          className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white shadow-md outline-none transition-transform focus-visible:ring-2 focus-visible:ring-accent ${
            canControlPlayback
              ? "hover:scale-105 active:scale-95 cursor-pointer bg-accent"
              : "cursor-not-allowed opacity-50 bg-accent/60"
          }`}
          style={{ backgroundColor: artworkAccent || "var(--accent)" }}
          disabled={!canControlPlayback}
          onClick={onTogglePlay}
          title={isPlaying ? "暂停" : "播放"}
          type="button"
        >
          {isPlaying ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 19h4V5H6zm8-14v14h4V5z" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" className="translate-x-[0.5px]">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <button
          type="button"
          data-testid="player-next-button"
          disabled={!canControlPlayback || !playbackTrackId}
          onClick={onNext}
          title="下一首"
          aria-label="下一首"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-foreground-muted transition-colors hover:text-[var(--hover-color)] hover:bg-[var(--hover-bg)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            "--hover-color": artworkAccent,
            "--hover-bg": artworkAccentSoft
          } as CSSProperties}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 18l8.5-6L6 6zm10-12v12h2V6z" />
          </svg>
        </button>

        <PlayerQueueDrawer
          roomId={roomId}
          queue={queue}
          tracks={tracks}
          members={members}
          currentSessionId={currentSessionId}
          currentQueueItemId={currentQueueItemId}
          nextQueueItemId={nextQueueItemId}
          accentColor={artworkAccent}
          accentSoft={artworkAccentSoft}
          canControlPlayback={canControlPlayback}
          canReorderQueue={canReorderQueue}
          canRemoveQueue={canRemoveQueue}
          onPlayQueueItem={onPlayQueueItem}
          onPlayNextQueueItem={onPlayNextQueueItem}
          onRemoveQueueItem={onRemoveQueueItem}
          onRemoveQueueItems={onRemoveQueueItems}
          onReorderQueue={onReorderQueue}
        />
      </div>

      {/* Right: Audio Quality Badge + Lyrics Toggle + Volume Control + Immersive + Mini */}
      <div className="flex min-w-0 items-center justify-end gap-2 sm:gap-2.5 lg:gap-3 min-w-[280px] lg:min-w-[340px] shrink-0 ml-auto h-8">
        {currentTrackDuration > 0 ? (
          <span className="hidden xl:inline-flex h-8 items-center text-xs font-mono tabular-nums text-foreground-muted/80 select-none mr-2 shrink-0 leading-none">
            {formatDuration(boundedProgressMs)} / {formatDuration(currentTrackDuration)}
          </span>
        ) : null}
        <QualityBadge
          accentColor={artworkAccent}
          accentSoft={artworkAccentSoft}
        />

        {onToggleLyrics ? (
          <LyricsToggleButton
            accentColor={artworkAccent}
            accentSoft={artworkAccentSoft}
            disabled={!playbackTrackId}
            isOpen={isLyricsOpen}
            onToggle={onToggleLyrics}
          />
        ) : null}

        <VolumeControl
          volume={volume}
          onChange={applyVolume}
          accentColor={artworkAccent}
          accentSoft={artworkAccentSoft}
        />

        <ImmersiveToggleButton
          accentColor={artworkAccent}
          accentSoft={artworkAccentSoft}
          isOpen={isImmersiveOpen}
          onToggle={onToggleImmersive}
        />

        <MiniPlayerToggleButton
          accentColor={artworkAccent}
          accentSoft={artworkAccentSoft}
          isOpen={isMiniOpen}
          onToggle={onToggleMini}
        />
      </div>
    </div>
  );
}

function ImmersiveToggleButton({
  isOpen,
  onToggle,
  accentColor = "rgb(0 148 255)",
  accentSoft = "rgba(0, 148, 255, 0.16)"
}: {
  isOpen: boolean;
  onToggle: () => void;
  accentColor?: string;
  accentSoft?: string;
}) {
  return (
    <button
      type="button"
      aria-label={isOpen ? "退出沉浸式播放" : "打开沉浸式播放"}
      title={isOpen ? "退出沉浸式播放" : "打开沉浸式播放"}
      onClick={onToggle}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-foreground-muted transition-colors hover:text-[var(--hover-color)] hover:bg-[var(--hover-bg)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      style={{
        "--hover-color": accentColor,
        "--hover-bg": accentSoft,
        ...(isOpen ? { color: accentColor, backgroundColor: accentSoft } : {})
      } as CSSProperties}
    >
      {isOpen ? (
        <svg aria-hidden="true" fill="none" height="17" viewBox="0 0 24 24" width="17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8"><path d="M9 15H4v5" /><path d="m4 20 6-6" /><path d="M15 9h5V4" /><path d="m20 4-6 6" /></svg>
      ) : (
        <svg aria-hidden="true" fill="none" height="17" viewBox="0 0 24 24" width="17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8"><path d="M4 9V4h5" /><path d="m4 4 6 6" /><path d="M20 15v5h-5" /><path d="m20 20-6-6" /></svg>
      )}
    </button>
  );
}

function MiniPlayerToggleButton({
  isOpen,
  onToggle,
  accentColor = "rgb(0 148 255)",
  accentSoft = "rgba(0, 148, 255, 0.16)"
}: {
  isOpen: boolean;
  onToggle: () => void;
  accentColor?: string;
  accentSoft?: string;
}) {
  return (
    <button
      type="button"
      aria-label={isOpen ? "关闭迷你播放器" : "打开迷你播放器"}
      title={isOpen ? "关闭迷你播放器" : "打开迷你播放器"}
      onClick={onToggle}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-foreground-muted transition-colors hover:text-[var(--hover-color)] hover:bg-[var(--hover-bg)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      style={{
        "--hover-color": accentColor,
        "--hover-bg": accentSoft,
        ...(isOpen ? { color: accentColor, backgroundColor: accentSoft } : {})
      } as CSSProperties}
    >
      <svg aria-hidden="true" fill="none" height="17" viewBox="0 0 24 24" width="17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
        <rect x="3.5" y="4" width="17" height="16" rx="2" />
        <rect x="11" y="12" width="7" height="5" rx="0.8" />
      </svg>
    </button>
  );
}
