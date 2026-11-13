import { Injectable } from "@nestjs/common";
import type { Server } from "socket.io";
import type {
  PeerSignalMessage,
  RoomChatDeletedPayload,
  RoomLibraryPatchPayload,
  RoomMemberRemovedPayload,
  RoomPlaybackPatchPayload,
  RoomPlaybackReadinessPayload,
  RoomPresencePatchPayload,
  RoomQueuePatchPayload,
  RoomSnapshot,
  RoomTrackDeletedPayload,
  RoomTrackAssetReadyPayload,
  RoomTrackAssetUnavailablePayload
} from "@soqaro/shared";
import {
  peerSignalMessageSchema,
  roomChatDeletedPayloadSchema,
  roomDeletedPayloadSchema,
  roomLibraryPatchPayloadSchema,
  roomMemberRemovedPayloadSchema,
  roomPlaybackPatchPayloadSchema,
  roomPlaybackReadinessPayloadSchema,
  roomPresencePatchPayloadSchema,
  roomQueuePatchPayloadSchema,
  roomSnapshotMissingPayloadSchema,
  roomSnapshotSchema,
  roomTrackDeletedPayloadSchema,
  roomTrackAssetReadyPayloadSchema,
  roomTrackAssetUnavailablePayloadSchema
} from "@soqaro/shared";
import { RedisService } from "../../infra/redis/redis.service";
import { MetricsService } from "../../common/metrics/metrics.service";
import {
  peerSignalChannel,
  roomChatDeletedChannel,
  roomDeletedChannel,
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
  roomTrackAssetUnavailableChannel,
  sessionReplacementChannel
} from "../realtime/room-realtime.channels";
import { RoomRealtimeBroadcaster } from "../realtime/room-realtime.broadcaster";
import { PeerSignalRelayService } from "./peer-signal-relay.service";
import { RoomPlaybackReadinessService } from "./room-playback-readiness.service";
import { RoomSessionRegistryService } from "./room-session-registry.service";

function hasForeignRedisEnvelope(
  message: { sourceId?: unknown; roomId?: unknown },
  localInstanceId: string
) {
  return (
    typeof message.sourceId === "string" &&
    message.sourceId !== localInstanceId &&
    typeof message.roomId === "string" &&
    message.roomId.length > 0
  );
}

/**
 * Cross-instance realtime fan-out: subscribes to the Redis channels published
 * by other signaling instances and re-emits each room event to the local
 * Socket.IO server, updating the in-memory relay/readiness/registry state
 * where a foreign message carries state (peer signals, readiness, session
 * replacement, room teardown).
 */
@Injectable()
export class RealtimeRedisSubscriber {
  private readonly redisUnsubscribers: Array<() => Promise<void> | void> = [];
  private server: Server | null = null;

  constructor(
    private readonly redisService: RedisService,
    private readonly roomRealtimeBroadcaster: RoomRealtimeBroadcaster,
    private readonly peerSignals: PeerSignalRelayService,
    private readonly readiness: RoomPlaybackReadinessService,
    private readonly registry: RoomSessionRegistryService,
    private readonly metrics: MetricsService
  ) {}

  setServer(server: Server) {
    this.server = server;
  }

