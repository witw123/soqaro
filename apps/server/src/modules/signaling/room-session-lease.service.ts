import { Injectable, Logger } from "@nestjs/common";
import { WsException } from "@nestjs/websockets";
import type { Socket } from "socket.io";
import { RedisService } from "../../infra/redis/redis.service";
import { RoomRealtimeBroadcaster } from "../realtime/room-realtime.broadcaster";

export type SessionLease = {
  instanceId?: string;
  roomId?: string;
  sessionId?: string;
  peerId?: string;
  socketId?: string;
  fenceToken?: string;
};

type SocketLeaseCheckResult = "owned" | "missing" | "replaced" | "unavailable";

type VerifiedSocketLease = {
  identity: string;
  expiresAtMs: number;
};

/**
 * Single-active-socket ownership of a room session, stored in Redis. The
 * lease lets a reconnecting client reclaim its session from a stale socket
 * that never fired a disconnect event, while a crashed client's lease can
 * still expire without an explicit disconnect.
 */
@Injectable()
export class RoomSessionLeaseService {
  private readonly logger = new Logger(RoomSessionLeaseService.name);
  private readonly roomLockTtlMs = 30_000;
  private readonly roomLockWaitMs = 3_000;
  // ICE candidate bursts can otherwise perform two Redis reads per signal
  // (sender and receiver). A short positive cache keeps fencing responsive
  // while collapsing hundreds of repeated checks during a ten-member join.
  private readonly socketLeaseVerificationTtlMs = 1_000;
  private readonly maxVerifiedSocketLeases = 2_048;
  private readonly verifiedSocketLeases = new Map<string, VerifiedSocketLease>();
  private readonly socketLeaseChecksInFlight = new Map<string, Promise<SocketLeaseCheckResult>>();
  readonly sessionLeaseTtlMs = 180_000;

  constructor(
    private readonly redisService: RedisService,
    private readonly roomRealtimeBroadcaster: RoomRealtimeBroadcaster
  ) {}

  key(roomId: string, sessionId: string) {
    return `soqaro:realtime-session:${roomId}:${sessionId}`;
  }

  async claim(
    roomId: string,
    sessionId: string,
    peerId: string,
    socketId: string,
    fenceToken: string
  ) {
    return this.withRoomLock(roomId, async () => {
      try {
        const previous = await this.redisService.claimJsonLease(
          this.key(roomId, sessionId),
          {
            instanceId: this.roomRealtimeBroadcaster.instanceId,
            roomId,
            sessionId,
            peerId,
            socketId,
            fenceToken
          },
          this.sessionLeaseTtlMs
        );
        this.rememberSocketLease(roomId, sessionId, socketId, fenceToken);
        if (
          previous &&
          typeof previous === "object" &&
          typeof (previous as SessionLease).socketId === "string" &&
          (previous as SessionLease).socketId !== socketId
        ) {
          this.invalidateSocket((previous as SessionLease).socketId);
        }
        if (!previous || typeof previous !== "object") {
          return null;
        }
        return previous as SessionLease;
      } catch (error) {
        if (isStrictRealtimeCoordination()) {
          throw error;
        }
        // Local signaling remains available in development when Redis is down.
        return null;
      }
    });
  }

  async assert(client: Socket) {
    const result = await this.checkSocketLease(client);
    if (result === "replaced") {
      throw new WsException("Realtime session was replaced.");
    }
    if (result === "missing") {
      throw new WsException("Realtime session lease is missing.");
    }
    if (result === "unavailable") {
      throw new WsException("Realtime session coordination is unavailable.");
    }
  }

  async renew(client: Socket) {
    const roomId = client.data.roomId as string;
    const sessionId = client.data.sessionId as string;
    const peerId = client.data.peerId as string;
    const fenceToken = client.data.sessionFenceToken as string;
    try {
      const renewed = await this.redisService.renewJsonLeaseIfValue(
        this.key(roomId, sessionId),
        {
          instanceId: this.roomRealtimeBroadcaster.instanceId,
          roomId,
          sessionId,
          peerId,
          socketId: client.id,
          fenceToken
        },
        this.sessionLeaseTtlMs
      );
      if (renewed) {
        this.rememberSocketLease(roomId, sessionId, client.id, fenceToken);
      } else {
        this.invalidateSocket(client.id);
      }
      return renewed;
    } catch {
      this.invalidateSocket(client.id);
      return !isStrictRealtimeCoordination();
    }
  }

