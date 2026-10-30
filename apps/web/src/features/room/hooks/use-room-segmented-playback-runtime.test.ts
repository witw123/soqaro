import { describe, expect, it } from "vitest";
import {
  recordReceiverAudioProgress,
  resolveReceiverPlaybackState,
  shouldRecoverStalledReceiverAudio
} from "@/features/room/playback/receiver-audio-health";
import {
  isSegmentedPlaybackAudible,
  uninterruptedRoomClock
} from "@/features/room/playback/playback-barrier";
import {
  alignLocalAudioToRoom,
  resolveCacheReadinessReport,
  hasCurrentLocalAudio,
  resolveLocalAudioTimelineKey,
  resolveRoomAudioPath,
  resolveRoomAudioPositionMs,
  resolveRoomProviderCachePlan,
  resolveRemoteAudioTimelineKey,
  shouldDisableSourcePlayback,
  shouldSkipUnavailableStreamingTrack,
  shouldWaitForLocalAudioContext
} from "@/features/room/playback/room-audio-path";

describe("receiver audio progress", () => {
  it("does not refresh progress for a playing event without clock movement", () => {
    const health = {
      lastProgressAtMs: 1_000,
      lastCurrentTime: 0,
      hasStarted: false,
      waitingSinceMs: 2_000
    };

    recordReceiverAudioProgress({
      health,
      event: "playing",
      currentTime: 0,
      nowMs: 8_000
    });

    expect(health).toEqual({
      lastProgressAtMs: 1_000,
      lastCurrentTime: 0,
      hasStarted: true,
      waitingSinceMs: 2_000
    });
  });

  it("clears waiting only after the media clock advances", () => {
    const health = {
      lastProgressAtMs: 1_000,
      lastCurrentTime: 0,
      hasStarted: true,
      waitingSinceMs: 2_000
    };

    recordReceiverAudioProgress({
      health,
      event: "progress",
      currentTime: 0.1,
      nowMs: 8_000
    });

    expect(health.lastProgressAtMs).toBe(8_000);
    expect(health.waitingSinceMs).toBeNull();
  });
});

describe("receiver playback state", () => {
  it("recovers a receiver whose element claims to play but its clock is frozen", () => {
    expect(shouldRecoverStalledReceiverAudio({
      boundAtMs: 1_000,
      hasStarted: true,
      lastProgressAtMs: 4_000,
      nowMs: 9_500
    })).toBe(true);
  });

  it("does not recover before startup grace or without a started element", () => {
    expect(shouldRecoverStalledReceiverAudio({
      boundAtMs: 8_000,
      hasStarted: false,
      lastProgressAtMs: 8_000,
      nowMs: 9_000
    })).toBe(false);
    expect(shouldRecoverStalledReceiverAudio({
      boundAtMs: 1_000,
      hasStarted: true,
      lastProgressAtMs: 8_000,
      nowMs: 9_000
    })).toBe(false);
  });

  it("recovers a started element whose receiver track is live but has no RTP", () => {
    expect(shouldRecoverStalledReceiverAudio({
      boundAtMs: 1_000,
      hasStarted: true,
      lastProgressAtMs: 1_000,
      receiverRtpActive: false,
      audioPaused: false,
      nowMs: 3_500
    })).toBe(true);
  });

  it("does not restart an RTP-active receiver just because MediaStream time is stale", () => {
    expect(shouldRecoverStalledReceiverAudio({
      boundAtMs: 1_000,
      hasStarted: true,
      lastProgressAtMs: 1_000,
      receiverRtpActive: true,
      audioPaused: false,
      nowMs: 8_000
    })).toBe(false);
  });

  it("does not treat an autoplay-paused element as a media failure", () => {
    expect(shouldRecoverStalledReceiverAudio({
      boundAtMs: 1_000,
      hasStarted: true,
      lastProgressAtMs: 1_000,
      receiverRtpActive: false,
      audioPaused: true,
      nowMs: 8_000
    })).toBe(false);
  });

  it("keeps an already-playing receiver live during a short RTP gap", () => {
    expect(resolveReceiverPlaybackState({
      receiverRtpActive: false,
      hasStarted: true,
      missingMediaSinceMs: 10_000,
      nowMs: 11_500
    })).toBe("live");
  });

  it("keeps a started receiver live when the browser reports a zero RTP window", () => {
    expect(resolveReceiverPlaybackState({
      receiverRtpActive: false,
      hasStarted: true,
      missingMediaSinceMs: null,
      nowMs: 11_500
    })).toBe("live");
  });

  it("keeps RTP-active playback live when the MediaStream clock is stale", () => {
    expect(resolveReceiverPlaybackState({
      receiverRtpActive: true,
      hasStarted: true,
      lastProgressAtMs: 10_000,
      missingMediaSinceMs: null,
      nowMs: 13_000
    })).toBe("live");
  });

  it("shows buffering only after the receiver gap exceeds the grace period", () => {
    expect(resolveReceiverPlaybackState({
      receiverRtpActive: false,
      hasStarted: true,
      missingMediaSinceMs: 10_000,
      nowMs: 13_000
    })).toBe("buffering");
  });

  it("keeps startup buffering until the first playback progress event", () => {
    expect(resolveReceiverPlaybackState({
      receiverRtpActive: false,
      hasStarted: false,
      missingMediaSinceMs: null,
      nowMs: 10_000
    })).toBe("buffering");
  });
});

