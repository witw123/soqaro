import { z } from "zod";
import { safeHttpUrlSchema } from "../contracts/url";

export const qqMusicAccountStatusSchema = z.object({
  connected: z.boolean(),
  qqMusicUserId: z.string().nullable(),
  nickname: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  lastValidatedAt: z.string().datetime().nullable()
}).strict();

export const qqMusicQrStatusSchema = z.enum(["pending", "scanned", "connected", "expired", "failed"]);
export const qqMusicQrStartResponseSchema = z.object({
  attemptId: z.string(),
  qrimg: z.string().min(1),
  expiresAt: z.string().datetime()
}).strict();
export const qqMusicQrStatusResponseSchema = z.object({
  status: qqMusicQrStatusSchema,
  account: qqMusicAccountStatusSchema.optional(),
  message: z.string().optional()
}).strict();
export const qqMusicTrackCandidateSchema = z.object({
  provider: z.literal("qqmusic"),
  providerTrackId: z.string().trim().min(1).max(128),
  relatedTrackId: z.string().trim().min(1).max(128).optional(),
  access: z.enum(["free", "vip", "paid", "unknown"]),
  quality: z.enum(["standard", "high", "exhigh", "lossless", "hires"]).nullable(),
  title: z.string(),
  artist: z.string(),
  album: z.string().nullable(),
  tags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  providerAlbumId: z.string().trim().min(1).optional(),
  releaseTime: z.string().nullable().optional(),
  durationMs: z.number().int().nonnegative(),
  artworkUrl: safeHttpUrlSchema().nullable()
}).strict();
export const qqMusicSearchResponseSchema = z.object({
  items: z.array(qqMusicTrackCandidateSchema),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative()
}).strict();

export type QqMusicAccountStatus = z.infer<typeof qqMusicAccountStatusSchema>;
export type QqMusicQrStatus = z.infer<typeof qqMusicQrStatusSchema>;
export type QqMusicQrStartResponse = z.infer<typeof qqMusicQrStartResponseSchema>;
export type QqMusicQrStatusResponse = z.infer<typeof qqMusicQrStatusResponseSchema>;
export type QqMusicTrackCandidate = z.infer<typeof qqMusicTrackCandidateSchema>;
export type QqMusicSearchResponse = z.infer<typeof qqMusicSearchResponseSchema>;
