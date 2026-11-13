"use client";

import type { PlaybackMode, RoomType } from "@soqaro/shared";

export type ThemeNavIconName =
  | "home"
  | "discover"
  | "search"
  | "playlist"
  | "favorite"
  | "profile"
  | "settings"
  | "theme-toggle"
  | "collapse"
  | "expand";

type IconBaseProps = {
  size?: number;
  className?: string;
};

/**
 * Brand emblem that adapts stroke geometry and duotone layers to the active theme's icon pack.
 */
export function ThemeAwareBrandGlyph({ size = 18, className = "" }: IconBaseProps) {
  return (
    <svg
      aria-hidden="true"
      className={`theme-aware-icon shrink-0 ${className}`}
      fill="none"
      height={size}
      stroke="currentColor"
      viewBox="0 0 24 24"
      width={size}
    >
      <circle cx="7" cy="17.5" r="2.75" fill="currentColor" fillOpacity="0.28" />
      <circle cx="17" cy="15.5" r="2.75" fill="currentColor" fillOpacity="0.28" />
      <path d="M9.75 17.5V6.2L19.75 4.4V15.5" />
      <path className="theme-icon-blueprint-accent" d="M9.75 9.6L19.75 7.8" strokeDasharray="2 2" />
      <circle cx="7" cy="17.5" r="2.75" />
      <circle cx="17" cy="15.5" r="2.75" />
    </svg>
  );
}

/**
 * Theme-stylized navigation icons that preserve universal silhouettes while adapting
 * line weight, joins, and pack-specific accents via CSS `data-icon-pack`.
 */
