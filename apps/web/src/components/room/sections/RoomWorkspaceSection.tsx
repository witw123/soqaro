"use client";

import { memo } from "react";
import type {
  AuthSession,
  RoomMediaConnectionState,
  RoomSnapshot,
  TrackMeta
} from "@soqaro/shared";
import type { RoomSocket } from "@/lib/network/ws-client";
import type { useRoomWorkspaceViewModel } from "@/components/room/hooks/use-room-workspace-view-model";
import type { useTrackUploads } from "@/features/upload/use-track-uploads";
import type { useRoomPageRoomActions } from "@/features/room/hooks/use-room-page-room-actions";
import type { useRoomClipboardActions } from "@/components/room/hooks/use-room-clipboard-actions";
import type { useRoomPageState } from "@/features/room/hooks/use-room-page-state";
import type { RoomPlaybackBarrierClock } from "@/features/playback/room-playback-clock";
import { RoomWorkspace } from "@/components/room/RoomWorkspace";

export type RoomWorkspaceSectionProps = {
  awayRoomId: string | null;
  onAwayRoom: () => void;
  activeSession: AuthSession | null;
  statusMessage: string;
  workspaceViewModel: ReturnType<typeof useRoomWorkspaceViewModel>;
  roomSnapshot: RoomSnapshot | null;
  playbackBarrier?: RoomPlaybackBarrierClock | null;
  initialRoomId: string | null;
  currentTrack: TrackMeta | null;
  currentPlaybackPositionRef?: React.MutableRefObject<number>;
  canControlPlayback: boolean;
  canDeleteRoom: boolean;
  canReorderQueue: boolean;
  uploads: ReturnType<typeof useTrackUploads>;
  playlists: ReturnType<typeof useRoomPageState>["playlists"];
  mediaConnectionState: RoomMediaConnectionState;
  workspaceEntryHref: string;
  authEntryHref: string;
  isNavigatingRoomExit: boolean;
  isRecoveringRoom: boolean;
  roomActions: ReturnType<typeof useRoomPageRoomActions>;
  clipboardActions: ReturnType<typeof useRoomClipboardActions>;
  onFilesSelected: (files: FileList | File[] | null) => Promise<void>;
  onPlayQueueItem: (queueItemId: string) => Promise<void>;
  onPlayTrack: (trackId?: string) => Promise<void>;
  onTabChange: (tab: "library" | "search" | "local" | "members") => void;
  onDiagnosticsVisibilityChange: (open: boolean) => void;
  onSeek: (positionMs: number) => void;
  socket: RoomSocket | null;
};

