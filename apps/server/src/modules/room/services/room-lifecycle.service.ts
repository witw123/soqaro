import { BadRequestException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Playlist, Room, RoomMemberPermissions, RoomType } from "@soqaro/shared";
import {
  defaultRoomMemberPermissions,
  getNewMemberPermissions,
  inactiveRadioAutopilot
} from "@soqaro/shared";
import type { RoomRecord } from "../room.types";
import {
  assertHost,
  assertMember,
  assertUniqueNickname,
  buildJoinCode,
  buildMember,
  hashRoomPassword,
  incrementPresenceRevision,
  incrementRoomRevision,
  maxRoomMembers,
  verifyRoomPassword
} from "../room-mutation";
import { AuthService } from "../../auth/auth.service";
import { RoomRecordRepository } from "../repositories/room-record.repository";
import { RoomActivityService } from "./room-activity.service";
import { RoomPlaybackService } from "./room-playback.service";
import { RoomPresenceOrchestratorService } from "./room-presence-orchestrator.service";
import { RoomPresenceService } from "./room-presence.service";
import { RoomSnapshotService } from "./room-snapshot.service";

type CreateRoomMetadata = {
  name?: string;
  description?: string | null;
  password?: string;
  newMemberPermissions?: RoomMemberPermissions;
  roomType: RoomType;
};

/**
 * Room lifecycle and membership: create/join/leave/delete a room, and manage
 * members (permissions, removal). Presence-sensitive operations are serialized
 * through the presence orchestrator so they share one persisted room revision.
 */
@Injectable()
export class RoomLifecycleService {
  constructor(
    private readonly authService: AuthService,
    private readonly roomRecordRepository: RoomRecordRepository,
    private readonly roomPresenceService: RoomPresenceService,
    private readonly roomPlaybackService: RoomPlaybackService,
    private readonly roomActivityService: RoomActivityService,
    private readonly roomSnapshotService: RoomSnapshotService,
    private readonly presenceOrchestrator: RoomPresenceOrchestratorService
  ) {}

  async createRoom(
    hostSessionId: string,
    visibility: Room["visibility"],
    metadata: CreateRoomMetadata
  ) {
    const hostSession = await this.authService.getUserOrThrow(hostSessionId);
    const name = metadata.name?.trim() || "未命名房间";
    const description = metadata.description?.trim() || null;
    const password = metadata.password?.trim() || null;
    const roomType = metadata.roomType;
    const room: Room = {
      id: `room_${randomUUID()}`,
      hostId: hostSession.id,
      joinCode: buildJoinCode(),
      name,
      description,
      hasPassword: !!password,
      visibility,
      roomType,
      radioAutopilot: { ...inactiveRadioAutopilot },
      requests: [],
      newMemberPermissions: roomType === "interactive"
        ? (metadata.newMemberPermissions
            ? { ...metadata.newMemberPermissions }
            : { ...defaultRoomMemberPermissions })
        : { library: false, queue: false, player: false },
      members: [buildMember(hostSession, "host")],
      presenceRevision: 0,
      roomRevision: 0,
      playback: {
        status: "paused",
        currentTrackId: null,
        currentQueueItemId: null,
        playbackAssetId: null,
        startAt: null,
        sourceSessionId: hostSession.id,
        sourcePeerId: null,
        sourceTrackId: null,
        positionMs: 0,
        startedAt: null,
        queueVersion: 1,
        playbackRevision: 1,
        mediaEpoch: 0,
        playbackMode: "sequence",
        shuffleBagTrackIds: [],
        nextQueueItemId: null
      }
    };

    const record: RoomRecord = {
      room,
      passwordHash: password ? hashRoomPassword(password) : null,
      tracks: [],
      queue: [],
      memberPermissionProfiles: {}
      ,requests: []
    };

    await this.roomRecordRepository.persistRecord(record);
    await this.roomRecordRepository.setRecentRoomForSession(hostSession.id, room.id);

    const saved = await this.roomRecordRepository.getRoomRecord(room.id);
    return this.roomSnapshotService.buildSnapshot(saved, [] as Playlist[]);
  }

