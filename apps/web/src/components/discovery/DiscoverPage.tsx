"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ProviderPlaylistDetail,
  ProviderTrackCandidate
} from "@soqaro/shared";
import { Button } from "@/components/ui/button";
import {
  ProviderAlbumTrackTable,
  ProviderPlaylistDetailView,
  ProviderSearchPage,
  type ProviderPlaylistPickerOption
} from "@/components/provider-search";
import type { AnchoredDialogAnchor } from "@/components/ui/anchored-dialog";
import { useSessionIdentity } from "@/features/session/use-session-identity";
import { soqaroApi } from "@/lib/network/soqaro-api";
import { useWorkspacePageActive } from "@/features/workspace/page-activity";
import { useFavoriteTracks } from "@/features/favorites/use-favorite-tracks";
import { useNetworkPlaylists } from "@/features/playlist/use-network-playlists";
import { useLocalPlayer } from "@/features/playback/local-player-context";
import {
  listMergedLocalPlaylistTracks,
  localPlaylistTrackId,
  toProviderTrackRecord,
  upsertLocalPlaylistTrack,
  type LocalPlaylistTrackRecord
} from "@/features/playlist/local-playlist";
import {
  buildPlaybackStatusMessage,
  prepareTrackForImmediatePlayback,
  toPlaybackPreparationErrorMessage
} from "@/features/playback/provider-playback-preparation";
import { downloadProviderTrackToLibrary } from "@/features/playback/provider-track-download";
import { useDiscoverRecommendations } from "@/features/discovery/use-discover-recommendations";
import {
  SlidersIcon,
  PlayIcon
} from "@/components/icons/DiscoverIcons";
import { useBackHandler } from "@/lib/desktop/use-back-handler";
import {
  TasteColdStartDialog,
  DiscoverSection,
  DiscoverArtistRail,
  DiscoverPlaylistRail,
  MoodStationRail,
  PlaylistPicker,
  Feedback,
  DiscoverEmptyState,
  DiscoverSkeleton,
  AppPageBackground,
  genreFilterPills,
  buildCuratedPlaylistCards,
  extractDiscoverArtists,
  providerTrackKey,
  providerPlaylistKey,
  toPlaylistTrackActions,
  toErrorMessage,
  moodStations,
  type Track,
  type Detail,
  type DiscoverPlaylistCard,
  type DiscoverTrackActions
} from "./index";

