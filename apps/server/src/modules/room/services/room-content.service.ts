import { BadRequestException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PrepareTrackAssetRequest, QueueItem, RadioAutopilot, ReportTrackAssetUnavailableRequest, RoomTrackDeletion, TrackMeta } from "@soqaro/shared";
import type { RoomRecord } from "../room.types";
import {
  assertHost,
  assertMember,
  assertPermission,
  incrementPlaybackRevision,
  incrementQueueVersion,
  incrementRoomRevision,
  maxAssetUnits,
  maxTrackDurationMs,
  maxTrackSizeBytes
} from "../room-mutation";
import { getEffectivePlaybackPositionMs, pausePlaybackAt } from "./room-playback.helpers";
import { AuthService } from "../../auth/auth.service";
import { RoomPlaybackService } from "./room-playback.service";
import { RoomRecordRepository } from "../repositories/room-record.repository";

/**
 * Mutations of a room's library content: track registration/removal and the
 * playback queue (append, import, remove, reorder, next). All writes persist
 * through the shared room record repository and keep the shuffle bag in sync
 * with the queue.
 */
@Injectable()
export class RoomContentService {
  constructor(
    private readonly authService: AuthService,
    private readonly roomRecordRepository: RoomRecordRepository,
    private readonly roomPlaybackService: RoomPlaybackService
  ) {}

  async registerTrack(
    roomId: string,
    sessionId: string,
    input: Omit<TrackMeta, "id"> & { id?: string }
  ) {
    await this.authService.getUserOrThrow(sessionId);
    const record = await this.roomRecordRepository.getRoomRecord(roomId);
    assertMember(record, sessionId);
    assertPermission(record, sessionId, "library");
    this.assertTrackLimits(input);

    const track: TrackMeta = {
      ...input,
      ownerSessionId: sessionId,
      ownerNickname: (await this.authService.getUserOrThrow(sessionId)).nickname,
      id: input.id ?? `track_${randomUUID()}`
    };

    const duplicateByFileHashIndex = record.tracks.findIndex(
      (item) =>
        item.fileHash === track.fileHash &&
        item.ownerSessionId === track.ownerSessionId
    );
    const sourceRef = track.sourceType !== "local_upload" ? track.sourceRef : null;
    const duplicateBySourceIndex = sourceRef
      ? record.tracks.findIndex(
          (item) =>
            item.ownerSessionId === track.ownerSessionId &&
            item.sourceType !== "local_upload" &&
            item.sourceRef?.provider === sourceRef.provider &&
            item.sourceRef?.trackId === sourceRef.trackId
        )
      : -1;
    const existingIndex = record.tracks.findIndex((item) => item.id === track.id);

    if (duplicateByFileHashIndex >= 0) {
      const existingTrack = record.tracks[duplicateByFileHashIndex];
      record.tracks[duplicateByFileHashIndex] = {
        ...existingTrack,
        ...track,
        id: existingTrack.id
      };
      incrementRoomRevision(record.room);
      await this.roomRecordRepository.persistRecord(record);
      return record.tracks[duplicateByFileHashIndex];
    }

    if (duplicateBySourceIndex >= 0) {
      const existingTrack = record.tracks[duplicateBySourceIndex];
      record.tracks[duplicateBySourceIndex] = {
        ...existingTrack,
        ...track,
        id: existingTrack.id
      };
      incrementRoomRevision(record.room);
      await this.roomRecordRepository.persistRecord(record);
      return record.tracks[duplicateBySourceIndex];
    }

    if (existingIndex >= 0) {
      record.tracks[existingIndex] = track;
    } else {
      record.tracks.unshift(track);
    }

    incrementRoomRevision(record.room);
    await this.roomRecordRepository.persistRecord(record);
    return track;
  }

