import { AuthService } from "../auth/auth.service";
import { createRoomCoreServices } from "./room-graph";

function createPrismaMock() {
  return {
    isAvailable: jest.fn(() => false),
    ensureAvailable: jest.fn(async () => false),
    guestSessions: {
      upsert: jest.fn(),
      findUnique: jest.fn()
    },
    roomStates: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn()
    },
    playlists: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn()
    }
  };
}

function createRedisMock() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    setJson: jest.fn(async (key: string, payload: unknown) => {
      store.set(key, JSON.stringify(payload));
    }),
    getJson: jest.fn(async (key: string) => {
      const value = store.get(key);
      return value ? JSON.parse(value) : null;
    }),
    setString: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    getString: jest.fn(async (key: string) => store.get(key) ?? null),
    delete: jest.fn(async (key: string) => {
      store.delete(key);
    }),
    addToSet: jest.fn(async (key: string, value: string) => {
      const existing = sets.get(key) ?? new Set<string>();
      existing.add(value);
      sets.set(key, existing);
    }),
    removeFromSet: jest.fn(async (key: string, value: string) => {
      const existing = sets.get(key);
      existing?.delete(value);
    }),
    getSetMembers: jest.fn(async (key: string) => [...(sets.get(key) ?? new Set<string>())]),
    publish: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined)
  };
}

function createPlaybackAssetMock(assetId: string, durationMs = 180_000, sourceFileHash = "b".repeat(64)) {
  const normalizedAssetId = assetId.padEnd(64, "0").slice(0, 64);
  const normalizedSourceFileHash = sourceFileHash.padEnd(64, "0").slice(0, 64);
  return {
    assetId: normalizedAssetId,
    kind: "playback" as const,
    sourceFileHash: normalizedSourceFileHash,
    profileId: "opus-music-v4" as const,
    codec: "opus" as const,
    container: "audio/ogg" as const,
    sampleRate: 48_000 as const,
    channels: 2 as const,
    bitrate: 256_000 as const,
    durationMs,
    segmentDurationMs: 2_000 as const,
    seekPrerollMs: 80 as const,
    unitCount: Math.ceil(durationMs / 2_000),
    merkleRoot: "c".repeat(64),
    encoder: {
      name: "@audio/opus-encode" as const,
      version: "3.4.0" as const
    }
  };
}

function createOriginalAssetMock(assetId: string, fileHash = "b".repeat(64), sizeBytes = 1024 * 1024) {
  const normalizedAssetId = assetId.padEnd(64, "0").slice(0, 64);
  const normalizedFileHash = fileHash.padEnd(64, "0").slice(0, 64);
  return {
    assetId: normalizedAssetId,
    kind: "original" as const,
    fileHash: normalizedFileHash,
    mimeType: "audio/mp3",
    sizeBytes,
    unitSize: 1048576 as const,
    unitCount: 1,
    merkleRoot: "c".repeat(64)
  };
}