describe("cache-independent room clock", () => {
  it("advances using the authoritative timeline without a cache hold", () => {
    expect(resolveRoomAudioPositionMs({
      status: "playing",
      positionMs: 12_000,
      startedAt: "2026-07-22T00:00:10.000Z",
      startAt: "2026-07-22T00:00:10.000Z"
    }, Date.parse("2026-07-22T00:00:13.500Z"), uninterruptedRoomClock)).toBe(15_500);
    expect(uninterruptedRoomClock.blocked).toBe(false);
  });
});

describe("cache readiness reporting", () => {
  it("holds the room while checking whether the provider file is cached", () => {
    expect(resolveCacheReadinessReport({
      cacheRequested: true,
      localReady: false,
      cacheAttemptPending: false,
      localAudioStatus: "checking"
    })).toEqual({ cacheEnabled: true, state: "waiting" });
  });

  it("only reports waiting during an actual provider-cache download", () => {
    expect(resolveCacheReadinessReport({
      cacheRequested: true,
      localReady: false,
      cacheAttemptPending: true,
      localAudioStatus: "missing"
    })).toEqual({ cacheEnabled: true, state: "waiting" });
  });

  it("falls back to streaming when this member cannot cache the track", () => {
    expect(resolveCacheReadinessReport({
      cacheRequested: true,
      localReady: false,
      cacheAttemptPending: false,
      localAudioStatus: "missing"
    })).toEqual({ cacheEnabled: false, state: "ready" });
  });

  it("keeps a successfully cached member in the cache participant set", () => {
    expect(resolveCacheReadinessReport({
      cacheRequested: true,
      localReady: true,
      cacheAttemptPending: false,
      localAudioStatus: "available"
    })).toEqual({ cacheEnabled: true, state: "ready" });
  });
});

describe("segmented playback audible state", () => {
  it("does not turn a live quiet source into waiting audio", () => {
    expect(isSegmentedPlaybackAudible({
      state: "live",
      isCurrentSource: true,
      sourceHealth: "source-ready"
    })).toBe(true);
  });

  it("still requires a live source track for the source member", () => {
    expect(isSegmentedPlaybackAudible({
      state: "live",
      isCurrentSource: true,
      sourceHealth: "source-silent"
    })).toBe(false);
  });

  it("treats a live native local file as audible for the source member", () => {
    expect(isSegmentedPlaybackAudible({
      state: "live",
      isCurrentSource: true,
      nativeLocalAudio: true
    })).toBe(true);
  });
});

describe("room audio path", () => {
  it("distinguishes local files from a remote listener stream", () => {
    expect(resolveRoomAudioPath({
      isCurrentSource: false,
      nativeLocalAudio: true,
      localFallback: false
    })).toBe("local-file");
    expect(resolveRoomAudioPath({
      isCurrentSource: false,
      nativeLocalAudio: false,
      localFallback: false
    })).toBe("remote-stream");
  });
});

