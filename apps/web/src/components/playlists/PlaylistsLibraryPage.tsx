"use client";

import { useState } from "react";
import { FavoriteAlbumsPage } from "@/components/discovery";
import { ProviderSearchPage } from "@/components/provider-search";
import { useBackHandler } from "@/lib/desktop/use-back-handler";
import { MusicIcon, RadioIcon, HeartIcon, FolderIcon } from "@/components/icons/DiscoverIcons";
import { PlaylistsWorkspacePage } from "./PlaylistsWorkspacePage";
import { AlistPlaylistsView } from "./AlistPlaylistsView";

type PlaylistLibraryTab = "local" | "network" | "favorites" | "alist";

const tabs: Array<{ id: PlaylistLibraryTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "local", label: "本地歌单", icon: MusicIcon },
  { id: "network", label: "网络歌单", icon: RadioIcon },
  { id: "favorites", label: "我的收藏", icon: HeartIcon },
  { id: "alist", label: "网盘目录", icon: FolderIcon }
];

export function PlaylistsLibraryPage() {
  const [activeTab, setActiveTab] = useState<PlaylistLibraryTab>("local");
  const [isSearchActive, setIsSearchActive] = useState(false);
  const [searchKeywords, setSearchKeywords] = useState("");

  useBackHandler(
    () => {
      setIsSearchActive(false);
      setSearchKeywords("");
    },
    isSearchActive
  );

  return (
    <main className="workspace-page hide-scrollbar relative overflow-y-auto selection:bg-accent/30 selection:text-white md:pl-60 lg:pb-28">
      <div aria-hidden="true" className="workspace-page-background" />
      <div className="workspace-page__inner workspace-page__inner--wide relative z-10 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-[calc(var(--room-mobile-bottom-inset)+2.5rem)] sm:pt-6 md:pt-8 md:pb-28">
        <ProviderSearchPage
          embedded
          isSearchActive={isSearchActive}
          keywords={searchKeywords}
          onBackToRecommendations={() => {
            setIsSearchActive(false);
            setSearchKeywords("");
          }}
          onKeywordsChange={setSearchKeywords}
          onSearchActiveChange={setIsSearchActive}
        />

        {!isSearchActive ? (
          <>
            <header className="mt-3 mb-5 flex items-center">
              <div
                aria-label="歌单分类"
                className="flex items-center gap-0.5 rounded-lg border-hairline border-[var(--slate-6)] bg-[var(--slate-2)] p-0.5 max-w-full overflow-x-auto hide-scrollbar touch-pan-x"
                role="tablist"
              >
                {tabs.map(({ id, label, icon: IconComp }) => {
                  const isActive = activeTab === id;
                  return (
                    <button
                      key={id}
                      aria-selected={isActive}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors duration-[250ms] ease-out cursor-pointer ${
                        isActive
                          ? "bg-[var(--slate-4)] text-[var(--slate-12)] font-semibold border-hairline border-[var(--slate-7)]"
                          : "border-hairline border-transparent text-[var(--slate-11)] hover:text-[var(--slate-12)] hover:bg-[var(--slate-3)]"
                      }`}
                      onClick={() => setActiveTab(id)}
                      role="tab"
                      type="button"
                    >
                      <IconComp
                        className={`w-3.5 h-3.5 transition-colors duration-[250ms] ease-out ${
                          isActive ? "text-[var(--blue-9)]" : "text-[var(--slate-10)]"
                        }`}
                      />
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>
            </header>

            {activeTab === "local" ? <PlaylistsWorkspacePage embedded playlistView="local" /> : null}
            {activeTab === "network" ? <PlaylistsWorkspacePage embedded playlistView="network" /> : null}
            {activeTab === "favorites" ? <FavoriteAlbumsPage embedded fixedHeight={false} showTitle={false} /> : null}
            {activeTab === "alist" ? <AlistPlaylistsView /> : null}
          </>
        ) : null}
      </div>
    </main>
  );
}
