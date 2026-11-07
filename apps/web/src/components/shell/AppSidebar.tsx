"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type MouseEvent } from "react";
import type { Route } from "next";
import {
  Compass,
  Heart,
  Home,
  ListMusic,
  Music,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Sun,
  User
} from "lucide-react";
import { storeAwayRoomId } from "@/lib/domain/away-room";
import { runRoomViewTransition } from "@/lib/ui/room-view-transition";
import {
  applyAppTheme,
  appSettingsChangeEvent,
  getAppSettings,
  isCustomLayoutSidebarCollapsed,
  isDarkTheme,
  resolveAppTheme,
  updateAppSettings,
  type ThemePreference
} from "@/features/settings/settings-store";

export type AppNavItemId = "home" | "discover" | "playlists" | "profile" | "settings";

type AppSidebarProps = {
  activeItem?: AppNavItemId;
  hasBottomPlayer?: boolean;
  compactMobile?: boolean;
  roomId?: string | null;
  onAwayRoom?: () => void;
};

type NavItemConfig = {
  id: AppNavItemId;
  label: string;
  href: string;
  icon: IconName;
  group: "explore" | "library";
};

const navItems: NavItemConfig[] = [
  { id: "home", label: "房间大厅", href: "/app", icon: "home", group: "explore" },
  { id: "discover", label: "发现房间", href: "/app/discover", icon: "discover", group: "explore" },
  { id: "playlists", label: "我的歌单", href: "/app/playlists", icon: "playlist", group: "library" },
  { id: "profile", label: "个人主页", href: "/app/profile", icon: "profile", group: "library" }
];

type IconName =
  | "home"
  | "discover"
  | "search"
  | "playlist"
  | "favorite"
  | "profile"
  | "settings"
  | "sun"
  | "collapse"
  | "expand";

