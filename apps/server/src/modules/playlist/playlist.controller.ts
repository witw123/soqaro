import { Body, Controller, Delete, Get, Headers, Ip, Param, Patch, Post, UnauthorizedException } from "@nestjs/common";
import {
  createPlaylistFromRoomRequestSchema,
  createPlaylistRequestSchema,
  importPlaylistToRoomRequestSchema,
  updatePlaylistRequestSchema
} from "@soqaro/shared";
import { parseRequestBody } from "../../common/validation/zod-validation";
import { AbuseProtectionService } from "../../common/security/abuse-protection.service";
import { AuthService } from "../auth/auth.service";
import { RoomRealtimePublisher } from "../room/services/room-realtime.publisher";
import { RoomService } from "../room/room.service";
import { PlaylistService } from "./playlist.service";

@Controller("v1/playlists")
export class PlaylistController {
  constructor(
    private readonly playlistService: PlaylistService,
    private readonly roomService: RoomService,
    private readonly roomRealtimePublisher: RoomRealtimePublisher,
    private readonly authService: AuthService,
    private readonly abuseProtection: AbuseProtectionService
  ) {}

  private async getCurrentUserId(sessionToken?: string) {
    try {
      const session = await this.authService.getAuthSessionByTokenOrThrow(sessionToken);
      return session.userId;
    } catch (error) {
      throw new UnauthorizedException(error instanceof Error ? error.message : "Unauthorized.");
    }
  }

  @Get()
  async listPlaylists(
    @Headers("x-session-token") sessionToken: string | undefined,
    @Ip() ipAddress?: string
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    await this.abuseProtection?.enforce("playlist:list", [
      { name: "ip", value: ipAddress },
      { name: "user", value: userId }
    ], { limit: 60, windowMs: 60 * 1000 });
    return this.playlistService.listPlaylists(userId);
  }

  @Post()
  async createPlaylist(
    @Headers("x-session-token") sessionToken: string | undefined,
    @Body()
    body: {
      title: string;
      description?: string | null;
      trackIds?: string[];
      tags?: string[];
      coverUrl?: string | null;
      isCollaborative?: boolean;
      roomId?: string | null;
    },
    @Ip() ipAddress?: string
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    await this.limitPlaylistWrite(userId, ipAddress);
    const payload = parseRequestBody(createPlaylistRequestSchema, body);
    if (payload.roomId) {
      await this.roomService.assertRoomPermission(payload.roomId, userId, "library");
    }
    const playlist = await this.playlistService.createPlaylist({
      ...payload,
      roomId: payload.roomId ?? null,
      ownerId: userId
    });
    if (payload.roomId) {
      await this.roomService.touchRoomRevision(payload.roomId);
      await this.roomRealtimePublisher.emitSnapshot(
        payload.roomId,
        await this.playlistService.listPlaylistsForRoom(payload.roomId)
      );
    }
    return playlist;
  }

  @Patch(":playlistId")
  async updatePlaylist(
    @Param("playlistId") playlistId: string,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Body()
    body: {
      title?: string;
      description?: string | null;
      tags?: string[];
      coverUrl?: string | null;
      trackIds?: string[];
    },
    @Ip() ipAddress?: string
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    await this.limitPlaylistWrite(userId, ipAddress);
    const payload = parseRequestBody(updatePlaylistRequestSchema, body);
    return this.playlistService.updatePlaylist(playlistId, {
      ...payload,
      ownerId: userId
    });
  }

  @Delete(":playlistId")
  async deletePlaylist(
    @Param("playlistId") playlistId: string,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Ip() ipAddress?: string
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    await this.limitPlaylistWrite(userId, ipAddress);
    const roomId = await this.playlistService.getRoomIdForPlaylist(playlistId);
    const result = await this.playlistService.deletePlaylist(playlistId, userId);
    if (roomId) {
      await this.roomService.touchRoomRevision(roomId);
      await this.roomRealtimePublisher.emitSnapshot(
        roomId,
        await this.playlistService.listPlaylistsForRoom(roomId)
      );
    }
    return result;
  }

  @Post(":playlistId/import-to-room")
  async importPlaylistToRoom(
    @Param("playlistId") playlistId: string,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Body()
    body: {
      roomId: string;
    },
    @Ip() ipAddress?: string
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    await this.limitPlaylistWrite(userId, ipAddress);
    const payload = parseRequestBody(importPlaylistToRoomRequestSchema, body);
    const playlist = await this.playlistService.getPlaylistForOwner(playlistId, userId);
    await this.roomService.importPlaylistToQueue(payload.roomId, userId, playlist.trackIds);
    const snapshot = await this.roomRealtimePublisher.emitQueueSnapshot(
      payload.roomId,
      await this.playlistService.listPlaylistsForRoom(payload.roomId)
    );
    return {
      queue: snapshot.queue,
      playback: snapshot.room.playback
    };
  }

  @Post("from-room")
  async createPlaylistFromRoom(
    @Headers("x-session-token") sessionToken: string | undefined,
    @Body()
    body: {
      roomId: string;
      title: string;
      description?: string | null;
    },
    @Ip() ipAddress?: string
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    await this.limitPlaylistWrite(userId, ipAddress);
    const payload = parseRequestBody(createPlaylistFromRoomRequestSchema, body);
    await this.roomService.assertRoomMember(payload.roomId, userId);
    const playlist = await this.playlistService.createPlaylistFromRoom({
      ...payload,
      ownerId: userId
    });
    await this.roomService.touchRoomRevision(payload.roomId);
    await this.roomRealtimePublisher.emitSnapshot(
      payload.roomId,
      await this.playlistService.listPlaylistsForRoom(payload.roomId)
    );
    return playlist;
  }

  private async limitPlaylistWrite(userId: string, ipAddress?: string) {
    await this.abuseProtection?.enforce("playlist:write", [
      { name: "ip", value: ipAddress },
      { name: "user", value: userId }
    ], { limit: 120, windowMs: 10 * 60 * 1000 });
  }
}
