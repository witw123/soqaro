"use client";

import type { ReactNode } from "react";
import type { AdminIncident, AdminOverview, AdminRoomSummary, AdminUserSummary } from "@soqaro/shared";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  FileText,
  LayoutGrid,
  LogOut,
  Plus,
  Radio,
  RefreshCw,
  Server,
  Users
} from "lucide-react";

export type AuditRow = {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  reason: string | null;
  result: string;
  createdAt: string;
};

export type IconName =
  | "grid"
  | "radio"
  | "users"
  | "alert"
  | "file"
  | "server"
  | "refresh"
  | "logout"
  | "arrow"
  | "bell"
  | "plus";

export function Icon({
  name,
  size = 16,
  className = ""
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  const props = { size, className, "aria-hidden": true as const };
  switch (name) {
    case "grid":
      return <LayoutGrid {...props} />;
    case "radio":
      return <Radio {...props} />;
    case "users":
      return <Users {...props} />;
    case "alert":
      return <AlertTriangle {...props} />;
    case "file":
      return <FileText {...props} />;
    case "server":
      return <Server {...props} />;
    case "refresh":
      return <RefreshCw {...props} />;
    case "logout":
      return <LogOut {...props} />;
    case "arrow":
      return <ArrowRight {...props} />;
    case "bell":
      return <Bell {...props} />;
    case "plus":
      return <Plus {...props} />;
    default:
      return null;
  }
}

export function Metric({
  label,
  value,
  meta,
  tone = "default",
  badge
}: {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  tone?: "default" | "blue" | "green" | "amber" | "red";
  badge?: string;
}) {
  const toneClasses = {
    default: "text-foreground",
    blue: "text-radix-blue-11",
    green: "text-radix-green-11",
    amber: "text-radix-amber-11",
    red: "text-radix-red-11"
  }[tone];

  const badgeClasses = {
    default: "bg-surface text-foreground-muted border-[var(--slate-6)]",
    blue: "bg-radix-blue-3 text-radix-blue-11 border-radix-blue-6",
    green: "bg-radix-green-3 text-radix-green-11 border-radix-green-6",
    amber: "bg-radix-amber-3 text-radix-amber-11 border-radix-amber-6",
    red: "bg-radix-red-3 text-radix-red-11 border-radix-red-6"
  }[tone];

  return (
    <div className="rounded-lg border-[0.5px] border-[var(--slate-6)] bg-surface p-3.5 flex flex-col justify-between gap-1.5">
      <div className="flex items-center justify-between text-xs text-foreground-muted">
        <span>{label}</span>
        {badge ? (
          <span className={`px-1.5 py-0.2 rounded text-[11px] font-mono border-[0.5px] ${badgeClasses}`}>
            {badge}
          </span>
        ) : null}
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <strong className={`text-lg font-semibold tracking-tight ${toneClasses}`}>{value}</strong>
        {meta ? <span className="text-xs text-foreground-muted">{meta}</span> : null}
      </div>
    </div>
  );
}

export function PanelHeader({
  title,
  hint,
  action
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="p-3.5 border-b-[0.5px] border-[var(--slate-6)] flex items-center justify-between">
      <div className="flex items-baseline gap-2">
        <div className="text-xs font-semibold text-foreground tracking-tight">{title}</div>
        {hint ? <div className="text-xs text-foreground-muted">{hint}</div> : null}
      </div>
      {action}
    </div>
  );
}

export function RoomCell({ room }: { room: AdminRoomSummary }) {
  const dotColor =
    room.health === "critical"
      ? "bg-radix-red-9"
      : room.health === "degraded"
      ? "bg-radix-amber-9"
      : "bg-radix-green-9";
  return (
    <div className="flex items-center gap-2">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
      <a
        className="font-mono font-medium hover:underline text-foreground"
        href={`/admin/rooms/${encodeURIComponent(room.id)}`}
      >
        {room.joinCode}
      </a>
    </div>
  );
}

export function RoomRow({ room }: { room: AdminRoomSummary }) {
  return (
    <tr className="hover:bg-surface-border/10 transition-colors">
      <td className="py-2 px-3">
        <RoomCell room={room} />
      </td>
      <td className="py-2 px-3">
        <HealthText value={room.health} />
      </td>
      <td className="py-2 px-3 font-mono text-foreground-muted">
        {room.onlineMemberCount}/{room.memberCount}
      </td>
      <td className="py-2 px-3 font-mono text-foreground-muted">
        {translatePlayback(room.playbackStatus)}
      </td>
      <td className="py-2 px-3 font-mono text-foreground-muted">
        {formatTime(room.updatedAt)}
      </td>
    </tr>
  );
}

export function SystemHealth({ overview }: { overview: AdminOverview | null }) {
  const prismaUp = overview?.dependencies.prisma === "up";
  const redisUp = overview?.dependencies.redis === "up";

  return (
    <div>
      <PanelHeader title="服务健康状态" />
      <div className="p-3.5 space-y-1.5">
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
          label="服务节点实例"
          value={`${overview?.instances ?? 0} 个在线`}
          status="info"
        />
        {overview?.runtime ? (
          <>
            <HealthRow
              label="服务运行时长"
              value={formatUptime(overview.runtime.uptimeSeconds)}
              status="unknown"
            />
            <HealthRow
              label="内存占用 (Heap)"
              value={`${overview.runtime.memoryHeapUsedMb} MB / ${overview.runtime.memoryHeapTotalMb} MB`}
              status="unknown"
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

export function HealthRow({
  label,
  value,
  status
}: {
  label: string;
  value: ReactNode;
  status?: "healthy" | "degraded" | "critical" | "unknown" | "info";
}) {
  const statusClasses = {
    healthy: "text-radix-green-11 bg-radix-green-3 border-radix-green-6",
    degraded: "text-radix-amber-11 bg-radix-amber-3 border-radix-amber-6",
    critical: "text-radix-red-11 bg-radix-red-3 border-radix-red-6",
    unknown: "text-foreground-muted bg-surface border-[var(--slate-6)]",
    info: "text-radix-blue-11 bg-radix-blue-3 border-radix-blue-6"
  }[status ?? "unknown"];

  return (
    <div className="flex items-center justify-between py-1 text-xs">
      <span className="text-foreground-muted">{label}</span>
      <div>
        {status ? (
          <span className={`px-2 py-0.5 rounded text-[11px] font-medium border-[0.5px] ${statusClasses}`}>
            {value}
          </span>
        ) : (
          <span className="font-mono text-foreground">{value}</span>
        )}
      </div>
    </div>
  );
}

export function IncidentPanel({ rows }: { rows: AdminIncident[] }) {
  return (
    <div className="rounded-lg border-[0.5px] border-[var(--slate-6)] bg-surface flex flex-col">
      <PanelHeader title="异常事件队列" hint={rows.length ? `${rows.length} 条` : undefined} />
      <div className="divide-y divide-[var(--slate-6)]/60">
        {rows.length ? (
          rows.map((row) => (
            <div key={row.id} className="p-3 flex items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    row.severity === "CRITICAL" ? "bg-radix-red-9" : "bg-radix-amber-9"
                  }`}
                />
                <div className="truncate">
                  <div className="font-medium text-foreground truncate">{row.type}</div>
                  <div className="text-xs text-foreground-muted truncate">
                    {translateScope(row.scopeType)} {row.scopeId ?? "全局"}
                  </div>
                </div>
              </div>
              <span className="font-mono text-xs text-foreground-muted shrink-0">
                {formatTime(row.lastSeenAt)}
              </span>
            </div>
          ))
        ) : (
          <div className="p-6 text-center text-xs text-foreground-muted">暂无未处理异常</div>
        )}
      </div>
    </div>
  );
}

export function AuditPanel({ rows }: { rows: AuditRow[] }) {
  return (
    <div className="rounded-lg border-[0.5px] border-[var(--slate-6)] bg-surface flex flex-col">
      <PanelHeader title="近期管理审计" hint={rows.length ? `${rows.length} 条` : undefined} />
      <div className="divide-y divide-[var(--slate-6)]/60">
        {rows.length ? (
          rows.map((row) => (
            <div key={row.id} className="p-3 flex items-center justify-between gap-3 text-xs">
              <div className="truncate">
                <div className="font-medium text-foreground">{translateAction(row.action)}</div>
                <div className="text-xs text-foreground-muted truncate">
                  {translateScope(row.targetType)} {row.targetId ?? "-"} / {translateResult(row.result)}
                </div>
              </div>
              <span className="font-mono text-xs text-foreground-muted shrink-0">
                {formatTime(row.createdAt)}
              </span>
            </div>
          ))
        ) : (
          <div className="p-6 text-center text-xs text-foreground-muted">暂无管理记录</div>
        )}
      </div>
    </div>
  );
}

export function UserCell({ user }: { user: AdminUserSummary }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-6 h-6 rounded-full bg-surface-border/50 text-foreground text-xs font-medium flex items-center justify-center shrink-0">
        {user.nickname.slice(0, 1).toUpperCase()}
      </span>
      <div>
        <div className="font-medium text-foreground">{user.nickname}</div>
        <div className="text-xs font-mono text-foreground-muted">{user.username}</div>
      </div>
    </div>
  );
}

export function HealthText({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  let dotColor = "bg-radix-green-9";
  let textColor = "text-radix-green-11";

  if (normalized.includes("critical") || normalized.includes("disabled") || normalized.includes("failed") || normalized.includes("down")) {
    dotColor = "bg-radix-red-9";
    textColor = "text-radix-red-11";
  } else if (
    normalized.includes("degraded") ||
    normalized.includes("open") ||
    normalized.includes("reconnecting") ||
    normalized.includes("conflict")
  ) {
    dotColor = "bg-radix-amber-9";
    textColor = "text-radix-amber-11";
  } else if (
    normalized.includes("unknown") ||
    normalized.includes("offline") ||
    normalized.includes("recovered")
  ) {
    dotColor = "bg-[var(--slate-9)]";
    textColor = "text-foreground-muted";
  }

  return (
    <span className={`inline-flex items-center gap-1.5 ${textColor}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} aria-hidden="true" />
      <span>{translateStatus(value)}</span>
    </span>
  );
}

export function translateStatus(value: string) {
  const labels: Record<string, string> = {
    active: "正常",
    healthy: "健康",
    degraded: "降级",
    critical: "严重",
    disabled: "已禁用",
    failed: "失败",
    open: "未处理",
    recovered: "已恢复",
    unknown: "未知",
    offline: "离线",
    online: "在线",
    reconnecting: "重连中",
    succeeded: "成功",
    pending: "处理中",
    down: "服务异常"
  };
  return labels[value.toLowerCase()] ?? value;
}

export function translatePlayback(value: string) {
  const labels: Record<string, string> = {
    playing: "播放中",
    paused: "已暂停",
    stopped: "已停止",
    idle: "空闲",
    conflict: "冲突"
  };
  return labels[value.toLowerCase()] ?? value;
}

export function translateScope(value: string) {
  const labels: Record<string, string> = {
    room: "房间",
    user: "用户",
    system: "系统",
    global: "全局"
  };
  return labels[value.toLowerCase()] ?? value;
}

export function translateAction(value: string) {
  const labels: Record<string, string> = {
    terminate_room: "结束房间",
    disable_user: "禁用用户",
    enable_user: "启用用户",
    revoke_sessions: "撤销会话",
    login: "登录",
    logout: "退出登录"
  };
  return labels[value.toLowerCase()] ?? value;
}

export function translateResult(value: string) {
  return translateStatus(value);
}

export function translateRedisMode(value: string) {
  const labels: Record<string, string> = {
    pubsub: "Pub/Sub",
    polling: "轮询",
    degraded: "降级",
    unknown: "未知"
  };
  return labels[value.toLowerCase()] ?? value;
}

export function formatUptime(totalSeconds: number) {
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours} 小时 ${remainingMinutes} 分`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days} 天 ${remainingHours} 小时`;
}

export function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "-"
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "-"
    : `${date.toLocaleDateString("zh-CN")} ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
}
