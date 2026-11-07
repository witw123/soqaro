"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Playlist
} from "@soqaro/shared";
import { Button } from "@/components/ui/button";
import {
  DeletePlaylistDialog,
  PlaylistEditorDialog,
  PlaylistMoveDialog,
  LocalPlaylistCard,
  NetworkPlaylistCard,
  PlaylistDetailView,
  tracksForLocalPlaylist,
  resolveLegacyNetworkPlaylistArtwork,
  getPlaylistArtworkCandidates,
  uniqueArtworkUrls,
  getNetworkPlaylistSource,
  resolveProviderArtwork,
  type PlaylistSelection
} from "./index";
import { useSessionIdentity } from "@/features/session/use-session-identity";
import { useBackHandler } from "@/lib/desktop/use-back-handler";
import { buildWorkspaceAuthHref } from "@/lib/domain/client-shell";
import {
  createLocalPlaylist,
  defaultLocalPlaylistId,
  deleteLocalPlaylist,
  ensureDefaultLocalPlaylist,
  flushLocalPlaylistPersistence,
  getDefaultLocalPlaylistTrackIds,
  importLocalPlaylistDirectoryTracks,
  listLocalPlaylists,
  mergeLocalPlaylists,
  restoreLocalPlaylistsFromRepository,
  listMergedLocalPlaylistTracks,
  listRoomPlaylistTrackIndex,
  sortLocalPlaylists,
  toCachedProviderTrack,
  updateLocalPlaylist,
  upsertLocalPlaylistTrack,
  type LocalPlaylistRecord,
  type LocalPlaylistTrackRecord,
  syncSelectedLocalDirectoryTracks
} from "@/features/playlist/local-playlist";
import {
  getLocalAudioStorageState,
  requestLocalAudioDirectoryPermission,
  type LocalAudioStorageState
} from "@/features/library/local-audio-storage";
import { playlistsChangedEventName, soqaroApi } from "@/lib/network/soqaro-api";
import {
  isLocalPlaylistMirror,
  localPlaylistIdFromMirror,
  syncLocalPlaylistToDatabase
} from "@/features/playlist/local-playlist-database";
import { useFavoriteTracks } from "@/features/favorites/use-favorite-tracks";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { useLocalPlayer } from "@/features/playback/local-player-context";
import type { AnchoredDialogAnchor } from "@/components/ui/anchored-dialog";

type PlaylistDeleteTarget =
  | { kind: "local"; playlist: LocalPlaylistRecord }
  | { kind: "network"; playlist: Playlist };
type TrackMoveRequest = {
  track: LocalPlaylistTrackRecord;
  source: PlaylistSelection;
  anchor: AnchoredDialogAnchor;
};

