import { z } from "zod";

const neteaseApiAlbumSchema = z
  .object({
    id: z.union([z.string(), z.number().int()]).optional().nullable(),
    albumId: z.union([z.string(), z.number().int()]).optional().nullable(),
    name: z.string().optional(),
    picUrl: z.string().optional().nullable()
  })
  .strip();

const neteaseApiSongSchema = z
  .object({
    id: z.union([z.string(), z.number().int()]),
    name: z.string(),
    fee: z.union([z.string(), z.number().int()]).optional().nullable(),
    duration: z.union([z.string(), z.number().finite()]).optional().nullable(),
    dt: z.union([z.string(), z.number().finite()]).optional().nullable(),
    artists: z
      .array(z.object({ name: z.string().optional() }).strip())
      .optional(),
    ar: z
      .array(z.object({ name: z.string().optional() }).strip())
      .optional(),
    album: neteaseApiAlbumSchema.optional().nullable(),
    al: neteaseApiAlbumSchema.optional().nullable(),
    h: z.object({ br: z.union([z.string(), z.number().finite()]).optional().nullable() }).strip().optional().nullable(),
    m: z.object({ br: z.union([z.string(), z.number().finite()]).optional().nullable() }).strip().optional().nullable(),
    l: z.object({ br: z.union([z.string(), z.number().finite()]).optional().nullable() }).strip().optional().nullable(),
    sq: z.object({ br: z.union([z.string(), z.number().finite()]).optional().nullable() }).strip().optional().nullable(),
    hr: z.object({ br: z.union([z.string(), z.number().finite()]).optional().nullable() }).strip().optional().nullable(),
    privilege: z
      .object({
        fee: z.union([z.string(), z.number().int()]).optional().nullable(),
        maxbr: z.union([z.string(), z.number().finite()]).optional().nullable()
      })
      .strip()
      .optional()
      .nullable()
  })
  .strip();

const neteaseProfileSchema = z
  .object({
    userId: z.union([z.string(), z.number().int()]).optional(),
    id: z.union([z.string(), z.number().int()]).optional(),
    nickname: z.string().optional().nullable(),
    signature: z.string().optional().nullable(),
    avatarUrl: z.string().optional().nullable()
  })
  .strip();

export const neteaseQrKeyBodySchema = z.union([
  z
    .object({
      code: z.number().int(),
      data: z.object({ unikey: z.string().trim().min(1) }).strip()
    })
    .strip(),
  z.object({ code: z.number().int(), unikey: z.string().trim().min(1) }).strip()
]);

export const neteaseQrCreateBodySchema = z.union([
  z
    .object({
      code: z.number().int(),
      data: z.object({ qrimg: z.string().trim().min(1) }).strip()
    })
    .strip(),
  z.object({ code: z.number().int(), qrimg: z.string().trim().min(1) }).strip()
]);

export const neteaseQrCheckBodySchema = z
  .object({
    code: z.number().int().optional(),
    data: z.object({ code: z.number().int().optional() }).strip().optional(),
    cookie: z.string().optional(),
    message: z.string().optional()
  })
  .strip();

export const neteaseLoginStatusBodySchema = z
  .object({
    code: z.number().int().optional(),
    data: z
      .object({
        code: z.number().int().optional(),
        profile: neteaseProfileSchema.optional().nullable()
      })
      .strip()
      .optional(),
    profile: neteaseProfileSchema.optional().nullable()
  })
  .strip()
  .refine((body) => body.code !== undefined || body.data?.code !== undefined);

export const neteaseSearchBodySchema = z
  .object({
    code: z.number().int(),
    result: z
      .object({
        songs: z.array(neteaseApiSongSchema).optional(),
        albums: z.array(z.record(z.unknown())).optional(),
        playlists: z.array(z.record(z.unknown())).optional()
      })
      .strip()
      .optional()
      .nullable()
  })
  .strip();

export const neteaseSongDetailBodySchema = z
  .object({
    code: z.number().int(),
    songs: z.array(neteaseApiSongSchema)
  })
  .strip();

export const neteaseAudioUrlBodySchema = z
  .object({
    code: z.number().int(),
    data: z
      .array(
        z
          .object({
            url: z.string().url().optional().nullable(),
            type: z.string().optional().nullable(),
            freeTrialInfo: z.unknown().optional().nullable()
          })
          .strip()
      )
      .optional()
  })
  .strip();

export const neteaseSearchQuerySchema = z
  .object({
    keywords: z.string().trim().min(1).max(100),
    limit: z.coerce.number().int().min(1).max(30).default(20),
    offset: z.coerce.number().int().min(0).max(10_000).default(0)
  })
  .strict();

export const neteaseSearchSuggestQuerySchema = z
  .object({
    keywords: z.string().trim().min(1).max(100)
  })
  .strict();

export const neteaseTrackIdSchema = z.string().trim().regex(/^\d+$/).max(32);

export const neteaseQualitySchema = z.enum(["standard", "high", "exhigh", "lossless", "hires"]);

export const neteaseCatalogPageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    offset: z.coerce.number().int().min(0).max(10_000).default(0)
  })
  .strict();

export const neteasePlaylistIdSchema = z.string().trim().regex(/^\d+$/).max(32);
export const neteaseAlbumIdSchema = z.string().trim().regex(/^\d+$/).max(32);

export const neteaseAccountStatusSchema = z
  .object({
    connected: z.boolean(),
    neteaseUserId: z.string().nullable(),
    nickname: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    lastValidatedAt: z.string().datetime().nullable()
  })
  .strict();

export type NeteaseSearchQuery = z.infer<typeof neteaseSearchQuerySchema>;
export type NeteaseSearchSuggestQuery = z.infer<typeof neteaseSearchSuggestQuerySchema>;
export type NeteaseQuality = z.infer<typeof neteaseQualitySchema>;
export type NeteaseApiSong = z.infer<typeof neteaseApiSongSchema>;
export type NeteaseQrCheckBody = z.infer<typeof neteaseQrCheckBodySchema>;
export type NeteaseLoginStatusBody = z.infer<typeof neteaseLoginStatusBodySchema>;
export type NeteaseSearchBody = z.infer<typeof neteaseSearchBodySchema>;
export type NeteaseSongDetailBody = z.infer<typeof neteaseSongDetailBodySchema>;
export type NeteaseAudioUrlBody = z.infer<typeof neteaseAudioUrlBodySchema>;
export type NeteaseCatalogPageQuery = z.infer<typeof neteaseCatalogPageQuerySchema>;
