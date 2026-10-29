"use client";

import type {
  GuestSession,
  NeteaseTrackCandidate,
  QqMusicTrackCandidate,
  RemoteTrackSourceRef,
  TrackSourceType,
  TrackLoudness
} from "@soqaro/shared";
import { createSHA256 } from "hash-wasm";
import type { PreparedAudioAssets } from "./audio-asset-builder";
import { readEmbeddedAudioMetadata } from "./audio-metadata";

type CapturedAudioGraph = {
  context: AudioContext | null;
  stream: MediaStream;
  mode: "native" | "audio-context";
};

const capturedAudioGraphs = new WeakMap<HTMLAudioElement, CapturedAudioGraph>();

export type UploadedTrack = {
  file?: File;
  objectUrl?: string;
  origin: "live-upload" | "netease-import" | "qqmusic-import" | "bilibili-import" | "alist-import";
};

export type CachedLibraryTrack = {
  fileHash: string;
  title: string;
  artist: string;
  album?: string | null;
  artworkUrl?: string | null;
  lyrics?: string | null;
  translatedLyrics?: string | null;
  romanizedLyrics?: string | null;
  provider?: "netease" | "qqmusic" | "bilibili" | "alist" | "local_upload";
  providerTrackId?: string | null;
  sourceDirectoryId?: string | null;
  sourceFileName?: string | null;
  mimeType: string;
  durationMs: number;
  sizeBytes: number;
  loudness?: TrackLoudness;
  cachedAt: string;
  sourceTrackIds: string[];
  sourceRoomIds: string[];
  lastSourceTrackId: string | null;
  lastSourceRoomId: string | null;
  lastOwnerNickname: string | null;
};

export type CachedLibraryTrackFile = CachedLibraryTrack & {
  file: File;
};

export type CapturedAudioStreamMode = CapturedAudioGraph["mode"];

export async function buildTrackMeta(
  file: File,
  objectUrl: string,
  session: GuestSession,
  preparedAssets?: PreparedAudioAssets,
  source?: {
    type: TrackSourceType;
    metadata?: Pick<
      NeteaseTrackCandidate | QqMusicTrackCandidate,
      "title" | "artist" | "album" | "artworkUrl" | "tags"
    >;
    sourceRef?: RemoteTrackSourceRef;
    loudness?: TrackLoudness;
  }
) {
  const fileHash = preparedAssets?.fileHash ?? await hashFile(file);
  // Provider downloads can also contain an embedded cover. Read it locally so
  // the player can sample a data URL without depending on remote CORS headers.
  const parsedEmbeddedMetadata = await readEmbeddedAudioMetadata(file);
  const embeddedMetadata = source?.type === undefined || source.type === "local_upload"
    ? parsedEmbeddedMetadata
    : null;
  const durationMs = preparedAssets?.playbackAsset.durationMs
    ?? embeddedMetadata?.durationMs
    ?? await readDuration(objectUrl);
  const title = truncateMetadataText(
    source?.metadata?.title
      ?? embeddedMetadata?.title
      ?? file.name.replace(/\.[^/.]+$/, "")
  ) ?? "未命名歌曲";
  const artist = truncateMetadataText(
    source?.metadata?.artist
      ?? embeddedMetadata?.artist
      ?? "本地上传"
  ) ?? "本地上传";
  const album = truncateMetadataText(source?.metadata?.album ?? embeddedMetadata?.album);
  const codec = truncateMetadataText(
    embeddedMetadata?.codec
      ?? file.type.split("/")[1]?.trim()
  );
  const sourceType = source?.type ?? "local_upload";

  return {
    title,
    artist,
    album,
    durationMs,
    bitrate: embeddedMetadata?.bitrate ?? null,
    sizeBytes: file.size,
    codec,
    mimeType: file.type || null,
    fileHash,
    artworkUrl: parsedEmbeddedMetadata.artworkUrl ?? source?.metadata?.artworkUrl ?? null,
    ...(source?.metadata?.tags?.length ? { providerTags: source.metadata.tags } : {}),
    lyrics: embeddedMetadata?.lyrics ?? null,
    ownerSessionId: session.userId,
    ownerNickname: session.nickname,
    sourceType,
    ...(source?.sourceRef ? { sourceRef: source.sourceRef } : {}),
    ...(preparedAssets?.loudness || source?.loudness
      ? { loudness: preparedAssets?.loudness ?? source?.loudness }
      : {}),
    ...(preparedAssets
      ? {
          originalAsset: preparedAssets.originalAsset,
          playbackAsset: preparedAssets.playbackAsset
        }
      : {})
  };
}

