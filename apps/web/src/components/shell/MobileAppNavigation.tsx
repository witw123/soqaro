"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type MouseEvent } from "react";
import { Home, Compass, ListMusic, User } from "lucide-react";
import { storeAwayRoomId } from "@/lib/domain/away-room";
import { runRoomViewTransition } from "@/lib/ui/room-view-transition";

type MobileNavIconName = "home" | "discover" | "playlist" | "profile";

type MobileNavItem = {
  id: "home" | "discover" | "playlists" | "profile";
  label: string;
  href: Route;
  icon: MobileNavIconName;
};

const items: MobileNavItem[] = [
  { id: "home", label: "首页", href: "/app", icon: "home" },
  { id: "discover", label: "发现", href: "/app/discover" as Route, icon: "discover" },
  { id: "playlists", label: "歌单", href: "/app/playlists", icon: "playlist" },
  { id: "profile", label: "我的", href: "/app/profile", icon: "profile" }
];

export function MobileAppNavigation({ onNavigateAway }: { onNavigateAway?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<Route | null>(null);
  const resolvedRoomId = pathname?.startsWith("/room/") ? pathname.split("/")[2] ?? null : null;

  useEffect(() => {
    setPendingHref(null);
  }, [pathname]);

  const handleItemClick = (event: MouseEvent<HTMLAnchorElement>, href: Route) => {
    if (!resolvedRoomId) {
      onNavigateAway?.();
      return;
    }

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
    if (href === "/app" && onNavigateAway) {
      onNavigateAway();
      return;
    }

    runRoomViewTransition(
      "room-exit",
      () => {
        storeAwayRoomId(resolvedRoomId);
        router.push(href);
      },
      { roomId: resolvedRoomId }
    );
  };

  return (
    <nav className="mobile-app-navigation fixed inset-x-0 bottom-0 z-[70] isolate h-[calc(3.25rem+env(safe-area-inset-bottom))] md:hidden" data-custom-layout-item="mobile-navigation" aria-label="主导航">
      <div className="grid h-full grid-cols-4 items-stretch px-1 pb-[env(safe-area-inset-bottom)] pt-0.5">
        {items.map((item) => {
          const active = pendingHref === item.href || isActivePath(pathname, item.href);
          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={`mobile-app-navigation__item ${active ? "mobile-app-navigation__item--active" : ""}`}
              href={item.href}
              key={item.id}
              onClick={(event) => handleItemClick(event, item.href)}
              onPointerDown={() => setPendingHref(item.href)}
            >
              <MobileNavIcon name={item.icon} />
              <span className="mobile-app-navigation__label">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function MobileNavIcon({ name }: { name: MobileNavIconName }) {
  const className = "mobile-app-navigation__icon h-5 w-5";

  if (name === "home") return <Home className={className} />;
  if (name === "discover") return <Compass className={className} />;
  if (name === "playlist") return <ListMusic className={className} />;
  if (name === "profile") return <User className={className} />;
  return null;
}

function isActivePath(pathname: string | null, href: Route) {
  if (href === "/app") {
    return pathname === "/app" || pathname === "/rooms" || (pathname?.startsWith("/room") ?? false);
  }
  return pathname?.startsWith(href) ?? false;
}


