"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import type { RoomDirectoryItem } from "@soqaro/shared";
import { useSessionIdentity } from "@/features/session/use-session-identity";
import { buildAppEntryHref, buildWorkspaceAuthHref } from "@/lib/domain/client-shell";
import { soqaroApi } from "@/lib/network/soqaro-api";
import { toUserFacingError } from "@/lib/domain/soqaro-ui";
import {
  buildRoomJoinBootstrapSnapshot,
  storeRoomSnapshotHandoff
} from "@/lib/domain/room-snapshot-handoff";
import { AppSidebar } from "@/components/shell";
import { roomAudioOutput } from "@/features/playback/room-audio-output";
import { useWorkspacePageActive } from "@/features/workspace/page-activity";
import { AwayRoomReturnButton } from "./AwayRoomReturnButton";
import { useAnnouncementCenter } from "./AnnouncementBanner";
import { CreateRoomDialogModal } from "./CreateRoomDialogModal";
import { JoinCodeDialogModal } from "./JoinCodeDialogModal";
import { RoomLobbyToolbar } from "./RoomLobbyToolbar";
import { RoomDirectoryGrid } from "./RoomDirectoryGrid";
import { RoomThresholdSheet } from "./RoomThresholdSheet";
import {
  ROOM_CHANNEL_THEMES,
  ROOM_FILTER_ORDER,
  countRoomsByFilter,
  sortCuratedRooms,
  type RoomFilterValue
} from "./room-gallery-layout";
import {
  prewarmRoomRuntimeChunk,
  runRoomViewTransition
} from "./room-view-transition";
import type { CreateRoomForm } from "./room-home-types";
import {
  readAwayRoomId,
  requestAwayRoomResume
} from "@/lib/domain/away-room";

const lastRoomStorageKey = "soqaro-last-room";
const emptyRooms: RoomDirectoryItem[] = [];

type RoomsHomePageProps = {
  awayRoomId?: string | null;
  hasBottomPlayer?: boolean;
  onResumeAwayRoom?: () => void;
  showSidebar?: boolean;
};

