import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type {
  PlaybackSnapshot,
  Room,
  RoomMember,
  RoomMemberPermissions,
  UserProfile
} from "@soqaro/shared";
import { defaultRoomMemberPermissions, getRoomMemberPermissions } from "@soqaro/shared";
import type { RoomRecord } from "./room.types";

// The current browser topology is a peer mesh for control plus one media
// sender per listener. Keep the product boundary aligned with the capacity we
// can make stable without a server-side media relay.
export const maxRoomMembers = 10;
export const maxTracksPerRoom = 2_000;
export const maxQueueItemsPerRoom = 2_000;
export const maxTrackDurationMs = 3 * 60 * 60 * 1000;
export const maxTrackSizeBytes = 1024 * 1024 * 1024;
export const maxAssetUnits = 10_000;

export function assertMember(record: RoomRecord, sessionId: string) {
  if (!record.room.members.some((member) => member.id === sessionId)) {
    throw new Error("Only room members can perform this action.");
  }
}

export function assertHost(record: RoomRecord, sessionId: string) {
  if (record.room.hostId !== sessionId) {
    throw new Error("Only the host can manage room members.");
  }
}

export function assertPermission(
  record: RoomRecord,
  sessionId: string,
  permission: keyof RoomMemberPermissions
) {
  const member = record.room.members.find((candidate) => candidate.id === sessionId);
  if (!member) {
    throw new Error("Only room members can perform this action.");
  }
  if (!getRoomMemberPermissions(member)[permission]) {
    throw new Error(`Member does not have the ${permission} permission.`);
  }
}

export function assertUniqueNickname(record: RoomRecord, sessionId: string, nickname: string) {
  const normalizedNickname = nickname.trim().toLowerCase();

  if (
    record.room.members.some(
      (member) =>
        member.id !== sessionId && member.nickname.trim().toLowerCase() === normalizedNickname
    )
  ) {
    throw new Error("Nickname already exists in this room.");
  }
}

export function incrementRoomRevision(room: Room) {
  room.roomRevision = (room.roomRevision ?? 0) + 1;
}

export function incrementPresenceRevision(room: Room) {
  room.presenceRevision += 1;
}

export function incrementQueueVersion(playback: PlaybackSnapshot) {
  playback.queueVersion += 1;
}

export function incrementPlaybackRevision(playback: PlaybackSnapshot) {
  playback.playbackRevision += 1;
}

export function buildJoinCode() {
  let joinCode = "";

  while (joinCode.length < 6) {
    joinCode += randomBytes(6).toString("base64url").replace(/[^A-Z0-9]/gi, "");
  }

  return joinCode.slice(0, 6).toUpperCase();
}

export function buildMember(session: UserProfile, role: RoomMember["role"]): RoomMember {
  return {
    id: session.id,
    nickname: session.nickname,
    role,
    joinedAt: new Date().toISOString(),
    peerId: null,
    presenceState: "offline",
    permissions: { ...defaultRoomMemberPermissions }
  };
}

export function hashRoomPassword(password: string) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `v1:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

export function verifyRoomPassword(password: string, encoded: string) {
  const [version, saltValue, hashValue] = encoded.split(":");
  if (version !== "v1" || !saltValue || !hashValue) return false;
  try {
    const expected = Buffer.from(hashValue, "base64url");
    const actual = scryptSync(password, Buffer.from(saltValue, "base64url"), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
