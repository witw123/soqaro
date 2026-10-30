"use client";

import { useEffect, useState } from "react";
import type { ProviderAlbumDetail, ProviderAlbumFavorite, ProviderArtistFavorite, ProviderTrackCandidate } from "@soqaro/shared";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Button } from "@/components/ui/button";
import {
  ProviderAlbumDetailView,
  ProviderAlbumTrackTable,
  ProviderPlaylistPickerDialog,
  type ProviderAlbumTrackActions,
  type ProviderPlaylistPickerOption
} from "@/components/provider-search";
import { useSessionIdentity } from "@/features/session/use-session-identity";
import { buildWorkspaceAuthHref } from "@/lib/domain/client-shell";
import { SoqaroApiError, soqaroApi } from "@/lib/network/soqaro-api";
import { useFavoriteAlbums } from "@/features/favorites/use-favorite-albums";
import { useFavoriteArtists } from "@/features/favorites/use-favorite-artists";
import { useLocalPlayer } from "@/features/playback/local-player-context";
import {
  providerPlaybackCacheChangedEvent
} from "@/features/playback/provider-track-cache";
import {
  buildPlaybackStatusMessage,
  prepareTrackForImmediatePlayback,
  toPlaybackPreparationErrorMessage
} from "@/features/playback/provider-playback-preparation";
import { downloadProviderTrackToLibrary } from "@/features/playback/provider-track-download";
import {
  listMergedLocalPlaylistTracks,
  localPlaylistTrackId,
  toProviderTrackRecord,
  upsertLocalPlaylistTrack,
  type LocalPlaylistTrackRecord
} from "@/features/playlist/local-playlist";
import { type AnchoredDialogAnchor } from "@/components/ui/anchored-dialog";
import { MediaArtwork } from "@/components/ui/media-artwork";
import { useFavoriteTracks, favoriteTrackToCandidate } from "@/features/favorites/use-favorite-tracks";
import { useNetworkPlaylists } from "@/features/playlist/use-network-playlists";
import { useBackHandler } from "@/lib/desktop/use-back-handler";

type Track = ProviderTrackCandidate;

