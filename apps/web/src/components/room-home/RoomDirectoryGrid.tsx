"use client";

import {
  memo,
  useMemo,
  useRef,
  type KeyboardEvent
} from "react";
import { LayoutGrid } from "lucide-react";
import type { RoomDirectoryItem } from "@soqaro/shared";
import { RoomDirectoryCard } from "@/components/room-card";
import {
  packRoomsIntoContentMosaic,
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

type RoomDirectoryGridProps = {
  rooms: RoomDirectoryItem[];
  roomsLoaded: boolean;
  awayRoomId: string | null;
  activeModalRoomId?: string | null;
  morphingRoomId?: string | null;
  onOpenRoom: (room: RoomDirectoryItem) => void;
  onPrewarmRoom: (roomId: string) => void;
};

export const RoomDirectoryGrid = memo(function RoomDirectoryGrid({
  rooms,
  roomsLoaded,
  awayRoomId,
  activeModalRoomId = null,
  morphingRoomId = null,
  onOpenRoom,
  onPrewarmRoom
}: RoomDirectoryGridProps) {
  const gridRootRef = useRef<HTMLDivElement>(null);

  const packedRooms = useMemo(
    () => packRoomsIntoContentMosaic(rooms, awayRoomId),
    [rooms, awayRoomId]
  );

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

  if (!packedRooms.length) {
    if (!roomsLoaded) {
      const skeletonSpans: Array<{ lg: MosaicTileSpan["lgSpan"]; md: MosaicTileSpan["mdSpan"] }> = [
        { lg: 5, md: 4 },
        { lg: 4, md: 4 },
        { lg: 3, md: 4 },
        { lg: 3, md: 4 },
        { lg: 5, md: 4 },
        { lg: 4, md: 4 }
      ];
      return (
        <div className="mosaic-puzzle-grid grid w-full grid-cols-1 gap-0 md:grid-cols-8 lg:grid-cols-12">
          {skeletonSpans.map((sp, index) => {
            const isLgRowEnd = index === 2 || index === 5;
            const isLgRowBottom = index >= 3;
            const isMdRowEnd = index === 1 || index === 3 || index === 5;
            const isMdRowBottom = index >= 4;
            const isMobileBottom = index === skeletonSpans.length - 1;
            return (
              <div
                key={index}
                className={`mosaic-puzzle-skeleton flex flex-col gap-2.5 p-3 animate-pulse md:col-span-4 ${LG_SPAN_CLASS[sp.lg]}`}
                data-mosaic-row-bottom-lg={isLgRowBottom ? "true" : undefined}
                data-mosaic-row-bottom-md={isMdRowBottom ? "true" : undefined}
                data-mosaic-row-bottom-sm={isMobileBottom ? "true" : undefined}
                data-mosaic-row-end-lg={isLgRowEnd ? "true" : undefined}
                data-mosaic-row-end-md={isMdRowEnd ? "true" : undefined}
              >
                <div className="room-directory-stage-frame w-full aspect-[2.4/1] md:aspect-auto md:h-[148px] xl:h-[160px] rounded-lg bg-surface-hover/70" />
                <div className="h-4 w-2/5 rounded bg-surface-hover/70" />
                <div className="h-3 w-4/5 rounded bg-surface-hover/50" />
              </div>
            );
          })}
        </div>
      );
    }

    return (
      <div
        className="mx-auto flex min-h-[260px] max-w-[680px] flex-col items-center justify-center px-6 py-14 text-center"
        data-testid="room-directory-empty"
      >
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
      {packedRooms.map(
        ({
          item,
          span,
          textScore,
          isLgRowEnd,
          isLgRowBottom,
          isMdRowEnd,
          isMdRowBottom,
          isMobileBottom
        }) => {
          const roomId = item.room.id;
          const isAway = Boolean(awayRoomId && awayRoomId === roomId);
          const isExpandedToModal = activeModalRoomId === roomId;
          const isMorphTarget = morphingRoomId === roomId;

          return (
            <div
              className={`mosaic-puzzle-tile relative min-w-0 ${MD_SPAN_CLASS[span.mdSpan]} ${LG_SPAN_CLASS[span.lgSpan]} ${
                isAway ? "z-10 ring-1 ring-inset ring-[var(--amber-7)]" : ""
              }`}
              data-mosaic-row-bottom-lg={isLgRowBottom ? "true" : undefined}
              data-mosaic-row-bottom-md={isMdRowBottom ? "true" : undefined}
              data-mosaic-row-bottom-sm={isMobileBottom ? "true" : undefined}
              data-mosaic-row-end-lg={isLgRowEnd ? "true" : undefined}
              data-mosaic-row-end-md={isMdRowEnd ? "true" : undefined}
              data-mosaic-slot-id={roomId}
              data-mosaic-span={span.lgSpan}
              data-mosaic-text-score={Math.round(textScore)}
              key={roomId}
            >
              <RoomDirectoryCard
                isExpandedToModal={isExpandedToModal}
                onOpen={onOpenRoom}
                onPrewarm={onPrewarmRoom}
                room={item}
                shellTransitionName={isMorphTarget ? "active-room-shell" : undefined}
              />
            </div>
          );
        }
      )}
    </div>
  );
});