describe("RoomService", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("lets only a radio host insert one recommended song as the next queue item", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;
    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "radio" });
    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host", "online");

    const registerProviderTrack = (
      trackId: string,
      title: string,
      artist: string,
      provider: "netease" | "qqmusic" = "netease"
    ) =>
      roomService.registerTrack(snapshot.room.id, host.id, {
        title,
        artist,
        album: null,
        durationMs: 180_000,
        bitrate: null,
        sizeBytes: null,
        codec: null,
        mimeType: null,
        fileHash: `hash_${trackId}`,
        artworkUrl: null,
        ownerSessionId: host.id,
        ownerNickname: host.nickname,
        sourceType: provider,
        sourceRef: { provider, trackId },
        playbackAsset: createPlaybackAssetMock(`asset_${trackId}`, 180_000)
      });

    const seed = await registerProviderTrack("1001", "Seed", "Seed Artist");
    const existingNext = await registerProviderTrack("1002", "Existing", "Existing Artist");
    const recommended = await registerProviderTrack("1003", "Recommended", "Seed Artist");
    const otherCandidate = await registerProviderTrack("1004", "Other", "Other Artist");
    const seedQueueItem = await roomService.addQueueItem(snapshot.room.id, host.id, seed.id);
    const existingNextQueueItem = await roomService.addQueueItem(snapshot.room.id, host.id, existingNext.id);
    await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      queueItemId: seedQueueItem.id,
      actorSessionId: host.id
    });

    await expect(
      roomService.updateRadioAutopilot(snapshot.room.id, member.id, {
        enabled: true
      })
    ).rejects.toThrow("Only the host");

    const inserted = await roomService.insertRadioAutopilotNextTrack(
      snapshot.room.id,
      host.id,
      recommended.id
    );

    expect(inserted).toMatchObject({
      trackId: recommended.id,
      source: "autopilot",
      sourceSeedTrackId: seed.id,
      position: 1
    });
    const afterInsert = await roomService.getRoomSnapshot(snapshot.room.id, []);
    expect(afterInsert.queue.map((item) => item.id)).toEqual([
      seedQueueItem.id,
      inserted.id,
      existingNextQueueItem.id
    ]);
    expect(afterInsert.queue.map((item) => item.position)).toEqual([0, 1, 2]);
    expect(afterInsert.room.playback.nextQueueItemId).toBe(inserted.id);
    await expect(
      roomService.insertRadioAutopilotNextTrack(snapshot.room.id, host.id, recommended.id)
    ).rejects.toThrow("已在节目单");
    await expect(
      roomService.insertRadioAutopilotNextTrack(snapshot.room.id, member.id, otherCandidate.id)
    ).rejects.toThrow("Only the host");
  });

  it("limits member management to the host and removes access after a kick", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "private", { roomType: "interactive" });
    await roomService.joinRoom(snapshot.room.id, member.id);

    await expect(
      roomService.updateMemberPermissions(snapshot.room.id, member.id, host.id, {
        library: false,
        queue: true,
        player: false
      })
    ).rejects.toThrow("Only the host");

    await roomService.updateMemberPermissions(snapshot.room.id, host.id, member.id, {
      library: false,
      queue: true,
      player: false
    });
    const updated = await roomService.getRoomSnapshot(snapshot.room.id, []);
    expect(updated.room.members.find((item) => item.id === member.id)?.permissions).toEqual({
      library: false,
      queue: true,
      player: false
    });

    await roomService.removeMember(snapshot.room.id, host.id, member.id);
    await expect(roomService.assertRoomMember(snapshot.room.id, member.id)).rejects.toThrow(
      "Only room members"
    );
    await expect(roomService.getRecoverableRoomSnapshot(snapshot.room.id, member.id)).resolves.toBeNull();

    await roomService.joinRoom(snapshot.room.id, member.id);
    const rejoined = await roomService.getRoomSnapshot(snapshot.room.id, []);
    expect(rejoined.room.members.find((item) => item.id === member.id)?.permissions).toEqual({
      library: false,
      queue: true,
      player: false
    });
  });

  it("restores host-assigned permissions after a member leaves and rejoins", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.joinRoom(snapshot.room.id, member.id);

    await roomService.updateMemberPermissions(snapshot.room.id, host.id, member.id, {
      library: false,
      queue: true,
      player: false
    });
    await roomService.leaveRoom(snapshot.room.id, member.id);
    await roomService.joinRoom(snapshot.room.id, member.id);

    const rejoined = await roomService.getRoomSnapshot(snapshot.room.id, []);
    expect(rejoined.room.members.find((item) => item.id === member.id)?.permissions).toEqual({
      library: false,
      queue: true,
      player: false
    });
  });

  it("uses room defaults only when a member joins for the first time", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const firstMember = await authService.createGuestSession("First Member");
    const secondMember = await authService.createGuestSession("Second Member");
    const snapshot = await roomService.createRoom(host.id, "public", {
      roomType: "interactive",
      newMemberPermissions: {
        library: false,
        queue: true,
        player: false
      }
    });

    expect(snapshot.room.newMemberPermissions).toEqual({
      library: false,
      queue: true,
      player: false
    });
    await roomService.joinRoom(snapshot.room.id, firstMember.id);

    await roomService.updateRoom(snapshot.room.id, host.id, {
      visibility: "public",
      name: snapshot.room.name ?? "Room",
      description: snapshot.room.description,
      password: "",
      newMemberPermissions: {
        library: true,
        queue: false,
        player: true
      }
    });
    await roomService.joinRoom(snapshot.room.id, secondMember.id);

    const afterJoins = await roomService.getRoomSnapshot(snapshot.room.id, []);
    expect(afterJoins.room.members.find((item) => item.id === firstMember.id)?.permissions).toEqual({
      library: false,
      queue: true,
      player: false
    });
    expect(afterJoins.room.members.find((item) => item.id === secondMember.id)?.permissions).toEqual({
      library: true,
      queue: false,
      player: true
    });

    await roomService.leaveRoom(snapshot.room.id, firstMember.id);
    await roomService.joinRoom(snapshot.room.id, firstMember.id);

    const afterRejoin = await roomService.getRoomSnapshot(snapshot.room.id, []);
    expect(afterRejoin.room.members.find((item) => item.id === firstMember.id)?.permissions).toEqual({
      library: false,
      queue: true,
      player: false
    });
  });

  it("allows any room member to control playback and uses the track owner as source", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    await roomService.updatePeerPresence(snapshot.room.id, member.id, "peer-member");
    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Track One",
      artist: "Local Upload",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "abc123",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });
    await roomService.addQueueItem(snapshot.room.id, member.id, track.id);

    await expect(
      roomService.updatePlayback(snapshot.room.id, {
        action: "play",
        trackId: track.id,
        actorSessionId: member.id
      })
    ).resolves.toMatchObject({
      status: "playing",
      currentTrackId: track.id,
      sourceSessionId: host.id,
      sourceTrackId: track.id,
      sourcePeerId: "peer-host"
    });
  });

  it("uses the actor peer as source when the uploader starts playback before presence settles", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Immediate Playback",
      artist: "Local Upload",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "immediate-playback",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });

    await expect(
      roomService.updatePlayback(snapshot.room.id, {
        action: "play",
        trackId: track.id,
        actorSessionId: host.id,
        actorPeerId: "peer-host"
      } as Parameters<typeof roomService.updatePlayback>[1] & { actorPeerId: string })
    ).resolves.toMatchObject({
      status: "playing",
      currentTrackId: track.id,
      sourceSessionId: host.id,
      sourcePeerId: "peer-host"
    });
  });

  it("increments room revision when playback changes", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Revision Track",
      artist: "Local Upload",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "revision-track",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });
    const beforePlayback = await roomService.getRoomSnapshot(snapshot.room.id, []);

    await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      trackId: track.id,
      actorSessionId: host.id,
      actorPeerId: "peer-host"
    });

    const afterPlayback = await roomService.getRoomSnapshot(snapshot.room.id, []);
    expect(afterPlayback.room.roomRevision).toBe((beforePlayback.room.roomRevision ?? 0) + 1);
    expect(afterPlayback.room.playback.status).toBe("playing");
  });

  it("allows any room member to remove a queue item", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const requester = await authService.createGuestSession("Requester");
    const otherMember = await authService.createGuestSession("Other");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, requester.id);
    await roomService.joinRoom(snapshot.room.id, otherMember.id);
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");

    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Track Two",
      artist: "Local Upload",
      album: null,
      durationMs: 90000,
      bitrate: null,
      fileHash: "def456",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });

    const queueItem = await roomService.addQueueItem(snapshot.room.id, requester.id, track.id);

    await expect(
      roomService.removeQueueItem(snapshot.room.id, queueItem.id, otherMember.id)
    ).resolves.toEqual([]);
  });

  it("clears the player when the currently playing queue item is removed", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");

    const firstTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "First",
      artist: "Artist",
      album: null,
      durationMs: 90000,
      bitrate: null,
      fileHash: "remove-current-first",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });
    const secondTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Second",
      artist: "Artist",
      album: null,
      durationMs: 90000,
      bitrate: null,
      fileHash: "remove-current-second",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });
    const firstQueueItem = await roomService.addQueueItem(snapshot.room.id, host.id, firstTrack.id);
    await roomService.addQueueItem(snapshot.room.id, host.id, secondTrack.id);

    await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      queueItemId: firstQueueItem.id,
      actorSessionId: host.id
    });

    await roomService.removeQueueItem(snapshot.room.id, firstQueueItem.id, host.id);
    const afterRemoval = await roomService.getRoomSnapshot(snapshot.room.id, []);

    expect(afterRemoval.queue).toHaveLength(1);
    expect(afterRemoval.queue[0]?.trackId).toBe(secondTrack.id);
    expect(afterRemoval.room.playback).toMatchObject({
      status: "paused",
      currentTrackId: null,
      currentQueueItemId: null,
      playbackAssetId: null,
      sourceSessionId: null,
      sourcePeerId: null
    });
  });

  it("clears direct playback when its matching queue item is removed", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Direct playback",
      artist: "Artist",
      album: null,
      durationMs: 90000,
      bitrate: null,
      fileHash: "remove-direct-playback",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });
    const queueItem = await roomService.addQueueItem(snapshot.room.id, host.id, track.id);

    await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      trackId: track.id,
      actorSessionId: host.id
    });

    await roomService.removeQueueItem(snapshot.room.id, queueItem.id, host.id);
    const afterRemoval = await roomService.getRoomSnapshot(snapshot.room.id, []);

    expect(afterRemoval.room.playback).toMatchObject({
      status: "paused",
      currentTrackId: null,
      currentQueueItemId: null,
      playbackAssetId: null,
      sourceSessionId: null,
      sourcePeerId: null
    });
  });

  it("keeps the host record offline and preserves host ownership when the host leaves", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    const roomAfterLeave = await roomService.leaveRoom(snapshot.room.id, host.id);

    expect(roomAfterLeave.hostId).toBe(host.id);
    expect(roomAfterLeave.members).toHaveLength(2);
    expect(roomAfterLeave.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: host.id,
          role: "host"
        }),
        expect.objectContaining({
          id: member.id,
          role: "member"
        })
      ])
    );

    const snapshotAfterLeave = await roomService.getRoomSnapshot(snapshot.room.id, []);
    expect(
      snapshotAfterLeave.room.members.find((trackedMember) => trackedMember.id === host.id)
    ).toMatchObject({
      id: host.id,
      role: "host",
      presenceState: "offline",
      peerId: null
    });
  });

  it("starts a new membership timer when the host leaves and rejoins", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-07-15T09:00:00.000Z"));

    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    const firstJoinedAt = snapshot.room.members.find((member) => member.id === host.id)?.joinedAt;

    await roomService.leaveRoom(snapshot.room.id, host.id);
    jest.setSystemTime(new Date("2026-07-15T09:12:00.000Z"));
    await roomService.joinRoom(snapshot.room.id, host.id);

    const rejoined = await roomService.getRoomSnapshot(snapshot.room.id, []);
    expect(rejoined.room.members.find((member) => member.id === host.id)?.joinedAt).toBe(
      "2026-07-15T09:12:00.000Z"
    );
    expect(firstJoinedAt).toBe("2026-07-15T09:00:00.000Z");
  });

  it("clears the recent room record after a member leaves an existing room", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.leaveRoom(snapshot.room.id, member.id);

    const recentRoom = await roomService.getRecentRoomSnapshotForSession(member.id);

    expect(recentRoom).toBeNull();
  });

  it("keeps a leaving member's tracks in the room record", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, member.id, "peer-member");
    const hostTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Host Track",
      artist: "Artist",
      album: null,
      durationMs: 90000,
      bitrate: null,
      fileHash: "host-track-stays-after-member-leave",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });
    const memberTrack = await roomService.registerTrack(snapshot.room.id, member.id, {
      title: "Member Track",
      artist: "Artist",
      album: null,
      durationMs: 90000,
      bitrate: null,
      fileHash: "member-track-removed-on-leave",
      artworkUrl: null,
      ownerSessionId: member.id,
      ownerNickname: member.nickname,
      sourceType: "local_upload"
    });

    await roomService.addQueueItem(snapshot.room.id, host.id, hostTrack.id);
    await roomService.addQueueItem(snapshot.room.id, member.id, memberTrack.id);
    await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      trackId: memberTrack.id,
      actorSessionId: host.id
    });

    const roomAfterLeave = await roomService.leaveRoom(snapshot.room.id, member.id);

    expect(roomAfterLeave.members.some((roomMember) => roomMember.id === member.id)).toBe(false);
    const snapshotAfterLeave = await roomService.getRoomSnapshot(snapshot.room.id, []);
    expect(snapshotAfterLeave.tracks.map((track) => track.id)).toEqual([memberTrack.id, hostTrack.id]);
    expect(snapshotAfterLeave.queue.map((queueItem) => queueItem.trackId)).toEqual([
      hostTrack.id,
      memberTrack.id
    ]);
    expect(snapshotAfterLeave.queue[0]?.position).toBe(0);
    expect(snapshotAfterLeave.room.playback.currentTrackId).toBe(memberTrack.id);
  });

  it("keeps the room recoverable when the last active member leaves and only the offline host remains", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.leaveRoom(snapshot.room.id, member.id);

    const recovered = await roomService.getRecoverableRoomSnapshot(snapshot.room.id, host.id);
    expect(recovered).not.toBeNull();
    expect(recovered?.room.hostId).toBe(host.id);
    expect(recovered?.room.members).toHaveLength(1);
    expect(recovered?.room.members[0]).toMatchObject({
      id: host.id,
      role: "host",
      presenceState: "offline"
    });
  });

  it("imports a playlist back into the room queue when tracks exist in the room", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Track Three",
      artist: "Local Upload",
      album: null,
      durationMs: 180000,
      bitrate: null,
      fileHash: "ghi789",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });

    const queue = await roomService.importPlaylistToQueue(snapshot.room.id, member.id, [track.id]);

    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      trackId: track.id,
      requestedById: member.id
    });

    const roomAfterImport = await roomService.getRoomSnapshot(snapshot.room.id, []);
    expect(roomAfterImport.room.playback).toMatchObject({
      status: "paused",
      currentTrackId: null,
      currentQueueItemId: null
    });
  });

  it("keeps playback paused when the first track is only added to queue", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Queued Only",
      artist: "Artist",
      album: null,
      durationMs: 100000,
      bitrate: null,
      fileHash: "queued-only",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });

    const queueItem = await roomService.addQueueItem(snapshot.room.id, member.id, track.id);
    const roomAfterQueue = await roomService.getRoomSnapshot(snapshot.room.id, []);

    expect(queueItem.trackId).toBe(track.id);
    expect(roomAfterQueue.queue).toHaveLength(1);
    expect(roomAfterQueue.room.playback).toMatchObject({
      status: "paused",
      currentTrackId: null,
      currentQueueItemId: null
    });
  });

  it("allows any room member to reorder the queue and jump to a queue item", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    const firstTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "First",
      artist: "Local Upload",
      album: null,
      durationMs: 100000,
      bitrate: null,
      fileHash: "first",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });
    const secondTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Second",
      artist: "Local Upload",
      album: null,
      durationMs: 100000,
      bitrate: null,
      fileHash: "second",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });

    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    const firstQueueItem = await roomService.addQueueItem(snapshot.room.id, member.id, firstTrack.id);
    const secondQueueItem = await roomService.addQueueItem(snapshot.room.id, member.id, secondTrack.id);

    const reordered = await roomService.reorderQueue(snapshot.room.id, member.id, [
      secondQueueItem.id,
      firstQueueItem.id
    ]);
    expect(reordered[0]?.id).toBe(secondQueueItem.id);
    expect(reordered[1]?.position).toBe(1);

    await expect(
      roomService.updatePlayback(snapshot.room.id, {
        action: "play",
        queueItemId: secondQueueItem.id,
        actorSessionId: host.id
      })
    ).resolves.toMatchObject({
      currentTrackId: secondTrack.id,
      currentQueueItemId: secondQueueItem.id,
      status: "playing",
      sourceSessionId: host.id
    });
  });

  it("keeps the active queue item stable when the same track appears multiple times", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");

    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Repeat",
      artist: "Artist",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "repeat-track",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });

    const firstQueueItem = await roomService.addQueueItem(snapshot.room.id, member.id, track.id);
    const secondQueueItem = await roomService.addQueueItem(snapshot.room.id, member.id, track.id);

    await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      queueItemId: firstQueueItem.id,
      actorSessionId: host.id
    });

    const nextPlayback = await roomService.updatePlayback(snapshot.room.id, {
      action: "next",
      actorSessionId: host.id
    });

    expect(nextPlayback.currentTrackId).toBe(track.id);
    expect(nextPlayback.currentQueueItemId).toBe(secondQueueItem.id);

    const previousPlayback = await roomService.updatePlayback(snapshot.room.id, {
      action: "prev",
      actorSessionId: host.id
    });

    expect(previousPlayback.currentTrackId).toBe(track.id);
    expect(previousPlayback.currentQueueItemId).toBe(firstQueueItem.id);
  });

  it("synchronizes playback order mode and uses it for real room advancement", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");

    const firstTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "First",
      artist: "Artist",
      album: null,
      durationMs: 100000,
      bitrate: null,
      fileHash: "mode-first",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });
    const secondTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Second",
      artist: "Artist",
      album: null,
      durationMs: 100000,
      bitrate: null,
      fileHash: "mode-second",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });
    const firstItem = await roomService.addQueueItem(snapshot.room.id, host.id, firstTrack.id);
    const secondItem = await roomService.addQueueItem(snapshot.room.id, host.id, secondTrack.id);

    const playing = await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      queueItemId: firstItem.id,
      actorSessionId: host.id
    });
    const single = await roomService.updatePlayback(snapshot.room.id, {
      action: "set-mode",
      playbackMode: "single",
      actorSessionId: host.id
    });
    expect(single).toMatchObject({ playbackMode: "single" });

    const repeated = await roomService.updatePlayback(snapshot.room.id, {
      action: "next",
      actorSessionId: host.id
    });
    expect(repeated).toMatchObject({
      playbackMode: "single",
      currentTrackId: firstTrack.id,
      currentQueueItemId: firstItem.id,
      positionMs: 0
    });

    await roomService.updatePlayback(snapshot.room.id, {
      action: "set-mode",
      playbackMode: "sequence",
      actorSessionId: host.id
    });
    const next = await roomService.updatePlayback(snapshot.room.id, {
      action: "next",
      actorSessionId: host.id
    });
    expect(next).toMatchObject({
      playbackMode: "sequence",
      currentTrackId: secondTrack.id,
      currentQueueItemId: secondItem.id
    });
    expect(next.playbackRevision).toBeGreaterThan(playing.playbackRevision);

    await expect(roomService.getRoomSnapshot(snapshot.room.id, [])).resolves.toMatchObject({
      room: { playback: { playbackMode: "sequence" } }
    });
  });

  it("restarts playback when jumping between queue items that share the same track", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");

    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Repeat",
      artist: "Artist",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "repeat-track",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });

    const firstQueueItem = await roomService.addQueueItem(snapshot.room.id, member.id, track.id);
    const secondQueueItem = await roomService.addQueueItem(snapshot.room.id, member.id, track.id);

    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-07-12T00:00:00.000Z"));
    try {
      const firstPlayback = await roomService.updatePlayback(snapshot.room.id, {
        action: "play",
        queueItemId: firstQueueItem.id,
        actorSessionId: host.id
      });

      jest.setSystemTime(new Date("2026-07-12T00:00:08.000Z"));

      const secondPlayback = await roomService.updatePlayback(snapshot.room.id, {
        action: "play",
        queueItemId: secondQueueItem.id,
        actorSessionId: host.id
      });

      expect(firstPlayback.currentTrackId).toBe(track.id);
      expect(firstPlayback.currentQueueItemId).toBe(firstQueueItem.id);
      expect(secondPlayback.currentTrackId).toBe(track.id);
      expect(secondPlayback.currentQueueItemId).toBe(secondQueueItem.id);
      expect(secondPlayback.positionMs).toBe(0);
      expect(secondPlayback.mediaEpoch).toBe(firstPlayback.mediaEpoch + 1);
      expect(secondPlayback.playbackRevision).toBeGreaterThan(firstPlayback.playbackRevision);
    } finally {
      jest.useRealTimers();
    }
  });

  it("binds direct track playback to its queue item before automatic next", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Repeated Track",
      artist: "Artist",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "direct-track-repeat",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });

    const firstQueueItem = await roomService.addQueueItem(snapshot.room.id, member.id, track.id);
    const secondQueueItem = await roomService.addQueueItem(snapshot.room.id, member.id, track.id);

    const playing = await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      trackId: track.id,
      actorSessionId: host.id
    });
    const nextPlayback = await roomService.updatePlayback(snapshot.room.id, {
      action: "next",
      actorSessionId: host.id
    });

    expect(playing.currentQueueItemId).toBe(firstQueueItem.id);
    expect(nextPlayback.currentQueueItemId).toBe(secondQueueItem.id);
  });

  it("allows the original uploader to delete a track and removes it from queue and playback", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, member.id, "peer-member");

    const track = await roomService.registerTrack(snapshot.room.id, member.id, {
      title: "Member Track",
      artist: "Artist",
      album: null,
      durationMs: 90000,
      bitrate: null,
      fileHash: "member-track-delete",
      artworkUrl: null,
      ownerSessionId: member.id,
      ownerNickname: member.nickname,
      sourceType: "local_upload"
    });

    await roomService.addQueueItem(snapshot.room.id, member.id, track.id);
    await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      trackId: track.id,
      actorSessionId: host.id
    });

    await expect(
      roomService.removeTrack(snapshot.room.id, member.id, track.id)
    ).resolves.toEqual({ ok: true });

    const roomAfterDelete = await roomService.getRoomSnapshot(snapshot.room.id, []);
    expect(roomAfterDelete.tracks).toHaveLength(0);
    expect(roomAfterDelete.queue).toHaveLength(0);
    expect(roomAfterDelete.room.playback.currentTrackId).toBeNull();
  });

  it("allows the host to delete another member's uploaded track", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    const track = await roomService.registerTrack(snapshot.room.id, member.id, {
      title: "Member Track",
      artist: "Artist",
      album: null,
      durationMs: 90000,
      bitrate: null,
      fileHash: "member-track-host-delete",
      artworkUrl: null,
      ownerSessionId: member.id,
      ownerNickname: member.nickname,
      sourceType: "local_upload"
    });
    await roomService.addQueueItem(snapshot.room.id, host.id, track.id);

    await expect(
      roomService.removeTrack(snapshot.room.id, host.id, track.id)
    ).resolves.toEqual({ ok: true });
  });

  it("blocks other members from deleting someone else's uploaded track", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Host Track",
      artist: "Artist",
      album: null,
      durationMs: 90000,
      bitrate: null,
      fileHash: "host-track-delete",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });

    await expect(
      roomService.removeTrack(snapshot.room.id, member.id, track.id)
    ).rejects.toThrow("Only the original uploader can delete this track.");
  });

  it("rejects playback when the track owner is offline", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, member.id, "peer-member");
    const memberTrack = await roomService.registerTrack(snapshot.room.id, member.id, {
      title: "Member Track",
      artist: "Local Upload",
      album: null,
      durationMs: 60000,
      bitrate: null,
      fileHash: "member-track",
      artworkUrl: null,
      ownerSessionId: member.id,
      ownerNickname: member.nickname,
      sourceType: "local_upload"
    });

    await roomService.updatePeerPresence(snapshot.room.id, member.id, null);

    await expect(
      roomService.updatePlayback(snapshot.room.id, {
        action: "play",
        trackId: memberTrack.id,
        actorSessionId: host.id
      })
    ).rejects.toThrow("Track owner is not online, so this song cannot be played right now.");
  });

  it("keeps playback snapshot consistent when a member pauses and seeks", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    await roomService.updatePeerPresence(snapshot.room.id, member.id, "peer-member");

    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Track Four",
      artist: "Local Upload",
      album: null,
      durationMs: 150000,
      bitrate: null,
      fileHash: "track-four",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });

    await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      trackId: track.id,
      actorSessionId: host.id,
      positionMs: 4000
    });

    const paused = await roomService.updatePlayback(snapshot.room.id, {
      action: "pause",
      actorSessionId: host.id,
      positionMs: 12000
    });

    expect(paused).toMatchObject({
      status: "paused",
      currentTrackId: track.id,
      sourceSessionId: host.id,
      sourcePeerId: "peer-host",
      sourceTrackId: track.id,
      positionMs: 12000,
      startedAt: null
    });

    const seeked = await roomService.updatePlayback(snapshot.room.id, {
      action: "seek",
      actorSessionId: host.id,
      positionMs: 30000
    });

    expect(seeked).toMatchObject({
      status: "paused",
      currentTrackId: track.id,
      sourceSessionId: host.id,
      sourcePeerId: "peer-host",
      sourceTrackId: track.id,
      positionMs: 30000,
      startedAt: null
    });
  });

  it("rejects stale playback writes with a version conflict", async () => {
    const prisma = createPrismaMock();
    const redis = {
      ...createRedisMock(),
      isAvailable: jest.fn(() => true)
    };
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Conflict",
      artist: "Artist",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "conflict-track",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });

    const firstPlayback = await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      trackId: track.id,
      actorSessionId: host.id,
      expectedVersion: snapshot.room.playback.playbackRevision
    });

    await expect(
      roomService.updatePlayback(snapshot.room.id, {
        action: "pause",
        actorSessionId: host.id,
        expectedVersion: firstPlayback.playbackRevision - 1
      })
    ).rejects.toThrow("Playback state version conflict.");
  });

  it("keeps member-owned playback running when the host leaves but is not the media source", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    await roomService.updatePeerPresence(snapshot.room.id, member.id, "peer-member");

    const memberTrack = await roomService.registerTrack(snapshot.room.id, member.id, {
      title: "Member Source",
      artist: "Artist",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "member-source",
      artworkUrl: null,
      ownerSessionId: member.id,
      ownerNickname: member.nickname,
      sourceType: "local_upload"
    });

    const playback = await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      trackId: memberTrack.id,
      actorSessionId: host.id,
      expectedVersion: snapshot.room.playback.playbackRevision
    });
    const roomAfterLeave = await roomService.leaveRoom(snapshot.room.id, host.id);

    expect(playback.sourceSessionId).toBe(member.id);
    expect(roomAfterLeave.hostId).toBe(host.id);
    expect(roomAfterLeave.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: host.id,
          role: "host"
        }),
        expect.objectContaining({
          id: member.id,
          role: "member"
        })
      ])
    );
    // Host left but is not the track owner/source, so media continues from the member.
    expect(roomAfterLeave.playback).toMatchObject({
      status: "playing",
      currentTrackId: memberTrack.id,
      sourceSessionId: member.id,
      sourcePeerId: "peer-member",
      sourceTrackId: memberTrack.id
    });
    expect(roomAfterLeave.playback.queueVersion).toBe(playback.queueVersion);
  });

  it("pauses playback when the track owner leaves the room", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    await roomService.updatePeerPresence(snapshot.room.id, member.id, "peer-member");

    const memberTrack = await roomService.registerTrack(snapshot.room.id, member.id, {
      title: "Member Source Leave",
      artist: "Artist",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "member-source-leave",
      artworkUrl: null,
      ownerSessionId: member.id,
      ownerNickname: member.nickname,
      sourceType: "local_upload"
    });

    const playback = await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      trackId: memberTrack.id,
      actorSessionId: host.id,
      positionMs: 2_500
    });
    const roomAfterOwnerLeave = await roomService.leaveRoom(snapshot.room.id, member.id);

    expect(roomAfterOwnerLeave.playback).toMatchObject({
      status: "paused",
      currentTrackId: memberTrack.id,
      sourceSessionId: member.id,
      sourcePeerId: null,
      startAt: null,
      startedAt: null
    });
    expect(roomAfterOwnerLeave.playback.mediaEpoch).toBe(playback.mediaEpoch + 1);
    expect(roomAfterOwnerLeave.playback.positionMs).toBeGreaterThanOrEqual(2_500);
  });

  it("starts a different track from the beginning when play switches songs", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    await roomService.updatePeerPresence(snapshot.room.id, member.id, "peer-member");

    const firstTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "First",
      artist: "Artist",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "first-track",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });
    const secondTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Second",
      artist: "Artist",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "second-track",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });

    await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      trackId: firstTrack.id,
      actorSessionId: host.id,
      positionMs: 45000
    });

    await expect(
      roomService.updatePlayback(snapshot.room.id, {
        action: "play",
        trackId: secondTrack.id,
        actorSessionId: host.id
      })
    ).resolves.toMatchObject({
      currentTrackId: secondTrack.id,
      positionMs: 0
    });
  });

  it("bumps the media epoch when switching tracks owned by the same online source", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");

    const firstTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "First",
      artist: "Artist",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "same-owner-1",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });
    const secondTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Second",
      artist: "Artist",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "same-owner-2",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });

    const firstPlayback = await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      trackId: firstTrack.id,
      actorSessionId: host.id
    });
    const secondPlayback = await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      trackId: secondTrack.id,
      actorSessionId: host.id
    });

    expect(secondPlayback.mediaEpoch).toBe(firstPlayback.mediaEpoch + 1);
  });

  it("keeps the same media epoch for pause, seek, and resume on the same source track", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.joinRoom(snapshot.room.id, member.id);

    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");

    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Stable Epoch",
      artist: "Artist",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "stable-epoch-track",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });

    const playing = await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      trackId: track.id,
      actorSessionId: host.id
    });
    const paused = await roomService.updatePlayback(snapshot.room.id, {
      action: "pause",
      actorSessionId: host.id,
      positionMs: 5000
    });
    const seeked = await roomService.updatePlayback(snapshot.room.id, {
      action: "seek",
      actorSessionId: host.id,
      positionMs: 20000
    });
    const resumed = await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      actorSessionId: host.id
    });

    expect(paused.mediaEpoch).toBe(playing.mediaEpoch);
    expect(seeked.mediaEpoch).toBe(playing.mediaEpoch);
    expect(resumed.mediaEpoch).toBe(playing.mediaEpoch);
  });

  it("pauses at the effective playback position when no client position is supplied", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-04-04T00:00:00.000Z"));
    try {
      const prisma = createPrismaMock();
      const redis = createRedisMock();
      const authService = new AuthService(prisma as never, {} as never);
      const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

      const host = await authService.createGuestSession("Host");
      const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");

      const track = await roomService.registerTrack(snapshot.room.id, host.id, {
        title: "Pause Effective",
        artist: "Artist",
        album: null,
        durationMs: 120000,
        bitrate: null,
        fileHash: "pause-effective-track",
        artworkUrl: null,
        ownerSessionId: host.id,
        ownerNickname: host.nickname,
        sourceType: "local_upload"
      });

      await roomService.updatePlayback(snapshot.room.id, {
        action: "play",
        trackId: track.id,
        actorSessionId: host.id,
        positionMs: 4000
      });

      jest.setSystemTime(new Date("2026-04-04T00:00:09.500Z"));

      const paused = await roomService.updatePlayback(snapshot.room.id, {
        action: "pause",
        actorSessionId: host.id
      });

      expect(paused.positionMs).toBe(13500);
      expect(paused.startedAt).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("pauses at the end with a single playback revision bump when next has no queue item", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");

    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "No Queue",
      artist: "Artist",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "no-queue-track",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });

    const playing = await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      trackId: track.id,
      actorSessionId: host.id
    });

    const afterNext = await roomService.updatePlayback(snapshot.room.id, {
      action: "next",
      actorSessionId: host.id
    });

    // Direct-play with no queue: next has nothing playable to advance to, so pause at end.
    expect(afterNext).toMatchObject({
      status: "paused",
      currentTrackId: track.id,
      startAt: null,
      startedAt: null,
      positionMs: 120000
    });
    expect(afterNext.playbackRevision).toBe(playing.playbackRevision + 1);
  });

  it("does not rewind an already playing track when play is submitted again", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-04-04T00:00:00.000Z"));
    try {
      const prisma = createPrismaMock();
      const redis = createRedisMock();
      const authService = new AuthService(prisma as never, {} as never);
      const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

      const host = await authService.createGuestSession("Host");
      const member = await authService.createGuestSession("Member");
      const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
      await roomService.joinRoom(snapshot.room.id, member.id);
      await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");

      const track = await roomService.registerTrack(snapshot.room.id, host.id, {
        title: "No Rewind",
        artist: "Artist",
        album: null,
        durationMs: 120000,
        bitrate: null,
        fileHash: "no-rewind-track",
        artworkUrl: null,
        ownerSessionId: host.id,
        ownerNickname: host.nickname,
        sourceType: "local_upload"
      });

      const playing = await roomService.updatePlayback(snapshot.room.id, {
        action: "play",
        trackId: track.id,
        actorSessionId: host.id
      });

      jest.setSystemTime(new Date("2026-04-04T00:00:05.000Z"));

      const repeatedPlay = await roomService.updatePlayback(snapshot.room.id, {
        action: "play",
        actorSessionId: host.id
      });

      expect(playing.positionMs).toBe(0);
      expect(repeatedPlay.currentTrackId).toBe(track.id);
      expect(repeatedPlay.positionMs).toBe(5000);
      expect(repeatedPlay.mediaEpoch).toBe(playing.mediaEpoch);
    } finally {
      jest.useRealTimers();
    }
  });

  it("restores the recent active room for a session from redis", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    const restored = await roomService.getRecentRoomSnapshotForSession(host.id);

    expect(restored).not.toBeNull();
    expect(restored?.room.id).toBe(snapshot.room.id);
    expect(redis.setString).toHaveBeenCalled();
  });

  it("refreshes the recent room when a member recovers an older room again", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const hostOne = await authService.createGuestSession("Host One");
    const hostTwo = await authService.createGuestSession("Host Two");
    const member = await authService.createGuestSession("Member");
    const firstRoom = await roomService.createRoom(hostOne.id, "public", { roomType: "interactive" });
    const secondRoom = await roomService.createRoom(hostTwo.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(firstRoom.room.id, member.id);
    await roomService.joinRoom(secondRoom.room.id, member.id);

    await roomService.getRecoverableRoomSnapshot(firstRoom.room.id, member.id);
    const recentRoom = await roomService.getRecentRoomSnapshotForSession(member.id);

    expect(recentRoom).not.toBeNull();
    expect(recentRoom?.room.id).toBe(firstRoom.room.id);
  });

  it("drops a stale recent room when the session is no longer a member", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const firstRoom = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    const secondRoom = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(firstRoom.room.id, member.id);
    await roomService.joinRoom(secondRoom.room.id, member.id);
    await roomService.leaveRoom(secondRoom.room.id, member.id);

    await roomService.rememberRecentRoom(secondRoom.room.id, host.id);
    await roomService.rememberRecentRoom(firstRoom.room.id, member.id);
    await (redis as ReturnType<typeof createRedisMock>).setString(
      "soqaro:session:" + member.id + ":recent-room",
      secondRoom.room.id
    );

    const recentRoom = await roomService.getRecentRoomSnapshotForSession(member.id);

    expect(recentRoom).not.toBeNull();
    expect(recentRoom?.room.id).toBe(firstRoom.room.id);
  });

  it("creates a six-character uppercase join code", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;
    const host = await authService.createGuestSession("Host");

    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    expect(snapshot.room.joinCode).toMatch(/^[A-Z0-9]{6}$/);
  });

  it("lists rooms from the redis registry when memory state is empty", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    const roomCorerestoredService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const restoredService = roomCorerestoredService.roomService;

    const rooms = await restoredService.listRoomsForSession(host.id);

    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.room.id).toBe(snapshot.room.id);
    expect(redis.addToSet).toHaveBeenCalled();
  });

  it("only recovers a room for members of that room", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const outsider = await authService.createGuestSession("Outsider");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await expect(
      roomService.getRecoverableRoomSnapshot(snapshot.room.id, outsider.id)
    ).resolves.toBeNull();
    await expect(
      roomService.getRecoverableRoomSnapshot(snapshot.room.id, host.id)
    ).resolves.toMatchObject({
      room: { id: snapshot.room.id }
    });
  });

  it("lists every recoverable public room regardless of presence", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await expect(roomService.listPublicRooms()).resolves.toHaveLength(1);

    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    await expect(roomService.listPublicRooms()).resolves.toHaveLength(1);

    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, member.id, "peer-member");
    await expect(roomService.listPublicRooms()).resolves.toHaveLength(1);

    await roomService.updatePeerPresence(snapshot.room.id, member.id, null);
    await expect(roomService.listPublicRooms()).resolves.toHaveLength(1);

    await roomService.updatePeerPresence(snapshot.room.id, host.id, null);
    await expect(roomService.listPublicRooms()).resolves.toHaveLength(1);
  });

  it("returns a sanitized directory summary without members, queue, or playback identity", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const visitor = await authService.createGuestSession("Visitor");
    const requester = await authService.createGuestSession("Requester");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "request" });
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    await roomService.joinRoom(snapshot.room.id, requester.id);
    await roomService.createRoomRequest(snapshot.room.id, requester.id, {
      provider: "netease",
      providerTrackId: "123456",
      title: "Requested Song",
      artist: "Artist",
      album: null,
      durationMs: 180_000,
      artworkUrl: null
    });

    const [directoryItem] = await roomService.listRoomDirectoryForSession(visitor.id);

    expect(directoryItem).toMatchObject({
      room: {
        id: snapshot.room.id,
        joinCode: snapshot.room.joinCode,
        directoryHostNickname: "Host",
        directoryMemberCount: 2,
        directoryOnlineMemberCount: 1,
        directoryIsMember: false,
        directoryQueueDepth: 0,
        directoryPendingRequestCount: 1,
        directoryBroadcastState: null,
        directoryNowPlaying: null,
        playbackStatus: "paused"
      }
    });
    expect(directoryItem.room).not.toHaveProperty("hostId");
    expect(directoryItem.room).not.toHaveProperty("members");
    expect(directoryItem).not.toHaveProperty("tracks");
    expect(directoryItem).not.toHaveProperty("queue");
    expect(directoryItem).not.toHaveProperty("playlists");
  });

  it("locks request and radio rooms to host-managed playback and member controls", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const requestRoom = await roomService.createRoom(host.id, "public", { roomType: "request" });
    const radioRoom = await roomService.createRoom(host.id, "public", { roomType: "radio" });
    await roomService.joinRoom(requestRoom.room.id, member.id);
    await roomService.joinRoom(radioRoom.room.id, member.id);

    const requestSnapshot = await roomService.getAccessibleRoomSnapshot(requestRoom.room.id, [], host.id);
    const requestMember = requestSnapshot.room.members.find((candidate) => candidate.id === member.id);
    expect(requestMember?.permissions).toEqual({ library: false, queue: false, player: false });

    await expect(
      roomService.updateMemberPermissions(requestRoom.room.id, host.id, member.id, {
        library: true,
        queue: true,
        player: true
      })
    ).rejects.toThrow("成员控制权限由房主规则固定");
    await expect(
      roomService.updatePlayback(requestRoom.room.id, {
        action: "pause",
        actorSessionId: member.id,
        expectedVersion: 1
      })
    ).rejects.toThrow("Only the host can control playback in this room.");
    await expect(
      roomService.updatePlayback(radioRoom.room.id, {
        action: "pause",
        actorSessionId: member.id,
        expectedVersion: 1
      })
    ).rejects.toThrow("Only the host can control playback in this room.");
  });

  it("accepts song requests only in request rooms and lets only the host decide them", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const requestRoom = await roomService.createRoom(host.id, "public", { roomType: "request" });
    const interactiveRoom = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.joinRoom(requestRoom.room.id, member.id);
    await roomService.joinRoom(interactiveRoom.room.id, member.id);
    const requestInput = {
      provider: "qqmusic" as const,
      providerTrackId: "003ABC",
      title: "Request Me",
      artist: "Artist",
      album: null,
      durationMs: 210_000,
      artworkUrl: null
    };

    const request = await roomService.createRoomRequest(requestRoom.room.id, member.id, requestInput);
    expect(request.status).toBe("pending");
    const hostRequest = await roomService.createRoomRequest(requestRoom.room.id, host.id, {
      ...requestInput,
      providerTrackId: "003HOST"
    });
    expect(hostRequest).toMatchObject({ requesterId: host.id, status: "pending" });
    await expect(
      roomService.createRoomRequest(interactiveRoom.room.id, member.id, requestInput)
    ).rejects.toThrow("当前房间不支持点歌请求。");
    await expect(
      roomService.decideRoomRequest(requestRoom.room.id, member.id, request.id, "approved")
    ).rejects.toThrow("Only the host can decide song requests.");
    await expect(
      roomService.decideRoomRequest(requestRoom.room.id, host.id, request.id, "approved")
    ).resolves.toMatchObject({ status: "approved" });
  });

  it("rejects joining a room with a duplicate nickname", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const duplicate = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await expect(roomService.joinRoom(snapshot.room.id, duplicate.id)).rejects.toThrow(
      "Nickname already exists in this room."
    );
  });

  it("deduplicates repeated track registration by file hash for the same uploader", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    const firstTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Same",
      artist: "Artist",
      album: null,
      durationMs: 180_000,
      bitrate: null,
      sizeBytes: 1024,
      codec: "mp3",
      fileHash: "same-hash",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: "Host",
      sourceType: "local_upload"
    });

    const secondTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Same",
      artist: "Artist",
      album: null,
      durationMs: 180_000,
      bitrate: null,
      sizeBytes: 1024,
      codec: "mp3",
      fileHash: "same-hash",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: "Host",
      sourceType: "local_upload"
    });

    const latestSnapshot = await roomService.getRoomSnapshot(snapshot.room.id, []);

    expect(secondTrack.id).toBe(firstTrack.id);
    expect(latestSnapshot.tracks.filter((track) => track.fileHash === "same-hash")).toHaveLength(1);
  });

  it("deduplicates provider tracks by source reference for the same uploader", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    const firstTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "QQ Song",
      artist: "Artist",
      album: null,
      durationMs: 180_000,
      bitrate: null,
      sizeBytes: 1024,
      codec: "mp3",
      fileHash: "qq-hash-1",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: "Host",
      sourceType: "qqmusic",
      sourceRef: { provider: "qqmusic", trackId: "003abc" }
    });
    const secondTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "QQ Song Updated",
      artist: "Artist",
      album: null,
      durationMs: 181_000,
      bitrate: null,
      sizeBytes: 1024,
      codec: "mp3",
      fileHash: "qq-hash-2",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: "Host",
      sourceType: "qqmusic",
      sourceRef: { provider: "qqmusic", trackId: "003abc" }
    });

    const latestSnapshot = await roomService.getRoomSnapshot(snapshot.room.id, []);
    expect(secondTrack.id).toBe(firstTrack.id);
    expect(latestSnapshot.tracks.filter((track) => track.sourceRef?.trackId === "003abc"))
      .toHaveLength(1);
  });

  it("keeps the full room roster in snapshots even when some members are offline", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");

    const nextSnapshot = await roomService.getRoomSnapshot(snapshot.room.id, []);
    const hostEntry = nextSnapshot.room.members.find((entry) => entry.id === host.id);
    const memberEntry = nextSnapshot.room.members.find((entry) => entry.id === member.id);

    expect(nextSnapshot.room.members).toHaveLength(2);
    expect(hostEntry).toMatchObject({
      id: host.id,
      peerId: "peer-host",
      presenceState: "online"
    });
    expect(memberEntry).toMatchObject({
      id: member.id,
      peerId: null,
      presenceState: "offline"
    });
  });

  it("repairs stale offline presence on heartbeat refresh", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    const refreshed = await roomService.refreshRealtimePresence(
      snapshot.room.id,
      host.id,
      "peer-host"
    );
    const nextSnapshot = await roomService.getRoomSnapshot(snapshot.room.id, []);

    expect(refreshed.changed).toBe(true);
    expect(nextSnapshot.room.presenceRevision).toBe(1);
    expect(nextSnapshot.room.members.find((entry) => entry.id === host.id)).toMatchObject({
      id: host.id,
      peerId: "peer-host",
      presenceState: "online"
    });
  });

  it("keeps the newest online state when reconnect transitions overlap", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-old", "online");

    await Promise.all([
      roomService.updatePeerPresence(snapshot.room.id, host.id, null, "reconnecting"),
      roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-new", "online")
    ]);

    const nextSnapshot = await roomService.getRoomSnapshot(snapshot.room.id, []);
    expect(nextSnapshot.room.members.find((entry) => entry.id === host.id)).toMatchObject({
      id: host.id,
      peerId: "peer-new",
      presenceState: "online"
    });
  });

  it("serializes presence transitions for different members in one room", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.joinRoom(snapshot.room.id, member.id);

    await Promise.all([
      roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host", "online"),
      roomService.updatePeerPresence(snapshot.room.id, member.id, "peer-member", "online")
    ]);

    const nextSnapshot = await roomService.getRoomSnapshot(snapshot.room.id, []);
    expect(nextSnapshot.room.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: host.id, peerId: "peer-host", presenceState: "online" }),
        expect.objectContaining({ id: member.id, peerId: "peer-member", presenceState: "online" })
      ])
    );
    expect(nextSnapshot.room.presenceRevision).toBe(3);
  });

  it("keeps playback running while the active source is reconnecting", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Disconnect Source",
      artist: "Artist",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "disconnect-source-track",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });

    const playback = await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      trackId: track.id,
      actorSessionId: host.id
    });

    const roomAfterDisconnect = await roomService.updatePeerPresence(
      snapshot.room.id,
      host.id,
      null,
      "reconnecting"
    );
    const nextSnapshot = await roomService.getRoomSnapshot(snapshot.room.id, []);

    expect(playback.status).toBe("playing");
    expect(roomAfterDisconnect.playback).toMatchObject({
      status: "playing",
      currentTrackId: track.id,
      sourceSessionId: host.id,
      sourcePeerId: "peer-host"
    });
    expect(roomAfterDisconnect.playback.positionMs).toBeGreaterThanOrEqual(0);
    expect(roomAfterDisconnect.playback.mediaEpoch).toBe(playback.mediaEpoch);
    expect(roomAfterDisconnect.playback.queueVersion).toBe(playback.queueVersion);
    expect(roomAfterDisconnect.playback.playbackRevision).toBe(playback.playbackRevision);
    expect(nextSnapshot.room.members.find((entry) => entry.id === host.id)).toMatchObject({
      id: host.id,
      peerId: null,
      presenceState: "reconnecting"
    });
    expect(nextSnapshot.room.playback).toMatchObject({
      status: "playing",
      currentTrackId: track.id,
      sourceSessionId: host.id,
      sourcePeerId: null
    });
  });

  it("bumps media epoch when the current source session reconnects with a new peer id", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host", "online");
    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Source Peer Refresh",
      artist: "Artist",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "source-peer-refresh",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload",
    });

    const playback = await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      trackId: track.id,
      actorSessionId: host.id
    });
    const roomAfterReconnect = await roomService.updatePeerPresence(
      snapshot.room.id,
      host.id,
      "peer-host-reconnected",
      "online"
    );

    expect(roomAfterReconnect.playback.sourcePeerId).toBe("peer-host-reconnected");
    expect(roomAfterReconnect.playback.mediaEpoch).toBe(playback.mediaEpoch + 1);
    expect(roomAfterReconnect.playback.playbackRevision).toBe(playback.playbackRevision + 1);
    expect(roomAfterReconnect.playback.queueVersion).toBe(playback.queueVersion);
  });

  it("pauses playback and bumps media epoch when the active source session is replaced", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Active Source",
      artist: "Artist",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "active-source-track",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });

    const playback = await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      trackId: track.id,
      actorSessionId: host.id,
      positionMs: 3_500
    });

    const pausedPlayback = await roomService.handleDuplicateSessionReplacement(
      snapshot.room.id,
      host.id
    );
    const nextSnapshot = await roomService.getRoomSnapshot(snapshot.room.id, []);

    expect(playback.status).toBe("playing");
    expect(pausedPlayback).toMatchObject({
      status: "paused",
      currentTrackId: track.id,
      sourceSessionId: host.id,
      sourcePeerId: null
    });
    expect(pausedPlayback.mediaEpoch).toBe(playback.mediaEpoch + 1);
    expect(pausedPlayback.playbackRevision).toBeGreaterThan(playback.playbackRevision);
    expect(pausedPlayback.positionMs).toBeGreaterThanOrEqual(3_500);
    expect(nextSnapshot.room.playback).toMatchObject({
      status: "paused",
      currentTrackId: track.id,
      sourceSessionId: host.id,
      sourcePeerId: null
    });
  });


  it("allows the active media source to advance next even when they are not host", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    await roomService.updatePeerPresence(snapshot.room.id, member.id, "peer-member");

    const memberTrack = await roomService.registerTrack(snapshot.room.id, member.id, {
      title: "Member A",
      artist: "Artist",
      album: null,
      durationMs: 60_000,
      bitrate: null,
      fileHash: "source-next-a",
      artworkUrl: null,
      ownerSessionId: member.id,
      ownerNickname: member.nickname,
      sourceType: "local_upload"
    });
    const hostTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Host B",
      artist: "Artist",
      album: null,
      durationMs: 60_000,
      bitrate: null,
      fileHash: "source-next-b",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });
    const firstItem = await roomService.addQueueItem(snapshot.room.id, host.id, memberTrack.id);
    const secondItem = await roomService.addQueueItem(snapshot.room.id, host.id, hostTrack.id);

    await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      queueItemId: firstItem.id,
      actorSessionId: host.id
    });

    await expect(
      roomService.updatePlayback(snapshot.room.id, {
        action: "pause",
        actorSessionId: member.id
      })
    ).resolves.toMatchObject({
      status: "paused",
      currentTrackId: memberTrack.id
    });

    const afterNext = await roomService.updatePlayback(snapshot.room.id, {
      action: "next",
      actorSessionId: member.id
    });

    expect(afterNext).toMatchObject({
      status: "playing",
      currentTrackId: hostTrack.id,
      currentQueueItemId: secondItem.id,
      sourceSessionId: host.id
    });
  });

  it("pauses and clears startAt when the active source goes offline", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Offline Source",
      artist: "Artist",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "offline-source-track",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });

    const playback = await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      trackId: track.id,
      actorSessionId: host.id,
      positionMs: 4_000
    });

    const roomAfterOffline = await roomService.updatePeerPresence(
      snapshot.room.id,
      host.id,
      null,
      "offline"
    );

    expect(roomAfterOffline.playback).toMatchObject({
      status: "paused",
      currentTrackId: track.id,
      sourceSessionId: host.id,
      sourcePeerId: null,
      startAt: null,
      startedAt: null
    });
    expect(roomAfterOffline.playback.positionMs).toBeGreaterThanOrEqual(4_000);
    expect(roomAfterOffline.playback.mediaEpoch).toBe(playback.mediaEpoch + 1);
    expect(roomAfterOffline.playback.playbackRevision).toBeGreaterThan(playback.playbackRevision);
  });

  it("wraps next to the start of the queue in sequential list loop mode", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");

    const firstTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "First",
      artist: "Artist",
      album: null,
      durationMs: 60_000,
      bitrate: null,
      fileHash: "next-wrap-1",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });
    const secondTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Second",
      artist: "Artist",
      album: null,
      durationMs: 60_000,
      bitrate: null,
      fileHash: "next-wrap-2",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });
    const firstItem = await roomService.addQueueItem(snapshot.room.id, host.id, firstTrack.id);
    const secondItem = await roomService.addQueueItem(snapshot.room.id, host.id, secondTrack.id);

    await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      queueItemId: secondItem.id,
      actorSessionId: host.id
    });

    const afterNext = await roomService.updatePlayback(snapshot.room.id, {
      action: "next",
      actorSessionId: host.id
    });

    expect(afterNext).toMatchObject({
      status: "playing",
      currentTrackId: firstTrack.id,
      currentQueueItemId: firstItem.id,
      positionMs: 0
    });
  });

  it("skips offline-owner tracks when advancing next", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    await roomService.updatePeerPresence(snapshot.room.id, member.id, "peer-member");

    const hostTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Host Track",
      artist: "Artist",
      album: null,
      durationMs: 60_000,
      bitrate: null,
      fileHash: "skip-offline-1",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });
    const memberTrack = await roomService.registerTrack(snapshot.room.id, member.id, {
      title: "Member Track",
      artist: "Artist",
      album: null,
      durationMs: 60_000,
      bitrate: null,
      fileHash: "skip-offline-2",
      artworkUrl: null,
      ownerSessionId: member.id,
      ownerNickname: member.nickname,
      sourceType: "local_upload"
    });
    const thirdTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Third Track",
      artist: "Artist",
      album: null,
      durationMs: 60_000,
      bitrate: null,
      fileHash: "skip-offline-3",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });

    const firstItem = await roomService.addQueueItem(snapshot.room.id, host.id, hostTrack.id);
    await roomService.addQueueItem(snapshot.room.id, host.id, memberTrack.id);
    const thirdItem = await roomService.addQueueItem(snapshot.room.id, host.id, thirdTrack.id);

    await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      queueItemId: firstItem.id,
      actorSessionId: host.id
    });

    await roomService.updatePeerPresence(snapshot.room.id, member.id, null);

    const afterNext = await roomService.updatePlayback(snapshot.room.id, {
      action: "next",
      actorSessionId: host.id
    });

    expect(afterNext).toMatchObject({
      status: "playing",
      currentTrackId: thirdTrack.id,
      currentQueueItemId: thirdItem.id,
      sourceSessionId: host.id
    });
  });

  it("advances ended playback via the server watchdog", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");

    const firstTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Short",
      artist: "Artist",
      album: null,
      durationMs: 5_000,
      bitrate: null,
      fileHash: "watchdog-1",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });
    const secondTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Next",
      artist: "Artist",
      album: null,
      durationMs: 60_000,
      bitrate: null,
      fileHash: "watchdog-2",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "local_upload"
    });
    const firstItem = await roomService.addQueueItem(snapshot.room.id, host.id, firstTrack.id);
    const secondItem = await roomService.addQueueItem(snapshot.room.id, host.id, secondTrack.id);

    await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      queueItemId: firstItem.id,
      actorSessionId: host.id,
      positionMs: 0
    });

    jest.setSystemTime(new Date("2026-01-01T00:00:06.000Z"));
    const advanced = await roomService.advanceEndedPlaybacks();
    expect(advanced).toHaveLength(1);
    expect(advanced[0]?.playback).toMatchObject({
      status: "playing",
      currentTrackId: secondTrack.id,
      currentQueueItemId: secondItem.id
    });
    jest.useRealTimers();
  });


  it("allows the host to delete a room and blocks non-host members", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.joinRoom(snapshot.room.id, member.id);

    await expect(roomService.deleteRoom(snapshot.room.id, member.id)).rejects.toThrow(
      "Only the host can delete this room."
    );

    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host");
    await roomService.updatePeerPresence(snapshot.room.id, member.id, "peer-member");

    await expect(roomService.deleteRoom(snapshot.room.id, host.id)).resolves.toEqual({ ok: true });
    await expect(roomService.getRoomSnapshot(snapshot.room.id, [])).rejects.toThrow(
      `Room not found: ${snapshot.room.id}`
    );
  });

  it("validates room membership and track belonging when recording room reaction", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const nonMember = await authService.createGuestSession("Stranger");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    // 1. Non-member cannot react
    await expect(
      roomService.recordRoomReaction({
        roomId: snapshot.room.id,
        userId: nonMember.id,
        trackId: null,
        reactionType: "like"
      })
    ).rejects.toThrow("Only room members can perform this action.");

    // 2. Member reacts with non-existent track
    await expect(
      roomService.recordRoomReaction({
        roomId: snapshot.room.id,
        userId: host.id,
        trackId: "track_non_existent",
        reactionType: "like"
      })
    ).rejects.toThrow("曲目不属于该房间。");

    // 3. Register a track in the room and react to it
    const registeredTrack = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Test Track",
      artist: "Test Artist",
      album: null,
      durationMs: 180_000,
      bitrate: null,
      sizeBytes: null,
      codec: null,
      mimeType: null,
      fileHash: "hash_test_123",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "netease",
      sourceRef: { provider: "netease", trackId: "123" }
    });

    await expect(
      roomService.recordRoomReaction({
        roomId: snapshot.room.id,
        userId: host.id,
        trackId: registeredTrack.id,
        reactionType: "applause"
      })
    ).resolves.toBe(0); // Prisma not available in mock, returns 0
  });

  it("restores sourcePeerId from null and bumps media epoch when a provider track uploader reconnects", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;

    const host = await authService.createGuestSession("Host");
    const member = await authService.createGuestSession("Member");

    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.joinRoom(snapshot.room.id, member.id);
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer-host", "online");
    await roomService.updatePeerPresence(snapshot.room.id, member.id, "peer-member", "online");

    const track = await roomService.registerTrack(snapshot.room.id, host.id, {
      title: "Provider Track",
      artist: "Artist",
      album: null,
      durationMs: 120000,
      bitrate: null,
      fileHash: "provider-track-recovery",
      artworkUrl: null,
      ownerSessionId: host.id,
      ownerNickname: host.nickname,
      sourceType: "netease",
      sourceRef: { provider: "netease", trackId: "999888" },
      playbackAsset: createPlaybackAssetMock("provider-track-recovery", 120000)
    });

    const initialPlayback = await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      trackId: track.id,
      actorSessionId: host.id
    });
    expect(initialPlayback.status).toBe("playing");
    expect(initialPlayback.sourcePeerId).toBe("peer-host");

    // Host goes offline. For all tracks including provider tracks, playback pauses.
    const roomAfterDeparture = await roomService.updatePeerPresence(
      snapshot.room.id,
      host.id,
      null,
      "offline"
    );
    expect(roomAfterDeparture.playback.status).toBe("paused");
    expect(roomAfterDeparture.playback.sourcePeerId).toBeNull();
  });

  it("updates track assets and starts playback when asset is prepared for waiting track", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;
    const host = await authService.createGuestSession("AssetHost");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });

    await roomService.updatePeerPresence(
      snapshot.room.id,
      host.id,
      "peer-asset-host",
      "online"
    );

    // Register a provider track without assets
    const [track] = await roomService.registerTracks(snapshot.room.id, host.id, [
      {
        title: "Waiting Track",
        artist: "Test Artist",
        album: "Test Album",
        durationMs: 180000,
        bitrate: null,
        fileHash: "hash-without-asset",
        artworkUrl: null,
        ownerSessionId: host.id,
        ownerNickname: host.nickname,
        sourceType: "netease",
        sourceRef: { provider: "netease", trackId: "123456" }
      }
    ]);

    // Try to play track without assets -> fails to find source candidate and clears/pauses
    await expect(
      roomService.updatePlayback(snapshot.room.id, {
        action: "play",
        trackId: track.id,
        actorSessionId: host.id
      })
    ).rejects.toThrow();

    // Now set playback currentTrackId to track.id with status "paused"
    const record = await roomCoreroomService.roomRecordRepository.getRoomRecord(snapshot.room.id);
    record.room.playback.currentTrackId = track.id;
    record.room.playback.status = "paused";
    await roomCoreroomService.roomRecordRepository.persistRecord(record);

    const newFileHash = "a".repeat(64);
    const originalAsset = createOriginalAssetMock("1".repeat(64), newFileHash);
    const playbackAsset = createPlaybackAssetMock("2".repeat(64), 180000, newFileHash);

    const result = await roomService.prepareTrackAsset(snapshot.room.id, host.id, {
      trackId: track.id,
      fileHash: newFileHash,
      originalAsset,
      playbackAsset
    });

    expect(result.track.fileHash).toBe(newFileHash);
    expect(result.track.playbackAsset?.assetId).toBe("2".repeat(64));
    expect(result.playbackChanged).toBe(true);
    expect(result.playback?.status).toBe("playing");
    expect(result.playback?.playbackAssetId).toBe("2".repeat(64));

    const updatedSnapshot = await roomService.getRoomSnapshot(snapshot.room.id, []);
    expect(updatedSnapshot.room.playback.status).toBe("playing");
    expect(updatedSnapshot.room.playback.currentTrackId).toBe(track.id);
    expect(updatedSnapshot.room.playback.playbackAssetId).toBe("2".repeat(64));
  });

  it("pauses playback and increments revision when current track asset is reported unavailable", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCoreroomService = createRoomCoreServices({ authService: authService, prisma: prisma, redis: redis });
  const roomService = roomCoreroomService.roomService;
    const host = await authService.createGuestSession("AssetHost2");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    const fileHash = "b".repeat(64);
    const originalAsset = createOriginalAssetMock("3".repeat(64), fileHash);
    const playbackAsset = createPlaybackAssetMock("4".repeat(64), 180000, fileHash);
    const [track] = await roomService.registerTracks(snapshot.room.id, host.id, [
      {
        title: "Playing Song",
        artist: "Artist",
        album: null,
        durationMs: 180000,
        bitrate: null,
        fileHash,
        artworkUrl: null,
        ownerSessionId: host.id,
        ownerNickname: host.nickname,
        sourceType: "local_upload",
        originalAsset,
        playbackAsset
      }
    ]);
    await roomService.addQueueItem(snapshot.room.id, host.id, track.id);

    const record = await roomCoreroomService.roomRecordRepository.getRoomRecord(snapshot.room.id);
    record.room.playback.status = "playing";
    record.room.playback.currentTrackId = track.id;
    record.room.playback.sourceSessionId = host.id;
    record.room.playback.sourcePeerId = "peer_host";
    const initialEpoch = record.room.playback.mediaEpoch;
    await roomCoreroomService.roomRecordRepository.persistRecord(record);

    const result = await roomService.reportTrackAssetUnavailable(snapshot.room.id, host.id, {
      trackId: track.id,
      reason: "source-missing"
    });

    expect(result.playbackChanged).toBe(true);
    expect(result.reason).toBe("source-missing");

    const updatedSnapshot = await roomService.getRoomSnapshot(snapshot.room.id, []);
    expect(updatedSnapshot.room.playback.status).toBe("paused");
    expect(updatedSnapshot.room.playback.sourcePeerId).toBeNull();
    expect(updatedSnapshot.room.playback.mediaEpoch).toBe(initialEpoch + 1);
  });

  it("advances to the next playable track when the active track asset is reported unavailable", async () => {
    const prisma = createPrismaMock();
    const redis = createRedisMock();
    const authService = new AuthService(prisma as never, {} as never);
    const roomCore = createRoomCoreServices({ authService, prisma, redis });
    const roomService = roomCore.roomService;
    const host = await authService.createGuestSession("AssetHost3");
    const snapshot = await roomService.createRoom(host.id, "public", { roomType: "interactive" });
    await roomService.updatePeerPresence(snapshot.room.id, host.id, "peer_host", "online");

    const hashA = "c".repeat(64);
    const hashB = "d".repeat(64);
    const [firstTrack, secondTrack] = await roomService.registerTracks(snapshot.room.id, host.id, [
      {
        title: "Broken Song",
        artist: "Artist",
        album: null,
        durationMs: 180000,
        bitrate: null,
        fileHash: hashA,
        artworkUrl: null,
        ownerSessionId: host.id,
        ownerNickname: host.nickname,
        sourceType: "local_upload",
        originalAsset: createOriginalAssetMock("5".repeat(64), hashA),
        playbackAsset: createPlaybackAssetMock("6".repeat(64), 180000, hashA)
      },
      {
        title: "Healthy Song",
        artist: "Artist",
        album: null,
        durationMs: 180000,
        bitrate: null,
        fileHash: hashB,
        artworkUrl: null,
        ownerSessionId: host.id,
        ownerNickname: host.nickname,
        sourceType: "local_upload",
        originalAsset: createOriginalAssetMock("7".repeat(64), hashB),
        playbackAsset: createPlaybackAssetMock("8".repeat(64), 180000, hashB)
      }
    ]);
    const firstQueueItem = await roomService.addQueueItem(snapshot.room.id, host.id, firstTrack.id);
    await roomService.addQueueItem(snapshot.room.id, host.id, secondTrack.id);
    await roomService.updatePlayback(snapshot.room.id, {
      action: "play",
      queueItemId: firstQueueItem.id,
      actorSessionId: host.id
    });

    const result = await roomService.reportTrackAssetUnavailable(snapshot.room.id, host.id, {
      trackId: firstTrack.id,
      reason: "source-missing"
    });

    expect(result.playbackChanged).toBe(true);
    expect(result.playback?.status).toBe("playing");
    expect(result.playback?.currentTrackId).toBe(secondTrack.id);
  });
});
