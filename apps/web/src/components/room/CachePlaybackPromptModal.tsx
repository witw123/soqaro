"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import type { TrackMeta } from "@soqaro/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "@/components/ui/dialog";
import { useBackHandler } from "@/lib/desktop/use-back-handler";
import { checkAnyProviderAccountBound } from "@/features/playback/provider-account-guard";
import { updateAppSettings } from "@/features/settings/settings-store";
import { resolveProviderTrackSource } from "@/features/library/provider-track-identity";
import { providerDisplayName } from "@/lib/domain/provider-labels";

type CachePlaybackPromptModalProps = {
  isOpen: boolean;
  track: TrackMeta | null;
  isSourceOwner?: boolean;
  onClose: () => void;
  onEnabled?: () => void;
};

export function CachePlaybackPromptModal({
  isOpen,
  track,
  isSourceOwner = false,
  onClose,
  onEnabled
}: CachePlaybackPromptModalProps) {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [requiresBinding, setRequiresBinding] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setRequiresBinding(false);
      setChecking(false);
    }
  }, [isOpen, track?.id]);

  useBackHandler(onClose, isOpen);

  if (!isOpen || !track) return null;

  const providerSource = resolveProviderTrackSource(track);
  const platformName = providerSource ? providerDisplayName(providerSource.provider) : "音乐平台";

  const handleEnableCache = async () => {
    setChecking(true);
    try {
      const status = await checkAnyProviderAccountBound();
      if (!status.bound) {
        setRequiresBinding(true);
        setChecking(false);
        return;
      }

      updateAppSettings({
        playback: {
          fullyCachedPlayback: true,
          streamingOnlyPlayback: false
        }
      });
      onEnabled?.();
      onClose();
    } catch {
      setRequiresBinding(true);
    } finally {
      setChecking(false);
    }
  };

  const handleGoToBind = () => {
    onClose();
    router.push("/app/profile" as Route);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md p-6">
        <DialogHeader className="pr-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-surface-border bg-surface text-accent">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
                <path d="M12 12v9" />
                <path d="m8 17 4 4 4-4" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base font-semibold text-foreground tracking-tight">
                {requiresBinding ? "需要绑定平台账号" : isSourceOwner ? "缺少房间音频资产" : "开启平台歌曲缓存播放"}
              </DialogTitle>
              <DialogDescription className="text-xs text-foreground-muted truncate">
                {track.title} {track.artist ? `- ${track.artist}` : ""}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="text-xs">
          {requiresBinding ? (
            <div className="flex flex-col gap-2 rounded-lg border border-surface-border bg-surface/60 p-4 leading-relaxed">
              <p className="font-medium text-foreground">
                开启平台歌曲缓存播放前，请先绑定网易云音乐或 QQ 音乐账号。
              </p>
              <p className="text-foreground-muted">
                {isSourceOwner
                  ? `当前歌曲来自${platformName}，绑定账号并开启缓存播放后可下载音频并向房间广播。`
                  : `当前歌曲来自${platformName}，绑定账号后可自动缓存到本地播放。`}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-surface-border bg-surface/60 p-4 leading-relaxed">
              <p className="text-foreground">
                歌曲《{track.title}》缺少可用的房间音频资产。
              </p>
              <p className="text-foreground-muted">
                {isSourceOwner
                  ? `开启平台歌曲缓存播放后，可通过已绑定的${platformName}账号下载音频并向房间广播。`
                  : `开启平台歌曲缓存播放后，可通过已绑定的${platformName}账号缓存到本地播放。`}
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2.5 pt-2">
          <Button
            onClick={onClose}
            size="sm"
            type="button"
            variant="ghost"
          >
            {requiresBinding ? "稍后再说" : "暂不开启"}
          </Button>
          {requiresBinding ? (
            <Button
              onClick={handleGoToBind}
              size="sm"
              type="button"
            >
              前往绑定账号
            </Button>
          ) : (
            <Button
              disabled={checking}
              onClick={handleEnableCache}
              size="sm"
              type="button"
            >
              {checking ? "正在检查账号..." : "开启缓存播放"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
