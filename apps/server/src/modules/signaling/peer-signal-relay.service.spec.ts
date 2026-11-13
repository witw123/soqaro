import type { PeerSignalMessage } from "@soqaro/shared";
import { PeerSignalRelayService } from "./peer-signal-relay.service";
import { RoomSessionLeaseService } from "./room-session-lease.service";

function createHarness() {
  const emit = jest.fn();
  const to = jest.fn(() => ({ emit }));
  const getSocket = jest.fn();
  const server = { sockets: { sockets: { get: getSocket } }, to };
  const sessionLease = { socketOwnsLease: jest.fn() };
  const relay = new PeerSignalRelayService(sessionLease as unknown as RoomSessionLeaseService);
  relay.setServer(server as never);
  return { emit, to, getSocket, sessionLease, relay };
}

function signal(overrides: Partial<PeerSignalMessage> = {}) {
  return {
    roomId: "room-1",
    toPeerId: "peer-2",
    fromPeerId: "peer-1",
    linkKind: "data",
    ...overrides
  } as PeerSignalMessage;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("PeerSignalRelayService", () => {
  it("queues a signal for an offline peer and flushes it in sequence order", async () => {
    const { emit, getSocket, sessionLease, relay } = createHarness();
    await relay.emitToPeer("room-1", "peer-2", signal({ sequence: 5 }));
    await relay.emitToPeer("room-1", "peer-2", signal({ sequence: 3 }));
    expect(emit).not.toHaveBeenCalled();

    sessionLease.socketOwnsLease.mockResolvedValue(true);
    getSocket.mockReturnValue({ id: "socket-2" });
    relay.registerPeerSocket("room-1", "peer-2", "socket-2");
    await settle();

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0][1].sequence).toBe(3);
    expect(emit.mock.calls[1][1].sequence).toBe(5);
  });

  it("delivers immediately to a live peer socket and stamps the recovery generation", async () => {
    const { emit, to, getSocket, sessionLease, relay } = createHarness();
    const generation = relay.registerRecoveryGeneration("room-1", "session-2", "peer-2");
    sessionLease.socketOwnsLease.mockResolvedValue(true);
    getSocket.mockReturnValue({ id: "socket-2" });
    relay.registerPeerSocket("room-1", "peer-2", "socket-2");
    await settle();

    await relay.emitToPeer("room-1", "peer-2", signal({ sequence: 1 }));

    expect(to).toHaveBeenCalledWith("socket-2");
    expect(emit).toHaveBeenCalledWith("peer.signal", expect.objectContaining({
      sequence: 1,
      recoveryGeneration: generation
    }));
  });

  it("skips a peer socket that no longer owns the session lease", async () => {
    const { emit, getSocket, sessionLease, relay } = createHarness();
    sessionLease.socketOwnsLease.mockResolvedValue(false);
    getSocket.mockReturnValue({ id: "socket-2" });
    relay.registerPeerSocket("room-1", "peer-2", "socket-2");
    await settle();

    await relay.emitToPeer("room-1", "peer-2", signal({ sequence: 1 }));
    expect(emit).not.toHaveBeenCalled();
  });

  it("drops an expired queued signal and keeps only the fresh one", async () => {
    const { emit, getSocket, sessionLease, relay } = createHarness();
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    await relay.emitToPeer("room-1", "peer-2", signal({ sequence: 1 }));
    jest.setSystemTime(1_000_000 + 11_000);
    await relay.emitToPeer("room-1", "peer-2", signal({ sequence: 2 }));

    sessionLease.socketOwnsLease.mockResolvedValue(true);
    getSocket.mockReturnValue({ id: "socket-2" });
    relay.registerPeerSocket("room-1", "peer-2", "socket-2");
    await jest.advanceTimersByTimeAsync(0);
    jest.useRealTimers();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1].sequence).toBe(2);
  });

  it("caps a per-sender queue at the pending signal limit", async () => {
    const { emit, getSocket, sessionLease, relay } = createHarness();
    for (let i = 0; i < 40; i++) {
      await relay.emitToPeer("room-1", "peer-2", signal({ sequence: i }));
    }

    sessionLease.socketOwnsLease.mockResolvedValue(true);
    getSocket.mockReturnValue({ id: "socket-2" });
    relay.registerPeerSocket("room-1", "peer-2", "socket-2");
    await settle();

    expect(emit).toHaveBeenCalledTimes(32);
    expect(emit.mock.calls[0][1].sequence).toBe(8);
    expect(emit.mock.calls[31][1].sequence).toBe(39);
  });

  it("clears pending signals for a room and peer", async () => {
    const { emit, getSocket, sessionLease, relay } = createHarness();
    await relay.emitToPeer("room-1", "peer-2", signal({ sequence: 1 }));
    relay.clearPendingPeerSignals("room-1", "peer-2");

    sessionLease.socketOwnsLease.mockResolvedValue(true);
    getSocket.mockReturnValue({ id: "socket-2" });
    relay.registerPeerSocket("room-1", "peer-2", "socket-2");
    await settle();

    expect(emit).not.toHaveBeenCalled();
  });

  it("tracks an incrementing recovery generation per room session", () => {
    const { relay } = createHarness();
    const first = relay.registerRecoveryGeneration("room-1", "session-1", "peer-1");
    const second = relay.registerRecoveryGeneration("room-1", "session-2", "peer-2");
    expect(second).toBeGreaterThan(first);
    expect(relay.resolvePeerRecoveryGeneration("room-1", "peer-1")).toBe(first);

    relay.clearRecoveryGeneration("room-1", "session-1", "peer-1");
    expect(relay.resolvePeerRecoveryGeneration("room-1", "peer-1")).toBeUndefined();
  });

  it("clears all relay state for a room", async () => {
    const { emit, getSocket, sessionLease, relay } = createHarness();
    relay.registerRecoveryGeneration("room-1", "session-1", "peer-1");
    await relay.emitToPeer("room-1", "peer-2", signal({ sequence: 1 }));

    relay.clearRoomState("room-1");

    expect(relay.resolvePeerRecoveryGeneration("room-1", "peer-1")).toBeUndefined();
    // The peer socket registry is gone, so a new signal is queued, not emitted.
    sessionLease.socketOwnsLease.mockResolvedValue(true);
    getSocket.mockReturnValue({ id: "socket-2" });
    await relay.emitToPeer("room-1", "peer-2", signal({ sequence: 2 }));
    expect(emit).not.toHaveBeenCalled();
  });

  it("skips delivery when live socket metadata belongs to another room or peer", async () => {
    const { emit, getSocket, sessionLease, relay } = createHarness();
    sessionLease.socketOwnsLease.mockResolvedValue(true);
    getSocket.mockReturnValue({
      id: "socket-2",
      data: { roomId: "other-room", peerId: "peer-2" }
    });
    relay.registerPeerSocket("room-1", "peer-2", "socket-2");
    await settle();

    await relay.emitToPeer("room-1", "peer-2", signal({ sequence: 10 }));
    expect(emit).not.toHaveBeenCalled();

    getSocket.mockReturnValue({
      id: "socket-2",
      data: { roomId: "room-1", peerId: "other-peer" }
    });
    await relay.emitToPeer("room-1", "peer-2", signal({ sequence: 11 }));
    expect(emit).not.toHaveBeenCalled();
  });
});