  subscribeAll() {
    void this.redisService.subscribe("soqaro:auth:user-invalidated", (payload) => {
      const userId = (payload as { userId?: unknown }).userId;
      if (typeof userId !== "string") return;
      for (const socket of this.server!.sockets.sockets.values()) {
        if (socket.data.sessionId === userId) {
          socket.emit("session.revoked");
          socket.disconnect(true);
        }
      }
    }).then((unsubscribe) => this.redisUnsubscribers.push(unsubscribe));

    void this.redisService
      .subscribe(roomSnapshotChannel, (payload) => {
        const message = payload as {
          sourceId?: string;
          roomId?: string;
          snapshot?: RoomSnapshot;
        };

        if (!hasForeignRedisEnvelope(message, this.roomRealtimeBroadcaster.instanceId)) {
          return;
        }

        const parsed = roomSnapshotSchema.safeParse(message.snapshot);
        if (!parsed.success || parsed.data.room.id !== message.roomId) {
          return;
        }

        this.server!.to(message.roomId).emit("room.snapshot", parsed.data);
      })
      .then((unsubscribe) => {
        this.redisUnsubscribers.push(unsubscribe);
      });

    void this.redisService.subscribe(roomSnapshotMissingChannel, (payload) => {
      const message = payload as {
        sourceId?: string;
        roomId?: string;
      };

      if (!hasForeignRedisEnvelope(message, this.roomRealtimeBroadcaster.instanceId)) {
        return;
      }

      const parsed = roomSnapshotMissingPayloadSchema.safeParse({ roomId: message.roomId });
      if (!parsed.success) {
        return;
      }

      this.registry.clearRoomState(parsed.data.roomId);
      this.server!.to(parsed.data.roomId).emit("room.snapshot.missing", parsed.data);
    }).then((unsubscribe) => {
      this.redisUnsubscribers.push(unsubscribe);
    });

    void this.redisService.subscribe(roomDeletedChannel, (payload) => {
      const message = payload as {
        sourceId?: string;
        roomId?: string;
        trackIds?: string[];
      };

      if (!hasForeignRedisEnvelope(message, this.roomRealtimeBroadcaster.instanceId)) {
        return;
      }

      const parsed = roomDeletedPayloadSchema.safeParse({
        roomId: message.roomId,
        trackIds: message.trackIds ?? []
      });
      if (!parsed.success) {
        return;
      }

      this.server!.to(parsed.data.roomId).emit("room.deleted", parsed.data);
      void this.registry.evictRoomSockets(parsed.data.roomId);
    }).then((unsubscribe) => {
      this.redisUnsubscribers.push(unsubscribe);
    });

    void this.redisService.subscribe(roomPlaybackPatchChannel, (payload) => {
      const message = payload as {
        sourceId?: string;
        roomId?: string;
        payload?: RoomPlaybackPatchPayload;
      };

      if (!hasForeignRedisEnvelope(message, this.roomRealtimeBroadcaster.instanceId)) {
        return;
      }

      const parsed = roomPlaybackPatchPayloadSchema.safeParse(message.payload);
      if (!parsed.success || parsed.data.roomId !== message.roomId) {
        return;
      }

      this.server!.to(message.roomId).emit("room.playback.patch", parsed.data);
    }).then((unsubscribe) => {
      this.redisUnsubscribers.push(unsubscribe);
    });

    void this.redisService.subscribe(roomQueuePatchChannel, (payload) => {
      const message = payload as {
        sourceId?: string;
        roomId?: string;
        payload?: RoomQueuePatchPayload;
      };

      if (!hasForeignRedisEnvelope(message, this.roomRealtimeBroadcaster.instanceId)) {
        return;
      }

      const parsed = roomQueuePatchPayloadSchema.safeParse(message.payload);
      if (!parsed.success || parsed.data.roomId !== message.roomId) {
        return;
      }

      this.server!.to(message.roomId).emit("room.queue.patch", parsed.data);
    }).then((unsubscribe) => {
      this.redisUnsubscribers.push(unsubscribe);
    });

    void this.redisService.subscribe(roomPresencePatchChannel, (payload) => {
      const message = payload as {
        sourceId?: string;
        roomId?: string;
        payload?: RoomPresencePatchPayload;
      };

      if (!hasForeignRedisEnvelope(message, this.roomRealtimeBroadcaster.instanceId)) {
        return;
      }

      const parsed = roomPresencePatchPayloadSchema.safeParse(message.payload);
      if (!parsed.success || parsed.data.roomId !== message.roomId) {
        return;
      }

      this.server!.to(message.roomId).emit("room.presence.patch", parsed.data);
    }).then((unsubscribe) => {
      this.redisUnsubscribers.push(unsubscribe);
    });

    void this.redisService.subscribe(roomLibraryPatchChannel, (payload) => {
      const message = payload as {
        sourceId?: string;
        roomId?: string;
        payload?: RoomLibraryPatchPayload;
      };

      if (!hasForeignRedisEnvelope(message, this.roomRealtimeBroadcaster.instanceId)) {
        return;
      }

      const parsed = roomLibraryPatchPayloadSchema.safeParse(message.payload);
      if (!parsed.success || parsed.data.roomId !== message.roomId) {
        return;
      }

      this.server!.to(message.roomId).emit("room.library.patch", parsed.data);
    }).then((unsubscribe) => {
      this.redisUnsubscribers.push(unsubscribe);
    });

    void this.redisService.subscribe(peerSignalChannel, (payload) => {
      const message = payload as {
        sourceId?: string;
        roomId?: string;
        payload?: PeerSignalMessage;
      };

      if (!hasForeignRedisEnvelope(message, this.roomRealtimeBroadcaster.instanceId)) {
        return;
      }

      const parsed = peerSignalMessageSchema.safeParse(message.payload);
      if (!parsed.success || parsed.data.roomId !== message.roomId) {
        return;
      }

      void this.peerSignals.emitToPeer(message.roomId, parsed.data.toPeerId, parsed.data);
    }).then((unsubscribe) => {
      this.redisUnsubscribers.push(unsubscribe);
    });

    void this.redisService.subscribe(roomPlaybackReadinessChannel, (payload) => {
      const message = payload as {
        sourceId?: string;
        roomId?: string;
        payload?: RoomPlaybackReadinessPayload;
      };
      if (!hasForeignRedisEnvelope(message, this.roomRealtimeBroadcaster.instanceId)) {
        return;
      }
      const parsed = roomPlaybackReadinessPayloadSchema.safeParse(message.payload);
      if (!parsed.success || parsed.data.roomId !== message.roomId) {
        return;
      }
      this.readiness.handleRedisReadiness(message.roomId, parsed.data);
    }).then((unsubscribe) => {
      this.redisUnsubscribers.push(unsubscribe);
    });

    void this.redisService.subscribe(roomTrackDeletedChannel, (payload) => {
      const message = payload as {
        sourceId?: string;
        roomId?: string;
        payload?: RoomTrackDeletedPayload;
      };

      if (!hasForeignRedisEnvelope(message, this.roomRealtimeBroadcaster.instanceId)) {
        return;
      }

      const parsed = roomTrackDeletedPayloadSchema.safeParse(message.payload);
      if (!parsed.success || parsed.data.roomId !== message.roomId) {
        return;
      }

      this.server!.to(message.roomId).emit("room.track.deleted", parsed.data);
    }).then((unsubscribe) => {
      this.redisUnsubscribers.push(unsubscribe);
    });

    void this.redisService.subscribe(roomTrackAssetReadyChannel, (payload) => {
      const message = payload as {
        sourceId?: string;
        roomId?: string;
        payload?: RoomTrackAssetReadyPayload;
      };

      if (!hasForeignRedisEnvelope(message, this.roomRealtimeBroadcaster.instanceId)) {
        return;
      }

      const parsed = roomTrackAssetReadyPayloadSchema.safeParse(message.payload);
      if (!parsed.success || parsed.data.roomId !== message.roomId) {
        return;
      }

      this.server!.to(message.roomId).emit("room.track.asset.ready", parsed.data);
    }).then((unsubscribe) => {
      this.redisUnsubscribers.push(unsubscribe);
    });

    void this.redisService.subscribe(roomTrackAssetUnavailableChannel, (payload) => {
      const message = payload as {
        sourceId?: string;
        roomId?: string;
        payload?: RoomTrackAssetUnavailablePayload;
      };

      if (!hasForeignRedisEnvelope(message, this.roomRealtimeBroadcaster.instanceId)) {
        return;
      }

      const parsed = roomTrackAssetUnavailablePayloadSchema.safeParse(message.payload);
      if (!parsed.success || parsed.data.roomId !== message.roomId) {
        return;
      }

      this.server!.to(message.roomId).emit("room.track.asset.unavailable", parsed.data);
    }).then((unsubscribe) => {
      this.redisUnsubscribers.push(unsubscribe);
    });

    void this.redisService.subscribe(roomMemberRemovedChannel, (payload) => {
      const message = payload as {
        sourceId?: string;
        roomId?: string;
        payload?: RoomMemberRemovedPayload;
      };

      if (!hasForeignRedisEnvelope(message, this.roomRealtimeBroadcaster.instanceId)) {
        return;
      }

      const parsed = roomMemberRemovedPayloadSchema.safeParse(message.payload);
      if (!parsed.success || parsed.data.roomId !== message.roomId) {
        return;
      }

      this.server!.to(message.roomId).emit("room.member.removed", parsed.data);
      void this.registry.evictMemberSockets(parsed.data.roomId, parsed.data.memberId);
    }).then((unsubscribe) => {
      this.redisUnsubscribers.push(unsubscribe);
    });

    void this.redisService.subscribe("soqaro:room-member-evicted", (payload) => {
      const message = payload as {
        sourceId?: string;
        roomId?: string;
        memberId?: string;
      };
      if (
        !hasForeignRedisEnvelope(message, this.roomRealtimeBroadcaster.instanceId) ||
        typeof message.roomId !== "string" ||
        typeof message.memberId !== "string"
      ) {
        return;
      }

      void this.registry.evictMemberSockets(message.roomId, message.memberId);
    }).then((unsubscribe) => {
      this.redisUnsubscribers.push(unsubscribe);
    });

    void this.redisService.subscribe(roomChatDeletedChannel, (payload) => {
      const message = payload as {
        sourceId?: string;
        roomId?: string;
        payload?: RoomChatDeletedPayload;
      };

      if (!hasForeignRedisEnvelope(message, this.roomRealtimeBroadcaster.instanceId)) {
        return;
      }

      const parsed = roomChatDeletedPayloadSchema.safeParse(message.payload);
      if (!parsed.success || parsed.data.roomId !== message.roomId) {
        return;
      }

      this.server!.to(message.roomId).emit("room.chat.deleted", parsed.data);
    }).then((unsubscribe) => {
      this.redisUnsubscribers.push(unsubscribe);
    });

    void this.redisService.subscribe(sessionReplacementChannel, (payload) => {
      const message = payload as {
        sourceId?: string;
        roomId?: string;
        sessionId?: string;
        socketId?: string;
      };
      if (
        !hasForeignRedisEnvelope(message, this.roomRealtimeBroadcaster.instanceId) ||
        typeof message.roomId !== "string" ||
        typeof message.sessionId !== "string" ||
        typeof message.socketId !== "string"
      ) {
        return;
      }

      const socket = this.server!.sockets.sockets.get(message.socketId);
      if (
        !socket ||
        socket.data.roomId !== message.roomId ||
        socket.data.sessionId !== message.sessionId
      ) {
        return;
      }

      this.registry.invalidateReplacedSocket(socket, message.roomId);
    }).then((unsubscribe) => {
      this.redisUnsubscribers.push(unsubscribe);
    });
  }

  dispose() {
    for (const unsubscribe of this.redisUnsubscribers.splice(0)) {
      void unsubscribe();
    }
  }
}
