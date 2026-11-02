"use client";

import { useCallback, useEffect, useRef } from "react";
import type { PersonalizationTrackInput, ProviderTrackCandidate, TrackMeta } from "@soqaro/shared";
import { soqaroApi } from "@/lib/network/soqaro-api";
import { recordLocalListeningProgress } from "./local-personalization-store";

const heartbeatIntervalMs = 15_000;
const maxProgressDeltaMs = 60_000;
export const personalizationChangedEvent = "soqaro-personalization-changed";

type ListeningSession = {
  id: string;
  userId: string;
  track: PersonalizationTrackInput;
  occurredAt: string;
  lastProgressMs: number;
  listenedMs: number;
  lastReportedListenedMs: number;
  playCountRecorded: boolean;
  completed: boolean;
  completionReported: boolean;
  quickSkipReported: boolean;
};

type ProviderTrackTasteDetail = { tags: string[]; releaseTime: string | null };

const providerTagCache = new Map<string, ProviderTrackTasteDetail>();
const providerTagRequests = new Map<string, Promise<ProviderTrackTasteDetail>>();

export function usePersonalizationReporter(input: {
  userId: string | null;
  currentTrack: TrackMeta | null;
  isPlaying: boolean;
  progressMs: number;
}) {
  const sessionRef = useRef<ListeningSession | null>(null);
  const isPlayingRef = useRef(input.isPlaying);
  const flushRef = useRef<(settle: boolean) => Promise<void>>(() => Promise.resolve());
  const flush = useCallback(async (settle: boolean) => {
    const session = sessionRef.current;
    if (!session || session.listenedMs < 1_000) return;
    try {
      session.track = await enrichPersonalizationTrack(session.track);
      const incrementalDeltaMs = Math.max(0, session.listenedMs - session.lastReportedListenedMs);
      const isNewPlay = !session.playCountRecorded;
      session.lastReportedListenedMs = session.listenedMs;
      session.playCountRecorded = true;

      if (incrementalDeltaMs > 0 || isNewPlay) {
        try {
          recordLocalListeningProgress({
            userId: session.userId,
            track: session.track,
            deltaMs: incrementalDeltaMs,
            isNewPlay
          });
        } catch {
          // Local profile update should not block telemetry
        }
      }

      await soqaroApi.recordPersonalizationEvent({
        id: session.id,
        type: "playback",
        track: session.track,
        listenedMs: Math.round(session.listenedMs),
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
        occurredAt: session.occurredAt
      });
      if (session.completed && !session.completionReported) {
        session.completionReported = true;
        await soqaroApi.recordPersonalizationEvent({ id: `${session.id}:completion`, type: "completion", track: session.track, occurredAt: new Date().toISOString() });
      }
      if (settle && !session.completed && session.listenedMs < 30_000 && !session.quickSkipReported) {
        session.quickSkipReported = true;
        await soqaroApi.recordPersonalizationEvent({ id: `${session.id}:quick-skip`, type: "quick-skip", track: session.track, occurredAt: new Date().toISOString() });
      }
      window.dispatchEvent(new Event(personalizationChangedEvent));
    } catch {
      // Personalization telemetry must never interrupt playback.
    }
  }, []);
  flushRef.current = flush;

  useEffect(() => {
    const wasPlaying = isPlayingRef.current;
    isPlayingRef.current = input.isPlaying;
    const nextTrack = toPersonalizationTrack(input.currentTrack);
    const session = sessionRef.current;
    if (!input.userId || !nextTrack || !input.currentTrack) {
      if (session) void flush(false);
      sessionRef.current = null;
      return;
    }
    if (!session || session.userId !== input.userId || trackKey(session.track) !== trackKey(nextTrack)) {
      if (session) void flush(true);
      sessionRef.current = {
        id: createSessionId(),
        userId: input.userId,
        track: nextTrack,
        occurredAt: new Date().toISOString(),
        lastProgressMs: Math.max(0, input.progressMs),
        listenedMs: 0,
        lastReportedListenedMs: 0,
        playCountRecorded: false,
        completed: false,
        completionReported: false,
        quickSkipReported: false
      };
      return;
    }
    if (input.isPlaying) {
      const deltaMs = input.progressMs - session.lastProgressMs;
      if (deltaMs > 0 && deltaMs <= maxProgressDeltaMs) session.listenedMs += deltaMs;
    }
    session.lastProgressMs = Math.max(0, input.progressMs);
    session.completed ||= session.track.durationMs > 0 && session.listenedMs / session.track.durationMs >= 0.7;
    if (wasPlaying && !input.isPlaying) void flush(false);
  }, [flush, input.currentTrack, input.isPlaying, input.progressMs, input.userId]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (isPlayingRef.current) void flushRef.current(false);
    }, heartbeatIntervalMs);
    return () => { window.clearInterval(intervalId); void flushRef.current(false); };
  }, []);
}

