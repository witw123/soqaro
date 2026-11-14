"use client";

import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import {
  errorCodes,
  type AuthSession,
  type PlaybackMode,
  type PlaybackSnapshot,
  type QueueItem,
  type RoomMemberPermissions,
  type RoomSnapshot,
  type UpdateRoomRequest
} from "@soqaro/shared";
import { SoqaroApiError, soqaroApi } from "@/lib/network/soqaro-api";
import { toUserFacingError } from "@/lib/domain/soqaro-ui";
import type { RoomStateEvent } from "@/features/room/room-state-reducer";
import { roomAudioOutput } from "@/features/playback/room-audio-output";
import { hasRoomPermission } from "@/features/room/room-permissions";
import { closeDesktopLyricsNative } from "@/features/playback/desktop-lyrics-context";
import { importTaskStore } from "@/features/upload/import-task-store";

type UseRoomActionsOptions = {
  activeSession: AuthSession | null;
  roomSnapshot: RoomSnapshot | null;
  dispatchRoomStateEvent: Dispatch<RoomStateEvent>;
  setSuppressRoomRecovery: Dispatch<SetStateAction<boolean>>;
  setStatusMessage: (value: string) => void;
  refreshAvailableRooms: () => Promise<void>;
  refreshPlaylists: () => Promise<void>;
  resetPlayerSurface: () => void;
  resetRealtimePeer: () => void;
  lastRoomStorageKey: string;
  getCurrentPlaybackPositionMs: () => number;
  getCurrentPeerId?: () => string | null;
  onTrackDeleted?: (trackId: string) => Promise<void> | void;
  onRoomDeleted?: (trackIds: string[]) => Promise<void> | void;
};

import {
  createPendingPausePlayback,
  createPendingSeekPlayback,
  hasPlaybackTimelineAdvanced,
  runBestEffortRoomLeave,
  shouldResetPlayerAfterQueueRemoval,
  shouldResetPlayerAfterTrackRemoval,
  shouldRetryPlaybackMutationAfterConflict,
  type PlaybackMutationOptions,
  type PlaybackMutationTarget
} from "./room-actions-helpers";

export * from "./room-actions-helpers";