  async registerTracks(
    roomId: string,
    sessionId: string,
    inputs: Array<Omit<TrackMeta, "id"> & { id?: string }>
  ) {
    const user = await this.authService.getUserOrThrow(sessionId);
    const record = await this.roomRecordRepository.getRoomRecord(roomId);
    assertMember(record, sessionId);
    assertPermission(record, sessionId, "library");

    if (inputs.length === 0) {
      throw new BadRequestException("至少需要导入一首歌曲。");
    }
    const registered: TrackMeta[] = [];
    for (const input of inputs) {
      this.assertTrackLimits(input);
      const track: TrackMeta = {
        ...input,
        ownerSessionId: sessionId,
        ownerNickname: user.nickname,
        id: input.id ?? `track_${randomUUID()}`
      };
      const sourceRef = track.sourceType !== "local_upload" ? track.sourceRef : null;
      const existingIndex = record.tracks.findIndex(
        (item) =>
          item.id === track.id ||
          (item.ownerSessionId === sessionId && item.fileHash === track.fileHash) ||
          (!!sourceRef &&
            item.ownerSessionId === sessionId &&
            item.sourceType !== "local_upload" &&
            item.sourceRef?.provider === sourceRef.provider &&
            item.sourceRef?.trackId === sourceRef.trackId)
      );

      if (existingIndex >= 0) {
        const existingTrack = record.tracks[existingIndex];
        record.tracks[existingIndex] = { ...existingTrack, ...track, id: existingTrack.id };
        registered.push(record.tracks[existingIndex]);
      } else {
        record.tracks.unshift(track);
        registered.push(track);
      }
    }

    incrementRoomRevision(record.room);
    await this.roomRecordRepository.persistRecord(record);
    return registered;
  }

  async prepareTrackAsset(
    roomId: string,
    sessionId: string,
    input: PrepareTrackAssetRequest
  ) {
    await this.authService.getUserOrThrow(sessionId);
    const record = await this.roomRecordRepository.getRoomRecord(roomId);
    assertMember(record, sessionId);

    const trackIndex = record.tracks.findIndex((item) => item.id === input.trackId);
    if (trackIndex < 0) {
      throw new BadRequestException(`房间中不存在该曲目: ${input.trackId}`);
    }

    const track = record.tracks[trackIndex];
    if (track.ownerSessionId !== sessionId && record.room.hostId !== sessionId) {
      throw new BadRequestException("只有曲目源成员或房主可以为该曲目准备分发资产。");
    }

    const updatedTrack: TrackMeta = {
      ...track,
      fileHash: input.fileHash,
      originalAsset: input.originalAsset,
      playbackAsset: input.playbackAsset
    };
    this.assertTrackLimits(updatedTrack);

    record.tracks[trackIndex] = updatedTrack;
    incrementRoomRevision(record.room);

    let playbackChanged = false;
    if (
      record.room.playback.currentTrackId === track.id &&
      record.room.playback.status === "paused"
    ) {
      await this.roomPlaybackService.applyTrackPlayback(
        record,
        track.id,
        record.room.playback.positionMs ?? 0,
        record.room.playback.currentQueueItemId,
        input.playbackAsset.assetId
      );
      incrementPlaybackRevision(record.room.playback);
      playbackChanged = true;
    }

    await this.roomRecordRepository.persistRecord(record);
    const playback = playbackChanged
      ? await this.roomPlaybackService.buildPlaybackForSnapshot(record)
      : undefined;

    return {
      track: updatedTrack,
      playbackChanged,
      playback,
      roomRevision: record.room.roomRevision ?? 0
    };
  }

