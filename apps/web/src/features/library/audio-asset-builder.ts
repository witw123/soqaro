"use client";

import {
  buildMerkleTree,
  computeAssetId,
  hashAssetUnit,
  originalAssetManifestSchema,
  playbackEncoderVersion,
  playbackAssetManifestSchema,
  playbackProfileId,
  type AssetUnitDescriptor,
  type OriginalAssetManifest,
  type PlaybackAssetManifest,
  type TrackLoudness
} from "@soqaro/shared";
import { createSHA256 } from "hash-wasm";
import {
  deleteAudioAsset,
  getCompleteAssetPairForSourceFileHash,
  getAssetManifest,
  deletePlaybackAssetDraft,
  getPlaybackAssetDraftUnitBatch,
  putAssetManifest,
  putPlaybackAssetDraftUnits,
  putLocallyGeneratedAssetUnits,
  upsertTranscodeJob
} from "@/features/library/indexeddb";
import { getConfiguredLocalRepository } from "./local-audio-storage";
import type { LocalRepository } from "./local-repository";
import { opusPreSkipSamples } from "@audio/opus-encode";
import { acquireOpusEncoderPool } from "./opus-segment-encoder";
import { parseWavHeader, type WavHeader } from "@/features/audio-codecs/wav-parser";
import { analyzeAudioBufferAsync, LoudnessAnalyzer } from "./loudness-analysis";
import {
  runExclusiveAudioDecodeTask,
  type AudioDecodeTaskPriority
} from "./audio-decode-queue";

const originalUnitSize = 1024 * 1024;
const segmentDurationMs = 2_000;
const seekPrerollMs = 80;
const opusSampleRate = 48_000;
const opusFrameSamples = 960;
const playbackDraftWriteBatchSize = 16;
const maxQueuedPlaybackDraftUnits = playbackDraftWriteBatchSize * 4;
export { playbackEncoderVersion, playbackProfileId };
export const maxDecodedPcmBytes = 256 * 1024 * 1024;
export const maxFullDecodeFileBytes = 64 * 1024 * 1024;

export type SupportedAudioUploadFormat = "flac" | "wav" | "mp3" | "m4a";

export type PreparedAudioAssets = {
  fileHash: string;
  originalAsset: OriginalAssetManifest;
  playbackAsset: PlaybackAssetManifest;
  loudness?: TrackLoudness;
};

type PreparedPlaybackAsset = {
  playbackAsset: PlaybackAssetManifest;
  loudness: TrackLoudness;
  leafHashes: string[];
  proofs: Array<Array<{ position: "left" | "right"; hash: string }>>;
  draftId: string;
};

export type AssetPreparationProgress = {
  stage:
    | "inspecting"
    | "hashing"
    | "persisting-original"
    | "decoding"
    | "encoding"
    | "persisting-playback";
  completed: number;
  total: number;
};

class AudioDecodeMemoryLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioDecodeMemoryLimitError";
  }
}

export function resolveSupportedUploadFormat(file: Pick<File, "name" | "type">) {
  const signature = `${file.type} ${file.name}`.trim().toLowerCase();
  if (signature.includes("flac") || signature.endsWith(".flac")) {
    return "flac" as const;
  }
  if (signature.includes("wav") || signature.includes("wave") || signature.endsWith(".wav")) {
    return "wav" as const;
  }
  if (
    signature.includes("audio/mpeg") ||
    signature.includes("audio/mp3") ||
    signature.endsWith(".mp3")
  ) {
    return "mp3" as const;
  }
  if (
    signature.includes("audio/mp4") ||
    signature.includes("audio/m4a") ||
    signature.includes("audio/x-m4a") ||
    signature.includes("audio/aac") ||
    signature.includes("video/mp4") ||
    signature.endsWith(".m4a") ||
    signature.endsWith(".mp4") ||
    signature.endsWith(".aac")
  ) {
    return "m4a" as const;
  }
  return null;
}

