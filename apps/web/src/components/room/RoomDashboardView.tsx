"use client";

import { memo, useCallback, useEffect, useState, type KeyboardEvent } from "react";
import dynamic from "next/dynamic";
import type {
  AuthSession,
  BilibiliTrackCandidate,
  NeteaseTrackCandidate,
  Playlist,
  PeerDiagnosticsSnapshot,
  PeerRecentEvent,
  RoomMemberPermissions,
  RoomMediaConnectionState,
  RoomMember,
  RoomSnapshot,
  QqMusicTrackCandidate,
  TrackMeta,
  UpdateRoomRequest
} from "@soqaro/shared";
import { RoomControlHeader } from "./RoomControlHeader";
import { RoomImportProgressBar } from "./RoomImportProgressBar";
import { RoomStage } from "./RoomStage";
import { RoomPanelSkeleton } from "./RoomPanelSkeleton";
import { RoomTabPanelPlaceholder, preloadRoomPanelChunks } from "./RoomTabPanelPlaceholder";
import { useProgressiveRoomLoading } from "./hooks/use-progressive-room-loading";
import type { CachedLibraryTrack, UploadedTrack } from "@/features/library/audio-utils";
import type { LocalStorageSummary } from "@/features/upload/use-track-uploads";
import type { RoomSocket } from "@/lib/network/ws-client";
import type { LocalMemberPanelState } from "./MembersPanel";
import { resolveCurrentSourcePeerId } from "@/features/room/hooks/use-room-page-derived";
import type { RoomPlaybackBarrierClock } from "@/features/playback/room-playback-clock";
import { getCurrentRoomMemberPermissions, isRoomHost } from "@/features/room/room-permissions";
import {
  MusicIcon,
  RadioIcon,
  SearchIcon,
  UsersIcon
} from "@/components/icons/DiscoverIcons";

type ManagementTabId = "library" | "search" | "local" | "members";

export type RoomDashboardViewProps = {
  roomSnapshot: RoomSnapshot;
  playbackBarrier?: RoomPlaybackBarrierClock | null;
  currentTrack: TrackMeta | null;
  currentTrackDuration: number;
  currentPlaybackPositionRef?: React.MutableRefObject<number>;
  isPlaying: boolean;
  activeSession: AuthSession | null;
  host: RoomMember | undefined;
  canControlPlayback: boolean;
  canDeleteRoom: boolean;
  canDisbandRoom: boolean;
  currentSourceOwnerNickname: string | null;
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
  onCopyJoinCode: () => Promise<void>;
  onShareRoom: () => Promise<void>;
  onAwayRoom: () => void;
  onLeaveRoom: () => void;
  onDeleteRoom: () => void;
  onFilesSelected: (files: FileList | File[] | null) => Promise<void>;
  onAddToQueue: (trackId: string) => Promise<unknown>;
  onBatchAddToQueue?: (trackIds: string[]) => Promise<unknown>;
  canReorderQueue: boolean;
  canRemoveQueue: boolean;
  onPlayQueueItem: (queueItemId: string) => Promise<void>;
  onPlayNextQueueItem: (queueItemId: string) => Promise<void>;
  onRemoveQueueItem: (queueItemId: string) => Promise<void>;
  onRemoveQueueItems?: (queueItemIds: string[]) => Promise<void>;
  onReorderQueue: (queueItemIds: string[]) => Promise<void>;
  onReorderTracks?: (trackIds: string[]) => Promise<void>;
  onDeleteTrack: (trackId: string) => Promise<void>;
  onDeleteTracks?: (trackIds: string[]) => Promise<unknown>;
  onPlayTrack: (trackId: string) => Promise<void>;
  onRefreshRoom: () => Promise<RoomSnapshot | null>;
  socket: RoomSocket | null;
  onTabChange?: (tab: ManagementTabId) => void;
  onDiagnosticsVisibilityChange?: (open: boolean) => void;
  onSeek: (positionMs: number) => void;
};

type RoomLayoutProps = RoomDashboardViewProps & {
  isHost: boolean;
  canManageLibrary: boolean;
  canAddToQueue: boolean;
  currentSourcePeerId: string | null;
};

const tabConfigs: Array<{ id: ManagementTabId; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "library", label: "曲库", icon: MusicIcon },
  { id: "search", label: "搜索", icon: SearchIcon },
  { id: "local", label: "我的歌单", icon: RadioIcon },
  { id: "members", label: "成员", icon: UsersIcon }
];

