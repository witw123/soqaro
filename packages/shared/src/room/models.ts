import { z } from "zod";
import { playbackSnapshotSchema } from "../playback/models";
import { playlistSchema, queueItemSchema, trackMetaSchema, type TrackMeta } from "../playlist/models";

export const roomPresenceStateSchema = z.enum(["online", "reconnecting", "offline"]);
export const roomTypeSchema = z.enum(["interactive", "request", "radio"]);
export type RoomType = z.infer<typeof roomTypeSchema>;

export const radioAutopilotSchema = z
  .object({
    enabled: z.boolean()
  })
  .strict();

export type RadioAutopilot = z.infer<typeof radioAutopilotSchema>;

export const inactiveRadioAutopilot: RadioAutopilot = {
  enabled: false
};

export const roomChatMessageSchema = z.object({
  id: z.string().min(1),
  roomId: z.string().min(1),
  senderId: z.string().min(1),
  senderName: z.string().min(1).max(80),
  content: z.string().min(1).max(500),
  timestamp: z.number().int().nonnegative()
}).strict();

export const roomChatHistoryResponseSchema = z.object({
  messages: z.array(roomChatMessageSchema),
  nextCursor: z.string().min(1).nullable()
}).strict();

export const roomChatDeletedPayloadSchema = z.object({
  roomId: z.string().min(1),
  messageId: z.string().min(1)
}).strict();

export type RoomChatMessage = z.infer<typeof roomChatMessageSchema>;
export type RoomChatHistoryResponse = z.infer<typeof roomChatHistoryResponseSchema>;
export type RoomChatDeletedPayload = z.infer<typeof roomChatDeletedPayloadSchema>;

export const roomDirectoryNowPlayingSchema = z.object({
  title: z.string().min(1).max(240),
  artist: z.string().min(1).max(240),
  album: z.string().nullable().optional(),
  artworkUrl: z.string().nullable()
});

export const roomRequestStatusSchema = z.enum(["pending", "approved", "rejected"]);
export const roomRequestSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  requesterId: z.string(),
  requesterName: z.string(),
  provider: z.enum(["netease", "qqmusic", "bilibili", "alist", "local"]),
  providerTrackId: z.string(),
  title: z.string(),
  artist: z.string(),
  album: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  artworkUrl: z.string().nullable(),
  status: roomRequestStatusSchema,
  createdAt: z.string().datetime()
});
export type RoomRequest = z.infer<typeof roomRequestSchema>;

export const roomMemberPermissionsSchema = z.object({
  library: z.boolean(),
  queue: z.boolean(),
  player: z.boolean()
}).strict();

export type RoomMemberPermissions = z.infer<typeof roomMemberPermissionsSchema>;

export const defaultRoomMemberPermissions: RoomMemberPermissions = {
  library: true,
  queue: true,
  player: true
};

export const roomMemberSchema = z.object({
  id: z.string(),
  nickname: z.string(),
  role: z.enum(["host", "member"]),
  joinedAt: z.string().datetime(),
  peerId: z.string().nullable(),
  presenceState: roomPresenceStateSchema.default("offline"),
  // Optional for snapshots persisted before member permissions were added.
  permissions: roomMemberPermissionsSchema.partial().optional()
});