  async joinRoom(roomId: string, sessionId: string, password?: string) {
    const record = await this.roomRecordRepository.getRoomRecord(roomId);
    const session = await this.authService.getUserOrThrow(sessionId);
    if (record.passwordHash && !verifyRoomPassword(password ?? "", record.passwordHash)) {
      throw new BadRequestException(password ? "房间密码错误。" : "请输入房间密码。");
    }
    assertUniqueNickname(record, session.id, session.nickname);

    const existingMember = record.room.members.find((member) => member.id === session.id);
    const currentPresence = existingMember
      ? (await this.roomPresenceService.getPresenceSnapshot(record.room.id, record.room.members)).get(session.id)
      : undefined;
    let membershipChanged = false;

    if (!existingMember) {
      if (record.room.members.length >= maxRoomMembers) {
        throw new BadRequestException("房间成员数量已达到上限。");
      }
      const savedPermissions = record.memberPermissionProfiles?.[session.id];
      const permissions = savedPermissions
        ? { ...savedPermissions }
        : getNewMemberPermissions(record.room);
      record.room.members.push({
        ...buildMember(session, "member"),
        permissions
      });
      record.memberPermissionProfiles = {
        ...(record.memberPermissionProfiles ?? {}),
        [session.id]: { ...permissions }
      };
      incrementPresenceRevision(record.room);
      incrementRoomRevision(record.room);
      membershipChanged = true;
    } else if (currentPresence?.presenceState !== "online") {
      // Hosts stay in the room record while away so room ownership survives.
      // Starting a new online session must therefore start a new membership timer.
      existingMember.joinedAt = new Date().toISOString();
      incrementPresenceRevision(record.room);
      incrementRoomRevision(record.room);
      membershipChanged = true;
    }

    if (membershipChanged) {
      await this.roomRecordRepository.persistRecord(record);
    }

    await this.roomRecordRepository.setRecentRoomForSession(session.id, roomId);

    return record.room;
  }

  async updateRoom(
    roomId: string,
    sessionId: string,
    input: {
      visibility: Room["visibility"];
      name: string;
      description?: string | null;
      password?: string;
      newMemberPermissions?: RoomMemberPermissions;
    }
  ) {
    const record = await this.roomRecordRepository.getRoomRecord(roomId);
    if (record.room.hostId !== sessionId) {
      throw new Error("Only the host can update this room.");
    }

    const password = input.password?.trim();
    record.room.visibility = input.visibility;
    record.room.name = input.name.trim();
    record.room.description = input.description?.trim() || null;
    if (record.room.roomType === "interactive" && input.newMemberPermissions !== undefined) {
      record.room.newMemberPermissions = { ...input.newMemberPermissions };
    }
    if (input.password !== undefined) {
      record.passwordHash = password ? hashRoomPassword(password) : null;
      record.room.hasPassword = Boolean(password);
    }
    incrementRoomRevision(record.room);
    await this.roomRecordRepository.persistRecord(record);
    return record.room;
  }

  updateMemberPermissions(
    roomId: string,
    actorSessionId: string,
    memberId: string,
    permissions: RoomMemberPermissions
  ) {
    return this.presenceOrchestrator.enqueuePresenceUpdate(roomId, actorSessionId, async () => {
      const record = await this.roomRecordRepository.getRoomRecord(roomId);
      assertHost(record, actorSessionId);
      if (record.room.roomType !== "interactive") {
        throw new BadRequestException("当前房间的成员控制权限由房主规则固定。");
      }
      const member = record.room.members.find((candidate) => candidate.id === memberId);
      if (!member) {
        throw new Error("Room member not found.");
      }
      if (member.role === "host") {
        throw new Error("Only the host can manage another room member.");
      }

      member.permissions = { ...permissions };
      record.memberPermissionProfiles = {
        ...(record.memberPermissionProfiles ?? {}),
        [memberId]: { ...permissions }
      };
      incrementPresenceRevision(record.room);
      incrementRoomRevision(record.room);
      await this.roomRecordRepository.persistRecord(record);
      return record.room;
    });
  }

  removeMember(roomId: string, actorSessionId: string, memberId: string) {
    return this.presenceOrchestrator.enqueuePresenceUpdate(roomId, actorSessionId, async () => {
      const record = await this.roomRecordRepository.getRoomRecord(roomId);
      assertHost(record, actorSessionId);
      const member = record.room.members.find((candidate) => candidate.id === memberId);
      if (!member) {
        throw new Error("Room member not found.");
      }
      if (member.role === "host") {
        throw new Error("Only the host can remove another room member.");
      }

      await this.roomPresenceService.clear(roomId, memberId);
      await this.roomActivityService.stop(memberId, roomId, record.room);
      record.room.members = record.room.members.filter((candidate) => candidate.id !== memberId);
      const activePresenceAfterRemoval = await this.roomPresenceService.getActivePresence(
        roomId,
        record.room.members
      );
      await this.roomPlaybackService.handleSourceDeparture(record, memberId, {
        hasOtherOnlineMember: activePresenceAfterRemoval.size > 0
      });
      incrementPresenceRevision(record.room);
      incrementRoomRevision(record.room);
      await this.roomRecordRepository.persistRecord(record);
      await this.roomRecordRepository.clearRecentRoomForSessionIfMatching(memberId, roomId);
      return { memberId, room: record.room };
    });
  }

