import { Injectable } from "@nestjs/common";
import type { PlaybackSnapshot, Playlist, RoomTrackAssetReadyPayload, RoomTrackAssetUnavailablePayload, RoomTrackDeletedPayload } from "@soqaro/shared";
import { RoomService } from "../room.service";
import { RoomRealtimeBroadcaster } from "../../realtime/room-realtime.broadcaster";

@Injectable()
export class RoomRealtimePublisher {
  constructor(
    private readonly roomService: RoomService,
    private readonly roomRealtimeBroadcaster: RoomRealtimeBroadcaster
  ) {}

  async emitSnapshot(roomId: string, playlists: Playlist[] = []) {
    const snapshot = await this.roomService.getRoomSnapshot(roomId, playlists);
    this.roomRealtimeBroadcaster.emitRoomSnapshot(roomId, snapshot);
    return snapshot;
  }

  async emitTopologySnapshot(roomId: string, playlists: Playlist[] = []) {
    const snapshot = await this.roomService.getRoomSnapshot(roomId, playlists);
    this.roomRealtimeBroadcaster.emitPresencePatch(
      roomId,
      {
        members: snapshot.room.members,
        playback: snapshot.room.playback,
        presenceRevision: snapshot.room.presenceRevision,
        roomRevision: snapshot.room.roomRevision ?? 0
      }
    );
    return snapshot;
  }

  async emitQueueSnapshot(roomId: string, playlists: Playlist[] = []) {
    const snapshot = await this.roomService.getRoomSnapshot(roomId, playlists);
    this.roomRealtimeBroadcaster.emitQueuePatch(
      roomId,
      {
        queue: snapshot.queue,
        playback: snapshot.room.playback,
        roomRevision: snapshot.room.roomRevision ?? 0
      }
    );
    return snapshot;
  }

  async emitLibrarySnapshot(roomId: string, playlists: Playlist[] = []) {
    const snapshot = await this.roomService.getRoomSnapshot(roomId, playlists);
    this.roomRealtimeBroadcaster.emitLibraryPatch(
      roomId,
      {
        tracks: snapshot.tracks,
        queue: snapshot.queue,
        playback: snapshot.room.playback,
        roomRevision: snapshot.room.roomRevision ?? 0
      }
    );
    return snapshot;
  }

  emitPlaybackPatch(roomId: string, playback: PlaybackSnapshot, roomRevision?: number) {
    this.roomRealtimeBroadcaster.emitPlaybackPatch(roomId, { playback, roomRevision });
  }

  emitRoomMissing(roomId: string) {
    this.roomRealtimeBroadcaster.emitRoomMissing(roomId);
  }

  emitRoomDeleted(roomId: string, trackIds: string[]) {
    this.roomRealtimeBroadcaster.emitRoomDeleted(roomId, trackIds);
  }

  emitTrackDeleted(roomId: string, payload: Omit<RoomTrackDeletedPayload, "roomId">) {
    this.roomRealtimeBroadcaster.emitTrackDeleted(roomId, payload);
  }

  emitTrackAssetReady(roomId: string, payload: Omit<RoomTrackAssetReadyPayload, "roomId">) {
    this.roomRealtimeBroadcaster.emitTrackAssetReady(roomId, payload);
  }

  emitTrackAssetUnavailable(roomId: string, payload: Omit<RoomTrackAssetUnavailablePayload, "roomId">) {
    this.roomRealtimeBroadcaster.emitTrackAssetUnavailable(roomId, payload);
  }

  emitMemberRemoved(roomId: string, memberId: string) {
    this.roomRealtimeBroadcaster.emitMemberRemoved(roomId, memberId);
  }

  evictMemberSession(roomId: string, memberId: string) {
    this.roomRealtimeBroadcaster.evictMemberSession(roomId, memberId);
  }

  emitChatDeleted(roomId: string, messageId: string) {
    this.roomRealtimeBroadcaster.emitChatDeleted(roomId, messageId);
  }
}