const LibraryTabPanel = dynamic(() => import("./LibraryTabPanel").then((mod) => mod.LibraryTabPanel), {
  loading: RoomTabPanelPlaceholder
});
const SearchTabPanel = dynamic(() => import("./SearchTabPanel").then((mod) => mod.SearchTabPanel), {
  loading: RoomTabPanelPlaceholder
});
const LocalStorageTabPanel = dynamic(() => import("./LocalStorageTabPanel").then((mod) => mod.LocalStorageTabPanel), {
  loading: RoomTabPanelPlaceholder
});
const MembersTabPanel = dynamic(() => import("./MembersTabPanel").then((mod) => mod.MembersTabPanel), {
  loading: RoomTabPanelPlaceholder
});

function RoomDashboardViewBase(props: RoomDashboardViewProps) {
  const currentSourcePeerId = resolveCurrentSourcePeerId(props.roomSnapshot, props.roomSnapshot.room.playback);
  const currentRoomPermissions = getCurrentRoomMemberPermissions(props.roomSnapshot, props.activeSession?.userId);
  const isHost = isRoomHost(props.roomSnapshot, props.activeSession?.userId);
  const canManageLibrary = currentRoomPermissions?.library === true;
  const canAddToQueue = currentRoomPermissions?.queue === true;

  const layoutProps: RoomLayoutProps = {
    ...props,
    isHost,
    canManageLibrary,
    canAddToQueue,
    currentSourcePeerId
  };

  return <InteractiveRoomLayout {...layoutProps} />;
}

function InteractiveRoomLayout(props: RoomLayoutProps) {
  const { stageReady, panelsReady } = useProgressiveRoomLoading();
  const [activeTab, setActiveTab] = useState<ManagementTabId>("library");
  const { onDiagnosticsVisibilityChange, onTabChange } = props;

  // 四个 tab 面板迟早都会被点到:空闲时预取 chunk,让首次切换无需加载占位。
  useEffect(
    () =>
      preloadRoomPanelChunks([
        () => import("./LibraryTabPanel"),
        () => import("./SearchTabPanel"),
        () => import("./LocalStorageTabPanel"),
        () => import("./MembersTabPanel")
      ]),
    []
  );
  const handleTabChange = useCallback((tab: ManagementTabId) => {
    setActiveTab(tab);
    if (tab !== "members") onDiagnosticsVisibilityChange?.(false);
    onTabChange?.(tab);
  }, [onDiagnosticsVisibilityChange, onTabChange]);
  const handleTabKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, tab: ManagementTabId) => {
    const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    const tabIds = tabConfigs.map((t) => t.id);
    const nextTab = tabIds[(tabIds.indexOf(tab) + direction + tabIds.length) % tabIds.length];
    handleTabChange(nextTab);
    document.getElementById(`room-tab-${nextTab}`)?.focus();
  }, [handleTabChange]);

  return (
    <div className="custom-scrollbar relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-y-auto overscroll-contain md:grid md:h-full md:grid-cols-[minmax(0,1.05fr)_minmax(22rem,0.95fr)] md:overflow-hidden md:gap-0" data-custom-layout-room-root="true">
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        {props.isPlaying ? <div className="absolute left-1/2 top-24 h-[58vw] w-[58vw] -translate-x-1/2 rounded-full bg-accent/6 blur-[110px] sm:h-[46vw] sm:w-[46vw] md:left-[28%] md:top-1/4" /> : null}
      </div>
      <div className="relative z-40 hidden md:flex h-auto w-full min-w-0 shrink-0 flex-col md:z-10 md:h-full md:min-h-0 md:overflow-hidden" data-custom-layout-item="room-stage">
        <div className="flex h-auto min-h-0 flex-1 flex-col md:h-full md:flex-[2] md:min-h-0">
          {stageReady ? (
            <RoomStage {...buildRoomStageProps(props)} />
          ) : (
            <div className="h-full min-h-[22rem] w-full rounded-2xl bg-surface/[0.04] animate-pulse" />
          )}
        </div>
      </div>
      <section className="material-surface relative z-20 flex min-h-[24rem] w-full min-w-0 flex-1 flex-col md:min-h-0 md:rounded-none md:border-l md:border-surface-border md:shadow-[-6px_0_24px_rgba(0,0,0,0.05)] dark:md:shadow-[-12px_0_36px_rgba(0,0,0,0.3)]" data-custom-layout-item="room-panel">
        <div className="material-surface-header sticky top-0 z-30 shrink-0 border-b border-surface-border bg-surface/30 backdrop-blur-md md:rounded-none">
          {/* Mobile Room Header matching desktop control bar */}
          <div className="border-b border-surface-border/60 px-3 pt-[calc(0.45rem+env(safe-area-inset-top,0px))] pb-2 md:hidden bg-background/95 backdrop-blur-md">
            <RoomControlHeader
              isMobile
              roomSnapshot={props.roomSnapshot}
              mediaConnectionState={props.mediaConnectionState}
              currentTrack={props.currentTrack}
              host={props.host}
              canDeleteRoom={props.canDeleteRoom}
              canDisbandRoom={props.canDisbandRoom}
              onCopyJoinCode={props.onCopyJoinCode}
              onShareRoom={props.onShareRoom}
              onAwayRoom={props.onAwayRoom}
              onLeaveRoom={props.onLeaveRoom}
              onDeleteRoom={props.onDeleteRoom}
              onUpdateRoom={props.onUpdateRoom}
            />
          </div>

          <div aria-label="房间视图" className="flex w-full items-center overflow-x-auto hide-scrollbar shrink-0" role="tablist">
            {tabConfigs.map(({ id: tab, label, icon: IconComp }) => {
              const isActive = activeTab === tab;
              return (
                <button
                  key={tab}
                  id={`room-tab-${tab}`}
                  data-testid={`room-tab-${tab}`}
                  aria-controls={`room-panel-${tab}`}
                  aria-selected={isActive}
                  onClick={() => handleTabChange(tab)}
                  onKeyDown={(event) => handleTabKeyDown(event, tab)}
                  role="tab"
                  tabIndex={isActive ? 0 : -1}
                  className={`relative flex-1 flex h-10 min-w-fit items-center justify-center gap-1.5 px-3 text-xs sm:text-sm transition-colors cursor-pointer select-none ${
                    isActive
                      ? "text-foreground font-semibold"
                      : "text-foreground-muted hover:text-foreground hover:bg-surface-hover/30"
                  }`}
                  type="button"
                >
                  <IconComp className={`w-3.5 h-3.5 shrink-0 transition-colors ${isActive ? "text-accent" : "text-foreground-muted"}`} />
                  <span className="whitespace-nowrap">{label}</span>
                  {isActive ? (
                    <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent-glow)]" />
                  ) : null}
                </button>
              );
            })}
          </div>
          <RoomImportProgressBar />
        </div>
        <div aria-labelledby={`room-tab-${activeTab}`} className="custom-scrollbar min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 pt-3 pb-[calc(var(--room-mobile-bottom-inset)+1.5rem)] sm:px-5 sm:py-4 md:pb-24 lg:pb-24" id={`room-panel-${activeTab}`} role="tabpanel">
          {panelsReady ? (
            <RoomManagementContent {...props} activeTab={activeTab} />
          ) : (
            <RoomPanelSkeleton />
          )}
        </div>
      </section>
    </div>
  );
}

