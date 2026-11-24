"use client";

/* eslint-disable @next/next/no-img-element */
import React, { useEffect, useState } from "react";
import type { Playlist } from "@soqaro/shared";
import type { LocalPlaylistRecord, LocalPlaylistTrackRecord } from "@/features/playlist/local-playlist";
import { toProviderTrackRecord } from "@/features/playlist/local-playlist";
import { soqaroApi } from "@/lib/network/soqaro-api";

export type NetworkPlaylistSource = { provider: "netease" | "qqmusic" | "bilibili"; playlistId: string };

export function Artwork({
  artworkUrl,
  artworkUrls,
  title,
  size = "sm"
}: {
  artworkUrl?: string | null;
  artworkUrls?: readonly (string | null | undefined)[];
  title: string;
  size?: "sm" | "lg" | "row" | "cover";
}) {
  const sizeClass =
    size === "cover"
      ? "aspect-square w-full rounded-none"
      : size === "lg"
        ? "h-24 w-24 rounded-xl"
        : size === "row"
          ? "h-16 w-16 rounded-lg"
          : "h-10 w-10 rounded-xl";
  const sources = uniqueArtworkUrls([...(artworkUrls ?? []), artworkUrl]);
  const sourceKey = sources.join("\u001f");
  const [failedSourceIndex, setFailedSourceIndex] = useState(0);

  useEffect(() => {
    setFailedSourceIndex(0);
  }, [sourceKey]);

  const activeArtworkUrl = sources[failedSourceIndex] ?? null;

  return (
    <div
      aria-label={`${title} 封面`}
      className={`${sizeClass} flex shrink-0 items-center justify-center overflow-hidden border border-surface-border bg-surface text-lg font-bold text-foreground-muted`}
    >
      {activeArtworkUrl ? (
        <img loading="lazy"
          alt=""
          className="h-full w-full object-cover"
          decoding="async"
          draggable={false}
          onError={() => setFailedSourceIndex((current) => current + 1)}
          src={activeArtworkUrl}
        />
      ) : (
        title.slice(0, 1).toUpperCase()
      )}
    </div>
  );
}

export function getTrackArtworkUrls(tracks: readonly Pick<LocalPlaylistTrackRecord, "artworkUrl">[]) {
  return uniqueArtworkUrls(tracks.map((track) => track.artworkUrl));
}

export function getPlaylistArtworkCandidates(
  playlist: Playlist,
  roomTrackIndex: ReadonlyMap<string, LocalPlaylistTrackRecord>,
  localTracks: readonly LocalPlaylistTrackRecord[] = []
) {
  const localTrackIndex = new Map(localTracks.map((track) => [track.id, track]));
  return uniqueArtworkUrls([
    playlist.coverUrl,
    ...playlist.trackIds.flatMap((trackId) => [
      roomTrackIndex.get(trackId)?.artworkUrl,
      localTrackIndex.get(trackId)?.artworkUrl
    ])
  ]);
}

export function uniqueArtworkUrls(urls: readonly (string | null | undefined)[]) {
  const result: string[] = [];
  for (const value of urls) {
    if (typeof value !== "string") continue;
    const url = value.trim();
    if (!url) continue;
    const secureUrl = url.replace(/^http:\/\//i, "https://");
    if (!result.includes(secureUrl)) result.push(secureUrl);
    if (secureUrl !== url && !result.includes(url)) result.push(url);
  }
  return result;
}

export function getNetworkPlaylistSource(playlist: Playlist): NetworkPlaylistSource | null {
  const sourceTag = playlist.tags.find((tag) => tag.startsWith("network:"));
  if (!sourceTag) return null;
  const [, provider, ...playlistIdParts] = sourceTag.split(":");
  if (provider !== "netease" && provider !== "qqmusic" && provider !== "bilibili") return null;
  const playlistId = playlistIdParts.join(":").trim();
  return playlistId ? { provider, playlistId } : null;
}

export function tracksForLocalPlaylist(
  playlist: LocalPlaylistRecord,
  tracks: LocalPlaylistTrackRecord[]
) {
  const trackMap = new Map(tracks.map((track) => [track.id, track]));
  return playlist.trackIds
    .map((trackId) => trackMap.get(trackId))
    .filter((track): track is LocalPlaylistTrackRecord => Boolean(track));
}

export async function resolveProviderArtwork(
  track: LocalPlaylistTrackRecord,
  provider: "netease" | "qqmusic"
) {
  if (track.artworkUrl || !track.providerTrackId) return track;
  try {
    const providerTrack =
      provider === "netease"
        ? await soqaroApi.getNeteaseTrack(track.providerTrackId)
        : await soqaroApi.getQqMusicTrack(track.providerTrackId);
    return toProviderTrackRecord(providerTrack, track);
  } catch {
    return track;
  }
}
