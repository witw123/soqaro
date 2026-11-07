"use client";

import type { PlaybackSnapshot, RoomMember, RoomSnapshot, TrackMeta } from "@soqaro/shared";
import {
  normalizeRoomMembers,
  shouldAcceptPresenceSnapshot,
  shouldReplacePlaybackSnapshot
} from "@/lib/domain/soqaro-ui";

type RoomStateSource = "bootstrap" | "authoritative";

export type RoomStateStore = {
  snapshot: RoomSnapshot | null;
  source: RoomStateSource | null;
};

export type RoomStateEvent =
  | {
      type: "bootstrap-handoff";
      snapshot: RoomSnapshot;
    }
  | {
      type: "subscribe-bootstrap";
      roomId: string;
      members: RoomMember[];
      playback: PlaybackSnapshot;
      presenceRevision: number;
      roomRevision: number;
    }
  | {
      type: "recover-snapshot" | "server-snapshot";
      snapshot: RoomSnapshot;
    }
  | {
      type: "server-presence-patch";
      roomId: string;
      members: RoomMember[];
      playback: PlaybackSnapshot;
      presenceRevision: number;
      roomRevision?: number;
    }
  | {
      type: "server-queue-patch";
      roomId: string;
      queue: RoomSnapshot["queue"];
      playback: PlaybackSnapshot;
      roomRevision?: number;
    }
  | {
      type: "server-library-patch";
      roomId: string;
      tracks: TrackMeta[];
      queue: RoomSnapshot["queue"];
      playback: PlaybackSnapshot;
      roomRevision?: number;
    }
  | {
      type: "server-track-deleted";
      roomId: string;
      trackId: string;
      roomRevision: number;
    }
  | {
      type: "server-playback-patch";
      roomId: string;
      playback: PlaybackSnapshot;
      roomRevision?: number;
    }
  | {
      // A playback mutation failed without committing on the server. The
      // fetched server playback is authoritative even though its revision is
      // lower than the optimistic pending revision, so it replaces the state
      // unconditionally instead of being blocked by the version gate.
      type: "playback-rollback";
      roomId: string;
      playback: PlaybackSnapshot;
    }
  | {
      type: "local-reset";
    };

export const initialRoomStateStore: RoomStateStore = {
  snapshot: null,
  source: null
};

function getRoomRevision(snapshot: RoomSnapshot | null | undefined) {
  return snapshot?.room.roomRevision ?? 0;
}

function shouldReplaceAuthoritativeSnapshot(
  current: RoomStateStore,
  incoming: RoomSnapshot,
  source: RoomStateSource
) {
  if (!current.snapshot) {
    return true;
  }

  if (current.snapshot.room.id !== incoming.room.id) {
    return true;
  }

  const currentRevision = getRoomRevision(current.snapshot);
  const incomingRevision = getRoomRevision(incoming);

  if (incomingRevision > currentRevision) {
    return true;
  }

  if (incomingRevision < currentRevision) {
    return false;
  }

  const currentPlaylists = current.snapshot.playlists ?? [];
  const incomingPlaylists = incoming.playlists ?? [];
  if (
    !(incomingPlaylists.length === 0 && currentPlaylists.length > 0) &&
    (incomingPlaylists.length !== currentPlaylists.length ||
      incomingPlaylists.some((p, i) => p.id !== currentPlaylists[i]?.id))
  ) {
    return true;
  }

  if (current.source !== "authoritative" && source === "authoritative") {
    return true;
  }

  // Once an authoritative snapshot is installed, an equal-revision snapshot
  // carries no newer room topology and must not rewind it.
  return current.source !== "authoritative";
}

function ensurePlaybackTrackMetadata(
  preferredTracks: RoomSnapshot["tracks"],
  currentTracks: RoomSnapshot["tracks"],
  incomingTracks: RoomSnapshot["tracks"],
  playbackTrackId: string | null
) {
  const nextTracks = [...preferredTracks];
  const knownTrackIds = new Set(nextTracks.map((track) => track.id));

  if (playbackTrackId && !knownTrackIds.has(playbackTrackId)) {
    const fallbackTrack =
      incomingTracks.find((track) => track.id === playbackTrackId) ??
      currentTracks.find((track) => track.id === playbackTrackId) ??
      null;
    if (fallbackTrack) {
      nextTracks.unshift(fallbackTrack);
    }
  }

  return nextTracks;
}

