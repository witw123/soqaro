import { z } from "zod";
import {
  originalAssetManifestSchema,
  playbackAssetManifestSchema
} from "../assets/models";
import {
  remoteTrackSourceRefSchema,
  trackLoudnessSchema,
  trackSourceTypeSchema
} from "../playlist/models";
import { playbackModeSchema } from "../playback/models";
import { roomMemberPermissionsSchema, roomTypeSchema } from "../room/models";
import { safeArtworkUrlSchema } from "./url";

const trimmedString = (max: number) => z.string().trim().min(1).max(max);
const accountSchema = trimmedString(64).regex(/^[a-zA-Z0-9_.-]+$/);
const optionalNullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional();

const stringId = trimmedString(160);
const trackIdListSchema = z.array(stringId).max(1000);

export const registerRequestSchema = z
  .object({
    username: accountSchema,
    password: z.string().min(8).max(256),
    nickname: trimmedString(80),
    turnstileToken: z.string().trim().min(1).max(2048).optional()
  })
  .strict();

export const loginRequestSchema = z
  .object({
    username: accountSchema,
    password: z.string().min(1).max(256),
    turnstileToken: z.string().trim().min(1).max(2048).optional()
  })
  .strict();

export const createRoomRequestSchema = z
  .object({
    visibility: z.enum(["private", "public"]).optional(),
    roomType: roomTypeSchema,
    name: trimmedString(120).optional(),
    description: optionalNullableText(500),
    password: z.string().trim().min(4).max(128).optional(),
    newMemberPermissions: roomMemberPermissionsSchema.optional()
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.roomType !== "interactive" && payload.newMemberPermissions) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["newMemberPermissions"],
        message: "Only interactive rooms can configure member permissions."
      });
    }
  });

export const updateRoomRequestSchema = z
  .object({
    visibility: z.enum(["private", "public"]),
    name: trimmedString(120),
    description: optionalNullableText(500),
    password: z
      .string()
      .trim()
      .max(128)
      .refine((value) => value.length === 0 || value.length >= 4, "密码至少 4 位。")
      .optional(),
    newMemberPermissions: roomMemberPermissionsSchema.optional()
  })
  .strict();

export const updateRoomMemberPermissionsRequestSchema = z
  .object({
    permissions: roomMemberPermissionsSchema
  })
  .strict();

export const createRoomSongRequestSchema = z.object({
  provider: z.enum(["netease", "qqmusic", "bilibili", "local"]),
  providerTrackId: trimmedString(240),
  title: trimmedString(240),
  artist: trimmedString(240),
  album: z.string().trim().max(240).nullable().optional(),
  durationMs: z.number().int().nonnegative().max(3 * 60 * 60 * 1000),
  artworkUrl: safeArtworkUrlSchema(4096).nullable().optional()
}).strict();

export const joinRoomRequestSchema = z
  .object({
    password: z.string().trim().max(128).optional()
  })
  .strict();

export const joinRoomByCodeRequestSchema = z
  .object({
    joinCode: trimmedString(16).transform((value) => value.toUpperCase()),
    password: z.string().trim().max(128).optional()
  })
  .strict();

export const registerTrackRequestSchema = z
  .object({
    id: stringId.optional(),
    title: trimmedString(240),
    artist: trimmedString(240),
    album: z.string().trim().max(240).nullable(),
    lyrics: z.string().trim().max(100_000).nullable().optional(),
    translatedLyrics: z.string().trim().max(100_000).nullable().optional(),
    romanizedLyrics: z.string().trim().max(100_000).nullable().optional(),
    durationMs: z.number().int().nonnegative().max(3 * 60 * 60 * 1000),
    bitrate: z.number().int().positive().max(10_000_000).nullable(),
    sizeBytes: z.number().int().nonnegative().max(1024 * 1024 * 1024).nullable().optional(),
    codec: z.string().trim().max(80).nullable().optional(),
    mimeType: z.string().trim().max(120).nullable().optional(),
    fileHash: trimmedString(256),
    artworkUrl: safeArtworkUrlSchema(4096).nullable(),
    ownerSessionId: stringId.optional(),
    ownerNickname: z.string().trim().max(80).optional(),
    sourceType: trackSourceTypeSchema,
    sourceRef: remoteTrackSourceRefSchema.nullable().optional(),
    loudness: trackLoudnessSchema.optional(),
    originalAsset: originalAssetManifestSchema.optional(),
    playbackAsset: playbackAssetManifestSchema.optional()
  })
  .strict()
  .superRefine((track, context) => {
    if (track.sourceType !== "local_upload" && !track.sourceRef) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceRef"],
        message: "Provider tracks require a source reference."
      });
    }

    if (track.sourceType === "local_upload" && track.sourceRef !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceRef"],
        message: "Local uploads cannot include a provider source reference."
      });
    }

    if (
      track.sourceType !== "local_upload" &&
      track.sourceRef &&
      track.sourceRef.provider !== track.sourceType
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceRef", "provider"],
        message: "Track source type and provider must match."
      });
    }
  });

export const registerTracksRequestSchema = z
  .object({
    tracks: z.array(registerTrackRequestSchema).min(1).max(500)
  })
  .strict();

export const batchDeleteTracksRequestSchema = z
  .object({
    trackIds: z.array(stringId).min(1).max(1000)
  })
  .strict();