  async reportTrackAssetUnavailable(
    roomId: string,
    sessionId: string,
    input: ReportTrackAssetUnavailableRequest
  ) {
    await this.authService.getUserOrThrow(sessionId);
    const record = await this.roomRecordRepository.getRoomRecord(roomId);
    assertMember(record, sessionId);

    const trackIndex = record.tracks.findIndex((item) => item.id === input.trackId);
    if (trackIndex < 0) {
      throw new BadRequestException(`房间中不存在该曲目: ${input.trackId}`);
    }

    const track = record.tracks[trackIndex];
    if (track.ownerSessionId !== sessionId && record.room.hostId !== sessionId) {
      throw new BadRequestException("只有曲目源成员或房主可以报告该曲目资产状态。");
    }

    let playbackChanged = false;
    if (record.room.playback.currentTrackId === track.id) {
      const advanced = await this.roomPlaybackService.advanceAfterUnavailableTrack(record, track.id);
      if (!advanced) {
        const pausePositionMs = getEffectivePlaybackPositionMs(record, record.room.playback);
        pausePlaybackAt(record, pausePositionMs, {
          sourceCandidate: null,
          clearSourcePeer: true,
          keepSourceSessionId: true,
          bumpMediaEpoch: true
        });
        incrementPlaybackRevision(record.room.playback);
      }
      playbackChanged = true;
    }

    incrementRoomRevision(record.room);
    await this.roomRecordRepository.persistRecord(record);
    const playback = playbackChanged
      ? await this.roomPlaybackService.buildPlaybackForSnapshot(record)
      : record.room.playback;

    return {
      track,
      reason: input.reason,
      playbackChanged,
      playback,
      roomRevision: record.room.roomRevision ?? 0
    };
  }

  async removeTrack(roomId: string, sessionId: string, trackId: string) {
    const record = await this.roomRecordRepository.getRoomRecord(roomId);
    assertMember(record, sessionId);
    assertPermission(record, sessionId, "library");

    const track = record.tracks.find((item) => item.id === trackId);
    if (!track) {
      throw new Error(`Track not found in room: ${trackId}`);
    }

    if (track.ownerSessionId !== sessionId && record.room.hostId !== sessionId) {
      throw new Error("Only the original uploader can delete this track.");
    }

    this.removeTracksById(record, new Set([trackId]));
    incrementRoomRevision(record.room);
    await this.roomRecordRepository.persistRecord(record);
    const deletion: RoomTrackDeletion = {
      roomId,
      trackId,
      fileHash: track.fileHash,
      originalAssetId: track.originalAsset?.assetId ?? null,
      playbackAssetId: track.playbackAsset?.assetId ?? null,
      roomRevision: record.room.roomRevision ?? 0,
      deletedAt: new Date().toISOString()
    };
    await this.roomRecordRepository.recordTrackDeletion(deletion).catch(() => undefined);
    return { ok: true };
  }

  async removeTracks(roomId: string, sessionId: string, trackIds: string[]) {
    const record = await this.roomRecordRepository.getRoomRecord(roomId);
    assertMember(record, sessionId);
    assertPermission(record, sessionId, "library");

    const targetSet = new Set(trackIds);
    const deletableTracks = record.tracks.filter(
      (item) => targetSet.has(item.id) && (item.ownerSessionId === sessionId || record.room.hostId === sessionId)
    );

    if (deletableTracks.length === 0) {
      return { ok: true, deletedTrackIds: [], deletedTracks: [] };
    }

    const deletableIds = new Set(deletableTracks.map((item) => item.id));
    this.removeTracksById(record, deletableIds);
    incrementRoomRevision(record.room);
    await this.roomRecordRepository.persistRecord(record);

    const now = new Date().toISOString();
    await Promise.all(
      deletableTracks.map((track) => {
        const deletion: RoomTrackDeletion = {
          roomId,
          trackId: track.id,
          fileHash: track.fileHash,
          originalAssetId: track.originalAsset?.assetId ?? null,
          playbackAssetId: track.playbackAsset?.assetId ?? null,
          roomRevision: record.room.roomRevision ?? 0,
          deletedAt: now
        };
        return this.roomRecordRepository.recordTrackDeletion(deletion).catch(() => undefined);
      })
    );

    return {
      ok: true,
      deletedTrackIds: deletableTracks.map((item) => item.id),
      deletedTracks: deletableTracks
    };
  }