export function AppSidebar({
  activeItem,
  hasBottomPlayer = false,
  compactMobile = false,
  roomId = null,
  onAwayRoom
}: AppSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [pendingItemId, setPendingItemId] = useState<AppNavItemId | null>(null);
  const currentItem = pendingItemId ?? activeItem ?? resolveActiveItem(pathname);
  const [collapsed, setCollapsed] = useState(true);
  const [customLayoutEnabled, setCustomLayoutEnabled] = useState(false);
  const [themePreference, setThemePreference] = useState<ThemePreference>("dark");
  const desktopBottomOffsetClass = hasBottomPlayer
    ? "md:bottom-16 lg:bottom-16"
    : "md:bottom-0";

  const resolvedRoomId = roomId ?? (pathname.startsWith("/room/") ? pathname.split("/")[2] : null);

  const handleNavigateAway = (event: MouseEvent<HTMLAnchorElement>, targetHref: string) => {
    if (!resolvedRoomId) return;
    const isPlainLeftClick =
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey;
    const isRoomHostVisible =
      typeof document !== "undefined" &&
      Boolean(document.querySelector('[data-custom-layout-room-host="true"]'));

    if (!isPlainLeftClick || !isRoomHostVisible) {
      storeAwayRoomId(resolvedRoomId);
      return;
    }

    event.preventDefault();
    if (targetHref === "/app" && onAwayRoom) {
      onAwayRoom();
      return;
    }

    runRoomViewTransition(
      "room-exit",
      () => {
        storeAwayRoomId(resolvedRoomId);
        router.push(targetHref as Route);
      },
      { roomId: resolvedRoomId }
    );
  };

  useEffect(() => {
    setPendingItemId(null);
  }, [pathname]);

  useEffect(() => {
    let themeMediaQuery: MediaQueryList | null = null;
    const syncTheme = () => {
      const preference = getAppSettings().theme;
      setThemePreference(preference);
      applyAppTheme(preference);
    };
    const syncSidebarState = () => {
      const settings = getAppSettings();
      const nextCollapsed = isCustomLayoutSidebarCollapsed(settings, pathname);
      setCollapsed(nextCollapsed);
      setCustomLayoutEnabled(settings.layout.customLayout.enabled);
      setThemePreference(settings.theme);
      // Keep the shared content offset aligned with the persisted setting. The
      // sidebar can briefly coexist with another route's instance during a
      // client transition, so it must not publish its own initial state here.
      document.documentElement.dataset.sidebarCollapsed = String(nextCollapsed);
      document.documentElement.dataset.reduceMotion = String(settings.layout.reduceMotion);
      document.documentElement.dataset.fullMotion = String(settings.layout.fullMotion);
      applyAppTheme(settings.theme);
      themeMediaQuery?.removeEventListener("change", syncTheme);
      themeMediaQuery = null;
      if (settings.theme === "system" && typeof window.matchMedia === "function") {
        themeMediaQuery = window.matchMedia("(prefers-color-scheme: light)");
        themeMediaQuery.addEventListener("change", syncTheme);
      }
    };
    syncSidebarState();
    window.addEventListener(appSettingsChangeEvent, syncSidebarState);
    window.addEventListener("storage", syncSidebarState);
    return () => {
      window.removeEventListener(appSettingsChangeEvent, syncSidebarState);
      window.removeEventListener("storage", syncSidebarState);
      themeMediaQuery?.removeEventListener("change", syncTheme);
    };
  }, [pathname]);

  function handleThemeToggle() {
    const resolvedTheme = resolveAppTheme(themePreference);
    const isDark = isDarkTheme(resolvedTheme);
    let nextTheme: ThemePreference;
    if (isDark) {
      if (themePreference === "sage-dark") nextTheme = "sage-light";
      else if (themePreference === "midnight-dark") nextTheme = "midnight-light";
      else if (themePreference === "obsidian") nextTheme = "paper";
      else nextTheme = "light";
    } else {
      if (themePreference === "sage-light") nextTheme = "sage-dark";
      else if (themePreference === "midnight-light") nextTheme = "midnight-dark";
      else if (themePreference === "paper") nextTheme = "obsidian";
      else nextTheme = "dark";
    }
    startThemeTransition(nextTheme);
  }

  const isCurrentDark = isDarkTheme(resolveAppTheme(themePreference));
  const themeActionLabel = isCurrentDark ? "浅色模式" : "深色模式";
  const footerControlSizeClass = collapsed
    ? "h-10 w-10 shrink-0 rounded-lg px-0"
    : "w-full rounded-xl px-3 py-3 text-sm";

  return (
    <aside
      className={`app-sidebar relative z-40 mx-3 mb-3 overflow-hidden rounded-2xl border border-surface-border bg-background-secondary/95 pt-[env(safe-area-inset-top)] text-foreground shadow-2xl backdrop-blur-2xl md:flex md:flex-col md:fixed md:top-0 md:left-0 md:right-auto md:mx-0 md:mb-0 md:rounded-none md:border-b-0 md:border-l-0 md:border-t-0 md:border-r md:border-surface-border md:pt-0 ${desktopBottomOffsetClass}`}
      data-custom-layout-item="sidebar"
      aria-label="主导航"
    >
      <div className={`flex items-center gap-3 border-b border-surface-border md:flex-col md:items-stretch ${compactMobile ? "px-3 py-2.5" : "px-4 py-3"} md:px-2 md:py-3`}>
        <Link
          href="/app"
          className={`flex min-w-0 items-center gap-3 ${collapsed ? "md:justify-center" : ""}`}
          aria-label="返回首页"
          onClick={(event) => handleNavigateAway(event, "/app")}
        >
          <span className={`flex shrink-0 items-center justify-center rounded-xl bg-accent text-white shadow-sm ${compactMobile ? "h-8 w-8" : "h-9 w-9"} md:h-9 md:w-9`}>
            <Music size={18} strokeWidth={2} aria-hidden="true" />
          </span>
          <span className={`min-w-0 leading-none ${collapsed ? "md:hidden" : ""}`}>
            <span className="block truncate text-sm font-bold text-foreground tracking-tight">Soqaro</span>
            <span className="mt-1 block truncate text-xs text-foreground-muted">实时协作听歌空间</span>
          </span>
        </Link>
      </div>

      <div className={`hide-scrollbar flex min-h-0 flex-1 items-center overflow-hidden md:flex-col md:items-stretch md:gap-2.5 md:p-2 ${compactMobile ? "gap-2 p-1.5" : "gap-3 p-2.5"}`}>
        <nav className="hide-scrollbar flex min-w-0 flex-1 flex-wrap items-center gap-1 overflow-x-hidden md:min-h-0 md:flex-col md:items-stretch md:overflow-y-auto md:overflow-x-hidden" aria-label="工作区">
          {!collapsed && (
            <div className="hidden px-3 pt-2 pb-1 text-xs font-medium text-foreground-muted/70 select-none md:block">
              探索
            </div>
          )}
          {navItems
            .filter((item) => item.group === "explore")
            .map((item) => {
              const isActive = currentItem === item.id;
              return (
                <Link
                  key={item.id}
                  href={item.href as Route}
                  aria-current={isActive ? "page" : undefined}
                  onClick={(event) => handleNavigateAway(event, item.href)}
                  onPointerDown={() => setPendingItemId(item.id)}
                  title={collapsed ? item.label : undefined}
                  className={`app-sidebar__nav-item group relative flex min-h-10 min-w-0 flex-1 flex-col items-center justify-center rounded-xl font-medium transition-all duration-150 sm:flex-row sm:gap-2.5 sm:px-3 sm:py-2 sm:text-xs md:flex-none md:justify-start md:gap-3 md:px-3 md:py-2 md:text-sm ${compactMobile ? "gap-0.5 px-0.5 py-1.5 text-xs" : "gap-1 px-1 py-2 text-xs"} ${
                    isActive
                      ? "text-accent bg-accent/10 font-semibold"
                      : "text-foreground-muted hover:text-foreground hover:bg-surface"
                  } ${collapsed ? "md:justify-center md:px-2" : ""}`}
                >
                  <NavIcon name={item.icon} />
                  <span className={`truncate ${collapsed ? "md:hidden" : ""}`}>{item.label}</span>
                </Link>
              );
            })}

          {!collapsed && (
            <div className="hidden px-3 pt-3 pb-1 text-xs font-medium text-foreground-muted/70 select-none md:block">
              音乐空间
            </div>
          )}
          {navItems
            .filter((item) => item.group === "library")
            .map((item) => {
              const isActive = currentItem === item.id;
              return (
                <Link
                  key={item.id}
                  href={item.href as Route}
                  aria-current={isActive ? "page" : undefined}
                  onClick={(event) => handleNavigateAway(event, item.href)}
                  onPointerDown={() => setPendingItemId(item.id)}
                  title={collapsed ? item.label : undefined}
                  className={`app-sidebar__nav-item group relative flex min-h-10 min-w-0 flex-1 flex-col items-center justify-center rounded-xl font-medium transition-all duration-150 sm:flex-row sm:gap-2.5 sm:px-3 sm:py-2 sm:text-xs md:flex-none md:justify-start md:gap-3 md:px-3 md:py-2 md:text-sm ${compactMobile ? "gap-0.5 px-0.5 py-1.5 text-xs" : "gap-1 px-1 py-2 text-xs"} ${
                    isActive
                      ? "text-accent bg-accent/10 font-semibold"
                      : "text-foreground-muted hover:text-foreground hover:bg-surface"
                  } ${collapsed ? "md:justify-center md:px-2" : ""}`}
                >
                  <NavIcon name={item.icon} />
                  <span className={`truncate ${collapsed ? "md:hidden" : ""}`}>{item.label}</span>
                </Link>
              );
            })}
        </nav>

        <div className={`app-sidebar__footer hidden flex-col border-t border-surface-border md:flex ${collapsed ? "md:items-center md:gap-2 md:px-0 md:pb-1 md:pt-2.5" : "md:items-stretch md:gap-1 md:px-0 md:pb-1 md:pt-2.5"}`}>
          <Link
            href={"/app/settings" as Route}
            onClick={(event) => handleNavigateAway(event, "/app/settings")}
            className={`app-sidebar__footer-control group flex min-w-0 items-center justify-center gap-2.5 font-medium text-foreground-muted hover:text-foreground hover:bg-surface rounded-xl transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${footerControlSizeClass} ${collapsed ? "md:justify-center" : "md:justify-start"}`}
            title="设置与偏好"
          >
            <NavIcon name="settings" size={18} />
            <span className={collapsed ? "md:hidden" : "truncate"}>设置与偏好</span>
          </Link>
          <button
            aria-label={`切换到${themeActionLabel}`}
            className={`app-sidebar__footer-control app-sidebar__theme group flex min-w-0 items-center justify-center gap-2.5 font-medium text-foreground-muted hover:text-foreground hover:bg-surface rounded-xl transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${footerControlSizeClass}`}
            onClick={handleThemeToggle}
            title={themeActionLabel}
            type="button"
          >
            <NavIcon name="sun" size={18} />
            <span className={collapsed ? "md:hidden" : "truncate"}>{themeActionLabel}</span>
          </button>
          <button
            aria-label={collapsed ? "展开侧边栏" : "收纳侧边栏"}
            aria-expanded={!collapsed}
            className={`app-sidebar__footer-control group flex min-w-0 items-center justify-center gap-2.5 font-medium text-foreground-muted hover:text-foreground hover:bg-surface rounded-xl transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40 ${footerControlSizeClass} ${collapsed ? "md:justify-center" : "md:justify-start"}`}
            onClick={() => updateAppSettings({ layout: { sidebarCollapsed: !collapsed } })}
            disabled={customLayoutEnabled}
            title={collapsed ? "展开侧边栏" : "收纳侧边栏"}
            type="button"
          >
            <NavIcon name={collapsed ? "expand" : "collapse"} size={18} />
            <span className={collapsed ? "md:hidden" : "truncate"}>收起侧栏</span>
          </button>
        </div>
      </div>

    </aside>
  );
}

