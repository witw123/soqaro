import type { GaplessTransition, PlaybackMode, PlaybackSnapshot } from "@soqaro/shared";
import { synchronizeShuffleBagTrackIds } from "@soqaro/shared";
import type { RoomRecord } from "../room.types";
import { RoomPresenceService } from "./room-presence.service";
import {
  assertRequestedPlaybackAsset,
  bumpPlaybackVersion,
  canPreserveMediaEpoch,
  clampPositionMs,
  getCurrentQueueIndex,
  getEffectivePlaybackPositionMs,
  getGaplessTransitionAt,
  getTrackDurationMs,
  pausePlaybackAt,
  pickTrackSourceCandidate
} from "./room-playback.helpers";

export class RoomPlaybackService {
  constructor(private readonly roomPresenceService: RoomPresenceService) {}

  async updatePlayback(
    record: RoomRecord,
    input: {
      action: "play" | "pause" | "seek" | "next" | "prev" | "gapless-next" | "set-mode";
      trackId?: string;
      queueItemId?: string;
      playbackAssetId?: string;
      positionMs?: number;
      playbackMode?: PlaybackMode;
    }
  ): Promise<PlaybackSnapshot> {
    const playback = record.room.playback;

    if (input.action === "gapless-next") {
      const transition = await this.resolveGaplessTransition(record);
      if (
        !transition ||
        transition.trackId !== input.trackId ||
        transition.queueItemId !== (input.queueItemId ?? null) ||
        Date.now() < Date.parse(transition.transitionAt)
      ) {
        throw new Error("Gapless transition is not ready.");
      }
      await this.applyTrackPlayback(
        record,
        transition.trackId,
        0,
        transition.queueItemId,
        transition.playbackAssetId,
        {
          startAt: transition.transitionAt,
          preserveMediaEpoch: canPreserveMediaEpoch(playback, transition)
        }
      );
    }

    if (input.action === "set-mode") {
      if (!input.playbackMode) {
        throw new Error("Playback mode is required when changing playback order.");
      }
      const previousMode = playback.playbackMode ?? "sequence";
      playback.playbackMode = input.playbackMode;
      if (input.playbackMode === "shuffle") {
        playback.shuffleBagTrackIds = synchronizeShuffleBagTrackIds(
          previousMode === "shuffle" ? playback.shuffleBagTrackIds ?? [] : [],
          record.queue.map((item) => item.trackId),
          playback.currentTrackId,
          previousMode === "shuffle" ? [] : record.queue.map((item) => item.trackId)
        );
      } else {
        playback.shuffleBagTrackIds = [];
      }
    }

    if (input.action === "next") {
      await this.advanceByPlaybackMode(record, "next", input.positionMs ?? 0);
    }

    if (input.action === "prev") {
      await this.advanceByPlaybackMode(record, "prev", input.positionMs ?? 0);
    }

    if (input.action === "play") {
      const queuedNext = playback.nextQueueItemId
        ? record.queue.find((item) => item.id === playback.nextQueueItemId)
        : undefined;
      let nextTrackId =
        input.trackId ?? playback.currentTrackId ?? queuedNext?.trackId ?? record.queue[0]?.trackId ?? null;
      let nextQueueItemId: string | null =
        input.queueItemId ?? (
          input.trackId === undefined
            ? playback.currentQueueItemId ?? queuedNext?.id ?? null
            : null
        );

      if (input.queueItemId) {
        const queueItem = record.queue.find((item) => item.id === input.queueItemId);
        if (!queueItem) {
          throw new Error("Queue item not found in this room.");
        }
        nextTrackId = queueItem.trackId;
        nextQueueItemId = queueItem.id;
      }
      if (!nextQueueItemId && nextTrackId) {
        nextQueueItemId = record.queue.find((item) => item.trackId === nextTrackId)?.id ?? null;
      }
      if (!nextTrackId) {
        this.clearPlayback(playback, { bumpVersion: false });
      } else {
        // Same track can appear multiple times in the queue. Switching queue
        // items must restart playback even when trackId is unchanged.
        const isQueueItemSwitch =
          nextQueueItemId !== null && nextQueueItemId !== playback.currentQueueItemId;
        const isTrackSwitch = nextTrackId !== playback.currentTrackId;
        const shouldRestart = isTrackSwitch || isQueueItemSwitch;
        // Prefer client-supplied position; only derive from wall clock when omitted.
        const startPositionMs =
          input.positionMs ??
          (shouldRestart ? 0 : getEffectivePlaybackPositionMs(record, playback));
        await this.applyTrackPlayback(
          record,
          nextTrackId,
          startPositionMs,
          nextQueueItemId,
          input.playbackAssetId
        );
        if (playback.playbackMode === "shuffle") {
          this.markShuffleTrackPlayed(record, nextTrackId);
        }
      }
    }

    if (input.action === "pause") {
      const currentTrack = record.tracks.find((track) => track.id === playback.currentTrackId);
      assertRequestedPlaybackAsset(currentTrack, input.playbackAssetId);
      const sourceCandidate = playback.currentTrackId
        ? await this.resolveTrackSourceCandidate(record, playback.currentTrackId, {
            preferredSessionId: playback.sourceSessionId
          })
        : null;
      const pausePositionMs =
        input.positionMs ?? getEffectivePlaybackPositionMs(record, playback);
      pausePlaybackAt(record, pausePositionMs, {
        sourceCandidate,
        bumpMediaEpoch: false
      });
    }

    if (input.action === "seek") {
      const currentTrack = record.tracks.find((track) => track.id === playback.currentTrackId);
      assertRequestedPlaybackAsset(currentTrack, input.playbackAssetId);
      const sourceCandidate = playback.currentTrackId
        ? await this.resolveTrackSourceCandidate(record, playback.currentTrackId, {
            preferredSessionId: playback.sourceSessionId
          })
        : null;
      if (
        playback.status === "playing" &&
        playback.currentTrackId &&
        !sourceCandidate
      ) {
        throw new Error("Track owner is not online, so this song cannot be played right now.");
      }

      if (
        sourceCandidate &&
        (playback.sourceSessionId !== sourceCandidate.sessionId ||
          playback.sourcePeerId !== sourceCandidate.peerId)
      ) {
        playback.sourceSessionId = sourceCandidate.sessionId;
        playback.sourcePeerId = sourceCandidate.peerId;
        playback.mediaEpoch += 1;
      }

      // Seek position is always client-authoritative when provided.
      playback.positionMs = clampPositionMs(
        record,
        playback.currentTrackId,
        input.positionMs ?? 0
      );
      if (playback.status === "playing") {
        const startAt = new Date().toISOString();
        playback.startAt = startAt;
        playback.startedAt = startAt;
      } else {
        playback.startAt = null;
        playback.startedAt = null;
      }
    }

    bumpPlaybackVersion(playback);
    return this.buildPlaybackForSnapshot(record);
  }