export function FavoriteAlbumsPage({
  embedded = false,
  fixedHeight = true,
  showTitle = true,
  onBack
}: {
  embedded?: boolean;
  fixedHeight?: boolean;
  showTitle?: boolean;
  onBack?: () => void;
}) {
  const router = useRouter();
  const authEntryHref = buildWorkspaceAuthHref({ redirectTo: "/app/profile" });
  const { activeSession, hydrated } = useSessionIdentity({
    sessionStorageKey: "soqaro-session",
    initialStatusMessage: ""
  });
  const player = useLocalPlayer();
  const [favoriteView, setFavoriteView] = useState<"tracks" | "albums" | "artists">("tracks");
  const {
    favoriteTracks,
    isFavorite: isFavoriteTrack,
    loading: favoriteTracksLoading,
    pendingFavoriteKey,
    toggleFavorite: toggleFavoriteTrack
  } = useFavoriteTracks(activeSession?.userId);
  const {
    albums: items,
    isLoading: albumsLoading,
    deleteFavoriteAlbum
  } = useFavoriteAlbums(activeSession?.userId);
  const {
    artists,
    isLoading: artistsLoading,
    deleteFavoriteArtist
  } = useFavoriteArtists(activeSession?.userId);
  const { playlists: networkPlaylists } = useNetworkPlaylists(activeSession?.userId);
  const favoritesLoaded = !albumsLoading && !artistsLoading;
  const [detail, setDetail] = useState<ProviderAlbumDetail | null>(null);
  useBackHandler(() => setDetail(null), detail !== null);
  const [pending, setPending] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [localTracks, setLocalTracks] = useState<LocalPlaylistTrackRecord[]>([]);
  const [playbackTracks, setPlaybackTracks] = useState<LocalPlaylistTrackRecord[]>([]);
  const [playlistPickerTrack, setPlaylistPickerTrack] = useState<Track | null>(null);
  const [playlistPickerAnchor, setPlaylistPickerAnchor] = useState<AnchoredDialogAnchor | null>(null);
  const [playlistPickerOptions, setPlaylistPickerOptions] = useState<ProviderPlaylistPickerOption[]>([]);
  const [playlistPickerLoading, setPlaylistPickerLoading] = useState(false);
  useEffect(() => {
    if (hydrated && !activeSession) router.replace(authEntryHref as Route);
  }, [activeSession, authEntryHref, hydrated, router]);

  useEffect(() => {
    let cancelled = false;
    void listMergedLocalPlaylistTracks().then((tracks) => {
      if (!cancelled) setLocalTracks(tracks);
    });
    return () => {
      cancelled = true;
    };
  }, [activeSession]);

  useEffect(() => {
    const handlePlaybackCacheChange = (event: Event) => {
      const detail = (event as CustomEvent<{ fileHashes?: string[]; kind?: "add" | "remove" }>).detail ?? {};
      if (detail.kind && detail.kind !== "remove") return;
      const fileHashes = new Set(detail.fileHashes ?? []);
      setPlaybackTracks((current) => current.filter((track) => !fileHashes.has(track.fileHash ?? "")));
    };
    window.addEventListener(providerPlaybackCacheChangedEvent, handlePlaybackCacheChange);
    return () => window.removeEventListener(providerPlaybackCacheChangedEvent, handlePlaybackCacheChange);
  }, []);

  function getLocalRecord(track: Track) {
    return localTracks.find((item) => item.id === localPlaylistTrackId(track))
      ?? playbackTracks.find((item) => item.id === localPlaylistTrackId(track))
      ?? toProviderTrackRecord(track);
  }

  function toggleFavoriteSong(track: Track) {
    void toggleFavoriteTrack(track)
      .then(() => setStatusMessage(`已${isFavoriteTrack(track) ? "收藏" : "取消收藏"}《${track.title}》。`))
      .catch((error) => setErrorMessage(toErrorMessage(error)));
  }

  function favoriteTrackActions() {
    return {
      isDownloaded: (track: Track) => getLocalRecord(track).availableOffline,
      isPlayable: () => true,
      isQueueable: (track: Track) => player.isTrackPlayable(getLocalRecord(track)) || playbackTracks.some((item) => item.id === localPlaylistTrackId(track) && !!item.fileHash),
      isQueued: (track: Track) => player.queue.some((item) => item.trackId === getLocalRecord(track).id),
      isDownloading: (track: Track) => pending === `download:${track.provider}:${track.providerTrackId}`,
      isPreparingPlayback: (track: Track) => pending === `play:${track.provider}:${track.providerTrackId}` || pending === `queue:${track.provider}:${track.providerTrackId}`,
      onDownload: (track: Track) => void downloadTrack(track),
      onAddToQueue: (track: Track) => void queueFavoriteTrack(track),
      onPlay: (track: Track) => void playFavoriteTrack(track),
      onAddToPlaylist: (track: Track, anchor: AnchoredDialogAnchor) => void openPlaylistPicker(track, anchor),
      isFavorite: (track: Track) => isFavoriteTrack(track),
      isTogglingFavorite: (track: Track) => pendingFavoriteKey === `${track.provider}:${track.providerTrackId}`,
      onToggleFavorite: toggleFavoriteSong
    };
  }

  async function resolveTrackArtwork(track: Track) {
    if (track.artworkUrl) return track;
    try {
      return track.provider === "netease"
        ? await soqaroApi.getNeteaseTrack(track.providerTrackId)
        : track.provider === "qqmusic"
          ? await soqaroApi.getQqMusicTrack(track.providerTrackId)
          : track;
    } catch {
      return track;
    }
  }

  async function prepareFavoriteTrack(track: Track) {
    const prepared = await prepareTrackForImmediatePlayback(track);
    setPlaybackTracks((current) => [...current.filter((item) => item.id !== prepared.record.id), prepared.record]);
    return prepared;
  }

  async function queueFavoriteTrack(track: Track) {
    if (pending) return;
    setPending(`queue:${track.provider}:${track.providerTrackId}`);
    setErrorMessage(null);
    try {
      // Queueing prepares the audio too, otherwise the queued item could
      // never start playing once its turn arrives.
      const prepared = await prepareFavoriteTrack(track);
      player.addToQueue(prepared.record);
      setStatusMessage(`《${track.title}》已加入播放队列。`);
    } catch (error) {
      setErrorMessage(toPlaybackPreparationErrorMessage(error, `《${track.title}》加入队列失败，请稍后重试。`));
    } finally {
      setPending(null);
    }
  }

  async function playFavoriteTrack(track: Track) {
    if (pending) return;
    setPending(`play:${track.provider}:${track.providerTrackId}`);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const prepared = await prepareFavoriteTrack(track);
      await player.playTrack(prepared.record);
      setStatusMessage(buildPlaybackStatusMessage(track.title, prepared.source));
    } catch (error) {
      setErrorMessage(toPlaybackPreparationErrorMessage(error, `《${track.title}》播放失败，请稍后重试。`));
    } finally {
      setPending(null);
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
      setErrorMessage(toErrorMessage(error));
      return false;
    } finally {
      setPending(null);
    }
  }

  const [isDownloadingAll, setIsDownloadingAll] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState({ completed: 0, total: 0 });

  async function downloadAllFavoriteTracks() {
    const candidateTracks = favoriteTracks.map(favoriteTrackToCandidate);
    const downloadable = candidateTracks.filter((track) => !getLocalRecord(track).availableOffline);
    if (isDownloadingAll || pending || downloadable.length === 0) return;
    setIsDownloadingAll(true);
    setDownloadProgress({ completed: 0, total: downloadable.length });
    setErrorMessage(null);
    setStatusMessage(null);
    let downloadedCount = 0;
    let failedCount = 0;
    try {
      for (let index = 0; index < downloadable.length; index += 1) {
        const item = downloadable[index];
        const success = await downloadTrack(item);
        if (success) downloadedCount += 1;
        else failedCount += 1;
        setDownloadProgress({ completed: index + 1, total: downloadable.length });
      }
      setStatusMessage(
        failedCount > 0
          ? `已下载 ${downloadedCount} 首，${failedCount} 首下载失败。`
          : `已成功下载 ${downloadedCount} 首歌曲到本地。`
      );
    } finally {
      setIsDownloadingAll(false);
    }
  }

  async function playAllFavoriteTracks() {
    const candidateTracks = favoriteTracks.map(favoriteTrackToCandidate);
    if (candidateTracks.length === 0 || pending) return;
    try {
      setPending("playAllFavorites");
      setErrorMessage(null);
      setStatusMessage(null);
      await player.playTracks(candidateTracks.map(getLocalRecord));
      setStatusMessage(`已开启收藏全部 ${candidateTracks.length} 首歌曲播放`);
    } catch (error) {
      setErrorMessage(toPlaybackPreparationErrorMessage(error, "播放收藏歌曲失败，请稍后重试。"));
    } finally {
      setPending(null);
    }
  }

  async function openPlaylistPicker(track: Track, anchor: AnchoredDialogAnchor) {
    if (pending) return;
    setPlaylistPickerTrack(track);
    setPlaylistPickerAnchor(anchor);
    setPlaylistPickerLoading(false);
    setPlaylistPickerOptions(networkPlaylists.map((playlist) => ({ kind: "network" as const, playlist })));
    setStatusMessage(null);
  }

  async function addTrackToPlaylist(option: ProviderPlaylistPickerOption) {
    const track = playlistPickerTrack;
    if (!track || pending) return;
    setPending(`add-playlist:${option.playlist.id}:${track.providerTrackId}`);
    setErrorMessage(null);
    try {
      const resolvedTrack = await resolveTrackArtwork(track);
      const trackId = localPlaylistTrackId(resolvedTrack);
      const record = toProviderTrackRecord(resolvedTrack, localTracks.find((item) => item.id === trackId));
      await upsertLocalPlaylistTrack(record);
      setLocalTracks((current) => [...current.filter((item) => item.id !== record.id), record]);
      if (!option.playlist.trackIds.includes(trackId)) {
        await soqaroApi.updatePlaylist(option.playlist.id, { trackIds: [...option.playlist.trackIds, trackId] });
        setStatusMessage(`《${resolvedTrack.title}》已加入“${option.playlist.title}”。`);
      } else {
        setStatusMessage(`《${resolvedTrack.title}》已在“${option.playlist.title}”中。`);
      }
      setPlaylistPickerTrack(null);
      setPlaylistPickerAnchor(null);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setPending(null);
    }
  }

  async function openAlbum(item: ProviderAlbumFavorite) {
    if (pending) return;
    setPending(`open:${item.id}`);
    setErrorMessage(null);
    try {
      const nextDetail = item.provider === "netease"
        ? await soqaroApi.getNeteaseAlbum(item.providerAlbumId)
        : item.provider === "qqmusic"
          ? await soqaroApi.getQqMusicAlbum(item.providerAlbumId)
          : await soqaroApi.getBilibiliVideoParts(item.providerAlbumId).then((partsDetail) => ({
              provider: "bilibili" as const,
              providerAlbumId: partsDetail.bvid,
              title: partsDetail.title,
              artist: partsDetail.artist,
              description: partsDetail.rawTitle,
              artworkUrl: partsDetail.artworkUrl,
              releaseTime: null,
              trackCount: partsDetail.parts.length,
              tracks: partsDetail.parts
            }));
      setDetail(nextDetail);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setPending(null);
    }
  }

  async function removeAlbum(item: ProviderAlbumFavorite) {
    if (!activeSession || pending) return;
    setPending(`remove:${item.id}`);
    setErrorMessage(null);
    try {
      await deleteFavoriteAlbum({ provider: item.provider, providerAlbumId: item.providerAlbumId });
      if (detail?.provider === item.provider && detail.providerAlbumId === item.providerAlbumId) setDetail(null);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      setPending(null);
    }
  }

  if (!hydrated || !activeSession) return <div className="min-h-[calc(100*var(--app-dvh))] bg-background" />;

  const detailItem = detail
    ? items.find((item) => item.provider === detail.provider && item.providerAlbumId === detail.providerAlbumId) ?? null
    : null;

  async function removeArtist(item: ProviderArtistFavorite) {
    setPending(`artist:${item.provider}:${item.providerArtistId}`);
    try {
      await deleteFavoriteArtist({ provider: item.provider, providerArtistId: item.providerArtistId });
      setStatusMessage(`已取消收藏 ${item.name}。`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "取消收藏歌手失败。");
    } finally {
      setPending(null);
    }
  }

  const favoriteCandidateTracks = favoriteTracks.map(favoriteTrackToCandidate);
  const favoriteDownloadedCount = favoriteCandidateTracks.filter((track) => getLocalRecord(track).availableOffline).length;

  const favoriteBody = (
    <div className={embedded ? "min-w-0 pb-1" : ""}>
      {favoriteView === "tracks" ? (
        <FavoriteTracksSection
          downloadProgress={downloadProgress}
          downloadedCount={favoriteDownloadedCount}
          isDownloadingAll={isDownloadingAll}
          loading={favoriteTracksLoading}
          onDownloadAll={downloadAllFavoriteTracks}
          onPlayAll={playAllFavoriteTracks}
          trackActions={favoriteTrackActions()}
          tracks={favoriteCandidateTracks}
        />
      ) : favoriteView === "artists" ? (
        <FavoriteArtistsSection artists={artists} pending={pending} onRemove={removeArtist} />
      ) : detail && detailItem ? (
        <ProviderAlbumDetailView
          album={detail}
          isFavorite
          onBack={() => setDetail(null)}
          onToggleFavorite={() => removeAlbum(detailItem)}
          pending={pending}
          trackActions={{
            isDownloaded: (track) => getLocalRecord(track).availableOffline,
            isPlayable: () => true,
            isQueueable: (track) => player.isTrackPlayable(getLocalRecord(track)) || playbackTracks.some((item) => item.id === localPlaylistTrackId(track) && !!item.fileHash),
            isQueued: (track) => player.queue.some((item) => item.trackId === getLocalRecord(track).id),
            isDownloading: (track) => pending === `download:${track.provider}:${track.providerTrackId}`,
            isPreparingPlayback: (track) => pending === `play:${track.provider}:${track.providerTrackId}` || pending === `queue:${track.provider}:${track.providerTrackId}`,
            onDownload: (track) => void downloadTrack(track),
            onAddToQueue: (track) => void queueFavoriteTrack(track),
            onPlay: (track) => void playFavoriteTrack(track),
            onAddToPlaylist: (track, anchor) => void openPlaylistPicker(track, anchor),
            isFavorite: (track) => isFavoriteTrack(track),
            isTogglingFavorite: (track) => pendingFavoriteKey === `${track.provider}:${track.providerTrackId}`,
            onToggleFavorite: toggleFavoriteSong
          }}
        />
      ) : (
        <section className="mt-4">
          {items.length ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {items.map((item) => (
                <article className="group relative min-w-0" key={item.id}>
                  <button className="block w-full min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70" disabled={pending !== null} onClick={() => void openAlbum(item)} type="button">
                    <div className="relative aspect-square overflow-hidden rounded-xl border border-surface-border bg-surface shadow-[0_12px_28px_rgba(0,0,0,0.18)] transition-transform duration-200 group-hover:-translate-y-1">
                      <AlbumArtwork alt={item.title} className="h-full w-full" src={item.artworkUrl} />
                    </div>
                    <div className="min-w-0 px-1 pt-3">
                      <strong className="block truncate text-[15px] font-semibold text-foreground">{item.title}</strong>
                      <p className="mt-1 truncate text-sm text-foreground-muted">{item.artist} / {item.provider === "netease" ? "网易云音乐" : item.provider === "qqmusic" ? "QQ 音乐" : "哔哩哔哩"}</p>
                    </div>
                  </button>
                  <Button aria-label={`取消收藏 ${item.title}`} className="absolute right-2 top-2 h-10 w-10 bg-black/60 text-white/80 opacity-100 backdrop-blur-sm transition-opacity hover:bg-red-500/80 hover:text-white sm:h-8 sm:w-8 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100" disabled={pending !== null} onClick={() => void removeAlbum(item)} size="icon" title="取消收藏" variant="ghost" type="button"><HeartIcon filled /></Button>
                </article>
              ))}
            </div>
          ) : !favoritesLoaded ? (
            <div className="workspace-surface flex min-h-[430px] items-center justify-center px-6 text-center text-sm text-foreground-muted">
              正在加载收藏…
            </div>
          ) : (
            <div className="workspace-surface flex min-h-[430px] flex-col items-center justify-center px-6 text-center">
              <HeartIcon />
              <p className="mt-4 text-sm font-medium text-foreground-muted">还没有收藏专辑</p>
              <p className="mt-2 text-xs text-foreground-muted">在搜索页打开专辑并点击收藏。</p>
            </div>
          )}
        </section>
      )}
      {statusMessage ? <p className="mt-5 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.08] px-4 py-3 text-xs text-emerald-200" role="status">{statusMessage}</p> : null}
      {errorMessage ? <p className="mt-5 rounded-xl border border-red-400/20 bg-red-400/[0.08] px-4 py-3 text-xs text-red-200" role="alert">{errorMessage}</p> : null}
    </div>
  );

  const content = (
      <div className={embedded
        ? fixedHeight
          ? "flex h-[29rem] min-w-0 flex-col overflow-hidden sm:h-[32rem] lg:h-[34rem]"
          : "flex min-w-0 flex-col"
        : "workspace-page__inner workspace-page__inner--wide pt-[calc(0.75rem+env(safe-area-inset-top))] pb-[calc(var(--room-mobile-bottom-inset)+2rem)] sm:pt-6 md:pt-10 md:pb-24"}>
        <header className={`flex flex-wrap items-center gap-3 ${showTitle ? "workspace-page__header" : "justify-start pb-3 pt-1"}`}>
          {showTitle ? (
            <div>
              <h1 className="workspace-page__title">收藏</h1>
            </div>
          ) : null}
          <div className="flex items-center gap-3">
            <div aria-label="收藏内容类型" className="flex items-center gap-1 rounded-xl border border-surface-border/80 bg-surface/40 p-1 shadow-2xs backdrop-blur-md" role="tablist">
              <button
                aria-selected={favoriteView === "tracks"}
                className={`flex items-center justify-center rounded-lg px-3 py-1 text-xs transition-all duration-150 cursor-pointer ${
                  favoriteView === "tracks"
                    ? "bg-surface-elevated text-foreground font-semibold shadow-xs border border-surface-border"
                    : "border border-transparent text-foreground-muted hover:text-foreground hover:bg-surface-hover/40"
                }`}
                onClick={() => { setFavoriteView("tracks"); setDetail(null); }}
                role="tab"
                type="button"
              >
                歌曲
              </button>
              <button
                aria-selected={favoriteView === "albums"}
                className={`flex items-center justify-center rounded-lg px-3 py-1 text-xs transition-all duration-150 cursor-pointer ${
                  favoriteView === "albums"
                    ? "bg-surface-elevated text-foreground font-semibold shadow-xs border border-surface-border"
                    : "border border-transparent text-foreground-muted hover:text-foreground hover:bg-surface-hover/40"
                }`}
                onClick={() => setFavoriteView("albums")}
                role="tab"
                type="button"
              >
                专辑
              </button>
              <button
                aria-selected={favoriteView === "artists"}
                className={`flex items-center justify-center rounded-lg px-3 py-1 text-xs transition-all duration-150 cursor-pointer ${
                  favoriteView === "artists"
                    ? "bg-surface-elevated text-foreground font-semibold shadow-xs border border-surface-border"
                    : "border border-transparent text-foreground-muted hover:text-foreground hover:bg-surface-hover/40"
                }`}
                onClick={() => { setFavoriteView("artists"); setDetail(null); }}
                role="tab"
                type="button"
              >
                歌手
              </button>
            </div>
            {embedded && onBack ? <Button onClick={onBack} size="sm" type="button" variant="outline">返回我的</Button> : null}
          </div>
        </header>
        {favoriteBody}
      </div>
  );

  const picker = playlistPickerTrack && playlistPickerAnchor ? (
        <ProviderPlaylistPickerDialog
          anchor={playlistPickerAnchor}
          loading={playlistPickerLoading}
          options={playlistPickerOptions}
          pending={pending !== null}
          subjectLabel={`《${playlistPickerTrack.title}》 - ${playlistPickerTrack.artist}`}
          onClose={() => {
            if (!pending) {
              setPlaylistPickerTrack(null);
              setPlaylistPickerAnchor(null);
            }
          }}
          onSelect={(option) => void addTrackToPlaylist(option)}
        />
      ) : null;

  if (embedded) {
    return <>{content}{picker}</>;
  }

  return <main className="workspace-page overflow-y-auto md:pl-60 lg:pb-28">{content}{picker}</main>;
}

