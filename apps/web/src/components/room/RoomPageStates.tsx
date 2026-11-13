"use client";

import Link from "next/link";
import type { Route } from "next";
import { Button } from "@/components/ui/button";

export function RoomTransitionState({
  isNavigatingRoomExit,
  isRecoveringRoom
}: {
  isNavigatingRoomExit: boolean;
  isRecoveringRoom: boolean;
}) {
  return (
    <section className="flex min-h-[60vh] flex-col items-center justify-center px-4 pt-12 text-center animate-fade-in">
      <div className="mb-6 h-16 w-16 rounded-full border border-surface-border bg-surface flex items-center justify-center text-accent">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
      <h2 className="mb-3 text-2xl font-bold text-foreground">
        {isNavigatingRoomExit ? "正在离开房间" : "正在连接房间"}
      </h2>
      <p className="max-w-sm text-sm leading-relaxed text-foreground-muted">
        {isNavigatingRoomExit
          ? "正在返回房间列表，请稍候。"
          : isRecoveringRoom
            ? "正在恢复房间状态并连接实时链路，请稍候。"
            : "正在恢复房间状态，请稍候。"}
      </p>
    </section>
  );
}

export function EmptyRoomState({
  activeSession,
  workspaceEntryHref,
  authEntryHref,
  onClearIdentity,
  onRetryRecovery
}: {
  activeSession: unknown;
  workspaceEntryHref: string;
  authEntryHref: string;
  onClearIdentity: () => void;
  onRetryRecovery?: () => void;
}) {
  return (
    <section className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4 animate-fade-in pt-12">
      <div className="w-16 h-16 rounded-full bg-surface border border-surface-border flex items-center justify-center mb-6 text-foreground-muted">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      </div>
      <h2 className="text-2xl font-bold text-foreground mb-4">当前没有可用的房间</h2>
      <p className="text-sm text-foreground-muted max-w-sm mb-8 leading-relaxed">
        {activeSession
          ? "这个地址没有恢复到有效房间。可重试连接，或回到房间列表重新创建与加入。"
          : "你还没有登录。先进入登录页，再回到房间列表继续。"}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-4">
        <Link href={workspaceEntryHref as Route}>
          <Button size="lg">返回房间列表</Button>
        </Link>
        {activeSession && onRetryRecovery ? (
          <Button variant="outline" onClick={onRetryRecovery} type="button">
            重新连接房间
          </Button>
        ) : null}
        {activeSession ? (
          <Button variant="ghost" onClick={onClearIdentity} type="button">
            清除当前会话状态
          </Button>
        ) : (
          <Link href={authEntryHref as Route}>
            <Button variant="ghost">去登录</Button>
          </Link>
        )}
      </div>
    </section>
  );
}
