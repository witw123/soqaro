import { PlaylistController } from "./playlist.controller";
import { PlaylistService } from "./playlist.service";

function createPrismaMock() {
  return {
    isAvailable: jest.fn(() => false),
    playlist: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 })
    }
  };
}

describe("PlaylistService", () => {
  it("returns an empty list when ownerId is missing", async () => {
    const prisma = createPrismaMock();
    const roomService = {
      getTracks: jest.fn().mockResolvedValue([]),
      getQueue: jest.fn().mockResolvedValue([])
    };
    const service = new PlaylistService(roomService as never, prisma as never);

    await expect(service.listPlaylists()).resolves.toEqual([]);
  });

  it("only allows the owner to fetch a playlist by id", async () => {
    const prisma = createPrismaMock();
    const roomService = {
      getTracks: jest.fn().mockResolvedValue([]),
      getQueue: jest.fn().mockResolvedValue([])
    };
    const service = new PlaylistService(roomService as never, prisma as never);
    const playlist = await service.createPlaylist({
      ownerId: "guest_owner",
      title: "Tonight",
      trackIds: ["track_1"]
    });

    await expect(
      service.getPlaylistForOwner(playlist.id, "guest_other")
    ).rejects.toThrow("Only the playlist owner can access this playlist.");

    await expect(
      service.getPlaylistForOwner(playlist.id, "guest_owner")
    ).resolves.toMatchObject({
      id: playlist.id
    });
  });

  it("sanitizes persisted playlist JSON arrays before returning them", async () => {
    const prisma = createPrismaMock();
    prisma.isAvailable.mockReturnValue(true);
    prisma.playlist.findMany.mockResolvedValue([
      {
        id: "playlist_1",
        ownerId: "guest_owner",
        roomId: "room_1",
        title: "Persisted",
        description: null,
        coverUrl: null,
        tags: "bad-tags",
        isCollaborative: false,
        trackIds: ["track_1", 123, "", "track_2"],
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedAt: new Date("2026-07-01T00:00:01.000Z")
      }
    ]);
    const roomService = {
      getTracks: jest.fn().mockResolvedValue([]),
      getQueue: jest.fn().mockResolvedValue([])
    };
    const service = new PlaylistService(roomService as never, prisma as never);

    await expect(service.listPlaylists()).resolves.toEqual([
      expect.objectContaining({
        tags: [],
        trackIds: ["track_1", "track_2"]
      })
    ]);
  });

  it("isolates room playlists and does not leak other users' playlists with common tracks", async () => {
    const prisma = createPrismaMock();
    const roomService = {
      getTracks: jest.fn().mockResolvedValue([{ id: "common_track" }]),
      getQueue: jest.fn().mockResolvedValue([])
    };
    const service = new PlaylistService(roomService as never, prisma as never);

    // Create user A's private playlist (no roomId) containing common_track
    const userAPlaylist = await service.createPlaylist({
      ownerId: "user_a",
      title: "User A Private",
      trackIds: ["common_track"]
    });

    // Create room 1's playlist containing common_track
    const room1Playlist = await service.createPlaylist({
      ownerId: "user_a",
      roomId: "room_1",
      title: "Room 1 Playlist",
      trackIds: ["common_track"]
    });

    // Create room 2's playlist
    const room2Playlist = await service.createPlaylist({
      ownerId: "user_b",
      roomId: "room_2",
      title: "Room 2 Playlist",
      trackIds: ["common_track"]
    });

    // Room 1 should only see room 1's playlists
    const room1Results = await service.listPlaylistsForRoom("room_1");
    expect(room1Results.map((p) => p.id)).toEqual([room1Playlist.id]);
    expect(room1Results.map((p) => p.id)).not.toContain(userAPlaylist.id);
    expect(room1Results.map((p) => p.id)).not.toContain(room2Playlist.id);
  });

  it("allows clearing description and coverUrl to null via updatePlaylist", async () => {
    const prisma = createPrismaMock();
    const roomService = {
      getTracks: jest.fn().mockResolvedValue([]),
      getQueue: jest.fn().mockResolvedValue([])
    };
    const service = new PlaylistService(roomService as never, prisma as never);

    const playlist = await service.createPlaylist({
      ownerId: "owner_1",
      title: "My List",
      description: "Initial description",
      coverUrl: "https://example.com/cover.png"
    });

    expect(playlist.description).toBe("Initial description");
    expect(playlist.coverUrl).toBe("https://example.com/cover.png");

    const updated = await service.updatePlaylist(playlist.id, {
      ownerId: "owner_1",
      description: null,
      coverUrl: null
    });

    expect(updated.description).toBeNull();
    expect(updated.coverUrl).toBeNull();

    const fetched = await service.getPlaylist(playlist.id);
    expect(fetched.description).toBeNull();
    expect(fetched.coverUrl).toBeNull();
  });

  it("preserves in-memory state if database update fails", async () => {
    const prisma = createPrismaMock();
    prisma.isAvailable.mockReturnValue(true);
    prisma.playlist.upsert.mockResolvedValue({});
    prisma.playlist.update.mockRejectedValue(new Error("Database connection lost"));

    const roomService = {
      getTracks: jest.fn().mockResolvedValue([]),
      getQueue: jest.fn().mockResolvedValue([])
    };
    const service = new PlaylistService(roomService as never, prisma as never);

    const playlist = await service.createPlaylist({
      ownerId: "owner_1",
      title: "Original Title",
      description: "Original Description"
    });

    await expect(
      service.updatePlaylist(playlist.id, {
        ownerId: "owner_1",
        title: "New Title"
      })
    ).rejects.toThrow("Database connection lost");

    // Verify in-memory state was NOT dirtied
    const cached = await service.getPlaylist(playlist.id);
    expect(cached.title).toBe("Original Title");
  });

  it("caps the number of playlists per room at 100", async () => {
    const prisma = createPrismaMock();
    const roomService = {
      getTracks: jest.fn().mockResolvedValue([]),
      getQueue: jest.fn().mockResolvedValue([])
    };
    const service = new PlaylistService(roomService as never, prisma as never);

    for (let index = 0; index < 100; index += 1) {
      await service.createPlaylist({
        ownerId: `owner_${index}`,
        roomId: "room_cap",
        title: `Playlist ${index}`
      });
    }

    await expect(
      service.createPlaylist({
        ownerId: "owner_100",
        roomId: "room_cap",
        title: "Playlist 100"
      })
    ).rejects.toThrow("房间播放列表数量已达到上限。");
  });
});

describe("PlaylistController", () => {
  it("requires library permission when creating a room playlist", async () => {
    const playlistService = {
      createPlaylist: jest.fn(),
      listPlaylistsForRoom: jest.fn().mockResolvedValue([])
    };
    const roomService = {
      assertRoomPermission: jest.fn().mockRejectedValue(new Error("Forbidden")),
      touchRoomRevision: jest.fn()
    };
    const roomRealtimePublisher = {
      emitSnapshot: jest.fn()
    };
    const authService = {
      getAuthSessionByTokenOrThrow: jest.fn().mockResolvedValue({ userId: "guest_1" })
    };
    const controller = new PlaylistController(
      playlistService as never,
      roomService as never,
      roomRealtimePublisher as never,
      authService as never,
      undefined as never
    );

    await expect(
      controller.createPlaylist("token", {
        title: "Room Mix",
        roomId: "room_1"
      })
    ).rejects.toThrow("Forbidden");

    expect(roomService.assertRoomPermission).toHaveBeenCalledWith("room_1", "guest_1", "library");
    expect(playlistService.createPlaylist).not.toHaveBeenCalled();
  });
});
