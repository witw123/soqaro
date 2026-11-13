"use client";
/* eslint-disable @next/next/no-img-element */

import { memo, useCallback, type CSSProperties } from "react";
import type { RoomDirectoryItem, RoomType } from "@soqaro/shared";
import { ArtisticRoomStageScene } from "./ArtisticRoomStageScene";
import { ThemeAwareRoomTypeGlyph } from "@/components/icons/ThemeIcons";

import { getArtworkSourceUrl } from "@/components/bottom-player/artwork-colors";

type RoomDirectoryCardProps = {
  room: RoomDirectoryItem;
  isExpandedToModal?: boolean;
  shellTransitionName?: string;
  onOpen: (room: RoomDirectoryItem) => void;
  onPrewarm?: (roomId: string) => void;
};

type RoomCardTheme = {
  accent: string;
  border: string;
  glow: string;
  label: string;
  soft: string;
};

type RoomCardStyle = CSSProperties & {
  "--room-accent": string;
  "--room-border": string;
  "--room-shadow": string;
  "--room-soft": string;
};

const roomCardThemes: Record<RoomType, RoomCardTheme> = {
  interactive: {
    accent: "var(--blue-9)",
    border: "color-mix(in srgb, var(--blue-9) 45%, transparent)",
    glow: "color-mix(in srgb, var(--blue-9) 28%, transparent)",
    label: "多人互动",
    soft: "color-mix(in srgb, var(--blue-9) 14%, transparent)"
  },
  request: {
    accent: "#ab4aba",
    border: "rgba(171, 74, 186, 0.45)",
    glow: "rgba(171, 74, 186, 0.25)",
    label: "点歌房",
    soft: "rgba(171, 74, 186, 0.14)"
  },
  radio: {
    accent: "#00a2c7",
    border: "rgba(0, 162, 199, 0.45)",
    glow: "rgba(0, 162, 199, 0.26)",
    label: "自由电台",
    soft: "rgba(0, 162, 199, 0.14)"
  }
};

const roomCardStaticStyles: Record<RoomType, RoomCardStyle> = {
  interactive: {
    "--room-accent": roomCardThemes.interactive.accent,
    "--room-border": roomCardThemes.interactive.border,
    "--room-shadow": roomCardThemes.interactive.glow,
    "--room-soft": roomCardThemes.interactive.soft
  },
  request: {
    "--room-accent": roomCardThemes.request.accent,
    "--room-border": roomCardThemes.request.border,
    "--room-shadow": roomCardThemes.request.glow,
    "--room-soft": roomCardThemes.request.soft
  },
  radio: {
    "--room-accent": roomCardThemes.radio.accent,
    "--room-border": roomCardThemes.radio.border,
    "--room-shadow": roomCardThemes.radio.glow,
    "--room-soft": roomCardThemes.radio.soft
  }
};

export const RoomDirectoryCard = memo(function RoomDirectoryCard({
  room: directoryItem,
  isExpandedToModal = false,
  shellTransitionName,
  onOpen,
  onPrewarm
}: RoomDirectoryCardProps) {
  const room = directoryItem.room;
  const theme = roomCardThemes[room.roomType];
  const nowPlaying = room.directoryNowPlaying;
  const baseStyle = roomCardStaticStyles[room.roomType];
  const cardStyle: RoomCardStyle = shellTransitionName
    ? { ...baseStyle, viewTransitionName: shellTransitionName }
    : baseStyle;

  const handleOpen = useCallback(() => {
    onOpen(directoryItem);
  }, [directoryItem, onOpen]);

  const handlePrewarm = useCallback(() => {
    onPrewarm?.(room.id);
  }, [onPrewarm, room.id]);

  const hiddenCardClass = isExpandedToModal ? "invisible pointer-events-none select-none" : "";

  return (
    <article
      className="group relative flex w-full h-full min-w-0 flex-col overflow-hidden rounded-xl border-[0.5px] border-surface-border bg-surface-elevated p-3 shadow-xs transition-[border-color,background-color,box-shadow,transform] duration-[250ms] ease-out hover:border-[color:var(--room-border)] focus-within:border-[color:var(--room-accent)] focus-within:ring-1 focus-within:ring-[color:var(--room-accent)] motion-reduce:transition-none"
      data-morphed-to-modal={isExpandedToModal ? "true" : undefined}
      data-room-theme={room.roomType}
      data-room-type={room.roomType}
      data-testid="room-directory-card"
      onPointerEnter={handlePrewarm}
      style={cardStyle}
    >
      <button
        aria-hidden={isExpandedToModal || undefined}
        aria-label={`查看 ${room.name} 的房间详情`}
        className={`absolute inset-0 z-10 cursor-pointer rounded-[inherit] focus:outline-none ${
          isExpandedToModal ? "invisible pointer-events-none" : ""
        }`}
        data-testid="room-directory-open"
        disabled={isExpandedToModal}
        onClick={handleOpen}
        onFocus={handlePrewarm}
        tabIndex={isExpandedToModal ? -1 : undefined}
        type="button"
      />

      {/* Room Visual Cover: Integrates Room Type Badge and Online Status inside the cover */}
      <section
        aria-hidden={isExpandedToModal || undefined}
        className={`room-directory-stage-frame relative w-full aspect-[2.4/1] md:aspect-auto md:h-[148px] xl:h-[160px] shrink-0 overflow-hidden rounded-lg border-[0.5px] border-surface-border bg-surface shadow-xs ${hiddenCardClass}`}
        data-card-scene={room.roomType}
        data-testid="room-directory-stage"
      >
        <RoomStageVisualContent room={room} themeLabel={theme.label} />
      </section>

      {/* Track Playing Information Placed BELOW the cover */}
      {nowPlaying?.title ? (
        <RoomNowPlayingBar
          ariaHidden={isExpandedToModal}
          className={`mt-2 ${hiddenCardClass}`}
          nowPlaying={nowPlaying}
        />
      ) : null}

      <div
        aria-hidden={isExpandedToModal || undefined}
        className={`${nowPlaying?.title ? "pt-2" : "pt-2.5"} ${hiddenCardClass}`}
      >
        <h3 className="truncate text-sm sm:text-base font-semibold tracking-tight text-foreground transition-colors">
          {room.name}
        </h3>
        <p className="mt-0.5 line-clamp-2 break-words text-xs leading-relaxed text-foreground-muted">
          {room.description?.trim() || fallbackDescription(room)}
        </p>
      </div>

      {isExpandedToModal ? (
        <div
          aria-hidden="true"
          className="room-card-morphed-slot pointer-events-none absolute inset-3 rounded-lg border-[0.5px] border-dashed border-[var(--slate-8)] bg-[var(--slate-1)]"
          data-testid="room-directory-card-morphed-slot"
        />
      ) : null}
    </article>
  );
});

