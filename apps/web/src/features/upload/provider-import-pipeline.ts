import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  GuestSession,
  ProviderTrackCandidate,
  RoomSnapshot,
  TrackMeta,
  TrackSourceType
} from "@soqaro/shared";
import {
  getCachedLibraryTrackByProviderTrack,
  getCachedLibraryTrackSummaryByProviderTrack,
  linkTrackAssets
} from "@/features/library/indexeddb";
import { soqaroApi } from "@/lib/network/soqaro-api";
import { buildTrackMeta, type UploadedTrack } from "@/features/library/audio-utils";
import {
  getReusableAudioAssets,
  prepareAudioAssets
} from "@/features/library/audio-asset-builder";
import { importTaskStore, mapAssetPreparationProgress } from "./import-task-store";
import { buildRegisterTrackPayload } from "./upload-pipeline";
import { toCachedLibraryFile } from "@/features/library/cache-library";
import { resolveLocalArtworkUrl } from "@/features/library/audio-metadata";
import { getConfiguredLocalRepository } from "@/features/library/local-audio-storage";
import { hasRoomPermission } from "@/features/room/room-permissions";
import {
  buildProviderSourceRef,
  extensionForImportedMimeType,
  requestProviderLyricsPayload,
  resolveImportedAudioMimeType,
  sanitizeFileName,
  sourceTypeLabel
} from "./upload-import-helpers";

export type { ProviderTrackCandidate };

export type PreparedProviderImport = {
  candidate: ProviderTrackCandidate;
  file: File;
  draft: Omit<TrackMeta, "id"> & { id?: string };
  localArtworkUrl: string | null;
  lyrics: string | null;
};

export type PrefetchedProviderAudio = {
  cachedTrack: Awaited<ReturnType<typeof getCachedLibraryTrackByProviderTrack>> | null;
  file: File;
  assets: Awaited<ReturnType<typeof prepareAudioAssets>> | null;
};

export type PrefetchedProviderAudioResult =
  | { ok: true; audio: PrefetchedProviderAudio }
  | { ok: false; error: unknown };

const TRACK_DOWNLOAD_INACTIVITY_TIMEOUT_MS = 35_000;

export async function prefetchProviderAudio(
  candidate: ProviderTrackCandidate,
  sourceType: Exclude<TrackSourceType, "local_upload">,
  onProgress?: (progress: { loaded: number; total: number | null; percent?: number }) => void,
  outerSignal?: AbortSignal
): Promise<PrefetchedProviderAudio> {
  const timeoutCtrl = new AbortController();
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

  const resetInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(
      () => timeoutCtrl.abort(new Error(`下载《${candidate.title}》超时，请稍后重试`)),
      TRACK_DOWNLOAD_INACTIVITY_TIMEOUT_MS
    );
  };
  resetInactivityTimer();

  const abortHandler = () => timeoutCtrl.abort();
  outerSignal?.addEventListener("abort", abortHandler, { once: true });

  try {
    const cachedSummary = typeof getCachedLibraryTrackSummaryByProviderTrack === "function"
      ? await getCachedLibraryTrackSummaryByProviderTrack(sourceType, candidate.providerTrackId).catch(() => null)
      : null;
    if (cachedSummary) {
      const localRepository = await getConfiguredLocalRepository().catch(() => null);
      if (localRepository) {
        const matchingTrack = await localRepository.readTrack(cachedSummary.fileHash).catch(() => null);
        if (matchingTrack?.source?.relativePath) {
          const file = await localRepository.readPath(matchingTrack.source.relativePath).catch(() => null);
          if (file) {
            const assets = await getReusableAudioAssets({
              fileHash: matchingTrack.fileHash,
              sizeBytes: matchingTrack.sizeBytes
            }).catch(() => null);
            onProgress?.({ loaded: 1, total: 1, percent: 100 });
            return {
              cachedTrack: null,
              file,
              assets
            };
          }
        }
      }
    }

    const cachedTrack: Awaited<ReturnType<typeof getCachedLibraryTrackByProviderTrack>> | null = (
      await getCachedLibraryTrackByProviderTrack(sourceType, candidate.providerTrackId)
    ) ?? null;
    if (cachedTrack) {
      const cachedFile = toCachedLibraryFile({
        file: cachedTrack.file,
        title: candidate.title,
        mimeType: cachedTrack.mimeType,
        fileHash: cachedTrack.fileHash
      });
      try {
        const file = new File([cachedFile], cachedFile.name, {
          type: await resolveImportedAudioMimeType(cachedFile)
        });
        const assets = await getReusableAudioAssets({
          fileHash: cachedTrack.fileHash,
          sizeBytes: cachedTrack.sizeBytes
        });
        onProgress?.({ loaded: 1, total: 1, percent: 100 });
        return { cachedTrack, file, assets };
      } catch {
        // Ignore an unreadable cache entry and download a fresh provider copy.
      }
    }

    const handleDownloadProgress = (loaded: number, total: number | null) => {
      resetInactivityTimer();
      const percent = total && total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : undefined;
      onProgress?.({ loaded, total, percent });
    };

    const source = sourceType === "netease"
      ? await soqaroApi.downloadNeteaseTrack(candidate.providerTrackId, "exhigh", timeoutCtrl.signal, handleDownloadProgress)
      : sourceType === "bilibili"
        ? await soqaroApi.downloadBilibiliTrack(candidate.providerTrackId, timeoutCtrl.signal, handleDownloadProgress)
        : await soqaroApi.downloadQqMusicTrack(candidate.providerTrackId, "exhigh", timeoutCtrl.signal, handleDownloadProgress);
    const extension = extensionForImportedMimeType(source.contentType);
    onProgress?.({ loaded: source.blob.size, total: source.blob.size, percent: 100 });
    return {
      cachedTrack: null,
      file: new File(
        [source.blob],
        `${sanitizeFileName(candidate.title, sourceType)}.${extension}`,
        { type: source.contentType }
      ),
      assets: null
    };
  } finally {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    outerSignal?.removeEventListener("abort", abortHandler);
  }
}