export const batchAddQueueItemsRequestSchema = z
  .object({
    trackIds: z.array(stringId).min(1).max(1000)
  })
  .strict();

export const batchRemoveQueueItemsRequestSchema = z
  .object({
    queueItemIds: z.array(stringId).min(1).max(1000)
  })
  .strict();

export const prepareTrackAssetRequestSchema = z
  .object({
    trackId: stringId,
    fileHash: trimmedString(256),
    originalAsset: originalAssetManifestSchema,
    playbackAsset: playbackAssetManifestSchema
  })
  .strict();

export const reportTrackAssetUnavailableRequestSchema = z
  .object({
    trackId: stringId,
    reason: z.enum(["source-missing", "asset-corrupt", "permission-denied"])
  })
  .strict();

export const addQueueItemRequestSchema = z
  .object({
    trackId: stringId
  })
  .strict();

export const updateRadioAutopilotRequestSchema = z
  .object({
    enabled: z.boolean()
  })
  .strict();

export const insertRadioAutopilotNextTrackRequestSchema = z
  .object({
    trackId: stringId
  })
  .strict();

export const reorderQueueRequestSchema = z
  .object({
    queueItemIds: z.array(stringId)
  })
  .strict();

export const reorderTracksRequestSchema = z
  .object({
    trackIds: z.array(stringId)
  })
  .strict();
export type ReorderTracksRequest = z.infer<typeof reorderTracksRequestSchema>;

export const setNextQueueItemRequestSchema = z
  .object({
    queueItemId: stringId
  })
  .strict();

export const updatePlaybackRequestSchema = z
  .object({
    action: z.enum(["play", "pause", "seek", "next", "prev", "gapless-next", "set-mode"]),
    trackId: stringId.optional(),
    queueItemId: stringId.optional(),
    playbackAssetId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    positionMs: z.number().int().nonnegative().optional(),
    playbackMode: playbackModeSchema.optional(),
    actorPeerId: stringId.optional(),
    expectedVersion: z.number().int().positive()
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.action === "set-mode" && !payload.playbackMode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["playbackMode"],
        message: "Playback mode is required when changing playback order."
      });
    }
  });

export const createPlaylistRequestSchema = z
  .object({
    title: trimmedString(160),
    description: optionalNullableText(5000),
    trackIds: trackIdListSchema.optional(),
    tags: z.array(trimmedString(128)).max(50).optional(),
    coverUrl: safeArtworkUrlSchema(4096).nullable().optional(),
    isCollaborative: z.boolean().optional(),
    roomId: z.string().trim().min(1).nullable().optional()
  })
  .strict();

export const updatePlaylistRequestSchema = z
  .object({
    title: trimmedString(160).optional(),
    description: optionalNullableText(5000),
    tags: z.array(trimmedString(128)).max(50).optional(),
    coverUrl: safeArtworkUrlSchema(4096).nullable().optional(),
    trackIds: trackIdListSchema.optional()
  })
  .strict();

export const importPlaylistToRoomRequestSchema = z
  .object({
    roomId: stringId
  })
  .strict();

export const createPlaylistFromRoomRequestSchema = z
  .object({
    roomId: stringId,
    title: trimmedString(160),
    description: optionalNullableText(1000)
  })
  .strict();

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>;
export type UpdateRoomRequest = z.infer<typeof updateRoomRequestSchema>;
export type JoinRoomByCodeRequest = z.infer<typeof joinRoomByCodeRequestSchema>;
export type RegisterTrackRequest = z.infer<typeof registerTrackRequestSchema>;
export type RegisterTracksRequest = z.infer<typeof registerTracksRequestSchema>;
export type BatchDeleteTracksRequest = z.infer<typeof batchDeleteTracksRequestSchema>;
export type BatchAddQueueItemsRequest = z.infer<typeof batchAddQueueItemsRequestSchema>;
export type BatchRemoveQueueItemsRequest = z.infer<typeof batchRemoveQueueItemsRequestSchema>;
export type PrepareTrackAssetRequest = z.infer<typeof prepareTrackAssetRequestSchema>;
export type ReportTrackAssetUnavailableRequest = z.infer<typeof reportTrackAssetUnavailableRequestSchema>;
export type AddQueueItemRequest = z.infer<typeof addQueueItemRequestSchema>;
export type UpdateRadioAutopilotRequest = z.infer<typeof updateRadioAutopilotRequestSchema>;
export type InsertRadioAutopilotNextTrackRequest = z.infer<typeof insertRadioAutopilotNextTrackRequestSchema>;
export type ReorderQueueRequest = z.infer<typeof reorderQueueRequestSchema>;
export type SetNextQueueItemRequest = z.infer<typeof setNextQueueItemRequestSchema>;
export type UpdatePlaybackRequest = z.infer<typeof updatePlaybackRequestSchema>;
export type CreatePlaylistRequest = z.infer<typeof createPlaylistRequestSchema>;
export type UpdatePlaylistRequest = z.infer<typeof updatePlaylistRequestSchema>;
export type ImportPlaylistToRoomRequest = z.infer<typeof importPlaylistToRoomRequestSchema>;
export type CreatePlaylistFromRoomRequest = z.infer<typeof createPlaylistFromRoomRequestSchema>;