function truncateMetadataText(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 240) : null;
}

async function hashFile(file: File) {
  const hasher = await createSHA256();
  hasher.init();
  const chunkSize = 4 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const chunk = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer());
    hasher.update(chunk);
  }
  return hasher.digest("hex");
}

export function readDuration(objectUrl: string) {
  return new Promise<number>((resolve) => {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.src = objectUrl;

    const cleanup = () => {
      audio.onloadedmetadata = null;
      audio.ontimeupdate = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    };

    audio.onloadedmetadata = () => {
      if (audio.duration === Infinity) {
        audio.currentTime = 1e101;
        audio.ontimeupdate = () => {
          audio.ontimeupdate = null;
          const duration = audio.duration;
          cleanup();
          resolve(Number.isFinite(duration) ? Math.round(duration * 1000) : 0);
        };
      } else {
        const duration = audio.duration;
        cleanup();
        resolve(Number.isFinite(duration) ? Math.round(duration * 1000) : 0);
      }
    };

    audio.onerror = () => {
      cleanup();
      resolve(0);
    };

    audio.load();
  });
}

function disposeCapturedAudioGraph(graph: CapturedAudioGraph | undefined) {
  if (!graph) {
    return;
  }

  for (const track of graph.stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Ignore stale track shutdown errors.
    }
  }

  void graph.context?.close().catch(() => undefined);
}

export function captureAudioStream(
  audio: HTMLAudioElement,
  options?: { forceRefresh?: boolean; preferAudioContext?: boolean }
) {
  const cachedGraph = capturedAudioGraphs.get(audio);
  const shouldReuseCachedGraph =
    !!cachedGraph &&
    !options?.forceRefresh &&
    (!options?.preferAudioContext || cachedGraph.mode === "audio-context");

  if (shouldReuseCachedGraph && cachedGraph) {
    if (cachedGraph.context?.state === "suspended") {
      void cachedGraph.context.resume().catch(() => undefined);
    }

    return cachedGraph.stream;
  }

  if (options?.forceRefresh && cachedGraph) {
    if (cachedGraph.mode === "audio-context") {
      // Browsers only allow one MediaElementSourceNode per HTMLMediaElement.
      // Recreating the graph for the same audio element can throw
      // InvalidStateError and break host relay audio after a track switch.
      if (cachedGraph.context?.state === "suspended") {
        void cachedGraph.context.resume().catch(() => undefined);
      }
      return cachedGraph.stream;
    }

    disposeCapturedAudioGraph(cachedGraph);
    capturedAudioGraphs.delete(audio);
  }

  const mediaAudio = audio as HTMLAudioElement & {
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
  };

  if (!options?.preferAudioContext && typeof mediaAudio.captureStream === "function") {
    try {
      const stream = mediaAudio.captureStream();
      capturedAudioGraphs.set(audio, {
        context: null,
        stream,
        mode: "native"
      });
      return stream;
    } catch {
      // Some embedded webviews expose captureStream but still throw synchronously.
      // Fall through to alternate strategies instead of crashing the caller.
    }
  }

  if (!options?.preferAudioContext && typeof mediaAudio.mozCaptureStream === "function") {
    try {
      const stream = mediaAudio.mozCaptureStream();
      capturedAudioGraphs.set(audio, {
        context: null,
        stream,
        mode: "native"
      });
      return stream;
    } catch {
      // Fall through to the AudioContext path.
    }
  }

  if (typeof window !== "undefined") {
    const AudioContextCtor = window.AudioContext;
    if (AudioContextCtor) {
      let context: AudioContext | null = null;
      try {
        context = new AudioContextCtor();
        const source = context.createMediaElementSource(audio);
        const destination = context.createMediaStreamDestination();
        source.connect(destination);
        source.connect(context.destination);
        capturedAudioGraphs.set(audio, {
          context,
          stream: destination.stream,
          mode: "audio-context"
        });
        if (context.state === "suspended") {
          void context.resume().catch(() => undefined);
        }
        return destination.stream;
      } catch {
        void context?.close().catch(() => undefined);
      }
    }
  }

  return null;
}

export function getCapturedAudioStreamMode(audio: HTMLAudioElement) {
  return capturedAudioGraphs.get(audio)?.mode ?? null;
}
