"use client";

import { useMemo, useRef } from "react";
import type { RoomSnapshot } from "@soqaro/shared";
import { isCurrentPlaybackSourceDevice } from "@/features/playback/playback-source-identity";
import {
  resolvePlaybackSurfaceKey,
  resolvePlaybackTimelineKey
} from "@/features/room/hooks/room-playback-topology";

type StableTrackMeta = Pick<
  RoomSnapshot["tracks"][number],
  | "id"
  | "title"
  | "artist"
  | "album"
  | "lyrics"
  | "durationMs"
  | "bitrate"
  | "sizeBytes"
  | "codec"
  | "mimeType"
  | "fileHash"
  | "artworkUrl"
  | "ownerSessionId"
  | "ownerNickname"
  | "sourceType"
  | "sourceRef"
  | "loudness"
  | "originalAsset"
  | "playbackAsset"
>;

type UseRoomPageDerivedInput = {
  activeSessionId: string | null | undefined;
  peerId: string;
  roomSnapshot: RoomSnapshot | null;
};

function resolveTrackSourceKey(track: StableTrackMeta) {
  return track.sourceRef
    ? `${track.sourceRef.provider}:${track.sourceRef.trackId}`
    : null;
}

function resolveAssetKey(asset: StableTrackMeta["originalAsset"] | StableTrackMeta["playbackAsset"]) {
  return asset
    ? `${asset.kind}:${asset.assetId}:${asset.unitCount}:${asset.merkleRoot}`
    : null;
}

function resolveLoudnessKey(loudness: StableTrackMeta["loudness"]) {
  return loudness
    ? [
      loudness.integratedLufs,
      loudness.truePeakDbtp,
      loudness.gainDb,
      loudness.targetLufs,
      loudness.version
    ].join(":")
    : null;
}

function areTrackMetasEqual(previous: StableTrackMeta, next: StableTrackMeta) {
  return (
    previous.id === next.id &&
    previous.title === next.title &&
    previous.artist === next.artist &&
    previous.album === next.album &&
    previous.lyrics === next.lyrics &&
    previous.durationMs === next.durationMs &&
    previous.bitrate === next.bitrate &&
    previous.sizeBytes === next.sizeBytes &&
    previous.codec === next.codec &&
    previous.mimeType === next.mimeType &&
    previous.fileHash === next.fileHash &&
    previous.artworkUrl === next.artworkUrl &&
    previous.ownerSessionId === next.ownerSessionId &&
    previous.ownerNickname === next.ownerNickname &&
    previous.sourceType === next.sourceType &&
    resolveTrackSourceKey(previous) === resolveTrackSourceKey(next) &&
    resolveLoudnessKey(previous.loudness) === resolveLoudnessKey(next.loudness) &&
    resolveAssetKey(previous.originalAsset) === resolveAssetKey(next.originalAsset) &&
    resolveAssetKey(previous.playbackAsset) === resolveAssetKey(next.playbackAsset)
  );
}

export function resolveStableCurrentTrack<TTrack extends StableTrackMeta>(
  previousTrack: TTrack | null,
  currentPlaybackTrackId: string | null | undefined,
  tracks: TTrack[] | null | undefined
) {
  const nextTrack = currentPlaybackTrackId
    ? tracks?.find((track) => track.id === currentPlaybackTrackId) ?? null
    : null;
  if (previousTrack && nextTrack && areTrackMetasEqual(previousTrack, nextTrack)) {
    return previousTrack;
  }

  return nextTrack;
}

export function resolveRoomPagePlaybackState(input: UseRoomPageDerivedInput) {
  const roomPlayback = input.roomSnapshot?.room.playback ?? null;
  const currentPlaybackTrackId = roomPlayback?.currentTrackId ?? null;
  const playbackMediaEpoch = roomPlayback?.mediaEpoch ?? null;
  const playbackQueueVersion = roomPlayback?.queueVersion ?? null;
  const playbackRevision = roomPlayback?.playbackRevision ?? null;
  const playbackSourcePeerId = roomPlayback?.sourcePeerId ?? null;
  const playbackSourceSessionId = roomPlayback?.sourceSessionId ?? null;
  const playbackStatus = roomPlayback?.status ?? null;
  const currentSourcePeerId = resolveCurrentSourcePeerId(input.roomSnapshot, roomPlayback);
  const currentSourcePresenceState = resolveCurrentSourcePresenceState(
    input.roomSnapshot,
    roomPlayback
  );

  return {
    roomPlayback,
    currentPlaybackTrackId,
    playbackMediaEpoch,
    playbackQueueVersion,
    playbackRevision,
    playbackSourcePeerId,
    playbackSourceSessionId,
    playbackStatus,
    isCurrentSourceOwner: isCurrentPlaybackSourceDevice({
      playback: roomPlayback,
      peerId: input.peerId,
      activeSessionId: input.activeSessionId,
      sourcePeerId: currentSourcePeerId,
      sourcePresenceState: currentSourcePresenceState
    }),
    playbackSurfaceKey: resolvePlaybackSurfaceKey(roomPlayback),
    playbackTimelineKey: resolvePlaybackTimelineKey(roomPlayback),
    playbackTopologySnapshot: currentPlaybackTrackId
      ? {
          currentTrackId: currentPlaybackTrackId,
          mediaEpoch: playbackMediaEpoch,
          sourcePeerId: playbackSourcePeerId,
          sourceSessionId: playbackSourceSessionId
        }
      : null
  };
}

