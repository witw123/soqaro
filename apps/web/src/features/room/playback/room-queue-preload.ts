import type { RoomSnapshot, TrackMeta } from "@soqaro/shared";

export function getRoomQueuePreloadTracks(snapshot: RoomSnapshot) {
  const { playback } = snapshot.room;
  const { queue, tracks } = snapshot;
  const index = queue.findIndex((item) => item.id === playback.currentQueueItemId);
  const orderedIds = playback.playbackMode === "shuffle"
    ? playback.shuffleBagTrackIds ?? []
    : playback.playbackMode === "single"
      ? []
      : [...queue.slice(index + 1), ...queue.slice(0, Math.max(0, index))]
          .map((item) => item.trackId);
  const explicitNext = queue.find((item) => item.id === playback.nextQueueItemId)?.trackId;
  const ids = [...new Set([
    explicitNext,
    playback.gaplessNext?.trackId,
    ...orderedIds
  ].filter((id): id is string => !!id && id !== playback.currentTrackId))];
  return ids.slice(0, 2)
    .flatMap((id) => tracks.find((track) => track.id === id) ?? []);
}

/**
 * Returns all upcoming candidate tracks in playback-mode priority order without
 * truncating before owner/failure filtering, so unplayable or foreign-owned
 * tracks never block background asset preparation for later queue items.
 */
export function getRoomUpcomingPreparationTracks(snapshot: RoomSnapshot): TrackMeta[] {
  const { playback } = snapshot.room;
  const { queue, tracks } = snapshot;
  const index = queue.findIndex((item) => item.id === playback.currentQueueItemId);
  const sequentialIds = [...queue.slice(index + 1), ...queue.slice(0, Math.max(0, index))]
    .map((item) => item.trackId);
  const orderedIds = playback.playbackMode === "shuffle"
    ? [...(playback.shuffleBagTrackIds ?? []), ...sequentialIds]
    : playback.playbackMode === "single"
      ? []
      : sequentialIds;
  const explicitNext = queue.find((item) => item.id === playback.nextQueueItemId)?.trackId;
  const ids = [...new Set([
    explicitNext,
    playback.gaplessNext?.trackId,
    ...orderedIds
  ].filter((id): id is string => !!id && id !== playback.currentTrackId))];
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  return ids.flatMap((id) => {
    const track = trackById.get(id);
    return track ? [track] : [];
  });
}

/** Retains only the current track and the next two local file reads. */
export class RoomAudioPreloader {
  private files = new Map<string, Promise<Blob | null>>();

  constructor(private readonly readFile: (track: TrackMeta) => Promise<Blob | null>) {}

  update(tracks: TrackMeta[]) {
    const wanted = new Set(tracks.map((track) => this.key(track)));
    for (const key of this.files.keys()) {
      if (!wanted.has(key)) this.files.delete(key);
    }
    for (const track of tracks) {
      void this.get(track).catch(() => undefined);
    }
  }

  get(track: TrackMeta) {
    const key = this.key(track);
    const existing = this.files.get(key);
    if (existing) return existing;
    const loading = this.readFile(track);
    this.files.set(key, loading);
    void loading.catch(() => {
      if (this.files.get(key) === loading) this.files.delete(key);
    });
    return loading;
  }

  clear() {
    this.files.clear();
  }

  private key(track: TrackMeta) {
    return `${track.id}:${track.fileHash}:${track.originalAsset?.assetId ?? ""}`;
  }
}