  async addQueueItem(roomId: string, sessionId: string, trackId: string) {
    const session = await this.authService.getUserOrThrow(sessionId);
    const record = await this.roomRecordRepository.getRoomRecord(roomId);
    assertMember(record, sessionId);
    if ((record.room.roomType === "request" || record.room.roomType === "radio") && record.room.hostId !== sessionId) {
      throw new BadRequestException("当前房间请先提交点歌请求，等待房主审核。");
    }
    assertPermission(record, sessionId, "queue");

    if (!record.tracks.some((track) => track.id === trackId)) {
      throw new Error(`Track not found in room: ${trackId}`);
    }

    const queueItem: QueueItem = {
      id: `queue_${randomUUID()}`,
      trackId,
      requestedBy: session.nickname,
      requestedById: session.id,
      source: "manual",
      sourceSeedTrackId: null,
      position: record.queue.length,
      createdAt: new Date().toISOString()
    };

    record.queue.push(queueItem);
    this.roomPlaybackService.syncShuffleBagWithQueue(record, [trackId]);
    incrementQueueVersion(record.room.playback);
    incrementRoomRevision(record.room);
    await this.roomRecordRepository.persistRecord(record);

    return queueItem;
  }

  async importPlaylistToQueue(roomId: string, sessionId: string, trackIds: string[]) {
    const session = await this.authService.getUserOrThrow(sessionId);
    const record = await this.roomRecordRepository.getRoomRecord(roomId);
    assertMember(record, sessionId);
    if ((record.room.roomType === "request" || record.room.roomType === "radio") && record.room.hostId !== sessionId) {
      throw new BadRequestException("当前房间成员不能直接导入共享队列。");
    }
    assertPermission(record, sessionId, "queue");

    const validTrackIds = trackIds
      .map((targetId) => {
        const direct = record.tracks.find((track) => track.id === targetId);
        if (direct) return direct.id;
        const matched = record.tracks.find((track) => {
          if (track.sourceRef && `${track.sourceRef.provider}:${track.sourceRef.trackId}` === targetId) return true;
          if (track.fileHash && track.fileHash === targetId) return true;
          return false;
        });
        return matched?.id ?? null;
      })
      .filter((id): id is string => !!id);

    if (validTrackIds.length === 0) {
      throw new Error("No tracks from this playlist are available in the current room.");
    }

    const nextItems = validTrackIds.map(
      (trackId, offset): QueueItem => ({
        id: `queue_${randomUUID()}`,
        trackId,
        requestedBy: session.nickname,
        requestedById: session.id,
        source: "manual",
        sourceSeedTrackId: null,
        position: record.queue.length + offset,
        createdAt: new Date().toISOString()
      })
    );

    record.queue.push(...nextItems);
    this.roomPlaybackService.syncShuffleBagWithQueue(record, validTrackIds);
    incrementQueueVersion(record.room.playback);
    incrementRoomRevision(record.room);
    await this.roomRecordRepository.persistRecord(record);
    return record.queue;
  }

  async updateRadioAutopilot(
    roomId: string,
    sessionId: string,
    input: { enabled: boolean }
  ): Promise<RadioAutopilot> {
    const record = await this.roomRecordRepository.getRoomRecord(roomId);
    assertMember(record, sessionId);
    assertHost(record, sessionId);
    if (record.room.roomType !== "radio") {
      throw new BadRequestException("只有自由电台可以开启自动推荐。");
    }

    record.room.radioAutopilot = { enabled: input.enabled };

    incrementRoomRevision(record.room);
    await this.roomRecordRepository.persistRecord(record);
    return record.room.radioAutopilot;
  }

