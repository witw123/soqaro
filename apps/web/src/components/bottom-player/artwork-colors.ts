"use client";

import { sanitizeArtworkUrl } from "@/lib/domain/url-safety";

import { useEffect, useState } from "react";
import {
  appSettingsChangeEvent,
  getAppSettings,
  getDefaultAppSettings
} from "@/features/settings/settings-store";

type Rgb = {
  r: number;
  g: number;
  b: number;
};

export type ArtworkPalette = {
  background: string;
  surface: string;
  border: string;
  accent: string;
  accentSoft: string;
  accentGlow: string;
};

/** Convert one of the palette's rgb/rgba values to a canvas-safe rgba value. */
export function withAlpha(color: string, alpha: number) {
  const match = color.match(/rgba?\(([^)]+)\)/i);
  if (!match) return color;

  const channels = match[1].split(/[\s,]+/).filter(Boolean).slice(0, 3);
  if (channels.length !== 3) return color;

  const clampedAlpha = Math.max(0, Math.min(1, alpha));
  return `rgba(${channels.join(", ")}, ${clampedAlpha})`;
}

const baseColor: Rgb = { r: 5, g: 8, b: 13 };
const fallbackPalette: ArtworkPalette = {
  background: "#0a0b0e",
  surface: "#141518",
  border: "rgba(255, 255, 255, 0.12)",
  accent: "rgb(0 122 255)",
  accentSoft: "rgba(0, 122, 255, 0.16)",
  accentGlow: "rgba(0, 122, 255, 0.28)"
};

export function useArtworkPalette(artworkUrl: string | null | undefined) {
  const [palette, setPalette] = useState<ArtworkPalette>(fallbackPalette);
  const [artworkColorEnabled, setArtworkColorEnabled] = useState(
    () => !getDefaultAppSettings().playback.disableArtworkColor
  );

  useEffect(() => {
    const syncArtworkColorPreference = () => {
      setArtworkColorEnabled(!getAppSettings().playback.disableArtworkColor);
    };
    syncArtworkColorPreference();
    window.addEventListener(appSettingsChangeEvent, syncArtworkColorPreference);
    window.addEventListener("storage", syncArtworkColorPreference);
    return () => {
      window.removeEventListener(appSettingsChangeEvent, syncArtworkColorPreference);
      window.removeEventListener("storage", syncArtworkColorPreference);
    };
  }, []);

  useEffect(() => {
    if (!artworkColorEnabled || !artworkUrl || typeof window === "undefined") {
      setPalette(fallbackPalette);
      return;
    }

    let cancelled = false;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (!cancelled) setPalette(extractArtworkPalette(image));
    };
    image.onerror = () => {
      if (!cancelled) setPalette(fallbackPalette);
    };
    const sourceUrl = getArtworkSourceUrl(artworkUrl);
    // CORS mode is needed for remote pixel sampling, but local data/blob
    // artwork must stay in the browser's normal same-origin loading path.
    if (/^https?:\/\//i.test(sourceUrl)) {
      image.crossOrigin = "anonymous";
    }
    image.src = sourceUrl;

    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [artworkColorEnabled, artworkUrl]);

  return palette;
}

export function getArtworkSourceUrl(artworkUrl: string) {
  return sanitizeArtworkUrl(artworkUrl) ?? "";
}

function extractArtworkPalette(image: HTMLImageElement): ArtworkPalette {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return fallbackPalette;

  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const buckets = new Map<string, { color: Rgb; count: number; saturation: number }>();

    for (let index = 0; index < pixels.length; index += 16) {
      const alpha = pixels[index + 3];
      if (alpha < 160) continue;

      const color = {
        r: pixels[index],
        g: pixels[index + 1],
        b: pixels[index + 2]
      };
      const maximum = Math.max(color.r, color.g, color.b);
      const minimum = Math.min(color.r, color.g, color.b);
      if (maximum < 14 || (maximum > 242 && minimum > 232)) continue;

      const key = [
        Math.round(color.r / 24),
        Math.round(color.g / 24),
        Math.round(color.b / 24)
      ].join(":");
      const saturation = maximum === 0 ? 0 : (maximum - minimum) / maximum;
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.count += 1;
      } else {
        buckets.set(key, { color, count: 1, saturation });
      }
    }

    const colors = [...buckets.values()];
    if (colors.length === 0) return fallbackPalette;

    const dominant = colors.sort((left, right) => right.count - left.count)[0].color;
    const vivid = colors.sort(
      (left, right) => right.saturation * right.count - left.saturation * left.count
    )[0].color;
    const accent = liftAccent(vivid);
    const background = blend(baseColor, dominant, 0.36);
    const surface = blend(baseColor, dominant, 0.52);

    return {
      background: toRgb(background),
      surface: toRgba(surface, 0.94),
      border: toRgba(accent, 0.28),
      accent: toRgb(accent),
      accentSoft: toRgba(accent, 0.18),
      accentGlow: toRgba(accent, 0.62)
    };
  } catch {
    // Remote artwork without CORS permission cannot be sampled safely.
    return fallbackPalette;
  }
}

function blend(from: Rgb, to: Rgb, amount: number): Rgb {
  return {
    r: Math.round(from.r + (to.r - from.r) * amount),
    g: Math.round(from.g + (to.g - from.g) * amount),
    b: Math.round(from.b + (to.b - from.b) * amount)
  };
}

function liftAccent(color: Rgb): Rgb {
  const multiplier = Math.max(1, 150 / Math.max(color.r, color.g, color.b));
  return {
    r: Math.min(255, Math.round(color.r * multiplier)),
    g: Math.min(255, Math.round(color.g * multiplier)),
    b: Math.min(255, Math.round(color.b * multiplier))
  };
}

function toRgb(color: Rgb) {
  return `rgb(${color.r} ${color.g} ${color.b})`;
}

function toRgba(color: Rgb, alpha: number) {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}