export function DiscoverPage() {
  const pageActive = useWorkspacePageActive();
  const { activeSession, hydrated } = useSessionIdentity({
    sessionStorageKey: "soqaro-session",
    initialStatusMessage: ""
  });
  const player = useLocalPlayer();
  const {
    isFavorite: isFavoriteTrack,
    pendingFavoriteKey,
    toggleFavorite: toggleFavoriteTrack
  } = useFavoriteTracks(activeSession?.userId);
  const {
    data: discoverData,
    isLoading: discoverLoading,
    error: discoverError,
    refetch: refetchDiscover
  } = useDiscoverRecommendations(activeSession?.userId, pageActive);
  const data = discoverData ?? null;
  const loading = discoverLoading && !data;
  const [actionErrorMessage, setErrorMessage] = useState<string | null>(null);
  const errorMessage = actionErrorMessage ?? (discoverError ? toErrorMessage(discoverError) : null);
  const detailRequestVersionRef = useRef(0);
  const detailAbortRef = useRef<AbortController | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  useBackHandler(() => setDetail(null), detail !== null);
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const { playlists: networkPlaylists } = useNetworkPlaylists(activeSession?.userId, pageActive);

  const favoritePlaylistKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const pl of networkPlaylists) {
      for (const tag of pl.tags) {
        if (tag.startsWith("network:")) {
          const parts = tag.split(":");
          if (parts.length >= 3) {
            keys.add(`${parts[1]}:${parts.slice(2).join(":")}`);
          }
        }
      }
    }
    return keys;
  }, [networkPlaylists]);

  const [playlistPickerTrack, setPlaylistPickerTrack] = useState<Track | null>(null);
  const [playlistPickerAnchor, setPlaylistPickerAnchor] = useState<AnchoredDialogAnchor | null>(null);
  const [playlistPickerOptions, setPlaylistPickerOptions] = useState<ProviderPlaylistPickerOption[]>([]);
  const [playlistPickerLoading, setPlaylistPickerLoading] = useState(false);
  const [activeFilterId, setActiveFilterId] = useState<string>("all");
  const [showColdStartDialog, setShowColdStartDialog] = useState(false);
  const [localTracks, setLocalTracks] = useState<LocalPlaylistTrackRecord[]>([]);
  const [isSearchActive, setIsSearchActive] = useState(false);
  const [searchKeywords, setSearchKeywords] = useState("");

  useEffect(() => {
    if (!pageActive) return;
    let cancelled = false;
    void listMergedLocalPlaylistTracks().then((tracks) => {
      if (!cancelled) setLocalTracks(tracks);
    });
    return () => {
      cancelled = true;
    };
  }, [activeSession, pageActive]);

  const load = useCallback(async (_force = false) => {
    await refetchDiscover();
  }, [refetchDiscover]);

  async function resolveTrackArtwork(track: Track) {
    if (track.artworkUrl) return track;
    try {
      return track.provider === "netease"
        ? await soqaroApi.getNeteaseTrack(track.providerTrackId)
        : await soqaroApi.getQqMusicTrack(track.providerTrackId);
    } catch {
      return track;
    }
  }

  async function downloadTrack(track: Track): Promise<boolean> {
    const existing = localTracks.find((item) => item.id === localPlaylistTrackId(track));
    if (existing?.availableOffline) return true;
    if (pending) return false;
    setPending(`download:${track.provider}:${track.providerTrackId}`);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const updatedTrack = await downloadProviderTrackToLibrary({ track, existing });
      setLocalTracks((current) => [...current.filter((item) => item.id !== updatedTrack.id), updatedTrack]);
      setStatusMessage(`《${updatedTrack.title}》已下载到本地音乐目录。`);
      return true;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "歌曲下载失败，请稍后重试。");
      return false;
    } finally {
      setPending(null);
    }
  }

  async function openPlaylistPicker(track: Track, anchor: AnchoredDialogAnchor) {
    if (pending) return;
    setPlaylistPickerTrack(track);
    setPlaylistPickerAnchor(anchor);
    setPlaylistPickerLoading(false);
    setPlaylistPickerOptions(
      networkPlaylists.map((playlist) => ({ kind: "network" as const, playlist }))
    );
    setErrorMessage(null);
  }

  async function addTrackToPlaylist(option: ProviderPlaylistPickerOption) {
    const track = playlistPickerTrack;
    if (!track || pending) return;
    setPending(`add-playlist:${option.kind}:${option.playlist.id}:${track.providerTrackId}`);
    setErrorMessage(null);
    try {
      const resolvedTrack = await resolveTrackArtwork(track);
      const trackId = localPlaylistTrackId(resolvedTrack);
      try {
        await upsertLocalPlaylistTrack(toProviderTrackRecord(resolvedTrack));
      } catch {
        // The network playlist remains authoritative when local metadata storage is unavailable.
      }
      if (option.playlist.trackIds.includes(trackId)) {
        setStatusMessage(`《${resolvedTrack.title}》已在“${option.playlist.title}”中。`);
      } else {
        await soqaroApi.updatePlaylist(option.playlist.id, { trackIds: [...option.playlist.trackIds, trackId] });
        setStatusMessage(`《${resolvedTrack.title}》已加入“${option.playlist.title}”。`);
      }
      setPlaylistPickerTrack(null);
      setPlaylistPickerAnchor(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "加入歌单失败，请稍后重试。");
    } finally {
      setPending(null);
    }
  }

  const playDailyRadarAll = async (tracks: Track[]) => {
    if (!tracks.length) return;
    try {
      setPending("dailyRadar");
      setErrorMessage(null);
      await player.playTracks(tracks.map((track) => toProviderTrackRecord(track)));
      setStatusMessage(`已开启今日聚焦全部 ${tracks.length} 首歌曲播放`);
    } catch (error) {
      setErrorMessage(toPlaybackPreparationErrorMessage(error, "播放聚焦歌曲失败，请稍后重试。"));
    } finally {
      setPending(null);
    }
  };

  const trackActions: DiscoverTrackActions = {
    pending,
    isFavorite: (track) => isFavoriteTrack(track),
    isFavoritePending: (track) => pendingFavoriteKey === `${track.provider}:${track.providerTrackId}`,
    isDownloaded: (track) => localTracks.some((item) => item.id === localPlaylistTrackId(track) && item.availableOffline),
    isQueued: (track) => player.queue.some((item) => item.trackId === localPlaylistTrackId(track)),
    onPlay: async (track) => {
      setPending(`play:${track.provider}:${track.providerTrackId}`);
      setErrorMessage(null);
      try {
        const prepared = await prepareTrackForImmediatePlayback(track);
        await player.playTrack(prepared.record);
        setStatusMessage(buildPlaybackStatusMessage(track.title, prepared.source));
      } catch (error) {
        setErrorMessage(toPlaybackPreparationErrorMessage(error, `《${track.title}》播放失败，请稍后重试。`));
      } finally {
        setPending(null);
      }
    },
    onQueue: async (track) => {
      setPending(`queue:${track.provider}:${track.providerTrackId}`);
      setErrorMessage(null);
      try {
        // Queueing prepares the audio too, otherwise the queued item could
        // never start playing once its turn arrives.
        const prepared = await prepareTrackForImmediatePlayback(track);
        player.addToQueue(prepared.record);
        setStatusMessage(`已将《${track.title}》加入播放队列`);
      } catch (error) {
        setErrorMessage(toPlaybackPreparationErrorMessage(error, `《${track.title}》加入队列失败，请稍后重试。`));
      } finally {
        setPending(null);
      }
    },
    onDownload: (track) => {
      void downloadTrack(track);
    },
    onAddToPlaylist: (track, anchor) => {
      void openPlaylistPicker(track, anchor);
    },
    onStartRadio: async (track) => {
      try {
        const radioTracks = await soqaroApi.getTrackRadio({ seedTrack: track, limit: 15 });
        const prepared = await prepareTrackForImmediatePlayback(track);
        const queuedTracks = radioTracks.slice(0, 10).map((nextTrack) => toProviderTrackRecord(nextTrack));
        await player.playTracks([prepared.record, ...queuedTracks], 0);
        setStatusMessage(`已开启从《${track.title}》出发的单曲漫游`);
      } catch (error) {
        setErrorMessage(toPlaybackPreparationErrorMessage(error, "开启漫游失败，请稍后重试。"));
      }
    },
    onToggleFavorite: async (track) => {
      await toggleFavoriteTrack(track as ProviderTrackCandidate);
    },
    onFeedback: () => {}
  };

  const playPlaylistAll = useCallback(async (tracks: Track[], title?: string) => {
    if (!tracks.length) return;
    try {
      setPending("playPlaylist");
      setErrorMessage(null);
      await player.playTracks(tracks.map((track) => toProviderTrackRecord(track)));
      setStatusMessage(title ? `正在播放歌单《${title}》` : `已开启全部 ${tracks.length} 首歌曲播放`);
    } catch (error) {
      setErrorMessage(toPlaybackPreparationErrorMessage(error, "播放歌单歌曲失败，请稍后重试。"));
    } finally {
      setPending(null);
    }
  }, [player]);

  const toggleFavoritePlaylist = async (playlistDetail: ProviderPlaylistDetail) => {
    const key = providerPlaylistKey(playlistDetail.provider, playlistDetail.providerPlaylistId);
    if (pending) return;
    setPending(`favorite-playlist:${key}`);
    setErrorMessage(null);
    try {
      if (favoritePlaylistKeys.has(key)) {
        const found = networkPlaylists.find((l) => l.tags.includes(`network:${key}`));
        if (found) {
          await soqaroApi.deletePlaylist(found.id);
        }
        setStatusMessage(`已取消收藏歌单《${playlistDetail.title}》。`);
      } else {
        await soqaroApi.createPlaylist({
          title: playlistDetail.title,
          description: playlistDetail.description,
          coverUrl: playlistDetail.artworkUrl ?? playlistDetail.tracks.find((t) => t.artworkUrl)?.artworkUrl ?? null,
          isCollaborative: false,
          tags: ["network", `network:${key}`, ...playlistDetail.tags].slice(0, 20),
          trackIds: playlistDetail.tracks.map((t) => `provider:${t.provider}:${t.providerTrackId}`)
        });
        await Promise.all(playlistDetail.tracks.map(async (track) => {
          try {
            await upsertLocalPlaylistTrack(toProviderTrackRecord(track));
          } catch {
            // The saved network playlist remains authoritative even if local cache fails
          }
        }));
        setStatusMessage(`《${playlistDetail.title}》已保存到我的歌单。`);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "操作歌单失败，请稍后重试。");
    } finally {
      setPending(null);
    }
  };

  const openPlaylist = async (card: DiscoverPlaylistCard) => {
    const { playlist } = card;
    const key = `playlist:${playlist.provider}:${playlist.providerPlaylistId}`;

    // If tracks are already present in memory (e.g. Daily Mix or curated genre playlists):
    if (card.tracks && card.tracks.length > 0) {
      setDetail({
        summary: playlist,
        value: {
          ...playlist,
          tracks: card.tracks
        }
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    // If it's a curated playlist with no tracks:
    if (playlist.providerPlaylistId.startsWith("soqaro-curated:")) {
      setDetail({
        summary: playlist,
        value: {
          ...playlist,
          tracks: []
        }
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    const version = ++detailRequestVersionRef.current;
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    setDetailLoading(key);
    try {
      const full = playlist.provider === "netease"
        ? await soqaroApi.getNeteasePlaylist(playlist.providerPlaylistId)
        : playlist.provider === "qqmusic"
          ? await soqaroApi.getQqMusicPlaylist(playlist.providerPlaylistId)
          : await soqaroApi.getBilibiliVideoParts(playlist.providerPlaylistId).then((parts) => ({
              provider: "bilibili" as const,
              providerPlaylistId: parts.bvid,
              title: parts.title,
              description: parts.rawTitle,
              artworkUrl: parts.artworkUrl,
              creatorName: parts.artist,
              tags: ["bilibili"],
              trackCount: parts.parts.length,
              tracks: parts.parts
            }));
      if (controller.signal.aborted || detailRequestVersionRef.current !== version) return;
      setDetail({
        summary: playlist,
        value: full
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      if (controller.signal.aborted || detailRequestVersionRef.current !== version) return;
      setErrorMessage(toErrorMessage(err));
    } finally {
      if (detailRequestVersionRef.current === version) setDetailLoading(null);
    }
  };

  const playPlaylistCard = useCallback(async (card: DiscoverPlaylistCard) => {
    const { playlist } = card;
    const playKey = `play:playlist:${playlist.provider}:${playlist.providerPlaylistId}`;
    setDetailLoading(playKey);
    try {
      let tracks = card.tracks;
      if (!tracks || !tracks.length) {
        if (!playlist.providerPlaylistId.startsWith("soqaro-curated:")) {
          const full = playlist.provider === "netease"
            ? await soqaroApi.getNeteasePlaylist(playlist.providerPlaylistId)
            : playlist.provider === "qqmusic"
              ? await soqaroApi.getQqMusicPlaylist(playlist.providerPlaylistId)
              : await soqaroApi.getBilibiliVideoParts(playlist.providerPlaylistId).then((parts) => ({
                  tracks: parts.parts
                }));
          tracks = full.tracks;
        }
      }
      if (tracks && tracks.length > 0) {
        await playPlaylistAll(tracks, playlist.title);
      } else {
        setErrorMessage(`歌单《${playlist.title}》暂无可用曲目。`);
      }
    } catch (err) {
      setErrorMessage(toErrorMessage(err));
    } finally {
      setDetailLoading(null);
    }
  }, [playPlaylistAll]);

  if (!hydrated) return <div className="min-h-[calc(100*var(--app-dvh))] bg-background" />;

  if (detail) {
    return (
      <main className="workspace-page hide-scrollbar relative overflow-y-auto selection:bg-accent/30 selection:text-white md:pl-60 lg:pb-28">
        <AppPageBackground />
        <div className="workspace-page__inner workspace-page__inner--wide pt-[calc(0.75rem+env(safe-area-inset-top))] pb-[calc(var(--room-mobile-bottom-inset)+2rem)] sm:pt-6 md:pt-8 md:pb-24">
          <ProviderPlaylistDetailView
            isFavorite={favoritePlaylistKeys.has(providerPlaylistKey(detail.value.provider, detail.value.providerPlaylistId))}
            onBack={() => setDetail(null)}
            onPlayAll={(tracks) => playPlaylistAll(tracks, detail.value.title)}
            onToggleFavorite={() => toggleFavoritePlaylist(detail.value)}
            pending={pending}
            playlist={detail.value}
            trackActions={toPlaylistTrackActions(trackActions)}
          />
          <Feedback errorMessage={errorMessage} statusMessage={statusMessage} />
        </div>
        <PlaylistPicker
          anchor={playlistPickerAnchor}
          loading={playlistPickerLoading}
          pending={pending}
          track={playlistPickerTrack}
          options={playlistPickerOptions}
          onClose={() => {
            if (!pending) {
              setPlaylistPickerTrack(null);
              setPlaylistPickerAnchor(null);
            }
          }}
          onSelect={addTrackToPlaylist}
        />
      </main>
    );
  }

  const activeFilter = genreFilterPills.find((pill) => pill.id === activeFilterId);
  const matchesFilter = (text: string) => {
    if (!activeFilter || activeFilter.id === "all") return true;
    const lower = text.toLowerCase();
    return (activeFilter.keywords ?? []).some((kw) => lower.includes(kw.toLowerCase()));
  };

  const filterTrackList = (list: { candidate: Track; reasons: string[] }[]) => {
    if (activeFilterId === "all") return list;
    return list.filter((item) =>
      matchesFilter(item.candidate.title) ||
      matchesFilter(item.candidate.artist) ||
      matchesFilter(item.candidate.album ?? "") ||
      (item.candidate.tags ?? []).some(matchesFilter) ||
      item.reasons.some(matchesFilter)
    );
  };

  const curatedPlaylists = data ? buildCuratedPlaylistCards(data) : [];
  const recommendedPlaylists: DiscoverPlaylistCard[] = data
    ? [...data.playlists, ...curatedPlaylists]
    : [];
  const filteredPlaylists = activeFilterId === "all"
    ? recommendedPlaylists
    : recommendedPlaylists.filter((p) => matchesFilter(p.playlist.title) || matchesFilter(p.playlist.description ?? "") || (p.playlist.tags ?? []).some(matchesFilter));

  const allRecommendedTracks = data
    ? [...data.forYou, ...data.deepCuts, ...data.moodDiscovery, ...data.familiarArtists]
    : [];
  const filteredTopTracks = filterTrackList(allRecommendedTracks).map((item) => item.candidate).slice(0, 10);
  const familiarArtists = data ? extractDiscoverArtists(data) : [];

  const topArtistItem = data?.familiarArtists[0] || data?.forYou[0];
  const topArtist = topArtistItem?.candidate.artist ?? null;
  const inspiredTracks = topArtist
    ? Array.from(
        new Map(
          allRecommendedTracks
            .filter(
              (item) =>
                item.candidate.artist.toLowerCase().includes(topArtist.toLowerCase()) ||
                item.reasons.some((r) => r.includes(topArtist))
            )
            .map((item) => [providerTrackKey(item.candidate), item.candidate])
        ).values()
      ).slice(0, 6)
    : [];

  const deepCutTracks = (data?.deepCuts ?? []).map((i) => i.candidate).slice(0, 6);
  const dailyMixCards = recommendedPlaylists.filter((p) => p.playlist.providerPlaylistId.startsWith("soqaro-curated:daily-mix-"));
  const otherPlaylists = filteredPlaylists.filter((p) => !p.playlist.providerPlaylistId.startsWith("soqaro-curated:daily-mix-"));

  const hasContent = Boolean(data?.forYou.length || data?.familiarArtists.length || data?.moodDiscovery.length || data?.deepCuts.length || data?.playlists.length);
  const noProfile = Boolean(data && !hasContent);
  const noAccounts = Boolean(data && data.providers.length === 0);

  const playMoodStation = async (station: (typeof moodStations)[0]) => {
    setPending(`mood:${station.id}`);
    try {
      const allPool = [
        ...(data?.dailyRadar?.tracks ?? []),
        ...(data?.forYou ?? []).map((i) => i.candidate),
        ...(data?.moodDiscovery ?? []).map((i) => i.candidate),
        ...(data?.deepCuts ?? []).map((i) => i.candidate),
        ...(data?.familiarArtists ?? []).map((i) => i.candidate)
      ];
      const uniquePool = Array.from(
        new Map(allPool.map((t) => [providerTrackKey(t), t])).values()
      );
      const matched = uniquePool.filter((track) => {
        const text = `${track.title} ${track.artist} ${track.album ?? ""} ${(track.tags ?? []).join(" ")}`.toLowerCase();
        return (station.keywords ?? []).some((kw) => text.includes(kw.toLowerCase()));
      });
      const tracksToPlay = matched.length > 0 ? matched : uniquePool;
      if (tracksToPlay.length > 0) {
        await player.playTracks(
          tracksToPlay.slice(0, 10).map((t) => toProviderTrackRecord(t))
        );
        setStatusMessage(`正在播放「${station.title}」专属场景电台`);
      }
    } catch (error) {
      setErrorMessage(toPlaybackPreparationErrorMessage(error, "播放电台失败，请稍后重试。"));
    } finally {
      setPending(null);
    }
  };

  return (
    <main className="workspace-page hide-scrollbar relative overflow-y-auto selection:bg-accent/30 selection:text-white md:pl-60 lg:pb-28">
      <AppPageBackground />
      <div className="workspace-page__inner workspace-page__inner--wide pb-[calc(var(--room-mobile-bottom-inset)+2rem)] pt-[calc(0.75rem+env(safe-area-inset-top))] sm:pt-6 md:pt-8 md:pb-20">
        {/* Desktop Page Header */}
        {!isSearchActive ? (
          <header className="mb-3 hidden md:flex items-end justify-between">
            <div>
              <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">
                发现
              </h1>
            </div>
          </header>
        ) : null}

        {/* Mobile Page Header for proper ergonomics without dividing border */}
        {!isSearchActive ? (
          <header className="mb-2.5 flex items-center justify-between md:hidden">
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-foreground">
                发现
              </h1>
            </div>
            <Link
              aria-label="打开个人中心"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-surface-border bg-surface text-foreground-muted shadow-sm transition-all hover:bg-surface-hover hover:text-foreground active:scale-95"
              href="/app/profile"
            >
              <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8"><circle cx="12" cy="8" r="3.5" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></svg>
            </Link>
          </header>
        ) : null}

        {/* Search header integration */}
        <ProviderSearchPage
          embedded
          isSearchActive={isSearchActive}
          keywords={searchKeywords}
          onBackToRecommendations={() => {
            setIsSearchActive(false);
            setSearchKeywords("");
          }}
          onKeywordsChange={setSearchKeywords}
          onSearchActiveChange={setIsSearchActive}
        />

        {!isSearchActive ? (
          <>
            {/* Genre Filter Pills */}
            <div className="mt-2.5 mb-3 flex items-center gap-1.5 overflow-x-auto pb-1 hide-scrollbar touch-pan-x">
              {genreFilterPills.map((pill) => {
                const active = activeFilterId === pill.id;
                return (
                  <button
                    key={pill.id}
                    type="button"
                    onClick={() => setActiveFilterId(pill.id)}
                    className={`inline-flex items-center h-7 px-3 rounded-full text-xs font-medium whitespace-nowrap transition-all duration-150 cursor-pointer select-none ${
                      active
                        ? "bg-accent/15 text-accent border border-accent/35 font-semibold"
                        : "bg-surface/80 border border-surface-border text-foreground-muted hover:text-foreground hover:bg-surface-hover/80"
                    }`}
                  >
                    {pill.label}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setShowColdStartDialog(true)}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs font-medium text-foreground-muted hover:text-foreground bg-surface/80 hover:bg-surface-hover/80 border border-surface-border ml-auto shrink-0 transition-colors cursor-pointer"
                title="偏好设置"
              >
                <SlidersIcon className="w-3.5 h-3.5 text-foreground-muted" />
                <span className="hidden sm:inline">偏好设置</span>
              </button>
            </div>

            {loading && !data ? <DiscoverSkeleton /> : null}

            {/* Filtered Genre Radar Spotlight */}
            {activeFilterId !== "all" && filteredTopTracks.length > 0 ? (
              <section className="relative mb-6 overflow-hidden rounded-xl p-2 sm:p-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                  <div className="space-y-0.5">
                    <h2 className="text-base sm:text-lg font-bold text-foreground tracking-tight">{activeFilter?.label}精选</h2>
                  </div>
                  <Button
                    type="button"
                    disabled={pending !== null}
                    onClick={() => playDailyRadarAll(filteredTopTracks)}
                    size="sm"
                    className="h-7 px-3 rounded-lg bg-accent hover:bg-accent-hover text-white text-xs font-medium shadow-xs transition-all active:scale-95 self-start sm:self-auto"
                  >
                    <PlayIcon className="w-3 h-3 mr-1" />
                    <span>播放全部</span>
                  </Button>
                </div>
                <div className="pt-2">
                  <div className="max-h-[560px] overflow-y-auto hide-scrollbar">
                    <ProviderAlbumTrackTable
                      actions={toPlaylistTrackActions(trackActions)}
                      showToolbar={false}
                      tracks={filteredTopTracks}
                    />
                  </div>
                </div>
              </section>
            ) : null}

            {!loading && noAccounts ? (
              <DiscoverEmptyState
                title="连接音乐平台后开始发现"
                description="绑定网易云音乐或 QQ 音乐账号，我们将从你的常听曲目生成个性化推荐。"
                actionHref="/app/settings"
                actionLabel="前往绑定"
              />
            ) : null}
            {!loading && !noAccounts && noProfile ? (
              <DiscoverEmptyState
                title="发现更多好音乐"
                description="在 Soqaro 播放或收藏歌曲，或通过偏好设置选择喜爱的曲风与艺人。"
                actionLabel="定制聆听偏好"
                onAction={() => setShowColdStartDialog(true)}
              />
            ) : null}
            {!loading && !noAccounts && !noProfile && !hasContent ? (
              <DiscoverEmptyState
                title="暂无新内容"
                description="可以稍后刷新，或继续聆听几首歌曲来丰富推荐内容。"
                actionLabel="重新加载"
                onAction={() => void load()}
              />
            ) : null}

            {/* Section 1: Daily Mix */}
            {dailyMixCards.length && activeFilterId === "all" ? (
              <DiscoverSection
                title="专为你推荐"
                subtitle="根据近期聆听生成"
              >
                <DiscoverPlaylistRail items={dailyMixCards} loadingKey={detailLoading} onOpen={openPlaylist} onPlay={playPlaylistCard} />
              </DiscoverSection>
            ) : null}

            {/* Section 2: Familiar Artists */}
            {familiarArtists.length && activeFilterId === "all" ? (
              <DiscoverArtistRail
                artists={familiarArtists}
                onStartRadio={async (track) => trackActions.onStartRadio(track)}
                pending={pending}
              />
            ) : null}

            {/* Section 3: Mood & Atmosphere Stations */}
            {activeFilterId === "all" ? (
              <MoodStationRail onPlayStation={playMoodStation} pending={pending} />
            ) : null}

            {/* Section 4: Contextual Attribution - Inspired By Top Artist */}
            {inspiredTracks.length > 0 && topArtist && activeFilterId === "all" ? (
              <DiscoverSection
                title={`来自 ${topArtist} 的相关推荐`}
              >
                <div className="rounded-xl">
                  <ProviderAlbumTrackTable
                    actions={toPlaylistTrackActions(trackActions)}
                    showToolbar={false}
                    tracks={inspiredTracks}
                  />
                </div>
              </DiscoverSection>
            ) : null}

            {/* Section 5: Deep Cuts */}
            {deepCutTracks.length > 0 && activeFilterId === "all" ? (
              <DiscoverSection
                title="单曲精选"
                subtitle="值得细品的小众与慢热佳作"
              >
                <div className="rounded-xl">
                  <ProviderAlbumTrackTable
                    actions={toPlaylistTrackActions(trackActions)}
                    showToolbar={false}
                    tracks={deepCutTracks}
                  />
                </div>
              </DiscoverSection>
            ) : null}

            {/* Section 6: Playlists */}
            {otherPlaylists.length ? (
              <DiscoverSection
                title={activeFilterId === "all" ? "精选歌单" : `${activeFilter?.label ?? ""}歌单`}
              >
                <DiscoverPlaylistRail items={otherPlaylists} loadingKey={detailLoading} onOpen={openPlaylist} onPlay={playPlaylistCard} />
              </DiscoverSection>
            ) : null}
          </>
        ) : null}

        <Feedback errorMessage={errorMessage} statusMessage={statusMessage} />
      </div>

      <PlaylistPicker
        anchor={playlistPickerAnchor}
        loading={playlistPickerLoading}
        pending={pending}
        track={playlistPickerTrack}
        options={playlistPickerOptions}
        onClose={() => {
          if (!pending) {
            setPlaylistPickerTrack(null);
            setPlaylistPickerAnchor(null);
          }
        }}
        onSelect={addTrackToPlaylist}
      />

      <TasteColdStartDialog
        isOpen={showColdStartDialog}
        onClose={() => setShowColdStartDialog(false)}
        onCompleted={() => void load()}
      />
    </main>
  );
}
