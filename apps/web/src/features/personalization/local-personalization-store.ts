import type {
  PersonalizationProfileResponse,
  PersonalizationTrack
} from "@soqaro/shared";

export function getLocalProfileKey(userId?: string | null): string {
  return userId ? `soqaro_local_profile_${userId}` : "soqaro_local_profile_guest";
}

export function getLocalStoredProfile(userId?: string | null): PersonalizationProfileResponse | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(getLocalProfileKey(userId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveLocalStoredProfile(profile: PersonalizationProfileResponse, userId?: string | null): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(getLocalProfileKey(userId), JSON.stringify(profile));
  } catch {
    // ignore storage quota errors
  }
}

export function clearLocalStoredProfile(userId?: string | null): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(getLocalProfileKey(userId));
    if (!userId) {
      localStorage.removeItem("soqaro_local_profile");
    }
  } catch {
    // ignore storage errors
  }
}

function toProviderType(p: string): "netease" | "qqmusic" | "bilibili" {
  if (p === "netease" || p === "qqmusic" || p === "bilibili") return p;
  return "bilibili";
}

/**
 * 将本地产生的收听事件即时累加到本地画像中
 */
export function recordLocalListeningProgress(input: {
  userId?: string | null;
  track: {
    provider: "netease" | "qqmusic" | "bilibili" | "alist" | "local_upload";
    providerTrackId: string;
    title: string;
    artist: string;
    album: string | null;
    durationMs: number;
    artworkUrl: string | null;
  };
  deltaMs: number;
  isNewPlay?: boolean;
}): PersonalizationProfileResponse {
  const current = getLocalStoredProfile(input.userId) ?? {
    version: "1.0",
    startedAt: new Date().toISOString(),
    totalListenedMs: 0,
    totalPlayCount: 0,
    trackCount: 0,
    artistCount: 0,
    tasteGroups: [],
    topTracks: [],
    topArtists: [],
    recentTracks: [],
    sourceDistribution: []
  };

  const delta = Math.max(0, input.deltaMs);
  current.totalListenedMs = (current.totalListenedMs || 0) + delta;
  if (input.isNewPlay) {
    current.totalPlayCount = (current.totalPlayCount || 0) + 1;
  }

  // 更新 Top Tracks
  const trackKey = `${input.track.provider}:${input.track.providerTrackId}`;
  const foundTrack = current.topTracks.find(
    (t) => `${t.provider}:${t.providerTrackId}` === trackKey
  );
  if (foundTrack) {
    foundTrack.listenedMs += delta;
    if (input.isNewPlay) foundTrack.playCount += 1;
  } else {
    const provider = toProviderType(input.track.provider);
    const newTrack: PersonalizationProfileResponse["topTracks"][number] = {
      provider,
      providerTrackId: input.track.providerTrackId,
      access: "free",
      quality: "standard",
      title: input.track.title,
      artist: input.track.artist,
      album: input.track.album,
      durationMs: input.track.durationMs,
      artworkUrl: input.track.artworkUrl,
      score: 1,
      reasons: ["本地常听"],
      listenedMs: delta,
      playCount: input.isNewPlay ? 1 : 0
    };
    current.topTracks.push(newTrack);
  }
  current.topTracks.sort((a, b) => b.listenedMs - a.listenedMs);
  if (current.topTracks.length > 30) current.topTracks = current.topTracks.slice(0, 30);
  current.trackCount = current.topTracks.length;

  // 更新 Top Artists
  const artistName = input.track.artist.trim();
  if (artistName && artistName !== "未知歌手") {
    const foundArtist = current.topArtists.find(
      (a) => a.name.toLowerCase() === artistName.toLowerCase()
    );
    if (foundArtist) {
      foundArtist.listenedMs += delta;
      if (input.isNewPlay) foundArtist.playCount += 1;
      foundArtist.score = Math.round(foundArtist.listenedMs / 10000);
    } else {
      const newArtist: PersonalizationProfileResponse["topArtists"][number] = {
        name: artistName,
        score: Math.max(1, Math.round(delta / 10000)),
        listenedMs: delta,
        playCount: input.isNewPlay ? 1 : 0
      };
      current.topArtists.push(newArtist);
    }
    current.topArtists.sort((a, b) => b.listenedMs - a.listenedMs);
    if (current.topArtists.length > 20) current.topArtists = current.topArtists.slice(0, 20);
    current.artistCount = current.topArtists.length;
  }

  // 更新 Recent Tracks
  const provider = toProviderType(input.track.provider);
  const recentCandidate: PersonalizationTrack = {
    provider,
    providerTrackId: input.track.providerTrackId,
    access: "free",
    quality: "standard",
    title: input.track.title,
    artist: input.track.artist,
    album: input.track.album,
    durationMs: input.track.durationMs,
    artworkUrl: input.track.artworkUrl,
    score: 1,
    reasons: ["最近播放"]
  };
  const filteredRecent = (current.recentTracks || []).filter(
    (t) => `${t.provider}:${t.providerTrackId}` !== trackKey
  );
  current.recentTracks = [recentCandidate, ...filteredRecent].slice(0, 20);

  // 更新音源分布
  const sourceDist = current.sourceDistribution || [];
  const foundSource = sourceDist.find((s) => s.source === input.track.provider);
  if (foundSource) {
    foundSource.listenedMs += delta;
  } else {
    sourceDist.push({ source: input.track.provider, listenedMs: delta });
  }
  current.sourceDistribution = sourceDist;

  saveLocalStoredProfile(current, input.userId);
  return current;
}

