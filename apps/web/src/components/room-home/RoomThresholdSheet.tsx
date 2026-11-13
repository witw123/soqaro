"use client";
/* eslint-disable @next/next/no-img-element */

import React, { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Disc3, Lock, X } from "lucide-react";
import type { RoomDirectoryItem, RoomType } from "@soqaro/shared";
import { getArtworkSourceUrl } from "@/components/bottom-player/artwork-colors";
import { Button } from "@/components/ui/button";
import { useBackHandler } from "@/lib/desktop/use-back-handler";

type RoomThresholdSheetProps = {
  room: RoomDirectoryItem;
  isPending: boolean;
  dialogError: string | null;
  onClose: () => void;
  onConfirm: (password: string) => void;
};

const roomFormatAccentColors: Record<RoomType, string> = {
  interactive: "#0070f3",
  request: "#c026d3",
  radio: "#00a9d6"
};

function resolveActivityMetric(room: RoomDirectoryItem["room"]): string | null {
  if (room.roomType === "request") {
    if (room.directoryPendingRequestCount > 0) {
      return `待审 ${room.directoryPendingRequestCount} / 队列 ${room.directoryQueueDepth}`;
    }
    return room.directoryQueueDepth > 0 ? `队列 ${room.directoryQueueDepth} 首` : null;
  }

  if (room.roomType === "radio") {
    return room.directoryBroadcastState === "on_air" ? "正在播出" : null;
  }

  return room.directoryQueueDepth > 0 ? `${room.directoryQueueDepth} 首曲目` : null;
}

