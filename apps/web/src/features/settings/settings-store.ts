import type { PlaybackMode } from "@soqaro/shared";
import { create } from "zustand";
import { invokeTauri, isTauriRuntime } from "@/lib/desktop/tauri";
import { EQUALIZER_PRESETS, type EqualizerPresetId } from "../playback/audio-equalizer";

export const appSettingsStorageKey = "soqaro-settings-v1";
export const appSettingsChangeEvent = "soqaro-settings-change";

export type ThemePreference =
  | "system"
  | "dark"
  | "light"
  | "sage-dark"
  | "sage-light"
  | "obsidian"
  | "midnight-dark"
  | "midnight-light"
  | "paper";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export const themePreferences: ThemePreference[] = [
  "system",
  "dark",
  "light",
  "sage-dark",
  "sage-light",
  "obsidian",
  "midnight-dark",
  "midnight-light",
  "paper"
];

export function isDarkTheme(theme: ResolvedTheme): boolean {
  return (
    theme === "dark" ||
    theme === "sage-dark" ||
    theme === "obsidian" ||
    theme === "midnight-dark"
  );
}
export type PlayerStyle = "vinyl" | "square-cover";
export type AudioQualityPreference = "standard" | "high" | "exhigh" | "lossless" | "hires";
export type CustomLayoutPageId = "home" | "discover" | "playlists" | "favorites" | "profile" | "settings" | "room";
export type CustomLayoutItemId = "sidebar" | "content" | "player" | "mobile-navigation" | "room-stage" | "room-panel";

export type CustomLayoutItem = {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  locked: boolean;
};

export type CustomLayoutPage = Record<CustomLayoutItemId, CustomLayoutItem>;

export type CustomLayoutSettings = {
  enabled: boolean;
  pages: Record<CustomLayoutPageId, CustomLayoutPage>;
};

export const customLayoutCanvas = {
  width: 1440,
  height: 900
} as const;

export const customLayoutPageIds: CustomLayoutPageId[] = [
  "home",
  "discover",
  "playlists",
  "favorites",
  "profile",
  "settings",
  "room"
];

export const customLayoutPageLabels: Record<CustomLayoutPageId, string> = {
  home: "首页",
  discover: "发现",
  playlists: "歌单",
  favorites: "收藏",
  profile: "我的",
  settings: "设置",
  room: "房间"
};

export const customLayoutItemLabels: Record<CustomLayoutItemId, string> = {
  sidebar: "侧边栏",
  content: "主内容",
  player: "底部播放器",
  "mobile-navigation": "移动端导航",
  "room-stage": "播放舞台",
  "room-panel": "房间管理面板"
};

export const customLayoutWorkspaceItemIds: CustomLayoutItemId[] = [
  "sidebar",
  "content",
  "mobile-navigation",
  "player"
];

export const customLayoutRoomItemIds: CustomLayoutItemId[] = [
  "sidebar",
  "room-stage",
  "room-panel",
  "mobile-navigation",
  "player"
];

export const customLayoutItemMinimumSizes: Record<CustomLayoutItemId, { width: number; height: number }> = {
  sidebar: { width: 48, height: 180 },
  content: { width: 360, height: 300 },
  player: { width: 360, height: 56 },
  "mobile-navigation": { width: 480, height: 48 },
  "room-stage": { width: 360, height: 300 },
  "room-panel": { width: 360, height: 300 }
};

export type AppSettings = {
  version: 1;
  theme: ThemePreference;
  layout: {
    sidebarCollapsed: boolean;
    reduceMotion: boolean;
    fullMotion: boolean;
    uiScale: number;
    customLayout: CustomLayoutSettings;
  };
  playback: {
    defaultVolume: number;
    loudnessNormalization: boolean;
    playerStyle: PlayerStyle;
    preferredAudioQuality: AudioQualityPreference;
    disableArtworkColor: boolean;
    localPlaybackMode: PlaybackMode;
    preventOfflineAutoLoad: boolean;
    streamingOnlyPlayback: boolean;
    fullyCachedPlayback: boolean;
    showLyricTranslation: boolean;
    showLyricRomanized: boolean;
    desktopLyricScale: number;
    trackChangeNotification: boolean;
    roomQueueNotification: boolean;
    roomLibraryNotification: boolean;
    roomChatNotification: boolean;
    roomPresenceNotification: boolean;
    onlyNotifyInBackground: boolean;
    enableFallbackSources: boolean;
    crossfadeDurationMs: number;
    equalizerEnabled: boolean;
    equalizerPreset: EqualizerPresetId;
    equalizerGains: [number, number, number, number, number];
  };
};