  async release(client: Socket) {
    const roomId = client.data.roomId as string | undefined;
    const sessionId = client.data.sessionId as string | undefined;
    const fenceToken = client.data.sessionFenceToken as string | undefined;
    if (!roomId || !sessionId || !fenceToken) {
      return;
    }
    this.invalidateSocket(client.id);
    try {
      await this.redisService.deleteJsonIfValue(this.key(roomId, sessionId), {
        instanceId: this.roomRealtimeBroadcaster.instanceId,
        roomId,
        sessionId,
        peerId: client.data.peerId as string,
        socketId: client.id,
        fenceToken
      });
    } catch {
      // Lease expiry is the fallback cleanup path.
    }
  }

  async belongsTo(
    roomId: string,
    sessionId: string,
    expected?: { peerId?: string; socketId?: string; fenceToken?: string }
  ) {
    try {
      const lease = await this.redisService.getJson<{
        peerId?: string;
        socketId?: string;
        fenceToken?: string;
      }>(this.key(roomId, sessionId));
      if (!lease) {
        return !isStrictRealtimeCoordination();
      }
      return (
        ((!expected?.peerId || lease.peerId === expected.peerId) &&
          (!expected?.socketId || lease.socketId === expected.socketId) &&
          (!expected?.fenceToken || lease.fenceToken === expected.fenceToken))
      );
    } catch {
      return !isStrictRealtimeCoordination();
    }
  }

  async delete(
    roomId: string,
    sessionId: string,
    expected?: { peerId?: string; socketId?: string; fenceToken?: string }
  ) {
    if (!expected?.peerId || !expected.socketId || !expected.fenceToken) {
      return false;
    }

    this.invalidateSocket(expected.socketId);

    try {
      // The old socket may be racing a replacement. Compare and delete in one
      // Redis operation so a lease claimed after this cleanup starts cannot
      // be removed by the stale disconnect timer.
      return await this.redisService.deleteJsonIfValue(this.key(roomId, sessionId), {
        instanceId: this.roomRealtimeBroadcaster.instanceId,
        roomId,
        sessionId,
        peerId: expected.peerId,
        socketId: expected.socketId,
        fenceToken: expected.fenceToken
      });
    } catch {
      // Ignore lease cleanup failures; the TTL limits stale ownership.
      return false;
    }
  }