function RoomWorkspaceSectionComponent({
  onAwayRoom,
  activeSession,
  statusMessage,
  workspaceViewModel,
  roomSnapshot,
  playbackBarrier,
  initialRoomId,
  currentTrack,
  currentPlaybackPositionRef,
  canControlPlayback,
  canDeleteRoom,
  canReorderQueue,
  uploads,
  playlists,
  mediaConnectionState,
  workspaceEntryHref,
  authEntryHref,
  isNavigatingRoomExit,
  isRecoveringRoom,
  roomActions,
  clipboardActions,
  onFilesSelected,
  onPlayQueueItem,
  onPlayTrack,
  onTabChange,
  onDiagnosticsVisibilityChange,
  onSeek,
  socket
}: RoomWorkspaceSectionProps) {
  const roomType = roomSnapshot?.room.roomType;
  const isHostControlledRoom = roomType === "request" || roomType === "radio";
  const isRoomHost = !!activeSession && roomSnapshot?.room.hostId === activeSession.userId;

  return (
    <RoomWorkspace
      activeSession={activeSession}
      statusMessage={statusMessage}
      statusTone={workspaceViewModel.statusTone}
      roomSnapshot={roomSnapshot}
      playbackBarrier={playbackBarrier}
      roomId={roomSnapshot?.room.id ?? initialRoomId}
      currentTrack={currentTrack}
      currentPlaybackPositionRef={currentPlaybackPositionRef}
      canControlPlayback={canControlPlayback}
      canDeleteRoom={canDeleteRoom}
      canDisbandRoom={workspaceViewModel.canDisbandRoom}
      uploadedTracks={uploads.uploadedTracks}
      localStorageSummary={uploads.localStorageSummary}
      playlists={playlists}
      onCleanLocalStorage={uploads.cleanLocalStorage}
      onRefreshLocalStorage={uploads.refreshCacheLibrary}
      onImportCachedTrack={uploads.importCachedTrack}
      onSaveTrackToLocal={uploads.saveTrackToLocal}
      onSavePlaylistFromQueue={roomActions.savePlaylistFromQueue}
      onLoadPlaylistIntoRoom={roomActions.loadPlaylistIntoRoom}
      onImportNeteaseTrack={uploads.handleNeteaseTrackImport}
      onImportQqMusicTrack={uploads.handleQqMusicTrackImport}
      onImportBilibiliTrack={uploads.handleBilibiliTrackImport}
      onImportNeteaseTracks={uploads.handleNeteaseTrackImports}
      onImportQqMusicTracks={uploads.handleQqMusicTrackImports}
      onImportBilibiliTracks={uploads.handleBilibiliTrackImports}
      onUpdatePlaylistTitle={roomActions.updatePlaylistTitle}
      onUpdatePlaylistTracks={roomActions.updatePlaylistTracks}
      onUpdateRoom={roomActions.updateRoom}
      onUpdateMemberPermissions={roomActions.updateMemberPermissions}
      onRemoveMember={roomActions.removeMember}
      onDeletePlaylist={roomActions.deletePlaylist}
      connectedPeersCount={workspaceViewModel.connectedPeersCount}
      mediaConnectionState={mediaConnectionState}
      mediaConnectedPeersCount={workspaceViewModel.mediaConnectedPeersCount}
      peerDiagnostics={workspaceViewModel.workspacePeerDiagnostics.peerDiagnostics}
      peerRecentEvents={workspaceViewModel.workspacePeerDiagnostics.peerRecentEvents}
      localMemberState={workspaceViewModel.localMemberState}
      iceConfigSource={workspaceViewModel.iceConfigSource}
      iceConfigStatus={workspaceViewModel.iceConfigStatus}
      workspaceEntryHref={workspaceEntryHref}
      authEntryHref={authEntryHref}
      showRoomTransitionState={workspaceViewModel.showRoomTransitionState}
      isNavigatingRoomExit={isNavigatingRoomExit}
      isRecoveringRoom={isRecoveringRoom}
      isRoomTransitionPending={workspaceViewModel.isRoomTransitionPending}
      onClearIdentity={roomActions.handleClearIdentity}
      onCopyJoinCode={clipboardActions.handleCopyJoinCode}
      onShareRoom={clipboardActions.handleShareRoom}
      onAwayRoom={onAwayRoom}
      onLeaveRoom={roomActions.handleLeaveRoomAction}
      onDeleteRoom={roomActions.handleDeleteRoomAction}
      onFilesSelected={onFilesSelected}
      onAddToQueue={roomActions.addToQueue}
      onBatchAddToQueue={roomActions.batchAddToQueue}
      canReorderQueue={isHostControlledRoom ? isRoomHost : canReorderQueue}
      canRemoveQueue={isHostControlledRoom ? isRoomHost : !!activeSession && canReorderQueue}
      onPlayQueueItem={onPlayQueueItem}
      onPlayNextQueueItem={roomActions.setNextQueueItem}
      onRemoveQueueItem={roomActions.removeQueueItem}
      onRemoveQueueItems={roomActions.removeQueueItems}
      onReorderQueue={roomActions.reorderQueue}
      onReorderTracks={roomActions.reorderTracks}
      onDeleteTrack={roomActions.deleteTrack}
      onDeleteTracks={roomActions.deleteTracks}
      onPlayTrack={onPlayTrack}
      onRefreshRoom={roomActions.refreshRoomSnapshot}
      onTabChange={onTabChange}
      onDiagnosticsVisibilityChange={onDiagnosticsVisibilityChange}
      onSeek={onSeek}
      socket={socket}
      playerSlot={null}
    />
  );
}

export const RoomWorkspaceSection = memo(RoomWorkspaceSectionComponent);
