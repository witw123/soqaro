"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Check, CheckSquare, Copy, GripVertical, Play, Plus, Save, Trash2 } from "lucide-react";
import type { AuthSession, RoomMember, TrackMeta } from "@soqaro/shared";
import { formatDuration } from "@/lib/domain/soqaro-ui";
import { Button } from "@/components/ui/button";
import type { UploadedTrack } from "@/features/library/audio-utils";
import { listRoomPlaylistTrackIndex, providerTrackKey } from "@/features/playlist/local-playlist";
import { reorderWithPosition } from "@/components/bottom-player/PlayerQueueDrawer";
import { findScrollableContainer, useDragAutoScroll } from "@/features/room/hooks/use-drag-auto-scroll";
import { LocalAudioImport } from "./LocalAudioImport";
import { TrackDistributionBadge } from "./TrackDistributionBadge";
import { TrackContextMenu, type ContextMenuItem } from "@/components/ui/TrackContextMenu";
import { getArtworkSourceUrl } from "@/components/bottom-player/artwork-colors";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type TrackListSectionProps = {
  roomId?: string | null;
  tracks: TrackMeta[];
  members?: Array<Pick<RoomMember, "id" | "presenceState">> | null;
  uploadedTracks: Record<string, UploadedTrack>;
  localFolderName: string | null;
  localSavedFileHashes: string[];
  canControlPlayback: boolean;
  canManageLibrary: boolean;
  canManageAllTracks?: boolean;
  canAddToQueue: boolean;
  activeSession: AuthSession | null;
  onFilesSelected: (files: FileList | File[] | null) => Promise<void>;
  onAddToQueue: (trackId: string) => Promise<unknown>;
  onSaveTrackToLocal: (track: TrackMeta) => Promise<void>;
  onDeleteTrack: (trackId: string) => Promise<void>;
  onDeleteTracks?: (trackIds: string[]) => Promise<unknown>;
  onPlayTrack: (trackId: string) => Promise<void>;
  onReorderTracks?: (trackIds: string[]) => Promise<void>;
  onBatchAddToQueue?: (trackIds: string[]) => Promise<unknown>;
  onRefreshRoom?: () => Promise<unknown>;
  hideLocalAudioImport?: boolean;
};

export type LibraryTrackFilter = "all" | "mine" | "others";

export function filterLibraryTracks<T extends Pick<TrackMeta, "ownerSessionId">>(
  tracks: T[],
  activeSessionUserId: string | null | undefined,
  filter: LibraryTrackFilter
) {
  if (filter === "all") return tracks;

  return tracks.filter((track) =>
    filter === "mine"
      ? track.ownerSessionId === activeSessionUserId
      : track.ownerSessionId !== activeSessionUserId
  );
}

