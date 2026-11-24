"use client";

import { memo, useState } from "react";
import type {
  AuthSession,
  BilibiliTrackCandidate,
  NeteaseTrackCandidate,
  Playlist,
  QqMusicTrackCandidate,
  TrackMeta
} from "@soqaro/shared";
import type { CachedLibraryTrack } from "@/features/library/audio-utils";
import type { LocalStorageSummary } from "@/features/upload/use-track-uploads";
import { PlaylistPanel } from "./PlaylistPanel";
import { LocalPlaylistPanel } from "./LocalPlaylistPanel";
import { FavoriteAlbumsPanel } from "./FavoriteAlbumsPanel";

type LocalStorageTabPanelProps = {
  tracks: TrackMeta[];
  playlists: Playlist[];
  activeSession: AuthSession | null;
  canManageLibrary: boolean;
  localStorageSummary: LocalStorageSummary;
  onImportCachedTrack: (track: CachedLibraryTrack) => Promise<void>;
  onLoadPlaylistIntoRoom: (playlistId: string) => Promise<void>;
  onImportNeteaseTrack: (track: NeteaseTrackCandidate) => Promise<void>;
  onImportQqMusicTrack: (track: QqMusicTrackCandidate) => Promise<void>;
  onImportBilibiliTrack?: (track: BilibiliTrackCandidate) => Promise<void>;
  onImportNeteaseTracks: (tracks: NeteaseTrackCandidate[]) => Promise<void>;
  onImportQqMusicTracks: (tracks: QqMusicTrackCandidate[]) => Promise<void>;
  onImportBilibiliTracks?: (tracks: BilibiliTrackCandidate[]) => Promise<void>;
  currentRoomId?: string | null;
  roomPlaylists?: Playlist[];
  onRefreshRoom?: () => Promise<unknown>;
};

function LocalStorageTabPanelBase({
  tracks,
  playlists,
  activeSession,
  canManageLibrary,
  localStorageSummary,
  onImportCachedTrack,
  onLoadPlaylistIntoRoom,
  onImportNeteaseTrack,
  onImportQqMusicTrack,
  onImportBilibiliTrack,
  onImportNeteaseTracks,
  onImportQqMusicTracks,
  onImportBilibiliTracks,
  currentRoomId,
  roomPlaylists,
  onRefreshRoom
}: LocalStorageTabPanelProps) {
  const [pendingCachedImport, setPendingCachedImport] = useState<string | null>(null);
  const [playlistTab, setPlaylistTab] = useState<"local" | "network" | "favorites">("local");

  const handleImportCachedTrack = async (track: CachedLibraryTrack) => {
    if (pendingCachedImport || !canManageLibrary) return;
    setPendingCachedImport(track.fileHash);
    try {
      await onImportCachedTrack(track);
    } finally {
      setPendingCachedImport(null);
    }
  };

  return (
    <div className="animate-fade-in flex w-full flex-col gap-5 max-w-4xl mx-auto">
      <div className="flex w-full justify-center">
        <div
          aria-label="歌单类型"
          className="flex w-full max-w-md items-center gap-1 rounded-lg border border-surface-border/60 bg-surface/30 p-0.5"
          role="tablist"
        >
          <button
            aria-selected={playlistTab === "local"}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-all cursor-pointer ${
              playlistTab === "local"
                ? "bg-surface-elevated text-foreground font-semibold shadow-2xs"
                : "text-foreground-muted hover:text-foreground hover:bg-surface-hover/30"
            }`}
            onClick={() => setPlaylistTab("local")}
            role="tab"
            type="button"
          >
            本地歌单
          </button>
          <button
            aria-selected={playlistTab === "network"}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-all cursor-pointer ${
              playlistTab === "network"
                ? "bg-surface-elevated text-foreground font-semibold shadow-2xs"
                : "text-foreground-muted hover:text-foreground hover:bg-surface-hover/30"
            }`}
            onClick={() => setPlaylistTab("network")}
            role="tab"
            type="button"
          >
            网络歌单
          </button>
          <button
            aria-selected={playlistTab === "favorites"}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-all cursor-pointer ${
              playlistTab === "favorites"
                ? "bg-surface-elevated text-foreground font-semibold shadow-2xs"
                : "text-foreground-muted hover:text-foreground hover:bg-surface-hover/30"
            }`}
            onClick={() => setPlaylistTab("favorites")}
            role="tab"
            type="button"
          >
            我的收藏
          </button>
        </div>
      </div>
      {playlistTab === "local" ? <section className="flex flex-col gap-3" data-testid="local-playlist-section">
      <LocalPlaylistPanel
          canManageLibrary={canManageLibrary}
          currentRoomId={currentRoomId}
          localPlaylists={localStorageSummary.localPlaylists}
          localTracks={localStorageSummary.localPlaylistTracks}
          localFolderName={localStorageSummary.localFolderName}
          onImportCachedTrack={handleImportCachedTrack}
          pendingCachedImport={pendingCachedImport}
          roomPlaylists={roomPlaylists}
          roomTracks={tracks}
          onRefreshRoom={onRefreshRoom}
        />
      </section> : null}
      {playlistTab === "network" ? <section className="flex flex-col gap-3" data-testid="network-playlist-section">
        <PlaylistPanel
          canManageLibrary={canManageLibrary}
          currentRoomId={currentRoomId}
          onLoadPlaylistIntoRoom={onLoadPlaylistIntoRoom}
          onImportNeteaseTrack={onImportNeteaseTrack}
          onImportQqMusicTrack={onImportQqMusicTrack}
          onImportBilibiliTrack={onImportBilibiliTrack}
          onImportNeteaseTracks={onImportNeteaseTracks}
          onImportQqMusicTracks={onImportQqMusicTracks}
          onImportBilibiliTracks={onImportBilibiliTracks}
          playlists={playlists}
          roomPlaylists={roomPlaylists}
          tracks={tracks}
          onRefreshRoom={onRefreshRoom}
        />
      </section> : null}
      {playlistTab === "favorites" ? <section className="flex flex-col gap-3" data-testid="favorite-albums-section">
        <FavoriteAlbumsPanel
          activeSession={activeSession}
          canManageLibrary={canManageLibrary}
          currentRoomId={currentRoomId}
          roomPlaylists={roomPlaylists}
          onImportNeteaseTrack={onImportNeteaseTrack}
          onImportQqMusicTrack={onImportQqMusicTrack}
          onImportBilibiliTrack={onImportBilibiliTrack}
          onImportNeteaseTracks={onImportNeteaseTracks}
          onImportQqMusicTracks={onImportQqMusicTracks}
          onImportBilibiliTracks={onImportBilibiliTracks}
          roomTracks={tracks}
          onRefreshRoom={onRefreshRoom}
        />
      </section> : null}
    </div>
  );
}

export const LocalStorageTabPanel = memo(LocalStorageTabPanelBase);