  async buildPlaybackForSnapshot(record: RoomRecord, activePresence?: Map<string, string>) {
    const resolvedPresence =
      activePresence ??
      (await this.roomPresenceService.getActivePresence(record.room.id, record.room.members));
    const storedSourcePeerId = record.room.playback.sourcePeerId;
    return {
      ...record.room.playback,
      sourcePeerId:
        record.room.playback.sourceSessionId && storedSourcePeerId
          ? resolvedPresence.get(record.room.playback.sourceSessionId) ?? null
          : null,
      gaplessNext: await this.resolveGaplessTransition(record, resolvedPresence)
    };
  }

  async applyTrackPlayback(
    record: RoomRecord,
    trackId: string,
    positionMs: number,
    queueItemId: string | null,
    requestedPlaybackAssetId?: string,
    options?: {
      startAt?: string;
      preserveMediaEpoch?: boolean;
    }
  ) {
    const playback = record.room.playback;
    const track = record.tracks.find((item) => item.id === trackId);
    if (!track) {
      throw new Error(`Track not found in room: ${trackId}`);
    }

    assertRequestedPlaybackAsset(track, requestedPlaybackAssetId);
    const sourceCandidate = await this.resolveTrackSourceCandidate(record, trackId);
    if (!sourceCandidate) {
      throw new Error("Track owner is not online, so this song cannot be played right now.");
    }

    const isTrackSwitch = playback.currentTrackId !== trackId;
    const isQueueItemSwitch =
      queueItemId !== null && playback.currentQueueItemId !== queueItemId;
    const isSwitchingSource =
      !!sourceCandidate &&
      (playback.sourceSessionId !== sourceCandidate.sessionId ||
        playback.sourcePeerId !== sourceCandidate.peerId);

    playback.status = "playing";
    playback.currentTrackId = trackId;
    playback.currentQueueItemId = queueItemId;
    playback.playbackAssetId = track.playbackAsset?.assetId ?? null;
    playback.sourceSessionId = sourceCandidate.sessionId;
    playback.sourcePeerId = sourceCandidate.peerId;
    playback.sourceTrackId = trackId;
    playback.positionMs = clampPositionMs(record, trackId, positionMs);
    const startAt = options?.startAt ?? new Date().toISOString();
    playback.startAt = startAt;
    playback.startedAt = startAt;
    playback.nextQueueItemId = null;
    // Queue-item switches need a media epoch bump so clients remount local
    // playback even when the underlying track asset is unchanged.
    if ((isTrackSwitch || isQueueItemSwitch || isSwitchingSource) && !options?.preserveMediaEpoch) {
      playback.mediaEpoch += 1;
    }
  }

