"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Route } from "next";
import { AppSidebar } from "./AppSidebar";
import { AwayRoomReturnButton } from "@/components/room-home";
import { MobileAppNavigation } from "./MobileAppNavigation";
import { awayRoomChangeEvent, readAwayRoomId, requestAwayRoomResume } from "@/lib/domain/away-room";
import { useCustomLayoutRuntime } from "@/features/settings/use-custom-layout-runtime";
import { WorkspacePageActivity } from "@/features/workspace/page-activity";
import { prewarmRoomRuntimeChunk, runRoomViewTransition } from "@/lib/ui/room-view-transition";

export function AppRouteShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
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

  function handleResumeAwayRoom() {
    if (!awayRoomId) return;
    prewarmRoomRuntimeChunk();
    requestAwayRoomResume(awayRoomId);
    runRoomViewTransition(
      "room-enter",
      () => {
        router.push(`/room/${awayRoomId}` as Route);
      },
      { roomId: awayRoomId }
    );
  }

  return (
      <div className="min-h-[calc(100*var(--app-dvh))] overflow-x-hidden bg-background text-foreground">
        <div className="hidden md:contents">
          <AppSidebar
            hasBottomPlayer
          />
        </div>
        {awayRoomId ? <AwayRoomReturnButton onClick={handleResumeAwayRoom} /> : null}
        <PersistentAppRouteViews pathname={pathname}>{children}</PersistentAppRouteViews>
        <MobileAppNavigation />
      </div>
  );
}

/** Keep visited workspace pages mounted so route changes do not reset their data state. */
const MAX_PERSISTENT_ROUTE_CACHE_ENTRIES = 6;

function PersistentAppRouteViews({
  pathname,
  children
}: {
  pathname: string | null;
  children: ReactNode;
}) {
  const routeKey = pathname || "/app";
  const routeCache = useRef(new Map<string, ReactNode>());
  const visibleRoute = useRef<string | null>(null);
  const lastChildren = useRef<ReactNode | undefined>(undefined);

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

  return (
    <div className="contents">
      {[...routeCache.current.entries()].map(([cachedRoute, page]) => {
        const isVisible = cachedRoute === visibleRoute.current;
        return (
          <div
            aria-hidden={!isVisible}
            className={isVisible ? "mobile-app-route-view custom-layout-content-region md:contents" : "hidden"}
            key={cachedRoute}
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
