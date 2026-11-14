import { RoomSessionRegistryService } from "./room-session-registry.service";
import { SignalingGateway } from "./signaling.gateway";

type TestClient = {
  id: string;
  data: Record<string, unknown>;
  leave: jest.Mock;
};

type GatewayWithCleanup = {
  cleanupFailedRoomSubscribe: (
    client: TestClient,
    roomId: string,
    sessionId: string,
    peerId: string,
    previousLease?: unknown
  ) => Promise<void>;
};

describe("SignalingGateway subscription cleanup", () => {
  it("cleans every local and persisted presence artifact after a failed subscribe", async () => {
    const registry = {
      isActiveSessionSocket: jest.fn().mockReturnValue(true),
      cancelPendingDisconnectCleanup: jest.fn(),
      unregisterSessionSocket: jest.fn(),
      updatePeerPresence: jest.fn().mockResolvedValue(true)
    };
    const sessionLease = {
      belongsTo: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(undefined),
      invalidateSocket: jest.fn()
    };
    const peerSignals = {
      unregisterPeerSocket: jest.fn(),
      clearPendingPeerSignals: jest.fn(),
      clearRecoveryGeneration: jest.fn()
    };
    const readiness = { clearForSession: jest.fn() };
    const metrics = { unbindRealtimeSocket: jest.fn() };
    const client: TestClient = {
      id: "socket-1",
      data: {
        roomId: "room-1",
        sessionId: "session-1",
        peerId: "peer-1",
        sessionFenceToken: "fence-1",
        isRealtimeAuthenticated: true
      },
      leave: jest.fn()
    };
    const gateway = Object.assign(Object.create(SignalingGateway.prototype), {
      registry,
      sessionLease,
      peerSignals,
      readiness,
      metrics
    }) as GatewayWithCleanup;

    await gateway.cleanupFailedRoomSubscribe(client, "room-1", "session-1", "peer-1");

    expect(registry.updatePeerPresence).toHaveBeenCalledWith(
      "room-1",
      "session-1",
      null,
      "offline"
    );
    expect(sessionLease.release).toHaveBeenCalledWith(client);
    expect(readiness.clearForSession).toHaveBeenCalledWith(
      "room-1",
      "session-1",
      "peer-1"
    );
    expect(client.leave).toHaveBeenCalledWith("room-1");
    expect(client.data.isRealtimeAuthenticated).toBe(false);
    expect(client.data.roomId).toBeUndefined();
  });

  it("does not mark a replaced socket offline during failed subscribe cleanup", async () => {
    const registry = {
      isActiveSessionSocket: jest.fn().mockReturnValue(false),
      cancelPendingDisconnectCleanup: jest.fn(),
      unregisterSessionSocket: jest.fn(),
      updatePeerPresence: jest.fn().mockResolvedValue(true)
    };
    const client: TestClient = {
      id: "socket-old",
      data: {
        roomId: "room-1",
        sessionId: "session-1",
        peerId: "peer-1",
        sessionFenceToken: "old-fence"
      },
      leave: jest.fn()
    };
    const gateway = Object.assign(Object.create(SignalingGateway.prototype), {
      registry,
      sessionLease: {
        belongsTo: jest.fn().mockResolvedValue(false),
        release: jest.fn().mockResolvedValue(undefined),
        invalidateSocket: jest.fn()
      },
      peerSignals: {
        unregisterPeerSocket: jest.fn(),
        clearPendingPeerSignals: jest.fn(),
        clearRecoveryGeneration: jest.fn()
      },
      readiness: { clearForSession: jest.fn() },
      metrics: { unbindRealtimeSocket: jest.fn() }
    }) as GatewayWithCleanup;

    await gateway.cleanupFailedRoomSubscribe(client, "room-1", "session-1", "peer-1");

    expect(registry.updatePeerPresence).not.toHaveBeenCalled();
  });

  it("rolls back lease to previousLease and does not mark presence offline when previousLease belongs to another socket", async () => {
    const registry = {
      isActiveSessionSocket: jest.fn().mockReturnValue(true),
      cancelPendingDisconnectCleanup: jest.fn(),
      unregisterSessionSocket: jest.fn(),
      updatePeerPresence: jest.fn().mockResolvedValue(true)
    };
    const sessionLease = {
      belongsTo: jest.fn().mockResolvedValue(true),
      rollback: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(undefined),
      invalidateSocket: jest.fn()
    };
    const peerSignals = {
      unregisterPeerSocket: jest.fn(),
      clearPendingPeerSignals: jest.fn(),
      clearRecoveryGeneration: jest.fn()
    };
    const readiness = { clearForSession: jest.fn() };
    const metrics = { unbindRealtimeSocket: jest.fn() };
    const client: TestClient = {
      id: "socket-new",
      data: {
        roomId: "room-1",
        sessionId: "session-1",
        peerId: "peer-new",
        sessionFenceToken: "fence-new",
        isRealtimeAuthenticated: true
      },
      leave: jest.fn()
    };
    const gateway = Object.assign(Object.create(SignalingGateway.prototype), {
      registry,
      sessionLease,
      peerSignals,
      readiness,
      metrics
    }) as GatewayWithCleanup;

    const previousLease = {
      socketId: "socket-old",
      fenceToken: "fence-old",
      peerId: "peer-old"
    };

    await gateway.cleanupFailedRoomSubscribe(client, "room-1", "session-1", "peer-new", previousLease);

    expect(sessionLease.rollback).toHaveBeenCalledWith(
      "room-1",
      "session-1",
      previousLease,
      {
        peerId: "peer-new",
        socketId: "socket-new",
        fenceToken: "fence-new"
      }
    );
    expect(registry.updatePeerPresence).not.toHaveBeenCalled();
    expect(client.leave).toHaveBeenCalledWith("room-1");
  });
});

