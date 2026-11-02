"use client";

import { useMemo, useState } from "react";
import type { AdminUserSummary } from "@soqaro/shared";
import { ADMIN_CONFIRM_REASON, adminApi } from "@/lib/network/admin-api";
import { HealthText, UserCell, formatTime } from "../ui";

type UserFilter = "all" | "active" | "disabled" | "admin";

export function Users({ users, onRefresh }: { users: AdminUserSummary[]; onRefresh: () => Promise<void> }) {
  const [filter, setFilter] = useState<UserFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchAction, setBatchAction] = useState<"disable" | "enable" | "revoke" | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchMessage, setBatchMessage] = useState("");

  const filteredUsers = useMemo(() => {
    switch (filter) {
      case "active":
        return users.filter((u) => u.status === "ACTIVE");
      case "disabled":
        return users.filter((u) => u.status === "DISABLED");
      case "admin":
        return users.filter((u) => u.role === "ADMIN");
      default:
        return users;
    }
  }, [users, filter]);

  const manageable = filteredUsers.filter((user) => user.role !== "ADMIN");
  const selectedUsers = manageable.filter((user) => selected.has(user.id));
  const allSelected = manageable.length > 0 && manageable.every((user) => selected.has(user.id));

  function toggleUser(userId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
    setBatchMessage("");
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(manageable.map((user) => user.id)));
    setBatchMessage("");
  }

  async function runBatch() {
    if (!selectedUsers.length || !batchAction || batchBusy) return;
    const targets =
      batchAction === "disable"
        ? selectedUsers.filter((user) => user.status === "ACTIVE")
        : batchAction === "enable"
        ? selectedUsers.filter((user) => user.status === "DISABLED")
        : selectedUsers;
    if (!targets.length) {
      setBatchAction(null);
      return;
    }
    setBatchBusy(true);
    setBatchMessage("");
    const results = await Promise.allSettled(
      targets.map((user) =>
        batchAction === "revoke"
          ? adminApi.revokeSessions(user.id, ADMIN_CONFIRM_REASON)
          : adminApi.setUserStatus(
              user.id,
              batchAction === "disable" ? "DISABLED" : "ACTIVE",
              ADMIN_CONFIRM_REASON
            )
      )
    );
    const failed = results.filter((result) => result.status === "rejected").length;
    setBatchBusy(false);
    setBatchAction(null);
    setSelected(new Set());
    setBatchMessage(
      failed
        ? `已处理 ${targets.length - failed} 个用户，${failed} 个失败`
        : `已完成 ${targets.length} 个用户操作`
    );
    await onRefresh();
  }

  function openUser(userId: string) {
    window.location.assign(`/admin/users/${encodeURIComponent(userId)}`);
  }

  const filterOptions: Array<{ id: UserFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: users.length },
    { id: "active", label: "正常", count: users.filter((u) => u.status === "ACTIVE").length },
    { id: "disabled", label: "已禁用", count: users.filter((u) => u.status === "DISABLED").length },
    { id: "admin", label: "管理员", count: users.filter((u) => u.role === "ADMIN").length }
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold text-foreground">用户目录</h2>
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

      {selectedUsers.length ? (
        <div className="rounded-lg border-[0.5px] border-[var(--slate-6)] bg-surface p-3 flex items-center justify-between text-xs">
          <span className="text-foreground font-medium">已选 {selectedUsers.length} 个普通用户</span>
          <div className="flex items-center gap-2">
            <button
              className="rounded-md border-[0.5px] border-[var(--slate-6)] bg-surface px-2.5 py-1 text-xs hover:bg-[var(--slate-4)] transition-colors"
              onClick={() => setSelected(new Set())}
            >
              清空选择
            </button>
            <button
              className="rounded-md border-[0.5px] border-[var(--slate-6)] bg-surface px-2.5 py-1 text-xs hover:bg-[var(--slate-4)] transition-colors disabled:opacity-50"
              onClick={() => setBatchAction("enable")}
              disabled={!selectedUsers.some((user) => user.status === "DISABLED")}
            >
              启用选中
            </button>
            <button
              className="rounded-md border-[0.5px] border-radix-amber-6 bg-radix-amber-3 px-2.5 py-1 text-xs text-radix-amber-11 hover:bg-radix-amber-4 transition-colors disabled:opacity-50"
              onClick={() => setBatchAction("revoke")}
            >
              撤销会话
            </button>
            <button
              className="rounded-md border-[0.5px] border-radix-red-6 bg-radix-red-3 px-2.5 py-1 text-xs text-radix-red-11 hover:bg-radix-red-4 transition-colors disabled:opacity-50"
              onClick={() => setBatchAction("disable")}
              disabled={!selectedUsers.some((user) => user.status === "ACTIVE")}
            >
              禁用选中
            </button>
          </div>
        </div>
      ) : null}

      {batchAction ? (
        <div className="rounded-lg border-[0.5px] border-radix-amber-6 bg-radix-amber-3 p-3.5 flex items-center justify-between gap-4 text-xs">
          <div>
            <strong className="text-radix-amber-11">
              确认对选中的 {selectedUsers.length} 个用户执行
              {batchAction === "disable"
                ? "禁用账号"
                : batchAction === "enable"
                ? "启用账号"
                : "撤销活跃会话"}
            </strong>
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
              className="rounded-md bg-radix-amber-9 text-white px-2.5 py-1 text-xs hover:bg-radix-amber-10 transition-colors disabled:opacity-50"
              onClick={() => void runBatch()}
              disabled={batchBusy}
            >
              {batchBusy ? "处理中..." : "确认执行"}
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
                  aria-label="全选可管理用户"
                  className="rounded border-[var(--slate-6)] bg-surface text-accent focus:ring-0 focus:ring-offset-0"
                />
              </th>
              <th className="py-2.5 px-3 font-medium">用户</th>
              <th className="py-2.5 px-3 font-medium">角色</th>
              <th className="py-2.5 px-3 font-medium">状态</th>
              <th className="py-2.5 px-3 font-medium">会话</th>
              <th className="py-2.5 px-3 font-medium">在播房间</th>
              <th className="py-2.5 px-3 font-medium">注册时间</th>
              <th className="py-2.5 px-3 font-medium">最后登录</th>
              <th className="py-2.5 px-3 font-medium text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--slate-6)]/60">
            {filteredUsers.map((user) => {
              const isAdmin = user.role === "ADMIN";
              return (
                <tr
                  key={user.id}
                  onClick={() => openUser(user.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openUser(user.id);
                    }
                  }}
                  role="link"
                  tabIndex={0}
                  className="cursor-pointer hover:bg-surface-border/15 transition-colors"
                >
                  <td
                    className="py-2 px-3 w-8"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {!isAdmin ? (
                      <input
                        type="checkbox"
                        checked={selected.has(user.id)}
                        onChange={() => toggleUser(user.id)}
                        aria-label={`选择用户 ${user.username}`}
                        className="rounded border-[var(--slate-6)] bg-surface text-accent focus:ring-0 focus:ring-offset-0"
                      />
                    ) : null}
                  </td>
                  <td className="py-2 px-3">
                    <UserCell user={user} />
                  </td>
                  <td className="py-2 px-3">
                    <span
                      className={`inline-block px-1.5 py-0.2 rounded text-[11px] font-mono border-[0.5px] ${
                        isAdmin
                          ? "border-radix-amber-6 bg-radix-amber-3 text-radix-amber-11"
                          : "border-[var(--slate-6)] bg-surface text-foreground-muted"
                      }`}
                    >
                      {isAdmin ? "管理员" : "用户"}
                    </span>
                  </td>
                  <td className="py-2 px-3">
                    <HealthText value={user.status} />
                  </td>
                  <td className="py-2 px-3 font-mono text-foreground-muted">
                    {user.activeSessionCount}
                  </td>
                  <td className="py-2 px-3 font-mono text-foreground-muted">
                    {user.onlineRoomCount}
                  </td>
                  <td className="py-2 px-3 font-mono text-foreground-muted">
                    {formatTime(user.createdAt)}
                  </td>
                  <td className="py-2 px-3 font-mono text-foreground-muted">
                    {user.lastLoginAt ? formatTime(user.lastLoginAt) : "从未"}
                  </td>
                  <td className="py-2 px-3 text-right">
                    <button
                      className="rounded border-[0.5px] border-[var(--slate-6)] bg-surface px-2 py-0.5 text-xs text-foreground hover:bg-[var(--slate-4)] transition-colors"
                      onClick={(event) => {
                        event.stopPropagation();
                        openUser(user.id);
                      }}
                    >
                      详情
                    </button>
                  </td>
                </tr>
              );
            })}
            {!filteredUsers.length ? (
              <tr>
                <td colSpan={9} className="py-8 text-center text-xs text-foreground-muted">
                  没有符合条件的用户
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
