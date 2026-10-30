"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type { AuthSession, RoomSnapshot, TrackMeta } from "@soqaro/shared";
import type { RoomSocket } from "@/lib/network/ws-client";
import {
  isProviderTrack,
  resolveRoomSourceMemberOffline
} from "@/features/room/playback/room-audio-path";
import {
  useTrackAssetPreparationState,
  useTrackUnavailableReason
} from "@/features/room/playback/room-track-asset-preparation";
import { appSettingsChangeEvent, getAppSettings } from "@/features/settings/settings-store";
import type { useTrackUploads } from "@/features/upload/use-track-uploads";
import type { useRoomClipboardActions } from "@/components/room/hooks/use-room-clipboard-actions";
import type { useRoomPageRoomActions } from "@/features/room/hooks/use-room-page-room-actions";
import type { useRoomPageState } from "@/features/room/hooks/use-room-page-state";
import type { useRoomPlaybackActions } from "@/features/room/hooks/use-room-playback-actions";
import type { useRoomWorkspaceViewModel } from "@/components/room/hooks/use-room-workspace-view-model";
import type { RoomPlaybackBarrierClock } from "@/features/playback/room-playback-clock";
import { RoomWorkspaceSection } from "@/components/room/sections/RoomWorkspaceSection";
import { RoomPlaybackSection } from "@/components/room/sections/RoomPlaybackSection";
import { RoomOverlaySection } from "@/components/room/sections/RoomOverlaySection";

type RoomAppShellProps = {
  activeSession: AuthSession | null;
  audioRef: RefObject<HTMLAudioElement | null>;
  currentPlaybackPositionRef?: MutableRefObject<number>;
  authEntryHref: string;
  backgroundOnly?: boolean;
  canControlPlayback: boolean;
  canDeleteRoom: boolean;
  canReorderQueue: boolean;
  clipboardActions: ReturnType<typeof useRoomClipboardActions>;
  currentTrack: TrackMeta | null;
  initialRoomId: string | null;
  isSourceOwner: boolean;
  pageState: ReturnType<typeof useRoomPageState>;
  playbackActions: ReturnType<typeof useRoomPlaybackActions>;
  roomActions: ReturnType<typeof useRoomPageRoomActions>;
  roomSnapshot: RoomSnapshot | null;
  playbackBarrier?: RoomPlaybackBarrierClock | null;
  isRoomAway: boolean;
  awayRoomId: string | null;
  onResumeRoom: () => void;
  onAwayRoom: () => void;
  socket: RoomSocket | null;
  statusMessage: string;
  uploads: ReturnType<typeof useTrackUploads>;
  workspaceEntryHref: string;
  workspaceViewModel: ReturnType<typeof useRoomWorkspaceViewModel>;
};

