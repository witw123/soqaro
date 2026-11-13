import { Injectable } from "@nestjs/common";
import type { PeerSignalMessage } from "@soqaro/shared";
import type { Server } from "socket.io";
import { RoomSessionLeaseService } from "./room-session-lease.service";

type PendingPeerSignal = {
  payload: PeerSignalMessage;
  expiresAtMs: number;
};

/**
 * WebRTC peer-signal forwarding for a room: delivers signals to a peer's
 * sockets (or queues them while the peer's session is still registering),
 * and tracks the recovery generation that lets a reconnecting peer resume
 * negotiation without re-offering the whole mesh.
 */
@Injectable()
export class PeerSignalRelayService {
  private readonly pendingPeerSignalTtlMs = 10_000;
  private readonly pendingPeerSignalLimit = 32;
  private readonly pendingPeerSignalTargetLimit = 128;
  private server: Server | null = null;
  private sequence = 0;
  private recoveryGenerationSequence = 0;
  private readonly peerSocketsByRoom = new Map<string, Map<string, Set<string>>>();
  private readonly recoveryGenerationByRoomSession = new Map<string, number>();
  private readonly recoveryGenerationByRoomPeer = new Map<string, Map<string, number>>();
  private readonly pendingPeerSignalsByRoomPeer = new Map<string, PendingPeerSignal[]>();
  private readonly peerDeliveryOperations = new Map<string, Promise<void>>();

  constructor(private readonly sessionLease: RoomSessionLeaseService) {}

  setServer(server: Server) {
    this.server = server;
  }

  nextSequence() {
    this.sequence += 1;
    return this.sequence;
  }

  async emitToPeer(
    roomId: string,
    peerId: string,
    payload: PeerSignalMessage
  ) {
    await this.enqueuePeerDelivery(roomId, peerId, async () => {
      // Signals queued during a disconnect must stay ahead of a new live
      // description. Otherwise a fresh answer can overtake the offer that
      // created it and get ignored while the peer is still in `stable`.
      const flushed = await this.flushPendingPeerSignalsNow(roomId, peerId);
      if (!flushed || !(await this.deliverToLivePeer(roomId, peerId, payload))) {
        this.queuePeerSignal(roomId, peerId, payload);
      }
    });
  }

