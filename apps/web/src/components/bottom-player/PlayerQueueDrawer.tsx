"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type PointerEvent as ReactPointerEvent } from "react";
import { Check, CheckSquare, GripVertical, ListMusic, Play, Trash2, X } from "lucide-react";
import type { QueueItem, RoomMember, TrackMeta } from "@soqaro/shared";
import { formatDuration } from "@/lib/domain/soqaro-ui";
import { Button } from "@/components/ui/button";
import { useBackHandler } from "@/lib/desktop/use-back-handler";
import { getArtworkSourceUrl } from "./artwork-colors";
import { TrackDistributionBadge } from "@/components/room/TrackDistributionBadge";
import { findScrollableContainer, useDragAutoScroll } from "@/features/room/hooks/use-drag-auto-scroll";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export type PlayerQueueListProps = {
  roomId?: string | null;
  queue: QueueItem[];
  tracks: TrackMeta[];
  members?: Array<Pick<RoomMember, "id" | "presenceState">> | null;
  currentSessionId?: string | null;
  currentQueueItemId: string | null;
  nextQueueItemId: string | null;
  canControlPlayback: boolean;
  canReorderQueue: boolean;
  canRemoveQueue: boolean;
  onPlayQueueItem: (queueItemId: string) => Promise<void>;
  onPlayNextQueueItem: (queueItemId: string) => Promise<void>;
  onRemoveQueueItem: (queueItemId: string) => Promise<void>;
  onRemoveQueueItems?: (queueItemIds: string[]) => Promise<void>;
  onReorderQueue: (queueItemIds: string[]) => Promise<void>;
  accentColor?: string;
  className?: string;
};

export type PlayerQueuePlacement = "default" | "immersive-desktop" | "bottom-sheet";

type PlayerQueueDrawerProps = Omit<PlayerQueueListProps, "className"> & {
  accentSoft?: string;
  compactMobile?: boolean;
  testId?: string;
  placement?: PlayerQueuePlacement;
};

type TouchReorderState = {
  itemId: string;
  pointerId: number;
  startX: number;
  startY: number;
  targetItemId: string | null;
  targetPosition: "before" | "after";
  active: boolean;
  targetElement: HTMLElement | null;
};

export function reorderWithPosition<T>(
  list: T[],
  sourceId: string,
  targetId: string,
  position: "before" | "after",
  getId: (item: T) => string
): T[] {
  if (sourceId === targetId) return list;
  const fromIndex = list.findIndex((item) => getId(item) === sourceId);
  const toIndex = list.findIndex((item) => getId(item) === targetId);
  if (fromIndex === -1 || toIndex === -1) return list;

  const result = [...list];
  const [removed] = result.splice(fromIndex, 1);
  const newTargetIndex = result.findIndex((item) => getId(item) === targetId);
  const insertIndex = position === "before" ? newTargetIndex : newTargetIndex + 1;
  result.splice(insertIndex, 0, removed);
  return result;
}

const touchReorderDelayMs = 420;
const touchReorderMoveTolerancePx = 10;

