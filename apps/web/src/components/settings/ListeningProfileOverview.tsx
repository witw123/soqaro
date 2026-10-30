"use client";

import { useEffect, useState } from "react";
import type { AuthSession, ProviderTrackCandidate } from "@soqaro/shared";
import { soqaroApi } from "@/lib/network/soqaro-api";
import { usePersonalizationProfile } from "@/features/personalization/use-personalization-profile";
import { useLocalPlayer } from "@/features/playback/local-player-context";
import { useFavoriteTracks } from "@/features/favorites/use-favorite-tracks";
import {
  buildPlaybackStatusMessage,
  prepareTrackForImmediatePlayback
} from "@/features/playback/provider-playback-preparation";
import { toProviderTrackRecord } from "@/features/playlist/local-playlist";
import { MediaArtwork } from "@/components/ui/media-artwork";
import { TasteExclusionsManager } from "@/components/discovery/TasteExclusionsManager";
import {
  PlayIcon,
  RadioIcon,
  MusicIcon,
  LandmarkIcon,
  BarChartIcon,
  SlidersIcon
} from "@/components/icons/DiscoverIcons";

const sourceConfig = {
  netease: { label: "网易云音乐", color: "bg-[#fa233b]", dot: "#fa233b", text: "text-[#fa233b]" },
  qqmusic: { label: "QQ 音乐", color: "bg-[#10b981]", dot: "#10b981", text: "text-[#10b981]" },
  local_upload: { label: "本地音频", color: "bg-[#94a3b8]", dot: "#94a3b8", text: "text-[#94a3b8]" }
} as const;