export async function importProviderTracks(input: {
  activeSession: GuestSession | null;
  candidates: ProviderTrackCandidate[];
  inFlightUploadHashesRef: MutableRefObject<Set<string>>;
  origin: UploadedTrack["origin"];
  persistTrackIntoLibrary: (input: {
    track: TrackMeta;
    roomId: string;
    file: File;
    lyrics?: string | null;
    refreshCache?: boolean;
  }) => Promise<void>;
  roomSnapshot: RoomSnapshot | null;
  setStatusMessage: (message: string) => void;
  setUploadedTracks: Dispatch<SetStateAction<Record<string, UploadedTrack>>>;
  sourceType: Exclude<TrackSourceType, "local_upload">;
  syncRoomSnapshot: (roomId: string) => Promise<void>;
  refreshCacheLibrary: () => Promise<void>;
  deleteTrack?: (roomId: string, trackId: string) => Promise<unknown>;
  deleteLocalTrackData?: (trackIds: readonly string[]) => Promise<void>;
}) {
  const { activeSession, candidates, roomSnapshot, sourceType, inFlightUploadHashesRef } = input;
  if (!activeSession || !roomSnapshot) {
    throw new Error(`请先进入一个房间后再导入${sourceTypeLabel(sourceType)}歌曲。`);
  }
  if (!hasRoomPermission(roomSnapshot, activeSession.userId, "library")) {
    throw new Error("你没有修改房间曲库的权限。请联系房主。");
  }

  const pendingCandidateKeys = new Set<string>();
  const pendingCandidates = candidates.filter((candidate) => {
    const key = `${activeSession.userId}:${candidate.provider}:${candidate.providerTrackId}`;
    if (inFlightUploadHashesRef.current.has(key) || pendingCandidateKeys.has(key)) return false;
    const sourceRef = buildProviderSourceRef(sourceType, candidate.providerTrackId);
    const shouldImport = !roomSnapshot.tracks.some((track) =>
      track.ownerSessionId === activeSession.userId &&
      track.sourceType === sourceType &&
      track.sourceRef?.provider === sourceRef.provider &&
      track.sourceRef.trackId === sourceRef.trackId
    );
    if (shouldImport) pendingCandidateKeys.add(key);
    return shouldImport;
  });
  if (pendingCandidates.length === 0) return;

  const itemKeys = pendingCandidates.flatMap((c) => [
    `${c.provider}:${c.providerTrackId}`,
    c.providerTrackId
  ]);
  const taskTitle = pendingCandidates.length === 1
    ? `导入《${pendingCandidates[0].title}》`
    : pendingCandidates.every((c) => c.provider === "bilibili")
      ? `导入 B 站音频 (${pendingCandidates.length} 首)`
      : `导入网络歌曲 (${pendingCandidates.length} 首)`;

  const taskId = importTaskStore.startTask({
    type: pendingCandidates.length > 1 ? "provider_batch" : "provider_track",
    title: taskTitle,
    totalCount: pendingCandidates.length,
    itemKeys,
    currentTitle: pendingCandidates[0].title,
    currentStage: "正在准备获取音频"
  });
  const cancelSignal = importTaskStore.getAbortSignal(taskId);

  const CHUNK_SIZE = 1;
  const currentBatch: PreparedProviderImport[] = [];
  const currentBatchHeldKeys: string[] = [];
  let totalSuccessfulCount = 0;
  const failures: unknown[] = [];
  for (const key of pendingCandidateKeys) inFlightUploadHashesRef.current.add(key);

  const commitBatch = async (
    batch: PreparedProviderImport[],
    batchHeldKeys: string[],
    currentProcessedCount: number
  ) => {
    if (batch.length === 0) return;
    const registeredItems: Array<{ track: TrackMeta; item: PreparedProviderImport }> = [];

    const batchStartIndex = currentProcessedCount - batch.length + 1;
    const batchEndIndex = currentProcessedCount;
    input.setStatusMessage(`正在提交第 ${batchStartIndex} - ${batchEndIndex} / ${pendingCandidates.length} 首歌曲到曲库…`);
    importTaskStore.updateTaskProgress(taskId, {
      currentTitle: batch.length === 1 ? batch[0].candidate.title : undefined,
      currentStage: `正在保存到房间曲库 (${batchStartIndex}-${batchEndIndex}/${pendingCandidates.length})`,
      currentStagePercent: 90
    });

    try {
      const batchRegistered = await soqaroApi.registerTracks(roomSnapshot.room.id, {
        tracks: batch.map((item) => buildRegisterTrackPayload(item.draft))
      });
      batchRegistered.forEach((track, idx) => {
        const item = batch[idx];
        if (item) registeredItems.push({ track, item });
      });
    } catch {
      for (const item of batch) {
        try {
          const [singleRegistered] = await soqaroApi.registerTracks(roomSnapshot.room.id, {
            tracks: [buildRegisterTrackPayload(item.draft)]
          });
          if (singleRegistered) {
            registeredItems.push({ track: singleRegistered, item });
          } else {
            throw new Error("服务端未返回已注册的曲目信息");
          }
        } catch (singleError) {
          failures.push(singleError);
          const itemKey = `${item.candidate.provider}:${item.candidate.providerTrackId}`;
          importTaskStore.failItem(
            taskId,
            itemKey,
            singleError instanceof Error ? singleError.message : "注册到房间曲库失败",
            [item.candidate.providerTrackId]
          );
        }
      }
    }

    if (registeredItems.length === 0) {
      for (const key of batchHeldKeys) inFlightUploadHashesRef.current.delete(key);
      return;
    }

    const chunkUploadEntries: Record<string, UploadedTrack> = {};
    const persistFailures: Array<{ track: TrackMeta; item: PreparedProviderImport; error: unknown }> = [];

    for (let i = 0; i < registeredItems.length; i++) {
      const { track, item } = registeredItems[i];
      input.setStatusMessage(`正在写入本地缓存 (${batchStartIndex + i}/${pendingCandidates.length})：《${item.candidate.title}》…`);
      importTaskStore.updateTaskProgress(taskId, {
        currentTitle: item.candidate.title,
        currentStage: `正在写入本地缓存 (${batchStartIndex + i}/${pendingCandidates.length})`,
        currentStagePercent: 91 + Math.round(((i + 1) / registeredItems.length) * 7),
        activeItemKey: `${item.candidate.provider}:${item.candidate.providerTrackId}`,
        activeItemAliasKeys: [item.candidate.providerTrackId]
      });

      try {
        if (track.originalAsset && track.playbackAsset) {
          await linkTrackAssets({
            trackId: track.id,
            originalAssetId: track.originalAsset.assetId,
            playbackAssetId: track.playbackAsset.assetId
          });
        }
        await input.persistTrackIntoLibrary({
          track: { ...track, artworkUrl: item.localArtworkUrl },
          roomId: roomSnapshot.room.id,
          file: item.file,
          lyrics: item.lyrics,
          refreshCache: false
        });
        chunkUploadEntries[track.id] = { origin: input.origin };

        const itemKey = `${item.candidate.provider}:${item.candidate.providerTrackId}`;
        importTaskStore.completeItem(taskId, itemKey, [item.candidate.providerTrackId]);
      } catch (error) {
        persistFailures.push({ track, item, error });
      }
    }

    if (persistFailures.length > 0) {
      const failedTrackIds = new Set(persistFailures.map((failure) => failure.track.id));
      await Promise.allSettled(
        [...failedTrackIds].flatMap((trackId) => [
          input.deleteTrack?.(roomSnapshot.room.id, trackId),
          input.deleteLocalTrackData?.([trackId])
        ])
      );
      for (const failure of persistFailures) {
        failures.push(failure.error);
        const itemKey = `${failure.item.candidate.provider}:${failure.item.candidate.providerTrackId}`;
        importTaskStore.failItem(
          taskId,
          itemKey,
          failure.error instanceof Error ? failure.error.message : "写入本地缓存失败",
          [failure.item.candidate.providerTrackId]
        );
      }
    }

    const chunkSuccessfulCount = Object.keys(chunkUploadEntries).length;
    if (chunkSuccessfulCount > 0) {
      totalSuccessfulCount += chunkSuccessfulCount;
      input.setUploadedTracks((current) => ({ ...current, ...chunkUploadEntries }));
      if (
        currentProcessedCount >= pendingCandidates.length ||
        currentProcessedCount % 5 === 0
      ) {
        await input.syncRoomSnapshot(roomSnapshot.room.id).catch(() => undefined);
      }
    }

    for (const key of batchHeldKeys) {
      inFlightUploadHashesRef.current.delete(key);
    }
  };
  const prefetchedAudio = new Map<number, Promise<PrefetchedProviderAudioResult>>();
  let nextPrefetchIndex = 0;
  let currentProcessingIndex = 0;

  let lastProgressUpdateTime = 0;
  let maxReportedLoaded = 0;
  let streamBytesStarted = false;

  const fillPrefetchWindow = (lastIndex: number) => {
    while (nextPrefetchIndex < pendingCandidates.length && nextPrefetchIndex <= lastIndex) {
      if (cancelSignal?.aborted) break;
      const index = nextPrefetchIndex++;
      const candidate = pendingCandidates[index];
      prefetchedAudio.set(
        index,
        prefetchProviderAudio(candidate, sourceType, (progress) => {
          if (currentProcessingIndex === index) {
            streamBytesStarted = true;
            maxReportedLoaded = Math.max(maxReportedLoaded, progress.loaded);

            const now = Date.now();
            if (now - lastProgressUpdateTime < 120 && progress.percent !== 100) {
              return;
            }
            lastProgressUpdateTime = now;

            const fraction = progress.percent !== undefined
              ? progress.percent / 100
              : progress.total && progress.total > 0
                ? maxReportedLoaded / progress.total
                : Math.min(0.95, maxReportedLoaded / (1024 * 1024 * 5));
            const dlPercent = Math.min(42, 5 + Math.round(fraction * 37));
            const loadedMb = (maxReportedLoaded / (1024 * 1024)).toFixed(1);
            const totalMb = progress.total ? (progress.total / (1024 * 1024)).toFixed(1) : null;
            const stageText = totalMb
              ? `正在下载音频 (${loadedMb}MB / ${totalMb}MB)`
              : `正在下载音频 (${loadedMb}MB)`;
            importTaskStore.updateTaskProgress(taskId, {
              currentTitle: candidate.title,
              currentStage: stageText,
              currentStagePercent: dlPercent,
              activeItemKey: `${candidate.provider}:${candidate.providerTrackId}`,
              activeItemAliasKeys: [candidate.providerTrackId]
            });
          }
        }, cancelSignal).then(
          (audio) => ({ ok: true as const, audio }),
          (error: unknown) => ({ ok: false as const, error })
        )
      );
    }
  };
  fillPrefetchWindow(1);
  let pipelineError: unknown = null;
  try {
    for (let index = 0; index < pendingCandidates.length; index += 1) {
      if (cancelSignal?.aborted) break;
      currentProcessingIndex = index;
      lastProgressUpdateTime = 0;
      maxReportedLoaded = 0;
      streamBytesStarted = false;

      const candidate = pendingCandidates[index];
      const key = `${activeSession.userId}:${candidate.provider}:${candidate.providerTrackId}`;
      const activeItemKey = `${candidate.provider}:${candidate.providerTrackId}`;
      const aliasKeys = [candidate.providerTrackId];
      let objectUrl: string | null = null;
      try {
        input.setStatusMessage(`正在按顺序导入 ${index + 1} / ${pendingCandidates.length}：《${candidate.title}》…`);
        importTaskStore.updateTaskProgress(taskId, {
          currentTitle: candidate.title,
          currentStage: "正在连接音频服务器",
          currentStagePercent: 5,
          activeItemKey,
          activeItemAliasKeys: aliasKeys
        });

        let currentDlPercent = 5;
        const downloadTimer = setInterval(() => {
          if (streamBytesStarted) return;
          if (currentDlPercent < 15) {
            currentDlPercent += 1;
            importTaskStore.updateTaskProgress(taskId, {
              currentTitle: candidate.title,
              currentStage: "正在连接音频服务器",
              currentStagePercent: currentDlPercent,
              activeItemKey,
              activeItemAliasKeys: aliasKeys
            });
          }
        }, 150);

        let prefetchResult: PrefetchedProviderAudioResult;
        let safetyTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const prefetchPromise = prefetchedAudio.get(index);
          if (!prefetchPromise) throw new Error(`歌曲预取任务不存在：${candidate.title}`);
          const safetyTimeoutPromise = new Promise<PrefetchedProviderAudioResult>((resolve) => {
            const checkSafety = () => {
              safetyTimer = setTimeout(() => {
                if (streamBytesStarted) {
                  // 数据流正在活跃接收，继续等待活跃下载完成
                  checkSafety();
                } else {
                  resolve({
                    ok: false,
                    error: new Error(`连接音频服务器超时：${candidate.title}`)
                  });
                }
              }, 45_000);
            };
            checkSafety();
          });
          prefetchResult = await Promise.race([prefetchPromise, safetyTimeoutPromise]);
        } finally {
          if (safetyTimer) clearTimeout(safetyTimer);
          clearInterval(downloadTimer);
        }
        prefetchedAudio.delete(index);
        fillPrefetchWindow(index + 1);
        if (!prefetchResult.ok) throw prefetchResult.error;
        const prefetched = prefetchResult.audio;
        if (!prefetched) throw new Error(`歌曲预取结果无效：${candidate.title}`);

        if (prefetched.cachedTrack) {
          importTaskStore.updateTaskProgress(taskId, {
            currentTitle: candidate.title,
            currentStage: "正在读取本地缓存",
            currentStagePercent: 35,
            activeItemKey,
            activeItemAliasKeys: aliasKeys
          });
          await new Promise((r) => setTimeout(r, 60));
        } else {
          importTaskStore.updateTaskProgress(taskId, {
            currentTitle: candidate.title,
            currentStage: "音频下载完成",
            currentStagePercent: 45,
            activeItemKey,
            activeItemAliasKeys: aliasKeys
          });
        }

        const sourceRef = buildProviderSourceRef(sourceType, candidate.providerTrackId);
        const lyricsPayloadPromise = requestProviderLyricsPayload(sourceType, candidate.providerTrackId);
        const artworkPromise = sourceType === "qqmusic" && candidate.artworkUrl && /^https?:\/\//i.test(candidate.artworkUrl)
          ? soqaroApi.downloadQqMusicArtwork(candidate.artworkUrl).then((response) => response.blob).catch(() => undefined)
          : Promise.resolve(undefined);
        const createdObjectUrl = URL.createObjectURL(prefetched.file);
        objectUrl = createdObjectUrl;
        const localArtworkPromise = artworkPromise.then((artworkBlob) =>
          resolveLocalArtworkUrl(prefetched.file, candidate.artworkUrl, artworkBlob)
        );

        if (prefetched.assets) {
          importTaskStore.updateTaskProgress(taskId, {
            currentTitle: candidate.title,
            currentStage: "音频分片已就绪",
            currentStagePercent: 80,
            activeItemKey,
            activeItemAliasKeys: aliasKeys
          });
          await new Promise((r) => setTimeout(r, 60));
        }

        let lastPrepProgressTime = 0;
        let lastPrepStage = "";
        const assets = prefetched.assets ?? await prepareAudioAssets({
          file: prefetched.file,
          expectedDurationMs: candidate.durationMs,
          signal: cancelSignal,
          onProgress: ({ stage, completed, total }) => {
            const now = Date.now();
            if (stage === lastPrepStage && completed < total && now - lastPrepProgressTime < 150) {
              return;
            }
            lastPrepProgressTime = now;
            lastPrepStage = stage;
            const { stageLabel, percent } = mapAssetPreparationProgress(stage, completed, total);
            importTaskStore.updateTaskProgress(taskId, {
              currentTitle: candidate.title,
              currentStage: stageLabel,
              currentStagePercent: percent,
              activeItemKey,
              activeItemAliasKeys: aliasKeys
            });
          }
        });
        const localArtworkUrl = await localArtworkPromise;
        const draft = await buildTrackMeta(prefetched.file, createdObjectUrl, activeSession, assets, {
          type: sourceType,
          metadata: { ...candidate, artworkUrl: localArtworkUrl },
          sourceRef
        });
        URL.revokeObjectURL(createdObjectUrl);
        objectUrl = null;
        const lyricsPayload = await lyricsPayloadPromise;
        const lyrics = lyricsPayload?.lyrics?.trim() || null;
        const translatedLyrics = lyricsPayload?.translatedLyrics?.trim() || null;
        const romanizedLyrics = lyricsPayload?.romanizedLyrics?.trim() || null;

        importTaskStore.updateTaskProgress(taskId, {
          currentTitle: candidate.title,
          currentStage: "解析歌词与封面",
          currentStagePercent: 88,
          activeItemKey,
          activeItemAliasKeys: aliasKeys
        });

        currentBatch.push({
          candidate,
          file: prefetched.file,
          draft: {
            ...draft,
            lyrics,
            translatedLyrics,
            romanizedLyrics,
            artworkUrl: candidate.artworkUrl ?? null
          },
          localArtworkUrl,
          lyrics
        });
        currentBatchHeldKeys.push(key);
      } catch (error) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        inFlightUploadHashesRef.current.delete(key);
        if (cancelSignal?.aborted) {
          break;
        }
        failures.push(error);
        const errDetail = error instanceof Error ? error.message : "获取音频失败";
        importTaskStore.failItem(taskId, activeItemKey, errDetail, aliasKeys);
      }

      if (cancelSignal?.aborted) {
        break;
      }

      // 当本批攒满 CHUNK_SIZE 或到达最后一首时，立即将本批入库并释放内存
      const isLastCandidate = index === pendingCandidates.length - 1;
      if (currentBatch.length >= CHUNK_SIZE || (isLastCandidate && currentBatch.length > 0)) {
        const batchToCommit = [...currentBatch];
        const batchKeysToCommit = [...currentBatchHeldKeys];
        currentBatch.length = 0;
        currentBatchHeldKeys.length = 0;
        await commitBatch(batchToCommit, batchKeysToCommit, index + 1);
        batchToCommit.length = 0;
        batchKeysToCommit.length = 0;
      }
      // 让出宏任务队列，让浏览器 GC 和 UI 渲染及时回收内存与刷新帧
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    if (cancelSignal?.aborted) {
      input.setStatusMessage(
        totalSuccessfulCount > 0
          ? `已取消导入（已完成 ${totalSuccessfulCount} 首）。`
          : "已取消导入。"
      );
      return;
    }

    if (totalSuccessfulCount === 0) {
      throw failures[0] ?? new Error("未能成功导入任何歌曲。");
    }

    input.setStatusMessage(
      `已导入 ${totalSuccessfulCount} 首歌曲${failures.length > 0 ? `，${failures.length} 首失败` : ""}。`
    );
  } catch (error) {
    if (cancelSignal?.aborted) {
      return;
    }
    pipelineError = error;
    throw error;
  } finally {
    prefetchedAudio.clear();
    for (const key of pendingCandidateKeys) {
      inFlightUploadHashesRef.current.delete(key);
    }
    if (totalSuccessfulCount > 0) {
      await input.syncRoomSnapshot(roomSnapshot.room.id).catch(() => undefined);
      void input.refreshCacheLibrary().catch(() => undefined);
    }
    if (cancelSignal?.aborted) {
      importTaskStore.cancelTask(taskId);
    } else {
      const errorMsg = pipelineError instanceof Error ? pipelineError.message : pipelineError ? String(pipelineError) : undefined;
      importTaskStore.finishTask(taskId, {
        error: errorMsg
      });
    }
  }
}
