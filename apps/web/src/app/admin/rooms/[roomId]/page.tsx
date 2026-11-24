"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { RoomChatMessage } from "@soqaro/shared";
import { adminApi, AdminApiError, ADMIN_CONFIRM_REASON, type AdminRoomDetail } from "@/lib/network/admin-api";
import {
  DataList,
  DataPanel,
  DetailRow,
  HealthText,
  InfoPanel,
  Metric,
  PanelHeader,
  formatDateTime,
  translatePlayback,
  translateStatus
} from "../../ui";

type RoomMember = { id?: string; nickname?: string; peerId?: string | null; presenceState?: string; role?: string; joinedAt?: string };
type JsonRecord = Record<string, unknown>;

export default function AdminRoomDetailPage() {
  const params = useParams<{ roomId: string }>();
  const router = useRouter();
  const [room, setRoom] = useState<AdminRoomDetail | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [action, setAction] = useState<"terminate" | null>(null);
  const [actionError, setActionError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [controlMessage, setControlMessage] = useState("");
  const [playbackBusy, setPlaybackBusy] = useState(false);
  const [kickingMemberId, setKickingMemberId] = useState<string | null>(null);

  // 聊天审查
  const [chatMessages, setChatMessages] = useState<RoomChatMessage[]>([]);
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);

  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setRefreshing(true);
    try {
      setError("");
      const [detail, chatRes] = await Promise.all([
        adminApi.room(params.roomId),
        adminApi.listChat(params.roomId, 50).catch(() => ({ data: [] }))
      ]);
      setRoom(detail);
      setChatMessages(chatRes.data);
    } catch (cause) {
      if (cause instanceof AdminApiError && (cause.status === 401 || cause.status === 403)) router.replace("/admin/login");
      else setError(cause instanceof Error ? cause.message : "加载房间监测数据失败。");
    } finally {
      loadingRef.current = false;
      setRefreshing(false);
    }
  }, [params.roomId, router]);

  useEffect(() => {
    void load();
    const refreshIfVisible = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refreshIfVisible, 4000);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [load]);

  async function confirmTerminate() {
    if (!room || actionBusy) return;
    setActionError("");
    setActionBusy(true);
    try {
      await adminApi.terminateRoom(room.id, room.joinCode, ADMIN_CONFIRM_REASON);
      router.replace("/admin");
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "结束房间失败，请刷新后重试。");
    } finally {
      setActionBusy(false);
    }
  }

  async function runPlaybackControl(playbackAction: "pause" | "play" | "next" | "clear-queue") {
    if (!room || playbackBusy) return;
    setPlaybackBusy(true);
    setControlMessage("");
    try {
      await adminApi.controlPlayback(room.id, playbackAction, ADMIN_CONFIRM_REASON);
      const actionText =
        playbackAction === "pause"
          ? "已发送远程暂停信令"
          : playbackAction === "play"
          ? "已发送远程播放信令"
          : playbackAction === "next"
          ? "已跳过当前曲目"
          : "已清空播放队列";
      setControlMessage(actionText);
      await load();
    } catch (cause) {
      setControlMessage(cause instanceof Error ? cause.message : "播放控制操作失败。");
    } finally {
      setPlaybackBusy(false);
    }
  }

  async function kickMember(memberId: string) {
    if (!room || kickingMemberId) return;
    setKickingMemberId(memberId);
    setControlMessage("");
    try {
      await adminApi.kickMember(room.id, memberId, ADMIN_CONFIRM_REASON);
      setControlMessage("已将成员移出房间并断开连接。");
      await load();
    } catch (cause) {
      setControlMessage(cause instanceof Error ? cause.message : "移出成员失败。");
    } finally {
      setKickingMemberId(null);
    }
  }

  async function deleteChatMessage(messageId: string) {
    if (!room || deletingMessageId) return;
    setDeletingMessageId(messageId);
    try {
      await adminApi.deleteChat(room.id, messageId, ADMIN_CONFIRM_REASON);
      setChatMessages((prev) => prev.filter((m) => m.id !== messageId));
    } catch (cause) {
      setControlMessage(cause instanceof Error ? cause.message : "删除聊天消息失败。");
    } finally {
      setDeletingMessageId(null);
    }
  }

  if (error) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
        <div className="rounded-lg border-[0.5px] border-radix-red-6 bg-radix-red-3 p-4 text-xs text-radix-red-11 flex flex-col gap-2 max-w-md">
          <p>{error}</p>
          <button className="underline hover:no-underline text-left text-foreground font-medium" onClick={() => void load()}>
            重新尝试
          </button>
        </div>
      </main>
    );
  }

  if (!room) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background text-foreground">
        <div className="text-xs text-foreground-muted">正在加载房间监测数据...</div>
      </main>
    );
  }

  const members = asRecords(room.members) as RoomMember[];
  const tracks = asRecords(room.tracks);
  const queue = asRecords(room.queue);
  const playback = asRecord(room.playback);
  const currentTrackId = stringValue(playback.currentTrackId);
  const currentTrackTitle = room.currentTrackTitle ?? stringValue(tracks.find((track) => track.id === currentTrackId)?.title) ?? "未播放";
  const isPlaying = room.playbackStatus === "playing";

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="h-12 border-b-[0.5px] border-[var(--slate-6)] px-6 flex items-center justify-between bg-surface/50 backdrop-blur-sm sticky top-0 z-20">
        <button
          className="inline-flex items-center gap-1.5 text-xs text-foreground-muted hover:text-foreground transition-colors"
          onClick={() => router.back()}
        >
          <span>←</span> 返回房间监测
        </button>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-foreground-muted">
            <span className="w-1.5 h-1.5 rounded-full bg-radix-green-9" />
            {refreshing ? "同步中" : "实时数据"}
          </span>
          <button
            className="h-7 px-2.5 rounded border-[0.5px] border-[var(--slate-6)] bg-surface hover:bg-surface-border/40 text-xs text-foreground transition-colors disabled:opacity-50"
            onClick={() => void load()}
            disabled={refreshing}
          >
            刷新
          </button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div>
          <div className="flex items-baseline gap-3">
            <h1 className="text-xl font-mono font-semibold tracking-tight text-foreground">{room.joinCode}</h1>
            <span className="text-sm text-foreground-muted">{room.name ?? "未命名房间"}</span>
          </div>
          <p className="mt-0.5 text-xs text-foreground-muted">每 4 秒自动采样一次在线拓扑状态</p>
        </div>

        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Metric label="健康度" value={translateStatus(room.health)} />
          <Metric label="在线成员" value={`${room.onlineMemberCount}/${room.memberCount}`} />
          <Metric label="诊断覆盖" value={`${room.telemetryCoverage?.reported ?? 0}/${room.telemetryCoverage?.total ?? 0}`} />
          <Metric label="播放状态" value={translatePlayback(room.playbackStatus)} />
        </section>

        {controlMessage ? (
          <div className="rounded-lg border-[0.5px] border-[var(--slate-6)] bg-surface-border/20 p-2.5 text-xs text-foreground" role="status">
            {controlMessage}
          </div>
        ) : null}

        {/* 房间治理与播放控制 */}
        <section className="rounded-lg border-[0.5px] border-[var(--slate-6)] bg-surface overflow-hidden">
          <PanelHeader title="房间管控与干预" hint="远程播放调度、违规清理与解散" />
          <div className="p-3.5 space-y-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                className="h-7 px-3 rounded border-[0.5px] border-[var(--slate-6)] bg-surface hover:bg-surface-border/40 text-xs text-foreground transition-colors disabled:opacity-50"
                onClick={() => void runPlaybackControl(isPlaying ? "pause" : "play")}
                disabled={playbackBusy}
              >
                {isPlaying ? "远程暂停" : "远程播放"}
              </button>

              <button
                className="h-7 px-3 rounded border-[0.5px] border-[var(--slate-6)] bg-surface hover:bg-surface-border/40 text-xs text-foreground transition-colors disabled:opacity-50"
                onClick={() => void runPlaybackControl("next")}
                disabled={playbackBusy}
              >
                跳过当前曲目
              </button>

              <button
                className="h-7 px-3 rounded border-[0.5px] border-radix-amber-6 bg-radix-amber-3 hover:opacity-90 text-radix-amber-11 text-xs transition-colors disabled:opacity-50"
                onClick={() => void runPlaybackControl("clear-queue")}
                disabled={playbackBusy}
              >
                清空队列
              </button>

              <div className="h-4 w-px bg-[var(--slate-6)] mx-1" />

              <button
                className="h-7 px-3 rounded border-[0.5px] border-radix-red-6 hover:bg-radix-red-3 text-radix-red-11 text-xs font-medium transition-colors"
                onClick={() => { setAction("terminate"); setActionError(""); }}
              >
                结束房间
              </button>
            </div>

            {action === "terminate" ? (
              <div className="rounded-md border-[0.5px] border-radix-red-6 bg-radix-red-3/50 p-3.5 flex flex-col gap-3">
                <div>
                  <strong className="text-xs font-semibold text-radix-red-11">确认永久结束此房间</strong>
                  <p className="mt-0.5 text-xs text-foreground-muted">结束后会清理房间状态、播放队列，并通知在线成员断开退出。</p>
                </div>
                <div className="text-xs text-foreground-muted">
                  目标房间：<span className="font-mono font-medium text-foreground">{room.joinCode}</span> / {room.name ?? "未命名房间"}
                </div>
                {actionError ? <p className="text-xs text-radix-red-11">{actionError}</p> : null}
                <div className="flex items-center gap-2">
                  <button
                    className="h-7 px-3 rounded border-[0.5px] border-[var(--slate-6)] bg-surface hover:bg-surface-border/40 text-xs transition-colors"
                    onClick={() => { setAction(null); setActionError(""); }}
                    disabled={actionBusy}
                  >
                    取消
                  </button>
                  <button
                    className="h-7 px-3 rounded bg-radix-red-9 hover:opacity-90 text-white text-xs font-medium transition-colors disabled:opacity-50"
                    onClick={() => void confirmTerminate()}
                    disabled={actionBusy}
                  >
                    {actionBusy ? "处理中..." : "确认结束房间"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <InfoPanel title="房间信息">
            <DetailRow label="房间码" value={room.joinCode} mono />
            <DetailRow label="房间 ID" value={room.id} mono />
            <DetailRow label="房间名称" value={room.name ?? "未命名房间"} />
            <DetailRow label="房间描述" value={room.description ?? "-"} />
            <DetailRow label="可见性" value={room.visibility === "private" ? "私密" : "公开"} />
            <DetailRow label="房主" value={room.hostNickname ?? room.hostId} />
            <DetailRow label="创建时间" value={formatDateTime(room.createdAt)} />
            <DetailRow label="更新时间" value={formatDateTime(room.updatedAt)} />
          </InfoPanel>
          <InfoPanel title="播放状态">
            <DetailRow label="状态" value={translatePlayback(room.playbackStatus)} />
            <DetailRow label="当前曲目" value={currentTrackTitle} />
            <DetailRow label="曲目 ID" value={currentTrackId ?? "-"} mono />
            <DetailRow label="播放位置" value={`${numberValue(playback.positionMs) ?? 0} ms`} mono />
            <DetailRow label="播放源" value={stringValue(playback.sourceSessionId) ?? "-"} mono />
            <DetailRow label="播放版本" value={stringValue(playback.playbackRevision) ?? "-"} mono />
          </InfoPanel>
        </section>

        {/* 成员管理 */}
        <DataPanel title="成员管理与诊断" hint={`${members.length} 位成员`}>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-surface-border text-foreground-muted font-mono text-xs">
                <th className="py-2.5 px-3 font-normal">成员</th>
                <th className="py-2.5 px-3 font-normal">状态</th>
                <th className="py-2.5 px-3 font-normal">Peer ID</th>
                <th className="py-2.5 px-3 font-normal">角色</th>
                <th className="py-2.5 px-3 font-normal">加入时间</th>
                <th className="py-2.5 px-3 font-normal text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border/50">
              {members.length ? (
                members.map((member, index) => (
                  <tr key={member.id ?? index} className="hover:bg-surface-border/15 transition-colors">
                    <td className="py-2.5 px-3">
                      <div className="font-medium text-foreground">{member.nickname ?? member.id ?? "未知"}</div>
                      <div className="text-xs font-mono text-foreground-muted">{member.id ?? "-"}</div>
                    </td>
                    <td className="py-2.5 px-3"><HealthText value={member.presenceState ?? "offline"} /></td>
                    <td className="py-2.5 px-3 font-mono text-foreground-muted">{member.peerId ?? "-"}</td>
                    <td className="py-2.5 px-3 font-mono text-foreground-muted">{member.role === "host" ? "房主" : "成员"}</td>
                    <td className="py-2.5 px-3 font-mono text-foreground-muted">{formatDateTime(member.joinedAt)}</td>
                    <td className="py-2.5 px-3 text-right">
                      {member.id ? (
                        <button
                          className="rounded border-[0.5px] border-radix-red-6 bg-radix-red-3 px-2 py-0.5 text-xs text-radix-red-11 hover:opacity-90 transition-colors disabled:opacity-50"
                          onClick={() => void kickMember(member.id!)}
                          disabled={kickingMemberId === member.id}
                        >
                          {kickingMemberId === member.id ? "移出中..." : "移出房间"}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-xs text-foreground-muted">暂无成员数据。</td>
                </tr>
              )}
            </tbody>
          </table>
        </DataPanel>

        {/* 房间聊天内容审查面板 */}
        <DataPanel title="房间聊天审查" hint={`最近 ${chatMessages.length} 条发言`}>
          <div className="divide-y divide-[var(--slate-6)]/60 max-h-72 overflow-y-auto">
            {chatMessages.length ? (
              chatMessages.map((msg) => (
                <div key={msg.id} className="p-3 flex items-start justify-between gap-3 text-xs hover:bg-surface-border/10 transition-colors">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{msg.senderName}</span>
                      <span className="text-xs font-mono text-foreground-muted">
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-foreground-muted break-words">{msg.content}</p>
                  </div>
                  <button
                    className="rounded border-[0.5px] border-radix-red-6 bg-radix-red-3 px-2 py-0.5 text-xs text-radix-red-11 hover:opacity-90 transition-colors shrink-0 disabled:opacity-50"
                    onClick={() => void deleteChatMessage(msg.id)}
                    disabled={deletingMessageId === msg.id}
                  >
                    {deletingMessageId === msg.id ? "删除中..." : "删除违规发言"}
                  </button>
                </div>
              ))
            ) : (
              <div className="p-6 text-center text-xs text-foreground-muted">该房间暂无聊天发言记录。</div>
            )}
          </div>
        </DataPanel>

        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <DataPanel title="播放队列" hint={`${queue.length} 项`}>
            <DataList
              rows={queue}
              empty="当前没有排队曲目。"
              render={(item, index) => (
                <div className="flex items-center gap-3 py-2 px-3 hover:bg-surface-border/20 text-xs">
                  <span className="w-5 text-center font-mono text-foreground-muted text-xs">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-foreground truncate">{stringValue(item.title) ?? stringValue(item.trackId) ?? "未知曲目"}</div>
                    <div className="text-xs text-foreground-muted truncate">{stringValue(item.requestedBy) ?? "未知成员"}</div>
                  </div>
                </div>
              )}
            />
          </DataPanel>
          <DataPanel title="房间曲库" hint={`${tracks.length} 首`}>
            <DataList
              rows={tracks}
              empty="当前没有曲目。"
              render={(item) => (
                <div className="flex items-center justify-between py-2 px-3 hover:bg-surface-border/20 text-xs gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-foreground truncate">{stringValue(item.title) ?? "未命名曲目"}</div>
                    <div className="text-xs text-foreground-muted truncate">{stringValue(item.artist) ?? "未知艺术家"}</div>
                  </div>
                  <span className="font-mono text-xs text-foreground-muted flex-shrink-0">{stringValue(item.fileHash)?.slice(0, 8) ?? "-"}</span>
                </div>
              )}
            />
          </DataPanel>
        </section>
      </div>
    </main>
  );
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? (value.filter((item): item is JsonRecord => Boolean(item && typeof item === "object")) as JsonRecord[]) : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && !Number.isNaN(value) ? value : null;
}
