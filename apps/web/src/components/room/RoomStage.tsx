import { memo, useEffect, useState, type ComponentProps, type CSSProperties, type MutableRefObject } from "react";
import type {
  RoomMediaConnectionState,
  RoomMember,
  RoomSnapshot,
  TrackMeta,
  UpdateRoomRequest
} from "@soqaro/shared";
import { formatDuration } from "@/lib/domain/soqaro-ui";
import { findRoomPlaylistTrackRecord } from "@/features/playlist/local-playlist";
import { RoomLyricsPositionProvider, useRoomLyricsPositionMs } from "./room-lyrics-position";

import { VinylAuraVisualizer } from "./VinylAuraVisualizer";
import { VinylTonearm } from "./VinylTonearm";
import { RoomControlHeader, getSourceModeLabel } from "./RoomControlHeader";
export { getSourceModeLabel };
import { RoomLyricsPanel } from "./RoomLyricsPanel";
import { fetchProviderLyricsCached, hasWordSyncedRoomLyrics, selectRoomLyrics } from "@/features/playback/lyrics";
import { getArtworkSourceUrl, useArtworkPalette } from "@/components/bottom-player/artwork-colors";
import { resolvePreferredArtworkUrl } from "@/components/bottom-player/preferred-artwork";
import { SquareAlbumCover } from "@/components/bottom-player";
import { usePlayerStyle } from "@/features/settings/use-player-style";
import type { RoomPlaybackBarrierClock } from "@/features/playback/room-playback-clock";
import { RoomReactionOverlay } from "./RoomReactionOverlay";
import type { RoomSocket } from "@/lib/network/ws-client";

type RoomStageProps = {
  roomSnapshot: RoomSnapshot;
  playbackBarrier?: RoomPlaybackBarrierClock | null;
  currentPlaybackPositionRef?: MutableRefObject<number>;
  currentTrack: TrackMeta | null;
  currentTrackDuration: number;
  isPlaying: boolean;
  host: RoomMember | undefined;
  canDeleteRoom: boolean;
  canDisbandRoom: boolean;
  currentSourceOwnerNickname: string | null;
  mediaConnectionState: RoomMediaConnectionState;
  mediaConnectedPeersCount: number;
  iceConfigSource: string;
  onCopyJoinCode: () => Promise<void>;
  onShareRoom: () => Promise<void>;
  onAwayRoom: () => void;
  onLeaveRoom: () => void;
  onDeleteRoom: () => void;
  onUpdateRoom: (input: UpdateRoomRequest) => Promise<boolean>;
  onSeek: (positionMs: number) => void;
  showMobilePlayer?: boolean;
  hideRoomMetadata?: boolean;
  mobileControlsOnly?: boolean;
  socket?: RoomSocket | null;
};