export async function prepareAudioAssets(input: {
  file: File;
  priority?: AudioDecodeTaskPriority;
  signal?: AbortSignal;
  onProgress?: (progress: AssetPreparationProgress) => void;
  expectedDurationMs?: number;
}): Promise<PreparedAudioAssets> {
  const format = resolveSupportedUploadFormat(input.file);
  if (!format) {
    throw new Error("仅支持 FLAC、WAV、MP3 和 M4A 音频文件。");
  }
  if (input.file.size <= 0) {
    throw new Error("音频文件为空。");
  }

  return runExclusiveAudioDecodeTask(
    async () => {
      throwIfAborted(input.signal);
      const decodePlan = await inspectDecodePlan(
        input.file,
        format,
        input.onProgress,
        input.expectedDurationMs
      );
      const source = await prepareOriginalAsset(input);
      const reusable = await getReusableAudioAssets({
        fileHash: source.fileHash,
        sizeBytes: input.file.size
      }).catch(() => null);
      if (reusable) {
        return reusable;
      }

      if (format === "m4a") {
        if (input.file.size > maxFullDecodeFileBytes) {
          throw new AudioDecodeMemoryLimitError(
            "M4A 音频文件过大，预计解码内存超出浏览器安全上限，请先切分音频或转为 FLAC/MP3。"
          );
        }
        if (decodePlan.durationSeconds !== undefined && decodePlan.channels !== undefined) {
          assertDecodedPcmWithinMemoryBudget({
            durationSeconds: decodePlan.durationSeconds,
            channels: decodePlan.channels
          });
        }
      }

      const useStreaming = decodePlan.useStreaming && format !== "m4a";
      const playbackDraftId = createPlaybackDraftId();
      const prepareStreamingFallback = () =>
        prepareStreamingPlaybackAsset({
          ...input,
          fileHash: source.fileHash,
          draftId: playbackDraftId,
          expectedDurationMs: decodePlan.durationSeconds
            ? Math.max(1, Math.round(decodePlan.durationSeconds * 1000))
            : input.expectedDurationMs
        });
      const playbackPromise = useStreaming
        ? prepareStreamingFallback()
        : preparePlaybackAsset({
            ...input,
            draftId: playbackDraftId,
            fileHash: source.fileHash
          }).catch(async (error) => {
            if (input.signal?.aborted || format === "m4a") {
              throw error;
            }
            await deletePlaybackAssetDraft(playbackDraftId).catch(() => undefined);
            return prepareStreamingFallback();
          });
      void playbackPromise.catch(() =>
        deletePlaybackAssetDraft(playbackDraftId).catch(() => undefined)
      );
      try {
        await upsertTranscodeJob({
          sourceFileHash: source.fileHash,
          kind: "playback-transcode",
          profileId: playbackProfileId,
          status: "running",
          progress: 0,
          errorMessage: null
        });
        const playback = await playbackPromise;
        const localRepository = await getConfiguredLocalRepository().catch(() => null);
        if (localRepository) {
          try {
            await persistPlaybackDraftUnits({
              draftId: playback.draftId,
              playback,
              onProgress: input.onProgress,
              repository: localRepository
            });
            await localRepository.writeOriginalManifest(source.originalAsset, "").catch(() => undefined);
            input.onProgress?.({
              stage: "persisting-original",
              completed: source.originalAsset.unitCount,
              total: source.originalAsset.unitCount
            });
          } catch (error) {
            await deletePlaybackAssetDraft(playbackDraftId).catch(() => undefined);
            throw error;
          }
        } else {
          const preexistingAssetIds = new Set(
            (
              await Promise.all([
                getAssetManifest(source.originalAsset.assetId, { includeLocalRepository: false }),
                getAssetManifest(playback.playbackAsset.assetId, { includeLocalRepository: false })
              ])
            )
              .filter((record) => !!record)
              .map((record) => record.assetId)
          );
          const createdAssetIds = [source.originalAsset.assetId, playback.playbackAsset.assetId]
            .filter((assetId) => !preexistingAssetIds.has(assetId));
          try {
            await putAssetManifest(source.originalAsset, { complete: true });
            input.onProgress?.({
              stage: "persisting-original",
              completed: source.originalAsset.unitCount,
              total: source.originalAsset.unitCount
            });
            await putAssetManifest(playback.playbackAsset);
            await persistPlaybackDraftUnits({
              draftId: playback.draftId,
              playback,
              onProgress: input.onProgress
            });
          } catch (error) {
            await Promise.allSettled([
              ...createdAssetIds.map((assetId) => deleteAudioAsset(assetId)),
              deletePlaybackAssetDraft(playbackDraftId)
            ]);
            throw error;
          }
        }
        await upsertTranscodeJob({
          sourceFileHash: source.fileHash,
          kind: "playback-transcode",
          profileId: playbackProfileId,
          status: "completed",
          progress: 1,
          errorMessage: null
        });
        return {
          fileHash: source.fileHash,
          originalAsset: source.originalAsset,
          playbackAsset: playback.playbackAsset,
          loudness: playback.loudness
        };
      } catch (error) {
        await deletePlaybackAssetDraft(playbackDraftId).catch(() => undefined);
        await upsertTranscodeJob({
          sourceFileHash: source.fileHash,
          kind: "playback-transcode",
          profileId: playbackProfileId,
          status: "failed",
          progress: 0,
          errorMessage: error instanceof Error ? error.message : "音频转码失败。"
        });
        throw error;
      }
    },
    {
      priority: input.priority ?? "high",
      signal: input.signal
    }
  );
}

export async function getReusableAudioAssets(input: {
  fileHash: string;
  sizeBytes?: number;
}): Promise<PreparedAudioAssets | null> {
  let pair = await getCompleteAssetPairForSourceFileHash(input.fileHash);
  if (!pair) return null;

  const originalAsset = pair.original.manifest;
  const playbackAsset = pair.playback.manifest;
  if (
    originalAsset.kind !== "original" ||
    playbackAsset.kind !== "playback" ||
    originalAsset.fileHash !== input.fileHash ||
    playbackAsset.sourceFileHash !== input.fileHash ||
    playbackAsset.profileId !== playbackProfileId ||
    playbackAsset.encoder.version !== playbackEncoderVersion ||
    (input.sizeBytes !== undefined && input.sizeBytes > 0 && originalAsset.sizeBytes !== input.sizeBytes)
  ) {
    return null;
  }

  return {
    fileHash: input.fileHash,
    originalAsset,
    playbackAsset
  };
}

