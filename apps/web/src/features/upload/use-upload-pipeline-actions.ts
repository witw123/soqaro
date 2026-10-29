import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type {
  BilibiliTrackCandidate,
  GuestSession,
  NeteaseTrackCandidate,
  ProviderTrackCandidate,
  QqMusicTrackCandidate,
  RemoteTrackSourceRef,
  RoomSnapshot,
  TrackMeta,
  TrackSourceType
} from "@soqaro/shared";
import type { RoomStateEvent } from "@/features/room/room-state-reducer";
import {
  deleteLocalTrackDataForTracks,
  linkTrackAssets,
  toCachedLibraryTrackSummaryRecord,
  upsertCachedLibraryTrack,
  upsertCachedLibraryTrackSummary
} from "@/features/library/indexeddb";
import {
  soqaroApi
} from "@/lib/network/soqaro-api";
import { buildTrackMeta, type CachedLibraryTrack, type UploadedTrack } from "@/features/library/audio-utils";
import {
  getReusableAudioAssets,
  prepareAudioAssets
} from "@/features/library/audio-asset-builder";
import {
  applySelectedTrackFilesResult,
  buildRegisterTrackPayload,
  processSelectedTrackFiles
} from "./upload-pipeline";
import {
  buildCachedLibraryTrackUpsertRecord
} from "@/features/library/cache-library";
import { resolveProviderTrackSource } from "@/features/library/provider-track-identity";
import {
  getConfiguredLocalRepository,
  saveCachedAudioFileToLocalDirectory
} from "@/features/library/local-audio-storage";
import { persistRoomSnapshotToLocalRepository } from "@/features/library/local-room-storage";
import { hasRoomPermission } from "@/features/room/room-permissions";
import {
  resolveImportedLyrics
} from "./upload-import-helpers";
import { importProviderTracks } from "./provider-import-pipeline";
import { importTaskStore, mapAssetPreparationProgress } from "./import-task-store";

type UploadPipelineActionsInput = {
  activeSession: GuestSession | null;
  dispatchRoomStateEvent: Dispatch<RoomStateEvent>;
  inFlightUploadHashesRef: MutableRefObject<Set<string>>;
  refreshCacheLibrary: () => Promise<void>;
  roomSnapshot: RoomSnapshot | null;
  setStatusMessage: (message: string) => void;
  setUploadedTracks: Dispatch<
    SetStateAction<Record<string, UploadedTrack>>
  >;
  uploadedTracks: Record<string, UploadedTrack>;
};

