import type {
  PersonalizationProfileResponse,
  RoomDirectoryItem,
  RoomType
} from "@soqaro/shared";
import type { RoomActivitySummary } from "@/lib/network/soqaro-api";

export type RoomVibeFilterId =
  | "all"
  | "playing"
  | "pop"
  | "rock"
  | "electronic"
  | "acg"
  | "chill"
  | "focus"
  | "guofeng";

export type RoomVibeCategory = {
  id: RoomVibeFilterId;
  label: string;
  keywords: readonly string[];
};

export const ROOM_VIBE_CATEGORIES: readonly RoomVibeCategory[] = [
  { id: "all", label: "全部推荐", keywords: [] },
  { id: "playing", label: "正在热播", keywords: [] },
  {
    id: "pop",
    label: "流行金曲",
    keywords: [
      "流行",
      "pop",
      "华语",
      "金曲",
      "粤语",
      "港乐",
      "主打",
      "热歌",
      "city pop",
      "k-pop",
      "欧美",
      "周杰伦",
      "林俊杰",
      "陈奕迅",
      "邓紫棋",
      "薛之谦",
      "陶喆",
      "taylor swift",
      "bruno mars"
    ]
  },
  {
    id: "rock",
    label: "摇滚独立",
    keywords: [
      "摇滚",
      "rock",
      "独立",
      "indie",
      "乐队",
      "朋克",
      "punk",
      "金属",
      "metal",
      "后摇",
      "五月天",
      "告五人",
      "草东没有派对",
      "万能青年旅店"
    ]
  },
  {
    id: "electronic",
    label: "电子律动",
    keywords: [
      "电子",
      "edm",
      "house",
      "techno",
      "电音",
      "synth",
      "舞曲",
      "律动",
      "蒸汽波",
      "派对",
      "dj",
      "club",
      "bass"
    ]
  },
  {
    id: "acg",
    label: "ACG 日系",
    keywords: [
      "acg",
      "anime",
      "二次元",
      "动漫",
      "动画",
      "游戏",
      "vocaloid",
      "日系",
      "日语",
      "j-pop",
      "ost",
      "原声",
      "米津玄师",
      "yoasobi",
      "radwimps"
    ]
  },
  {
    id: "chill",
    label: "深夜民谣",
    keywords: [
      "深夜",
      "夜听",
      "晚安",
      "治愈",
      "r&b",
      "rnb",
      "soul",
      "爵士",
      "jazz",
      "蓝调",
      "慢歌",
      "抒情",
      "民谣",
      "folk",
      "吉他",
      "故事",
      "雨天",
      "放空"
    ]
  },
  {
    id: "focus",
    label: "专注纯音",
    keywords: [
      "专注",
      "学习",
      "工作",
      "纯音乐",
      "纯音",
      "轻音乐",
      "古典",
      "钢琴",
      "lo-fi",
      "lofi",
      "chill",
      "白噪音",
      "自习",
      "咖啡",
      "冥想",
      "器乐",
      "阅读"
    ]
  },
  {
    id: "guofeng",
    label: "国风古韵",
    keywords: [
      "国风",
      "古风",
      "仙侠",
      "戏腔",
      "民乐",
      "新中式",
      "武侠",
      "中国风",
      "古琴",
      "琵琶"
    ]
  }
];

export type RoomRecommendationMatchKind =
  | "away"
  | "taste"
  | "frequent"
  | "live"
  | "general";

export type CuratedRoomRecommendation = {
  item: RoomDirectoryItem;
  score: number;
  reason: string;
  matchKind: RoomRecommendationMatchKind;
  vibeLabels: string[];
  vibeIds: RoomVibeFilterId[];
  isLive: boolean;
  isFrequent: boolean;
  isTasteMatched: boolean;
};

export type RoomRecommendationContext = {
  awayRoomId?: string | null;
  profile?: PersonalizationProfileResponse | null;
  favoriteArtistNames?: readonly string[];
  favoriteTrackTitles?: readonly string[];
  roomActivity?: readonly RoomActivitySummary[];
};

const ROOM_FORMAT_LABELS: Record<RoomType, string> = {
  interactive: "多人互动",
  request: "点歌房",
  radio: "自由电台"
};

export function formatRoomFormatLabel(roomType: RoomType): string {
  return ROOM_FORMAT_LABELS[roomType];
}