  async rollback(
    roomId: string,
    sessionId: string,
    previousLease: SessionLease | null,
    currentClaim: { peerId?: string; socketId: string; fenceToken: string }
  ) {
    if (!previousLease) {
      return this.delete(roomId, sessionId, currentClaim);
    }

    this.invalidateSocket(currentClaim.socketId);

    return this.withRoomLock(roomId, async () => {
      try {
        const restored = await this.redisService.restoreJsonLeaseIfValue(
          this.key(roomId, sessionId),
          {
            instanceId: this.roomRealtimeBroadcaster.instanceId,
            roomId,
            sessionId,
            peerId: currentClaim.peerId ?? previousLease.peerId,
            socketId: currentClaim.socketId,
            fenceToken: currentClaim.fenceToken
          },
          previousLease,
          this.sessionLeaseTtlMs
        );
        if (restored) {
          if (previousLease.socketId && previousLease.fenceToken) {
            this.rememberSocketLease(
              roomId,
              sessionId,
              previousLease.socketId,
              previousLease.fenceToken
            );
          }
        }
        return restored;
      } catch (error) {
        this.logger.warn(`Failed to rollback session lease: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    });
  }

  async socketOwnsLease(socket: Socket) {
    return (await this.checkSocketLease(socket)) === "owned";
  }

  invalidateSocket(socketId?: string) {
    if (!socketId) {
      return;
    }
    this.verifiedSocketLeases.delete(socketId);
    for (const key of this.socketLeaseChecksInFlight.keys()) {
      if (key.startsWith(`${socketId}:`)) {
        this.socketLeaseChecksInFlight.delete(key);
      }
    }
  }

  async checkSocketLease(socket: Socket): Promise<SocketLeaseCheckResult> {
    const roomId = socket.data.roomId as string | undefined;
    const sessionId = socket.data.sessionId as string | undefined;
    const fenceToken = socket.data.sessionFenceToken as string | undefined;
    if (!roomId || !sessionId || !fenceToken) {
      return "owned";
    }

    const identity = this.socketLeaseIdentity(roomId, sessionId, socket.id, fenceToken);
    const cached = this.verifiedSocketLeases.get(socket.id);
    if (cached?.identity === identity && cached.expiresAtMs > Date.now()) {
      return "owned";
    }
    if (cached) {
      this.verifiedSocketLeases.delete(socket.id);
    }

    const inFlightKey = `${socket.id}:${identity}`;
    const currentCheck = this.socketLeaseChecksInFlight.get(inFlightKey);
    if (currentCheck) {
      return currentCheck;
    }

    const check = (async (): Promise<SocketLeaseCheckResult> => {
      try {
        const lease = await this.redisService.getJson<{
          socketId?: string;
          fenceToken?: string;
        }>(this.key(roomId, sessionId));
        if (!lease) {
          return isStrictRealtimeCoordination() ? "missing" : "owned";
        }
        if (lease.socketId !== socket.id || lease.fenceToken !== fenceToken) {
          return "replaced";
        }
        return "owned";
      } catch {
        return isStrictRealtimeCoordination() ? "unavailable" : "owned";
      }
    })();
    this.socketLeaseChecksInFlight.set(inFlightKey, check);
    try {
      const result = await check;
      if (
        result === "owned" &&
        this.socketLeaseChecksInFlight.get(inFlightKey) === check &&
        socket.data.roomId === roomId &&
        socket.data.sessionId === sessionId &&
        socket.data.sessionFenceToken === fenceToken
      ) {
        this.rememberSocketLease(roomId, sessionId, socket.id, fenceToken);
      }
      return result;
    } finally {
      if (this.socketLeaseChecksInFlight.get(inFlightKey) === check) {
        this.socketLeaseChecksInFlight.delete(inFlightKey);
      }
    }
  }

  private rememberSocketLease(
    roomId: string,
    sessionId: string,
    socketId: string,
    fenceToken: string
  ) {
    const now = Date.now();
    if (this.verifiedSocketLeases.size >= this.maxVerifiedSocketLeases) {
      for (const [cachedSocketId, cachedLease] of this.verifiedSocketLeases) {
        if (cachedLease.expiresAtMs <= now) {
          this.verifiedSocketLeases.delete(cachedSocketId);
        }
      }
      if (this.verifiedSocketLeases.size >= this.maxVerifiedSocketLeases) {
        const oldestSocketId = this.verifiedSocketLeases.keys().next().value;
        if (typeof oldestSocketId === "string") {
          this.verifiedSocketLeases.delete(oldestSocketId);
        }
      }
    }
    this.verifiedSocketLeases.set(socketId, {
      identity: this.socketLeaseIdentity(roomId, sessionId, socketId, fenceToken),
      expiresAtMs: now + this.socketLeaseVerificationTtlMs
    });
  }

  private socketLeaseIdentity(
    roomId: string,
    sessionId: string,
    socketId: string,
    fenceToken: string
  ) {
    return `${roomId}:${sessionId}:${socketId}:${fenceToken}`;
  }

  private async withRoomLock<T>(roomId: string, operation: () => Promise<T>) {
    const redis = this.redisService as RedisService & {
      acquireLock?: (key: string, ttlMs: number) => Promise<string | null>;
      releaseLock?: (key: string, token: string) => Promise<boolean>;
      isAvailable?: () => boolean;
    };
    if (
      typeof redis.acquireLock !== "function" ||
      typeof redis.releaseLock !== "function" ||
      typeof redis.isAvailable !== "function"
    ) {
      if (isStrictRealtimeCoordination()) {
        throw new WsException("Realtime session coordination is unavailable.");
      }
      return operation();
    }
    if (!redis.isAvailable()) {
      if (isStrictRealtimeCoordination()) {
        throw new WsException("Realtime session coordination is unavailable.");
      }
      return operation();
    }

    const lockKey = `soqaro:lock:room:${roomId}`;
    const deadline = Date.now() + this.roomLockWaitMs;
    let token: string | null = null;
    while (!token && Date.now() < deadline) {
      token = await redis.acquireLock(lockKey, this.roomLockTtlMs);
      if (!token) {
        await delay(20);
      }
    }
    if (!token) {
      throw new WsException("Realtime session coordination is busy.");
    }

    try {
      return await operation();
    } finally {
      await redis.releaseLock(lockKey, token).catch((error) => {
        this.logger.warn(`Unable to release session lease lock ${roomId}: ${String(error)}`);
      });
    }
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isStrictRealtimeCoordination() {
  return process.env.NODE_ENV === "production";
}
