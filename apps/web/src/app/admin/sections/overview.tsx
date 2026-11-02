"use client";

import { useEffect, useState } from "react";
import type { AdminIncident, AdminOverview, AdminRoomSummary, AdminTrackStats } from "@soqaro/shared";
import { adminApi } from "@/lib/network/admin-api";
import {
  AuditPanel,
  Icon,
  IncidentPanel,
  Metric,
  PanelHeader,
  RoomRow,
  SystemHealth,
  type AuditRow
} from "../ui";

export function Overview({
  overview,
  rooms,
  incidents,
  audit,
  onRooms
}: {
  overview: AdminOverview | null;
  rooms: AdminRoomSummary[];
  incidents: AdminIncident[];
  audit: AuditRow[];
  onRooms: () => void;
}) {
  const [trackStats, setTrackStats] = useState<AdminTrackStats | null>(null);

  useEffect(() => {
    adminApi.trackStats().then(setTrackStats).catch(() => undefined);
  }, []);

  const activeRooms = rooms.filter((room) => room.onlineMemberCount > 0).slice(0, 6);

  const roomTone =
    (overview?.rooms.critical ?? 0) > 0
      ? "red"
      : (overview?.rooms.degraded ?? 0) > 0
      ? "amber"
      : "green";

  const incidentTone = (overview?.openIncidents ?? 0) > 0 ? "red" : "default";

  const totalTracks = trackStats?.totalTracks ?? 0;
  const sourceDist = trackStats?.sourceDistribution ?? {};

  const sources: Array<{ key: string; label: string; count: number; badgeColor: string }> = [
    { key: "bilibili", label: "哔哩哔哩", count: sourceDist.bilibili ?? 0, badgeColor: "text-radix-blue-11 bg-radix-blue-3 border-radix-blue-6" },
    { key: "netease", label: "网易云", count: sourceDist.netease ?? 0, badgeColor: "text-radix-red-11 bg-radix-red-3 border-radix-red-6" },
    { key: "qqmusic", label: "QQ音乐", count: sourceDist.qqmusic ?? 0, badgeColor: "text-radix-green-11 bg-radix-green-3 border-radix-green-6" },
    { key: "local_upload", label: "本地上传", count: sourceDist.local_upload ?? 0, badgeColor: "text-radix-amber-11 bg-radix-amber-3 border-radix-amber-6" },
    { key: "alist", label: "Alist网盘", count: sourceDist.alist ?? 0, badgeColor: "text-foreground-muted bg-surface border-[var(--slate-6)]" }
  ];

  return (
    <div className="space-y-6">
      {/* 4 项核心数据监视卡片 */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" aria-label="关键运行指标">
        <Metric
          label="在线用户"
          value={overview?.users.online ?? 0}
          meta={`连接数 ${overview?.network.wsConnections ?? 0}`}
          badge={`用户池 ${overview?.users.total ?? 0}`}
          tone="blue"
        />
        <Metric
          label="活跃房间"
          value={overview?.rooms.active ?? 0}
          meta={`正在播放 ${overview?.playback.active ?? 0}`}
          badge={`房间总数 ${overview?.rooms.total ?? 0}`}
          tone="green"
        />
        <Metric
          label="健康房间"
          value={overview?.rooms.healthy ?? 0}
          meta={`降级 ${overview?.rooms.degraded ?? 0} / 异常 ${overview?.rooms.critical ?? 0}`}
          tone={roomTone}
        />
        <Metric
          label="异常与冲突"
          value={overview?.openIncidents ?? 0}
          meta={`播放冲突 ${overview?.network.playbackConflicts ?? 0} / ICE 异常 ${overview?.network.iceFailures ?? 0}`}
          tone={incidentTone}
        />
      </section>

      {/* 曲库音源分布概览 */}
      <section className="rounded-lg border-[0.5px] border-[var(--slate-6)] bg-surface p-3.5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground">全站曲库与音源分布</span>
            <span className="text-xs text-foreground-muted">收录 {totalTracks} 首</span>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {sources.map((item) => {
            const percentage = totalTracks > 0 ? Math.round((item.count / totalTracks) * 100) : 0;
            return (
              <div
                key={item.key}
                className="rounded-md border-[0.5px] border-[var(--slate-6)] bg-[var(--slate-2)] p-2.5 flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs text-foreground-muted">{item.label}</span>
                  <span className={`px-1.5 py-0.2 rounded text-[11px] font-mono border-[0.5px] ${item.badgeColor}`}>
                    {percentage}%
                  </span>
                </div>
                <div className="mt-2 text-sm font-semibold tracking-tight text-foreground font-mono">
                  {item.count} 首
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 活跃房间与系统健康 */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 rounded-lg border-[0.5px] border-[var(--slate-6)] bg-surface flex flex-col">
          <PanelHeader
            title="活跃房间"
            hint={activeRooms.length ? `${activeRooms.length} 个运行中` : undefined}
            action={
              <button
                className="inline-flex items-center gap-1 text-xs text-foreground-muted hover:text-foreground transition-colors"
                onClick={onRooms}
              >
                <span>全部房间</span>
                <Icon name="arrow" size={12} />
              </button>
            }
          />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b-[0.5px] border-[var(--slate-6)] bg-surface-border/20 text-foreground-muted">
                  <th className="py-2.5 px-3 font-medium">房间码</th>
                  <th className="py-2.5 px-3 font-medium">状态</th>
                  <th className="py-2.5 px-3 font-medium">成员</th>
                  <th className="py-2.5 px-3 font-medium">播放状态</th>
                  <th className="py-2.5 px-3 font-medium">活跃更新</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--slate-6)]/60">
                {activeRooms.length ? (
                  activeRooms.map((room) => <RoomRow key={room.id} room={room} />)
                ) : (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-xs text-foreground-muted">
                      暂无活跃房间
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-lg border-[0.5px] border-[var(--slate-6)] bg-surface">
          <SystemHealth overview={overview} />
        </div>
      </section>

      {/* 异常队列与管理审计 */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <IncidentPanel rows={incidents.slice(0, 4)} />
        <AuditPanel rows={audit.slice(0, 4)} />
      </section>
    </div>
  );
}