function FavoriteArtistsSection({
  artists,
  pending,
  onRemove
}: {
  artists: ProviderArtistFavorite[];
  pending: string | null;
  onRemove: (artist: ProviderArtistFavorite) => Promise<void>;
}) {
  if (artists.length === 0) {
    return <div className="mt-6 flex min-h-64 flex-col items-center justify-center border border-dashed border-surface-border px-6 text-center"><p className="text-sm font-medium text-foreground-muted">还没有收藏歌手</p><p className="mt-2 text-xs text-foreground-muted">可在设置中选择导入平台关注的歌手。</p></div>;
  }
  return <section className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">{artists.map((artist) => <article className="group relative min-w-0" key={artist.id}><div className="aspect-square overflow-hidden rounded-full border border-surface-border bg-surface"><AlbumArtwork alt={artist.name} className="h-full w-full" src={artist.artworkUrl} /></div><strong className="mt-3 block truncate text-center text-sm font-semibold text-foreground">{artist.name}</strong><p className="mt-1 text-center text-xs text-foreground-muted">{artist.provider === "netease" ? "网易云音乐" : "QQ 音乐"}</p><Button aria-label={`取消收藏 ${artist.name}`} className="absolute right-1 top-1 h-10 w-10 bg-black/60 text-white/80 opacity-100 backdrop-blur-sm transition-opacity hover:bg-red-500/80 hover:text-white focus-visible:opacity-100 sm:h-8 sm:w-8 sm:opacity-0 sm:group-hover:opacity-100" disabled={pending !== null} onClick={() => void onRemove(artist)} size="icon" title="取消收藏" type="button" variant="ghost"><HeartIcon filled /></Button></article>)}</section>;
}

