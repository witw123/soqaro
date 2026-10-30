"use client";

import React, { useEffect, useState } from "react";
import type { LocalPlaylistTrackRecord } from "@/features/playlist/local-playlist";
import {
  defaultLocalPlaylistId,
  providerTrackKey,
  toCachedProviderTrack,
  toProviderTrackRecord
} from "@/features/playlist/local-playlist";
import {
  listCachedProviderPlaybackTrackKeys,
  providerPlaybackCacheChangedEvent
} from "@/features/playback/provider-track-cache";
import {
  buildPlaybackStatusMessage,
  prepareTrackForImmediatePlayback,
  toPlaybackPreparationErrorMessage
} from "@/features/playback/provider-playback-preparation";
import { downloadProviderTrackToLibrary } from "@/features/playback/provider-track-download";
import { soqaroApi } from "@/lib/network/soqaro-api";
import { useLocalPlayer } from "@/features/playback/local-player-context";
import type { AnchoredDialogAnchor } from "@/components/ui/anchored-dialog";
import { Button } from "@/components/ui/button";
import type { PlaylistSelection } from "./playlist-dialogs";
import {
  Artwork,
  getNetworkPlaylistSource,
  getPlaylistArtworkCandidates,
  getTrackArtworkUrls,
  tracksForLocalPlaylist,
  uniqueArtworkUrls
} from "./playlist-artwork";
import { LocalTrackRow, PlaylistOrderButtons } from "./LocalTrackRow";

