"use client";

import { useMemo, useState } from "react";
import type { AdminIncident } from "@soqaro/shared";
import { ADMIN_CONFIRM_REASON, adminApi } from "@/lib/network/admin-api";
import { HealthText, formatTime, translateScope } from "../ui";

type IncidentFilter = "all" | "critical" | "warning" | "open";

export function Incidents({ rows, onRefresh }: { rows: AdminIncident[]; onRefresh: () => Promise<void> }) {
  const [filter, setFilter] = useState<IncidentFilter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [allBusy, setAllBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState("");

  const filteredRows = useMemo(() => {
    switch (filter) {
      case "critical":
        return rows.filter((r) => r.severity === "CRITICAL");
      case "warning":
        return rows.filter((r) => r.severity !== "CRITICAL");
      case "open":
        return rows.filter((r) => r.status === "OPEN");
      default:
        return rows;
    }
  }, [rows, filter]);

  const openCount = rows.filter((r) => r.status === "OPEN").length;

  async function resolveOne(id: string) {
    if (busyId || allBusy) return;
    setBusyId(id);
    setActionMessage("");
    try {
      await adminApi.resolveIncident(id, ADMIN_CONFIRM_REASON);
      setActionMessage("异常事件已标记为已解决");
      await onRefresh();
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "标记解决失败");
    } finally {
      setBusyId(null);
    }
  }

  async function resolveAll() {
    if (busyId || allBusy || openCount === 0) return;
    setAllBusy(true);
    setActionMessage("");
    try {
      const res = await adminApi.resolveAllIncidents(ADMIN_CONFIRM_REASON);
      setActionMessage(`已将 ${res.count} 个未处理异常标记为已解决`);
      await onRefresh();
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "批量解决失败");
    } finally {
      setAllBusy(false);
    }
  }

  const filterOptions: Array<{ id: IncidentFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: rows.length },
    { id: "open", label: "未处理", count: openCount },
    { id: "critical", label: "严重", count: rows.filter((r) => r.severity === "CRITICAL").length },
    { id: "warning", label: "警告", count: rows.filter((r) => r.severity !== "CRITICAL").length }
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold text-foreground">异常事件队列</h2>
        <div className="flex items-center gap-2">
          {/* 筛选 Chip */}
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

          {openCount > 0 ? (
            <button
              className="rounded-md border-[0.5px] border-radix-green-6 bg-radix-green-3 px-2.5 py-1 text-xs text-radix-green-11 hover:bg-radix-green-4 transition-colors disabled:opacity-50"
              onClick={() => void resolveAll()}
              disabled={allBusy}
            >
              {allBusy ? "处理中..." : "全部标为已解决"}
            </button>
          ) : null}
        </div>
      </div>

      {actionMessage ? (
        <div className="rounded-lg border-[0.5px] border-[var(--slate-6)] bg-surface p-2.5 text-xs text-foreground" role="status">
          {actionMessage}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border-[0.5px] border-[var(--slate-6)] bg-surface">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b-[0.5px] border-[var(--slate-6)] bg-surface-border/20 text-foreground-muted">
              <th className="py-2.5 px-3 font-medium">级别</th>
              <th className="py-2.5 px-3 font-medium">类型</th>
              <th className="py-2.5 px-3 font-medium">范围</th>
              <th className="py-2.5 px-3 font-medium">状态</th>
              <th className="py-2.5 px-3 font-medium">最近发现</th>
              <th className="py-2.5 px-3 font-medium text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--slate-6)]/60">
            {filteredRows.map((row) => (
              <tr key={row.id} className="hover:bg-surface-border/15 transition-colors">
                <td className="py-2 px-3">
                  <span
                    className={`inline-block px-1.5 py-0.2 rounded text-[11px] font-mono border-[0.5px] ${
                      row.severity === "CRITICAL"
                        ? "border-radix-red-6 bg-radix-red-3 text-radix-red-11"
                        : "border-radix-amber-6 bg-radix-amber-3 text-radix-amber-11"
                    }`}
                  >
                    {row.severity === "CRITICAL" ? "严重" : "警告"}
                  </span>
                </td>
                <td className="py-2 px-3 font-mono font-medium text-foreground">
                  {row.type}
                </td>
                <td className="py-2 px-3 text-foreground-muted">
                  {translateScope(row.scopeType)} {row.scopeId ?? "全局"}
                </td>
                <td className="py-2 px-3">
                  <HealthText value={row.status} />
                </td>
                <td className="py-2 px-3 font-mono text-foreground-muted">
                  {formatTime(row.lastSeenAt)}
                </td>
                <td className="py-2 px-3 text-right">
                  {row.status === "OPEN" ? (
                    <button
                      className="rounded border-[0.5px] border-[var(--slate-6)] bg-surface px-2 py-0.5 text-xs text-foreground hover:bg-[var(--slate-4)] transition-colors disabled:opacity-50"
                      onClick={() => void resolveOne(row.id)}
                      disabled={busyId === row.id || allBusy}
                    >
                      {busyId === row.id ? "处理中..." : "标为解决"}
                    </button>
                  ) : (
                    <span className="text-xs text-foreground-muted font-mono">已闭环</span>
                  )}
                </td>
              </tr>
            ))}
            {!filteredRows.length ? (
              <tr>
                <td colSpan={6} className="py-8 text-center text-xs text-foreground-muted">
                  暂无匹配的异常事件
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
