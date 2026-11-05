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
  overrides: Partial<RoomDirectoryItem["room"]> & { roomType?: RoomType } = {}
): RoomDirectoryItem {
  return {
    room: {
      id,
      joinCode: id.toUpperCase().slice(0, 6),
      name: `Room ${id}`,
      description: null,
      hasPassword: false,
      visibility: "public",
      roomType: "interactive",
      directoryHostNickname: "Host",
      directoryMemberCount: 1,
      directoryOnlineMemberCount: 1,
      directoryIsMember: false,
      directoryQueueDepth: 0,
      directoryPendingRequestCount: 0,
      directoryBroadcastState: null,
      directoryNowPlaying: null,
      playbackStatus: "paused",
      ...overrides
    }
  };
}

describe("room-gallery-layout", () => {
  it("prioritizes away room first, then active playback, then online count", () => {
    const idleCrowded = makeRoom("idle_crowded", {
      directoryOnlineMemberCount: 20,
      playbackStatus: "paused"
    });
    const playingSmall = makeRoom("playing_small", {
      directoryOnlineMemberCount: 4,
      playbackStatus: "playing",
      directoryNowPlaying: { title: "Track", artist: "Artist", artworkUrl: null }
    });
    const awayIdle = makeRoom("away_idle", {
      directoryOnlineMemberCount: 1,
      playbackStatus: "paused"
    });

    const sorted = sortCuratedRooms(
      [idleCrowded, playingSmall, awayIdle],
      "away_idle"
    );

    expect(sorted.map((item) => item.room.id)).toEqual([
      "away_idle",
      "playing_small",
      "idle_crowded"
    ]);
  });

  it("maps room counts to solo, diptych, trio, and gallery topologies", () => {
    const r1 = makeRoom("r1", { directoryOnlineMemberCount: 10 });
    const r2 = makeRoom("r2", { directoryOnlineMemberCount: 8, roomType: "request" });
    const r3 = makeRoom("r3", { directoryOnlineMemberCount: 6, roomType: "radio" });
    const r4 = makeRoom("r4", { directoryOnlineMemberCount: 3 });

    expect(buildCuratedGalleryPlan([]).mode).toBe("empty");

    const solo = buildCuratedGalleryPlan([r1]);
    expect(solo.mode).toBe("solo");
    expect(solo.leadRoom?.room.id).toBe("r1");

    const diptych = buildCuratedGalleryPlan([r1, r2]);
    expect(diptych.mode).toBe("diptych");
    expect(diptych.diptychRooms?.map((r) => r.room.id)).toEqual(["r1", "r2"]);

    const trio = buildCuratedGalleryPlan([r1, r2, r3]);
    expect(trio.mode).toBe("trio");
    expect(trio.leadRoom?.room.id).toBe("r1");
    expect(trio.pairedSubRooms?.map((r) => r.room.id)).toEqual(["r2", "r3"]);

    const gallery = buildCuratedGalleryPlan([r1, r2, r3, r4]);
    expect(gallery.mode).toBe("gallery");
    expect(gallery.leadRoom?.room.id).toBe("r1");
    expect(gallery.matrixRooms.map((r) => r.room.id)).toEqual(["r2", "r3", "r4"]);
  });

  it("counts rooms per filter and formats format-specific metrics cleanly", () => {
    const rooms = [
      makeRoom("r1", { roomType: "interactive", directoryQueueDepth: 5 }),
      makeRoom("r2", { roomType: "request", directoryPendingRequestCount: 2, directoryQueueDepth: 4 }),
      makeRoom("r3", { roomType: "radio", directoryBroadcastState: "on_air" })
    ];

    expect(countRoomsByFilter(rooms)).toEqual({
      all: 3,
      interactive: 1,
      request: 1,
      radio: 1
    });

    expect(formatRoomLiveMetric(rooms[0]!)).toEqual({
      label: "共享队列",
      value: "5 首曲目"
    });
    expect(formatRoomLiveMetric(rooms[1]!)).toEqual({
      label: "点歌动态",
      value: "待处理 2 / 队列 4"
    });
    expect(formatRoomLiveMetric(rooms[2]!)).toEqual({
      label: "电台信号",
      value: "正在播出"
    });
  });
});
