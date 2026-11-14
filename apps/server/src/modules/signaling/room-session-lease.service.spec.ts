import { WsException } from "@nestjs/websockets";
import { RoomSessionLeaseService } from "./room-session-lease.service";

function createRedis() {
  return {
    claimJsonLease: jest.fn(),
    getJson: jest.fn(),
    renewJsonLeaseIfValue: jest.fn(),
    deleteJsonIfValue: jest.fn(),
    restoreJsonLeaseIfValue: jest.fn()
  };
}

function createBroadcaster() {
  return { instanceId: "instance-a" };
}

function createSocket(
  data: Record<string, unknown>,
  id = "socket-1"
) {
  return { id, data } as never;
}

describe("RoomSessionLeaseService", () => {
  it("claims a lease and returns the previous owner", async () => {
    const redis = createRedis();
    redis.claimJsonLease.mockResolvedValue({ socketId: "socket-0", fenceToken: "old" });
    const lease = new RoomSessionLeaseService(redis as never, createBroadcaster() as never);

    const previous = await lease.claim("room-1", "session-1", "peer-1", "socket-1", "fence-1");

    expect(previous).toEqual({ socketId: "socket-0", fenceToken: "old" });
    expect(redis.claimJsonLease).toHaveBeenCalledWith(
      "soqaro:realtime-session:room-1:session-1",
      {
        instanceId: "instance-a",
        roomId: "room-1",
        sessionId: "session-1",
        peerId: "peer-1",
        socketId: "socket-1",
        fenceToken: "fence-1"
      },
      lease.sessionLeaseTtlMs
    );
  });

  it("coordinates lease claims with the room state lock when Redis is available", async () => {
    const redis = createRedis() as ReturnType<typeof createRedis> & {
      acquireLock: jest.Mock;
      releaseLock: jest.Mock;
      isAvailable: jest.Mock;
    };
    redis.isAvailable = jest.fn(() => true);
    redis.acquireLock = jest.fn().mockResolvedValue("lock-token");
    redis.releaseLock = jest.fn().mockResolvedValue(true);
    redis.claimJsonLease.mockResolvedValue(null);
    const lease = new RoomSessionLeaseService(redis as never, createBroadcaster() as never);

    await expect(lease.claim("room-1", "session-1", "peer-1", "socket-1", "fence-1"))
      .resolves.toBeNull();

    expect(redis.acquireLock).toHaveBeenCalledWith("soqaro:lock:room:room-1", 30_000);
    expect(redis.releaseLock).toHaveBeenCalledWith("soqaro:lock:room:room-1", "lock-token");
  });

  it("returns null when Redis is unavailable during claim", async () => {
    const redis = createRedis();
    redis.claimJsonLease.mockRejectedValue(new Error("down"));
    const lease = new RoomSessionLeaseService(redis as never, createBroadcaster() as never);

    await expect(lease.claim("room-1", "session-1", "peer-1", "socket-1", "fence-1")).resolves.toBeNull();
  });

  it("accepts a socket that owns the current lease", async () => {
    const redis = createRedis();
    redis.getJson.mockResolvedValue({ socketId: "socket-1", fenceToken: "fence-1" });
    const lease = new RoomSessionLeaseService(redis as never, createBroadcaster() as never);

    await expect(lease.assert(createSocket({
      roomId: "room-1",
      sessionId: "session-1",
      sessionFenceToken: "fence-1"
    }))).resolves.toBeUndefined();
  });

  it("coalesces and briefly caches repeated ownership checks for one socket", async () => {
    const redis = createRedis();
    let resolveLease!: (value: { socketId: string; fenceToken: string }) => void;
    redis.getJson.mockImplementation(() => new Promise((resolve) => {
      resolveLease = resolve;
    }));
    const lease = new RoomSessionLeaseService(redis as never, createBroadcaster() as never);
    const socket = createSocket({
      roomId: "room-1",
      sessionId: "session-1",
      sessionFenceToken: "fence-1"
    });

    const first = lease.assert(socket);
    const second = lease.socketOwnsLease(socket);
    expect(redis.getJson).toHaveBeenCalledTimes(1);
    resolveLease({ socketId: "socket-1", fenceToken: "fence-1" });

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, true]);
    await expect(lease.socketOwnsLease(socket)).resolves.toBe(true);
    expect(redis.getJson).toHaveBeenCalledTimes(1);
  });

  it("does not restore a cached ownership result after the socket is invalidated", async () => {
    const redis = createRedis();
    let resolveLease!: (value: { socketId: string; fenceToken: string }) => void;
    redis.getJson
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveLease = resolve;
      }))
      .mockResolvedValueOnce({ socketId: "socket-2", fenceToken: "fence-2" });
    const lease = new RoomSessionLeaseService(redis as never, createBroadcaster() as never);
    const socket = createSocket({
      roomId: "room-1",
      sessionId: "session-1",
      sessionFenceToken: "fence-1"
    });

    const staleCheck = lease.socketOwnsLease(socket);
    lease.invalidateSocket("socket-1");
    resolveLease({ socketId: "socket-1", fenceToken: "fence-1" });
    await expect(staleCheck).resolves.toBe(true);

    await expect(lease.socketOwnsLease(socket)).resolves.toBe(false);
    expect(redis.getJson).toHaveBeenCalledTimes(2);
  });

  it("rejects a socket whose lease was replaced", async () => {
    const redis = createRedis();
    redis.getJson.mockResolvedValue({ socketId: "socket-2", fenceToken: "fence-2" });
    const lease = new RoomSessionLeaseService(redis as never, createBroadcaster() as never);

    await expect(lease.assert(createSocket({
      roomId: "room-1",
      sessionId: "session-1",
      sessionFenceToken: "fence-1"
    }))).rejects.toBeInstanceOf(WsException);
  });

  it("does not fail an assert when Redis is temporarily down", async () => {
    const redis = createRedis();
    redis.getJson.mockRejectedValue(new Error("down"));
    const lease = new RoomSessionLeaseService(redis as never, createBroadcaster() as never);

    await expect(lease.assert(createSocket({
      roomId: "room-1",
      sessionId: "session-1",
      sessionFenceToken: "fence-1"
    }))).resolves.toBeUndefined();
  });

  it("renews the lease with the broadcasting instance identity", async () => {
    const redis = createRedis();
    redis.renewJsonLeaseIfValue.mockResolvedValue(true);
    const lease = new RoomSessionLeaseService(redis as never, createBroadcaster() as never);

    await expect(lease.renew(createSocket({
      roomId: "room-1",
      sessionId: "session-1",
      peerId: "peer-1",
      sessionFenceToken: "fence-1"
    }))).resolves.toBe(true);
    expect(redis.renewJsonLeaseIfValue).toHaveBeenCalledWith(
      "soqaro:realtime-session:room-1:session-1",
      {
        instanceId: "instance-a",
        roomId: "room-1",
        sessionId: "session-1",
        peerId: "peer-1",
        socketId: "socket-1",
        fenceToken: "fence-1"
      },
      lease.sessionLeaseTtlMs
    );
  });

  it("treats a Redis outage as a successful renew", async () => {
    const redis = createRedis();
    redis.renewJsonLeaseIfValue.mockRejectedValue(new Error("down"));
    const lease = new RoomSessionLeaseService(redis as never, createBroadcaster() as never);

    await expect(lease.renew(createSocket({
      roomId: "room-1",
      sessionId: "session-1",
      peerId: "peer-1",
      sessionFenceToken: "fence-1"
    }))).resolves.toBe(true);
  });

  it("releases the lease only when the socket carries a fence token", async () => {
    const redis = createRedis();
    redis.deleteJsonIfValue.mockResolvedValue(true);
    const lease = new RoomSessionLeaseService(redis as never, createBroadcaster() as never);

    await lease.release(createSocket({}));
    expect(redis.deleteJsonIfValue).not.toHaveBeenCalled();

    await lease.release(createSocket({
      roomId: "room-1",
      sessionId: "session-1",
      peerId: "peer-1",
      sessionFenceToken: "fence-1"
    }));
    expect(redis.deleteJsonIfValue).toHaveBeenCalledWith(
      "soqaro:realtime-session:room-1:session-1",
      {
        instanceId: "instance-a",
        roomId: "room-1",
        sessionId: "session-1",
        peerId: "peer-1",
        socketId: "socket-1",
        fenceToken: "fence-1"
      }
    );
  });

  it("tells whether a lease belongs to the expected socket", async () => {
    const redis = createRedis();
    redis.getJson.mockResolvedValue({ socketId: "socket-1", fenceToken: "fence-1" });
    const lease = new RoomSessionLeaseService(redis as never, createBroadcaster() as never);

    await expect(lease.belongsTo("room-1", "session-1", { socketId: "socket-1" })).resolves.toBe(true);
    await expect(lease.belongsTo("room-1", "session-1", { socketId: "socket-2" })).resolves.toBe(false);
  });

  it("returns true when no lease exists", async () => {
    const redis = createRedis();
    redis.getJson.mockResolvedValue(null);
    const lease = new RoomSessionLeaseService(redis as never, createBroadcaster() as never);

    await expect(lease.belongsTo("room-1", "session-1", { socketId: "socket-1" })).resolves.toBe(true);
    await expect(lease.socketOwnsLease(createSocket({
      roomId: "room-1",
      sessionId: "session-1",
      sessionFenceToken: "fence-1"
    }))).resolves.toBe(true);
  });

  it("deletes the lease only with a complete expected identity", async () => {
    const redis = createRedis();
    redis.deleteJsonIfValue.mockResolvedValue(true);
    const lease = new RoomSessionLeaseService(redis as never, createBroadcaster() as never);

    await expect(lease.delete("room-1", "session-1", { peerId: "peer-1" })).resolves.toBe(false);
    await expect(lease.delete("room-1", "session-1", {
      peerId: "peer-1",
      socketId: "socket-1",
      fenceToken: "fence-1"
    })).resolves.toBe(true);
  });

  it("rolls back the lease to previous owner when previousLease exists", async () => {
    const redis = createRedis();
    redis.restoreJsonLeaseIfValue.mockResolvedValue(true);
    const lease = new RoomSessionLeaseService(redis as never, createBroadcaster() as never);

    const previousLease = {
      instanceId: "instance-a",
      roomId: "room-1",
      sessionId: "session-1",
      peerId: "peer-0",
      socketId: "socket-0",
      fenceToken: "fence-0"
    };

    const currentClaim = {
      peerId: "peer-1",
      socketId: "socket-1",
      fenceToken: "fence-1"
    };

    await expect(
      lease.rollback("room-1", "session-1", previousLease, currentClaim)
    ).resolves.toBe(true);

    expect(redis.restoreJsonLeaseIfValue).toHaveBeenCalledWith(
      "soqaro:realtime-session:room-1:session-1",
      {
        instanceId: "instance-a",
        roomId: "room-1",
        sessionId: "session-1",
        peerId: "peer-1",
        socketId: "socket-1",
        fenceToken: "fence-1"
      },
      previousLease,
      lease.sessionLeaseTtlMs
    );
  });

  it("deletes the lease on rollback if there was no previous lease", async () => {
    const redis = createRedis();
    redis.deleteJsonIfValue.mockResolvedValue(true);
    const lease = new RoomSessionLeaseService(redis as never, createBroadcaster() as never);

    const currentClaim = {
      peerId: "peer-1",
      socketId: "socket-1",
      fenceToken: "fence-1"
    };

    await expect(
      lease.rollback("room-1", "session-1", null, currentClaim)
    ).resolves.toBe(true);

    expect(redis.deleteJsonIfValue).toHaveBeenCalledWith(
      "soqaro:realtime-session:room-1:session-1",
      {
        instanceId: "instance-a",
        roomId: "room-1",
        sessionId: "session-1",
        peerId: "peer-1",
        socketId: "socket-1",
        fenceToken: "fence-1"
      }
    );
  });

  it("distinguishes missing and replaced leases when renewSocketLease fails", async () => {
    const redis = createRedis();
    redis.renewJsonLeaseIfValue.mockResolvedValue(false);
    const lease = new RoomSessionLeaseService(redis as never, createBroadcaster() as never);
    const socket = createSocket({
      roomId: "room-1",
      sessionId: "session-1",
      peerId: "peer-1",
      sessionFenceToken: "fence-1"
    });

    redis.getJson.mockResolvedValueOnce(null);
    await expect(lease.renewSocketLease(socket)).resolves.toBe("missing");

    redis.getJson.mockResolvedValueOnce({
      socketId: "socket-2",
      fenceToken: "fence-2"
    });
    await expect(lease.renewSocketLease(socket)).resolves.toBe("replaced");
  });
});
