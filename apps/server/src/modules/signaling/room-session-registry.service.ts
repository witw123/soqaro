import { Injectable, Logger } from "@nestjs/common";
import type { Server, Socket } from "socket.io";
import { MetricsService } from "../../common/metrics/metrics.service";
import { RoomRealtimePublisher } from "../room/services/room-realtime.publisher";
import { RoomService } from "../room/room.service";
import { PeerSignalRelayService } from "./peer-signal-relay.service";
import { RoomPlaybackReadinessService } from "./room-playback-readiness.service";
import { RoomSessionLeaseService } from "./room-session-lease.service";

/**
 * In-memory socket registry for active room sessions, plus the disconnect
 * grace period that marks a departing member "reconnecting" for a short window
 * before their session is torn down. Also owns the small presence wrappers
 * that notify the room when a member's realtime presence changes.
 */
@Injectable()
export class RoomSessionRegistryService {
  private readonly logger = new Logger(RoomSessionRegistryService.name);
  // Background browser tabs under Intensive Wake Up Throttling only run timers
  // once every 60s. Keep the disconnect grace window above one throttled tick
  // so a transient socket drop in a hidden source tab can reconnect without
  // flipping the room to paused.
  private readonly disconnectGracePeriodMs = 90_000;
  private readonly activeSessionsByRoom = new Map<
    string,
    Map<string, { socketId: string; peerId: string; fenceToken: string }>
  >();
  private readonly pendingDisconnectCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private server: Server | null = null;

  constructor(
    private readonly sessionLease: RoomSessionLeaseService,
    private readonly peerSignals: PeerSignalRelayService,
    private readonly readiness: RoomPlaybackReadinessService,
    private readonly roomService: RoomService,
    private readonly roomRealtimePublisher: RoomRealtimePublisher,
    private readonly metrics: MetricsService
  ) {}

  setServer(server: Server) {
    this.server = server;
  }

  registerSessionSocket(
    roomId?: string,
    sessionId?: string,
    peerId?: string,
    socketId?: string,
    fenceToken = "local"
  ) {
    if (!roomId || !sessionId || !peerId || !socketId) {
      return;
    }

    const roomSessions = this.activeSessionsByRoom.get(roomId) ?? new Map();
    roomSessions.set(sessionId, { socketId, peerId, fenceToken });
    this.activeSessionsByRoom.set(roomId, roomSessions);
  }

  unregisterSessionSocket(roomId?: string, sessionId?: string, socketId?: string) {
    if (!roomId || !sessionId || !socketId) {
      return;
    }

    const roomSessions = this.activeSessionsByRoom.get(roomId);
    if (!roomSessions) {
      return;
    }

    const current = roomSessions.get(sessionId);
    if (!current || current.socketId !== socketId) {
      return;
    }

    roomSessions.delete(sessionId);
    if (roomSessions.size === 0) {
      this.activeSessionsByRoom.delete(roomId);
    }
  }

  isActiveSessionSocket(roomId?: string, sessionId?: string, socketId?: string) {
    if (!roomId || !sessionId || !socketId) {
      return false;
    }

    return this.activeSessionsByRoom.get(roomId)?.get(sessionId)?.socketId === socketId;
  }

  findSessionByPeerId(roomId: string, peerId: string): string | null {
    const roomSessions = this.activeSessionsByRoom.get(roomId);
    if (!roomSessions) {
      return null;
    }
    for (const [sessionId, entry] of roomSessions) {
      if (entry.peerId === peerId) {
        return sessionId;
      }
    }
    return null;
  }