  private enqueuePeerDelivery(
    roomId: string,
    peerId: string,
    task: () => Promise<void>
  ) {
    const key = this.roomPeerKey(roomId, peerId);
    const previous = this.peerDeliveryOperations.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(task);
    this.peerDeliveryOperations.set(key, operation);
    const clear = () => {
      if (this.peerDeliveryOperations.get(key) === operation) {
        this.peerDeliveryOperations.delete(key);
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  private async deliverToLivePeer(
    roomId: string,
    peerId: string,
    payload: PeerSignalMessage
  ) {
    const socketIds = this.peerSocketsByRoom.get(roomId)?.get(peerId);
    if (!this.server || !socketIds?.size) {
      return false;
    }

    const recoveryGeneration = this.resolvePeerRecoveryGeneration(roomId, peerId);
    const nextPayload =
      typeof recoveryGeneration === "number"
        ? {
            ...payload,
            recoveryGeneration
          }
        : payload;
    let delivered = false;
    for (const socketId of [...socketIds]) {
      const socket = this.server.sockets.sockets.get(socketId);
      if (!socket || socket.connected === false) {
        this.unregisterPeerSocket(roomId, peerId, socketId);
        continue;
      }
      if (
        (socket.data?.roomId && socket.data.roomId !== roomId) ||
        (socket.data?.peerId && socket.data.peerId !== peerId)
      ) {
        this.unregisterPeerSocket(roomId, peerId, socketId);
        continue;
      }

      let ownsLease = false;
      try {
        ownsLease = await this.sessionLease.socketOwnsLease(socket);
      } catch {
        // Keep the registration during a transient lease-store outage, but do
        // not claim delivery. The signal remains queued for the next attempt.
        continue;
      }
      if (!ownsLease) {
        this.unregisterPeerSocket(roomId, peerId, socketId);
        continue;
      }

      this.server.to(socketId).emit("peer.signal", nextPayload);
      delivered = true;
    }
    return delivered;
  }

  private queuePeerSignal(
    roomId: string,
    peerId: string,
    payload: PeerSignalMessage,
    expiresAtMs?: number
  ) {
    // A target can receive independent data/media negotiations from every
    // member while its Socket.IO session is still registering. Sharing one
    // short queue across all senders drops the tail of a ten-member fan-out,
    // which leaves a media PC connected in the UI but without an SDP/candidate
    // path. Keep ordering isolated per sender and link kind.
    const key = this.pendingPeerSignalKey(roomId, peerId, payload);
    const now = Date.now();
    if (!this.pendingPeerSignalsByRoomPeer.has(key) && this.pendingPeerSignalsByRoomPeer.size >= this.pendingPeerSignalTargetLimit) {
      const oldestKey = this.pendingPeerSignalsByRoomPeer.keys().next().value;
      if (typeof oldestKey === "string") {
        this.pendingPeerSignalsByRoomPeer.delete(oldestKey);
      }
    }
    const queued = (this.pendingPeerSignalsByRoomPeer.get(key) ?? []).filter(
      (entry) => entry.expiresAtMs > now
    );
    queued.push({
      payload,
      expiresAtMs: expiresAtMs ?? now + this.pendingPeerSignalTtlMs
    });
    if (queued.length > this.pendingPeerSignalLimit) {
      queued.splice(0, queued.length - this.pendingPeerSignalLimit);
    }
    this.pendingPeerSignalsByRoomPeer.set(key, queued);
  }

  private pendingPeerSignalKey(
    roomId: string,
    peerId: string,
    payload: PeerSignalMessage
  ) {
    return `${this.roomPeerKey(roomId, peerId)}:${payload.fromPeerId}:${payload.linkKind ?? "data"}`;
  }

  async flushPendingPeerSignals(roomId: string, peerId: string) {
    await this.enqueuePeerDelivery(roomId, peerId, () =>
      this.flushPendingPeerSignalsNow(roomId, peerId).then(() => undefined)
    );
  }

  private async flushPendingPeerSignalsNow(roomId: string, peerId: string) {
    const prefix = `${this.roomPeerKey(roomId, peerId)}:`;
    const queued = [...this.pendingPeerSignalsByRoomPeer.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .flatMap(([, entries]) => entries);
    if (queued.length === 0) {
      return true;
    }

    const now = Date.now();
    for (const key of [...this.pendingPeerSignalsByRoomPeer.keys()]) {
      if (key.startsWith(prefix)) {
        this.pendingPeerSignalsByRoomPeer.delete(key);
      }
    }
    queued.sort((left, right) =>
      (left.payload.sequence ?? Number.MAX_SAFE_INTEGER) -
      (right.payload.sequence ?? Number.MAX_SAFE_INTEGER)
    );
    for (let index = 0; index < queued.length; index += 1) {
      const entry = queued[index]!;
      if (entry.expiresAtMs <= now) {
        continue;
      }

      if (await this.deliverToLivePeer(roomId, peerId, entry.payload)) {
        continue;
      }

      for (const pending of queued.slice(index)) {
        if (pending.expiresAtMs > now) {
          this.queuePeerSignal(roomId, peerId, pending.payload, pending.expiresAtMs);
        }
      }
      return false;
    }
    return true;
  }

  clearPendingPeerSignals(roomId?: string, peerId?: string) {
    if (roomId && peerId) {
      const prefix = `${this.roomPeerKey(roomId, peerId)}:`;
      for (const key of [...this.pendingPeerSignalsByRoomPeer.keys()]) {
        if (key.startsWith(prefix)) {
          this.pendingPeerSignalsByRoomPeer.delete(key);
        }
      }
      return;
    }

    if (roomId) {
      for (const key of this.pendingPeerSignalsByRoomPeer.keys()) {
        if (key.startsWith(`${roomId}:`)) {
          this.pendingPeerSignalsByRoomPeer.delete(key);
        }
      }
    }
  }

  clearRoomState(roomId: string) {
    this.clearPendingPeerSignals(roomId);
    this.peerSocketsByRoom.delete(roomId);
    this.recoveryGenerationByRoomPeer.delete(roomId);
    for (const key of [...this.peerDeliveryOperations.keys()]) {
      if (key.startsWith(`${roomId}:`)) {
        this.peerDeliveryOperations.delete(key);
      }
    }
    for (const key of [...this.recoveryGenerationByRoomSession.keys()]) {
      if (key.startsWith(`${roomId}:`)) {
        this.recoveryGenerationByRoomSession.delete(key);
      }
    }
  }

  dispose() {
    this.peerSocketsByRoom.clear();
    this.pendingPeerSignalsByRoomPeer.clear();
    this.peerDeliveryOperations.clear();
    this.recoveryGenerationByRoomSession.clear();
    this.recoveryGenerationByRoomPeer.clear();
  }

  registerPeerSocket(roomId?: string, peerId?: string, socketId?: string) {
    if (!roomId || !peerId || !socketId) {
      return;
    }

    const roomPeers = this.peerSocketsByRoom.get(roomId) ?? new Map<string, Set<string>>();
    const peerSockets = roomPeers.get(peerId) ?? new Set<string>();
    peerSockets.add(socketId);
    roomPeers.set(peerId, peerSockets);
    this.peerSocketsByRoom.set(roomId, roomPeers);
    void this.flushPendingPeerSignals(roomId, peerId);
  }

  unregisterPeerSocket(roomId?: string, peerId?: string, socketId?: string) {
    if (!roomId || !peerId || !socketId) {
      return;
    }

    const roomPeers = this.peerSocketsByRoom.get(roomId);
    if (!roomPeers) {
      return;
    }

    const peerSockets = roomPeers.get(peerId);
    if (!peerSockets) {
      return;
    }

    peerSockets.delete(socketId);
    if (peerSockets.size === 0) {
      roomPeers.delete(peerId);
    }
    if (roomPeers.size === 0) {
      this.peerSocketsByRoom.delete(roomId);
    }
  }

  private nextRecoveryGeneration() {
    this.recoveryGenerationSequence += 1;
    return this.recoveryGenerationSequence;
  }

  private recoverySessionKey(roomId: string, sessionId: string) {
    return `${roomId}:${sessionId}`;
  }

  private roomPeerKey(roomId: string, peerId: string) {
    return `${roomId}:${peerId}`;
  }

  private getOrCreateRoomPeerRecoveryMap(roomId: string) {
    const current = this.recoveryGenerationByRoomPeer.get(roomId);
    if (current) {
      return current;
    }

    const next = new Map<string, number>();
    this.recoveryGenerationByRoomPeer.set(roomId, next);
    return next;
  }

  registerRecoveryGeneration(roomId: string, sessionId: string, peerId: string) {
    const nextGeneration = this.nextRecoveryGeneration();
    this.recoveryGenerationByRoomSession.set(this.recoverySessionKey(roomId, sessionId), nextGeneration);
    this.getOrCreateRoomPeerRecoveryMap(roomId).set(peerId, nextGeneration);
    return nextGeneration;
  }

  clearRecoveryGeneration(roomId?: string, sessionId?: string, peerId?: string) {
    if (roomId && sessionId) {
      this.recoveryGenerationByRoomSession.delete(this.recoverySessionKey(roomId, sessionId));
    }

    if (roomId && peerId) {
      const roomPeers = this.recoveryGenerationByRoomPeer.get(roomId);
      roomPeers?.delete(peerId);
      if (roomPeers && roomPeers.size === 0) {
        this.recoveryGenerationByRoomPeer.delete(roomId);
      }
    }
  }

  resolvePeerRecoveryGeneration(roomId: string, peerId: string) {
    return this.recoveryGenerationByRoomPeer.get(roomId)?.get(peerId);
  }
}
