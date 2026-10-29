"use client";

import { useEffect, useState } from "react";
import type { TrackMeta } from "@soqaro/shared";
import {
  getCachedLibraryTrackSummary,
  getCachedLibraryTrackSummaryByProviderTrack
} from "@/features/library/local-audio-storage";

type ArtworkTrack = Pick<TrackMeta, "id" | "fileHash" | "artworkUrl" | "sourceRef"> | null;

export function isBrowserLocalArtworkUrl(value: string | null | undefined): value is string {
  return Boolean(value?.trim() && /^(?:data|blob):/i.test(value.trim()));
}

export function resolvePreferredArtworkUrl(
  localArtworkUrl: string | null | undefined,
  remoteArtworkUrl: string | null | undefined
) {
  const normalizedLocalArtworkUrl = localArtworkUrl?.trim() || null;
  if (isBrowserLocalArtworkUrl(normalizedLocalArtworkUrl)) {
    return normalizedLocalArtworkUrl;
  }
  const normalizedRemoteArtworkUrl = remoteArtworkUrl?.trim() || null;
  if (isBrowserLocalArtworkUrl(normalizedRemoteArtworkUrl)) {
    return normalizedRemoteArtworkUrl;
  }
  return normalizedRemoteArtworkUrl;
}

export function usePreferredArtworkUrl(track: ArtworkTrack) {
  const directArtworkUrl = isBrowserLocalArtworkUrl(track?.artworkUrl)
    ? track.artworkUrl.trim()
    : null;
  const trackId = track?.id ?? null;
  const fileHash = track?.fileHash ?? null;
  const provider = track?.sourceRef?.provider ?? null;
  const providerTrackId = track?.sourceRef?.trackId ?? null;
  const trackKey = `${trackId ?? ""}:${fileHash ?? ""}:${provider ?? ""}:${providerTrackId ?? ""}`;
  const [cachedArtwork, setCachedArtwork] = useState<{
    trackKey: string;
    artworkUrl: string | null;
  }>({ trackKey: "", artworkUrl: null });

  useEffect(() => {
    let cancelled = false;
    setCachedArtwork({ trackKey, artworkUrl: directArtworkUrl });

    if (!trackId) {
      return () => {
        cancelled = true;
      };
    }

    void Promise.all([
      fileHash
        ? getCachedLibraryTrackSummary(fileHash).catch(() => null)
        : Promise.resolve(null),
      provider && providerTrackId
        ? getCachedLibraryTrackSummaryByProviderTrack(provider, providerTrackId).catch(() => null)
        : Promise.resolve(null)
    ]).then((records) => {
      if (cancelled) return;
      const cachedArtworkUrl = records
        .map((record) => record?.artworkUrl)
        .find(isBrowserLocalArtworkUrl);
      if (cachedArtworkUrl) {
        setCachedArtwork({ trackKey, artworkUrl: cachedArtworkUrl.trim() });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [directArtworkUrl, fileHash, provider, providerTrackId, trackId, trackKey]);

  const localArtworkUrl = cachedArtwork.trackKey === trackKey
    ? cachedArtwork.artworkUrl
    : directArtworkUrl;
  return resolvePreferredArtworkUrl(localArtworkUrl, track?.artworkUrl);
}
