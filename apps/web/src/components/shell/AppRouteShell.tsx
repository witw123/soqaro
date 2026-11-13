"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Route } from "next";
import { AppSidebar } from "./AppSidebar";
import { AwayRoomReturnButton } from "@/components/room-home";
import { MobileAppNavigation } from "./MobileAppNavigation";
import { awayRoomChangeEvent, readAwayRoomId, requestAwayRoomResume } from "@/lib/domain/away-room";
import { useCustomLayoutRuntime } from "@/features/settings/use-custom-layout-runtime";
import { WorkspacePageActivity } from "@/features/workspace/page-activity";
import {
  awaitRoomRuntimePrewarm,
  prewarmRoomRuntimeChunk,
  runRoomViewTransition
} from "@/lib/ui/room-view-transition";

export function AppRouteShell({
  children,
  active = true,
  pathname: providedPathname
}: {
  children: ReactNode;
  active?: boolean;
  pathname?: string | null;
}) {
  const hookPathname = usePathname();
  const pathname = providedPathname !== undefined ? providedPathname : hookPathname;
  const router = useRouter();
  useCustomLayoutRuntime(pathname);
  const [awayRoomId, setAwayRoomId] = useState<string | null>(null);

  useEffect(() => {
    const syncAwayRoom = () => setAwayRoomId(readAwayRoomId());
    syncAwayRoom();
    window.addEventListener(awayRoomChangeEvent, syncAwayRoom);
    window.addEventListener("storage", syncAwayRoom);
    return () => {
      window.removeEventListener(awayRoomChangeEvent, syncAwayRoom);
      window.removeEventListener("storage", syncAwayRoom);
    };
  }, []);

  async function handleResumeAwayRoom() {
    if (!awayRoomId) return;
    const targetHref = `/room/${awayRoomId}` as Route;
    prewarmRoomRuntimeChunk();
    router.prefetch(targetHref);
    await awaitRoomRuntimePrewarm();
    requestAwayRoomResume(awayRoomId);
    runRoomViewTransition(
      "room-enter",
      () => {
        router.push(targetHref);
      },
      { roomId: awayRoomId }
    );
  }

  return (
      <div
        aria-hidden={!active}
        className={
          active
            ? "min-h-[calc(100*var(--app-dvh))] overflow-x-hidden bg-background text-foreground"
            : "hidden"
        }
      >
        {active ? (
          <div className="hidden md:contents">
            <AppSidebar
              hasBottomPlayer
            />
          </div>
        ) : null}
        {active && awayRoomId ? <AwayRoomReturnButton onClick={handleResumeAwayRoom} /> : null}
        <PersistentAppRouteViews active={active} pathname={pathname}>
          {children}
        </PersistentAppRouteViews>
        {active ? <MobileAppNavigation /> : null}
      </div>
  );
}

/** Keep visited workspace pages mounted so route changes do not reset their data state. */
const MAX_PERSISTENT_ROUTE_CACHE_ENTRIES = 6;

function PersistentAppRouteViews({
  active,
  pathname,
  children
}: {
  active: boolean;
  pathname: string | null;
  children: ReactNode;
}) {
  const routeKey = pathname || "/app";
  const routeCache = useRef(new Map<string, ReactNode>());
  const visibleRoute = useRef<string | null>(null);
  const lastChildren = useRef<ReactNode | undefined>(undefined);
  const prevRouteKeyRef = useRef<string | null>(active ? routeKey : null);
  const [animatingRouteKey, setAnimatingRouteKey] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!active) return;
    if (prevRouteKeyRef.current === routeKey) return;
    prevRouteKeyRef.current = routeKey;
    if (
      typeof document !== "undefined" &&
      document.documentElement.hasAttribute("data-room-transition")
    ) {
      setAnimatingRouteKey(null);
      return;
    }
    setAnimatingRouteKey(routeKey);
  }, [active, routeKey]);

  if (active) {
    const cachedPage = routeCache.current.get(routeKey);
    if (routeCache.current.has(routeKey)) {
      // A cached route can be shown immediately while Next resolves its new RSC payload.
      // Re-insert to refresh recency so eviction drops least-recently-used routes.
      visibleRoute.current = routeKey;
      lastChildren.current = cachedPage;
      routeCache.current.delete(routeKey);
      routeCache.current.set(routeKey, cachedPage);
    } else if (children !== null && children !== undefined && children !== lastChildren.current) {
      // Pathname can update before children during a client transition. Do not cache the
      // previous route under the new key; wait for the new page node to arrive.
      routeCache.current.set(routeKey, children);
      visibleRoute.current = routeKey;
      lastChildren.current = children;
      while (routeCache.current.size > MAX_PERSISTENT_ROUTE_CACHE_ENTRIES) {
        const oldestEvictable = [...routeCache.current.keys()].find(
          (candidate) => candidate !== routeKey && candidate !== visibleRoute.current
        );
        if (oldestEvictable === undefined) break;
        routeCache.current.delete(oldestEvictable);
      }
    }
  }

  return (
    <div className="contents">
      {[...routeCache.current.entries()].map(([cachedRoute, page]) => {
        const isVisible = active && cachedRoute === visibleRoute.current;
        const isEntering = isVisible && animatingRouteKey === cachedRoute;
        return (
          <div
            aria-hidden={!isVisible}
            className={
              isVisible
                ? `mobile-app-route-view${isEntering ? " mobile-app-route-view--enter" : ""} custom-layout-content-region md:contents`
                : "hidden"
            }
            key={cachedRoute}
            onAnimationEnd={
              isEntering
                ? (event) => {
                    if (event.target === event.currentTarget) {
                      setAnimatingRouteKey((current) => (current === cachedRoute ? null : current));
                    }
                  }
                : undefined
            }
          >
            <WorkspacePageActivity.Provider value={isVisible}>
              {page}
            </WorkspacePageActivity.Provider>
          </div>
        );
      })}
    </div>
  );
}
