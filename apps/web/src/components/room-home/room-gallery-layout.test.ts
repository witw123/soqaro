import { describe, expect, it } from "vitest";
import type { RoomDirectoryItem, RoomType } from "@soqaro/shared";
import {
  buildCuratedGalleryPlan,
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

  it("partitions rooms cleanly into scrolling rail and lower grid without single-card orphans", () => {
    const r1 = makeRoom("r1", { online: 10, playing: true });
    const r2 = makeRoom("r2", { online: 8, playing: true });
    const r3 = makeRoom("r3", { online: 6, playing: true });

    expect(buildCuratedGalleryPlan([]).mode).toBe("empty");

    const threePlan = buildCuratedGalleryPlan([r1, r2, r3]);
    expect(threePlan.mode).toBe("rail");
    expect(threePlan.featuredRooms).toHaveLength(3);
    expect(threePlan.gridRooms).toHaveLength(0);

    const sevenRooms = Array.from({ length: 7 }, (_, i) =>
      makeRoom(`room_${i}`, { online: 20 - i, playing: i < 3 })
    );
    const sevenPlan = buildCuratedGalleryPlan(sevenRooms);
    expect(sevenPlan.mode).toBe("rail-and-grid");
    expect(sevenPlan.featuredRooms).toHaveLength(5);
    expect(sevenPlan.gridRooms).toHaveLength(2);

    const sixteenRooms = Array.from({ length: 16 }, (_, i) =>
      makeRoom(`room16_${i}`, { online: 30 - i, playing: i < 4 })
    );
    const sixteenPlan = buildCuratedGalleryPlan(sixteenRooms);
    expect(sixteenPlan.mode).toBe("rail-and-grid");
    expect(sixteenPlan.featuredRooms).toHaveLength(6);
    expect(sixteenPlan.gridRooms).toHaveLength(10);
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