export function RoomsHomePage({
  awayRoomId,
  hasBottomPlayer = false,
  onResumeAwayRoom,
  showSidebar = true
}: RoomsHomePageProps = {}) {
  const router = useRouter();
  const workspaceEntryHref = buildAppEntryHref();
  const buildRoomHref = useCallback((roomId: string) => `/room/${roomId}`, []);
  const authEntryHref = buildWorkspaceAuthHref({
    redirectTo: workspaceEntryHref
  });
  const {
    activeSession,
    hydrated,
    statusMessage,
    setStatusMessage
  } = useSessionIdentity({
    sessionStorageKey: "soqaro-session",
    initialStatusMessage: ""
  });
  const pageActive = useWorkspacePageActive();
  const queryClient = useQueryClient();
  const roomsQuery = useQuery({
    queryKey: ["rooms", activeSession?.userId ?? null],
    queryFn: ({ signal }) => soqaroApi.listRooms(signal),
    enabled: hydrated && pageActive,
    staleTime: 10_000,
    refetchInterval: pageActive ? 10_000 : false
  });
  const availableRooms = roomsQuery.data ?? emptyRooms;
  const roomsLoaded = !roomsQuery.isPending;
  const refreshAvailableRooms = roomsQuery.refetch;

  const [roomTypeFilter, setRoomTypeFilter] = useState<RoomFilterValue>("all");
  const [morphingRoomId, setMorphingRoomId] = useState<string | null>(null);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [joinDialogOpen, setJoinDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createFormVisibility, setCreateFormVisibility] = useState<"public" | "private">("public");
  const [selectedRoom, setSelectedRoom] = useState<RoomDirectoryItem | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [storedAwayRoomId, setStoredAwayRoomId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const joinInFlightRef = useRef(false);
  const prefetchedRoomIdsRef = useRef(new Set<string>());
  const effectiveAwayRoomId = awayRoomId ?? storedAwayRoomId;

  const announcementCenter = useAnnouncementCenter();

  useEffect(() => {
    if (awayRoomId !== undefined) {
      setStoredAwayRoomId(awayRoomId);
      return;
    }

    setStoredAwayRoomId(readAwayRoomId());
  }, [awayRoomId]);

  const handlePrewarmRoom = useCallback(
    (roomId: string) => {
      prewarmRoomRuntimeChunk();
      if (prefetchedRoomIdsRef.current.has(roomId)) return;
      prefetchedRoomIdsRef.current.add(roomId);
      router.prefetch(buildRoomHref(roomId) as Route);
    },
    [buildRoomHref, router]
  );

  const handleResumeAwayRoom = useCallback(() => {
    if (!effectiveAwayRoomId) return;
    prewarmRoomRuntimeChunk();
    if (onResumeAwayRoom) {
      runRoomViewTransition("room-enter", () => {
        onResumeAwayRoom();
      });
      return;
    }

    requestAwayRoomResume(effectiveAwayRoomId);
    runRoomViewTransition("room-enter", () => {
      router.push(buildRoomHref(effectiveAwayRoomId) as Route);
    });
  }, [buildRoomHref, effectiveAwayRoomId, onResumeAwayRoom, router]);

  useEffect(() => {
    if (roomsQuery.error) setStatusMessage(toUserFacingError(roomsQuery.error));
  }, [roomsQuery.error, setStatusMessage]);

  useEffect(() => {
    if (!pageActive) {
      void queryClient.cancelQueries({
        queryKey: ["rooms", activeSession?.userId ?? null],
        type: "inactive"
      });
    }
  }, [pageActive, activeSession?.userId, queryClient]);

  // Keep open threshold room data synced when background directory query refreshes
  useEffect(() => {
    if (!selectedRoom) return;
    const updated = availableRooms.find((item) => item.room.id === selectedRoom.room.id);
    if (updated && updated !== selectedRoom) {
      setSelectedRoom(updated);
    }
  }, [availableRooms, selectedRoom]);

  function openCreateRoom(visibility: "public" | "private") {
    if (!activeSession) {
      setStatusMessage("创建房间需要先登录账号。");
      router.push(authEntryHref as Route);
      return;
    }
    prewarmRoomRuntimeChunk();
    setCreateFormVisibility(visibility);
    setDialogError(null);
    setCreateDialogOpen(true);
  }

  function openJoinDialog() {
    if (!activeSession) {
      setStatusMessage("加入房间需要先登录账号。");
      router.push(authEntryHref as Route);
      return;
    }
    prewarmRoomRuntimeChunk();
    setDialogError(null);
    setJoinDialogOpen(true);
  }

  async function handleCreateRoom(form: CreateRoomForm) {
    primeRoomAudioFromUserGesture();
    prewarmRoomRuntimeChunk();
    try {
      const snapshot = await soqaroApi.createRoom({
        visibility: form.visibility,
        name: form.name.trim() || undefined,
        description: form.description.trim() || undefined,
        password: form.password.trim() || undefined,
        roomType: form.roomType,
        ...(form.roomType === "interactive"
          ? { newMemberPermissions: form.newMemberPermissions }
          : {})
      });
      storeRoomSnapshotHandoff(snapshot);
      window.localStorage.setItem(lastRoomStorageKey, snapshot.room.id);
      runRoomViewTransition("room-enter", () => {
        setCreateDialogOpen(false);
        router.push(buildRoomHref(snapshot.room.id) as Route);
      });
    } catch (error) {
      setDialogError(toUserFacingError(error));
    }
  }

  async function handleJoinRoom(code: string, password?: string) {
    if (!code.trim()) {
      setStatusMessage("请输入房间码。");
      return;
    }
    // Enter-key submits do not go through the disabled submit button, so a
    // double keypress would otherwise fire two concurrent join requests.
    if (joinInFlightRef.current) return;
    joinInFlightRef.current = true;

    primeRoomAudioFromUserGesture();
    prewarmRoomRuntimeChunk();
    try {
      const joined = await soqaroApi.joinRoomByCode(code.trim(), password);
      storeRoomSnapshotHandoff(buildRoomJoinBootstrapSnapshot(joined));
      window.localStorage.setItem(lastRoomStorageKey, joined.roomId);
      runRoomViewTransition("room-enter", () => {
        setSelectedRoom(null);
        setJoinDialogOpen(false);
        router.push(buildRoomHref(joined.roomId) as Route);
      });
    } catch (error) {
      if (selectedRoom) {
        setDialogError(toUserFacingError(error));
      } else {
        setStatusMessage(toUserFacingError(error));
      }
    } finally {
      joinInFlightRef.current = false;
    }
  }

  const openRoomDetails = useCallback(
    (room: RoomDirectoryItem) => {
      if (room.room.id === effectiveAwayRoomId) {
        handleResumeAwayRoom();
        return;
      }
      if (!activeSession) {
        setStatusMessage("进入房间需要先登录账号。");
        router.push(authEntryHref as Route);
        return;
      }

      handlePrewarmRoom(room.room.id);
      const targetRoomId = room.room.id;
      let targetCardEl: HTMLElement | null = null;
      runRoomViewTransition(
        "card-open",
        () => {
          if (targetCardEl) targetCardEl.style.viewTransitionName = "";
          setSelectedRoom(room);
          setDialogError(null);
        },
        {
          beforeCapture: () => {
            const slotEl = document.querySelector<HTMLElement>(
              `[data-mosaic-slot-id="${CSS.escape(targetRoomId)}"]`
            );
            targetCardEl = slotEl?.querySelector<HTMLElement>('[data-testid="room-directory-card"]') ?? null;
            if (targetCardEl) targetCardEl.style.viewTransitionName = "active-room-shell";
          }
        }
      );
    },
    [activeSession, authEntryHref, effectiveAwayRoomId, handlePrewarmRoom, handleResumeAwayRoom, router, setStatusMessage]
  );

  const closeRoomDetails = useCallback(() => {
    if (!selectedRoom) return;
    const closingId = selectedRoom.room.id;
    runRoomViewTransition(
      "card-close",
      () => {
        setMorphingRoomId(closingId);
        setSelectedRoom(null);
        setDialogError(null);
      },
      {
        onFinished: () => {
          setMorphingRoomId(null);
        }
      }
    );
  }, [selectedRoom]);

  const handleFilterChange = useCallback(
    (nextFilter: RoomFilterValue) => {
      if (nextFilter === roomTypeFilter) return;
      const prevIndex = ROOM_FILTER_ORDER.indexOf(roomTypeFilter);
      const nextIndex = ROOM_FILTER_ORDER.indexOf(nextFilter);
      const direction = nextIndex >= prevIndex ? "forward" : "backward";
      runRoomViewTransition(
        "gallery",
        () => {
          setRoomTypeFilter(nextFilter);
        },
        { direction }
      );
    },
    [roomTypeFilter]
  );

  const rawFilterCounts = useMemo(
    () => countRoomsByFilter(availableRooms),
    [availableRooms]
  );
  const filterCountsRef = useRef(rawFilterCounts);
  const filterCounts = useMemo(() => {
    const prev = filterCountsRef.current;
    if (
      prev.all === rawFilterCounts.all &&
      prev.interactive === rawFilterCounts.interactive &&
      prev.request === rawFilterCounts.request &&
      prev.radio === rawFilterCounts.radio
    ) {
      return prev;
    }
    filterCountsRef.current = rawFilterCounts;
    return rawFilterCounts;
  }, [rawFilterCounts]);

  const handleManualRefresh = useCallback(() => {
    setIsManualRefreshing(true);
    startTransition(async () => {
      try {
        await refreshAvailableRooms();
      } finally {
        setIsManualRefreshing(false);
      }
    });
  }, [refreshAvailableRooms]);

  const filteredRooms = useMemo(
    () =>
      availableRooms.filter(
        (room) => roomTypeFilter === "all" || room.room.roomType === roomTypeFilter
      ),
    [availableRooms, roomTypeFilter]
  );

  const sortedRooms = useMemo(
    () => sortCuratedRooms(filteredRooms, effectiveAwayRoomId),
    [filteredRooms, effectiveAwayRoomId]
  );

  const activeChannelTheme = ROOM_CHANNEL_THEMES[roomTypeFilter];

  if (!hydrated) {
    return <div className="min-h-[calc(100*var(--app-dvh))] bg-background" />;
  }

  return (
    <main className="workspace-page home-workspace-page hide-scrollbar relative flex flex-col overflow-y-auto selection:bg-accent/30 selection:text-white pb-[calc(var(--room-mobile-bottom-inset)+2rem)] md:pb-[calc(12rem+env(safe-area-inset-bottom))] md:pl-[var(--app-sidebar-width)]">
      {showSidebar ? (
        <AppSidebar
          activeItem="home"
          hasBottomPlayer={hasBottomPlayer}
        />
      ) : null}

      {effectiveAwayRoomId && showSidebar ? (
        <AwayRoomReturnButton onClick={handleResumeAwayRoom} />
      ) : null}

      <section className="workspace-page__inner home-centered-workspace relative flex w-full shrink-0 flex-col gap-3.5 pt-[calc(0.75rem+env(safe-area-inset-top))] md:gap-4">
        {announcementCenter.marqueeNode}

        <RoomLobbyToolbar
          activeFilter={roomTypeFilter}
          announcementBell={announcementCenter.bellTriggerNode}
          counts={filterCounts}
          isRefreshing={isPending || isManualRefreshing}
          onCreatePublicRoom={() => openCreateRoom("public")}
          onFilterChange={handleFilterChange}
          onOpenJoinDialog={openJoinDialog}
          onRefresh={handleManualRefresh}
          roomsLoaded={roomsLoaded}
        />

        {statusMessage && !selectedRoom && !joinDialogOpen && !createDialogOpen ? (
          <div
            className="rounded-xl border-hairline border-surface-border bg-surface px-3.5 py-2 text-xs text-foreground-muted"
            role="status"
          >
            {statusMessage}
          </div>
        ) : null}

        {/* Framed Bento Mosaic Canvas Tray (Zero-Gap Flush Shared Borders) */}
        <div
          className="room-mosaic-canvas-tray relative min-h-[240px] overflow-hidden rounded-xl border-hairline border-[var(--slate-6)] bg-[var(--slate-2)] p-0"
          data-channel={roomTypeFilter}
          data-testid="room-mosaic-canvas-tray"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 z-30 h-[1px] transition-colors duration-[250ms] ease-out"
            style={{ background: activeChannelTheme.topLine }}
          />
          <RoomDirectoryGrid
            awayRoomId={effectiveAwayRoomId}
            morphingRoomId={morphingRoomId}
            onOpenRoom={openRoomDetails}
            onPrewarmRoom={handlePrewarmRoom}
            rooms={sortedRooms}
            roomsLoaded={roomsLoaded}
          />
        </div>
      </section>

      {announcementCenter.modalNode}

      {createDialogOpen ? (
        <CreateRoomDialogModal
          defaultRoomName={activeSession?.nickname ? `${activeSession.nickname}的音乐房间` : "音乐房间"}
          dialogError={dialogError}
          initialVisibility={createFormVisibility}
          isPending={isPending}
          onClose={() => setCreateDialogOpen(false)}
          onSubmit={(form) => {
            startTransition(() => void handleCreateRoom(form));
          }}
        />
      ) : null}

      {joinDialogOpen ? (
        <JoinCodeDialogModal
          isPending={isPending}
          onClose={() => setJoinDialogOpen(false)}
          onSubmit={(code) => {
            const room = availableRooms.find(
              (item) => item.room.joinCode.toUpperCase() === code.trim().toUpperCase()
            );
            if (room) {
              setJoinDialogOpen(false);
              openRoomDetails(room);
              return;
            }
            if (isPending || joinInFlightRef.current) return;
            startTransition(() => void handleJoinRoom(code));
          }}
          statusMessage={statusMessage}
        />
      ) : null}

      {selectedRoom ? (
        <RoomThresholdSheet
          dialogError={dialogError}
          isPending={isPending}
          onClose={closeRoomDetails}
          onConfirm={(password) => {
            setDialogError(null);
            startTransition(async () => {
              try {
                await handleJoinRoom(selectedRoom.room.joinCode, password || undefined);
              } catch (error) {
                setDialogError(toUserFacingError(error));
              }
            });
          }}
          room={selectedRoom}
        />
      ) : null}
    </main>
  );
}

function primeRoomAudioFromUserGesture() {
  // Start the shared context while the join/create click still carries a
  // transient user activation. The room route may receive a playing snapshot
  // immediately after navigation, before the listener has another gesture.
  void roomAudioOutput.primeOutputs({ localAudio: null });
}
