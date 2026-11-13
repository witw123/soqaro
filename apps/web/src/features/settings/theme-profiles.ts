import type { ResolvedTheme, ThemePreference } from "./settings-store";

export type ThemeIconPack =
  | "studio"
  | "botanical"
  | "noir"
  | "blueprint"
  | "editorial";

export interface ThemePreviewPalette {
  bg: string;
  card: string;
  stage: string;
  border: string;
  fg: string;
  muted: string;
  accent: string;
  accentSubtle: string;
  frameRadius: string;
  badgeRadius: string;
}

export interface ThemeProfile {
  id: ResolvedTheme;
  label: string;
  mode: "dark" | "light";
  metaThemeColor: string;
  iconPack: ThemeIconPack;
  preview: ThemePreviewPalette;
}

export const SYSTEM_THEME_LABEL = "跟随系统";

export const THEME_PROFILES: Record<ResolvedTheme, ThemeProfile> = {
  dark: {
    id: "dark",
    label: "深空灰",
    mode: "dark",
    metaThemeColor: "#111113",
    iconPack: "studio",
    preview: {
      bg: "#111113",
      card: "#18191b",
      stage: "#212225",
      border: "#363a3f",
      fg: "#ecedee",
      muted: "#9ba1a6",
      accent: "#0090ff",
      accentSubtle: "#13273c",
      frameRadius: "5px",
      badgeRadius: "3px"
    }
  },
  light: {
    id: "light",
    label: "日间白",
    mode: "light",
    metaThemeColor: "#fcfcfd",
    iconPack: "studio",
    preview: {
      bg: "#fcfcfd",
      card: "#f9f9fb",
      stage: "#f0f0f3",
      border: "#d9d9e0",
      fg: "#1c2024",
      muted: "#60646c",
      accent: "#0090ff",
      accentSubtle: "#e6f4fe",
      frameRadius: "5px",
      badgeRadius: "3px"
    }
  },
  "sage-dark": {
    id: "sage-dark",
    label: "灰绿深色",
    mode: "dark",
    metaThemeColor: "#0f1412",
    iconPack: "botanical",
    preview: {
      bg: "#0f1412",
      card: "#161c19",
      stage: "#1e2622",
      border: "#37453e",
      fg: "#eaf0ec",
      muted: "#a4b5ac",
      accent: "#29a383",
      accentSubtle: "#132d26",
      frameRadius: "6px",
      badgeRadius: "9999px"
    }
  },
  "sage-light": {
    id: "sage-light",
    label: "灰绿浅色",
    mode: "light",
    metaThemeColor: "#eff5f2",
    iconPack: "botanical",
    preview: {
      bg: "#eff5f2",
      card: "#f8fbf9",
      stage: "#e7efeb",
      border: "#c4d3cb",
      fg: "#17221d",
      muted: "#475950",
      accent: "#29a383",
      accentSubtle: "#dff3ec",
      frameRadius: "6px",
      badgeRadius: "9999px"
    }
  },
  obsidian: {
    id: "obsidian",
    label: "黑曜红",
    mode: "dark",
    metaThemeColor: "#070708",
    iconPack: "noir",
    preview: {
      bg: "#070708",
      card: "#0f0f12",
      stage: "#17171c",
      border: "#32323d",
      fg: "#fafafa",
      muted: "#a7a7b5",
      accent: "#e54666",
      accentSubtle: "#3a141e",
      frameRadius: "3px",
      badgeRadius: "2px"
    }
  },
  "midnight-dark": {
    id: "midnight-dark",
    label: "午夜深蓝",
    mode: "dark",
    metaThemeColor: "#08101d",
    iconPack: "blueprint",
    preview: {
      bg: "#08101d",
      card: "#0e182a",
      stage: "#14233b",
      border: "#2d4772",
      fg: "#ecf3fe",
      muted: "#9eb7dc",
      accent: "#00a2c7",
      accentSubtle: "#0d2a3a",
      frameRadius: "5px",
      badgeRadius: "3px"
    }
  },
  "midnight-light": {
    id: "midnight-light",
    label: "晴空浅蓝",
    mode: "light",
    metaThemeColor: "#eaf2fc",
    iconPack: "blueprint",
    preview: {
      bg: "#eaf2fc",
      card: "#f6f9fe",
      stage: "#e1ecfa",
      border: "#b6cde9",
      fg: "#0e1d34",
      muted: "#39547b",
      accent: "#3e63dd",
      accentSubtle: "#e5ecfd",
      frameRadius: "5px",
      badgeRadius: "3px"
    }
  },
  paper: {
    id: "paper",
    label: "暖白素笺",
    mode: "light",
    metaThemeColor: "#f5efe3",
    iconPack: "editorial",
    preview: {
      bg: "#f5efe3",
      card: "#fbf8f1",
      stage: "#ede5d6",
      border: "#cfc2ac",
      fg: "#221b14",
      muted: "#544739",
      accent: "#d95308",
      accentSubtle: "#ffebd6",
      frameRadius: "6px",
      badgeRadius: "3px"
    }
  }
};

export function getThemeProfile(theme: ResolvedTheme): ThemeProfile {
  return THEME_PROFILES[theme] ?? THEME_PROFILES.dark;
}

export function getThemeLabel(preference: ThemePreference): string {
  if (preference === "system") return SYSTEM_THEME_LABEL;
  return THEME_PROFILES[preference]?.label ?? THEME_PROFILES.dark.label;
}
