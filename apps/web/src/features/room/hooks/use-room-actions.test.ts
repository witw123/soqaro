import { describe, expect, it, vi } from "vitest";
import {
  createPendingPausePlayback,
  createPendingSeekPlayback,
  hasPlaybackTimelineAdvanced,
  runBestEffortRoomLeave,
  shouldRetryPlaybackMutationAfterConflict,
  shouldResetPlayerAfterQueueRemoval,
  shouldResetPlayerAfterTrackRemoval
} from "./use-room-actions";

describe("optimistic playback seek", () => {
  it("stops the old timeline at the target until the server confirms the seek", () => {
    const nextPlayback = createPendingSeekPlayback({
      playback: {
        status: "playing",
        currentTrackId: "track_1",
        currentQueueItemId: "queue_1",
        playbackAssetId: "asset_1",
        startAt: "2026-07-22T00:00:00.000Z",
        sourceSessionId: "session_1",
        sourcePeerId: "peer_1",
        sourceTrackId: "track_1",
        positionMs: 10_000,
        startedAt: "2026-07-22T00:00:00.000Z",
        queueVersion: 1,
        playbackRevision: 4,
        mediaEpoch: 1,
        playbackMode: "sequence"
      },
      positionMs: 45_000,
      durationMs: 60_000
    });

    expect(nextPlayback).toMatchObject({
      positionMs: 45_000,
      startAt: null,
      startedAt: null,
      playbackRevision: 5
    });
  });
});

describe("optimistic playback pause", () => {
  it("stops the local timeline immediately while the room pause request is in flight", () => {
    const nextPlayback = createPendingPausePlayback({
      playback: {
        status: "playing",
        currentTrackId: "track_1",
        currentQueueItemId: "queue_1",
        playbackAssetId: "asset_1",
        startAt: "2026-08-11T00:00:00.000Z",
        sourceSessionId: "session_1",
        sourcePeerId: "peer_1",
        sourceTrackId: "track_1",
        positionMs: 10_000,
        startedAt: "2026-08-11T00:00:00.000Z",
        queueVersion: 1,
        playbackRevision: 4,
        mediaEpoch: 1,
        playbackMode: "sequence"
      },
      positionMs: 75_000,
      durationMs: 60_000
    });

    expect(nextPlayback).toMatchObject({
      status: "paused",
      positionMs: 60_000,
      startAt: null,
      startedAt: null,
      playbackRevision: 5
    });
  });
});

describe("player cleanup after removal", () => {
  it("resets only when the removed queue item is currently playing", () => {
    expect(
      shouldResetPlayerAfterQueueRemoval(
        { currentTrackId: "track_1" },
        { currentTrackId: null }
      )
    ).toBe(true);
    expect(
      shouldResetPlayerAfterQueueRemoval(
        { currentTrackId: "track_1" },
        { currentTrackId: "track_2" }
      )
    ).toBe(false);
    expect(
      shouldResetPlayerAfterQueueRemoval(
        { currentTrackId: null },
        { currentTrackId: null }
      )
    ).toBe(false);
  });

  it("resets only when the removed library track is currently playing", () => {
    expect(shouldResetPlayerAfterTrackRemoval("track_1", "track_1")).toBe(true);
    expect(shouldResetPlayerAfterTrackRemoval("track_2", "track_1")).toBe(false);
  });
});

describe("playback mutation conflict retry", () => {
  it("retries only while the active track and queue item are unchanged", () => {
    const expectedTarget = {
      currentTrackId: "track_1",
      currentQueueItemId: "queue_1"
    };

    expect(
      shouldRetryPlaybackMutationAfterConflict(expectedTarget, expectedTarget)
    ).toBe(true);
    expect(
      shouldRetryPlaybackMutationAfterConflict(expectedTarget, {
        currentTrackId: "track_2",
        currentQueueItemId: "queue_2"
      })
    ).toBe(false);
    expect(
      shouldRetryPlaybackMutationAfterConflict(expectedTarget, {
        currentTrackId: "track_1",
        currentQueueItemId: "queue_2"
      })
    ).toBe(false);
  });

  it("skips retrying track advance when single-track repeat already restarted on the server", () => {
    const expectedTarget = {
      currentTrackId: "track_1",
      currentQueueItemId: "queue_1",
      status: "playing" as const,
      startAt: "2026-07-22T00:00:00.000Z",
      startedAt: "2026-07-22T00:00:00.000Z"
    };

    expect(
      shouldRetryPlaybackMutationAfterConflict(
        expectedTarget,
        {
          ...expectedTarget,
          startAt: "2026-07-22T00:03:00.000Z",
          startedAt: "2026-07-22T00:03:00.000Z"
        },
        { requireSameTimelineAnchor: true }
      )
    ).toBe(false);

    expect(
      shouldRetryPlaybackMutationAfterConflict(
        expectedTarget,
        {
          ...expectedTarget,
          status: "paused"
        },
        { requireSameTimelineAnchor: true }
      )
    ).toBe(false);

    expect(
      shouldRetryPlaybackMutationAfterConflict(
        expectedTarget,
        expectedTarget,
        { requireSameTimelineAnchor: true }
      )
    ).toBe(true);
  });

  it("detects whether a playback timeline actually advanced or rolled back", () => {
    const previous = {
      status: "playing" as const,
      currentTrackId: "track_1",
      currentQueueItemId: "queue_1",
      playbackAssetId: "asset_1",
      startAt: "2026-07-22T00:00:00.000Z",
      startedAt: "2026-07-22T00:00:00.000Z",
      sourceSessionId: "session_1",
      sourcePeerId: "peer_1",
      sourceTrackId: "track_1",
      positionMs: 0,
      queueVersion: 1,
      playbackRevision: 4,
      mediaEpoch: 1,
      playbackMode: "single" as const
    };

    expect(hasPlaybackTimelineAdvanced(previous, previous)).toBe(false);
    expect(hasPlaybackTimelineAdvanced(previous, null)).toBe(false);
    expect(
      hasPlaybackTimelineAdvanced(previous, {
        ...previous,
        startAt: "2026-07-22T00:03:00.000Z",
        startedAt: "2026-07-22T00:03:00.000Z",
        playbackRevision: 5
      })
    ).toBe(true);
  });
});

describe("runBestEffortRoomLeave", () => {
  it("completes the local room exit even when the remote leave request fails", async () => {
    const completeLocalExit = vi.fn(async () => undefined);
    const remoteError = new Error("network timeout");

    const result = await runBestEffortRoomLeave({
      roomId: "room_1",
      leaveRemote: vi.fn(async () => {
        throw remoteError;
      }),
      completeLocalExit
    });

    expect(result).toEqual({
      remoteStatus: "failed",
      remoteError
    });
    expect(completeLocalExit).toHaveBeenCalledTimes(1);
  });

  it("does not wait indefinitely for a hung remote leave request before completing local exit", async () => {
    vi.useFakeTimers();
    const completeLocalExit = vi.fn(async () => undefined);

    try {
      const resultPromise = runBestEffortRoomLeave({
        roomId: "room_1",
        leaveRemote: vi.fn(() => new Promise(() => undefined)),
        completeLocalExit,
        remoteWaitMs: 25
      });

      await Promise.resolve();
      expect(completeLocalExit).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(25);
      await expect(resultPromise).resolves.toEqual({
        remoteStatus: "pending",
        remoteError: null
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
