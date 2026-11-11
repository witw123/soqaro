"use client";

import { useMemo, useRef, useState } from "react";
import { Play } from "lucide-react";
import type { RoomMember, RoomTrackDistributionState, TrackMeta } from "@soqaro/shared";
import { resolveTrackDistributionStatus } from "@soqaro/shared";
import { AnchoredDialog, getAnchoredDialogAnchor, type AnchoredDialogAnchor } from "@/components/ui/anchored-dialog";
import {
  ensureRoomTrackDistributionAsset,
  prepareTrackWithLocalFile,
  useTrackAssetPreparationState,
  useTrackUnavailableReason
} from "@/features/room/playback/room-track-asset-preparation";

export type TrackDistributionBadgeProps = {
  roomId?: string | null;
  track: TrackMeta | null | undefined;
  members?: Array<Pick<RoomMember, "id" | "presenceState">> | null;
  currentSessionId?: string | null;
  className?: string;
  onPlay?: () => void;
};

type StateConfig = {
  title: string;
  dotClass: string;
  tagClass: string;
  description: string;
};

const STATE_CONFIGS: Record<RoomTrackDistributionState, StateConfig> = {
  ready: {
    title: "分发就绪",
    dotClass: "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.35)]",
    tagClass: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    description: "房间音频资产完整，源成员在线广播中，所有成员可正常同步收听。"
  },
  preparing: {
    title: "准备资产中",
    dotClass: "bg-amber-400 animate-pulse shadow-[0_0_6px_rgba(251,191,36,0.35)]",
    tagClass: "text-amber-400 bg-amber-500/10 border-amber-500/20",
    description: "源成员在线，正在准备可供房间分发的分段音频资产…"
  },
  "source-missing": {
    title: "源文件缺失",
    dotClass: "bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.35)]",
    tagClass: "text-rose-400 bg-rose-500/10 border-rose-500/20",
    description: "源成员在线但在本地未找到音频源文件，无法开始多人同步播放。"
  },
  "source-offline": {
    title: "源成员离线",
    dotClass: "bg-zinc-500",
    tagClass: "text-zinc-400 bg-zinc-500/10 border-zinc-500/20",
    description: "歌曲源成员当前离线（多人流式广播暂不可用）。若您本地拥有缓存、本地保存或开启了缓存播放，仍可直接播放。"
  },
  failed: {
    title: "准备失败",
    dotClass: "bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.35)]",
    tagClass: "text-rose-400 bg-rose-500/10 border-rose-500/20",
    description: "音频资产转换或注册失败，无法开始多人同步播放。"
  },
  unknown: {
    title: "状态未就绪",
    dotClass: "bg-zinc-600",
    tagClass: "text-zinc-400 bg-zinc-500/10 border-zinc-500/20",
    description: "曲目分发状态等待确认中。"
  }
};