  /**
   * Advance to the next playable queue item after the current one.
   * Optionally wraps to the start of the queue and skips tracks whose owners are
   * offline. When nothing playable remains, pauses at the end of the current track.
   */
  async advanceToNextPlayable(
    record: RoomRecord,
    options?: {
      positionMs?: number;
      wrap?: boolean;
    }
  ): Promise<"advanced" | "paused-at-end" | "cleared"> {
    const playback = record.room.playback;
    const currentIndex = getCurrentQueueIndex(record);
    const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
    const candidate = await this.findPlayableQueueItem(record, startIndex, 1, {
      wrap: options?.wrap === true
    });

    if (candidate) {
      await this.applyTrackPlayback(
        record,
        candidate.trackId,
        options?.positionMs ?? 0,
        candidate.id
      );
      return "advanced";
    }

    if (playback.currentTrackId) {
      const endPositionMs = getTrackDurationMs(record, playback.currentTrackId);
      pausePlaybackAt(record, endPositionMs, {
        sourceCandidate: null,
        bumpMediaEpoch: true,
        clearSourcePeer: true
      });
      return "paused-at-end";
    }

    this.clearPlayback(playback, { bumpVersion: false });
    return "cleared";
  }

  private async advanceByPlaybackMode(
    record: RoomRecord,
    direction: "next" | "prev",
    positionMs: number
  ) {
    if (direction === "next") {
      const playback = record.room.playback;
      const queuedNextId = playback.nextQueueItemId;
      if (queuedNextId) {
        // Consume the preference before resolving the fallback path. A stale
        // or offline item must not block the normal playback mode forever.
        playback.nextQueueItemId = null;
        const queuedNext = record.queue.find((item) => item.id === queuedNextId);
        if (
          queuedNext &&
          queuedNext.id !== playback.currentQueueItemId &&
          await this.resolveTrackSourceCandidate(record, queuedNext.trackId)
        ) {
          await this.applyTrackPlayback(
            record,
            queuedNext.trackId,
            positionMs,
            queuedNext.id
          );
          return "advanced" as const;
        }
      }
    }

    const mode = record.room.playback.playbackMode ?? "sequence";

    if (mode === "single") {
      const playback = record.room.playback;
      const currentTrackId = playback.currentTrackId;
      if (currentTrackId) {
        const currentQueueItemId = playback.currentQueueItemId;
        const sourceCandidate = await this.resolveTrackSourceCandidate(record, currentTrackId);
        if (sourceCandidate) {
          await this.applyTrackPlayback(
            record,
            currentTrackId,
            positionMs,
            currentQueueItemId
          );
          return "advanced" as const;
        }

        pausePlaybackAt(record, getTrackDurationMs(record, currentTrackId), {
          sourceCandidate: null,
          bumpMediaEpoch: true,
          clearSourcePeer: true
        });
        return "paused-at-end" as const;
      }
      return this.advanceToNextPlayable(record, { positionMs, wrap: false });
    }

    if (mode === "shuffle") {
      const randomized = await this.advanceToRandomPlayable(record, positionMs);
      if (randomized) {
        return "advanced" as const;
      }

      if (record.room.playback.currentTrackId) {
        pausePlaybackAt(record, getTrackDurationMs(record, record.room.playback.currentTrackId), {
          sourceCandidate: null,
          bumpMediaEpoch: true,
          clearSourcePeer: true
        });
        return "paused-at-end" as const;
      }

      this.clearPlayback(record.room.playback, { bumpVersion: false });
      return "cleared" as const;
    }

    return direction === "next"
      ? this.advanceToNextPlayable(record, { positionMs, wrap: true })
      : this.advanceToPreviousPlayable(record, { positionMs });
  }

