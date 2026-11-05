import { describe, expect, it } from "vitest";
import type { RoomDirectoryItem, RoomType } from "@soqaro/shared";
import {
  countRoomsByFilter,
  formatRoomLiveMetric,
  sortCuratedRooms
} from "./room-gallery-layout";

function makeRoom(
  id: string,
  overrides: {
    roomType?: RoomType;
    online?: number;
    playing?: boolean;
    onAir?: boolean;
    queueDepth?: number;
    pendingRequests?: number;
  } = {}
): RoomDirectoryItem {
  const roomType = overrides.roomType ?? "interactive";
  return {
    room: {
      id,
      joinCode: id.slice(0, 6).toUpperCase().padEnd(6, "0"),
      name: `Room ${id}`,
      description: "Test description",
      hasPassword: false,
      visibility: "public",
      roomType,
      directoryHostNickname: "Host",
      directoryMemberCount: overrides.online ?? 1,
      directoryOnlineMemberCount: overrides.online ?? 1,
      directoryIsMember: false,
      directoryQueueDepth: overrides.queueDepth ?? 0,
      directoryPendingRequestCount: overrides.pendingRequests ?? 0,
      directoryBroadcastState: overrides.onAir ? "on_air" : null,
      directoryNowPlaying: overrides.playing
        ? { title: "Track", artist: "Artist", artworkUrl: null }
        : null,
      playbackStatus: overrides.playing ? "playing" : "paused"
    }
  };
}

describe("room-gallery-layout", () => {
  it("prioritizes away room, then actively playing rooms, then online count", () => {
    const idleCrowded = makeRoom("idle_crowded", { online: 20, playing: false });
    const playingSmall = makeRoom("playing_small", { online: 4, playing: true });
    const playingLarge = makeRoom("playing_large", { online: 12, playing: true });
    const awayIdle = makeRoom("away_idle", { online: 1, playing: false });

    const sorted = sortCuratedRooms(
      [idleCrowded, playingSmall, playingLarge, awayIdle],
      "away_idle"
    );

    expect(sorted.map((item) => item.room.id)).toEqual([
      "away_idle",
      "playing_large",
      "playing_small",
      "idle_crowded"
    ]);
  });

  it("counts filter categories and formats live metrics cleanly", () => {
    const interactive = makeRoom("int", { roomType: "interactive", queueDepth: 6 });
    const request = makeRoom("req", {
      roomType: "request",
      queueDepth: 2,
      pendingRequests: 3
    });
    const radio = makeRoom("rad", { roomType: "radio", onAir: true });

    expect(countRoomsByFilter([interactive, request, radio])).toEqual({
      all: 3,
      interactive: 1,
      request: 1,
      radio: 1
    });

    expect(formatRoomLiveMetric(interactive)).toEqual({
      label: "共享队列",
      value: "6 首曲目"
    });
    expect(formatRoomLiveMetric(request)).toEqual({
      label: "点歌动态",
      value: "待处理 3 / 队列 2"
    });
    expect(formatRoomLiveMetric(radio)).toEqual({
      label: "电台信号",
      value: "正在播出"
    });
  });
});