export function ThemeAwareNavIcon({
  name,
  size = 18,
  className = "",
  isDarkTheme = true
}: IconBaseProps & {
  name: ThemeNavIconName;
  isDarkTheme?: boolean;
}) {
  const shared = {
    "aria-hidden": true as const,
    className: `theme-aware-icon shrink-0 ${className}`,
    fill: "none",
    height: size,
    stroke: "currentColor",
    viewBox: "0 0 24 24",
    width: size
  };

  switch (name) {
    case "home":
      return (
        <svg {...shared}>
          <path
            className="theme-icon-duotone"
            d="M4 10.5L12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19v-8.5Z"
            stroke="none"
          />
          <path d="M4 10.5L12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19v-8.5Z" />
          <path d="M9.5 20.5V14h5v6.5" />
          <path className="theme-icon-noir-accent" d="M9.5 14h5" />
          <circle className="theme-icon-blueprint-accent" cx="12" cy="8.5" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      );

    case "discover":
      return (
        <svg {...shared}>
          <circle className="theme-icon-duotone" cx="12" cy="12" r="9" stroke="none" />
          <circle cx="12" cy="12" r="9" />
          <polygon
            className="theme-icon-noir-accent"
            points="15.8 8.2 13.7 13.7 8.2 15.8 10.3 10.3 15.8 8.2"
          />
          <polygon points="15.8 8.2 13.7 13.7 8.2 15.8 10.3 10.3 15.8 8.2" />
          <path className="theme-icon-blueprint-accent" d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21" />
        </svg>
      );

    case "playlist":
      return (
        <svg {...shared}>
          <circle className="theme-icon-duotone" cx="17.5" cy="16.5" r="2.75" stroke="none" />
          <path d="M4 7h11" />
          <path d="M4 12h9" />
          <path d="M4 17h6" />
          <path d="M20.25 16.5V6.5l-4.5 1.2v8.8" strokeOpacity="0" />
          <path d="M19.75 16.5V7.5L15 8.8" />
          <circle cx="17" cy="16.5" r="2.75" />
          <path className="theme-icon-noir-accent" d="M4 7h4" />
        </svg>
      );

    case "profile":
      return (
        <svg {...shared}>
          <circle className="theme-icon-duotone" cx="12" cy="8" r="3.5" stroke="none" />
          <path
            className="theme-icon-duotone"
            d="M5 19.5a7 7 0 0 1 14 0"
            stroke="none"
          />
          <circle cx="12" cy="8" r="3.5" />
          <path d="M5 19.5a7 7 0 0 1 14 0" />
          <path className="theme-icon-noir-accent" d="M9.5 19.5h5" />
        </svg>
      );

    case "settings":
      return (
        <svg {...shared}>
          <circle className="theme-icon-duotone" cx="12" cy="12" r="3" stroke="none" />
          <path d="M12 3.5v2M12 18.5v2M5.99 5.99l1.41 1.41M16.6 16.6l1.41 1.41M3.5 12h2M18.5 12h2M5.99 18.01l1.41-1.41M16.6 7.4l1.41-1.41" />
          <circle cx="12" cy="12" r="5.5" />
          <circle className="theme-icon-noir-accent" cx="12" cy="12" r="2.2" />
          <circle cx="12" cy="12" r="2.2" />
        </svg>
      );

    case "theme-toggle":
      if (isDarkTheme) {
        return (
          <svg {...shared}>
            <circle className="theme-icon-duotone" cx="12" cy="12" r="4.5" stroke="none" />
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2.5v2.2M12 19.3v2.2M5.28 5.28l1.56 1.56M17.16 17.16l1.56 1.56M2.5 12h2.2M19.3 12h2.2M5.28 18.72l1.56-1.56M17.16 6.84l1.56-1.56" />
          </svg>
        );
      }
      return (
        <svg {...shared}>
          <path
            className="theme-icon-duotone"
            d="M20.2 14.4A8.2 8.2 0 1 1 9.6 3.8a6.8 6.8 0 0 0 10.6 10.6Z"
            stroke="none"
          />
          <path d="M20.2 14.4A8.2 8.2 0 1 1 9.6 3.8a6.8 6.8 0 0 0 10.6 10.6Z" />
          <path className="theme-icon-noir-accent" d="M17.5 5.5v2.2M16.4 6.6h2.2" />
        </svg>
      );

    case "collapse":
      return (
        <svg {...shared}>
          <rect className="theme-icon-duotone" x="3.5" y="4" width="5.5" height="16" rx="1" stroke="none" />
          <rect x="3.5" y="4" width="17" height="16" rx="2" />
          <path d="M9 4v16" />
          <path d="m15.5 9.5-2.5 2.5 2.5 2.5" />
        </svg>
      );

    case "expand":
      return (
        <svg {...shared}>
          <rect className="theme-icon-duotone" x="3.5" y="4" width="5.5" height="16" rx="1" stroke="none" />
          <rect x="3.5" y="4" width="17" height="16" rx="2" />
          <path d="M9 4v16" />
          <path d="m13.5 9.5 2.5 2.5-2.5 2.5" />
        </svg>
      );

    case "search":
      return (
        <svg {...shared}>
          <circle className="theme-icon-duotone" cx="11" cy="11" r="6.5" stroke="none" />
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
      );

    case "favorite":
      return (
        <svg {...shared}>
          <path
            className="theme-icon-duotone"
            d="M12 20.2s-7-4.4-8.6-8.7C2.1 8 4.4 4.5 8 4.5c2 0 3.4 1.1 4 2.4.6-1.3 2-2.4 4-2.4 3.6 0 5.9 3.5 4.6 7-1.6 4.3-8.6 8.7-8.6 8.7Z"
            stroke="none"
          />
          <path d="M12 20.2s-7-4.4-8.6-8.7C2.1 8 4.4 4.5 8 4.5c2 0 3.4 1.1 4 2.4.6-1.3 2-2.4 4-2.4 3.6 0 5.9 3.5 4.6 7-1.6 4.3-8.6 8.7-8.6 8.7Z" />
        </svg>
      );
  }
}

/**
 * Room type glyph rendered in room card corner badges and headers, styled by active theme pack.
 */