  removeMemberByAdmin(roomId: string, memberId: string) {
    return this.presenceOrchestrator.enqueuePresenceUpdate(roomId, `admin_${memberId}`, async () => {
      const record = await this.roomRecordRepository.getRoomRecord(roomId);
      const member = record.room.members.find((candidate) => candidate.id === memberId);
      if (!member) {
        throw new Error("Room member not found.");
      }
      await this.roomPresenceService.clear(roomId, memberId);
      await this.roomActivityService.stop(memberId, roomId, record.room);
      record.room.members = record.room.members.filter((candidate) => candidate.id !== memberId);
      const activePresenceAfterRemoval = await this.roomPresenceService.getActivePresence(
        roomId,
        record.room.members
      );
      await this.roomPlaybackService.handleSourceDeparture(record, memberId, {
        hasOtherOnlineMember: activePresenceAfterRemoval.size > 0
      });
      incrementPresenceRevision(record.room);
      incrementRoomRevision(record.room);
      await this.roomRecordRepository.persistRecord(record);
      await this.roomRecordRepository.clearRecentRoomForSessionIfMatching(memberId, roomId);
      return { memberId, room: record.room };
    });
  }

  async deleteRoom(roomId: string, sessionId: string) {
    const record = await this.roomRecordRepository.getRoomRecord(roomId, { allowTerminated: true });
    await this.assertCanDeleteRoomRecord(record, sessionId);

    await Promise.all(
      record.room.members.map((member) =>
        this.roomActivityService.stop(member.id, roomId, record.room)
      )
    );

    await this.roomRecordRepository.markRoomTerminated(record, "房主解散房间");
    await this.roomRecordRepository.deleteRecord(record);
    await Promise.all(
      record.room.members.map((member) =>
        this.roomRecordRepository.clearRecentRoomForSessionIfMatching(member.id, roomId)
      )
    );
    await this.roomRecordRepository.completeRoomTermination(roomId);

    return { ok: true };
  }

  async deleteRoomByAdmin(roomId: string) {
    const record = await this.roomRecordRepository.getRoomRecord(roomId, { allowTerminated: true });
    // AdminService creates the tombstone with the audit reason before this
    // method runs. Preserve that reason during retries.
    await Promise.all(
      record.room.members.map((member) =>
        this.roomActivityService.stop(member.id, roomId, record.room)
      )
    );
    await this.roomRecordRepository.markRoomTerminated(record);
    await this.roomRecordRepository.deleteRecord(record);
    await Promise.all(record.room.members.map((member) => this.roomRecordRepository.clearRecentRoomForSessionIfMatching(member.id, roomId)));
    await this.roomRecordRepository.completeRoomTermination(roomId);
    return { ok: true };
  }

  async assertCanDeleteRoom(roomId: string, sessionId: string) {
    const record = await this.roomRecordRepository.getRoomRecord(roomId, { allowTerminated: true });
    await this.assertCanDeleteRoomRecord(record, sessionId);
  }

  leaveRoom(roomId: string, sessionId: string) {
    return this.presenceOrchestrator.enqueuePresenceUpdate(roomId, sessionId, async () => {
      const record = await this.roomRecordRepository.getRoomRecord(roomId);
      assertMember(record, sessionId);
      const leavingHost = record.room.hostId === sessionId;
      await this.roomPresenceService.clear(roomId, sessionId);
      await this.roomActivityService.stop(sessionId, roomId, record.room);

      if (!leavingHost) {
        record.room.members = record.room.members.filter((member) => member.id !== sessionId);
      }

      const activePresenceAfterLeave = await this.roomPresenceService.getActivePresence(
        roomId,
        record.room.members
      );
      const hasOtherOnlineMember = [...activePresenceAfterLeave.keys()].some((id) => id !== sessionId);
      await this.roomPlaybackService.handleSourceDeparture(record, sessionId, {
        hasOtherOnlineMember
      });
      incrementPresenceRevision(record.room);
      incrementRoomRevision(record.room);

      await this.roomRecordRepository.persistRecord(record);
      await this.roomRecordRepository.clearRecentRoomForSessionIfMatching(sessionId, roomId);
      return record.room;
    });
  }

  private async assertCanDeleteRoomRecord(record: RoomRecord, sessionId: string) {
    if (record.room.hostId !== sessionId) {
      throw new Error("Only the host can delete this room.");
    }
  }
}