  async replaceExistingRoomSession(
    roomId: string,
    sessionId: string,
    nextPeerId: string,
    nextSocketId: string
  ) {
    const existing = this.activeSessionsByRoom.get(roomId)?.get(sessionId);
    if (!existing || existing.socketId === nextSocketId) {
      return;
    }

    this.cancelPendingDisconnectCleanup(roomId, sessionId);
    this.peerSignals.unregisterPeerSocket(roomId, existing.peerId, existing.socketId);
    this.unregisterSessionSocket(roomId, sessionId, existing.socketId);
    this.metrics.unbindRealtimeSocket(existing.socketId);
    this.peerSignals.clearRecoveryGeneration(roomId, sessionId, existing.peerId);

    const replacedSocket = this.server?.sockets.sockets.get(existing.socketId);
    const isSeamlessReconnect = existing.peerId === nextPeerId;
    if (isSeamlessReconnect) {
      if (replacedSocket) {
        this.invalidateReplacedSocket(replacedSocket, roomId, { notifyReplaced: false });
      }
      return;
    }

    await this.roomService.handleDuplicateSessionReplacement(roomId, sessionId);
    await this.roomRealtimePublisher.emitTopologySnapshot(roomId);

    if (!replacedSocket) {
      return;
    }

    this.invalidateReplacedSocket(replacedSocket, roomId);
  }

  scheduleDisconnectCleanup(
    roomId: string,
    sessionId: string,
    peerId?: string,
    socketId?: string,
    fenceToken?: string
  ) {
    this.cancelPendingDisconnectCleanup(roomId, sessionId);
    const cleanupKey = this.disconnectCleanupKey(roomId, sessionId);
    const timeoutId = setTimeout(() => {
      this.pendingDisconnectCleanupTimers.delete(cleanupKey);
      void this.finalizePeerDisconnect(roomId, sessionId, peerId, socketId, fenceToken);
    }, this.disconnectGracePeriodMs);
    this.pendingDisconnectCleanupTimers.set(cleanupKey, timeoutId);
  }

  cancelPendingDisconnectCleanup(roomId: string, sessionId: string) {
    const cleanupKey = this.disconnectCleanupKey(roomId, sessionId);
    const timeoutId = this.pendingDisconnectCleanupTimers.get(cleanupKey);
    if (!timeoutId) {
      return;
    }

    clearTimeout(timeoutId);
    this.pendingDisconnectCleanupTimers.delete(cleanupKey);
  }

  async finalizePeerDisconnect(
    roomId: string,
    sessionId: string,
    peerId?: string,
    socketId?: string,
    fenceToken?: string
  ) {
    if (this.activeSessionsByRoom.get(roomId)?.has(sessionId)) {
      return;
    }

    const ownsLease = await this.sessionLease.belongsTo(roomId, sessionId, {
      peerId,
      socketId,
      fenceToken
    });
    if (!ownsLease) {
      return;
    }
    await this.updatePeerPresence(roomId, sessionId, null, "offline");
    const deleted = await this.sessionLease.delete(roomId, sessionId, {
      peerId,
      socketId,
      fenceToken
    });
    if (!deleted) {
      return;
    }
    await this.sessionLease.releasePeerId?.(roomId, sessionId, peerId);

    this.readiness.clearForSession(roomId, sessionId, peerId);
    if (peerId) {
      this.peerSignals.clearPendingPeerSignals(roomId, peerId);
    }
    this.peerSignals.clearRecoveryGeneration(roomId, sessionId, peerId);
  }

  invalidateReplacedSocket(
    socket: Socket,
    roomId: string,
    options?: {
      notifyReplaced?: boolean;
    }
  ) {
    const sessionId = socket.data.sessionId as string | undefined;
    const peerId = socket.data.peerId as string | undefined;
    this.sessionLease.invalidateSocket(socket.id);
    if (sessionId) {
      this.cancelPendingDisconnectCleanup(roomId, sessionId);
    }
    this.peerSignals.unregisterPeerSocket(roomId, peerId, socket.id);
    this.unregisterSessionSocket(roomId, sessionId, socket.id);
    this.metrics.unbindRealtimeSocket(socket.id);
    if (options?.notifyReplaced !== false) {
      socket.emit("room.session.replaced", {
        roomId,
        reason: "duplicate-session"
      });
    }
    socket.leave(roomId);
    socket.data.roomId = undefined;
    socket.data.sessionId = undefined;
    socket.data.peerId = undefined;
    socket.data.sessionFenceToken = undefined;
    socket.data.isRealtimeAuthenticated = false;
  }

