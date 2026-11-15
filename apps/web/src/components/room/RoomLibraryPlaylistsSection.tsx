/* eslint-disable @next/next/no-img-element */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BilibiliTrackCandidate,
  NeteaseTrackCandidate,
  Playlist,
  ProviderTrackCandidate,
  QqMusicTrackCandidate,
  TrackMeta
} from "@soqaro/shared";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/domain/soqaro-ui";
import { soqaroApi } from "@/lib/network/soqaro-api";
import { toProviderImportErrorMessage } from "@/features/upload/upload-import-helpers";
import type { CachedLibraryTrack } from "@/features/library/audio-utils";
import { getArtworkSourceUrl } from "@/components/bottom-player/artwork-colors";
import {
  CheckIcon,
  FolderIcon,
  ListMusicIcon,
  TrashIcon
} from "@/components/icons/DiscoverIcons";
import { importTaskStore, useVisibleImportTasks, isCandidateImporting } from "@/features/upload/import-task-store";
import {
  listCachedLibraryTrackSummaries,
  listLocalPlaylistTracks
} from "@/features/library/indexeddb";
import {
  buildFallbackPlaylistTracks,
  buildRoomTrackKeySet,
  getRoomPlaylistSource,
  isTrackInRoom,
  type ResolvedPlaylistTrackEntry,
  type RoomPlaylistSource
} from "./room-library-playlist-utils";

type ProviderTrack = ProviderTrackCandidate;

export type RoomLibraryPlaylistsSectionProps = {
  roomPlaylists: Playlist[];
  tracks: TrackMeta[];
  canManageLibrary: boolean;
  canAddToQueue: boolean;
  onDeletePlaylist: (playlistId: string) => Promise<void>;
  onLoadPlaylistIntoRoom: (playlistId: string) => Promise<void>;
  onImportNeteaseTrack?: (track: NeteaseTrackCandidate) => Promise<void>;
  onImportQqMusicTrack?: (track: QqMusicTrackCandidate) => Promise<void>;
  onImportBilibiliTrack?: (track: BilibiliTrackCandidate) => Promise<void>;
  onImportNeteaseTracks?: (tracks: NeteaseTrackCandidate[]) => Promise<void>;
  onImportQqMusicTracks?: (tracks: QqMusicTrackCandidate[]) => Promise<void>;
  onImportBilibiliTracks?: (tracks: BilibiliTrackCandidate[]) => Promise<void>;
  onImportCachedTrack?: (track: CachedLibraryTrack) => Promise<void>;
  onSwitchToDesk?: () => void;
};

type PlaylistTrackItem = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationMs: number;
  artworkUrl: string | null;
  providerTrack: ProviderTrack | null;
  cachedTrack: CachedLibraryTrack | null;
  isInRoom: boolean;
};

async function fetchSourceTracks(source: RoomPlaylistSource): Promise<ProviderTrack[]> {
  try {
    if (source.type === "bilibili") {
      const detail = await soqaroApi.getBilibiliVideoParts(source.bvid);
      return detail.parts;
    }
    if (source.type === "album") {
      const detail = source.provider === "netease"
        ? await soqaroApi.getNeteaseAlbum(source.albumId)
        : await soqaroApi.getQqMusicAlbum(source.albumId);
      return detail.tracks;
    }
    const detail = source.provider === "netease"
      ? await soqaroApi.getNeteasePlaylist(source.playlistId)
      : source.provider === "qqmusic"
        ? await soqaroApi.getQqMusicPlaylist(source.playlistId)
        : null;
    return detail?.tracks ?? [];
  } catch {
    return [];
  }
}