async function prepareOriginalAsset(input: {
  file: File;
  signal?: AbortSignal;
  onProgress?: (progress: AssetPreparationProgress) => void;
}) {
  const unitCount = Math.ceil(input.file.size / originalUnitSize);
  const fileHasher = await createSHA256();
  fileHasher.init();
  const leafHashes: string[] = [];

  for (let unitIndex = 0; unitIndex < unitCount; unitIndex += 1) {
    throwIfAborted(input.signal);
    const payload = await readFileUnit(input.file, unitIndex);
    const bytes = new Uint8Array(payload);
    fileHasher.update(bytes);
    leafHashes.push(await hashAssetUnit(unitIndex, bytes));
    input.onProgress?.({ stage: "hashing", completed: unitIndex + 1, total: unitCount });
    if (unitIndex > 0 && unitIndex % 16 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  const fileHash = fileHasher.digest("hex");
  const tree = await buildMerkleTree(leafHashes);
  const manifestWithoutId = {
    kind: "original" as const,
    fileHash,
    mimeType: input.file.type || mimeTypeFromFileName(input.file.name),
    sizeBytes: input.file.size,
    unitSize: originalUnitSize as 1048576,
    unitCount,
    merkleRoot: tree.root
  };
  const originalAsset = originalAssetManifestSchema.parse({
    ...manifestWithoutId,
    assetId: await computeAssetId(manifestWithoutId)
  });
  return { fileHash, originalAsset, leafHashes, proofs: tree.proofs };
}

function createPlaybackDraftUnitQueue(draftId: string) {
  const queuedDraftUnits: Array<{
    unitIndex: number;
    descriptor: Omit<AssetUnitDescriptor, "assetId" | "contentHash" | "proof">;
    contentHash: string;
    payload: ArrayBuffer;
  }> = [];
  let queuedDraftUnitCount = 0;
  let draftWriteError: unknown = null;
  let draftWriteChain = Promise.resolve();

  const flush = () => {
    if (queuedDraftUnits.length === 0) return;
    const batch = queuedDraftUnits.splice(0, queuedDraftUnits.length);
    draftWriteChain = draftWriteChain.then(async () => {
      if (draftWriteError) return;
      try {
        await putPlaybackAssetDraftUnits({
          draftId,
          units: batch
        });
      } catch (error) {
        draftWriteError ??= error;
      } finally {
        queuedDraftUnitCount -= batch.length;
      }
    });
  };

  return {
    enqueue: async (unit: {
      unitIndex: number;
      descriptor: Omit<AssetUnitDescriptor, "assetId" | "contentHash" | "proof">;
      contentHash: string;
      payload: ArrayBuffer;
    }) => {
      queuedDraftUnits.push(unit);
      queuedDraftUnitCount += 1;
      if (queuedDraftUnits.length >= playbackDraftWriteBatchSize) {
        flush();
      }
      if (queuedDraftUnitCount >= maxQueuedPlaybackDraftUnits) {
        await draftWriteChain;
      }
      if (draftWriteError) throw draftWriteError;
    },
    finish: async () => {
      flush();
      await draftWriteChain;
      if (draftWriteError) throw draftWriteError;
    },
    waitForIdle: () => draftWriteChain
  };
}

async function preparePlaybackAsset(input: {
  file: File;
  draftId: string;
  fileHash: string | Promise<string>;
  signal?: AbortSignal;
  onProgress?: (progress: AssetPreparationProgress) => void;
}): Promise<PreparedPlaybackAsset> {
  throwIfAborted(input.signal);
  input.onProgress?.({ stage: "decoding", completed: 0, total: 1 });
  const audioBuffer = await decodeAudioFile(input.file);
  input.onProgress?.({ stage: "decoding", completed: 1, total: 1 });
  return await encodePlaybackAsset(input, audioBuffer);
}

async function prepareStreamingPlaybackAsset(input: {
  file: File;
  draftId: string;
  fileHash: string | Promise<string>;
  expectedDurationMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: AssetPreparationProgress) => void;
}): Promise<PreparedPlaybackAsset> {
  const format = resolveSupportedUploadFormat(input.file);
  if (!format || format === "m4a") {
    throw new Error("流式分片解码仅支持 FLAC、WAV 和 MP3 音频文件。");
  }

  let channelCount: 1 | 2 | null = null;
  let sourceSampleRate: number | null = null;
  let loudnessAnalyzer: LoudnessAnalyzer | null = null;
  let pcm: PcmAccumulator | null = null;
  let nextUnitIndex = 0;
  const leafHashes: Array<string | undefined> = [];
  const expectedUnitCount = input.expectedDurationMs
    ? Math.max(1, Math.ceil(input.expectedDurationMs / segmentDurationMs))
    : 0;
  const encoderPool = acquireOpusEncoderPool(resolveEncodingConcurrency(4));
  const { encoders } = encoderPool;
  const availableEncoderIndexes = encoders.map((_, index) => index);
  const encoderWaiters: Array<(index: number) => void> = [];
  const pendingUnitTasks = new Set<Promise<void>>();
  const maxInFlightUnits = encoders.length * 2;
  let completedUnits = 0;
  let encodingError: unknown = null;
  const draftQueue = createPlaybackDraftUnitQueue(input.draftId);

  const acquireEncoder = async () => {
    const available = availableEncoderIndexes.pop();
    if (available !== undefined) return available;
    return await new Promise<number>((resolve) => encoderWaiters.push(resolve));
  };

  const releaseEncoder = (index: number) => {
    const waiter = encoderWaiters.shift();
    if (waiter) {
      waiter(index);
    } else {
      availableEncoderIndexes.push(index);
    }
  };

  const waitForTaskCapacity = async () => {
    while (pendingUnitTasks.size >= maxInFlightUnits) {
      await Promise.race([...pendingUnitTasks].map((task) => task.catch(() => undefined)));
      if (encodingError) throw encodingError;
    }
  };

  const scheduleUnit = async (inputUnit: {
    unitIndex: number;
    channels: Float32Array[];
    sampleRate: number;
    trimStartSamples: number;
    trimEndSamples: number;
    durationMs: number;
  }) => {
    if (encodingError) throw encodingError;
    await waitForTaskCapacity();
    const encoderIndex = await acquireEncoder();
    if (encodingError) {
      releaseEncoder(encoderIndex);
      throw encodingError;
    }

    const task = (async () => {
      let payload: ArrayBuffer;
      try {
        payload = await encoders[encoderIndex]!.encode({
          sampleRate: inputUnit.sampleRate,
          channels: inputUnit.channels,
          bitrateKbps: channelCount === 1 ? 128 : 256
        });
      } catch (error) {
        encodingError ??= error;
        throw error;
      } finally {
        // Hashing and IndexedDB persistence do not occupy the encoder worker.
        releaseEncoder(encoderIndex);
      }

      try {
        const contentHash = await hashAssetUnit(inputUnit.unitIndex, payload);
        await draftQueue.enqueue({
          unitIndex: inputUnit.unitIndex,
          descriptor: {
            kind: "playback",
            unitIndex: inputUnit.unitIndex,
            payloadBytes: payload.byteLength,
            startMs: inputUnit.unitIndex * segmentDurationMs,
            durationMs: inputUnit.durationMs,
            trimStartSamples: inputUnit.trimStartSamples,
            trimEndSamples: inputUnit.trimEndSamples
          },
          contentHash,
          payload
        });
        leafHashes[inputUnit.unitIndex] = contentHash;
        completedUnits += 1;
        input.onProgress?.({
          stage: "encoding",
          completed: completedUnits,
          total: Math.max(expectedUnitCount, nextUnitIndex)
        });
      } catch (error) {
        encodingError ??= error;
        throw error;
      }
    })();
    pendingUnitTasks.add(task);
    task.then(
      () => pendingUnitTasks.delete(task),
      () => pendingUnitTasks.delete(task)
    );
  };

  const emitReadyUnits = async (final: boolean) => {
    if (!pcm || !sourceSampleRate) return;
    const sampleRate = sourceSampleRate;
    const totalSamples = pcm.endSample;
    const unitCount = final
      ? Math.max(1, Math.ceil(totalSamples / (segmentDurationMs / 1000 * sampleRate)))
      : Number.POSITIVE_INFINITY;
    const segmentSamples = Math.round((segmentDurationMs / 1000) * sampleRate);
    const prerollSamples = Math.round((seekPrerollMs / 1000) * sampleRate);
    const postrollSamples = Math.max(
      1,
      Math.ceil(opusPreSkipSamples * sampleRate / opusSampleRate)
    );

    while (nextUnitIndex < unitCount) {
      throwIfAborted(input.signal);
      const contentStart = nextUnitIndex * segmentSamples;
      const contentEnd = Math.min(totalSamples, contentStart + segmentSamples);
      const requiredEnd = final
        ? contentEnd
        : contentEnd + postrollSamples;
      if (!final && totalSamples < requiredEnd) {
        break;
      }
      if (contentEnd <= contentStart) {
        break;
      }

      const sampleStart = Math.max(0, contentStart - prerollSamples);
      const sampleEnd = Math.min(totalSamples, contentEnd + postrollSamples);
      const segment = pcm.readWindow(sampleStart, sampleEnd);
      const encodedSegment = prepareIndependentOpusSegment({
        channels: segment,
        trimStartSamples: nextUnitIndex === 0 ? 0 : contentStart - sampleStart,
        contentSamples: contentEnd - contentStart
      }, sampleRate);
      await scheduleUnit({
        unitIndex: nextUnitIndex,
        channels: encodedSegment.channels,
        sampleRate,
        trimStartSamples: encodedSegment.trimStartSamples,
        trimEndSamples: encodedSegment.trimEndSamples,
        durationMs: Math.max(1, Math.round((contentEnd - contentStart) / sampleRate * 1000))
      });
      nextUnitIndex += 1;
      pcm.trimBefore(Math.max(0, contentEnd - prerollSamples));
    }
  };

  try {
    await streamAudioBlobPcmChunks(input.file, format, input.signal, async (decoded) => {
      throwIfAborted(input.signal);
      if (decoded.channels.length < 1 || decoded.channels.length > 2) {
        throw new Error("仅支持单声道或双声道音频。");
      }
      const channels = decoded.channels.length as 1 | 2;
      if (channelCount === null) {
        channelCount = channels;
        sourceSampleRate = decoded.sampleRate;
        pcm = new PcmAccumulator(channels);
        loudnessAnalyzer = new LoudnessAnalyzer(decoded.sampleRate, channels);
      } else if (channelCount !== channels || sourceSampleRate !== decoded.sampleRate) {
        throw new Error("流式音频解码块的声道数或采样率发生变化。");
      }

      loudnessAnalyzer!.push({
        sampleRate: decoded.sampleRate,
        channels: decoded.channels
      });
      pcm!.append(decoded.channels, false);
      await emitReadyUnits(false);
    });

    const preparedPcm = pcm as PcmAccumulator | null;
    if (!preparedPcm || !channelCount || !sourceSampleRate) {
      throw new Error("音频没有解码出可用 PCM 数据。");
    }
    await emitReadyUnits(true);
    await Promise.allSettled([...pendingUnitTasks]);
    await draftQueue.finish();
    if (encodingError) throw encodingError;
    const completeLeafHashes: string[] = [];
    for (let unitIndex = 0; unitIndex < nextUnitIndex; unitIndex += 1) {
      const contentHash = leafHashes[unitIndex];
      if (!contentHash) {
        throw new Error("流式音频没有生成完整的播放分片。");
      }
      completeLeafHashes.push(contentHash);
    }
    if (completeLeafHashes.length === 0 || completeLeafHashes.length !== nextUnitIndex) {
      throw new Error("流式音频没有生成完整的播放分片。");
    }

    const durationMs = Math.max(1, Math.ceil((preparedPcm.endSample / sourceSampleRate) * 1000));
    const expectedUnitCount = Math.max(1, Math.ceil(durationMs / segmentDurationMs));
    if (completeLeafHashes.length !== expectedUnitCount) {
      throw new Error("流式音频时间轴与播放分片数量不一致。");
    }
    const tree = await buildMerkleTree(completeLeafHashes);
    const manifestWithoutId = {
      kind: "playback" as const,
      sourceFileHash: await input.fileHash,
      profileId: playbackProfileId,
      codec: "opus" as const,
      container: "audio/ogg" as const,
      sampleRate: opusSampleRate as 48000,
      channels: channelCount,
      bitrate: channelCount === 1 ? 128_000 as const : 256_000 as const,
      durationMs,
      segmentDurationMs: segmentDurationMs as 2000,
      seekPrerollMs: seekPrerollMs as 80,
      unitCount: completeLeafHashes.length,
      merkleRoot: tree.root,
      encoder: { name: "@audio/opus-encode" as const, version: playbackEncoderVersion }
    };
    const playbackAsset = playbackAssetManifestSchema.parse({
      ...manifestWithoutId,
      assetId: await computeAssetId(manifestWithoutId)
    });
    return {
      playbackAsset,
      loudness: loudnessAnalyzer!.finish(),
      leafHashes: completeLeafHashes,
      proofs: tree.proofs,
      draftId: input.draftId
    };
  } finally {
    await Promise.allSettled([...pendingUnitTasks]);
    await draftQueue.waitForIdle();
    encoderPool.release();
  }
}

async function persistPlaybackDraftUnits(input: {
  draftId: string;
  playback: PreparedPlaybackAsset;
  onProgress?: (progress: AssetPreparationProgress) => void;
  repository?: LocalRepository | null;
}) {
  const batchSize = 8;
  let offset = 0;
  const repositoryWriter = input.repository
    ? await input.repository.beginPlaybackAssetWrite(input.playback.playbackAsset)
    : null;
  try {
    while (offset < input.playback.leafHashes.length) {
      const records = await getPlaybackAssetDraftUnitBatch(input.draftId, offset, batchSize);
      if (records.length === 0) {
        throw new Error("流式播放分片草稿不完整。");
      }
      if (records.some((record, index) => record.unitIndex !== offset + index)) {
        throw new Error("流式播放分片草稿索引不连续。");
      }
      const units = records.map((record) => {
        if (
          record.descriptor.unitIndex !== record.unitIndex ||
          record.payload.byteLength !== record.descriptor.payloadBytes
        ) {
          throw new Error("流式播放分片草稿元数据不一致。");
        }
        if (record.contentHash !== input.playback.leafHashes[record.unitIndex]) {
          throw new Error("流式播放分片内容校验失败。");
        }
        const proof = input.playback.proofs[record.unitIndex];
        if (!proof) {
          throw new Error("流式播放分片证明不完整。");
        }
        return {
          descriptor: {
            ...record.descriptor,
            assetId: input.playback.playbackAsset.assetId,
            contentHash: record.contentHash,
            proof
          } satisfies AssetUnitDescriptor,
          payload: record.payload
        };
      });
      offset += records.length;
      if (input.repository) {
        if (repositoryWriter) {
          await repositoryWriter.writeUnits(units);
        }
      } else {
        await putLocallyGeneratedAssetUnits({
          assetId: input.playback.playbackAsset.assetId,
          units,
          complete: offset === input.playback.leafHashes.length
        });
      }
      input.onProgress?.({
        stage: "persisting-playback",
        completed: offset,
        total: input.playback.leafHashes.length
      });
    }
    if (repositoryWriter) {
      await repositoryWriter.commit();
    }
  } catch (error) {
    if (repositoryWriter) {
      await repositoryWriter.abort();
    }
    throw error;
  }
  await deletePlaybackAssetDraft(input.draftId);
}

export type DecodedPcmChunk = {
  channels: Float32Array[];
  sampleRate: number;
  samplesDecoded: number;
};

type StreamingDecoder = {
  ready: Promise<void>;
  decode: (bytes: Uint8Array) => Promise<{
    channelData: Float32Array[];
    samplesDecoded: number;
    sampleRate: number;
    errors: unknown[];
  }>;
  flush?: () => Promise<{
    channelData: Float32Array[];
    samplesDecoded: number;
    sampleRate: number;
    errors: unknown[];
  }>;
  free: () => Promise<void>;
};

export async function streamAudioBlobPcmChunks(
  file: Blob,
  format: "flac" | "wav" | "mp3",
  signal: AbortSignal | undefined,
  onChunk: (chunk: DecodedPcmChunk) => Promise<void> | void
) {
  throwIfAborted(signal);
  if (format === "wav") {
    await streamWavPcmChunks(file, signal, onChunk);
    return;
  }

  const decoder = (format === "flac"
    ? new (await import("@wasm-audio-decoders/flac")).FLACDecoderWebWorker()
    : new (await import("mpg123-decoder")).MPEGDecoderWebWorker({ enableGapless: true })) as StreamingDecoder;
  let offset = 0;
  const chunkSize = 1024 * 1024;
  let ready = false;
  try {
    await decoder.ready;
    ready = true;
    while (offset < file.size) {
      throwIfAborted(signal);
      const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer());
      if (bytes.byteLength === 0) break;
      offset += bytes.byteLength;
      const decoded = await decoder.decode(bytes);
      await consumeDecodedChunk(decoded, format, onChunk);
    }
    if (format === "flac" && decoder.flush) {
      const decoded = await decoder.flush();
      await consumeDecodedChunk(decoded, format, onChunk);
    }
  } finally {
    if (ready) {
      await decoder.free().catch(() => undefined);
    } else {
      void decoder.ready.then(() => decoder.free()).catch(() => undefined);
    }
  }
}

