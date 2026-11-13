import { Injectable, BadRequestException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Playlist } from "@soqaro/shared";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { RoomService } from "../room/room.service";

type PersistedPlaylistRecord = {
  id: string;
  ownerId: string;
  roomId?: string | null;
  title: string;
  description: string | null;
  coverUrl: string | null;
  tags: unknown;
  isCollaborative: boolean;
  trackIds: unknown;
  createdAt: Date;
  updatedAt: Date;
};

const maxPlaylistsPerUser = 1000;
const maxPlaylistsPerRoom = 100;

@Injectable()
export class PlaylistService {
  private readonly playlists = new Map<string, Playlist>();
  private readonly playlistRoomIds = new Map<string, string | null>();

  constructor(
    private readonly roomService: RoomService,
    private readonly prisma: PrismaService
  ) {}

  async listPlaylists(ownerId?: string) {
    if (this.prisma.isAvailable()) {
      const persisted = await this.prisma.playlist.findMany({
        where: {
          roomId: null,
          ...(ownerId ? { ownerId } : {})
        },
        orderBy: { updatedAt: "desc" }
      });

      const records = (persisted ?? []) as PersistedPlaylistRecord[];
      const playlists = records.map((item) => this.deserializePlaylist(item));
      records.forEach((item) => {
        this.playlistRoomIds.set(item.id, item.roomId ?? null);
      });
      playlists.forEach((playlist: Playlist) => this.playlists.set(playlist.id, playlist));
      return playlists;
    }

    const playlists = [...this.playlists.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );

    const nonRoomPlaylists = playlists.filter(
      (playlist) => this.playlistRoomIds.get(playlist.id) == null
    );

    return ownerId
      ? nonRoomPlaylists.filter((playlist) => playlist.ownerId === ownerId)
      : nonRoomPlaylists;
  }

  async listPlaylistsForRoom(roomId: string) {
    if (this.prisma.isAvailable()) {
      const persisted = await this.prisma.playlist.findMany({
        where: { roomId },
        orderBy: { updatedAt: "desc" }
      });

      const records = (persisted ?? []) as PersistedPlaylistRecord[];
      const playlists = records.map((item) => this.deserializePlaylist(item));
      records.forEach((item) => {
        this.playlistRoomIds.set(item.id, item.roomId ?? null);
      });
      playlists.forEach((playlist: Playlist) => this.playlists.set(playlist.id, playlist));
      return playlists;
    }

    const playlists = [...this.playlists.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );
    return playlists.filter((playlist) => this.playlistRoomIds.get(playlist.id) === roomId);
  }

