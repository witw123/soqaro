"use client";

import { errorCodes, getRoomMemberPermissions, type PlaybackSnapshot, type RoomMember, type RoomSnapshot } from "@soqaro/shared";
import { SoqaroApiError } from "../network/soqaro-api";

export function formatDuration(durationMs: number) {
  if (!durationMs) {
    return "0:00";
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatTransferRateMBps(valueKbps: number | null | undefined) {
  if (typeof valueKbps !== "number" || !Number.isFinite(valueKbps)) {
    return "未知";
  }

  return `${(Math.max(0, valueKbps) / 8_000).toFixed(2)} MB/s`;
}

export function normalizePlaylistTitle(input: string, fallback = "Tonight Selects") {
  const trimmed = input.trim();
  return trimmed || fallback;
}

export function removeTracksFromUploads<T>(
  uploads: Record<string, T>,
  removedTrackIds: string[]
) {
  if (removedTrackIds.length === 0) {
    return uploads;
  }

  const next = { ...uploads };
  for (const trackId of removedTrackIds) {
    delete next[trackId];
  }
  return next;
}

export function getOnlineMembers(members: RoomMember[]) {
  return normalizeRoomMembers(members).filter(
    (member) => member.presenceState === "online"
  );
}

export function getOnlineMemberCount(members: RoomMember[]) {
  return getOnlineMembers(members).length;
}

export function getReconnectingMemberCount(members: RoomMember[]) {
  return normalizeRoomMembers(members).filter(
    (member) => member.presenceState === "reconnecting"
  ).length;
}

export function normalizeRoomMembers(members: RoomMember[]) {
  const presencePriority: Record<RoomMember["presenceState"], number> = {
    online: 3,
    reconnecting: 2,
    offline: 1
  };
  const byMemberId = new Map<string, RoomMember>();

  for (const member of members) {
    const current = byMemberId.get(member.id);
    if (!current) {
      byMemberId.set(member.id, member);
      continue;
    }

    const currentScore = presencePriority[current.presenceState] + (current.peerId ? 1 : 0);
    const candidateScore = presencePriority[member.presenceState] + (member.peerId ? 1 : 0);
    if (candidateScore >= currentScore) {
      byMemberId.set(member.id, member);
    }
  }

  return [...byMemberId.values()];
}

export function getPresenceRevision(
  room: { presenceRevision?: number } | null | undefined
) {
  return room?.presenceRevision ?? 0;
}

export function shouldAcceptPresenceRevision(
  currentRevision: number | null | undefined,
  incomingRevision: number | null | undefined
) {
  return (incomingRevision ?? 0) >= (currentRevision ?? 0);
}

export function areSameRoomMembers(
  currentMembers: RoomMember[] | null | undefined,
  incomingMembers: RoomMember[] | null | undefined
) {
  const current = normalizeRoomMembers(currentMembers ?? []);
  const incoming = normalizeRoomMembers(incomingMembers ?? []);

  if (current.length !== incoming.length) {
    return false;
  }

  const incomingById = new Map(incoming.map((member) => [member.id, member]));

  for (const member of current) {
    const incomingMember = incomingById.get(member.id);
    if (!incomingMember) {
      return false;
    }

    if (
      incomingMember.nickname !== member.nickname ||
      incomingMember.role !== member.role ||
      incomingMember.joinedAt !== member.joinedAt ||
      incomingMember.peerId !== member.peerId ||
      incomingMember.presenceState !== member.presenceState ||
      JSON.stringify(getRoomMemberPermissions(incomingMember)) !== JSON.stringify(getRoomMemberPermissions(member))
    ) {
      return false;
    }
  }

  return true;
}

export function shouldAcceptPresenceSnapshot(
  currentMembers: RoomMember[] | null | undefined,
  currentRevision: number | null | undefined,
  incomingMembers: RoomMember[] | null | undefined,
  incomingRevision: number | null | undefined
) {
  if (!shouldAcceptPresenceRevision(currentRevision, incomingRevision)) {
    return false;
  }

  if ((incomingRevision ?? 0) > (currentRevision ?? 0)) {
    return true;
  }

  return !areSameRoomMembers(currentMembers, incomingMembers);
}

export function getPlaybackConsistencyVersion(playback: PlaybackSnapshot | null | undefined) {
  return playback?.playbackRevision ?? playback?.queueVersion ?? 0;
}

export function isSamePlaybackSnapshot(
  current: PlaybackSnapshot | null | undefined,
  incoming: PlaybackSnapshot | null | undefined
) {
  if (current === incoming) {
    return true;
  }

  if (!current || !incoming) {
    return false;
  }

  return (
    current.status === incoming.status &&
    current.currentTrackId === incoming.currentTrackId &&
    current.currentQueueItemId === incoming.currentQueueItemId &&
    current.sourceSessionId === incoming.sourceSessionId &&
    current.sourcePeerId === incoming.sourcePeerId &&
    current.sourceTrackId === incoming.sourceTrackId &&
    current.positionMs === incoming.positionMs &&
    current.startedAt === incoming.startedAt &&
    current.queueVersion === incoming.queueVersion &&
    current.playbackRevision === incoming.playbackRevision &&
    current.mediaEpoch === incoming.mediaEpoch &&
    (current.playbackMode ?? "sequence") === (incoming.playbackMode ?? "sequence") &&
    (current.nextQueueItemId ?? null) === (incoming.nextQueueItemId ?? null) &&
    JSON.stringify(current.gaplessNext ?? null) === JSON.stringify(incoming.gaplessNext ?? null)
  );
}

export function shouldAcceptPlaybackSnapshot(
  current: PlaybackSnapshot | null | undefined,
  incoming: PlaybackSnapshot | null | undefined
) {
  return getPlaybackConsistencyVersion(incoming) >= getPlaybackConsistencyVersion(current);
}

export function shouldReplacePlaybackSnapshot(
  current: PlaybackSnapshot | null | undefined,
  incoming: PlaybackSnapshot | null | undefined
) {
  return shouldAcceptPlaybackSnapshot(current, incoming) && !isSamePlaybackSnapshot(current, incoming);
}

export function mergeRoomSnapshot(
  current: RoomSnapshot | null | undefined,
  incoming: RoomSnapshot
) {
  if (!current) {
    return incoming;
  }

  if (current.room.id !== incoming.room.id) {
    return incoming;
  }

  const acceptPresence =
    (incoming.room.roomRevision ?? 0) >= (current.room.roomRevision ?? 0) &&
    shouldAcceptPresenceSnapshot(
      current.room.members,
      getPresenceRevision(current.room),
      incoming.room.members,
      getPresenceRevision(incoming.room)
    );
  const acceptPlayback = shouldAcceptPlaybackSnapshot(
    current.room.playback,
    incoming.room.playback
  );
  const acceptRoomTopology =
    (incoming.room.roomRevision ?? 0) >= (current.room.roomRevision ?? 0);
  const playback = acceptPlayback ? incoming.room.playback : current.room.playback;
  const nextTracks = ensurePlaybackTrackMetadata(
    acceptRoomTopology ? incoming.tracks : current.tracks,
    current.tracks,
    incoming.tracks,
    playback.currentTrackId
  );

  return {
    ...incoming,
    tracks: nextTracks,
    queue: acceptRoomTopology ? incoming.queue : current.queue,
    playlists: incoming.playlists.length > 0 ? incoming.playlists : current.playlists,
    room: {
      ...incoming.room,
      roomRevision: acceptRoomTopology
        ? incoming.room.roomRevision ?? current.room.roomRevision ?? 0
        : current.room.roomRevision ?? 0,
      members: acceptPresence ? incoming.room.members : current.room.members,
      presenceRevision: acceptPresence
        ? getPresenceRevision(incoming.room)
        : getPresenceRevision(current.room),
      playback
    }
  } satisfies RoomSnapshot;
}

function ensurePlaybackTrackMetadata(
  preferredTracks: RoomSnapshot["tracks"],
  currentTracks: RoomSnapshot["tracks"],
  incomingTracks: RoomSnapshot["tracks"],
  playbackTrackId: string | null
) {
  const nextTracks = [...preferredTracks];
  const knownTrackIds = new Set(nextTracks.map((track) => track.id));

  if (playbackTrackId && !knownTrackIds.has(playbackTrackId)) {
    const fallbackTrack =
      incomingTracks.find((track) => track.id === playbackTrackId) ??
      currentTracks.find((track) => track.id === playbackTrackId) ??
      null;
    if (fallbackTrack) {
      nextTracks.unshift(fallbackTrack);
    }
  }

  return nextTracks;
}

export function toUserFacingError(error: unknown) {
  const message = error instanceof Error ? error.message : "请求失败。";
  const code = error instanceof SoqaroApiError ? error.code : null;

  // Prefer error-code-based mapping; fall back to message matching only
  // when the server response didn't carry a structured error code.
  if (code) {
    switch (code) {
      case errorCodes.unauthorizedRoomAction:
        return "当前账号没有执行这个房间操作的权限。";
      case errorCodes.roomNotFound:
        return "房间不存在或已经被删除。";
      case errorCodes.trackOwnerOffline:
        return "这首歌的上传者当前不在线，暂时无法播放。";
      case errorCodes.playbackVersionConflict:
        return "房间播放状态刚刚被别人改动，请稍后再试。";
      case errorCodes.realtimeUnavailable:
        return "实时同步暂不可用，请稍后再试。";
      case errorCodes.rateLimited:
        return "操作过于频繁，请稍后再试。";
      case errorCodes.invalidCredentials:
        return "账号或密码错误。";
      case errorCodes.unauthorized:
        return "当前登录状态已失效，请重新登录。";
      case errorCodes.validationFailed:
        return "请求参数不正确，请检查输入内容。";
      case errorCodes.bilibiliTrackNotFound:
        return "未找到可播放的 B 站音频流，请换一首重试。";
      case errorCodes.bilibiliUnavailable:
        return "B 站音频服务暂时不可用，请稍后重试。";
      case errorCodes.neteaseTrackNotFound:
      case errorCodes.qqMusicTrackNotFound:
        return "该歌曲没有可用的公开音频，可能受限于 VIP 或版权。";
      case errorCodes.neteaseAudioUnsupported:
      case errorCodes.qqMusicAudioUnsupported:
        return "平台返回了当前播放器不支持的音频格式。";
      case errorCodes.neteaseImportTooLarge:
      case errorCodes.qqMusicImportTooLarge:
        return "歌曲文件过大，无法导入。";
      case errorCodes.neteaseUnavailable:
        return "网易云音乐服务暂时不可用，请稍后重试。";
      case errorCodes.qqMusicUnavailable:
        return "QQ 音乐服务暂时不可用，请稍后重试。";
      case errorCodes.internal:
        return "服务器处理请求失败，请稍后重试。";
      default:
        // Unknown code — let the message fall through to string matching below.
        break;
    }
  }

  // Fallback: match common server-side error messages for edge cases where
  // the error code did not propagate (e.g. raw Error throws). Comparisons
  // are case-insensitive to tolerate minor message text drift.
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes("only the host or the requester can remove this queue item")) {
    return "只有房主或点歌人可以移除这首歌。";
  }
  if (lowerMessage.includes("only room members can perform this action")) {
    return "加入房间后才能执行这个操作。";
  }
  if (lowerMessage.includes("room not found")) {
    return "房间不存在或已经被删除。";
  }
  if (lowerMessage.includes("no tracks from this playlist are available")) {
    return "这个歌单和当前房间曲库不匹配。";
  }
  if (lowerMessage.includes("only the host can delete this room")) {
    return "只有房主可以删除房间。";
  }
  if (lowerMessage.includes("all track uploaders must be online before deleting the room")) {
    return "只有所有已上传歌曲的成员都在线时才能解散房间。";
  }
  if (lowerMessage.includes("queue reorder payload does not match")) {
    return "队列顺序已经变化，请刷新后再试一次。";
  }
  if (lowerMessage.includes("queue item not found")) {
    return "这首歌已经不在当前播放队列里了。";
  }
  if (lowerMessage.includes("track owner is not online")) {
    return "这首歌的上传者当前不在线，暂时无法播放。";
  }
  if (lowerMessage.includes("only the original uploader can delete this track")) {
    return "只有歌曲上传者本人可以删除这首歌。";
  }
  if (lowerMessage.includes("does not have") && lowerMessage.includes("permission")) {
    return "该成员没有执行这个操作的权限。";
  }
  if (lowerMessage.includes("playback state version conflict")) {
    return "房间播放状态刚刚被别人改动，请稍后再试。";
  }
  if (lowerMessage.includes("realtime sync unavailable")) {
    return "实时同步暂不可用，请稍后再试。";
  }
  if (lowerMessage.includes("playback control rate limit exceeded")) {
    return "操作过于频繁，请稍后再试。";
  }
  if (lowerMessage.includes("invalid username or password")) {
    return "账号或密码错误。";
  }
  if (lowerMessage.includes("username already exists")) {
    return "这个账号已被使用。";
  }
  if (lowerMessage.includes("nickname already exists in this room")) {
    return "这个昵称已经在房间里被使用了，请换一个再加入。";
  }
  if (lowerMessage.includes("account storage is temporarily unavailable")) {
    return "账号存储当前不可用。请检查数据库与迁移状态后重试。";
  }
  if (lowerMessage.includes("unauthorized")) {
    return "当前登录状态已失效，请重新登录。";
  }
  if (lowerMessage.includes("internal server error")) {
    return "服务器处理请求失败，请稍后重试。";
  }

  return message;
}
