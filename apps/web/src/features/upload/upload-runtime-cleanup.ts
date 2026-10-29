type StateSetter<TState> = (updater: (current: TState) => TState) => void;
type RuntimeRef<TValue> = {
  current: TValue;
};

export function syncUploadedTrackObjectUrls(input: {
  currentUrls: Map<string, string>;
  uploadedTracks: Record<string, { objectUrl?: string }>;
  revokeObjectUrl: (objectUrl: string) => void;
}) {
  const nextUrls = new Map(
    Object.entries(input.uploadedTracks)
      .filter(([, upload]) => Boolean(upload?.objectUrl))
      .map(([trackId, upload]) => [trackId, upload.objectUrl!])
  );

  for (const [trackId, objectUrl] of input.currentUrls.entries()) {
    if (nextUrls.get(trackId) !== objectUrl) {
      input.revokeObjectUrl(objectUrl);
    }
  }

  return nextUrls;
}

export function cleanupUploadRuntimeRefs(input: {
  uploadedTrackUrlsRef: RuntimeRef<Map<string, string>>;
  cacheLibraryTracksRef: RuntimeRef<{ clear: () => void }>;
  revokeObjectUrl: (objectUrl: string) => void;
}) {
  for (const objectUrl of input.uploadedTrackUrlsRef.current.values()) {
    input.revokeObjectUrl(objectUrl);
  }
  input.uploadedTrackUrlsRef.current.clear();
  input.cacheLibraryTracksRef.current.clear();
}

export function pruneUploadRuntimeStateForActiveTracks<TUpload>(input: {
  activeTrackIds: Set<string>;
  uploadedTracks: Record<string, TUpload>;
}) {
  const nextUploadedTracks = { ...input.uploadedTracks };
  for (const trackId of Object.keys(input.uploadedTracks)) {
    if (!input.activeTrackIds.has(trackId)) {
      delete nextUploadedTracks[trackId];
    }
  }
  return nextUploadedTracks;
}

export function applyUploadRuntimePruneForActiveTracks<TUpload>(input: {
  activeTrackIds: Set<string>;
  setUploadedTracks: StateSetter<Record<string, TUpload>>;
}) {
  input.setUploadedTracks((current) =>
    pruneUploadRuntimeStateForActiveTracks({
      activeTrackIds: input.activeTrackIds,
      uploadedTracks: current
    })
  );
}
