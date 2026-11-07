"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type KeyboardEvent
} from "react";
import { LayoutGrid } from "lucide-react";
import type { RoomDirectoryItem } from "@soqaro/shared";
import { RoomDirectoryCard } from "@/components/room-card";
import {
  packRoomsIntoContentMosaic,
  toSafeViewTransitionToken,
  type MosaicTileSpan
} from "./room-gallery-layout";
import { isRoomMotionReduced } from "./room-view-transition";

const LG_SPAN_CLASS: Record<MosaicTileSpan["lgSpan"], string> = {
  3: "lg:col-span-3",
  4: "lg:col-span-4",
  5: "lg:col-span-5",
  6: "lg:col-span-6",
  7: "lg:col-span-7"
};

const MD_SPAN_CLASS: Record<MosaicTileSpan["mdSpan"], string> = {
  3: "md:col-span-3",
  4: "md:col-span-4",
  5: "md:col-span-5",
  6: "md:col-span-6",
  8: "md:col-span-8"
};

type RelativeBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type RoomDirectoryGridProps = {
  rooms: RoomDirectoryItem[];
  roomsLoaded: boolean;
  awayRoomId: string | null;
  morphingRoomId?: string | null;
  suppressCardSlotTransition?: boolean;
  onOpenRoom: (room: RoomDirectoryItem) => void;
  onPrewarmRoom: (roomId: string) => void;
};

