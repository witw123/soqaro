import { apiBaseUrl } from "./api-client";
import type {
  AdminIncident,
  AdminMaintenanceResult,
  AdminOverview,
  AdminProviderHealth,
  AdminRoomSummary,
  AdminSession,
  AdminTrackStats,
  AdminUserSummary,
  RoomChatMessage,
  SystemAnnouncement
} from "@soqaro/shared";

const csrfStorageKey = "soqaro-admin-csrf";
export const ADMIN_CONFIRM_REASON = "管理员面板确认操作";

export class AdminApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export type AdminRoomDetail = AdminRoomSummary & {
  name?: string | null;
  description?: string | null;
  createdAt?: string | null;
  playback: Record<string, unknown>;
  queue: unknown[];
  tracks: unknown[];
  members: unknown[];
};

export type AdminUserDetail = AdminUserSummary & {
  disabledAt: string | null;
  disabledReason: string | null;
  sessions: Array<{ id: string; createdAt: string; expiresAt: string }>;
  rooms: Array<{ id: string; joinCode: string; name: string; visibility: string; role: "host" | "member"; updatedAt: string }>;
  audits: Array<{ id: string; action: string; reason: string | null; result: string; createdAt: string }>;
};

function getCsrfToken() {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(csrfStorageKey);
  } catch {
    return null;
  }
}

async function request<T>(path: string, init: RequestInit = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const csrf = getCsrfToken();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(method !== "GET" && csrf ? { "x-admin-csrf": csrf } : {}),
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) {
    let message = `请求失败 (${response.status})`;
    try { const body = await response.json() as { message?: string }; message = body.message ?? message; } catch { /* plain response */ }
    throw new AdminApiError(message, response.status);
  }
  return response.json() as Promise<T>;
}

export const adminApi = {
  login: async (username: string, password: string, turnstileToken?: string) => {
    const session = await request<AdminSession>("/v1/admin/auth/login", { method: "POST", body: JSON.stringify({ username, password, turnstileToken }) });
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(csrfStorageKey, session.csrfToken);
      } catch {
        // Ignore
      }
    }
    return session;
  },
  logout: () => request<{ ok: boolean }>("/v1/admin/auth/logout", { method: "POST" }),
  session: () => request<AdminSession>("/v1/admin/session"),
  overview: () => request<AdminOverview>("/v1/admin/overview"),
  rooms: (query = "") => request<{ data: AdminRoomSummary[]; nextCursor: string | null; generatedAt: string }>(`/v1/admin/rooms${query ? `?q=${encodeURIComponent(query)}` : ""}`),
  room: (roomId: string) => request<AdminRoomDetail>(`/v1/admin/rooms/${encodeURIComponent(roomId)}`),
  terminateRoom: (roomId: string, expectedJoinCode: string, reason: string) => request<{ ok: boolean; alreadyTerminated: boolean }>(`/v1/admin/rooms/${encodeURIComponent(roomId)}/terminate`, { method: "POST", body: JSON.stringify({ expectedJoinCode, reason }) }),
  controlPlayback: (roomId: string, action: "pause" | "play" | "next" | "clear-queue", reason?: string) =>
    request<{ ok: boolean; action: string }>(`/v1/admin/rooms/${encodeURIComponent(roomId)}/playback`, { method: "POST", body: JSON.stringify({ action, reason }) }),
  kickMember: (roomId: string, memberId: string, reason?: string) =>
    request<{ ok: boolean; memberId: string }>(`/v1/admin/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(memberId)}`, { method: "DELETE", body: JSON.stringify({ reason }) }),
  listChat: (roomId: string, limit = 50) =>
    request<{ data: RoomChatMessage[] }>(`/v1/admin/rooms/${encodeURIComponent(roomId)}/chat?limit=${limit}`),
  deleteChat: (roomId: string, messageId: string, reason?: string) =>
    request<{ ok: boolean; messageId: string }>(`/v1/admin/rooms/${encodeURIComponent(roomId)}/chat/${encodeURIComponent(messageId)}`, { method: "DELETE", body: JSON.stringify({ reason }) }),
  users: (query = "") => request<{ data: AdminUserSummary[]; nextCursor: string | null; generatedAt: string }>(`/v1/admin/users${query ? `?q=${encodeURIComponent(query)}` : ""}`),
  user: (userId: string) => request<AdminUserDetail>(`/v1/admin/users/${encodeURIComponent(userId)}`),
  setUserStatus: (userId: string, status: "ACTIVE" | "DISABLED", reason: string) => request<{ ok: boolean; status: string }>(`/v1/admin/users/${encodeURIComponent(userId)}/status`, { method: "PATCH", body: JSON.stringify({ status, reason }) }),
  setUserRole: (userId: string, role: "ADMIN" | "USER", reason: string) =>
    request<{ ok: boolean; role: string }>(`/v1/admin/users/${encodeURIComponent(userId)}/role`, { method: "PATCH", body: JSON.stringify({ role, reason }) }),
  resetPassword: (userId: string, reason: string, newPassword?: string) =>
    request<{ ok: boolean; temporaryPassword?: string }>(`/v1/admin/users/${encodeURIComponent(userId)}/reset-password`, { method: "POST", body: JSON.stringify({ reason, newPassword }) }),
  revokeSessions: (userId: string, reason: string) => request<{ ok: boolean }>(`/v1/admin/users/${encodeURIComponent(userId)}/sessions/revoke`, { method: "POST", body: JSON.stringify({ reason }) }),
  incidents: () => request<{ data: AdminIncident[]; nextCursor: string | null; generatedAt: string }>("/v1/admin/incidents"),
  resolveIncident: (id: string, reason?: string) =>
    request<{ ok: boolean; id: string; status: string }>(`/v1/admin/incidents/${encodeURIComponent(id)}/resolve`, { method: "PATCH", body: JSON.stringify({ reason }) }),
  resolveAllIncidents: (reason?: string) =>
    request<{ ok: boolean; count: number }>("/v1/admin/incidents/resolve-all", { method: "POST", body: JSON.stringify({ reason }) }),
  audit: () => request<{ data: Array<{ id: string; actorUserId: string; action: string; targetType: string; targetId: string | null; reason: string | null; result: string; createdAt: string }>; nextCursor: string | null; generatedAt: string }>("/v1/admin/audit-logs"),
  system: () => request<AdminOverview>("/v1/admin/system"),
  providerHealth: () => request<{ data: AdminProviderHealth[] }>("/v1/admin/system/providers"),
  trackStats: () => request<AdminTrackStats>("/v1/admin/stats/tracks"),
  runMaintenance: () => request<AdminMaintenanceResult>("/v1/admin/system/maintenance", { method: "POST" }),
  announcements: () => request<{ data: SystemAnnouncement[] }>("/v1/admin/announcements"),
  createAnnouncement: (payload: { title: string; content: string; isActive?: boolean }) =>
    request<SystemAnnouncement>("/v1/admin/announcements", { method: "POST", body: JSON.stringify(payload) }),
  updateAnnouncement: (id: string, payload: { title?: string; content?: string; isActive?: boolean }) =>
    request<SystemAnnouncement>(`/v1/admin/announcements/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteAnnouncement: (id: string) =>
    request<{ ok: boolean; id: string }>(`/v1/admin/announcements/${encodeURIComponent(id)}`, { method: "DELETE" })
};
