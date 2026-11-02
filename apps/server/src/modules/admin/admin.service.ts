import { ConflictException, HttpException, HttpStatus, Injectable, NotFoundException, Optional, UnauthorizedException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { adminLoginRequestSchema, adminReasonSchema, adminUserStatusSchema, createAnnouncementRequestSchema, updateAnnouncementRequestSchema } from "@soqaro/shared";
import type { RoomMember } from "@soqaro/shared";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { RedisService } from "../../infra/redis/redis.service";
import { AuthService } from "../auth/auth.service";
import { TurnstileService } from "../auth/turnstile.service";
import { RoomService } from "../room/room.service";
import { RoomPresenceService } from "../room/services/room-presence.service";
import { RoomChatService } from "../room/services/room-chat.service";
import { PlaylistService } from "../playlist/playlist.service";
import { RoomRealtimePublisher } from "../room/services/room-realtime.publisher";
import { MetricsService } from "../../common/metrics/metrics.service";
import { getCorsOrigins, getRequestOrigin, isAllowedOrigin } from "../../common/cors/get-cors-origins";

export const adminSessionCookie = "soqaro_admin_session";
export const adminCsrfCookie = "soqaro_admin_csrf";
const adminAbsoluteTtlMs = 8 * 60 * 60 * 1000;
const adminIdleTtlMs = 30 * 60 * 1000;

export type AdminPrincipal = { userId: string; username: string; nickname: string; role: "ADMIN"; csrfToken: string; expiresAt: Date };

@Injectable()
export class AdminService implements OnModuleInit, OnModuleDestroy {
  private readonly developmentAuditHashSecret = randomBytes(32).toString("hex");
  private heartbeatTimer?: NodeJS.Timeout;
  private tombstoneTimer?: NodeJS.Timeout;
  private sessionCleanupTimer?: NodeJS.Timeout;
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly auth: AuthService,
    private readonly roomService: RoomService,
    private readonly roomPresence: RoomPresenceService,
    private readonly playlistService: PlaylistService,
    private readonly roomPublisher: RoomRealtimePublisher,
    private readonly turnstile: TurnstileService,
    private readonly roomChatService: RoomChatService,
    @Optional() private readonly metricsService?: MetricsService
  ) {}

  onModuleInit() {
    this.heartbeatTimer = setInterval(() => { void this.writeInstanceHeartbeat(); }, 10_000);
    this.tombstoneTimer = setInterval(() => { void this.retryPendingTombstones(); }, 10_000);
    this.sessionCleanupTimer = setInterval(() => { void this.cleanupExpiredSessions(); }, 60 * 60 * 1000);
    void this.writeInstanceHeartbeat();
    void this.cleanupExpiredSessions();
  }

  onModuleDestroy() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.tombstoneTimer) clearInterval(this.tombstoneTimer);
    if (this.sessionCleanupTimer) clearInterval(this.sessionCleanupTimer);
  }

  private async cleanupExpiredSessions() {
    if (!(await this.prisma.ensureAvailable())) return;
    await this.prisma.adminSession.deleteMany({
      where: {
        OR: [
          { expiresAt: { lte: new Date() } },
          { revokedAt: { not: null } }
        ]
      }
    }).catch(() => undefined);
  }

  private async writeInstanceHeartbeat() {
    if (!this.redis.isAvailable()) return;
    const instanceId = process.env.INSTANCE_ID?.trim() || process.env.HOSTNAME || `instance-${process.pid}`;
    await this.redis.setJson(`soqaro:admin:instance:${instanceId}`, { instanceId, version: process.env.RELEASE_TAG || "dev", startedAt: process.uptime() }, 30).catch(() => undefined);
    await this.redis.addSortedSetScore("soqaro:admin:instances", Date.now(), instanceId).catch(() => undefined);
  }

  private async retryPendingTombstones() {
    if (!(await this.prisma.ensureAvailable())) return;
    const pending = await this.prisma.roomTombstone.findMany({ where: { status: "PENDING", expiresAt: { gt: new Date() } }, take: 20 });
    for (const tombstone of pending) {
      try {
        await this.roomService.deleteRoomByAdmin(tombstone.roomId);
        await this.playlistService.deletePlaylistsForRoom(tombstone.roomId);
        this.roomPublisher.emitRoomDeleted(tombstone.roomId, Array.isArray(tombstone.trackIds) ? tombstone.trackIds.filter((id): id is string => typeof id === "string") : []);
        this.roomPublisher.emitRoomMissing(tombstone.roomId);
        await this.prisma.roomTombstone.update({ where: { roomId: tombstone.roomId }, data: { status: "SUCCEEDED" } });
      } catch (error) {
        if (error instanceof Error && error.message.includes("Room not found")) {
          await this.prisma.roomTombstone.update({ where: { roomId: tombstone.roomId }, data: { status: "SUCCEEDED" } }).catch(() => undefined);
        }
      }
    }
  }

  async login(input: unknown, request: Request) {
    const payload = adminLoginRequestSchema.parse(input);
    if (process.env.NODE_ENV === "production" && !process.env.AUDIT_HASH_SECRET?.trim()) {
      throw new UnauthorizedException("管理员审计密钥未配置。");
    }
    if (this.turnstile) {
      await this.turnstile.verify(
        payload.turnstileToken,
        request.ip || request.socket.remoteAddress || "unknown"
      );
    } else if (process.env.NODE_ENV === "production") {
      throw new UnauthorizedException("管理员人机验证服务未配置。");
    }
    await this.assertLoginAllowed(payload.username, request);
    let user: Awaited<ReturnType<AuthService["authenticateCredentials"]>>;
    try {
      user = await this.auth.authenticateCredentials(payload);
    } catch {
      throw new UnauthorizedException("用户名或密码错误。");
    }
    if (user.role !== "ADMIN" || user.status !== "ACTIVE") {
      throw new UnauthorizedException("管理员账号不可用。");
    }
    if (!(await this.prisma.ensureAvailable())) throw new UnauthorizedException("数据库暂不可用。");
    const sessionToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + adminAbsoluteTtlMs);
    await this.prisma.adminSession.create({ data: { id: `admin_session_${randomUUID()}`, userId: user.id, tokenHash: hashToken(sessionToken), csrfHash: hashToken(csrfToken), createdAt: now, lastActiveAt: now, expiresAt } });
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
    await this.writeAudit(user.id, "admin.login", "user", user.id, null, "SUCCEEDED", request);
    return { sessionToken, csrfToken, principal: { userId: user.id, username: user.username, nickname: user.nickname, role: "ADMIN" as const, expiresAt: expiresAt.toISOString() } };
  }

  private async assertLoginAllowed(username: string, request: Request) {
    if (!this.redis.isAvailable()) {
      if (process.env.NODE_ENV === "production") throw new UnauthorizedException("登录限流依赖暂不可用。");
      return;
    }
    const ip = request.ip || request.socket.remoteAddress || "unknown";
    const normalized = username.trim().toLowerCase();
    const windowMs = 15 * 60 * 1000;
    const [ipCount, userCount] = await Promise.all([
      this.redis.incrementWithTtlMs(`soqaro:admin:login:ip:${createHash("sha256").update(ip).digest("hex")}`, windowMs),
      this.redis.incrementWithTtlMs(`soqaro:admin:login:user:${createHash("sha256").update(normalized).digest("hex")}`, windowMs)
    ]);
    if (ipCount > 5 || userCount > 5) throw new HttpException("登录尝试过于频繁，请稍后再试。", HttpStatus.TOO_MANY_REQUESTS);
  }

  async validateRequest(request: Request): Promise<AdminPrincipal> {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[adminSessionCookie];
    if (!token || !(await this.prisma.ensureAvailable())) throw new UnauthorizedException("需要管理员登录。");
    const row = await this.prisma.adminSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
    const now = Date.now();
    if (!row || row.revokedAt || row.expiresAt.getTime() <= now || row.lastActiveAt.getTime() + adminIdleTtlMs <= now || row.user.role !== "ADMIN" || row.user.status !== "ACTIVE") throw new UnauthorizedException("管理员会话已失效。");
    if (request.method !== "GET") {
      const csrfHeader = request.headers["x-admin-csrf"];
      const csrfCookie = cookies[adminCsrfCookie];
      if (!csrfHeader || !csrfCookie || !safeEqual(hashToken(String(csrfHeader)), row.csrfHash) || !safeEqual(hashToken(csrfCookie), row.csrfHash)) throw new UnauthorizedException("CSRF 校验失败。");
      const origin = request.headers.origin;
      const allowedOrigins = getCorsOrigins();
      if (!isAllowedOrigin(origin, getRequestOrigin(request), allowedOrigins)) throw new UnauthorizedException("Origin 校验失败。");
    }
    if (now - row.lastActiveAt.getTime() > 5 * 60 * 1000) void this.prisma.adminSession.update({ where: { id: row.id }, data: { lastActiveAt: new Date() } });
    return { userId: row.user.id, username: row.user.username, nickname: row.user.nickname, role: "ADMIN", csrfToken: cookies[adminCsrfCookie] ?? "", expiresAt: row.expiresAt };
  }

  async logout(request: Request) {
    if (!(await this.prisma.ensureAvailable())) return { ok: true };
    const token = parseCookies(request.headers.cookie)[adminSessionCookie];
    if (token) await this.prisma.adminSession.updateMany({ where: { tokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: new Date() } });
    return { ok: true };
  }

  async overview() {
    const now = new Date();
    const [users, rooms, incidents] = await Promise.all([this.prisma.user.findMany({ select: { status: true } }), this.prisma.roomState.findMany({ orderBy: { updatedAt: "desc" } }), this.prisma.operationalIncident.count({ where: { status: "OPEN" } })]);
    const summaries = await Promise.all(rooms.map((room) => this.roomSummary(room)));
    const activeRooms = summaries.filter((room) => room.onlineMemberCount > 0);
    const playbackActive = summaries.filter((room) => room.playbackStatus === "playing").length;
    let instances = 1;
    if (this.redis.isAvailable()) {
      const active = await this.redis.getSortedSetMembersByScore("soqaro:admin:instances", Date.now() - 30_000, "+inf").catch(() => []);
      instances = Math.max(1, active.length);
    }
    const healthy = summaries.filter((room) => room.health === "healthy").length;
    const degraded = summaries.filter((room) => room.health === "degraded").length;
    const critical = summaries.filter((room) => room.health === "critical").length;
    const unknown = summaries.filter((room) => room.health === "unknown").length;
    const mem = process.memoryUsage();
    const metricsSnapshot = this.metricsService?.snapshot() ?? {
      wsConnections: 0,
      activeRooms: 0,
      realtimeFailures: 0,
      playbackConflicts: 0,
      iceFailures: 0,
      diagnosticsReports: 0,
      diagnosticsRateLimited: 0
    };
    return {
      generatedAt: now.toISOString(),
      dependencies: {
        prisma: this.prisma.isAvailable() ? "up" : "down",
        redis: this.redis.isAvailable() ? "up" : "down",
        redisMode: this.redis.getMode()
      },
      runtime: {
        uptimeSeconds: Math.floor(process.uptime()),
        memoryHeapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
        memoryHeapTotalMb: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
        memoryRssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10
      },
      network: {
        wsConnections: metricsSnapshot.wsConnections,
        realtimeFailures: metricsSnapshot.realtimeFailures,
        playbackConflicts: metricsSnapshot.playbackConflicts,
        iceFailures: metricsSnapshot.iceFailures
      },
      users: {
        total: users.length,
        online: new Set(summaries.flatMap((room) => room.onlineUserIds)).size,
        disabled: users.filter((user) => user.status === "DISABLED").length
      },
      rooms: {
        total: rooms.length,
        active: activeRooms.length,
        healthy,
        degraded,
        critical,
        unknown
      },
      playback: {
        active: playbackActive,
        paused: Math.max(0, rooms.length - playbackActive)
      },
      openIncidents: incidents,
      instances
    };
  }

  async listRooms(query: { q?: string; limit?: number }) {
    const q = query.q?.trim();
    const rows = await this.prisma.roomState.findMany({
      where: q
        ? {
            OR: [
              { id: { contains: q, mode: "insensitive" } },
              { joinCode: { contains: q, mode: "insensitive" } }
            ]
          }
        : undefined,
      orderBy: { updatedAt: "desc" },
      take: Math.min(query.limit ?? 50, 100)
    });
    const data = await Promise.all(rows.map((row) => this.roomSummary(row)));
    return { data, nextCursor: null, generatedAt: new Date().toISOString() };
  }

  async roomDetail(roomId: string) {
    const row = await this.prisma.roomState.findUnique({ where: { id: roomId } });
    if (!row) throw new NotFoundException("房间不存在。");
    const members = Array.isArray(row.members) ? row.members as Array<{ id?: string; peerId?: string | null; presenceState?: string; [key: string]: unknown }> : [];
    const livePresence = await this.roomPresence.getPresenceSnapshot(row.id, members as RoomMember[]);
    const summary = await this.roomSummary(row, livePresence);
    const liveMembers = members.map((member) => {
      if (!member.id) return member;
      const live = livePresence.get(member.id);
      return live ? { ...member, peerId: live.peerId, presenceState: live.presenceState } : { ...member, peerId: null, presenceState: "offline" };
    });
    return {
      ...summary,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      hostId: row.hostId,
      createdAt: row.createdAt.toISOString(),
      playback: row.playback,
      queue: row.queue,
      tracks: row.tracks,
      members: liveMembers
    };
  }

  async listUsers(query: { q?: string; limit?: number }) {
    const q = query.q?.trim();
    const [rows, rooms] = await Promise.all([
      this.prisma.user.findMany({
        where: q
          ? {
              OR: [
                { username: { contains: q, mode: "insensitive" } },
                { nickname: { contains: q, mode: "insensitive" } }
              ]
            }
          : undefined,
        orderBy: { createdAt: "desc" },
        take: Math.min(query.limit ?? 50, 100),
        include: { userSessions: { where: { expiresAt: { gt: new Date() } }, select: { id: true } } }
      }),
      this.prisma.roomState.findMany({ select: { id: true, members: true } })
    ]);
    const onlineRoomCounts = new Map<string, number>();
    await Promise.all(rooms.map(async (room) => {
      const members = Array.isArray(room.members) ? room.members as Array<{ id?: string; peerId?: string | null; presenceState?: string }> : [];
      const livePresence = await this.roomPresence.getPresenceSnapshot(room.id, members as RoomMember[]);
      for (const member of members) {
        if (member.id && livePresence.get(member.id)?.presenceState === "online") onlineRoomCounts.set(member.id, (onlineRoomCounts.get(member.id) ?? 0) + 1);
      }
    }));
    const data = rows.map((row) => ({ id: row.id, username: row.username, nickname: row.nickname, role: row.role, status: row.status, createdAt: row.createdAt.toISOString(), lastLoginAt: row.lastLoginAt?.toISOString() ?? null, activeSessionCount: row.userSessions.length, onlineRoomCount: onlineRoomCounts.get(row.id) ?? 0 }));
    return { data, nextCursor: null, generatedAt: new Date().toISOString() };
  }

  async userDetail(userId: string) {
    const [user, roomRows] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, nickname: true, role: true, status: true, createdAt: true, lastLoginAt: true, disabledAt: true, disabledReason: true, userSessions: { where: { expiresAt: { gt: new Date() } }, select: { id: true, createdAt: true, expiresAt: true } } } }),
      this.prisma.roomState.findMany({ select: { id: true, joinCode: true, name: true, visibility: true, hostId: true, members: true, updatedAt: true } })
    ]);
    if (!user) throw new NotFoundException("用户不存在。");
    const audits = await this.prisma.adminAuditLog.findMany({ where: { targetType: "user", targetId: userId }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, action: true, reason: true, result: true, createdAt: true } });
    const rooms = roomRows
      .filter((room) => room.hostId === userId || (Array.isArray(room.members) && room.members.some((member) => (member as { id?: string }).id === userId)))
      .map((room) => ({
        id: room.id,
        joinCode: room.joinCode,
        name: room.name,
        visibility: room.visibility,
        role: room.hostId === userId ? "host" : "member",
        updatedAt: room.updatedAt.toISOString()
      }));
    return { ...user, createdAt: user.createdAt.toISOString(), lastLoginAt: user.lastLoginAt?.toISOString() ?? null, disabledAt: user.disabledAt?.toISOString() ?? null, sessions: user.userSessions.map((session) => ({ ...session, createdAt: session.createdAt.toISOString(), expiresAt: session.expiresAt.toISOString() })), rooms, audits: audits.map((audit) => ({ ...audit, createdAt: audit.createdAt.toISOString() })) };
  }

  async setUserStatus(actor: AdminPrincipal, userId: string, statusInput: unknown, request: Request) {
    this.assertMutationsEnabled();
    const payload = adminUserStatusSchema.parse((statusInput as { status?: unknown }).status);
    if (userId === actor.userId) throw new ConflictException("不能修改当前管理员账号。");
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role === "ADMIN") throw new NotFoundException("普通用户不存在。");
    const reason = adminReasonSchema.parse((statusInput as { reason?: unknown }).reason);
    const disabled = payload === "DISABLED";
    await this.prisma.$transaction(async (tx) => { await tx.user.update({ where: { id: userId }, data: { status: payload, disabledAt: disabled ? new Date() : null, disabledReason: disabled ? reason : null } }); if (disabled) await tx.userSession.deleteMany({ where: { userId } }); await tx.adminAuditLog.create({ data: { id: `audit_${randomUUID()}`, actorUserId: actor.userId, action: disabled ? "user.disable" : "user.enable", targetType: "user", targetId: userId, reason, result: "SUCCEEDED", userAgent: request.headers["user-agent"] ?? null } }); });
    await this.auth.invalidateSessionsForUser(userId);
    await this.publishUserInvalidated(userId);
    return { ok: true, status: payload };
  }

  async revokeUserSessions(actor: AdminPrincipal, userId: string, reason: string, request: Request) {
    this.assertMutationsEnabled();
    if (userId === actor.userId) throw new ConflictException("不能撤销当前管理员会话。");
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role === "ADMIN") throw new NotFoundException("普通用户不存在。");
    await this.prisma.userSession.deleteMany({ where: { userId } });
    await this.writeAudit(actor.userId, "user.sessions.revoke", "user", userId, adminReasonSchema.parse(reason), "SUCCEEDED", request);
    await this.auth.invalidateSessionsForUser(userId);
    await this.publishUserInvalidated(userId);
    return { ok: true };
  }

  async terminateRoom(actor: AdminPrincipal, roomId: string, payload: { reason: string; expectedJoinCode: string }, request: Request) {
    this.assertMutationsEnabled();
    const reason = adminReasonSchema.parse(payload.reason);
    const room = await this.prisma.roomState.findUnique({ where: { id: roomId } });
    if (!room) return { ok: true, alreadyTerminated: true };
    if (room.joinCode !== payload.expectedJoinCode) throw new ConflictException("房间码已变化，请刷新后重试。");
    const tracks = Array.isArray(room.tracks) ? room.tracks.map((track) => (track as { id?: string }).id).filter((id): id is string => !!id) : [];
    await this.prisma.roomTombstone.upsert({ where: { roomId }, create: { id: `tombstone_${randomUUID()}`, roomId, trackIds: tracks, reason, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) }, update: { trackIds: tracks, reason, status: "PENDING" } });
    await this.roomService.deleteRoomByAdmin(roomId);
    await this.playlistService.deletePlaylistsForRoom(roomId);
    this.roomPublisher.emitRoomDeleted(roomId, tracks);
    this.roomPublisher.emitRoomMissing(roomId);
    await this.prisma.roomTombstone.update({ where: { roomId }, data: { status: "SUCCEEDED" } });
    await this.writeAudit(actor.userId, "room.terminate", "room", roomId, reason, "SUCCEEDED", request);
    return { ok: true, alreadyTerminated: false };
  }

  private assertMutationsEnabled() {
    if (process.env.ADMIN_MUTATIONS_ENABLED === "false") throw new ConflictException("管理动作当前已关闭。");
  }

  // ── Incident Lifecycle ────────────────────────────────────────────────────────

  async resolveIncident(actor: AdminPrincipal, incidentId: string, reason: string | null, request: Request) {
    const incident = await this.prisma.operationalIncident.findUnique({ where: { id: incidentId } });
    if (!incident) throw new NotFoundException("异常事件不存在。");
    if (incident.status === "RECOVERED") return { ok: true, alreadyResolved: true };
    const now = new Date();
    await this.prisma.operationalIncident.update({
      where: { id: incidentId },
      data: { status: "RECOVERED", recoveredAt: now }
    });
    await this.writeAudit(actor.userId, "incident.resolve", "incident", incidentId, reason, "SUCCEEDED", request);
    return { ok: true, id: incidentId, status: "RECOVERED", recoveredAt: now.toISOString() };
  }

  async resolveAllIncidents(actor: AdminPrincipal, reason: string | null, request: Request) {
    const now = new Date();
    const result = await this.prisma.operationalIncident.updateMany({
      where: { status: "OPEN" },
      data: { status: "RECOVERED", recoveredAt: now }
    });
    await this.writeAudit(actor.userId, "incident.resolve_all", "incident", null, reason, "SUCCEEDED", request);
    return { ok: true, count: result.count, recoveredAt: now.toISOString() };
  }

  // ── Room Moderation & Playback Control ──────────────────────────────────────

  async controlRoomPlayback(
    actor: AdminPrincipal,
    roomId: string,
    action: "pause" | "play" | "next" | "clear-queue",
    reason: string | null,
    request: Request
  ) {
    this.assertMutationsEnabled();
    const room = await this.prisma.roomState.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException("房间不存在。");
    const result = await this.roomService.controlPlaybackByAdmin(roomId, action);
    await this.writeAudit(
      actor.userId,
      "room.playback_control",
      "room",
      roomId,
      `${action}${reason ? `: ${reason}` : ""}`,
      "SUCCEEDED",
      request
    );
    return result;
  }

  async kickRoomMember(
    actor: AdminPrincipal,
    roomId: string,
    memberId: string,
    reason: string | null,
    request: Request
  ) {
    this.assertMutationsEnabled();
    const room = await this.prisma.roomState.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException("房间不存在。");
    await this.roomService.removeMemberByAdmin(roomId, memberId);
    this.roomPublisher.emitTopologySnapshot(roomId);
    this.roomPublisher.emitMemberRemoved(roomId, memberId);
    await this.writeAudit(
      actor.userId,
      "room.kick_member",
      "room",
      roomId,
      `member=${memberId}${reason ? `, reason=${reason}` : ""}`,
      "SUCCEEDED",
      request
    );
    return { ok: true, memberId, roomId };
  }

  async listRoomChat(roomId: string, limit = 50) {
    if (!this.roomChatService) return { data: [] };
    const data = await this.roomChatService.listHistoryForAdmin(roomId, limit);
    return { data };
  }

  async deleteRoomChatMessage(
    actor: AdminPrincipal,
    roomId: string,
    messageId: string,
    reason: string | null,
    request: Request
  ) {
    this.assertMutationsEnabled();
    if (!this.roomChatService) throw new ConflictException("聊天服务暂未挂载。");
    const deleted = await this.roomChatService.deleteMessageByAdmin(roomId, messageId);
    this.roomPublisher.emitChatDeleted(roomId, messageId);
    await this.writeAudit(
      actor.userId,
      "room.delete_chat",
      "room",
      roomId,
      `messageId=${messageId}${reason ? `, reason=${reason}` : ""}`,
      "SUCCEEDED",
      request
    );
    return { ok: true, ...deleted };
  }

  // ── User Governance ─────────────────────────────────────────────────────────

  async setUserRole(
    actor: AdminPrincipal,
    userId: string,
    newRole: "ADMIN" | "USER",
    reason: string,
    request: Request
  ) {
    this.assertMutationsEnabled();
    if (userId === actor.userId) throw new ConflictException("不能修改当前管理员自身的角色。");
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("用户不存在。");
    if (user.role === newRole) return { ok: true, role: newRole };
    await this.prisma.user.update({
      where: { id: userId },
      data: { role: newRole }
    });
    if (newRole === "USER") {
      await this.prisma.adminSession.deleteMany({ where: { userId } }).catch(() => undefined);
    }
    await this.writeAudit(
      actor.userId,
      "user.set_role",
      "user",
      userId,
      `${reason} (${user.role} -> ${newRole})`,
      "SUCCEEDED",
      request
    );
    return { ok: true, role: newRole };
  }

  async resetUserPassword(
    actor: AdminPrincipal,
    userId: string,
    newPasswordInput: string | undefined,
    reason: string,
    request: Request
  ) {
    this.assertMutationsEnabled();
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("用户不存在。");
    if (user.id === actor.userId) throw new ConflictException("管理员重置自身密码请在设置页进行。");
    const plainPassword = newPasswordInput?.trim() || randomBytes(6).toString("hex");
    const passwordHash = await this.auth.hashPassword(plainPassword);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash }
    });
    await this.prisma.userSession.deleteMany({ where: { userId } }).catch(() => undefined);
    await this.prisma.adminSession.deleteMany({ where: { userId } }).catch(() => undefined);
    await this.auth.invalidateSessionsForUser(userId);
    await this.publishUserInvalidated(userId);
    await this.writeAudit(
      actor.userId,
      "user.reset_password",
      "user",
      userId,
      reason,
      "SUCCEEDED",
      request
    );
    return { ok: true, temporaryPassword: plainPassword };
  }

  // ── Provider Health Diagnostics ─────────────────────────────────────────────

  async checkProvidersHealth(): Promise<{ data: import("@soqaro/shared").AdminProviderHealth[] }> {
    const now = new Date().toISOString();

    const probe = async (
      provider: "bilibili" | "netease" | "qqmusic",
      name: string,
      url: string,
      hasCredentials: boolean,
      headers: Record<string, string> = {}
    ): Promise<import("@soqaro/shared").AdminProviderHealth> => {
      const start = Date.now();
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3500);
        const res = await fetch(url, { method: "HEAD", headers, signal: controller.signal });
        clearTimeout(timeout);
        const latencyMs = Date.now() - start;
        return {
          provider,
          name,
          status: res.status < 500 ? (latencyMs > 1500 ? "degraded" : "healthy") : "down",
          latencyMs,
          message: res.status < 500 ? "接口正常响应" : `HTTP 状态异常 (${res.status})`,
          hasCredentials,
          checkedAt: now
        };
      } catch (error) {
        return {
          provider,
          name,
          status: "down",
          latencyMs: null,
          message: error instanceof Error ? error.message : "连接超时或网络异常",
          hasCredentials,
          checkedAt: now
        };
      }
    };

    const hasBiliCookie = !!(process.env.BILIBILI_COOKIE?.trim());
    const hasNeteaseCookie = !!(process.env.NETEASE_COOKIE?.trim());
    const hasQqMusicCookie = !!(process.env.QQMUSIC_COOKIE?.trim());

    const results = await Promise.all([
      probe("bilibili", "哔哩哔哩 (Bilibili)", "https://api.bilibili.com/x/frontend/finger/spi", hasBiliCookie, {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
      }),
      probe("netease", "网易云音乐 (Netease)", "https://music.163.com/api/v1/resource/comments/R_SO_4_1", hasNeteaseCookie),
      probe("qqmusic", "QQ音乐 (QQMusic)", "https://u.y.qq.com/cgi-bin/musicu.fcg", hasQqMusicCookie)
    ]);

    return { data: results };
  }

  async listIncidents(limit = 50) { return { data: await this.prisma.operationalIncident.findMany({ orderBy: { lastSeenAt: "desc" }, take: Math.min(limit, 100) }), nextCursor: null, generatedAt: new Date().toISOString() }; }
  async listAudit(limit = 50) { return { data: await this.prisma.adminAuditLog.findMany({ orderBy: { createdAt: "desc" }, take: Math.min(limit, 100), select: { id: true, actorUserId: true, action: true, targetType: true, targetId: true, reason: true, result: true, createdAt: true } }), nextCursor: null, generatedAt: new Date().toISOString() }; }

  async listAnnouncements() {
    if (!(await this.prisma.ensureAvailable())) return { data: [] };
    const items = await this.prisma.systemAnnouncement.findMany({
      orderBy: { createdAt: "desc" }
    });
    return {
      data: items.map((item) => ({
        id: item.id,
        title: item.title,
        content: item.content,
        isActive: item.isActive,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString()
      }))
    };
  }

  async createAnnouncement(admin: AdminPrincipal, body: unknown, request: Request) {
    if (!(await this.prisma.ensureAvailable())) {
      throw new HttpException("数据库暂不可用", HttpStatus.SERVICE_UNAVAILABLE);
    }
    const parsed = createAnnouncementRequestSchema.parse(body);
    const id = randomUUID();
    const item = await this.prisma.systemAnnouncement.create({
      data: {
        id,
        title: parsed.title,
        content: parsed.content,
        isActive: parsed.isActive ?? true
      }
    });
    await this.writeAudit(
      admin.userId,
      "announcement.create",
      "announcement",
      item.id,
      `创建系统公告: ${item.title}`,
      "success",
      request
    );
    return {
      id: item.id,
      title: item.title,
      content: item.content,
      isActive: item.isActive,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString()
    };
  }

  async updateAnnouncement(admin: AdminPrincipal, id: string, body: unknown, request: Request) {
    if (!(await this.prisma.ensureAvailable())) {
      throw new HttpException("数据库暂不可用", HttpStatus.SERVICE_UNAVAILABLE);
    }
    const parsed = updateAnnouncementRequestSchema.parse(body);
    const existing = await this.prisma.systemAnnouncement.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException("公告不存在");
    }
    const updated = await this.prisma.systemAnnouncement.update({
      where: { id },
      data: {
        ...(parsed.title !== undefined ? { title: parsed.title } : {}),
        ...(parsed.content !== undefined ? { content: parsed.content } : {}),
        ...(parsed.isActive !== undefined ? { isActive: parsed.isActive } : {})
      }
    });
    await this.writeAudit(
      admin.userId,
      "announcement.update",
      "announcement",
      id,
      `更新系统公告: ${updated.title} (启用状态: ${updated.isActive})`,
      "success",
      request
    );
    return {
      id: updated.id,
      title: updated.title,
      content: updated.content,
      isActive: updated.isActive,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString()
    };
  }

  async deleteAnnouncement(admin: AdminPrincipal, id: string, request: Request) {
    if (!(await this.prisma.ensureAvailable())) {
      throw new HttpException("数据库暂不可用", HttpStatus.SERVICE_UNAVAILABLE);
    }
    const existing = await this.prisma.systemAnnouncement.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException("公告不存在");
    }
    await this.prisma.systemAnnouncement.delete({ where: { id } });
    await this.writeAudit(
      admin.userId,
      "announcement.delete",
      "announcement",
      id,
      `删除系统公告: ${existing.title}`,
      "success",
      request
    );
    return { ok: true, id };
  }

  private async roomSummary(row: { id: string; joinCode: string; name?: string | null; description?: string | null; createdAt?: Date; visibility: string; hostId: string; members: unknown; tracks?: unknown; playback: unknown; updatedAt: Date }, livePresence?: Map<string, { peerId: string | null; presenceState: string }>) {
    const members = Array.isArray(row.members) ? row.members as Array<{ id?: string; nickname?: string; presenceState?: string; peerId?: string | null }> : [];
    const playback = (row.playback ?? {}) as { status?: string; currentTrackId?: string };
    const tracks = Array.isArray(row.tracks) ? row.tracks as Array<{ id?: string; title?: string }> : [];
    const presence = livePresence ?? await this.roomPresence.getPresenceSnapshot(row.id, members as RoomMember[]);
    const onlineMembers = members.filter((member) => member.id && presence.get(member.id)?.presenceState === "online");
    const reportedPeerIds = await this.readReportedPeerIds(row.id);
    const reported = onlineMembers.filter((member) => { const peerId = presence.get(member.id!)?.peerId; return !!peerId && reportedPeerIds.has(peerId); }).length;
    const health = await this.resolveRoomHealth(row.id, onlineMembers, presence, reportedPeerIds);
    return { id: row.id, joinCode: row.joinCode, name: row.name ?? null, description: row.description ?? null, createdAt: row.createdAt?.toISOString() ?? null, visibility: row.visibility, hostId: row.hostId, hostNickname: members.find((member) => member.id === row.hostId)?.nickname ?? null, memberCount: members.length, onlineMemberCount: onlineMembers.length, onlineUserIds: onlineMembers.map((member) => member.id!), playbackStatus: playback.status ?? "idle", currentTrackTitle: tracks.find((track) => track.id === playback.currentTrackId)?.title ?? null, health, telemetryCoverage: { reported, total: onlineMembers.length }, updatedAt: row.updatedAt.toISOString() };
  }

  private async resolveRoomHealth(roomId: string, onlineMembers: Array<{ id?: string }>, livePresence: Map<string, { peerId: string | null; presenceState: string }>, reportedPeerIds: Set<string>) {
    if (onlineMembers.length === 0) return "unknown" as const;
    if (!this.redis.isAvailable() || reportedPeerIds.size === 0) return "unknown" as const;
    const peerIds = onlineMembers.map((member) => member.id ? livePresence.get(member.id)?.peerId : null).filter((peerId): peerId is string => !!peerId && reportedPeerIds.has(peerId));
    if (peerIds.length < onlineMembers.length) return "degraded" as const;
    let rawReports: Array<string | null>;
    try {
      rawReports = await this.redis.getStrings(peerIds.map((peerId) => "soqaro:admin:telemetry:peer:" + roomId + ":" + peerId));
    } catch {
      return "unknown" as const;
    }
    let hasDegraded = false;
    let missingReport = false;
    for (const raw of rawReports) {
      if (!raw) { missingReport = true; continue; }
      try {
        const report = JSON.parse(raw) as { peers?: Array<{ mediaConnectionState?: string | null; mediaTrackState?: string | null; packetLossRate?: number | null; jitterMs?: number | null; rttMs?: number | null }> };
        for (const peer of report.peers ?? []) {
          if (peer.mediaConnectionState === "failed" || peer.mediaTrackState === "failed" || (peer.packetLossRate ?? 0) >= 0.05 || (peer.jitterMs ?? 0) >= 50 || (peer.rttMs ?? 0) >= 500) return "critical" as const;
          if ((peer.mediaConnectionState && !["connected", "completed", "new"].includes(peer.mediaConnectionState)) || (peer.packetLossRate ?? 0) >= 0.03 || (peer.jitterMs ?? 0) >= 30 || (peer.rttMs ?? 0) >= 250 || peer.mediaTrackState === "ended") hasDegraded = true;
        }
      } catch { hasDegraded = true; }
    }
    return missingReport || hasDegraded ? "degraded" as const : "healthy" as const;
  }

  private async readReportedPeerIds(roomId: string) {
    if (!this.redis.isAvailable()) return new Set<string>();
    const members = await this.redis.getSortedSetMembersByScore(`soqaro:admin:telemetry:room-peers:${roomId}`, Date.now() - 45_000, "+inf").catch(() => []);
    return new Set(members);
  }

  private async publishUserInvalidated(userId: string) {
    if (this.redis.isPubSubAvailable()) await this.redis.publish("soqaro:auth:user-invalidated", { userId, at: new Date().toISOString() });
  }


  async getTrackStats(): Promise<import("@soqaro/shared").AdminTrackStats> {
    if (!(await this.prisma.ensureAvailable())) {
      return { totalTracks: 0, sourceDistribution: {} };
    }
    const rooms = await this.prisma.roomState.findMany({ select: { tracks: true } });
    const distribution: Record<string, number> = {
      bilibili: 0,
      netease: 0,
      qqmusic: 0,
      local_upload: 0,
      alist: 0,
      other: 0
    };
    let total = 0;
    for (const room of rooms) {
      const tracks = Array.isArray(room.tracks) ? (room.tracks as Array<{ source?: string }>) : [];
      for (const track of tracks) {
        total += 1;
        const source = (track.source ?? "").toLowerCase();
        if (source === "bilibili" || source.includes("bili")) {
          distribution.bilibili += 1;
        } else if (source === "netease" || source.includes("163")) {
          distribution.netease += 1;
        } else if (source === "qqmusic" || source.includes("qq")) {
          distribution.qqmusic += 1;
        } else if (source === "local_upload" || source === "local") {
          distribution.local_upload += 1;
        } else if (source === "alist") {
          distribution.alist += 1;
        } else {
          distribution.other += 1;
        }
      }
    }
    return { totalTracks: total, sourceDistribution: distribution };
  }

  async runSystemMaintenance(
    admin: AdminPrincipal,
    request: Request
  ): Promise<import("@soqaro/shared").AdminMaintenanceResult> {
    this.assertMutationsEnabled();
    let cleanedSessions = 0;
    let cleanedTombstones = 0;
    if (await this.prisma.ensureAvailable()) {
      const now = new Date();
      const [adminSessionRes, userSessionRes, tombstoneRes] = await Promise.all([
        this.prisma.adminSession.deleteMany({
          where: {
            OR: [
              { expiresAt: { lte: now } },
              { revokedAt: { not: null } }
            ]
          }
        }).catch(() => ({ count: 0 })),
        this.prisma.userSession.deleteMany({
          where: { expiresAt: { lte: now } }
        }).catch(() => ({ count: 0 })),
        this.prisma.roomTombstone.deleteMany({
          where: { status: "SUCCEEDED" }
        }).catch(() => ({ count: 0 }))
      ]);
      cleanedSessions = adminSessionRes.count + userSessionRes.count;
      cleanedTombstones = tombstoneRes.count;
    }
    const redisLatencyMs = await this.redis.ping();
    await this.writeAudit(
      admin.userId,
      "system.maintenance",
      "system",
      null,
      `清理会话: ${cleanedSessions}, 清理墓碑: ${cleanedTombstones}, Redis延时: ${redisLatencyMs !== null ? `${redisLatencyMs}ms` : "不可用"}`,
      "SUCCEEDED",
      request
    );
    return { cleanedSessions, cleanedTombstones, redisLatencyMs };
  }

  private async writeAudit(actorUserId: string, action: string, targetType: string, targetId: string | null, reason: string | null, result: string, request: Request) {
    if (!(await this.prisma.ensureAvailable())) return;
    const hashSecret = process.env.AUDIT_HASH_SECRET?.trim();
    if (!hashSecret && process.env.NODE_ENV === "production") {
      throw new Error("AUDIT_HASH_SECRET must be configured in production.");
    }
    const ip = request.ip || request.socket.remoteAddress || "unknown";
    // Non-production fallback is a per-process random so the audit ipHash can
    // never be brute-forced from a published source constant.
    const effectiveHashSecret = hashSecret || this.developmentAuditHashSecret;
    await this.prisma.adminAuditLog.create({ data: { id: `audit_${randomUUID()}`, actorUserId, action, targetType, targetId, reason, result, ipHash: createHmac("sha256", effectiveHashSecret).update(ip).digest("hex"), userAgent: request.headers["user-agent"] ?? null } });
  }
}

function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
function safeEqual(left: string, right: string) { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function parseCookies(raw?: string) { return Object.fromEntries((raw ?? "").split(";").map((part) => part.trim().split("=")).filter(([key, value]) => key && value).map(([key, ...value]) => [key, value.join("=")])); }