export function RoomDirectoryGrid({
  rooms,
  roomsLoaded,
  awayRoomId,
  morphingRoomId = null,
  suppressCardSlotTransition = false,
  onOpenRoom,
  onPrewarmRoom
}: RoomDirectoryGridProps) {
  const gridRootRef = useRef<HTMLDivElement>(null);
  const lastLayoutRectsRef = useRef<Map<string, RelativeBox>>(new Map());
  const activeFlipAnimsRef = useRef<Map<string, Animation>>(new Map());
  const lastContainerWidthRef = useRef<number>(0);

  const packedRooms = useMemo(
    () => packRoomsIntoContentMosaic(rooms, awayRoomId),
    [rooms, awayRoomId]
  );

  // Measure layout rects after each render so resize FLIP has accurate baseline coordinates
  useLayoutEffect(() => {
    const root = gridRootRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    lastContainerWidthRef.current = Math.round(rootRect.width);

    const nextMap = new Map<string, RelativeBox>();
    const slots = root.querySelectorAll<HTMLElement>("[data-mosaic-slot-id]");
    slots.forEach((slot) => {
      const id = slot.dataset.mosaicSlotId;
      if (!id) return;
      nextMap.set(id, {
        left: slot.offsetLeft,
        top: slot.offsetTop,
        width: slot.offsetWidth,
        height: slot.offsetHeight
      });
    });
    lastLayoutRectsRef.current = nextMap;
  }, [packedRooms]);

  // Live Viewport Resize FLIP Engine: smoothly glides & scales puzzle tiles when resizing
  useEffect(() => {
    const root = gridRootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;

    let rafId: number | null = null;
    const activeAnims = activeFlipAnimsRef.current;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const newWidth = Math.round(entry.contentRect.width);
      if (newWidth <= 0 || Math.abs(newWidth - lastContainerWidthRef.current) < 2) {
        return;
      }
      lastContainerWidthRef.current = newWidth;

      if (
        isRoomMotionReduced() ||
        Boolean(document.documentElement.dataset.roomTransition)
      ) {
        return;
      }

      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const currentRoot = gridRootRef.current;
        if (!currentRoot) return;
        const rootRect = currentRoot.getBoundingClientRect();
        const prevMap = lastLayoutRectsRef.current;
        const updatedMap = new Map<string, RelativeBox>();

        const slots = currentRoot.querySelectorAll<HTMLElement>("[data-mosaic-slot-id]");
        slots.forEach((slot) => {
          const id = slot.dataset.mosaicSlotId;
          if (!id) return;

          // If an animation is already in flight, capture its current visual position before canceling
          const runningAnim = activeAnims.get(id);
          let prevBox = prevMap.get(id);
          if (runningAnim) {
            const visualRect = slot.getBoundingClientRect();
            prevBox = {
              left: visualRect.left - rootRect.left,
              top: visualRect.top - rootRect.top,
              width: visualRect.width,
              height: visualRect.height
            };
            runningAnim.cancel();
            activeAnims.delete(id);
          }

          const nextBox: RelativeBox = {
            left: slot.offsetLeft,
            top: slot.offsetTop,
            width: slot.offsetWidth,
            height: slot.offsetHeight
          };
          updatedMap.set(id, nextBox);

          if (!prevBox || nextBox.width <= 0 || nextBox.height <= 0) return;

          const dx = prevBox.left - nextBox.left;
          const dy = prevBox.top - nextBox.top;
          const sx = prevBox.width / nextBox.width;
          const sy = prevBox.height / nextBox.height;

          const hasMoved = Math.abs(dx) > 1.5 || Math.abs(dy) > 1.5;
          const hasScaled = Math.abs(sx - 1) > 0.015 || Math.abs(sy - 1) > 0.015;

          if ((hasMoved || hasScaled) && typeof slot.animate === "function") {
            const anim = slot.animate(
              [
                {
                  transformOrigin: "0 0",
                  transform: `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`
                },
                {
                  transformOrigin: "0 0",
                  transform: "translate3d(0, 0, 0) scale(1, 1)"
                }
              ],
              {
                duration: 320,
                easing: "cubic-bezier(0.16, 1, 0.3, 1)"
              }
            );
            activeAnims.set(id, anim);
            anim.onfinish = () => {
              if (activeAnims.get(id) === anim) {
                activeAnims.delete(id);
              }
            };
          }
        });

        lastLayoutRectsRef.current = updatedMap;
      });
    });

    observer.observe(root);
    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      activeAnims.forEach((anim) => anim.cancel());
      activeAnims.clear();
    };
  }, []);

  function handleGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
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

    const root = gridRootRef.current;
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
    const isMorphTarget = morphingRoomId === roomId;
    return {
      ...(suppressCardSlotTransition || isMorphTarget
        ? {}
        : { viewTransitionName: `lobby-card-${toSafeViewTransitionToken(roomId)}` }),
      animationDelay: `${Math.min(staggerIndex, 9) * 20}ms`
    };
  }

  if (!packedRooms.length) {
    if (!roomsLoaded) {
      const skeletonSpans: Array<MosaicTileSpan["lgSpan"]> = [5, 4, 3, 3, 5, 4];
      return (
        <div className="mosaic-puzzle-grid grid w-full grid-cols-1 gap-0 md:grid-cols-8 lg:grid-cols-12">
          {skeletonSpans.map((span, index) => (
            <div
              key={index}
              className={`flex flex-col gap-2.5 border-r-[0.5px] border-b-[0.5px] border-surface-border bg-surface/40 p-3 animate-pulse md:col-span-4 ${LG_SPAN_CLASS[span]}`}
            >
              <div className="room-directory-stage-frame w-full aspect-[2.4/1] md:aspect-auto md:h-[148px] xl:h-[160px] rounded-lg bg-surface-hover/70" />
              <div className="h-4 w-2/5 rounded bg-surface-hover/70" />
              <div className="h-3 w-4/5 rounded bg-surface-hover/50" />
            </div>
          ))}
        </div>
      );
    }

    return (
      <div className="mx-auto flex min-h-[260px] max-w-[680px] flex-col items-center justify-center px-6 py-14 text-center">
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
      className="mosaic-puzzle-grid grid w-full grid-cols-1 gap-0 md:grid-cols-8 lg:grid-cols-12"
      data-testid="room-directory-grid"
      onKeyDown={handleGridKeyDown}
      ref={gridRootRef}
    >
      {packedRooms.map(({ item, span, textScore }, index) => {
        const roomId = item.room.id;
        const isAway = Boolean(awayRoomId && awayRoomId === roomId);
        const isMorphTarget = morphingRoomId === roomId;

        return (
          <div
            className={`room-gallery-slot-enter mosaic-puzzle-tile relative min-w-0 ${MD_SPAN_CLASS[span.mdSpan]} ${LG_SPAN_CLASS[span.lgSpan]} ${
              isAway ? "z-10 ring-1 ring-inset ring-[var(--amber-7)]" : ""
            }`}
            data-mosaic-slot-id={roomId}
            data-mosaic-span={span.lgSpan}
            data-mosaic-text-score={Math.round(textScore)}
            key={roomId}
            style={buildSlotStyle(roomId, index)}
          >
            <RoomDirectoryCard
              onOpen={() => onOpenRoom(item)}
              onPrewarm={() => onPrewarmRoom(roomId)}
              room={item}
              shellTransitionName={isMorphTarget ? "active-room-shell" : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}
