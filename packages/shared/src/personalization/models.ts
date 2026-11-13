import { z } from "zod";
import { safeArtworkUrlSchema } from "../contracts/url";
import { providerPlaylistSummarySchema, providerTrackCandidateSchema } from "../providers/catalog";

export const personalizationSurfaceSchema = z.enum(["discover", "radio", "search"]);
export const tasteEntityKindSchema = z.enum([
  "track",
  "artist",
  "album",
  "playlist",
  "genre",
  "language",
  "region",
  "scene",
  "era",
  "source"
]);
export const personalizationTasteGroupIdSchema = z.enum(["genre", "language-region", "scene", "era", "behavior"]);
export const personalizationTasteTagSourceSchema = z.enum([
  "provider-tags",
  "album-text",
  "playlist-text",
  "artist-map",
  "track-text",
  "derived-behavior"
]);
export const tasteEventTypeSchema = z.enum([
  "playback",
  "favorite",
  "unfavorite",
  "manual-selection",
  "completion",
  "quick-skip",
  "dismissed",
  "unavailable"
]);
export const recommendationFeedbackActionSchema = z.enum(["not-interested", "exclude-from-profile"]);

export const personalizationTrackSchema = z.object({
  provider: z.enum(["local_upload", "netease", "qqmusic", "bilibili", "alist"]),
  providerTrackId: z.string().trim().min(1).max(512),
  access: z.enum(["free", "vip", "paid", "unknown"]),
  quality: z.enum(["standard", "high", "exhigh", "lossless", "hires"]).nullable(),
  title: z.string().trim().min(1).max(240),
  artist: z.string().trim().min(1).max(240),
  album: z.string().trim().max(240).nullable(),
  providerTags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  providerAlbumId: z.string().trim().min(1).max(512).nullable().optional(),
  releaseTime: z.string().trim().min(4).max(80).nullable().optional(),
  durationMs: z.number().int().min(0).max(86_400_000),
  artworkUrl: safeArtworkUrlSchema(4096).nullable()
}).strict();

export const recordPersonalizationEventSchema = z.object({
  id: z.string().trim().min(1).max(160),
  type: tasteEventTypeSchema,
  track: personalizationTrackSchema,
  surface: personalizationSurfaceSchema.optional(),
  listenedMs: z.number().int().min(0).max(86_400_000).optional(),
  timezoneOffsetMinutes: z.number().int().min(-840).max(840).optional(),
  occurredAt: z.string().datetime()
}).strict();

export const personalizationFeedbackSchema = z.object({
  action: recommendationFeedbackActionSchema,
  target: z.object({
    kind: z.enum(["track", "artist"]),
    key: z.string().trim().min(1).max(512),
    label: z.string().trim().min(1).max(480).optional()
  }).strict()
}).strict();

export const personalizationRecommendationsQuerySchema = z.object({
  surface: personalizationSurfaceSchema,
  provider: z.enum(["netease", "qqmusic"]).optional(),
  currentTrackKey: z.string().trim().min(1).max(512).optional(),
  excludedTrackKeys: z.preprocess(
    (value) => typeof value === "string" ? value.split(",").filter(Boolean) : value,
    z.array(z.string().trim().min(1).max(512)).max(100).optional()
  ),
  query: z.string().trim().min(1).max(240).optional()
}).strict();

export const trackRadioQuerySchema = z.object({
  seedTrack: personalizationTrackSchema,
  limit: z.number().int().min(5).max(50).default(20),
  excludedTrackKeys: z.preprocess(
    (value) => typeof value === "string" ? value.split(",").filter(Boolean) : value,
    z.array(z.string().trim().min(1).max(512)).max(100).optional()
  )
}).strict();

export const coldStartTasteDimensionSchema = z.enum(["genre", "language", "region", "scene", "era"]);

export const coldStartTasteSelectionSchema = z.object({
  label: z.string().trim().min(1).max(80),
  dimension: coldStartTasteDimensionSchema
}).strict();

export const coldStartTasteInputSchema = z.object({
  selections: z.array(coldStartTasteSelectionSchema).min(1).max(24),
  initialArtists: z.array(z.string().trim().min(1).max(80)).max(12).optional()
}).strict();

export type PersonalizationSurface = z.infer<typeof personalizationSurfaceSchema>;
export type TasteEntityKind = z.infer<typeof tasteEntityKindSchema>;
export type TasteEventType = z.infer<typeof tasteEventTypeSchema>;
export type RecordPersonalizationEvent = z.infer<typeof recordPersonalizationEventSchema>;
export type PersonalizationTrackInput = z.infer<typeof personalizationTrackSchema>;
export type PersonalizationFeedback = z.infer<typeof personalizationFeedbackSchema>;
export type PersonalizationRecommendationsQuery = z.infer<typeof personalizationRecommendationsQuerySchema>;
export type TrackRadioQuery = z.infer<typeof trackRadioQuerySchema>;
export type ColdStartTasteDimension = z.infer<typeof coldStartTasteDimensionSchema>;
export type ColdStartTasteSelection = z.infer<typeof coldStartTasteSelectionSchema>;
export type ColdStartTasteInput = z.infer<typeof coldStartTasteInputSchema>;

export type PersonalizationTasteGroupId = z.infer<typeof personalizationTasteGroupIdSchema>;
export type PersonalizationTasteTagSource = z.infer<typeof personalizationTasteTagSourceSchema>;
export type PersonalizationTasteTag = {
  label: string;
  score: number;
  confidence: number;
  source: PersonalizationTasteTagSource;
  updatedAt: string;
};
export type PersonalizationTasteGroup = {
  id: PersonalizationTasteGroupId;
  label: string;
  tags: PersonalizationTasteTag[];
};
export type PersonalizationTrack = z.infer<typeof providerTrackCandidateSchema> & {
  score: number;
  reasons: string[];
};
export type PersonalizationPlaylist = z.infer<typeof providerPlaylistSummarySchema> & {
  score: number;
  reasons: string[];
};

export type PersonalizationProfileResponse = {
  version: string;
  startedAt: string | null;
  totalListenedMs: number;
  totalPlayCount: number;
  trackCount: number;
  artistCount: number;
  tasteGroups: PersonalizationTasteGroup[];
  topTracks: Array<PersonalizationTrack & { listenedMs: number; playCount: number }>;
  topArtists: Array<{ name: string; score: number; listenedMs: number; playCount: number }>;
  recentTracks?: PersonalizationTrack[];
  sourceDistribution: Array<{ source: string; listenedMs: number }>;
};

export type LiveRoomRecommendation = {
  roomId: string;
  roomTitle: string;
  hostName: string;
  mode: "radio" | "request" | "common";
  listenerCount: number;
  currentTrack: {
    title: string;
    artist: string;
    artworkUrl: string | null;
  } | null;
};

export type DailyRadarResponse = {
  date: string;
  title: string;
  subtitle: string;
  tracks: PersonalizationTrack[];
  summaryGenres: string[];
};

export type PersonalizationRecommendationsResponse = {
  profileVersion: string;
  providers: Array<"netease" | "qqmusic">;
  forYou: PersonalizationTrack[];
  familiarArtists: PersonalizationTrack[];
  moodDiscovery: PersonalizationTrack[];
  deepCuts: PersonalizationTrack[];
  playlists: PersonalizationPlaylist[];
  dailyRadar?: DailyRadarResponse;
  liveRooms?: LiveRoomRecommendation[];
};

export type PersonalizationExclusion = {
  kind: "track" | "artist";
  key: string;
  label: string | null;
  action: "not-interested" | "exclude-from-profile";
  createdAt: string;
};