describe("provider cache source transition", () => {
  it("does not reuse a resolved file from the previous track", () => {
    expect(hasCurrentLocalAudio({
      key: "track-old",
      status: "available",
      file: new Blob(["audio"]),
      error: null
    }, "track-new")).toBe(false);
    expect(hasCurrentLocalAudio({
      key: "track-new",
      status: "available",
      file: new Blob(["audio"]),
      error: null
    }, "track-new")).toBe(true);
  });

  it("keeps segmented source playback during cache lookup and download", () => {
    expect(shouldDisableSourcePlayback({
      isCurrentSource: true,
      localAudioStatus: "checking"
    })).toBe(false);
    expect(shouldDisableSourcePlayback({
      isCurrentSource: true,
      localAudioStatus: "missing"
    })).toBe(false);
  });

  it("switches the source to a local file only after it is available", () => {
    expect(shouldDisableSourcePlayback({
      isCurrentSource: true,
      localAudioStatus: "available"
    })).toBe(true);
  });

  it("never disables the room source for a listener", () => {
    expect(shouldDisableSourcePlayback({
      isCurrentSource: false,
      localAudioStatus: "available"
    })).toBe(false);
  });

  it("skips a streaming-only source track when its room playback asset is absent", () => {
    expect(shouldSkipUnavailableStreamingTrack({
      isCurrentSource: true,
      streamingOnlyPlayback: true,
      playback: { status: "playing", currentTrackId: "track-1" },
      currentTrackId: "track-1",
      playbackAsset: null
    })).toBe(true);
    expect(shouldSkipUnavailableStreamingTrack({
      isCurrentSource: true,
      streamingOnlyPlayback: true,
      playback: { status: "playing", currentTrackId: "track-1" },
      currentTrackId: "track-1",
      playbackAsset: { assetId: "asset-1" } as never
    })).toBe(false);
  });
});

describe("native local audio context requirement", () => {
  it("does not block a listener's own cache when the shared context is suspended", () => {
    expect(shouldWaitForLocalAudioContext({
      isCurrentSource: false,
      audioUnlocked: false,
      audioContextState: "suspended"
    })).toBe(false);
  });

  it("keeps the source cache behind the broadcast audio context", () => {
    expect(shouldWaitForLocalAudioContext({
      isCurrentSource: true,
      audioUnlocked: false,
      audioContextState: "suspended"
    })).toBe(true);
    expect(shouldWaitForLocalAudioContext({
      isCurrentSource: true,
      audioUnlocked: true,
      audioContextState: "running"
    })).toBe(false);
  });
});

describe("listener audio output ownership", () => {
  it("does not require the shared audio graph for a listener cache by default", () => {
    expect(shouldWaitForLocalAudioContext({
      isCurrentSource: false,
      audioUnlocked: false,
      audioContextState: "suspended"
    })).toBe(false);
  });
});

describe("local room audio clock", () => {
  it("joins at the room's current position after caching and catches up after slow startup", () => {
    const playback = {
      status: "playing" as const,
      positionMs: 12_000,
      startedAt: new Date(10_000).toISOString(),
      startAt: new Date(10_000).toISOString()
    };
    const audio = { currentTime: 0, duration: 60 };
    alignLocalAudioToRoom(audio, playback, { force: true, nowMs: 20_000 });
    expect(audio.currentTime).toBe(22);
    alignLocalAudioToRoom(audio, playback, { nowMs: 23_000 });
    expect(audio.currentTime).toBe(25);
    audio.currentTime = 25.1;
    alignLocalAudioToRoom(audio, playback, { nowMs: 23_200 });
    expect(audio.currentTime).toBe(25.1);
  });

  it("keeps a completed cache paused at the room position and clamps track end", () => {
    const audio = { currentTime: 0, duration: 60 };
    const playback = {
      status: "paused" as const, positionMs: 12_000,
      startedAt: null, startAt: null
    };
    alignLocalAudioToRoom(audio, playback, { force: true, nowMs: 99_000 });
    expect(audio.currentTime).toBe(12);
    alignLocalAudioToRoom(audio, {
      ...playback, status: "playing", startedAt: new Date(0).toISOString()
    }, { force: true, nowMs: 99_000 });
    expect(audio.currentTime).toBe(60);
  });

  it("uses the room clock to advance a playing local file", () => {
    expect(resolveRoomAudioPositionMs({
      status: "playing",
      positionMs: 12_000,
      startedAt: "2026-07-22T00:00:10.000Z",
      startAt: "2026-07-22T00:00:10.000Z"
    }, Date.parse("2026-07-22T00:00:13.500Z"))).toBe(15_500);
  });

  it("keeps paused local audio at the server position", () => {
    expect(resolveRoomAudioPositionMs({
      status: "paused",
      positionMs: 12_000,
      startedAt: "2026-07-22T00:00:10.000Z",
      startAt: "2026-07-22T00:00:10.000Z"
    }, Date.parse("2026-07-22T00:00:13.500Z"))).toBe(12_000);
  });

  it("freezes local audio at the barrier hold position", () => {
    expect(resolveRoomAudioPositionMs({
      status: "playing",
      positionMs: 12_000,
      startedAt: "2026-07-22T00:00:10.000Z",
      startAt: "2026-07-22T00:00:10.000Z"
    }, Date.parse("2026-07-22T00:01:00.000Z"), {
      holdPositionMs: 18_250,
      resumeAtMs: null
    })).toBe(18_250);
  });

  it("resumes local audio from the held position instead of the stale room anchor", () => {
    expect(resolveRoomAudioPositionMs({
      status: "playing",
      positionMs: 12_000,
      startedAt: "2026-07-22T00:00:10.000Z",
      startAt: "2026-07-22T00:00:10.000Z"
    }, Date.parse("2026-07-22T00:00:16.000Z"), {
      holdPositionMs: 18_250,
      resumeAtMs: Date.parse("2026-07-22T00:00:15.000Z")
    })).toBe(19_250);
  });
});

