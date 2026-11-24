import { HttpException, HttpStatus } from "@nestjs/common";
import type { ProviderSearchSuggestion } from "@soqaro/shared";
import { errorCodes } from "@soqaro/shared";

export type SongRecord = {
  id?: unknown;
  name?: unknown;
  fee?: unknown;
  duration?: unknown;
  dt?: unknown;
  artists?: unknown;
  ar?: unknown;
  album?: unknown;
  al?: unknown;
  h?: unknown;
  m?: unknown;
  l?: unknown;
  sq?: unknown;
  hr?: unknown;
  privilege?: unknown;
};

export type SearchTermCache = { expiresAt: number; items: ProviderSearchSuggestion[] };
export type QrAttempt = { userId: string; key: string };
export const qrTtlSeconds = 180;
export const qrKeyPrefix = "soqaro:netease:qr:";

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readString(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
    playlist.styles
  ];
  const tags = values
    .flatMap((value) => {
      if (Array.isArray(value)) {
        return value.map((item) => {
          const record = asRecord(item);
          return readString(record?.name ?? record?.tagName ?? record?.label ?? item);
        });
      }
      const record = asRecord(value);
      return [readString(record?.name ?? record?.tagName ?? record?.label ?? value)];
    })
    .filter((value): value is string => !!value);
  return [...new Set(tags)].slice(0, 20);
}

export function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function readLyricText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

export function readNeteaseTrackArray(...values: unknown[]): unknown[] {
  const queue = [...values];
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
    for (const key of ["songs", "songList", "songlist", "list", "data", "result"]) {
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

export function findCatalogArray(value: unknown, keys: string[]) {
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
  }
  return [] as unknown[];
}

export function readNeteaseArtworkUrl(...values: unknown[]) {
  for (const value of values) {
    const result = readString(value);
    if (!result) continue;
    const normalized = result.startsWith("//")
      ? `https:${result}`
      : result.replace(/^http:\/\//i, "https://");
    try {
      const url = new URL(normalized);
      if (url.protocol === "https:" && url.hostname) return url.toString();
    } catch {
      // Ignore malformed provider artwork URLs and try the next field.
    }
  }
  return null;
}

export function readArtistNames(value: unknown) {
  if (!Array.isArray(value)) return "未知歌手";
  const names = value
    .map((item) => readString(asRecord(item)?.name))
    .filter((item): item is string => !!item);
  return names.join(" / ") || "未知歌手";
}

export function resolveTrackAccess(song: SongRecord) {
  const privilege = asRecord(song.privilege);
  const fee = readNumber(song.fee) ?? readNumber(privilege?.fee);
  if (fee === 0 || fee === 8) return "free" as const;
  if (fee === 1) return "vip" as const;
  if (fee === 4) return "paid" as const;
  return "unknown" as const;
}

export function resolveTrackQuality(song: SongRecord) {
  if (hasAudioFile(song.hr)) return "hires" as const;
  if (hasAudioFile(song.sq)) return "lossless" as const;
  if (hasAudioFile(song.h) || (readNumber(asRecord(song.privilege)?.maxbr) ?? 0) >= 320_000) {
    return "exhigh" as const;
  }
  if (hasAudioFile(song.m)) return "high" as const;
  if (hasAudioFile(song.l)) return "standard" as const;
  return null;
}

export function hasAudioFile(value: unknown) {
  const record = asRecord(value);
  return !!record && (readNumber(record.br) ?? 0) > 0;
}

export function readAudioRecord(value: unknown) {
  const body = asRecord(value);
  const data = Array.isArray(body?.data) ? body.data : [];
  const item = asRecord(data[0]);
  const url = readString(item?.url);
  const freeTrialInfo = asRecord(item?.freeTrialInfo);
  return url
    ? {
        url,
        type: readString(item?.type),
        isTrial: freeTrialInfo !== null
      }
    : null;
}

export function resolveAudioMimeType(providerType: string | null, upstreamType: string | null) {
  const type = `${providerType ?? ""} ${upstreamType ?? ""}`.toLowerCase();
  if (type.includes("flac")) return "audio/flac";
  if (type.includes("mpeg") || type.includes("mp3")) return "audio/mpeg";
  return null;
}

export function isAllowedAudioHost(hostname: string) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "music.163.com" ||
    normalized.endsWith(".music.163.com") ||
    normalized.endsWith(".126.net") ||
    normalized.endsWith(".netease.com")
  );
}

/**
 * NetEase's player endpoint still returns HTTP CDN links. The CDN supports
 * HTTPS, which is required by the provider fetcher's SSRF-safe transport.
 */
export function normalizeNeteaseAudioUrl(value: string) {
  const url = new URL(value);
  if (url.protocol === "http:") {
    url.protocol = "https:";
    if (url.port === "80") {
      url.port = "";
    }
  }
  if (url.protocol !== "https:") {
    throw new Error("NetEase returned a non-HTTPS audio URL.");
  }
  return url;
}

export function isNeteaseUnavailableError(error: unknown) {
  if (!(error instanceof HttpException) || error.getStatus() !== HttpStatus.BAD_GATEWAY) {
    return false;
  }

  const response = error.getResponse();
  return (
    typeof response === "object" &&
    response !== null &&
    "code" in response &&
    response.code === errorCodes.neteaseUnavailable
  );
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
  return labels.slice(0, 10).map((label) => ({ provider: "netease" as const, label, hint }));
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