export function useRoomActions({
  activeSession,
  roomSnapshot,
  dispatchRoomStateEvent,
  setSuppressRoomRecovery,
  setStatusMessage,
  refreshAvailableRooms,
  refreshPlaylists,
  resetPlayerSurface,
  resetRealtimePeer,
  lastRoomStorageKey,
  getCurrentPlaybackPositionMs,
  getCurrentPeerId,
  onTrackDeleted,
  onRoomDeleted
}: UseRoomActionsOptions) {
  const playbackMutationChainRef = useRef<Promise<void>>(Promise.resolve());
  const latestPlaybackStateRef = useRef<{
    roomId: string | null;
    revision: number | null;
  }>({
    roomId: roomSnapshot?.room.id ?? null,
    revision: roomSnapshot?.room.playback.playbackRevision ?? null
  });
  const renderedRoomId = roomSnapshot?.room.id ?? null;
  const renderedPlaybackRevision = roomSnapshot?.room.playback.playbackRevision ?? null;
  if (latestPlaybackStateRef.current.roomId !== renderedRoomId) {
    latestPlaybackStateRef.current = {
      roomId: renderedRoomId,
      revision: renderedPlaybackRevision
    };
  }
  if (
    renderedPlaybackRevision !== null &&
    latestPlaybackStateRef.current.roomId === renderedRoomId &&
    (latestPlaybackStateRef.current.revision === null ||
      renderedPlaybackRevision >= latestPlaybackStateRef.current.revision)
  ) {
    latestPlaybackStateRef.current.revision = renderedPlaybackRevision;
  }

  const syncRoomSnapshot = useCallback(
    async (roomId: string) => {
      const snapshot = await soqaroApi.getRoom(roomId);
      dispatchRoomStateEvent({
        type: "recover-snapshot",
        snapshot
      });
      return snapshot;
    },
    [dispatchRoomStateEvent]
  );

  const refreshRoomSnapshot = useCallback(async () => {
    if (!roomSnapshot) return null;
    return syncRoomSnapshot(roomSnapshot.room.id);
  }, [roomSnapshot, syncRoomSnapshot]);

  const updateRoom = useCallback(
    async (input: UpdateRoomRequest) => {
      if (!activeSession || !roomSnapshot || roomSnapshot.room.hostId !== activeSession.userId) {
        return false;
      }

      try {
        const snapshot = await soqaroApi.updateRoom(roomSnapshot.room.id, input);
        dispatchRoomStateEvent({
          type: "recover-snapshot",
          snapshot
        });
        setStatusMessage("房间信息已更新。");
        return true;
      } catch (error) {
        setStatusMessage(toUserFacingError(error));
        return false;
      }
    },
    [activeSession, dispatchRoomStateEvent, roomSnapshot, setStatusMessage]
  );

  const updateMemberPermissions = useCallback(
    async (memberId: string, permissions: RoomMemberPermissions) => {
      if (!activeSession || !roomSnapshot || roomSnapshot.room.hostId !== activeSession.userId) {
        return false;
      }

      try {
        const snapshot = await soqaroApi.updateRoomMemberPermissions(
          roomSnapshot.room.id,
          memberId,
          permissions
        );
        dispatchRoomStateEvent({ type: "recover-snapshot", snapshot });
        setStatusMessage("成员权限已更新。");
        return true;
      } catch (error) {
        setStatusMessage(toUserFacingError(error));
        return false;
      }
    },
    [activeSession, dispatchRoomStateEvent, roomSnapshot, setStatusMessage]
  );

  const removeMember = useCallback(
    async (memberId: string) => {
      if (!activeSession || !roomSnapshot || roomSnapshot.room.hostId !== activeSession.userId) {
        return false;
      }

      try {
        const snapshot = await soqaroApi.removeRoomMember(roomSnapshot.room.id, memberId);
        dispatchRoomStateEvent({ type: "recover-snapshot", snapshot });
        setStatusMessage("成员已移出房间。");
        return true;
      } catch (error) {
        setStatusMessage(toUserFacingError(error));
        return false;
      }
    },
    [activeSession, dispatchRoomStateEvent, roomSnapshot, setStatusMessage]
  );

  const runPlaybackMutation = useCallback(
    async (
      roomId: string,
      expectedVersion: number,
      requestPlayback: (nextExpectedVersion: number) => Promise<PlaybackSnapshot>,
      retryTarget?: PlaybackMutationTarget,
      options?: PlaybackMutationOptions
    ) => {
      const execute = async () => {
        if (latestPlaybackStateRef.current.roomId !== roomId) {
          latestPlaybackStateRef.current = {
            roomId,
            revision: null
          };
        }
        let nextExpectedVersion = Math.max(
          expectedVersion,
          latestPlaybackStateRef.current.revision ?? 0
        );

        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const playback = await requestPlayback(nextExpectedVersion);
            if (latestPlaybackStateRef.current.roomId === roomId) {
              latestPlaybackStateRef.current.revision = playback.playbackRevision;
            }
            dispatchRoomStateEvent({
              type: "server-playback-patch",
              roomId,
              playback,
              roomRevision: (playback as { roomRevision?: number }).roomRevision
            });
            if (options?.refreshSnapshotOnSuccess !== false) {
              void syncRoomSnapshot(roomId).catch(() => undefined);
            }
            return playback;
          } catch (error) {
            const isVersionConflict =
              (error instanceof SoqaroApiError &&
                error.code === errorCodes.playbackVersionConflict) ||
              (error instanceof Error && error.message.includes("Playback state version conflict"));

            if (!isVersionConflict) {
              // A request can commit on the server while its response is lost.
              // Reconcile once before reporting an error so the player does not
              // remain on a stale track after a successful cut.
              try {
                const snapshot = await syncRoomSnapshot(roomId);
                if (
                  snapshot.room.playback.playbackRevision > nextExpectedVersion ||
                  (retryTarget &&
                    shouldRetryPlaybackMutationAfterConflict(
                      retryTarget,
                      snapshot.room.playback
                    ))
                ) {
                  return snapshot.room.playback;
                }
                // The mutation never committed: roll the optimistic pending
                // state back to the authoritative server playback. Its
                // revision is lower than the pending one, so the normal
                // version-gated patch path would reject it and the room would
                // stay diverged until someone else moves playback forward.
                if (latestPlaybackStateRef.current.roomId === roomId) {
                  latestPlaybackStateRef.current.revision =
                    snapshot.room.playback.playbackRevision;
                }
                dispatchRoomStateEvent({
                  type: "playback-rollback",
                  roomId,
                  playback: snapshot.room.playback
                });
                return snapshot.room.playback;
              } catch {
                // Preserve the original request error when reconciliation also fails.
              }
              setStatusMessage(toUserFacingError(error));
              return null;
            }

            if (attempt === 1) {
              setStatusMessage(toUserFacingError(error));
              return null;
            }

            try {
              const snapshot = await syncRoomSnapshot(roomId);
              if (latestPlaybackStateRef.current.roomId === roomId) {
                latestPlaybackStateRef.current.revision = snapshot.room.playback.playbackRevision;
              }
              if (
                retryTarget &&
                !shouldRetryPlaybackMutationAfterConflict(
                  retryTarget,
                  snapshot.room.playback,
                  options
                )
              ) {
                if (!options?.silentOnConflictSkip) {
                  setStatusMessage("播放曲目已更新，本次操作未重试。");
                }
                return options?.returnSnapshotOnConflictSkip ? snapshot.room.playback : null;
              }
              nextExpectedVersion = snapshot.room.playback.playbackRevision;
            } catch (refreshError) {
              setStatusMessage(toUserFacingError(refreshError));
              return null;
            }
          }
        }

        return null;
      };
      const run = playbackMutationChainRef.current.then(execute, execute);
      playbackMutationChainRef.current = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
    [dispatchRoomStateEvent, setStatusMessage, syncRoomSnapshot]
  );

  const leaveRoom = useCallback(async () => {
    if (!activeSession || !roomSnapshot) {
      return false;
    }

    try {
      const result = await runBestEffortRoomLeave({
        roomId: roomSnapshot.room.id,
        leaveRemote: soqaroApi.leaveRoom,
        remoteWaitMs: 150,
        completeLocalExit: async () => {
          setSuppressRoomRecovery(true);
          resetPlayerSurface();
          roomAudioOutput.releaseRoomAudioSession();
          closeDesktopLyricsNative();
          resetRealtimePeer();
          window.localStorage.removeItem(lastRoomStorageKey);
          void refreshAvailableRooms().catch(() => undefined);
        }
      });
      setStatusMessage(
        result.remoteStatus === "confirmed"
          ? "已离开房间。"
          : result.remoteStatus === "failed"
            ? "已离开本地房间，服务器离开请求未确认。"
            : "已离开房间，服务器确认仍在后台进行。"
      );
      return true;
    } catch (error) {
      setStatusMessage(toUserFacingError(error));
      return false;
    }
  }, [
    activeSession,
    roomSnapshot,
    setSuppressRoomRecovery,
    resetPlayerSurface,
    resetRealtimePeer,
    lastRoomStorageKey,
    refreshAvailableRooms,
    setStatusMessage
  ]);

  const deleteRoom = useCallback(async () => {
    if (!activeSession || !roomSnapshot) {
      return false;
    }

    try {
      const trackIds = roomSnapshot.tracks.map((track) => track.id);
      await soqaroApi.deleteRoom(roomSnapshot.room.id);
      setSuppressRoomRecovery(true);
      resetPlayerSurface();
      roomAudioOutput.releaseRoomAudioSession();
      closeDesktopLyricsNative();
      resetRealtimePeer();
      window.localStorage.removeItem(lastRoomStorageKey);
      try {
        await onRoomDeleted?.(trackIds);
      } catch {
        // Room deletion already succeeded on the server. Do not fail the exit flow
        // if optional local cleanup cannot finish.
      }
      void refreshAvailableRooms().catch(() => undefined);
      setStatusMessage("房间已解散。");
      return true;
    } catch (error) {
      setStatusMessage(toUserFacingError(error));
      return false;
    }
  }, [
    activeSession,
    roomSnapshot,
    onRoomDeleted,
    setSuppressRoomRecovery,
    resetPlayerSurface,
    resetRealtimePeer,
    lastRoomStorageKey,
    refreshAvailableRooms,
    setStatusMessage
  ]);

  const addToQueue = useCallback(
    async (trackId: string): Promise<QueueItem | null> => {
      if (!activeSession || !roomSnapshot || !hasRoomPermission(roomSnapshot, activeSession.userId, "queue")) {
        return null;
      }

      try {
        const result = await soqaroApi.addQueueItem(roomSnapshot.room.id, { trackId });
        dispatchRoomStateEvent({
          type: "server-queue-patch",
          roomId: roomSnapshot.room.id,
          queue: result.queue,
          playback: result.playback
        });
        void syncRoomSnapshot(roomSnapshot.room.id).catch(() => undefined);
        setStatusMessage("歌曲已加入共享队列。");
        return [...result.queue]
          .reverse()
          .find((item) => item.trackId === trackId && item.requestedById === activeSession.userId)
          ?? null;
      } catch (error) {
        setStatusMessage(toUserFacingError(error));
        return null;
      }
    },
    [
      activeSession,
      dispatchRoomStateEvent,
      roomSnapshot,
      setStatusMessage,
      syncRoomSnapshot
    ]
  );

  const deleteTrack = useCallback(
    async (trackId: string) => {
      if (!activeSession || !roomSnapshot || !hasRoomPermission(roomSnapshot, activeSession.userId, "library")) {
        return;
      }

      try {
        const shouldResetPlayer = shouldResetPlayerAfterTrackRemoval(
          trackId,
          roomSnapshot.room.playback.currentTrackId
        );
        await soqaroApi.deleteTrack(roomSnapshot.room.id, trackId);
        if (shouldResetPlayer) {
          resetPlayerSurface();
        }
        await onTrackDeleted?.(trackId);
        await syncRoomSnapshot(roomSnapshot.room.id);
        await refreshPlaylists();
        setStatusMessage("歌曲已从房间曲库中删除。");
      } catch (error) {
        setStatusMessage(toUserFacingError(error));
      }
    },
    [
      activeSession,
      roomSnapshot,
      onTrackDeleted,
      syncRoomSnapshot,
      refreshPlaylists,
      resetPlayerSurface,
      setStatusMessage
    ]
  );

  const deleteTracks = useCallback(
    async (trackIds: string[]) => {
      if (!activeSession || !roomSnapshot || !hasRoomPermission(roomSnapshot, activeSession.userId, "library") || trackIds.length === 0) {
        return [];
      }

      try {
        const currentPlayingTrackId = roomSnapshot.room.playback.currentTrackId;
        const shouldResetPlayer = currentPlayingTrackId !== null && trackIds.includes(currentPlayingTrackId);
        const result = await soqaroApi.deleteTracks(roomSnapshot.room.id, { trackIds });
        if (shouldResetPlayer) {
          resetPlayerSurface();
        }
        for (const trackId of result.deletedTrackIds) {
          await onTrackDeleted?.(trackId);
        }
        await syncRoomSnapshot(roomSnapshot.room.id);
        await refreshPlaylists();
        setStatusMessage(`已从房间曲库中删除 ${result.deletedTrackIds.length} 首歌曲。`);
        return result.deletedTrackIds;
      } catch (error) {
        setStatusMessage(toUserFacingError(error));
        return [];
      }
    },
    [
      activeSession,
      roomSnapshot,
      onTrackDeleted,
      syncRoomSnapshot,
      refreshPlaylists,
      resetPlayerSurface,
      setStatusMessage
    ]
  );

  const batchAddToQueue = useCallback(
    async (trackIds: string[]) => {
      if (!activeSession || !roomSnapshot || !hasRoomPermission(roomSnapshot, activeSession.userId, "queue") || trackIds.length === 0) {
        return null;
      }

      try {
        const result = await soqaroApi.addQueueItems(roomSnapshot.room.id, { trackIds });
        dispatchRoomStateEvent({
          type: "server-queue-patch",
          roomId: roomSnapshot.room.id,
          queue: result.queue,
          playback: result.playback
        });
        void syncRoomSnapshot(roomSnapshot.room.id).catch(() => undefined);
        setStatusMessage(`已将 ${trackIds.length} 首歌曲加入共享队列。`);
        return result.queue;
      } catch (error) {
        setStatusMessage(toUserFacingError(error));
        return null;
      }
    },
    [
      activeSession,
      dispatchRoomStateEvent,
      roomSnapshot,
      setStatusMessage,
      syncRoomSnapshot
    ]
  );

  const playTrack = useCallback(
    async (trackId?: string) => {
      if (!roomSnapshot || !activeSession || !hasRoomPermission(roomSnapshot, activeSession.userId, "player")) {
        return;
      }

      await runPlaybackMutation(
        roomSnapshot.room.id,
        roomSnapshot.room.playback.playbackRevision,
        (expectedVersion) => {
          const selectedTrackId = trackId ?? roomSnapshot.room.playback.currentTrackId;
          const playbackAssetId = roomSnapshot.tracks.find(
            (track) => track.id === selectedTrackId
          )?.playbackAsset?.assetId;
          return soqaroApi.updatePlayback(roomSnapshot.room.id, {
            action: "play",
            trackId,
            ...(playbackAssetId ? { playbackAssetId } : {}),
            actorPeerId: getCurrentPeerId?.() ?? undefined,
            expectedVersion
          });
        }
      );
    },
    [roomSnapshot, activeSession, getCurrentPeerId, runPlaybackMutation]
  );

  const playQueueItem = useCallback(
    async (queueItemId: string, trackId?: string) => {
      if (!roomSnapshot || !activeSession || !hasRoomPermission(roomSnapshot, activeSession.userId, "player")) {
        return;
      }

      await runPlaybackMutation(
        roomSnapshot.room.id,
        roomSnapshot.room.playback.playbackRevision,
        (expectedVersion) => {
          const queueTrackId = trackId ?? roomSnapshot.queue.find((item) => item.id === queueItemId)?.trackId;
          const playbackAssetId = roomSnapshot.tracks.find(
            (track) => track.id === queueTrackId
          )?.playbackAsset?.assetId;
          return soqaroApi.updatePlayback(roomSnapshot.room.id, {
            action: "play",
            queueItemId,
            ...(playbackAssetId ? { playbackAssetId } : {}),
            actorPeerId: getCurrentPeerId?.() ?? undefined,
            expectedVersion
          });
        }
      );
    },
    [roomSnapshot, activeSession, getCurrentPeerId, runPlaybackMutation]
  );

  const pauseTrack = useCallback(
    async (positionMs = getCurrentPlaybackPositionMs()) => {
      if (!roomSnapshot || !activeSession || !hasRoomPermission(roomSnapshot, activeSession.userId, "player")) {
        return;
      }

      const currentPlayback = roomSnapshot.room.playback;
      const currentTrack = roomSnapshot.tracks.find(
        (track) => track.id === currentPlayback.currentTrackId
      );
      const optimisticPlayback = createPendingPausePlayback({
        playback: currentPlayback,
        positionMs,
        durationMs: currentTrack?.durationMs
      });
      dispatchRoomStateEvent({
        type: "server-playback-patch",
        roomId: roomSnapshot.room.id,
        playback: optimisticPlayback
      });

      await runPlaybackMutation(
        roomSnapshot.room.id,
        currentPlayback.playbackRevision,
        (expectedVersion) => {
          const playbackAssetId = currentTrack?.playbackAsset?.assetId;
          return soqaroApi.updatePlayback(roomSnapshot.room.id, {
            action: "pause",
            positionMs: optimisticPlayback.positionMs,
            ...(playbackAssetId ? { playbackAssetId } : {}),
            actorPeerId: getCurrentPeerId?.() ?? undefined,
            expectedVersion
          });
        },
        currentPlayback
      );
    },
    [
      roomSnapshot,
      activeSession,
      dispatchRoomStateEvent,
      getCurrentPlaybackPositionMs,
      getCurrentPeerId,
      runPlaybackMutation
    ]
  );

  const prevTrack = useCallback(async () => {
    if (!roomSnapshot || !activeSession || !hasRoomPermission(roomSnapshot, activeSession.userId, "player") || !roomSnapshot.room.playback.currentTrackId) {
      return;
    }

    await runPlaybackMutation(
      roomSnapshot.room.id,
      roomSnapshot.room.playback.playbackRevision,
      (expectedVersion) =>
        soqaroApi.updatePlayback(roomSnapshot.room.id, {
          action: "prev",
          actorPeerId: getCurrentPeerId?.() ?? undefined,
          expectedVersion
        }),
      roomSnapshot.room.playback
    );
  }, [roomSnapshot, activeSession, getCurrentPeerId, runPlaybackMutation]);

  const nextTrack = useCallback(async (options?: PlaybackMutationOptions) => {
    if (!roomSnapshot || !activeSession || !hasRoomPermission(roomSnapshot, activeSession.userId, "player")) {
      return null;
    }

    const safeOptions =
      options && typeof options === "object" && !("nativeEvent" in options)
        ? options
        : undefined;

    return runPlaybackMutation(
      roomSnapshot.room.id,
      roomSnapshot.room.playback.playbackRevision,
      (expectedVersion) =>
        soqaroApi.updatePlayback(roomSnapshot.room.id, {
          action: "next",
          actorPeerId: getCurrentPeerId?.() ?? undefined,
          expectedVersion
        }),
      roomSnapshot.room.playback,
      {
        requireSameTimelineAnchor: true,
        silentOnConflictSkip: true,
        returnSnapshotOnConflictSkip: true,
        ...safeOptions
      }
    );
  }, [roomSnapshot, activeSession, getCurrentPeerId, runPlaybackMutation]);

  const savePlaylistFromQueue = useCallback(
    async (title: string) => {
      if (!activeSession || !roomSnapshot) {
        return;
      }

      try {
        await soqaroApi.createPlaylistFromRoom({
          roomId: roomSnapshot.room.id,
          title,
          description: "从当前房间队列保存"
        });
        await refreshPlaylists();
        setStatusMessage(`歌单“${title}”已保存。`);
      } catch (error) {
        setStatusMessage(toUserFacingError(error));
      }
    },
    [activeSession, roomSnapshot, refreshPlaylists, setStatusMessage]
  );

  const updatePlaylistTitle = useCallback(
    async (playlistId: string, title: string) => {
      if (!activeSession) {
        return;
      }

      try {
        await soqaroApi.updatePlaylist(playlistId, { title });
        await refreshPlaylists();
        setStatusMessage("歌单名称已更新。");
      } catch (error) {
        setStatusMessage(toUserFacingError(error));
      }
    },
    [activeSession, refreshPlaylists, setStatusMessage]
  );

  const updatePlaylistTracks = useCallback(
    async (playlistId: string, trackIds: string[]) => {
      if (!activeSession) {
        return;
      }

      try {
        await soqaroApi.updatePlaylist(playlistId, { trackIds });
        await refreshPlaylists();
        setStatusMessage("歌单曲目已更新。");
      } catch (error) {
        setStatusMessage(toUserFacingError(error));
      }
    },
    [activeSession, refreshPlaylists, setStatusMessage]
  );

  const deletePlaylist = useCallback(
    async (playlistId: string) => {
      if (!activeSession) {
        return;
      }

      try {
        await soqaroApi.deletePlaylist(playlistId);
        await refreshPlaylists();
        setStatusMessage("歌单已删除。");
      } catch (error) {
        setStatusMessage(toUserFacingError(error));
      }
    },
    [activeSession, refreshPlaylists, setStatusMessage]
  );

  const loadPlaylistIntoRoom = useCallback(
    async (playlistId: string) => {
      if (!activeSession || !roomSnapshot || !hasRoomPermission(roomSnapshot, activeSession.userId, "queue")) {
        return;
      }

      const targetPlaylist = roomSnapshot.playlists.find((p) => p.id === playlistId);
      const title = targetPlaylist ? `加载歌单《${targetPlaylist.title}》到队列` : "加载歌单曲目到队列";
      const taskId = importTaskStore.startTask({
        type: "playlist_load",
        title,
        totalCount: 1,
        itemKeys: [playlistId, `playlist:${playlistId}`],
        currentTitle: targetPlaylist?.title,
        currentStage: "正在请求服务器加载曲目"
      });

      let stagePercent = 20;
      const progressTimer = setInterval(() => {
        if (stagePercent < 75) {
          stagePercent += Math.max(1, Math.round((75 - stagePercent) * 0.15));
          importTaskStore.updateTaskProgress(taskId, {
            currentStage: "正在加载歌单曲目到队列",
            currentStagePercent: stagePercent
          });
        }
      }, 250);

      try {
        await soqaroApi.importPlaylistToRoom(playlistId, {
          roomId: roomSnapshot.room.id
        });
        clearInterval(progressTimer);
        importTaskStore.updateTaskProgress(taskId, {
          currentStage: "加载完成，正在同步队列",
          currentStagePercent: 90
        });
        void syncRoomSnapshot(roomSnapshot.room.id).catch(() => undefined);
        setStatusMessage("歌单已加入当前房间队列。");
        importTaskStore.finishTask(taskId);
      } catch (error) {
        clearInterval(progressTimer);
        const errMsg = toUserFacingError(error);
        setStatusMessage(errMsg);
        importTaskStore.finishTask(taskId, { error: errMsg });
      }
    },
    [activeSession, roomSnapshot, setStatusMessage, syncRoomSnapshot]
  );

  const removeQueueItem = useCallback(
    async (queueItemId: string) => {
      if (!roomSnapshot || !activeSession || !hasRoomPermission(roomSnapshot, activeSession.userId, "queue")) {
        return;
      }

      try {
        const result = await soqaroApi.removeQueueItem(roomSnapshot.room.id, queueItemId);
        dispatchRoomStateEvent({
          type: "server-queue-patch",
          roomId: roomSnapshot.room.id,
          queue: result.queue,
          playback: result.playback
        });
        if (shouldResetPlayerAfterQueueRemoval(roomSnapshot.room.playback, result.playback)) {
          resetPlayerSurface();
        }
        void syncRoomSnapshot(roomSnapshot.room.id).catch(() => undefined);
        setStatusMessage("歌曲已从队列中移除。");
      } catch (error) {
        setStatusMessage(toUserFacingError(error));
      }
    },
    [
      roomSnapshot,
      activeSession,
      dispatchRoomStateEvent,
      resetPlayerSurface,
      setStatusMessage,
      syncRoomSnapshot
    ]
  );

  const removeQueueItems = useCallback(
    async (queueItemIds: string[]) => {
      if (!roomSnapshot || !activeSession || !hasRoomPermission(roomSnapshot, activeSession.userId, "queue") || queueItemIds.length === 0) {
        return;
      }

      try {
        const result = await soqaroApi.removeQueueItems(roomSnapshot.room.id, { queueItemIds });
        dispatchRoomStateEvent({
          type: "server-queue-patch",
          roomId: roomSnapshot.room.id,
          queue: result.queue,
          playback: result.playback
        });
        if (shouldResetPlayerAfterQueueRemoval(roomSnapshot.room.playback, result.playback)) {
          resetPlayerSurface();
        }
        void syncRoomSnapshot(roomSnapshot.room.id).catch(() => undefined);
        setStatusMessage(`已从队列中移除 ${queueItemIds.length} 首歌曲。`);
      } catch (error) {
        setStatusMessage(toUserFacingError(error));
      }
    },
    [
      roomSnapshot,
      activeSession,
      dispatchRoomStateEvent,
      resetPlayerSurface,
      setStatusMessage,
      syncRoomSnapshot
    ]
  );

  const reorderQueue = useCallback(
    async (queueItemIds: string[]) => {
      if (!roomSnapshot || !activeSession || !hasRoomPermission(roomSnapshot, activeSession.userId, "queue")) {
        return;
      }

      try {
        const result = await soqaroApi.reorderQueue(roomSnapshot.room.id, {
          queueItemIds
        });
        dispatchRoomStateEvent({
          type: "server-queue-patch",
          roomId: roomSnapshot.room.id,
          queue: result.queue,
          playback: result.playback
        });
        void syncRoomSnapshot(roomSnapshot.room.id).catch(() => undefined);
        setStatusMessage("播放队列顺序已更新。");
      } catch (error) {
        setStatusMessage(toUserFacingError(error));
      }
    },
    [roomSnapshot, activeSession, dispatchRoomStateEvent, setStatusMessage, syncRoomSnapshot]
  );

  const reorderTracks = useCallback(
    async (trackIds: string[]) => {
      if (!roomSnapshot || !activeSession || !hasRoomPermission(roomSnapshot, activeSession.userId, "library")) {
        return;
      }

      try {
        const nextTracks = await soqaroApi.reorderTracks(roomSnapshot.room.id, {
          trackIds
        });
        dispatchRoomStateEvent({
          type: "server-library-patch",
          roomId: roomSnapshot.room.id,
          tracks: nextTracks,
          queue: roomSnapshot.queue,
          playback: roomSnapshot.room.playback
        });
        void syncRoomSnapshot(roomSnapshot.room.id).catch(() => undefined);
        setStatusMessage("曲库歌曲顺序已更新。");
      } catch (error) {
        setStatusMessage(toUserFacingError(error));
      }
    },
    [roomSnapshot, activeSession, dispatchRoomStateEvent, setStatusMessage, syncRoomSnapshot]
  );

  const setNextQueueItem = useCallback(
    async (queueItemId: string) => {
      if (!roomSnapshot || !activeSession || !hasRoomPermission(roomSnapshot, activeSession.userId, "player")) {
        return;
      }

      try {
        const result = await soqaroApi.setNextQueueItem(roomSnapshot.room.id, {
          queueItemId
        });
        dispatchRoomStateEvent({
          type: "server-queue-patch",
          roomId: roomSnapshot.room.id,
          queue: result.queue,
          playback: result.playback
        });
        void syncRoomSnapshot(roomSnapshot.room.id).catch(() => undefined);
        setStatusMessage("已设为下一首播放，队列顺序保持不变。");
      } catch (error) {
        setStatusMessage(toUserFacingError(error));
      }
    },
    [
      activeSession,
      dispatchRoomStateEvent,
      roomSnapshot,
      setStatusMessage,
      syncRoomSnapshot
    ]
  );

  const setPlaybackMode = useCallback(
    async (playbackMode: PlaybackMode) => {
      if (!roomSnapshot || !activeSession || !hasRoomPermission(roomSnapshot, activeSession.userId, "player")) {
        return;
      }

      const nextPlayback = await runPlaybackMutation(
        roomSnapshot.room.id,
        roomSnapshot.room.playback.playbackRevision,
        (expectedVersion) =>
          soqaroApi.updatePlayback(roomSnapshot.room.id, {
            action: "set-mode",
            playbackMode,
            actorPeerId: getCurrentPeerId?.() ?? undefined,
            expectedVersion
          }),
        undefined,
        { refreshSnapshotOnSuccess: false }
      );

      if (nextPlayback) {
        setStatusMessage("播放顺序已同步到房间");
      }
    },
    [activeSession, getCurrentPeerId, roomSnapshot, runPlaybackMutation, setStatusMessage]
  );

  const seekTrack = useCallback(
    async (positionMs: number) => {
      if (!roomSnapshot || !activeSession || !hasRoomPermission(roomSnapshot, activeSession.userId, "player")) {
        return null;
      }

      const currentPlayback = roomSnapshot.room.playback;
      if (!currentPlayback.currentTrackId) {
        return null;
      }
      const currentTrack = roomSnapshot.tracks.find(
        (track) => track.id === currentPlayback.currentTrackId
      );
      const optimisticPlayback = createPendingSeekPlayback({
        playback: currentPlayback,
        positionMs,
        durationMs: currentTrack?.durationMs
      });
      dispatchRoomStateEvent({
        type: "server-playback-patch",
        roomId: roomSnapshot.room.id,
        playback: optimisticPlayback
      });

      return runPlaybackMutation(
        roomSnapshot.room.id,
        currentPlayback.playbackRevision,
        (expectedVersion) => {
          const playbackAssetId = roomSnapshot.tracks.find(
            (track) => track.id === currentPlayback.currentTrackId
          )?.playbackAsset?.assetId;
          return soqaroApi.updatePlayback(roomSnapshot.room.id, {
            action: "seek",
            positionMs: optimisticPlayback.positionMs,
            ...(playbackAssetId ? { playbackAssetId } : {}),
            actorPeerId: getCurrentPeerId?.() ?? undefined,
            expectedVersion
          });
        },
        currentPlayback
      );
    },
    [
      roomSnapshot,
      activeSession,
      dispatchRoomStateEvent,
      getCurrentPeerId,
      runPlaybackMutation
    ]
  );

  const handleEnded = useCallback(async () => {
    if (!roomSnapshot || !activeSession) {
      return false;
    }
    if (!hasRoomPermission(roomSnapshot, activeSession.userId, "player")) {
      return true;
    }

    const previousPlayback = roomSnapshot.room.playback;
    const result = await nextTrack({
      requireSameTimelineAnchor: true,
      silentOnConflictSkip: true,
      returnSnapshotOnConflictSkip: true
    });
    return hasPlaybackTimelineAdvanced(previousPlayback, result);
  }, [activeSession, roomSnapshot, nextTrack]);

  return {
    refreshRoomSnapshot,
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
    handleEnded
  };
}
