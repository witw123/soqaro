import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  RoomLibraryPatchPayload,
  RoomChatDeletedPayload,
  RoomPlaybackPatchPayload,
  RoomPlaybackReadinessPayload,
  RoomPresencePatchPayload,
  RoomQueuePatchPayload,
  RoomMemberRemovedPayload,
  RoomSnapshot,
  RoomTrackDeletedPayload,
  RoomTrackAssetReadyPayload,
  RoomTrackAssetUnavailablePayload
} from "@soqaro/shared";
import type { Server } from "socket.io";
import { RedisService } from "../../infra/redis/redis.service";
import {
  roomDeletedChannel,
  roomChatDeletedChannel,
  roomLibraryPatchChannel,
  roomMemberRemovedChannel,
  roomPlaybackPatchChannel,
  roomPlaybackReadinessChannel,
  roomPresencePatchChannel,
  roomQueuePatchChannel,
  roomSnapshotChannel,
  roomSnapshotMissingChannel,
  roomTrackDeletedChannel,
  roomTrackAssetReadyChannel,
  roomTrackAssetUnavailableChannel
} from "./room-realtime.channels";

@Injectable()
export class RoomRealtimeBroadcaster {
  readonly instanceId = randomUUID();
  private server: Server | null = null;
  private evictionHandler: {
    evictMember: (roomId: string, memberId: string) => void;
    evictRoom: (roomId: string) => void;
  } | null = null;

  constructor(private readonly redisService: RedisService) {}

  setServer(server: Server) {
    this.server = server;
  }

  setEvictionHandler(handler: {
    evictMember: (roomId: string, memberId: string) => void;
    evictRoom: (roomId: string) => void;
  }) {
    this.evictionHandler = handler;
  }

  emitRoomSnapshot(roomId: string, snapshot: RoomSnapshot) {
    this.server?.to(roomId).emit("room.snapshot", snapshot);
    this.publish(roomSnapshotChannel, {
      sourceId: this.instanceId,
      roomId,
      snapshot
    });
  }

  emitRoomMissing(roomId: string) {
    this.server?.to(roomId).emit("room.snapshot.missing", { roomId });
    this.publish(roomSnapshotMissingChannel, {
      sourceId: this.instanceId,
      roomId
    });
  }

  emitRoomDeleted(roomId: string, trackIds: string[]) {
    this.server?.to(roomId).emit("room.deleted", { roomId, trackIds });
    this.evictionHandler?.evictRoom(roomId);
    this.publish(roomDeletedChannel, {
      sourceId: this.instanceId,
      roomId,
      trackIds
    });
  }

  emitPlaybackPatch(
    roomId: string,
    payload: Omit<RoomPlaybackPatchPayload, "roomId" | "updatedAt">
  ) {
    const message: RoomPlaybackPatchPayload = {
      roomId,
      playback: payload.playback,
      roomRevision: payload.roomRevision,
      updatedAt: new Date().toISOString()
    };
    this.server?.to(roomId).emit("room.playback.patch", message);
    this.publish(roomPlaybackPatchChannel, {
      sourceId: this.instanceId,
      roomId,
      payload: message
    });
  }

  emitQueuePatch(
    roomId: string,
    payload: Omit<RoomQueuePatchPayload, "roomId" | "updatedAt">
  ) {
    const message: RoomQueuePatchPayload = {
      roomId,
      queue: payload.queue,
      playback: payload.playback,
      roomRevision: payload.roomRevision,
      updatedAt: new Date().toISOString()
    };
    this.server?.to(roomId).emit("room.queue.patch", message);
    this.publish(roomQueuePatchChannel, {
      sourceId: this.instanceId,
      roomId,
      payload: message
    });
  }

