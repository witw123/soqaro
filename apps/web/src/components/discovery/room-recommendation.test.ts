import { describe, expect, it } from "vitest";
import type { PersonalizationProfileResponse, RoomDirectoryItem } from "@soqaro/shared";
import {
  curateRecommendedRooms,
  filterCuratedRooms,
  pickRandomOpenRoom
} from "./room-recommendation";

function buildRoom(
  overrides: Partial<RoomDirectoryItem["room"]> & { id: string; name: string }
): RoomDirectoryItem {
  return {
    room: {
      id: overrides.id,
      joinCode: overrides.joinCode ?? overrides.id.toUpperCase(),
      name: overrides.name,
      description: overrides.description ?? null,
      hasPassword: overrides.hasPassword ?? false,
      visibility: overrides.visibility ?? "public",
      roomType: overrides.roomType ?? "interactive",
      directoryHostNickname: overrides.directoryHostNickname ?? "Host",
      directoryMemberCount: overrides.directoryMemberCount ?? 2,
      directoryOnlineMemberCount: overrides.directoryOnlineMemberCount ?? 2,
      directoryIsMember: overrides.directoryIsMember ?? false,
      directoryQueueDepth: overrides.directoryQueueDepth ?? 3,
      directoryPendingRequestCount: overrides.directoryPendingRequestCount ?? 0,
      directoryBroadcastState: overrides.directoryBroadcastState ?? null,
      directoryNowPlaying: overrides.directoryNowPlaying ?? null,
      playbackStatus: overrides.playbackStatus ?? "paused"
    }
  };
}

describe("room-recommendation curation", () => {
  it("prioritizes taste-matched rooms playing user's top artists or genres", () => {
    const rooms: RoomDirectoryItem[] = [
      buildRoom({
        id: "r1",
        name: "普通闲聊房",
        directoryOnlineMemberCount: 3,
        playbackStatus: "playing",
        directoryNowPlaying: {
          title: "Unknown Song",
          artist: "Other Artist",
          artworkUrl: null
        }
      }),
      buildRoom({
        id: "r2",
        name: "深夜华语流行",
        directoryOnlineMemberCount: 2,
        playbackStatus: "playing",
        directoryNowPlaying: {
          title: "晴天",
          artist: "周杰伦",
          artworkUrl: null
        }
      })
    ];

    const profile: PersonalizationProfileResponse = {
      version: "1.0",
      startedAt: null,
      totalListenedMs: 60000,
      totalPlayCount: 5,
      trackCount: 2,
      artistCount: 1,
      tasteGroups: [
        {
          id: "genre",
          label: "曲风",
          tags: [
            {
              label: "摇滚",
              score: 8,
              confidence: 0.9,
              source: "provider-tags",
              updatedAt: "2026-01-01T00:00:00.000Z"
            }
          ]
        }
      ],
      topTracks: [],
      topArtists: [
        { name: "周杰伦", score: 10, listenedMs: 60000, playCount: 5 }
      ],
      sourceDistribution: []
    };

    const curated = curateRecommendedRooms(rooms, { profile });
    expect(curated[0]?.item.room.id).toBe("r2");
    expect(curated[0]?.isTasteMatched).toBe(true);
    expect(curated[0]?.reason).toBe("正在播放 周杰伦");
  });

  it("filters rooms by vibe category, room type, and search query", () => {
    const rooms: RoomDirectoryItem[] = [
      buildRoom({
        id: "r-rock",
        name: "独立摇滚现场",
        description: "后摇与乐队巡礼",
        roomType: "interactive",
        playbackStatus: "playing",
        directoryNowPlaying: {
          title: "杀死那个石家庄人",
          artist: "万能青年旅店",
          artworkUrl: null
        }
      }),
      buildRoom({
        id: "r-focus",
        name: "自习白噪音",
        description: "Lo-Fi 与钢琴纯音",
        roomType: "radio",
        directoryBroadcastState: "on_air"
      })
    ];

    const curated = curateRecommendedRooms(rooms);

    const rockFiltered = filterCuratedRooms(curated, {
      vibeFilter: "rock",
      roomTypeFilter: "all",
      searchQuery: ""
    });
    expect(rockFiltered.map((c) => c.item.room.id)).toEqual(["r-rock"]);

    const radioFiltered = filterCuratedRooms(curated, {
      vibeFilter: "all",
      roomTypeFilter: "radio",
      searchQuery: ""
    });
    expect(radioFiltered.map((c) => c.item.room.id)).toEqual(["r-focus"]);

    const searched = filterCuratedRooms(curated, {
      vibeFilter: "all",
      roomTypeFilter: "all",
      searchQuery: "万能青年"
    });
    expect(searched.map((c) => c.item.room.id)).toEqual(["r-rock"]);
  });

  it("picks an open password-free room for random quick entry", () => {
    const rooms: RoomDirectoryItem[] = [
      buildRoom({
        id: "locked",
        name: "加密房",
        hasPassword: true,
        playbackStatus: "playing"
      }),
      buildRoom({
        id: "open-live",
        name: "公开热播房",
        hasPassword: false,
        playbackStatus: "playing"
      })
    ];

    const curated = curateRecommendedRooms(rooms);
    const picked = pickRandomOpenRoom(curated);
    expect(picked?.room.id).toBe("open-live");
  });
});