export function RoomAppShell({
  activeSession,
  audioRef,
  currentPlaybackPositionRef,
  authEntryHref,
  backgroundOnly = false,
  canControlPlayback,
  canDeleteRoom,
  canReorderQueue,
  clipboardActions,
  currentTrack,
  initialRoomId,
  isSourceOwner,
  pageState,
  playbackActions,
  roomActions,
  roomSnapshot,
  playbackBarrier,
  isRoomAway,
  awayRoomId,
  onResumeRoom,
  onAwayRoom,
  socket,
  statusMessage,
  uploads,
  workspaceEntryHref,
  workspaceViewModel
}: RoomAppShellProps) {
  const requestRoomSeekRef = useRef<(positionMs: number) => void>(() => undefined);
  const [dismissedTrackId, setDismissedTrackId] = useState<string | null>(null);
  const [settings, setSettings] = useState(() => getAppSettings());

  useEffect(() => {
    const sync = () => setSettings(getAppSettings());
    window.addEventListener(appSettingsChangeEvent, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(appSettingsChangeEvent, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const preparationState = useTrackAssetPreparationState(currentTrack?.id);
  const unavailableReason = useTrackUnavailableReason(currentTrack?.id);
  const isSourceMemberOffline = resolveRoomSourceMemberOffline({
    isCurrentSource: isSourceOwner,
    roomSnapshot,
    track: currentTrack
  });
  const requiresCachePrompt = isSourceOwner
    ? preparationState === "failed" || preparationState === "source-missing"
    : Boolean(unavailableReason) ||
      (isSourceMemberOffline && settings.playback.preventOfflineAutoLoad);

  const isMissingOpsAsset = Boolean(
    !backgroundOnly &&
    currentTrack &&
    isProviderTrack(currentTrack) &&
    !currentTrack.playbackAsset &&
    !settings.playback.streamingOnlyPlayback &&
    !settings.playback.fullyCachedPlayback &&
    requiresCachePrompt &&
    dismissedTrackId !== currentTrack.id
  );

  const handleSeekRequestReady = useCallback(
    (requestSeek: ((positionMs: number) => void) | null) => {
      requestRoomSeekRef.current = requestSeek ?? (() => undefined);
    },
    []
  );

  const handleWorkspaceSeek = useCallback((positionMs: number) => {
    requestRoomSeekRef.current(positionMs);
  }, []);

  const handleCloseCachePrompt = useCallback(() => {
    if (currentTrack) setDismissedTrackId(currentTrack.id);
  }, [currentTrack]);

  const handleEnableCache = useCallback(() => {
    setSettings(getAppSettings());
  }, []);

  return (
    <>
      {!backgroundOnly ? (
        <RoomWorkspaceSection
          activeSession={activeSession}
          authEntryHref={authEntryHref}
          awayRoomId={awayRoomId}
          canControlPlayback={canControlPlayback}
          canDeleteRoom={canDeleteRoom}
          canReorderQueue={canReorderQueue}
          clipboardActions={clipboardActions}
          currentTrack={currentTrack}
          currentPlaybackPositionRef={currentPlaybackPositionRef}
          initialRoomId={initialRoomId}
          isNavigatingRoomExit={pageState.isNavigatingRoomExit}
          isRecoveringRoom={pageState.isRecoveringRoom}
          isRoomAway={isRoomAway}
          mediaConnectionState={pageState.mediaConnectionState}
          onAwayRoom={onAwayRoom}
          onDiagnosticsVisibilityChange={pageState.setIsDiagnosticsPanelOpen}
          onFilesSelected={playbackActions.handleFilesSelected}
          onPlayQueueItem={playbackActions.handlePlayQueueItem}
          onPlayTrack={playbackActions.handlePlayTrack}
          onResumeRoom={onResumeRoom}
          onSeek={handleWorkspaceSeek}
          onTabChange={pageState.setActiveDashboardTab}
          playbackBarrier={playbackBarrier}
          playlists={pageState.playlists}
          roomActions={roomActions}
          roomSnapshot={roomSnapshot}
          socket={socket}
          statusMessage={statusMessage}
          uploads={uploads}
          workspaceEntryHref={workspaceEntryHref}
          workspaceViewModel={workspaceViewModel}
        />
      ) : null}

      <RoomPlaybackSection
        activeSession={activeSession}
        audioRef={audioRef}
        canReorderQueue={canReorderQueue}
        currentTrack={currentTrack}
        isSourceOwner={isSourceOwner}
        onNext={playbackActions.handleNextTrack}
        onPause={roomActions.pauseTrack}
        onPlay={playbackActions.handlePlayTrack}
        onPlayNextQueueItem={roomActions.setNextQueueItem}
        onPlayQueueItem={playbackActions.handlePlayQueueItem}
        onPlaybackPositionChange={playbackActions.handlePlaybackPositionChange}
        onPrev={playbackActions.handlePrevTrack}
        onRemoveQueueItem={roomActions.removeQueueItem}
        onRemoveQueueItems={roomActions.removeQueueItems}
        onReorderQueue={roomActions.reorderQueue}
        onSeek={roomActions.seekTrack}
        onSeekRequestReady={handleSeekRequestReady}
        onSetPlaybackMode={roomActions.setPlaybackMode}
        onVolumeChange={pageState.setVolume}
        playbackBarrier={playbackBarrier}
        playerResetEpoch={pageState.playerResetEpoch}
        roomSnapshot={roomSnapshot}
      />

      <RoomOverlaySection
        audioBlockedOverlay={pageState.audioBlockedOverlay}
        backgroundOnly={backgroundOnly}
        currentTrack={currentTrack}
        isMissingOpsAsset={isMissingOpsAsset}
        isRoomAway={isRoomAway}
        isSourceOwner={isSourceOwner}
        onAwayRoom={onAwayRoom}
        onCloseCachePrompt={handleCloseCachePrompt}
        onEnableCache={handleEnableCache}
        onUnlockAudio={playbackActions.handleAudioUnlock}
      />
    </>
  );
}