  emitPresencePatch(
    roomId: string,
    payload: Omit<RoomPresencePatchPayload, "roomId" | "updatedAt">
  ) {
    const message: RoomPresencePatchPayload = {
      roomId,
      members: payload.members,
      playback: payload.playback,
      presenceRevision: payload.presenceRevision,
      roomRevision: payload.roomRevision,
      updatedAt: new Date().toISOString()
    };
    this.server?.to(roomId).emit("room.presence.patch", message);
    this.publish(roomPresencePatchChannel, {
      sourceId: this.instanceId,
      roomId,
      payload: message
    });
  }

  emitLibraryPatch(
    roomId: string,
    payload: Omit<RoomLibraryPatchPayload, "roomId" | "updatedAt">
  ) {
    const message: RoomLibraryPatchPayload = {
      roomId,
      tracks: payload.tracks,
      queue: payload.queue,
      playback: payload.playback,
      roomRevision: payload.roomRevision,
      updatedAt: new Date().toISOString()
    };
    this.server?.to(roomId).emit("room.library.patch", message);
    this.publish(roomLibraryPatchChannel, {
      sourceId: this.instanceId,
      roomId,
      payload: message
    });
  }

  emitPlaybackReadiness(roomId: string, payload: Omit<RoomPlaybackReadinessPayload, "roomId">) {
    const message: RoomPlaybackReadinessPayload = {
      roomId,
      ...payload
    };
    this.server?.to(roomId).emit("room.playback.readiness", message);
    this.publish(roomPlaybackReadinessChannel, {
      sourceId: this.instanceId,
      roomId,
      payload: message
    });
  }

  emitTrackDeleted(roomId: string, payload: Omit<RoomTrackDeletedPayload, "roomId">) {
    const message: RoomTrackDeletedPayload = { roomId, ...payload };
    this.server?.to(roomId).emit("room.track.deleted", message);
    this.publish(roomTrackDeletedChannel, {
      sourceId: this.instanceId,
      roomId,
      payload: message
    });
  }

  emitTrackAssetReady(roomId: string, payload: Omit<RoomTrackAssetReadyPayload, "roomId">) {
    const message: RoomTrackAssetReadyPayload = { roomId, ...payload };
    this.server?.to(roomId).emit("room.track.asset.ready", message);
    this.publish(roomTrackAssetReadyChannel, {
      sourceId: this.instanceId,
      roomId,
      payload: message
    });
  }

  emitTrackAssetUnavailable(roomId: string, payload: Omit<RoomTrackAssetUnavailablePayload, "roomId">) {
    const message: RoomTrackAssetUnavailablePayload = { roomId, ...payload };
    this.server?.to(roomId).emit("room.track.asset.unavailable", message);
    this.publish(roomTrackAssetUnavailableChannel, {
      sourceId: this.instanceId,
      roomId,
      payload: message
    });
  }

  emitMemberRemoved(roomId: string, memberId: string) {
    const message: RoomMemberRemovedPayload = { roomId, memberId };
    this.server?.to(roomId).emit("room.member.removed", message);
    this.evictionHandler?.evictMember(roomId, memberId);
    this.publish(roomMemberRemovedChannel, {
      sourceId: this.instanceId,
      roomId,
      payload: message
    });
  }

  evictMemberSession(roomId: string, memberId: string) {
    this.evictionHandler?.evictMember(roomId, memberId);
    this.publish("soqaro:room-member-evicted", {
      sourceId: this.instanceId,
      roomId,
      memberId
    });
  }

  emitChatDeleted(roomId: string, messageId: string) {
    const message: RoomChatDeletedPayload = { roomId, messageId };
    this.server?.to(roomId).emit("room.chat.deleted", message);
    this.publish(roomChatDeletedChannel, {
      sourceId: this.instanceId,
      roomId,
      payload: message
    });
  }

  private publish(channel: string, payload: unknown) {
    void (async () => {
      for (const delayMs of [0, 100, 250, 500, 1_000, 2_000]) {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        try {
          await this.redisService.publish(channel, payload);
          return;
        } catch {
          // Room snapshots and patches can be recovered; retry short outages first.
        }
      }
    })();
  }
}
