import { z } from "zod";
import { safeHttpUrlSchema } from "../contracts/url";

export const neteaseAccountStatusSchema = z
  .object({
    connected: z.boolean(),
    neteaseUserId: z.string().nullable(),
    nickname: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    lastValidatedAt: z.string().datetime().nullable()
  })
  .strict();

export const neteaseQrStatusSchema = z.enum([
  "pending",
  "scanned",
  "connected",
  "expired",
  "failed"
]);

export const neteaseQrStartResponseSchema = z
  .object({
    attemptId: z.string(),
    qrimg: z.string().min(1),
    expiresAt: z.string().datetime()
  })
  .strict();

export const neteaseQrStatusResponseSchema = z
  .object({
    status: neteaseQrStatusSchema,
    account: neteaseAccountStatusSchema.optional(),
    message: z.string().optional()
  })
  .strict();

export const neteaseTrackCandidateSchema = z
  .object({
    provider: z.literal("netease"),
    providerTrackId: z.string().regex(/^\d+$/),
    relatedTrackId: z.string().trim().min(1).optional(),
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
  })
  .strict();

export const neteaseSearchResponseSchema = z
  .object({
    items: z.array(neteaseTrackCandidateSchema),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative()
  })
  .strict();

export type NeteaseAccountStatus = z.infer<typeof neteaseAccountStatusSchema>;
export type NeteaseQrStatus = z.infer<typeof neteaseQrStatusSchema>;
export type NeteaseQrStartResponse = z.infer<typeof neteaseQrStartResponseSchema>;
export type NeteaseQrStatusResponse = z.infer<typeof neteaseQrStatusResponseSchema>;
export type NeteaseTrackCandidate = z.infer<typeof neteaseTrackCandidateSchema>;
export type NeteaseSearchResponse = z.infer<typeof neteaseSearchResponseSchema>;
