"use client";

import { useMemo, useState } from "react";
import type { AdminRoomSummary } from "@soqaro/shared";
import { ADMIN_CONFIRM_REASON, adminApi } from "@/lib/network/admin-api";
import { HealthText, formatTime, translatePlayback } from "../ui";

type RoomFilter = "all" | "active" | "playing" | "alert";

export function Rooms({ rooms, onRefresh }: { rooms: AdminRoomSummary[]; onRefresh: () => Promise<void> }) {
  const [filter, setFilter] = useState<RoomFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchAction, setBatchAction] = useState<"terminate" | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchMessage, setBatchMessage] = useState("");

  const filteredRooms = useMemo(() => {
    switch (filter) {
      case "active":
        return rooms.filter((r) => r.onlineMemberCount > 0);
      case "playing":
        return rooms.filter((r) => r.playbackStatus === "playing");
      case "alert":
        return rooms.filter((r) => r.health === "critical" || r.health === "degraded");
      default:
        return rooms;
    }
  }, [rooms, filter]);

  const allSelected = filteredRooms.length > 0 && filteredRooms.every((room) => selected.has(room.id));

  function toggleRoom(roomId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(roomId)) next.delete(roomId);
      else next.add(roomId);
      return next;
    });
    setBatchMessage("");
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(filteredRooms.map((room) => room.id)));
    setBatchMessage("");
  }

  async function runBatch() {
    const targets = filteredRooms.filter((room) => selected.has(room.id));
    if (!targets.length || batchBusy) return;
    setBatchBusy(true);
    setBatchMessage("");
    const results = await Promise.allSettled(
      targets.map((room) => adminApi.terminateRoom(room.id, room.joinCode, ADMIN_CONFIRM_REASON))
    );
    const failed = results.filter((result) => result.status === "rejected").length;
    setBatchBusy(false);
    setBatchAction(null);
    setSelected(new Set());
    setBatchMessage(
      failed
        ? `已处理 ${targets.length - failed} 个房间，${failed} 个失败`
        : `已结束 ${targets.length} 个房间`
    );
    await onRefresh();
  }

  function openRoom(roomId: string) {
    window.location.assign(`/admin/rooms/${encodeURIComponent(roomId)}`);
  }

  const filterOptions: Array<{ id: RoomFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: rooms.length },
    { id: "active", label: "活跃中", count: rooms.filter((r) => r.onlineMemberCount > 0).length },
    { id: "playing", label: "播放中", count: rooms.filter((r) => r.playbackStatus === "playing").length },
    { id: "alert", label: "告警与异常", count: rooms.filter((r) => r.health === "critical" || r.health === "degraded").length }
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold text-foreground">房间目录</h2>
        {/* 快捷状态筛选 */}
        <div className="flex items-center gap-1.5">
          {filterOptions.map((opt) => {
            const active = filter === opt.id;
            return (
              <button
                key={opt.id}
                onClick={() => setFilter(opt.id)}
                className={`px-2.5 py-1 rounded text-xs transition-colors border-[0.5px] ${
                  active
                    ? "bg-[var(--slate-5)] text-foreground border-[var(--slate-7)] font-medium"
                    : "bg-surface text-foreground-muted border-[var(--slate-6)] hover:text-foreground"
                }`}
              >
                {opt.label} ({opt.count})
              </button>
            );
          })}
        </div>
      </div>

      {selected.size ? (
        <div className="rounded-lg border-[0.5px] border-[var(--slate-6)] bg-surface p-3 flex items-center justify-between text-xs">
          <span className="text-foreground font-medium">已选 {selected.size} 个房间</span>
          <div className="flex items-center gap-2">
            <button
              className="rounded-md border-[0.5px] border-[var(--slate-6)] bg-surface px-2.5 py-1 text-xs hover:bg-[var(--slate-4)] transition-colors"
              onClick={() => setSelected(new Set())}
            >
              清空选择
            </button>
            <button
              className="rounded-md border-[0.5px] border-radix-red-6 bg-radix-red-3 px-2.5 py-1 text-xs text-radix-red-11 hover:bg-radix-red-4 transition-colors"
              onClick={() => setBatchAction("terminate")}
            >
              结束选中房间
            </button>
          </div>
        </div>
      ) : null}

      {batchAction ? (
        <div className="rounded-lg border-[0.5px] border-radix-red-6 bg-radix-red-3 p-3.5 flex items-center justify-between gap-4 text-xs">
          <div>
            <strong className="text-radix-red-11">确认结束选中的 {selected.size} 个房间</strong>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              className="rounded-md border-[0.5px] border-[var(--slate-6)] bg-surface px-2.5 py-1 text-xs hover:bg-[var(--slate-4)] transition-colors"
              onClick={() => setBatchAction(null)}
              disabled={batchBusy}
            >
              取消
            </button>
            <button
              className="rounded-md bg-radix-red-9 text-white px-2.5 py-1 text-xs hover:bg-radix-red-10 transition-colors disabled:opacity-50"
              onClick={() => void runBatch()}
              disabled={batchBusy}
            >
              {batchBusy ? "处理中..." : "确认结束"}
            </button>
          </div>
        </div>
      ) : null}

      {batchMessage ? (
        <div className="rounded-lg border-[0.5px] border-[var(--slate-6)] bg-surface p-2.5 text-xs text-foreground" role="status">
          {batchMessage}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border-[0.5px] border-[var(--slate-6)] bg-surface">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b-[0.5px] border-[var(--slate-6)] bg-surface-border/20 text-foreground-muted">
              <th className="py-2.5 px-3 w-8">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="全选房间"
                  className="rounded border-[var(--slate-6)] bg-surface text-accent focus:ring-0 focus:ring-offset-0"
                />
              </th>
              <th className="py-2.5 px-3 font-medium">房间</th>
              <th className="py-2.5 px-3 font-medium">健康度</th>
              <th className="py-2.5 px-3 font-medium">成员</th>
              <th className="py-2.5 px-3 font-medium">播放</th>
              <th className="py-2.5 px-3 font-medium">可见性</th>
              <th className="py-2.5 px-3 font-medium">更新时间</th>
              <th className="py-2.5 px-3 font-medium text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--slate-6)]/60">
            {filteredRooms.map((room) => {
              const signalColor =
                room.health === "critical"
                  ? "bg-radix-red-9"
                  : room.health === "degraded"
                  ? "bg-radix-amber-9"
                  : "bg-radix-green-9";
              return (
                <tr
                  key={room.id}
                  onClick={() => openRoom(room.id)}
                  className="cursor-pointer hover:bg-surface-border/15 transition-colors"
                >
                  <td
                    className="py-2 px-3 w-8"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(room.id)}
                      onChange={() => toggleRoom(room.id)}
                      aria-label={`选择房间 ${room.joinCode}`}
                      className="rounded border-[var(--slate-6)] bg-surface text-accent focus:ring-0 focus:ring-offset-0"
                    />
                  </td>
                  <td className="py-2 px-3">
                    <div className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${signalColor}`} />
                      <div>
                        <a
                          href={`/admin/rooms/${encodeURIComponent(room.id)}`}
                          onClick={(event) => event.stopPropagation()}
                          className="font-mono font-medium text-foreground hover:underline"
                        >
                          {room.joinCode}
                        </a>
                        <div className="text-xs text-foreground-muted">
                          {room.name || "未命名房间"} / 房主 {room.hostNickname || room.hostId}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="py-2 px-3">
                    <HealthText value={room.health} />
                  </td>
                  <td className="py-2 px-3 font-mono text-foreground-muted">
                    {room.onlineMemberCount}/{room.memberCount}
                  </td>
                  <td className="py-2 px-3">
                    <div className="text-foreground">{translatePlayback(room.playbackStatus)}</div>
                    <div className="text-xs text-foreground-muted truncate max-w-[140px]">
                      {room.currentTrackTitle || "未播放"}
                    </div>
                  </td>
                  <td className="py-2 px-3 font-mono text-foreground-muted">
                    {room.visibility === "private" ? "私密" : "公开"}
                  </td>
                  <td className="py-2 px-3 font-mono text-foreground-muted">
                    {formatTime(room.updatedAt)}
                  </td>
                  <td className="py-2 px-3 text-right">
                    <a
                      href={`/admin/rooms/${encodeURIComponent(room.id)}`}
                      onClick={(event) => event.stopPropagation()}
                      className="inline-block rounded border-[0.5px] border-[var(--slate-6)] bg-surface px-2 py-0.5 text-xs text-foreground hover:bg-[var(--slate-4)] transition-colors"
                    >
                      详情
                    </a>
                  </td>
                </tr>
              );
            })}
            {!filteredRooms.length ? (
              <tr>
                <td colSpan={8} className="py-8 text-center text-xs text-foreground-muted">
                  没有符合条件的房间
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
