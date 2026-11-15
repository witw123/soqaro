import type {
  BilibiliTrackCandidate,
  NeteaseTrackCandidate,
  Playlist,
  ProviderTrackCandidate,
  QqMusicTrackCandidate,
  TrackMeta
} from "@soqaro/shared";
import type { CachedLibraryTrack } from "@/features/library/audio-utils";
import { toCachedLibraryTrack } from "@/features/library/cache-library-files";
import type {
  CachedLibraryTrackSummaryRecord,
  LocalPlaylistTrackRecord
} from "@/features/library/indexeddb";
import { toCachedProviderTrack } from "@/features/playlist/local-playlist-mappers";

export type RoomPlaylistSource =
  | { type: "playlist"; provider: "netease" | "qqmusic"; playlistId: string }
  | { type: "album"; provider: "netease" | "qqmusic"; albumId: string }
  | { type: "bilibili"; bvid: string };

export type ResolvedPlaylistTrackEntry = {
  key: string;
  rawId: string;
  title: string;
  artist: string;
  album: string | null;
  durationMs: number;
  artworkUrl: string | null;
  providerTrack: ProviderTrackCandidate | null;
  cachedTrack: CachedLibraryTrack | null;
};

/** Resolve the remote playlist/album/video source encoded in a room playlist's tags. */
export function getRoomPlaylistSource(playlist: Pick<Playlist, "tags">): RoomPlaylistSource | null {
  const albumTag = playlist.tags?.find((tag) => tag.startsWith("album:"));
  if (albumTag) {
    const parts = albumTag.split(":");
    if (parts.length >= 3) {
      const provider = parts[1];
      const id = parts.slice(2).join(":");
      if (provider === "bilibili" && id) return { type: "bilibili", bvid: id };
      if ((provider === "netease" || provider === "qqmusic") && id) {
        return { type: "album", provider, albumId: id };
      }
    }
  }

  const networkTag = playlist.tags?.find((tag) => tag.startsWith("network:"));
  if (networkTag) {
    const [, provider, ...idParts] = networkTag.split(":");
    const id = idParts.join(":");
    if (provider === "bilibili" && id) return { type: "bilibili", bvid: id };
    if ((provider === "netease" || provider === "qqmusic") && id) {
      return { type: "playlist", provider, playlistId: id };
    }
  }

  const directTag = playlist.tags?.find(
    (tag) => tag.startsWith("netease:") || tag.startsWith("qqmusic:") || tag.startsWith("bilibili:")
  );
  if (directTag) {
    const [provider, ...idParts] = directTag.split(":");
    const id = idParts.join(":");
    if (provider === "bilibili" && id) return { type: "bilibili", bvid: id };
    if ((provider === "netease" || provider === "qqmusic") && id) {
      return { type: "playlist", provider, playlistId: id };
    }
  }

  return null;
}

/** Produce a stable primitive key for a resolved playlist source for React hook dependencies. */
export function getRoomPlaylistSourceKey(source: RoomPlaylistSource | null): string {
  if (!source) return "";
  if (source.type === "bilibili") return `bilibili:${source.bvid}`;
  if (source.type === "album") return `album:${source.provider}:${source.albumId}`;
  return `playlist:${source.provider}:${source.playlistId}`;
}

/** Extract the file hash from a `local:<fileHash>` playlist track entry. */
export function extractLocalFileHash(rawId: string): string | null {
  const trimmed = rawId.trim();
  if (!trimmed.startsWith("local:")) return null;
  const hash = trimmed.slice("local:".length).trim();
  return hash.length > 0 ? hash : null;
}