async function consumeDecodedChunk(
  decoded: {
    channelData: Float32Array[];
    samplesDecoded: number;
    sampleRate: number;
    errors: unknown[];
  },
  format: "flac" | "mp3",
  onChunk: (chunk: DecodedPcmChunk) => Promise<void> | void
) {
  if (decoded.errors.length > 0) {
    throw new Error(`${format === "flac" ? "FLAC" : "MP3"} 流式解码检测到数据错误。`);
  }
  if (decoded.samplesDecoded <= 0 || decoded.channelData.length === 0) return;
  if (
    !Number.isInteger(decoded.samplesDecoded) ||
    !Number.isFinite(decoded.sampleRate) ||
    decoded.sampleRate <= 0 ||
    decoded.channelData.some((channel) => channel.length !== decoded.samplesDecoded)
  ) {
    throw new Error(`${format === "flac" ? "FLAC" : "MP3"} 流式解码返回了无效 PCM。`);
  }
  if (decoded.channelData.some((channel) => {
    for (const sample of channel) {
      if (!Number.isFinite(sample)) return true;
    }
    return false;
  })) {
    throw new Error(`${format === "flac" ? "FLAC" : "MP3"} 流式解码返回了非有限 PCM。`);
  }
  await onChunk({
    channels: decoded.channelData,
    sampleRate: decoded.sampleRate,
    samplesDecoded: decoded.samplesDecoded
  });
}