export const roomSchema = z.object({
  id: z.string(),
  hostId: z.string(),
  joinCode: z.string(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().nullable().optional(),
  hasPassword: z.boolean().optional(),
  visibility: z.enum(["private", "public"]),
  roomType: roomTypeSchema,
  radioAutopilot: radioAutopilotSchema,
  requests: z.array(roomRequestSchema).optional(),
  // Optional so snapshots persisted before room-level defaults remain valid.
  newMemberPermissions: roomMemberPermissionsSchema.optional(),
  members: z.array(roomMemberSchema),
  // Directory responses intentionally omit member details and carry only
  // aggregate values needed by the lobby UI.
  directoryHostNickname: z.string().max(80).optional(),
  directoryMemberCount: z.number().int().nonnegative().optional(),
  directoryOnlineMemberCount: z.number().int().nonnegative().optional(),
  directoryIsMember: z.boolean().optional(),
  playback: playbackSnapshotSchema,
  presenceRevision: z.number().int().nonnegative().default(0),
  roomRevision: z.number().int().nonnegative().default(0).optional()
});

export const roomSnapshotSchema = z.object({
  room: roomSchema,
  tracks: z.array(trackMetaSchema),
  queue: z.array(queueItemSchema),
  playlists: z.array(playlistSchema)
});

export const roomDirectoryItemSchema = z.object({
  room: z.object({
    id: z.string(),
    joinCode: z.string(),
    name: z.string().min(1).max(120),
    description: z.string().nullable(),
    hasPassword: z.boolean(),
    visibility: z.enum(["private", "public"]),
    roomType: roomTypeSchema,
    directoryHostNickname: z.string().max(80),
    directoryMemberCount: z.number().int().nonnegative(),
    directoryOnlineMemberCount: z.number().int().nonnegative(),
    directoryIsMember: z.boolean(),
    directoryQueueDepth: z.number().int().nonnegative(),
    directoryPendingRequestCount: z.number().int().nonnegative(),
    directoryBroadcastState: z.enum(["on_air", "off_air"]).nullable(),
    directoryNowPlaying: roomDirectoryNowPlayingSchema.nullable(),
    playbackStatus: playbackSnapshotSchema.shape.status
  })
});

export const roomTrackDeletionSchema = z.object({
  roomId: z.string(),
  trackId: z.string(),
  fileHash: z.string().nullable().optional(),
  originalAssetId: z.string().nullable().optional(),
  playbackAssetId: z.string().nullable().optional(),
  roomRevision: z.number().int().nonnegative(),
  deletedAt: z.string().datetime()
});

export const roomSyncResponseSchema = z.object({
  roomId: z.string(),
  roomDeleted: z.boolean(),
  roomRevision: z.number().int().nonnegative(),
  snapshot: roomSnapshotSchema.nullable(),
  deletedTracks: z.array(roomTrackDeletionSchema),
  // true 表示自 sinceRevision 以来房间没有任何变化,snapshot 为 null,
  // 客户端应沿用本地现有状态(省掉全量快照的序列化与传输)。
  unchanged: z.boolean().optional()
});

// Joining only needs the room metadata and route id. Tracks, queue and
// presence are loaded by the room runtime after navigation so large rooms do
// not block the join request.
export const roomJoinResponseSchema = z.object({
  roomId: z.string().min(1),
  roomRevision: z.number().int().nonnegative(),
  room: roomSchema
}).strict();

export const roomTrackDistributionStateSchema = z.enum([
  "unknown",
  "preparing",
  "ready",
  "source-missing",
  "source-offline",
  "failed"
]);

export const roomTrackDistributionStatusSchema = z.object({
  trackId: z.string(),
  state: roomTrackDistributionStateSchema,
  sourceSessionId: z.string().nullable(),
  assetId: z.string().nullable(),
  errorCode: z.string().nullable().optional(),
  updatedAt: z.string()
});

export type RoomTrackDistributionState = z.infer<typeof roomTrackDistributionStateSchema>;
export type RoomTrackDistributionStatus = z.infer<typeof roomTrackDistributionStatusSchema>;

export type RoomMember = z.infer<typeof roomMemberSchema>;
export type Room = z.infer<typeof roomSchema>;
export type RoomSnapshot = z.infer<typeof roomSnapshotSchema>;
export type RoomDirectoryItem = z.infer<typeof roomDirectoryItemSchema>;
export type RoomTrackDeletion = z.infer<typeof roomTrackDeletionSchema>;
export type RoomSyncResponse = z.infer<typeof roomSyncResponseSchema>;
export type RoomJoinResponse = z.infer<typeof roomJoinResponseSchema>;

export function getRoomMemberPermissions(
  member: Pick<RoomMember, "role" | "permissions">
): RoomMemberPermissions {
  if (member.role === "host") {
    return { ...defaultRoomMemberPermissions };
  }

  return {
    ...defaultRoomMemberPermissions,
    ...member.permissions
  };
}

export function getNewMemberPermissions(
  room: Pick<Room, "newMemberPermissions">
): RoomMemberPermissions {
  return {
    ...defaultRoomMemberPermissions,
    ...room.newMemberPermissions
  };
}

export function isProviderTrackMeta(track: TrackMeta | undefined): boolean {
  return !!(
    track &&
    (track.sourceType === "netease" || track.sourceType === "qqmusic") &&
    track.sourceRef &&
    track.sourceRef.provider === track.sourceType
  );
}

export function hasCompleteRoomAsset(track: TrackMeta | undefined): boolean {
  if (!track) return false;
  if (isProviderTrackMeta(track)) {
    return Boolean(track.playbackAsset?.assetId && track.fileHash);
  }
  return Boolean(track.fileHash);
}

export function resolveTrackDistributionStatus(input: {
  track: TrackMeta | undefined;
  members: Array<Pick<RoomMember, "id" | "presenceState">>;
  currentSessionId?: string | null;
  localFileAvailable?: boolean;
  assetUnavailableReason?: "source-missing" | "asset-corrupt" | "permission-denied" | null;
}): RoomTrackDistributionStatus {
  const { track, members, currentSessionId, localFileAvailable, assetUnavailableReason } = input;
  if (!track) {
    return {
      trackId: "",
      state: "unknown",
      sourceSessionId: null,
      assetId: null,
      updatedAt: new Date().toISOString()
    };
  }

  const isOwner = !!currentSessionId && currentSessionId === track.ownerSessionId;
  const ownerMember = members.find((m) => m.id === track.ownerSessionId);
  const isOwnerOnline = ownerMember?.presenceState === "online";
  const hasAsset = hasCompleteRoomAsset(track);

  let state: RoomTrackDistributionState = "unknown";
  let errorCode: string | null = assetUnavailableReason ?? null;

  if (!isOwnerOnline) {
    state = "source-offline";
  } else if (assetUnavailableReason === "source-missing" || (isOwner && localFileAvailable === false)) {
    state = "source-missing";
    errorCode = "source-missing";
  } else if (assetUnavailableReason === "asset-corrupt" || assetUnavailableReason === "permission-denied") {
    state = "failed";
  } else if (!hasAsset) {
    state = "preparing";
  } else {
    state = "ready";
  }

  return {
    trackId: track.id,
    state,
    sourceSessionId: track.ownerSessionId,
    assetId: track.playbackAsset?.assetId ?? null,
    errorCode,
    updatedAt: new Date().toISOString()
  };
}
