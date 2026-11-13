import type {
  ProviderAlbumSummary,
  ProviderArtistSummary,
  ProviderPlaylistSummary,
  ProviderSearchSuggestion,
  QqMusicTrackCandidate
} from "@soqaro/shared";

export const qrTtlSeconds = 180;
export const accountValidationTtlMs = 5 * 60_000;
export const qrKeyPrefix = "soqaro:qqmusic:qr:";

export type QrAttempt = { userId: string; qrsig: string; ptqrtoken: string };
export type SearchTermCache = { expiresAt: number; items: ProviderSearchSuggestion[] };

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readString(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : typeof value === "string" && value.trim()
      ? value.trim()
      : null;
}

export function readProviderTags(playlist: Record<string, unknown>) {
  const values = [
    playlist.tags,
    playlist.tag,
    playlist.category,
    playlist.categoryName,
    playlist.categories,
    playlist.genre,
    playlist.genres,
    playlist.style,
    playlist.styles,
    playlist.dissCate,
    playlist.disscate
  ];
  const tags = values.flatMap((value) => {
    if (Array.isArray(value)) {
      return value.map((item) => {
        const record = asRecord(item);
        return readString(record?.name ?? record?.tagName ?? record?.label ?? record?.catname ?? item);
      });
    }
    const record = asRecord(value);
    return [readString(record?.name ?? record?.tagName ?? record?.label ?? record?.catname ?? value)];
  }).filter((value): value is string => !!value);
  return [...new Set(tags)].slice(0, 20);
}

export function readQqTrackId(record: Record<string, unknown>) {
  const mid = readString(record.songmid ?? record.songMid ?? record.song_mid ?? record.mid);
  if (mid) return mid;
  const legacyId = readString(record.songId ?? record.songid ?? record.id);
  return legacyId && !/^\d+$/.test(legacyId) ? legacyId : null;
}

export function findFirstArray(value: unknown, keys: string[]) {
  const queue = [value];
  const visited = new Set<Record<string, unknown>>();
  while (queue.length > 0) {
    const record = asRecord(queue.shift());
    if (!record || visited.has(record)) continue;
    visited.add(record);
    for (const key of keys) {
      if (Array.isArray(record[key])) return record[key];
      const nested = asRecord(record[key]);
      if (nested) queue.push(nested);
    }
    for (const key of ["data", "result", "response"]) {
      const nested = asRecord(record[key]);
      if (nested) queue.push(nested);
    }
  }
  return [] as unknown[];
}

export function readTrackArray(value: unknown): unknown[] {
  const queue = [value];
  const visited = new Set<Record<string, unknown>>();
  let emptyList: unknown[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      if (current.length > 0) return current;
      emptyList = current;
      continue;
    }
    const record = asRecord(current);
    if (!record || visited.has(record)) continue;
    visited.add(record);
    for (const key of ["songlist", "songList", "songs", "list", "albumSonglist", "data", "result"]) {
      const nested = record[key];
      if (Array.isArray(nested)) {
        if (nested.length > 0) return nested;
        emptyList = nested;
        continue;
      }
      if (nested && typeof nested === "object") queue.push(nested);
    }
  }
  return emptyList;
}

export function readFirstRecord(value: unknown, keys: string[]): Record<string, unknown> | null {
  const queue = [value];
  const visited = new Set<Record<string, unknown>>();
  while (queue.length > 0) {
    const current = queue.shift();
    const record = asRecord(current);
    if (!record || visited.has(record)) continue;
    visited.add(record);
    for (const key of keys) {
      const candidate = record[key];
      if (Array.isArray(candidate)) {
        const item = candidate.map(asRecord).find((entry): entry is Record<string, unknown> => !!entry);
        if (item) return item;
      } else if (asRecord(candidate)) {
        const candidateRecord = asRecord(candidate);
        if (candidateRecord) {
          if (hasPlaylistIdentity(candidateRecord)) return candidateRecord;
          queue.push(candidateRecord);
        }
      }
    }
    for (const key of ["data", "result", "response"]) {
      const nested = asRecord(record[key]);
      if (nested) queue.push(nested);
    }
  }
  return null;
}

export function hasPlaylistIdentity(value: Record<string, unknown>) {
  return ["dissid", "disstid", "dissId", "dissID", "playlistId", "tid", "id", "dissname", "name", "title"]
    .some((key) => readString(value[key]) !== null);
}

export function readNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function dedupeAlbums(albums: ProviderAlbumSummary[]) {
  return [...new Map(albums.map((album) => [album.providerAlbumId, album])).values()];
}

export function readLyricText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * QQ 的 qrc 字段是 base64 编码的逐字歌词(与 NetEase YRC 同为
 * `[start,dur](start,dur,0)字` 行格式)。上游只对 lyric 字段解码,
 * qrc 需要在这里补一次 base64 解码;解码失败按缺失处理。
 */
export function readWordSyncedLyric(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const direct = readLyricText(value);
  if (direct?.includes("[")) return direct;
  try {
    const decoded = Buffer.from(value, "base64").toString("utf-8");
    return decoded.includes("[") && decoded.trim() ? decoded : null;
  } catch {
    return null;
  }
}

