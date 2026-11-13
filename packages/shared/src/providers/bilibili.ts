import { z } from "zod";
import { safeArtworkUrlSchema, safeHttpUrlSchema } from "../contracts/url";

export const bilibiliQualitySchema = z.enum(["standard", "high", "exhigh"]);

export const bilibiliTrackCandidateSchema = z
  .object({
    provider: z.literal("bilibili"),
    providerTrackId: z.string().min(1),
    bvid: z.string().min(1).optional(),
    cid: z.number().int().positive().optional(),
    title: z.string(),
    artist: z.string(),
    album: z.string().nullable().default(null),
    tags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    providerAlbumId: z.string().trim().min(1).optional(),
    releaseTime: z.string().nullable().optional(),
    durationMs: z.number().int().nonnegative(),
    artworkUrl: safeArtworkUrlSchema(4096).nullable().default(null),
    access: z.enum(["free", "vip", "paid", "unknown"]).default("free"),
    quality: bilibiliQualitySchema.nullable().default("exhigh"),
    pageCount: z.number().int().positive().optional()
  });

export const bilibiliPageSchema = z
  .object({
    cid: z.number().int().positive(),
    page: z.number().int().positive(),
    part: z.string(),
    duration: z.number().int().nonnegative()
  })
  .strict();

export const bilibiliVideoDetailSchema = z
  .object({
    bvid: z.string(),
    title: z.string(),
    pic: safeHttpUrlSchema().nullable(),
    ownerName: z.string(),
    ownerFace: safeHttpUrlSchema().nullable(),
    duration: z.number(),
    pages: z.array(bilibiliPageSchema)
  })
  .strict();

export const bilibiliSearchResponseSchema = z
  .object({
    items: z.array(bilibiliTrackCandidateSchema),
    total: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative()
  })
  .strict();

export type BilibiliTrackCandidate = z.infer<typeof bilibiliTrackCandidateSchema>;
export type BilibiliVideoDetail = z.infer<typeof bilibiliVideoDetailSchema>;
export type BilibiliSearchResponse = z.infer<typeof bilibiliSearchResponseSchema>;
