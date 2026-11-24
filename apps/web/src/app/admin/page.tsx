"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminIncident, AdminOverview, AdminRoomSummary, AdminSession, AdminUserSummary, SystemAnnouncement } from "@soqaro/shared";
import { adminApi, AdminApiError } from "@/lib/network/admin-api";
import { Icon, type IconName, type AuditRow } from "./ui";
import { Overview } from "./sections/overview";
import { Announcements } from "./sections/announcements";
import { Rooms } from "./sections/rooms";
import { Users } from "./sections/users";
import { Incidents } from "./sections/incidents";
import { Audit } from "./sections/audit";
import { System } from "./sections/system";

type Tab = "overview" | "announcements" | "rooms" | "users" | "incidents" | "audit" | "system";

const tabs: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: "overview", label: "系统总览", icon: "grid" },
  { id: "announcements", label: "系统通知", icon: "bell" },
  { id: "rooms", label: "房间监测", icon: "radio" },
  { id: "users", label: "用户目录", icon: "users" },
  { id: "incidents", label: "异常事件", icon: "alert" },
  { id: "audit", label: "管理审计", icon: "file" },
  { id: "system", label: "系统依赖", icon: "server" }
];

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [session, setSession] = useState<AdminSession | null>(null);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [rooms, setRooms] = useState<AdminRoomSummary[]>([]);
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [incidents, setIncidents] = useState<AdminIncident[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [announcements, setAnnouncements] = useState<SystemAnnouncement[]>([]);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [error, setError] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const loadingRef = useRef(false);
  const queuedRef = useRef(false);
  const latestLoadRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    if (loadingRef.current) {
      queuedRef.current = true;
      return;
    }
    loadingRef.current = true;
    setRefreshing(true);
    try {
      setError("");
      const current = session ?? (await adminApi.session());
      setSession(current);
      const [overviewData, roomData, userData, incidentData, auditData, announcementData] = await Promise.all([
        adminApi.overview(),
        adminApi.rooms(debouncedQuery),
        adminApi.users(debouncedQuery),
        adminApi.incidents(),
        adminApi.audit(),
        adminApi.announcements().catch(() => ({ data: [] }))
      ]);
      setOverview(overviewData);
      setRooms(roomData.data);
      setUsers(userData.data);
      setIncidents(incidentData.data);
      setAudit(auditData.data);
      setAnnouncements(announcementData.data);
      setLastUpdatedAt(overviewData.generatedAt);
    } catch (cause) {
      if (cause instanceof AdminApiError && (cause.status === 401 || cause.status === 403)) {
        window.location.assign("/admin/login");
        return;
      }
      setError(cause instanceof Error ? cause.message : "管理数据加载失败。");
    } finally {
      loadingRef.current = false;
      setRefreshing(false);
      if (queuedRef.current) {
        queuedRef.current = false;
        void latestLoadRef.current?.();
      }
    }
  }, [debouncedQuery, session]);

  latestLoadRef.current = load;
  useEffect(() => {
    void load();
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(refreshIfVisible, tab === "overview" ? 5000 : 10000);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [load, tab]);

  async function logout() {
    await adminApi.logout().catch(() => undefined);
    window.sessionStorage.removeItem("soqaro-admin-csrf");
    window.location.assign("/admin/login");
  }

  const activeTab = tabs.find((item) => item.id === tab) ?? tabs[0];
  const incidentCount = overview?.openIncidents ?? incidents.filter((item) => item.status === "OPEN").length;

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      {/* 侧边导航栏 */}
      <aside className="w-56 border-r border-surface-border bg-surface/30 backdrop-blur-sm flex flex-col shrink-0">
        <div className="h-14 border-b border-surface-border px-4 flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-[var(--accent,#3b82f6)] text-white font-mono font-bold text-xs flex items-center justify-center shrink-0">
            MR
          </div>
          <div className="min-w-0 leading-tight">
            <div className="text-xs font-semibold tracking-tight truncate">音乐房间</div>
            <div className="text-xs text-foreground-muted truncate">管理控制台</div>
          </div>
        </div>

        <div className="px-3 pt-4 pb-1 text-xs font-mono font-medium text-foreground-muted">运维中心</div>

        <nav className="p-2 space-y-1 flex-1" aria-label="管理台导航">
          {tabs.map((item) => {
            const isActive = tab === item.id;
            return (
              <button
                key={item.id}
                className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs transition-colors ${
                  isActive
                    ? "bg-surface-border/60 text-foreground font-medium"
                    : "text-foreground-muted hover:text-foreground hover:bg-surface-border/30"
                }`}
                onClick={() => setTab(item.id)}
              >
                <Icon name={item.icon} size={15} className="shrink-0" />
                <span className="truncate">{item.label}</span>
                {item.id === "incidents" && incidentCount > 0 ? (
                  <span className="ml-auto text-xs font-mono px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/20">
                    {incidentCount}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>

        {/* 底部操作员信息 */}
        <div className="p-3 border-t border-surface-border bg-surface/50">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="text-xs font-medium text-foreground truncate">{session?.nickname ?? "管理员"}</div>
              <div className="text-xs text-foreground-muted truncate">管理员权限</div>
            </div>
          </div>
        </div>
      </aside>

      {/* 主界面区域 */}
      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        {/* 顶部工具条 */}
        <header className="h-12 border-b border-surface-border px-6 flex items-center justify-between bg-surface/50 backdrop-blur-sm sticky top-0 z-20 shrink-0">
          <div className="text-xs text-foreground-muted flex items-center gap-1.5">
            <span>音乐房间</span>
            <span aria-hidden="true">/</span>
            <strong className="text-foreground font-medium">{activeTab.label}</strong>
          </div>

          <div className="flex items-center gap-2">
            <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs text-foreground-muted bg-surface-border/20 border border-surface-border/50">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <span>实时采样</span>
            </div>
            <button
              className="inline-flex items-center gap-1.5 rounded-md border border-surface-border bg-surface px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-surface-border/40 disabled:opacity-50"
              onClick={() => void load()}
              disabled={refreshing}
            >
              <Icon name="refresh" size={13} className={refreshing ? "animate-spin" : ""} />
              <span>{refreshing ? "刷新中" : "刷新"}</span>
            </button>
            <button
              className="inline-flex items-center gap-1.5 rounded-md border border-surface-border bg-surface px-2.5 py-1 text-xs text-foreground-muted hover:text-foreground transition-colors hover:bg-surface-border/40"
              onClick={() => void logout()}
            >
              <Icon name="logout" size={13} />
              <span>退出</span>
            </button>
          </div>
        </header>

        {/* 内容容器 */}
        <main className="flex-1 max-w-7xl w-full mx-auto p-6 space-y-6">
          {/* 页面标题 & 搜索栏 */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">{activeTab.label}</h1>
              <p className="text-xs text-foreground-muted mt-0.5">
                {refreshing
                  ? "正在同步最新状态..."
                  : lastUpdatedAt
                  ? `最近采样 ${new Date(lastUpdatedAt).toLocaleTimeString()}`
                  : "等待首次采样"}
              </p>
            </div>

            {tab === "rooms" || tab === "users" ? (
              <div className="shrink-0">
                <input
                  className="h-8 rounded-md border border-surface-border bg-surface px-2.5 text-xs text-foreground placeholder:text-foreground-muted focus:outline-none focus:ring-1 focus:ring-[var(--accent,#3b82f6)] w-56 transition-all"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={tab === "rooms" ? "搜索房间码" : "搜索用户名或昵称"}
                  aria-label="搜索"
                />
              </div>
            ) : null}
          </div>

          {/* 错误提示 */}
          {error ? (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3.5 text-xs text-red-400 flex items-center justify-between">
              <span>{error}</span>
              <button
                className="underline hover:no-underline font-medium ml-4 text-foreground"
                onClick={() => void load()}
              >
                重新尝试
              </button>
            </div>
          ) : null}

          {/* 各 Tab 内容 */}
          {tab === "overview" ? (
            <Overview
              overview={overview}
              rooms={rooms}
              incidents={incidents}
              audit={audit}
              onRooms={() => setTab("rooms")}
            />
          ) : tab === "announcements" ? (
            <Announcements announcements={announcements} onRefresh={load} />
          ) : tab === "rooms" ? (
            <Rooms rooms={rooms} onRefresh={load} />
          ) : tab === "users" ? (
            <Users users={users} onRefresh={load} />
          ) : tab === "incidents" ? (
            <Incidents rows={incidents} onRefresh={load} />
          ) : tab === "audit" ? (
            <Audit rows={audit} />
          ) : (
            <System overview={overview} />
          )}
        </main>
      </div>
    </div>
  );
}