export function readHttpUrl(...values: unknown[]) {
  for (const value of values) {
    const result = readString(value);
    if (!result) continue;
    const normalized = result.startsWith("//") ? `https:${result}` : result.replace(/^http:/i, "https:");
    if (/^https:\/\//.test(normalized)) return normalized;
  }
  return null;
}

export function unwrapData(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  const data = asRecord(record.data);
  return data ?? record;
}

export function buildQqAlbumArtwork(albumMid: string) {
  return albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` : null;
}

export function readDuration(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? (n < 10_000 ? Math.round(n * 1_000) : Math.round(n)) : 0;
}

export function resolveMime(contentType: string | null, url: string) {
  const type = `${contentType ?? ""} ${url}`.toLowerCase();
  return type.includes("flac") ? "audio/flac" : type.includes("mp3") || type.includes("mpeg") ? "audio/mpeg" : null;
}

const SAFE_ARTWORK_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif"
]);

export function resolveArtworkMime(contentType: string | null) {
  const mimeType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mimeType && SAFE_ARTWORK_MIME_TYPES.has(mimeType) ? mimeType : null;
}

export function normalizeQqMusicArtworkUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("QQ Music artwork must use HTTPS.");
  if (url.port || url.username || url.password || !isAllowedHost(url.hostname)) {
    throw new Error("QQ Music returned an unsupported artwork URL.");
  }
  return url;
}

export function normalizeQqMusicAudioUrl(value: string) {
  const url = new URL(value);
  if (url.protocol === "http:") {
    url.protocol = "https:";
    if (url.port === "80") url.port = "";
  }
  if (url.protocol !== "https:") throw new Error("QQ Music returned a non-HTTPS audio URL.");
  return url;
}

export function isAllowedHost(host: string) {
  const h = host.toLowerCase();
  return h === "qq.com" || h.endsWith(".qq.com") || h === "gtimg.cn" || h.endsWith(".gtimg.cn");
}

export function readTermCache(cache: SearchTermCache | null | undefined, allowExpired = false) {
  if (!cache) return null;
  if (!allowExpired && cache.expiresAt <= Date.now()) return null;
  return cache.items;
}

export function trimTermCache(cache: Map<string, SearchTermCache>) {
  while (cache.size > 128) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== "string") return;
    cache.delete(oldest);
  }
}

export function toSearchSuggestions(labels: string[], hint: string): ProviderSearchSuggestion[] {
  return labels.slice(0, 10).map((label) => ({ provider: "qqmusic" as const, label, hint }));
}

export function readSearchTerms(value: unknown, preferredKeys: string[]) {
  const terms: string[] = [];
  const seenTerms = new Set<string>();
  const ignoredTerms = new Set(["专辑", "歌手", "单曲", "歌曲", "歌单", "用户", "mv", "热搜"]);
  const visited = new Set<object>();
  const visit = (current: unknown, depth: number) => {
    if (depth > 6 || terms.length >= 20) return;
    if (Array.isArray(current)) {
      current.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!current || typeof current !== "object") return;
    if (visited.has(current)) return;
    visited.add(current);
    const record = current as Record<string, unknown>;
    for (const key of preferredKeys) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim()) {
        const label = candidate.trim();
        const normalized = label.toLocaleLowerCase();
        if (ignoredTerms.has(normalized)) continue;
        if (!seenTerms.has(normalized)) {
          seenTerms.add(normalized);
          terms.push(label);
        }
      } else if (candidate && typeof candidate === "object") {
        visit(candidate, depth + 1);
      }
    }
    for (const [key, nested] of Object.entries(record)) {
      if (key === "code" || preferredKeys.includes(key)) continue;
      if (nested && typeof nested === "object") visit(nested, depth + 1);
    }
  };
  visit(value, 0);
  return terms;
}

export function toTrackCandidate(value: unknown): QqMusicTrackCandidate | null {
  const raw = asRecord(value);
  const r = asRecord(raw?.songInfo) ?? asRecord(raw?.songinfo) ?? asRecord(raw?.song) ?? raw;
  if (!r) return null;
  const id = readQqTrackId(r);
  const title = readString(r.songname ?? r.songName ?? r.name ?? r.title);
  if (!id || !title) return null;
  const singers = Array.isArray(r.singer)
    ? r.singer.map((s) => readString(asRecord(s)?.name)).filter(Boolean).join(" / ")
    : Array.isArray(r.singers)
      ? r.singers.map((s) => readString(asRecord(s)?.name)).filter(Boolean).join(" / ")
      : readString(r.singername ?? r.singerName ?? r.artist) ?? "未知歌手";
  const pay = asRecord(r.pay);
  const payPlay = Number(pay?.payplay ?? pay?.pay_play);
  const file = asRecord(r.file);
  const quality =
    Number(r.sizeflac ?? file?.size_flac) > 0
      ? "lossless"
      : Number(r.size320 ?? file?.size_320mp3) > 0
        ? "high"
        : Number(r.size128 ?? file?.size_128mp3) > 0
          ? "standard"
          : null;
  const album = asRecord(r.album);
  const albumMid = readString(
    r.albummid ?? r.albumMid ?? r.albumMID ?? album?.mid ?? album?.albummid ?? album?.albumMid ?? album?.albumMID
  );
  const artworkUrl =
    readHttpUrl(
      r.albumPic,
      r.album_pic,
      r.albumPicUrl,
      r.picUrl,
      r.picurl,
      r.imgUrl,
      r.imgurl,
      album?.albumPic,
      album?.album_pic,
      album?.picUrl,
      album?.picurl,
      album?.imgUrl,
      album?.imgurl
    ) ?? (albumMid ? buildQqAlbumArtwork(albumMid) : null);
  const relatedTrackId = readString(r.songid ?? r.songId ?? r.id);
  return {
    provider: "qqmusic",
    providerTrackId: id,
    ...(relatedTrackId ? { relatedTrackId } : {}),
    access: payPlay === 0 ? "free" : payPlay === 1 ? "paid" : "unknown",
    quality,
    title,
    artist: singers || "未知歌手",
    album: readString(r.albumname ?? r.albumName ?? album?.name),
    tags: readProviderTags(r),
    ...(albumMid ? { providerAlbumId: albumMid } : {}),
    releaseTime: readString(r.pubTime ?? r.publishTime ?? r.time_public ?? album?.pubTime ?? album?.publishTime),
    durationMs: readDuration(r.interval ?? r.duration),
    artworkUrl
  };
}

export function toPlaylistSummary(value: unknown): ProviderPlaylistSummary | null {
  const playlist = asRecord(value);
  const id = readString(
    playlist?.dissid ??
      playlist?.disstid ??
      playlist?.dissId ??
      playlist?.dissID ??
      playlist?.playlistId ??
      playlist?.topId ??
      playlist?.tid ??
      playlist?.id
  );
  if (!playlist || !id) return null;
  return {
    provider: "qqmusic",
    providerPlaylistId: id,
    title: readString(playlist.dissname ?? playlist.topTitle ?? playlist.name ?? playlist.title) ?? "未命名歌单",
    description: readString(playlist.desc ?? playlist.description ?? playlist.introduction ?? playlist.updateTime),
    tags: readProviderTags(playlist),
    artworkUrl: readHttpUrl(
      playlist.logo,
      playlist.dissCover,
      playlist.disscover,
      playlist.coverUrl,
      playlist.coverurl,
      playlist.coverImgUrl,
      playlist.coverimgurl,
      playlist.picUrl,
      playlist.picurl,
      playlist.imgUrl,
      playlist.imgurl,
      playlist.pic,
      playlist.cover
    ),
    creatorName: readString(playlist.nickname ?? playlist.creatorName ?? asRecord(playlist.creator)?.name),
    trackCount:
      readNumber(playlist.songnum ?? playlist.songNum ?? playlist.song_count ?? playlist.total) ??
      (Array.isArray(playlist.songlist) ? playlist.songlist.length : 0)
  };
}

export function toAlbumSummary(value: unknown): ProviderAlbumSummary | null {
  const album = asRecord(value);
  const id = readString(
    album?.albummid ??
      album?.albumMid ??
      album?.albumMID ??
      album?.album_mid ??
      album?.albumid ??
      album?.albumId ??
      album?.albumID ??
      album?.mid
  );
  const title = readString(album?.albumname ?? album?.albumName ?? album?.album_name ?? album?.name ?? album?.title);
  if (!album || !id || !title) return null;
  const singer = Array.isArray(album.singer)
    ? album.singer.map((item) => readString(asRecord(item)?.name)).filter(Boolean).join(" / ")
    : readString(album.singername ?? album.singerName ?? album.singer_name ?? album.artist);
  return {
    provider: "qqmusic",
    providerAlbumId: id,
    title,
    artist: singer || "未知歌手",
    description: readString(album.desc ?? album.description ?? album.intro),
    artworkUrl:
      readHttpUrl(
        album.albumPic,
        album.album_pic,
        album.albumPicUrl,
        album.picUrl,
        album.picurl,
        album.imgUrl,
        album.imgurl,
        album.coverUrl,
        album.coverImgUrl
      ) ?? buildQqAlbumArtwork(id),
    releaseTime: readString(album.pubtime ?? album.pubTime ?? album.publicTime ?? album.publishTime),
    trackCount: readNumber(album.songnum ?? album.songNum ?? album.song_count ?? album.total) ?? 0
  };
}

export function toArtistSummary(value: unknown): ProviderArtistSummary | null {
  const artist = asRecord(value);
  const id = readString(artist?.singermid ?? artist?.singerMid ?? artist?.mid ?? artist?.id);
  const name = readString(artist?.singername ?? artist?.singerName ?? artist?.name);
  if (!artist || !id || !name) return null;
  return {
    provider: "qqmusic",
    providerArtistId: id,
    name,
    artworkUrl: readHttpUrl(artist.pic, artist.picUrl, artist.singerPic, artist.avatar),
    description: readString(artist.desc ?? artist.description)
  };
}