export function PlaylistsWorkspacePage({
  playlistView = "network",
  embedded = false
}: {
  playlistView?: "local" | "network";
  embedded?: boolean;
}) {
  const router = useRouter();
  const authEntryHref = buildWorkspaceAuthHref({
    redirectTo: playlistView === "local" ? "/app/profile/playlists" : "/app/playlists"
  });
  const { activeSession, hydrated } = useSessionIdentity({
    sessionStorageKey: "soqaro-session",
    initialStatusMessage: ""
  });
  const [localTracks, setLocalTracks] = useState<LocalPlaylistTrackRecord[]>([]);
  const [localPlaylists, setLocalPlaylists] = useState<LocalPlaylistRecord[]>([]);
  const [localStorageState, setLocalStorageState] = useState<LocalAudioStorageState | null>(null);
  const [isScanningDirectory, setIsScanningDirectory] = useState(false);
  const initialSyncTriggeredRef = useRef(false);
  const [networkPlaylists, setNetworkPlaylists] = useState<Playlist[]>([]);
  const [localPlaylistDatabaseIds, setLocalPlaylistDatabaseIds] = useState<Record<string, string>>({});
  const [networkArtworkById, setNetworkArtworkById] = useState<Record<string, string[]>>({});
  const [roomTrackIndex, setRoomTrackIndex] = useState<Map<string, LocalPlaylistTrackRecord>>(() => new Map());
  const [playlistDataLoaded, setPlaylistDataLoaded] = useState(false);
  const [selectedPlaylist, setSelectedPlaylist] = useState<PlaylistSelection | null>(null);
  useBackHandler(() => setSelectedPlaylist(null), selectedPlaylist !== null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [createDialogKind, setCreateDialogKind] = useState<"local" | "network" | null>(null);
  const [newPlaylistTitle, setNewPlaylistTitle] = useState("");
  const [newPlaylistDescription, setNewPlaylistDescription] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<PlaylistDeleteTarget | null>(null);
  const [moveTarget, setMoveTarget] = useState<TrackMoveRequest | null>(null);
  const refreshVersion = useRef(0);
  const networkPlaylistsRef = useRef<Playlist[]>([]);
  const player = useLocalPlayer();
  const activeUserId = activeSession?.userId ?? null;
  const {
    isFavorite: isFavoriteTrack,
    pendingFavoriteKey,
    toggleFavorite: toggleFavoriteTrack
  } = useFavoriteTracks(activeUserId);

  const authorizeDirectory = async () => {
    if (pending) return;
    setPending(true);
    setMessage(null);
    try {
      const granted = await requestLocalAudioDirectoryPermission();
      if (!granted) {
        setMessage("未获得本地目录访问权限。");
        return;
      }
      setIsScanningDirectory(true);
      const count = await syncSelectedLocalDirectoryTracks();
      await refresh();
      setStatusMessage(`已授权并完成扫描，共识别 ${count} 首歌曲。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "目录授权失败。");
    } finally {
      setIsScanningDirectory(false);
      setPending(false);
    }
  };

  const scanDirectory = async () => {
    if (isScanningDirectory || pending) return;
    setIsScanningDirectory(true);
    setMessage(null);
    setStatusMessage(null);
    try {
      const count = await syncSelectedLocalDirectoryTracks();
      await refresh();
      setStatusMessage(`本地目录扫描完成，共识别 ${count} 首歌曲。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "扫描本地目录失败。");
    } finally {
      setIsScanningDirectory(false);
    }
  };

  function togglePlaylistTrackFavorite(track: LocalPlaylistTrackRecord) {
    const candidate = toCachedProviderTrack(track);
    if (!candidate) return;
    void toggleFavoriteTrack(candidate)
      .then(() => setStatusMessage(`已${isFavoriteTrack(candidate) ? "收藏" : "取消收藏"}《${track.title}》。`))
      .catch((error) => setMessage(error instanceof Error ? error.message : "更新歌曲收藏失败。"));
  }

  useEffect(() => {
    if (hydrated && !activeSession) router.replace(authEntryHref as Route);
  }, [activeSession, authEntryHref, hydrated, router]);

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;

    const applyLocalData = (
      tracks: LocalPlaylistTrackRecord[],
      playlists: LocalPlaylistRecord[],
      roomTracks: Map<string, LocalPlaylistTrackRecord>
    ) => {
      if (version !== refreshVersion.current) return;
      setLocalTracks(tracks);
      setLocalPlaylists(playlists);
      setRoomTrackIndex(roomTracks);
      if (playlistView === "local") setPlaylistDataLoaded(true);
      setSelectedPlaylist((current) => {
        if (!current) return null;
        if (current.kind === "local") {
          const playlist = playlists.find((item) => item.id === current.playlist.id);
          return playlist ? { kind: "local", playlist } : null;
        }
        const playlist = networkPlaylistsRef.current.find((item) => item.id === current.playlist.id);
        return playlist ? { kind: "network", playlist } : null;
      });
    };

    const applyDatabasePlaylists = (playlists: Playlist[]) => {
      if (version !== refreshVersion.current) return;
      const nextNetworkPlaylists = playlists.filter((playlist) => !isLocalPlaylistMirror(playlist));
      networkPlaylistsRef.current = nextNetworkPlaylists;
      setNetworkPlaylists(nextNetworkPlaylists);
      if (playlistView === "network") setPlaylistDataLoaded(true);
      setSelectedPlaylist((current) => {
        if (!current || current.kind !== "network") return current;
        const playlist = nextNetworkPlaylists.find((item) => item.id === current.playlist.id);
        return playlist ? { kind: "network", playlist } : null;
      });
    };

    const loadLocalData = async () => {
      await flushLocalPlaylistPersistence();
      const readLocalData = async () => {
        const [tracks, restoredPlaylists, storage, roomTracks] = await Promise.all([
          listMergedLocalPlaylistTracks(),
          restoreLocalPlaylistsFromRepository(),
          getLocalAudioStorageState(),
          listRoomPlaylistTrackIndex()
        ]);
        setLocalStorageState(storage);
        mergeLocalPlaylists(restoredPlaylists);
        const playlists = ensureDefaultLocalPlaylist({
          trackIds: getDefaultLocalPlaylistTrackIds(
            tracks,
            new Set(storage.savedFileHashes),
            { allowUnverifiedWhenEmpty: storage.permission !== "granted" }
          ),
          sourceDirectoryName: storage.directoryName
        });
        applyLocalData(tracks, playlists, roomTracks);

        if (
          !initialSyncTriggeredRef.current &&
          storage.directoryName &&
          storage.permission === "granted" &&
          storage.savedFileHashes.length === 0
        ) {
          initialSyncTriggeredRef.current = true;
          void syncSelectedLocalDirectoryTracks().then(() => {
            void refresh();
          });
        }

        return { tracks, playlists, storage, roomTracks };
      };

      return readLocalData();
    };

    const loadNetworkData = async () => {
      const playlists = await soqaroApi.listMyPlaylists();
      applyDatabasePlaylists(playlists);
      return playlists;
    };

    const [localResult, networkResult] = await Promise.allSettled([
      loadLocalData(),
      loadNetworkData()
    ]);
    if (version !== refreshVersion.current) return 0;

    if (localResult.status === "rejected") {
      if (playlistView === "local") setPlaylistDataLoaded(true);
      setMessage("本地歌单加载失败，请刷新重试。");
    }
    if (networkResult.status === "rejected") {
      if (playlistView === "network") setPlaylistDataLoaded(true);
      if (networkPlaylistsRef.current.length === 0) {
        setMessage("网络歌单加载失败，请稍后重试；本地音频仍可使用。");
      }
    }

    if (localResult.status === "fulfilled" && networkResult.status === "fulfilled") {
      const localData = localResult.value;
      const databasePlaylists = networkResult.value;
      const mergedLocalPlaylists = mergeLocalPlaylistsWithDatabase(
        localData.playlists,
        databasePlaylists.filter(isLocalPlaylistMirror)
      );
      mergeLocalPlaylists(mergedLocalPlaylists);
      const localPlaylistRecords = ensureDefaultLocalPlaylist({
        trackIds: getDefaultLocalPlaylistTrackIds(
          localData.tracks,
          new Set(localData.storage.savedFileHashes),
          { allowUnverifiedWhenEmpty: localData.storage.permission !== "granted" }
        ),
        sourceDirectoryName: localData.storage.directoryName
      });
      applyLocalData(localData.tracks, localPlaylistRecords, localData.roomTracks);

      const { ids: localPlaylistDatabaseIds, failed } =
        await syncLocalPlaylistsToDatabase(localPlaylistRecords, databasePlaylists);
      if (version === refreshVersion.current) {
        setLocalPlaylistDatabaseIds(localPlaylistDatabaseIds);
        if (failed) {
          console.warn("Some local playlist mirrors could not be synchronized.");
        } else {
          setMessage(null);
        }
      }

      if (Object.keys(localPlaylistDatabaseIds).length > 0) {
        try {
          applyDatabasePlaylists(await soqaroApi.listMyPlaylists());
        } catch {
          // The first successful response is still valid for displaying network playlists.
        }
      }
    }
    return localResult.status === "fulfilled" ? localResult.value.tracks.length : 0;
  }, [playlistView]);

  useEffect(() => {
    if (!activeSession) return;
    void refresh().catch(() => setMessage("歌单数据加载失败，请刷新重试。"));
    const handlePlaylistsChanged = () => {
      void refresh().catch(() => undefined);
    };
    window.addEventListener(playlistsChangedEventName, handlePlaylistsChanged);
    return () => {
      window.removeEventListener(playlistsChangedEventName, handlePlaylistsChanged);
    };
  }, [activeSession, playlistView, refresh]);

  useEffect(() => {
    let cancelled = false;
    if (networkPlaylists.length === 0) {
      setNetworkArtworkById({});
      return;
    }

    const loadNetworkArtwork = async () => {
      setNetworkArtworkById((current) => {
        const next = { ...current };
        for (const playlist of networkPlaylists) {
          const cachedArtwork = getPlaylistArtworkCandidates(playlist, roomTrackIndex, localTracks);
          if (cachedArtwork.length > 0) {
            next[playlist.id] = uniqueArtworkUrls([
              ...cachedArtwork,
              ...(current[playlist.id] ?? [])
            ]);
          }
        }
        return next;
      });

      await Promise.all(networkPlaylists.map(async (playlist) => {
        const source = getNetworkPlaylistSource(playlist);
        const cachedArtwork = getPlaylistArtworkCandidates(playlist, roomTrackIndex, localTracks);
        let artworkUrls = cachedArtwork;

        if (source) {
          try {
            const detail = source.provider === "netease"
              ? await soqaroApi.getNeteasePlaylist(source.playlistId)
              : source.provider === "qqmusic"
                ? await soqaroApi.getQqMusicPlaylist(source.playlistId)
                : await soqaroApi.getBilibiliVideoParts(source.playlistId).then((parts) => ({
                    artworkUrl: parts.artworkUrl,
                    tracks: parts.parts
                  }));
            artworkUrls = uniqueArtworkUrls([
              detail.artworkUrl,
              ...detail.tracks.map((track) => track.artworkUrl),
              ...cachedArtwork
            ]);
          } catch {
            const legacyArtwork = await resolveLegacyNetworkPlaylistArtwork(playlist, roomTrackIndex);
            artworkUrls = uniqueArtworkUrls([...cachedArtwork, ...legacyArtwork]);
          }
        } else {
          const legacyArtwork = await resolveLegacyNetworkPlaylistArtwork(playlist, roomTrackIndex);
          artworkUrls = uniqueArtworkUrls([...cachedArtwork, ...legacyArtwork]);
        }

        if (!cancelled && artworkUrls.length > 0) {
          setNetworkArtworkById((current) => ({
            ...current,
            [playlist.id]: uniqueArtworkUrls([
              ...artworkUrls,
              ...(current[playlist.id] ?? [])
            ])
          }));
        }
      }));
    };

    void loadNetworkArtwork();
    return () => {
      cancelled = true;
    };
  }, [localTracks, networkPlaylists, roomTrackIndex]);

  useEffect(() => {
    let cancelled = false;
    const unresolvedTracks = localTracks.filter((track) =>
      !track.artworkUrl &&
      (track.provider === "netease" || track.provider === "qqmusic") &&
      !!track.providerTrackId
    );
    if (unresolvedTracks.length === 0) return;

    const resolveMissingArtwork = async () => {
      const resolvedTracks = await Promise.all(unresolvedTracks.slice(0, 24).map(async (track) => {
        const provider = track.provider === "netease" || track.provider === "qqmusic" ? track.provider : null;
        if (!provider) return null;
        const resolved = await resolveProviderArtwork(track, provider);
        if (!resolved.artworkUrl) return null;
        try {
          await upsertLocalPlaylistTrack(resolved);
        } catch {
          // The card can still use the resolved URL for this session.
        }
        return resolved;
      }));
      if (cancelled) return;

      const resolvedById = new Map(
        resolvedTracks
          .filter((track): track is LocalPlaylistTrackRecord => !!track)
          .map((track) => [track.id, track])
      );
      if (resolvedById.size === 0) return;
      setLocalTracks((current) => current.map((track) => resolvedById.get(track.id) ?? track));
    };

    void resolveMissingArtwork();
    return () => {
      cancelled = true;
    };
  }, [localTracks]);

  async function openCreateDialog(kind: "local" | "network") {
    if (pending) return;
    setMessage(null);
    setCreateDialogKind(kind);
  }

  async function createPlaylist(kind: "local" | "network") {
    const title = newPlaylistTitle.trim();
    if (!title || pending) return;
    setPending(true);
    setMessage(null);
    setStatusMessage(null);
    try {
      let playlist: LocalPlaylistRecord | Playlist;
      if (kind === "local") {
        playlist = createLocalPlaylist({
          title,
          description: newPlaylistDescription
        });
        try {
          const imported = await importLocalPlaylistDirectoryTracks();
          const updated = updateLocalPlaylist(playlist.id, {
            trackIds: imported.tracks.map((track) => track.id),
            sourceDirectoryId: imported.sourceDirectoryId,
            sourceDirectoryName: imported.directoryName
          });
          if (updated) {
            playlist = updated;
            await syncLocalPlaylistToDatabase(updated);
          }
        } catch (error) {
          if (!(error instanceof Error && error.name === "AbortError")) {
            setMessage(error instanceof Error ? error.message : "目录读取失败，可稍后重试。 ");
          }
        }
      } else {
        playlist = await soqaroApi.createPlaylist({
          title,
          description: newPlaylistDescription.trim() || null,
          tags: ["network"],
          isCollaborative: false
        });
      }
      await refresh();
      setCreateDialogKind(null);
      setNewPlaylistTitle("");
      setNewPlaylistDescription("");
      if (kind === "local") {
        setSelectedPlaylist({ kind: "local", playlist: playlist as LocalPlaylistRecord });
      } else {
        setSelectedPlaylist({ kind: "network", playlist: playlist as Playlist });
      }
      setStatusMessage(kind === "local" ? "本地歌单已创建。" : "网络歌单已创建。可从搜索页保存网易云或 QQ 音乐歌单。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建歌单失败，请重试。");
    } finally {
      setPending(false);
    }
  }

  async function deletePlaylist() {
    if (!deleteTarget || pending) return;
    const target = deleteTarget;
    setPending(true);
    setMessage(null);
    setStatusMessage(null);
    try {
      if (target.kind === "local") {
        if (target.playlist.id === defaultLocalPlaylistId) {
          throw new Error("默认本地歌单不能删除。 ");
        }
        deleteLocalPlaylist(target.playlist.id);
        const databasePlaylistId = localPlaylistDatabaseIds[target.playlist.id];
        if (databasePlaylistId) {
          await soqaroApi.deletePlaylist(databasePlaylistId);
        }
      } else {
        await soqaroApi.deletePlaylist(target.playlist.id);
      }
      await refresh();
      if (selectedPlaylist?.kind === target.kind && selectedPlaylist.playlist.id === target.playlist.id) {
        setSelectedPlaylist(null);
      }
      setDeleteTarget(null);
      setStatusMessage(`歌单“${target.playlist.title}”已删除。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除歌单失败，请重试。");
    } finally {
      setPending(false);
    }
  }

  async function updatePlaylistTracks(target: PlaylistSelection, trackIds: string[]) {
    if (pending) return;
    setPending(true);
    setMessage(null);
    setStatusMessage(null);
    try {
      if (target.kind === "local") {
        const updated = updateLocalPlaylist(target.playlist.id, { trackIds });
        if (!updated) throw new Error("本地歌单不存在，请刷新后重试。");
        await syncLocalPlaylistToDatabase(updated, localPlaylistDatabaseIds[target.playlist.id]);
        await refresh();
        setSelectedPlaylist({ kind: "local", playlist: updated });
      } else {
        const updated = await soqaroApi.updatePlaylist(target.playlist.id, { trackIds });
        await refresh();
        setSelectedPlaylist({ kind: "network", playlist: updated });
      }
      setStatusMessage("歌单歌曲已更新。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "歌单歌曲更新失败，请重试。");
    } finally {
      setPending(false);
    }
  }

  async function moveTrackToPlaylist(request: TrackMoveRequest, target: PlaylistSelection) {
    if (pending) return;
    if (request.source.kind === target.kind && request.source.playlist.id === target.playlist.id) {
      setMoveTarget(null);
      return;
    }

    setPending(true);
    setMessage(null);
    setStatusMessage(null);
    try {
      const trackId = request.track.id;
      if (target.kind === "local") {
        const targetPlaylist = listLocalPlaylists().find((playlist) => playlist.id === target.playlist.id);
        if (!targetPlaylist) throw new Error("目标本地歌单不存在，请刷新后重试。");
        await upsertLocalPlaylistTrack(request.track);
        if (!targetPlaylist.trackIds.includes(trackId)) {
          const updatedTarget = updateLocalPlaylist(targetPlaylist.id, { trackIds: [...targetPlaylist.trackIds, trackId] });
          if (updatedTarget) await syncLocalPlaylistToDatabase(updatedTarget, localPlaylistDatabaseIds[targetPlaylist.id]);
        }
      } else {
        if (!request.track.providerTrackId || request.track.provider === "local_upload") {
          throw new Error("本地上传歌曲只能移动到本地歌单。");
        }
        if (!target.playlist.trackIds.includes(trackId)) {
          await soqaroApi.updatePlaylist(target.playlist.id, {
            trackIds: [...target.playlist.trackIds, trackId]
          });
        }
      }

      if (request.source.kind === "local") {
        const sourcePlaylist = listLocalPlaylists().find((playlist) => playlist.id === request.source.playlist.id);
        if (!sourcePlaylist) throw new Error("来源本地歌单不存在，请刷新后重试。");
        let updatedSource = sourcePlaylist;
        updatedSource = updateLocalPlaylist(sourcePlaylist.id, {
          trackIds: sourcePlaylist.trackIds.filter((id) => id !== trackId)
        }) ?? sourcePlaylist;
        await syncLocalPlaylistToDatabase(updatedSource, localPlaylistDatabaseIds[sourcePlaylist.id]);
        await refresh();
        setSelectedPlaylist({ kind: "local", playlist: updatedSource });
      } else {
        const updatedSource = await soqaroApi.updatePlaylist(request.source.playlist.id, {
          trackIds: request.source.playlist.trackIds.filter((id) => id !== trackId)
        });
        await refresh();
        setSelectedPlaylist({ kind: "network", playlist: updatedSource });
      }

      setMoveTarget(null);
      setStatusMessage(`《${request.track.title}》已移动到“${target.playlist.title}”。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "移动歌曲失败，请重试。");
    } finally {
      setPending(false);
    }
  }

  if (!hydrated || !activeSession) return embedded ? null : <div className="min-h-[calc(100*var(--app-dvh))] bg-background" />;

  const WorkspaceShell = embedded ? "section" : "main";

  return (
    <WorkspaceShell className={embedded
      ? "relative w-full text-foreground selection:bg-accent/30 selection:text-white"
      : "workspace-page relative overflow-y-auto selection:bg-accent/30 selection:text-white md:pl-60 lg:pb-28"}>
      {!embedded ? <AppPageBackground /> : null}
      <div className={embedded
        ? "relative z-10 flex w-full flex-col pb-4"
        : "workspace-page__inner relative z-10 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-[calc(var(--room-mobile-bottom-inset)+2rem)] sm:pt-6 md:pt-8 md:pb-24"}>
        {selectedPlaylist ? (
          <PlaylistDetailView
            localTracks={localTracks}
            networkArtworkUrls={selectedPlaylist.kind === "network" ? networkArtworkById[selectedPlaylist.playlist.id] : null}
            player={player}
            roomTrackIndex={roomTrackIndex}
            selection={selectedPlaylist}
            pending={pending}
            onBack={() => setSelectedPlaylist(null)}
            onArtworkResolved={selectedPlaylist.kind === "network"
              ? (artworkUrl) => setNetworkArtworkById((current) => ({
                  ...current,
                  [selectedPlaylist.playlist.id]: uniqueArtworkUrls([
                    ...(current[selectedPlaylist.playlist.id] ?? []),
                    artworkUrl
                  ])
                }))
              : undefined}
            onTrackUpdated={(track) => setLocalTracks((current) => {
              const index = current.findIndex((item) => item.id === track.id);
              if (index < 0) return [...current, track];
              const next = [...current];
              next[index] = track;
              return next;
            })}
            isFavorite={(track) => {
              const candidate = toCachedProviderTrack(track);
              return candidate ? isFavoriteTrack(candidate) : false;
            }}
            isTogglingFavorite={(track) => {
              const candidate = toCachedProviderTrack(track);
              return candidate ? pendingFavoriteKey === `${candidate.provider}:${candidate.providerTrackId}` : false;
            }}
            onToggleFavorite={togglePlaylistTrackFavorite}
            onUpdateTracks={(trackIds) => void updatePlaylistTracks(selectedPlaylist, trackIds)}
            onMoveTrack={(track, anchor) => setMoveTarget({ anchor, track, source: selectedPlaylist })}
            onDelete={selectedPlaylist.kind === "local" && selectedPlaylist.playlist.id !== defaultLocalPlaylistId
              ? () => setDeleteTarget({ kind: "local", playlist: selectedPlaylist.playlist })
              : selectedPlaylist.kind === "network"
                ? () => setDeleteTarget({ kind: "network", playlist: selectedPlaylist.playlist })
                : undefined}
            onScanDirectory={scanDirectory}
            isScanning={isScanningDirectory}
            onAuthorizeDirectory={authorizeDirectory}
            needsAuthorization={Boolean(localStorageState?.directoryName && localStorageState.permission !== "granted" && !localStorageState.fixedRoot)}
          />
        ) : (
          <>
            {playlistView === "local" ? (
              <section className="mt-2 flex flex-col gap-3.5" data-testid="local-playlists">
                <div className="flex items-center justify-between gap-3">
                  <h1 className="text-base sm:text-lg font-semibold tracking-tight text-foreground">本地歌单</h1>
                  <div className="flex items-center gap-2">
                    {localStorageState?.directoryName && localStorageState.permission !== "granted" && !localStorageState.fixedRoot ? (
                      <Button
                        className="h-8 rounded-lg px-2.5 text-xs border border-surface-border"
                        disabled={pending}
                        onClick={() => void authorizeDirectory()}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        重新授权
                      </Button>
                    ) : null}
                    {localStorageState?.directoryName && (localStorageState.permission === "granted" || localStorageState.fixedRoot) ? (
                      <Button
                        className="h-8 rounded-lg px-2.5 text-xs border border-surface-border"
                        disabled={isScanningDirectory}
                        onClick={() => void scanDirectory()}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {isScanningDirectory ? "扫描中…" : "扫描目录"}
                      </Button>
                    ) : null}
                    <Button onClick={() => void openCreateDialog("local")} size="sm" variant="outline" type="button" className="h-8 rounded-lg px-2.5 text-xs border border-surface-border">
                      <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="14"><path d="M12 5v14M5 12h14" /></svg>
                      新建本地歌单
                    </Button>
                  </div>
                </div>
                {localPlaylists.length ? (
                  <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 sm:gap-x-4 sm:gap-y-5 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                    {localPlaylists.map((playlist) => (
                      <LocalPlaylistCard
                        key={playlist.id}
                        onDelete={playlist.id === defaultLocalPlaylistId ? undefined : () => setDeleteTarget({ kind: "local", playlist })}
                        onOpen={() => setSelectedPlaylist({ kind: "local", playlist })}
                        playlist={playlist}
                        tracks={tracksForLocalPlaylist(playlist, localTracks)}
                      />
                    ))}
                  </div>
                ) : !playlistDataLoaded ? (
                  <div className="rounded-2xl border border-dashed border-surface-border px-6 py-8 text-center text-sm text-foreground-muted">正在加载本地歌单…</div>
                ) : <div className="rounded-2xl border border-dashed border-surface-border px-6 py-8 text-center text-sm text-foreground-muted">当前没有本地歌单，可使用右上角按钮新建。</div>}
              </section>
            ) : (
              <section className="mt-2 flex flex-col gap-3.5" data-testid="network-playlists">
                <div className="flex items-center justify-between gap-3">
                  <h1 className="text-base sm:text-lg font-semibold tracking-tight text-foreground">我的歌单</h1>
                  <Button onClick={() => void openCreateDialog("network")} size="sm" variant="outline" type="button" className="h-8 rounded-lg px-2.5 text-xs">
                    <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="14"><path d="M12 5v14M5 12h14" /></svg>
                    新建歌单
                  </Button>
                </div>
                {networkPlaylists.length ? (
                  <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 sm:gap-x-4 sm:gap-y-5 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                    {networkPlaylists.map((playlist) => (
                      <NetworkPlaylistCard
                        key={playlist.id}
                        onDelete={() => setDeleteTarget({ kind: "network", playlist })}
                        onOpen={() => setSelectedPlaylist({ kind: "network", playlist })}
                        playlist={playlist}
                        artworkUrls={uniqueArtworkUrls([
                          ...(networkArtworkById[playlist.id] ?? []),
                          ...getPlaylistArtworkCandidates(playlist, roomTrackIndex, localTracks)
                        ])}
                      />
                    ))}
                  </div>
                ) : !playlistDataLoaded ? (
                  <div className="rounded-2xl border border-dashed border-surface-border px-6 py-8 text-center text-sm text-foreground-muted">正在加载歌单…</div>
                ) : <div className="rounded-2xl border border-dashed border-surface-border px-6 py-8 text-center text-sm text-foreground-muted">从搜索页保存歌单后，会显示在这里。</div>}
              </section>
            )}
          </>
        )}
        {statusMessage ? <p className="mt-4 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300" role="status">{statusMessage}</p> : null}
        {message ? <p className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300" role="alert">{message}</p> : null}
        {createDialogKind ? (
          <PlaylistEditorDialog
            description={newPlaylistDescription}
            kind={createDialogKind}
            onCancel={() => setCreateDialogKind(null)}
            onDescriptionChange={setNewPlaylistDescription}
            onSubmit={() => void createPlaylist(createDialogKind)}
            onTitleChange={setNewPlaylistTitle}
            pending={pending}
            title={newPlaylistTitle}
          />
        ) : null}
        {deleteTarget ? (
          <DeletePlaylistDialog
            kind={deleteTarget.kind}
            onCancel={() => setDeleteTarget(null)}
            onConfirm={() => void deletePlaylist()}
            pending={pending}
            playlist={deleteTarget.playlist}
          />
        ) : null}
        {moveTarget ? (
          <PlaylistMoveDialog
            localPlaylists={localPlaylists}
            networkPlaylists={networkPlaylists}
            onCancel={() => {
              if (!pending) setMoveTarget(null);
            }}
            onSelect={(target) => void moveTrackToPlaylist(moveTarget, target)}
            pending={pending}
            source={moveTarget.source}
            track={moveTarget.track}
            anchor={moveTarget.anchor}
          />
        ) : null}
      </div>
    </WorkspaceShell>
  );
}