export function RoomThresholdSheet({
  room: directoryItem,
  isPending,
  dialogError: initialDialogError,
  onClose,
  onConfirm
}: RoomThresholdSheetProps) {
  const room = directoryItem.room;
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  useBackHandler(onClose);

  useEffect(() => {
    setPassword("");
    setLocalError(null);
  }, [room.id]);

  const displayedError = localError || initialDialogError;
  const customDescription = room.description?.trim() || "";
  const nowPlaying = room.directoryNowPlaying;
  const hasNowPlaying = Boolean(nowPlaying?.title);
  const artworkSrc = nowPlaying?.artworkUrl ? getArtworkSourceUrl(nowPlaying.artworkUrl) : null;
  const activityMetric = resolveActivityMetric(room);
  const isActivelyPlaying = room.playbackStatus === "playing";

  const handleSubmit = (event?: React.FormEvent) => {
    if (event) event.preventDefault();
    if (isPending) return;
    if (room.hasPassword && !password.trim()) {
      setLocalError("请输入房间密码。");
      return;
    }
    setLocalError(null);
    onConfirm(password.trim());
  };

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && !isPending && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 overflow-hidden overscroll-contain bg-black/65"
          data-dialog-backdrop="room-threshold"
          style={{
            zIndex: "var(--z-modal)",
            viewTransitionName: "room-dialog-backdrop"
          }}
        />
        <DialogPrimitive.Content
          className="light-dialog-surface custom-scrollbar fixed left-1/2 top-1/2 max-h-[85dvh] w-[calc(100dvw-2rem)] max-w-[420px] -translate-x-1/2 -translate-y-1/2 overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl border-hairline border-[var(--slate-6)] bg-[var(--slate-2)] text-[var(--slate-12)] shadow-[0_16px_40px_rgba(0,0,0,0.45)]"
          data-dialog-surface="room-threshold"
          style={{
            zIndex: "var(--z-modal-high)",
            viewTransitionName: "active-room-shell"
          }}
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-[1.5px] overflow-hidden"
            style={{
              background: isPending
                ? "var(--slate-4)"
                : `linear-gradient(90deg, transparent 0%, ${roomFormatAccentColors[room.roomType]} 50%, transparent 100%)`,
              opacity: isPending ? 1 : 0.75
            }}
          >
            {isPending ? (
              <div className="h-full w-2/3 animate-pulse bg-[var(--blue-9)]" />
            ) : null}
          </div>

          {/* Header: Room Title and Optional Description */}
          <div className="px-4 pt-4 pb-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <DialogPrimitive.Title className="break-words text-base font-semibold leading-snug tracking-tight text-[var(--slate-12)]">
                  {room.name ?? "未命名房间"}
                </DialogPrimitive.Title>
                {room.hasPassword || room.visibility === "private" ? (
                  <Lock
                    aria-label="需要密码"
                    className="h-3.5 w-3.5 shrink-0 text-[var(--slate-10)]"
                  />
                ) : null}
              </div>

              <DialogPrimitive.Close
                aria-label="关闭"
                className="-mr-1.5 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--slate-11)] transition-colors duration-[250ms] ease-out hover:bg-[var(--slate-4)] hover:text-[var(--slate-12)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--blue-8)] disabled:pointer-events-none cursor-pointer"
                disabled={isPending}
              >
                <X className="h-4 w-4" />
              </DialogPrimitive.Close>
            </div>

            {customDescription ? (
              <DialogPrimitive.Description className="mt-2 max-h-36 overflow-y-auto custom-scrollbar whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--slate-11)]">
                {customDescription}
              </DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">
                {room.name ?? "房间详情"}
              </DialogPrimitive.Description>
            )}
          </div>

          {/* Media Row: Compact Cover + Track/Artist/Album + Queue Count */}
          {hasNowPlaying && nowPlaying ? (
            <>
              <div aria-hidden="true" className="h-[0.5px] w-full bg-[var(--slate-6)]" />
              <div className="flex min-w-0 items-center gap-3 px-4 py-3">
                <div
                  className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border-hairline border-[var(--slate-6)] bg-[var(--slate-3)]"
                  data-testid="room-threshold-artwork"
                >
                  {artworkSrc ? (
                    <img
                      alt={nowPlaying.title}
                      className="h-full w-full object-cover"
                      decoding="async"
                      fetchPriority="low"
                      loading="lazy"
                      src={artworkSrc}
                    />
                  ) : (
                    <Disc3 className="h-4 w-4 text-[var(--slate-10)]" />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    {isActivelyPlaying ? (
                      <span
                        aria-hidden="true"
                        className="inline-flex h-3 shrink-0 items-end gap-[1.5px]"
                      >
                        <span className="h-2 w-[2px] rounded-full bg-[var(--blue-9)] animate-[pulse_1s_ease-in-out_infinite]" />
                        <span className="h-3 w-[2px] rounded-full bg-[var(--blue-9)] animate-[pulse_1.3s_ease-in-out_infinite]" />
                        <span className="h-1.5 w-[2px] rounded-full bg-[var(--blue-9)] animate-[pulse_0.9s_ease-in-out_infinite]" />
                      </span>
                    ) : null}
                    <span className="truncate text-sm font-medium leading-snug text-[var(--slate-12)]">
                      {nowPlaying.title}
                    </span>
                  </div>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-[var(--slate-11)]">
                    {nowPlaying.artist ? (
                      <span className="truncate">{nowPlaying.artist}</span>
                    ) : null}
                    {nowPlaying.artist && nowPlaying.album ? (
                      <span
                        aria-hidden="true"
                        className="h-2.5 w-[0.5px] shrink-0 bg-[var(--slate-6)]"
                      />
                    ) : null}
                    {nowPlaying.album ? (
                      <span className="truncate text-[var(--slate-10)]" title={nowPlaying.album}>
                        {nowPlaying.album}
                      </span>
                    ) : null}
                  </div>
                </div>

                {activityMetric ? (
                  <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--slate-11)]">
                    {activityMetric}
                  </span>
                ) : null}
              </div>
            </>
          ) : null}

          {/* Footer: Optional Password Input + Host Info + Primary CTA */}
          <div aria-hidden="true" className="h-[0.5px] w-full bg-[var(--slate-6)]" />
          <form className="flex flex-col gap-3 px-4 py-3" onSubmit={handleSubmit}>
            {room.hasPassword ? (
              <div className="relative flex items-center">
                <Lock
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-[var(--slate-10)]"
                />
                <input
                  aria-label="房间密码"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoFocus
                  className="h-9 w-full rounded-lg border-hairline border-[var(--slate-7)] bg-[var(--slate-3)] pl-8 pr-3 text-sm text-[var(--slate-12)] caret-[var(--blue-9)] outline-none transition-colors duration-[250ms] ease-out placeholder:text-[var(--slate-10)] focus:border-[var(--blue-8)] focus:bg-[var(--slate-2)]"
                  onChange={(event) => {
                    setLocalError(null);
                    setPassword(event.target.value);
                  }}
                  placeholder="输入房间密码"
                  spellCheck="false"
                  type="password"
                  value={password}
                />
              </div>
            ) : null}

            {displayedError ? (
              <p
                className="rounded-lg border-hairline border-[var(--red-6)] bg-[var(--red-3)] px-3 py-2 text-xs text-[var(--red-11)]"
                role="alert"
              >
                {displayedError}
              </p>
            ) : null}

            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--slate-11)]">
                <span>房主</span>
                <span className="truncate max-w-[12rem] font-medium text-[var(--slate-12)]">
                  {room.directoryHostNickname || "未知"}
                </span>
              </div>

              <Button
                className="h-8 shrink-0 whitespace-nowrap rounded-lg bg-[var(--blue-9)] px-4 text-xs font-medium text-white transition-colors duration-[250ms] ease-out hover:bg-[var(--blue-10)]"
                data-testid="room-entry-confirm"
                disabled={isPending}
                size="sm"
                type="submit"
              >
                {isPending ? "进入中…" : room.directoryIsMember ? "回到房间" : "进入房间"}
              </Button>
            </div>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