  private async advanceToRandomPlayable(record: RoomRecord, positionMs: number) {
    const playback = record.room.playback;
    const trackIds = [...new Set(record.queue.map((item) => item.trackId))];
    if (trackIds.length === 0) {
      return false;
    }

    const bag = synchronizeShuffleBagTrackIds(
      playback.shuffleBagTrackIds ?? [],
      trackIds,
      playback.currentTrackId,
      []
    );
    playback.shuffleBagTrackIds = bag;

    let candidateTrackId: string | null = null;
    for (const trackId of bag) {
      if (trackId === playback.currentTrackId) {
        continue;
      }
      if (await this.resolveTrackSourceCandidate(record, trackId)) {
        candidateTrackId = trackId;
        break;
      }
    }

    // A one-track queue still loops in shuffle mode rather than stopping.
    if (!candidateTrackId && trackIds.length === 1 && playback.currentTrackId === trackIds[0]) {
      if (await this.resolveTrackSourceCandidate(record, trackIds[0])) {
        candidateTrackId = trackIds[0];
        playback.shuffleBagTrackIds = [];
      }
    }

    if (!candidateTrackId) {
      return false;
    }

    const candidate = record.queue.find((item) => item.trackId === candidateTrackId);
    if (!candidate) {
      return false;
    }

    playback.shuffleBagTrackIds = bag.filter((trackId) => trackId !== candidateTrackId);
    await this.applyTrackPlayback(record, candidate.trackId, positionMs, candidate.id);
    return true;
  }

  syncShuffleBagWithQueue(record: RoomRecord, addedTrackIds: readonly string[]) {
    const playback = record.room.playback;
    if (playback.playbackMode !== "shuffle") {
      playback.shuffleBagTrackIds = [];
      return;
    }

    playback.shuffleBagTrackIds = synchronizeShuffleBagTrackIds(
      playback.shuffleBagTrackIds ?? [],
      record.queue.map((item) => item.trackId),
      playback.currentTrackId,
      addedTrackIds
    );
  }

  private markShuffleTrackPlayed(record: RoomRecord, trackId: string) {
    const playback = record.room.playback;
    playback.shuffleBagTrackIds = synchronizeShuffleBagTrackIds(
      playback.shuffleBagTrackIds ?? [],
      record.queue.map((item) => item.trackId),
      trackId,
      []
    ).filter((candidateTrackId) => candidateTrackId !== trackId);
  }

  async advanceToPreviousPlayable(
    record: RoomRecord,
    options?: {
      positionMs?: number;
    }
  ): Promise<"advanced" | "restarted" | "cleared"> {
    const playback = record.room.playback;
    const currentIndex = getCurrentQueueIndex(record);
    const startIndex = currentIndex > 0 ? currentIndex - 1 : record.queue.length - 1;

    const candidate = await this.findPlayableQueueItem(record, startIndex, -1, {
      wrap: true
    });
    if (candidate) {
      await this.applyTrackPlayback(
        record,
        candidate.trackId,
        options?.positionMs ?? 0,
        candidate.id
      );
      return "advanced";
    }

    if (playback.currentTrackId) {
      // Stay on the first / current track and restart from the requested position.
      await this.applyTrackPlayback(
        record,
        playback.currentTrackId,
        options?.positionMs ?? 0,
        playback.currentQueueItemId
      );
      return "restarted";
    }

    if (record.queue[0]) {
      const fallback = await this.findPlayableQueueItem(record, 0, 1, { wrap: true });
      if (fallback) {
        await this.applyTrackPlayback(
          record,
          fallback.trackId,
          options?.positionMs ?? 0,
          fallback.id
        );
        return "advanced";
      }
    }

    this.clearPlayback(playback, { bumpVersion: false });
    return "cleared";
  }

