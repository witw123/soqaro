import type { PlaybackSnapshot, RoomMember } from "@soqaro/shared";

export function isCurrentPlaybackSourceDevice(input: {
  playback: PlaybackSnapshot | null | undefined;
  peerId: string | null | undefined;
  activeSessionId?: string | null | undefined;
  sourcePeerId?: string | null;
  sourcePresenceState?: RoomMember["presenceState"] | null;
}) {
  const playback = input.playback;
  if (!playback?.currentTrackId || !input.peerId) {
    return false;
  }

  if (
    input.activeSessionId &&
    playback.sourceSessionId &&
    input.activeSessionId !== playback.sourceSessionId
  ) {
    return false;
  }

  const explicitSourcePeerId = input.sourcePeerId ?? null;
  const snapshotSourcePeerId = playback.sourcePeerId ?? null;

  if (!explicitSourcePeerId && !snapshotSourcePeerId) {
    return Boolean(
      playback.status === "playing" &&
      input.sourcePresenceState === "reconnecting" &&
      input.activeSessionId &&
      playback.sourceSessionId &&
      input.activeSessionId === playback.sourceSessionId
    );
  }

  // Only the specific physical client peer currently designated as the room's
  // broadcast source peer (or transitioning presence peer) may act as the broadcast source.
  return (
    (snapshotSourcePeerId !== null && input.peerId === snapshotSourcePeerId) ||
    (explicitSourcePeerId !== null && input.peerId === explicitSourcePeerId)
  );
}
