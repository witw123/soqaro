"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { RoomTabPanelPlaceholder, preloadRoomPanelChunks } from "./RoomTabPanelPlaceholder";
import dynamic from "next/dynamic";
import type {
  BilibiliTrackCandidate,
  NeteaseTrackCandidate,
  QqMusicTrackCandidate,
  RoomRequest,
  TrackMeta
} from "@soqaro/shared";
import { Button } from "@/components/ui/button";
import { PlayerQueueList } from "@/components/bottom-player";
import { formatDuration } from "@/lib/domain/soqaro-ui";
import { soqaroApi } from "@/lib/network/soqaro-api";
import { getArtworkSourceUrl } from "@/components/bottom-player/artwork-colors";
import { RoomControlHeader } from "./RoomControlHeader";
import { RoomImportProgressBar } from "./RoomImportProgressBar";
import type { RoomDashboardViewProps } from "./RoomDashboardView";
import {
  FolderIcon,
  HistoryIcon,
  InboxIcon,
  LayersIcon,
  ListMusicIcon,
  MusicIcon,
  SearchIcon,
  UsersIcon
} from "@/components/icons/DiscoverIcons";
import { useProgressiveRoomLoading } from "./hooks/use-progressive-room-loading";
import { RoomPanelSkeleton } from "./RoomPanelSkeleton";

const LibraryTabPanel = dynamic(() => import("./LibraryTabPanel").then((m) => m.LibraryTabPanel), {
  loading: RoomTabPanelPlaceholder
});
const LocalStorageTabPanel = dynamic(() => import("./LocalStorageTabPanel").then((m) => m.LocalStorageTabPanel), {
  loading: RoomTabPanelPlaceholder
});
const MembersPanel = dynamic(() => import("./MembersPanel").then((m) => m.MembersPanel), {
  loading: RoomTabPanelPlaceholder
});
const RoomProviderTrackSearch = dynamic(() => import("./RoomProviderTrackSearch").then((m) => m.RoomProviderTrackSearch), {
  loading: RoomTabPanelPlaceholder
});

type ProviderCandidate = NeteaseTrackCandidate | QqMusicTrackCandidate | BilibiliTrackCandidate;

type HostLeftTab = "inbox" | "search" | "library" | "playlists";
type MemberLeftTab = "search" | "my-requests" | "library";
type RequestLeftTab = HostLeftTab | MemberLeftTab;
type RequestRightTab = "queue" | "members";
type HostMobileTab = "inbox" | "search" | "queue" | "library" | "members";
type MemberMobileTab = "search" | "my-requests" | "queue" | "library" | "members";
type RequestMobileTab = HostMobileTab | MemberMobileTab;

