import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appSettingsStorageKey,
  applyUiScale,
  getDefaultAppSettings,
  getCustomLayoutItemIds,
  getDefaultCustomLayoutSettings,
  getCustomLayoutPageId,
  getAppSettings,
  isCustomLayoutSidebarCollapsed,
  normalizeSettings,
  resolveAppTheme,
  resetAppSettings,
  updateAppSettings
} from "./settings-store";

describe("app settings store", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a compact sidebar and stable playback defaults", () => {
    expect(normalizeSettings(null)).toMatchObject({
      theme: "dark",
      layout: { sidebarCollapsed: true },
      playback: {
        defaultVolume: 0.8,
        loudnessNormalization: false,
        playerStyle: "vinyl",
        disableArtworkColor: false,
        localPlaybackMode: "sequence",
        preventOfflineAutoLoad: false,
        streamingOnlyPlayback: false,
        fullyCachedPlayback: false
      }
    });
  });

  it("normalizes and resolves light, system and custom preset themes", () => {
    expect(normalizeSettings({ theme: "light" }).theme).toBe("light");
    expect(normalizeSettings({ theme: "system" }).theme).toBe("system");
    expect(normalizeSettings({ theme: "sage-dark" }).theme).toBe("sage-dark");
    expect(normalizeSettings({ theme: "obsidian" }).theme).toBe("obsidian");
    expect(normalizeSettings({ theme: "paper" }).theme).toBe("paper");
    expect(normalizeSettings({ theme: "unknown" }).theme).toBe("dark");
    expect(resolveAppTheme("dark", true)).toBe("dark");
    expect(resolveAppTheme("light", false)).toBe("light");
    expect(resolveAppTheme("sage-dark", false)).toBe("sage-dark");
    expect(resolveAppTheme("obsidian", true)).toBe("obsidian");
    expect(resolveAppTheme("system", true)).toBe("light");
    expect(resolveAppTheme("system", false)).toBe("dark");
  });

  it("normalizes the shared player style preference", () => {
    expect(normalizeSettings({ playback: { playerStyle: "square-cover" } }).playback.playerStyle).toBe("square-cover");
    expect(normalizeSettings({ playback: { playerStyle: "unknown" } }).playback.playerStyle).toBe("vinyl");
  });

  it("keeps streaming-only and fully cached playback mutually exclusive", () => {
    expect(normalizeSettings({
      playback: {
        streamingOnlyPlayback: true,
        fullyCachedPlayback: true
      }
    }).playback).toMatchObject({
      streamingOnlyPlayback: true,
      fullyCachedPlayback: false
    });

    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key)
      },
      dispatchEvent: vi.fn()
    });

    updateAppSettings({ playback: { streamingOnlyPlayback: true } });
    expect(getAppSettings().playback).toMatchObject({
      streamingOnlyPlayback: true,
      fullyCachedPlayback: false
    });

    updateAppSettings({ playback: { fullyCachedPlayback: true } });
    expect(getAppSettings().playback).toMatchObject({
      streamingOnlyPlayback: false,
      fullyCachedPlayback: true
    });

    updateAppSettings({ playback: { streamingOnlyPlayback: true } });
    expect(getAppSettings().playback).toMatchObject({
      streamingOnlyPlayback: true,
      fullyCachedPlayback: false
    });
  });

  it("keeps custom layout pages independent and bounded", () => {
    const first = getDefaultAppSettings();
    const second = getDefaultAppSettings();
    first.layout.customLayout.pages.home.content.x = 400;
    expect(second.layout.customLayout.pages.home.content.x).toBe(64);

    const normalized = normalizeSettings({
      layout: {
        customLayout: {
          enabled: true,
          pages: {
            discover: {
              content: { x: 9999, y: -20, width: 100, height: 9999, visible: true, locked: false }
            }
          }
        }
      }
    });
    expect(normalized.layout.customLayout.enabled).toBe(true);
    expect(normalized.layout.customLayout.pages.discover.content).toMatchObject({ x: 1080, y: 0, width: 360, height: 900 });
    expect(getCustomLayoutPageId("/app/settings")).toBe("settings");
    expect(getCustomLayoutPageId("/rooms")).toBe("home");
  });

  it("keeps custom sidebar geometry independent from the legacy collapse setting", () => {
    const expanded = normalizeSettings({
      layout: {
        sidebarCollapsed: true,
        customLayout: {
          enabled: true,
          pages: { home: { sidebar: { width: 240, height: 840 } } }
        }
      }
    });
    const collapsed = normalizeSettings({
      layout: {
        sidebarCollapsed: false,
        customLayout: {
          enabled: true,
          pages: { home: { sidebar: { width: 64, height: 840 } } }
        }
      }
    });

    expect(expanded.layout.customLayout.pages.home.sidebar.width).toBe(240);
    expect(collapsed.layout.customLayout.pages.home.sidebar.width).toBe(64);
    expect(isCustomLayoutSidebarCollapsed(expanded, "/app")).toBe(false);
    expect(isCustomLayoutSidebarCollapsed(collapsed, "/app")).toBe(true);
  });

  it("provides a separate room layout aligned with the desktop player", () => {
    const defaults = getDefaultCustomLayoutSettings();
    const room = defaults.pages.room;

    expect(getCustomLayoutItemIds("room")).toEqual([
      "sidebar",
      "room-stage",
      "room-panel",
      "mobile-navigation",
      "player"
    ]);
    expect(room.sidebar).toMatchObject({ x: 0, y: 0, width: 64, height: 828 });
    expect(room["room-stage"]).toMatchObject({ x: 64, y: 0, width: 792, height: 828, visible: true });
    expect(room["room-panel"]).toMatchObject({ x: 856, y: 0, width: 584, height: 828, visible: true });
    expect(room.player).toMatchObject({ x: 0, y: 828, width: 1440, height: 72 });
    expect(defaults.pages.home["room-stage"].visible).toBe(false);

    const migrated = normalizeSettings({
      layout: {
        customLayout: {
          pages: {
            home: { player: { x: 64, y: 840, width: 1376, height: 60 } },
            room: { player: { x: 64, y: 828, width: 1376, height: 72 } }
          }
        }
      }
    }).layout.customLayout.pages;
    expect(migrated.home.player).toMatchObject({ x: 0, width: 1440 });
    expect(migrated.room.player).toMatchObject({ x: 0, width: 1440 });
  });

  it("maps room routes to the room custom layout page", () => {
    expect(getCustomLayoutPageId("/room/demo")).toBe("room");
    expect(getCustomLayoutPageId("/room/demo/settings")).toBe("room");
  });

  it("persists normalized updates and can reset them", () => {
    const values = new Map<string, string>();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key)
      },
      dispatchEvent
    });

    updateAppSettings({
      layout: { sidebarCollapsed: false },
      playback: {
        defaultVolume: 2,
        preventOfflineAutoLoad: true,
        streamingOnlyPlayback: true
      }
    });
    expect(getAppSettings()).toMatchObject({
      layout: { sidebarCollapsed: false },
      playback: {
        defaultVolume: 1,
        disableArtworkColor: false,
        preventOfflineAutoLoad: true,
        streamingOnlyPlayback: true,
        fullyCachedPlayback: false
      }
    });
    expect(values.has(appSettingsStorageKey)).toBe(true);

    updateAppSettings({ layout: { fullMotion: true } });
    expect(getAppSettings().layout.fullMotion).toBe(true);

    resetAppSettings();
    expect(getAppSettings().layout.sidebarCollapsed).toBe(true);
    expect(getAppSettings().layout.fullMotion).toBe(false);
    expect(dispatchEvent).toHaveBeenCalled();
  });

  it("normalizes and updates the ui scale setting within bounds", () => {
    expect(normalizeSettings(null).layout.uiScale).toBe(1);
    expect(normalizeSettings({ layout: { uiScale: 1.25 } }).layout.uiScale).toBe(1.25);
    expect(normalizeSettings({ layout: { uiScale: 0.1 } }).layout.uiScale).toBe(0.5);
    expect(normalizeSettings({ layout: { uiScale: 10 } }).layout.uiScale).toBe(2);
    expect(normalizeSettings({ layout: { uiScale: "invalid" } }).layout.uiScale).toBe(1);

    const values = new Map<string, string>();
    const dispatchEvent = vi.fn();
    const styleMap = new Map<string, string>();
    const style = {
      zoom: "",
      setProperty: (k: string, v: string) => styleMap.set(k, v),
      getPropertyValue: (k: string) => styleMap.get(k) ?? "",
      removeProperty: (k: string) => {
        styleMap.delete(k);
        if (k === "zoom") style.zoom = "";
      }
    };
    const dataset: Record<string, string | undefined> = {};

    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key)
      },
      dispatchEvent,
      location: { pathname: "/app/settings", search: "" }
    });

    vi.stubGlobal("document", {
      documentElement: {
        dataset,
        style
      }
    });

    updateAppSettings({ layout: { uiScale: 1.1 } });
    expect(getAppSettings().layout.uiScale).toBe(1.1);
    expect(dataset.uiScale).toBeUndefined();
    expect(styleMap.get("--ui-scale")).toBeUndefined();

    resetAppSettings();
    expect(getAppSettings().layout.uiScale).toBe(1);
    expect(dataset.uiScale).toBeUndefined();
    expect(styleMap.get("--ui-scale")).toBeUndefined();

    // Test applyUiScale in web browser (cleans up any zoom styles)
    style.zoom = "1.25";
    styleMap.set("--ui-scale", "1.25");
    dataset.uiScale = "1.25";

    applyUiScale(1.25);
    expect(dataset.uiScale).toBeUndefined();
    expect(styleMap.get("--ui-scale")).toBeUndefined();
    expect(style.zoom).toBe("");
  });

  it("uses the native desktop zoom command when the Tauri bridge is available", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const style = {
      zoom: "",
      setProperty: vi.fn(),
      removeProperty: vi.fn()
    };
    vi.stubGlobal("window", {
      __TAURI__: { core: { invoke } },
      localStorage: { getItem: () => null },
      location: { pathname: "/app/settings", search: "" }
    });
    vi.stubGlobal("document", { documentElement: { dataset: {}, style } });

    applyUiScale(1.25);
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledWith("set_ui_zoom", { scale: 1.25 });
    expect(style.setProperty).toHaveBeenCalledWith("--ui-scale", "1.25");
    expect(style.zoom).toBe("");
  });
});
