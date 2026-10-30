"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { AlistAudioItem, AlistConfig } from "@soqaro/shared";
import { useAlistStorage } from "@/features/settings/use-alist-storage";
import { soqaroApi } from "@/lib/network/soqaro-api";
import { useLocalPlayer } from "@/features/playback/local-player-context";
import type { LocalPlaylistTrackRecord } from "@/features/playlist/local-playlist";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import {
  FolderIcon,
  PlayIcon,
  RotateCcwIcon,
  SettingsIcon,
  CheckIcon,
  CloseIcon
} from "@/components/icons/DiscoverIcons";

export function AlistPlaylistsView() {
  const {
    config,
    isConfigured,
    testing,
    testResult,
    saveConfig,
    removeConfig,
    testConnection
  } = useAlistStorage();

  const player = useLocalPlayer();

  // Setup form states
  const [inputUrl, setInputUrl] = useState(config?.url ?? "http://localhost:5244");
  const [inputPath, setInputPath] = useState(config?.mountPath ?? "/Music");
  const [inputToken, setInputToken] = useState(config?.token ?? "");
  const [showConfigDrawer, setShowConfigDrawer] = useState(false);

  // Directory state
  const [currentPath, setCurrentPath] = useState(config?.mountPath ?? "/Music");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [directories, setDirectories] = useState<string[]>([]);
  const [audioItems, setAudioItems] = useState<AlistAudioItem[]>([]);
  const [playingTrackPath, setPlayingTrackPath] = useState<string | null>(null);

  // Sync state if config changes
  useEffect(() => {
    if (config) {
      setInputUrl(config.url);
      setInputPath(config.mountPath || "/Music");
      setInputToken(config.token || "");
      setCurrentPath(config.mountPath || "/Music");
    }
  }, [config]);

  const loadDirectory = useCallback(async (dirPath: string) => {
    if (!config?.url) return;
    setLoading(true);
    setError(null);
    try {
      const res = await soqaroApi.listAlistDirectory({
        url: config.url,
        path: dirPath,
        refresh: false,
        token: config.token
      });
      setDirectories(res.directories ?? []);
      setAudioItems(res.items ?? []);
      setCurrentPath(res.currentPath ?? dirPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取网盘目录失败，请检查网络或 Alist 状态。");
    } finally {
      setLoading(false);
    }
  }, [config]);

  useEffect(() => {
    if (isConfigured && config?.url) {
      void loadDirectory(currentPath);
    }
  }, [isConfigured, config?.url, loadDirectory, currentPath]);

  // Navigate deeper into subdirectory
  const handleNavigateSubdir = (dirName: string) => {
    const nextPath = currentPath.endsWith("/")
      ? `${currentPath}${dirName}`
      : `${currentPath}/${dirName}`;
    void loadDirectory(nextPath);
  };

  // Breadcrumb navigation
  const handleBreadcrumbClick = (targetIndex: number, parts: string[]) => {
    const selected = parts.slice(0, targetIndex + 1);
    const nextPath = "/" + selected.join("/");
    void loadDirectory(nextPath);
  };

  const breadcrumbParts = currentPath.split("/").filter(Boolean);

  // Convert an AlistAudioItem to a playable LocalPlaylistTrackRecord
  const buildTrackRecord = async (item: AlistAudioItem): Promise<LocalPlaylistTrackRecord> => {
    if (!config?.url) throw new Error("Alist 未配置");

    const fileDetail = await soqaroApi.getAlistFile({
      url: config.url,
      path: item.path,
      token: config.token
    });

    const streamUrl = soqaroApi.getAlistStreamUrl(fileDetail.rawUrl);

    // Try to fetch LRC lyrics if available
    let lyrics: string | null = null;
    if (item.lrcPath) {
      try {
        const lrcDetail = await soqaroApi.getAlistFile({
          url: config.url,
          path: item.lrcPath,
          token: config.token
        });
        const lrcRes = await fetch(soqaroApi.getAlistStreamUrl(lrcDetail.rawUrl));
        if (lrcRes.ok) {
          lyrics = await lrcRes.text();
        }
      } catch {
        // ignore lyrics fetch failure
      }
    }

    return {
      id: `alist:${item.path}`,
      title: item.title,
      artist: item.artist,
      album: item.album ?? null,
      durationMs: 0,
      mimeType: item.ext ? `audio/${item.ext}` : "audio/mpeg",
      sizeBytes: item.sizeBytes,
      artworkUrl: null,
      lyrics,
      provider: "alist",
      providerTrackId: item.path,
      fileHash: `alist:${item.path}`,
      fileName: streamUrl,
      availableOffline: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  };

  // Play single track
  const handlePlayItem = async (item: AlistAudioItem) => {
    try {
      setPlayingTrackPath(item.path);
      const record = await buildTrackRecord(item);
      await player.playTrack(record);
    } catch (err) {
      setError(err instanceof Error ? `播放失败: ${err.message}` : "播放失败，请检查网络或媒体文件。");
    } finally {
      setPlayingTrackPath(null);
    }
  };

  // Play all tracks in current directory
  const handlePlayAll = async () => {
    if (audioItems.length === 0) return;
    try {
      setLoading(true);
      const initialIndex = player.playbackMode === "shuffle"
        ? Math.floor(Math.random() * audioItems.length)
        : 0;
      const first = audioItems[initialIndex]!;
      setPlayingTrackPath(first.path);
      const firstRecord = await buildTrackRecord(first);
      await player.playTracks([firstRecord], 0);

      // Preload the rest asynchronously into player queue
      for (let i = 0; i < audioItems.length; i++) {
        if (i === initialIndex) continue;
        const other = audioItems[i]!;
        void buildTrackRecord(other).then((rec) => {
          player.addToQueue(rec);
        });
      }
    } catch (err) {
      setError(err instanceof Error ? `播放出错: ${err.message}` : "播放出错，请检查网络或媒体文件。");
    } finally {
      setLoading(false);
      setPlayingTrackPath(null);
    }
  };

  const handleSaveSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    const newConfig: AlistConfig = {
      url: inputUrl.trim(),
      mountPath: inputPath.trim() || "/Music",
      token: inputToken.trim() || undefined
    };
    const test = await testConnection(newConfig);
    if (test.ok) {
      saveConfig(newConfig);
      setShowConfigDrawer(false);
    }
  };

  // 1. Unconfigured State View
  if (!isConfigured) {
    return (
      <div className="max-w-xl mx-auto px-4 py-8">
        <div className="rounded-2xl border border-surface-border bg-surface p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-3">
            <span className="p-2 rounded-xl bg-accent/10 text-accent">
              <FolderIcon className="w-5 h-5" />
            </span>
            <h2 className="text-base sm:text-lg font-semibold text-foreground">连接 Alist 网盘</h2>
          </div>
          <p className="text-xs sm:text-sm text-foreground-muted mb-6 leading-relaxed">
            连接自建的 Alist 服务，直接在线流式点播已挂载的阿里云盘、百度网盘、115 或本地磁盘中的音乐目录，无需下载到本地。
          </p>

          <form onSubmit={handleSaveSetup} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-foreground-muted mb-1.5">
                Alist 服务地址
              </label>
              <input
                type="url"
                required
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                placeholder="例如 http://192.168.1.100:5244 或 https://pan.example.com"
                className="w-full px-3.5 py-2 text-sm rounded-xl border border-surface-border bg-surface-muted focus:outline-none focus:border-accent text-foreground"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground-muted mb-1.5">
                音乐挂载根目录
              </label>
              <input
                type="text"
                required
                value={inputPath}
                onChange={(e) => setInputPath(e.target.value)}
                placeholder="/Music 或 /"
                className="w-full px-3.5 py-2 text-sm rounded-xl border border-surface-border bg-surface-muted focus:outline-none focus:border-accent text-foreground"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground-muted mb-1.5">
                Alist API Token（可选，如开启了私有鉴权）
              </label>
              <input
                type="password"
                value={inputToken}
                onChange={(e) => setInputToken(e.target.value)}
                placeholder="alist-xxxx"
                className="w-full px-3.5 py-2 text-sm rounded-xl border border-surface-border bg-surface-muted focus:outline-none focus:border-accent text-foreground"
              />
            </div>

            {testResult ? (
              <div
                className={`flex items-start gap-2 p-3 rounded-xl text-xs font-medium ${
                  testResult.ok
                    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                    : "bg-red-500/10 text-red-400 border border-red-500/20"
                }`}
              >
                {testResult.ok ? <CheckIcon className="w-4 h-4 shrink-0 mt-0.5" /> : <CloseIcon className="w-4 h-4 shrink-0 mt-0.5" />}
                <span>{testResult.message}</span>
              </div>
            ) : null}

            <div className="pt-2 flex items-center justify-end gap-3">
              <button
                type="button"
                disabled={testing}
                onClick={() =>
                  void testConnection({
                    url: inputUrl.trim(),
                    mountPath: inputPath.trim() || "/Music",
                    token: inputToken.trim() || undefined
                  })
                }
                className="px-4 py-2 text-xs sm:text-sm font-medium rounded-lg border border-surface-border hover:bg-surface-hover transition-colors text-foreground-muted"
              >
                {testing ? "测试中..." : "测试连接"}
              </button>
              <button
                type="submit"
                disabled={testing}
                className="px-5 py-2 text-xs sm:text-sm font-semibold rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
              >
                保存并连接
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // 2. Configured File Manager View
  return (
    <div className="max-w-5xl mx-auto px-4 py-4 space-y-4">
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 sm:p-4 rounded-xl border border-surface-border bg-surface/50">
        {/* Breadcrumbs */}
        <div className="flex items-center gap-1.5 text-xs sm:text-sm font-medium overflow-x-auto hide-scrollbar py-1">
          <button
            onClick={() => void loadDirectory(config?.mountPath || "/Music")}
            className="text-foreground-muted hover:text-foreground transition-colors flex items-center gap-1 shrink-0"
          >
            <FolderIcon className="w-4 h-4 text-accent" />
            <span>{config?.mountPath || "根目录"}</span>
          </button>
          {breadcrumbParts.map((part, index) => {
            const isLast = index === breadcrumbParts.length - 1;
            return (
              <React.Fragment key={`${part}-${index}`}>
                <span className="text-foreground-muted/40">/</span>
                {isLast ? (
                  <span className="text-foreground font-semibold shrink-0">{part}</span>
                ) : (
                  <button
                    onClick={() => handleBreadcrumbClick(index, breadcrumbParts)}
                    className="text-foreground-muted hover:text-foreground transition-colors shrink-0"
                  >
                    {part}
                  </button>
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => void loadDirectory(currentPath)}
            disabled={loading}
            title="刷新当前目录"
            className="h-8 w-8 rounded-lg border border-surface-border text-foreground-muted hover:text-foreground hover:bg-surface-hover flex items-center justify-center transition-colors disabled:opacity-50"
          >
            <RotateCcwIcon className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            onClick={() => setShowConfigDrawer(true)}
            title="网盘连接配置"
            className="h-8 w-8 rounded-lg border border-surface-border text-foreground-muted hover:text-foreground hover:bg-surface-hover flex items-center justify-center transition-colors"
          >
            <SettingsIcon className="w-3.5 h-3.5" />
          </button>
          {audioItems.length > 0 ? (
            <button
              onClick={() => void handlePlayAll()}
              disabled={loading}
              className="inline-flex h-8 items-center gap-1.5 px-3.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors"
            >
              <PlayIcon className="w-3.5 h-3.5" />
              <span>播放全部 ({audioItems.length})</span>
            </button>
          ) : null}
        </div>
      </div>

      {/* Error state */}
      {error ? (
        <div className="p-3.5 rounded-xl border border-rose-500/20 bg-rose-500/10 text-rose-500 text-xs sm:text-sm flex items-center justify-between">
          <span>{error}</span>
          <button
            onClick={() => void loadDirectory(currentPath)}
            className="underline hover:no-underline font-semibold ml-2"
          >
            重试
          </button>
        </div>
      ) : null}

      {/* Subdirectories chips */}
      {directories.length > 0 ? (
        <div className="space-y-1.5">
          <h3 className="text-xs font-medium text-foreground-muted px-1">
            子文件夹 ({directories.length})
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {directories.map((dir) => (
              <button
                key={dir}
                onClick={() => handleNavigateSubdir(dir)}
                className="flex items-center gap-2 p-2 rounded-lg border border-surface-border bg-surface hover:bg-surface-hover text-left text-xs sm:text-sm text-foreground transition-colors group"
              >
                <FolderIcon className="w-3.5 h-3.5 text-accent/80 group-hover:text-accent shrink-0" />
                <span className="truncate font-medium">{dir}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Audio Items List */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-xs font-medium text-foreground-muted">
            音频曲目 ({audioItems.length})
          </h3>
        </div>

        {audioItems.length === 0 && !loading ? (
          <div className="py-10 text-center rounded-xl border border-dashed border-surface-border bg-surface/30">
            <p className="text-sm font-medium text-foreground-muted">当前目录没有可播放的音频文件</p>
            <p className="text-xs text-foreground-muted/60 mt-1">支持 .flac, .mp3, .wav, .m4a, .ogg, .opus 等格式</p>
          </div>
        ) : (
          <div className="rounded-xl border border-surface-border bg-surface/40 divide-y divide-surface-border/50 overflow-hidden">
            {audioItems.map((item, index) => {
              const isPlayingThis = playingTrackPath === item.path;
              const formatSize = (item.sizeBytes / 1024 / 1024).toFixed(1);

              return (
                <div
                  key={item.path}
                  className="flex items-center justify-between px-3.5 py-2 hover:bg-surface-hover/60 transition-colors group"
                >
                  <div className="flex items-center gap-3 min-w-0 pr-4">
                    <span className="text-xs font-mono text-foreground-muted/40 w-5 text-center shrink-0">
                      {index + 1}
                    </span>
                    <button
                      onClick={() => void handlePlayItem(item)}
                      disabled={isPlayingThis}
                      className="p-1.5 rounded-lg bg-surface hover:bg-accent hover:text-white text-foreground transition-all shrink-0 border border-surface-border"
                      title="立即播放"
                    >
                      <PlayIcon className="w-3.5 h-3.5" />
                    </button>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs sm:text-sm font-medium text-foreground truncate">
                          {item.title}
                        </span>
                        {item.ext ? (
                          <span className="uppercase px-1.5 py-0.5 rounded text-xs font-mono font-medium bg-surface border border-surface-border text-foreground-muted shrink-0">
                            {item.ext}
                          </span>
                        ) : null}
                        {item.lrcPath ? (
                          <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                            LRC
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs text-foreground-muted truncate mt-0.5">
                        {item.artist} / {formatSize} MB
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={async () => {
                        try {
                          const record = await buildTrackRecord(item);
                          player.addToQueue(record);
                        } catch {
                          // ignore
                        }
                      }}
                      className="h-7 px-2.5 rounded-md text-xs font-medium border border-surface-border bg-surface text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors opacity-0 group-hover:opacity-100 sm:opacity-100"
                    >
                      + 队列
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Settings Modal/Drawer */}
      <Dialog open={showConfigDrawer} onOpenChange={setShowConfigDrawer}>
        <DialogContent className="max-w-md p-6">
          <DialogHeader className="pr-6">
            <DialogTitle className="text-base font-semibold text-foreground">
              修改 Alist 网盘设置
            </DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSaveSetup} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-foreground-muted mb-1">
                Alist 服务地址
              </label>
              <input
                type="url"
                required
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-xl border border-surface-border bg-surface-muted focus:outline-none focus:border-accent text-foreground"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground-muted mb-1">
                音乐挂载根路径
              </label>
              <input
                type="text"
                required
                value={inputPath}
                onChange={(e) => setInputPath(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-xl border border-surface-border bg-surface-muted focus:outline-none focus:border-accent text-foreground"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground-muted mb-1">
                访问 Token（可选）
              </label>
              <input
                type="password"
                value={inputToken}
                onChange={(e) => setInputToken(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-xl border border-surface-border bg-surface-muted focus:outline-none focus:border-accent text-foreground"
              />
            </div>

            {testResult ? (
              <div
                className={`p-2.5 rounded-xl text-xs ${
                  testResult.ok ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                }`}
              >
                {testResult.message}
              </div>
            ) : null}

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={() => {
                  removeConfig();
                  setShowConfigDrawer(false);
                }}
                className="text-xs text-red-400 hover:underline"
              >
                断开连接
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={testing}
                  onClick={() =>
                    void testConnection({
                      url: inputUrl.trim(),
                      mountPath: inputPath.trim() || "/Music",
                      token: inputToken.trim() || undefined
                    })
                  }
                  className="px-3 py-1.5 text-xs font-medium rounded-xl border border-surface-border hover:bg-white/5 transition-colors cursor-pointer"
                >
                  {testing ? "测试中..." : "测试"}
                </button>
                <button
                  type="submit"
                  disabled={testing}
                  className="px-4 py-1.5 text-xs font-semibold rounded-xl bg-accent text-accent-contrast hover:opacity-90 transition-opacity cursor-pointer"
                >
                  保存
                </button>
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