export function PlaylistDetailView({
  localTracks,
  networkArtworkUrls,
  roomTrackIndex,
  player,
  selection,
  onBack,
  onDelete,
  onArtworkResolved,
  onTrackUpdated,
  isFavorite,
  isTogglingFavorite,
  onToggleFavorite,
  onUpdateTracks,
  onMoveTrack,
  onScanDirectory,
  isScanning,
  onAuthorizeDirectory,
  needsAuthorization,
  pending
}: {
  localTracks: LocalPlaylistTrackRecord[];
  networkArtworkUrls?: readonly string[] | null;
  roomTrackIndex: Map<string, LocalPlaylistTrackRecord>;
  player: ReturnType<typeof useLocalPlayer>;
  selection: PlaylistSelection;
  onBack: () => void;
  onDelete?: () => void;
  onArtworkResolved?: (artworkUrl: string) => void;
  onTrackUpdated?: (track: LocalPlaylistTrackRecord) => void;
  isFavorite: (track: LocalPlaylistTrackRecord) => boolean;
  isTogglingFavorite: (track: LocalPlaylistTrackRecord) => boolean;
  onToggleFavorite: (track: LocalPlaylistTrackRecord) => void;
  onUpdateTracks: (trackIds: string[]) => void;
  onMoveTrack?: (track: LocalPlaylistTrackRecord, anchor: AnchoredDialogAnchor) => void;
  onScanDirectory?: () => void;
  isScanning?: boolean;
  onAuthorizeDirectory?: () => void;
  needsAuthorization?: boolean;
  pending: boolean;
}) {
  const isLocal = selection.kind === "local";
  const localPlaylist = selection.kind === "local" ? selection.playlist : null;
  const networkPlaylist = selection.kind === "network" ? selection.playlist : null;
  const networkSource = networkPlaylist ? getNetworkPlaylistSource(networkPlaylist) : null;
  const networkProvider = networkSource?.provider ?? null;
  const networkPlaylistId = networkSource?.playlistId ?? null;
  const [remoteTracks, setRemoteTracks] = useState<LocalPlaylistTrackRecord[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [draggingTrackId, setDraggingTrackId] = useState<string | null>(null);
  const [dragOverTrackId, setDragOverTrackId] = useState<string | null>(null);
  const [downloadTrackId, setDownloadTrackId] = useState<string | null>(null);
  const [playbackTrackId, setPlaybackTrackId] = useState<string | null>(null);
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState({ completed: 0, total: 0 });
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  // Provider keys whose audio sits in the persistent playback cache. Rows of
  // a network playlist only carry provider identity, so this is what makes
  // their queueable state survive a reload instead of trusting the in-memory
  // state of the current session.
  const [cachedProviderTrackIds, setCachedProviderTrackIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    const refreshCachedProviderTrackIds = () => {
      void listCachedProviderPlaybackTrackKeys().then((keys) => {
        if (!cancelled) setCachedProviderTrackIds(keys);
      });
    };
    refreshCachedProviderTrackIds();
    // The cache module notifies on both additions and removals, so freshly
    // prepared tracks light up their queueable state without a reload.
    window.addEventListener(providerPlaybackCacheChangedEvent, refreshCachedProviderTrackIds);
    return () => {
      cancelled = true;
      window.removeEventListener(providerPlaybackCacheChangedEvent, refreshCachedProviderTrackIds);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setRemoteTracks([]);
    setRemoteError(null);
    setDownloadMessage(null);
    if (isLocal || !networkProvider || !networkPlaylistId) {
      setRemoteLoading(false);
      return;
    }

    setRemoteLoading(true);
    const load =
      networkProvider === "netease"
        ? soqaroApi.getNeteasePlaylist(networkPlaylistId)
        : networkProvider === "qqmusic"
          ? soqaroApi.getQqMusicPlaylist(networkPlaylistId)
          : soqaroApi.getBilibiliVideoParts(networkPlaylistId).then((partsDetail) => ({
              provider: "bilibili" as const,
              providerPlaylistId: partsDetail.bvid,
              title: partsDetail.title,
              description: partsDetail.rawTitle,
              artworkUrl: partsDetail.artworkUrl,
              creatorName: partsDetail.artist,
              trackCount: partsDetail.parts.length,
              tags: ["bilibili"],
              tracks: partsDetail.parts
            }));
    void load
      .then((detail) => {
        if (cancelled) return;
        setRemoteTracks(
          detail.tracks.map((track) => {
            const trackId = providerTrackKey(track.provider, track.providerTrackId);
            return toProviderTrackRecord(track, roomTrackIndex.get(trackId));
          })
        );
      })
      .catch((error) => {
        if (!cancelled)
          setRemoteError(error instanceof Error ? error.message : "网络歌单详情加载失败。");
      })
      .finally(() => {
        if (!cancelled) setRemoteLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isLocal, networkPlaylistId, networkProvider, roomTrackIndex]);

  const localPlaylistTracks = localPlaylist ? tracksForLocalPlaylist(localPlaylist, localTracks) : [];
  const title = isLocal ? localPlaylist?.title ?? "本地歌单" : networkPlaylist?.title ?? "网络歌单";
  const description = isLocal
    ? localPlaylist?.description || `${localPlaylist?.sourceDirectoryName || "项目根目录"}中的本地歌曲`
    : networkPlaylist?.description ||
      (networkSource?.provider === "qqmusic"
        ? "来自 QQ 音乐的网络歌单"
        : networkSource?.provider === "netease"
          ? "来自网易云音乐的网络歌单"
          : "保存的网络歌单");
  const remoteTrackMap = new Map(remoteTracks.map((track) => [track.id, track]));
  const localTrackMap = new Map(localTracks.map((track) => [track.id, track]));
  const networkTracks = (networkPlaylist?.trackIds ?? []).map((trackId, index) => ({
    track:
      remoteTrackMap.get(trackId) ??
      (trackId.startsWith("local:") ? remoteTracks[index] : undefined) ??
      roomTrackIndex.get(trackId) ??
      localTrackMap.get(trackId),
    index,
    trackId
  }));
  const artworkUrls = isLocal
    ? getTrackArtworkUrls(localPlaylistTracks)
    : uniqueArtworkUrls([
        ...(networkArtworkUrls ?? []),
        ...(networkPlaylist
          ? getPlaylistArtworkCandidates(networkPlaylist, roomTrackIndex, localTracks)
          : []),
        ...networkTracks.map(({ track }) => track?.artworkUrl)
      ]);
  const rows = isLocal
    ? localPlaylistTracks.map((track, index) => ({ track, index, trackId: track.id }))
    : networkTracks;
  const currentTrackIds = rows.map(({ trackId }) => trackId);
  const canEditTracks = !pending;

  function reorderTracks(targetTrackId: string) {
    if (!draggingTrackId || draggingTrackId === targetTrackId || !canEditTracks) return;
    const fromIndex = currentTrackIds.indexOf(draggingTrackId);
    const toIndex = currentTrackIds.indexOf(targetTrackId);
    if (fromIndex < 0 || toIndex < 0) return;
    const nextTrackIds = [...currentTrackIds];
    const [movedTrackId] = nextTrackIds.splice(fromIndex, 1);
    nextTrackIds.splice(toIndex, 0, movedTrackId);
    setDraggingTrackId(null);
    setDragOverTrackId(null);
    onUpdateTracks(nextTrackIds);
  }

  function moveTrackByOffset(trackId: string, direction: -1 | 1) {
    if (!canEditTracks) return;
    const currentIndex = currentTrackIds.indexOf(trackId);
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= currentTrackIds.length) return;

    const nextTrackIds = [...currentTrackIds];
    [nextTrackIds[currentIndex], nextTrackIds[targetIndex]] = [
      nextTrackIds[targetIndex],
      nextTrackIds[currentIndex]
    ];
    onUpdateTracks(nextTrackIds);
  }

  const sequenceTracks = rows
    .map((row) => row.track)
    .filter((track): track is LocalPlaylistTrackRecord => Boolean(track))
    .filter(
      (track, index, list) => list.findIndex((candidate) => candidate.id === track.id) === index
    );
  const canPrepareTrack = (track: LocalPlaylistTrackRecord) =>
    player.isTrackPlayable(track) || !!toCachedProviderTrack(track);
  const playableTracks = sequenceTracks.filter(canPrepareTrack);
  const downloadableTracks = sequenceTracks.filter(
    (track) =>
      (track.provider === "netease" ||
        track.provider === "qqmusic" ||
        track.provider === "bilibili") &&
      !!track.providerTrackId &&
      !track.availableOffline
  );
  const showBatchDownload =
    sequenceTracks.length > 0 && (!isLocal || downloadableTracks.length > 0);

  async function playPlaylistTrack(track: LocalPlaylistTrackRecord) {
    if (downloadTrackId || playbackTrackId) return;
    setPlaybackTrackId(track.id);
    setDownloadMessage(null);
    try {
      const prepared = await prepareTrackForImmediatePlayback(track);
      await player.playTrack(prepared.record);
      setDownloadMessage(buildPlaybackStatusMessage(track.title, prepared.source));
    } catch (error) {
      setDownloadMessage(toPlaybackPreparationErrorMessage(error, `《${track.title}》播放失败，请重试。`));
    } finally {
      setPlaybackTrackId(null);
    }
  }

  async function playAllTracks() {
    if (
      isDownloadingAll ||
      downloadTrackId ||
      playbackTrackId ||
      playableTracks.length === 0
    )
      return;
    setDownloadMessage(null);
    const firstTrack = playableTracks[0]!;
    setPlaybackTrackId(firstTrack.id);
    try {
      await player.playTracks(playableTracks);
      setDownloadMessage(`正在播放“${title}”`);
    } catch (error) {
      setDownloadMessage(toPlaybackPreparationErrorMessage(error, "播放歌单失败，请重试。"));
    } finally {
      setPlaybackTrackId(null);
    }
  }

  async function downloadTrack(track: LocalPlaylistTrackRecord) {
    const provider =
      track.provider === "netease" || track.provider === "qqmusic" || track.provider === "bilibili"
        ? track.provider
        : null;
    if (!provider || !track.providerTrackId || track.availableOffline || downloadTrackId)
      return false;
    setDownloadTrackId(track.id);
    setDownloadMessage(null);
    try {
      const updatedTrack = await downloadProviderTrackToLibrary({
        track,
        existing: track,
        onResolved: (resolved) => {
          if (resolved.artworkUrl) {
            onArtworkResolved?.(resolved.artworkUrl);
            onTrackUpdated?.(resolved);
          }
        }
      });
      onTrackUpdated?.(updatedTrack);
      setRemoteTracks((current) =>
        current.map((item) => (item.id === updatedTrack.id ? updatedTrack : item))
      );
      setDownloadMessage(`《${updatedTrack.title}》已下载到本地音乐目录。`);
      return true;
    } catch (error) {
      setDownloadMessage(error instanceof Error ? error.message : "歌曲下载失败，请重试。");
      return false;
    } finally {
      setDownloadTrackId(null);
    }
  }

  async function downloadAllTracks() {
    if (isDownloadingAll || downloadTrackId || downloadableTracks.length === 0) return;
    setIsDownloadingAll(true);
    setDownloadProgress({ completed: 0, total: downloadableTracks.length });
    setDownloadMessage(null);
    let downloadedCount = 0;
    let failedCount = 0;
    try {
      for (let index = 0; index < downloadableTracks.length; index += 1) {
        const downloaded = await downloadTrack(downloadableTracks[index]);
        if (downloaded) downloadedCount += 1;
        else failedCount += 1;
        setDownloadProgress({ completed: index + 1, total: downloadableTracks.length });
      }
      setDownloadMessage(
        failedCount > 0
          ? `已下载 ${downloadedCount} 首，${failedCount} 首下载失败。`
          : `已下载 ${downloadedCount} 首歌曲。`
      );
    } finally {
      setIsDownloadingAll(false);
    }
  }

  return (
    <section className="mt-2" data-testid="playlist-detail">
      <div className="mb-4 flex items-center justify-between">
        <Button className="h-7 px-2.5 gap-1.5 rounded-md text-xs font-medium text-foreground-muted hover:text-foreground hover:bg-surface-hover border border-surface-border bg-surface/50" onClick={onBack} size="sm" type="button" variant="ghost">
          <svg
            aria-hidden="true"
            fill="none"
            height="14"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
            width="14"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
          返回歌单
        </Button>
        {onDelete ? (
          <Button
            aria-label="删除歌单"
            className="h-7 px-2.5 gap-1.5 rounded-md text-xs font-medium text-rose-500 hover:bg-rose-500/10 hover:text-rose-600 border border-transparent hover:border-rose-500/20"
            onClick={onDelete}
            size="sm"
            type="button"
            variant="ghost"
          >
            <svg
              aria-hidden="true"
              fill="none"
              height="14"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.8"
              viewBox="0 0 24 24"
              width="14"
            >
              <path d="M3 6h18M8 6V4h8v2m-9 0 1 15h8l1-15M10 10v7m4-7v7" />
            </svg>
            删除歌单
          </Button>
        ) : null}
      </div>

      <div className="flex flex-col gap-5 pb-6 sm:flex-row sm:items-end">
        <div className="shrink-0 self-center sm:self-auto">
          <Artwork artworkUrls={artworkUrls} size="lg" title={title} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-md bg-surface px-2 py-0.5 text-xs font-medium text-foreground-muted">
              {isLocal ? "本地歌单" : "网络歌单"}
            </span>
          </div>
          <h1 className="mt-2 text-xl font-bold text-foreground tracking-tight sm:text-2xl truncate">{title}</h1>
          {description ? (
            <p className="mt-1.5 text-sm text-foreground-muted line-clamp-2 max-w-2xl">{description}</p>
          ) : null}
          {remoteLoading ? (
            <p className="mt-2 text-xs text-accent">正在同步平台歌单详情…</p>
          ) : null}
          {remoteError ? (
            <p className="mt-2 text-xs text-amber-300">
              {remoteError} 当前显示已保存的歌曲索引。
            </p>
          ) : null}
        </div>
      </div>

      {downloadMessage ? (
        <p
          className="mt-4 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300"
          role="status"
        >
          {downloadMessage}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border pb-3">
        <span className="text-xs font-medium text-foreground-muted">{rows.length} 首歌曲</span>
        <div className="flex items-center gap-2">
          {isLocal && localPlaylist?.id === defaultLocalPlaylistId ? (
            needsAuthorization && onAuthorizeDirectory ? (
              <Button
                className="h-8 gap-1.5 rounded-lg border border-surface-border bg-surface px-3 text-xs font-medium text-foreground hover:bg-surface-hover"
                onClick={onAuthorizeDirectory}
                type="button"
                variant="outline"
              >
                重新授权
              </Button>
            ) : onScanDirectory ? (
              <Button
                className="h-8 gap-1.5 rounded-lg border border-surface-border bg-surface px-3 text-xs font-medium text-foreground hover:bg-surface-hover"
                disabled={isScanning}
                onClick={onScanDirectory}
                type="button"
                variant="outline"
              >
                {isScanning ? "扫描中…" : "扫描目录"}
              </Button>
            ) : null
          ) : null}
          {showBatchDownload ? (
            <Button
              className="h-8 gap-1.5 rounded-lg border border-surface-border bg-surface px-3 text-xs font-medium text-foreground hover:bg-surface-hover"
              disabled={
                isDownloadingAll || downloadTrackId !== null || downloadableTracks.length === 0
              }
              onClick={() => void downloadAllTracks()}
              type="button"
              variant="outline"
            >
              <svg
                aria-hidden="true"
                fill="none"
                height="14"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
                viewBox="0 0 24 24"
                width="14"
              >
                <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />
              </svg>
              {isDownloadingAll
                ? `下载中 ${downloadProgress.completed}/${downloadProgress.total}`
                : downloadableTracks.length > 0
                  ? "一键下载"
                  : "已全部下载"}
            </Button>
          ) : null}
          <Button
            className="h-8 gap-1.5 rounded-lg bg-accent px-3.5 text-xs font-medium text-white shadow-xs hover:bg-accent-hover active:scale-95"
            disabled={
              playableTracks.length === 0 ||
              playbackTrackId !== null ||
              downloadTrackId !== null
            }
            onClick={() => void playAllTracks()}
            type="button"
          >
            <svg aria-hidden="true" fill="currentColor" height="14" viewBox="0 0 24 24" width="14">
              <path d="M8 5v14l11-7z" />
            </svg>
            播放全部
          </Button>
        </div>
      </div>

      <div className="mt-4 space-y-0.5">
        {rows.length ? (
          rows.map(({ track, index, trackId }) => {
            if (!track) {
              return (
                <article
                  className={`group flex items-center justify-between gap-3 px-3 py-2 rounded-lg transition-colors hover:bg-surface-hover/60 ${
                    dragOverTrackId === trackId ? "bg-accent/10" : ""
                  } ${canEditTracks ? "cursor-grab active:cursor-grabbing" : ""}`}
                  draggable={canEditTracks}
                  key={`${selection.kind}:${trackId}`}
                  onDragEnd={() => {
                    setDraggingTrackId(null);
                    setDragOverTrackId(null);
                  }}
                  onDragOver={(event) => {
                    if (!canEditTracks) return;
                    event.preventDefault();
                    setDragOverTrackId(trackId);
                  }}
                  onDragStart={(event) => {
                    if (!canEditTracks) return;
                    event.dataTransfer.effectAllowed = "move";
                    setDraggingTrackId(trackId);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    reorderTracks(trackId);
                  }}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="w-6 shrink-0 flex items-center justify-center text-xs font-semibold tabular-nums text-foreground-muted">
                      {String(index + 1).padStart(2, "0")}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground/80">{trackId}</p>
                      <p className="mt-0.5 text-xs text-foreground-muted">曲目信息不可用</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {canEditTracks ? (
                      <PlaylistOrderButtons
                        index={index}
                        onMove={(direction) => moveTrackByOffset(trackId, direction)}
                        title={trackId}
                        total={currentTrackIds.length}
                      />
                    ) : null}
                    {canEditTracks ? (
                      <Button
                        aria-label="从歌单移除歌曲"
                        className="h-8 w-8 rounded-lg text-foreground-muted hover:text-red-400 hover:bg-red-500/10"
                        onClick={() =>
                          onUpdateTracks(currentTrackIds.filter((id) => id !== trackId))
                        }
                        size="icon"
                        title="从歌单移除"
                        type="button"
                        variant="ghost"
                      >
                        <svg
                          aria-hidden="true"
                          fill="none"
                          height="14"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="1.8"
                          viewBox="0 0 24 24"
                          width="14"
                        >
                          <path d="M3 6h18M8 6V4h8v2m-9 0 1 15h8l1-15M10 10v7m4-7v7" />
                        </svg>
                      </Button>
                    ) : null}
                  </div>
                </article>
              );
            }
            const playable = canPrepareTrack(track);
            const queueable =
              player.isTrackPlayable(track) ||
              ((track.provider === "netease" ||
                track.provider === "qqmusic" ||
                track.provider === "bilibili") &&
                !!track.providerTrackId &&
                cachedProviderTrackIds.has(providerTrackKey(track.provider, track.providerTrackId)));
            return (
              <LocalTrackRow
                draggable={canEditTracks}
                index={index}
                isCurrent={player.currentTrack?.id === track.id}
                isDownloading={downloadTrackId === track.id}
                isDragTarget={dragOverTrackId === trackId}
                isFavorite={isFavorite(track)}
                isPlayable={playable}
                isPreparingPlayback={playbackTrackId === track.id}
                isQueueable={queueable}
                isQueued={player.queue.some((item) => item.trackId === track.id)}
                isTogglingFavorite={isTogglingFavorite(track)}
                key={`${selection.kind}:${track.id}`}
                onAddToQueue={() => player.addToQueue(track)}
                onDownload={
                  track.providerTrackId &&
                  (track.provider === "netease" ||
                    track.provider === "qqmusic" ||
                    track.provider === "bilibili")
                    ? () => void downloadTrack(track)
                    : undefined
                }
                onDragEnd={() => {
                  setDraggingTrackId(null);
                  setDragOverTrackId(null);
                }}
                onDragOver={() => setDragOverTrackId(trackId)}
                onDragStart={() => setDraggingTrackId(trackId)}
                onDrop={() => reorderTracks(trackId)}
                onMove={(anchor) => onMoveTrack?.(track, anchor)}
                onMoveOrder={(direction) => moveTrackByOffset(trackId, direction)}
                onPlay={() => void playPlaylistTrack(track)}
                onRemove={
                  canEditTracks
                    ? () =>
                        onUpdateTracks(
                          currentTrackIds.filter((itemTrackId) => itemTrackId !== trackId)
                        )
                    : undefined
                }
                onToggleFavorite={() => onToggleFavorite(track)}
                total={rows.length}
                track={track}
              />
            );
          })
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center text-sm text-foreground-muted">
            <p>这个歌单还没有歌曲。</p>
            {isLocal && localPlaylist?.id === defaultLocalPlaylistId ? (
              needsAuthorization && onAuthorizeDirectory ? (
                <Button
                  className="h-8 gap-1.5 rounded-lg border border-surface-border bg-surface px-3 text-xs font-medium text-foreground hover:bg-surface-hover"
                  onClick={onAuthorizeDirectory}
                  type="button"
                  variant="outline"
                >
                  重新授权本地目录
                </Button>
              ) : onScanDirectory ? (
                <Button
                  className="h-8 gap-1.5 rounded-lg border border-surface-border bg-surface px-3 text-xs font-medium text-foreground hover:bg-surface-hover"
                  disabled={isScanning}
                  onClick={onScanDirectory}
                  type="button"
                  variant="outline"
                >
                  {isScanning ? "正在扫描…" : "扫描本地目录"}
                </Button>
              ) : null
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