function mergeRoomMembersPreservingPermissions(
  currentMembers: RoomMember[],
  incomingMembers: RoomMember[]
) {
  const currentById = new Map(currentMembers.map((member) => [member.id, member]));
  return normalizeRoomMembers(incomingMembers).map((member) => ({
    ...member,
    permissions: member.permissions ?? currentById.get(member.id)?.permissions
  }));
}

function shouldUseTopologyPlaybackReset(input: {
  currentSnapshot: RoomSnapshot;
  incomingPlayback: PlaybackSnapshot;
  nextTracks: RoomSnapshot["tracks"];
  nextQueue: RoomSnapshot["queue"];
  shouldApplyTopology: boolean;
}) {
  const currentPlayback = input.currentSnapshot.room.playback;
  if (
    !input.shouldApplyTopology ||
    input.incomingPlayback.currentTrackId !== null ||
    !currentPlayback.currentTrackId
  ) {
    return false;
  }

  const currentTrackStillExists = input.nextTracks.some(
    (track) => track.id === currentPlayback.currentTrackId
  );
  const currentQueueItemStillExists = currentPlayback.currentQueueItemId
    ? input.nextQueue.some((item) => item.id === currentPlayback.currentQueueItemId)
    : true;

  return !currentTrackStillExists || !currentQueueItemStillExists;
}

function normalizeSnapshot(
  currentSnapshot: RoomSnapshot | null,
  incomingSnapshot: RoomSnapshot
) {
  if (!currentSnapshot || currentSnapshot.room.id !== incomingSnapshot.room.id) {
    return incomingSnapshot;
  }

  const shouldApplyTopology = getRoomRevision(incomingSnapshot) >= getRoomRevision(currentSnapshot);
  const playback = shouldUseTopologyPlaybackReset({
    currentSnapshot,
    incomingPlayback: incomingSnapshot.room.playback,
    nextTracks: incomingSnapshot.tracks,
    nextQueue: incomingSnapshot.queue,
    shouldApplyTopology
  })
    ? incomingSnapshot.room.playback
    : shouldReplacePlaybackSnapshot(
        currentSnapshot.room.playback,
        incomingSnapshot.room.playback
      )
    ? incomingSnapshot.room.playback
    : currentSnapshot.room.playback;
  const shouldApplyPresence =
    getRoomRevision(incomingSnapshot) >= getRoomRevision(currentSnapshot) &&
    shouldAcceptPresenceSnapshot(
      currentSnapshot.room.members,
      currentSnapshot.room.presenceRevision,
      incomingSnapshot.room.members,
      incomingSnapshot.room.presenceRevision
    );

  const incomingPlaylists = incomingSnapshot.playlists;
  const currentPlaylists = currentSnapshot.playlists ?? [];
  const playlists =
    incomingPlaylists && incomingPlaylists.length > 0
      ? incomingPlaylists
      : incomingPlaylists && getRoomRevision(incomingSnapshot) > getRoomRevision(currentSnapshot)
        ? incomingPlaylists
        : currentPlaylists;

  return {
    ...incomingSnapshot,
    tracks: ensurePlaybackTrackMetadata(
      incomingSnapshot.tracks,
      currentSnapshot.tracks,
      incomingSnapshot.tracks,
      playback.currentTrackId
    ),
    playlists,
    room: {
      ...incomingSnapshot.room,
      roomRevision: getRoomRevision(incomingSnapshot),
      members: shouldApplyPresence
        ? mergeRoomMembersPreservingPermissions(
            currentSnapshot.room.members,
            incomingSnapshot.room.members
          )
        : currentSnapshot.room.members,
      presenceRevision: shouldApplyPresence
        ? incomingSnapshot.room.presenceRevision
        : currentSnapshot.room.presenceRevision,
      playback
    }
  } satisfies RoomSnapshot;
}