export function PlayerQueueDrawer({
  roomId,
  queue,
  tracks,
  members,
  currentSessionId,
  currentQueueItemId,
  nextQueueItemId,
  canControlPlayback,
  canReorderQueue,
  canRemoveQueue,
  onPlayQueueItem,
  onPlayNextQueueItem,
  onRemoveQueueItem,
  onRemoveQueueItems,
  onReorderQueue,
  accentColor = "rgb(0 148 255)",
  accentSoft = "rgba(0, 148, 255, 0.16)",
  compactMobile = false,
  testId = "player-queue-button",
  placement = compactMobile ? "bottom-sheet" : "default"
}: PlayerQueueDrawerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleDrawer = () => setIsOpen((current) => !current);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  useBackHandler(() => setIsOpen(false), isOpen);

  const isImmersiveDesktop = placement === "immersive-desktop";
  const isBottomSheet = placement === "bottom-sheet";

  const buttonClasses = isImmersiveDesktop
    ? `relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors hover:bg-white/10 active:bg-white/10 hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        isOpen ? "bg-white/15 text-white shadow-sm" : "text-foreground-muted"
      }`
    : compactMobile
    ? `relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-[transform,color,background-color] active:scale-95 focus-visible:outline-none ${
        isOpen ? "bg-white/15 text-white" : "text-white/80 hover:text-white"
      }`
    : `relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-foreground-muted transition-colors hover:text-[var(--hover-color)] hover:bg-[var(--hover-bg)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        isOpen ? "bg-[var(--hover-bg)] text-[var(--hover-color)]" : ""
      }`;

  const buttonStyle = isImmersiveDesktop
    ? ({
        color: accentColor,
        ...(isOpen ? { backgroundColor: accentSoft, color: "#ffffff" } : {})
      } as React.CSSProperties)
    : compactMobile
    ? undefined
    : ({
        "--hover-color": accentColor,
        "--hover-bg": accentSoft,
        color: accentColor,
        ...(isOpen ? { backgroundColor: accentSoft } : {})
      } as React.CSSProperties);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid={testId}
        className={buttonClasses}
        style={buttonStyle}
        onClick={toggleDrawer}
        aria-expanded={isOpen}
        aria-label="歌曲队列"
        title="歌曲队列"
      >
        <ListMusic size={17} aria-hidden="true" />
        {queue.length > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 px-1 items-center justify-center rounded-full text-xs font-bold text-white transition-[background-color,box-shadow] duration-500 leading-none"
            style={{ backgroundColor: accentColor, boxShadow: `0 0 8px ${accentColor}` }}
          >
            {queue.length}
          </span>
        )}
      </button>

      {isOpen ? (
        <>
          {isImmersiveDesktop ? (
            <div
              aria-hidden="true"
              className="fixed inset-0 z-[85] bg-black/35 backdrop-blur-[1px]"
              onClick={() => setIsOpen(false)}
            />
          ) : isBottomSheet ? (
            <div
              aria-hidden="true"
              className="fixed inset-0 z-[95] bg-black/60 backdrop-blur-sm"
              onClick={() => setIsOpen(false)}
            />
          ) : (
            <div
              aria-hidden="true"
              className="fixed inset-0 z-[95] bg-black/60 backdrop-blur-sm sm:hidden"
              onClick={() => setIsOpen(false)}
            />
          )}

          <aside
            aria-label="播放队列"
            data-testid="player-queue-drawer"
            className={
              isImmersiveDesktop
                ? "light-player-queue fixed bottom-10 right-6 lg:right-10 xl:right-14 z-[90] flex max-h-[min(72vh,560px)] w-[min(460px,calc(100vw-3rem))] flex-col overflow-hidden rounded-2xl border border-surface-border bg-background-secondary text-foreground shadow-2xl animate-slide-up origin-bottom-right"
                : isBottomSheet
                ? "light-player-queue fixed inset-x-0 bottom-0 top-auto z-[100] mb-0 flex w-full max-h-[calc(75*var(--app-dvh))] flex-col overflow-hidden rounded-t-2xl border-t border-surface-border bg-background-secondary text-foreground shadow-2xl animate-slide-up pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
                : "light-player-queue absolute bottom-full right-0 z-50 mb-3 flex max-h-[60vh] w-[min(500px,calc(100vw-1rem))] flex-col overflow-hidden rounded-xl border border-surface-border bg-background-secondary text-foreground shadow-2xl animate-slide-up origin-bottom-right max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:top-auto max-sm:z-[100] max-sm:mb-0 max-sm:w-full max-sm:max-h-[calc(75*var(--app-dvh))] max-sm:rounded-b-none max-sm:rounded-t-2xl max-sm:border-x-0 max-sm:border-b-0 max-sm:border-t max-sm:border-surface-border max-sm:pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
            }
          >
            {isBottomSheet || !isImmersiveDesktop ? (
              <div className="flex shrink-0 items-center justify-center pt-2 pb-1 sm:hidden">
                <div className="h-1 w-10 rounded-full bg-surface-border" />
              </div>
            ) : null}

            <div className="flex shrink-0 items-center justify-between border-b border-surface-border/70 px-3.5 py-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-foreground">播放队列</span>
                <span className="text-xs tabular-nums text-foreground-muted">({queue.length} 首)</span>
              </div>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground active:scale-95 focus-visible:outline-none"
                aria-label="关闭播放队列"
                title="关闭"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>

            <PlayerQueueList
              roomId={roomId}
              accentColor={accentColor}
              canControlPlayback={canControlPlayback}
              canRemoveQueue={canRemoveQueue}
              canReorderQueue={canReorderQueue}
              currentQueueItemId={currentQueueItemId}
              nextQueueItemId={nextQueueItemId}
              onPlayNextQueueItem={onPlayNextQueueItem}
              onPlayQueueItem={onPlayQueueItem}
              onRemoveQueueItem={onRemoveQueueItem}
              onRemoveQueueItems={onRemoveQueueItems}
              onReorderQueue={onReorderQueue}
              queue={queue}
              tracks={tracks}
              members={members}
              currentSessionId={currentSessionId}
            />
          </aside>
        </>
      ) : null}
    </div>
  );
}