  async createPlaylist(input: {
    ownerId: string;
    roomId?: string | null;
    title: string;
    description?: string | null;
    trackIds?: string[];
    tags?: string[];
    coverUrl?: string | null;
    isCollaborative?: boolean;
  }) {
    if (!input.title.trim()) {
      throw new BadRequestException("播放列表标题不能为空。");
    }
    const ownedCount = this.prisma.isAvailable()
      ? await this.prisma.playlist.count({ where: { ownerId: input.ownerId } })
      : [...this.playlists.values()].filter((playlist) => playlist.ownerId === input.ownerId).length;
    if (ownedCount >= maxPlaylistsPerUser) {
      throw new BadRequestException("播放列表数量已达到上限。");
    }
    if (input.roomId) {
      const roomPlaylists = await this.listPlaylistsForRoom(input.roomId);
      if (roomPlaylists.length >= maxPlaylistsPerRoom) {
        throw new BadRequestException("房间播放列表数量已达到上限。");
      }
    }

    const playlist: Playlist = {
      id: `playlist_${randomUUID()}`,
      ownerId: input.ownerId,
      title: input.title,
      description: input.description ?? null,
      coverUrl: input.coverUrl ?? null,
      tags: input.tags ?? [],
      isCollaborative: input.isCollaborative ?? false,
      trackIds: input.trackIds ?? [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (this.prisma.isAvailable()) {
      await this.prisma.playlist.upsert({
        where: { id: playlist.id },
        update: {
          ownerId: playlist.ownerId,
          roomId: input.roomId ?? null,
          title: playlist.title,
          description: playlist.description,
          coverUrl: playlist.coverUrl,
          tags: playlist.tags,
          isCollaborative: playlist.isCollaborative,
          trackIds: playlist.trackIds
        },
        create: {
          id: playlist.id,
          ownerId: playlist.ownerId,
          roomId: input.roomId ?? null,
          title: playlist.title,
          description: playlist.description,
          coverUrl: playlist.coverUrl,
          tags: playlist.tags,
          isCollaborative: playlist.isCollaborative,
          trackIds: playlist.trackIds,
          createdAt: new Date(playlist.createdAt),
          updatedAt: new Date(playlist.updatedAt)
        }
      });
    }

    this.playlists.set(playlist.id, playlist);
    this.playlistRoomIds.set(playlist.id, input.roomId ?? null);

    return playlist;
  }

  async createPlaylistFromRoom(input: {
    ownerId: string;
    roomId: string;
    title: string;
    description?: string | null;
  }) {
    const roomQueue = await this.roomService.getQueue(input.roomId);

    return this.createPlaylist({
      ownerId: input.ownerId,
      roomId: input.roomId,
      title: input.title,
      description: input.description,
      trackIds: roomQueue.map((item) => item.trackId)
    });
  }

  async updatePlaylist(
    playlistId: string,
    input: {
      ownerId: string;
      title?: string;
      description?: string | null;
      tags?: string[];
      coverUrl?: string | null;
      trackIds?: string[];
    }
  ) {
    const current = await this.getPlaylistOrThrow(playlistId);

    if (current.ownerId !== input.ownerId) {
      throw new Error("Only the playlist owner can update this playlist.");
    }

    const updated: Playlist = {
      ...current,
      title: input.title !== undefined ? input.title : current.title,
      description: input.description !== undefined ? input.description : current.description,
      coverUrl: input.coverUrl !== undefined ? input.coverUrl : current.coverUrl,
      tags: input.tags !== undefined ? input.tags : current.tags,
      trackIds: input.trackIds !== undefined ? input.trackIds : current.trackIds,
      updatedAt: new Date().toISOString()
    };

    if (this.prisma.isAvailable()) {
      await this.prisma.playlist.update({
        where: { id: updated.id },
        data: {
          title: updated.title,
          description: updated.description,
          coverUrl: updated.coverUrl,
          tags: updated.tags,
          trackIds: updated.trackIds
        }
      });
    }

    this.playlists.set(updated.id, updated);

    return updated;
  }

  async deletePlaylist(playlistId: string, ownerId: string) {
    const current = await this.getPlaylistOrThrow(playlistId);

    if (current.ownerId !== ownerId) {
      throw new Error("Only the playlist owner can delete this playlist.");
    }

    if (this.prisma.isAvailable()) {
      await this.prisma.playlist.deleteMany({
        where: { id: playlistId, ownerId }
      });
    }

    this.playlists.delete(playlistId);
    this.playlistRoomIds.delete(playlistId);

    return { ok: true };
  }

  async removeTrackFromPlaylists(trackId: string) {
    const playlists = await this.listPlaylists();
    const affectedPlaylists = playlists.filter((playlist) => playlist.trackIds.includes(trackId));

    const databaseAvailable = this.prisma.isAvailable();
    const databaseUpdates: Array<{ id: string; trackIds: string[] }> = [];

    for (const playlist of affectedPlaylists) {
      const nextTrackIds = playlist.trackIds.filter((id) => id !== trackId);
      const updated: Playlist = {
        ...playlist,
        trackIds: nextTrackIds,
        updatedAt: new Date().toISOString()
      };

      if (databaseAvailable) {
        databaseUpdates.push({ id: updated.id, trackIds: updated.trackIds });
      }

      this.playlists.set(updated.id, updated);
    }

    if (databaseUpdates.length > 0) {
      await Promise.all(
        databaseUpdates.map((update) =>
          this.prisma.playlist.update({
            where: { id: update.id },
            data: { trackIds: update.trackIds }
          })
        )
      );
    }
  }

  async deletePlaylistsForRoom(roomId: string) {
    if (this.prisma.isAvailable()) {
      await this.prisma.playlist.deleteMany({
        where: { roomId }
      });
    }

    const playlists = await this.listPlaylists();
    const roomPlaylists = playlists.filter((playlist) => this.playlistRoomIds.get(playlist.id) === roomId);

    for (const playlist of roomPlaylists) {
      this.playlists.delete(playlist.id);
      this.playlistRoomIds.delete(playlist.id);
    }

    return { ok: true };
  }

  async getPlaylist(playlistId: string) {
    return this.getPlaylistOrThrow(playlistId);
  }

  async getRoomIdForPlaylist(playlistId: string): Promise<string | null> {
    if (this.prisma.isAvailable()) {
      const persisted = await this.prisma.playlist.findUnique({
        where: { id: playlistId },
        select: { roomId: true }
      });
      return persisted?.roomId ?? null;
    }
    return this.playlistRoomIds.get(playlistId) ?? null;
  }

  async getPlaylistForOwner(playlistId: string, ownerId: string) {
    const playlist = await this.getPlaylistOrThrow(playlistId);

    if (playlist.ownerId !== ownerId) {
      throw new Error("Only the playlist owner can access this playlist.");
    }

    return playlist;
  }

  private deserializePlaylist(item: {
    id: string;
    ownerId: string;
    title: string;
    description: string | null;
    coverUrl: string | null;
    tags: unknown;
    isCollaborative: boolean;
    trackIds: unknown;
    createdAt: Date;
    updatedAt: Date;
  }): Playlist {
    return {
      id: item.id,
      ownerId: item.ownerId,
      title: item.title,
      description: item.description,
      coverUrl: item.coverUrl,
      tags: toStringList(item.tags),
      isCollaborative: item.isCollaborative,
      trackIds: toStringList(item.trackIds),
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString()
    };
  }

  private async getPlaylistOrThrow(playlistId: string) {
    const cached = this.playlists.get(playlistId);
    if (cached) {
      return cached;
    }

    if (this.prisma.isAvailable()) {
      const persisted = await this.prisma.playlist.findUnique({
        where: { id: playlistId }
      });

      if (persisted) {
        const playlist = this.deserializePlaylist(persisted);
        this.playlists.set(playlist.id, playlist);
        return playlist;
      }
    }

    throw new Error(`Playlist not found: ${playlistId}`);
  }
}

function toStringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}