export function TrackDistributionBadge({
  roomId,
  track,
  members,
  currentSessionId,
  className = "",
  onPlay
}: TrackDistributionBadgeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [anchor, setAnchor] = useState<AnchoredDialogAnchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isActionPending, setIsActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const preparationState = useTrackAssetPreparationState(track?.id);
  const unavailableReason = useTrackUnavailableReason(track?.id);

  const status = useMemo(() => {
    if (!track) return null;
    const base = resolveTrackDistributionStatus({
      track,
      members: members ?? [],
      currentSessionId,
      assetUnavailableReason: unavailableReason
    });
    if (preparationState && base.state !== "source-offline" && base.state !== "ready") {
      return { ...base, state: preparationState };
    }
    return base;
  }, [track, members, currentSessionId, preparationState, unavailableReason]);

  if (!track || !status) return null;

  const config = { ...((STATE_CONFIGS[status.state] ?? STATE_CONFIGS.unknown)) };
  if (unavailableReason === "permission-denied") {
    config.title = "权限受限";
    config.description = "本地音频目录读取权限已失效。请选择本地文件重新生成分发资产。";
  } else if (unavailableReason === "asset-corrupt") {
    config.title = "资产损坏";
    config.description = "本地分段音频数据损坏或不完整。请重试准备或重新选择本地音频文件。";
  } else if (unavailableReason === "source-missing") {
    config.title = "音频源缺失";
    config.description = "未找到可读取的原始音频文件，无法开始多人同步播放。";
  }

  const isOwner = Boolean(currentSessionId && currentSessionId === track.ownerSessionId);
  const canManageAsset = isOwner && (status.state === "source-missing" || status.state === "failed");

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();
    if (triggerRef.current) {
      setAnchor(getAnchoredDialogAnchor(triggerRef.current));
      setActionError(null);
      setIsOpen((prev) => !prev);
    }
  };

  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!roomId || !track) return;
    setIsActionPending(true);
    setActionError(null);
    try {
      await ensureRoomTrackDistributionAsset(roomId, track);
    } catch (err) {
      setActionError((err as Error).message || "重试准备失败");
    } finally {
      setIsActionPending(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !roomId || !track) return;
    setIsActionPending(true);
    setActionError(null);
    try {
      await prepareTrackWithLocalFile(roomId, track, file);
      setIsOpen(false);
    } catch (err) {
      setActionError((err as Error).message || "选择文件处理失败");
    } finally {
      setIsActionPending(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const providerLabel = track.sourceType === "local_upload"
    ? "本地上传"
    : track.sourceType === "netease"
      ? "网易云音乐"
      : track.sourceType === "qqmusic"
        ? "QQ 音乐"
        : track.sourceType;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="track-distribution-badge"
        aria-label={`曲目资产状态: ${config.title}`}
        title={`曲目资产状态: ${config.title}`}
        onClick={handleClick}
        className={`absolute -bottom-0.5 -right-0.5 z-10 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-surface border border-surface-border transition-transform hover:scale-125 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ${className}`}
      >
        <span className={`h-2 w-2 rounded-full ${config.dotClass}`} />
      </button>

      {isOpen && anchor ? (
        <AnchoredDialog
          anchor={anchor}
          ariaLabelledBy={`dist-badge-${track.id}`}
          onClose={() => setIsOpen(false)}
          compact
          className="w-72 max-w-[calc(100vw-32px)] rounded-xl border border-surface-border bg-surface p-3.5 shadow-lg backdrop-blur-md"
        >
          <div id={`dist-badge-${track.id}`} className="space-y-2.5 text-xs text-foreground">
            <div className="flex items-center justify-between border-b border-surface-border/60 pb-2">
              <div className="flex items-center gap-1.5 font-medium">
                <span className={`h-2 w-2 rounded-full ${config.dotClass}`} />
                <span>{config.title}</span>
              </div>
              <span className={`rounded px-1.5 py-0.5 text-xs font-mono border ${config.tagClass}`}>
                {status.state}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-foreground-muted">
              {config.description}
            </p>

            {actionError ? (
              <p className="rounded bg-rose-500/10 p-1.5 text-xs text-rose-400 border border-rose-500/20">
                {actionError}
              </p>
            ) : null}

            <div className="space-y-1 rounded-lg bg-surface/40 p-2 text-xs text-foreground-muted">
              <div className="flex justify-between">
                <span>持有人</span>
                <span className="font-medium text-foreground">{track.ownerNickname || "未知成员"}</span>
              </div>
              <div className="flex justify-between">
                <span>曲目来源</span>
                <span className="font-medium text-foreground">{providerLabel}</span>
              </div>
              {track.playbackAsset?.assetId ? (
                <div className="flex justify-between font-mono">
                  <span>分段资产</span>
                  <span className="text-foreground">{track.playbackAsset.assetId.slice(0, 10)}…</span>
                </div>
              ) : null}
            </div>

            {onPlay ? (
              <div className="pt-2 border-t border-surface-border/40">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsOpen(false);
                    onPlay();
                  }}
                  className="w-full flex items-center justify-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20 cursor-pointer"
                >
                  <Play size={13} fill="currentColor" />
                  <span>播放曲目</span>
                </button>
              </div>
            ) : null}

            {canManageAsset && roomId ? (
              <div className="flex items-center gap-2 pt-1 border-t border-surface-border/40">
                <button
                  type="button"
                  disabled={isActionPending}
                  onClick={handleRetry}
                  className="flex-1 rounded-md border border-surface-border bg-surface/60 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-elevated disabled:opacity-50"
                >
                  {isActionPending ? "处理中…" : "重试准备"}
                </button>
                <button
                  type="button"
                  disabled={isActionPending}
                  onClick={() => fileInputRef.current?.click()}
                  className="flex-1 rounded-md border border-accent/30 bg-accent/10 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
                >
                  选择本地文件
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </div>
            ) : null}
          </div>
        </AnchoredDialog>
      ) : null}
    </>
  );
}