const defaultSettings: AppSettings = {
  version: 1,
  theme: "dark",
  layout: {
    sidebarCollapsed: true,
    reduceMotion: false,
    fullMotion: false,
    uiScale: 1,
    customLayout: getDefaultCustomLayoutSettings()
  },
  playback: {
    defaultVolume: 0.8,
    loudnessNormalization: false,
    playerStyle: "vinyl",
    preferredAudioQuality: "exhigh",
    disableArtworkColor: false,
    localPlaybackMode: "sequence",
    preventOfflineAutoLoad: false,
    streamingOnlyPlayback: false,
    fullyCachedPlayback: false,
    showLyricTranslation: true,
    showLyricRomanized: false,
    desktopLyricScale: 1,
    trackChangeNotification: true,
    roomQueueNotification: true,
    roomLibraryNotification: true,
    roomChatNotification: true,
    roomPresenceNotification: true,
    onlyNotifyInBackground: true,
    enableFallbackSources: true,
    crossfadeDurationMs: 800,
    equalizerEnabled: false,
    equalizerPreset: "flat",
    equalizerGains: [0, 0, 0, 0, 0]
  }
};

export function getDefaultAppSettings() {
  return cloneSettings(defaultSettings);
}

export function getAppSettings(): AppSettings {
  if (typeof window === "undefined") return cloneSettings(defaultSettings);

  try {
    const raw = window.localStorage.getItem(appSettingsStorageKey);
    if (!raw) return cloneSettings(defaultSettings);
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return cloneSettings(defaultSettings);
  }
}

export interface AppSettingsStoreState {
  settings: AppSettings;
  updateSettings: (patch: Parameters<typeof updateAppSettings>[0]) => AppSettings;
  resetSettings: () => AppSettings;
}

export const useAppSettingsStore = create<AppSettingsStoreState>((set) => ({
  settings: getAppSettings(),
  updateSettings: (patch) => {
    const next = updateAppSettings(patch);
    set({ settings: next });
    return next;
  },
  resetSettings: () => {
    const next = resetAppSettings();
    set({ settings: next });
    return next;
  }
}));

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (!event.key || event.key === appSettingsStorageKey) {
      useAppSettingsStore.setState({ settings: getAppSettings() });
    }
  });
}

export function useAppSettings<T = AppSettings>(selector?: (state: AppSettings) => T): T {
  return useAppSettingsStore((s) => (selector ? selector(s.settings) : (s.settings as unknown as T)));
}

export function updateAppSettings(
  patch: Partial<{
    theme: ThemePreference;
    layout: Partial<AppSettings["layout"]>;
    playback: Partial<AppSettings["playback"]>;
  }>
) {
  const current = getAppSettings();
  const mergedPlayback = { ...current.playback, ...patch.playback };
  if (patch.playback?.fullyCachedPlayback === true && patch.playback.streamingOnlyPlayback === undefined) {
    mergedPlayback.streamingOnlyPlayback = false;
  } else if (patch.playback?.streamingOnlyPlayback === true && patch.playback.fullyCachedPlayback === undefined) {
    mergedPlayback.fullyCachedPlayback = false;
  }
  const next = normalizeSettings({
    ...current,
    ...patch,
    layout: { ...current.layout, ...patch.layout },
    playback: mergedPlayback
  });
  if (typeof window !== "undefined") {
    window.localStorage.setItem(appSettingsStorageKey, JSON.stringify(next));
    if (typeof document !== "undefined") {
      document.documentElement.dataset.reduceMotion = String(next.layout.reduceMotion);
      document.documentElement.dataset.fullMotion = String(next.layout.fullMotion);
      applyUiScale(next.layout.uiScale);
    }
    useAppSettingsStore.setState({ settings: next });
    window.dispatchEvent(new Event(appSettingsChangeEvent));
  }
  return next;
}

export function resetAppSettings() {
  const defaults = cloneSettings(defaultSettings);
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(appSettingsStorageKey);
    if (typeof document !== "undefined") {
      document.documentElement.dataset.reduceMotion = String(defaultSettings.layout.reduceMotion);
      document.documentElement.dataset.fullMotion = String(defaultSettings.layout.fullMotion);
      applyUiScale(defaultSettings.layout.uiScale);
    }
    useAppSettingsStore.setState({ settings: defaults });
    window.dispatchEvent(new Event(appSettingsChangeEvent));
  }
  return defaults;
}