  /**
   * Server-side guard for tracks that finished without a client next call.
   * Returns true when playback state was mutated.
   */
  async advanceIfTrackEnded(record: RoomRecord): Promise<boolean> {
    const playback = record.room.playback;
    if (playback.status !== "playing" || !playback.currentTrackId) {
      return false;
    }

    const durationMs = getTrackDurationMs(record, playback.currentTrackId);
    if (durationMs <= 0) {
      return false;
    }

    const positionMs = getEffectivePlaybackPositionMs(record, playback);
    if (positionMs < durationMs) {
      return false;
    }

    if (await this.shouldDeferTrackEndForReconnectingSource(record)) {
      return false;
    }

    await this.advanceByPlaybackMode(record, "next", 0);
    bumpPlaybackVersion(playback);
    return true;
  }

  /**
   * Advances to another playable queue item when the active track's asset is
   * reported unavailable during playback. Returns false when no alternative
   * playable track exists so the caller can pause cleanly.
   */
  async advanceAfterUnavailableTrack(
    record: RoomRecord,
    unavailableTrackId: string
  ): Promise<boolean> {
    const playback = record.room.playback;
    if (playback.status !== "playing" || playback.currentTrackId !== unavailableTrackId) {
      return false;
    }

    const mode = playback.playbackMode ?? "sequence";
    if (mode === "single") {
      return false;
    }

    const excludedTrackIds = new Set([unavailableTrackId]);
    if (mode === "shuffle") {
      const trackIds = [...new Set(record.queue.map((item) => item.trackId))]
        .filter((trackId) => !excludedTrackIds.has(trackId));
      if (trackIds.length === 0) {
        return false;
      }
      const bag = synchronizeShuffleBagTrackIds(
        playback.shuffleBagTrackIds ?? [],
        trackIds,
        unavailableTrackId,
        []
      );
      let candidateTrackId: string | null = null;
      for (const trackId of bag) {
        if (excludedTrackIds.has(trackId)) continue;
        if (await this.resolveTrackSourceCandidate(record, trackId)) {
          candidateTrackId = trackId;
          break;
        }
      }
      if (!candidateTrackId) {
        return false;
      }
      const candidate = record.queue.find((item) => item.trackId === candidateTrackId);
      if (!candidate) {
        return false;
      }
      playback.shuffleBagTrackIds = bag.filter((trackId) => trackId !== candidateTrackId);
      await this.applyTrackPlayback(record, candidate.trackId, 0, candidate.id);
      bumpPlaybackVersion(playback);
      return true;
    }

    const currentIndex = getCurrentQueueIndex(record);
    const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
    const candidate = await this.findPlayableQueueItem(record, startIndex, 1, {
      wrap: true,
      excludedTrackIds
    });
    if (!candidate) {
      return false;
    }

    await this.applyTrackPlayback(record, candidate.trackId, 0, candidate.id);
    bumpPlaybackVersion(playback);
    return true;
  }

  async advanceGaplessIfDue(record: RoomRecord): Promise<boolean> {
    const playback = record.room.playback;
    const transitionAtMs = getGaplessTransitionAt(record);
    if (transitionAtMs === null || Date.now() < transitionAtMs) {
      return false;
    }

    const transition = await this.resolveGaplessTransition(record);
    if (!transition) {
      return false;
    }

    await this.applyTrackPlayback(
      record,
      transition.trackId,
      0,
      transition.queueItemId,
      transition.playbackAssetId,
      {
        startAt: transition.transitionAt,
        preserveMediaEpoch: canPreserveMediaEpoch(playback, transition)
      }
    );
    bumpPlaybackVersion(playback);
    return true;
  }

