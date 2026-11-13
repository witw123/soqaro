"use client";

import { memo, type ReactNode } from "react";
import type {
  AuthSession,
  BilibiliTrackCandidate,
  NeteaseTrackCandidate,
  Playlist,
  PeerDiagnosticsSnapshot,
  PeerRecentEvent,
  RoomMemberPermissions,
  RoomMediaConnectionState,
  RoomSnapshot,
  QqMusicTrackCandidate,
  TrackMeta,
  UpdateRoomRequest
} from "@soqaro/shared";
import type { RoomSocket } from "@/lib/network/ws-client";
import { EmptyRoomState, RoomTransitionState } from "@/components/room/RoomPageStates";
import { InteractiveRoomView } from "@/components/room/InteractiveRoomView";
import { RequestRoomView } from "@/components/room/RequestRoomView";
import { RadioRoomView } from "@/components/room/RadioRoomView";
import type { CachedLibraryTrack, UploadedTrack } from "@/features/library/audio-utils";
import type { LocalStorageSummary } from "@/features/upload/use-track-uploads";
import { AppSidebar } from "@/components/shell";
import type { LocalMemberPanelState } from "@/components/room/MembersPanel";
import { useCustomLayoutRuntime } from "@/features/settings/use-custom-layout-runtime";
import type { RoomPlaybackBarrierClock } from "@/features/playback/room-playback-clock";

type RoomWorkspaceProps = {
  activeSession: AuthSession | null;
  statusMessage: string;
  statusTone: string;
  roomSnapshot: RoomSnapshot | null;
  playbackBarrier?: RoomPlaybackBarrierClock | null;
  roomId: string | null;
  currentTrack: TrackMeta | null;
  currentPlaybackPositionRef?: React.MutableRefObject<number>;
  canControlPlayback: boolean;
  canDeleteRoom: boolean;
  canDisbandRoom: boolean;
  uploadedTracks: Record<string, UploadedTrack>;
  localStorageSummary: LocalStorageSummary;
  playlists: Playlist[];
  onCleanLocalStorage: () => Promise<void>;
  onRefreshLocalStorage: () => Promise<void>;
  onImportCachedTrack: (track: CachedLibraryTrack) => Promise<void>;
  onSaveTrackToLocal: (track: TrackMeta) => Promise<void>;
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
  onUpdateRoom: (input: UpdateRoomRequest) => Promise<boolean>;
  onUpdateMemberPermissions: (memberId: string, permissions: RoomMemberPermissions) => Promise<boolean>;
  onRemoveMember: (memberId: string) => Promise<boolean>;
  onDeletePlaylist: (playlistId: string) => Promise<void>;
  connectedPeersCount: number;
  mediaConnectionState: RoomMediaConnectionState;
  mediaConnectedPeersCount: number;
  peerDiagnostics: PeerDiagnosticsSnapshot[];
  peerRecentEvents: PeerRecentEvent[];
  localMemberState: LocalMemberPanelState | null;
  iceConfigSource: string;
  iceConfigStatus: string;
  workspaceEntryHref: string;
  authEntryHref: string;
  showRoomTransitionState: boolean;
  isNavigatingRoomExit: boolean;
  isRecoveringRoom: boolean;
  isRoomTransitionPending: boolean;
  onClearIdentity: () => void;
  onCopyJoinCode: () => Promise<void>;
  onShareRoom: () => Promise<void>;
  onAwayRoom: () => void;
  onLeaveRoom: () => void;
  onDeleteRoom: () => void;
  onFilesSelected: (files: FileList | File[] | null) => Promise<void>;
  onAddToQueue: (trackId: string) => Promise<unknown>;
  canReorderQueue: boolean;
  canRemoveQueue: boolean;
  onPlayQueueItem: (queueItemId: string) => Promise<void>;
  onPlayNextQueueItem: (queueItemId: string) => Promise<void>;
  onRemoveQueueItem: (queueItemId: string) => Promise<void>;
  onReorderQueue: (queueItemIds: string[]) => Promise<void>;
  onReorderTracks?: (trackIds: string[]) => Promise<void>;
  onDeleteTrack: (trackId: string) => Promise<void>;
  onDeleteTracks?: (trackIds: string[]) => Promise<unknown>;
  onBatchAddToQueue?: (trackIds: string[]) => Promise<unknown>;
  onRemoveQueueItems?: (queueItemIds: string[]) => Promise<void>;
  onPlayTrack: (trackId: string) => Promise<void>;
  onRefreshRoom: () => Promise<RoomSnapshot | null>;
  onRetryRecovery?: () => void;
  onTabChange: (tab: "library" | "search" | "local" | "members") => void;
  onDiagnosticsVisibilityChange: (open: boolean) => void;
  onSeek: (positionMs: number) => void;
  socket: RoomSocket | null;
  playerSlot: ReactNode;
};