describe("remote room audio timeline", () => {
  it("changes when a playing seek creates a new room clock anchor", () => {
    const initial = {
      currentTrackId: "track-1",
      mediaEpoch: 2,
      status: "playing" as const,
      positionMs: 1_000,
      playbackRevision: 7,
      startAt: "2026-07-22T00:00:10.000Z",
      startedAt: "2026-07-22T00:00:10.000Z"
    };
    const seeked = {
      ...initial,
      positionMs: 42_000,
      playbackRevision: 8,
      startAt: "2026-07-22T00:00:51.000Z",
      startedAt: "2026-07-22T00:00:51.000Z"
    };

    expect(resolveRemoteAudioTimelineKey(initial)).not.toBe(
      resolveRemoteAudioTimelineKey(seeked)
    );
  });

  it("does not change on ordinary clock progress within one timeline", () => {
    const initial = {
      currentTrackId: "track-1",
      mediaEpoch: 2,
      status: "playing" as const,
      positionMs: 1_000,
      playbackRevision: 7,
      startAt: "2026-07-22T00:00:10.000Z",
      startedAt: "2026-07-22T00:00:10.000Z"
    };

    expect(resolveRemoteAudioTimelineKey(initial)).toBe(
      resolveRemoteAudioTimelineKey({ ...initial, positionMs: 1_250 })
    );
  });
});

describe("native local audio timeline", () => {
  const playback = {
    currentTrackId: "track-1",
    mediaEpoch: 2,
    status: "playing" as const,
    positionMs: 1_000,
    playbackRevision: 7,
    startAt: "2026-07-22T00:00:10.000Z",
    startedAt: "2026-07-22T00:00:10.000Z"
  };

  it("invalidates an in-flight cache play when the room is paused", () => {
    expect(resolveLocalAudioTimelineKey(playback)).not.toBe(
      resolveLocalAudioTimelineKey({
        ...playback,
        status: "paused",
        positionMs: 4_000
      })
    );
  });

  it("does not interrupt cached audio for ordinary playing clock updates", () => {
    expect(resolveLocalAudioTimelineKey(playback)).toBe(
      resolveLocalAudioTimelineKey({
        ...playback,
        positionMs: 4_000
      })
    );
  });

  it("invalidates an in-flight cache play when a barrier starts waiting", () => {
    expect(resolveLocalAudioTimelineKey(playback)).not.toBe(
      resolveLocalAudioTimelineKey(playback, {
        holdPositionMs: 3_250,
        resumeAtMs: null
      })
    );
  });
});

