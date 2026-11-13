"use client";
/* eslint-disable @next/next/no-img-element */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import {
  Compass,
  Disc3,
  Lock,
  Radio,
  RefreshCw,
  Shuffle,
  SlidersHorizontal,
  Users
} from "lucide-react";
import type { RoomDirectoryItem, RoomType } from "@soqaro/shared";
import { getArtworkSourceUrl } from "@/components/bottom-player/artwork-colors";
import { RoomThresholdSheet } from "@/components/room-home/RoomThresholdSheet";
import { Button } from "@/components/ui/button";
import { SearchBar } from "@/components/ui/search-bar";
import { useFavoriteArtists } from "@/features/favorites/use-favorite-artists";
import { useFavoriteTracks } from "@/features/favorites/use-favorite-tracks";
import {
  getLocalStoredProfile,
  mergeProfileWithServer
} from "@/features/personalization/local-personalization-store";
import { roomAudioOutput } from "@/features/playback/room-audio-output";
import { useSessionIdentity } from "@/features/session/use-session-identity";
import { useWorkspacePageActive } from "@/features/workspace/page-activity";
import {
  awayRoomChangeEvent,
  readAwayRoomId,
  requestAwayRoomResume
} from "@/lib/domain/away-room";
import { buildWorkspaceAuthHref } from "@/lib/domain/client-shell";
import {
  prepareRoomJoinHandoff
} from "@/lib/domain/room-snapshot-handoff";
import { toUserFacingError } from "@/lib/domain/soqaro-ui";
import { soqaroApi } from "@/lib/network/soqaro-api";
import { useBackHandler } from "@/lib/desktop/use-back-handler";
import {
  awaitRoomRuntimePrewarm,
  prewarmRoomRuntimeChunk,
  runRoomViewTransition
} from "@/lib/ui/room-view-transition";
import { TasteColdStartDialog } from "./TasteColdStartDialog";
import {
  ROOM_VIBE_CATEGORIES,
  curateRecommendedRooms,
  filterCuratedRooms,
  pickRandomOpenRoom,
  type CuratedRoomRecommendation,
  type RoomVibeFilterId
} from "./room-recommendation";

const lastRoomStorageKey = "soqaro-last-room";
const emptyRooms: RoomDirectoryItem[] = [];

const ROOM_TYPE_FILTERS: ReadonlyArray<{ id: "all" | RoomType; label: string }> = [
  { id: "all", label: "全部模式" },
  { id: "interactive", label: "多人互动" },
  { id: "request", label: "点歌房" },
  { id: "radio", label: "自由电台" }
];