function TrackListSectionBase({
  roomId,
  tracks,
  members,
  uploadedTracks,
  localFolderName,
  localSavedFileHashes,
  canControlPlayback,
  canManageLibrary,
  canManageAllTracks,
  canAddToQueue,
  activeSession,
  hideLocalAudioImport,
  onFilesSelected,
  onAddToQueue,
  onSaveTrackToLocal,
  onDeleteTrack,
  onDeleteTracks,
  onPlayTrack,
  onReorderTracks,
  onBatchAddToQueue,
  onRefreshRoom
}: TrackListSectionProps) {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [trackFilter, setTrackFilter] = useState<LibraryTrackFilter>("all");
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set());
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false);
  const [cachedArtworkByTrackId, setCachedArtworkByTrackId] = useState<Map<string, string>>(new Map());
  const [draggingTrackId, setDraggingTrackId] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<{
    trackId: string;
    position: "before" | "after";
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    track: TrackMeta;
    position: { x: number; y: number };
    canDelete: boolean;
    isSaved: boolean;
  } | null>(null);
  const canReorderTracks = canManageLibrary && Boolean(onReorderTracks);

  const contextMenuItems: ContextMenuItem[] = contextMenu ? [
    {
      id: "play",
      label: "立即播放",
      icon: <Play size={14} fill="currentColor" />,
      disabled: pendingAction !== null,
      onSelect: () => void runAction(`play:${contextMenu.track.id}`, () => onPlayTrack(contextMenu.track.id))
    },
    {
      id: "queue",
      label: "加入播放队列",
      icon: <Plus size={14} />,
      disabled: !canAddToQueue || pendingAction !== null,
      onSelect: () => void runAction(`queue:${contextMenu.track.id}`, () => onAddToQueue(contextMenu.track.id))
    },
    ...(contextMenu.isSaved ? [] : [{
      id: "save-local",
      label: "保存到本地",
      icon: <Save size={14} />,
      disabled: pendingAction !== null,
      onSelect: () => void runAction(`save:${contextMenu.track.id}`, () => onSaveTrackToLocal(contextMenu.track))
    }]),
    {
      id: "copy",
      label: "复制歌曲信息",
      icon: <Copy size={14} />,
      onSelect: () => {
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          void navigator.clipboard.writeText(`${contextMenu.track.title} - ${contextMenu.track.artist}`);
        }
      }
    },
    ...(contextMenu.canDelete ? [{
      id: "delete",
      label: "从房间移除",
      destructive: true,
      icon: <Trash2 size={14} />,
      disabled: !canManageLibrary || pendingAction !== null,
      onSelect: () => void runAction(`delete:${contextMenu.track.id}`, () => onDeleteTrack(contextMenu.track.id))
    }] : [])
  ] : [];

  const sectionRef = useRef<HTMLElement>(null);
  const draggingTrackIdRef = useRef<string | null>(null);
  draggingTrackIdRef.current = draggingTrackId;
  const renderedTracksRef = useRef<TrackMeta[]>([]);

  const touchReorderRef = useRef<{
    trackId: string;
    pointerId: number;
    startX: number;
    startY: number;
    targetTrackId: string | null;
    targetPosition: "before" | "after";
    active: boolean;
    targetElement: HTMLElement | null;
  } | null>(null);
  const touchReorderTimerRef = useRef<number | null>(null);

  const { updateAutoScroll, stopAutoScroll } = useDragAutoScroll({
    getScrollContainer: () => findScrollableContainer(sectionRef.current),
    onScrollFrame: (point) => {
      const draggingId = draggingTrackIdRef.current;
      if (!draggingId) return;

      const target = document
        .elementFromPoint(point.x, point.y)
        ?.closest<HTMLElement>("[data-track-id]");
      if (target && target.dataset.trackId) {
        const targetId = target.dataset.trackId;
        const rect = target.getBoundingClientRect();
        const position = point.y < rect.top + rect.height / 2 ? "before" : "after";
        if (touchReorderRef.current?.active) {
          touchReorderRef.current.targetTrackId = targetId;
          touchReorderRef.current.targetPosition = position;
        }
        if (targetId !== draggingId) {
          setDragOverTarget((prev) => {
            if (prev?.trackId === targetId && prev.position === position) return prev;
            return { trackId: targetId, position };
          });
        }
      } else {
        const container = findScrollableContainer(sectionRef.current);
        const currentRendered = renderedTracksRef.current;
        if (container && currentRendered.length > 0) {
          const rect = container.getBoundingClientRect();
          if (point.y > rect.bottom - 64) {
            const lastTrackId = currentRendered[currentRendered.length - 1].id;
            if (touchReorderRef.current?.active) {
              touchReorderRef.current.targetTrackId = lastTrackId;
              touchReorderRef.current.targetPosition = "after";
            }
            if (lastTrackId !== draggingId) {
              setDragOverTarget({ trackId: lastTrackId, position: "after" });
            }
          } else if (point.y < rect.top + 64) {
            const firstTrackId = currentRendered[0].id;
            if (touchReorderRef.current?.active) {
              touchReorderRef.current.targetTrackId = firstTrackId;
              touchReorderRef.current.targetPosition = "before";
            }
            if (firstTrackId !== draggingId) {
              setDragOverTarget({ trackId: firstTrackId, position: "before" });
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

  const handleTrackDrop = async (targetTrackId: string, position: "before" | "after") => {
    stopAutoScroll();
    if (!draggingTrackId || !canReorderTracks || !onReorderTracks) {
      setDraggingTrackId(null);
      setDragOverTarget(null);
      return;
    }

    const sourceTrackId = draggingTrackId;
    setDraggingTrackId(null);
    setDragOverTarget(null);

    if (sourceTrackId === targetTrackId) return;

    const nextTracks = reorderWithPosition(tracks, sourceTrackId, targetTrackId, position, (t) => t.id);
    await onReorderTracks(nextTracks.map((t) => t.id));
  };

  function handleTouchReorderStart(event: React.PointerEvent<HTMLElement>, trackId: string) {
    if (!canReorderTracks || (event.pointerType !== "touch" && event.pointerType !== "pen")) {
      return;
    }
    if ((event.target as HTMLElement).closest("button")) return;

    cancelTouchReorderTimer();
    const targetElement = event.currentTarget;
    touchReorderRef.current = {
      trackId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      targetTrackId: trackId,
      targetPosition: "after",
      active: false,
      targetElement
    };
    touchReorderTimerRef.current = window.setTimeout(() => {
      const current = touchReorderRef.current;
      if (!current || current.pointerId !== event.pointerId) return;
      current.active = true;
      setDraggingTrackId(current.trackId);
      setDragOverTarget(null);
      current.targetElement?.setPointerCapture(current.pointerId);
    }, 420);
  }

  function handleTouchReorderMove(event: React.PointerEvent<HTMLElement>) {
    const current = touchReorderRef.current;
    if (!current || current.pointerId !== event.pointerId) return;

    if (!current.active) {
      const movedDistance = Math.hypot(
        event.clientX - current.startX,
        event.clientY - current.startY
      );
      if (movedDistance > 10) {
        cancelTouchReorderTimer();
        touchReorderRef.current = null;
      }
      return;
    }

    event.preventDefault();
    updateAutoScroll(event.clientX, event.clientY);

    const target = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-track-id]");
    const targetTrackId = target?.dataset.trackId ?? current.trackId;
    let position: "before" | "after" = "after";
    if (target) {
      const rect = target.getBoundingClientRect();
      position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    }
    current.targetTrackId = targetTrackId;
    current.targetPosition = position;
    if (targetTrackId !== current.trackId) {
      setDragOverTarget({ trackId: targetTrackId, position });
    } else {
      setDragOverTarget(null);
    }
  }

  function finishTouchReorder(event: React.PointerEvent<HTMLElement>) {
    stopAutoScroll();
    const current = touchReorderRef.current;
    if (!current || current.pointerId !== event.pointerId) return;

    cancelTouchReorderTimer();
    if (current.active && current.targetTrackId && current.targetTrackId !== current.trackId) {
      event.preventDefault();
      void handleTrackDrop(current.targetTrackId, current.targetPosition);
      if (current.targetElement?.hasPointerCapture(current.pointerId)) {
        current.targetElement.releasePointerCapture(current.pointerId);
      }
    }
    touchReorderRef.current = null;
    setDraggingTrackId(null);
    setDragOverTarget(null);
  }

  const activeSessionUserId = activeSession?.userId;
  const ownTrackCount = tracks.filter((track) => track.ownerSessionId === activeSessionUserId).length;
  const otherTrackCount = tracks.length - ownTrackCount;
  const visibleTracks = filterLibraryTracks(tracks, activeSessionUserId, trackFilter);

  const toggleSelectTrack = (trackId: string) => {
    setSelectedTrackIds((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) {
        next.delete(trackId);
      } else {
        next.add(trackId);
      }
      return next;
    });
  };

  const areAllVisibleSelected = visibleTracks.length > 0 && visibleTracks.every((t) => selectedTrackIds.has(t.id));
  const toggleSelectAll = () => {
    if (areAllVisibleSelected) {
      setSelectedTrackIds(new Set());
    } else {
      setSelectedTrackIds(new Set(visibleTracks.map((t) => t.id)));
    }
  };

  const handleBatchAddToQueue = async () => {
    if (selectedTrackIds.size === 0 || !canAddToQueue) return;
    const ids = Array.from(selectedTrackIds);
    await runAction("batch-queue", async () => {
      if (onBatchAddToQueue) {
        await onBatchAddToQueue(ids);
      } else {
        for (const id of ids) {
          await onAddToQueue(id);
        }
      }
      setIsSelectMode(false);
      setSelectedTrackIds(new Set());
    });
  };

  const handleBatchSaveToLocal = async () => {
    if (selectedTrackIds.size === 0) return;
    const selectedTracks = tracks.filter((t) => selectedTrackIds.has(t.id));
    await runAction("batch-save", async () => {
      for (const track of selectedTracks) {
        const isSaved = localSavedFileHashes.includes(track.fileHash);
        const canSave = !!activeSession && (
          track.ownerSessionId === activeSession.userId ||
          (track.sourceType !== "local_upload" && !!track.sourceRef)
        );
        if (!isSaved && canSave) {
          await onSaveTrackToLocal(track);
        }
      }
    });
  };

  const deletableSelectedTracks = tracks.filter((t) =>
    selectedTrackIds.has(t.id) &&
    canDeleteLibraryTrack({
      track: t,
      activeSessionUserId: activeSession?.userId,
      isHost: canManageAllTracks,
      hasLibraryPermission: canManageLibrary
    })
  );

  const handleBatchDelete = async () => {
    if (deletableSelectedTracks.length === 0 || !canManageLibrary) return;
    const ids = deletableSelectedTracks.map((t) => t.id);

    await runAction("batch-delete", async () => {
      if (onDeleteTracks) {
        await onDeleteTracks(ids);
      } else {
        for (const id of ids) {
          await onDeleteTrack(id);
        }
      }
      setIsSelectMode(false);
      setSelectedTrackIds(new Set());
    });
  };

  const [renderedCount, setRenderedCount] = useState(35);

  useEffect(() => {
    if (draggingTrackId && renderedCount < visibleTracks.length) {
      setRenderedCount(visibleTracks.length);
    }
  }, [draggingTrackId, renderedCount, visibleTracks.length]);

  useEffect(() => {
    if (renderedCount >= visibleTracks.length) return;
    const timer = window.setTimeout(() => {
      setRenderedCount((prev) => Math.min(prev + 40, visibleTracks.length));
    }, 40);
    return () => window.clearTimeout(timer);
  }, [renderedCount, visibleTracks.length]);

  useEffect(() => {
    setRenderedCount(35);
  }, [trackFilter]);

  const renderedTracks = visibleTracks.slice(0, renderedCount);
  renderedTracksRef.current = renderedTracks;

  useEffect(() => {
    let cancelled = false;
    void listRoomPlaylistTrackIndex()
      .then((index) => {
        if (cancelled) return;
        const artworkByTrackId = new Map<string, string>();
        for (const [trackId, record] of index) {
          if (record.artworkUrl) artworkByTrackId.set(trackId, record.artworkUrl);
          if (record.providerTrackId && (record.provider === "netease" || record.provider === "qqmusic") && record.artworkUrl) {
            artworkByTrackId.set(providerTrackKey(record.provider, record.providerTrackId), record.artworkUrl);
          }
        }
        setCachedArtworkByTrackId(artworkByTrackId);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const runAction = async (key: string, action: () => Promise<unknown>) => {
    if (pendingAction) return;
    setPendingAction(key);
    try {
      await action();
    } finally {
      setPendingAction(null);
    }
  };
  return (
    <section
      ref={sectionRef}
      className="relative flex w-full flex-col gap-2"
      onDragOver={(event) => {
        if (!canReorderTracks || !draggingTrackId) return;
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
        if (dragOverTarget && draggingTrackId) {
          void handleTrackDrop(dragOverTarget.trackId, dragOverTarget.position);
        }
      }}
    >
      {!hideLocalAudioImport ? (
        <LocalAudioImport
          disabled={!canManageLibrary || pendingAction !== null}
          onFilesSelected={(files) => runAction("upload", () => onFilesSelected(files))}
        />
      ) : null}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <div
            aria-label="曲库来源筛选"
            className="grid flex-1 grid-cols-3 gap-0.5 rounded-lg border border-surface-border/60 bg-surface/60 p-0.5"
            role="group"
          >
            {[
              { value: "all" as const, label: "全部歌曲", count: tracks.length },
              { value: "mine" as const, label: "本人上传", count: ownTrackCount },
              { value: "others" as const, label: "其他成员", count: otherTrackCount }
            ].map((option) => (
              <button
                key={option.value}
                aria-pressed={trackFilter === option.value}
                data-testid={`library-filter-${option.value}`}
                className={`flex min-w-0 whitespace-nowrap items-center justify-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium transition-colors sm:px-2.5 cursor-pointer ${
                  trackFilter === option.value
                    ? "bg-surface-elevated text-foreground font-semibold shadow-2xs"
                    : "text-foreground-muted hover:bg-surface-hover/50 hover:text-foreground"
                }`}
                onClick={() => setTrackFilter(option.value)}
                type="button"
              >
                <span className="truncate">{option.label}</span>
                <span
                  className={`font-mono text-xs ${
                    trackFilter === option.value ? "text-accent font-semibold" : "text-foreground-muted/70"
                  }`}
                >
                  {option.count}
                </span>
              </button>
            ))}
          </div>

          {tracks.length > 0 && (
            <button
              type="button"
              data-testid="library-batch-mode-toggle"
              aria-pressed={isSelectMode}
              className={`flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors cursor-pointer ${
                isSelectMode
                  ? "border-accent/40 bg-accent/10 text-accent font-semibold"
                  : "border-surface-border/60 bg-surface/60 text-foreground-muted hover:bg-surface-hover/50 hover:text-foreground"
              }`}
              onClick={() => {
                setIsSelectMode(!isSelectMode);
                setSelectedTrackIds(new Set());
              }}
              title={isSelectMode ? "退出批量操作" : "批量操作"}
            >
              <CheckSquare size={13} aria-hidden="true" />
              <span>{isSelectMode ? "退出" : "批量"}</span>
            </button>
          )}
        </div>

        {isSelectMode ? (
          <div
            data-testid="library-batch-bar"
            className="animate-fade-in flex flex-wrap items-center justify-between gap-1.5 rounded-lg border border-accent/25 bg-accent/5 px-2.5 py-1.5 text-xs text-foreground"
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="library-batch-select-all"
                onClick={toggleSelectAll}
                className="flex items-center gap-1.5 text-xs font-medium text-foreground hover:text-accent transition-colors cursor-pointer"
              >
                <span
                  className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded border transition-colors ${
                    areAllVisibleSelected
                      ? "border-accent bg-accent text-white"
                      : selectedTrackIds.size > 0
                      ? "border-accent/60 bg-accent/20 text-accent"
                      : "border-surface-border bg-surface"
                  }`}
                >
                  {areAllVisibleSelected ? (
                    <Check size={10} strokeWidth={3} />
                  ) : selectedTrackIds.size > 0 ? (
                    <span className="h-1.5 w-1.5 rounded-xs bg-accent" />
                  ) : null}
                </span>
                <span>{areAllVisibleSelected ? "取消全选" : "全选当前"}</span>
              </button>
              <span className="text-xs text-foreground-muted">
                已选 <strong className="font-mono text-accent">{selectedTrackIds.size}</strong> 首
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                data-testid="library-batch-queue-button"
                disabled={selectedTrackIds.size === 0 || !canAddToQueue || pendingAction !== null}
                onClick={() => void handleBatchAddToQueue()}
                className="h-6.5 px-2 text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover/80"
                title="将选中的歌曲加入播放队列"
              >
                <Plus size={12} className="mr-1" />
                <span>加入队列</span>
              </Button>

              {localFolderName ? (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="library-batch-save-button"
                  disabled={selectedTrackIds.size === 0 || pendingAction !== null}
                  onClick={() => void handleBatchSaveToLocal()}
                  className="h-6.5 px-2 text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover/80"
                  title="将选中的歌曲保存到本地目录"
                >
                  <Save size={12} className="mr-1" />
                  <span>保存本地</span>
                </Button>
              ) : null}

              {canManageLibrary ? (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="library-batch-delete-button"
                  disabled={deletableSelectedTracks.length === 0 || pendingAction !== null}
                  onClick={() => setShowBatchDeleteConfirm(true)}
                  className="h-6.5 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                  title="将选中有权限的歌曲从曲库删除"
                >
                  <Trash2 size={12} className="mr-1" />
                  <span>删除 ({deletableSelectedTracks.length})</span>
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        {visibleTracks.length > 0 ? (
          <div className="overflow-hidden rounded-lg border border-surface-border/60 bg-surface/50">
            {renderedTracks.map((track) => {
              const canDeleteTrack = canDeleteLibraryTrack({
                track,
                activeSessionUserId: activeSession?.userId,
                isHost: canManageAllTracks,
                hasLibraryPermission: canManageLibrary
              });
              const uploadedTrack = uploadedTracks[track.id] ?? null;
              const isUploadedLocally = !!uploadedTrack;
              const isSavedLocally = localSavedFileHashes.includes(track.fileHash);
              const canSaveToSelectedFolder = Boolean(localFolderName);
              const canSaveLocalTrack = !!activeSession && (
                track.ownerSessionId === activeSession.userId ||
                (track.sourceType !== "local_upload" && !!track.sourceRef)
              );
              const cachedArtworkKey = track.sourceRef
                ? providerTrackKey(track.sourceRef.provider, track.sourceRef.trackId)
                : track.id;
              const artworkUrl = track.artworkUrl ?? cachedArtworkByTrackId.get(cachedArtworkKey) ?? null;

              return (
                <article
                  key={track.id}
                  data-testid="track-card"
                  data-track-id={track.id}
                  draggable={!isSelectMode && canReorderTracks}
                  onClick={(event) => {
                    if (isSelectMode) {
                      if ((event.target as HTMLElement).closest("button")) return;
                      toggleSelectTrack(track.id);
                    }
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({
                      track,
                      position: { x: event.clientX, y: event.clientY },
                      canDelete: canDeleteTrack,
                      isSaved: isSavedLocally
                    });
                  }}
                  onDragStart={(event) => {
                    if (isSelectMode || !canReorderTracks) return;
                    setDraggingTrackId(track.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", track.id);
                  }}
                  onDragOver={(event) => {
                    if (isSelectMode || !canReorderTracks || !draggingTrackId || draggingTrackId === track.id) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    updateAutoScroll(event.clientX, event.clientY);
                    const rect = event.currentTarget.getBoundingClientRect();
                    const midY = rect.top + rect.height / 2;
                    const position = event.clientY < midY ? "before" : "after";
                    setDragOverTarget((prev) => {
                      if (prev?.trackId === track.id && prev.position === position) return prev;
                      return { trackId: track.id, position };
                    });
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                      setDragOverTarget((prev) => (prev?.trackId === track.id ? null : prev));
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    stopAutoScroll();
                    if (isSelectMode || !draggingTrackId || !canReorderTracks) {
                      setDraggingTrackId(null);
                      setDragOverTarget(null);
                      return;
                    }
                    const rect = event.currentTarget.getBoundingClientRect();
                    const position = dragOverTarget?.position ?? (
                      event.clientY < rect.top + rect.height / 2 ? "before" : "after"
                    );
                    void handleTrackDrop(track.id, position);
                  }}
                  onDragEnd={() => {
                    stopAutoScroll();
                    setDraggingTrackId(null);
                    setDragOverTarget(null);
                  }}
                  onPointerCancel={finishTouchReorder}
                  onPointerDown={(event) => {
                    if (!isSelectMode) handleTouchReorderStart(event, track.id);
                  }}
                  onPointerMove={handleTouchReorderMove}
                  onPointerUp={finishTouchReorder}
                  className={`group relative grid grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[auto_auto] items-center gap-x-2 gap-y-0.5 border-b border-surface-border/30 px-2 py-1.5 transition-colors last:border-b-0 hover:bg-surface-hover sm:gap-x-2.5 sm:px-3 ${
                    !isSelectMode && canReorderTracks ? "cursor-grab active:cursor-grabbing" : ""
                  } ${
                    isSelectMode ? "cursor-pointer" : ""
                  } ${
                    isSelectMode && selectedTrackIds.has(track.id) ? "bg-accent/10 border-accent/30" : ""
                  } ${
                    draggingTrackId === track.id ? "scale-95 touch-none opacity-40 bg-surface-muted/40" : "touch-pan-y"
                  }`}
                >
                  {/* Visual drop indicator */}
                  {dragOverTarget?.trackId === track.id && draggingTrackId !== track.id ? (
                    <div
                      className={`absolute left-1 right-1 z-20 h-0.5 bg-accent pointer-events-none ${
                        dragOverTarget.position === "before" ? "-top-[1px]" : "-bottom-[1px]"
                      }`}
                    >
                      <div className="absolute -left-1 -top-[3px] h-2 w-2 rounded-full bg-accent" />
                    </div>
                  ) : null}

                  <div className="relative row-span-2 flex shrink-0 items-center gap-1 sm:gap-1.5">
                    {isSelectMode ? (
                      <button
                        type="button"
                        data-testid={`track-checkbox-${track.id}`}
                        aria-checked={selectedTrackIds.has(track.id)}
                        role="checkbox"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelectTrack(track.id);
                        }}
                        className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors cursor-pointer ${
                          selectedTrackIds.has(track.id)
                            ? "border-accent bg-accent text-white"
                            : "border-surface-border/80 bg-surface/80 hover:border-foreground-muted"
                        }`}
                      >
                        {selectedTrackIds.has(track.id) ? (
                          <Check size={11} strokeWidth={3} />
                        ) : null}
                      </button>
                    ) : null}
                    {!isSelectMode && canReorderTracks ? (
                      <div
                        aria-hidden="true"
                        className="flex shrink-0 items-center text-foreground-muted/30 transition-colors group-hover:text-foreground-muted/70"
                      >
                        <GripVertical className="h-3.5 w-3.5" />
                      </div>
                    ) : null}
                    <div className="relative shrink-0">
                      <TrackArtwork artworkUrl={artworkUrl} title={track.title} />
                      <TrackDistributionBadge
                        roomId={roomId}
                        track={track}
                        members={members}
                        currentSessionId={activeSession?.userId ?? null}
                      />
                    </div>
                  </div>

                  <div className="min-w-0">
                    <h3 className="truncate text-xs sm:text-sm font-semibold text-foreground">{track.title}</h3>
                  </div>

                  <div className="col-start-3 row-span-2 flex min-w-max self-center justify-self-end flex-nowrap items-center justify-end gap-0.5 sm:gap-1">
                    <Button
                      data-testid="track-play-button"
                      data-track-id={track.id}
                      variant="ghost"
                      className="h-8 w-8 shrink-0 !rounded-none bg-transparent p-0 !text-accent hover:bg-transparent hover:!text-accent disabled:opacity-100 disabled:!text-accent/45 sm:h-7 sm:w-7"
                      disabled={!canControlPlayback || pendingAction !== null}
                      onClick={() => void runAction(`play:${track.id}`, () => onPlayTrack(track.id))}
                      type="button"
                      aria-label={`播放《${track.title}》`}
                      title="立即播放"
                      size="icon"
                    >
                      <Play size={15} fill="currentColor" aria-hidden="true" />
                    </Button>

                    {canDeleteTrack ? (
                      <Button
                        data-testid="track-delete-button"
                        data-track-id={track.id}
                        variant="ghost"
                        className="h-8 w-8 shrink-0 !rounded-none bg-transparent p-0 text-destructive hover:bg-transparent hover:text-destructive sm:h-7 sm:w-7"
                        disabled={!canManageLibrary || pendingAction !== null}
                        onClick={() =>
                          void runAction(`delete:${track.id}`, () => onDeleteTrack(track.id))
                        }
                        aria-label={`删除《${track.title}》`}
                        title="删除"
                        type="button"
                        size="icon"
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </Button>
                    ) : null}

                    {canSaveLocalTrack ? (
                      <Button
                        data-testid="track-save-local-button"
                        data-track-id={track.id}
                        variant="ghost"
                        className={`h-8 w-8 shrink-0 !rounded-none bg-transparent p-0 hover:bg-transparent sm:h-7 sm:w-7 ${isSavedLocally ? "text-accent hover:text-accent" : canSaveToSelectedFolder ? "" : "text-foreground-muted/60"}`}
                        disabled={pendingAction !== null}
                        onClick={() => void runAction(`save:${track.id}`, () => onSaveTrackToLocal(track))}
                        aria-label={isSavedLocally
                          ? `《${track.title}》已保存到本地`
                          : canSaveToSelectedFolder
                            ? `保存《${track.title}》到本地`
                            : `《${track.title}》需要先选择本地保存目录`}
                        title={isSavedLocally ? "已保存到本地" : canSaveToSelectedFolder ? "保存到本地" : "先选择本地保存目录"}
                        type="button"
                        size="icon"
                      >
                        {isSavedLocally ? (
                          <Check size={15} aria-hidden="true" />
                        ) : (
                          <Save size={15} aria-hidden="true" />
                        )}
                      </Button>
                    ) : null}

                    <Button
                      data-testid="track-add-queue-button"
                      data-track-id={track.id}
                      variant="ghost"
                      className="h-8 w-8 shrink-0 !rounded-none bg-transparent p-0 hover:bg-transparent hover:text-foreground sm:h-7 sm:w-7"
                      disabled={!canAddToQueue || pendingAction !== null}
                      onClick={() => void runAction(`queue:${track.id}`, () => onAddToQueue(track.id))}
                      aria-label={`将《${track.title}》加入队列`}
                      title="加入队列"
                      type="button"
                      size="icon"
                    >
                      <Plus size={15} aria-hidden="true" />
                    </Button>

                  </div>

                  <div className="col-start-2 col-end-3 min-w-0 space-y-0.5">
                    <p className="flex min-w-0 items-center gap-1.5 text-xs text-foreground-muted">
                      <span className="min-w-0 max-w-[40%] truncate">{track.artist}</span>
                      <span className="text-surface-border">/</span>
                      <span className="min-w-0 max-w-[45%] truncate">{track.album ?? "未知专辑"}</span>
                      <span className="text-surface-border">/</span>
                      <span className="shrink-0 tabular-nums">{formatDuration(track.durationMs)}</span>
                    </p>
                    <p className="truncate text-xs text-foreground-muted/60">
                      <span
                        className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${
                          isUploadedLocally
                            ? "bg-green-500"
                            : "bg-blue-500"
                        }`}
                      />
                      {track.ownerNickname} 上传
                    </p>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="rounded-2xl border border-surface-border bg-surface/30 px-6 py-12 text-center">
            {tracks.length === 0 ? (
              <div className="flex flex-col items-center gap-3">
                <p className="mx-auto max-w-sm text-sm text-foreground-muted">
                  还没有曲目。先导入本地音乐，之后就可以在队列里协作播放。
                </p>
                {onRefreshRoom ? (
                  <Button
                    className="h-7 rounded-md px-2.5 text-xs font-medium border border-surface-border/80 bg-surface/60 text-foreground-muted hover:text-foreground hover:bg-surface-hover/60"
                    disabled={isRefreshing}
                    onClick={async () => {
                      setIsRefreshing(true);
                      try {
                        await onRefreshRoom();
                      } finally {
                        setIsRefreshing(false);
                      }
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {isRefreshing ? "同步中…" : "刷新曲库"}
                  </Button>
                ) : null}
              </div>
            ) : (
              <p className="mx-auto max-w-sm text-sm text-foreground-muted">
                {trackFilter === "mine"
                  ? "你还没有上传歌曲。导入本地音乐后，它会出现在这里。"
                  : "暂无其他成员上传的歌曲。"}
              </p>
            )}
          </div>
        )}
      </div>

      {pendingAction ? (
        <div className="animate-fade-in absolute left-1/2 top-4 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-surface-border bg-surface px-4 py-1.5 shadow-lg backdrop-blur-md">
          <div className="h-2 w-2 animate-ping rounded-full bg-accent" />
          <span className="text-xs text-foreground">处理中...</span>
        </div>
      ) : null}

      <TrackContextMenu
        position={contextMenu?.position ?? null}
        title={contextMenu?.track.title}
        subtitle={contextMenu?.track.artist}
        items={contextMenuItems}
        onClose={() => setContextMenu(null)}
      />

      <ConfirmDialog
        open={showBatchDeleteConfirm}
        title="移除歌曲"
        description={
          deletableSelectedTracks.length < selectedTrackIds.size
            ? `选中的 ${selectedTrackIds.size} 首歌曲中，你有权删除 ${deletableSelectedTracks.length} 首。确定从房间曲库中移除吗？`
            : `确定将选中的 ${deletableSelectedTracks.length} 首歌曲从房间曲库中移除吗？`
        }
        confirmLabel="移除"
        destructive
        pending={pendingAction === "batch-delete"}
        onCancel={() => setShowBatchDeleteConfirm(false)}
        onConfirm={async () => {
          await handleBatchDelete();
          setShowBatchDeleteConfirm(false);
        }}
      />
    </section>
  );
}

export const TrackListSection = memo(TrackListSectionBase);

function TrackArtwork({ artworkUrl, title }: { artworkUrl: string | null; title: string }) {
  const src = artworkUrl ? getArtworkSourceUrl(artworkUrl) : null;
  return (
    <div
      aria-label={`${title} 封面`}
      className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-surface-border bg-background text-xs font-semibold text-foreground-muted"
      style={src ? { backgroundImage: `url(${src})`, backgroundPosition: "center", backgroundSize: "cover" } : undefined}
    >
      {!src ? title.slice(0, 1).toUpperCase() : null}
    </div>
  );
}

export function canDeleteLibraryTrack(input: {
  track: Pick<TrackMeta, "ownerSessionId">;
  activeSessionUserId: string | null | undefined;
  isHost?: boolean;
  hasLibraryPermission?: boolean;
}) {
  return !!(
    input.activeSessionUserId &&
    input.hasLibraryPermission !== false &&
    (input.isHost || input.track.ownerSessionId === input.activeSessionUserId)
  );
}