  async insertRadioAutopilotNextTrack(
    roomId: string,
    sessionId: string,
    trackId: string
  ): Promise<QueueItem> {
    const session = await this.authService.getUserOrThrow(sessionId);
    const record = await this.roomRecordRepository.getRoomRecord(roomId);
    assertMember(record, sessionId);
    assertHost(record, sessionId);
    if (record.room.roomType !== "radio") {
      throw new BadRequestException("只有自由电台可以补充推荐歌曲。");
    }

    const currentQueueItemId = record.room.playback.currentQueueItemId;
    const currentIndex = currentQueueItemId
      ? record.queue.findIndex((item) => item.id === currentQueueItemId)
      : -1;
    if (currentIndex < 0 || !record.room.playback.currentTrackId) {
      throw new BadRequestException("请先从节目单播放一首歌曲。");
    }

    const track = record.tracks.find((item) => item.id === trackId);
    if (!track) {
      throw new BadRequestException("推荐歌曲尚未导入当前电台曲库。");
    }
    const sourceKey = getProviderTrackKey(track);
    const isAlreadyQueued = record.queue.some((item) => {
      const queuedTrack = record.tracks.find((candidate) => candidate.id === item.trackId);
      return item.trackId === track.id || (sourceKey !== null && getProviderTrackKey(queuedTrack) === sourceKey);
    });
    if (isAlreadyQueued) {
      throw new BadRequestException("推荐歌曲已在节目单中。");
    }

    const nextItem: QueueItem = {
      id: `queue_${randomUUID()}`,
      trackId: track.id,
      requestedBy: "自动推荐",
      requestedById: session.id,
      source: "autopilot",
      sourceSeedTrackId: record.room.playback.currentTrackId,
      position: currentIndex + 1,
      createdAt: new Date().toISOString()
    };

    record.queue = [
      ...record.queue.slice(0, currentIndex + 1),
      nextItem,
      ...record.queue.slice(currentIndex + 1)
    ].map((item, index) => ({ ...item, position: index }));
    record.room.playback.nextQueueItemId = nextItem.id;
    this.roomPlaybackService.syncShuffleBagWithQueue(record, [nextItem.trackId]);
    incrementPlaybackRevision(record.room.playback);
    incrementQueueVersion(record.room.playback);
    incrementRoomRevision(record.room);
    await this.roomRecordRepository.persistRecord(record);
    return nextItem;
  }

  async removeQueueItem(roomId: string, queueItemId: string, actorSessionId: string) {
    const record = await this.roomRecordRepository.getRoomRecord(roomId);
    assertMember(record, actorSessionId);
    if ((record.room.roomType === "request" || record.room.roomType === "radio") && record.room.hostId !== actorSessionId) {
      throw new BadRequestException("只有房主可以管理当前房间队列。");
    }
    assertPermission(record, actorSessionId, "queue");
    const removed = record.queue.find((item) => item.id === queueItemId);

    if (!removed) {
      return record.queue;
    }

    const nextQueue = record.queue
      .filter((item) => item.id !== queueItemId)
      .map((item, index) => ({ ...item, position: index }));

    const playback = record.room.playback;
    const removesCurrentQueueItem = playback.currentQueueItemId === removed.id;
    const removesNextQueueItem = playback.nextQueueItemId === removed.id;
    const removesDirectlyPlayingTrack =
      playback.currentQueueItemId === null && playback.currentTrackId === removed.trackId;

    if (removesCurrentQueueItem || removesDirectlyPlayingTrack) {
      record.queue = nextQueue;
      this.roomPlaybackService.clearPlayback(playback);
      this.roomPlaybackService.syncShuffleBagWithQueue(record, []);
      incrementQueueVersion(playback);
      incrementRoomRevision(record.room);
      await this.roomRecordRepository.persistRecord(record);
      return record.queue;
    }

    record.queue = nextQueue;
    if (removesNextQueueItem) {
      playback.nextQueueItemId = null;
    }
    this.roomPlaybackService.syncShuffleBagWithQueue(record, []);
    incrementQueueVersion(record.room.playback);
    incrementRoomRevision(record.room);
    await this.roomRecordRepository.persistRecord(record);
    return record.queue;
  }