export function normalizeSettings(value: unknown): AppSettings {
  const input = isRecord(value) ? value : {};
  const layout = isRecord(input.layout) ? input.layout : {};
  const playback = isRecord(input.playback) ? input.playback : {};
  const volume = typeof playback.defaultVolume === "number" && Number.isFinite(playback.defaultVolume)
    ? Math.min(1, Math.max(0, playback.defaultVolume))
    : defaultSettings.playback.defaultVolume;
  const playbackMode = playback.localPlaybackMode === "shuffle" || playback.localPlaybackMode === "single"
    ? playback.localPlaybackMode
    : "sequence";
  const playerStyle: PlayerStyle = playback.playerStyle === "square-cover" ? "square-cover" : "vinyl";
  const streamingOnlyPlayback = playback.streamingOnlyPlayback === true;
  const fullyCachedPlayback = !streamingOnlyPlayback && playback.fullyCachedPlayback === true;
  const desktopLyricScale = typeof playback.desktopLyricScale === "number" && Number.isFinite(playback.desktopLyricScale)
    ? Math.min(2.5, Math.max(0.5, playback.desktopLyricScale))
    : defaultSettings.playback.desktopLyricScale;
  const uiScale = typeof layout.uiScale === "number" && Number.isFinite(layout.uiScale)
    ? Math.round(Math.min(2, Math.max(0.5, layout.uiScale)) * 100) / 100
    : defaultSettings.layout.uiScale;
  const quality = playback.preferredAudioQuality;
  const preferredAudioQuality: AudioQualityPreference =
    quality === "standard" || quality === "high" || quality === "lossless" || quality === "hires"
      ? quality
      : "exhigh";

  const rawTheme = input.theme;
  const theme: ThemePreference = typeof rawTheme === "string" && (themePreferences as string[]).includes(rawTheme)
    ? (rawTheme as ThemePreference)
    : "dark";

  return {
    version: 1,
    theme,
    layout: {
      sidebarCollapsed: layout.sidebarCollapsed !== false,
      reduceMotion: layout.reduceMotion === true,
      fullMotion: layout.fullMotion === true,
      uiScale,
      customLayout: normalizeCustomLayoutSettings(layout.customLayout)
    },
    playback: {
      defaultVolume: volume,
      loudnessNormalization: playback.loudnessNormalization === true,
      playerStyle,
      preferredAudioQuality,
      disableArtworkColor: playback.disableArtworkColor === true,
      localPlaybackMode: playbackMode,
      preventOfflineAutoLoad: playback.preventOfflineAutoLoad === true,
      streamingOnlyPlayback,
      fullyCachedPlayback,
      showLyricTranslation: playback.showLyricTranslation !== false,
      showLyricRomanized: playback.showLyricRomanized === true,
      desktopLyricScale,
      trackChangeNotification: playback.trackChangeNotification !== false,
      roomQueueNotification: playback.roomQueueNotification !== false,
      roomLibraryNotification: playback.roomLibraryNotification !== false,
      roomChatNotification: playback.roomChatNotification !== false,
      roomPresenceNotification: playback.roomPresenceNotification !== false,
      onlyNotifyInBackground: playback.onlyNotifyInBackground !== false,
      enableFallbackSources: playback.enableFallbackSources !== false,
      crossfadeDurationMs: typeof playback.crossfadeDurationMs === "number" && Number.isFinite(playback.crossfadeDurationMs)
        ? Math.min(3000, Math.max(0, playback.crossfadeDurationMs))
        : defaultSettings.playback.crossfadeDurationMs,
      equalizerEnabled: playback.equalizerEnabled === true,
      equalizerPreset: (typeof playback.equalizerPreset === "string" && playback.equalizerPreset in EQUALIZER_PRESETS ? playback.equalizerPreset : defaultSettings.playback.equalizerPreset) as EqualizerPresetId,
      equalizerGains: Array.isArray(playback.equalizerGains) && playback.equalizerGains.length === 5 && playback.equalizerGains.every((g) => typeof g === "number" && Number.isFinite(g))
        ? [
            Math.max(-12, Math.min(12, playback.equalizerGains[0])),
            Math.max(-12, Math.min(12, playback.equalizerGains[1])),
            Math.max(-12, Math.min(12, playback.equalizerGains[2])),
            Math.max(-12, Math.min(12, playback.equalizerGains[3])),
            Math.max(-12, Math.min(12, playback.equalizerGains[4]))
          ]
        : [...defaultSettings.playback.equalizerGains]
    }
  };
}

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    version: settings.version,
    theme: settings.theme,
    layout: {
      sidebarCollapsed: settings.layout.sidebarCollapsed,
      reduceMotion: settings.layout.reduceMotion,
      fullMotion: settings.layout.fullMotion,
      uiScale: settings.layout.uiScale,
      customLayout: cloneCustomLayoutSettings(settings.layout.customLayout)
    },
    playback: {
      ...settings.playback,
      equalizerGains: [...settings.playback.equalizerGains]
    }
  };
}

