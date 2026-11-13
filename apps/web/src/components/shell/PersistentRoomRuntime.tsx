"use client";

import { useEffect, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { LocalPlayerProvider } from "@/features/playback/local-player-context";
import { awayRoomChangeEvent, readAwayRoomId } from "@/lib/domain/away-room";
import { DesktopLyricsProvider } from "@/features/playback/desktop-lyrics-context";
import { ShellBackButton } from "./ShellBackButton";
import { applyUiScale, appSettingsChangeEvent, getAppSettings } from "@/features/settings/settings-store";

import { isCapacitorRuntime } from "@/lib/desktop/tauri";
import { requestNotificationPermission } from "@/features/playback/system-notifications";
import { useAppUpdate } from "@/features/update/use-app-update";
import { UpdatePromptDialog } from "@/components/update/UpdatePromptDialog";
import { AppPersistentPlayer } from "@/components/bottom-player/AppPersistentPlayer";
import { resolvePlaybackOwnership } from "@/features/playback/playback-ownership";
import { useSessionIdentity } from "@/features/session/use-session-identity";
import { WorkspaceQueryProvider } from "@/features/workspace/workspace-query-provider";
import { AppRouteShell } from "./AppRouteShell";
import { StorageRootGate } from "./StorageRootGate";

// 房间运行时(实时引擎/P2P/音频编码)体量很大且只在进房后渲染,
// 动态加载让落地页/发现页/登录页等无需首屏下载这 ~1MB 的运行时。
const SoqaroApp = dynamic(
  () => import("@/components/soqaro-app").then((mod) => mod.SoqaroApp),
  { ssr: false }
);

const DesktopLyricsOverlay = dynamic(
  () => import("@/components/desktop-lyrics").then((mod) => mod.DesktopLyricsOverlay),
  { ssr: false }
);

export function PersistentRoomRuntime({ children }: { children: ReactNode }) {
  return <StorageRootGate><RoomRuntime>{children}</RoomRuntime></StorageRootGate>;
}

function RoomRuntime({ children }: { children: ReactNode }) {
  const [hasMounted, setHasMounted] = useState(false);
  const pathname = usePathname();
  const isLyricsWindow =
    pathname === "/desktop-lyrics" ||
    (typeof window !== "undefined" && window.location.search.includes("window=desktop-lyrics"));
  const [awayRoomId, setAwayRoomId] = useState<string | null>(null);
  const { activeSession } = useSessionIdentity({
    sessionStorageKey: "soqaro-session",
    initialStatusMessage: ""
  });

  useEffect(() => {
    setHasMounted(true);
    // 水合完成后空闲时预热运行时分块，既不影响初次水合又保证进房迅速
    const prewarm = () => {
      void import("@/components/soqaro-app");
    };
    if (typeof window !== "undefined") {
      if ("requestIdleCallback" in window && typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(prewarm, { timeout: 2000 });
      } else {
        setTimeout(prewarm, 500);
      }
    }
  }, []);

  useEffect(() => {
    if (isCapacitorRuntime()) {
      void requestNotificationPermission();
    }
  }, []);

  useEffect(() => {
    if (isLyricsWindow) return;
    const syncAwayRoom = () => setAwayRoomId(readAwayRoomId());
    syncAwayRoom();
    window.addEventListener(awayRoomChangeEvent, syncAwayRoom);
    window.addEventListener("storage", syncAwayRoom);
    return () => {
      window.removeEventListener(awayRoomChangeEvent, syncAwayRoom);
      window.removeEventListener("storage", syncAwayRoom);
    };
  }, [isLyricsWindow]);

  useEffect(() => {
    if (isLyricsWindow) return;
    const syncScale = () => {
      applyUiScale(getAppSettings().layout.uiScale);
    };
    syncScale();
    window.addEventListener(appSettingsChangeEvent, syncScale);
    window.addEventListener("storage", syncScale);
    return () => {
      window.removeEventListener(appSettingsChangeEvent, syncScale);
      window.removeEventListener("storage", syncScale);
    };
  }, [isLyricsWindow]);

  const { owner, routeRoomId, runtimeRoomId } = resolvePlaybackOwnership(
    pathname, awayRoomId, isLyricsWindow
  );
  const isWorkspaceRoute = Boolean(
    pathname && (pathname === "/rooms" || pathname === "/app" || pathname.startsWith("/app/"))
  );
  const shouldMountAppShell = !isLyricsWindow && (isWorkspaceRoute || Boolean(routeRoomId));
  const { result: updateResult, isPromptOpen: isUpdatePromptOpen, dismissPrompt: dismissUpdatePrompt } = useAppUpdate({
    autoCheck: !isLyricsWindow
  });

  return (
    <DesktopLyricsProvider activeSource={owner}>
      <WorkspaceQueryProvider key={activeSession?.userId ?? "anonymous"}>
        <LocalPlayerProvider active={owner === "local"}>
          {shouldMountAppShell ? (
            <AppRouteShell active={isWorkspaceRoute} pathname={pathname}>
              {isWorkspaceRoute ? children : null}
            </AppRouteShell>
          ) : (
            children
          )}
          {owner === "local" ? <AppPersistentPlayer /> : null}
          {hasMounted && runtimeRoomId ? (
            <SoqaroApp
              key={runtimeRoomId}
              backgroundOnly={!routeRoomId}
              initialRoomId={runtimeRoomId}
              workspaceOnly
            />
          ) : null}
        </LocalPlayerProvider>
      </WorkspaceQueryProvider>
      <DesktopLyricsOverlay />
      <ShellBackButton />
      <UpdatePromptDialog
        onDismiss={dismissUpdatePrompt}
        open={isUpdatePromptOpen}
        result={updateResult}
      />
    </DesktopLyricsProvider>
  );
}