function RoomManagementContent(props: RoomLayoutProps & { activeTab: ManagementTabId }) {
  if (props.activeTab === "library") {
    return (
      <LibraryTabPanel
        activeSession={props.activeSession}
        canAddToQueue={props.canAddToQueue}
        canControlPlayback={props.canControlPlayback}
        canManageAllTracks={props.isHost}
        canManageLibrary={props.canManageLibrary}
        localFolderName={props.localStorageSummary.localFolderName}
        localSavedFileHashes={props.localStorageSummary.localSavedFileHashes}
        members={props.roomSnapshot.room.members}
        onAddToQueue={props.onAddToQueue}
        onBatchAddToQueue={props.onBatchAddToQueue}
        onDeletePlaylist={props.onDeletePlaylist}
        onDeleteTrack={props.onDeleteTrack}
        onDeleteTracks={props.onDeleteTracks}
        onFilesSelected={props.onFilesSelected}
        onImportCachedTrack={props.onImportCachedTrack}
        onImportNeteaseTrack={props.onImportNeteaseTrack}
        onImportNeteaseTracks={props.onImportNeteaseTracks}
        onImportQqMusicTrack={props.onImportQqMusicTrack}
        onImportQqMusicTracks={props.onImportQqMusicTracks}
        onImportBilibiliTrack={props.onImportBilibiliTrack}
        onImportBilibiliTracks={props.onImportBilibiliTracks}
        onLoadPlaylistIntoRoom={props.onLoadPlaylistIntoRoom}
        onPlayTrack={props.onPlayTrack}
        onReorderTracks={props.onReorderTracks}
        onSaveTrackToLocal={props.onSaveTrackToLocal}
        onRefreshRoom={props.onRefreshRoom}
        roomId={props.roomSnapshot.room.id}
        roomPlaylists={props.roomSnapshot.playlists}
        tracks={props.roomSnapshot.tracks}
        uploadedTracks={props.uploadedTracks}
      />
    );
  }
  if (props.activeTab === "search") {
    return (
      <SearchTabPanel
        canManageLibrary={props.canManageLibrary}
        onImportBilibiliTrack={props.onImportBilibiliTrack}
        onImportBilibiliTracks={props.onImportBilibiliTracks}
        onImportNeteaseTrack={props.onImportNeteaseTrack}
        onImportQqMusicTrack={props.onImportQqMusicTrack}
        roomTracks={props.roomSnapshot.tracks}
      />
    );
  }
  if (props.activeTab === "local") {
    return (
      <LocalStorageTabPanel
        activeSession={props.activeSession}
        canManageLibrary={props.canManageLibrary}
        currentRoomId={props.roomSnapshot.room.id}
        localStorageSummary={props.localStorageSummary}
        onCleanLocalStorage={props.onCleanLocalStorage}
        onDeletePlaylist={props.onDeletePlaylist}
        onImportBilibiliTrack={props.onImportBilibiliTrack}
        onImportBilibiliTracks={props.onImportBilibiliTracks}
        onImportCachedTrack={props.onImportCachedTrack}
        onImportNeteaseTrack={props.onImportNeteaseTrack}
        onImportNeteaseTracks={props.onImportNeteaseTracks}
        onImportQqMusicTrack={props.onImportQqMusicTrack}
        onImportQqMusicTracks={props.onImportQqMusicTracks}
        onLoadPlaylistIntoRoom={props.onLoadPlaylistIntoRoom}
        onRefreshLocalStorage={props.onRefreshLocalStorage}
        onSavePlaylistFromQueue={props.onSavePlaylistFromQueue}
        onUpdatePlaylistTitle={props.onUpdatePlaylistTitle}
        onUpdatePlaylistTracks={props.onUpdatePlaylistTracks}
        playlists={props.playlists}
        roomPlaylists={props.roomSnapshot.playlists}
        tracks={props.roomSnapshot.tracks}
        onRefreshRoom={props.onRefreshRoom}
      />
    );
  }
  return <MembersTabPanel members={props.roomSnapshot.room.members} peerDiagnostics={props.peerDiagnostics} peerRecentEvents={props.peerRecentEvents} localMemberState={props.localMemberState} playbackStatus={props.roomSnapshot.room.playback.status} sourceSessionId={props.roomSnapshot.room.playback.sourceSessionId} sourcePeerId={props.currentSourcePeerId} iceConfigSource={props.iceConfigSource} iceConfigStatus={props.iceConfigStatus} activeSessionId={props.activeSession?.userId ?? null} isHost={props.isHost} onUpdateMemberPermissions={props.onUpdateMemberPermissions} onRemoveMember={props.onRemoveMember} onDiagnosticsVisibilityChange={props.onDiagnosticsVisibilityChange} />;
}

