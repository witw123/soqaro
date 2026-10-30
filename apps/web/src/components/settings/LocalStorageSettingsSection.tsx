"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  clearLocalOtherFiles,
  clearLocalAudioCache,
  clearSavedLocalAudio,
  chooseLocalAudioDirectory,
  getLocalAudioStorageStats,
  getLocalAudioStorageState,
  requestLocalAudioDirectoryPermission,
  type LocalAudioStorageState
} from "@/features/library/local-audio-storage";
import {
  cancelSelectedLocalDirectorySync,
  syncSelectedLocalDirectoryTracks
} from "@/features/playlist/local-playlist";
import { useWorkspacePageActive } from "@/features/workspace/page-activity";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function LocalStorageManagementCard() {
  const pageActive = useWorkspacePageActive();
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [state, setState] = useState<LocalAudioStorageState | null>(null);
  const [cacheBytes, setCacheBytes] = useState(0);
  const [cachedTrackCount, setCachedTrackCount] = useState(0);
  const [savedBytes, setSavedBytes] = useState(0);
  const [savedTrackCount, setSavedTrackCount] = useState(0);
  const [otherBytes, setOtherBytes] = useState(0);
  const [otherFileCount, setOtherFileCount] = useState(0);
  const [pendingAction, setPendingAction] = useState<"choose" | "scan" | "authorize" | "clean-cache" | "clean-saved" | "clean-other" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => Promise<void>;
  } | null>(null);
  const pending = pendingAction !== null;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoadFailed(false);
    const nextState = await getLocalAudioStorageState();
    if (signal?.aborted) return;
    setState(nextState);
    const stats = await getLocalAudioStorageStats();
    if (signal?.aborted) return;
    setCachedTrackCount(stats.cache.fileCount);
    setCacheBytes(stats.cache.bytes);
    setSavedTrackCount(stats.saved.fileCount);
    setSavedBytes(stats.saved.bytes);
    setOtherFileCount(stats.other.fileCount);
    setLoaded(true);
    setOtherBytes(stats.other.bytes);
  }, []);

  useEffect(() => {
    if (!pageActive) return;
    const controller = new AbortController();
    void refresh(controller.signal).catch(() => {
      if (!controller.signal.aborted) {
        setLoadFailed(true);
        setMessage("无法读取本地目录状态。");
      }
    });
    return () => {
      controller.abort();
    };
  }, [refresh, pageActive]);

  const choose = async () => {
    if (pending) return;
    setPendingAction("choose");
    setMessage(null);
    try {
      cancelSelectedLocalDirectorySync();
      await chooseLocalAudioDirectory();
      await syncSelectedLocalDirectoryTracks().catch(() => null);
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "选择本地目录失败，请重试。");
    } finally {
      setPendingAction(null);
    }
  };

  const scan = async () => {
    setPendingAction("scan");
    setMessage(null);
    try {
      const count = await syncSelectedLocalDirectoryTracks();
      await refresh();
      setMessage(`目录检查完成，共 ${count} 首来源歌曲。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "检查目录失败。");
    } finally {
      setPendingAction(null);
    }
  };

  const authorize = async () => {
    setPendingAction("authorize");
    try {
      if (!(await requestLocalAudioDirectoryPermission())) throw new Error("目录授权未完成。");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "目录授权失败。");
    } finally {
      setPendingAction(null);
    }
  };

  const executeCleanCache = async () => {
    setPendingAction("clean-cache");
    setMessage(null);
    try {
      const result = await clearLocalAudioCache();
      await refresh();
      setMessage(
        result.failedEntryCount > 0
          ? `已清理 ${result.deletedEntryCount} 个缓存音频，${result.failedEntryCount} 个缓存因目录权限未能清理。`
          : result.deletedEntryCount > 0
            ? `已清理 ${result.deletedEntryCount} 个缓存音频。`
          : "没有发现缓存音频。"
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "清理缓存失败，请重试。");
    } finally {
      setPendingAction(null);
    }
  };

  const cleanCache = () => {
    if (pending) return;
    setConfirmDialog({
      title: "清理缓存音频",
      description: "确定清理全部缓存音频吗？已保存歌曲和本地歌单不会被删除。",
      confirmLabel: "清理",
      onConfirm: executeCleanCache
    });
  };

  const executeCleanSaved = async () => {
    setPendingAction("clean-saved");
    setMessage(null);
    try {
      const result = await clearSavedLocalAudio();
      await refresh();
      setMessage(
        result.failedEntryCount > 0
          ? `已清理 ${result.deletedEntryCount} 首本地歌曲，${result.failedEntryCount} 首因目录权限未能清理。`
          : result.skippedExternalCount > 0
            ? `已清理 ${result.deletedEntryCount} 首本地歌曲，跳过 ${result.skippedExternalCount} 首目录原文件。`
            : result.deletedEntryCount > 0
              ? `已清理 ${result.deletedEntryCount} 首本地歌曲。`
              : "没有发现可清理的本地歌曲。"
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "清理本地歌曲失败，请重试。");
    } finally {
      setPendingAction(null);
    }
  };

  const cleanSaved = () => {
    if (pending) return;
    setConfirmDialog({
      title: "清理本地歌曲",
      description: "确定清理已保存的本地歌曲吗？选择目录中的原始文件不会被删除。",
      confirmLabel: "清理",
      onConfirm: executeCleanSaved
    });
  };

  const executeCleanOther = async () => {
    setPendingAction("clean-other");
    setMessage(null);
    try {
      const result = await clearLocalOtherFiles();
      await refresh();
      setMessage(
        result.failedEntryCount > 0
          ? `已清理 ${result.deletedEntryCount} 个其他文件，${result.failedEntryCount} 个文件未能清理。`
          : result.deletedEntryCount > 0
            ? `已清理 ${result.deletedEntryCount} 个其他文件。`
            : "没有发现可清理的其他文件。"
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "清理其他文件失败，请重试。");
    } finally {
      setPendingAction(null);
    }
  };

  const cleanOther = () => {
    if (pending) return;
    setConfirmDialog({
      title: "清理辅助文件",
      description: "确定清理封面、歌词和其他辅助文件吗？本地歌曲和歌单不会被删除。",
      confirmLabel: "清理",
      onConfirm: executeCleanOther
    });
  };

  return (
    <section className="mt-8 border-b border-surface-border pb-5" data-testid="local-storage-management">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">本地存储</h2>
          <p className="mt-1 text-xs leading-5 text-foreground-muted">
            管理下载歌曲、封面、歌词和浏览器缓存所在的位置。
          </p>
          <p className="mt-3 truncate text-xs text-foreground-muted" title={state?.directoryName ?? undefined}>
            {state?.directoryName ? `根目录：${state.directoryName}` : state ? "尚未选择根目录" : "正在读取根目录…"}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          {state?.directoryName && state.permission !== "granted" && !state.fixedRoot ? (
            <Button disabled={pending} onClick={() => void authorize()} size="sm" variant="outline">重新授权</Button>
          ) : null}
          {state?.directoryName && state.permission === "granted" && !state.fixedRoot ? (
            <Button disabled={pending} onClick={() => void scan()} size="sm" variant="outline">
              {pendingAction === "scan" ? "检查中…" : "检查目录"}
            </Button>
          ) : null}
          {state?.supported ? (
            <Button
              data-testid="choose-local-folder-button"
              disabled={pending}
              onClick={() => void choose()}
              size="sm"
              type="button"
              variant="outline"
            >
              {pendingAction === "choose" ? "选择中…" : state.directoryName ? "更改保存目录" : "选择保存目录"}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="mt-5 grid gap-3 lg:grid-cols-3">
        <StorageSection
          dataTestId="local-storage-cache"
          description="浏览器播放缓存和本地缓存音频"
          disabled={pending || !loaded || cachedTrackCount === 0}
          label="播放缓存"
          onClean={() => void cleanCache()}
          pending={pendingAction === "clean-cache"}
          summary={loadFailed ? "无法读取" : loaded ? `${formatBytes(cacheBytes)} (${cachedTrackCount} 首音频)` : "读取中…"}
          actionLabel="清理缓存"
        />
        <StorageSection
          dataTestId="local-storage-saved"
          description="已保存到 Soqaro 目录的本地歌曲"
          disabled={pending || !loaded || state?.permission !== "granted" || savedTrackCount === 0}
          label="本地歌曲"
          onClean={() => void cleanSaved()}
          pending={pendingAction === "clean-saved"}
          summary={loadFailed ? "无法读取" : loaded ? `${formatBytes(savedBytes)} (${savedTrackCount} 首歌曲)` : "读取中…"}
          actionLabel="清理本地歌曲"
        />
        <StorageSection
          dataTestId="local-storage-other"
          description="封面、歌词和其他辅助文件"
          disabled={pending || !loaded || state?.permission !== "granted" || otherFileCount === 0}
          label="其他文件"
          onClean={() => void cleanOther()}
          pending={pendingAction === "clean-other"}
          summary={loadFailed ? "无法读取" : loaded ? `${formatBytes(otherBytes)} (${otherFileCount} 个文件)` : "读取中…"}
          actionLabel="清理其他文件"
        />
      </div>
      {state?.supported === false && !state.fixedRoot ? <p className="mt-3 text-xs text-amber-300">当前浏览器不支持选择本地文件夹，请使用 Chrome 或 Edge。</p> : null}
      {message ? <p className="mt-3 text-xs text-foreground-muted" role="status">{message}</p> : null}
      {confirmDialog ? (
        <ConfirmDialog
          confirmLabel={confirmDialog.confirmLabel}
          description={confirmDialog.description}
          destructive
          onCancel={() => setConfirmDialog(null)}
          onConfirm={async () => {
            const action = confirmDialog.onConfirm;
            setConfirmDialog(null);
            await action();
          }}
          open
          pending={pending}
          title={confirmDialog.title}
        />
      ) : null}
    </section>
  );
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function StorageSection({
  actionLabel,
  dataTestId,
  description,
  disabled,
  label,
  onClean,
  pending,
  summary
}: {
  actionLabel: string;
  dataTestId: string;
  description: string;
  disabled: boolean;
  label: string;
  onClean: () => void;
  pending: boolean;
  summary: string;
}) {
  return (
    <div className="flex flex-col justify-between rounded-lg border border-surface-border bg-surface/30 p-4" data-testid={dataTestId}>
      <div>
        <h3 className="text-sm font-semibold text-foreground">{label}</h3>
        <p className="mt-1 text-xs leading-5 text-foreground-muted">{description}</p>
        <p className="mt-3 text-sm font-medium tabular-nums text-foreground">{summary}</p>
      </div>
      <Button
        className="mt-4 w-fit"
        disabled={disabled}
        onClick={onClean}
        size="sm"
        type="button"
        variant="outline"
      >
        {pending ? "清理中…" : actionLabel}
      </Button>
    </div>
  );
}
