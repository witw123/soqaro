const SAFE_DATA_IMAGE_URL_RE = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/i;
const UNSAFE_URL_CHARS_RE = /["'\\()<>`\s]/;

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve an internal app redirect target, blocking open-redirect tricks such as
 * protocol-relative URLs (`//evil.example`), backslashes (`/\evil`), or external origins.
 */
export function resolveSafeRedirectPath(
  raw: string | null | undefined,
  fallback: string
): string {
  if (!raw) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/\\") ||
    trimmed.includes("\\") ||
    hasControlChars(trimmed)
  ) {
    return fallback;
  }
  try {
    const parsed = new URL(trimmed, "https://soqaro.internal");
    if (parsed.origin !== "https://soqaro.internal" || !parsed.pathname.startsWith("/")) {
      return fallback;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

/**
 * Normalize and validate an artwork URL before rendering in `<img>` or CSS `url(...)`.
 * Allows same-origin relative paths, `https://` (upgrading `http://` and `//`), `blob:`,
 * and raster `data:image/...;base64,...` URLs while blocking `javascript:`, SVG data URLs,
 * and CSS breakout characters.
 */
export function sanitizeArtworkUrl(raw: string | null | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed || hasControlChars(trimmed) || UNSAFE_URL_CHARS_RE.test(trimmed)) {
    return undefined;
  }

  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }

  if (/^blob:/i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return parsed.protocol === "blob:" ? trimmed : undefined;
    } catch {
      return undefined;
    }
  }

  if (/^data:/i.test(trimmed)) {
    return SAFE_DATA_IMAGE_URL_RE.test(trimmed) ? trimmed : undefined;
  }

  const normalized = trimmed.startsWith("//")
    ? `https:${trimmed}`
    : trimmed.replace(/^http:\/\//i, "https://");

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:") {
      return undefined;
    }
    const serialized = parsed.toString();
    return hasControlChars(serialized) || UNSAFE_URL_CHARS_RE.test(serialized)
      ? undefined
      : serialized;
  } catch {
    return undefined;
  }
}

/** Format a validated artwork URL as a CSS `url("...")` value or `undefined`. */
export function toCssUrlValue(raw: string | null | undefined): string | undefined {
  const safeUrl = sanitizeArtworkUrl(raw);
  return safeUrl ? `url("${safeUrl}")` : undefined;
}
