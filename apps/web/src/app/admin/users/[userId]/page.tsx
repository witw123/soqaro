"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { adminApi, AdminApiError, ADMIN_CONFIRM_REASON, type AdminUserDetail } from "@/lib/network/admin-api";
import {
  DataList,
  DataPanel,
  DetailRow,
  InfoPanel,
  Metric,
  PanelHeader,
  formatDateTime,
  translateAction
} from "../../ui";

export default function AdminUserDetailPage() {
  const params = useParams<{ userId: string }>();
  const router = useRouter();
  const [user, setUser] = useState<AdminUserDetail | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [action, setAction] = useState<"status" | "revoke" | "role" | "reset-password" | null>(null);
  const [actionReason, setActionReason] = useState(ADMIN_CONFIRM_REASON);
  const [customPassword, setCustomPassword] = useState("");
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setRefreshing(true);
    try {
      setError("");
      setUser(await adminApi.user(params.userId));
    } catch (cause) {
      if (cause instanceof AdminApiError && (cause.status === 401 || cause.status === 403)) router.replace("/admin/login");
      else setError(cause instanceof Error ? cause.message : "加载用户数据失败。");
    } finally {
      loadingRef.current = false;
      setRefreshing(false);
    }
  }, [params.userId, router]);

  useEffect(() => {
    void load();
    const refreshIfVisible = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refreshIfVisible, 10000);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [load]);

  async function confirmAction() {
    if (!user || !action || actionBusy) return;
    setActionError("");
    setActionBusy(true);
    try {
      if (action === "status") {
        await adminApi.setUserStatus(user.id, user.status === "ACTIVE" ? "DISABLED" : "ACTIVE", actionReason.trim() || ADMIN_CONFIRM_REASON);
      } else if (action === "revoke") {
        await adminApi.revokeSessions(user.id, actionReason.trim() || ADMIN_CONFIRM_REASON);
      } else if (action === "role") {
        const nextRole = user.role === "ADMIN" ? "USER" : "ADMIN";
        await adminApi.setUserRole(user.id, nextRole, actionReason.trim() || ADMIN_CONFIRM_REASON);
      } else if (action === "reset-password") {
        const res = await adminApi.resetPassword(user.id, actionReason.trim() || ADMIN_CONFIRM_REASON, customPassword.trim() || undefined);
        if (res.temporaryPassword) {
          setGeneratedPassword(res.temporaryPassword);
        }
      }
      if (action !== "reset-password") {
        setAction(null);
      }
      await load();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "管理操作失败，请重试。");
    } finally {
      setActionBusy(false);
    }
  }

  function copyPassword() {
    if (!generatedPassword) return;
    void navigator.clipboard.writeText(generatedPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (error) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4 text-xs text-red-400 flex flex-col gap-2 max-w-md">
          <p>{error}</p>
          <button className="underline hover:no-underline text-left text-foreground font-medium" onClick={() => void load()}>
            重新尝试
          </button>
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background text-foreground">
        <div className="text-xs text-foreground-muted">正在加载用户详情...</div>
      </main>
    );
  }

  const isAdmin = user.role === "ADMIN";

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="h-12 border-b border-surface-border px-6 flex items-center justify-between bg-surface/50 backdrop-blur-sm sticky top-0 z-20">
        <button
          className="inline-flex items-center gap-1.5 text-xs text-foreground-muted hover:text-foreground transition-colors"
          onClick={() => router.back()}
        >
          <span>←</span> 返回用户目录
        </button>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-foreground-muted">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            {refreshing ? "同步中" : "实时数据"}
          </span>
          <button
            className="h-7 px-2.5 rounded border border-surface-border bg-surface hover:bg-surface-border/40 text-xs text-foreground transition-colors disabled:opacity-50"
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
            <h1 className="text-xl font-semibold tracking-tight text-foreground">{user.nickname}</h1>
            <span className="text-sm font-mono text-foreground-muted">{user.username}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-mono border-[0.5px] ${isAdmin ? "border-radix-amber-6 bg-radix-amber-3 text-radix-amber-11" : "border-[var(--slate-6)] bg-surface text-foreground-muted"}`}>
              {isAdmin ? "管理员" : "普通用户"}
            </span>
          </div>
          <p className="mt-0.5 text-xs font-mono text-foreground-muted">用户全局 ID: {user.id}</p>
        </div>

        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Metric label="账号状态" value={user.status === "ACTIVE" ? "正常" : "已禁用"} />
          <Metric label="有效会话" value={String(user.sessions.length)} />
          <Metric label="当前关联房间" value={String(user.rooms.length)} />
          <Metric label="账号角色" value={user.role === "ADMIN" ? "系统管理员" : "标准用户"} />
        </section>

        {/* 账号控制台 */}
        <section className="rounded-lg border-[0.5px] border-[var(--slate-6)] bg-surface overflow-hidden">
          <PanelHeader title="账号治理与权限控制" hint="状态流转、角色调整与凭据重置" />
          <div className="p-3.5 space-y-3">
            {generatedPassword ? (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3.5 text-xs flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <strong className="text-emerald-400 font-medium">密码已成功重置并清空全部旧会话</strong>
                  <button
                    className="text-xs text-foreground underline hover:no-underline"
                    onClick={() => { setGeneratedPassword(null); setAction(null); }}
                  >
                    关闭提示
                  </button>
                </div>
                <p className="text-foreground-muted">请妥善保存临时密码并交由用户：</p>
                <div className="flex items-center gap-2">
                  <code className="px-3 py-1.5 rounded bg-surface border border-surface-border font-mono text-sm text-foreground select-all">
                    {generatedPassword}
                  </code>
                  <button
                    className="h-7 px-3 rounded border border-surface-border bg-surface hover:bg-surface-border/40 text-xs transition-colors"
                    onClick={copyPassword}
                  >
                    {copied ? "已复制！" : "复制密码"}
                  </button>
                </div>
              </div>
            ) : null}

            {action ? (
              <div className="rounded-md border border-surface-border bg-surface-border/10 p-3.5 flex flex-col gap-3 text-xs">
                <div>
                  <strong className="font-semibold text-foreground">
                    {action === "status"
                      ? (user.status === "ACTIVE" ? "确认禁用账号" : "确认解除禁用")
                      : action === "role"
                      ? (user.role === "ADMIN" ? "确认将此管理员降级为普通用户" : "确认将此用户提升为系统管理员")
                      : action === "reset-password"
                      ? "确认重置用户登录密码"
                      : "确认撤销全部活跃会话"}
                  </strong>
                  <p className="mt-1 text-foreground-muted">
                    {action === "status"
                      ? (user.status === "ACTIVE" ? "禁用后会立即注销用户全部会话并断开其实时网络连接。" : "启用后用户可重新凭账号密码登录。")
                      : action === "role"
                      ? (user.role === "ADMIN" ? "降级后该用户将立即失去管理台访问权限并注销管理员会话。" : "提权后该用户将获得管理后台全部运维权限。")
                      : action === "reset-password"
                      ? "重置密码后会强制踢出用户在所有设备上的有效会话，需使用新密码重新登录。"
                      : "撤销后账号状态不变，用户需要在各设备重新输入密码登录。"}
                  </p>
                </div>

                {action === "status" && user.status === "ACTIVE" ? (
                  <div>
                    <label className="block text-foreground-muted mb-1">封禁原因（记录至审计日志）</label>
                    <input
                      className="w-full max-w-md h-7 rounded border border-surface-border bg-surface px-2 text-xs text-foreground placeholder:text-foreground-muted"
                      value={actionReason}
                      onChange={(e) => setActionReason(e.target.value)}
                      placeholder="输入封禁原因，例如：发布违规低俗内容"
                    />
                  </div>
                ) : null}

                {action === "reset-password" ? (
                  <div>
                    <label className="block text-foreground-muted mb-1">自定义新密码（留空则自动生成高强度随机密码）</label>
                    <input
                      type="password"
                      className="w-full max-w-md h-7 rounded border border-surface-border bg-surface px-2 text-xs text-foreground placeholder:text-foreground-muted"
                      value={customPassword}
                      onChange={(e) => setCustomPassword(e.target.value)}
                      placeholder="留空自动生成 12 位随机密码"
                    />
                  </div>
                ) : null}

                {actionError ? <p className="text-red-400">{actionError}</p> : null}

                <div className="flex items-center gap-2 mt-1">
                  <button
                    className="h-7 px-3 rounded border border-surface-border bg-surface hover:bg-surface-border/40 transition-colors"
                    onClick={() => { setAction(null); setActionError(""); }}
                    disabled={actionBusy}
                  >
                    取消
                  </button>
                  <button
                    className={`h-7 px-3 rounded text-white font-medium transition-colors disabled:opacity-50 ${
                      (action === "status" && user.status === "ACTIVE") || (action === "role" && user.role === "ADMIN")
                        ? "bg-red-600 hover:bg-red-700"
                        : "bg-[var(--accent,#3b82f6)] hover:opacity-90"
                    }`}
                    onClick={() => void confirmAction()}
                    disabled={actionBusy}
                  >
                    {actionBusy ? "处理中..." : "确认执行"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <strong className="text-xs font-medium text-foreground">快速治理动作</strong>
                  <p className="text-xs text-foreground-muted mt-0.5">即时生效，全部操作强制写入系统 HMAC 审计记录。</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    className={`h-7 px-3 rounded border text-xs font-medium transition-colors ${
                      user.status === "ACTIVE"
                        ? "border-red-500/30 hover:bg-red-500/10 text-red-400"
                        : "border-emerald-500/30 hover:bg-emerald-500/10 text-emerald-400"
                    }`}
                    onClick={() => { setAction("status"); setActionError(""); }}
                  >
                    {user.status === "ACTIVE" ? "禁用账号" : "解除禁用"}
                  </button>

                  <button
                    className="h-7 px-3 rounded border border-surface-border bg-surface hover:bg-surface-border/40 text-xs font-medium text-foreground transition-colors"
                    onClick={() => { setAction("role"); setActionError(""); }}
                  >
                    {user.role === "ADMIN" ? "降为普通用户" : "提升为管理员"}
                  </button>

                  <button
                    className="h-7 px-3 rounded border border-surface-border bg-surface hover:bg-surface-border/40 text-xs font-medium text-foreground transition-colors"
                    onClick={() => { setAction("reset-password"); setActionError(""); setCustomPassword(""); }}
                  >
                    重置登录密码
                  </button>

                  <button
                    className="h-7 px-3 rounded border border-surface-border bg-surface hover:bg-surface-border/40 text-xs font-medium text-foreground transition-colors"
                    onClick={() => { setAction("revoke"); setActionError(""); }}
                  >
                    撤销全部会话
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <InfoPanel title="账号信息">
            <DetailRow label="用户 ID" value={user.id} mono />
            <DetailRow label="用户名" value={user.username} mono />
            <DetailRow label="昵称" value={user.nickname} />
            <DetailRow label="状态" value={user.status === "ACTIVE" ? "正常" : "已禁用"} />
            <DetailRow label="角色" value={user.role === "ADMIN" ? "管理员" : "普通用户"} />
            <DetailRow label="注册时间" value={formatDateTime(user.createdAt)} />
            <DetailRow label="最近登录" value={formatDateTime(user.lastLoginAt)} />
            {user.disabledAt ? <DetailRow label="禁用时间" value={formatDateTime(user.disabledAt)} /> : null}
            {user.disabledReason ? <DetailRow label="禁用原因" value={user.disabledReason} /> : null}
          </InfoPanel>
          <InfoPanel title="当前加入房间">
            <DataList
              rows={user.rooms}
              empty="当前没有加入任何房间。"
              render={(room) => (
                <div className="flex items-center justify-between py-2 text-xs" key={room.id}>
                  <a className="font-mono text-[var(--accent,#3b82f6)] hover:underline font-medium" href={`/admin/rooms/${encodeURIComponent(room.id)}`}>
                    {room.joinCode}
                  </a>
                  <span className="text-foreground-muted">
                    {room.name || "未命名房间"} ({room.role === "host" ? "房主" : "成员"})
                  </span>
                </div>
              )}
            />
          </InfoPanel>
        </section>

        <DataPanel title="有效会话" hint={`${user.sessions.length} 个`}>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-surface-border text-foreground-muted font-mono text-xs">
                <th className="py-2.5 px-3 font-normal">会话 ID</th>
                <th className="py-2.5 px-3 font-normal">创建时间</th>
                <th className="py-2.5 px-3 font-normal">过期时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border/50">
              {user.sessions.length ? (
                user.sessions.map((session) => (
                  <tr key={session.id} className="hover:bg-surface-border/15 transition-colors">
                    <td className="py-2.5 px-3 font-mono text-foreground-muted">{session.id}</td>
                    <td className="py-2.5 px-3 font-mono text-foreground-muted">{formatDateTime(session.createdAt)}</td>
                    <td className="py-2.5 px-3 font-mono text-foreground-muted">{formatDateTime(session.expiresAt)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} className="py-8 text-center text-xs text-foreground-muted">没有有效普通会话。</td>
                </tr>
              )}
            </tbody>
          </table>
        </DataPanel>

        <DataPanel title="相关审计" hint={`${user.audits.length} 条`}>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-surface-border text-foreground-muted font-mono text-xs">
                <th className="py-2.5 px-3 font-normal">时间</th>
                <th className="py-2.5 px-3 font-normal">操作</th>
                <th className="py-2.5 px-3 font-normal">原因说明</th>
                <th className="py-2.5 px-3 font-normal">结果</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border/50">
              {user.audits.length ? (
                user.audits.map((audit) => (
                  <tr key={audit.id} className="hover:bg-surface-border/15 transition-colors">
                    <td className="py-2.5 px-3 font-mono text-foreground-muted">{formatDateTime(audit.createdAt)}</td>
                    <td className="py-2.5 px-3 font-medium text-foreground">{translateAction(audit.action)}</td>
                    <td className="py-2.5 px-3 text-foreground-muted">{audit.reason ?? "-"}</td>
                    <td className="py-2.5 px-3"><span className="text-emerald-400 font-medium">成功</span></td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-xs text-foreground-muted">没有针对此用户的审计记录。</td>
                </tr>
              )}
            </tbody>
          </table>
        </DataPanel>
      </div>
    </main>
  );
}