function mergeLocalPlaylistsWithDatabase(
  localPlaylists: LocalPlaylistRecord[],
  databasePlaylists: Playlist[]
) {
  const merged = new Map(localPlaylists.map((playlist) => [playlist.id, playlist]));
  for (const databasePlaylist of databasePlaylists) {
    const localId = localPlaylistIdFromMirror(databasePlaylist);
    if (!localId || merged.has(localId)) continue;
    merged.set(localId, {
      id: localId,
      title: databasePlaylist.title,
      description: databasePlaylist.description,
      trackIds: databasePlaylist.trackIds,
      sourceDirectoryId: null,
      sourceDirectoryName: null,
      createdAt: databasePlaylist.createdAt,
      updatedAt: databasePlaylist.updatedAt
    });
  }
  return sortLocalPlaylists([...merged.values()]);
}

async function syncLocalPlaylistsToDatabase(
  localPlaylists: LocalPlaylistRecord[],
  databasePlaylists: Playlist[]
) {
  const databaseByLocalId = new Map(
    databasePlaylists
      .map((playlist) => [localPlaylistIdFromMirror(playlist), playlist] as const)
      .filter((entry): entry is readonly [string, Playlist] => !!entry[0])
  );
  const ids: Record<string, string> = {};
  let failed = false;
  for (const playlist of localPlaylists) {
    try {
      const existing = databaseByLocalId.get(playlist.id);
      const synced = await syncLocalPlaylistToDatabase(playlist, existing?.id, existing);
      ids[playlist.id] = synced.id;
    } catch {
      failed = true;
    }
  }
  return { ids, failed };
}

function AppPageBackground() {
  return <div aria-hidden="true" className="workspace-page-background" />;
}