  clearPlayback(playback: PlaybackSnapshot, options?: { bumpVersion?: boolean }) {
    playback.status = "paused";
    playback.currentTrackId = null;
    playback.currentQueueItemId = null;
    playback.nextQueueItemId = null;
    playback.playbackAssetId = null;
    playback.startAt = null;
    playback.sourceSessionId = null;
    playback.sourcePeerId = null;
    playback.sourceTrackId = null;
    playback.positionMs = 0;
    playback.startedAt = null;
    playback.mediaEpoch += 1;
    if (options?.bumpVersion !== false) {
      bumpPlaybackVersion(playback);
    }
  }

  /**
   * A provider-backed track can keep its room timeline while the uploader is
   * offline. Listeners will resolve the provider source locally; local uploads
   * still pause because they have no remote source to fall back to.
   */
  handleSourceDeparture(record: RoomRecord, sessionId: string) {
    const playback = record.room.playback;
    if (!playback.currentTrackId || playback.sourceSessionId !== sessionId) {
      return false;
    }

    const positionMs = getEffectivePlaybackPositionMs(record, playback);
    pausePlaybackAt(record, positionMs, {
      sourceCandidate: null,
      bumpMediaEpoch: true,
      clearSourcePeer: true,
      keepSourceSessionId: true
    });
    bumpPlaybackVersion(playback);
    return true;
  }

  handleSourcePeerOnline(record: RoomRecord, sessionId: string, peerId: string) {
    const playback = record.room.playback;
    if (
      playback.status !== "playing" ||
      !playback.currentTrackId ||
      playback.sourceSessionId !== sessionId ||
      playback.sourcePeerId === peerId
    ) {
      return false;
    }

    playback.sourcePeerId = peerId;
    playback.mediaEpoch += 1;
    bumpPlaybackVersion(playback);
    return true;
  }

  pausePlaybackForSessionReplacement(record: RoomRecord, sessionId: string) {
    const playback = record.room.playback;
    if (!playback.currentTrackId || playback.sourceSessionId !== sessionId) {
      return false;
    }

    const positionMs = getEffectivePlaybackPositionMs(record, playback);
    pausePlaybackAt(record, positionMs, {
      sourceCandidate: null,
      bumpMediaEpoch: true,
      clearSourcePeer: true,
      keepSourceSessionId: true
    });
    bumpPlaybackVersion(playback);
    return true;
  }



  private async shouldDeferTrackEndForReconnectingSource(record: RoomRecord): Promise<boolean> {
    if (typeof this.roomPresenceService.getPresenceSnapshot !== "function") {
      return false;
    }

    const playback = record.room.playback;
    const mode = playback.playbackMode ?? "sequence";
    const activePresence = await this.roomPresenceService.getActivePresence(
      record.room.id,
      record.room.members
    );
    const trackById = new Map(record.tracks.map((track) => [track.id, track]));

    const candidateTrackIds = new Set<string>();
    if (playback.nextQueueItemId) {
      const explicitNext = record.queue.find((item) => item.id === playback.nextQueueItemId);
      if (explicitNext && explicitNext.id !== playback.currentQueueItemId) {
        candidateTrackIds.add(explicitNext.trackId);
      }
    }
    if (mode === "single") {
      if (playback.currentTrackId) {
        candidateTrackIds.add(playback.currentTrackId);
      }
    } else {
      for (const item of record.queue) {
        candidateTrackIds.add(item.trackId);
      }
    }

    for (const trackId of candidateTrackIds) {
      if (
        mode === "shuffle" &&
        candidateTrackIds.size > 1 &&
        trackId === playback.currentTrackId
      ) {
        continue;
      }
      const track = trackById.get(trackId);
      if (track && pickTrackSourceCandidate(track, activePresence)) {
        return false;
      }
    }

    const presenceSnapshot = await this.roomPresenceService.getPresenceSnapshot(
      record.room.id,
      record.room.members
    );
    for (const trackId of candidateTrackIds) {
      const track = trackById.get(trackId);
      if (!track) continue;
      if (presenceSnapshot.get(track.ownerSessionId)?.presenceState === "reconnecting") {
        return true;
      }
    }

    return false;
  }