async function streamWavPcmChunks(
  file: Blob,
  signal: AbortSignal | undefined,
  onChunk: (chunk: DecodedPcmChunk) => Promise<void> | void
) {
  const probe = new Uint8Array(await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer());
  const header = parseWavHeader(probe);
  const supportedBitDepth = header?.format === "float"
    ? header.bitsPerSample === 32 || header.bitsPerSample === 64
    : header?.bitsPerSample === 8 ||
      header?.bitsPerSample === 16 ||
      header?.bitsPerSample === 24 ||
      header?.bitsPerSample === 32;
  if (!header || header.dataBytes <= 0 || header.channels < 1 || header.channels > 2 || !supportedBitDepth) {
    throw new Error("WAV 文件格式或位深不受支持。");
  }
  if (
    !Number.isFinite(header.sampleRate) ||
    header.sampleRate <= 0 ||
    header.totalSamples <= 0 ||
    header.dataOffset + header.dataBytes > file.size ||
    header.dataBytes % header.blockAlign !== 0
  ) {
    throw new Error("WAV 文件数据不完整或不是完整音频帧。");
  }

  const chunkBytes = Math.max(header.blockAlign, Math.floor((1024 * 1024) / header.blockAlign) * header.blockAlign);
  let offset = header.dataOffset;
  const dataEnd = Math.min(file.size, header.dataOffset + header.dataBytes);
  while (offset < dataEnd) {
    throwIfAborted(signal);
    const end = Math.min(dataEnd, offset + chunkBytes);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    const channels = decodeWavPcmChannels(bytes, header);
    if (channels[0]?.length) {
      if (channels.some((channel) => {
        for (const sample of channel) {
          if (!Number.isFinite(sample)) return true;
        }
        return false;
      })) {
        throw new Error("WAV 文件包含非有限 PCM 样本。");
      }
      await onChunk({
        channels,
        sampleRate: header.sampleRate,
        samplesDecoded: channels[0].length
      });
    }
    if (bytes.byteLength === 0) {
      throw new Error("WAV 文件数据读取不完整。");
    }
    offset += bytes.byteLength;
  }
  if (offset !== dataEnd) {
    throw new Error("WAV 文件数据读取不完整。");
  }
}

function decodeWavPcmChannels(bytes: Uint8Array, header: WavHeader) {
  const bytesPerSample = Math.max(1, Math.floor(header.bitsPerSample / 8));
  const frameCount = Math.floor(bytes.byteLength / header.blockAlign);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = Array.from({ length: header.channels }, () => new Float32Array(frameCount));

  for (let frame = 0; frame < frameCount; frame += 1) {
    const frameOffset = frame * header.blockAlign;
    for (let channel = 0; channel < header.channels; channel += 1) {
      channels[channel]![frame] = decodeWavSample(
        view,
        frameOffset + channel * bytesPerSample,
        header.format,
        header.bitsPerSample
      );
    }
  }
  return channels;
}