function RoomStageVisualContent({
  room,
  themeLabel
}: {
  room: RoomDirectoryItem["room"];
  themeLabel: string;
}) {
  const nowPlaying = room.directoryNowPlaying;
  return (
    <>
      {/* Seamless Badges Over Cover: Room Type (Left) & Online Count (Right) adapted across all themes via Radix tokens */}
      <div className="pointer-events-none absolute top-2 left-2.5 right-2.5 z-20 flex items-center justify-between gap-2">
        <span className="room-card-stage-badge inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium shadow-xs">
          <span className="room-card-stage-badge-icon">
            <ThemeAwareRoomTypeGlyph roomType={room.roomType} />
          </span>
          {themeLabel}
        </span>
        <span className="room-card-stage-badge inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 text-xs font-mono tabular-nums shadow-xs">
          <span aria-hidden="true" className="room-card-online-dot h-1.5 w-1.5 rounded-full" />
          {room.directoryOnlineMemberCount} 人在线
        </span>
      </div>

      {nowPlaying?.title ? (
        <RoomNowPlayingStageScene
          nowPlaying={nowPlaying}
          roomType={room.roomType}
        />
      ) : (
        <ArtisticRoomStageScene roomType={room.roomType} />
      )}
    </>
  );
}

function RoomNowPlayingBar({
  nowPlaying,
  className = "",
  ariaHidden = false
}: {
  nowPlaying: NonNullable<RoomDirectoryItem["room"]["directoryNowPlaying"]>;
  className?: string;
  ariaHidden?: boolean;
}) {
  return (
    <div
      aria-hidden={ariaHidden || undefined}
      className={`room-card-now-playing-bar flex min-w-0 w-full items-center gap-2 overflow-hidden rounded-lg px-2.5 py-1 ${className}`}
    >
      <div className="flex items-end gap-0.5 h-3 shrink-0 text-accent" aria-hidden="true">
        <span className="w-0.5 h-full bg-current rounded-full animate-music-bar origin-bottom will-change-transform" style={{ animationDuration: "0.8s" }} />
        <span className="w-0.5 h-full bg-current rounded-full animate-music-bar origin-bottom will-change-transform" style={{ animationDuration: "1.1s", animationDelay: "0.2s" }} />
        <span className="w-0.5 h-full bg-current rounded-full animate-music-bar origin-bottom will-change-transform" style={{ animationDuration: "0.9s", animationDelay: "0.4s" }} />
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-xs">
        <span className="min-w-0 truncate font-medium text-foreground">{nowPlaying.title}</span>
        {nowPlaying.artist ? (
          <span className="max-w-[42%] shrink-0 truncate text-foreground-muted">/ {nowPlaying.artist}</span>
        ) : null}
      </div>
    </div>
  );
}

function RoomNowPlayingStageScene({
  nowPlaying,
  roomType
}: {
  nowPlaying: NonNullable<RoomDirectoryItem["room"]["directoryNowPlaying"]>;
  roomType: RoomType;
}) {
  const artworkSrc = nowPlaying.artworkUrl ? getArtworkSourceUrl(nowPlaying.artworkUrl) : null;

  return (
    <div className="room-card-stage-backdrop relative flex h-full w-full items-center justify-center overflow-hidden select-none">
      {/* Background Layer: Room's Default Theme Scene elements */}
      <div className="absolute inset-0 opacity-25 dark:opacity-40">
        <ArtisticRoomStageScene roomType={roomType} />
      </div>

      {/* Blurred Album Artwork Overlay Background */}
      {artworkSrc ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-2 bg-cover bg-center opacity-25 dark:opacity-30 blur-lg scale-110"
          style={{ backgroundImage: `url("${artworkSrc}")` }}
        />
      ) : null}
      <div className="room-card-stage-scrim absolute inset-0" />

      {/* Central Album Artwork Cover */}
      <div className="relative flex items-center justify-center pt-2">
        <div className="room-card-artwork-frame relative z-10 h-16 w-16 sm:h-20 sm:w-20 shrink-0 overflow-hidden rounded-xl transition-transform duration-[250ms] ease-out group-hover:scale-105">
          {artworkSrc ? (
            <img
              alt={nowPlaying.title}
              className="h-full w-full object-cover"
              decoding="async"
              loading="lazy"
              src={artworkSrc}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-foreground-muted">
              <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
              </svg>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function fallbackDescription(room: RoomDirectoryItem["room"]) {
  if (room.roomType === "request") return "成员自由点歌互动，沉浸式品鉴优质音乐。";
  if (room.roomType === "radio") return "主理人广播策展，探索多维声波流动。";
  return "多人协作曲库与队列，尽享实时同步聆听。";
}