export function ListeningProfileOverview({
  activeSession,
  onOpenColdStart
}: {
  activeSession: AuthSession;
  onOpenColdStart?: () => void;
}) {
  const player = useLocalPlayer();
  const { favoriteTracks } = useFavoriteTracks(activeSession.userId);
  const { profile, loading } = usePersonalizationProfile();
  const [activeRadioTrackKey, setActiveRadioTrackKey] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [showAllTopTracks, setShowAllTopTracks] = useState(false);
  const [showAllTopArtists, setShowAllTopArtists] = useState(false);
  const [showExclusions, setShowExclusions] = useState(false);

  const handlePlayTrack = async (candidate: ProviderTrackCandidate) => {
    try {
      const prepared = await prepareTrackForImmediatePlayback(candidate);
      await player.playTrack(prepared.record);
      setStatusMessage(buildPlaybackStatusMessage(candidate.title, prepared.source));
    } catch {
      setStatusMessage(`播放《${candidate.title}》失败`);
    }
  };

  const handleStartTrackRadio = async (candidate: ProviderTrackCandidate) => {
    const key = `${candidate.provider}:${candidate.providerTrackId}`;
    setActiveRadioTrackKey(key);
    try {
      const radioTracks = await soqaroApi.getTrackRadio({ seedTrack: candidate, limit: 15 });
      const prepared = await prepareTrackForImmediatePlayback(candidate);
      const queuedTracks = radioTracks.slice(0, 10).map((nextTrack) => toProviderTrackRecord(nextTrack));
      await player.playTracks([prepared.record, ...queuedTracks], 0);
      setStatusMessage(`已开启从《${candidate.title}》出发的单曲漫游`);
    } catch {
      setStatusMessage(`开启漫游失败，请稍后重试`);
    } finally {
      setActiveRadioTrackKey(null);
    }
  };

  const handleTagClick = async (tagLabel: string) => {
    const seedTrack = profile?.topTracks[0] || profile?.recentTracks?.[0];
    if (seedTrack) {
      void handleStartTrackRadio(seedTrack);
      setStatusMessage(`已基于「${tagLabel}」偏好开启漫游电台`);
    } else if (onOpenColdStart) {
      onOpenColdStart();
    }
  };

  if (loading && !profile) {
    return <ProfileLoadingSkeleton />;
  }

  if (!profile || (profile.totalPlayCount === 0 && favoriteTracks.length === 0)) {
    return <ProfileEmptyState onOpenColdStart={onOpenColdStart} />;
  }

  const totalSourceTime = profile.sourceDistribution.reduce((acc, curr) => acc + curr.listenedMs, 0);
  const activeTasteGroups = profile.tasteGroups.filter((group) => group.tags.length > 0);
  const visibleTopTracks = showAllTopTracks ? profile.topTracks : profile.topTracks.slice(0, 5);
  const visibleTopArtists = showAllTopArtists ? profile.topArtists : profile.topArtists.slice(0, 5);

  return (
    <div className="profile-content space-y-4 sm:space-y-5 animate-in fade-in duration-300 pb-28 sm:pb-8 w-full max-w-full overflow-hidden">
      <StatusToast message={statusMessage} onDismiss={setStatusMessage} />

      {/* Taste & Genres: the identity core of the page — click a tag to start radio */}
      <section className="rounded-xl border border-surface-border bg-surface/40 p-4 sm:p-5">
        <div className="mb-4">
          <div className="flex items-center gap-2 min-w-0">
            <div className="p-1 rounded-lg bg-surface-elevated text-foreground-muted shrink-0">
              <SlidersIcon className="w-4 h-4 text-accent" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm sm:text-base font-bold text-foreground tracking-tight truncate">常听曲风与偏好</h3>
              <p className="text-xs text-foreground-muted truncate">点击标签，即刻开启对应的专属漫游电台</p>
            </div>
          </div>
        </div>

        {activeTasteGroups.length > 0 ? (
          <div className="space-y-4">
            {activeTasteGroups.map((group) => (
              <div key={group.id} className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-xs font-medium text-foreground-muted">{group.label}</h4>
                  <span className="text-xs text-foreground-muted/60">{group.tags.length} 项</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {group.tags.map((tag) => (
                    <button
                      key={`${group.id}:${tag.label}:${tag.source}`}
                      type="button"
                      onClick={() => void handleTagClick(tag.label)}
                      className="inline-flex max-w-full items-center gap-1.5 px-3.5 py-2 rounded-full text-[13px] font-medium bg-surface hover:bg-surface-hover text-foreground border border-surface-border hover:border-accent/50 hover:text-accent transition-all cursor-pointer overflow-hidden group"
                      title={`点击开启「${tag.label}」音乐漫游`}
                    >
                      <span className="truncate max-w-[180px] sm:max-w-[240px]">{tag.label}</span>
                      <RadioIcon className="w-3.5 h-3.5 text-foreground-muted group-hover:text-accent transition-colors shrink-0" />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-foreground-muted py-2">
            在房间听歌或收藏歌曲后，系统会自动为你统计常听曲风与习惯偏好。
          </p>
        )}
      </section>

      {/* Top Tracks & Top Artists */}
      <div className="grid gap-4 sm:gap-5 lg:grid-cols-2 items-start w-full max-w-full overflow-hidden">
        {/* Top Tracks */}
        <section className="rounded-xl border border-surface-border bg-surface/40 p-3.5 sm:p-5 w-full max-w-full overflow-hidden">
          <div className="flex items-center justify-between gap-2 mb-3.5">
            <div className="flex items-center gap-2">
              <div className="p-1 rounded-lg bg-surface-elevated text-foreground-muted">
                <BarChartIcon className="w-4 h-4 text-accent" />
              </div>
              <div>
                <h3 className="text-sm sm:text-base font-bold text-foreground tracking-tight">最常播放歌曲</h3>
                <p className="text-xs text-foreground-muted">收听频次最高的心动单曲</p>
              </div>
            </div>
            {profile.topTracks.length > 5 && (
              <button
                type="button"
                onClick={() => setShowAllTopTracks((prev) => !prev)}
                className="text-xs font-medium text-accent hover:underline cursor-pointer"
              >
                {showAllTopTracks ? "收起" : `展开 Top ${profile.topTracks.length}`}
              </button>
            )}
          </div>

          <div className="space-y-1">
            {visibleTopTracks.map((item, index) => {
              const itemKey = `${item.provider}:${item.providerTrackId}`;
              const isRadioRunning = activeRadioTrackKey === itemKey;
              const rankColor =
                index === 0
                  ? "text-amber-400 font-bold"
                  : index === 1
                  ? "text-slate-300 font-bold"
                  : index === 2
                  ? "text-amber-600 font-bold"
                  : "text-foreground-muted font-medium";

              return (
                <div
                  key={itemKey}
                  className="flex items-center gap-2 py-1.5 px-2 rounded-lg transition-colors hover:bg-surface-hover/60 group w-full min-w-0 overflow-hidden"
                >
                  <span className={`w-4 shrink-0 text-xs tabular-nums text-center ${rankColor}`}>
                    {index + 1}
                  </span>
                  <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-lg bg-surface-elevated border border-surface-border/40">
                    <Artwork alt="" className="h-full w-full object-cover block" src={item.artworkUrl} />
                  </div>
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <p className="truncate text-xs sm:text-sm font-semibold text-foreground group-hover:text-accent transition-colors" title={item.title}>
                      {item.title}
                    </p>
                    <p className="truncate text-xs text-foreground-muted" title={`${item.artist}${item.album ? ` / ${item.album}` : ""}`}>
                      {item.artist}{item.album ? ` / ${item.album}` : ""}
                    </p>
                  </div>
                  <div className="text-right shrink-0 whitespace-nowrap">
                    <span className="block text-xs font-semibold tabular-nums text-foreground">
                      {item.playCount} 次
                    </span>
                    <span className="hidden sm:block text-xs tabular-nums text-foreground-muted">
                      {formatDuration(item.listenedMs)}
                    </span>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => handlePlayTrack(item)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors cursor-pointer"
                      title="立即播放"
                    >
                      <PlayIcon className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={isRadioRunning}
                      onClick={() => handleStartTrackRadio(item)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-foreground-muted hover:text-accent hover:bg-accent/10 transition-colors cursor-pointer"
                      title="开启单曲漫游"
                    >
                      <RadioIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Top Artists & Source Distribution */}
        <div className="space-y-4 sm:space-y-5 w-full max-w-full overflow-hidden">
          {/* Top Artists */}
          <section className="rounded-xl border border-surface-border bg-surface/40 p-3.5 sm:p-5 w-full max-w-full overflow-hidden">
            <div className="flex items-center justify-between gap-2 mb-3.5">
              <div className="flex items-center gap-2">
                <div className="p-1 rounded-lg bg-surface-elevated text-foreground-muted">
                  <LandmarkIcon className="w-4 h-4 text-accent" />
                </div>
                <div>
                  <h3 className="text-sm sm:text-base font-bold text-foreground tracking-tight">常听歌手</h3>
                  <p className="text-xs text-foreground-muted">收听深度最高的音乐艺人</p>
                </div>
              </div>
              {profile.topArtists.length > 5 && (
                <button
                  type="button"
                  onClick={() => setShowAllTopArtists((prev) => !prev)}
                  className="text-xs font-medium text-accent hover:underline cursor-pointer"
                >
                  {showAllTopArtists ? "收起" : `展开 Top ${profile.topArtists.length}`}
                </button>
              )}
            </div>

            <div className="space-y-1">
              {visibleTopArtists.map((artist, index) => (
                <div
                  key={artist.name}
                  className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg transition-colors hover:bg-surface-hover/60 min-w-0 overflow-hidden"
                >
                  <span className="w-4 shrink-0 text-xs font-semibold tabular-nums text-foreground-muted text-center">
                    {index + 1}
                  </span>
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-elevated border border-surface-border/40 text-xs font-bold text-foreground">
                    {artist.name.slice(0, 1)}
                  </div>
                  <span className="min-w-0 flex-1 truncate text-xs sm:text-sm font-semibold text-foreground" title={artist.name}>
                    {artist.name}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-foreground-muted font-medium whitespace-nowrap pr-1">
                    {artist.playCount} 次
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* Multi-source Distribution */}
          {profile.sourceDistribution.length > 0 && totalSourceTime > 0 && (
            <section className="rounded-xl border border-surface-border bg-surface/40 p-3.5 sm:p-5 w-full max-w-full overflow-hidden">
              <h4 className="text-xs font-medium text-foreground-muted mb-3">音源收听分布</h4>
              <div className="h-2.5 w-full rounded-full bg-surface-elevated flex overflow-hidden p-0.5 gap-0.5 border border-surface-border/40">
                {profile.sourceDistribution.map((src) => {
                  const cfg = sourceConfig[src.source as keyof typeof sourceConfig] ?? {
                    label: src.source,
                    color: "bg-foreground-muted",
                    dot: "#94a3b8",
                    text: "text-foreground-muted"
                  };
                  const pct = Math.max(3, (src.listenedMs / totalSourceTime) * 100);
                  return (
                    <div
                      key={src.source}
                      style={{ width: `${pct}%` }}
                      className={`h-full rounded-full ${cfg.color} transition-all`}
                      title={`${cfg.label}: ${pct.toFixed(1)}%`}
                    />
                  );
                })}
              </div>

              <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 text-xs text-foreground-muted">
                {profile.sourceDistribution.map((src) => {
                  const cfg = sourceConfig[src.source as keyof typeof sourceConfig] ?? {
                    label: src.source,
                    color: "bg-foreground-muted",
                    dot: "#94a3b8",
                    text: "text-foreground-muted"
                  };
                  const pct = ((src.listenedMs / totalSourceTime) * 100).toFixed(0);
                  return (
                    <div key={src.source} className="flex items-center gap-1.5 min-w-0 truncate">
                      <span className={`w-2 h-2 rounded-full ${cfg.color} shrink-0`} />
                      <span className="truncate">{cfg.label}</span>
                      <span className="font-semibold text-foreground shrink-0">{pct}%</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </div>

      {/* Exclusions manager: a low-frequency tool, kept as a quiet inline entry */}
      <div className="flex justify-center pt-1">
        <button
          type="button"
          onClick={() => setShowExclusions((prev) => !prev)}
          className="inline-flex items-center gap-1 text-xs text-foreground-muted hover:text-foreground transition-colors cursor-pointer"
        >
          {showExclusions ? "收起屏蔽记录" : "管理屏蔽记录与负反馈"}
          <svg
            aria-hidden="true"
            className={`w-3 h-3 transition-transform duration-200 ${showExclusions ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {showExclusions ? (
        <section className="rounded-xl border border-surface-border bg-surface/40 p-3.5 sm:p-5">
          <TasteExclusionsManager onOpenColdStart={onOpenColdStart ?? (() => undefined)} />
        </section>
      ) : null}
    </div>
  );
}

function StatusToast({
  message,
  onDismiss
}: {
  message: string | null;
  onDismiss: (message: string | null) => void;
}) {
  useEffect(() => {
    if (!message) {
      return;
    }
    const timer = window.setTimeout(() => onDismiss(null), 4000);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss]);

  if (!message) {
    return null;
  }

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[90] flex justify-center px-4 md:bottom-24"
      role="status"
    >
      <p className="pointer-events-auto max-w-full truncate rounded-xl border border-surface-border bg-surface px-4 py-2.5 text-xs text-foreground shadow-md backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 duration-200">
        {message}
      </p>
    </div>
  );
}

function Artwork({ alt, src, className = "" }: { alt: string; src: string | null; className?: string }) {
  return <MediaArtwork alt={alt} src={src} rounded="md" containerClassName={className} />;
}

function ProfileLoadingSkeleton() {
  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="h-28 rounded-xl bg-surface/40 border border-surface-border animate-pulse" />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="h-64 rounded-xl bg-surface/40 border border-surface-border animate-pulse" />
        <div className="space-y-4">
          <div className="h-40 rounded-xl bg-surface/40 border border-surface-border animate-pulse" />
          <div className="h-20 rounded-xl bg-surface/40 border border-surface-border animate-pulse" />
        </div>
      </div>
    </div>
  );
}

function ProfileEmptyState({ onOpenColdStart }: { onOpenColdStart?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-6 rounded-xl border border-surface-border bg-surface/30 text-center">
      <div className="p-3 rounded-xl bg-surface-elevated border border-surface-border text-foreground-muted mb-3.5">
        <MusicIcon className="w-6 h-6 text-accent" />
      </div>
      <h3 className="text-base font-bold text-foreground">记录你的听歌足迹</h3>
      <p className="text-xs sm:text-sm text-foreground-muted max-w-sm mt-1 mb-5 leading-relaxed">
        在房间听歌、收藏歌曲或在电台收听后，这里会自动生成你的收听偏好与常听歌手。
      </p>
      {onOpenColdStart && (
        <button
          type="button"
          onClick={onOpenColdStart}
          className="px-5 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white font-medium text-xs shadow-xs transition-all active:scale-95 cursor-pointer"
        >
          挑选常听曲风与场景
        </button>
      )}
    </div>
  );
}

function formatDuration(durationMs: number) {
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000));
  if (totalMinutes < 60) {
    return `${totalMinutes} 分钟`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
}
