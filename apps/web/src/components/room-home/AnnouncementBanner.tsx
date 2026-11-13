"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SystemAnnouncement } from "@soqaro/shared";
import { soqaroApi } from "@/lib/network/soqaro-api";
import { useWorkspacePageActive } from "@/features/workspace/page-activity";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";

const DISMISSED_STORAGE_KEY = "soqaro-dismissed-announcements";

function readDismissedIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function writeDismissedIds(ids: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // Ignore storage errors
  }
}

/**
 * Format relative time (e.g. 17天前, 3小时前, 刚刚) as shown in Image 2
 */
function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  if (Number.isNaN(diffMs)) return "";
  if (diffMs < 0) return "刚刚";
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes}分钟前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}小时前`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}天前`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}个月前`;
  return `${Math.floor(diffDays / 365)}年前`;
}

/**
 * Format exact datetime for detail view (e.g. 2026-09-05 14:30)
 */
function formatExactTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export function useAnnouncementCenter() {
  const pageActive = useWorkspacePageActive();
  const announcementsQuery = useQuery({
    queryKey: ["system-announcements", "active"],
    queryFn: ({ signal }) => soqaroApi.getActiveAnnouncements(signal),
    enabled: pageActive,
    staleTime: 30_000,
    refetchInterval: pageActive ? 30_000 : false
  });

  const rawAnnouncements = announcementsQuery.data?.data;
  const announcements = useMemo(() => rawAnnouncements ?? [], [rawAnnouncements]);
  const [isDismissed, setIsDismissed] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<SystemAnnouncement | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => readDismissedIds());

  // Sync dismissed state when active announcements change
  useEffect(() => {
    if (!announcements.length) {
      setIsDismissed(true);
      return;
    }
    const dismissed = readDismissedIds();
    setDismissedIds(dismissed);
    const allDismissed = announcements.every((item) => dismissed.has(item.id));
    setIsDismissed(allDismissed);
  }, [announcements]);

  // Track scroll cycle count to advance announcements smoothly one by one
  const [cycle, setCycle] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(700);
  const showMarquee = !isDismissed && announcements.length > 0;

  useEffect(() => {
    if (!showMarquee) return;
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          setContainerWidth(Math.round(entry.contentRect.width));
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [showMarquee]);

  // Current announcement: displays exactly one announcement per cycle, cycling through all active ones
  const activeIndex = announcements.length > 0 ? cycle % announcements.length : 0;
  const currentAnnouncement = announcements[activeIndex] ?? announcements[0];

  const currentAnnouncementText = useMemo(() => {
    if (!currentAnnouncement) return "";
    const cleanContent = currentAnnouncement.content.replace(/\r?\n+/g, " ").trim();
    return `${currentAnnouncement.title}：${cleanContent}`;
  }, [currentAnnouncement]);

  // Uniform velocity: duration scales with travel distance (container width + text width)
  const marqueeDuration = useMemo(() => {
    const textLength = currentAnnouncementText.length;
    const textWidth = Math.max(textLength * 14, 120);
    const totalDistance = containerWidth + textWidth;
    return Math.max(12, Math.min(60, Math.round(totalDistance / 60)));
  }, [containerWidth, currentAnnouncementText]);

  const handleDismissMarquee = useCallback(() => {
    setDismissedIds((prev) => {
      const next = new Set(prev);
      announcements.forEach((item) => next.add(item.id));
      writeDismissedIds(next);
      setIsDismissed(true);
      return next;
    });
  }, [announcements]);

  const handleMarkAsRead = useCallback((id: string) => {
    setDismissedIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      writeDismissedIds(next);
      if (announcements.every((item) => next.has(item.id))) {
        setIsDismissed(true);
      }
      return next;
    });
  }, [announcements]);

  const handleOpenModal = useCallback((item?: SystemAnnouncement) => {
    setSelectedAnnouncement(item ?? null);
    setIsModalOpen(true);
  }, []);

  const hasUnread = useMemo(() => {
    if (!announcements.length) return false;
    return announcements.some((item) => !dismissedIds.has(item.id));
  }, [announcements, dismissedIds]);

  const bellTriggerNode = useMemo(
    () =>
      !showMarquee ? (
        <button
          type="button"
          onClick={() => handleOpenModal()}
          className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-hairline border-surface-border bg-surface text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors duration-[250ms] ease-out cursor-pointer active:scale-95"
          title="系统公告"
          aria-label="查看系统公告"
        >
          <svg
            aria-hidden="true"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
          {hasUnread ? (
            <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-accent" />
          ) : null}
        </button>
      ) : null,
    [handleOpenModal, hasUnread, showMarquee]
  );

  const marqueeNode = showMarquee ? (
    <aside
      aria-label="系统通知"
      className="group relative flex w-full items-center justify-between gap-2.5 overflow-hidden rounded-xl border-hairline border-surface-border bg-surface px-3 py-1.5 text-xs text-foreground animate-fade-in"
    >
      <button
        type="button"
        onClick={() => handleOpenModal()}
        className="flex h-5 w-5 items-center justify-center shrink-0 text-accent hover:opacity-80 transition-opacity duration-[250ms] ease-out cursor-pointer select-none"
        title="查看所有公告"
        aria-label="查看所有公告"
      >
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
      </button>

      <div
        ref={containerRef}
        onClick={() => handleOpenModal(currentAnnouncement)}
        className="announcement-marquee-container relative flex-1 min-w-0 h-5 overflow-hidden flex items-center cursor-pointer select-none"
        title="点击查看公告详情"
      >
        <div
          key={cycle}
          className="announcement-marquee-track text-xs font-normal text-foreground/90 group-hover:[animation-play-state:paused]"
          style={{ animationDuration: `${marqueeDuration}s` }}
          onAnimationEnd={() => setCycle((c) => c + 1)}
        >
          {currentAnnouncementText}
        </div>
      </div>

      <button
        type="button"
        onClick={handleDismissMarquee}
        className="rounded p-1 text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors duration-[250ms] ease-out shrink-0 cursor-pointer"
        title="收起通知"
        aria-label="收起通知"
      >
        <svg
          aria-hidden="true"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </aside>
  ) : null;

  const modalNode = isModalOpen ? (
    <AnnouncementDialogModal
      announcements={announcements}
      selectedAnnouncement={selectedAnnouncement}
      dismissedIds={dismissedIds}
      onSelectAnnouncement={setSelectedAnnouncement}
      onMarkAsRead={handleMarkAsRead}
      onClose={() => {
        setIsModalOpen(false);
        setSelectedAnnouncement(null);
      }}
    />
  ) : null;

  return {
    bellTriggerNode,
    marqueeNode,
    modalNode
  };
}

/**
 * Announcement Center Modal Dialog (Reference structure from Image 2)
 */
function AnnouncementDialogModal({
  announcements,
  selectedAnnouncement,
  dismissedIds,
  onSelectAnnouncement,
  onMarkAsRead,
  onClose
}: {
  announcements: SystemAnnouncement[];
  selectedAnnouncement: SystemAnnouncement | null;
  dismissedIds: Set<string>;
  onSelectAnnouncement: (item: SystemAnnouncement | null) => void;
  onMarkAsRead: (id: string) => void;
  onClose: () => void;
}) {
  // Handle ESC key for back to list when detail is open
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && selectedAnnouncement) {
        event.stopPropagation();
        onSelectAnnouncement(null);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onSelectAnnouncement, selectedAnnouncement]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md max-h-[min(82vh,600px)] p-5 sm:p-6 flex flex-col overflow-hidden">
        {/* Modal Header: Bell icon + Title "公告" */}
        <DialogHeader className="pb-3 border-b border-surface-border shrink-0 pr-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/15 text-accent shrink-0">
              <svg
                aria-hidden="true"
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              </svg>
            </div>
            <DialogTitle className="text-base font-bold tracking-tight text-foreground">
              公告
            </DialogTitle>
            {announcements.length > 0 ? (
              <span className="font-mono text-xs text-foreground-muted">
                ({announcements.length})
              </span>
            ) : null}
          </div>
        </DialogHeader>

        {/* Modal Body: List View (Image 2) or Detail View */}
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pt-2">
          {selectedAnnouncement ? (
            /* 详情视图：展示单条公告完整内容与发布时间 */
            <div className="py-2 flex flex-col gap-3 animate-fade-in">
              <button
                type="button"
                onClick={() => onSelectAnnouncement(null)}
                className="inline-flex items-center gap-1.5 text-xs text-foreground-muted hover:text-foreground transition-colors cursor-pointer select-none self-start"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
                <span>返回公告列表</span>
              </button>

              <div>
                <h4 className="text-base font-bold text-foreground tracking-tight leading-snug">
                  {selectedAnnouncement.title}
                </h4>
                <p className="mt-1 text-xs text-foreground-muted">
                  发布于 {formatRelativeTime(selectedAnnouncement.createdAt)} ({formatExactTime(selectedAnnouncement.createdAt)})
                </p>
              </div>

              <div className="rounded-xl border border-surface-border bg-surface/40 p-4 text-xs sm:text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed max-h-[46vh] overflow-y-auto custom-scrollbar font-sans select-text">
                {selectedAnnouncement.content}
              </div>

              <div className="pt-2 flex justify-end">
                {dismissedIds.has(selectedAnnouncement.id) ? (
                  <Button
                    size="sm"
                    disabled
                    variant="outline"
                    className="rounded-xl px-4 text-xs h-8 border-surface-border text-foreground-muted/60 opacity-60 cursor-not-allowed"
                  >
                    已读
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => onMarkAsRead(selectedAnnouncement.id)}
                    className="rounded-xl px-4 text-xs h-8"
                  >
                    已读
                  </Button>
                )}
              </div>
            </div>
          ) : (
            /* 列表视图（对应图2结构）：圆点/图标 + 标题 + 相对时间 + 右箭头 */
            <div className="py-1">
              {!announcements.length ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface border border-surface-border text-foreground-muted/60 mb-2.5">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
                    </svg>
                  </div>
                  <p className="text-xs text-foreground-muted">暂无系统公告</p>
                </div>
              ) : (
                <div className="divide-y divide-surface-border/50">
                  {announcements.map((item) => {
                    const isRead = dismissedIds.has(item.id);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => onSelectAnnouncement(item)}
                        className="group flex w-full items-center justify-between gap-3 px-2 py-3 text-left transition-colors hover:bg-surface-hover/70 rounded-xl cursor-pointer"
                      >
                        {/* 左侧圆形图标与信息 */}
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div
                            className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface border transition-colors ${
                              isRead
                                ? "border-surface-border text-foreground-muted/60"
                                : "border-accent/30 text-accent group-hover:border-accent/50"
                            }`}
                          >
                            <svg
                              aria-hidden="true"
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <circle cx="12" cy="12" r="9" />
                              <polyline points="9 12 11 14 15 10" />
                            </svg>
                            {!isRead ? (
                              <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-accent ring-2 ring-background-secondary" />
                            ) : null}
                          </div>
                          <div className="min-w-0 flex-1">
                            <h4
                              className={`truncate text-sm transition-colors ${
                                isRead
                                  ? "font-normal text-foreground/80 group-hover:text-foreground"
                                  : "font-semibold text-foreground group-hover:text-accent"
                              }`}
                            >
                              {item.title}
                            </h4>
                            <p className="text-xs text-foreground-muted mt-0.5">
                              {formatRelativeTime(item.createdAt)}
                            </p>
                          </div>
                        </div>

                        {/* 右侧箭头 */}
                        <svg
                          className="h-4 w-4 text-foreground-muted/40 group-hover:text-foreground-muted shrink-0 transition-transform group-hover:translate-x-0.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