function startThemeTransition(nextTheme: ThemePreference) {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  const reduceMotion = root.dataset.reduceMotion === "true" || (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const toggle = document.querySelector<HTMLButtonElement>(".app-sidebar__theme");
  const toggleRect = toggle?.getBoundingClientRect();

  if (!reduceMotion) {
    const originX = toggleRect ? toggleRect.left + toggleRect.width / 2 : window.innerWidth / 2;
    const originY = toggleRect ? toggleRect.top + toggleRect.height / 2 : window.innerHeight / 2;
    root.style.setProperty("--theme-transition-x", `${originX}px`);
    root.style.setProperty("--theme-transition-y", `${originY}px`);
  }

  const viewTransitionDocument = document as Document & {
    startViewTransition?: (callback: () => void) => { finished: Promise<void> };
  };

  if (!reduceMotion && typeof viewTransitionDocument.startViewTransition === "function") {
    const transition = viewTransitionDocument.startViewTransition(() => {
      applyAppTheme(nextTheme);
      updateAppSettings({ theme: nextTheme });
    });
    void transition.finished.finally(() => clearThemeTransitionStyles(root));
    return;
  }

  if (!reduceMotion) root.classList.add("theme-transitioning");
  updateAppSettings({ theme: nextTheme });
  if (!reduceMotion) {
    window.setTimeout(() => clearThemeTransitionStyles(root), 360);
  }
}

function clearThemeTransitionStyles(root: HTMLElement) {
  root.classList.remove("theme-transitioning");
  root.style.removeProperty("--theme-transition-x");
  root.style.removeProperty("--theme-transition-y");
}

function resolveActiveItem(pathname: string | null): AppNavItemId | null {
  if (pathname?.startsWith("/app/settings")) {
    return "settings";
  }
  if (pathname?.startsWith("/app/discover")) {
    return "discover";
  }
  if (pathname?.startsWith("/app/search")) {
    return "discover";
  }
  if (pathname?.startsWith("/app/playlists")) {
    return "playlists";
  }
  if (pathname?.startsWith("/app/profile")) {
    return "profile";
  }
  if (pathname === "/app" || pathname === "/rooms" || (pathname?.startsWith("/room") ?? false)) {
    return "home";
  }
  return null;
}

function NavIcon({ name, size = 18 }: { name: IconName; size?: number }) {
  const props = { size, "aria-hidden": true as const, className: "shrink-0" };
  switch (name) {
    case "home":
      return <Home {...props} />;
    case "playlist":
      return <ListMusic {...props} />;
    case "search":
      return <Search {...props} />;
    case "discover":
      return <Compass {...props} />;
    case "profile":
      return <User {...props} />;
    case "favorite":
      return <Heart {...props} />;
    case "settings":
      return <Settings {...props} />;
    case "collapse":
      return <PanelLeftClose {...props} />;
    case "expand":
      return <PanelLeftOpen {...props} />;
    case "sun":
      return <Sun {...props} />;
    default:
      return <Music {...props} />;
  }
}