/**
 * 将本地生成的画像与服务端持久化存储的画像进行合并
 * 确保多设备漫游时数据无缝同步，同时本地新增数据绝不丢失
 */
export function mergeProfileWithServer(
  local: PersonalizationProfileResponse | null,
  server: PersonalizationProfileResponse | null,
  userId?: string | null
): PersonalizationProfileResponse | null {
  if (!local) return server;
  if (!server) return local;

  // 如果服务端画像处于初始或重置状态（无启动时间且各项计数为0），不复活本地旧缓存
  if (server.startedAt === null && server.totalPlayCount === 0 && server.totalListenedMs === 0) {
    clearLocalStoredProfile(userId);
    return server;
  }

  // 综合两端总时长与播放数
  const totalListenedMs = Math.max(local.totalListenedMs || 0, server.totalListenedMs || 0);
  const totalPlayCount = Math.max(local.totalPlayCount || 0, server.totalPlayCount || 0);
  const trackCount = Math.max(local.trackCount || 0, server.trackCount || 0);
  const artistCount = Math.max(local.artistCount || 0, server.artistCount || 0);

  // 合并 Top Tracks
  const trackMap = new Map<string, (typeof local.topTracks)[number]>();
  for (const t of server.topTracks || []) {
    trackMap.set(`${t.provider}:${t.providerTrackId}`, { ...t });
  }
  for (const t of local.topTracks || []) {
    const key = `${t.provider}:${t.providerTrackId}`;
    const existing = trackMap.get(key);
    if (existing) {
      existing.listenedMs = Math.max(existing.listenedMs, t.listenedMs);
      existing.playCount = Math.max(existing.playCount, t.playCount);
    } else {
      trackMap.set(key, { ...t });
    }
  }
  const mergedTopTracks = Array.from(trackMap.values())
    .sort((a, b) => b.listenedMs - a.listenedMs)
    .slice(0, 30);

  // 合并 Top Artists
  const artistMap = new Map<string, (typeof local.topArtists)[number]>();
  for (const a of server.topArtists || []) {
    artistMap.set(a.name.toLowerCase(), { ...a });
  }
  for (const a of local.topArtists || []) {
    const key = a.name.toLowerCase();
    const existing = artistMap.get(key);
    if (existing) {
      existing.listenedMs = Math.max(existing.listenedMs, a.listenedMs);
      existing.playCount = Math.max(existing.playCount, a.playCount);
      existing.score = Math.max(existing.score, a.score);
    } else {
      artistMap.set(key, { ...a });
    }
  }
  const mergedTopArtists = Array.from(artistMap.values())
    .sort((a, b) => b.listenedMs - a.listenedMs)
    .slice(0, 20);

  const merged: PersonalizationProfileResponse = {
    version: server.version || local.version,
    startedAt: server.startedAt || local.startedAt,
    totalListenedMs,
    totalPlayCount,
    trackCount: Math.max(trackCount, mergedTopTracks.length),
    artistCount: Math.max(artistCount, mergedTopArtists.length),
    tasteGroups: server.tasteGroups?.length ? server.tasteGroups : local.tasteGroups || [],
    topTracks: mergedTopTracks,
    topArtists: mergedTopArtists,
    recentTracks: local.recentTracks?.length ? local.recentTracks : server.recentTracks || [],
    sourceDistribution: server.sourceDistribution?.length ? server.sourceDistribution : local.sourceDistribution || []
  };

  saveLocalStoredProfile(merged, userId);
  return merged;
}