export function recordPersonalizationFavorite(track: TrackMeta, isFavorite: boolean) {
  return recordFavoriteEvent(toPersonalizationTrack(track), isFavorite);
}

export function recordPersonalizationFavoriteCandidate(track: ProviderTrackCandidate, isFavorite: boolean) {
  return recordFavoriteEvent({ provider: track.provider, providerTrackId: track.providerTrackId, access: track.access, quality: track.quality, title: track.title.trim() || "未命名歌曲", artist: track.artist.trim() || "未知艺人", album: track.album?.trim() || null, providerAlbumId: track.providerAlbumId ?? null, providerTags: track.tags, releaseTime: track.releaseTime ?? null, durationMs: Math.max(0, Math.round(track.durationMs)), artworkUrl: /^https?:\/\//i.test(track.artworkUrl ?? "") ? track.artworkUrl : null }, isFavorite);
}

function recordFavoriteEvent(track: PersonalizationTrackInput | null, isFavorite: boolean) {
  if (!track) return Promise.resolve();
  return enrichPersonalizationTrack(track).then((enrichedTrack) => soqaroApi.recordPersonalizationEvent({ id: `${isFavorite ? "favorite" : "unfavorite"}:${trackKey(enrichedTrack)}:${createSessionId()}`, type: isFavorite ? "favorite" : "unfavorite", track: enrichedTrack, occurredAt: new Date().toISOString() })).then((result) => {
      window.dispatchEvent(new Event(personalizationChangedEvent));
      return result;
    });
}

export function toPersonalizationTrack(track: TrackMeta | null): PersonalizationTrackInput | null {
  if (!track) return null;
  const provider = track.sourceRef?.provider ?? track.sourceType;
  if (
    provider !== "local_upload" &&
    provider !== "netease" &&
    provider !== "qqmusic" &&
    provider !== "bilibili" &&
    provider !== "alist"
  ) {
    return null;
  }
  const providerTrackId = track.sourceRef?.trackId ?? track.fileHash ?? track.id;
  if (!providerTrackId) return null;
  return {
    provider,
    providerTrackId,
    access: "unknown",
    quality: null,
    title: track.title.trim() || "未命名歌曲",
    artist: track.artist.trim() || "未知艺人",
    album: track.album?.trim() || null,
    providerAlbumId: null,
    providerTags: track.providerTags,
    releaseTime: null,
    durationMs: Math.max(0, Math.round(track.durationMs)),
    artworkUrl: /^https?:\/\//i.test(track.artworkUrl ?? "") ? track.artworkUrl : null
  };
}

function trackKey(track: PersonalizationTrackInput) { return `${track.provider}:${track.providerTrackId}`; }
function createSessionId() { return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}:${Math.random().toString(36).slice(2)}`; }

async function enrichPersonalizationTrack(track: PersonalizationTrackInput) {
  if (
    track.provider === "local_upload" ||
    track.provider === "bilibili" ||
    track.provider === "alist" ||
    (track.providerTags?.length && track.releaseTime)
  ) {
    return track;
  }
  const key = trackKey(track);
  const cached = providerTagCache.get(key);
  if (cached) return { ...track, providerTags: cached.tags, releaseTime: cached.releaseTime };
  let request = providerTagRequests.get(key);
  if (!request) {
    request = (track.provider === "netease" ? soqaroApi.getNeteaseTrack(track.providerTrackId) : soqaroApi.getQqMusicTrack(track.providerTrackId))
      .then((candidate) => ({ tags: candidate.tags ?? [], releaseTime: candidate.releaseTime ?? null }))
      .catch((): ProviderTrackTasteDetail => ({ tags: [], releaseTime: null }))
      .then((detail) => {
        providerTagCache.set(key, detail);
        providerTagRequests.delete(key);
        return detail;
      });
    providerTagRequests.set(key, request);
  }
  const detail = await request;
  return { ...track, providerTags: detail.tags, releaseTime: detail.releaseTime };
}
