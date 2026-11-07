"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  Playlist,
  RoomDirectoryItem,
  RoomMediaConnectionState,
  RoomSnapshot
} from "@soqaro/shared";
import type { Route } from "next";
import {
  soqaroApi,
  playlistsChangedEventName,
  playlistsChangedStorageKey
} from "@/lib/network/soqaro-api";
import { isLocalPlaylistMirror } from "@/features/playlist/local-playlist-database";
import { filterOpenPublicRooms } from "@/features/room/room-list-visibility";
import { useRoomActions } from "@/features/room/hooks/use-room-actions";
import type { RoomStateEvent } from "@/features/room/room-state-reducer";
import type { PlaybackStartRequest } from "@/features/playback/playback-start-request";
import { useRoomLifecycleActions } from "@/features/room/hooks/use-room-lifecycle-actions";
import type { RoomRecoveryState } from "@/features/room/hooks/use-room-page-state";

type RoomRouter = {
  push: (href: Route) => void;
  replace: (href: Route) => void;
};

type UseRoomActionsInput = Parameters<typeof useRoomActions>[0];

type UseRoomPageRoomActionsInput = {
  activeSession: UseRoomActionsInput["activeSession"];
  audioRef: RefObject<HTMLAudioElement | null>;
  authEntryHref: string;
  clearIdentity: () => void;
  currentPlaybackPositionRef: MutableRefObject<number>;
  deleteRoomTrackArtifacts: (trackIds: string[], roomId?: string, deleteRoomSnapshot?: boolean) => Promise<void> | void;
  dispatchRoomStateEvent: Dispatch<RoomStateEvent>;
  peerId: string;
  peerStorageKey: string;
  resetPeerDiagnostics: () => void;
  roomSnapshot: RoomSnapshot | null;
  router: RoomRouter;
  setAvailableRooms: Dispatch<SetStateAction<RoomDirectoryItem[]>>;
  setBufferHealth: Dispatch<SetStateAction<"healthy" | "low" | "critical">>;
  setIsNavigatingRoomExit: Dispatch<SetStateAction<boolean>>;
  setMediaConnectedPeers: Dispatch<SetStateAction<string[]>>;
  setMediaConnectionState: Dispatch<SetStateAction<RoomMediaConnectionState>>;
  setPeerId: Dispatch<SetStateAction<string>>;
  setPlaybackStartRequest: Dispatch<SetStateAction<PlaybackStartRequest | null>>;
  setPlayerResetEpoch: Dispatch<SetStateAction<number>>;
  setPlaylists: Dispatch<SetStateAction<Playlist[]>>;
  setRoomRecoveryState: Dispatch<SetStateAction<RoomRecoveryState>>;
  setStatusMessage: (value: string) => void;
  setSuppressRoomRecovery: Dispatch<SetStateAction<boolean>>;
  workspaceEntryHref: string;
  workspaceOnly: boolean;
};

