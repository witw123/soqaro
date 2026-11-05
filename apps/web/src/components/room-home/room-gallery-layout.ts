import type { RoomDirectoryItem, RoomType } from "@soqaro/shared";

export type RoomFilterValue = "all" | RoomType;

export function isRoomActivelyPlaying(item: RoomDirectoryItem): boolean {
  const { room } = item;
  return room.playbackStatus === "playing" || room.directoryBroadcastState === "on_air";
}

/**
 * Deterministic curatorial ranking:
 * 1. Away room currently synced in background (immediate return path)
 * 2. Actively playing / broadcasting rooms before idle rooms
 * 3. Higher online listener count
 * 4. Deeper active queue / pending request activity as tie-breaker
 */
export function sortCuratedRooms(
  rooms: readonly RoomDirectoryItem[],
  awayRoomId?: string | null
): RoomDirectoryItem[] {
  return [...rooms].sort((left, right) => {
    const leftIsAway = Boolean(awayRoomId && left.room.id === awayRoomId);
    const rightIsAway = Boolean(awayRoomId && right.room.id === awayRoomId);
    if (leftIsAway !== rightIsAway) return leftIsAway ? -1 : 1;

    const leftActive = isRoomActivelyPlaying(left);
    const rightActive = isRoomActivelyPlaying(right);
    if (leftActive !== rightActive) return leftActive ? -1 : 1;

    const onlineDiff =
      right.room.directoryOnlineMemberCount - left.room.directoryOnlineMemberCount;
    if (onlineDiff !== 0) return onlineDiff;

    const activityLeft =
      left.room.directoryQueueDepth + left.room.directoryPendingRequestCount;
    const activityRight =
      right.room.directoryQueueDepth + right.room.directoryPendingRequestCount;
    return activityRight - activityLeft;
  });
}

export function countRoomsByFilter(
  rooms: readonly RoomDirectoryItem[]
): Record<RoomFilterValue, number> {
  const counts: Record<RoomFilterValue, number> = {
    all: rooms.length,
    interactive: 0,
    request: 0,
    radio: 0
  };

  for (const item of rooms) {
    counts[item.room.roomType] += 1;
  }

  return counts;
}

export function toSafeViewTransitionToken(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function formatRoomLiveMetric(item: RoomDirectoryItem): {
  label: string;
  value: string;
} {
  const { room } = item;
  if (room.roomType === "request") {
    return {
      label: "点歌动态",
      value:
        room.directoryPendingRequestCount > 0
          ? `待处理 ${room.directoryPendingRequestCount} / 队列 ${room.directoryQueueDepth}`
          : `队列 ${room.directoryQueueDepth} 首`
    };
  }

  if (room.roomType === "radio") {
    return {
      label: "电台信号",
      value: room.directoryBroadcastState === "on_air" ? "正在播出" : "待机静默"
    };
  }

  return {
    label: "共享队列",
    value: `${room.directoryQueueDepth} 首曲目`
  };
}
