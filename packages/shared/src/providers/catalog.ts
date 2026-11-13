import { z } from "zod";
import { safeHttpUrlSchema } from "../contracts/url";
import { neteaseTrackCandidateSchema } from "./netease";
import { qqMusicTrackCandidateSchema } from "./qqmusic";
import { bilibiliTrackCandidateSchema } from "./bilibili";

export const providerSchema = z.enum(["netease", "qqmusic", "bilibili"]);
export type Provider = z.infer<typeof providerSchema>;

export const providerSearchSuggestionSchema = z
  .object({
    provider: providerSchema,
    label: z.string().trim().min(1),
    hint: z.string().trim().min(1).nullable()
  })
  .strict();

export const providerSearchSuggestionListResponseSchema = z
  .object({
    items: z.array(providerSearchSuggestionSchema)
  })
  .strict();

export const providerAudioResolveResponseSchema = z
  .object({
    provider: providerSchema,
    providerTrackId: z.string().trim().min(1),
    url: safeHttpUrlSchema(),
    mimeType: z.enum(["audio/mpeg", "audio/flac"]).nullable(),
    fileType: z.enum(["mp3", "flac"])
  })
  .strict();

export const providerLyricsSchema = z
  .object({
    provider: providerSchema,
    providerTrackId: z.string().trim().min(1),
    plainLyric: z.string().nullable(),
    wordSyncedLyric: z.string().nullable(),
    translatedLyric: z.string().nullable(),
    romanizedLyric: z.string().nullable()
  })
  .strict();

export const providerArtistSummarySchema = z
  .object({
    provider: providerSchema,
    providerArtistId: z.string().trim().min(1),
    name: z.string().trim().min(1),
    artworkUrl: safeHttpUrlSchema().nullable(),
    description: z.string().nullable()
  })
  .strict();

export const providerPlaylistSummarySchema = z
  .object({
    provider: providerSchema,
    providerPlaylistId: z.string().trim().min(1),
    title: z.string(),
    description: z.string().nullable(),
    tags: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    artworkUrl: safeHttpUrlSchema().nullable(),
    creatorName: z.string().nullable(),
    trackCount: z.number().int().nonnegative()
  })
  .strict();

export const providerTrackCandidateSchema = z.union([
  neteaseTrackCandidateSchema,
  qqMusicTrackCandidateSchema,
  bilibiliTrackCandidateSchema
]);

export const providerPlaylistDetailSchema = providerPlaylistSummarySchema.extend({
  tracks: z.array(providerTrackCandidateSchema)
});

export const providerAlbumSummarySchema = z
  .object({
    provider: providerSchema,
    providerAlbumId: z.string().trim().min(1),
    title: z.string(),
    artist: z.string(),
    description: z.string().nullable(),
    artworkUrl: safeHttpUrlSchema().nullable(),
    releaseTime: z.string().nullable(),
    trackCount: z.number().int().nonnegative(),
  })
  .strict();

export const providerAlbumDetailSchema = providerAlbumSummarySchema
  .extend({
    tracks: z.array(providerTrackCandidateSchema)
  })
  .strict();

export const providerPlaylistListResponseSchema = z
  .object({
    items: z.array(providerPlaylistSummarySchema),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative()
  })
  .strict();

export const providerAlbumListResponseSchema = z
  .object({
    items: z.array(providerAlbumSummarySchema),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative()
  })
  .strict();

export const providerArtistListResponseSchema = z
  .object({
    items: z.array(providerArtistSummarySchema),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative()
  })
  .strict();

export const providerLibrarySnapshotSchema = z
  .object({
    provider: providerSchema,
    likedTracks: z.array(providerTrackCandidateSchema),
    collectedPlaylists: z.array(providerPlaylistSummarySchema),
    collectedAlbums: z.array(providerAlbumSummarySchema),
    followedArtists: z.array(providerArtistSummarySchema)
  })
  .strict();

export const providerAlbumFavoriteSchema = providerAlbumSummarySchema
  .extend({
    id: z.string().trim().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export const providerTrackFavoriteSchema = z
  .object({
    id: z.string().trim().min(1),
    provider: providerSchema,
    providerTrackId: z.string().trim().min(1),
    access: z.enum(["free", "vip", "paid", "unknown"]),
    quality: z.enum(["standard", "high", "exhigh", "lossless", "hires"]).nullable(),
    title: z.string(),
    artist: z.string(),
    album: z.string().nullable(),
    providerAlbumId: z.string().nullable(),
    durationMs: z.number().int().nonnegative(),
    artworkUrl: z.string().url().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export const providerArtistFavoriteSchema = providerArtistSummarySchema
  .extend({
    id: z.string().trim().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export type ProviderLyrics = z.infer<typeof providerLyricsSchema>;
export type ProviderArtistSummary = z.infer<typeof providerArtistSummarySchema>;
export type ProviderSearchSuggestion = z.infer<typeof providerSearchSuggestionSchema>;
export type ProviderSearchSuggestionListResponse = z.infer<typeof providerSearchSuggestionListResponseSchema>;
export type ProviderAudioResolveResponse = z.infer<typeof providerAudioResolveResponseSchema>;
export type ProviderPlaylistSummary = z.infer<typeof providerPlaylistSummarySchema>;
export type ProviderPlaylistDetail = z.infer<typeof providerPlaylistDetailSchema>;
export type ProviderAlbumSummary = z.infer<typeof providerAlbumSummarySchema>;
export type ProviderAlbumDetail = z.infer<typeof providerAlbumDetailSchema>;
export type ProviderPlaylistListResponse = z.infer<typeof providerPlaylistListResponseSchema>;
export type ProviderAlbumListResponse = z.infer<typeof providerAlbumListResponseSchema>;
export type ProviderArtistListResponse = z.infer<typeof providerArtistListResponseSchema>;
export type ProviderLibrarySnapshot = z.infer<typeof providerLibrarySnapshotSchema>;
export type ProviderTrackCandidate = z.infer<typeof providerTrackCandidateSchema>;
export type ProviderAlbumFavorite = z.infer<typeof providerAlbumFavoriteSchema>;
export type ProviderTrackFavorite = z.infer<typeof providerTrackFavoriteSchema>;
export type ProviderArtistFavorite = z.infer<typeof providerArtistFavoriteSchema>;