async function loadResolvedPlaylistEntries(
  trackIds: readonly string[],
  source: RoomPlaylistSource | null
): Promise<ResolvedPlaylistTrackEntry[]> {
  if (source) {
    const remoteTracks = await fetchSourceTracks(source);
    if (remoteTracks.length > 0) {
      return remoteTracks.map((track) => ({
        key: `${track.provider}:${track.providerTrackId}`,
        rawId: `provider:${track.provider}:${track.providerTrackId}`,
        title: track.title,
        artist: track.artist,
        album: track.album ?? null,
        durationMs: track.durationMs,
        artworkUrl: track.artworkUrl ?? null,
        providerTrack: track,
        cachedTrack: null
      }));
    }
  }

  const [localTracks, cachedSummaries] = await Promise.all([
    listLocalPlaylistTracks().catch(() => []),
    listCachedLibraryTrackSummaries().catch(() => [])
  ]);
  return buildFallbackPlaylistTracks(trackIds, localTracks, cachedSummaries);
}

type ImportHandlers = {
  onImportNeteaseTracks?: (tracks: NeteaseTrackCandidate[]) => Promise<void>;
  onImportQqMusicTracks?: (tracks: QqMusicTrackCandidate[]) => Promise<void>;
  onImportBilibiliTracks?: (tracks: BilibiliTrackCandidate[]) => Promise<void>;
  onImportCachedTrack?: (track: CachedLibraryTrack) => Promise<void>;
};

async function importMissingEntries(
  entries: readonly { providerTrack: ProviderTrack | null; cachedTrack: CachedLibraryTrack | null }[],
  handlers: ImportHandlers
): Promise<{ importedGroups: number; failedMessages: string[] }> {
  const netease: NeteaseTrackCandidate[] = [];
  const qqmusic: QqMusicTrackCandidate[] = [];
  const bilibili: BilibiliTrackCandidate[] = [];
  const cached: CachedLibraryTrack[] = [];

  for (const entry of entries) {
    if (entry.providerTrack) {
      if (entry.providerTrack.provider === "netease") {
        netease.push(entry.providerTrack as NeteaseTrackCandidate);
      } else if (entry.providerTrack.provider === "qqmusic") {
        qqmusic.push(entry.providerTrack as QqMusicTrackCandidate);
      } else if (entry.providerTrack.provider === "bilibili") {
        bilibili.push(entry.providerTrack as BilibiliTrackCandidate);
      }
    } else if (entry.cachedTrack) {
      cached.push(entry.cachedTrack);
    }
  }

  let importedGroups = 0;
  const failedMessages: string[] = [];

  const runBatch = async (label: string, task: () => Promise<void>) => {
    try {
      await task();
      importedGroups += 1;
    } catch (error) {
      const detail = toProviderImportErrorMessage(error);
      failedMessages.push(`${label}：${detail}`);
    }
  };

  if (netease.length > 0 && handlers.onImportNeteaseTracks) {
    await runBatch("网易云曲目", () => handlers.onImportNeteaseTracks!(netease));
  }
  if (qqmusic.length > 0 && handlers.onImportQqMusicTracks) {
    await runBatch("QQ音乐曲目", () => handlers.onImportQqMusicTracks!(qqmusic));
  }
  if (bilibili.length > 0 && handlers.onImportBilibiliTracks) {
    await runBatch("B站曲目", () => handlers.onImportBilibiliTracks!(bilibili));
  }
  if (cached.length > 0 && handlers.onImportCachedTrack) {
    for (const track of cached) {
      await runBatch(`本地缓存《${track.title}》`, () => handlers.onImportCachedTrack!(track));
    }
  }

  return { importedGroups, failedMessages };
}