export function PlayerQueueList({
  roomId,
  queue,
  tracks,
  members,
  currentSessionId,
  currentQueueItemId,
  nextQueueItemId,
  canControlPlayback,
  canReorderQueue,
  canRemoveQueue,
  onPlayQueueItem,
  onPlayNextQueueItem,
  onRemoveQueueItem,
  onRemoveQueueItems,
  onReorderQueue,
  accentColor = "rgb(0 148 255)",
  className = ""
}: PlayerQueueListProps) {
  const [draggingQueueItemId, setDraggingQueueItemId] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<{
    itemId: string;
    position: "before" | "after";
  } | null>(null);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedQueueItemIds, setSelectedQueueItemIds] = useState<Set<string>>(new Set());
  const [showBatchRemoveConfirm, setShowBatchRemoveConfirm] = useState(false);
  const [isPending, startTransition] = useTransition();
  const touchReorderRef = useRef<TouchReorderState | null>(null);
  const touchReorderTimerRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingQueueItemIdRef = useRef<string | null>(null);
  draggingQueueItemIdRef.current = draggingQueueItemId;

  const queueWithTracks = useMemo(
    () =>
      queue.map((item) => ({
        item,
        track: tracks.find((track) => track.id === item.trackId) ?? null
      })),
    [queue, tracks]
  );

  const { updateAutoScroll, stopAutoScroll } = useDragAutoScroll({
    getScrollContainer: () => findScrollableContainer(containerRef.current),
    onScrollFrame: (point) => {
      const draggingId = draggingQueueItemIdRef.current;
      if (!draggingId) return;

      const target = document
        .elementFromPoint(point.x, point.y)
        ?.closest<HTMLElement>("[data-queue-item-id]");
      if (target && target.dataset.queueItemId) {
        const targetId = target.dataset.queueItemId;
        const rect = target.getBoundingClientRect();
        const position = point.y < rect.top + rect.height / 2 ? "before" : "after";
        if (touchReorderRef.current?.active) {
          touchReorderRef.current.targetItemId = targetId;
          touchReorderRef.current.targetPosition = position;
        }
        if (targetId !== draggingId) {
          setDragOverTarget((prev) => {
            if (prev?.itemId === targetId && prev.position === position) return prev;
            return { itemId: targetId, position };
          });
        }
      } else {
        const container = findScrollableContainer(containerRef.current);
        if (container && queueWithTracks.length > 0) {
          const rect = container.getBoundingClientRect();
          if (point.y > rect.bottom - 64) {
            const lastItemId = queueWithTracks[queueWithTracks.length - 1].item.id;
            if (touchReorderRef.current?.active) {
              touchReorderRef.current.targetItemId = lastItemId;
              touchReorderRef.current.targetPosition = "after";
            }
            if (lastItemId !== draggingId) {
              setDragOverTarget({ itemId: lastItemId, position: "after" });
            }
          } else if (point.y < rect.top + 64) {
            const firstItemId = queueWithTracks[0].item.id;
            if (touchReorderRef.current?.active) {
              touchReorderRef.current.targetItemId = firstItemId;
              touchReorderRef.current.targetPosition = "before";
            }
            if (firstItemId !== draggingId) {
              setDragOverTarget({ itemId: firstItemId, position: "before" });
            }
          }
        }
      }
    }
  });

  useEffect(() => {
    return () => {
      if (touchReorderTimerRef.current !== null) {
        window.clearTimeout(touchReorderTimerRef.current);
      }
    };
  }, []);

  function cancelTouchReorderTimer() {
    stopAutoScroll();
    if (touchReorderTimerRef.current !== null) {
      window.clearTimeout(touchReorderTimerRef.current);
      touchReorderTimerRef.current = null;
    }
  }

  function reorderQueueItem(sourceItemId: string, targetItemId: string, position: "before" | "after") {
    if (sourceItemId === targetItemId || isPending) return;
    const reorderedIds = reorderWithPosition(
      queue.map((item) => item.id),
      sourceItemId,
      targetItemId,
      position,
      (id) => id
    );
    void onReorderQueue(reorderedIds);
  }

  function handleTouchReorderStart(event: ReactPointerEvent<HTMLDivElement>, itemId: string) {
    if (!canReorderQueue || (event.pointerType !== "touch" && event.pointerType !== "pen")) {
      return;
    }
    if ((event.target as HTMLElement).closest("button")) return;

    cancelTouchReorderTimer();
    const targetElement = event.currentTarget;
    touchReorderRef.current = {
      itemId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      targetItemId: itemId,
      targetPosition: "after",
      active: false,
      targetElement
    };
    touchReorderTimerRef.current = window.setTimeout(() => {
      const current = touchReorderRef.current;
      if (!current || current.pointerId !== event.pointerId) return;
      current.active = true;
      setDraggingQueueItemId(current.itemId);
      setDragOverTarget(null);
      current.targetElement?.setPointerCapture(current.pointerId);
    }, touchReorderDelayMs);
  }

  function handleTouchReorderMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = touchReorderRef.current;
    if (!current || current.pointerId !== event.pointerId) return;

    if (!current.active) {
      const movedDistance = Math.hypot(
        event.clientX - current.startX,
        event.clientY - current.startY
      );
      if (movedDistance > touchReorderMoveTolerancePx) {
        cancelTouchReorderTimer();
        touchReorderRef.current = null;
      }
      return;
    }

    event.preventDefault();
    updateAutoScroll(event.clientX, event.clientY);

    const target = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-queue-item-id]");
    const targetItemId = target?.dataset.queueItemId ?? current.itemId;
    let position: "before" | "after" = "after";
    if (target) {
      const rect = target.getBoundingClientRect();
      position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    }
    current.targetItemId = targetItemId;
    current.targetPosition = position;
    if (targetItemId !== current.itemId) {
      setDragOverTarget({ itemId: targetItemId, position });
    } else {
      setDragOverTarget(null);
    }
  }

  function finishTouchReorder(event: ReactPointerEvent<HTMLDivElement>) {
    stopAutoScroll();
    const current = touchReorderRef.current;
    if (!current || current.pointerId !== event.pointerId) return;

    cancelTouchReorderTimer();
    if (current.active && current.targetItemId && current.targetItemId !== current.itemId) {
      event.preventDefault();
      reorderQueueItem(current.itemId, current.targetItemId, current.targetPosition);
      if (current.targetElement?.hasPointerCapture(current.pointerId)) {
        current.targetElement.releasePointerCapture(current.pointerId);
      }
    }
    touchReorderRef.current = null;
    setDraggingQueueItemId(null);
    setDragOverTarget(null);
  }

  async function handleDrop(targetQueueItemId: string, position: "before" | "after") {
    stopAutoScroll();
    if (!draggingQueueItemId || !canReorderQueue) {
      setDraggingQueueItemId(null);
      setDragOverTarget(null);
      return;
    }

    const sourceItemId = draggingQueueItemId;
    setDraggingQueueItemId(null);
    setDragOverTarget(null);

    if (sourceItemId === targetQueueItemId) return;

    const reorderedIds = reorderWithPosition(
      queue.map((item) => item.id),
      sourceItemId,
      targetQueueItemId,
      position,
      (id) => id
    );
    await onReorderQueue(reorderedIds);
  }

  const areAllSelected = queue.length > 0 && queue.every((item) => selectedQueueItemIds.has(item.id));
  const toggleSelectAll = () => {
    if (areAllSelected) {
      setSelectedQueueItemIds(new Set());
    } else {
      setSelectedQueueItemIds(new Set(queue.map((item) => item.id)));
    }
  };

  const toggleSelectItem = (itemId: string) => {
    setSelectedQueueItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  const handleBatchRemove = async () => {
    if (selectedQueueItemIds.size === 0 || !canRemoveQueue) return;
    const ids = Array.from(selectedQueueItemIds);

    startTransition(async () => {
      if (onRemoveQueueItems) {
        await onRemoveQueueItems(ids);
      } else {
        for (const id of ids) {
          await onRemoveQueueItem(id);
        }
      }
      setIsSelectMode(false);
      setSelectedQueueItemIds(new Set());
    });
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {canRemoveQueue && queue.length > 0 ? (
        <div className="flex shrink-0 items-center justify-between border-b border-surface-border/40 px-3 py-1.5 text-xs text-foreground-muted">
          {isSelectMode ? (
            <>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="queue-batch-select-all"
                  onClick={toggleSelectAll}
                  className="flex items-center gap-1.5 font-medium text-foreground hover:text-accent transition-colors cursor-pointer"
                >
                  <span
                    className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded border transition-colors ${
                      areAllSelected
                        ? "border-accent bg-accent text-white"
                        : selectedQueueItemIds.size > 0
                        ? "border-accent/60 bg-accent/20 text-accent"
                        : "border-surface-border bg-surface"
                    }`}
                  >
                    {areAllSelected ? (
                      <Check size={10} strokeWidth={3} />
                    ) : selectedQueueItemIds.size > 0 ? (
                      <span className="h-1.5 w-1.5 rounded-xs bg-accent" />
                    ) : null}
                  </span>
                  <span>{areAllSelected ? "取消全选" : "全选"}</span>
                </button>
                <span className="text-xs tabular-nums">
                  已选 <strong className="font-mono text-accent">{selectedQueueItemIds.size}</strong> 首
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  data-testid="queue-batch-remove-button"
                  disabled={selectedQueueItemIds.size === 0 || isPending}
                  onClick={() => setShowBatchRemoveConfirm(true)}
                  className="inline-flex items-center gap-1 rounded px-2 py-0.5 font-medium text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                >
                  <Trash2 size={12} />
                  <span>移出队列 ({selectedQueueItemIds.size})</span>
                </button>
                <button
                  type="button"
                  data-testid="queue-batch-mode-exit"
                  onClick={() => {
                    setIsSelectMode(false);
                    setSelectedQueueItemIds(new Set());
                  }}
                  className="rounded px-1.5 py-0.5 text-foreground-muted hover:bg-surface-hover hover:text-foreground transition-colors cursor-pointer"
                >
                  完成
                </button>
              </div>
            </>
          ) : (
            <div className="flex w-full items-center justify-end">
              <button
                type="button"
                data-testid="queue-batch-mode-toggle"
                onClick={() => {
                  setIsSelectMode(true);
                  setSelectedQueueItemIds(new Set());
                }}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-foreground-muted hover:bg-surface-hover hover:text-foreground transition-colors cursor-pointer"
                title="批量管理队列"
              >
                <CheckSquare size={12} />
                <span>批量管理</span>
              </button>
            </div>
          )}
        </div>
      ) : null}

      <div
        ref={containerRef}
        className={`light-player-queue-content relative min-h-0 flex-1 overflow-y-auto p-1.5 sm:p-2 custom-scrollbar ${className}`}
      onDragOver={(event) => {
        if (!canReorderQueue || !draggingQueueItemId) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        updateAutoScroll(event.clientX, event.clientY);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          stopAutoScroll();
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        stopAutoScroll();
        if (dragOverTarget && draggingQueueItemId) {
          void handleDrop(dragOverTarget.itemId, dragOverTarget.position);
        }
      }}
    >
            {queueWithTracks.length ? (
              queueWithTracks.map(({ item, track }, index) => {
                const canRemove = canRemoveQueue;
                const isCurrent = currentQueueItemId === item.id;
                const isNext = nextQueueItemId === item.id;
                const title = track?.title ?? "未知曲目";
                const artistName = track?.artist?.trim() || "未知歌手";
                const albumName = track?.album?.trim() || "未知专辑";
                const memberName = track?.ownerNickname?.trim() || item.requestedBy?.trim() || "成员";

                return (
                  <div
                    key={item.id}
                    data-testid="queue-item"
                    className={`group relative flex items-center gap-2 sm:gap-2.5 rounded-lg px-2 py-1.5 sm:px-2.5 sm:py-1.5 transition-all ${
                      isSelectMode && selectedQueueItemIds.has(item.id)
                        ? "border border-accent/40 bg-accent/10"
                        : isCurrent
                        ? "border border-accent/35 bg-accent/10"
                        : "border border-transparent hover:bg-surface-hover/60 hover:border-surface-border/40"
                    } ${
                      isSelectMode ? "cursor-pointer" : canReorderQueue ? "cursor-grab active:cursor-grabbing" : ""
                    } ${
                      draggingQueueItemId === item.id ? "scale-95 touch-none opacity-40 bg-surface-muted/40" : "touch-pan-y"
                    }`}
                    data-queue-item-id={item.id}
                    draggable={!isSelectMode && canReorderQueue}
                    onClick={(event) => {
                      if (isSelectMode) {
                        if ((event.target as HTMLElement).closest("button")) return;
                        toggleSelectItem(item.id);
                      }
                    }}
                    onDragStart={(event) => {
                      if (isSelectMode || !canReorderQueue) return;
                      setDraggingQueueItemId(item.id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", item.id);
                    }}
                    onDragOver={(event) => {
                      if (isSelectMode || !canReorderQueue || !draggingQueueItemId || draggingQueueItemId === item.id) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      updateAutoScroll(event.clientX, event.clientY);
                      const rect = event.currentTarget.getBoundingClientRect();
                      const midY = rect.top + rect.height / 2;
                      const position = event.clientY < midY ? "before" : "after";
                      setDragOverTarget((prev) => {
                        if (prev?.itemId === item.id && prev.position === position) return prev;
                        return { itemId: item.id, position };
                      });
                    }}
                    onDragLeave={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                        setDragOverTarget((prev) => (prev?.itemId === item.id ? null : prev));
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      stopAutoScroll();
                      if (isSelectMode || !draggingQueueItemId || !canReorderQueue) {
                        setDraggingQueueItemId(null);
                        setDragOverTarget(null);
                        return;
                      }
                      const rect = event.currentTarget.getBoundingClientRect();
                      const position = dragOverTarget?.position ?? (
                        event.clientY < rect.top + rect.height / 2 ? "before" : "after"
                      );
                      void handleDrop(item.id, position);
                    }}
                    onDragEnd={() => {
                      stopAutoScroll();
                      setDraggingQueueItemId(null);
                      setDragOverTarget(null);
                    }}
                    onPointerCancel={finishTouchReorder}
                    onPointerDown={(event) => {
                      if (!isSelectMode) handleTouchReorderStart(event, item.id);
                    }}
                    onPointerMove={handleTouchReorderMove}
                    onPointerUp={finishTouchReorder}
                  >
                    {/* Visual drop indicator */}
                    {dragOverTarget?.itemId === item.id && draggingQueueItemId !== item.id ? (
                      <div
                        className={`absolute left-1 right-1 z-20 h-0.5 bg-accent pointer-events-none ${
                          dragOverTarget.position === "before" ? "-top-[1px]" : "-bottom-[1px]"
                        }`}
                      >
                        <div className="absolute -left-1 -top-[3px] h-2 w-2 rounded-full bg-accent" />
                      </div>
                    ) : null}

                    <div className="w-5 shrink-0 flex items-center justify-center">
                      {isSelectMode ? (
                        <button
                          type="button"
                          data-testid={`queue-checkbox-${item.id}`}
                          aria-checked={selectedQueueItemIds.has(item.id)}
                          role="checkbox"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSelectItem(item.id);
                          }}
                          className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded border transition-colors cursor-pointer ${
                            selectedQueueItemIds.has(item.id)
                              ? "border-accent bg-accent text-white"
                              : "border-surface-border/80 bg-surface/80 hover:border-foreground-muted"
                          }`}
                        >
                          {selectedQueueItemIds.has(item.id) ? (
                            <Check size={10} strokeWidth={3} />
                          ) : null}
                        </button>
                      ) : (
                        <span className={`w-full text-center font-mono text-xs font-semibold tabular-nums ${isCurrent ? "text-accent font-bold" : "text-foreground-muted"}`}>
                          {canReorderQueue ? (
                            <>
                              <span className="block group-hover:hidden">{String(index + 1).padStart(2, "0")}</span>
                              <GripVertical
                                aria-hidden="true"
                                className="hidden group-hover:block mx-auto h-3.5 w-3.5 text-foreground-muted/60"
                              />
                            </>
                          ) : (
                            String(index + 1).padStart(2, "0")
                          )}
                        </span>
                      )}
                    </div>
                    <div className="relative shrink-0">
                      <QueueArtwork artworkUrl={track?.artworkUrl ?? null} title={title} />
                      <TrackDistributionBadge
                        roomId={roomId}
                        track={track}
                        members={members}
                        currentSessionId={currentSessionId}
                      />
                    </div>
                    <div className="min-w-0 flex-1 pr-2">
                       <strong className={`block truncate text-xs sm:text-sm ${isCurrent ? "text-accent font-bold" : "text-foreground font-semibold"}`}>
                         {title}
                       </strong>
                       <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-foreground-muted">
                         <span className="min-w-0 truncate">{artistName}</span>
                         {albumName ? <span className="min-w-0 truncate text-foreground-muted/60">/ {albumName}</span> : null}
                       </p>
                       <p className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-foreground-muted/70">
                         <span className="shrink-0 tabular-nums">{formatDuration(track?.durationMs ?? 0)}</span>
                         <span className="min-w-0 truncate">{memberName}上传</span>
                       </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                      {canControlPlayback ? (
                        <Button
                          aria-label={`将《${title}》设为下一首播放`}
                          aria-pressed={isNext}
                          className={`h-7 w-7 disabled:opacity-100 sm:h-7 sm:w-7 ${
                            isNext
                              ? "bg-accent/15 text-accent hover:bg-accent/25"
                              : "text-foreground-muted hover:bg-surface-hover/60 hover:text-foreground"
                          }`}
                          data-testid="queue-item-next-button"
                          disabled={isCurrent || isPending}
                          onClick={() => void onPlayNextQueueItem(item.id)}
                          title="下一首播放"
                          type="button"
                          variant="ghost"
                        >
                          <svg
                            aria-hidden="true"
                            className="block shrink-0"
                            data-testid="queue-item-next-icon"
                            fill="currentColor"
                            height="15"
                            style={{ color: isNext ? accentColor : "currentColor" }}
                            viewBox="0 0 24 24"
                            width="15"
                          >
                            <path d="M6 18l8.5-6L6 6zm10-12v12h2V6z" />
                          </svg>
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        data-testid="queue-item-play-button"
                        className="h-7 w-7 text-foreground-muted hover:bg-surface-hover/60 hover:text-foreground sm:h-7 sm:w-7"
                        disabled={!canControlPlayback || isCurrent}
                        onClick={() => void onPlayQueueItem(item.id)}
                        title="播放"
                      >
                        <Play size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-foreground-muted hover:bg-red-500/15 hover:text-red-400 sm:h-7 sm:w-7"
                        disabled={!canRemove}
                        onClick={() => startTransition(() => void onRemoveQueueItem(item.id))}
                        title="移除"
                      >
                         <X size={14} />
                      </Button>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="py-10 text-center text-sm text-foreground-muted">
                 队列空空如也。
              </div>
            )}
            
            {isPending ? (
              <div className="light-player-queue-pending absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-sm">
                 <div className="light-player-queue-pending-pill flex items-center gap-2 rounded-full border border-surface-border bg-background-secondary px-4 py-1.5 shadow-lg">
                    <div className="w-2 h-2 rounded-full bg-accent animate-ping" />
                    <span className="text-xs text-foreground">更新队列中...</span>
                 </div>
              </div>
            ) : null}
      </div>

      <ConfirmDialog
        open={showBatchRemoveConfirm}
        title="移出播放队列"
        description={`确定将选中的 ${selectedQueueItemIds.size} 首歌曲移出播放队列吗？`}
        confirmLabel="移出"
        destructive
        pending={isPending}
        onCancel={() => setShowBatchRemoveConfirm(false)}
        onConfirm={async () => {
          await handleBatchRemove();
          setShowBatchRemoveConfirm(false);
        }}
      />
    </div>
  );
}

function QueueArtwork({ artworkUrl, title }: { artworkUrl: string | null; title: string }) {
  const source = artworkUrl?.trim() ? getArtworkSourceUrl(artworkUrl) : null;
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [source]);

  return (
    <div
      aria-label={`${title} 封面`}
      className="light-player-queue-artwork flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-surface-border bg-surface text-xs font-semibold text-foreground-muted"
      data-testid="queue-item-artwork"
    >
      {source && !hasError ? (
        // External provider artwork is intentionally rendered without Next image optimization.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          className="h-full w-full object-cover"
          decoding="async"
          draggable={false}
          loading="lazy"
          onError={() => setHasError(true)}
          src={source}
        />
      ) : (
        <span aria-hidden="true">{title.slice(0, 1).toUpperCase() || "♪"}</span>
      )}
    </div>
  );
}
