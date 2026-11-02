"use client";

import { useCallback, useEffect, useState } from "react";
import type { AdminMaintenanceResult, AdminOverview, AdminProviderHealth } from "@soqaro/shared";
import { adminApi } from "@/lib/network/admin-api";
import { HealthRow, HealthText, Icon, PanelHeader, formatUptime, translateRedisMode } from "../ui";

export function System({ overview }: { overview: AdminOverview | null }) {
  const [providers, setProviders] = useState<AdminProviderHealth[]>([]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  // 自愈与运维
  const [maintaining, setMaintaining] = useState(false);
  const [maintenanceResult, setMaintenanceResult] = useState<AdminMaintenanceResult | null>(null);
  const [maintenanceError, setMaintenanceError] = useState("");

  const checkProviders = useCallback(async () => {
    setChecking(true);
    setError("");
    try {
      const res = await adminApi.providerHealth();
      setProviders(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "检测音源连通性失败");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkProviders();
  }, [checkProviders]);

  async function handleMaintenance() {
    setMaintaining(true);
    setMaintenanceError("");
    try {
      const result = await adminApi.runMaintenance();
      setMaintenanceResult(result);
    } catch (err) {
      setMaintenanceError(err instanceof Error ? err.message : "执行系统自愈维护失败");
    } finally {
      setMaintaining(false);
    }
  }

  const prismaUp = overview?.dependencies.prisma === "up";
  const redisUp = overview?.dependencies.redis === "up";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xs font-semibold text-foreground">服务运行时与依赖诊断</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="inline-flex items-center gap-1.5 rounded-md border-[0.5px] border-[var(--slate-6)] bg-surface px-2.5 py-1 text-xs hover:bg-[var(--slate-4)] transition-colors disabled:opacity-50"
            onClick={() => void handleMaintenance()}
            disabled={maintaining}
          >
            <Icon name="refresh" size={12} className={maintaining ? "animate-spin" : ""} />
            <span>{maintaining ? "正在执行清理..." : "一键自愈与清理"}</span>
          </button>
          <button
            className="inline-flex items-center gap-1.5 rounded-md border-[0.5px] border-[var(--slate-6)] bg-surface px-2.5 py-1 text-xs hover:bg-[var(--slate-4)] transition-colors disabled:opacity-50"
            onClick={() => void checkProviders()}
            disabled={checking}
          >
            <Icon name="refresh" size={12} className={checking ? "animate-spin" : ""} />
            <span>{checking ? "探测中..." : "探测外部音源"}</span>
          </button>
        </div>
      </div>

      {/* 自愈维护结果提示 */}
      {maintenanceResult ? (
        <div className="rounded-lg border-[0.5px] border-radix-green-6 bg-radix-green-3 p-3 text-xs text-radix-green-11 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span>
              已完成自愈清理：清理过期会话 {maintenanceResult.cleanedSessions} 条，清理失效房间墓碑 {maintenanceResult.cleanedTombstones} 条
            </span>
            {maintenanceResult.redisLatencyMs !== null ? (
              <span className="font-mono">Redis 探测延时 {maintenanceResult.redisLatencyMs}ms</span>
            ) : null}
          </div>
          <button
            className="hover:underline text-[11px]"
            onClick={() => setMaintenanceResult(null)}
          >
            关闭
          </button>
        </div>
      ) : null}

      {maintenanceError ? (
        <div className="rounded-lg border-[0.5px] border-radix-red-6 bg-radix-red-3 p-3 text-xs text-radix-red-11">
          {maintenanceError}
        </div>
      ) : null}

      {/* 运行时服务与网络网关遥测 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-lg border-[0.5px] border-[var(--slate-6)] bg-surface">
          <PanelHeader title="基础设施依赖" />
          <div className="p-3.5 space-y-1">
            <HealthRow
              label="PostgreSQL 数据库"
              value={prismaUp ? "正常" : "异常"}
              status={prismaUp ? "healthy" : "critical"}
            />
            <HealthRow
              label="Redis 存储服务"
              value={
                redisUp
                  ? `正常 (${translateRedisMode(overview?.dependencies.redisMode ?? "")})`
                  : "异常"
              }
              status={redisUp ? "healthy" : "critical"}
            />
            <HealthRow
              label="在线服务实例"
              value={`${overview?.instances ?? 0} 个`}
              status="info"
            />
            {overview?.runtime ? (
              <>
                <HealthRow
                  label="进程运行时长"
                  value={formatUptime(overview.runtime.uptimeSeconds)}
                />
                <HealthRow
                  label="V8 堆内存"
                  value={`${overview.runtime.memoryHeapUsedMb} MB / ${overview.runtime.memoryHeapTotalMb} MB`}
                />
                <HealthRow
                  label="物理常驻内存 (RSS)"
                  value={`${overview.runtime.memoryRssMb} MB`}
                />
              </>
            ) : null}
          </div>
        </div>

        <div className="rounded-lg border-[0.5px] border-[var(--slate-6)] bg-surface">
          <PanelHeader title="网络网关与同步遥测" />
          <div className="p-3.5 space-y-1">
            <HealthRow
              label="WebSocket 实时连接"
              value={`${overview?.network.wsConnections ?? 0} 个活跃会话`}
              status="info"
            />
            <HealthRow
              label="实时房间数"
              value={`${overview?.rooms.active ?? 0} / ${overview?.rooms.total ?? 0}`}
            />
            <HealthRow
              label="播放控制冲突计数"
              value={`${overview?.network.playbackConflicts ?? 0} 次`}
              status={(overview?.network.playbackConflicts ?? 0) > 0 ? "degraded" : "healthy"}
            />
            <HealthRow
              label="WebRTC ICE 穿透失败"
              value={`${overview?.network.iceFailures ?? 0} 次`}
              status={(overview?.network.iceFailures ?? 0) > 0 ? "critical" : "healthy"}
            />
            <HealthRow
              label="实时广播/同步异常"
              value={`${overview?.network.realtimeFailures ?? 0} 次`}
              status={(overview?.network.realtimeFailures ?? 0) > 0 ? "critical" : "healthy"}
            />
          </div>
        </div>
      </div>

      {/* 外部音源健康看板 */}
      <div className="rounded-lg border-[0.5px] border-[var(--slate-6)] bg-surface">
        <PanelHeader title="外部音频源连通性" />
        {error ? (
          <div className="p-3 text-xs text-radix-red-11 bg-radix-red-3 border-b-[0.5px] border-[var(--slate-6)]">
            {error}
          </div>
        ) : null}
        <div className="divide-y divide-[var(--slate-6)]/60">
          {providers.length ? (
            providers.map((item) => (
              <div key={item.provider} className="p-3.5 flex items-center justify-between gap-4 text-xs">
                <div className="flex items-center gap-3">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      item.status === "healthy"
                        ? "bg-radix-green-9"
                        : item.status === "degraded"
                        ? "bg-radix-amber-9"
                        : "bg-radix-red-9"
                    }`}
                  />
                  <div>
                    <div className="font-medium text-foreground">{item.name}</div>
                    <div className="text-xs text-foreground-muted mt-0.5">{item.message ?? "就绪"}</div>
                  </div>
                </div>

                <div className="flex items-center gap-4 text-right shrink-0">
                  <div>
                    <div className="text-xs text-foreground-muted">凭据</div>
                    <div className="font-mono text-xs">
                      {item.hasCredentials ? (
                        <span className="text-radix-green-11">已配置 Cookie</span>
                      ) : (
                        <span className="text-foreground-muted">访客模式</span>
                      )}
                    </div>
                  </div>

                  <div className="min-w-[70px]">
                    <div className="text-xs text-foreground-muted">响应时延</div>
                    <div className="font-mono text-xs text-foreground">
                      {item.latencyMs !== null ? `${item.latencyMs} ms` : "-"}
                    </div>
                  </div>

                  <div className="min-w-[60px]">
                    <div className="text-xs text-foreground-muted">状态</div>
                    <HealthText value={item.status} />
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="p-6 text-center text-xs text-foreground-muted">
              {checking ? "正在探测音源连通性..." : "暂无探测数据"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
