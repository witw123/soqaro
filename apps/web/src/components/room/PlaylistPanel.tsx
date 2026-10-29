"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AuthSession,
  BilibiliTrackCandidate,
  NeteaseTrackCandidate,
  Playlist,
  ProviderTrackCandidate,
  QqMusicTrackCandidate,
  TrackMeta
} from "@soqaro/shared";
import { Button } from "@/components/ui/button";
import {
  ProviderAlbumTrackTable,
  type ProviderAlbumTrackActions
} from "@/components/provider-search/ProviderAlbumDetailView";
import { soqaroApi } from "@/lib/network/soqaro-api";
import {
  listRoomPlaylistTrackIndex,
  providerTrackKey,
  toCachedProviderTrack
} from "@/features/playlist/local-playlist";
import type { LocalPlaylistTrackRecord } from "@/features/playlist/local-playlist";
import { getArtworkSourceUrl } from "@/components/bottom-player/artwork-colors";
import { useBackHandler } from "@/lib/desktop/use-back-handler";

import { CheckIcon } from "@/components/icons/DiscoverIcons";
import { importTaskStore, useVisibleImportTasks } from "@/features/upload/import-task-store";

type ProviderTrack = ProviderTrackCandidate;
type NetworkPlaylistSource = { provider: "netease" | "qqmusic" | "bilibili"; playlistId: string };
type PlaylistTrackInfo = Pick<TrackMeta, "id" | "title" | "artist" | "album" | "durationMs" | "artworkUrl"> & {
  providerTrack: ProviderTrack | null;
  isInRoom: boolean;
};

type PlaylistPanelProps = {
  playlists: Playlist[];
  tracks: TrackMeta[];
  activeSession: AuthSession | null;
  canManageLibrary: boolean;
  canCreatePlaylist: boolean;
  onSavePlaylistFromQueue: (title: string) => Promise<void>;
  onLoadPlaylistIntoRoom: (playlistId: string) => Promise<void>;
  onImportNeteaseTrack: (track: NeteaseTrackCandidate) => Promise<void>;
  onImportQqMusicTrack: (track: QqMusicTrackCandidate) => Promise<void>;
  onImportBilibiliTrack?: (track: BilibiliTrackCandidate) => Promise<void>;
  onImportNeteaseTracks: (tracks: NeteaseTrackCandidate[]) => Promise<void>;
  onImportQqMusicTracks: (tracks: QqMusicTrackCandidate[]) => Promise<void>;
  onImportBilibiliTracks?: (tracks: BilibiliTrackCandidate[]) => Promise<void>;
  onUpdatePlaylistTitle: (playlistId: string, title: string) => Promise<void>;
  onUpdatePlaylistTracks: (playlistId: string, trackIds: string[]) => Promise<void>;
  onDeletePlaylist: (playlistId: string) => Promise<void>;
  currentRoomId?: string | null;
  roomPlaylists?: Playlist[];
  onRefreshRoom?: () => Promise<unknown>;
};

