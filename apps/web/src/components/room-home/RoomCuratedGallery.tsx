"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent
} from "react";
import { ChevronLeft, ChevronRight, LayoutGrid } from "lucide-react";
import type { RoomDirectoryItem } from "@soqaro/shared";
import { RoomDirectoryCard } from "@/components/room-card";
import {
  isRoomActivelyPlaying,
  toSafeViewTransitionToken,
  type CuratedGalleryPlan,
  type RoomFilterValue
} from "./room-gallery-layout";
import { isRoomMotionReduced } from "./room-view-transition";

type RoomCuratedGalleryProps = {
  plan: CuratedGalleryPlan;
  filterKey: RoomFilterValue;
  roomsLoaded: boolean;
  awayRoomId: string | null;
  morphingStageRoomId: string | null;
  suppressCardSlotTransition?: boolean;
  onOpenRoom: (room: RoomDirectoryItem) => void;
  onPrewarmRoom: (roomId: string) => void;
};

export function RoomCuratedGallery({
  plan,
  filterKey,
  roomsLoaded,
  awayRoomId,
  morphingStageRoomId,
  suppressCardSlotTransition = false,
  onOpenRoom,
  onPrewarmRoom
}: RoomCuratedGalleryProps) {
  const galleryRootRef = useRef<HTMLDivElement>(null);

  function handleGalleryKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (
      event.key !== "ArrowRight" &&
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp"
    ) {
      return;
    }

    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return;
    if (activeElement.dataset.testid !== "room-directory-open") return;

    const root = galleryRootRef.current;
    if (!root) return;
    const triggers = Array.from(
      root.querySelectorAll<HTMLButtonElement>('[data-testid="room-directory-open"]')
    );
    const currentIndex = triggers.indexOf(activeElement as HTMLButtonElement);
    if (currentIndex === -1 || triggers.length <= 1) return;

    event.preventDefault();
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = (currentIndex + delta + triggers.length) % triggers.length;
    const nextTrigger = triggers[nextIndex];
    if (!nextTrigger) return;
    nextTrigger.focus({ preventScroll: true });
    nextTrigger.scrollIntoView({
      behavior: isRoomMotionReduced() ? "auto" : "smooth",
      block: "nearest",
      inline: "nearest"
    });
  }

  function buildSlotStyle(roomId: string, staggerIndex: number): CSSProperties {
    return {
      ...(suppressCardSlotTransition
        ? {}
        : { viewTransitionName: `lobby-card-${toSafeViewTransitionToken(roomId)}` }),
      animationDelay: `${Math.min(staggerIndex, 8) * 24}ms`
    };
  }

  function resolveStageTransitionName(roomId: string): string | undefined {
    return morphingStageRoomId === roomId ? "active-room-stage" : undefined;
  }

  if (!plan.orderedRooms.length) {
    if (!roomsLoaded) {
      return (
        <div className="grid w-full grid-cols-1 gap-3.5 pt-1 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="flex flex-col gap-3 rounded-xl border-hairline border-surface-border bg-surface/40 p-3 animate-pulse"
            >
              <div className="w-full aspect-[2.4/1] rounded-lg bg-surface-hover/70" />
              <div className="h-4 w-2/5 rounded bg-surface-hover/70" />
              <div className="h-3 w-4/5 rounded bg-surface-hover/50" />
            </div>
          ))}
        </div>
      );
    }

    return (
      <div className="mx-auto flex min-h-[260px] max-w-[680px] flex-col items-center justify-center rounded-[20px] border-hairline border-surface-border bg-surface/35 px-6 py-14 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border-hairline border-surface-border bg-surface text-foreground-muted">
          <LayoutGrid className="h-5 w-5" />
        </div>
        <h2 className="mb-1.5 text-sm font-semibold text-foreground">当前没有房间</h2>
        <p className="max-w-xs text-xs leading-relaxed text-foreground-muted">
          可以先创建一个房间等待成员加入，或输入房间码进入私密房间。
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex w-full flex-col gap-5 md:gap-6"
      data-gallery-mode={plan.mode}
      onKeyDown={handleGalleryKeyDown}
      ref={galleryRootRef}
    >
      <FeaturedScrollingGalleryRail
        awayRoomId={awayRoomId}
        buildSlotStyle={buildSlotStyle}
        filterKey={filterKey}
        hasLowerGrid={plan.gridRooms.length > 0}
        onOpenRoom={onOpenRoom}
        onPrewarmRoom={onPrewarmRoom}
        resolveStageTransitionName={resolveStageTransitionName}
        rooms={plan.featuredRooms}
      />

      {plan.gridRooms.length > 0 ? (
        <section aria-label="更多房间" className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="inline-flex items-center gap-1.5 text-xs">
              <h2 className="font-semibold text-foreground">更多房间</h2>
              <span className="font-mono tabular-nums text-foreground-muted">
                {plan.gridRooms.length}
              </span>
            </div>
            <div className="h-[0.5px] flex-1 bg-surface-border/60" aria-hidden="true" />
          </div>

          <div className="grid w-full grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:gap-4">
            {plan.gridRooms.map((item, index) => {
              const isAway = Boolean(awayRoomId && awayRoomId === item.room.id);
              return (
                <div
                  className={`room-gallery-slot-enter min-w-0 rounded-xl ${
                    isAway ? "ring-1 ring-[var(--amber-7)]" : ""
                  }`}
                  key={item.room.id}
                  style={buildSlotStyle(item.room.id, index + 3)}
                >
                  <RoomDirectoryCard
                    onOpen={() => onOpenRoom(item)}
                    onPrewarm={() => onPrewarmRoom(item.room.id)}
                    room={item}
                    stageTransitionName={resolveStageTransitionName(item.room.id)}
                  />
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function FeaturedScrollingGalleryRail({
  rooms,
  filterKey,
  hasLowerGrid,
  awayRoomId,
  buildSlotStyle,
  resolveStageTransitionName,
  onOpenRoom,
  onPrewarmRoom
}: {
  rooms: RoomDirectoryItem[];
  filterKey: RoomFilterValue;
  hasLowerGrid: boolean;
  awayRoomId: string | null;
  buildSlotStyle: (roomId: string, staggerIndex: number) => CSSProperties;
  resolveStageTransitionName: (roomId: string) => string | undefined;
  onOpenRoom: (room: RoomDirectoryItem) => void;
  onPrewarmRoom: (roomId: string) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const slotMapRef = useRef(new Map<string, HTMLDivElement>());
  const glideRafRef = useRef<number | null>(null);
  const glideTargetRef = useRef<number | null>(null);

  const [scrollState, setScrollState] = useState({
    canPrev: false,
    canNext: false,
    activeStop: 0,
    stopTargets: [0] as number[]
  });

  const [inFrameMap, setInFrameMap] = useState<Record<string, boolean>>({});

  const cancelGlide = useCallback(() => {
    if (glideRafRef.current !== null) {
      window.cancelAnimationFrame(glideRafRef.current);
      glideRafRef.current = null;
    }
    glideTargetRef.current = null;
    const track = trackRef.current;
    if (track) {
      track.style.scrollSnapType = "";
    }
  }, []);

  const syncScrollMetrics = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;

    const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
    const currentLeft = Math.max(0, Math.min(maxScroll, track.scrollLeft));
    const canPrev = currentLeft > 6;
    const canNext = maxScroll - currentLeft > 6;

    if (maxScroll <= 6) {
      setScrollState((prev) =>
        !prev.canPrev && !prev.canNext && prev.stopTargets.length === 1
          ? prev
          : { canPrev: false, canNext: false, activeStop: 0, stopTargets: [0] }
      );
      return;
    }

    const stride = Math.max(220, track.clientWidth * 0.8);
    const stopCount = Math.min(8, Math.max(2, Math.ceil(maxScroll / stride) + 1));
    const stopTargets = Array.from({ length: stopCount }, (_, index) =>
      Math.round((index / (stopCount - 1)) * maxScroll)
    );
    const activeStop = Math.min(
      stopCount - 1,
      Math.max(0, Math.round((currentLeft / maxScroll) * (stopCount - 1)))
    );

    setScrollState((prev) => {
      const sameStops =
        prev.stopTargets.length === stopTargets.length &&
        prev.stopTargets.every((val, idx) => val === stopTargets[idx]);
      if (
        prev.canPrev === canPrev &&
        prev.canNext === canNext &&
        prev.activeStop === activeStop &&
        sameStops
      ) {
        return prev;
      }
      return { canPrev, canNext, activeStop, stopTargets };
    });
  }, []);

  const glideToScrollLeft = useCallback(
    (rawTarget: number) => {
      const track = trackRef.current;
      if (!track) return;
      const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
      const target = Math.max(0, Math.min(maxScroll, rawTarget));

      if (isRoomMotionReduced() || Math.abs(target - track.scrollLeft) < 2) {
        cancelGlide();
        track.scrollLeft = target;
        syncScrollMetrics();
        return;
      }

      if (glideRafRef.current !== null) {
        window.cancelAnimationFrame(glideRafRef.current);
      }

      const startLeft = track.scrollLeft;
      const delta = target - startLeft;
      const durationMs = 320;
      const startTime = performance.now();
      glideTargetRef.current = target;
      // Suspend native snap while gliding so CSS snap never fights the ease-out curve
      track.style.scrollSnapType = "none";

      const tick = (now: number) => {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / durationMs);
        // Quartic ease-out: fast responsive launch, silky deceleration into place
        const eased = 1 - Math.pow(1 - progress, 4);
        track.scrollLeft = startLeft + delta * eased;
        syncScrollMetrics();

        if (progress < 1) {
          glideRafRef.current = window.requestAnimationFrame(tick);
        } else {
          glideRafRef.current = null;
          glideTargetRef.current = null;
          track.scrollLeft = target;
          track.style.scrollSnapType = "";
          syncScrollMetrics();
        }
      };

      glideRafRef.current = window.requestAnimationFrame(tick);
    },
    [cancelGlide, syncScrollMetrics]
  );

  // Reset rail scroll position cleanly when switching room filter tabs
  useEffect(() => {
    cancelGlide();
    const track = trackRef.current;
    if (track) {
      track.scrollLeft = 0;
    }
    syncScrollMetrics();
  }, [cancelGlide, filterKey, syncScrollMetrics]);

  // Observe container resize & room count updates to keep pagination stops accurate
  useEffect(() => {
    syncScrollMetrics();
    const track = trackRef.current;
    if (!track) return;

    const handleScroll = () => {
      if (glideRafRef.current === null) {
        syncScrollMetrics();
      }
    };

    track.addEventListener("scroll", handleScroll, { passive: true });
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => syncScrollMetrics());
      resizeObserver.observe(track);
    }

    return () => {
      track.removeEventListener("scroll", handleScroll);
      resizeObserver?.disconnect();
    };
  }, [rooms.length, syncScrollMetrics]);

  useEffect(() => cancelGlide, [cancelGlide]);

  // Track which cards are comfortably inside the horizontal gallery frame for subtle edge bloom
  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        setInFrameMap((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const entry of entries) {
            const roomId = (entry.target as HTMLElement).dataset.railRoomId;
            if (!roomId) continue;
            const isComfortablyInFrame = entry.intersectionRatio >= 0.55;
            if (next[roomId] !== isComfortablyInFrame) {
              next[roomId] = isComfortablyInFrame;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      {
        root: track,
        threshold: [0.2, 0.55, 0.85]
      }
    );

    for (const node of slotMapRef.current.values()) {
      observer.observe(node);
    }

    return () => observer.disconnect();
  }, [rooms]);

  const isScrollable = scrollState.canPrev || scrollState.canNext;
  const showHeader = hasLowerGrid || isScrollable;

  const hasAwayInRail = useMemo(
    () => Boolean(awayRoomId && rooms.some((item) => item.room.id === awayRoomId)),
    [awayRoomId, rooms]
  );
  const hasActiveInRail = useMemo(
    () => rooms.some((item) => isRoomActivelyPlaying(item)),
    [rooms]
  );

  function handleStepStop(direction: -1 | 1) {
    const { stopTargets, activeStop } = scrollState;
    if (stopTargets.length <= 1) return;

    // When clicking rapidly during an active glide, advance relative to the in-flight stop
    let baseStop = activeStop;
    if (glideTargetRef.current !== null) {
      const pendingIndex = stopTargets.findIndex(
        (val) => Math.abs(val - glideTargetRef.current!) <= 8
      );
      if (pendingIndex !== -1) baseStop = pendingIndex;
    }

    const nextIndex = Math.max(0, Math.min(stopTargets.length - 1, baseStop + direction));
    glideToScrollLeft(stopTargets[nextIndex] ?? 0);
  }

  const edgeMaskStyle = useMemo((): CSSProperties | undefined => {
    if (!isScrollable) return undefined;
    const maskValue =
      scrollState.canPrev && scrollState.canNext
        ? "linear-gradient(to right, transparent 0px, black 20px, black calc(100% - 26px), transparent 100%)"
        : scrollState.canNext
          ? "linear-gradient(to right, black 0px, black calc(100% - 28px), transparent 100%)"
          : "linear-gradient(to right, transparent 0px, black 22px, black 100%)";

    return {
      maskImage: maskValue,
      WebkitMaskImage: maskValue
    };
  }, [isScrollable, scrollState.canNext, scrollState.canPrev]);

  const slideWidthClass =
    rooms.length === 1
      ? "w-full max-w-[380px]"
      : rooms.length <= 3
        ? "w-[85%] sm:w-[calc((100%-0.875rem)/2)] lg:w-[calc((100%-1.75rem)/3)]"
        : "w-[85%] sm:w-[calc((100%-0.875rem)/2.15)] lg:w-[calc((100%-2.625rem)/3.2)]";

  return (
    <section aria-label="焦点房间画廊" className="flex flex-col gap-2.5">
      {showHeader ? (
        <div className="flex min-h-7 items-center justify-between gap-3">
          <div className="inline-flex items-center gap-1.5 text-xs">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                hasAwayInRail
                  ? "bg-[var(--amber-9)]"
                  : hasActiveInRail
                    ? "bg-[var(--green-9)]"
                    : "bg-[var(--slate-8)]"
              }`}
            />
            <h2 className="font-semibold text-foreground">焦点画廊</h2>
            <span className="font-mono tabular-nums text-foreground-muted">{rooms.length}</span>
          </div>

          {isScrollable ? (
            <div className="flex items-center gap-2.5">
              {scrollState.stopTargets.length > 1 ? (
                <div
                  aria-label="画廊分页进度"
                  className="hidden items-center gap-1 sm:flex"
                >
                  {scrollState.stopTargets.map((target, index) => {
                    const isActive = index === scrollState.activeStop;
                    return (
                      <button
                        aria-label={`跳转至画廊第 ${index + 1} 段`}
                        aria-pressed={isActive}
                        className={`h-1.5 rounded-full transition-[width,background-color] duration-[250ms] ease-out motion-reduce:transition-none cursor-pointer ${
                          isActive
                            ? "w-4 bg-accent"
                            : "w-1.5 bg-[var(--slate-6)] hover:bg-[var(--slate-8)]"
                        }`}
                        key={index}
                        onClick={() => glideToScrollLeft(target)}
                        type="button"
                      />
                    );
                  })}
                </div>
              ) : null}

              <div className="flex items-center gap-1">
                <button
                  aria-label="向左滑动房间画廊"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg border-hairline border-surface-border bg-surface text-foreground-muted transition-all duration-[250ms] ease-out hover:bg-surface-hover hover:text-foreground active:scale-95 disabled:pointer-events-none disabled:opacity-30 cursor-pointer"
                  disabled={!scrollState.canPrev}
                  onClick={() => handleStepStop(-1)}
                  type="button"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <button
                  aria-label="向右滑动房间画廊"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg border-hairline border-surface-border bg-surface text-foreground-muted transition-all duration-[250ms] ease-out hover:bg-surface-hover hover:text-foreground active:scale-95 disabled:pointer-events-none disabled:opacity-30 cursor-pointer"
                  disabled={!scrollState.canNext}
                  onClick={() => handleStepStop(1)}
                  type="button"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        className="hide-scrollbar flex w-full snap-x snap-mandatory items-stretch gap-3.5 overflow-x-auto overflow-y-visible py-0.5 scroll-pl-0.5"
        data-testid="room-featured-rail"
        onPointerDown={cancelGlide}
        onTouchStart={cancelGlide}
        onWheel={cancelGlide}
        ref={trackRef}
        style={edgeMaskStyle}
      >
        {rooms.map((item, index) => {
          const roomId = item.room.id;
          const isAway = Boolean(awayRoomId && awayRoomId === roomId);
          const isPeekingEdge = isScrollable && inFrameMap[roomId] === false;

          return (
            <div
              className={`room-gallery-slot-enter ${slideWidthClass} shrink-0 snap-start rounded-xl transition-[transform,opacity] duration-[250ms] ease-out motion-reduce:transition-none ${
                isPeekingEdge ? "scale-[0.985] opacity-75" : "scale-100 opacity-100"
              } ${isAway ? "ring-1 ring-[var(--amber-7)]" : ""}`}
              data-rail-room-id={roomId}
              key={roomId}
              ref={(node) => {
                if (node) {
                  slotMapRef.current.set(roomId, node);
                } else {
                  slotMapRef.current.delete(roomId);
                }
              }}
              style={buildSlotStyle(roomId, index)}
            >
              <RoomDirectoryCard
                onOpen={() => onOpenRoom(item)}
                onPrewarm={() => onPrewarmRoom(roomId)}
                room={item}
                stageTransitionName={resolveStageTransitionName(roomId)}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
