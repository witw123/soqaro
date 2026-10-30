import { Body, BadRequestException, Controller, Delete, Get, Headers, Ip, Query, Patch, Param, Post, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import {
  batchDeleteTracksRequestSchema,
  computeAssetId,
  createRoomRequestSchema,
  createRoomSongRequestSchema,
  joinRoomByCodeRequestSchema,
  insertRadioAutopilotNextTrackRequestSchema,
  registerTrackRequestSchema,
  registerTracksRequestSchema,
  prepareTrackAssetRequestSchema,
  reorderTracksRequestSchema,
  reportTrackAssetUnavailableRequestSchema,
  updateRoomMemberPermissionsRequestSchema,
  updateRadioAutopilotRequestSchema,
  updateRoomRequestSchema,
  type BatchDeleteTracksRequest,
  type Playlist,
  type PrepareTrackAssetRequest,
  type RegisterTrackRequest,
  type RegisterTracksRequest,
  type RoomJoinResponse,
  type RoomMemberPermissions
} from "@soqaro/shared";
import { parseRequestBody } from "../../common/validation/zod-validation";
import { AbuseProtectionService } from "../../common/security/abuse-protection.service";
import { AuthService } from "../auth/auth.service";
import { PlaylistService } from "../playlist/playlist.service";
import { RoomService } from "./room.service";
import { RoomRealtimePublisher } from "./services/room-realtime.publisher";
import { RoomChatService } from "./services/room-chat.service";

@Controller("v1/rooms")
export class RoomController {
  constructor(
    private readonly roomService: RoomService,
    private readonly roomRealtimePublisher: RoomRealtimePublisher,
    private readonly authService: AuthService,
    private readonly playlistService: PlaylistService,
    private readonly abuseProtection: AbuseProtectionService,
    private readonly roomChatService: RoomChatService
  ) {}

  private async getPlaylistsForRoom(roomId: string): Promise<Playlist[]> {
    try {
      return await this.playlistService.listPlaylistsForRoom(roomId);
    } catch {
      return [];
    }
  }

  private async getCurrentUserId(sessionToken?: string) {
    try {
      const session = await this.authService.getAuthSessionByTokenOrThrow(sessionToken);
      return session.userId;
    } catch (error) {
      throw new UnauthorizedException(error instanceof Error ? error.message : "Unauthorized.");
    }
  }

  @Post()
  async createRoom(
    @Headers("x-session-token") sessionToken: string | undefined,
    @Body()
    body: {
      visibility?: "private" | "public";
      roomType: import("@soqaro/shared").RoomType;
      name?: string;
      description?: string | null;
      password?: string;
      newMemberPermissions?: RoomMemberPermissions;
    },
    @Ip() ipAddress?: string
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    await this.abuseProtection?.enforce("room:create", [
      { name: "ip", value: ipAddress },
      { name: "user", value: userId }
    ], { limit: 10, windowMs: 60 * 60 * 1000 });
    const payload = parseRequestBody(createRoomRequestSchema, body);
    const metadata = {
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.description !== undefined ? { description: payload.description } : {}),
      ...(payload.password !== undefined ? { password: payload.password } : {}),
      ...(payload.newMemberPermissions !== undefined
        ? { newMemberPermissions: payload.newMemberPermissions }
        : {}),
      roomType: payload.roomType
    };
    const snapshot = await this.roomService.createRoom(userId, payload.visibility ?? "public", metadata);
    const playlists = await this.getPlaylistsForRoom(snapshot.room.id);
    await this.roomRealtimePublisher.emitSnapshot(snapshot.room.id, playlists);
    return snapshot;
  }

  @Get()
  async listRooms(
    @Headers("x-session-token") sessionToken: string | undefined,
    @Ip() ipAddress?: string
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    await this.abuseProtection?.enforce("room:list", [
      { name: "ip", value: ipAddress },
      { name: "user", value: userId }
    ], { limit: 60, windowMs: 60 * 1000 });
    return this.roomService.listRoomDirectoryForSession(userId);
  }

  @Get("recent/active")
  async getRecentRoom(@Headers("x-session-token") sessionToken: string | undefined) {
    const userId = await this.getCurrentUserId(sessionToken);
    return this.roomService.getRecentRoomSnapshotForSession(userId);
  }

  @Get("recent")
  async listRecentRooms(@Headers("x-session-token") sessionToken: string | undefined) {
    const userId = await this.getCurrentUserId(sessionToken);
    return this.roomService.listRecentRoomSnapshotsForSession(userId);
  }

  @Get("activity")
  async listRoomActivity(@Headers("x-session-token") sessionToken: string | undefined) {
    const userId = await this.getCurrentUserId(sessionToken);
    return this.roomService.listRoomActivitiesForSession(userId);
  }

  @Get("owned")
  async listOwnedRooms(@Headers("x-session-token") sessionToken: string | undefined) {
    const userId = await this.getCurrentUserId(sessionToken);
    return this.roomService.listOwnedRoomSnapshotsForSession(userId);
  }

  @Get("stats")
  async getRoomStats(@Headers("x-session-token") sessionToken: string | undefined) {
    const userId = await this.getCurrentUserId(sessionToken);
    return this.roomService.getRoomStatsForSession(userId);
  }

  @Get(":roomId/chat")
  async listRadioChatHistory(
    @Param("roomId") roomId: string,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Query("before") before?: string
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    if (!this.roomChatService) {
      throw new ServiceUnavailableException("聊天记录服务暂不可用。");
    }
    return this.roomChatService.listHistory(roomId, userId, before?.trim() || undefined);
  }

  @Delete(":roomId/chat/:messageId")
  async deleteRadioChatMessage(
    @Param("roomId") roomId: string,
    @Param("messageId") messageId: string,
    @Headers("x-session-token") sessionToken: string | undefined
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    if (!this.roomChatService) {
      throw new ServiceUnavailableException("聊天记录服务暂不可用。");
    }
    const result = await this.roomChatService.deleteMessage(roomId, userId, messageId);
    this.roomRealtimePublisher.emitChatDeleted(roomId, messageId);
    return result;
  }

  @Get(":roomId/recover")
  async recoverRoom(
    @Param("roomId") roomId: string,
    @Headers("x-session-token") sessionToken: string | undefined
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    return this.roomService.getRecoverableRoomSnapshot(roomId, userId);
  }

  @Get(":roomId/sync")
  async syncRoom(
    @Param("roomId") roomId: string,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Headers("x-room-revision") roomRevisionHeader?: string,
    @Query("since") sinceQuery?: string
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    const sinceRevision = Number.parseInt(roomRevisionHeader ?? sinceQuery ?? "0", 10);
    const playlists = await this.getPlaylistsForRoom(roomId);
    return this.roomService.syncRoom(
      roomId,
      userId,
      Number.isFinite(sinceRevision) ? sinceRevision : 0,
      playlists
    );
  }

  @Get(":roomId")
  async getRoom(
    @Param("roomId") roomId: string,
    @Headers("x-session-token") sessionToken: string | undefined
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    const playlists = await this.getPlaylistsForRoom(roomId);
    return this.roomService.getAccessibleRoomSnapshot(roomId, playlists, userId);
  }

  @Post("join-by-code")
  async joinRoomByCode(
    @Headers("x-session-token") sessionToken: string | undefined,
    @Body() body: { joinCode: string; password?: string },
    @Ip() ipAddress?: string
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    await this.abuseProtection?.enforce("room:join", [
      { name: "ip", value: ipAddress },
      { name: "user", value: userId }
    ], { limit: 30, windowMs: 10 * 60 * 1000 });
    const payload = parseRequestBody(joinRoomByCodeRequestSchema, body);
    const room = await this.roomService.findRoomByJoinCode(payload.joinCode);
    const joinedRoom = payload.password !== undefined
      ? await this.roomService.joinRoom(room.id, userId, payload.password)
      : await this.roomService.joinRoom(room.id, userId);

    // Existing members still need the topology update, but generating the
    // full snapshot must not keep the joining client's HTTP request open.
    void Promise.resolve()
      .then(() => this.roomRealtimePublisher.emitTopologySnapshot(joinedRoom.id))
      .catch(() => undefined);

    return {
      roomId: joinedRoom.id,
      roomRevision: joinedRoom.roomRevision ?? 0,
      room: joinedRoom
    } satisfies RoomJoinResponse;
  }

  @Post(":roomId/join")
  async joinRoom(
    @Param("roomId") roomId: string,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Body() body?: { password?: string },
    @Ip() ipAddress?: string
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    await this.abuseProtection?.enforce("room:join", [
      { name: "ip", value: ipAddress },
      { name: "user", value: userId }
    ], { limit: 30, windowMs: 10 * 60 * 1000 });
    if (body?.password !== undefined) {
      await this.roomService.joinRoom(roomId, userId, body.password);
    } else {
      await this.roomService.joinRoom(roomId, userId);
    }
    return this.roomRealtimePublisher.emitTopologySnapshot(roomId);
  }

  @Patch(":roomId")
  async updateRoom(
    @Param("roomId") roomId: string,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Body()
    body: {
      visibility: "private" | "public";
      name: string;
      description?: string | null;
      password?: string;
      newMemberPermissions?: RoomMemberPermissions;
    },
    @Ip() ipAddress?: string
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    await this.abuseProtection?.enforce("room:update", [
      { name: "ip", value: ipAddress },
      { name: "user", value: userId }
    ], { limit: 10, windowMs: 60 * 60 * 1000 });
    const payload = parseRequestBody(updateRoomRequestSchema, body);
    await this.roomService.updateRoom(roomId, userId, payload);
    const playlists = await this.getPlaylistsForRoom(roomId);
    return this.roomRealtimePublisher.emitSnapshot(roomId, playlists);
  }

  @Patch(":roomId/members/:memberId/permissions")
  async updateMemberPermissions(
    @Param("roomId") roomId: string,
    @Param("memberId") memberId: string,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Body() body: unknown
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    const payload = parseRequestBody(updateRoomMemberPermissionsRequestSchema, body);
    await this.roomService.updateMemberPermissions(roomId, userId, memberId, payload.permissions);
    return this.roomRealtimePublisher.emitTopologySnapshot(roomId);
  }

  @Delete(":roomId/members/:memberId")
  async removeMember(
    @Param("roomId") roomId: string,
    @Param("memberId") memberId: string,
    @Headers("x-session-token") sessionToken: string | undefined
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    await this.roomService.removeMember(roomId, userId, memberId);
    const snapshot = await this.roomRealtimePublisher.emitTopologySnapshot(roomId);
    this.roomRealtimePublisher.emitMemberRemoved(roomId, memberId);
    return snapshot;
  }

  @Post(":roomId/leave")
  async leaveRoom(
    @Param("roomId") roomId: string,
    @Headers("x-session-token") sessionToken: string | undefined
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    const room = await this.roomService.leaveRoom(roomId, userId);
    await this.roomRealtimePublisher.emitTopologySnapshot(roomId);
    return room;
  }

  @Delete(":roomId")
  async deleteRoom(
    @Param("roomId") roomId: string,
    @Headers("x-session-token") sessionToken: string | undefined
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    await this.roomService.assertCanDeleteRoom(roomId, userId);
    let snapshot;
    try {
      snapshot = await this.roomService.getRoomSnapshot(
        roomId,
        await this.playlistService.listPlaylistsForRoom(roomId)
      );
    } catch {
      // Playlist data is auxiliary to room termination. Continue with the
      // authoritative room snapshot if playlist storage is unavailable.
      snapshot = await this.roomService.getRoomSnapshot(roomId, []);
    }
    const trackIds = snapshot.tracks.map((track) => track.id);
    const result = await this.roomService.deleteRoom(roomId, userId);
    await this.playlistService.deletePlaylistsForRoom(roomId).catch(() => undefined);
    this.roomRealtimePublisher.emitRoomDeleted(roomId, trackIds);
    this.roomRealtimePublisher.emitRoomMissing(roomId);
    return result;
  }

  @Post(":roomId/tracks")
  async registerTrack(
    @Param("roomId") roomId: string,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Body()
    body: RegisterTrackRequest,
    @Ip() ipAddress?: string
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    await this.abuseProtection?.enforce("room:track-write", [
      { name: "ip", value: ipAddress },
      { name: "user", value: userId }
    ], { limit: 1200, windowMs: 10 * 60 * 1000 });
    const payload = parseRequestBody(registerTrackRequestSchema, body);
    await this.validateTrackAssets(payload);
    const track = await this.roomService.registerTrack(roomId, userId, {
      ...payload,
      ownerSessionId: payload.ownerSessionId ?? userId,
      ownerNickname: payload.ownerNickname ?? ""
    });
    await this.roomRealtimePublisher.emitLibrarySnapshot(roomId);
    return track;
  }

  @Get(":roomId/requests")
  async listRoomRequests(
    @Param("roomId") roomId: string,
    @Headers("x-session-token") sessionToken: string | undefined
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    return this.roomService.listRoomRequests(roomId, userId);
  }

  @Post(":roomId/requests")
  async createRoomRequest(
    @Param("roomId") roomId: string,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Body() body: unknown,
    @Ip() ipAddress?: string
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    await this.abuseProtection?.enforce("room:request-song", [
      { name: "ip", value: ipAddress },
      { name: "user", value: userId },
      { name: "room", value: roomId }
    ], { limit: 20, windowMs: 10 * 60 * 1000 });
    const payload = parseRequestBody(createRoomSongRequestSchema, body);
    const request = await this.roomService.createRoomRequest(roomId, userId, {
      ...payload,
      album: payload.album ?? null,
      artworkUrl: payload.artworkUrl ?? null
    });
    const playlists = await this.getPlaylistsForRoom(roomId);
    await this.roomRealtimePublisher.emitSnapshot(roomId, playlists);
    return request;
  }

  @Post(":roomId/requests/:requestId/approve")
  async approveRoomRequest(
    @Param("roomId") roomId: string,
    @Param("requestId") requestId: string,
    @Headers("x-session-token") sessionToken: string | undefined
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    const request = await this.roomService.decideRoomRequest(roomId, userId, requestId, "approved");
    const playlists = await this.getPlaylistsForRoom(roomId);
    await this.roomRealtimePublisher.emitSnapshot(roomId, playlists);
    return request;
  }

  @Post(":roomId/requests/:requestId/reject")
  async rejectRoomRequest(
    @Param("roomId") roomId: string,
    @Param("requestId") requestId: string,
    @Headers("x-session-token") sessionToken: string | undefined
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    const request = await this.roomService.decideRoomRequest(roomId, userId, requestId, "rejected");
    const playlists = await this.getPlaylistsForRoom(roomId);
    await this.roomRealtimePublisher.emitSnapshot(roomId, playlists);
    return request;
  }

  @Patch(":roomId/radio-autopilot")
  async updateRadioAutopilot(
    @Param("roomId") roomId: string,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Body() body: unknown
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    const payload = parseRequestBody(updateRadioAutopilotRequestSchema, body);
    await this.roomService.updateRadioAutopilot(roomId, userId, payload);
    const playlists = await this.getPlaylistsForRoom(roomId);
    return this.roomRealtimePublisher.emitSnapshot(roomId, playlists);
  }

  @Post(":roomId/radio-autopilot/next")
  async insertRadioAutopilotNextTrack(
    @Param("roomId") roomId: string,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Body() body: unknown
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    const payload = parseRequestBody(insertRadioAutopilotNextTrackRequestSchema, body);
    const inserted = await this.roomService.insertRadioAutopilotNextTrack(roomId, userId, payload.trackId);
    const snapshot = await this.roomRealtimePublisher.emitQueueSnapshot(roomId);
    return {
      queue: snapshot.queue,
      playback: snapshot.room.playback,
      insertedQueueItemId: inserted.id
    };
  }

  @Get(":roomId/reactions")
  async getRoomReactions(
    @Param("roomId") roomId: string,
    @Query("trackId") trackId: string | undefined,
    @Headers("x-session-token") sessionToken: string | undefined
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    return this.roomService.getRoomReactionCounts(roomId, trackId || null, userId);
  }

  @Post(":roomId/tracks/batch")
  async registerTracks(
    @Param("roomId") roomId: string,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Body() body: RegisterTracksRequest,
    @Ip() ipAddress?: string
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    await this.abuseProtection?.enforce("room:track-write", [
      { name: "ip", value: ipAddress },
      { name: "user", value: userId }
    ], { limit: 1200, windowMs: 10 * 60 * 1000 });
    const payload = parseRequestBody(registerTracksRequestSchema, body);
    await Promise.all(payload.tracks.map((track) => this.validateTrackAssets(track)));
    const tracks = await this.roomService.registerTracks(roomId, userId, payload.tracks.map((track) => ({
      ...track,
      ownerSessionId: track.ownerSessionId ?? userId,
      ownerNickname: track.ownerNickname ?? ""
    })));
    await this.roomRealtimePublisher.emitLibrarySnapshot(roomId);
    return tracks;
  }

  @Post(":roomId/tracks/:trackId/asset")
  async prepareTrackAsset(
    @Param("roomId") roomId: string,
    @Param("trackId") trackId: string,
    @Body() body: unknown,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Ip() ipAddress?: string
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    await this.abuseProtection?.enforce("room:track-write", [
      { name: "ip", value: ipAddress },
      { name: "user", value: userId }
    ], { limit: 1200, windowMs: 10 * 60 * 1000 });
    const payload = parseRequestBody(prepareTrackAssetRequestSchema, body);
    if (payload.trackId !== trackId) {
      throw new BadRequestException("Track ID in path does not match request body.");
    }
    await this.validateTrackAssets(payload);
    const result = await this.roomService.prepareTrackAsset(roomId, userId, payload);
    await this.roomRealtimePublisher.emitLibrarySnapshot(roomId);
    if (result.playbackChanged && result.playback) {
      this.roomRealtimePublisher.emitPlaybackPatch(roomId, result.playback, result.roomRevision);
    }
    this.roomRealtimePublisher.emitTrackAssetReady(roomId, {
      trackId: result.track.id,
      fileHash: result.track.fileHash,
      assetId: result.track.playbackAsset!.assetId,
      roomRevision: result.roomRevision
    });
    return result.track;
  }

  @Post(":roomId/tracks/:trackId/asset/unavailable")
  async reportTrackAssetUnavailable(
    @Param("roomId") roomId: string,
    @Param("trackId") trackId: string,
    @Body() body: unknown,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Ip() ipAddress?: string
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    await this.abuseProtection?.enforce("room:track-write", [
      { name: "ip", value: ipAddress },
      { name: "user", value: userId }
    ], { limit: 1200, windowMs: 10 * 60 * 1000 });
    const payload = parseRequestBody(reportTrackAssetUnavailableRequestSchema, body);
    if (payload.trackId !== trackId) {
      throw new BadRequestException("Track ID in path does not match request body.");
    }
    const result = await this.roomService.reportTrackAssetUnavailable(roomId, userId, payload);
    if (result.playbackChanged) {
      this.roomRealtimePublisher.emitPlaybackPatch(roomId, result.playback, result.roomRevision);
    }
    this.roomRealtimePublisher.emitTrackAssetUnavailable(roomId, {
      trackId: result.track.id,
      reason: result.reason,
      roomRevision: result.roomRevision
    });
    return { ok: true, trackId: result.track.id, reason: result.reason };
  }

  private async validateTrackAssets(payload: RegisterTrackRequest | PrepareTrackAssetRequest) {
    if (!payload.originalAsset || !payload.playbackAsset) {
      throw new BadRequestException("P2P v4 tracks require original and playback assets.");
    }
    if (
      payload.originalAsset.fileHash !== payload.fileHash ||
      payload.playbackAsset.sourceFileHash !== payload.fileHash
    ) {
      throw new BadRequestException("Track asset source hashes do not match the registered file.");
    }
    const { assetId: originalAssetId, ...originalManifest } = payload.originalAsset;
    const { assetId: playbackAssetId, ...playbackManifest } = payload.playbackAsset;
    const [expectedOriginalAssetId, expectedPlaybackAssetId] = await Promise.all([
      computeAssetId(originalManifest),
      computeAssetId(playbackManifest)
    ]);
    if (
      originalAssetId !== expectedOriginalAssetId ||
      playbackAssetId !== expectedPlaybackAssetId
    ) {
      throw new BadRequestException("Track asset ids do not match their canonical manifests.");
    }
  }

  @Delete(":roomId/tracks/:trackId")
  async deleteTrack(
    @Param("roomId") roomId: string,
    @Param("trackId") trackId: string,
    @Headers("x-session-token") sessionToken: string | undefined
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    const getRoomSnapshot = this.roomService.getRoomSnapshot;
    const beforeSnapshot = typeof getRoomSnapshot === "function"
      ? await getRoomSnapshot.call(this.roomService, roomId, []).catch(() => null)
      : null;
    const deletedTrack = beforeSnapshot?.tracks.find((track) => track.id === trackId);
    const result = await this.roomService.removeTrack(roomId, userId, trackId);
    await this.playlistService.removeTrackFromPlaylists(trackId);
    const librarySnapshot = await this.roomRealtimePublisher.emitLibrarySnapshot(roomId);
    if (deletedTrack) {
      this.roomRealtimePublisher.emitTrackDeleted(roomId, {
        trackId,
        fileHash: deletedTrack.fileHash,
        originalAssetId: deletedTrack.originalAsset?.assetId ?? null,
        playbackAssetId: deletedTrack.playbackAsset?.assetId ?? null,
        roomRevision: librarySnapshot?.room.roomRevision ?? (beforeSnapshot?.room.roomRevision ?? 0) + 1,
        deletedAt: new Date().toISOString()
      });
    }
    return result;
  }

  @Post(":roomId/tracks/batch-delete")
  async deleteTracks(
    @Param("roomId") roomId: string,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Body() body: BatchDeleteTracksRequest,
    @Ip() ipAddress?: string
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    await this.abuseProtection?.enforce("room:track-write", [
      { name: "ip", value: ipAddress },
      { name: "user", value: userId }
    ], { limit: 1200, windowMs: 10 * 60 * 1000 });
    const payload = parseRequestBody(batchDeleteTracksRequestSchema, body);
    const getRoomSnapshot = this.roomService.getRoomSnapshot;
    const beforeSnapshot = typeof getRoomSnapshot === "function"
      ? await getRoomSnapshot.call(this.roomService, roomId, []).catch(() => null)
      : null;
    const result = await this.roomService.removeTracks(roomId, userId, payload.trackIds);
    await Promise.all(
      result.deletedTrackIds.map((trackId) =>
        this.playlistService.removeTrackFromPlaylists(trackId).catch(() => undefined)
      )
    );
    const librarySnapshot = await this.roomRealtimePublisher.emitLibrarySnapshot(roomId);
    const now = new Date().toISOString();
    const revision = librarySnapshot?.room.roomRevision ?? (beforeSnapshot?.room.roomRevision ?? 0) + 1;
    for (const track of result.deletedTracks) {
      this.roomRealtimePublisher.emitTrackDeleted(roomId, {
        trackId: track.id,
        fileHash: track.fileHash,
        originalAssetId: track.originalAsset?.assetId ?? null,
        playbackAssetId: track.playbackAsset?.assetId ?? null,
        roomRevision: revision,
        deletedAt: now
      });
    }
    return { ok: true, deletedTrackIds: result.deletedTrackIds };
  }

  @Patch(":roomId/tracks/reorder")
  async reorderTracks(
    @Param("roomId") roomId: string,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Body() body: unknown
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    const payload = parseRequestBody(reorderTracksRequestSchema, body);
    const tracks = await this.roomService.reorderTracks(roomId, userId, payload.trackIds);
    await this.roomRealtimePublisher.emitLibrarySnapshot(roomId);
    return tracks;
  }
}
