import type { ILyricsTag, IPicture } from "music-metadata";

const maxArtworkDataUrlLength = 3_800;
const artworkSizes = [256, 192, 128, 96, 64] as const;
const artworkQualities = [0.8, 0.6, 0.4, 0.25] as const;

export type EmbeddedAudioMetadata = {
  title: string | null;
  artist: string | null;
  album: string | null;
  durationMs: number | null;
  bitrate: number | null;
  codec: string | null;
  artworkUrl: string | null;
  lyrics: string | null;
};

const emptyEmbeddedAudioMetadata: EmbeddedAudioMetadata = {
  title: null,
  artist: null,
  album: null,
  durationMs: null,
  bitrate: null,
  codec: null,
  artworkUrl: null,
  lyrics: null
};

const metadataCache = new WeakMap<Blob, Promise<EmbeddedAudioMetadata>>();

export async function readEmbeddedAudioMetadata(file: Blob): Promise<EmbeddedAudioMetadata> {
  const cached = metadataCache.get(file);
  if (cached) {
    return cached;
  }

  const task = (async (): Promise<EmbeddedAudioMetadata> => {
    try {
      const { parseBlob, selectCover } = await import("music-metadata");
      const metadata = await parseBlob(file, { duration: true, skipCovers: false });
      const cover = selectCover(metadata.common.picture);

      return {
        title: normalizeText(metadata.common.title),
        artist: normalizeText(metadata.common.artist)
          ?? normalizeText(metadata.common.artists?.join(" / ")),
        album: normalizeText(metadata.common.album),
        durationMs: toDurationMs(metadata.format.duration),
        bitrate: toBitrate(metadata.format.bitrate),
        codec: normalizeText(metadata.format.codec),
        artworkUrl: await pictureToDataUrl(cover),
        lyrics: readLyrics(metadata.common.lyrics)
      };
    } catch {
      return emptyEmbeddedAudioMetadata;
    }
  })();

  metadataCache.set(file, task);
  return task;
}

/** Prefer a cover embedded in a downloaded audio file over a remote URL. */
export async function resolveLocalArtworkUrl(
  file: Blob,
  fallbackArtworkUrl: string | null | undefined,
  downloadedArtwork?: Blob | null
) {
  const fallback = fallbackArtworkUrl?.trim() || null;
  if (!fallback) {
    return downloadedArtwork ? blobToDataUrl(downloadedArtwork) : null;
  }
  if (/^(?:data|blob):/i.test(fallback)) {
    return fallback;
  }

  const embedded = await readEmbeddedAudioMetadata(file);
  if (embedded.artworkUrl) return embedded.artworkUrl;
  if (downloadedArtwork) return blobToDataUrl(downloadedArtwork);
  return fallback;
}

export async function blobToDataUrl(file: Blob, maxBytes = 4 * 1024 * 1024) {
  if (file.size <= 0 || file.size > maxBytes || (file.type && !file.type.startsWith("image/"))) {
    return null;
  }
  if (typeof btoa !== "function") return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${file.type || "image/jpeg"};base64,${btoa(binary)}`;
}

function normalizeText(value: string | undefined) {
  const normalized = value?.trim();
  return normalized || null;
}

function toDurationMs(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1_000)
    : null;
}

function toBitrate(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 10_000_000
    ? Math.round(value)
    : null;
}

function readLyrics(tags: ILyricsTag[] | undefined) {
  const sections = (tags ?? [])
    .map((tag) => {
      const synchronized = (tag.syncText ?? [])
        .filter((line) => line.text.trim())
        .map((line) => `${formatLyricTimestamp(line.timestamp)}${line.text.trim()}`)
        .join("\n");
      return synchronized || tag.text?.trim() || "";
    })
    .filter(Boolean);

  return sections.length > 0 ? [...new Set(sections)].join("\n\n") : null;
}

function formatLyricTimestamp(timestamp: number | undefined) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0) {
    return "";
  }

  const totalMs = Math.round(timestamp);
  const minutes = Math.floor(totalMs / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1_000);
  const centiseconds = Math.floor((totalMs % 1_000) / 10);
  return `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}]`;
}

async function pictureToDataUrl(picture: IPicture | null) {
  if (!picture?.data?.length || typeof btoa !== "function") {
    return null;
  }

  const mimeType = normalizePictureMimeType(picture.format);
  const estimatedRawDataUrlLength =
    Math.ceil(picture.data.byteLength / 3) * 4 + mimeType.length + 13;
  if (estimatedRawDataUrlLength <= maxArtworkDataUrlLength) {
    const rawDataUrl = `data:${mimeType};base64,${bytesToBase64(picture.data)}`;
    if (rawDataUrl.length <= maxArtworkDataUrlLength) {
      return rawDataUrl;
    }
  }

  if (
    typeof document === "undefined" ||
    typeof Image === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return null;
  }

  const imageBuffer = new ArrayBuffer(picture.data.byteLength);
  new Uint8Array(imageBuffer).set(picture.data);
  const imageBlob = new Blob([imageBuffer], { type: mimeType });
  const imageUrl = URL.createObjectURL(imageBlob);
  try {
    const image = await loadImage(imageUrl);
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    if (!sourceWidth || !sourceHeight) {
      return null;
    }

    for (const size of artworkSizes) {
      const scale = Math.min(1, size / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) continue;

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      try {
        for (const quality of artworkQualities) {
          const dataUrl = canvas.toDataURL("image/jpeg", quality);
          if (dataUrl.length <= maxArtworkDataUrlLength) {
            return dataUrl;
          }
        }
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(imageUrl);
  }

  return null;
}

function normalizePictureMimeType(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  return normalized?.startsWith("image/") ? normalized : "image/jpeg";
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to decode embedded artwork."));
    image.src = url;
  });
}
