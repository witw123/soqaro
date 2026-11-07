"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from "react";
import Link from "next/link";
import { Plus, RotateCw, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { roomTypeLabel } from "./room-home-types";
import {
  ROOM_FILTER_ORDER,
  type RoomFilterValue
} from "./room-gallery-layout";

type RoomLobbyToolbarProps = {
  activeFilter: RoomFilterValue;
  counts: Record<RoomFilterValue, number>;
  roomsLoaded: boolean;
  isRefreshing: boolean;
  announcementBell?: ReactNode;
  onFilterChange: (next: RoomFilterValue) => void;
  onCreatePublicRoom: () => void;
  onOpenJoinDialog: () => void;
  onRefresh: () => void;
};

export function RoomLobbyToolbar({
  activeFilter,
  counts,
  roomsLoaded,
  isRefreshing,
  announcementBell,
  onFilterChange,
  onCreatePublicRoom,
  onOpenJoinDialog,
  onRefresh
}: RoomLobbyToolbarProps) {
  return (
    <>
      {/* Mobile Header & Sliding Filter Bar */}
      <div className="flex flex-col gap-3 md:hidden">
        <header className="flex items-center justify-between gap-3">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">房间大厅</h1>
          <div className="flex items-center gap-1.5">
            <button
              className="inline-flex h-8 items-center gap-1 rounded-lg bg-accent px-2.5 text-xs font-medium text-white transition-colors duration-[250ms] ease-out hover:bg-accent-hover active:scale-95 cursor-pointer"
              onClick={onCreatePublicRoom}
              type="button"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>创建</span>
            </button>
            <button
              className="inline-flex h-8 items-center gap-1 rounded-lg border-hairline border-surface-border bg-surface px-2.5 text-xs font-medium text-foreground-muted transition-colors duration-[250ms] ease-out hover:bg-surface-hover hover:text-foreground active:scale-95 cursor-pointer"
              onClick={onOpenJoinDialog}
              type="button"
            >
              <span>房间码</span>
            </button>
            <button
              aria-label="刷新房间列表"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border-hairline border-surface-border bg-surface text-foreground-muted transition-colors duration-[250ms] ease-out hover:bg-surface-hover hover:text-foreground active:scale-95 cursor-pointer"
              onClick={onRefresh}
              title="刷新房间列表"
              type="button"
            >
              <RotateCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
            </button>
            {announcementBell}
            <Link
              aria-label="打开个人中心"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border-hairline border-surface-border bg-surface text-foreground-muted transition-colors duration-[250ms] ease-out hover:bg-surface-hover hover:text-foreground active:scale-95"
              href="/app/profile"
            >
              <User className="h-3.5 w-3.5" />
            </Link>
          </div>
        </header>

        <SlidingRoomFilterTabs
          activeFilter={activeFilter}
          counts={counts}
          fullWidth
          onFilterChange={onFilterChange}
          roomsLoaded={roomsLoaded}
        />
      </div>

      {/* Desktop Optically Aligned Top Navigation Deck */}
      <div className="hidden items-center justify-between gap-4 md:flex">
        <SlidingRoomFilterTabs
          activeFilter={activeFilter}
          counts={counts}
          onFilterChange={onFilterChange}
          roomsLoaded={roomsLoaded}
        />

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            data-testid="create-public-room"
            size="sm"
            className="h-8 rounded-lg px-3.5 text-xs font-medium bg-accent hover:bg-accent-hover text-white transition-colors duration-[250ms] ease-out"
            onClick={onCreatePublicRoom}
            type="button"
          >
            创建房间
          </Button>
          <Button
            data-testid="open-join-room-dialog"
            variant="outline"
            size="sm"
            className="h-8 rounded-lg px-3 border-hairline border-surface-border bg-surface hover:bg-surface-hover text-foreground text-xs font-medium transition-colors duration-[250ms] ease-out"
            onClick={onOpenJoinDialog}
            type="button"
          >
            输入房间码加入
          </Button>
          <Button
            aria-label="刷新房间列表"
            variant="ghost"
            size="sm"
            className="h-8 rounded-lg px-2.5 text-foreground-muted hover:text-foreground hover:bg-surface text-xs inline-flex items-center gap-1.5 transition-colors duration-[250ms] ease-out"
            onClick={onRefresh}
            type="button"
          >
            <RotateCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
            <span>刷新</span>
          </Button>
          {announcementBell}
        </div>
      </div>
    </>
  );
}

function SlidingRoomFilterTabs({
  activeFilter,
  counts,
  roomsLoaded,
  fullWidth = false,
  onFilterChange
}: {
  activeFilter: RoomFilterValue;
  counts: Record<RoomFilterValue, number>;
  roomsLoaded: boolean;
  fullWidth?: boolean;
  onFilterChange: (next: RoomFilterValue) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Record<RoomFilterValue, HTMLButtonElement | null>>({
    all: null,
    interactive: null,
    request: null,
    radio: null
  });
  const [indicator, setIndicator] = useState<{ x: number; width: number; ready: boolean }>({
    x: 0,
    width: 0,
    ready: false
  });

  useLayoutEffect(() => {
    const syncIndicator = () => {
      const target = buttonRefs.current[activeFilter];
      if (!target || target.offsetWidth === 0) return;
      setIndicator({
        x: target.offsetLeft,
        width: target.offsetWidth,
        ready: true
      });
    };

    syncIndicator();
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncIndicator);
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeFilter, counts, roomsLoaded]);

  useEffect(() => {
    const target = buttonRefs.current[activeFilter];
    if (!target || target.offsetWidth === 0) return;
    setIndicator({
      x: target.offsetLeft,
      width: target.offsetWidth,
      ready: true
    });
  }, [activeFilter]);

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: RoomFilterValue) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const currentIndex = ROOM_FILTER_ORDER.indexOf(current);
    const nextFilter =
      ROOM_FILTER_ORDER[(currentIndex + step + ROOM_FILTER_ORDER.length) % ROOM_FILTER_ORDER.length]!;
    onFilterChange(nextFilter);
    buttonRefs.current[nextFilter]?.focus();
  }

  return (
    <div
      aria-label="房间类型筛选"
      className={`relative items-center gap-1 rounded-xl bg-surface p-1 ${
        fullWidth ? "flex w-full" : "inline-flex"
      }`}
      ref={containerRef}
      role="tablist"
    >
      {indicator.ready ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1 bottom-1 left-0 rounded-lg bg-surface-elevated shadow-xs transition-[transform,width] duration-[250ms] ease-out motion-reduce:transition-none"
          style={{
            width: `${indicator.width}px`,
            transform: `translate3d(${indicator.x}px, 0, 0)`
          }}
        />
      ) : null}

      {ROOM_FILTER_ORDER.map((item) => {
        const isSelected = activeFilter === item;
        const count = counts[item];
        const isEmptyCategory = roomsLoaded && item !== "all" && count === 0;
        const label = item === "all" ? "全部" : roomTypeLabel(item);

        return (
          <button
            aria-selected={isSelected}
            className={`relative z-10 flex h-8 whitespace-nowrap items-center justify-center gap-1.5 rounded-lg text-xs transition-colors duration-[250ms] ease-out cursor-pointer ${
              fullWidth ? "flex-1 px-2" : "px-3.5"
            } ${
              isSelected
                ? !indicator.ready
                  ? "bg-surface-elevated text-foreground font-semibold shadow-xs"
                  : "text-foreground font-semibold"
                : isEmptyCategory
                  ? "text-foreground-muted/50 hover:text-foreground-muted"
                  : "text-foreground-muted hover:text-foreground"
            }`}
            key={item}
            onClick={() => {
              if (item !== activeFilter) onFilterChange(item);
            }}
            onKeyDown={(event) => handleTabKeyDown(event, item)}
            ref={(node) => {
              buttonRefs.current[item] = node;
            }}
            role="tab"
            tabIndex={isSelected ? 0 : -1}
            type="button"
          >
            <span>{label}</span>
            {roomsLoaded ? (
              <span
                aria-hidden="true"
                className={`font-mono tabular-nums transition-colors duration-[250ms] ease-out ${
                  isSelected ? "text-foreground" : "opacity-65"
                }`}
              >
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
