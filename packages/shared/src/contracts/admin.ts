import { z } from "zod";

export const adminRoleSchema = z.enum(["USER", "ADMIN"]);
export const adminUserStatusSchema = z.enum(["ACTIVE", "DISABLED"]);
export const incidentSeveritySchema = z.enum(["DEGRADED", "CRITICAL"]);
export const incidentStatusSchema = z.enum(["OPEN", "RECOVERED"]);

export const adminLoginRequestSchema = z.object({
  username: z.string().trim().min(1).max(160),
  password: z.string().min(1).max(512),
  turnstileToken: z.string().trim().min(1).max(2048).optional()
}).strict();

export const adminReasonSchema = z.string().trim().min(8).max(500);
export const adminCursorSchema = z.string().trim().max(512).optional();
export const adminLimitSchema = z.coerce.number().int().min(1).max(100).default(50);

export const adminPageInfoSchema = z.object({
  nextCursor: z.string().nullable(),
  generatedAt: z.string().datetime()
});

export const adminSessionSchema = z.object({
  userId: z.string(),
  username: z.string(),
  nickname: z.string(),
  role: z.literal("ADMIN"),
  expiresAt: z.string().datetime(),
  csrfToken: z.string().min(16)
});

export const adminUserSummarySchema = z.object({
  id: z.string(),
  username: z.string(),
  nickname: z.string(),
  role: adminRoleSchema,
  status: adminUserStatusSchema,
  disabledReason: z.string().nullable().optional(),
  disabledAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime(),
  lastLoginAt: z.string().datetime().nullable(),
  activeSessionCount: z.number().int().nonnegative(),
  onlineRoomCount: z.number().int().nonnegative()
});

export const adminRoomSummarySchema = z.object({
  id: z.string(),
  joinCode: z.string(),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  createdAt: z.string().datetime().nullable().optional(),
  visibility: z.string(),
  hostId: z.string(),
  hostNickname: z.string().nullable(),
  memberCount: z.number().int().nonnegative(),
  onlineMemberCount: z.number().int().nonnegative(),
  playbackStatus: z.string(),
  currentTrackTitle: z.string().nullable(),
  health: z.enum(["healthy", "degraded", "critical", "unknown"]),
  telemetryCoverage: z.object({ reported: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  updatedAt: z.string().datetime()
});

export const adminIncidentSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  type: z.string(),
  scopeType: z.string(),
  scopeId: z.string().nullable(),
  severity: incidentSeveritySchema,
  status: incidentStatusSchema,
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  recoveredAt: z.string().datetime().nullable(),
  occurrenceCount: z.number().int().positive(),
  details: z.record(z.unknown()).nullable()
});

export const adminOverviewSchema = z.object({
  generatedAt: z.string().datetime(),
  dependencies: z.object({
    prisma: z.enum(["up", "down"]),
    redis: z.enum(["up", "down"]),
    redisMode: z.string()
  }),
  runtime: z.object({
    uptimeSeconds: z.number().nonnegative(),
    memoryHeapUsedMb: z.number().nonnegative(),
    memoryHeapTotalMb: z.number().nonnegative(),
    memoryRssMb: z.number().nonnegative()
  }),
  network: z.object({
    wsConnections: z.number().int().nonnegative(),
    realtimeFailures: z.number().int().nonnegative(),
    playbackConflicts: z.number().int().nonnegative(),
    iceFailures: z.number().int().nonnegative()
  }),
  users: z.object({ total: z.number().int().nonnegative(), online: z.number().int().nonnegative(), disabled: z.number().int().nonnegative() }),
  rooms: z.object({ total: z.number().int().nonnegative(), active: z.number().int().nonnegative(), healthy: z.number().int().nonnegative(), degraded: z.number().int().nonnegative(), critical: z.number().int().nonnegative(), unknown: z.number().int().nonnegative() }),
  playback: z.object({ active: z.number().int().nonnegative(), paused: z.number().int().nonnegative() }),
  openIncidents: z.number().int().nonnegative(),
  instances: z.number().int().nonnegative()
});

export const adminActionRequestSchema = z.object({ reason: adminReasonSchema });
export const adminTerminateRoomRequestSchema = z.object({ reason: adminReasonSchema, expectedJoinCode: z.string().trim().min(1).max(32) });
export const adminUserStatusRequestSchema = z.object({ reason: adminReasonSchema, status: adminUserStatusSchema });

export const adminPlaybackActionSchema = z.enum(["pause", "play", "next", "clear-queue"]);
export const adminRoomPlaybackRequestSchema = z.object({ action: adminPlaybackActionSchema, reason: adminReasonSchema.optional() });
export const adminRoleChangeRequestSchema = z.object({ role: adminRoleSchema, reason: adminReasonSchema });
export const adminResetPasswordRequestSchema = z.object({ newPassword: z.string().min(6).max(128).optional(), reason: adminReasonSchema });
export const adminResolveIncidentRequestSchema = z.object({ reason: adminReasonSchema.optional() });

export const adminProviderHealthSchema = z.object({
  provider: z.enum(["bilibili", "netease", "qqmusic"]),
  name: z.string(),
  status: z.enum(["healthy", "degraded", "down"]),
  latencyMs: z.number().nullable(),
  message: z.string().nullable(),
  hasCredentials: z.boolean(),
  checkedAt: z.string().datetime()
});

export const systemAnnouncementSchema = z.object({
  id: z.string(),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(5000),
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const createAnnouncementRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(5000),
  isActive: z.boolean().default(true)
});

export const updateAnnouncementRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(5000).optional(),
  isActive: z.boolean().optional()
});

export const adminTrackStatsSchema = z.object({
  totalTracks: z.number().int().nonnegative(),
  sourceDistribution: z.record(z.string(), z.number().int().nonnegative())
});

export const adminMaintenanceResultSchema = z.object({
  cleanedSessions: z.number().int().nonnegative(),
  cleanedTombstones: z.number().int().nonnegative(),
  redisLatencyMs: z.number().nullable()
});

export type AdminRole = z.infer<typeof adminRoleSchema>;
export type AdminUserStatus = z.infer<typeof adminUserStatusSchema>;
export type AdminSession = z.infer<typeof adminSessionSchema>;
export type AdminUserSummary = z.infer<typeof adminUserSummarySchema>;
export type AdminRoomSummary = z.infer<typeof adminRoomSummarySchema>;
export type AdminIncident = z.infer<typeof adminIncidentSchema>;
export type AdminOverview = z.infer<typeof adminOverviewSchema>;
export type AdminPlaybackAction = z.infer<typeof adminPlaybackActionSchema>;
export type AdminRoomPlaybackRequest = z.infer<typeof adminRoomPlaybackRequestSchema>;
export type AdminRoleChangeRequest = z.infer<typeof adminRoleChangeRequestSchema>;
export type AdminResetPasswordRequest = z.infer<typeof adminResetPasswordRequestSchema>;
export type AdminResolveIncidentRequest = z.infer<typeof adminResolveIncidentRequestSchema>;
export type AdminProviderHealth = z.infer<typeof adminProviderHealthSchema>;
export type SystemAnnouncement = z.infer<typeof systemAnnouncementSchema>;
export type CreateAnnouncementRequest = z.infer<typeof createAnnouncementRequestSchema>;
export type UpdateAnnouncementRequest = z.infer<typeof updateAnnouncementRequestSchema>;
export type AdminTrackStats = z.infer<typeof adminTrackStatsSchema>;
export type AdminMaintenanceResult = z.infer<typeof adminMaintenanceResultSchema>;