/** Parse a `provider:...`, `<provider>:<trackId>`, or bare `BV...` entry into a stub candidate. */
export function parsePlaylistProviderTrack(rawId: string): ProviderTrackCandidate | null {
  const trimmed = rawId.trim();
  if (!trimmed || trimmed.startsWith("local:")) return null;

  const cleanId = trimmed.startsWith("provider:") ? trimmed.slice("provider:".length) : trimmed;
  const parts = cleanId.split(":");
  const provider = parts[0];

  if (parts.length >= 2 && (provider === "netease" || provider === "qqmusic" || provider === "bilibili")) {
    const trackId = parts.slice(1).join(":").trim();
    if (!trackId) return null;

    if (provider === "netease") {
      if (!/^\d+$/.test(trackId)) return null;
      const candidate: NeteaseTrackCandidate = {
        provider: "netease",
        providerTrackId: trackId,
        access: "unknown",
        quality: null,
        title: `网络歌曲 ${trackId}`,
        artist: "网络音乐",
        album: null,
        durationMs: 0,
        artworkUrl: null
      };
      return candidate;
    }

    if (provider === "qqmusic") {
      const candidate: QqMusicTrackCandidate = {
        provider: "qqmusic",
        providerTrackId: trackId,
        access: "unknown",
        quality: null,
        title: `网络歌曲 ${trackId}`,
        artist: "网络音乐",
        album: null,
        durationMs: 0,
        artworkUrl: null
      };
      return candidate;
    }

    const bvid = parts[1];
    const cidPart = parts[2];
    const cid = cidPart && /^\d+$/.test(cidPart) ? Number(cidPart) : undefined;
    const candidate: BilibiliTrackCandidate = {
      provider: "bilibili",
      providerTrackId: trackId,
      bvid,
      ...(cid !== undefined ? { cid } : {}),
      access: "unknown",
      quality: null,
      title: `B站音频 ${trackId}`,
      artist: "哔哩哔哩",
      album: null,
      durationMs: 0,
      artworkUrl: null
    };
    return candidate;
  }

  if (/^BV[a-zA-Z0-9]+(?::\d+)?$/.test(cleanId)) {
    const [bvid, cidPart] = cleanId.split(":");
    const cid = cidPart && /^\d+$/.test(cidPart) ? Number(cidPart) : undefined;
    const candidate: BilibiliTrackCandidate = {
      provider: "bilibili",
      providerTrackId: cleanId,
      bvid,
      ...(cid !== undefined ? { cid } : {}),
      access: "unknown",
      quality: null,
      title: `B站音频 ${cleanId}`,
      artist: "哔哩哔哩",
      album: null,
      durationMs: 0,
      artworkUrl: null
    };
    return candidate;
  }

  return null;
}

/** Build the lookup set of all track keys currently imported into the room. */
export function buildRoomTrackKeySet(tracks: readonly TrackMeta[]): Set<string> {
  return new Set(
    tracks.flatMap((track) => {
      const keys = [track.id];
      if (track.fileHash) {
        keys.push(track.fileHash);
        keys.push(`local:${track.fileHash}`);
      }
      if (track.sourceRef) {
        keys.push(`${track.sourceRef.provider}:${track.sourceRef.trackId}`);
        keys.push(`provider:${track.sourceRef.provider}:${track.sourceRef.trackId}`);
        keys.push(track.sourceRef.trackId);
      }
      return keys;
    })
  );
}

/** Check whether a playlist entry key matches any track already in the room. */
export function isTrackInRoom(roomTrackKeySet: ReadonlySet<string>, candidateKey: string): boolean {
  if (roomTrackKeySet.has(candidateKey)) return true;

  if (candidateKey.startsWith("provider:")) {
    const withoutPrefix = candidateKey.slice("provider:".length);
    if (withoutPrefix && roomTrackKeySet.has(withoutPrefix)) return true;
  } else if (candidateKey.startsWith("local:")) {
    const fileHash = candidateKey.slice("local:".length);
    if (fileHash && roomTrackKeySet.has(fileHash)) return true;
  } else {
    if (roomTrackKeySet.has(`provider:${candidateKey}`)) return true;
    if (roomTrackKeySet.has(`local:${candidateKey}`)) return true;
  }

  return false;
}