export function DiscoverPage() {
  const router = useRouter();
  const pageActive = useWorkspacePageActive();
  const queryClient = useQueryClient();
  const authEntryHref = buildWorkspaceAuthHref({ redirectTo: "/app/discover" });
  const {
    activeSession,
    hydrated,
    statusMessage,
    setStatusMessage
  } = useSessionIdentity({
    sessionStorageKey: "soqaro-session",
    initialStatusMessage: ""
  });

  const userId = activeSession?.userId ?? null;

  const roomsQuery = useQuery({
    queryKey: ["rooms", userId],
    queryFn: ({ signal }) => soqaroApi.listRooms(signal),
    enabled: hydrated && pageActive,
    staleTime: 10_000,
    refetchInterval: pageActive ? 10_000 : false
  });

  const profileQuery = useQuery({
    queryKey: ["personalization", "profile", userId],
    queryFn: async ({ signal }) => {
      const localProfile = getLocalStoredProfile(userId);
      if (!userId) return localProfile;
      try {
        const serverProfile = await soqaroApi.getPersonalizationProfile(signal);
        return mergeProfileWithServer(localProfile, serverProfile, userId);
      } catch {
        return localProfile;
      }
    },
    enabled: hydrated && pageActive,
    staleTime: 30_000
  });

  const roomActivityQuery = useQuery({
    queryKey: ["room-activity", userId],
    queryFn: () => soqaroApi.getRoomActivity(),
    enabled: hydrated && pageActive && Boolean(userId),
    staleTime: 30_000
  });

  const { artists: favoriteArtists } = useFavoriteArtists(userId);
  const { favoriteTracks } = useFavoriteTracks(userId);

  const [awayRoomId, setAwayRoomId] = useState<string | null>(null);
  const [vibeFilter, setVibeFilter] = useState<RoomVibeFilterId>("all");
  const [roomTypeFilter, setRoomTypeFilter] = useState<"all" | RoomType>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRoom, setSelectedRoom] = useState<RoomDirectoryItem | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [showColdStartDialog, setShowColdStartDialog] = useState(false);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [isPending, startTransition] = useTransition();
  const joinInFlightRef = useRef(false);
  const prefetchedRoomIdsRef = useRef(new Set<string>());

  useBackHandler(
    () => {
      setSearchQuery("");
      setVibeFilter("all");
      setRoomTypeFilter("all");
    },
    Boolean(searchQuery.trim() || vibeFilter !== "all" || roomTypeFilter !== "all")
  );

  useEffect(() => {
    const syncAwayRoom = () => setAwayRoomId(readAwayRoomId());
    syncAwayRoom();
    window.addEventListener(awayRoomChangeEvent, syncAwayRoom);
    window.addEventListener("storage", syncAwayRoom);
    return () => {
      window.removeEventListener(awayRoomChangeEvent, syncAwayRoom);
      window.removeEventListener("storage", syncAwayRoom);
    };
  }, []);

  useEffect(() => {
    if (!pageActive) {
      void queryClient.cancelQueries({
        queryKey: ["rooms", userId],
        type: "inactive"
      });
    }
  }, [pageActive, queryClient, userId]);

  const availableRooms = roomsQuery.data ?? emptyRooms;
  const roomsLoaded = !roomsQuery.isPending;

  useEffect(() => {
    if (!selectedRoom) return;
    const updated = availableRooms.find((item) => item.room.id === selectedRoom.room.id);
    if (updated && updated !== selectedRoom) {
      setSelectedRoom(updated);
    }
  }, [availableRooms, selectedRoom]);

  const handlePrewarmRoom = useCallback(
    (roomId: string) => {
      prewarmRoomRuntimeChunk();
      if (prefetchedRoomIdsRef.current.has(roomId)) return;
      prefetchedRoomIdsRef.current.add(roomId);
      router.prefetch(`/room/${roomId}` as Route);
    },
    [router]
  );

  const handleResumeAwayRoom = useCallback(async () => {
    if (!awayRoomId) return;
    handlePrewarmRoom(awayRoomId);
    await awaitRoomRuntimePrewarm();
    requestAwayRoomResume(awayRoomId);
    runRoomViewTransition(
      "room-enter",
      () => {
        router.push(`/room/${awayRoomId}` as Route);
      },
      { roomId: awayRoomId }
    );
  }, [awayRoomId, handlePrewarmRoom, router]);

  const openRoomDetails = useCallback(
    (room: RoomDirectoryItem) => {
      if (room.room.id === awayRoomId) {
        handleResumeAwayRoom();
        return;
      }
      if (!activeSession) {
        setStatusMessage("进入房间需要先登录账号。");
        router.push(authEntryHref as Route);
        return;
      }

      handlePrewarmRoom(room.room.id);
      runRoomViewTransition(
        "card-open",
        () => {
          setSelectedRoom(room);
          setDialogError(null);
        },
        { roomId: room.room.id }
      );
    },
    [activeSession, authEntryHref, awayRoomId, handlePrewarmRoom, handleResumeAwayRoom, router, setStatusMessage]
  );

  const closeRoomDetails = useCallback(() => {
    if (!selectedRoom) return;
    const closingId = selectedRoom.room.id;
    runRoomViewTransition(
      "card-close",
      () => {
        setSelectedRoom(null);
        setDialogError(null);
      },
      { roomId: closingId }
    );
  }, [selectedRoom]);

  async function handleJoinRoom(code: string, password?: string) {
    if (!code.trim() || joinInFlightRef.current) return;
    joinInFlightRef.current = true;

    void roomAudioOutput.primeOutputs({ localAudio: null });
    prewarmRoomRuntimeChunk();
    try {
      const joined = await soqaroApi.joinRoomByCode(code.trim(), password);
      await prepareRoomJoinHandoff(joined, {
        lastRoomStorageKey,
        prefetchRoom: () => handlePrewarmRoom(joined.roomId)
      });
      runRoomViewTransition(
        "room-enter",
        () => {
          setSelectedRoom(null);
          router.push(`/room/${joined.roomId}` as Route);
        },
        { roomId: joined.roomId }
      );
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

  const handleManualRefresh = useCallback(() => {
    setIsManualRefreshing(true);
    startTransition(async () => {
      try {
        await Promise.all([
          roomsQuery.refetch(),
          profileQuery.refetch(),
          userId ? roomActivityQuery.refetch() : Promise.resolve()
        ]);
      } finally {
        setIsManualRefreshing(false);
      }
    });
  }, [profileQuery, roomActivityQuery, roomsQuery, userId]);

  const favoriteArtistNames = useMemo(
    () => favoriteArtists.map((artist) => artist.name),
    [favoriteArtists]
  );
  const favoriteTrackTitles = useMemo(
    () => favoriteTracks.map((track) => track.title),
    [favoriteTracks]
  );

  const curatedRooms = useMemo(
    () =>
      curateRecommendedRooms(availableRooms, {
        awayRoomId,
        profile: profileQuery.data ?? null,
        favoriteArtistNames,
        favoriteTrackTitles,
        roomActivity: roomActivityQuery.data ?? []
      }),
    [
      availableRooms,
      awayRoomId,
      favoriteArtistNames,
      favoriteTrackTitles,
      profileQuery.data,
      roomActivityQuery.data
    ]
  );

  const filteredRooms = useMemo(
    () =>
      filterCuratedRooms(curatedRooms, {
        vibeFilter,
        roomTypeFilter,
        searchQuery
      }),
    [curatedRooms, roomTypeFilter, searchQuery, vibeFilter]
  );

  const handleRandomRoom = useCallback(() => {
    const picked = pickRandomOpenRoom(curatedRooms, awayRoomId);
    if (!picked) {
      setStatusMessage("当前没有可直接进入的公开免密房间。");
      return;
    }
    openRoomDetails(picked);
  }, [awayRoomId, curatedRooms, openRoomDetails, setStatusMessage]);

  const isFilteredView =
    vibeFilter !== "all" ||
    roomTypeFilter !== "all" ||
    searchQuery.trim().length > 0;

  // Sections for the default curated view
  const liveSpotlightRooms = useMemo(
    () =>
      curatedRooms
        .filter((entry) => entry.isLive || Boolean(entry.item.room.directoryNowPlaying?.title))
        .slice(0, 2),
    [curatedRooms]
  );

  const spotlightIds = useMemo(
    () => new Set(liveSpotlightRooms.map((entry) => entry.item.room.id)),
    [liveSpotlightRooms]
  );

  const tasteMatchedRooms = useMemo(
    () =>
      curatedRooms.filter(
        (entry) =>
          entry.isTasteMatched && !spotlightIds.has(entry.item.room.id)
      ),
    [curatedRooms, spotlightIds]
  );

  const frequentRooms = useMemo(
    () =>
      curatedRooms.filter(
        (entry) => entry.isFrequent && !spotlightIds.has(entry.item.room.id)
      ),
    [curatedRooms, spotlightIds]
  );

  const remainingRecommendedRooms = useMemo(() => {
    const excludedIds = new Set([
      ...spotlightIds,
      ...tasteMatchedRooms.map((entry) => entry.item.room.id)
    ]);
    const rest = curatedRooms.filter((entry) => !excludedIds.has(entry.item.room.id));
    return rest.length > 0 ? rest : curatedRooms;
  }, [curatedRooms, spotlightIds, tasteMatchedRooms]);

  const hasOpenRoom = useMemo(
    () => curatedRooms.some((entry) => !entry.item.room.hasPassword),
    [curatedRooms]
  );

  if (!hydrated) {
    return <div className="min-h-[calc(100*var(--app-dvh))] bg-background" />;
  }

  return (
    <main className="workspace-page hide-scrollbar relative overflow-y-auto selection:bg-accent/30 selection:text-white pb-[calc(var(--room-mobile-bottom-inset)+2.5rem)] md:pl-[var(--app-sidebar-width)] md:pb-24">
      <div aria-hidden="true" className="workspace-page-background" />

      <div className="workspace-page__inner workspace-page__inner--wide relative z-10 flex flex-col gap-4 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:pt-6 md:pt-8">
        {/* Top Toolbar: Room Search + Auxiliary Actions */}
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="w-full sm:max-w-md md:max-w-lg">
            <SearchBar
              id="discover-room-search"
              value={searchQuery}
              onChange={setSearchQuery}
              onSubmit={setSearchQuery}
              onClear={() => setSearchQuery("")}
              placeholder="搜索房间、正在播放的歌曲、艺人或房主"
              showSearchButton={false}
            />
          </div>

          <div className="flex items-center gap-1.5 self-start sm:self-auto">
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border-hairline border-[var(--slate-6)] bg-[var(--slate-2)] px-2.5 text-xs font-medium text-[var(--slate-11)] transition-colors duration-[250ms] ease-out hover:border-[var(--slate-7)] hover:bg-[var(--slate-3)] hover:text-[var(--slate-12)] disabled:pointer-events-none disabled:opacity-45 cursor-pointer"
              disabled={!roomsLoaded || !hasOpenRoom}
              onClick={handleRandomRoom}
              title="随机切入一个活跃的公开免密房间"
              type="button"
            >
              <Shuffle className="h-3.5 w-3.5 text-[var(--slate-10)]" />
              <span>随机进房</span>
            </button>

            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border-hairline border-[var(--slate-6)] bg-[var(--slate-2)] px-2.5 text-xs font-medium text-[var(--slate-11)] transition-colors duration-[250ms] ease-out hover:border-[var(--slate-7)] hover:bg-[var(--slate-3)] hover:text-[var(--slate-12)] cursor-pointer"
              onClick={() => setShowColdStartDialog(true)}
              title="设置听歌偏好以优化房间推荐"
              type="button"
            >
              <SlidersHorizontal className="h-3.5 w-3.5 text-[var(--slate-10)]" />
              <span>口味偏好</span>
            </button>

            <button
              aria-label="刷新房间推荐"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border-hairline border-[var(--slate-6)] bg-[var(--slate-2)] text-[var(--slate-11)] transition-colors duration-[250ms] ease-out hover:border-[var(--slate-7)] hover:bg-[var(--slate-3)] hover:text-[var(--slate-12)] disabled:pointer-events-none disabled:opacity-45 cursor-pointer"
              disabled={isPending || isManualRefreshing}
              onClick={handleManualRefresh}
              title="刷新推荐"
              type="button"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${
                  isPending || isManualRefreshing ? "animate-spin" : ""
                }`}
              />
            </button>
          </div>
        </header>

        {/* Vibe & Mode Filter Bar */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div
            aria-label="音乐流派与氛围筛选"
            className="flex items-center gap-1.5 overflow-x-auto pb-0.5 hide-scrollbar touch-pan-x"
            role="tablist"
          >
            {ROOM_VIBE_CATEGORIES.map((category) => {
              const active = vibeFilter === category.id;
              return (
                <button
                  aria-selected={active}
                  className={`inline-flex h-7 items-center rounded-lg px-2.5 text-xs font-medium whitespace-nowrap transition-colors duration-[250ms] ease-out cursor-pointer select-none ${
                    active
                      ? "border-hairline border-[var(--blue-7)] bg-[var(--blue-3)] text-[var(--blue-11)] font-semibold"
                      : "border-hairline border-[var(--slate-6)] bg-[var(--slate-2)] text-[var(--slate-11)] hover:border-[var(--slate-7)] hover:bg-[var(--slate-3)] hover:text-[var(--slate-12)]"
                  }`}
                  key={category.id}
                  onClick={() => setVibeFilter(category.id)}
                  role="tab"
                  type="button"
                >
                  {category.label}
                </button>
              );
            })}
          </div>

          <div
            aria-label="房间模式筛选"
            className="flex items-center gap-0.5 self-start rounded-lg border-hairline border-[var(--slate-6)] bg-[var(--slate-2)] p-0.5 shrink-0"
            role="tablist"
          >
            {ROOM_TYPE_FILTERS.map((mode) => {
              const active = roomTypeFilter === mode.id;
              return (
                <button
                  aria-selected={active}
                  className={`inline-flex h-6 items-center rounded-md px-2 text-xs font-medium whitespace-nowrap transition-colors duration-[250ms] ease-out cursor-pointer ${
                    active
                      ? "border-hairline border-[var(--slate-7)] bg-[var(--slate-4)] text-[var(--slate-12)] font-semibold"
                      : "border-hairline border-transparent text-[var(--slate-11)] hover:text-[var(--slate-12)]"
                  }`}
                  key={mode.id}
                  onClick={() => setRoomTypeFilter(mode.id)}
                  role="tab"
                  type="button"
                >
                  {mode.label}
                </button>
              );
            })}
          </div>
        </div>

        {statusMessage ? (
          <div
            className="rounded-lg border-hairline border-[var(--slate-6)] bg-[var(--slate-2)] px-3 py-2 text-xs text-[var(--slate-11)]"
            role="status"
          >
            {statusMessage}
          </div>
        ) : null}

        {/* Loading Skeleton */}
        {!roomsLoaded ? (
          <div
            aria-label="正在加载房间推荐"
            className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3"
          >
            {Array.from({ length: 6 }, (_, index) => (
              <div
                className="h-36 animate-pulse rounded-xl border-hairline border-[var(--slate-6)] bg-[var(--slate-2)] p-3"
                key={index}
              />
            ))}
          </div>
        ) : availableRooms.length === 0 ? (
          <div
            className="mt-4 flex min-h-56 flex-col items-center justify-center rounded-xl border-hairline border-[var(--slate-6)] bg-[var(--slate-2)] px-6 py-10 text-center"
            data-discover-empty="true"
          >
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border-hairline border-[var(--slate-6)] bg-[var(--slate-3)] text-[var(--slate-10)]">
              <Compass className="h-5 w-5" />
            </div>
            <h2 className="text-base font-semibold text-[var(--slate-12)]">
              当前暂无活跃房间
            </h2>
            <p className="mt-1 text-xs text-[var(--slate-11)]">
              前往房间大厅创建第一个多人同步听歌房间
            </p>
            <Button
              className="mt-4 h-8 rounded-lg bg-[var(--blue-9)] px-4 text-xs font-medium text-white hover:bg-[var(--blue-10)]"
              onClick={() => router.push("/app" as Route)}
              size="sm"
              type="button"
            >
              前往房间大厅
            </Button>
          </div>
        ) : isFilteredView ? (
          /* Filtered or Searched Room Results */
          <section className="flex flex-col gap-3" data-discover-ready="true">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold tracking-tight text-[var(--slate-12)]">
                筛选结果
              </h2>
              <div className="flex items-center gap-2.5 text-xs text-[var(--slate-11)]">
                <span className="font-mono tabular-nums">{filteredRooms.length} 个房间</span>
                <button
                  className="text-[var(--blue-11)] hover:underline cursor-pointer"
                  onClick={() => {
                    setVibeFilter("all");
                    setRoomTypeFilter("all");
                    setSearchQuery("");
                  }}
                  type="button"
                >
                  重置筛选
                </button>
              </div>
            </div>

            {filteredRooms.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {filteredRooms.map((entry) => (
                  <RecommendedRoomCard
                    entry={entry}
                    isExpandedToModal={selectedRoom?.room.id === entry.item.room.id}
                    key={entry.item.room.id}
                    onOpen={openRoomDetails}
                    onPrewarm={handlePrewarmRoom}
                  />
                ))}
              </div>
            ) : (
              <div
                className="flex min-h-48 flex-col items-center justify-center rounded-xl border-hairline border-[var(--slate-6)] bg-[var(--slate-2)] px-6 py-8 text-center"
                data-discover-empty="true"
              >
                <p className="text-sm font-medium text-[var(--slate-12)]">
                  没有找到匹配的房间
                </p>
                <p className="mt-1 text-xs text-[var(--slate-11)]">
                  可尝试切换其他风格标签或清除搜索词
                </p>
                <button
                  className="mt-3 inline-flex h-8 items-center rounded-lg border-hairline border-[var(--slate-6)] bg-[var(--slate-3)] px-3 text-xs font-medium text-[var(--slate-12)] transition-colors duration-[250ms] ease-out hover:bg-[var(--slate-4)] cursor-pointer"
                  onClick={() => {
                    setVibeFilter("all");
                    setRoomTypeFilter("all");
                    setSearchQuery("");
                  }}
                  type="button"
                >
                  查看全部推荐房间
                </button>
              </div>
            )}
          </section>
        ) : (
          /* Default Curated Multi-Section Room Discovery */
          <div className="flex flex-col gap-6" data-discover-ready="true">
            {/* Section 1: Live Spotlight Rooms */}
            {liveSpotlightRooms.length > 0 ? (
              <section className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold tracking-tight text-[var(--slate-12)]">
                    正在热播
                  </h2>
                  <span className="text-xs text-[var(--slate-11)]">
                    实时同步播放中
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {liveSpotlightRooms.map((entry) => (
                    <LiveSpotlightRoomCard
                      entry={entry}
                      isExpandedToModal={selectedRoom?.room.id === entry.item.room.id}
                      key={entry.item.room.id}
                      onOpen={openRoomDetails}
                      onPrewarm={handlePrewarmRoom}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {/* Section 2: Taste-Matched Rooms */}
            {tasteMatchedRooms.length > 0 ? (
              <section className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold tracking-tight text-[var(--slate-12)]">
                    口味契合
                  </h2>
                  <button
                    className="text-xs text-[var(--slate-11)] transition-colors duration-[250ms] ease-out hover:text-[var(--slate-12)] cursor-pointer"
                    onClick={() => setShowColdStartDialog(true)}
                    type="button"
                  >
                    调整偏好
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {tasteMatchedRooms.slice(0, 6).map((entry) => (
                    <RecommendedRoomCard
                      entry={entry}
                      isExpandedToModal={selectedRoom?.room.id === entry.item.room.id}
                      key={entry.item.room.id}
                      onOpen={openRoomDetails}
                      onPrewarm={handlePrewarmRoom}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {/* Section 3: Frequent / Joined Rooms */}
            {frequentRooms.length > 0 ? (
              <section className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold tracking-tight text-[var(--slate-12)]">
                    常去房间
                  </h2>
                  <span className="font-mono text-xs tabular-nums text-[var(--slate-11)]">
                    {frequentRooms.length} 个房间
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {frequentRooms.slice(0, 3).map((entry) => (
                    <RecommendedRoomCard
                      entry={entry}
                      isExpandedToModal={selectedRoom?.room.id === entry.item.room.id}
                      key={entry.item.room.id}
                      onOpen={openRoomDetails}
                      onPrewarm={handlePrewarmRoom}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {/* Section 4: All Recommended Rooms */}
            <section className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold tracking-tight text-[var(--slate-12)]">
                  为你推荐
                </h2>
                <span className="font-mono text-xs tabular-nums text-[var(--slate-11)]">
                  共 {curatedRooms.length} 个房间
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {remainingRecommendedRooms.map((entry) => (
                  <RecommendedRoomCard
                    entry={entry}
                    isExpandedToModal={selectedRoom?.room.id === entry.item.room.id}
                    key={entry.item.room.id}
                    onOpen={openRoomDetails}
                    onPrewarm={handlePrewarmRoom}
                  />
                ))}
              </div>
            </section>
          </div>
        )}
      </div>

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

      <TasteColdStartDialog
        isOpen={showColdStartDialog}
        onClose={() => setShowColdStartDialog(false)}
        onCompleted={() => {
          void profileQuery.refetch();
        }}
      />
    </main>
  );
}

const LiveSpotlightRoomCard = memo(function LiveSpotlightRoomCard({
  entry,
  isExpandedToModal = false,
  onOpen,
  onPrewarm
}: {
  entry: CuratedRoomRecommendation;
  isExpandedToModal?: boolean;
  onOpen: (room: RoomDirectoryItem) => void;
  onPrewarm: (roomId: string) => void;
}) {
  const { room } = entry.item;
  const nowPlaying = room.directoryNowPlaying;
  const artworkSrc = nowPlaying?.artworkUrl
    ? getArtworkSourceUrl(nowPlaying.artworkUrl)
    : null;
  const hiddenCardClass = isExpandedToModal ? "invisible pointer-events-none select-none" : "";

  return (
    <article
      className="group relative flex min-w-0 items-center gap-3.5 rounded-xl border-hairline border-[var(--slate-6)] bg-[var(--slate-2)] p-3 transition-colors duration-[250ms] ease-out hover:border-[var(--slate-8)] hover:bg-[var(--slate-3)]"
      data-discover-room-id={room.id}
      data-morphed-to-modal={isExpandedToModal ? "true" : undefined}
      onPointerEnter={() => onPrewarm(room.id)}
    >
      <button
        aria-hidden={isExpandedToModal || undefined}
        aria-label={`查看 ${room.name} 的房间详情`}
        className={`absolute inset-0 z-10 cursor-pointer rounded-[inherit] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--blue-8)] ${
          isExpandedToModal ? "invisible pointer-events-none" : ""
        }`}
        disabled={isExpandedToModal}
        onClick={() => onOpen(entry.item)}
        onFocus={() => onPrewarm(room.id)}
        tabIndex={isExpandedToModal ? -1 : undefined}
        type="button"
      />

      {/* Album Cover / Stage Artwork */}
      <div
        aria-hidden={isExpandedToModal || undefined}
        className={`relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border-hairline border-[var(--slate-6)] bg-[var(--slate-3)] ${hiddenCardClass}`}
      >
        {artworkSrc ? (
          <img
            alt={nowPlaying?.title ?? room.name}
            className="h-full w-full object-cover"
            decoding="async"
            loading="lazy"
            src={artworkSrc}
          />
        ) : (
          <RoomModeFallbackIcon roomType={room.roomType} />
        )}
      </div>

      {/* Room & Track Info */}
      <div
        aria-hidden={isExpandedToModal || undefined}
        className={`flex min-w-0 flex-1 flex-col justify-center gap-2 ${hiddenCardClass}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <h3 className="truncate text-sm font-semibold tracking-tight text-[var(--slate-12)]">
              {room.name}
            </h3>
            {room.hasPassword ? (
              <Lock
                aria-label="需要密码"
                className="h-3 w-3 shrink-0 text-[var(--slate-10)]"
              />
            ) : null}
          </div>

          <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums text-[var(--slate-11)]">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                room.directoryOnlineMemberCount > 0
                  ? "bg-[var(--green-9)]"
                  : "bg-[var(--slate-8)]"
              }`}
            />
            {room.directoryOnlineMemberCount} 人在线
          </span>
        </div>

        {/* Now Playing Strip */}
        {nowPlaying?.title ? (
          <div className="flex min-w-0 items-center gap-2 rounded-lg border-hairline border-[var(--slate-6)] bg-[var(--slate-3)] px-2.5 py-1.5">
            <LiveEqualizerBars active={entry.isLive} />
            <span className="truncate text-xs font-medium text-[var(--slate-12)]">
              {nowPlaying.title}
            </span>
            {nowPlaying.artist ? (
              <span className="max-w-[45%] shrink-0 truncate text-xs text-[var(--slate-11)]">
                / {nowPlaying.artist}
              </span>
            ) : null}
          </div>
        ) : (
          <p className="truncate text-xs text-[var(--slate-11)]">
            {room.description?.trim() || "多人实时同步听歌空间"}
          </p>
        )}
      </div>
    </article>
  );
});

const RecommendedRoomCard = memo(function RecommendedRoomCard({
  entry,
  isExpandedToModal = false,
  onOpen,
  onPrewarm
}: {
  entry: CuratedRoomRecommendation;
  isExpandedToModal?: boolean;
  onOpen: (room: RoomDirectoryItem) => void;
  onPrewarm: (roomId: string) => void;
}) {
  const { room } = entry.item;
  const nowPlaying = room.directoryNowPlaying;
  const artworkSrc = nowPlaying?.artworkUrl
    ? getArtworkSourceUrl(nowPlaying.artworkUrl)
    : null;
  const hiddenCardClass = isExpandedToModal ? "invisible pointer-events-none select-none" : "";

  return (
    <article
      className="group relative flex min-w-0 flex-col justify-between rounded-xl border-hairline border-[var(--slate-6)] bg-[var(--slate-2)] p-3 transition-colors duration-[250ms] ease-out hover:border-[var(--slate-8)] hover:bg-[var(--slate-3)]"
      data-discover-room-id={room.id}
      data-morphed-to-modal={isExpandedToModal ? "true" : undefined}
      onPointerEnter={() => onPrewarm(room.id)}
    >
      <button
        aria-hidden={isExpandedToModal || undefined}
        aria-label={`查看 ${room.name} 的房间详情`}
        className={`absolute inset-0 z-10 cursor-pointer rounded-[inherit] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--blue-8)] ${
          isExpandedToModal ? "invisible pointer-events-none" : ""
        }`}
        disabled={isExpandedToModal}
        onClick={() => onOpen(entry.item)}
        onFocus={() => onPrewarm(room.id)}
        tabIndex={isExpandedToModal ? -1 : undefined}
        type="button"
      />

      <div aria-hidden={isExpandedToModal || undefined} className={hiddenCardClass}>
        {/* Card Header: Title + Online Count */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <h3 className="truncate text-sm font-semibold tracking-tight text-[var(--slate-12)]">
              {room.name}
            </h3>
            {room.hasPassword ? (
              <Lock
                aria-label="需要密码"
                className="h-3 w-3 shrink-0 text-[var(--slate-10)]"
              />
            ) : null}
          </div>

          <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums text-[var(--slate-11)]">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                room.directoryOnlineMemberCount > 0
                  ? "bg-[var(--green-9)]"
                  : "bg-[var(--slate-8)]"
              }`}
            />
            {room.directoryOnlineMemberCount} 人
          </span>
        </div>

        {room.description?.trim() ? (
          <p className="mt-1 truncate text-xs text-[var(--slate-11)]">
            {room.description.trim()}
          </p>
        ) : null}

        {/* Concentric Inner Now Playing / Queue Box */}
        <div className="mt-2.5 flex min-w-0 items-center gap-2.5 rounded-lg border-hairline border-[var(--slate-6)] bg-[var(--slate-3)] px-2.5 py-2">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border-hairline border-[var(--slate-6)] bg-[var(--slate-2)]">
            {artworkSrc ? (
              <img
                alt={nowPlaying?.title ?? room.name}
                className="h-full w-full object-cover"
                decoding="async"
                loading="lazy"
                src={artworkSrc}
              />
            ) : (
              <RoomModeFallbackIcon roomType={room.roomType} small />
            )}
          </div>

          {nowPlaying?.title ? (
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <LiveEqualizerBars active={entry.isLive} />
                <span className="truncate text-xs font-medium text-[var(--slate-12)]">
                  {nowPlaying.title}
                </span>
              </div>
              <span className="mt-0.5 block truncate text-xs text-[var(--slate-11)]">
                {nowPlaying.artist || "未知艺人"}
              </span>
            </div>
          ) : (
            <div className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-[var(--slate-11)]">
                {room.roomType === "radio" && room.directoryBroadcastState === "on_air"
                  ? "电台正在播出"
                  : "当前暂无播放曲目"}
              </span>
              <span className="mt-0.5 block truncate text-xs text-[var(--slate-10)]">
                {room.directoryQueueDepth > 0
                  ? `待播队列 ${room.directoryQueueDepth} 首`
                  : "进入房间后可点歌或排曲"}
              </span>
            </div>
          )}
        </div>
      </div>
    </article>
  );
});

