import { describe, expect, it } from "vitest";
import type { RoomDirectoryItem, RoomType } from "@soqaro/shared";
import {
  computeRoomTextScore,
  countRoomsByFilter,
  formatRoomLiveMetric,
  packRoomsIntoContentMosaic,
  resolveMosaicSpanPattern,
  sortCuratedRooms
} from "./room-gallery-layout";

function makeRoom(
  id: string,
  overrides: {
    name?: string;
    description?: string;
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
      name: overrides.name ?? `Room ${id}`,
      description: overrides.description ?? "Test description",
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

  it("builds flush interlocking 12-column Bento Mosaic span patterns with staggered seams", () => {
    expect(resolveMosaicSpanPattern(0)).toEqual([]);
    expect(resolveMosaicSpanPattern(1)).toEqual([{ lgSpan: 6, mdSpan: 6 }]);

    for (const count of [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16]) {
      const spans = resolveMosaicSpanPattern(count);
      expect(spans).toHaveLength(count);

      // Partition into 12-column rows and verify every row sums to 12 and seams stagger
      const rowsSeamSets: number[][] = [];
      let currentSum = 0;
      let currentSeams: number[] = [];

      for (const item of spans) {
        currentSum += item.lgSpan;
        if (currentSum < 12) {
          currentSeams.push(currentSum);
        } else {
          expect(currentSum).toBe(12);
          rowsSeamSets.push(currentSeams);
          currentSum = 0;
          currentSeams = [];
        }
      }
      expect(currentSum).toBe(0);

      for (let r = 1; r < rowsSeamSets.length; r += 1) {
        const prevSeams = rowsSeamSets[r - 1]!;
        const nextSeams = rowsSeamSets[r]!;
        for (const seam of nextSeams) {
          expect(prevSeams).not.toContain(seam);
        }
      }
    }
  });

  it("assigns rooms with longer titles and descriptions to wider mosaic slots within each row", () => {
    const shortRoom = makeRoom("short_copy", {
      name: "短房",
      description: "随手放歌",
      online: 15,
      playing: true
    });
    const mediumRoom = makeRoom("medium_copy", {
      name: "城市夜航电台",
      description: "多人实时同步收听，共享深夜曲库与独立摇滚。",
      online: 14,
      playing: true
    });
    const longRoom = makeRoom("long_copy", {
      name: "前卫摇滚与器乐长篇组曲鉴赏听歌房",
      description:
        "听点前卫的（以及器乐长篇组曲鉴赏）。可作为通勤、工作、学习或睡觉时的背景音乐，适合于沙发、电梯间、候车厅、咖啡馆。",
      online: 13,
      playing: true
    });

    expect(computeRoomTextScore(longRoom)).toBeGreaterThan(computeRoomTextScore(mediumRoom));
    expect(computeRoomTextScore(mediumRoom)).toBeGreaterThan(computeRoomTextScore(shortRoom));

    // Row 0 template is [5, 4, 3]: even though shortRoom has the highest online count,
    // within Row 0 longRoom must receive the 5-col slot, mediumRoom the 4-col slot, and shortRoom the 3-col slot
    const packed = packRoomsIntoContentMosaic([shortRoom, mediumRoom, longRoom]);
    expect(packed.map((entry) => ({ id: entry.item.room.id, lgSpan: entry.span.lgSpan }))).toEqual([
      { id: "long_copy", lgSpan: 5 },
      { id: "medium_copy", lgSpan: 4 },
      { id: "short_copy", lgSpan: 3 }
    ]);
  });

  it("annotates mosaic tile boundaries correctly for flush outer grid alignment", () => {
    const rooms = Array.from({ length: 5 }, (_, i) =>
      makeRoom(`room_${i}`, { name: `Room ${i}`, description: `Desc ${i}` })
    );

    const packed = packRoomsIntoContentMosaic(rooms);
    expect(packed).toHaveLength(5);

    // Desktop (12-cols): Row 0 is [5,4,3] -> index 2 is row end; Row 1 is [7,5] -> index 4 is row end
    expect(packed.map((p) => p.isLgRowEnd)).toEqual([false, false, true, false, true]);
    // Desktop: Row 1 items (indices 3, 4) are bottom row
    expect(packed.map((p) => p.isLgRowBottom)).toEqual([false, false, false, true, true]);

    // Tablet (8-cols): [5, 3] -> index 1 end; [3, 5] -> index 3 end; [8] -> index 4 end
    expect(packed.map((p) => p.isMdRowEnd)).toEqual([false, true, false, true, true]);
    // Tablet: Row 2 is single [8] -> index 4 is bottom row
    expect(packed.map((p) => p.isMdRowBottom)).toEqual([false, false, false, false, true]);

    // Mobile (1-col): only last item is bottom
    expect(packed.map((p) => p.isMobileBottom)).toEqual([false, false, false, false, true]);
  });
});
