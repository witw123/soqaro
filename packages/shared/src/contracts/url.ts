import { z } from "zod";

const SAFE_RELATIVE_PATH_PATTERN = /^\/(?![/\\])[^\s\u0000-\u001f\u007f]+$/;
const SAFE_RASTER_DATA_IMAGE_PATTERN =
  /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/]+={0,2}$/i;

export function isSafeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function isSafeArtworkUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (isSafeHttpUrl(trimmed)) {
    return true;
  }
  if (SAFE_RELATIVE_PATH_PATTERN.test(trimmed)) {
    return true;
  }
  return SAFE_RASTER_DATA_IMAGE_PATTERN.test(trimmed);
}

export function safeHttpUrlSchema(maxLength = 4096) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .refine(isSafeHttpUrl, "URL must use http:// or https://.");
}

export function safeArtworkUrlSchema(maxLength = 4096) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .refine(
      isSafeArtworkUrl,
      "Artwork URL must use http(s), a relative path, or a raster data:image URI."
    );
}