export function isRoomBroadcastingOrPlaying(item: RoomDirectoryItem): boolean {
  const { room } = item;
  return (
    room.playbackStatus === "playing" ||
    room.directoryBroadcastState === "on_air"
  );
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function matchRoomVibes(item: RoomDirectoryItem): {
  ids: RoomVibeFilterId[];
  labels: string[];
} {
  const { room } = item;
  const corpus = [
    room.name,
    room.description ?? "",
    room.directoryNowPlaying?.title ?? "",
    room.directoryNowPlaying?.artist ?? ""
  ]
    .join(" ")
    .toLowerCase();

  const ids: RoomVibeFilterId[] = [];
  const labels: string[] = [];

  for (const category of ROOM_VIBE_CATEGORIES) {
    if (category.id === "all" || category.id === "playing") continue;
    if (category.keywords.some((kw) => corpus.includes(kw.toLowerCase()))) {
      ids.push(category.id);
      labels.push(category.label);
    }
  }

  return { ids, labels };
}

export function curateRecommendedRooms(
  rooms: readonly RoomDirectoryItem[],
  context: RoomRecommendationContext = {}
): CuratedRoomRecommendation[] {
  const awayRoomId = context.awayRoomId ?? null;
  const profile = context.profile ?? null;

  const artistNames = Array.from(
    new Set(
      [
        ...(profile?.topArtists.map((a) => a.name.trim()) ?? []),
        ...(context.favoriteArtistNames?.map((name) => name.trim()) ?? [])
      ].filter((name) => name.length > 0)
    )
  );

  const trackTitles = Array.from(
    new Set(
      [
        ...(profile?.topTracks.map((t) => t.title.trim()) ?? []),
        ...(profile?.recentTracks?.map((t) => t.title.trim()) ?? []),
        ...(context.favoriteTrackTitles?.map((title) => title.trim()) ?? [])
      ].filter((title) => title.length >= 2)
    )
  );

  const tasteTags = Array.from(
    new Set(
      (
        profile?.tasteGroups.flatMap((group) =>
          group.tags.map((tag) => tag.label.trim())
        ) ?? []
      ).filter((label) => label.length > 0)
    )
  );

  const activityByRoomId = new Map<string, RoomActivitySummary>();
  for (const activity of context.roomActivity ?? []) {
    activityByRoomId.set(activity.roomId, activity);
  }

  const curated = rooms.map((item): CuratedRoomRecommendation => {
    const { room } = item;
    const nowPlaying = room.directoryNowPlaying;
    const nowTitleLower = normalizeText(nowPlaying?.title);
    const nowArtistLower = normalizeText(nowPlaying?.artist);
    const roomTextLower = normalizeText(`${room.name} ${room.description ?? ""}`);
    const fullCorpusLower = `${roomTextLower} ${nowTitleLower} ${nowArtistLower}`;

    const isAway = Boolean(awayRoomId && room.id === awayRoomId);
    const activity = activityByRoomId.get(room.id);
    const isFrequent = isAway || room.directoryIsMember || Boolean(activity);
    const isLive = isRoomBroadcastingOrPlaying(item);

    const matchedVibes = matchRoomVibes(item);

    let score = 0;
    let reason = "";
    let matchKind: RoomRecommendationMatchKind = "general";
    let isTasteMatched = false;

    // 1. Base live activity score
    if (isLive) {
      score += 24;
    }
    if (nowPlaying?.title) {
      score += 12;
    }
    score += Math.min(room.directoryOnlineMemberCount * 5, 35);
    score += Math.min(
      (room.directoryQueueDepth + room.directoryPendingRequestCount) * 2,
      16
    );
    if (!room.hasPassword) {
      score += 8;
    }

    // 2. Taste match (Artist / Track / Tag)
    const matchedNowPlayingArtist = artistNames.find(
      (artist) =>
        nowArtistLower.length > 0 &&
        nowArtistLower.includes(artist.toLowerCase())
    );
    const matchedRoomArtist = !matchedNowPlayingArtist
      ? artistNames.find((artist) =>
          roomTextLower.includes(artist.toLowerCase())
        )
      : undefined;
    const matchedTrackTitle = trackTitles.find(
      (title) =>
        nowTitleLower.length > 0 &&
        nowTitleLower === title.toLowerCase()
    );
    const matchedTag = tasteTags.find((tag) =>
      fullCorpusLower.includes(tag.toLowerCase())
    );

    if (matchedNowPlayingArtist) {
      score += 48;
      reason = `正在播放 ${matchedNowPlayingArtist}`;
      matchKind = "taste";
      isTasteMatched = true;
    } else if (matchedTrackTitle) {
      score += 44;
      reason = "正在播放常听曲目";
      matchKind = "taste";
      isTasteMatched = true;
    } else if (matchedRoomArtist) {
      score += 34;
      reason = `常听艺人 ${matchedRoomArtist}`;
      matchKind = "taste";
      isTasteMatched = true;
    } else if (matchedTag) {
      score += 28;
      reason = `符合「${matchedTag}」偏好`;
      matchKind = "taste";
      isTasteMatched = true;
    }

    // 3. Familiarity / Away status
    if (isAway) {
      score += 120;
      reason = "当前挂起房间";
      matchKind = "away";
    } else if (room.directoryIsMember) {
      score += 30;
      if (!reason) {
        reason = "已加入房间";
        matchKind = "frequent";
      }
    } else if (activity) {
      score += 22;
      if (!reason) {
        reason = "近期常去";
        matchKind = "frequent";
      }
    }

    // 4. Factual fallback reason
    if (!reason) {
      if (room.roomType === "radio" && room.directoryBroadcastState === "on_air") {
        reason = "电台正在播出";
        matchKind = "live";
      } else if (isLive && room.directoryOnlineMemberCount >= 2) {
        reason = `${room.directoryOnlineMemberCount} 人同步在听`;
        matchKind = "live";
      } else if (nowPlaying?.title) {
        reason = matchedVibes.labels[0] ?? "正在播放曲目";
        matchKind = "live";
      } else if (
        room.roomType === "request" &&
        (room.directoryQueueDepth > 0 || room.directoryPendingRequestCount > 0)
      ) {
        reason = "开放点歌互动";
      } else if (room.directoryQueueDepth > 0) {
        reason = `队列 ${room.directoryQueueDepth} 首`;
      } else if (matchedVibes.labels[0]) {
        reason = matchedVibes.labels[0];
      } else if (!room.hasPassword) {
        reason = "公开免密";
      } else {
        reason = "凭密码进入";
      }
    }

    return {
      item,
      score,
      reason,
      matchKind,
      vibeLabels: matchedVibes.labels,
      vibeIds: matchedVibes.ids,
      isLive,
      isFrequent,
      isTasteMatched
    };
  });

  return curated.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (left.isLive !== right.isLive) {
      return left.isLive ? -1 : 1;
    }
    return (
      right.item.room.directoryOnlineMemberCount -
      left.item.room.directoryOnlineMemberCount
    );
  });
}