export function buildRoomStageProps(
  props: RoomDashboardViewProps,
  options?: { showMobilePlayer?: boolean; hideRoomMetadata?: boolean; mobileControlsOnly?: boolean }
) {
  return {
    roomSnapshot: props.roomSnapshot,
    playbackBarrier: props.playbackBarrier,
    currentTrack: props.currentTrack,
    currentTrackDuration: props.currentTrackDuration,
    currentPlaybackPositionRef: props.currentPlaybackPositionRef,
    isPlaying: props.isPlaying,
    host: props.host,
    canDeleteRoom: props.canDeleteRoom,
    canDisbandRoom: props.canDisbandRoom,
    currentSourceOwnerNickname: props.currentSourceOwnerNickname,
    mediaConnectionState: props.mediaConnectionState,
    mediaConnectedPeersCount: props.mediaConnectedPeersCount,
    iceConfigSource: props.iceConfigSource,
    onUpdateRoom: props.onUpdateRoom,
    onCopyJoinCode: props.onCopyJoinCode,
    onShareRoom: props.onShareRoom,
    onAwayRoom: props.onAwayRoom,
    onLeaveRoom: props.onLeaveRoom,
    onDeleteRoom: props.onDeleteRoom,
    onSeek: props.onSeek,
    socket: props.socket,
    showMobilePlayer: options?.showMobilePlayer,
    hideRoomMetadata: options?.hideRoomMetadata,
    mobileControlsOnly: options?.mobileControlsOnly
  };
}

export const RoomDashboardView = memo(RoomDashboardViewBase);