function decodeWavSample(
  view: DataView,
  offset: number,
  format: "pcm" | "float",
  bitsPerSample: number
) {
  if (format === "float") {
    return bitsPerSample === 64 ? view.getFloat64(offset, true) : view.getFloat32(offset, true);
  }
  if (bitsPerSample === 8) return (view.getUint8(offset) - 128) / 128;
  if (bitsPerSample === 16) return view.getInt16(offset, true) / 32_768;
  if (bitsPerSample === 24) {
    const value = view.getUint8(offset) |
      (view.getUint8(offset + 1) << 8) |
      (view.getUint8(offset + 2) << 16);
    const signed = (value & 0x800000) !== 0 ? value | 0xff000000 : value;
    return signed / 8_388_608;
  }
  if (bitsPerSample === 32) return view.getInt32(offset, true) / 2_147_483_648;
  throw new Error(`不支持的 WAV PCM 位深：${bitsPerSample}`);
}

class PcmAccumulator {
  private readonly chunks: Array<{ start: number; channels: Float32Array[] }> = [];
  private _startSample = 0;
  private _endSample = 0;

  constructor(private readonly channelCount: number) {}

  get endSample() {
    return this._endSample;
  }

  append(channels: Float32Array[], copy = true) {
    const frameCount = channels[0]?.length ?? 0;
    if (!frameCount) return;
    if (channels.length !== this.channelCount || channels.some((channel) => channel.length !== frameCount)) {
      throw new Error("PCM 音频块的声道长度不一致。");
    }
    this.chunks.push({
      start: this._endSample,
      channels: channels.map((channel) => copy ? channel.slice() : channel)
    });
    this._endSample += frameCount;
  }

  readWindow(startSample: number, endSample: number) {
    const start = Math.max(this._startSample, Math.floor(startSample));
    const end = Math.min(this._endSample, Math.max(start, Math.ceil(endSample)));
    const output = Array.from({ length: this.channelCount }, () => new Float32Array(end - start));
    for (const chunk of this.chunks) {
      const chunkStart = chunk.start;
      const chunkEnd = chunkStart + (chunk.channels[0]?.length ?? 0);
      const overlapStart = Math.max(start, chunkStart);
      const overlapEnd = Math.min(end, chunkEnd);
      if (overlapEnd <= overlapStart) continue;
      const sourceOffset = overlapStart - chunkStart;
      const outputOffset = overlapStart - start;
      for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
        output[channelIndex]!.set(
          chunk.channels[channelIndex]!.subarray(sourceOffset, sourceOffset + overlapEnd - overlapStart),
          outputOffset
        );
      }
    }
    return output;
  }

  sampleAtClamped(sampleIndex: number, channelIndex: number) {
    if (this._endSample <= this._startSample) {
      throw new Error("重采样器没有可用的音频采样。");
    }
    const target = Math.max(this._startSample, Math.min(this._endSample - 1, Math.floor(sampleIndex)));
    for (const chunk of this.chunks) {
      const length = chunk.channels[0]?.length ?? 0;
      if (target >= chunk.start && target < chunk.start + length) {
        return chunk.channels[channelIndex]![target - chunk.start]!;
      }
    }
    throw new Error("重采样器读取了不可用的音频采样。");
  }

  trimBefore(sample: number) {
    const target = Math.max(this._startSample, Math.min(this._endSample, Math.floor(sample)));
    while (this.chunks.length > 0) {
      const first = this.chunks[0]!;
      const end = first.start + (first.channels[0]?.length ?? 0);
      if (end <= target) {
        this.chunks.shift();
        continue;
      }
      if (first.start < target) {
        const offset = target - first.start;
        first.channels = first.channels.map((channel) => channel.subarray(offset));
        first.start = target;
      }
      break;
    }
    this._startSample = target;
  }
}

export class StreamingSincResampler {
  private readonly source: PcmAccumulator;
  private outputSampleIndex = 0;
  private finished = false;
  private readonly cutoff: number;
  private readonly support: number;

  constructor(
    private readonly channelCount: number,
    private readonly sourceSampleRate: number,
    private readonly targetSampleRate: number
  ) {
    if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) {
      throw new Error("音频采样率无效。");
    }
    this.cutoff = Math.min(1, targetSampleRate / sourceSampleRate);
    this.support = 8 / this.cutoff;
    this.source = new PcmAccumulator(channelCount);
  }

  append(channels: Float32Array[]) {
    if (this.finished) throw new Error("重采样器已经结束。");
    this.source.append(channels);
    return this.drain(false);
  }

  finish() {
    this.finished = true;
    return this.drain(true);
  }

  private drain(final: boolean) {
    const sourceEnd = this.source.endSample;
    const targetEnd = final
      ? Math.round(sourceEnd * this.targetSampleRate / this.sourceSampleRate)
      : Math.ceil(sourceEnd * this.targetSampleRate / this.sourceSampleRate);
    const output = Array.from({ length: this.channelCount }, () => new Float32Array(Math.max(0, targetEnd - this.outputSampleIndex)));
    let outputCount = 0;
    while (this.outputSampleIndex < targetEnd) {
      const sourcePosition = this.outputSampleIndex * this.sourceSampleRate / this.targetSampleRate;
      const firstIndex = Math.ceil(sourcePosition - this.support);
      const lastIndex = Math.floor(sourcePosition + this.support);
      if (!final && lastIndex >= sourceEnd) break;
      if (sourceEnd <= 0 || firstIndex >= sourceEnd) break;
      let weightSum = 0;
      for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
        output[channelIndex]![outputCount] = 0;
      }
      for (let sourceIndex = firstIndex; sourceIndex <= lastIndex; sourceIndex += 1) {
        const distance = (sourcePosition - sourceIndex) * this.cutoff;
        const absoluteDistance = Math.abs(distance);
        if (absoluteDistance >= 8) continue;
        const windowDistance = absoluteDistance / 8;
        const weight = this.cutoff * sinc(distance) * (0.5 + 0.5 * Math.cos(Math.PI * windowDistance));
        if (weight === 0) continue;
        weightSum += weight;
        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
          output[channelIndex]![outputCount] += this.source.sampleAtClamped(sourceIndex, channelIndex) * weight;
        }
      }
      if (weightSum !== 0) {
        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
          output[channelIndex]![outputCount] /= weightSum;
        }
      }
      outputCount += 1;
      this.outputSampleIndex += 1;
    }
    const nextSourcePosition = this.outputSampleIndex * this.sourceSampleRate / this.targetSampleRate;
    this.source.trimBefore(Math.max(0, Math.floor(nextSourcePosition - this.support - 1)));
    return output.map((channel) => channel.slice(0, outputCount));
  }

  private sourceSampleAt(sampleIndex: number, channelIndex: number) {
    return this.source.sampleAtClamped(sampleIndex, channelIndex);
  }
}