export function RequestRoomView(props: RoomDashboardViewProps) {
  // 房间内各面板迟早会被点到:空闲时预取,避免首次切换出现加载占位。
  useEffect(
    () =>
      preloadRoomPanelChunks([
        () => import("./LibraryTabPanel"),
        () => import("./LocalStorageTabPanel"),
        () => import("./MembersPanel"),
        () => import("./RoomProviderTrackSearch")
      ]),
    []
  );
  const { panelsReady } = useProgressiveRoomLoading();
  const roomId = props.roomSnapshot.room.id;
  const isHost = props.roomSnapshot.room.hostId === props.activeSession?.userId;
  const snapshotRef = useRef(props.roomSnapshot);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [membershipNow, setMembershipNow] = useState(() => Date.now());

  const requests = useMemo(
    () => props.roomSnapshot.room.requests ?? [],
    [props.roomSnapshot.room.requests]
  );
  const myRequests = useMemo(
    () => requests.filter((request) => request.requesterId === props.activeSession?.userId),
    [props.activeSession?.userId, requests]
  );
  const pendingRequests = useMemo(
    () => requests.filter((request) => request.status === "pending"),
    [requests]
  );
  const handledRequests = useMemo(
    () => requests.filter((request) => request.status !== "pending").slice().reverse(),
    [requests]
  );

  const [leftTab, setLeftTab] = useState<RequestLeftTab>(() => {
    if (isHost) return pendingRequests.length > 0 ? "inbox" : "search";
    return "search";
  });
  const [rightTab, setRightTab] = useState<RequestRightTab>("queue");
  const [mobileTab, setMobileTab] = useState<RequestMobileTab>(() => {
    if (isHost) return pendingRequests.length > 0 ? "inbox" : "search";
    return "search";
  });

  useEffect(() => {
    snapshotRef.current = props.roomSnapshot;
  }, [props.roomSnapshot]);

  useEffect(() => {
    const timer = window.setInterval(() => setMembershipNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const queueCount = props.roomSnapshot.queue.length;
  const memberCount = props.roomSnapshot.room.members.length;

  const decideRequest = async (
    request: RoomRequest,
    decision: "approved" | "rejected",
    options?: { playNext?: boolean }
  ) => {
    if (pendingRequestId) return;
    setPendingRequestId(request.id);
    setMessage(null);
    try {
      if (decision === "rejected") {
        await soqaroApi.rejectRoomRequest(roomId, request.id);
        setMessage(`已拒绝《${request.title}》。`);
        return;
      }

      snapshotRef.current = await soqaroApi.getRoom(roomId);
      const track = await importRequestedTrack(request, props, snapshotRef);
      snapshotRef.current = await soqaroApi.getRoom(roomId);
      let queuedId = snapshotRef.current.queue.find((item) => item.trackId === track.id)?.id;
      if (!queuedId) {
        const queuedItem = await props.onAddToQueue(track.id);
        if (!queuedItem) {
          throw new Error("歌曲未能加入共享队列，点歌仍保持待审核。请检查房主权限或稍后重试。");
        }
        queuedId = (queuedItem as { id?: string })?.id;
      }
      await soqaroApi.approveRoomRequest(roomId, request.id);

      if (options?.playNext && queuedId) {
        await props.onPlayNextQueueItem(queuedId);
        setMessage(`《${request.title}》已批准并设为下一首播放。`);
      } else {
        setMessage(`《${request.title}》已加入共享队列。`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "处理点歌失败，请稍后重试。");
    } finally {
      setPendingRequestId(null);
    }
  };

  const handleApproveAll = async () => {
    if (pendingRequestId || pendingRequests.length === 0) return;
    setPendingRequestId("batch:all");
    setMessage(null);
    try {
      let count = 0;
      for (const request of pendingRequests) {
        try {
          snapshotRef.current = await soqaroApi.getRoom(roomId);
          const track = await importRequestedTrack(request, props, snapshotRef);
          snapshotRef.current = await soqaroApi.getRoom(roomId);
          const alreadyQueued = snapshotRef.current.queue.some((item) => item.trackId === track.id);
          if (!alreadyQueued) {
            await props.onAddToQueue(track.id);
          }
          await soqaroApi.approveRoomRequest(roomId, request.id);
          count += 1;
        } catch {
          // Continue with subsequent items in batch
        }
      }
      setMessage(`已批量接纳 ${count} 首点歌。`);
    } finally {
      setPendingRequestId(null);
    }
  };

  const submitRequest = async (track: ProviderCandidate) => {
    setMessage(null);
    const request = await soqaroApi.createRoomRequest(roomId, {
      provider: track.provider,
      providerTrackId: track.providerTrackId,
      title: track.title,
      artist: track.artist,
      album: track.album ?? null,
      durationMs: track.durationMs,
      artworkUrl: track.artworkUrl ?? null
    });
    if (isHost) {
      await decideRequest(request, "approved");
      return;
    }
    setMessage(`《${track.title}》已送入房主审核队列。`);
  };

  const hostLeftTabs = useMemo(() => [
    { id: "inbox" as const, label: `待审核 (${pendingRequests.length})`, icon: InboxIcon },
    { id: "search" as const, label: "搜歌导入", icon: SearchIcon },
    { id: "library" as const, label: "曲库", icon: FolderIcon },
    { id: "playlists" as const, label: "歌单", icon: LayersIcon }
  ], [pendingRequests.length]);

  const memberLeftTabs = useMemo(() => [
    { id: "search" as const, label: "我要点歌", icon: SearchIcon },
    { id: "my-requests" as const, label: `我的记录 (${myRequests.length})`, icon: HistoryIcon },
    { id: "library" as const, label: "曲库", icon: FolderIcon }
  ], [myRequests.length]);

  const rightTabs = useMemo(() => [
    { id: "queue" as const, label: `点歌队列 (${queueCount})`, icon: ListMusicIcon },
    { id: "members" as const, label: `成员 (${memberCount})`, icon: UsersIcon }
  ], [queueCount, memberCount]);

  const mobileTabs = useMemo(() => {
    const list: Array<{ id: RequestMobileTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [];
    if (isHost) {
      list.push(
        { id: "inbox", label: `审核 (${pendingRequests.length})`, icon: InboxIcon },
        { id: "search", label: "搜歌", icon: SearchIcon },
        { id: "queue", label: `队列 (${queueCount})`, icon: ListMusicIcon },
        { id: "library", label: "曲库", icon: FolderIcon },
        { id: "members", label: `成员 (${memberCount})`, icon: UsersIcon }
      );
    } else {
      list.push(
        { id: "search", label: "我要点歌", icon: SearchIcon },
        { id: "my-requests", label: `我的 (${myRequests.length})`, icon: HistoryIcon },
        { id: "queue", label: `队列 (${queueCount})`, icon: ListMusicIcon },
        { id: "library", label: "曲库", icon: FolderIcon },
        { id: "members", label: `成员 (${memberCount})`, icon: UsersIcon }
      );
    }
    return list;
  }, [isHost, pendingRequests.length, queueCount, memberCount, myRequests.length]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background" data-room-view="request">
      {/* Mobile Top Room Control Header */}
      <div className="relative z-30 shrink-0 px-3 pt-[calc(0.45rem+env(safe-area-inset-top,0px))] pb-2 lg:hidden border-b border-surface-border/50 bg-background/95 backdrop-blur-md">
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

      {/* Desktop Unified Header Bar */}
      <div className="relative z-30 hidden lg:block shrink-0 border-b border-surface-border/50 bg-surface/40 px-3 sm:px-4 backdrop-blur-xl">
        <RoomControlHeader
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

      {/* Desktop Balanced Split Layout */}
      <div className="hidden lg:grid flex-1 min-h-0 w-full lg:grid-cols-[minmax(0,1.3fr)_minmax(22rem,0.9fr)] divide-x divide-surface-border/40 overflow-hidden">
        {/* Left Column: Request & Review Station */}
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <RequestWorkspaceTabs
            activeTab={leftTab}
            ariaLabel="点歌管理"
            panelPrefix="request-left"
            onChange={(tab) => setLeftTab(tab)}
            tabs={isHost ? hostLeftTabs : memberLeftTabs}
          />
          <div className="px-2 shrink-0">
            <RoomImportProgressBar />
          </div>
          <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
            {message ? (
              <div className="px-3 pt-2">
                <p className="rounded-xl border border-surface-border/60 bg-surface/80 px-3 py-1.5 text-xs text-foreground backdrop-blur-md shadow-xs" role="status">
                  {message}
                </p>
              </div>
            ) : null}
            {panelsReady ? (
              leftTab === "inbox" && isHost ? (
                <div className="p-2 sm:p-2.5">
                  <RequestInbox
                    pendingRequestId={pendingRequestId}
                    pendingRequests={pendingRequests}
                    handledRequests={handledRequests}
                    onDecide={decideRequest}
                    onApproveAll={handleApproveAll}
                  />
                </div>
              ) : leftTab === "search" ? (
                <div className="p-2 sm:p-2.5" data-testid={isHost ? "request-room-host-search" : "request-room-search"}>
                  <RoomProviderTrackSearch
                    canManageLibrary={isHost}
                    hideUnavailableProvidersNotice
                    mode={isHost ? "import" : "request"}
                    onRequestTrack={submitRequest}
                    onImportNeteaseTrack={props.onImportNeteaseTrack}
                    onImportQqMusicTrack={props.onImportQqMusicTrack}
                    onImportBilibiliTrack={props.onImportBilibiliTrack}
                    onImportBilibiliTracks={props.onImportBilibiliTracks}
                    roomTracks={props.roomSnapshot.tracks}
                    surface="plain"
                  />
                </div>
              ) : leftTab === "my-requests" ? (
                <div className="p-2 sm:p-2.5">
                  <RequestHistory
                    queue={props.roomSnapshot.queue}
                    requests={myRequests}
                    title="我的点歌"
                    tracks={props.roomSnapshot.tracks}
                  />
                </div>
              ) : leftTab === "library" ? (
                <div className="flex h-full min-h-0 flex-col p-2 sm:p-2.5">
                  <LibraryTabPanel
                    activeSession={props.activeSession}
                    canAddToQueue={isHost}
                    canControlPlayback={props.canControlPlayback}
                    canManageAllTracks={isHost}
                    canManageLibrary={isHost}
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
                </div>
              ) : (
                <div className="flex h-full min-h-0 flex-col p-2 sm:p-2.5">
                  <LocalStorageTabPanel
                    activeSession={props.activeSession}
                    canManageLibrary={isHost}
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
                </div>
              )
            ) : (
              <RoomPanelSkeleton />
            )}
          </div>
        </div>

        {/* Right Column: Queue & Activity Station */}
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background">
          <RequestWorkspaceTabs
            activeTab={rightTab}
            ariaLabel="队列与成员"
            panelPrefix="request-right"
            onChange={setRightTab}
            tabs={rightTabs}
          />
          <div
            aria-labelledby={`request-right-tab-${rightTab}`}
            className="hide-scrollbar flex min-h-0 flex-1 flex-col overflow-hidden"
            id={`request-right-panel-${rightTab}`}
            role="tabpanel"
          >
            {panelsReady ? (
              rightTab === "queue" ? (
                <div className="flex h-full min-h-0 flex-col p-2 sm:p-2.5" data-testid="request-queue-panel">
                  <PlayerQueueList
                    canControlPlayback={props.canControlPlayback}
                    canRemoveQueue={props.canRemoveQueue}
                    canReorderQueue={props.canReorderQueue}
                    currentQueueItemId={props.roomSnapshot.room.playback.currentQueueItemId}
                    nextQueueItemId={props.roomSnapshot.room.playback.nextQueueItemId ?? null}
                    onPlayNextQueueItem={props.onPlayNextQueueItem}
                    onPlayQueueItem={props.onPlayQueueItem}
                    onRemoveQueueItem={props.onRemoveQueueItem}
                    onRemoveQueueItems={props.onRemoveQueueItems}
                    onReorderQueue={props.onReorderQueue}
                    queue={props.roomSnapshot.queue}
                    tracks={props.roomSnapshot.tracks}
                    members={props.roomSnapshot.room.members}
                    currentSessionId={props.activeSession?.userId ?? null}
                  />
                </div>
              ) : (
                <div className="flex h-full min-h-0 flex-1 min-w-0 flex-col overflow-hidden p-2 sm:p-2.5" data-testid="request-members-panel">
                  <MembersPanel
                    activeSessionId={props.activeSession?.userId ?? null}
                    isHost={isHost}
                    members={props.roomSnapshot.room.members}
                    now={membershipNow}
                    onRemoveMember={props.onRemoveMember}
                    onUpdateMemberPermissions={props.onUpdateMemberPermissions}
                  />
                </div>
              )
            ) : (
              <RoomPanelSkeleton />
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 flex-col overflow-hidden lg:hidden">
        <div className="material-surface-header sticky top-0 z-30 shrink-0 border-b border-surface-border bg-surface/30 backdrop-blur-md">
          <div
            aria-label="点歌功能"
            className="flex w-full items-center overflow-x-auto hide-scrollbar"
            role="tablist"
          >
            {mobileTabs.map((tab) => {
              const isActive = mobileTab === tab.id;
              const IconComp = tab.icon;
              return (
                <button
                  key={tab.id}
                  aria-selected={isActive}
                  className={`relative flex-1 flex h-10 min-w-fit items-center justify-center gap-1.5 px-3 text-xs transition-colors cursor-pointer select-none ${
                    isActive
                      ? "text-foreground font-semibold"
                      : "text-foreground-muted hover:text-foreground hover:bg-surface-hover/30"
                  }`}
                  onClick={() => setMobileTab(tab.id)}
                  role="tab"
                  type="button"
                >
                  <IconComp className={`w-3.5 h-3.5 shrink-0 transition-colors ${isActive ? "text-accent" : "text-foreground-muted"}`} />
                  <span className="whitespace-nowrap">{tab.label}</span>
                  {isActive ? (
                    <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent-glow)]" />
                  ) : null}
                </button>
              );
            })}
          </div>
          <RoomImportProgressBar />
        </div>

        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto pb-[calc(var(--room-mobile-bottom-inset)+1rem)]">
          {message ? (
            <div className="px-3 pt-2">
              <p className="rounded-xl border border-surface-border/60 bg-surface/80 px-3 py-1.5 text-xs text-foreground backdrop-blur-md shadow-xs" role="status">
                {message}
              </p>
            </div>
          ) : null}
          {panelsReady ? (
            mobileTab === "inbox" && isHost ? (
              <div className="p-2">
                <RequestInbox
                  pendingRequestId={pendingRequestId}
                  pendingRequests={pendingRequests}
                  handledRequests={handledRequests}
                  onDecide={decideRequest}
                  onApproveAll={handleApproveAll}
                />
              </div>
            ) : mobileTab === "search" ? (
              <div className="p-2">
                <RoomProviderTrackSearch
                  canManageLibrary={isHost}
                  hideUnavailableProvidersNotice
                  mode={isHost ? "import" : "request"}
                  onRequestTrack={submitRequest}
                  onImportNeteaseTrack={props.onImportNeteaseTrack}
                  onImportQqMusicTrack={props.onImportQqMusicTrack}
                  onImportBilibiliTrack={props.onImportBilibiliTrack}
                  onImportBilibiliTracks={props.onImportBilibiliTracks}
                  roomTracks={props.roomSnapshot.tracks}
                  surface="plain"
                />
              </div>
            ) : mobileTab === "my-requests" ? (
              <div className="p-2">
                <RequestHistory
                  queue={props.roomSnapshot.queue}
                  requests={myRequests}
                  title="我的点歌"
                  tracks={props.roomSnapshot.tracks}
                />
              </div>
            ) : mobileTab === "queue" ? (
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex-1 min-h-0 p-2">
                  <PlayerQueueList
                    canControlPlayback={props.canControlPlayback}
                    canRemoveQueue={props.canRemoveQueue}
                    canReorderQueue={props.canReorderQueue}
                    currentQueueItemId={props.roomSnapshot.room.playback.currentQueueItemId}
                    nextQueueItemId={props.roomSnapshot.room.playback.nextQueueItemId ?? null}
                    onPlayNextQueueItem={props.onPlayNextQueueItem}
                    onPlayQueueItem={props.onPlayQueueItem}
                    onRemoveQueueItem={props.onRemoveQueueItem}
                    onRemoveQueueItems={props.onRemoveQueueItems}
                    onReorderQueue={props.onReorderQueue}
                    queue={props.roomSnapshot.queue}
                    tracks={props.roomSnapshot.tracks}
                    members={props.roomSnapshot.room.members}
                    currentSessionId={props.activeSession?.userId ?? null}
                  />
                </div>
              </div>
            ) : mobileTab === "library" ? (
              <div className="flex h-full min-h-0 flex-col p-2">
                <LibraryTabPanel
                  activeSession={props.activeSession}
                  canAddToQueue={isHost}
                  canControlPlayback={props.canControlPlayback}
                  canManageAllTracks={isHost}
                  canManageLibrary={isHost}
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
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-1 min-w-0 flex-col overflow-hidden p-2">
                <MembersPanel
                  activeSessionId={props.activeSession?.userId ?? null}
                  isHost={isHost}
                  members={props.roomSnapshot.room.members}
                  now={membershipNow}
                  onRemoveMember={props.onRemoveMember}
                  onUpdateMemberPermissions={props.onUpdateMemberPermissions}
                />
              </div>
            )
          ) : (
            <RoomPanelSkeleton />
          )}
        </div>
      </div>
    </div>
  );
}

function RequestWorkspaceTabs<T extends string>({
  activeTab,
  ariaLabel,
  panelPrefix,
  onChange,
  tabs
}: {
  activeTab: T;
  ariaLabel: string;
  panelPrefix: string;
  onChange: (tab: T) => void;
  tabs: Array<{ id: T; label: string; icon?: React.ComponentType<{ className?: string }> }>;
}) {
  return (
    <div className="material-surface-header sticky top-0 z-20 shrink-0 border-b border-surface-border bg-surface/20 backdrop-blur-md">
      <div
        aria-label={ariaLabel}
        className="flex w-full items-center"
        role="tablist"
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          const IconComp = tab.icon;
          return (
            <button
              key={tab.id}
              id={`${panelPrefix}-tab-${tab.id}`}
              aria-controls={`${panelPrefix}-panel-${tab.id}`}
              aria-selected={isActive}
              className={`relative flex-1 flex h-10 items-center justify-center gap-1.5 px-2.5 text-xs transition-colors cursor-pointer select-none ${
                isActive
                  ? "text-foreground font-semibold"
                  : "text-foreground-muted hover:text-foreground hover:bg-surface-hover/30"
              }`}
              onClick={() => onChange(tab.id)}
              role="tab"
              tabIndex={isActive ? 0 : -1}
              type="button"
            >
              {IconComp && <IconComp className={`w-3.5 h-3.5 shrink-0 transition-colors ${isActive ? "text-accent" : "text-foreground-muted"}`} />}
              <span className="truncate">{tab.label}</span>
              {isActive ? (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent-glow)]" />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RequestInbox({
  pendingRequestId,
  pendingRequests,
  handledRequests,
  onDecide,
  onApproveAll
}: {
  pendingRequestId: string | null;
  pendingRequests: RoomRequest[];
  handledRequests: RoomRequest[];
  onDecide: (request: RoomRequest, decision: "approved" | "rejected", options?: { playNext?: boolean }) => Promise<void>;
  onApproveAll?: () => Promise<void>;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-surface-border/60 bg-surface/50 backdrop-blur-xl shadow-xs" data-testid="request-room-inbox">
      <div className="flex items-center justify-between px-3 py-2 sm:px-3.5">
        <div className="flex items-center gap-1.5">
          <h2 className="font-bold text-foreground text-xs sm:text-sm">待审核点歌</h2>
          {pendingRequests.length > 0 ? (
            <span className="rounded-full bg-amber-400/15 border border-amber-400/30 px-2 py-0.2 text-xs font-bold text-amber-400">
              {pendingRequests.length}
            </span>
          ) : null}
        </div>
        {pendingRequests.length > 1 && onApproveAll ? (
          <Button
            disabled={pendingRequestId !== null}
            onClick={() => void onApproveAll()}
            size="sm"
            type="button"
            className="h-7 rounded-lg text-xs bg-accent hover:bg-accent-hover text-white shadow-xs transition-all active:scale-95 px-2.5"
          >
            全部接纳入队
          </Button>
        ) : null}
      </div>
      {pendingRequests.length ? (
        <div className="divide-y divide-surface-border/40">
          {pendingRequests.map((request) => (
            <RequestTicket
              key={request.id}
              request={request}
              pending={pendingRequestId === request.id || pendingRequestId === "batch:all"}
              onDecide={onDecide}
            />
          ))}
        </div>
      ) : (
        <div className="px-3 py-4 text-center text-xs text-foreground-muted">还没有等待审核的点歌。</div>
      )}
      {handledRequests.length ? (
        <div className="border-t border-surface-border/40 px-3 py-2 sm:px-3.5">
          <p className="text-xs font-medium text-foreground-muted">最近处理记录</p>
          <div className="mt-1.5 divide-y divide-surface-border/30">
            {handledRequests.slice(0, 4).map((request) => (
              <RequestHistoryRow key={request.id} request={request} />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function RequestTicket({
  request,
  pending,
  onDecide
}: {
  request: RoomRequest;
  pending: boolean;
  onDecide: (request: RoomRequest, decision: "approved" | "rejected", options?: { playNext?: boolean }) => Promise<void>;
}) {
  return (
    <article className="flex min-w-0 items-center gap-2.5 px-3 py-2 sm:px-3.5 transition-colors hover:bg-surface-hover/60">
      <Artwork artworkUrl={request.artworkUrl} title={request.title} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs sm:text-sm font-semibold text-foreground" title={request.title}>{request.title}</p>
        <p className="mt-0.5 truncate text-xs text-foreground-muted" title={`${request.artist}${request.album ? ` / ${request.album}` : ""}`}>
          {request.artist}{request.album ? ` / ${request.album}` : ""}
        </p>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-foreground-muted/70">
          <span className="font-medium text-accent">@{request.requesterName}</span>
          <span className="font-mono">{formatDuration(request.durationMs)}</span>
          <span className="capitalize">{request.provider === "netease" ? "网易云" : request.provider === "qqmusic" ? "QQ 音乐" : "Bilibili"}</span>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <Button
          disabled={pending}
          onClick={() => void onDecide(request, "approved")}
          size="sm"
          type="button"
          className="h-7 rounded-lg px-2.5 text-xs font-semibold bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 border border-emerald-500/30"
        >
          {pending ? "处理中…" : "接纳入队"}
        </Button>
        <Button
          disabled={pending}
          onClick={() => void onDecide(request, "approved", { playNext: true })}
          size="sm"
          type="button"
          variant="outline"
          className="h-7 rounded-lg px-2 text-xs hidden sm:inline-flex border border-surface-border hover:bg-surface-hover text-foreground"
          title="优先插播为下一首"
        >
          插播
        </Button>
        <Button
          disabled={pending}
          onClick={() => void onDecide(request, "rejected")}
          size="sm"
          type="button"
          variant="ghost"
          className="h-7 rounded-lg px-2 text-xs text-foreground-muted hover:text-rose-400 hover:bg-rose-500/10"
        >
          婉拒
        </Button>
      </div>
    </article>
  );
}

function RequestHistory({
  queue = [],
  requests,
  title,
  tracks = []
}: {
  queue?: RoomDashboardViewProps["roomSnapshot"]["queue"];
  requests: RoomRequest[];
  title: string;
  tracks?: TrackMeta[];
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-surface-border/60 bg-surface/50 backdrop-blur-xl shadow-xs">
      <div className="flex items-center justify-between px-3 py-2 sm:px-3.5">
        <h2 className="font-bold text-foreground text-xs sm:text-sm">{title}</h2>
        <span className="text-xs font-mono text-foreground-muted">{requests.length} 次点歌记录</span>
      </div>
      {requests.length ? (
        <div className="divide-y divide-surface-border/40">
          {requests.slice().reverse().map((request) => {
            let queuePosition: number | null = null;
            if (request.status === "approved" && queue.length > 0) {
              const matchingTrack = tracks.find(
                (t) => t.sourceRef?.provider === request.provider && t.sourceRef.trackId === request.providerTrackId
              );
              if (matchingTrack) {
                const index = queue.findIndex((q) => q.trackId === matchingTrack.id);
                if (index >= 0) queuePosition = index + 1;
              }
            }
            return <RequestHistoryRow key={request.id} request={request} queuePosition={queuePosition} />;
          })}
        </div>
      ) : (
        <div className="px-3 py-4 text-center text-xs text-foreground-muted">还没有提交过点歌。</div>
      )}
    </section>
  );
}

function RequestHistoryRow({
  request,
  queuePosition = null
}: {
  request: RoomRequest;
  queuePosition?: number | null;
}) {
  const statusLabel = request.status === "approved"
    ? queuePosition !== null ? `排在第 ${queuePosition} 位` : "已加入队列"
    : request.status === "rejected"
      ? "未被接纳"
      : "等待审核";

  const statusClass = request.status === "approved"
    ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-400"
    : request.status === "rejected"
      ? "bg-rose-500/15 border-rose-500/30 text-rose-400"
      : "bg-amber-500/15 border-amber-500/30 text-amber-400";

  return (
    <div className="flex min-w-0 items-center justify-between gap-2.5 px-3 py-2 sm:px-3.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs sm:text-sm font-semibold text-foreground">{request.title}</p>
        <p className="truncate text-xs text-foreground-muted">{request.artist}</p>
      </div>
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium border ${statusClass}`}>
        {statusLabel}
      </span>
    </div>
  );
}

function Artwork({ artworkUrl, title }: { artworkUrl: string | null; title: string }) {
  if (!artworkUrl) {
    return <span aria-label={title} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface border border-surface-border/60 text-xs text-foreground-muted"><MusicIcon className="w-4 h-4 text-accent" /></span>;
  }
  return <img loading="lazy" alt={title} className="h-9 w-9 shrink-0 rounded-lg object-cover border border-surface-border/60 shadow-xs" src={getArtworkSourceUrl(artworkUrl)} />;
}

async function importRequestedTrack(
  request: RoomRequest,
  props: RoomDashboardViewProps,
  snapshotRef: MutableRefObject<RoomDashboardViewProps["roomSnapshot"]>
): Promise<TrackMeta> {
  const existingTrack = snapshotRef.current.tracks.find(
    (item) => item.sourceRef?.provider === request.provider && item.sourceRef.trackId === request.providerTrackId
  );
  if (existingTrack) return existingTrack;

  if (request.provider === "netease") {
    await props.onImportNeteaseTrack({
      provider: "netease",
      providerTrackId: request.providerTrackId,
      access: "unknown",
      quality: null,
      title: request.title,
      artist: request.artist,
      album: request.album,
      durationMs: request.durationMs,
      artworkUrl: request.artworkUrl
    });
  } else if (request.provider === "qqmusic") {
    await props.onImportQqMusicTrack({
      provider: "qqmusic",
      providerTrackId: request.providerTrackId,
      access: "unknown",
      quality: null,
      title: request.title,
      artist: request.artist,
      album: request.album,
      durationMs: request.durationMs,
      artworkUrl: request.artworkUrl
    });
  } else if (request.provider === "bilibili") {
    await props.onImportBilibiliTrack?.({
      provider: "bilibili",
      providerTrackId: request.providerTrackId,
      access: "free",
      quality: null,
      title: request.title,
      artist: request.artist,
      album: request.album,
      durationMs: request.durationMs,
      artworkUrl: request.artworkUrl
    });
  }

  snapshotRef.current = await soqaroApi.getRoom(props.roomSnapshot.room.id);
  const importedTrack = snapshotRef.current.tracks.find(
    (item) => item.sourceRef?.provider === request.provider && item.sourceRef.trackId === request.providerTrackId
  );
  if (!importedTrack) throw new Error("歌曲导入成功但在房间曲库中未就绪。");
  return importedTrack;
}