function cloneCustomLayoutSettings(settings: CustomLayoutSettings): CustomLayoutSettings {
  return {
    enabled: settings.enabled,
    pages: Object.fromEntries(
      customLayoutPageIds.map((pageId) => [
        pageId,
        Object.fromEntries(
          (Object.entries(settings.pages[pageId]) as Array<[CustomLayoutItemId, CustomLayoutItem]>).map(([itemId, item]) => [
            itemId,
            { ...item }
          ])
        ) as CustomLayoutPage
      ])
    ) as Record<CustomLayoutPageId, CustomLayoutPage>
  };
}

export function getDefaultCustomLayoutSettings(): CustomLayoutSettings {
  const pages = Object.fromEntries(
    customLayoutPageIds.map((pageId) => [pageId, createDefaultCustomLayoutPage(pageId)])
  ) as Record<CustomLayoutPageId, CustomLayoutPage>;
  return { enabled: false, pages };
}

export function normalizeCustomLayoutSettings(value: unknown): CustomLayoutSettings {
  const input = isRecord(value) ? value : {};
  const pagesInput = isRecord(input.pages) ? input.pages : {};
  const defaults = getDefaultCustomLayoutSettings();
  const pages = Object.fromEntries(
    customLayoutPageIds.map((pageId) => {
      const pageInput = isRecord(pagesInput[pageId]) ? pagesInput[pageId] : {};
      const defaultPage = defaults.pages[pageId];
      const page = Object.fromEntries(
        (Object.keys(defaultPage) as CustomLayoutItemId[]).map((itemId) => [
          itemId,
          migrateLegacyDefaultLayoutItem(
            normalizeCustomLayoutItem(pageInput[itemId], defaultPage[itemId], itemId),
            pageInput[itemId],
            pageId,
            itemId
          )
        ])
      ) as CustomLayoutPage;
      return [pageId, page];
    })
  ) as Record<CustomLayoutPageId, CustomLayoutPage>;

  return {
    enabled: input.enabled === true,
    pages
  };
}

export function getCustomLayoutPageId(pathname: string | null): CustomLayoutPageId {
  if (pathname?.startsWith("/room/")) return "room";
  if (pathname?.startsWith("/app/discover")) return "discover";
  if (pathname?.startsWith("/app/playlists")) return "playlists";
  if (pathname?.startsWith("/app/favorites")) return "favorites";
  if (pathname?.startsWith("/app/profile")) return "profile";
  if (pathname?.startsWith("/app/settings")) return "settings";
  return "home";
}

export function isCustomLayoutSidebarCollapsed(settings: AppSettings, pathname: string | null) {
  if (!settings.layout.customLayout.enabled) {
    return settings.layout.sidebarCollapsed;
  }

  const pageId = getCustomLayoutPageId(pathname);
  const sidebar = settings.layout.customLayout.pages[pageId].sidebar;
  return !sidebar.visible || sidebar.width < 160;
}

export function getCustomLayoutItemIds(pageId: CustomLayoutPageId): CustomLayoutItemId[] {
  return pageId === "room" ? customLayoutRoomItemIds : customLayoutWorkspaceItemIds;
}

function createDefaultCustomLayoutPage(pageId: CustomLayoutPageId): CustomLayoutPage {
  const isRoom = pageId === "room";
  const roomContentHeight = customLayoutCanvas.height - 72;
  return {
    sidebar: { x: 0, y: 0, width: 64, height: isRoom ? roomContentHeight : 840, visible: true, locked: false },
    content: { x: 64, y: 0, width: 1376, height: 840, visible: !isRoom, locked: false },
    player: { x: 0, y: isRoom ? roomContentHeight : 840, width: customLayoutCanvas.width, height: isRoom ? 72 : 60, visible: true, locked: false },
    "mobile-navigation": { x: 0, y: 840, width: 1440, height: 60, visible: true, locked: true },
    "room-stage": { x: 64, y: 0, width: 792, height: roomContentHeight, visible: isRoom, locked: false },
    "room-panel": { x: 856, y: 0, width: 584, height: roomContentHeight, visible: isRoom, locked: false }
  };
}