  async removeQueueItems(roomId: string, queueItemIds: string[], actorSessionId: string) {
    const record = await this.roomRecordRepository.getRoomRecord(roomId);
    assertMember(record, actorSessionId);
    if ((record.room.roomType === "request" || record.room.roomType === "radio") && record.room.hostId !== actorSessionId) {
      throw new BadRequestException("只有房主可以管理当前房间队列。");
    }
    assertPermission(record, actorSessionId, "queue");

    const targetIds = new Set(queueItemIds);
    const removedItems = record.queue.filter((item) => targetIds.has(item.id));
    if (removedItems.length === 0) {
      return record.queue;
    }

    const nextQueue = record.queue
      .filter((item) => !targetIds.has(item.id))
      .map((item, index) => ({ ...item, position: index }));

    const playback = record.room.playback;
    const removesCurrentQueueItem = Boolean(playback.currentQueueItemId && targetIds.has(playback.currentQueueItemId));
    const removesNextQueueItem = Boolean(playback.nextQueueItemId && targetIds.has(playback.nextQueueItemId));
    const removesDirectlyPlayingTrack =
      !playback.currentQueueItemId &&
      Boolean(playback.currentTrackId && removedItems.some((item) => item.trackId === playback.currentTrackId));

    if (removesCurrentQueueItem || removesDirectlyPlayingTrack) {
      record.queue = nextQueue;
      this.roomPlaybackService.clearPlayback(playback);
      this.roomPlaybackService.syncShuffleBagWithQueue(record, []);
      incrementQueueVersion(playback);
      incrementRoomRevision(record.room);
      await this.roomRecordRepository.persistRecord(record);
      return record.queue;
    }

    record.queue = nextQueue;
    if (removesNextQueueItem) {
      playback.nextQueueItemId = null;
    }
    this.roomPlaybackService.syncShuffleBagWithQueue(record, []);
    incrementQueueVersion(record.room.playback);
    incrementRoomRevision(record.room);
    await this.roomRecordRepository.persistRecord(record);
    return record.queue;
  }

  async addQueueItems(roomId: string, sessionId: string, trackIds: string[]) {
    return this.importPlaylistToQueue(roomId, sessionId, trackIds);
  }

  async setNextQueueItem(roomId: string, actorSessionId: string, queueItemId: string) {
    const record = await this.roomRecordRepository.getRoomRecord(roomId);
    assertMember(record, actorSessionId);
    if ((record.room.roomType === "request" || record.room.roomType === "radio") && record.room.hostId !== actorSessionId) {
      throw new BadRequestException("只有房主可以管理当前房间队列。");
    }
    assertPermission(record, actorSessionId, "player");

    const queueItem = record.queue.find((item) => item.id === queueItemId);
    if (!queueItem) {
      throw new Error("Queue item not found in this room.");
    }
    if (record.room.playback.currentQueueItemId === queueItemId) {
      throw new Error("The current queue item is already playing.");
    }

    record.room.playback.nextQueueItemId = queueItemId;
    incrementPlaybackRevision(record.room.playback);
    incrementRoomRevision(record.room);
    await this.roomRecordRepository.persistRecord(record);
    return record.room.playback;
  }

  async reorderQueue(roomId: string, actorSessionId: string, queueItemIds: string[]) {
    const record = await this.roomRecordRepository.getRoomRecord(roomId);
    assertMember(record, actorSessionId);
    if ((record.room.roomType === "request" || record.room.roomType === "radio") && record.room.hostId !== actorSessionId) {
      throw new BadRequestException("只有房主可以管理当前房间队列。");
    }
    assertPermission(record, actorSessionId, "queue");

    const existingIds = record.queue.map((item) => item.id);
    if (
      queueItemIds.length !== existingIds.length ||
      queueItemIds.some((id) => !existingIds.includes(id))
    ) {
      throw new Error("Queue reorder payload does not match the current room queue.");
    }

    const nextQueue = queueItemIds
      .map((queueItemId) => record.queue.find((item) => item.id === queueItemId))
      .filter((item): item is QueueItem => !!item)
      .map((item, index) => ({
        ...item,
        position: index
      }));

    record.queue = nextQueue;
    this.roomPlaybackService.syncShuffleBagWithQueue(record, []);
    incrementQueueVersion(record.room.playback);
    incrementRoomRevision(record.room);
    await this.roomRecordRepository.persistRecord(record);
    return record.queue;
  }

