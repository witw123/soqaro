import type { PlaybackSnapshot } from "@soqaro/shared";

export type PlaybackMutationTarget = Pick<
  PlaybackSnapshot,
  "currentTrackId" | "currentQueueItemId"
> & {
  startedAt?: string | null;
  startAt?: string | null;
  status?: PlaybackSnapshot["status"];
};

export type PlaybackMutationOptions = {
  refreshSnapshotOnSuccess?: boolean;
  requireSameTimelineAnchor?: boolean;
  silentOnConflictSkip?: boolean;
  returnSnapshotOnConflictSkip?: boolean;
};

export async function runBestEffortRoomLeave(input: {
  roomId: string;
  leaveRemote: (roomId: string) => Promise<unknown>;
  completeLocalExit: () => Promise<void> | void;
  remoteWaitMs?: number;
}) {
  const remoteLeave = Promise.resolve()
    .then(() => input.leaveRemote(input.roomId))
    .then(() => ({
      remoteStatus: "confirmed" as const,
      remoteError: null
    }))
    .catch((error) => ({
      remoteStatus: "failed" as const,
      remoteError: error
    }));

  await input.completeLocalExit();

  const remoteWaitMs = input.remoteWaitMs ?? 1_200;
  return Promise.race([
    remoteLeave,
    new Promise<{ remoteStatus: "pending"; remoteError: null }>((resolve) => {
      globalThis.setTimeout(() => {
        resolve({
          remoteStatus: "pending",
          remoteError: null
        });
      }, remoteWaitMs);
    })
  ]);
}

export function shouldResetPlayerAfterQueueRemoval(
  previousPlayback: Pick<PlaybackSnapshot, "currentTrackId">,
  nextPlayback: Pick<PlaybackSnapshot, "currentTrackId">
) {
  return Boolean(previousPlayback.currentTrackId && !nextPlayback.currentTrackId);
}

export function shouldResetPlayerAfterTrackRemoval(
  removedTrackId: string,
  currentTrackId: string | null | undefined
) {
  return removedTrackId === currentTrackId;
}

export function shouldRetryPlaybackMutationAfterConflict(
  expectedTarget: PlaybackMutationTarget,
  latestPlayback: PlaybackMutationTarget,
  options?: Pick<PlaybackMutationOptions, "requireSameTimelineAnchor">
) {
  if (
    expectedTarget.currentTrackId !== latestPlayback.currentTrackId ||
    expectedTarget.currentQueueItemId !== latestPlayback.currentQueueItemId
  ) {
    return false;
  }

  if (options?.requireSameTimelineAnchor) {
    if (
      expectedTarget.status !== undefined &&
      latestPlayback.status !== undefined &&
      expectedTarget.status !== latestPlayback.status
    ) {
      return false;
    }

    const expectedAnchor = expectedTarget.startAt ?? expectedTarget.startedAt ?? null;
    const latestAnchor = latestPlayback.startAt ?? latestPlayback.startedAt ?? null;
    if (expectedAnchor !== latestAnchor) {
      return false;
    }
  }

  return true;
}

export function hasPlaybackTimelineAdvanced(
  previousPlayback: Pick<
    PlaybackSnapshot,
    | "currentTrackId"
    | "currentQueueItemId"
    | "status"
    | "startAt"
    | "startedAt"
    | "playbackRevision"
  >,
  nextPlayback: PlaybackSnapshot | null | undefined
) {
  if (!nextPlayback) {
    return false;
  }

  return (
    nextPlayback.currentTrackId !== previousPlayback.currentTrackId ||
    nextPlayback.currentQueueItemId !== previousPlayback.currentQueueItemId ||
    nextPlayback.status !== previousPlayback.status ||
    (nextPlayback.startAt ?? nextPlayback.startedAt ?? null) !==
      (previousPlayback.startAt ?? previousPlayback.startedAt ?? null) ||
    nextPlayback.playbackRevision > previousPlayback.playbackRevision
  );
}

export function createPendingSeekPlayback(input: {
  playback: PlaybackSnapshot;
  positionMs: number;
  durationMs?: number | null;
}) {
  const durationMs = input.durationMs ?? 0;
  const positionMs =
    durationMs > 0
      ? Math.min(Math.max(0, input.positionMs), durationMs)
      : Math.max(0, input.positionMs);
  return {
    ...input.playback,
    positionMs,
    // Stop the old segmented timeline immediately, but do not create a
    // client-clock timeline that will be replaced by the server clock.
    startAt: null,
    startedAt: null,
    playbackRevision: input.playback.playbackRevision + 1
  } satisfies PlaybackSnapshot;
}

export function createPendingPausePlayback(input: {
  playback: PlaybackSnapshot;
  positionMs: number;
  durationMs?: number | null;
}) {
  const durationMs = input.durationMs ?? 0;
  const positionMs =
    durationMs > 0
      ? Math.min(Math.max(0, input.positionMs), durationMs)
      : Math.max(0, input.positionMs);

  return {
    ...input.playback,
    status: "paused",
    positionMs,
    startedAt: null,
    startAt: null,
    playbackRevision: input.playback.playbackRevision + 1
  } satisfies PlaybackSnapshot;
}
