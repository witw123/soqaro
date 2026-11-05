"use client";

import { useRef, type CSSProperties, type KeyboardEvent } from "react";
import { LayoutGrid } from "lucide-react";
import type { RoomDirectoryItem } from "@soqaro/shared";
import { RoomDirectoryCard } from "@/components/room-card";
import {
  toSafeViewTransitionToken
} from "./room-gallery-layout";
import { isRoomMotionReduced } from "./room-view-transition";

type RoomDirectoryGridProps = {
  rooms: RoomDirectoryItem[];
  roomsLoaded: boolean;
  awayRoomId: string | null;
  morphingStageRoomId: string | null;
  suppressCardSlotTransition?: boolean;
  onOpenRoom: (room: RoomDirectoryItem) => void;
  onPrewarmRoom: (roomId: string) => void;
};

export function RoomDirectoryGrid({
  rooms,
  roomsLoaded,
  awayRoomId,
  morphingStageRoomId,
  suppressCardSlotTransition = false,
  onOpenRoom,
  onPrewarmRoom
}: RoomDirectoryGridProps) {
  const gridRootRef = useRef<HTMLDivElement>(null);

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

  if (!rooms.length) {
    if (!roomsLoaded) {
      return (
        <div className="grid w-full grid-cols-1 gap-3.5 pt-1 sm:grid-cols-2 lg:grid-cols-3 xl:gap-4">
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
      className="grid w-full grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:gap-4"
      data-testid="room-directory-grid"
      onKeyDown={handleGridKeyDown}
      ref={gridRootRef}
    >
      {rooms.map((item, index) => {
        const roomId = item.room.id;
        const isAway = Boolean(awayRoomId && awayRoomId === roomId);

        return (
          <div
            className={`room-gallery-slot-enter min-w-0 rounded-xl ${
              isAway ? "ring-1 ring-[var(--amber-7)]" : ""
            }`}
            key={roomId}
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
  );
}
