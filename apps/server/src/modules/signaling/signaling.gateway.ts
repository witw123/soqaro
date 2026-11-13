import { OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  ConnectedSocket,
  OnGatewayDisconnect,
  OnGatewayConnection,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import type {
  PeerSignalMessage,
  Playlist,
  RoomSubscribeAckPayload,
  RoomChatInputPayload,
  RoomClockInputPayload,
  RoomPlaybackReadinessPayload,
  RoomPresencePayload,
  RoomSubscribePayload,
  RoomSnapshot,
  RoomUnsubscribePayload,
  RoomReactionInputPayload
} from "@soqaro/shared";
import {
  errorCodes,
  diagnosticsReportPayloadSchema,
  peerSignalMessageSchema,
  roomChatInputPayloadSchema,
  roomClockInputPayloadSchema,
  roomPlaybackReadinessInputPayloadSchema,
  roomPresencePayloadSchema,
  roomSubscribePayloadSchema,
  roomUnsubscribePayloadSchema,
  roomReactionInputPayloadSchema
} from "@soqaro/shared";
import { createWsApiException } from "../../common/errors/ws-error";
import { MetricsService } from "../../common/metrics/metrics.service";
import { AbuseProtectionService } from "../../common/security/abuse-protection.service";
import { getCorsOrigins } from "../../common/cors/get-cors-origins";
import { RedisService } from "../../infra/redis/redis.service";
import { AuthService } from "../auth/auth.service";
import { RoomRealtimePublisher } from "../room/services/room-realtime.publisher";
import { RoomChatService } from "../room/services/room-chat.service";
import { RoomService } from "../room/room.service";
import { RoomRealtimeBroadcaster } from "../realtime/room-realtime.broadcaster";
import { PlaylistService } from "../playlist/playlist.service";
import {
  peerSignalChannel,
  sessionReplacementChannel
} from "../realtime/room-realtime.channels";
import { PeerSignalRelayService } from "./peer-signal-relay.service";
import { RealtimeRedisSubscriber } from "./realtime-redis-subscriber.service";
import { RoomPlaybackReadinessService } from "./room-playback-readiness.service";
import { RoomSessionLeaseService, type SessionLease } from "./room-session-lease.service";
import { RoomSessionRegistryService } from "./room-session-registry.service";
import {
  buildSubscribeAck,
  getSocketIp,
  getSocketSessionToken,
  peerSignalRateLimits,
  type RealtimeRateLimitBucket
} from "./signaling.helpers";

@WebSocketGateway({
  path: "/ws/socket.io",
  cors: { origin: getCorsOrigins(), credentials: true }
})
export class SignalingGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly realtimeRateLimits = new Map<string, Map<string, RealtimeRateLimitBucket>>();
  private readonly unauthenticatedConnectionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly socketIdsByIp = new Map<string, Set<string>>();
  private readonly maxSocketsPerIp = 20;
  private readonly unauthenticatedConnectionTimeoutMs = 15_000;
  private readonly telemetryLastReportAt = new Map<string, number>();
  private readonly telemetryReportRetentionMs = 10 * 60 * 1_000;

  constructor(
    private readonly redisService: RedisService,
    private readonly roomService: RoomService,
    private readonly roomRealtimePublisher: RoomRealtimePublisher,
    private readonly roomRealtimeBroadcaster: RoomRealtimeBroadcaster,
    private readonly authService: AuthService,
    private readonly metrics: MetricsService,
    private readonly abuseProtection: AbuseProtectionService,
    private readonly sessionLease: RoomSessionLeaseService,
    private readonly peerSignals: PeerSignalRelayService,
    private readonly readiness: RoomPlaybackReadinessService,
    private readonly registry: RoomSessionRegistryService,
    private readonly subscriber: RealtimeRedisSubscriber,
    private readonly roomChatService: RoomChatService,
    private readonly playlistService: PlaylistService
  ) {}

  @WebSocketServer()
  server!: Server;

  afterInit() {
    this.ensureBroadcasterServer();
    this.peerSignals.setServer(this.server);
    this.readiness.setServer(this.server);
    this.registry.setServer(this.server);
    this.subscriber.setServer(this.server);
    this.subscriber.subscribeAll();
  }

  async handleConnection(client: Socket) {
    const connectionIp = getSocketIp(client);
    const socketIds = this.socketIdsByIp.get(connectionIp) ?? new Set<string>();
    if (socketIds.size >= this.maxSocketsPerIp) {
      client.disconnect(true);
      return;
    }
    socketIds.add(client.id);
    this.socketIdsByIp.set(connectionIp, socketIds);
    client.data.connectionIp = connectionIp;

    try {
      await this.abuseProtection.enforce(
        "ws:connect",
        [{ name: "ip", value: connectionIp }],
        { limit: 60, windowMs: 60 * 1000 }
      );
    } catch {
      this.releaseSocketIp(client);
      client.disconnect(true);
      return;
    }

    const sessionToken = getSocketSessionToken(client);
    if (sessionToken) {
      try {
        const session = await this.authService.getAuthSessionByTokenOrThrow(sessionToken);
        client.data.handshakeSessionId = session.userId;
        client.data.handshakeAuthenticated = true;
        return;
      } catch {
        this.releaseSocketIp(client);
        client.disconnect(true);
        return;
      }
    }

    const timer = setTimeout(() => {
      this.unauthenticatedConnectionTimers.delete(client.id);
      client.disconnect(true);
    }, this.unauthenticatedConnectionTimeoutMs);
    this.unauthenticatedConnectionTimers.set(client.id, timer);
  }

  onModuleDestroy() {
    this.subscriber.dispose();
    this.registry.dispose();
    this.peerSignals.dispose();
    this.readiness.dispose();
    for (const timer of this.unauthenticatedConnectionTimers.values()) {
      clearTimeout(timer);
    }
    this.unauthenticatedConnectionTimers.clear();
    this.socketIdsByIp.clear();
    this.telemetryLastReportAt.clear();
  }

  @SubscribeMessage("peer.signal")
  async handleSignal(@ConnectedSocket() client: Socket, @MessageBody() payload: PeerSignalMessage) {
    const parsed = peerSignalMessageSchema.safeParse(payload);
    if (!parsed.success) {
      throw createWsApiException(
        "Invalid peer signal payload.",
        errorCodes.validationFailed,
        parsed.error.flatten()
      );
    }
    const message = parsed.data;
    this.assertRealtimeRateLimit(
      client,
      message.type === "candidate" ? "peer.signal.candidate" : "peer.signal.description",
      message.type === "candidate"
        ? peerSignalRateLimits.candidate
        : peerSignalRateLimits.description
    );

    this.assertRealtimeClient(client, message.roomId);
    const sessionId = client.data.sessionId as string;
    await this.assertUserStillActive(sessionId);
    await this.sessionLease.assert(client);
    if (client.data.peerId !== message.fromPeerId) {
      throw new WsException("Peer mismatch.");
    }
    await this.assertRoomMemberForSocket(message.roomId, sessionId);

    const nextPayload = {
      ...message,
      sequence: this.peerSignals.nextSequence(),
      recoveryGeneration:
        message.recoveryGeneration ?? this.peerSignals.resolvePeerRecoveryGeneration(message.roomId, message.toPeerId),
      senderRecoveryGeneration:
        this.peerSignals.resolvePeerRecoveryGeneration(message.roomId, message.fromPeerId)
    } as PeerSignalMessage;

    await this.peerSignals.emitToPeer(message.roomId, nextPayload.toPeerId, nextPayload);
    this.publishRealtime(peerSignalChannel, {
      sourceId: this.roomRealtimeBroadcaster.instanceId,
      roomId: message.roomId,
      payload: nextPayload
    });
    return nextPayload;
  }

  @SubscribeMessage("diagnostics.report")
  async handleDiagnosticsReport(@ConnectedSocket() client: Socket, @MessageBody() payload: unknown) {
    this.assertRealtimeRateLimit(client, "diagnostics.report", 30);
    const parsed = diagnosticsReportPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw createWsApiException("Invalid diagnostics report.", errorCodes.validationFailed, parsed.error.flatten());
    }
    const report = parsed.data;
    this.assertRealtimeClient(client, report.roomId);
    await this.assertUserStillActive(client.data.sessionId as string);
    await this.sessionLease.assert(client);
    if (client.data.sessionId !== report.sessionId || client.data.peerId !== report.peerId) {
      throw new WsException("Diagnostics identity mismatch.");
    }
    await this.assertRoomMemberForSocket(report.roomId, report.sessionId);
    const rateKey = `${report.roomId}:${report.peerId}`;
    const now = Date.now();
    if (now - (this.telemetryLastReportAt.get(rateKey) ?? 0) < 5_000) { this.metrics.incrementDiagnosticsRateLimited(); return { ok: false, rateLimited: true }; }
    if (this.telemetryLastReportAt.size >= 4_096) {
      // Entries are only ever written; without a sweep the map grows with
      // every room/peer combination the process has ever seen.
      for (const [key, reportedAt] of this.telemetryLastReportAt) {
        if (now - reportedAt > this.telemetryReportRetentionMs) {
          this.telemetryLastReportAt.delete(key);
        }
      }
    }
    this.telemetryLastReportAt.set(rateKey, now);
    if (this.redisService.isAvailable()) {
      await this.redisService.setJson(`soqaro:admin:telemetry:peer:${report.roomId}:${report.peerId}`, report, 45);
      await this.redisService.addSortedSetScore(`soqaro:admin:telemetry:room-peers:${report.roomId}`, now, report.peerId);
      await this.redisService.addSortedSetScore("soqaro:admin:telemetry:active-rooms", now, report.roomId);
    }
    this.metrics.incrementDiagnosticsReport();
    return { ok: true };
  }

  @SubscribeMessage("room.playback.readiness")
  async handlePlaybackReadiness(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: unknown,
    callback?: (payload: RoomPlaybackReadinessPayload) => void
  ) {
    this.assertRealtimeRateLimit(client, "room.playback.readiness", 60);
    const parsed = roomPlaybackReadinessInputPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw createWsApiException(
        "Invalid playback readiness payload.",
        errorCodes.validationFailed,
        parsed.error.flatten()
      );
    }
    const message = parsed.data;
    this.assertRealtimeClient(client, message.roomId);
    await this.assertUserStillActive(client.data.sessionId as string);
    await this.sessionLease.assert(client);
    if (client.data.sessionId !== message.sessionId || client.data.peerId !== message.peerId) {
      throw new WsException("Playback readiness identity mismatch.");
    }

    const canonical = await this.readiness.handleReadiness(message);
    if (!canonical) {
      return;
    }
    callback?.(canonical);
    return canonical;
  }

  @SubscribeMessage("room.chat")
  async handleRoomChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: RoomChatInputPayload
  ) {
    this.assertRealtimeRateLimit(client, "room.chat", 30);
    const parsed = roomChatInputPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw createWsApiException(
        "Invalid chat payload.",
        errorCodes.validationFailed,
        parsed.error.flatten()
      );
    }

    this.assertRealtimeClient(client, parsed.data.roomId);
    await this.sessionLease.assert(client);
    const sessionId = client.data.sessionId as string | undefined;
    if (!sessionId) {
      throw new WsException("Unauthorized realtime request.");
    }

    const user = await this.authService.getUserOrThrow(sessionId) as {
      id: string;
      nickname: string;
      status?: string;
    };
    if (user.status === "DISABLED") {
      throw new WsException("Account is disabled.");
    }
    const nextPayload = await this.roomChatService.append({
      roomId: parsed.data.roomId,
      sessionId: user.id,
      senderName: user.nickname,
      content: parsed.data.content
    });

    this.server.to(parsed.data.roomId).emit("room.chat", nextPayload);
    return nextPayload;
  }

  @SubscribeMessage("room.reaction")
  async handleRoomReaction(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: RoomReactionInputPayload
  ) {
    this.assertRealtimeRateLimit(client, "room.reaction", 20);
    const parsed = roomReactionInputPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw createWsApiException("Invalid room reaction payload.", errorCodes.validationFailed, parsed.error.flatten());
    }
    this.assertRealtimeClient(client, parsed.data.roomId);
    await this.sessionLease.assert(client);
    const sessionId = client.data.sessionId as string | undefined;
    if (!sessionId) throw new WsException("Unauthorized realtime request.");
    const user = await this.authService.getUserOrThrow(sessionId) as {
      id: string;
      nickname: string;
      status?: string;
    };
    if (user.status === "DISABLED") {
      throw new WsException("Account is disabled.");
    }
    const rawTrackId = parsed.data.trackId?.trim() || null;
    const trackId = rawTrackId ?? (await this.roomService.getRoomCurrentTrackId(parsed.data.roomId)) ?? null;
    let totalCount = 0;
    try {
      totalCount = await this.roomService.recordRoomReaction({
        roomId: parsed.data.roomId,
        userId: user.id,
        trackId,
        reactionType: parsed.data.reaction
      });
    } catch (error) {
      throw createWsApiException(
        error instanceof Error ? error.message : "Reaction recording failed."
      );
    }
    const nextPayload = {
      roomId: parsed.data.roomId,
      senderId: user.id,
      senderName: user.nickname,
      reaction: parsed.data.reaction,
      trackId,
      timestamp: Date.now(),
      totalCount
    };
    this.server.to(parsed.data.roomId).emit("room.reaction", nextPayload);
    return nextPayload;
  }

  @SubscribeMessage("room.clock")
  async handleRoomClock(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: RoomClockInputPayload
  ) {
    this.assertRealtimeRateLimit(client, "room.clock", 60);
    const parsed = roomClockInputPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw createWsApiException(
        "Invalid room clock payload.",
        errorCodes.validationFailed,
        parsed.error.flatten()
      );
    }

    this.assertRealtimeClient(client, parsed.data.roomId);
    await this.assertUserStillActive(client.data.sessionId as string);
    await this.sessionLease.assert(client);
    return { serverNow: new Date().toISOString() };
  }

  @SubscribeMessage("room.subscribe")
  async handleRoomSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: RoomSubscribePayload
  ) {
    this.assertRealtimeRateLimit(client, "room.subscribe", 12);
    const parsed = roomSubscribePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw createWsApiException(
        "Invalid room subscribe payload.",
        errorCodes.validationFailed,
        parsed.error.flatten()
      );
    }
    const message = parsed.data;

    if (
      (message.protocolVersion ?? client.data.protocolVersion) !== 4 ||
      !(message.capabilities ?? client.data.capabilities)?.includes("webrtc-opus-v1")
    ) {
      return {
        ok: false,
        protocolVersion: 4,
        capability: "webrtc-opus-v1",
        errorCode: "client_upgrade_required"
      } satisfies RoomSubscribeAckPayload;
    }

    this.ensureBroadcasterServer();
    if (!message.sessionId || !message.peerId) {
      throw new WsException("Missing session identity.");
    }

    const sessionToken = getSocketSessionToken(client);
    try {
      await this.authService.assertSessionToken(message.sessionId, sessionToken);
    } catch (error) {
      throw createWsApiException(
        error instanceof Error ? error.message : "Unauthorized.",
        errorCodes.unauthorized
      );
    }
    if (
      client.data.handshakeAuthenticated &&
      client.data.handshakeSessionId !== message.sessionId
    ) {
      throw createWsApiException("Realtime identity mismatch.", errorCodes.unauthorized);
    }
    await this.assertUserStillActive(message.sessionId);

    let playlists: Playlist[] = [];
    try {
      playlists = await this.playlistService.listPlaylistsForRoom(message.roomId);
    } catch {
      playlists = [];
    }

    let precheckSnapshot: RoomSnapshot;
    try {
      precheckSnapshot = await this.roomService.getAccessibleRoomSnapshot(
        message.roomId,
        playlists,
        message.sessionId
      );
    } catch {
      client.emit("room.snapshot.missing", { roomId: message.roomId });
      return { ok: false };
    }

    const isMember =
      precheckSnapshot.room.hostId === message.sessionId ||
      precheckSnapshot.room.members.some((member) => member.id === message.sessionId);
    if (!isMember) {
      client.emit("room.snapshot.missing", { roomId: message.roomId });
      return { ok: false };
    }

    const localPeerOwner = this.registry.findSessionByPeerId(message.roomId, message.peerId);
    const snapshotPeerConflict = precheckSnapshot.room.members.some(
      (member) =>
        member.id !== message.sessionId &&
        member.presenceState !== "offline" &&
        member.peerId === message.peerId
    );
    if ((localPeerOwner && localPeerOwner !== message.sessionId) || snapshotPeerConflict) {
      throw createWsApiException("Peer ID is already in use.", errorCodes.unauthorizedRoomAction);
    }
    await this.sessionLease.claimPeerId(message.roomId, message.sessionId, message.peerId);

    const pendingAuthenticationTimer = this.unauthenticatedConnectionTimers.get(client.id);
    if (pendingAuthenticationTimer) {
      clearTimeout(pendingAuthenticationTimer);
      this.unauthenticatedConnectionTimers.delete(client.id);
    }

    const previousRoomId = client.data.roomId as string | undefined;
    const previousSessionId = client.data.sessionId as string | undefined;
    const previousPeerId = client.data.peerId as string | undefined;

    const fenceToken = randomUUID();
    let previousLease: Awaited<ReturnType<RoomSessionLeaseService["claim"]>> = null;
    try {
      // Claim the target lease before dismantling the current socket. If Redis
      // rejects the claim, the existing subscription remains usable.
      previousLease = await this.sessionLease.claim(
        message.roomId,
        message.sessionId,
        message.peerId,
        client.id,
        fenceToken
      );

      this.peerSignals.unregisterPeerSocket(
        previousRoomId,
        previousPeerId,
        client.id
      );
      this.registry.unregisterSessionSocket(
        previousRoomId,
        previousSessionId,
        client.id
      );
      this.metrics.unbindRealtimeSocket(client.id);
      client.data ??= {};
    } catch (error) {
      await this.sessionLease.releasePeerId(message.roomId, message.sessionId, message.peerId);
      await this.sessionLease.rollback(message.roomId, message.sessionId, previousLease, {
        peerId: message.peerId,
        socketId: client.id,
        fenceToken
      });
      throw error;
    }

    client.data.roomId = message.roomId;
    client.data.sessionId = message.sessionId;
    client.data.peerId = message.peerId;
    client.data.sessionFenceToken = fenceToken;
    client.data.protocolVersion = 4;
    client.data.capabilities = ["webrtc-opus-v1"];
    client.data.isRealtimeAuthenticated = true;

    let recoveryGeneration: number;
    try {
      this.registry.cancelPendingDisconnectCleanup(message.roomId, message.sessionId);
      const presenceUpdated = await this.registry.updatePeerPresence(
        message.roomId,
        message.sessionId,
        message.peerId,
        "online"
      );
      if (!presenceUpdated) {
        throw new WsException("Realtime presence is unavailable.");
      }
      await this.registry.rememberRecentRoom(message.roomId, message.sessionId);
      let snapshot: RoomSnapshot;
      try {
        snapshot = await this.roomService.getAccessibleRoomSnapshot(message.roomId, playlists, message.sessionId);
      } catch {
        await this.cleanupFailedRoomSubscribe(
          client,
          message.roomId,
          message.sessionId,
          message.peerId,
          previousLease
        );
        client.emit("room.snapshot.missing", { roomId: message.roomId });
        return { ok: false };
      }

      client.join(message.roomId);
      recoveryGeneration = this.peerSignals.registerRecoveryGeneration(
        message.roomId,
        message.sessionId,
        message.peerId
      );
      this.peerSignals.registerPeerSocket(message.roomId, message.peerId, client.id);
      this.registry.registerSessionSocket(
        message.roomId,
        message.sessionId,
        message.peerId,
        client.id,
        fenceToken
      );

      // New subscription is fully established. Now commit the transition:
      if (
        previousRoomId &&
        previousSessionId &&
        (previousRoomId !== message.roomId || previousSessionId !== message.sessionId)
      ) {
        client.leave(previousRoomId);
        void this.registry.updatePeerPresence(previousRoomId, previousSessionId, null, "offline");
        this.readiness.clearForSession(previousRoomId, previousSessionId, previousPeerId);
        await this.sessionLease.releasePeerId(previousRoomId, previousSessionId, previousPeerId);
      }

      await this.registry.replaceExistingRoomSession(
        message.roomId,
        message.sessionId,
        message.peerId,
        client.id
      );

      if (
        previousLease?.socketId &&
        previousLease.socketId !== client.id &&
        previousLease.instanceId !== this.roomRealtimeBroadcaster.instanceId
      ) {
        this.publishRealtime(sessionReplacementChannel, {
          sourceId: this.roomRealtimeBroadcaster.instanceId,
          roomId: message.roomId,
          sessionId: message.sessionId,
          socketId: previousLease.socketId
        });
      }

      this.metrics.bindRealtimeSocket(client.id, message.roomId);
      // Flush the compact subscribe ack before the snapshot so peer negotiation can start immediately.
      setImmediate(() => {
        if (!this.registry.isActiveSessionSocket(message.roomId, message.sessionId, client.id)) {
          return;
        }
        client.emit("room.snapshot", snapshot);
        const key = `${snapshot.room.playback.currentTrackId ?? "none"}:${snapshot.room.playback.mediaEpoch}`;
        for (const item of this.readiness.getReadinessForTimeline(message.roomId, key)) {
          client.emit("room.playback.readiness", item);
        }
      });
      return buildSubscribeAck(snapshot, recoveryGeneration);
    } catch (error) {
      await this.cleanupFailedRoomSubscribe(
        client,
        message.roomId,
        message.sessionId,
        message.peerId,
        previousLease
      );
      throw createWsApiException(error instanceof Error ? error.message : "Unauthorized.");
    }
  }

  @SubscribeMessage("room.presence")
  async handleRoomPresence(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: RoomPresencePayload
  ) {
    const parsed = roomPresencePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw createWsApiException(
        "Invalid room presence payload.",
        errorCodes.validationFailed,
        parsed.error.flatten()
      );
    }
    const message = parsed.data;

    this.ensureBroadcasterServer();
    if (
      client.data.isRealtimeAuthenticated &&
      client.data.roomId !== message.roomId &&
      !client.data.roomId
    ) {
      return { ok: false, reason: "not-subscribed" as const };
    }
    this.assertRealtimeClient(client, message.roomId);
    await this.assertUserStillActive(client.data.sessionId as string);
    const leaseStatus = await this.sessionLease.checkSocketLease(client);
    if (leaseStatus === "missing") {
      return { ok: false, reason: "lease-missing" as const };
    }
    if (leaseStatus === "replaced") {
      throw new WsException("Realtime session was replaced.");
    }
    if (leaseStatus === "unavailable") {
      throw new WsException("Realtime session coordination is unavailable.");
    }
    if (!(await this.sessionLease.renew(client))) {
      throw new WsException("Realtime session was replaced.");
    }

    if (client.data.sessionId !== message.sessionId || client.data.peerId !== message.peerId) {
      throw new WsException("Presence mismatch.");
    }

    const refreshResult = await this.roomService.refreshRealtimePresence(
      message.roomId,
      message.sessionId,
      message.peerId
    );
    if (refreshResult.changed) {
      await this.roomRealtimePublisher.emitTopologySnapshot(message.roomId);
    }
    return { ok: true };
  }

  @SubscribeMessage("room.unsubscribe")
  async handleRoomUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: RoomUnsubscribePayload
  ) {
    const parsed = roomUnsubscribePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw createWsApiException(
        "Invalid room unsubscribe payload.",
        errorCodes.validationFailed,
        parsed.error.flatten()
      );
    }
    const message = parsed.data;

    this.assertRealtimeClient(client, message.roomId);
    const sessionId = client.data.sessionId as string | undefined;
    const peerId = client.data.peerId as string | undefined;
    const isActiveSessionSocket = this.registry.isActiveSessionSocket(message.roomId, sessionId, client.id);
    const ownsLease = sessionId && isActiveSessionSocket
      ? await this.sessionLease.belongsTo(message.roomId, sessionId, {
          peerId,
          socketId: client.id,
          fenceToken: client.data.sessionFenceToken as string | undefined
        })
      : false;

    this.peerSignals.unregisterPeerSocket(message.roomId, peerId, client.id);
    this.registry.unregisterSessionSocket(message.roomId, sessionId, client.id);
    this.metrics.unbindRealtimeSocket(client.id);
    if (sessionId && isActiveSessionSocket) {
      this.registry.cancelPendingDisconnectCleanup(message.roomId, sessionId);
    }
    client.leave(message.roomId);
    if (sessionId && isActiveSessionSocket && ownsLease) {
      await this.registry.updatePeerPresence(
        message.roomId,
        sessionId,
        null,
        "offline"
      );
    }
    if (sessionId && isActiveSessionSocket) {
      await this.sessionLease.release(client);
      await this.sessionLease.releasePeerId(message.roomId, sessionId, peerId);
    }
    if (peerId) {
      this.peerSignals.clearPendingPeerSignals(message.roomId, peerId);
    }
    this.readiness.clearForSession(message.roomId, sessionId, peerId);
    this.peerSignals.clearRecoveryGeneration(message.roomId, sessionId, peerId);
    this.realtimeRateLimits.delete(client.id);
    client.data.roomId = undefined;
    client.data.sessionId = undefined;
    client.data.peerId = undefined;
    client.data.sessionFenceToken = undefined;
    client.data.isRealtimeAuthenticated = false;
    return { ok: true };
  }

  async handleDisconnect(client: Socket) {
    this.realtimeRateLimits.delete(client.id);
    this.sessionLease.invalidateSocket(client.id);
    const pendingAuthenticationTimer = this.unauthenticatedConnectionTimers.get(client.id);
    if (pendingAuthenticationTimer) {
      clearTimeout(pendingAuthenticationTimer);
      this.unauthenticatedConnectionTimers.delete(client.id);
    }
    this.releaseSocketIp(client);
    const roomId = client.data.roomId as string | undefined;
    const sessionId = client.data.sessionId as string | undefined;
    const peerId = client.data.peerId as string | undefined;
    const isActiveSessionSocket = this.registry.isActiveSessionSocket(roomId, sessionId, client.id);

    this.peerSignals.unregisterPeerSocket(roomId, peerId, client.id);
    this.registry.unregisterSessionSocket(roomId, sessionId, client.id);
    this.metrics.unbindRealtimeSocket(client.id);
    if (roomId && sessionId && isActiveSessionSocket) {
      const ownsLease = await this.sessionLease.belongsTo(roomId, sessionId, {
        peerId,
        socketId: client.id,
        fenceToken: client.data.sessionFenceToken as string | undefined
      });
      if (!ownsLease) {
        return;
      }
      void this.registry.updatePeerPresence(roomId, sessionId, null, "reconnecting").finally(() => {
        this.readiness.clearForSession(roomId, sessionId, peerId);
      });
      this.registry.scheduleDisconnectCleanup(
        roomId,
        sessionId,
        peerId,
        client.id,
        client.data.sessionFenceToken as string | undefined
      );
    }
  }



  private releaseSocketIp(client: Socket) {
    const ip = client.data.connectionIp as string | undefined;
    if (!ip) return;
    const socketIds = this.socketIdsByIp.get(ip);
    socketIds?.delete(client.id);
    if (socketIds?.size === 0) {
      this.socketIdsByIp.delete(ip);
    }
    client.data.connectionIp = undefined;
  }

  private assertRealtimeClient(client: Socket, roomId: string) {
    if (!client.data.isRealtimeAuthenticated || client.data.roomId !== roomId) {
      throw new WsException("Unauthorized realtime request.");
    }
  }

  private publishRealtime(channel: string, payload: unknown) {
    void (async () => {
      const retryDelaysMs = [0, 100, 250, 500, 1_000, 2_000];
      for (const delayMs of retryDelaysMs) {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        try {
          await this.redisService.publish(channel, payload);
          return;
        } catch {
          // Retry short Redis outages so ICE and room patches are not lost.
        }
      }
      this.metrics.incrementRealtimeFailure();
    })();
  }



  private assertRealtimeRateLimit(client: Socket, action: string, limit: number) {
    const now = Date.now();
    const limits = this.realtimeRateLimits.get(client.id) ?? new Map<string, RealtimeRateLimitBucket>();
    const current = limits.get(action);
    const bucket = !current || now - current.windowStartedAt >= 60_000
      ? { windowStartedAt: now, count: 0 }
      : current;
    if (bucket.count >= limit) {
      throw createWsApiException("Realtime message rate limit exceeded.", errorCodes.rateLimited);
    }
    bucket.count += 1;
    limits.set(action, bucket);
    this.realtimeRateLimits.set(client.id, limits);
  }

  private ensureBroadcasterServer() {
    if (this.server) {
      this.roomRealtimeBroadcaster.setServer(this.server);
    }
    this.roomRealtimeBroadcaster.setEvictionHandler?.({
      evictMember: (roomId, memberId) => {
        void this.registry.evictMemberSockets(roomId, memberId);
      },
      evictRoom: (roomId) => {
        void this.registry.evictRoomSockets(roomId);
      }
    });
  }

  private async cleanupFailedRoomSubscribe(
    client: Socket,
    roomId: string,
    sessionId: string,
    peerId: string,
    previousLease?: SessionLease | null
  ) {
    const wasActiveSocket = this.registry.isActiveSessionSocket(roomId, sessionId, client.id);
    const ownsLease = await this.sessionLease.belongsTo(roomId, sessionId, {
      peerId,
      socketId: client.id,
      fenceToken: client.data.sessionFenceToken as string | undefined
    });

    this.registry.cancelPendingDisconnectCleanup(roomId, sessionId);
    this.peerSignals.unregisterPeerSocket(roomId, peerId, client.id);
    this.registry.unregisterSessionSocket(roomId, sessionId, client.id);
    this.peerSignals.clearPendingPeerSignals(roomId, peerId);
    this.peerSignals.clearRecoveryGeneration(roomId, sessionId, peerId);
    this.readiness.clearForSession(roomId, sessionId, peerId);
    this.metrics.unbindRealtimeSocket(client.id);

    // Only the socket that still owns the fenced lease may transition the
    // member offline. A replaced socket must not undo the new connection.
    const isRestoringOtherSocket = Boolean(previousLease?.socketId && previousLease.socketId !== client.id);
    if (wasActiveSocket && ownsLease && !isRestoringOtherSocket) {
      await this.registry.updatePeerPresence(roomId, sessionId, null, "offline");
    }

    if (previousLease !== undefined) {
      await this.sessionLease.rollback(roomId, sessionId, previousLease, {
        peerId,
        socketId: client.id,
        fenceToken: client.data.sessionFenceToken as string
      });
    } else {
      await this.sessionLease.release(client);
    }
    if (!isRestoringOtherSocket) {
      await this.sessionLease.releasePeerId?.(roomId, sessionId, peerId);
    }

    client.leave(roomId);
    client.data.roomId = undefined;
    client.data.sessionId = undefined;
    client.data.peerId = undefined;
    client.data.sessionFenceToken = undefined;
    client.data.isRealtimeAuthenticated = false;
  }

  private async assertRoomMemberForSocket(roomId: string, sessionId: string) {
    try {
      await this.roomService.assertRoomMember(roomId, sessionId);
    } catch (error) {
      throw createWsApiException(
        error instanceof Error ? error.message : "Unauthorized room action.",
        errorCodes.unauthorizedRoomAction
      );
    }
  }

  private async assertUserStillActive(sessionId: string) {
    if (!sessionId) throw new WsException("Unauthorized realtime request.");
    try {
      const user = await this.authService.getUserOrThrow(sessionId) as { status?: string };
      if (user.status === "DISABLED") throw new WsException("Account is disabled.");
    } catch (error) {
      if (error instanceof WsException) throw error;
      throw new WsException("Unauthorized realtime request.");
    }
  }
}
