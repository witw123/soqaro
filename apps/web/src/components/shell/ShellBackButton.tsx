"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { storeAwayRoomId } from "@/lib/domain/away-room";
import { capacitorPlugin } from "@/lib/desktop/tauri";
import { resolveBackNavigation, runBackHandler } from "@/lib/desktop/back-handler";
import { runRoomViewTransition } from "@/lib/ui/room-view-transition";

type BackButtonPayload = { canGoBack?: boolean };

type AppPlugin = {
  addListener?: (
    event: string,
    callback: (payload: BackButtonPayload) => void
  ) => Promise<{ remove: () => void }> | { remove: () => void };
  exitApp?: () => void;
};

const exitHintWindowMs = 2_000;

/**
 * Routes the Android hardware back button.
 *
 * The Capacitor App plugin is the only thing that turns the system back
 * gesture into a JS event — without it the WebView's default dismisses the
 * whole activity. Order of precedence:
 *
 * 1. an open overlay (registered through `useBackHandler`) consumes the press,
 * 2. the home page quits, so a press on a start destination never rewinds,
 * 3. otherwise step back through the SPA history,
 * 4. with no history left, require a second press before quitting, so a stray
 *    swipe on the home screen does not close the app.
 *
 * No-op in plain browsers and on desktop, where the plugin global is absent.
 */
export function ShellBackButton() {
  const router = useRouter();
  const pathname = usePathname();
  // The listener is installed once for the app's lifetime, so it reads the
  // current route through a ref rather than re-subscribing on every navigation.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const lastPressAtRef = useRef(0);
  const [isExitHintVisible, setIsExitHintVisible] = useState(false);
  const exitHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const plugin = capacitorPlugin("App") as AppPlugin | undefined;
    if (!plugin?.addListener) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const handleBack = (payload: BackButtonPayload | undefined) => {
      if (runBackHandler()) return;

      const decision = resolveBackNavigation({
        pathname: pathnameRef.current,
        canGoBack: payload?.canGoBack
      });
      if (decision.action === "navigate") {
        // 逻辑父级导航:房间/子页返回大厅,而不是历史里的上一界面。
        // typedRoutes 把 target 收窄为字符串字面量,这里显式放宽。
        const currentPath = pathnameRef.current;
        if (currentPath?.startsWith("/room/") && decision.target === "/app") {
          const roomId = currentPath.slice("/room/".length).split("/")[0] ?? null;
          if (roomId) {
            runRoomViewTransition(
              "room-exit",
              () => {
                storeAwayRoomId(roomId);
                router.push(decision.target as Parameters<typeof router.push>[0]);
              },
              { roomId }
            );
            return;
          }
        }
        router.push(decision.target as Parameters<typeof router.push>[0]);
        return;
      }
      if (decision.action === "history") {
        router.back();
        return;
      }

      const now = Date.now();
      if (now - lastPressAtRef.current < exitHintWindowMs) {
        lastPressAtRef.current = 0;
        plugin.exitApp?.();
        return;
      }

      lastPressAtRef.current = now;
      setIsExitHintVisible(true);
      if (exitHintTimerRef.current) clearTimeout(exitHintTimerRef.current);
      exitHintTimerRef.current = setTimeout(() => setIsExitHintVisible(false), exitHintWindowMs);
    };

    const listener = plugin.addListener("backButton", handleBack);
    // Natively registered plugins hand back a synchronous handle instead of
    // the Promise that TS-registered ones return; normalize before chaining.
    void Promise.resolve(listener)
      .then((listenerHandle) => {
        if (!listenerHandle) return;
        if (cancelled) listenerHandle.remove();
        else unlisten = () => listenerHandle.remove();
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
      unlisten = undefined;
      if (exitHintTimerRef.current) {
        clearTimeout(exitHintTimerRef.current);
        exitHintTimerRef.current = null;
      }
    };
  }, [router]);

  if (!isExitHintVisible) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[2147483647] flex justify-center pb-[calc(1.5rem+env(safe-area-inset-bottom))]"
      role="status"
    >
      <span className="rounded-full border border-white/15 bg-black/80 px-4 py-2 text-sm text-white shadow-lg backdrop-blur-md">
        再按一次返回键退出
      </span>
    </div>
  );
}