export function useUploadPipelineActions({
  activeSession,
  dispatchRoomStateEvent,
  inFlightUploadHashesRef,
  refreshCacheLibrary,
  roomSnapshot,
  setStatusMessage,
  setUploadedTracks
}: UploadPipelineActionsInput) {
  const latestActiveSessionRef = useRef(activeSession);
  latestActiveSessionRef.current = activeSession;
  const latestRoomSnapshotRef = useRef(roomSnapshot);
  latestRoomSnapshotRef.current = roomSnapshot;
  const uploadTaskChainRef = useRef<Promise<void>>(Promise.resolve());

  const enqueueUploadTask = useCallback(<T>(task: () => Promise<T>): Promise<T> => {
    const next = uploadTaskChainRef.current.then(task, task);
    uploadTaskChainRef.current = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }, []);

  const syncRoomSnapshot = useCallback(
    async (roomId: string) => {
      try {
        const latestSnapshot = await soqaroApi.getRoom(roomId);
        dispatchRoomStateEvent({
          type: "recover-snapshot",
          snapshot: latestSnapshot
        });
      } catch {
        // The realtime snapshot remains the source of truth.
      }
    },
    [dispatchRoomStateEvent]
  );

  const persistTrackIntoLibrary = useCallback(
    async (input: {
      track: Pick<
        import("@soqaro/shared").TrackMeta,
        | "id"
        | "title"
        | "artist"
        | "mimeType"
        | "durationMs"
        | "sizeBytes"
        | "fileHash"
        | "ownerNickname"
      > & Partial<
        Pick<
          TrackMeta,
          "album" | "artworkUrl" | "sourceType" | "sourceRef" | "loudness" | "originalAsset" | "playbackAsset" | "translatedLyrics" | "romanizedLyrics"
        >
      >;
      roomId: string;
      file: File | Blob;
      refreshCache?: boolean;
      lyrics?: string | null;
    }) => {
      const cachedRecord = buildCachedLibraryTrackUpsertRecord({
        ...input,
        track: {
          ...input.track,
          lyrics: input.lyrics ?? null
        }
      });

      const localRepository = await getConfiguredLocalRepository();
      if (localRepository) {
        const cachedAt = new Date().toISOString();
        await upsertCachedLibraryTrackSummary(
          toCachedLibraryTrackSummaryRecord({
            ...cachedRecord,
            cachedAt
          })
        );
        const providerSource = resolveProviderTrackSource(input.track);
        const provider = providerSource?.provider ?? (
          input.track.sourceType === "netease" || input.track.sourceType === "qqmusic" || input.track.sourceType === "bilibili" || input.track.sourceType === "alist"
            ? input.track.sourceType
            : "local_upload"
        );

        const savedToRepo = await saveCachedAudioFileToLocalDirectory({
          file: input.file,
          fileHash: input.track.fileHash,
          title: input.track.title,
          mimeType: input.track.mimeType ?? "audio/mpeg",
          provider,
          originalAsset: input.track.originalAsset,
          playbackAsset: input.track.playbackAsset
        }).catch(() => null);
        if (!savedToRepo) {
          await upsertCachedLibraryTrack(cachedRecord);
        }
      } else {
        await upsertCachedLibraryTrack(cachedRecord);
      }

      if (input.refreshCache !== false) {
        await refreshCacheLibrary();
      }

      const currentSnapshot = latestRoomSnapshotRef.current;
      if (input.refreshCache !== false && currentSnapshot?.room.id === input.roomId) {
        const tracks = currentSnapshot.tracks.some((track) => track.id === input.track.id)
          ? currentSnapshot.tracks
          : [...currentSnapshot.tracks, input.track as TrackMeta];
        void persistRoomSnapshotToLocalRepository({
          ...currentSnapshot,
          tracks
        }).catch(() => undefined);
      }
    },
    [refreshCacheLibrary]
  );

  const handleFilesSelected = useCallback(
    async (
      files: FileList | File[] | null,
      metadataByFileHash?: ReadonlyMap<string, CachedLibraryTrack>
    ) => {
      if (!files) return;
      const selectedFiles = Array.from(files);
      if (selectedFiles.length === 0) return;

      return enqueueUploadTask(async () => {
        const currentSession = latestActiveSessionRef.current;
        const currentSnapshot = latestRoomSnapshotRef.current;
        if (!currentSession || !currentSnapshot) {
          return;
        }
        if (!hasRoomPermission(currentSnapshot, currentSession.userId, "library")) {
          setStatusMessage("你没有修改房间曲库的权限。请联系房主。");
          return;
        }

        const isCachedImport = Boolean(metadataByFileHash && metadataByFileHash.size > 0);
        const firstCachedTitle = metadataByFileHash?.values().next().value?.title;
        const taskTitle = isCachedImport && firstCachedTitle
          ? `导入缓存音频《${firstCachedTitle}》`
          : selectedFiles.length === 1
            ? `导入本地音频《${selectedFiles[0].name}》`
            : `导入本地音频 (${selectedFiles.length} 个文件)`;

        const itemKeys = selectedFiles.flatMap((f) => [
          f.name,
          ...(metadataByFileHash ? Array.from(metadataByFileHash.keys()) : []),
          ...(metadataByFileHash ? Array.from(metadataByFileHash.values()).map((v) => v.title) : [])
        ]);

        const taskId = importTaskStore.startTask({
          type: isCachedImport ? "cached_track" : "local_files",
          title: taskTitle,
          totalCount: selectedFiles.length,
          itemKeys,
          currentTitle: firstCachedTitle ?? selectedFiles[0].name,
          currentStage: "正在校验源文件"
        });

        const roomId = currentSnapshot.room.id;
        let hasError = false;
        let readyCount = 0;
        try {
          const result = await processSelectedTrackFiles({
            files: selectedFiles,
            activeSession: currentSession,
            roomId,
            roomTracks: currentSnapshot.tracks,
            inFlightUploadHashes: inFlightUploadHashesRef.current,
            createObjectUrl: (file) => URL.createObjectURL(file),
            revokeObjectUrl: (objectUrl) => URL.revokeObjectURL(objectUrl),
            onTrackStart: (file, index) => {
              const cachedMetadata = metadataByFileHash?.get(file.name);
              importTaskStore.updateTaskProgress(taskId, {
                currentTitle: cachedMetadata?.title ?? file.name,
                currentStage: "正在校验源文件",
                currentStagePercent: 0,
                completedCount: index,
                activeItemKey: file.name
              });
            },
            buildTrackMeta: async (file, objectUrl) => {
              const cachedMetadata = selectedFiles.length === 1 && metadataByFileHash?.size === 1
                ? metadataByFileHash.values().next().value
                : undefined;
              const reusedAssets = cachedMetadata
                ? await getReusableAudioAssets({
                    fileHash: cachedMetadata.fileHash,
                    sizeBytes: cachedMetadata.sizeBytes
                  })
                : null;
              if (reusedAssets) {
                importTaskStore.updateTaskProgress(taskId, {
                  currentTitle: cachedMetadata?.title ?? file.name,
                  currentStage: "音频资源已就绪",
                  currentStagePercent: 87,
                  activeItemKey: file.name
                });
              }
              let lastProgressTime = 0;
              let lastStage = "";
              const assets = reusedAssets ?? await prepareAudioAssets({
                file,
                expectedDurationMs: cachedMetadata?.durationMs,
                onProgress: ({ stage, completed, total }) => {
                  const now = Date.now();
                  if (stage === lastStage && completed < total && now - lastProgressTime < 150) {
                    return;
                  }
                  lastProgressTime = now;
                  lastStage = stage;
                  const { stageLabel, percent } = mapAssetPreparationProgress(stage, completed, total, "local");
                  importTaskStore.updateTaskProgress(taskId, {
                    currentTitle: cachedMetadata?.title ?? file.name,
                    currentStage: stageLabel,
                    currentStagePercent: percent,
                    activeItemKey: file.name
                  });
                }
              });
              const resolvedCachedMetadata = metadataByFileHash?.get(assets.fileHash);
              const provider = resolvedCachedMetadata?.provider;
              const providerTrackId = resolvedCachedMetadata?.providerTrackId;
              let sourceType: TrackSourceType = "local_upload";
              let sourceRef: RemoteTrackSourceRef | undefined;
              if (
                (provider === "netease" || provider === "qqmusic") &&
                providerTrackId
              ) {
                sourceType = provider;
                sourceRef = { provider, trackId: providerTrackId };
              }
              const draft = await buildTrackMeta(file, objectUrl, currentSession, assets, resolvedCachedMetadata
                ? {
                    type: sourceType,
                    metadata: {
                      title: resolvedCachedMetadata.title,
                      artist: resolvedCachedMetadata.artist,
                      album: resolvedCachedMetadata.album ?? null,
                      artworkUrl: resolvedCachedMetadata.artworkUrl ?? null
                    },
                    ...(sourceRef ? { sourceRef } : {}),
                    ...(resolvedCachedMetadata?.loudness
                      ? { loudness: resolvedCachedMetadata.loudness }
                      : {})
                  }
                : undefined);
              const lyrics = draft.lyrics?.trim()
                || resolvedCachedMetadata?.lyrics?.trim()
                || await resolveImportedLyrics({
                  title: draft.title,
                  artist: draft.artist,
                  sourceType,
                  sourceTrackId: sourceRef?.trackId
                });
              return {
                ...draft,
                lyrics: lyrics || null,
                translatedLyrics: resolvedCachedMetadata?.translatedLyrics ?? null,
                romanizedLyrics: resolvedCachedMetadata?.romanizedLyrics ?? null
              };
            },
            buildRegisterTrackPayload,
            registerTrack: (registerRoomId, payload) =>
              soqaroApi.registerTrack(
                registerRoomId,
                payload as Parameters<typeof soqaroApi.registerTrack>[1]
              ),
            deleteTrack: (registerRoomId, trackId) =>
              soqaroApi.deleteTrack(registerRoomId, trackId),
            deleteLocalTrackData: deleteLocalTrackDataForTracks,
            persistTrackIntoLibrary: (persistInput) =>
              persistTrackIntoLibrary({ ...persistInput, refreshCache: false }),
            onTrackReady: async (trackId, upload, registeredTrack) => {
              readyCount += 1;
              setUploadedTracks((current) => ({
                ...current,
                [trackId]: upload
              }));
              if (registeredTrack.originalAsset && registeredTrack.playbackAsset) {
                void linkTrackAssets({
                  trackId,
                  originalAssetId: registeredTrack.originalAsset.assetId,
                  playbackAssetId: registeredTrack.playbackAsset.assetId
                });
              }
              importTaskStore.completeItem(
                taskId,
                registeredTrack.title || registeredTrack.id,
                [registeredTrack.fileHash, registeredTrack.id]
              );
              if (readyCount % 5 === 0) {
                await syncRoomSnapshot(roomId);
              }
            }
          });

          await applySelectedTrackFilesResult({
            roomId,
            result,
            setUploadedTracks,
            syncRoomSnapshot,
            setStatusMessage
          });
          void refreshCacheLibrary().catch(() => undefined);
          if (result.importedCount === 0 && selectedFiles.length > 0) {
            hasError = true;
          }
        } catch (error) {
          hasError = true;
          throw error;
        } finally {
          importTaskStore.finishTask(taskId, {
            error: hasError ? "导入失败" : undefined
          });
        }
      });
    },
    [
      enqueueUploadTask,
      inFlightUploadHashesRef,
      persistTrackIntoLibrary,
      setStatusMessage,
      setUploadedTracks,
      syncRoomSnapshot,
      refreshCacheLibrary
    ]
  );

  const runProviderImport = useCallback(
    (
      candidates: ProviderTrackCandidate[],
      origin: UploadedTrack["origin"],
      sourceType: Exclude<TrackSourceType, "local_upload">
    ) =>
      enqueueUploadTask(() =>
        importProviderTracks({
          activeSession: latestActiveSessionRef.current,
          candidates,
          inFlightUploadHashesRef,
          origin,
          persistTrackIntoLibrary,
          roomSnapshot: latestRoomSnapshotRef.current,
          deleteTrack: (roomId, trackId) => soqaroApi.deleteTrack(roomId, trackId),
          deleteLocalTrackData: deleteLocalTrackDataForTracks,
          setStatusMessage,
          setUploadedTracks,
          sourceType,
          syncRoomSnapshot,
          refreshCacheLibrary
        })
      ),
    [
      enqueueUploadTask,
      inFlightUploadHashesRef,
      persistTrackIntoLibrary,
      refreshCacheLibrary,
      setStatusMessage,
      setUploadedTracks,
      syncRoomSnapshot
    ]
  );

  const handleNeteaseTrackImport = useCallback(
    (candidate: NeteaseTrackCandidate) => runProviderImport([candidate], "netease-import", "netease"),
    [runProviderImport]
  );

  const handleQqMusicTrackImport = useCallback(
    (candidate: QqMusicTrackCandidate) => runProviderImport([candidate], "qqmusic-import", "qqmusic"),
    [runProviderImport]
  );

  const handleBilibiliTrackImport = useCallback(
    (candidate: BilibiliTrackCandidate) => runProviderImport([candidate], "bilibili-import", "bilibili"),
    [runProviderImport]
  );

  return {
    syncRoomSnapshot,
    persistTrackIntoLibrary,
    handleFilesSelected,
    handleNeteaseTrackImport,
    handleQqMusicTrackImport,
    handleBilibiliTrackImport,
    handleNeteaseTrackImports: (candidates: NeteaseTrackCandidate[]) =>
      runProviderImport(candidates, "netease-import", "netease"),
    handleQqMusicTrackImports: (candidates: QqMusicTrackCandidate[]) =>
      runProviderImport(candidates, "qqmusic-import", "qqmusic"),
    handleBilibiliTrackImports: (candidates: BilibiliTrackCandidate[]) =>
      runProviderImport(candidates, "bilibili-import", "bilibili")
  };
}
export { importProviderTracks, prefetchProviderAudio, type ProviderTrackCandidate } from "./provider-import-pipeline";