export function ThemeAwareRoomTypeGlyph({
  roomType,
  large = false,
  className = ""
}: {
  roomType: RoomType;
  large?: boolean;
  className?: string;
}) {
  const sizeClass = large ? "h-6 w-6" : "h-3.5 w-3.5";

  if (roomType === "request") {
    return (
      <svg
        aria-hidden="true"
        className={`theme-aware-icon ${sizeClass} shrink-0 text-current ${className}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <circle className="theme-icon-duotone" cx="6.5" cy="18" r="2.75" stroke="none" />
        <circle className="theme-icon-duotone" cx="18" cy="16" r="2.75" stroke="none" />
        <path d="M9.25 18V5.2l11.5-2V16" />
        <circle cx="6.5" cy="18" r="2.75" />
        <circle cx="18" cy="16" r="2.75" />
      </svg>
    );
  }

  if (roomType === "radio") {
    return (
      <svg
        aria-hidden="true"
        className={`theme-aware-icon ${sizeClass} shrink-0 text-current ${className}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <circle className="theme-icon-duotone" cx="12" cy="12" r="5.5" stroke="none" />
        <circle className="theme-icon-noir-accent" cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="2" />
        <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      className={`theme-aware-icon ${sizeClass} shrink-0 text-current ${className}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <circle className="theme-icon-duotone" cx="9" cy="7.5" r="3.5" stroke="none" />
      <path d="M15.5 20.5v-2a3.75 3.75 0 0 0-3.75-3.75H6.25A3.75 3.75 0 0 0 2.5 18.5v2" />
      <circle cx="9" cy="7.5" r="3.5" />
      <path d="M21.5 20.5v-2a3.75 3.75 0 0 0-2.75-3.6" />
      <path d="M15.5 4.2a3.5 3.5 0 0 1 0 6.6" />
    </svg>
  );
}

/**
 * Theme-stylized playback mode and volume glyphs for the persistent player bar.
 */
export function ThemeAwarePlaybackModeGlyph({ mode }: { mode: PlaybackMode }) {
  if (mode === "shuffle") {
    return (
      <svg
        aria-hidden="true"
        className="theme-aware-icon"
        fill="none"
        height="17"
        stroke="currentColor"
        viewBox="0 0 24 24"
        width="17"
      >
        <path d="M4 7h3.5c3.5 0 4.5 10 9 10H20" />
        <path d="m17 14 3 3-3 3" />
        <path d="M4 17h3c1.4 0 2.4-1.1 3.1-2.4" />
        <path d="M14 9.4C14.8 8 15.8 7 17.2 7H20" />
        <path d="m17 4 3 3-3 3" />
      </svg>
    );
  }

  if (mode === "single") {
    return (
      <svg
        aria-hidden="true"
        className="theme-aware-icon"
        fill="none"
        height="17"
        stroke="currentColor"
        viewBox="0 0 24 24"
        width="17"
      >
        <path d="M17 2l4 4-4 4" />
        <path d="M3 11V9a3 3 0 0 1 3-3h15" />
        <path d="m7 22-4-4 4-4" />
        <path d="M21 13v2a3 3 0 0 1-3 3H3" />
        <path d="M12 10v4" />
        <path d="M10.5 10h1.5a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-1.5" />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      className="theme-aware-icon"
      fill="none"
      height="17"
      stroke="currentColor"
      viewBox="0 0 24 24"
      width="17"
    >
      <path d="M4 7h12" />
      <path d="m13 4 3 3-3 3" />
      <path d="M20 17H8" />
      <path d="m11 14-3 3 3 3" />
    </svg>
  );
}

export function ThemeAwareVolumeGlyph({ muted }: { muted: boolean }) {
  if (muted) {
    return (
      <svg
        aria-hidden="true"
        className="theme-aware-icon"
        fill="none"
        height="17"
        stroke="currentColor"
        viewBox="0 0 24 24"
        width="17"
      >
        <path className="theme-icon-duotone" d="M11 5 6 9H3v6h3l5 4V5Z" stroke="none" />
        <path d="M11 5 6 9H3v6h3l5 4V5Z" />
        <path d="m19 9-5 6" />
        <path d="m14 9 5 6" />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      className="theme-aware-icon"
      fill="none"
      height="17"
      stroke="currentColor"
      viewBox="0 0 24 24"
      width="17"
    >
      <path className="theme-icon-duotone" d="M11 5 6 9H3v6h3l5 4V5Z" stroke="none" />
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  );
}