export function filterCuratedRooms(
  curatedRooms: readonly CuratedRoomRecommendation[],
  options: {
    vibeFilter: RoomVibeFilterId;
    roomTypeFilter: "all" | RoomType;
    searchQuery: string;
  }
): CuratedRoomRecommendation[] {
  const query = normalizeText(options.searchQuery);

  return curatedRooms.filter((entry) => {
    const { room } = entry.item;

    if (
      options.roomTypeFilter !== "all" &&
      room.roomType !== options.roomTypeFilter
    ) {
      return false;
    }

    if (options.vibeFilter === "playing") {
      if (!entry.isLive && !room.directoryNowPlaying?.title) {
        return false;
      }
    } else if (options.vibeFilter !== "all") {
      if (!entry.vibeIds.includes(options.vibeFilter)) {
        return false;
      }
    }

    if (!query) {
      return true;
    }

    const searchableFields = [
      room.name,
      room.description ?? "",
      room.joinCode,
      room.directoryHostNickname,
      room.directoryNowPlaying?.title ?? "",
      room.directoryNowPlaying?.artist ?? "",
      entry.reason,
      ...entry.vibeLabels
    ];

    return searchableFields.some((field) =>
      field.toLowerCase().includes(query)
    );
  });
}

export function pickRandomOpenRoom(
  curatedRooms: readonly CuratedRoomRecommendation[],
  excludeRoomId?: string | null
): RoomDirectoryItem | null {
  const candidates = curatedRooms.filter(
    (entry) =>
      !entry.item.room.hasPassword &&
      entry.item.room.id !== excludeRoomId
  );
  if (candidates.length === 0) return null;

  const liveCandidates = candidates.filter(
    (entry) => entry.isLive || Boolean(entry.item.room.directoryNowPlaying?.title)
  );
  const pool = liveCandidates.length > 0 ? liveCandidates : candidates;
  const randomIndex = Math.floor(Math.random() * pool.length);
  return pool[randomIndex]?.item ?? null;
}