function sinc(value: number) {
  if (value === 0) return 1;
  const angle = Math.PI * value;
  return Math.sin(angle) / angle;
}

async function encodePlaybackAsset(
  input: {
    draftId: string;
    fileHash: string | Promise<string>;
    signal?: AbortSignal;
    onProgress?: (progress: AssetPreparationProgress) => void;
  },
  audioBuffer: Pick<
    AudioBuffer,
    "duration" | "sampleRate" | "numberOfChannels" | "length" | "getChannelData"
  >
): Promise<PreparedPlaybackAsset> {
  if (audioBuffer.numberOfChannels < 1 || audioBuffer.numberOfChannels > 2) {
    throw new Error("仅支持单声道或双声道音频。");
  }
  assertDecodedPcmWithinMemoryBudget({
    durationSeconds: audioBuffer.duration,
    channels: audioBuffer.numberOfChannels
  });

  const channels = audioBuffer.numberOfChannels as 1 | 2;
  const loudness = await analyzeAudioBufferAsync(audioBuffer, input.signal);
  const bitrate = channels === 1 ? 128_000 as const : 256_000 as const;
  const durationMs = Math.max(1, Math.round(audioBuffer.duration * 1000));
  const sourceSampleRate = audioBuffer.sampleRate;
  const unitCount = Math.ceil(durationMs / segmentDurationMs);
  const leafHashes: Array<string | undefined> = new Array(unitCount);
  const concurrency = resolveEncodingConcurrency(unitCount);
  const encoderPool = acquireOpusEncoderPool(concurrency);
  const { encoders } = encoderPool;
  const draftQueue = createPlaybackDraftUnitQueue(input.draftId);
  let nextUnitIndex = 0;
  let completedUnits = 0;

  try {
    await Promise.all(encoders.map(async (encoder) => {
      while (true) {
        const unitIndex = nextUnitIndex++;
        if (unitIndex >= unitCount) return;
        throwIfAborted(input.signal);
        const segment = slicePcmSegment(audioBuffer, unitIndex);
        const encodedSegment = prepareIndependentOpusSegment(segment, sourceSampleRate);
        const payload = await encoder.encode({
          sampleRate: sourceSampleRate,
          channels: encodedSegment.channels,
          bitrateKbps: channels === 1 ? 128 : 256
        });
        const contentHash = await hashAssetUnit(unitIndex, payload);
        await draftQueue.enqueue({
          unitIndex,
          descriptor: {
            kind: "playback",
            unitIndex,
            payloadBytes: payload.byteLength,
            startMs: unitIndex * segmentDurationMs,
            durationMs: Math.min(segmentDurationMs, durationMs - unitIndex * segmentDurationMs),
            trimStartSamples: encodedSegment.trimStartSamples,
            trimEndSamples: encodedSegment.trimEndSamples
          },
          contentHash,
          payload
        });
        leafHashes[unitIndex] = contentHash;
        completedUnits += 1;
        input.onProgress?.({ stage: "encoding", completed: completedUnits, total: unitCount });
      }
    }));
    await draftQueue.finish();
  } finally {
    await draftQueue.waitForIdle();
    encoderPool.release();
  }

  const completeLeafHashes = leafHashes.map((hash) => {
    if (!hash) throw new Error("Playback encoding did not produce every segment hash.");
    return hash;
  });
  const tree = await buildMerkleTree(completeLeafHashes);
  const fileHash = await input.fileHash;
  const manifestWithoutId = {
    kind: "playback" as const,
    sourceFileHash: fileHash,
    profileId: playbackProfileId,
    codec: "opus" as const,
    container: "audio/ogg" as const,
    sampleRate: opusSampleRate as 48000,
    channels,
    bitrate,
    durationMs,
    segmentDurationMs: segmentDurationMs as 2000,
    seekPrerollMs: seekPrerollMs as 80,
    unitCount,
    merkleRoot: tree.root,
    encoder: { name: "@audio/opus-encode" as const, version: playbackEncoderVersion }
  };
  const playbackAsset = playbackAssetManifestSchema.parse({
    ...manifestWithoutId,
    assetId: await computeAssetId(manifestWithoutId)
  });
  return {
    playbackAsset,
    loudness,
    leafHashes: completeLeafHashes,
    proofs: tree.proofs,
    draftId: input.draftId
  };
}

export function resolveEncodingConcurrency(unitCount: number, hardwareConcurrency =
  typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency) {
  if (!Number.isFinite(unitCount) || unitCount <= 0) return 1;
  const availableWorkers = Number.isFinite(hardwareConcurrency)
    ? Math.max(1, Math.floor(hardwareConcurrency) - 1)
    : 2;
  return Math.min(unitCount, 4, availableWorkers);
}

export function slicePcmSegment(
  audioBuffer: Pick<AudioBuffer, "duration" | "sampleRate" | "numberOfChannels" | "length" | "getChannelData">,
  unitIndex: number
) {
  const segmentSamples = Math.round((segmentDurationMs / 1000) * audioBuffer.sampleRate);
  const prerollSamples = Math.round((seekPrerollMs / 1000) * audioBuffer.sampleRate);
  const postrollSamples = Math.max(
    1,
    Math.ceil((opusPreSkipSamples * audioBuffer.sampleRate) / opusSampleRate)
  );
  const contentStart = unitIndex * segmentSamples;
  const start = Math.max(0, contentStart - prerollSamples);
  const contentEnd = Math.min(audioBuffer.length, contentStart + segmentSamples);
  const end = Math.min(audioBuffer.length, contentEnd + postrollSamples);
  const sourceChannels = Array.from({ length: audioBuffer.numberOfChannels }, (_, channelIndex) =>
    audioBuffer.getChannelData(channelIndex).slice(start, end)
  );
  return {
    channels: sourceChannels,
    trimStartSamples: unitIndex === 0 ? 0 : prerollSamples,
    contentSamples: Math.max(0, contentEnd - contentStart)
  };
}

type EncodablePlaybackSegment = {
  channels: Float32Array[];
  trimStartSamples: number;
  contentSamples: number;
};

