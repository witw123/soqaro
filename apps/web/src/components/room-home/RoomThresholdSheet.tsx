"use client";

import React, { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Check, Copy, Lock, X } from "lucide-react";
import type { RoomDirectoryItem } from "@soqaro/shared";
import { Button } from "@/components/ui/button";
import { RoomStageSurface } from "@/components/room-card";
import { useBackHandler } from "@/lib/desktop/use-back-handler";
import { roomTypeDescription } from "./room-home-types";
import { formatRoomLiveMetric } from "./room-gallery-layout";

type RoomThresholdSheetProps = {
  room: RoomDirectoryItem;
  isPending: boolean;
  dialogError: string | null;
  stageTransitionActive: boolean;
  onClose: () => void;
  onConfirm: (password: string) => void;
};

export function RoomThresholdSheet({
  room: directoryItem,
  isPending,
  dialogError: initialDialogError,
  stageTransitionActive,
  onClose,
  onConfirm
}: RoomThresholdSheetProps) {
  const room = directoryItem.room;
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  useBackHandler(onClose);

  // Reset transient form state when room selection changes
  useEffect(() => {
    setPassword("");
    setLocalError(null);
    setCopiedCode(false);
  }, [room.id]);

  const displayedError = localError || initialDialogError;
  const liveMetric = formatRoomLiveMetric(directoryItem);

  const accessLabel = room.directoryIsMember
    ? "已在房间名单"
    : room.hasPassword
      ? "密码保护"
      : room.visibility === "private"
        ? "私密房间"
        : "公开直入";

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

  async function handleCopyCode() {
    try {
      await navigator.clipboard?.writeText(room.joinCode);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1500);
    } catch {
      // Ignore clipboard failures in restricted environments.
    }
  }

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && !isPending && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-black/75 backdrop-blur-xs transition-opacity duration-[250ms] ease-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="light-dialog-surface custom-scrollbar fixed inset-x-0 bottom-0 z-[calc(var(--z-modal)+1)] max-h-[min(calc(90*var(--app-dvh)),calc(100*var(--app-dvh)-env(safe-area-inset-top)-env(safe-area-inset-bottom)-1rem))] w-full overflow-x-hidden overflow-y-auto overscroll-contain rounded-t-[20px] border-hairline border-surface-border bg-background-secondary p-3.5 pb-[calc(0.875rem+env(safe-area-inset-bottom))] text-foreground shadow-2xl duration-[250ms] ease-out sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-[calc(100vw-2rem)] sm:max-w-[720px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[20px] sm:p-4"
        >
          {/* Handshake Progress Bar along top edge while entering room */}
          {isPending ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 h-[1.5px] overflow-hidden bg-surface"
            >
              <div className="h-full w-2/3 animate-pulse bg-accent" />
            </div>
          ) : null}

          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1.16fr)_minmax(0,1fr)] sm:gap-5">
            {/* Left Column: Shared-Element Stage Viewport + Room Metadata */}
            <div className="flex min-w-0 flex-col gap-2.5">
              <RoomStageSurface
                aspectClassName="aspect-[2.4/1]"
                room={directoryItem}
                stageTransitionName={stageTransitionActive ? "active-room-stage" : undefined}
              />

              {/* Concentric rounded-lg telemetry grid in bottom left */}
              <div className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 rounded-lg border-hairline border-surface-border bg-surface p-2.5 text-xs">
                <div className="min-w-0">
                  <span className="block truncate text-foreground-muted">房主</span>
                  <span className="mt-0.5 block truncate font-medium text-foreground">
                    {room.directoryHostNickname || "未知"}
                  </span>
                </div>
                <div className="min-w-0">
                  <span className="block truncate text-foreground-muted">房间码</span>
                  <button
                    aria-label={`复制房间码 ${room.joinCode}`}
                    className="mt-0.5 inline-flex max-w-full items-center gap-1.5 font-mono tabular-nums text-foreground transition-colors duration-[250ms] ease-out hover:text-accent cursor-pointer"
                    onClick={() => void handleCopyCode()}
                    type="button"
                  >
                    <span className="truncate">{copiedCode ? "已复制" : room.joinCode}</span>
                    {copiedCode ? (
                      <Check className="h-3 w-3 shrink-0 text-[var(--green-11)]" />
                    ) : (
                      <Copy className="h-3 w-3 shrink-0 opacity-65" />
                    )}
                  </button>
                </div>
                <div className="min-w-0">
                  <span className="block truncate text-foreground-muted">状态</span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1 font-medium text-foreground">
                    {room.hasPassword ? <Lock className="h-3 w-3 shrink-0 text-foreground-muted" /> : null}
                    <span className="truncate">{accessLabel}</span>
                  </span>
                </div>
                <div className="min-w-0">
                  <span className="block truncate text-foreground-muted">{liveMetric.label}</span>
                  <span className="mt-0.5 block truncate font-mono tabular-nums text-foreground">
                    {liveMetric.value}
                  </span>
                </div>
              </div>
            </div>

            {/* Right Column: Title, Description & Entry Form */}
            <form className="flex min-w-0 flex-col justify-between gap-3 pt-0.5" onSubmit={handleSubmit}>
              <div className="flex min-w-0 flex-col gap-2.5">
                <div className="relative min-w-0 pr-8">
                  <DialogPrimitive.Title className="line-clamp-2 break-words text-lg font-semibold leading-snug tracking-tight text-foreground">
                    {room.name ?? "未命名房间"}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Close
                    aria-label="关闭"
                    className="absolute right-0 top-0 inline-flex h-7 w-7 items-center justify-center rounded-lg text-foreground-muted transition-colors duration-[250ms] ease-out hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none cursor-pointer"
                    disabled={isPending}
                  >
                    <X className="h-4 w-4" />
                  </DialogPrimitive.Close>
                </div>

                <DialogPrimitive.Description className="max-h-[140px] overflow-y-auto custom-scrollbar whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground-muted">
                  {room.description?.trim() || roomTypeDescription(room.roomType)}
                </DialogPrimitive.Description>

                {room.hasPassword ? (
                  <label className="mt-1 flex flex-col gap-1.5 text-xs font-medium text-foreground">
                    <span>房间密码</span>
                    <input
                      autoCapitalize="none"
                      autoCorrect="off"
                      autoFocus
                      className="rounded-lg border-hairline border-surface-border bg-background px-3 py-2 text-sm text-foreground caret-accent outline-none placeholder:text-foreground-muted focus:border-accent focus:ring-1 focus:ring-accent"
                      onChange={(event) => {
                        setLocalError(null);
                        setPassword(event.target.value);
                      }}
                      placeholder="请输入房间密码"
                      spellCheck="false"
                      type="password"
                      value={password}
                    />
                  </label>
                ) : null}

                {displayedError ? (
                  <p
                    className="rounded-lg border-hairline border-[var(--red-6)] bg-[var(--red-3)] px-3 py-2 text-xs text-[var(--red-11)]"
                    role="alert"
                  >
                    {displayedError}
                  </p>
                ) : null}
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <Button
                  className="h-8 shrink-0 whitespace-nowrap rounded-lg px-3 text-xs"
                  disabled={isPending}
                  onClick={onClose}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  收起
                </Button>
                <Button
                  className="h-8 shrink-0 whitespace-nowrap rounded-lg bg-accent px-4 text-xs font-medium text-white transition-colors duration-[250ms] ease-out hover:bg-accent-hover"
                  data-testid="room-entry-confirm"
                  disabled={isPending}
                  size="sm"
                  type="submit"
                >
                  {isPending ? "进入中…" : room.directoryIsMember ? "回到房间" : "进入房间"}
                </Button>
              </div>
            </form>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