function normalizeCustomLayoutItem(value: unknown, fallback: CustomLayoutItem, itemId: CustomLayoutItemId): CustomLayoutItem {
  const input = isRecord(value) ? value : {};
  const minimum = customLayoutItemMinimumSizes[itemId];
  const width = normalizeLayoutNumber(input.width, fallback.width, minimum.width, customLayoutCanvas.width);
  const height = normalizeLayoutNumber(input.height, fallback.height, minimum.height, customLayoutCanvas.height);
  return {
    x: normalizeLayoutNumber(input.x, fallback.x, 0, customLayoutCanvas.width - width),
    y: normalizeLayoutNumber(input.y, fallback.y, 0, customLayoutCanvas.height - height),
    width,
    height,
    visible: input.visible !== false,
    locked: input.locked === true
  };
}

function migrateLegacyDefaultLayoutItem(
  item: CustomLayoutItem,
  rawValue: unknown,
  pageId: CustomLayoutPageId,
  itemId: CustomLayoutItemId
) {
  if (itemId !== "player" || !isRecord(rawValue)) return item;
  const legacyHeight = pageId === "room" ? 72 : 60;
  const legacyY = pageId === "room" ? customLayoutCanvas.height - legacyHeight : 840;
  const isLegacyDefault = rawValue.x === 64
    && rawValue.y === legacyY
    && rawValue.width === 1376
    && rawValue.height === legacyHeight;
  return isLegacyDefault
    ? { ...item, x: 0, width: customLayoutCanvas.width }
    : item;
}

function normalizeLayoutNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.round(Math.min(maximum, Math.max(minimum, numeric)));
}

export function resolveAppTheme(preference: ThemePreference, prefersLight?: boolean): ResolvedTheme {
  if (preference === "system") {
    const systemPrefersLight = prefersLight ?? (
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: light)").matches
        : false
    );
    return systemPrefersLight ? "light" : "dark";
  }
  return preference;
}

export function applyAppTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveAppTheme(preference);
  if (typeof document !== "undefined") {
    const isDark = isDarkTheme(resolved);
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themeMode = isDark ? "dark" : "light";
    document.documentElement.style.colorScheme = isDark ? "dark" : "light";

    const metaThemeColors: Record<ResolvedTheme, string> = {
      dark: "#0d0f12",
      light: "#f6f7f8",
      "sage-dark": "#141716",
      "sage-light": "#f2f5f3",
      obsidian: "#090a0c",
      "midnight-dark": "#0a0f18",
      "midnight-light": "#eef3f9",
      paper: "#f5f2eb"
    };
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", metaThemeColors[resolved] ?? "#0d0f12");
  }
  return resolved;
}

export function applyUiScale(scale: number): number {
  if (typeof document !== "undefined") {
    if (typeof window !== "undefined") {
      const pathname = window.location?.pathname;
      const search = window.location?.search;
      const isLyricsWindow =
        pathname === "/desktop-lyrics" ||
        (typeof search === "string" && search.includes("window=desktop-lyrics"));
      if (isLyricsWindow) {
        return scale;
      }
    }
    const normalized = Math.min(2, Math.max(0.5, scale));
    const isDefault = Math.abs(normalized - 1) < 0.001;
    if (typeof window !== "undefined" && isTauriRuntime()) {
      void invokeTauri("set_ui_zoom", { scale: isDefault ? 1 : normalized });
      document.documentElement.style.removeProperty("font-size");
      document.documentElement.style.removeProperty("zoom");
      if (isDefault) {
        document.documentElement.style.removeProperty("--ui-scale");
        delete document.documentElement.dataset.uiScale;
      } else {
        document.documentElement.style.setProperty("--ui-scale", String(normalized));
        document.documentElement.dataset.uiScale = String(normalized);
      }
      return normalized;
    }
    // Web browsers use native browser zoom (Ctrl +/-); clean up any CSS zoom artifacts
    document.documentElement.style.removeProperty("font-size");
    document.documentElement.style.removeProperty("zoom");
    document.documentElement.style.removeProperty("--ui-scale");
    delete document.documentElement.dataset.uiScale;
  }
  return scale;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
