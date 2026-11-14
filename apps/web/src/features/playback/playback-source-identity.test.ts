import { describe, expect, it } from "vitest";
import type { PlaybackSnapshot } from "@soqaro/shared";
import { isCurrentPlaybackSourceDevice } from "./playback-source-identity";

describe("playback-source-identity", () => {
  const basePlayback = {
    status: "playing",
    currentTrackId: "track_1",
    currentQueueItemId: "queue_1",
    queueVersion: 1,
    playbackRevision: 1,
    mediaEpoch: 1,
    positionMs: 5000,
    sourceSessionId: "user_session_123",
    sourcePeerId: "peer_device_a",
    sourceTrackId: "track_1",
    startedAt: "2026-09-06T10:00:00.000Z"
  } as PlaybackSnapshot;

  it("returns false if playback or currentTrackId is missing", () => {
    expect(
      isCurrentPlaybackSourceDevice({
        playback: null,
        peerId: "peer_device_a"
      })
    ).toBe(false);

    expect(
      isCurrentPlaybackSourceDevice({
        playback: { ...basePlayback, currentTrackId: null },
        peerId: "peer_device_a"
      })
    ).toBe(false);
  });

  it("returns false if local peerId is missing", () => {
    expect(
      isCurrentPlaybackSourceDevice({
        playback: basePlayback,
        peerId: null
      })
    ).toBe(false);

    expect(
      isCurrentPlaybackSourceDevice({
        playback: basePlayback,
        peerId: undefined
      })
    ).toBe(false);
  });

  it("returns false when another device of the same user account was playing", () => {
    // Device A played under user_session_123 with peer_device_a.
    // Device B logs into user_session_123 with peer_device_b.
    // Device B must NOT be treated as the source device.
    expect(
      isCurrentPlaybackSourceDevice({
        playback: basePlayback,
        peerId: "peer_device_b",
        activeSessionId: "user_session_123"
      })
    ).toBe(false);
  });

  it("returns false when the source has departed (sourcePeerId is null)", () => {
    const departedPlayback: PlaybackSnapshot = {
      ...basePlayback,
      sourcePeerId: null
    };

    expect(
      isCurrentPlaybackSourceDevice({
        playback: departedPlayback,
        peerId: "peer_device_b",
        activeSessionId: "user_session_123"
      })
    ).toBe(false);
  });

  it("preserves source ownership while the active playing source session is reconnecting", () => {
    const reconnectingPlayback: PlaybackSnapshot = {
      ...basePlayback,
      sourcePeerId: null
    };

    expect(
      isCurrentPlaybackSourceDevice({
        playback: reconnectingPlayback,
        peerId: "peer_device_a",
        activeSessionId: "user_session_123",
        sourcePresenceState: "reconnecting"
      })
    ).toBe(true);

    expect(
      isCurrentPlaybackSourceDevice({
        playback: { ...reconnectingPlayback, status: "paused" },
        peerId: "peer_device_a",
        activeSessionId: "user_session_123",
        sourcePresenceState: "reconnecting"
      })
    ).toBe(false);

    expect(
      isCurrentPlaybackSourceDevice({
        playback: reconnectingPlayback,
        peerId: "peer_device_a",
        activeSessionId: "user_session_other",
        sourcePresenceState: "reconnecting"
      })
    ).toBe(false);
  });

  it("returns true when peerId matches sourcePeerId", () => {
    expect(
      isCurrentPlaybackSourceDevice({
        playback: basePlayback,
        peerId: "peer_device_a",
        activeSessionId: "user_session_123"
      })
    ).toBe(true);
  });

  it("respects explicit sourcePeerId override matching peerId", () => {
    expect(
      isCurrentPlaybackSourceDevice({
        playback: basePlayback,
        peerId: "peer_override_1",
        sourcePeerId: "peer_override_1"
      })
    ).toBe(true);

    expect(
      isCurrentPlaybackSourceDevice({
        playback: basePlayback,
        peerId: "peer_override_1",
        sourcePeerId: "peer_different"
      })
    ).toBe(false);
  });
});
