import { describe, expect, it } from "vitest";
import type { RoomSnapshot } from "@soqaro/shared";
import {
  resolveRoomPagePlaybackState,
  resolveStableCurrentTrack
} from "./use-room-page-derived";

const track = {
  id: "track_cached",
  title: "Cached",
  artist: "Artist",
  album: null,
  durationMs: 120_000,
  bitrate: null,
  sizeBytes: 48_000_000,
  codec: "flac",
  mimeType: "audio/flac",
  fileHash: "hash_cached",
  artworkUrl: null,
  ownerSessionId: "host",
  ownerNickname: "Host",
  sourceType: "local_upload"
} satisfies RoomSnapshot["tracks"][number];

function createSnapshot(input: {
  track?: RoomSnapshot["tracks"][number];
  sourcePeerId?: string | null;
  sourceSessionId?: string | null;
  memberPeerId?: string | null;
  hostPeerId?: string | null;
  hostPresenceState?: "online" | "reconnecting" | "offline";
}) {
  const sourceSessionId = input.sourceSessionId ?? "host";
  return {
    room: {
      id: "room_1",
      hostId: "host",
      joinCode: "ROOM42",
      visibility: "public",
      roomType: "interactive",
      radioAutopilot: { enabled: false },
      playback: {
        status: "playing",
        currentTrackId: "track_cached",
        currentQueueItemId: "queue_1",
        positionMs: 12_000,
        startedAt: "2026-07-06T00:00:01.000Z",
        sourceSessionId,
        sourcePeerId: input.sourcePeerId !== undefined ? input.sourcePeerId : "peer_host",
        sourceTrackId: "track_cached",
        queueVersion: 3,
        playbackRevision: 5,
        mediaEpoch: 7
      },
      members: [
        {
          id: "host",
          peerId: input.hostPeerId !== undefined ? input.hostPeerId : "peer_host",
          nickname: "Host",
          role: "host",
          joinedAt: "2026-07-06T00:00:00.000Z",
          presenceState: input.hostPresenceState ?? "online"
        },
        ...(sourceSessionId === "member"
          ? [{
              id: "member",
              peerId: input.memberPeerId ?? "peer_member",
              nickname: "Member",
              role: "member" as const,
              joinedAt: "2026-07-06T00:00:00.000Z",
              presenceState: "online" as const
            }]
          : [])
      ],
      presenceRevision: 1,
      roomRevision: 1
    },
    tracks: [input.track ?? track],
    queue: [
      {
        id: "queue_1",
        trackId: "track_cached",
        requestedBy: "Host",
        requestedById: "host",
        source: "manual",
        sourceSeedTrackId: null,
        position: 0,
        createdAt: "2026-07-06T00:00:00.000Z"
      }
    ],
    playlists: []
  } satisfies RoomSnapshot;
}

describe("room page derived state", () => {
  it("keeps currentTrack stable across equivalent snapshot track refreshes", () => {
    const refreshedTrack = { ...track };

    expect(resolveStableCurrentTrack(track, "track_cached", [refreshedTrack])).toBe(track);
  });

  it("refreshes the stable track when provider identity arrives later", () => {
    const initialTrack = {
      ...track,
      sourceType: "netease" as const
    };
    const refreshedTrack = {
      ...initialTrack,
      sourceRef: {
        provider: "netease" as const,
        trackId: "123456"
      }
    };

    expect(resolveStableCurrentTrack(
      initialTrack,
      "track_cached",
      [refreshedTrack]
    )).toBe(refreshedTrack);
  });

  it("derives playback identity from scalar fields instead of snapshot object identity", () => {
    const first = resolveRoomPagePlaybackState({
      roomSnapshot: createSnapshot({}),
      peerId: "peer_host",
      activeSessionId: "host"
    });
    const refreshed = resolveRoomPagePlaybackState({
      roomSnapshot: createSnapshot({ track: { ...track } }),
      peerId: "peer_host",
      activeSessionId: "host"
    });

    expect(refreshed.playbackSurfaceKey).toBe(first.playbackSurfaceKey);
    expect(refreshed.playbackTimelineKey).toBe(first.playbackTimelineKey);
    expect(refreshed.playbackTopologySnapshot).toEqual(first.playbackTopologySnapshot);
    expect(refreshed.isCurrentSourceOwner).toBe(true);
  });

  it("uses the current presence peer when a member becomes the source", () => {
    const snapshot = createSnapshot({
      sourceSessionId: "member",
      sourcePeerId: "peer_member_old",
      memberPeerId: "peer_member_current"
    });

    const playback = resolveRoomPagePlaybackState({
      roomSnapshot: snapshot,
      peerId: "peer_member_current",
      activeSessionId: "member"
    });

    expect(playback.isCurrentSourceOwner).toBe(true);
  });

  it("keeps the local source active while its presence peer id is refreshed", () => {
    const snapshot = createSnapshot({
      sourceSessionId: "member",
      sourcePeerId: "peer_member_old",
      memberPeerId: "peer_member_current"
    });

    const playback = resolveRoomPagePlaybackState({
      roomSnapshot: snapshot,
      peerId: "peer_member_old",
      activeSessionId: "member"
    });

    expect(playback.isCurrentSourceOwner).toBe(true);
  });

  it("keeps the local source active during transient reconnecting snapshots and drops when offline", () => {
    const reconnectingSnapshot = createSnapshot({
      sourceSessionId: "host",
      sourcePeerId: null,
      hostPeerId: null,
      hostPresenceState: "reconnecting"
    });
    const offlineSnapshot = createSnapshot({
      sourceSessionId: "host",
      sourcePeerId: null,
      hostPeerId: null,
      hostPresenceState: "offline"
    });

    expect(
      resolveRoomPagePlaybackState({
        roomSnapshot: reconnectingSnapshot,
        peerId: "peer_host",
        activeSessionId: "host"
      }).isCurrentSourceOwner
    ).toBe(true);

    expect(
      resolveRoomPagePlaybackState({
        roomSnapshot: offlineSnapshot,
        peerId: "peer_host",
        activeSessionId: "host"
      }).isCurrentSourceOwner
    ).toBe(false);
  });
});