describe("SignalingGateway chat", () => {
  it("persists a canonical message and broadcasts it to every room client", async () => {
    const emit = jest.fn();
    const message = {
      id: "chat_1",
      roomId: "room_1",
      senderId: "user_1",
      senderName: "Alice",
      content: "hello",
      timestamp: 1
    };
    const roomChatService = { append: jest.fn().mockResolvedValue(message) };
    const server = { to: jest.fn().mockReturnValue({ emit }) };
    const gateway = Object.assign(Object.create(SignalingGateway.prototype), {
      assertRealtimeRateLimit: jest.fn(),
      assertRealtimeClient: jest.fn(),
      sessionLease: { assert: jest.fn().mockResolvedValue(undefined) },
      authService: { getUserOrThrow: jest.fn().mockResolvedValue({ id: "user_1", nickname: "Alice" }) },
      roomChatService,
      server
    }) as {
      handleRoomChat: (client: { data: Record<string, unknown> }, payload: unknown) => Promise<unknown>;
    };

    await expect(gateway.handleRoomChat({ data: { sessionId: "user_1" } }, {
      roomId: "room_1",
      content: "hello"
    })).resolves.toEqual(message);

    expect(roomChatService.append).toHaveBeenCalledWith({
      roomId: "room_1",
      sessionId: "user_1",
      senderName: "Alice",
      content: "hello"
    });
    expect(server.to).toHaveBeenCalledWith("room_1");
    expect(emit).toHaveBeenCalledWith("room.chat", message);
  });

  describe("SignalingGateway reaction", () => {
    it("sanitizes trackId and broadcasts reaction", async () => {
      const emit = jest.fn();
      const server = { to: jest.fn().mockReturnValue({ emit }) };
      const roomService = {
        getRoomSnapshot: jest.fn(),
    getRoomCurrentTrackId: jest.fn().mockResolvedValue("track_current"),
        recordRoomReaction: jest.fn().mockResolvedValue(5)
      };
      const gateway = Object.assign(Object.create(SignalingGateway.prototype), {
        assertRealtimeRateLimit: jest.fn(),
        assertRealtimeClient: jest.fn(),
        sessionLease: { assert: jest.fn().mockResolvedValue(undefined) },
        authService: { getUserOrThrow: jest.fn().mockResolvedValue({ id: "user_1", nickname: "Alice" }) },
        roomService,
        server
      }) as {
        handleRoomReaction: (client: { data: Record<string, unknown> }, payload: unknown) => Promise<unknown>;
      };

      const result = await gateway.handleRoomReaction({ data: { sessionId: "user_1" } }, {
        roomId: "room_1",
        reaction: "like",
        trackId: "   "
      });

      expect(roomService.recordRoomReaction).toHaveBeenCalledWith({
        roomId: "room_1",
        userId: "user_1",
        trackId: "track_current",
        reactionType: "like"
      });
      expect(result).toMatchObject({
        roomId: "room_1",
        senderId: "user_1",
        reaction: "like",
        trackId: "track_current",
        totalCount: 5
      });
      expect(emit).toHaveBeenCalledWith("room.reaction", expect.objectContaining({
        trackId: "track_current",
        totalCount: 5
      }));
    });

    it("converts recording error to WsException", async () => {
      const server = { to: jest.fn().mockReturnValue({ emit: jest.fn() }) };
      const roomService = {
        getRoomSnapshot: jest.fn(),
    getRoomCurrentTrackId: jest.fn().mockResolvedValue(null),
        recordRoomReaction: jest.fn().mockRejectedValue(new Error("曲目不属于该房间。"))
      };
      const gateway = Object.assign(Object.create(SignalingGateway.prototype), {
        assertRealtimeRateLimit: jest.fn(),
        assertRealtimeClient: jest.fn(),
        sessionLease: { assert: jest.fn().mockResolvedValue(undefined) },
        authService: { getUserOrThrow: jest.fn().mockResolvedValue({ id: "user_1", nickname: "Alice" }) },
        roomService,
        server
      }) as {
        handleRoomReaction: (client: { data: Record<string, unknown> }, payload: unknown) => Promise<unknown>;
      };

      await expect(gateway.handleRoomReaction({ data: { sessionId: "user_1" } }, {
        roomId: "room_1",
        reaction: "fire",
        trackId: "track_invalid"
      })).rejects.toThrow("曲目不属于该房间。");
    });
  });

  describe("SignalingGateway room.presence", () => {
    it("returns lease-missing when the session lease expired so the client can resubscribe", async () => {
      const gateway = Object.assign(Object.create(SignalingGateway.prototype), {
        ensureBroadcasterServer: jest.fn(),
        assertRealtimeClient: jest.fn(),
        assertUserStillActive: jest.fn().mockResolvedValue(undefined),
        sessionLease: {
          checkSocketLease: jest.fn().mockResolvedValue("missing")
        }
      }) as {
        handleRoomPresence: (
          client: { data: Record<string, unknown> },
          payload: unknown
        ) => Promise<{ ok: boolean; reason?: string }>;
      };

      const result = await gateway.handleRoomPresence(
        {
          data: {
            isRealtimeAuthenticated: true,
            roomId: "room_1",
            sessionId: "user_1",
            peerId: "peer_1"
          }
        },
        {
          roomId: "room_1",
          sessionId: "user_1",
          peerId: "peer_1"
        }
      );

      expect(result).toEqual({ ok: false, reason: "lease-missing" });
    });

    it("returns not-subscribed for handshake-authenticated sockets whose room state was cleared or mismatched", async () => {
      const gateway = Object.assign(Object.create(SignalingGateway.prototype), {
        ensureBroadcasterServer: jest.fn(),
        assertRealtimeClient: jest.fn(() => {
          throw new Error("should not reach assertRealtimeClient");
        })
      }) as {
        handleRoomPresence: (
          client: { data: Record<string, unknown> },
          payload: unknown
        ) => Promise<{ ok: boolean; reason?: string }>;
      };

      const clearedSocketResult = await gateway.handleRoomPresence(
        {
          data: {
            handshakeAuthenticated: true,
            isRealtimeAuthenticated: false,
            roomId: undefined,
            sessionId: undefined,
            peerId: undefined
          }
        },
        {
          roomId: "room_1",
          sessionId: "user_1",
          peerId: "peer_1"
        }
      );
      expect(clearedSocketResult).toEqual({ ok: false, reason: "not-subscribed" });

      const otherRoomResult = await gateway.handleRoomPresence(
        {
          data: {
            handshakeAuthenticated: true,
            isRealtimeAuthenticated: true,
            roomId: "room_other",
            sessionId: "user_1",
            peerId: "peer_1"
          }
        },
        {
          roomId: "room_1",
          sessionId: "user_1",
          peerId: "peer_1"
        }
      );
      expect(otherRoomResult).toEqual({ ok: false, reason: "not-subscribed" });
    });

    it("returns lease-missing when checkSocketLease hits cache but renewSocketLease detects an expired lease", async () => {
      const gateway = Object.assign(Object.create(SignalingGateway.prototype), {
        ensureBroadcasterServer: jest.fn(),
        assertRealtimeClient: jest.fn(),
        assertUserStillActive: jest.fn().mockResolvedValue(undefined),
        sessionLease: {
          checkSocketLease: jest.fn().mockResolvedValue("owned"),
          renewSocketLease: jest.fn().mockResolvedValue("missing")
        }
      }) as {
        handleRoomPresence: (
          client: { data: Record<string, unknown> },
          payload: unknown
        ) => Promise<{ ok: boolean; reason?: string }>;
      };

      const result = await gateway.handleRoomPresence(
        {
          data: {
            handshakeAuthenticated: true,
            isRealtimeAuthenticated: true,
            roomId: "room_1",
            sessionId: "user_1",
            peerId: "peer_1"
          }
        },
        {
          roomId: "room_1",
          sessionId: "user_1",
          peerId: "peer_1"
        }
      );

      expect(result).toEqual({ ok: false, reason: "lease-missing" });
    });
  });

  describe("SignalingGateway security enforcement", () => {
    function createSubscribeGatewayHarness() {
      const registry = {
        findSessionByPeerId: jest.fn().mockReturnValue(null),
        isActiveSessionSocket: jest.fn().mockReturnValue(true),
        cancelPendingDisconnectCleanup: jest.fn(),
        unregisterSessionSocket: jest.fn(),
        registerSessionSocket: jest.fn(),
        replaceExistingRoomSession: jest.fn().mockResolvedValue(undefined),
        updatePeerPresence: jest.fn().mockResolvedValue(true),
        rememberRecentRoom: jest.fn().mockResolvedValue(undefined),
        evictMemberSockets: jest.fn().mockResolvedValue(undefined),
        evictRoomSockets: jest.fn().mockResolvedValue(undefined)
      };
      const sessionLease = {
        claimPeerId: jest.fn().mockResolvedValue(undefined),
        releasePeerId: jest.fn().mockResolvedValue(undefined),
        claim: jest.fn().mockResolvedValue(null),
        rollback: jest.fn().mockResolvedValue(undefined),
        belongsTo: jest.fn().mockResolvedValue(true),
        assert: jest.fn().mockResolvedValue(undefined)
      };
      const peerSignals = {
        unregisterPeerSocket: jest.fn(),
        registerPeerSocket: jest.fn(),
        registerRecoveryGeneration: jest.fn().mockReturnValue(1),
        clearPendingPeerSignals: jest.fn(),
        clearRecoveryGeneration: jest.fn(),
        nextSequence: jest.fn().mockReturnValue(1),
        resolvePeerRecoveryGeneration: jest.fn().mockReturnValue(1),
        emitToPeer: jest.fn().mockResolvedValue(undefined)
      };
      const readiness = {
        clearForSession: jest.fn(),
        getReadinessForTimeline: jest.fn().mockReturnValue([])
      };
      const metrics = {
        bindRealtimeSocket: jest.fn(),
        unbindRealtimeSocket: jest.fn(),
        incrementDiagnosticsReport: jest.fn()
      };
      const roomService = {
        getAccessibleRoomSnapshot: jest.fn(),
        assertRoomMember: jest.fn().mockResolvedValue(undefined)
      };
      const authService = {
        assertSessionToken: jest.fn().mockResolvedValue(undefined),
        getUserOrThrow: jest.fn().mockResolvedValue({
          id: "user_1",
          nickname: "User 1",
          status: "ACTIVE"
        })
      };
      const gateway = Object.assign(Object.create(SignalingGateway.prototype), {
        realtimeRateLimits: new Map(),
        unauthenticatedConnectionTimers: new Map(),
        telemetryLastReportAt: new Map(),
        telemetryReportRetentionMs: 600_000,
        redisService: { isAvailable: jest.fn().mockReturnValue(false) },
        roomService,
        roomRealtimePublisher: { emitTopologySnapshot: jest.fn() },
        roomRealtimeBroadcaster: {
          instanceId: "inst-1",
          setServer: jest.fn(),
          setEvictionHandler: jest.fn()
        },
        authService,
        metrics,
        sessionLease,
        peerSignals,
        readiness,
        registry,
        playlistService: { listPlaylistsForRoom: jest.fn().mockResolvedValue([]) },
        roomChatService: { append: jest.fn() },
        server: { to: jest.fn(() => ({ emit: jest.fn() })) }
      }) as Record<string, (...args: unknown[]) => Promise<unknown>>;

      return {
        gateway,
        registry,
        sessionLease,
        peerSignals,
        roomService,
        authService
      };
    }

    it("rejects non-members in room.subscribe before joining or registering sockets", async () => {
      const { gateway, registry, peerSignals, roomService } = createSubscribeGatewayHarness();
      roomService.getAccessibleRoomSnapshot.mockResolvedValue({
        room: {
          id: "room_1",
          hostId: "host_1",
          members: [{ id: "host_1", peerId: "peer_host", presenceState: "online" }]
        }
      });
      const client = {
        id: "socket_1",
        handshake: { headers: { "x-session-token": "tok_1" }, auth: {} },
        data: {},
        join: jest.fn(),
        emit: jest.fn(),
        leave: jest.fn()
      };

      const result = await gateway.handleRoomSubscribe(client, {
        roomId: "room_1",
        sessionId: "outsider_1",
        peerId: "peer_outsider",
        protocolVersion: 4,
        capabilities: ["webrtc-opus-v1"]
      });

      expect(result).toEqual({ ok: false });
      expect(client.emit).toHaveBeenCalledWith("room.snapshot.missing", { roomId: "room_1" });
      expect(client.join).not.toHaveBeenCalled();
      expect(peerSignals.registerPeerSocket).not.toHaveBeenCalled();
      expect(registry.registerSessionSocket).not.toHaveBeenCalled();
    });

    it("rejects duplicate peerId held by another session on room.subscribe", async () => {
      const { gateway, registry, sessionLease, roomService } = createSubscribeGatewayHarness();
      roomService.getAccessibleRoomSnapshot.mockResolvedValue({
        room: {
          id: "room_1",
          hostId: "host_1",
          members: [
            { id: "host_1", peerId: "shared_peer", presenceState: "online" },
            { id: "user_2", peerId: null, presenceState: "offline" }
          ]
        }
      });
      registry.findSessionByPeerId.mockReturnValue("host_1");
      const client = {
        id: "socket_2",
        handshake: { headers: { "x-session-token": "tok_2" }, auth: {} },
        data: {},
        join: jest.fn(),
        emit: jest.fn(),
        leave: jest.fn()
      };

      await expect(
        gateway.handleRoomSubscribe(client, {
          roomId: "room_1",
          sessionId: "user_2",
          peerId: "shared_peer",
          protocolVersion: 4,
          capabilities: ["webrtc-opus-v1"]
        })
      ).rejects.toThrow("Peer ID is already in use.");
      expect(client.join).not.toHaveBeenCalled();

      registry.findSessionByPeerId.mockReturnValue(null);
      roomService.getAccessibleRoomSnapshot.mockResolvedValue({
        room: {
          id: "room_1",
          hostId: "host_1",
          members: [{ id: "user_2", peerId: null, presenceState: "offline" }]
        }
      });
      sessionLease.claimPeerId.mockRejectedValue(new Error("Peer ID is already in use."));

      await expect(
        gateway.handleRoomSubscribe(client, {
          roomId: "room_1",
          sessionId: "user_2",
          peerId: "shared_peer",
          protocolVersion: 4,
          capabilities: ["webrtc-opus-v1"]
        })
      ).rejects.toThrow("Peer ID is already in use.");
      expect(client.join).not.toHaveBeenCalled();
    });

    it("enforces room membership on peer.signal and diagnostics.report", async () => {
      const { gateway, roomService } = createSubscribeGatewayHarness();
      roomService.assertRoomMember.mockRejectedValue(new Error("User is not a member of this room."));
      const client = {
        id: "socket_1",
        data: {
          isRealtimeAuthenticated: true,
          roomId: "room_1",
          sessionId: "user_1",
          peerId: "peer_1"
        }
      };

      await expect(
        gateway.handleSignal(client, {
          protocolVersion: 4,
          capability: "webrtc-opus-v1",
          roomId: "room_1",
          fromPeerId: "peer_1",
          toPeerId: "peer_2",
          channelKind: "data",
          type: "candidate",
          payload: { candidate: "candidate:1 1 UDP 1 127.0.0.1 9 typ host" }
        })
      ).rejects.toThrow("User is not a member of this room.");

      await expect(
        gateway.handleDiagnosticsReport(client, {
          protocolVersion: 1,
          roomId: "room_1",
          sessionId: "user_1",
          peerId: "peer_1",
          reportedAt: new Date().toISOString(),
          peers: []
        })
      ).rejects.toThrow("User is not a member of this room.");
    });

    it("rejects DISABLED users on room.chat, room.reaction, room.clock, and peer.signal", async () => {
      const { gateway, authService } = createSubscribeGatewayHarness();
      authService.getUserOrThrow.mockResolvedValue({
        id: "user_1",
        nickname: "User 1",
        status: "DISABLED"
      });
      const client = {
        id: "socket_1",
        data: {
          isRealtimeAuthenticated: true,
          roomId: "room_1",
          sessionId: "user_1",
          peerId: "peer_1"
        }
      };

      await expect(
        gateway.handleRoomChat(client, { roomId: "room_1", content: "hello" })
      ).rejects.toThrow("Account is disabled.");
      await expect(
        gateway.handleRoomReaction(client, { roomId: "room_1", reaction: "like" })
      ).rejects.toThrow("Account is disabled.");
      await expect(
        gateway.handleRoomClock(client, { roomId: "room_1" })
      ).rejects.toThrow("Account is disabled.");
      await expect(
        gateway.handleSignal(client, {
          protocolVersion: 4,
          capability: "webrtc-opus-v1",
          roomId: "room_1",
          fromPeerId: "peer_1",
          toPeerId: "peer_2",
          channelKind: "data",
          type: "candidate",
          payload: { candidate: "candidate:1 1 UDP 1 127.0.0.1 9 typ host" }
        })
      ).rejects.toThrow("Account is disabled.");
    });

    it("evicts member and room sockets and releases leases in RoomSessionRegistryService", async () => {
      const sessionLease = {
        invalidateSocket: jest.fn(),
        release: jest.fn().mockResolvedValue(undefined),
        forceDelete: jest.fn().mockResolvedValue(undefined)
      };
      const peerSignals = {
        unregisterPeerSocket: jest.fn(),
        clearPendingPeerSignals: jest.fn(),
        clearRecoveryGeneration: jest.fn(),
        clearRoomState: jest.fn()
      };
      const readiness = {
        clearForSession: jest.fn(),
        clearRoomState: jest.fn()
      };
      const metrics = {
        unbindRealtimeSocket: jest.fn(),
        clearRoom: jest.fn()
      };
      const registry = new RoomSessionRegistryService(
        sessionLease as never,
        peerSignals as never,
        readiness as never,
        {} as never,
        {} as never,
        metrics as never
      );

      const socket1 = {
        id: "sock_1",
        data: {
          roomId: "room_1",
          sessionId: "user_1",
          peerId: "peer_1",
          sessionFenceToken: "fence_1",
          isRealtimeAuthenticated: true
        },
        leave: jest.fn()
      };
      const socket2 = {
        id: "sock_2",
        data: {
          roomId: "room_1",
          sessionId: "user_2",
          peerId: "peer_2",
          sessionFenceToken: "fence_2",
          isRealtimeAuthenticated: true
        },
        leave: jest.fn()
      };
      const socketsMap = new Map([
        ["sock_1", socket1],
        ["sock_2", socket2]
      ]);
      registry.setServer({ sockets: { sockets: socketsMap } } as never);
      registry.registerSessionSocket("room_1", "user_1", "peer_1", "sock_1", "fence_1");
      registry.registerSessionSocket("room_1", "user_2", "peer_2", "sock_2", "fence_2");

      await registry.evictMemberSockets("room_1", "user_1");
      expect(socket1.leave).toHaveBeenCalledWith("room_1");
      expect(socket1.data.isRealtimeAuthenticated).toBe(false);
      expect(socket1.data.roomId).toBeUndefined();
      expect(sessionLease.forceDelete).toHaveBeenCalledWith("room_1", "user_1", "peer_1");
      expect(socket2.leave).not.toHaveBeenCalled();

      await registry.evictRoomSockets("room_1");
      expect(socket2.leave).toHaveBeenCalledWith("room_1");
      expect(socket2.data.isRealtimeAuthenticated).toBe(false);
      expect(sessionLease.forceDelete).toHaveBeenCalledWith("room_1", "user_2", "peer_2");
      expect(peerSignals.clearRoomState).toHaveBeenCalledWith("room_1");
    });

    it("does not emit room.session.replaced when replacing a socket during seamless same-peerId reconnect", async () => {
      const sessionLease = { invalidateSocket: jest.fn() };
      const peerSignals = {
        unregisterPeerSocket: jest.fn(),
        clearRecoveryGeneration: jest.fn()
      };
      const metrics = { unbindRealtimeSocket: jest.fn() };
      const roomService = { handleDuplicateSessionReplacement: jest.fn().mockResolvedValue(undefined) };
      const roomRealtimePublisher = { emitTopologySnapshot: jest.fn().mockResolvedValue(undefined) };
      const registry = new RoomSessionRegistryService(
        sessionLease as never,
        peerSignals as never,
        {} as never,
        roomService as never,
        roomRealtimePublisher as never,
        metrics as never
      );

      const oldSocket = {
        id: "sock_old",
        data: {
          roomId: "room_1",
          sessionId: "user_1",
          peerId: "peer_1",
          sessionFenceToken: "fence_1",
          isRealtimeAuthenticated: true
        },
        emit: jest.fn(),
        leave: jest.fn()
      };
      const newSocket = {
        id: "sock_new",
        data: {
          roomId: "room_1",
          sessionId: "user_1",
          peerId: "peer_other",
          sessionFenceToken: "fence_2",
          isRealtimeAuthenticated: true
        },
        emit: jest.fn(),
        leave: jest.fn()
      };
      registry.setServer({
        sockets: {
          sockets: new Map([
            ["sock_old", oldSocket],
            ["sock_new", newSocket]
          ])
        }
      } as never);

      registry.registerSessionSocket("room_1", "user_1", "peer_1", "sock_old", "fence_1");
      await registry.replaceExistingRoomSession("room_1", "user_1", "peer_1", "sock_reconnect");
      expect(oldSocket.emit).not.toHaveBeenCalled();
      expect(oldSocket.leave).toHaveBeenCalledWith("room_1");
      expect(roomService.handleDuplicateSessionReplacement).not.toHaveBeenCalled();

      registry.registerSessionSocket("room_1", "user_1", "peer_other", "sock_new", "fence_2");
      await registry.replaceExistingRoomSession("room_1", "user_1", "peer_different", "sock_tab2");
      expect(newSocket.emit).toHaveBeenCalledWith("room.session.replaced", {
        roomId: "room_1",
        reason: "duplicate-session"
      });
      expect(roomService.handleDuplicateSessionReplacement).toHaveBeenCalledWith("room_1", "user_1");
    });

    it("keeps active socket registrations intact during same-room same-session resubscribe", async () => {
      const { gateway, registry, peerSignals, roomService } = createSubscribeGatewayHarness();
      roomService.getAccessibleRoomSnapshot.mockResolvedValue({
        room: {
          id: "room_1",
          hostId: "host_1",
          playback: { currentTrackId: null, mediaEpoch: 0 },
          members: [{ id: "user_1", peerId: "peer_1", presenceState: "online" }]
        }
      });
      const client = {
        id: "socket_1",
        handshake: { headers: { "x-session-token": "tok_1" }, auth: {} },
        data: {
          handshakeAuthenticated: true,
          handshakeSessionId: "user_1",
          isRealtimeAuthenticated: true,
          roomId: "room_1",
          sessionId: "user_1",
          peerId: "peer_1"
        },
        join: jest.fn(),
        emit: jest.fn(),
        leave: jest.fn()
      };

      await gateway.handleRoomSubscribe(client, {
        roomId: "room_1",
        sessionId: "user_1",
        peerId: "peer_1",
        protocolVersion: 4,
        capabilities: ["webrtc-opus-v1"]
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(peerSignals.unregisterPeerSocket).not.toHaveBeenCalled();
      expect(registry.unregisterSessionSocket).not.toHaveBeenCalled();
      expect(peerSignals.registerPeerSocket).toHaveBeenCalledWith("room_1", "peer_1", "socket_1");
      expect(registry.registerSessionSocket).toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith("room.snapshot", expect.anything());
    });
  });
});