export function PlaylistPanel({
  playlists,
  tracks,
  activeSession: _activeSession,
  canManageLibrary,
  canCreatePlaylist: _canCreatePlaylist,
  onSavePlaylistFromQueue: _onSavePlaylistFromQueue,
  onLoadPlaylistIntoRoom,
  onImportNeteaseTrack,
  onImportQqMusicTrack,
  onImportBilibiliTrack,
  onImportNeteaseTracks,
  onImportQqMusicTracks,
  onImportBilibiliTracks,
  onDeletePlaylist: _onDeletePlaylist,
  currentRoomId,
  roomPlaylists,
  onRefreshRoom
}: PlaylistPanelProps) {
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  useBackHandler(() => setSelectedPlaylistId(null), selectedPlaylistId !== null);
  const [loadingPlaylistId, setLoadingPlaylistId] = useState<string | null>(null);
  const [addingToLibraryId, setAddingToLibraryId] = useState<string | null>(null);
  const [libraryFeedback, setLibraryFeedback] = useState<string | null>(null);
  const [remoteTracks, setRemoteTracks] = useState<ProviderTrack[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [cachedTracks, setCachedTracks] = useState<Map<string, LocalPlaylistTrackRecord>>(new Map());
  const [networkArtworkById, setNetworkArtworkById] = useState<Record<string, string[]>>({});
  const artworkRequestIdsRef = useRef(new Set<string>());
  const displayPlaylists = useMemo(() => {
    const seen = new Set<string>();
    return playlists.filter((p) => {
      if (p.tags?.some((t) => t.startsWith("source_playlist:"))) return false;
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  }, [playlists]);
  const selectedPlaylist = displayPlaylists.find((playlist) => playlist.id === selectedPlaylistId) ?? null;
  const selectedSource = selectedPlaylist ? getNetworkPlaylistSource(selectedPlaylist) : null;
  const selectedProvider = selectedSource?.provider ?? null;
  const selectedProviderPlaylistId = selectedSource?.playlistId ?? null;
  const roomProviderTrackKeys = new Set(
    tracks.flatMap((track) => {
      const source = track.sourceRef;
      return source ? [`${source.provider}:${source.trackId}`] : [];
    })
  );
  const roomTrackMap = new Map<string, PlaylistTrackInfo>();
  for (const track of tracks) {
    const providerKey = track.sourceRef
      ? providerTrackKey(track.sourceRef.provider, track.sourceRef.trackId)
      : null;
    const cached = providerKey ? cachedTracks.get(providerKey) : cachedTracks.get(track.id);
    const info = toPlaylistTrackInfo(track, roomProviderTrackKeys, cached);
    roomTrackMap.set(track.id, info);
    if (providerKey) roomTrackMap.set(providerKey, info);
  }
  const cachedTrackMap = new Map(
    [...cachedTracks.values()]
      .map((track) => {
        const providerTrack = toCachedProviderTrack(track);
        return providerTrack ? [providerTrackKey(providerTrack.provider, providerTrack.providerTrackId), toPlaylistTrackInfo(providerTrack, roomProviderTrackKeys, track)] as const : null;
      })
      .filter((entry): entry is readonly [string, PlaylistTrackInfo] => !!entry)
  );
  const remoteTrackMap = new Map(
    remoteTracks.map((track) => [
      providerTrackKey(track.provider, track.providerTrackId),
      toPlaylistTrackInfo(track, roomProviderTrackKeys, cachedTracks.get(providerTrackKey(track.provider, track.providerTrackId)))
    ])
  );
  const selectedPlaylistTracks = selectedPlaylist
    ? selectedPlaylist.trackIds.map((trackId, index) =>
        remoteTrackMap.get(trackId)
        ?? (trackId.startsWith("local:") && remoteTracks[index]
          ? toPlaylistTrackInfo(remoteTracks[index], roomProviderTrackKeys, cachedTracks.get(providerTrackKey(remoteTracks[index].provider, remoteTracks[index].providerTrackId)))
          : undefined)
        ?? cachedTrackMap.get(trackId)
        ?? roomTrackMap.get(trackId)
        ?? null
      )
    : [];

  useEffect(() => {
    let cancelled = false;
    void listRoomPlaylistTrackIndex()
      .then((index) => {
        if (!cancelled) setCachedTracks(index);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const artworkRequestIds = artworkRequestIdsRef.current;
    const candidateById = new Map(
      displayPlaylists.map((playlist) => [
        playlist.id,
        getPlaylistArtworkCandidates(playlist, cachedTracks, tracks)
      ])
    );

    setNetworkArtworkById((current) => {
      const next: Record<string, string[]> = {};
      for (const playlist of displayPlaylists) {
        const artworkUrls = uniqueArtworkUrls([
          ...(candidateById.get(playlist.id) ?? []),
          ...(current[playlist.id] ?? [])
        ]);
        if (artworkUrls.length > 0) next[playlist.id] = artworkUrls;
      }
      return next;
    });

    const requests = displayPlaylists
      .map((playlist) => {
        const source = getNetworkPlaylistSource(playlist);
        if (!source || artworkRequestIds.has(playlist.id)) {
          return null;
        }
        artworkRequestIds.add(playlist.id);
        return { playlist, source };
      })
      .filter((request): request is NonNullable<typeof request> => !!request);

    void Promise.all(requests.map(async ({ playlist, source }) => {
      try {
        const detail = source.provider === "netease"
          ? await soqaroApi.getNeteasePlaylist(source.playlistId)
          : source.provider === "qqmusic"
            ? await soqaroApi.getQqMusicPlaylist(source.playlistId)
            : await soqaroApi.getBilibiliVideoParts(source.playlistId).then((p) => ({
                artworkUrl: p.artworkUrl,
                tracks: p.parts
              }));
        const artworkUrls = uniqueArtworkUrls([
          detail.artworkUrl,
          ...detail.tracks.map((track) => track.artworkUrl)
        ]);
        if (cancelled || artworkUrls.length === 0) return;
        setNetworkArtworkById((current) => ({
          ...current,
          [playlist.id]: uniqueArtworkUrls([
            ...artworkUrls,
            ...(current[playlist.id] ?? [])
          ])
        }));
      } catch {
        // A playlist can still render its title when the provider is unavailable.
      }
    }));

    return () => {
      cancelled = true;
      for (const { playlist } of requests) {
        artworkRequestIds.delete(playlist.id);
      }
    };
  }, [cachedTracks, displayPlaylists, tracks]);

  useEffect(() => {
    let cancelled = false;
    setRemoteTracks([]);
    setRemoteError(null);

    if (!selectedPlaylistId || !selectedProvider || !selectedProviderPlaylistId) {
      setRemoteLoading(false);
      return;
    }

    setRemoteLoading(true);
    const request = selectedProvider === "netease"
      ? soqaroApi.getNeteasePlaylist(selectedProviderPlaylistId)
      : selectedProvider === "qqmusic"
        ? soqaroApi.getQqMusicPlaylist(selectedProviderPlaylistId)
        : soqaroApi.getBilibiliVideoParts(selectedProviderPlaylistId).then((partsDetail) => ({
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
    void request
      .then((detail) => {
        if (!cancelled) {
          setRemoteTracks(detail.tracks);
          const artworkUrls = uniqueArtworkUrls([
            detail.artworkUrl,
            ...detail.tracks.map((track) => track.artworkUrl)
          ]);
          if (artworkUrls.length > 0) {
            setNetworkArtworkById((current) => ({
              ...current,
              [selectedPlaylistId]: uniqueArtworkUrls([
                ...artworkUrls,
                ...(current[selectedPlaylistId] ?? [])
              ])
            }));
          }
        }
      })
      .catch((error) => {
        if (!cancelled) setRemoteError(error instanceof Error ? error.message : "网络歌曲信息加载失败。");
      })
      .finally(() => {
        if (!cancelled) setRemoteLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedPlaylistId, selectedProvider, selectedProviderPlaylistId]);

  const isPlaylistInRoom = useCallback((targetPlaylist: Playlist) => {
    if (!roomPlaylists || roomPlaylists.length === 0) return false;
    const targetSource = getNetworkPlaylistSource(targetPlaylist);
    return roomPlaylists.some((rp) => {
      if (rp.id === targetPlaylist.id) return true;
      if (rp.tags?.includes(`source_playlist:${targetPlaylist.id}`)) return true;
      if (targetSource) {
        const rpSource = getNetworkPlaylistSource(rp);
        if (rpSource && rpSource.provider === targetSource.provider && rpSource.playlistId === targetSource.playlistId) {
          return true;
        }
      }
      return rp.title === targetPlaylist.title && rp.trackIds.length === targetPlaylist.trackIds.length;
    });
  }, [roomPlaylists]);

  useVisibleImportTasks();
  const handleAddToLibrary = async (playlist: Playlist) => {
    if (!currentRoomId || !canManageLibrary || addingToLibraryId !== null) return;
    setAddingToLibraryId(playlist.id);
    setLibraryFeedback(null);
    const taskId = importTaskStore.startTask({
      type: "playlist_load",
      title: `添加歌单《${playlist.title}》到曲库`,
      totalCount: 1,
      itemKeys: [playlist.id, `playlist:${playlist.id}`],
      currentStage: "正在解析曲目并添加"
    });
    try {
      const source = getNetworkPlaylistSource(playlist);
      let allCandidates: ProviderTrack[] = [];
      if (source) {
        try {
          const detail = source.provider === "netease"
            ? await soqaroApi.getNeteasePlaylist(source.playlistId)
            : source.provider === "qqmusic"
              ? await soqaroApi.getQqMusicPlaylist(source.playlistId)
              : await soqaroApi.getBilibiliVideoParts(source.playlistId).then((p) => ({
                  tracks: p.parts
                }));
          allCandidates = detail.tracks;
        } catch {
          // Gracefully continue
        }
      }

      // If allCandidates is empty but we have cached tracks, try to find them
      if (allCandidates.length === 0 && playlist.trackIds.length > 0) {
        for (const trackId of playlist.trackIds) {
          const cached = cachedTracks.get(trackId);
          if (cached) {
            const providerTrack = toCachedProviderTrack(cached);
            if (providerTrack) {
              allCandidates.push(providerTrack);
            }
          }
        }
      }

      const tags = (playlist.tags || [])
        .filter((t) => typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim().slice(0, 100));

      if (source && !tags.some((t) => t.startsWith("network:"))) {
        tags.push(`network:${source.provider}:${source.playlistId}`.slice(0, 100));
      }
      if (!tags.includes(`source_playlist:${playlist.id}`)) {
        tags.push(`source_playlist:${playlist.id}`.slice(0, 100));
      }

      const rawTrackIds = allCandidates.length > 0
        ? allCandidates.map((t) => providerTrackKey(t.provider, t.providerTrackId))
        : playlist.trackIds;
      const trackIds = rawTrackIds
        .filter((id) => typeof id === "string" && id.trim().length > 0);

      await soqaroApi.createPlaylist({
        title: (playlist.title || "未命名歌单").trim().slice(0, 160),
        description: playlist.description ? playlist.description.trim().slice(0, 4000) : null,
        trackIds,
        tags: tags.slice(0, 50),
        coverUrl: playlist.coverUrl || null,
        roomId: currentRoomId
      });

      if (onRefreshRoom) {
        await onRefreshRoom();
      }

      setLibraryFeedback(`已将歌单《${playlist.title}》加入曲库，可在曲库歌单中按需加载歌曲。`);
      importTaskStore.finishTask(taskId);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "添加到曲库失败。";
      setLibraryFeedback(errMsg);
      importTaskStore.finishTask(taskId, { error: errMsg });
    } finally {
      setAddingToLibraryId(null);
    }
  };

  const handleLoadAndPlayPlaylist = async (playlistId: string) => {
    if (!onLoadPlaylistIntoRoom || loadingPlaylistId !== null) return;
    setLoadingPlaylistId(playlistId);
    try {
      await onLoadPlaylistIntoRoom(playlistId);
    } finally {
      setLoadingPlaylistId(null);
    }
  };

  if (selectedPlaylist) {
    return (
      <PlaylistDetail
        onBack={() => {
          setSelectedPlaylistId(null);
        }}
        onPlayPlaylist={() => void handleLoadAndPlayPlaylist(selectedPlaylist.id)}
        isPlaylistLoading={loadingPlaylistId === selectedPlaylist.id}
        canAddToLibrary={Boolean(currentRoomId && canManageLibrary)}
        isInLibrary={isPlaylistInRoom(selectedPlaylist)}
        isAddingToLibrary={addingToLibraryId === selectedPlaylist.id}
        onAddToLibrary={() => void handleAddToLibrary(selectedPlaylist)}
        onImportNeteaseTrack={onImportNeteaseTrack}
        onImportQqMusicTrack={onImportQqMusicTrack}
        onImportBilibiliTrack={onImportBilibiliTrack}
        onImportNeteaseTracks={onImportNeteaseTracks}
        onImportQqMusicTracks={onImportQqMusicTracks}
        onImportBilibiliTracks={onImportBilibiliTracks}
        canManageLibrary={canManageLibrary}
        playlist={selectedPlaylist}
        remoteError={remoteError}
        remoteLoading={remoteLoading}
        tracks={selectedPlaylistTracks}
        onRefreshRoom={onRefreshRoom}
      />
    );
  }

  return (
    <section className="flex w-full flex-col gap-3" data-testid="network-playlist-panel">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground">网络歌单</p>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2">
          {libraryFeedback ? (
            <span className="text-xs text-accent truncate max-w-xs">{libraryFeedback}</span>
          ) : null}
          <span className="font-mono text-xs text-foreground-muted">{displayPlaylists.length} 个歌单</span>
        </div>
      </div>

      {displayPlaylists.length > 0 ? (
        <div className="divide-y divide-surface-border overflow-hidden rounded-lg border border-surface-border bg-surface/40">
          {displayPlaylists.map((playlist) => (
            <PlaylistCard
              key={playlist.id}
              artworkUrls={networkArtworkById[playlist.id] ?? []}
              canAddToLibrary={Boolean(currentRoomId && canManageLibrary)}
              isInLibrary={isPlaylistInRoom(playlist)}
              isAddingToLibrary={
                addingToLibraryId === playlist.id ||
                importTaskStore.isItemImporting(playlist.id) ||
                importTaskStore.isItemImporting(`playlist:${playlist.id}`)
              }
              onAddToLibrary={() => void handleAddToLibrary(playlist)}
              onOpen={() => setSelectedPlaylistId(playlist.id)}
              playlist={playlist}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-surface-border px-4 py-4 text-xs text-foreground-muted">
          当前房间还没有网络歌单。
        </div>
      )}
    </section>
  );
}

function PlaylistCard({
  playlist,
  artworkUrls,
  onOpen,
  canAddToLibrary,
  isInLibrary,
  isAddingToLibrary,
  onAddToLibrary
}: {
  playlist: Playlist;
  artworkUrls: readonly string[];
  onOpen: () => void;
  canAddToLibrary?: boolean;
  isInLibrary?: boolean;
  isAddingToLibrary?: boolean;
  onAddToLibrary?: () => void;
}) {
  const source = getNetworkPlaylistSource(playlist);
  const providerName = source?.provider === "qqmusic" ? "QQ 音乐" : source?.provider === "netease" ? "网易云音乐" : "网络歌单";

  return (
    <article className="group flex min-w-0 items-center justify-between gap-3 px-3 py-3 text-left transition-colors hover:bg-surface-hover">
      <button
        aria-label={`打开歌单 ${playlist.title}`}
        className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70"
        onClick={onOpen}
        type="button"
      >
        <Artwork artworkUrls={artworkUrls} size="sm" title={playlist.title} />
        <div className="min-w-0 flex-1 space-y-1">
          <strong className="block truncate text-sm font-semibold text-foreground group-hover:text-accent transition-colors">
            {playlist.title}
          </strong>
          <p className="truncate text-xs text-foreground-muted">{providerName} / {playlist.trackIds.length} 首歌曲</p>
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-2">
        {canAddToLibrary ? (
          <button
            type="button"
            disabled={isInLibrary || isAddingToLibrary}
            onClick={(e) => {
              e.stopPropagation();
              onAddToLibrary?.();
            }}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              isInLibrary
                ? "cursor-default border border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                : "border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
            }`}
          >
            {isInLibrary ? (
              <>
                <CheckIcon className="h-3 w-3" />
                <span>已在曲库</span>
              </>
            ) : isAddingToLibrary ? (
              "加入中…"
            ) : (
              "加入曲库"
            )}
          </button>
        ) : null}
        <span className="shrink-0 text-xs text-foreground-muted">查看</span>
      </div>
    </article>
  );
}

function PlaylistDetail({
  playlist,
  onBack,
  onPlayPlaylist,
  isPlaylistLoading,
  canAddToLibrary,
  isInLibrary,
  isAddingToLibrary,
  onAddToLibrary,
  onImportNeteaseTrack,
  onImportQqMusicTrack,
  onImportBilibiliTrack,
  onImportNeteaseTracks,
  onImportQqMusicTracks,
  onImportBilibiliTracks,
  canManageLibrary,
  tracks,
  remoteLoading,
  remoteError,
  onRefreshRoom
}: {
  playlist: Playlist;
  onBack: () => void;
  onPlayPlaylist?: () => void;
  isPlaylistLoading?: boolean;
  canAddToLibrary?: boolean;
  isInLibrary?: boolean;
  isAddingToLibrary?: boolean;
  onAddToLibrary?: () => void;
  onImportNeteaseTrack: (track: NeteaseTrackCandidate) => Promise<void>;
  onImportQqMusicTrack: (track: QqMusicTrackCandidate) => Promise<void>;
  onImportBilibiliTrack?: (track: BilibiliTrackCandidate) => Promise<void>;
  onImportNeteaseTracks: (tracks: NeteaseTrackCandidate[]) => Promise<void>;
  onImportQqMusicTracks: (tracks: QqMusicTrackCandidate[]) => Promise<void>;
  onImportBilibiliTracks?: (tracks: BilibiliTrackCandidate[]) => Promise<void>;
  canManageLibrary: boolean;
  tracks: Array<PlaylistTrackInfo | null>;
  remoteLoading: boolean;
  remoteError: string | null;
  onRefreshRoom?: () => Promise<unknown> | unknown;
}) {
  const [selectedTrackKeys, setSelectedTrackKeys] = useState<string[]>([]);
  const [pendingTrackIds, setPendingTrackIds] = useState<Set<string>>(new Set());
  const pendingTrackIdsRef = useRef(new Set<string>());
  const [isImportingSelected, setIsImportingSelected] = useState(false);

  // Convert PlaylistTrackInfo[] to ProviderTrack[] to seamlessly feed ProviderAlbumTrackTable
  const displayTracks: ProviderTrack[] = useMemo(() => {
    return tracks.map((track, index) => {
      if (track?.providerTrack) return track.providerTrack;
      const rawId = playlist.trackIds[index] || `network:${index}`;
      const parts = rawId.split(":");
      const provider = (parts[1] === "qqmusic" ? "qqmusic" : parts[1] === "bilibili" ? "bilibili" : "netease") as "netease" | "qqmusic" | "bilibili";
      const providerTrackId = parts[2] || parts[1] || String(index);
      return {
        provider,
        providerTrackId,
        title: track?.title ?? `曲目 ${index + 1}`,
        artist: track?.artist ?? "未知歌手",
        album: track?.album ?? null,
        durationMs: track?.durationMs ?? 0,
        artworkUrl: track?.artworkUrl ?? null,
        access: "free" as const,
        quality: "standard" as const
      };
    });
  }, [tracks, playlist.trackIds]);

  const trackKeyToInfo = useMemo(() => {
    const map = new Map<string, PlaylistTrackInfo>();
    tracks.forEach((track, index) => {
      if (!track) return;
      if (track.providerTrack) {
        map.set(`${track.providerTrack.provider}:${track.providerTrack.providerTrackId}`, track);
      }
      map.set(track.id, track);
      const rawId = playlist.trackIds[index];
      if (rawId) map.set(rawId, track);
    });
    return map;
  }, [tracks, playlist.trackIds]);

  const selectableTracks = useMemo(() => {
    return tracks.filter(
      (track): track is PlaylistTrackInfo => !!track?.providerTrack && !track.isInRoom
    );
  }, [tracks]);

  const selectableKeys = useMemo(() => {
    return selectableTracks.map((t: PlaylistTrackInfo) => `${t.providerTrack!.provider}:${t.providerTrack!.providerTrackId}`);
  }, [selectableTracks]);

  const selectedTracks = useMemo(() => {
    return selectedTrackKeys
      .map((key) => trackKeyToInfo.get(key))
      .filter((t): t is PlaylistTrackInfo => !!t && !t.isInRoom);
  }, [selectedTrackKeys, trackKeyToInfo]);

  const allSelectableSelected = selectableKeys.length > 0 && selectedTrackKeys.length >= selectableKeys.length;
  const isImportBusy =
    pendingTrackIds.size > 0 ||
    isImportingSelected ||
    selectableKeys.some((k) => importTaskStore.isItemImporting(k));

  useEffect(() => {
    const validKeys = new Set(selectableKeys);
    setSelectedTrackKeys((current) => {
      const next = current.filter((key) => validKeys.has(key));
      return next.length === current.length ? current : next;
    });
  }, [selectableKeys]);

  const importTrack = useCallback(async (track: PlaylistTrackInfo) => {
    if (
      !canManageLibrary ||
      !track.providerTrack ||
      track.isInRoom ||
      pendingTrackIdsRef.current.has(track.id)
    ) return;
    pendingTrackIdsRef.current.add(track.id);
    setPendingTrackIds((current) => new Set(current).add(track.id));
    const trackKey = `${track.providerTrack.provider}:${track.providerTrack.providerTrackId}`;
    try {
      if (track.providerTrack.provider === "netease") {
        await onImportNeteaseTrack(track.providerTrack);
      } else if (track.providerTrack.provider === "qqmusic") {
        await onImportQqMusicTrack(track.providerTrack);
      } else if (track.providerTrack.provider === "bilibili" && onImportBilibiliTrack) {
        await onImportBilibiliTrack(track.providerTrack as BilibiliTrackCandidate);
      }
      setSelectedTrackKeys((current) => current.filter((k) => k !== trackKey && k !== track.id));
      if (onRefreshRoom) {
        await onRefreshRoom();
      }
    } catch {
      // Handled through room status
    } finally {
      pendingTrackIdsRef.current.delete(track.id);
      setPendingTrackIds((current) => {
        const next = new Set(current);
        next.delete(track.id);
        return next;
      });
    }
  }, [canManageLibrary, onImportBilibiliTrack, onImportNeteaseTrack, onImportQqMusicTrack, onRefreshRoom]);

  const importSelectedTracks = async () => {
    if (!canManageLibrary || isImportBusy || selectedTracks.length === 0) return;
    setIsImportingSelected(true);
    const selectedIds = new Set<string>(selectedTracks.map((track: PlaylistTrackInfo) => track.id));
    setPendingTrackIds(selectedIds);
    for (const track of selectedTracks) pendingTrackIdsRef.current.add(track.id);
    const neteaseTracks = selectedTracks
      .filter((track: PlaylistTrackInfo) => track.providerTrack?.provider === "netease")
      .map((track: PlaylistTrackInfo) => track.providerTrack) as NeteaseTrackCandidate[];
    const qqMusicTracks = selectedTracks
      .filter((track: PlaylistTrackInfo) => track.providerTrack?.provider === "qqmusic")
      .map((track: PlaylistTrackInfo) => track.providerTrack) as QqMusicTrackCandidate[];
    const bilibiliTracks = selectedTracks
      .filter((track: PlaylistTrackInfo) => track.providerTrack?.provider === "bilibili")
      .map((track: PlaylistTrackInfo) => track.providerTrack) as BilibiliTrackCandidate[];
    try {
      if (neteaseTracks.length > 0) {
        await onImportNeteaseTracks(neteaseTracks).catch(() => undefined);
      }
      if (qqMusicTracks.length > 0) {
        await onImportQqMusicTracks(qqMusicTracks).catch(() => undefined);
      }
      if (bilibiliTracks.length > 0 && onImportBilibiliTracks) {
        await onImportBilibiliTracks(bilibiliTracks).catch(() => undefined);
      }
      if (onRefreshRoom) {
        await onRefreshRoom();
      }
      setSelectedTrackKeys([]);
    } finally {
      for (const track of selectedTracks) pendingTrackIdsRef.current.delete(track.id);
      setPendingTrackIds(new Set());
      setIsImportingSelected(false);
    }
  };

  const toggleTrackSelection = (trackKey: string) => {
    setSelectedTrackKeys((current) =>
      current.includes(trackKey)
        ? current.filter((item) => item !== trackKey)
        : [...current, trackKey]
    );
  };

  const toggleSelectAll = () => {
    setSelectedTrackKeys(allSelectableSelected ? [] : selectableKeys);
  };

  const trackActions: ProviderAlbumTrackActions = useMemo(() => ({
    onPlay: onPlayPlaylist ? () => {
      onPlayPlaylist();
    } : undefined,
    isInRoom: (track: ProviderTrack) => {
      const info = trackKeyToInfo.get(`${track.provider}:${track.providerTrackId}`);
      return info?.isInRoom ?? false;
    },
    isImporting: (track: ProviderTrack) => {
      const info = trackKeyToInfo.get(`${track.provider}:${track.providerTrackId}`);
      if (info && pendingTrackIds.has(info.id)) return true;
      if (importTaskStore.isItemImporting(`${track.provider}:${track.providerTrackId}`)) return true;
      if (importTaskStore.isItemImporting(track.providerTrackId)) return true;
      return false;
    },
    onImport: canManageLibrary ? (track: ProviderTrack) => {
      const info = trackKeyToInfo.get(`${track.provider}:${track.providerTrackId}`);
      if (info) void importTrack(info);
    } : undefined
  }), [canManageLibrary, importTrack, onPlayPlaylist, pendingTrackIds, trackKeyToInfo]);

  return (
    <section className="flex w-full flex-col" data-testid="network-playlist-detail">
      {/* Top Header Actions */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-surface-border/40 pb-3">
        <Button className="gap-1.5 rounded-xl text-xs font-semibold text-foreground-muted hover:text-foreground" onClick={onBack} size="sm" type="button" variant="ghost">
          <ArrowLeftIcon />
          <span>返回歌单</span>
        </Button>
        <div className="flex items-center gap-2">
          {canAddToLibrary ? (
            isInLibrary ? (
              <span className="flex h-7.5 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20">
                <CheckIcon className="h-3.5 w-3.5" />
                <span>已在曲库</span>
              </span>
            ) : (
              <Button
                className="gap-1 rounded-lg h-7.5 px-2.5 text-xs font-medium"
                disabled={isAddingToLibrary}
                onClick={onAddToLibrary}
                size="sm"
                type="button"
                variant="outline"
              >
                {isAddingToLibrary ? "加入中…" : "加入曲库"}
              </Button>
            )
          ) : null}
          {onPlayPlaylist ? (
            <Button
              className="gap-1.5 rounded-xl bg-accent text-white shadow-xs transition-all hover:bg-accent-hover active:scale-95 disabled:cursor-wait text-xs"
              disabled={isPlaylistLoading}
              onClick={onPlayPlaylist}
              size="sm"
              type="button"
              title="将整张歌单载入房间并开始播放"
            >
              {isPlaylistLoading ? (
                <>
                  <LoadingSpinner className="h-3.5 w-3.5 animate-spin" />
                  <span>载入播放中…</span>
                </>
              ) : (
                <>
                  <PlayIcon className="h-3.5 w-3.5 fill-current" />
                  <span>播放整张歌单</span>
                </>
              )}
            </Button>
          ) : null}
        </div>
      </div>

      {/* Optional Batch Import Toolbar */}
      {canManageLibrary && selectableTracks.length > 0 ? (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-surface-border/60 bg-surface/50 px-3 py-2">
          <label className="flex min-w-0 cursor-pointer items-center gap-2 text-xs text-foreground-muted">
            <input
              type="checkbox"
              checked={allSelectableSelected}
              disabled={isImportBusy}
              onChange={toggleSelectAll}
              className="h-4 w-4 accent-accent rounded"
            />
            <span>{allSelectableSelected ? "取消全选" : "全选未加入歌曲"}</span>
          </label>
          <div className="flex items-center gap-2">
            <span className="text-xs tabular-nums text-foreground-muted">已选 {selectedTracks.length} 首</span>
            <Button
              disabled={selectedTracks.length === 0 || isImportBusy}
              onClick={() => void importSelectedTracks()}
              size="sm"
              variant="outline"
              className="rounded-lg h-7 px-2.5 text-xs font-medium border border-accent/30 bg-accent/5 text-accent hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
            >
              {isImportBusy ? "加入中…" : "加入曲库"}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Tracks Surface - Same track table as the favorites songs list */}
      <div data-testid="network-playlist-tracks">
        {remoteLoading ? <p className="px-3 py-4 text-center text-xs text-foreground-muted">正在加载歌曲信息…</p> : null}
        {remoteError ? <p className="px-3 py-4 text-center text-xs text-amber-500">歌曲信息加载失败，当前显示已保存的歌曲索引。</p> : null}
        {displayTracks.length > 0 ? (
          <ProviderAlbumTrackTable
            actions={trackActions}
            onToggleSelect={canManageLibrary && selectableTracks.length > 0 ? toggleTrackSelection : undefined}
            selectablePredicate={(track) => !trackKeyToInfo.get(`${track.provider}:${track.providerTrackId}`)?.isInRoom}
            selectedTrackIds={selectedTrackKeys}
            showToolbar={false}
            tracks={displayTracks}
          />
        ) : !remoteLoading ? (
          <p className="px-3 py-8 text-center text-xs text-foreground-muted">这个歌单还没有歌曲。</p>
        ) : null}
      </div>
    </section>
  );
}

function Artwork({ artworkUrl, artworkUrls, title, size = "sm" }: {
  artworkUrl?: string | null;
  artworkUrls?: readonly (string | null | undefined)[];
  title: string;
  size?: "sm" | "lg" | "row" | "cover";
}) {
  const sizeClass = size === "cover"
    ? "aspect-square w-full rounded-none"
    : size === "lg"
      ? "h-24 w-24 rounded-xl"
      : size === "row"
        ? "h-16 w-16 rounded-lg"
      : "h-10 w-10 rounded-lg";
  const sources = uniqueArtworkUrls([...(artworkUrls ?? []), artworkUrl]);
  const sourceKey = sources.join("\u001f");
  const [failedSourceIndex, setFailedSourceIndex] = useState(0);

  useEffect(() => {
    setFailedSourceIndex(0);
  }, [sourceKey]);

  const activeArtworkUrl = sources[failedSourceIndex] ?? null;

  return (
    <div
      aria-label={`${title} 封面`}
      className={`${sizeClass} flex shrink-0 items-center justify-center overflow-hidden border border-surface-border bg-surface text-lg font-bold text-foreground-muted`}
    >
      {activeArtworkUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img loading="lazy"
          alt=""
          className="h-full w-full object-cover"
          decoding="async"
          draggable={false}
          onError={() => setFailedSourceIndex((current) => current + 1)}
          src={getArtworkSourceUrl(activeArtworkUrl)}
        />
      ) : title.slice(0, 1).toUpperCase()}
    </div>
  );
}

function getNetworkPlaylistSource(playlist: Playlist): NetworkPlaylistSource | null {
  const sourceTag = playlist.tags.find((tag) => tag.startsWith("network:"));
  if (!sourceTag) return null;
  const [, provider, ...playlistIdParts] = sourceTag.split(":");
  if (provider !== "netease" && provider !== "qqmusic" && provider !== "bilibili") return null;
  const playlistId = playlistIdParts.join(":").trim();
  return playlistId ? { provider, playlistId } : null;
}

function getPlaylistArtworkCandidates(
  playlist: Playlist,
  cachedTracks: ReadonlyMap<string, LocalPlaylistTrackRecord>,
  roomTracks: readonly TrackMeta[]
) {
  const roomTrackMap = new Map<string, string | null>(
    roomTracks.map((track) => [track.id, track.artworkUrl])
  );
  for (const track of roomTracks) {
    if (track.sourceRef) {
      roomTrackMap.set(providerTrackKey(track.sourceRef.provider, track.sourceRef.trackId), track.artworkUrl);
    }
  }

  return uniqueArtworkUrls([
    playlist.coverUrl,
    ...playlist.trackIds.flatMap((trackId) => [
      cachedTracks.get(trackId)?.artworkUrl,
      roomTrackMap.get(trackId)
    ])
  ]);
}

function uniqueArtworkUrls(urls: readonly (string | null | undefined)[]) {
  const result: string[] = [];
  for (const value of urls) {
    if (typeof value !== "string") continue;
    const url = value.trim();
    if (!url) continue;
    const secureUrl = url.replace(/^http:\/\//i, "https://");
    if (!result.includes(secureUrl)) result.push(secureUrl);
    if (secureUrl !== url && !result.includes(url)) result.push(url);
  }
  return result;
}

function toPlaylistTrackInfo(
  track: TrackMeta | ProviderTrack,
  roomProviderTrackKeys: Set<string>,
  cached?: LocalPlaylistTrackRecord
): PlaylistTrackInfo {
  const isProviderTrack = "providerTrackId" in track;
  return {
    id: isProviderTrack ? `provider:${track.provider}:${track.providerTrackId}` : track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationMs: track.durationMs,
    artworkUrl: track.artworkUrl ?? cached?.artworkUrl ?? null,
    providerTrack: isProviderTrack ? track : null,
    isInRoom: isProviderTrack
      ? roomProviderTrackKeys.has(`${track.provider}:${track.providerTrackId}`)
      : true
  };
}

function ArrowLeftIcon() {
  return <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="16"><path d="m15 18-6-6 6-6" /></svg>;
}

function PlayIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="currentColor" height="15" viewBox="0 0 24 24" width="15">
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}

function LoadingSpinner({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" height="15" viewBox="0 0 24 24" width="15">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