/** Resolve fallback playlist entries from local IndexedDB records, cached track summaries, and raw IDs. */
export function buildFallbackPlaylistTracks(
  trackIds: readonly string[],
  localTracks: readonly LocalPlaylistTrackRecord[],
  cachedSummaries: readonly CachedLibraryTrackSummaryRecord[]
): ResolvedPlaylistTrackEntry[] {
  const localMap = new Map<string, LocalPlaylistTrackRecord>();
  for (const record of localTracks) {
    localMap.set(record.id, record);
    if (record.providerTrackId) {
      localMap.set(`${record.provider}:${record.providerTrackId}`, record);
      localMap.set(`provider:${record.provider}:${record.providerTrackId}`, record);
      localMap.set(record.providerTrackId, record);
    }
    if (record.fileHash) {
      localMap.set(record.fileHash, record);
      localMap.set(`local:${record.fileHash}`, record);
    }
  }

  const cachedMap = new Map<string, CachedLibraryTrackSummaryRecord>();
  for (const summary of cachedSummaries) {
    cachedMap.set(summary.fileHash, summary);
    cachedMap.set(`local:${summary.fileHash}`, summary);
    if (summary.provider && summary.providerTrackId) {
      cachedMap.set(`${summary.provider}:${summary.providerTrackId}`, summary);
      cachedMap.set(`provider:${summary.provider}:${summary.providerTrackId}`, summary);
    }
  }

  return trackIds.map((rawId, index) => {
    const trimmed = rawId.trim();
    const withoutProviderPrefix = trimmed.startsWith("provider:")
      ? trimmed.slice("provider:".length)
      : trimmed;
    const localHash = extractLocalFileHash(trimmed);

    const localMatch =
      localMap.get(trimmed) ??
      localMap.get(withoutProviderPrefix) ??
      (localHash ? localMap.get(localHash) : undefined);

    const cachedSummary =
      (localHash ? cachedMap.get(localHash) : undefined) ??
      (localMatch?.fileHash ? cachedMap.get(localMatch.fileHash) : undefined) ??
      cachedMap.get(trimmed) ??
      cachedMap.get(withoutProviderPrefix);

    const cachedTrack = cachedSummary ? toCachedLibraryTrack(cachedSummary) : null;

    if (localMatch) {
      const providerCandidate = toCachedProviderTrack(localMatch);
      if (providerCandidate) {
        return {
          key: `${providerCandidate.provider}:${providerCandidate.providerTrackId}`,
          rawId,
          title: providerCandidate.title,
          artist: providerCandidate.artist,
          album: providerCandidate.album ?? null,
          durationMs: providerCandidate.durationMs,
          artworkUrl: providerCandidate.artworkUrl ?? null,
          providerTrack: providerCandidate,
          cachedTrack
        };
      }
      if (cachedTrack) {
        return {
          key: `local:${cachedTrack.fileHash}`,
          rawId,
          title: localMatch.title || cachedTrack.title,
          artist: localMatch.artist || cachedTrack.artist,
          album: localMatch.album ?? cachedTrack.album ?? null,
          durationMs: localMatch.durationMs || cachedTrack.durationMs,
          artworkUrl: localMatch.artworkUrl ?? cachedTrack.artworkUrl ?? null,
          providerTrack: null,
          cachedTrack
        };
      }
    }

    if (cachedTrack) {
      return {
        key: `local:${cachedTrack.fileHash}`,
        rawId,
        title: cachedTrack.title,
        artist: cachedTrack.artist,
        album: cachedTrack.album ?? null,
        durationMs: cachedTrack.durationMs,
        artworkUrl: cachedTrack.artworkUrl ?? null,
        providerTrack: null,
        cachedTrack
      };
    }

    const parsedCandidate = parsePlaylistProviderTrack(trimmed);
    if (parsedCandidate) {
      return {
        key: `${parsedCandidate.provider}:${parsedCandidate.providerTrackId}`,
        rawId,
        title: parsedCandidate.title,
        artist: parsedCandidate.artist,
        album: parsedCandidate.album ?? null,
        durationMs: parsedCandidate.durationMs,
        artworkUrl: parsedCandidate.artworkUrl ?? null,
        providerTrack: parsedCandidate,
        cachedTrack: null
      };
    }

    return {
      key: rawId,
      rawId,
      title: `曲目 ${index + 1}`,
      artist: "未知艺术家",
      album: null,
      durationMs: 0,
      artworkUrl: null,
      providerTrack: null,
      cachedTrack: null
    };
  });
}