function LiveEqualizerBars({ active }: { active: boolean }) {
  if (!active) {
    return (
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--slate-8)]"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-3 shrink-0 items-end gap-[1.5px] text-[var(--blue-9)]"
    >
      <span
        className="h-full w-[2px] origin-bottom rounded-full bg-current animate-music-bar will-change-transform"
        style={{ animationDuration: "0.8s" }}
      />
      <span
        className="h-full w-[2px] origin-bottom rounded-full bg-current animate-music-bar will-change-transform"
        style={{ animationDuration: "1.1s", animationDelay: "0.2s" }}
      />
      <span
        className="h-full w-[2px] origin-bottom rounded-full bg-current animate-music-bar will-change-transform"
        style={{ animationDuration: "0.9s", animationDelay: "0.4s" }}
      />
    </span>
  );
}

function RoomModeFallbackIcon({
  roomType,
  small = false
}: {
  roomType: RoomType;
  small?: boolean;
}) {
  if (roomType === "radio") {
    return (
      <Radio
        className={small ? "h-4 w-4 text-[var(--slate-10)]" : "h-6 w-6 text-[var(--slate-10)]"}
      />
    );
  }
  if (roomType === "request") {
    return (
      <Disc3
        className={small ? "h-4 w-4 text-[var(--slate-10)]" : "h-6 w-6 text-[var(--slate-10)]"}
      />
    );
  }
  return (
    <Users
      className={small ? "h-4 w-4 text-[var(--slate-10)]" : "h-6 w-6 text-[var(--slate-10)]"}
    />
  );
}
