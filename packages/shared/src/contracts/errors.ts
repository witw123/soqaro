import { z } from "zod";

export const errorCodes = {
  internal: "INTERNAL_ERROR",
  validationFailed: "VALIDATION_FAILED",
  unauthorized: "UNAUTHORIZED",
  invalidCredentials: "INVALID_CREDENTIALS",
  rateLimited: "RATE_LIMITED",
  roomNotFound: "ROOM_NOT_FOUND",
  roomClosed: "ROOM_CLOSED",
  peerUnavailable: "PEER_UNAVAILABLE",
  chunkMissing: "CHUNK_MISSING",
  playbackOutOfSync: "PLAYBACK_OUT_OF_SYNC",
  realtimeUnavailable: "REALTIME_UNAVAILABLE",
  playbackVersionConflict: "PLAYBACK_VERSION_CONFLICT",
  trackOwnerOffline: "TRACK_OWNER_OFFLINE",
  unauthorizedRoomAction: "UNAUTHORIZED_ROOM_ACTION",
  neteaseDisabled: "NETEASE_DISABLED",
  neteaseAccountRequired: "NETEASE_ACCOUNT_REQUIRED",
  neteaseAuthExpired: "NETEASE_AUTH_EXPIRED",
  neteaseQrExpired: "NETEASE_QR_EXPIRED",
  neteaseTrackNotFound: "NETEASE_TRACK_NOT_FOUND",
  neteaseAudioUnsupported: "NETEASE_AUDIO_UNSUPPORTED",
  neteaseImportTooLarge: "NETEASE_IMPORT_TOO_LARGE",
  neteaseUnavailable: "NETEASE_UNAVAILABLE",
  recommendationUnavailable: "RECOMMENDATION_UNAVAILABLE",
  qqMusicDisabled: "QQMUSIC_DISABLED",
  qqMusicAccountRequired: "QQMUSIC_ACCOUNT_REQUIRED",
  qqMusicAuthExpired: "QQMUSIC_AUTH_EXPIRED",
  qqMusicQrExpired: "QQMUSIC_QR_EXPIRED",
  qqMusicTrackNotFound: "QQMUSIC_TRACK_NOT_FOUND",
  qqMusicAudioUnsupported: "QQMUSIC_AUDIO_UNSUPPORTED",
  qqMusicImportTooLarge: "QQMUSIC_IMPORT_TOO_LARGE",
  qqMusicUnavailable: "QQMUSIC_UNAVAILABLE",
  bilibiliTrackNotFound: "BILIBILI_TRACK_NOT_FOUND",
  bilibiliUnavailable: "BILIBILI_UNAVAILABLE"
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];

const errorCodeValues = Object.values(errorCodes) as [ErrorCode, ...ErrorCode[]];

export const apiErrorResponseSchema = z.object({
  code: z.enum(errorCodeValues),
  message: z.string(),
  details: z.unknown().optional()
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

export function createApiErrorResponse(
  code: ErrorCode,
  message: string,
  details?: unknown
): ApiErrorResponse {
  return details === undefined ? { code, message } : { code, message, details };
}