export function RoomLibraryPlaylistsSection({
  roomPlaylists,
  tracks,
  canManageLibrary,
  canAddToQueue,
  onDeletePlaylist,
  onLoadPlaylistIntoRoom,
  onImportNeteaseTrack,
  onImportQqMusicTrack,
  onImportBilibiliTrack,
  onImportNeteaseTracks,
  onImportQqMusicTracks,
  onImportBilibiliTracks,
  onImportCachedTrack,
  onSwitchToDesk
}: RoomLibraryPlaylistsSectionProps) {
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [isQueueBusyId, setIsQueueBusyId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useVisibleImportTasks();

  const selectedPlaylist = useMemo(
    () => roomPlaylists.find((p) => p.id === selectedPlaylistId) ?? null,
    [roomPlaylists, selectedPlaylistId]
  );

  const roomTrackKeySet = useMemo(() => buildRoomTrackKeySet(tracks), [tracks]);

  const playlistStats = useMemo(() => {
    const map = new Map<string, { total: number; imported: number; isAllImported: boolean }>();
    for (const playlist of roomPlaylists) {
      const total = playlist.trackIds.length;
      const imported = playlist.trackIds.filter((id) => isTrackInRoom(roomTrackKeySet, id)).length;
      map.set(playlist.id, { total, imported, isAllImported: total > 0 && imported >= total });
    }
    return map;
  }, [roomPlaylists, roomTrackKeySet]);

  const handleAddAllToQueue = useCallback(
    async (playlist: Playlist) => {
      if (!canAddToQueue || isQueueBusyId !== null) return;
      setIsQueueBusyId(playlist.id);
      setStatusMessage(`正在准备将歌单《${playlist.title}》的全部歌曲加入节目单…`);
      try {
        const source = getRoomPlaylistSource(playlist);
        const resolvedEntries = await loadResolvedPlaylistEntries(playlist.trackIds, source);
        const missingEntries = resolvedEntries.filter(
          (entry) =>
            (entry.providerTrack !== null || entry.cachedTrack !== null) &&
            !isTrackInRoom(roomTrackKeySet, entry.key) &&
            !isTrackInRoom(roomTrackKeySet, entry.rawId)
        );

        let failedMessages: string[] = [];
        if (missingEntries.length > 0) {
          setStatusMessage(`正在导入剩余的 ${missingEntries.length} 首歌曲到曲库…`);
          const result = await importMissingEntries(missingEntries, {
            onImportNeteaseTracks,
            onImportQqMusicTracks,
            onImportBilibiliTracks,
            onImportCachedTrack
          });
          failedMessages = result.failedMessages;
        }

        await onLoadPlaylistIntoRoom(playlist.id);
        setStatusMessage(
          failedMessages.length > 0
            ? `歌单《${playlist.title}》部分可播曲目已加入节目单（${failedMessages[0]}）。`
            : `已将歌单《${playlist.title}》全部歌曲加入节目单。`
        );
      } catch (error) {
        setStatusMessage(toProviderImportErrorMessage(error));
      } finally {
        setIsQueueBusyId(null);
      }
    },
    [
      canAddToQueue,
      isQueueBusyId,
      onImportBilibiliTracks,
      onImportCachedTrack,
      onImportNeteaseTracks,
      onImportQqMusicTracks,
      onLoadPlaylistIntoRoom,
      roomTrackKeySet
    ]
  );

  const handleDeletePlaylist = useCallback(
    async (playlistId: string) => {
      if (!canManageLibrary || pendingDeleteId !== null) return;
      setPendingDeleteId(playlistId);
      try {
        await onDeletePlaylist(playlistId);
        if (selectedPlaylistId === playlistId) {
          setSelectedPlaylistId(null);
        }
        setStatusMessage("歌单已从曲库中移除。");
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : "移除歌单失败。");
      } finally {
        setPendingDeleteId(null);
      }
    },
    [canManageLibrary, onDeletePlaylist, pendingDeleteId, selectedPlaylistId]
  );

  if (selectedPlaylist) {
    return (
      <RoomLibraryPlaylistDetail
        key={selectedPlaylist.id}
        canAddToQueue={canAddToQueue}
        canManageLibrary={canManageLibrary}
        isQueueBusy={isQueueBusyId === selectedPlaylist.id}
        onAddAllToQueue={() => void handleAddAllToQueue(selectedPlaylist)}
        onBack={() => setSelectedPlaylistId(null)}
        onDelete={() => void handleDeletePlaylist(selectedPlaylist.id)}
        onImportCachedTrack={onImportCachedTrack}
        onImportNeteaseTrack={onImportNeteaseTrack}
        onImportNeteaseTracks={onImportNeteaseTracks}
        onImportQqMusicTrack={onImportQqMusicTrack}
        onImportQqMusicTracks={onImportQqMusicTracks}
        onImportBilibiliTrack={onImportBilibiliTrack}
        onImportBilibiliTracks={onImportBilibiliTracks}
        playlist={selectedPlaylist}
        queueStatusMessage={statusMessage}
        roomTracks={tracks}
      />
    );
  }

  return (
    <section className="flex w-full flex-col gap-3" data-testid="room-library-playlists-section">
      {statusMessage ? (
        <div className="flex items-center justify-end">
          <p className="truncate text-xs text-accent" role="status">
            {statusMessage}
          </p>
        </div>
      ) : null}

      {roomPlaylists.length > 0 ? (
        <div className="divide-y divide-surface-border/50 overflow-hidden rounded-xl border border-surface-border/60 bg-surface/40">
          {roomPlaylists.map((playlist) => {
            const stats = playlistStats.get(playlist.id) ?? {
              total: playlist.trackIds.length,
              imported: 0,
              isAllImported: false
            };
            const source = getRoomPlaylistSource(playlist);
            const sourceLabel = source?.type === "bilibili"
              ? "哔哩哔哩"
              : source?.provider === "netease"
              ? (source.type === "album" ? "网易云专辑" : "网易云音乐")
              : source?.provider === "qqmusic"
              ? (source.type === "album" ? "QQ音乐专辑" : "QQ 音乐")
              : "曲库歌单";
            const isBusy =
              isQueueBusyId === playlist.id ||
              importTaskStore.isItemImporting(playlist.id) ||
              importTaskStore.isItemImporting(playlist.title);
            const isDeleting = pendingDeleteId === playlist.id;

            return (
              <article
                key={playlist.id}
                className="group flex min-w-0 items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-hover/70"
              >
                <button
                  aria-label={`打开曲库歌单 ${playlist.title}`}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                  onClick={() => setSelectedPlaylistId(playlist.id)}
                  type="button"
                >
                  <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-lg border border-surface-border/60 bg-surface shadow-xs">
                    {playlist.coverUrl ? (
                      <img
                        alt=""
                        className="h-full w-full object-cover"
                        src={getArtworkSourceUrl(playlist.coverUrl)}
                      />
                    ) : (
                      <div className="grid h-full w-full place-items-center text-foreground-muted">
                        <FolderIcon className="h-5 w-5" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <strong className="block truncate text-xs sm:text-sm font-semibold text-foreground group-hover:text-accent transition-colors">
                      {playlist.title}
                    </strong>
                    <div className="flex items-center gap-2 text-xs text-foreground-muted">
                      <span>{sourceLabel}</span>
                      <span className="text-surface-border">/</span>
                      <span>共 {stats.total} 首</span>
                      <span className="text-surface-border">/</span>
                      <span className={stats.isAllImported ? "text-emerald-400 font-medium" : "text-foreground-muted"}>
                        已导入 {stats.imported} 首
                      </span>
                    </div>
                  </div>
                </button>

                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    className="flex h-7.5 items-center gap-1 rounded-md px-2 text-xs font-medium border border-surface-border bg-surface hover:bg-surface-hover text-foreground active:scale-95 disabled:cursor-wait"
                    disabled={isBusy}
                    onClick={() => void handleAddAllToQueue(playlist)}
                    size="sm"
                    title="将歌单全部歌曲加入节目单"
                    type="button"
                    variant="outline"
                  >
                    <ListMusicIcon className="h-3.5 w-3.5" />
                    <span>{isBusy ? "加入中…" : "全部加队列"}</span>
                  </Button>
                  {canManageLibrary ? (
                    <Button
                      aria-label={`从曲库移除歌单 ${playlist.title}`}
                      className="h-7.5 w-7.5 shrink-0 text-foreground-muted transition-colors hover:bg-red-500/15 hover:text-red-400"
                      disabled={isDeleting}
                      onClick={() => void handleDeletePlaylist(playlist.id)}
                      size="icon"
                      title="从曲库移除歌单"
                      type="button"
                      variant="ghost"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-surface-border/60 bg-surface/20 px-4 py-8 text-center">
          <FolderIcon className="mx-auto h-8 w-8 text-foreground-muted/60" />
          <p className="mt-2 text-xs sm:text-sm font-semibold text-foreground">曲库暂无歌单</p>
          <p className="mt-1 text-xs text-foreground-muted">
            可以在“搜歌添加 -&gt; 我的歌单”中将歌单加入曲库。
          </p>
          {onSwitchToDesk ? (
            <Button
              className="mt-3.5 h-7.5 rounded-lg px-3 text-xs font-semibold bg-accent text-white shadow-xs hover:bg-accent-hover"
              onClick={onSwitchToDesk}
              size="sm"
              type="button"
            >
              前往选择歌单
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}

function RoomLibraryPlaylistDetail({
  playlist,
  roomTracks,
  canManageLibrary,
  canAddToQueue,
  isQueueBusy,
  queueStatusMessage,
  onBack,
  onAddAllToQueue,
  onDelete,
  onImportNeteaseTrack,
  onImportQqMusicTrack,
  onImportBilibiliTrack,
  onImportNeteaseTracks,
  onImportQqMusicTracks,
  onImportBilibiliTracks,
  onImportCachedTrack
}: {
  playlist: Playlist;
  roomTracks: TrackMeta[];
  canManageLibrary: boolean;
  canAddToQueue: boolean;
  isQueueBusy: boolean;
  queueStatusMessage?: string | null;
  onBack: () => void;
  onAddAllToQueue: () => void;
  onDelete: () => void;
  onImportNeteaseTrack?: (track: NeteaseTrackCandidate) => Promise<void>;
  onImportQqMusicTrack?: (track: QqMusicTrackCandidate) => Promise<void>;
  onImportBilibiliTrack?: (track: BilibiliTrackCandidate) => Promise<void>;
  onImportNeteaseTracks?: (tracks: NeteaseTrackCandidate[]) => Promise<void>;
  onImportQqMusicTracks?: (tracks: QqMusicTrackCandidate[]) => Promise<void>;
  onImportBilibiliTracks?: (tracks: BilibiliTrackCandidate[]) => Promise<void>;
  onImportCachedTrack?: (track: CachedLibraryTrack) => Promise<void>;
}) {
  useVisibleImportTasks();
  const [resolvedEntries, setResolvedEntries] = useState<ResolvedPlaylistTrackEntry[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [pendingTrackIds, setPendingTrackIds] = useState<Set<string>>(() => new Set());
  const [isImportingSelected, setIsImportingSelected] = useState(false);
  const [detailStatus, setDetailStatus] = useState<string | null>(null);
  const pendingTrackIdsRef = useRef<Set<string>>(new Set());

  const isQueueBusyComputed =
    isQueueBusy ||
    importTaskStore.isItemImporting(playlist.id) ||
    importTaskStore.isItemImporting(playlist.title);

  // Stabilize source and trackIds by primitive keys so roomSnapshot updates do not re-trigger loading.
  const tagsKey = (playlist.tags ?? []).join("\u0000");
  const trackIdsKey = playlist.trackIds.join("\u0000");
  const source = useMemo(
    () => getRoomPlaylistSource({ tags: tagsKey ? tagsKey.split("\u0000") : [] }),
    [tagsKey]
  );
  const stableTrackIds = useMemo(
    () => (trackIdsKey ? trackIdsKey.split("\u0000") : []),
    [trackIdsKey]
  );

  useEffect(() => {
    let cancelled = false;
    async function loadTracks() {
      setRemoteLoading(true);
      const entries = await loadResolvedPlaylistEntries(stableTrackIds, source);
      if (!cancelled) {
        setResolvedEntries(entries);
        setRemoteLoading(false);
      }
    }

    void loadTracks();
    return () => {
      cancelled = true;
    };
  }, [source, stableTrackIds]);

  const roomProviderTrackKeys = useMemo(() => buildRoomTrackKeySet(roomTracks), [roomTracks]);
  const roomTrackByKey = useMemo(() => {
    const map = new Map<string, TrackMeta>();
    for (const track of roomTracks) {
      map.set(track.id, track);
      if (track.fileHash) {
        map.set(track.fileHash, track);
        map.set(`local:${track.fileHash}`, track);
      }
      if (track.sourceRef) {
        map.set(`${track.sourceRef.provider}:${track.sourceRef.trackId}`, track);
        map.set(`provider:${track.sourceRef.provider}:${track.sourceRef.trackId}`, track);
        map.set(track.sourceRef.trackId, track);
      }
    }
    return map;
  }, [roomTracks]);

  const displayTracks: PlaylistTrackItem[] = useMemo(() => {
    return resolvedEntries.map((entry) => {
      const inRoom =
        isTrackInRoom(roomProviderTrackKeys, entry.key) ||
        isTrackInRoom(roomProviderTrackKeys, entry.rawId);
      const roomMatch = inRoom
        ? (roomTrackByKey.get(entry.key) ??
            roomTrackByKey.get(entry.rawId) ??
            roomTrackByKey.get(entry.rawId.replace(/^(?:provider|local):/, "")))
        : undefined;
      const useRoomMeta = roomMatch && !entry.providerTrack && !entry.cachedTrack;

      return {
        id: entry.key,
        title: useRoomMeta ? roomMatch.title : entry.title,
        artist: useRoomMeta ? roomMatch.artist : entry.artist,
        album: useRoomMeta ? roomMatch.album : entry.album,
        durationMs: useRoomMeta ? roomMatch.durationMs : entry.durationMs,
        artworkUrl: useRoomMeta ? roomMatch.artworkUrl : entry.artworkUrl,
        providerTrack: entry.providerTrack,
        cachedTrack: entry.cachedTrack,
        isInRoom: inRoom
      };
    });
  }, [resolvedEntries, roomProviderTrackKeys, roomTrackByKey]);

  const canImportItem = useCallback(
    (item: PlaylistTrackItem) =>
      Boolean(item.providerTrack || (item.cachedTrack && onImportCachedTrack)),
    [onImportCachedTrack]
  );

  const selectableTracks = useMemo(
    () => displayTracks.filter((t) => !t.isInRoom && canImportItem(t)),
    [canImportItem, displayTracks]
  );
  const selectableKeys = useMemo(() => selectableTracks.map((t) => t.id), [selectableTracks]);
  const allSelectableSelected = selectableKeys.length > 0 && selectedKeys.length >= selectableKeys.length;
  const importedCount = displayTracks.filter((t) => t.isInRoom).length;

  const isTrackItemImporting = useCallback(
    (item: PlaylistTrackItem) => {
      if (pendingTrackIds.has(item.id)) return true;
      if (item.providerTrack && isCandidateImporting(item.providerTrack)) return true;
      if (item.cachedTrack && importTaskStore.isItemImporting(item.cachedTrack.fileHash)) return true;
      return importTaskStore.isItemImporting(item.id);
    },
    [pendingTrackIds]
  );

  const isImportBusy =
    isImportingSelected ||
    selectableTracks.some((t) =>
      t.providerTrack
        ? isCandidateImporting(t.providerTrack)
        : t.cachedTrack
          ? importTaskStore.isItemImporting(t.cachedTrack.fileHash)
          : importTaskStore.isItemImporting(t.id)
    );

  const toggleSelectAll = () => {
    setSelectedKeys(allSelectableSelected ? [] : selectableKeys);
  };

  const toggleTrackSelect = (key: string) => {
    setSelectedKeys((curr) =>
      curr.includes(key) ? curr.filter((k) => k !== key) : [...curr, key]
    );
  };

  const importSingleTrack = useCallback(
    async (item: PlaylistTrackItem) => {
      if (
        !canManageLibrary ||
        !canImportItem(item) ||
        item.isInRoom ||
        pendingTrackIdsRef.current.has(item.id)
      ) {
        return;
      }
      pendingTrackIdsRef.current.add(item.id);
      setPendingTrackIds((c) => new Set(c).add(item.id));
      setDetailStatus(`正在导入《${item.title}》…`);
      try {
        if (item.providerTrack) {
          if (item.providerTrack.provider === "netease" && onImportNeteaseTrack) {
            await onImportNeteaseTrack(item.providerTrack as NeteaseTrackCandidate);
          } else if (item.providerTrack.provider === "qqmusic" && onImportQqMusicTrack) {
            await onImportQqMusicTrack(item.providerTrack as QqMusicTrackCandidate);
          } else if (item.providerTrack.provider === "bilibili" && onImportBilibiliTrack) {
            await onImportBilibiliTrack(item.providerTrack as BilibiliTrackCandidate);
          }
        } else if (item.cachedTrack && onImportCachedTrack) {
          await onImportCachedTrack(item.cachedTrack);
        }
        setSelectedKeys((c) => c.filter((k) => k !== item.id));
        setDetailStatus(`《${item.title}》导入完成。`);
      } catch (error) {
        setDetailStatus(toProviderImportErrorMessage(error));
      } finally {
        pendingTrackIdsRef.current.delete(item.id);
        setPendingTrackIds((c) => {
          const next = new Set(c);
          next.delete(item.id);
          return next;
        });
      }
    },
    [
      canImportItem,
      canManageLibrary,
      onImportBilibiliTrack,
      onImportCachedTrack,
      onImportNeteaseTrack,
      onImportQqMusicTrack
    ]
  );

  const importSelectedTracks = async () => {
    if (!canManageLibrary || isImportingSelected || selectedKeys.length === 0) return;
    setIsImportingSelected(true);
    const selectedItems = displayTracks.filter(
      (t) => selectedKeys.includes(t.id) && !t.isInRoom && canImportItem(t)
    );

    setDetailStatus(`正在批量导入 ${selectedItems.length} 首歌曲…`);
    try {
      const { importedGroups, failedMessages } = await importMissingEntries(selectedItems, {
        onImportNeteaseTracks,
        onImportQqMusicTracks,
        onImportBilibiliTracks,
        onImportCachedTrack
      });
      setSelectedKeys([]);
      if (failedMessages.length === 0) {
        setDetailStatus("批量导入完成。");
      } else if (importedGroups > 0) {
        setDetailStatus(`部分曲目导入完成（${failedMessages[0]}）。`);
      } else {
        setDetailStatus(failedMessages[0]);
      }
    } finally {
      setIsImportingSelected(false);
    }
  };

  const visibleStatus = detailStatus ?? queueStatusMessage ?? null;

  return (
    <div className="flex w-full flex-col gap-3" data-testid="room-library-playlist-detail">
      {visibleStatus ? (
        <div className="flex items-center justify-end">
          <p className="truncate text-xs text-accent" role="status">
            {visibleStatus}
          </p>
        </div>
      ) : null}

      {/* Top Header Actions */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-border/50 pb-2.5">
        <Button
          className="gap-1.5 rounded-lg text-xs font-semibold text-foreground-muted hover:text-foreground"
          onClick={onBack}
          size="sm"
          type="button"
          variant="ghost"
        >
          <span>&larr; 返回歌单列表</span>
        </Button>
        <div className="flex items-center gap-2">
          {canAddToQueue ? (
            <Button
              className="gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-white shadow-xs hover:bg-accent-hover active:scale-95 disabled:cursor-wait"
              disabled={isQueueBusyComputed}
              onClick={() => {
                setDetailStatus(null);
                onAddAllToQueue();
              }}
              size="sm"
              type="button"
            >
              <ListMusicIcon className="h-3.5 w-3.5" />
              <span>{isQueueBusyComputed ? "正在导入并加入队列…" : "全部加入队列"}</span>
            </Button>
          ) : null}
          {canManageLibrary ? (
            <Button
              className="h-8 w-8 text-foreground-muted hover:bg-red-500/15 hover:text-red-400"
              onClick={onDelete}
              size="icon"
              title="从曲库移除"
              type="button"
              variant="ghost"
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      {/* Playlist Meta Banner */}
      <div className="flex items-center gap-3.5 rounded-xl border border-surface-border/50 bg-surface/40 p-3">
        <div className="relative h-14 w-14 sm:h-16 sm:w-16 shrink-0 overflow-hidden rounded-lg border border-surface-border/60 bg-surface shadow-xs">
          {playlist.coverUrl ? (
            <img
              alt=""
              className="h-full w-full object-cover"
              src={getArtworkSourceUrl(playlist.coverUrl)}
            />
          ) : (
            <div className="grid h-full w-full place-items-center text-foreground-muted">
              <FolderIcon className="h-6 w-6" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="truncate text-sm sm:text-base font-bold text-foreground">
            {playlist.title}
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
            <span>共 {displayTracks.length} 首</span>
            <span className="text-surface-border">/</span>
            <span className={importedCount >= displayTracks.length ? "text-emerald-400 font-semibold" : "text-accent font-semibold"}>
              已导入 {importedCount} 首
            </span>
          </div>
        </div>
      </div>

      {/* Batch Import Toolbar */}
      {canManageLibrary && selectableTracks.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-surface-border/60 bg-surface/50 px-3 py-2">
          <label className="flex min-w-0 cursor-pointer items-center gap-2 text-xs text-foreground-muted select-none">
            <input
              checked={allSelectableSelected}
              className="h-4 w-4 accent-accent rounded"
              disabled={isImportBusy}
              onChange={toggleSelectAll}
              type="checkbox"
            />
            <span>{allSelectableSelected ? "取消全选" : "全选未加入歌曲"}</span>
          </label>
          <div className="flex items-center gap-2">
            <span className="text-xs tabular-nums text-foreground-muted">
              已选 {selectedKeys.length} 首
            </span>
            <Button
              className="rounded-lg h-7 px-2.5 text-xs font-medium border border-accent/30 bg-accent/5 text-accent hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={selectedKeys.length === 0 || isImportBusy}
              onClick={() => void importSelectedTracks()}
              size="sm"
              type="button"
              variant="outline"
            >
              {isImportBusy ? "加入中…" : "加入曲库"}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Track List */}
      <div className="divide-y divide-surface-border/40 overflow-hidden rounded-xl border border-surface-border/50 bg-surface/30">
        {remoteLoading ? (
          <p className="px-3 py-6 text-center text-xs text-foreground-muted">正在加载歌单歌曲信息…</p>
        ) : displayTracks.length > 0 ? (
          displayTracks.map((item, index) => {
            const isImporting = isTrackItemImporting(item);
            const isSelected = selectedKeys.includes(item.id);

            return (
              <div
                key={item.id}
                className="group flex min-w-0 items-center justify-between gap-2.5 px-3 py-2 text-xs transition-colors hover:bg-surface-hover/60"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  {!item.isInRoom && canManageLibrary && canImportItem(item) ? (
                    <input
                      checked={isSelected}
                      className="h-3.5 w-3.5 accent-accent rounded shrink-0 cursor-pointer"
                      disabled={isImportBusy}
                      onChange={() => toggleTrackSelect(item.id)}
                      type="checkbox"
                    />
                  ) : (
                    <span className="w-4 shrink-0 text-center font-mono text-xs text-foreground-muted/60">
                      {index + 1}
                    </span>
                  )}
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="truncate font-semibold text-foreground" title={item.title}>
                      {item.title}
                    </p>
                    <p className="truncate text-xs text-foreground-muted" title={`${item.artist}${item.album ? ` / ${item.album}` : ""}`}>
                      {item.artist}
                      {item.album ? ` / ${item.album}` : ""}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2 text-right">
                  <span className="tabular-nums font-mono text-xs text-foreground-muted/70">
                    {formatDuration(item.durationMs)}
                  </span>
                  {item.isInRoom ? (
                    <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400">
                      <CheckIcon className="h-3 w-3" />
                      <span>已在曲库</span>
                    </span>
                  ) : canManageLibrary && canImportItem(item) ? (
                    <button
                      className="h-7 rounded-md px-2.5 text-xs font-medium border border-accent/30 bg-accent/5 text-accent hover:bg-accent/15 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={isImporting || isImportBusy}
                      onClick={() => void importSingleTrack(item)}
                      type="button"
                    >
                      {isImporting ? "加入中…" : "加入曲库"}
                    </button>
                  ) : (
                    <span className="text-xs text-foreground-muted/60">未加入</span>
                  )}
                </div>
              </div>
            );
          })
        ) : (
          <p className="px-3 py-6 text-center text-xs text-foreground-muted">歌单中没有曲目</p>
        )}
      </div>
    </div>
  );
}