function FavoriteTracksSection({
  loading,
  tracks,
  trackActions,
  downloadedCount,
  onDownloadAll,
  onPlayAll,
  isDownloadingAll,
  downloadProgress
}: {
  loading: boolean;
  tracks: Track[];
  trackActions: ProviderAlbumTrackActions;
  downloadedCount: number;
  onDownloadAll?: () => void;
  onPlayAll?: () => void;
  isDownloadingAll?: boolean;
  downloadProgress?: { completed: number; total: number };
}) {
  if (loading && tracks.length === 0) {
    return <div className="mt-6 flex min-h-64 items-center justify-center rounded-2xl border border-dashed border-surface-border text-sm text-foreground-muted">正在加载收藏歌曲…</div>;
  }
  if (tracks.length === 0) {
    return <div className="mt-6 flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-surface-border px-6 text-center"><HeartIcon /><p className="mt-4 text-sm font-medium text-foreground-muted">还没有收藏歌曲</p><p className="mt-2 text-xs text-foreground-muted">在发现、歌单或播放器中点击心形按钮收藏歌曲。</p></div>;
  }
  const downloadableCount = tracks.length - downloadedCount;
  return (
    <section className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border pb-3">
        <span className="text-xs font-medium text-foreground-muted">
          {tracks.length} 首歌曲，已下载 {downloadedCount} 首
        </span>
        <div className="flex items-center gap-2">
          {onDownloadAll && downloadableCount > 0 ? (
            <Button
              disabled={isDownloadingAll}
              onClick={onDownloadAll}
              size="sm"
              type="button"
              variant="outline"
            >
              <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="14"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" /></svg>
              {isDownloadingAll ? `下载中 ${downloadProgress?.completed ?? 0}/${downloadProgress?.total ?? downloadableCount}` : "一键下载全部"}
            </Button>
          ) : null}
          {onPlayAll ? (
            <Button onClick={onPlayAll} size="sm" type="button">
              <svg aria-hidden="true" fill="currentColor" height="14" viewBox="0 0 24 24" width="14"><path d="M8 5v14l11-7z" /></svg>
              播放全部
            </Button>
          ) : null}
        </div>
      </div>
      <div className="mt-4">
        <ProviderAlbumTrackTable actions={trackActions} showToolbar={false} tracks={tracks} />
      </div>
    </section>
  );
}

function AlbumArtwork({ alt, src, className = "" }: { alt: string; src: string | null; className?: string }) {
  return (
    <MediaArtwork
      alt={alt}
      src={src}
      className={className}
      containerClassName={className}
      rounded="none"
    />
  );
}

function HeartIcon({ filled = false }: { filled?: boolean }) {
  return <svg aria-hidden="true" fill={filled ? "currentColor" : "none"} height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="16"><path d="M20.8 8.7c0 5.2-8.8 10.3-8.8 10.3S3.2 13.9 3.2 8.7A4.7 4.7 0 0 1 12 6.1a4.7 4.7 0 0 1 8.8 2.6Z" /></svg>;
}

function toErrorMessage(error: unknown) {
  if (error instanceof SoqaroApiError) {
    if (error.code === "QQMUSIC_TRACK_NOT_FOUND") return "该歌曲没有可用的公开音频，可能受到 VIP 或版权限制，请换一首歌曲重试。";
    if (error.code === "QQMUSIC_AUTH_EXPIRED") return "QQ 音乐登录已失效，请回我的页面重新绑定。";
    return error.message;
  }
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}