describe("room provider cache and offline auto-load plan", () => {
  function buildTrack(complete = true) {
    return {
      id: "track-1",
      title: "Demo",
      artist: "Artist",
      album: null,
      durationMs: 180_000,
      bitrate: 320_000,
      sizeBytes: 4_000_000,
      fileHash: "a".repeat(64),
      artworkUrl: null,
      ownerSessionId: "owner-1",
      ownerNickname: "Owner",
      sourceType: "netease" as const,
      sourceRef: { provider: "netease" as const, trackId: "10086" },
      ...(complete
        ? {
            originalAsset: {
              assetId: "1".repeat(64),
              kind: "original" as const,
              fileHash: "a".repeat(64),
              mimeType: "audio/mpeg",
              sizeBytes: 4_000_000,
              unitSize: 1_048_576,
              unitCount: 4,
              merkleRoot: "2".repeat(64)
            },
            playbackAsset: {
              assetId: "3".repeat(64),
              kind: "playback" as const,
              sourceFileHash: "a".repeat(64),
              profileId: "opus-music-v4" as const,
              codec: "opus" as const,
              container: "audio/ogg" as const,
              sampleRate: 48_000 as const,
              channels: 2 as const,
              bitrate: 256_000 as const,
              durationMs: 180_000,
              segmentDurationMs: 2_000 as const,
              seekPrerollMs: 80 as const,
              unitCount: 90,
              merkleRoot: "4".repeat(64),
              encoder: { name: "@audio/opus-encode" as const, version: "3.4.0" as const }
            }
          }
        : {})
    };
  }

  function buildSnapshot(presenceState: "online" | "offline" = "online", status: "playing" | "paused" = "playing") {
    return {
      room: {
        id: "room-1",
        playback: {
          currentTrackId: "track-1",
          sourceSessionId: "owner-1",
          status,
          mediaEpoch: 1,
          playbackRevision: 1,
          positionMs: 0,
          startedAt: "2026-07-22T00:00:10.000Z",
          startAt: "2026-07-22T00:00:10.000Z"
        },
        members: [
          {
            id: "owner-1",
            presenceState
          }
        ]
      }
    } as never;
  }

  it("enables provider caching when fullyCachedPlayback is on and source member is online even if preventOfflineAutoLoad is on", () => {
    expect(resolveRoomProviderCachePlan({
      sharedCacheEnabled: true,
      segmentedStreamEnabled: true,
      streamingOnlyPlayback: false,
      fullyCachedPlayback: true,
      preventOfflineAutoLoad: true,
      isCurrentSource: false,
      roomSnapshot: buildSnapshot("online"),
      track: buildTrack(true)
    })).toEqual({
      mode: "provider-cache",
      source: { provider: "netease", trackId: "10086", label: "网易云音乐" },
      isSourceMemberOffline: false
    });
  });

  it("auto-caches when source member is offline and preventOfflineAutoLoad is false", () => {
    expect(resolveRoomProviderCachePlan({
      sharedCacheEnabled: true,
      segmentedStreamEnabled: true,
      streamingOnlyPlayback: false,
      fullyCachedPlayback: false,
      preventOfflineAutoLoad: false,
      isCurrentSource: false,
      roomSnapshot: buildSnapshot("offline", "playing"),
      track: buildTrack(false)
    })).toEqual({
      mode: "offline-fallback",
      source: { provider: "netease", trackId: "10086", label: "网易云音乐" },
      isSourceMemberOffline: true
    });
  });

  it("blocks offline provider downloads when preventOfflineAutoLoad is true", () => {
    expect(resolveRoomProviderCachePlan({
      sharedCacheEnabled: true,
      segmentedStreamEnabled: true,
      streamingOnlyPlayback: false,
      fullyCachedPlayback: true,
      preventOfflineAutoLoad: true,
      isCurrentSource: false,
      roomSnapshot: buildSnapshot("offline", "playing"),
      track: buildTrack(true)
    })).toEqual({
      mode: "none",
      source: null,
      isSourceMemberOffline: true
    });
  });

  it("disables all provider caching and offline auto-loading in streamingOnlyPlayback mode", () => {
    expect(resolveRoomProviderCachePlan({
      sharedCacheEnabled: true,
      segmentedStreamEnabled: true,
      streamingOnlyPlayback: true,
      fullyCachedPlayback: true,
      preventOfflineAutoLoad: false,
      isCurrentSource: false,
      roomSnapshot: buildSnapshot("offline", "playing"),
      track: buildTrack(true)
    })).toEqual({
      mode: "none",
      source: null,
      isSourceMemberOffline: true
    });
  });

  it("defers duplicate provider download on current source while OPS assets are still preparing", () => {
    expect(resolveRoomProviderCachePlan({
      sharedCacheEnabled: true,
      segmentedStreamEnabled: true,
      streamingOnlyPlayback: false,
      fullyCachedPlayback: true,
      preventOfflineAutoLoad: false,
      isCurrentSource: true,
      roomSnapshot: buildSnapshot("online", "playing"),
      track: buildTrack(false)
    }).mode).toBe("none");

    expect(resolveRoomProviderCachePlan({
      sharedCacheEnabled: true,
      segmentedStreamEnabled: true,
      streamingOnlyPlayback: false,
      fullyCachedPlayback: true,
      preventOfflineAutoLoad: false,
      isCurrentSource: true,
      roomSnapshot: buildSnapshot("online", "playing"),
      track: buildTrack(true)
    }).mode).toBe("provider-cache");
  });
});