export function prepareIndependentOpusSegment(
  segment: EncodablePlaybackSegment,
  sourceSampleRate = opusSampleRate
) {
  const inputLength = segment.channels[0]?.length ?? 0;
  if (inputLength <= 0) {
    throw new Error("音频片段为空。");
  }

  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) {
    throw new Error("音频采样率无效。");
  }
  const sourceToOpus = opusSampleRate / sourceSampleRate;
  const trimStartSamples = Math.max(
    0,
    Math.round(segment.trimStartSamples * sourceToOpus)
  );
  const contentSamples = Math.max(
    0,
    Math.round(segment.contentSamples * sourceToOpus)
  );
  const sourceContentStart = Math.min(inputLength, Math.max(0, segment.trimStartSamples));
  const sourceContentEnd = Math.min(
    inputLength,
    sourceContentStart + Math.max(0, segment.contentSamples)
  );
  const sourceTailSamples = Math.max(0, inputLength - sourceContentEnd);
  const requiredTailSamples = Math.ceil(opusPreSkipSamples / sourceToOpus);
  const tailPaddingSamples = Math.max(0, requiredTailSamples - sourceTailSamples);

  // Encode real post-roll when available. At EOF, repeating the last sample
  // keeps the codec lookahead stable instead of forcing a hard step to zero at
  // every 2s boundary.
  // Normal segments already contain real post-roll. Keep their buffers so
  // the encoder worker can take ownership without another full PCM copy.
  const channels = tailPaddingSamples > 0
    ? segment.channels.map((channel) => {
        const padded = new Float32Array(channel.length + tailPaddingSamples);
        padded.set(channel);
        const lastSample = channel[channel.length - 1] ?? 0;
        padded.fill(lastSample, channel.length);
        return padded;
      })
    : segment.channels;
  const encodedInputLength = channels[0]!.length;
  const encodedSampleLength = Math.round(encodedInputLength * sourceToOpus);
  const encodedFrameLength = Math.ceil(encodedSampleLength / opusFrameSamples) * opusFrameSamples;
  const decodedLength = Math.max(0, encodedFrameLength - opusPreSkipSamples);
  const trimEndSamples = Math.max(
    0,
    decodedLength - trimStartSamples - contentSamples
  );
  return {
    channels,
    trimStartSamples,
    trimEndSamples
  };
}

async function inspectDecodePlan(
  file: File,
  format: SupportedAudioUploadFormat,
  onProgress?: (progress: AssetPreparationProgress) => void,
  expectedDurationMs?: number
) {
  let durationSeconds: number | undefined =
    expectedDurationMs && expectedDurationMs > 0
      ? expectedDurationMs / 1000
      : undefined;
  let channels: number | undefined;
  onProgress?.({ stage: "inspecting", completed: 0, total: 1 });
  const shouldParseMetadata = format === "m4a" || durationSeconds === undefined;
  if (shouldParseMetadata) {
    try {
      const { parseBlob } = await import("music-metadata");
      const metadata = await parseBlob(file, {
        duration: durationSeconds === undefined,
        skipCovers: true
      });
      if (
        typeof metadata.format.duration === "number" &&
        Number.isFinite(metadata.format.duration) &&
        metadata.format.duration > 0
      ) {
        durationSeconds = metadata.format.duration;
      }
      channels = typeof metadata.format.numberOfChannels === "number" &&
        Number.isFinite(metadata.format.numberOfChannels) &&
        metadata.format.numberOfChannels > 0
        ? metadata.format.numberOfChannels
        : undefined;
    } catch {
      // The browser decoder or the format-specific streaming decoder remains authoritative.
    }
  }
  onProgress?.({ stage: "inspecting", completed: 1, total: 1 });
  if (durationSeconds !== undefined && channels === undefined) {
    channels = 2;
  }
  const estimatedPcmBytes = durationSeconds !== undefined && channels !== undefined
    ? estimateDecodedPcmBytes({ durationSeconds, channels })
    : 0;
  return {
    durationSeconds,
    channels,
    estimatedPcmBytes,
    useStreaming:
      resolveDecodePath(estimatedPcmBytes, format) === "streaming" ||
      durationSeconds === undefined ||
      channels === undefined
  };
}

export function estimateDecodedPcmBytes(input: {
  durationSeconds: number;
  channels: number;
}) {
  if (
    !Number.isFinite(input.durationSeconds) ||
    input.durationSeconds <= 0 ||
    !Number.isFinite(input.channels) ||
    input.channels <= 0
  ) {
    return 0;
  }
  return Math.ceil(input.durationSeconds * opusSampleRate * Math.ceil(input.channels) * 4);
}

export function assertDecodedPcmWithinMemoryBudget(input: {
  durationSeconds: number;
  channels: number;
}) {
  const estimatedBytes = estimateDecodedPcmBytes(input);
  if (estimatedBytes > maxDecodedPcmBytes) {
    throw new AudioDecodeMemoryLimitError(
      "音频过长，预计解码内存超过 256 MB，请先切分音频再上传。"
    );
  }
}

export function resolveDecodePath(
  estimatedPcmBytes: number,
  format?: SupportedAudioUploadFormat
) {
  if (format === "flac" || format === "wav" || format === "mp3") {
    return "streaming";
  }
  return Number.isFinite(estimatedPcmBytes) && estimatedPcmBytes > maxDecodedPcmBytes
    ? "streaming"
    : "full";
}

async function readFileUnit(file: File, unitIndex: number) {
  return file.slice(
    unitIndex * originalUnitSize,
    Math.min(file.size, (unitIndex + 1) * originalUnitSize)
  ).arrayBuffer();
}

async function decodeAudioFile(file: Blob) {
  if (file.size > maxFullDecodeFileBytes) {
    throw new AudioDecodeMemoryLimitError(
      "音频文件过大，预计解码内存超出浏览器安全上限，请先切分音频或转为 FLAC/MP3。"
    );
  }
  let offlineContext: OfflineAudioContext | null = null;
  if (typeof OfflineAudioContext === "function") {
    try {
      offlineContext = new OfflineAudioContext(1, 1, opusSampleRate);
    } catch {
      offlineContext = null;
    }
  }
  if (offlineContext) {
    const buffer = await file.arrayBuffer();
    return await offlineContext.decodeAudioData(buffer);
  }

  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: opusSampleRate });
  } catch {
    context = new AudioContext();
  }
  try {
    const buffer = await file.arrayBuffer();
    return await context.decodeAudioData(buffer);
  } finally {
    await context.close().catch(() => undefined);
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("Audio asset preparation was cancelled.", "AbortError");
  }
}

function createPlaybackDraftId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `playback-draft-${crypto.randomUUID()}`;
  }
  return `playback-draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function mimeTypeFromFileName(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".flac")) return "audio/flac";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".m4a") || lower.endsWith(".mp4") || lower.endsWith(".aac")) return "audio/mp4";
  return "audio/mpeg";
}