  async updatePeerPresence(
    roomId: string,
    sessionId: string,
    peerId: string | null,
    presenceState: "online" | "reconnecting" | "offline"
  ): Promise<boolean> {
    try {
      await this.roomService.updatePeerPresence(roomId, sessionId, peerId, presenceState);
      await this.roomRealtimePublisher.emitTopologySnapshot(roomId);
      return true;
    } catch (error) {
      this.metrics.incrementRealtimeFailure();
      this.logger.warn(
        `Unable to update realtime presence for ${roomId}/${sessionId} (${presenceState}): ${String(error)}`
      );
      return false;
    }
  }

  async rememberRecentRoom(roomId: string, sessionId: string) {
    try {
      await this.roomService.rememberRecentRoom(roomId, sessionId);
    } catch {
      noop();
    }
  }

  clearRoomState(roomId: string) {
    this.peerSignals.clearRoomState(roomId);
    this.activeSessionsByRoom.delete(roomId);
    this.metrics.clearRoom(roomId);
    this.readiness.clearRoomState(roomId);
  }

  async evictMemberSockets(roomId: string, sessionId: string) {
    this.cancelPendingDisconnectCleanup(roomId, sessionId);

    const matchingSockets: Socket[] = [];
    if (this.server) {
      for (const socket of this.server.sockets.sockets.values()) {
        if (socket.data?.roomId === roomId && socket.data?.sessionId === sessionId) {
          matchingSockets.push(socket);
        }
      }
    }

    const activeEntry = this.activeSessionsByRoom.get(roomId)?.get(sessionId);
    let knownPeerId = activeEntry?.peerId;

    for (const socket of matchingSockets) {
      const peerId = socket.data?.peerId as string | undefined;
      knownPeerId = knownPeerId ?? peerId;
      this.sessionLease.invalidateSocket(socket.id);
      this.peerSignals.unregisterPeerSocket(roomId, peerId, socket.id);
      this.unregisterSessionSocket(roomId, sessionId, socket.id);
      this.metrics.unbindRealtimeSocket(socket.id);
      this.readiness.clearForSession(roomId, sessionId, peerId);
      if (peerId) {
        this.peerSignals.clearPendingPeerSignals(roomId, peerId);
      }
      this.peerSignals.clearRecoveryGeneration(roomId, sessionId, peerId);
      await this.sessionLease.release(socket);
      socket.leave(roomId);
      socket.data.roomId = undefined;
      socket.data.sessionId = undefined;
      socket.data.peerId = undefined;
      socket.data.sessionFenceToken = undefined;
      socket.data.isRealtimeAuthenticated = false;
    }

    if (activeEntry) {
      this.peerSignals.unregisterPeerSocket(roomId, activeEntry.peerId, activeEntry.socketId);
      this.unregisterSessionSocket(roomId, sessionId, activeEntry.socketId);
      this.metrics.unbindRealtimeSocket(activeEntry.socketId);
    }

    await this.sessionLease.forceDelete?.(roomId, sessionId, knownPeerId);
  }

  async evictRoomSockets(roomId: string) {
    const memberSessions = new Map<string, string | undefined>();
    const activeSessions = this.activeSessionsByRoom.get(roomId);
    if (activeSessions) {
      for (const [sessionId, entry] of activeSessions) {
        memberSessions.set(sessionId, entry.peerId);
      }
    }
    if (this.server) {
      for (const socket of this.server.sockets.sockets.values()) {
        if (socket.data?.roomId === roomId) {
          const sessionId = socket.data?.sessionId as string | undefined;
          const peerId = socket.data?.peerId as string | undefined;
          if (sessionId && !memberSessions.has(sessionId)) {
            memberSessions.set(sessionId, peerId);
          } else if (!sessionId) {
            this.sessionLease.invalidateSocket(socket.id);
            this.metrics.unbindRealtimeSocket(socket.id);
            socket.leave(roomId);
            socket.data.roomId = undefined;
            socket.data.isRealtimeAuthenticated = false;
          }
        }
      }
    }

    for (const [sessionId] of memberSessions) {
      await this.evictMemberSockets(roomId, sessionId);
    }
    this.clearRoomState(roomId);
  }

  dispose() {
    for (const timer of this.pendingDisconnectCleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingDisconnectCleanupTimers.clear();
    this.activeSessionsByRoom.clear();
  }

  private disconnectCleanupKey(roomId: string, sessionId: string) {
    return `${roomId}:${sessionId}`;
  }
}

function noop() {}