function RoomStageBase({
  roomSnapshot,
  playbackBarrier,
  currentPlaybackPositionRef,
  currentTrack,
  currentTrackDuration,
  isPlaying,
  host,
  canDeleteRoom,
  canDisbandRoom,
  currentSourceOwnerNickname,
  mediaConnectionState,
  onCopyJoinCode,
  onShareRoom,
  onAwayRoom,
  onLeaveRoom,
  onDeleteRoom,
  onUpdateRoom,
  onSeek,
  showMobilePlayer = false,
  hideRoomMetadata = false,
  mobileControlsOnly = false,
  socket
}: RoomStageProps) {
  const currentTrackId = currentTrack?.id ?? null;

  const [lyricsText, setLyricsText] = useState<string | null>(null);
  const [translatedLyricsText, setTranslatedLyricsText] = useState<string | null>(null);
  const [romanizedLyricsText, setRomanizedLyricsText] = useState<string | null>(null);
  const [lyricsStatus, setLyricsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [cachedArtworkUrl, setCachedArtworkUrl] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState<{ height: number; width: number } | null>(null);
  const compactStage = viewportSize !== null && (viewportSize.height < 900 || viewportSize.width < 1024);
  const ultraCompactStage = viewportSize !== null && (viewportSize.height < 760 || viewportSize.width < 640);
  const playback = roomSnapshot.room.playback;
  const playbackPositionMs = playback.positionMs;
  const playbackStartedAt = playback.startedAt;
  const playbackStartAt = playback.startAt;
  const playbackStatus = playback.status;
  const playbackRevision = playback.playbackRevision;
  const barrierBlocked = playbackBarrier?.blocked;
  const barrierHoldPositionMs = playbackBarrier?.holdPositionMs;
  const barrierResumeAtMs = playbackBarrier?.resumeAtMs;
  const playbackPositionKey = [
    playbackPositionMs,
    playbackStartedAt ?? "",
    playbackStartAt ?? "",
    playbackStatus,
    playbackRevision
  ].join("|");
  const playbackBarrierKey = [
    barrierBlocked ? "blocked" : "ready",
    barrierHoldPositionMs ?? "",
    barrierResumeAtMs ?? ""
  ].join("|");
  const sourceProvider =
    currentTrack?.sourceRef?.provider ??
    (currentTrack?.sourceType === "netease" || currentTrack?.sourceType === "qqmusic"
      ? currentTrack.sourceType
      : null);

  const sourceTrackId = currentTrack?.sourceRef?.trackId ?? currentTrack?.id ?? null;
  const currentTrackFileHash = currentTrack?.fileHash ?? null;
  const currentTrackLyrics = currentTrack?.lyrics?.trim() || null;
  const currentTrackTranslatedLyrics = currentTrack?.translatedLyrics?.trim() || null;
  const currentTrackRomanizedLyrics = currentTrack?.romanizedLyrics?.trim() || null;
  const artworkUrl = resolvePreferredArtworkUrl(cachedArtworkUrl, currentTrack?.artworkUrl)
    ?? cachedArtworkUrl
    ?? null;
  const artworkPalette = useArtworkPalette(artworkUrl);
  const playerStyle = usePlayerStyle();
  const recordSize = ultraCompactStage
    ? "clamp(8.5rem, min(22vh, 38vw), 10.5rem)"
    : compactStage
      ? "clamp(9.5rem, min(25vh, 38vw), 12.5rem)"
      : "clamp(11rem, min(30vh, 36vw), 16rem)";
  const stageContentOffset = hideRoomMetadata
      ? "translate-y-0"
    : ultraCompactStage
      ? "-translate-y-3"
      : compactStage
        ? "-translate-y-[clamp(1.5rem,5vh,4rem)]"
        : "-translate-y-[clamp(2rem,5vh,4rem)]";



  useEffect(() => {
    const updateViewportSize = () => {
      const viewport = window.visualViewport;
      setViewportSize({
        height: viewport?.height ?? window.innerHeight,
        width: viewport?.width ?? window.innerWidth
      });
    };

    updateViewportSize();
    window.addEventListener("resize", updateViewportSize);
    window.visualViewport?.addEventListener("resize", updateViewportSize);
    return () => {
      window.removeEventListener("resize", updateViewportSize);
      window.visualViewport?.removeEventListener("resize", updateViewportSize);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!currentTrackId) {
      setCachedArtworkUrl(null);
      setLyricsText(null);
      setTranslatedLyricsText(null);
      setRomanizedLyricsText(null);
      setLyricsStatus("idle");
      return;
    }

    setLyricsStatus("loading");
    setLyricsText(null);
    setTranslatedLyricsText(currentTrackTranslatedLyrics);
    setRomanizedLyricsText(currentTrackRomanizedLyrics);

    void (async () => {
      let localRecord = null;
      try {
        localRecord = await findRoomPlaylistTrackRecord({
          trackId: currentTrackId,
          fileHash: currentTrackFileHash,
          provider: sourceProvider,
          providerTrackId: sourceTrackId
        });
      } catch {
        // Storage might be unavailable
      }

      if (cancelled) return;

      // 1. Set artwork if found in local record
      setCachedArtworkUrl(localRecord?.artworkUrl ?? null);

      // 2. Resolve lyrics
      const localLyrics = currentTrackLyrics || localRecord?.lyrics?.trim() || null;
      const localTranslated = currentTrackTranslatedLyrics || localRecord?.translatedLyrics?.trim() || null;
      const localRomanized = currentTrackRomanizedLyrics || localRecord?.romanizedLyrics?.trim() || null;

      if (localLyrics) {
        setLyricsText(localLyrics);
      }
      if (localTranslated) {
        setTranslatedLyricsText(localTranslated);
      }
      if (localRomanized) {
        setRomanizedLyricsText(localRomanized);
      }

      const hasWordSynced = hasWordSyncedRoomLyrics(localLyrics);
      if (
        (sourceProvider !== "netease" && sourceProvider !== "qqmusic" && sourceProvider !== "bilibili") ||
        !sourceTrackId ||
        (hasWordSynced && localTranslated && localRomanized)
      ) {
        setLyricsStatus(localLyrics ? "ready" : "idle");
        return;
      }

      try {
        const response = await fetchProviderLyricsCached(sourceProvider, sourceTrackId);
        if (!cancelled) {
          setLyricsText(selectRoomLyrics({
            localLyrics,
            wordSyncedLyric: response.wordSyncedLyric,
            plainLyric: response.plainLyric
          }));
          setTranslatedLyricsText(response.translatedLyric?.trim() || localTranslated || null);
          setRomanizedLyricsText(response.romanizedLyric?.trim() || localRomanized || null);
          setLyricsStatus("ready");
        }
      } catch {
        if (!cancelled) {
          if (localLyrics) {
            setLyricsText(localLyrics);
          }
          setLyricsStatus(localLyrics ? "ready" : "error");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    currentTrackFileHash,
    currentTrackId,
    currentTrackLyrics,
    currentTrackRomanizedLyrics,
    currentTrackTranslatedLyrics,
    sourceProvider,
    sourceTrackId
  ]);

  return (
    <RoomLyricsPositionProvider
      playback={playback}
      currentPlaybackPositionRef={currentPlaybackPositionRef}
      currentTrackDuration={currentTrackDuration}
      isPlaying={isPlaying}
      playbackBarrier={playbackBarrier}
      playbackPositionKey={playbackPositionKey}
      playbackBarrierKey={playbackBarrierKey}
    >
    <section
      className={`relative flex h-auto w-full min-h-0 flex-col px-3 pb-3 ${hideRoomMetadata ? "pt-[calc(0.75rem+env(safe-area-inset-top))]" : "pt-[calc(2.25rem+env(safe-area-inset-top))]"} ${mobileControlsOnly ? "max-lg:pb-0 max-lg:pt-3" : ""} sm:px-5 md:px-8 lg:h-full ${
        ultraCompactStage ? "lg:py-2" : compactStage ? "lg:py-3" : "lg:py-4 xl:py-5"
      }`}
    >
      <RoomControlHeader
        roomSnapshot={roomSnapshot}
        mediaConnectionState={mediaConnectionState}
        currentTrack={currentTrack}
        host={host}
        canDeleteRoom={canDeleteRoom}
        canDisbandRoom={canDisbandRoom}
        onCopyJoinCode={onCopyJoinCode}
        onShareRoom={onShareRoom}
        onAwayRoom={onAwayRoom}
        onLeaveRoom={onLeaveRoom}
        onDeleteRoom={onDeleteRoom}
        onUpdateRoom={onUpdateRoom}
        hideRoomMetadata={hideRoomMetadata}
        className={
          hideRoomMetadata && !mobileControlsOnly
            ? "absolute right-3 top-[calc(0.75rem+env(safe-area-inset-top))] sm:right-5 md:right-8 z-30"
            : mobileControlsOnly
              ? `relative z-30 ${compactStage ? "mb-0 lg:mb-3" : "mb-0 lg:mb-5 xl:mb-6"}`
              : `relative z-30 ${compactStage ? "mb-0 lg:mb-3" : "mb-0 lg:mb-5 xl:mb-6"}`
        }
      />

      {showMobilePlayer ? (
        <ContextProgressMobileStagePlayer
          artworkPalette={artworkPalette}
          artworkUrl={artworkUrl}
          currentTrack={currentTrack}
          currentTrackDuration={currentTrackDuration}
          isPlaying={isPlaying}
          playbackBarrier={playbackBarrier}
          playerStyle={playerStyle}
        />
      ) : null}

      <div className={`relative z-20 flex min-h-0 flex-1 flex-col items-center overflow-visible ${showMobilePlayer ? "hidden lg:flex" : ""}`}>
        <div className="flex h-full min-h-0 w-full flex-col items-center justify-center overflow-visible">
          <div className={`flex min-h-0 w-full max-w-[48rem] flex-col items-center justify-center overflow-visible px-1 ${stageContentOffset}`}>
            <div
                className="relative flex h-[var(--record-size)] min-h-0 w-full shrink-0 items-center justify-center"
                data-room-stage-record="true"
              >
                <div
                  className="pointer-events-none relative flex min-h-0 w-full items-center justify-center"
                  data-room-stage-record-surface="true"
                  style={{ "--record-size": recordSize, height: "var(--record-size)" } as CSSProperties}
                >
                  <div
                    className="relative flex items-center justify-center overflow-visible"
                    style={{ width: "var(--record-size)", height: "var(--record-size)" }}
                  >
                    {playerStyle === "square-cover" ? (
                      <SquareAlbumCover artworkUrl={artworkUrl} className="h-full w-full rounded-[1rem] shadow-2xl" />
                    ) : (
                      <>
                        <VinylAuraVisualizer
                          accentColor={artworkPalette.accent}
                          frozen={playbackBarrier?.blocked === true}
                          isPlaying={isPlaying}
                        />
                        <div
                          className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-full border border-white/5 bg-gradient-to-tr from-[#020202] via-[#111111] to-[#1a1a1a] shadow-2xl transition-[box-shadow,opacity,transform] duration-700 ease-out animate-spin-slow"
                          style={{ animationPlayState: isPlaying ? "running" : "paused" }}
                        >
                          <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_30%,rgba(255,255,255,0.1),transparent_40%)]" />
                          <div
                            className="absolute inset-0 rounded-full"
                            style={{
                              background: `conic-gradient(from 0deg at 50% 50%, ${artworkPalette.accentSoft} 0deg, transparent 90deg, ${artworkPalette.accentSoft} 180deg, transparent 270deg, ${artworkPalette.accentSoft} 360deg)`
                            }}
                          />
                          {Array.from({ length: 6 }).map((_, index) => (
                            <div
                              key={index}
                              className="absolute rounded-full border border-white/[0.02]"
                              style={{ width: `${100 - index * 15}%`, height: `${100 - index * 15}%` }}
                            />
                          ))}
                          {artworkUrl ? (
                            <div
                              aria-hidden="true"
                              className="absolute z-10 aspect-square w-[48%] overflow-hidden rounded-full border border-white/10 shadow-[0_0_24px_rgba(0,0,0,0.35)]"
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
                            className="absolute z-20 flex aspect-square items-center justify-center rounded-full border shadow-inner"
                            style={{
                              width: "26%",
                              height: "26%",
                              borderColor: artworkPalette.border,
                              backgroundColor: artworkPalette.accentSoft
                            }}
                          >
                            <div className="rounded-full border border-white/5 bg-black shadow-inner" style={{ width: "32%", height: "32%" }} />
                          </div>
                        </div>
                        <VinylTonearm
                          accentColor={artworkPalette.accent}
                          frozen={playbackBarrier?.blocked === true}
                          isPlaying={isPlaying}
                        />
                      </>
                    )}
                  </div>

                </div>
              </div>
            <div
                className={`relative z-30 flex shrink-0 flex-col items-center text-center ${
                  ultraCompactStage ? "gap-2 pt-3" : compactStage ? "gap-2.5 pt-3.5" : "gap-3 pt-4 sm:gap-3.5 sm:pt-5"
                }`}
              >
                {currentTrack ? (
                  <>
                    <div className="flex flex-wrap items-center justify-center gap-1.5 sm:gap-2.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          isPlaying
                            ? "border border-accent/40 bg-accent/15 text-accent"
                            : "border border-surface-border bg-surface text-foreground-muted"
                        }`}
                      >
                        {playbackBarrier?.blocked ? "缓存中" : isPlaying ? "正在播放" : "准备就绪"}
                      </span>
                      {currentSourceOwnerNickname ? (
                        <span className="flex items-center gap-1 text-xs text-foreground-muted">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                            <circle cx="12" cy="7" r="4" />
                          </svg>
                          当前音源：<span className="text-foreground">{currentSourceOwnerNickname}</span>
                        </span>
                      ) : null}
                    </div>

                    <h2
                      className={`max-w-[20ch] font-semibold tracking-tight text-foreground ${
                        ultraCompactStage
                          ? "text-lg leading-tight"
                          : compactStage
                            ? "text-xl leading-tight"
                            : "text-xl sm:text-2xl leading-tight"
                      }`}
                      data-testid="stage-track-title"
                      title={currentTrack.title}
                    >
                      {currentTrack.title}
                    </h2>

                    <p
                      className={`font-medium tracking-wide text-foreground-muted ${
                        ultraCompactStage
                          ? "max-w-[26ch] text-xs leading-snug"
                          : compactStage
                            ? "max-w-[26ch] text-xs leading-snug"
                            : "max-w-[28ch] text-xs sm:text-sm leading-relaxed"
                      }`}
                      data-testid="stage-track-artist"
                    >
                      {`${currentTrack.artist} / ${formatDuration(currentTrackDuration)}`}
                    </p>
                  </>
                ) : (
                  <p className="max-w-[26ch] text-center text-xs sm:text-sm leading-relaxed text-foreground-muted">
                    从曲库添加音乐，或导入本地音频，马上开始这场协作收听。
                  </p>
                )}
              </div>

            <ContextPositionRoomLyricsPanel
              className="max-w-[36rem]"
              frozen={playbackBarrier?.blocked === true}
              visibleLines={3}
              fontScale="medium"
              isPlaying={isPlaying}
              lyrics={lyricsText}
              translatedLyrics={translatedLyricsText}
              romanizedLyrics={romanizedLyricsText}
              showControls={false}
              showTranslation={false}
              showRomanized={false}
              status={lyricsStatus}
              onSeek={onSeek}
            />
          </div>
        </div>

        {/* Floating Vector SVG Reaction Overlay */}
        <RoomReactionOverlay roomId={roomSnapshot.room.id} socket={socket} />
      </div>
    </section>
    </RoomLyricsPositionProvider>
  );
}

export const RoomStage = memo(RoomStageBase);

/** 位置从 RoomLyricsPositionProvider 读取,避免宿主布局以 10Hz 跟随重渲染。 */
const ContextProgressMobileStagePlayer = function ContextProgressMobileStagePlayer(
  props: Omit<ComponentProps<typeof MobileRoomStagePlayer>, "progressMs">
) {
  const progressMs = useRoomLyricsPositionMs();
  return <MobileRoomStagePlayer {...props} progressMs={progressMs} />;
};

const ContextPositionRoomLyricsPanel = memo(function ContextPositionRoomLyricsPanel(
  props: Omit<ComponentProps<typeof RoomLyricsPanel>, "positionMs">
) {
  const positionMs = useRoomLyricsPositionMs();
  return <RoomLyricsPanel {...props} positionMs={positionMs} />;
});

function MobileRoomStagePlayer({
  artworkPalette,
  artworkUrl,
  currentTrack,
  currentTrackDuration,
  isPlaying,
  playbackBarrier,
  playerStyle,
  progressMs
}: {
  artworkPalette: ReturnType<typeof useArtworkPalette>;
  artworkUrl: string | null;
  currentTrack: TrackMeta | null;
  currentTrackDuration: number;
  isPlaying: boolean;
  playbackBarrier?: RoomPlaybackBarrierClock | null;
  playerStyle: ReturnType<typeof usePlayerStyle>;
  progressMs: number;
}) {
  const boundedProgressMs = currentTrackDuration > 0
    ? Math.min(Math.max(0, progressMs), currentTrackDuration)
    : 0;
  const progressPercent = currentTrackDuration > 0
    ? Math.round((boundedProgressMs / currentTrackDuration) * 100)
    : 0;
  const playbackLabel = playbackBarrier?.blocked ? "缓存中" : isPlaying ? "正在播放" : "准备就绪";

  return <div className="relative z-20 flex min-h-[22rem] flex-1 flex-col items-center justify-center px-5 pb-7 pt-4 text-center lg:hidden" data-room-mobile-player="true">
    <div className="relative flex w-full max-w-[22rem] flex-col items-center">
      <div className="relative aspect-square w-[min(56vw,15rem)]">
        {playerStyle === "square-cover" ? (
          <SquareAlbumCover artworkUrl={artworkUrl} className="h-full w-full rounded-2xl border border-white/10 shadow-[0_18px_44px_rgba(0,0,0,0.38)]" />
        ) : (
          <div className="relative flex h-full w-full items-center justify-center rounded-full border border-white/10 bg-black shadow-[0_18px_44px_rgba(0,0,0,0.38)]">
            <div className="absolute inset-[7%] overflow-hidden rounded-full border border-white/10 bg-white/[0.04]">
              {artworkUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img loading="lazy"
                  alt=""
                  className="h-full w-full object-cover"
                  referrerPolicy="no-referrer"
                  src={getArtworkSourceUrl(artworkUrl)}
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-xs text-white/45">音乐</div>
              )}
            </div>
            <div className="relative z-10 h-[18%] w-[18%] rounded-full border border-white/15 bg-black" style={{ boxShadow: `0 0 0 0.6rem ${artworkPalette.accentSoft}` }} />
          </div>
        )}
        <span className="absolute -bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap border px-2.5 py-1 font-mono text-xs font-semibold" style={{ borderColor: artworkPalette.border, backgroundColor: artworkPalette.accentSoft, color: artworkPalette.accent }}>{playbackLabel}</span>
      </div>

      <div className="mt-7 min-w-0 w-full">
        <h2 className="mx-auto max-w-[22ch] truncate text-xl font-semibold text-white">{currentTrack?.title ?? "等待节目开始"}</h2>
        <p className="mx-auto mt-1 max-w-[28ch] truncate text-sm text-white/60">{currentTrack ? `${currentTrack.artist}${currentTrack.album ? ` / ${currentTrack.album}` : ""}` : "主持人准备好节目后会在这里播放"}</p>
        <div className="mt-5 h-px w-full overflow-hidden bg-white/10"><div className="h-full transition-[width] duration-200" style={{ width: `${progressPercent}%`, backgroundColor: artworkPalette.accent }} /></div>
        <div className="mt-2 flex justify-between font-mono text-xs text-white/45"><span>{formatDuration(boundedProgressMs)}</span><span>{formatDuration(currentTrackDuration)}</span></div>
      </div>
    </div>
  </div>;
}