export function useRoomPageDerived({
  activeSessionId,
  peerId,
  roomSnapshot
}: UseRoomPageDerivedInput) {
  const roomPlayback = roomSnapshot?.room.playback ?? null;
  const currentPlaybackTrackId = roomPlayback?.currentTrackId ?? null;
  const playbackMediaEpoch = roomPlayback?.mediaEpoch ?? null;
  const playbackQueueVersion = roomPlayback?.queueVersion ?? null;
  const playbackRevision = roomPlayback?.playbackRevision ?? null;
  const playbackSourcePeerId = roomPlayback?.sourcePeerId ?? null;
  const playbackSourceSessionId = roomPlayback?.sourceSessionId ?? null;
  const playbackStatus = roomPlayback?.status ?? null;
  const currentSourcePeerId = resolveCurrentSourcePeerId(roomSnapshot, roomPlayback);
  const currentSourcePresenceState = resolveCurrentSourcePresenceState(roomSnapshot, roomPlayback);

  const isCurrentSourceOwner = useMemo(
    () =>
      isCurrentPlaybackSourceDevice({
        playback: roomPlayback,
        peerId,
        activeSessionId,
        sourcePeerId: currentSourcePeerId,
        sourcePresenceState: currentSourcePresenceState
      }),
    [activeSessionId, currentSourcePeerId, currentSourcePresenceState, peerId, roomPlayback]
  );
  const playbackSurfaceKey = useMemo(
    () => {
      if (!currentPlaybackTrackId) {
        return null;
      }

      const sourceIdentity = playbackSourceSessionId ?? playbackSourcePeerId ?? "none";
      const mediaEpoch = typeof playbackMediaEpoch === "number" ? playbackMediaEpoch : "none";
      return [currentPlaybackTrackId, sourceIdentity, mediaEpoch].join("|");
    },
    [currentPlaybackTrackId, playbackMediaEpoch, playbackSourcePeerId, playbackSourceSessionId]
  );
  const playbackTimelineKey = useMemo(
    () => {
      if (!currentPlaybackTrackId) {
        return null;
      }

      const mediaEpoch = typeof playbackMediaEpoch === "number" ? playbackMediaEpoch : "none";
      return [
        currentPlaybackTrackId,
        mediaEpoch,
        roomPlayback?.startAt ?? roomPlayback?.startedAt ?? "stopped",
        playbackStatus
      ].join("|");
    },
    [currentPlaybackTrackId, playbackMediaEpoch, playbackStatus, roomPlayback?.startAt, roomPlayback?.startedAt]
  );
  const playbackTopologySnapshot = useMemo(
    () =>
      currentPlaybackTrackId
        ? {
            currentTrackId: currentPlaybackTrackId,
            mediaEpoch: playbackMediaEpoch,
            sourcePeerId: playbackSourcePeerId,
            sourceSessionId: playbackSourceSessionId
          }
        : null,
    [currentPlaybackTrackId, playbackMediaEpoch, playbackSourcePeerId, playbackSourceSessionId]
  );
  const currentTrackRef = useRef<RoomSnapshot["tracks"][number] | null>(null);
  const currentTrack = useMemo(
    () => resolveStableCurrentTrack(currentTrackRef.current, currentPlaybackTrackId, roomSnapshot?.tracks),
    [currentPlaybackTrackId, roomSnapshot?.tracks]
  );
  currentTrackRef.current = currentTrack;

  return {
    roomPlayback,
    currentPlaybackTrackId,
    playbackMediaEpoch,
    playbackQueueVersion,
    playbackRevision,
    playbackSourcePeerId,
    playbackSourceSessionId,
    playbackStatus,
    isCurrentSourceOwner,
    playbackSurfaceKey,
    playbackTimelineKey,
    playbackTopologySnapshot,
    currentTrack
  };
}

export function resolveCurrentSourcePeerId(
  roomSnapshot: RoomSnapshot | null | undefined,
  playback: RoomSnapshot["room"]["playback"] | null | undefined
) {
  if (!playback?.sourcePeerId) {
    return null;
  }
  const presencePeerId = playback.sourceSessionId
    ? roomSnapshot?.room.members.find((member) => member.id === playback.sourceSessionId)?.peerId ?? null
    : null;
  return presencePeerId ?? playback.sourcePeerId;
}

export function resolveCurrentSourcePresenceState(
  roomSnapshot: RoomSnapshot | null | undefined,
  playback: RoomSnapshot["room"]["playback"] | null | undefined
) {
  if (!playback?.sourceSessionId) {
    return null;
  }
  return (
    roomSnapshot?.room.members.find((member) => member.id === playback.sourceSessionId)
      ?.presenceState ?? null
  );
}