  private async findPlayableQueueItem(
    record: RoomRecord,
    startIndex: number,
    direction: 1 | -1,
    options: { wrap: boolean; excludedTrackIds?: Set<string> }
  ) {
    if (record.queue.length === 0) {
      return null;
    }

    const excludedTrackIds = options.excludedTrackIds;
    const visited = new Set<number>();
    let index = startIndex;

    while (index >= 0 && index < record.queue.length && !visited.has(index)) {
      visited.add(index);
      const item = record.queue[index]!;
      if (!excludedTrackIds?.has(item.trackId)) {
        const sourceCandidate = await this.resolveTrackSourceCandidate(record, item.trackId);
        if (sourceCandidate) {
          return item;
        }
      }
      index += direction;
    }

    if (!options.wrap) {
      return null;
    }

    if (direction > 0) {
      for (let i = 0; i < startIndex && i < record.queue.length; i += 1) {
        if (visited.has(i)) continue;
        const item = record.queue[i]!;
        if (excludedTrackIds?.has(item.trackId)) continue;
        const sourceCandidate = await this.resolveTrackSourceCandidate(record, item.trackId);
        if (sourceCandidate) {
          return item;
        }
      }
    } else if (direction < 0) {
      for (let i = record.queue.length - 1; i > startIndex && i >= 0; i -= 1) {
        if (visited.has(i)) continue;
        const item = record.queue[i]!;
        if (excludedTrackIds?.has(item.trackId)) continue;
        const sourceCandidate = await this.resolveTrackSourceCandidate(record, item.trackId);
        if (sourceCandidate) {
          return item;
        }
      }
    }

    return null;
  }



  private async resolveGaplessTransition(
    record: RoomRecord,
    activePresence?: Map<string, string>
  ): Promise<GaplessTransition | null> {
    const playback = record.room.playback;
    if (
      playback.status !== "playing" ||
      playback.playbackMode !== "sequence" ||
      !playback.currentTrackId ||
      !playback.startAt ||
      !playback.sourceSessionId ||
      playback.nextQueueItemId
    ) {
      return null;
    }

    const transitionAtMs = getGaplessTransitionAt(record);
    const currentTrack = record.tracks.find((track) => track.id === playback.currentTrackId);
    const currentIndex = getCurrentQueueIndex(record);
    const nextQueueItem = currentIndex >= 0
      ? (record.queue[currentIndex + 1] ?? record.queue[0])
      : record.queue[0];
    const nextTrack = nextQueueItem
      ? record.tracks.find((track) => track.id === nextQueueItem.trackId)
      : undefined;
    if (
      !currentTrack ||
      transitionAtMs === null ||
      !nextQueueItem ||
      !nextTrack?.playbackAsset ||
      nextTrack.durationMs <= 0
    ) {
      return null;
    }

    const presence = activePresence ?? await this.roomPresenceService.getActivePresence(
      record.room.id,
      record.room.members
    );
    const nextSource = pickTrackSourceCandidate(nextTrack, presence);
    if (!nextSource || nextSource.sessionId !== playback.sourceSessionId) {
      return null;
    }

    return {
      trackId: nextTrack.id,
      queueItemId: nextQueueItem.id,
      playbackAssetId: nextTrack.playbackAsset.assetId,
      durationMs: nextTrack.durationMs,
      transitionAt: new Date(transitionAtMs).toISOString(),
      sourceSessionId: nextSource.sessionId,
      sourcePeerId: nextSource.peerId
    };
  }

  private async resolveTrackSourceCandidate(
    record: RoomRecord,
    trackId: string,
    options?: {
      preferredSessionId?: string | null;
      excludedSessionIds?: Set<string>;
    }
  ) {
    const track = record.tracks.find((item) => item.id === trackId);
    if (!track) {
      return null;
    }

    const activePresence = await this.roomPresenceService.getActivePresence(
      record.room.id,
      record.room.members
    );
    return pickTrackSourceCandidate(track, activePresence, options);
  }

  getEffectivePlaybackPositionMs(record: RoomRecord, playback: PlaybackSnapshot) {
    return getEffectivePlaybackPositionMs(record, playback);
  }
}