export function useRoomPageRoomActions({
  activeSession,
  audioRef,
  authEntryHref,
  clearIdentity,
  currentPlaybackPositionRef,
  deleteRoomTrackArtifacts,
  dispatchRoomStateEvent,
  peerId,
  peerStorageKey,
  resetPeerDiagnostics,
  roomSnapshot,
  router,
  setAvailableRooms,
  setBufferHealth,
  setIsNavigatingRoomExit,
  setMediaConnectedPeers,
  setMediaConnectionState,
  setPeerId,
  setPlaybackStartRequest,
  setPlayerResetEpoch,
  setPlaylists,
  setRoomRecoveryState,
  setStatusMessage,
  setSuppressRoomRecovery,
  workspaceEntryHref,
  workspaceOnly
}: UseRoomPageRoomActionsInput) {
  const resetRealtimePeer = useCallback(() => {
    const randomPart = typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const nextPeerId = `peer_${randomPart}`;
    try {
      window.sessionStorage.setItem(peerStorageKey, nextPeerId);
    } catch {
      // Ignore storage errors
    }
    setPeerId(nextPeerId);
  }, [peerStorageKey, setPeerId]);
  const queryClient = useQueryClient();
  const getCurrentPeerId = useCallback(() => peerId || null, [peerId]);
  const playlistRefreshVersionRef = useRef(0);

  const refreshAvailableRooms = useCallback(async () => {
    try {
      const rooms = await soqaroApi.listRooms();
      queryClient.setQueryData(["rooms", activeSession?.userId ?? null], rooms);
      setAvailableRooms(filterOpenPublicRooms(rooms));
    } catch {
      setAvailableRooms([]);
    }
  }, [activeSession?.userId, queryClient, setAvailableRooms]);

  const refreshPlaylists = useCallback(async () => {
    const version = ++playlistRefreshVersionRef.current;
    try {
      const nextPlaylists = await soqaroApi.listMyPlaylists();
      if (version === playlistRefreshVersionRef.current) {
        setPlaylists(nextPlaylists.filter((playlist) => !isLocalPlaylistMirror(playlist)));
      }
    } catch {
      // Keep the last successful list when a background refresh is temporarily unavailable.
    }
  }, [setPlaylists]);

  useEffect(() => {
    if (!activeSession) {
      return;
    }

    const refreshFromExternalChange = () => {
      void refreshPlaylists();
    };
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === playlistsChangedStorageKey) {
        refreshFromExternalChange();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshFromExternalChange();
      }
    };

    window.addEventListener(playlistsChangedEventName, refreshFromExternalChange);
    window.addEventListener("storage", handleStorageChange);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener(playlistsChangedEventName, refreshFromExternalChange);
      window.removeEventListener("storage", handleStorageChange);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeSession, refreshPlaylists]);

  const handleTrackDeleted = useCallback(
    async (trackId: string) => {
      await deleteRoomTrackArtifacts(
        [trackId],
        roomSnapshot?.room.id
      );
    },
    [deleteRoomTrackArtifacts, roomSnapshot?.room.id]
  );
  const handleRoomDeleted = useCallback(
    async (trackIds: string[], roomId?: string) => {
      await deleteRoomTrackArtifacts(trackIds, roomId ?? roomSnapshot?.room.id, true);
    },
    [deleteRoomTrackArtifacts, roomSnapshot?.room.id]
  );

  const resetPlayerSurface = useCallback(() => {
    const localAudio = audioRef.current;

    if (localAudio) {
      localAudio.pause();
      localAudio.srcObject = null;
      localAudio.removeAttribute("src");
      localAudio.load();
    }

    resetPeerDiagnostics();
    currentPlaybackPositionRef.current = 0;
    setPlayerResetEpoch((current) => current + 1);
    setBufferHealth("healthy");
    setMediaConnectionState("idle");
    setMediaConnectedPeers([]);
    setPlaybackStartRequest(null);
    setRoomRecoveryState({
      phase: "joining",
      mode: "steady",
      generation: null,
      bootstrapStartedAt: null,
      bootstrapSourcePeerId: null,
      pendingSnapshot: false,
      pendingData: false,
      pendingMedia: false,
      listenerBootstrapAttempts: null,
    });
  }, [
    audioRef,
    currentPlaybackPositionRef,
    resetPeerDiagnostics,
    setBufferHealth,
    setMediaConnectedPeers,
    setMediaConnectionState,
    setPlaybackStartRequest,
    setPlayerResetEpoch,
    setRoomRecoveryState
  ]);

  const {
    leaveRoom,
    deleteRoom,
    deleteTrack,
    deleteTracks,
    addToQueue,
    batchAddToQueue,
    playTrack,
    playQueueItem,
    pauseTrack,
    prevTrack,
    nextTrack,
    savePlaylistFromQueue,
    updatePlaylistTitle,
    updatePlaylistTracks,
    updateRoom,
    updateMemberPermissions,
    removeMember,
    deletePlaylist,
    loadPlaylistIntoRoom,
    removeQueueItem,
    removeQueueItems,
    reorderQueue,
    reorderTracks,
    setNextQueueItem,
    setPlaybackMode,
    seekTrack,
    refreshRoomSnapshot
  } = useRoomActions({
    activeSession,
    roomSnapshot,
    dispatchRoomStateEvent,
    setSuppressRoomRecovery,
    setStatusMessage,
    refreshAvailableRooms,
    refreshPlaylists,
    resetPlayerSurface,
    resetRealtimePeer,
    lastRoomStorageKey: "soqaro-last-room",
    getCurrentPlaybackPositionMs: () => currentPlaybackPositionRef.current,
    getCurrentPeerId,
    onTrackDeleted: handleTrackDeleted,
    onRoomDeleted: handleRoomDeleted
  });

  const {
    handleClearIdentity,
    handleLeaveRoomAction,
    handleDeleteRoomAction,
    handleLogout
  } = useRoomLifecycleActions({
    currentRoomId: roomSnapshot?.room.id ?? null,
    workspaceOnly,
    workspaceEntryHref,
    authEntryHref,
    router,
    clearIdentity,
    resetPlayerSurface,
    resetRealtimePeer,
    setSuppressRoomRecovery,
    dispatchRoomStateEvent,
    setPlaylists,
    leaveRoom,
    deleteRoom,
    setIsNavigatingRoomExit
  });

  return {
    addToQueue,
    batchAddToQueue,
    deleteTrack,
    deleteTracks,
    handleClearIdentity,
    handleDeleteRoomAction,
    handleLeaveRoomAction,
    handleLogout,
    nextTrack,
    savePlaylistFromQueue,
    updatePlaylistTitle,
    updatePlaylistTracks,
    updateRoom,
    updateMemberPermissions,
    removeMember,
    deletePlaylist,
    loadPlaylistIntoRoom,
    pauseTrack,
    playQueueItem,
    playTrack,
    prevTrack,
    refreshRoomSnapshot,
    refreshAvailableRooms,
    refreshPlaylists,
    removeQueueItem,
    removeQueueItems,
    reorderQueue,
    reorderTracks,
    setNextQueueItem,
    setPlaybackMode,
    resetPlayerSurface,
    seekTrack
  };
}