function RoomWorkspaceBase({
  activeSession,
  statusMessage,
  statusTone,
  roomSnapshot,
  playbackBarrier,
  roomId,
  currentTrack,
  canControlPlayback,
  canDeleteRoom,
  canDisbandRoom,
  uploadedTracks,
  localStorageSummary,
  playlists,
  onCleanLocalStorage,
  onRefreshLocalStorage,
  onImportCachedTrack,
  onSaveTrackToLocal,
  onSavePlaylistFromQueue,
  onLoadPlaylistIntoRoom,
  onImportNeteaseTrack,
  onImportQqMusicTrack,
  onImportBilibiliTrack,
  onImportNeteaseTracks,
  onImportQqMusicTracks,
  onImportBilibiliTracks,
  onUpdatePlaylistTitle,
  onUpdatePlaylistTracks,
  onUpdateRoom,
  onUpdateMemberPermissions,
  onRemoveMember,
  onDeletePlaylist,
  connectedPeersCount,
  mediaConnectionState,
  mediaConnectedPeersCount,
  peerDiagnostics,
  peerRecentEvents,
  localMemberState,
  iceConfigSource,
  iceConfigStatus,
  workspaceEntryHref,
  authEntryHref,
  showRoomTransitionState,
  isNavigatingRoomExit,
  isRecoveringRoom,
  isRoomTransitionPending,
  onClearIdentity,
  onCopyJoinCode,
  onShareRoom,
  onAwayRoom,
  onLeaveRoom,
  onDeleteRoom,
  onFilesSelected,
  onAddToQueue,
  canReorderQueue,
  canRemoveQueue,
  onPlayQueueItem,
  onPlayNextQueueItem,
  onRemoveQueueItem,
  onReorderQueue,
  onReorderTracks,
  onDeleteTrack,
  onDeleteTracks,
  onBatchAddToQueue,
  onRemoveQueueItems,
  onPlayTrack,
  onRefreshRoom,
  onRetryRecovery,
  onTabChange,
  onDiagnosticsVisibilityChange,
  onSeek,
  currentPlaybackPositionRef,
  socket,
  playerSlot
}: RoomWorkspaceProps) {
  useCustomLayoutRuntime("/room/current");
  const playback = roomSnapshot?.room.playback;
  const host = roomSnapshot?.room.members.find((member) => member.role === "host");
  const isPlaying = playback?.status === "playing" && playbackBarrier?.blocked !== true;
  const currentTrackDuration = currentTrack?.durationMs ?? 0;
  const currentSourceOwnerNickname =
    resolveCurrentSourceNickname(roomSnapshot?.room.members ?? [], playback?.sourceSessionId ?? null);
  const RoomView = roomSnapshot?.room.roomType === "request"
    ? RequestRoomView
    : roomSnapshot?.room.roomType === "radio"
      ? RadioRoomView
      : InteractiveRoomView;

  return (
    <main className="relative box-border flex h-[calc(100*var(--app-dvh))] max-h-[calc(100*var(--app-dvh))] min-h-0 flex-col overflow-hidden bg-background pb-[var(--room-mobile-bottom-inset)] md:pl-60 lg:pb-[var(--room-desktop-bottom-inset)]" data-custom-layout-room-host="true">

      <div className="hidden md:contents">
        <AppSidebar
          hasBottomPlayer
          compactMobile
          roomId={roomId}
          onAwayRoom={onAwayRoom}
        />
      </div>


      {roomSnapshot && statusMessage ? (
        <div
          className="pointer-events-none fixed left-1/2 top-[calc(env(safe-area-inset-top)+5rem)] z-50 w-fit max-w-[calc(100dvw-1rem)] -translate-x-1/2 px-0 sm:top-20"
          aria-live="polite"
        >
          <div
            key={statusMessage}
            data-testid="room-status-message"
            className={`pointer-events-auto w-fit max-w-full break-words whitespace-normal rounded-2xl px-4 py-2.5 text-center text-sm font-medium shadow-xl backdrop-blur-md transition-[background-color,border-color,color,box-shadow,opacity,transform] duration-200 ease-out animate-slide-up ${
              statusTone === "warning"
                ? "border border-red-500/20 bg-red-500/10 text-red-400"
                : statusTone === "success"
                  ? "border border-green-500/20 bg-green-500/10 text-green-400"
                  : "border border-surface-border bg-surface/80 text-foreground"
            }`}
          >
            {statusMessage}
          </div>
        </div>
      ) : null}

      <div
        className="relative min-h-0 flex-1 overflow-hidden bg-background animate-in fade-in duration-[250ms] ease-out motion-reduce:animate-none"
        data-room-shell-viewport="true"
      >
        <div className="h-full min-h-0 w-full">
          {roomSnapshot ? (
            <RoomView
              roomSnapshot={roomSnapshot}
              playbackBarrier={playbackBarrier}
              currentTrack={currentTrack}
              currentTrackDuration={currentTrackDuration}
              currentPlaybackPositionRef={currentPlaybackPositionRef}
              isPlaying={isPlaying}
              activeSession={activeSession}
              host={host}
              canControlPlayback={canControlPlayback}
              canDeleteRoom={canDeleteRoom}
              canDisbandRoom={canDisbandRoom}
              currentSourceOwnerNickname={currentSourceOwnerNickname}
              uploadedTracks={uploadedTracks}
              localStorageSummary={localStorageSummary}
              playlists={playlists}
              onCleanLocalStorage={onCleanLocalStorage}
              onRefreshLocalStorage={onRefreshLocalStorage}
              onImportCachedTrack={onImportCachedTrack}
              onSaveTrackToLocal={onSaveTrackToLocal}
              onSavePlaylistFromQueue={onSavePlaylistFromQueue}
              onLoadPlaylistIntoRoom={onLoadPlaylistIntoRoom}
              onImportNeteaseTrack={onImportNeteaseTrack}
              onImportQqMusicTrack={onImportQqMusicTrack}
              onImportBilibiliTrack={onImportBilibiliTrack}
              onImportNeteaseTracks={onImportNeteaseTracks}
              onImportQqMusicTracks={onImportQqMusicTracks}
              onImportBilibiliTracks={onImportBilibiliTracks}
              onUpdatePlaylistTitle={onUpdatePlaylistTitle}
              onUpdatePlaylistTracks={onUpdatePlaylistTracks}
              onUpdateRoom={onUpdateRoom}
              onUpdateMemberPermissions={onUpdateMemberPermissions}
              onRemoveMember={onRemoveMember}
              onDeletePlaylist={onDeletePlaylist}
              connectedPeersCount={connectedPeersCount}
              mediaConnectionState={mediaConnectionState}
              mediaConnectedPeersCount={mediaConnectedPeersCount}
              peerDiagnostics={peerDiagnostics}
              peerRecentEvents={peerRecentEvents}
              localMemberState={localMemberState}
              iceConfigSource={iceConfigSource}
              iceConfigStatus={iceConfigStatus}
              onCopyJoinCode={onCopyJoinCode}
              onShareRoom={onShareRoom}
              onAwayRoom={onAwayRoom}
              onLeaveRoom={onLeaveRoom}
              onDeleteRoom={onDeleteRoom}
              onFilesSelected={onFilesSelected}
              onAddToQueue={onAddToQueue}
              onBatchAddToQueue={onBatchAddToQueue}
              canReorderQueue={canReorderQueue}
              canRemoveQueue={canRemoveQueue}
              onPlayQueueItem={onPlayQueueItem}
              onPlayNextQueueItem={onPlayNextQueueItem}
              onRemoveQueueItem={onRemoveQueueItem}
              onRemoveQueueItems={onRemoveQueueItems}
              onReorderQueue={onReorderQueue}
              onReorderTracks={onReorderTracks}
              onDeleteTrack={onDeleteTrack}
              onDeleteTracks={onDeleteTracks}
              onPlayTrack={onPlayTrack}
              onRefreshRoom={onRefreshRoom}
              socket={socket}
              onTabChange={onTabChange}
              onDiagnosticsVisibilityChange={onDiagnosticsVisibilityChange}
              onSeek={onSeek}
            />
          ) : showRoomTransitionState ? (
            <RoomTransitionState
              isNavigatingRoomExit={isNavigatingRoomExit}
              isRecoveringRoom={isRecoveringRoom || isRoomTransitionPending}
            />
          ) : (
            <EmptyRoomState
              activeSession={activeSession}
              workspaceEntryHref={workspaceEntryHref}
              authEntryHref={authEntryHref}
              onClearIdentity={onClearIdentity}
              onRetryRecovery={onRetryRecovery}
            />
          )}
        </div>
      </div>

      {playerSlot}
    </main>
  );
}

export const RoomWorkspace = memo(RoomWorkspaceBase);

export function resolveCurrentSourceNickname(
  members: Array<Pick<RoomSnapshot["room"]["members"][number], "id" | "nickname">>,
  sourceSessionId: string | null
) {
  return members.find((member) => member.id === sourceSessionId)?.nickname ?? null;
}