  async reorderTracks(roomId: string, actorSessionId: string, trackIds: string[]) {
    const record = await this.roomRecordRepository.getRoomRecord(roomId);
    assertMember(record, actorSessionId);
    if ((record.room.roomType === "request" || record.room.roomType === "radio") && record.room.hostId !== actorSessionId) {
      throw new BadRequestException("只有房主可以调整当前房间曲库排序。");
    }
    assertPermission(record, actorSessionId, "library");

    const existingIds = new Set(record.tracks.map((item) => item.id));
    if (
      trackIds.length !== existingIds.size ||
      trackIds.some((id) => !existingIds.has(id))
    ) {
      throw new BadRequestException("曲目排序数据与当前曲库不一致。");
    }

    const trackMap = new Map(record.tracks.map((item) => [item.id, item]));
    const nextTracks = trackIds
      .map((trackId) => trackMap.get(trackId))
      .filter((item): item is TrackMeta => !!item);

    record.tracks = nextTracks;
    incrementRoomRevision(record.room);
    await this.roomRecordRepository.persistRecord(record);
    return record.tracks;
  }

  private removeTracksById(record: RoomRecord, trackIds: Set<string>) {
    if (trackIds.size === 0) {
      return;
    }

    const previousQueueLength = record.queue.length;
    record.tracks = record.tracks.filter((item) => !trackIds.has(item.id));
    record.queue = record.queue
      .filter((item) => !trackIds.has(item.trackId))
      .map((item, index) => ({ ...item, position: index }));
    if (record.room.playback.nextQueueItemId) {
      const nextQueueItem = record.queue.find(
        (item) => item.id === record.room.playback.nextQueueItemId
      );
      if (!nextQueueItem) {
        record.room.playback.nextQueueItemId = null;
      }
    }
    this.roomPlaybackService.syncShuffleBagWithQueue(record, []);

    if (
      record.room.playback.currentTrackId &&
      trackIds.has(record.room.playback.currentTrackId)
    ) {
      this.roomPlaybackService.clearPlayback(record.room.playback);
    }

    if (record.queue.length !== previousQueueLength) {
      incrementQueueVersion(record.room.playback);
    }
  }

  private assertTrackLimits(input: Omit<TrackMeta, "id"> & { id?: string }) {
    if (input.durationMs > maxTrackDurationMs) {
      throw new BadRequestException("曲目时长超过允许的最大值。");
    }
    if (input.sizeBytes !== null && input.sizeBytes !== undefined && input.sizeBytes > maxTrackSizeBytes) {
      throw new BadRequestException("曲目文件超过允许的最大大小。");
    }

    const manifests = [input.originalAsset, input.playbackAsset].filter(Boolean);
    if (manifests.some((manifest) => manifest && manifest.unitCount > maxAssetUnits)) {
      throw new BadRequestException("音频资源分片数量超过允许的最大值。");
    }
    if (input.playbackAsset && input.playbackAsset.durationMs > maxTrackDurationMs) {
      throw new BadRequestException("播放资源时长超过允许的最大值。");
    }
    if (input.originalAsset && input.originalAsset.sizeBytes > maxTrackSizeBytes) {
      throw new BadRequestException("原始音频资源超过允许的最大大小。");
    }
  }
}

function getProviderTrackKey(track: TrackMeta | undefined) {
  return track?.sourceRef ? `${track.sourceRef.provider}:${track.sourceRef.trackId}` : null;
}