export function roomStateReducer(
  current: RoomStateStore,
  event: RoomStateEvent
): RoomStateStore {
  switch (event.type) {
    case "local-reset":
      return initialRoomStateStore;

    case "bootstrap-handoff": {
      if (current.source === "authoritative" && current.snapshot?.room.id === event.snapshot.room.id) {
        return current;
      }

      if (!shouldReplaceAuthoritativeSnapshot(current, event.snapshot, "bootstrap")) {
        return current;
      }

      return {
        snapshot: normalizeSnapshot(current.snapshot, event.snapshot),
        source: "bootstrap"
      };
    }

    case "subscribe-bootstrap": {
      const snapshot = current.snapshot;
      if (!snapshot || snapshot.room.id !== event.roomId) {
        return current;
      }

      const currentRoomRevision = getRoomRevision(snapshot);
      const currentPresenceRevision = snapshot.room.presenceRevision ?? 0;
      const shouldApplyTopology = event.roomRevision >= currentRoomRevision;
      const shouldApplyPresence = shouldApplyTopology && shouldAcceptPresenceSnapshot(
        snapshot.room.members,
        currentPresenceRevision,
        event.members,
        event.presenceRevision
      );
      const nextPlayback = shouldReplacePlaybackSnapshot(snapshot.room.playback, event.playback)
        ? event.playback
        : snapshot.room.playback;
      const nextMembers = shouldApplyPresence
        ? mergeRoomMembersPreservingPermissions(snapshot.room.members, event.members)
        : snapshot.room.members;

      if (
        !shouldApplyPresence &&
        nextPlayback === snapshot.room.playback &&
        event.roomRevision <= currentRoomRevision
      ) {
        return current;
      }

      return {
        ...current,
        snapshot: {
          ...snapshot,
          room: {
            ...snapshot.room,
            members: nextMembers,
            presenceRevision: shouldApplyPresence
              ? Math.max(currentPresenceRevision, event.presenceRevision)
              : currentPresenceRevision,
            roomRevision: current.source === "authoritative"
              ? Math.max(currentRoomRevision, event.roomRevision)
              : currentRoomRevision,
            playback: nextPlayback
          }
        }
      };
    }

    case "recover-snapshot":
    case "server-snapshot": {
      if (!shouldReplaceAuthoritativeSnapshot(current, event.snapshot, "authoritative")) {
        return current;
      }

      return {
        snapshot: normalizeSnapshot(current.snapshot, event.snapshot),
        source: "authoritative"
      };
    }

    case "server-presence-patch": {
      const snapshot = current.snapshot;
      if (!snapshot || snapshot.room.id !== event.roomId) {
        return current;
      }

      const currentPresenceRevision = snapshot.room.presenceRevision ?? 0;
      const currentRoomRevision = getRoomRevision(snapshot);
      const shouldApplyTopology = (event.roomRevision ?? currentRoomRevision) >= currentRoomRevision;
      const shouldApplyPresence = shouldApplyTopology && shouldAcceptPresenceSnapshot(
        snapshot.room.members,
        currentPresenceRevision,
        event.members,
        event.presenceRevision
      );
      const nextPlayback = shouldReplacePlaybackSnapshot(snapshot.room.playback, event.playback)
        ? event.playback
        : snapshot.room.playback;
      const nextMembers = shouldApplyPresence
        ? mergeRoomMembersPreservingPermissions(snapshot.room.members, event.members)
        : snapshot.room.members;

      if (!shouldApplyPresence && nextPlayback === snapshot.room.playback) {
        return current;
      }

      return {
        ...current,
        snapshot: {
          ...snapshot,
          room: {
            ...snapshot.room,
            members: nextMembers,
            presenceRevision: shouldApplyPresence
              ? event.presenceRevision
              : currentPresenceRevision,
            roomRevision: Math.max(currentRoomRevision, event.roomRevision ?? 0),
            playback: nextPlayback
          }
        }
      };
    }

    case "server-queue-patch": {
      const snapshot = current.snapshot;
      if (!snapshot || snapshot.room.id !== event.roomId) {
        return current;
      }

      const currentRevision = getRoomRevision(snapshot);
      const shouldApplyTopology = (event.roomRevision ?? currentRevision) >= currentRevision;
      const nextQueue = shouldApplyTopology ? event.queue : snapshot.queue;
      const nextPlayback = shouldUseTopologyPlaybackReset({
        currentSnapshot: snapshot,
        incomingPlayback: event.playback,
        nextTracks: snapshot.tracks,
        nextQueue,
        shouldApplyTopology
      })
        ? event.playback
        : shouldReplacePlaybackSnapshot(snapshot.room.playback, event.playback)
          ? event.playback
          : snapshot.room.playback;

      if (!shouldApplyTopology && nextPlayback === snapshot.room.playback) {
        return current;
      }

      return {
        ...current,
        snapshot: {
          ...snapshot,
          queue: nextQueue,
          room: {
            ...snapshot.room,
            roomRevision: Math.max(currentRevision, event.roomRevision ?? 0),
            playback: nextPlayback
          }
        }
      };
    }

    case "server-library-patch": {
      const snapshot = current.snapshot;
      if (!snapshot || snapshot.room.id !== event.roomId) {
        return current;
      }

      const currentRevision = getRoomRevision(snapshot);
      const shouldApplyTopology = (event.roomRevision ?? currentRevision) >= currentRevision;
      const nextTracks = shouldApplyTopology ? event.tracks : snapshot.tracks;
      const nextQueue = shouldApplyTopology ? event.queue : snapshot.queue;
      const nextPlayback = shouldUseTopologyPlaybackReset({
        currentSnapshot: snapshot,
        incomingPlayback: event.playback,
        nextTracks,
        nextQueue,
        shouldApplyTopology
      })
        ? event.playback
        : shouldReplacePlaybackSnapshot(snapshot.room.playback, event.playback)
          ? event.playback
          : snapshot.room.playback;

      if (!shouldApplyTopology && nextPlayback === snapshot.room.playback) {
        return current;
      }

      return {
        ...current,
        snapshot: {
          ...snapshot,
          tracks: ensurePlaybackTrackMetadata(
            nextTracks,
            snapshot.tracks,
            event.tracks,
            nextPlayback.currentTrackId
          ),
          queue: nextQueue,
          room: {
            ...snapshot.room,
            roomRevision: Math.max(currentRevision, event.roomRevision ?? 0),
            playback: nextPlayback
          }
        }
      };
    }

    case "server-track-deleted": {
      const snapshot = current.snapshot;
      if (!snapshot || snapshot.room.id !== event.roomId) {
        return current;
      }

      const currentRevision = getRoomRevision(snapshot);
      if (event.roomRevision < currentRevision) {
        return current;
      }

      const nextTracks = snapshot.tracks.filter((track) => track.id !== event.trackId);
      const nextQueue = snapshot.queue
        .filter((item) => item.trackId !== event.trackId)
        .map((item, index) => ({ ...item, position: index }));
      const isPlayingTrack = snapshot.room.playback.currentTrackId === event.trackId;
      const isNextTrack = snapshot.room.playback.nextQueueItemId
        ? nextQueue.some((item) => item.id === snapshot.room.playback.nextQueueItemId)
        : true;
      return {
        ...current,
        snapshot: {
          ...snapshot,
          tracks: nextTracks,
          queue: nextQueue,
          room: {
            ...snapshot.room,
            roomRevision: Math.max(currentRevision, event.roomRevision),
            playback: isPlayingTrack
              ? {
                  ...snapshot.room.playback,
                  status: "paused",
                  currentTrackId: null,
                  currentQueueItemId: null,
                  playbackAssetId: null,
                  sourceTrackId: null,
                  nextQueueItemId: null,
                  positionMs: 0,
                  startedAt: null,
                  startAt: null,
                  playbackRevision: snapshot.room.playback.playbackRevision + 1,
                  mediaEpoch: snapshot.room.playback.mediaEpoch + 1
                }
              : !isNextTrack
                ? {
                    ...snapshot.room.playback,
                    nextQueueItemId: null,
                    playbackRevision: snapshot.room.playback.playbackRevision + 1
                  }
              : snapshot.room.playback
          }
        }
      };
    }

    case "playback-rollback": {
      const snapshot = current.snapshot;
      if (!snapshot || snapshot.room.id !== event.roomId) {
        return current;
      }

      return {
        ...current,
        source: "authoritative",
        snapshot: {
          ...snapshot,
          room: {
            ...snapshot.room,
            playback: event.playback
          }
        }
      };
    }

    case "server-playback-patch": {
      const snapshot = current.snapshot;
      if (!snapshot || snapshot.room.id !== event.roomId) {
        return current;
      }

      if (!shouldReplacePlaybackSnapshot(snapshot.room.playback, event.playback)) {
        return current;
      }

      const currentRevision = getRoomRevision(snapshot);
      return {
        ...current,
        snapshot: {
          ...snapshot,
          room: {
            ...snapshot.room,
            playback: event.playback,
            roomRevision: Math.max(currentRevision, event.roomRevision ?? 0)
          }
        }
      };
    }

    default:
      return current;
  }
}
