import {
  assetUnitDescriptorSchema,
  playbackProfileId,
  verifyAssetUnit,
  type AssetUnitDescriptor,
  type AudioAssetManifest
} from "@soqaro/shared";
import { LocalRepository } from "../local-repository";
import { getLocalAudioDirectory } from "./storage-records";
import {
  assetUnitId,
  soqaroDatabase,
  type AudioAssetManifestRecord,
  type AudioAssetUnitRecord,
  type TrackAssetLinkRecord,
  type TranscodeJobRecord
} from "./database";

export async function putAssetManifest(
  manifest: AudioAssetManifest,
  options?: { complete?: boolean }
) {
  const now = new Date().toISOString();
  const existing = await soqaroDatabase.assetManifests.get(manifest.assetId);
  await soqaroDatabase.assetManifests.put({
    assetId: manifest.assetId,
    kind: manifest.kind,
    sourceFileHash:
      manifest.kind === "original" ? manifest.fileHash : manifest.sourceFileHash,
    manifest,
    complete: options?.complete ?? existing?.complete ?? false,
    createdAt: existing?.createdAt ?? now,
    lastAccessedAt: now
  });
}

export async function getAssetManifest(
  assetId: string,
  options?: { includeLocalRepository?: boolean }
) {
  const record = await soqaroDatabase.assetManifests.get(assetId);
  if (record?.complete || options?.includeLocalRepository === false) {
    if (record) {
      await soqaroDatabase.assetManifests.update(assetId, {
        lastAccessedAt: new Date().toISOString()
      });
    }
    return record ?? null;
  }

  if (!record) {
    const repository = await getLocalRepositoryForAssetRead();
    if (!repository) return null;

    const original = await repository.readOriginalManifest(assetId);
    if (original?.manifest.kind === "original") {
      return createLocalAssetManifestRecord(repository, original.manifest);
    }

    const playback = await repository.readPlaybackAsset(assetId, playbackProfileId);
    return playback?.manifest.kind === "playback"
      ? createLocalAssetManifestRecord(repository, playback.manifest)
      : null;
  }

  const repository = await getLocalRepositoryForAssetRead();
  if (repository) {
    const original = await repository.readOriginalManifest(assetId);
    if (original?.manifest.kind === "original") {
      return createLocalAssetManifestRecord(repository, original.manifest);
    }

    const playback = await repository.readPlaybackAsset(assetId, playbackProfileId);
    if (playback?.manifest.kind === "playback") {
      return createLocalAssetManifestRecord(repository, playback.manifest);
    }
  }

  if (record) {
    await soqaroDatabase.assetManifests.update(assetId, {
      lastAccessedAt: new Date().toISOString()
    });
    return record;
  }
  return null;
}

export async function getCompleteAssetPairForSourceFileHash(fileHash: string) {
  const records = await soqaroDatabase.assetManifests
    .where("sourceFileHash")
    .equals(fileHash)
    .toArray();
  const original = records.find(
    (record) => record.complete && record.manifest.kind === "original"
  );
  const playback = records.find(
    (record) =>
      record.complete &&
      record.manifest.kind === "playback" &&
      record.manifest.profileId === playbackProfileId
  );
  if (original && playback) return { original, playback };

  const repository = await getLocalRepositoryForAssetRead();
  if (!repository) return null;

  const localTrack = await repository.readTrack(fileHash);
  if (localTrack?.originalAsset?.assetId && localTrack?.playbackAsset?.assetId) {
    const [originalRecord, playbackRecord] = await Promise.all([
      repository.readOriginalManifest(localTrack.originalAsset.assetId),
      repository.readPlaybackAsset(localTrack.playbackAsset.assetId, playbackProfileId)
    ]);
    if (
      originalRecord?.manifest.kind === "original" &&
      originalRecord.manifest.fileHash === fileHash &&
      playbackRecord?.manifest.kind === "playback" &&
      playbackRecord.manifest.profileId === playbackProfileId &&
      playbackRecord.manifest.sourceFileHash === fileHash &&
      playbackRecord.units.length === playbackRecord.manifest.unitCount
    ) {
      return {
        original: createLocalAssetManifestRecord(repository, originalRecord.manifest),
        playback: createLocalAssetManifestRecord(repository, playbackRecord.manifest)
      };
    }
  }

  return null;
}

export async function deleteAudioAsset(assetId: string) {
  await soqaroDatabase.transaction(
    "rw",
    soqaroDatabase.assetManifests,
    soqaroDatabase.assetUnits,
    async () => {
      await soqaroDatabase.assetUnits.where("assetId").equals(assetId).delete();
      await soqaroDatabase.assetManifests.delete(assetId);
    }
  );
}

export async function putVerifiedAssetUnit(input: {
  descriptor: AssetUnitDescriptor;
  payload: ArrayBuffer;
  protectedUntil?: string | null;
}) {
  const descriptor = assetUnitDescriptorSchema.parse(input.descriptor);
  const manifestRecord = await soqaroDatabase.assetManifests.get(descriptor.assetId);
  if (!manifestRecord || manifestRecord.kind !== descriptor.kind) {
    throw new Error("Asset manifest is missing or does not match the unit kind.");
  }
  if (descriptor.unitIndex >= manifestRecord.manifest.unitCount) {
    throw new Error("Asset unit index exceeds the manifest unit count.");
  }
  if (input.payload.byteLength !== descriptor.payloadBytes) {
    throw new Error("Asset unit payload length does not match its descriptor.");
  }
  if (descriptor.unitIndex >= manifestRecord.manifest.unitCount) {
    throw new RangeError("Asset unit index exceeds the manifest unit count.");
  }
  const valid = await verifyAssetUnit({
    unitIndex: descriptor.unitIndex,
    payload: input.payload,
    contentHash: descriptor.contentHash,
    proof: descriptor.proof,
    merkleRoot: manifestRecord.manifest.merkleRoot
  });
  if (!valid) {
    throw new Error("Asset unit failed Merkle verification.");
  }

  const now = new Date().toISOString();
  await soqaroDatabase.assetUnits.put({
    ...descriptor,
    unitId: assetUnitId(descriptor.assetId, descriptor.unitIndex),
    payload: input.payload,
    lastAccessedAt: now,
    protectedUntil: input.protectedUntil ?? null
  });
  const unitCount = await soqaroDatabase.assetUnits.where("assetId").equals(descriptor.assetId).count();
  if (unitCount >= manifestRecord.manifest.unitCount) {
    await soqaroDatabase.assetManifests.update(descriptor.assetId, {
      complete: true,
      lastAccessedAt: now
    });
  }
}

export async function putLocallyGeneratedAssetUnits(input: {
  assetId: string;
  units: Array<{ descriptor: AssetUnitDescriptor; payload: ArrayBuffer }>;
  complete?: boolean;
}) {
  if (input.units.length === 0) return;
  const manifestRecord = await soqaroDatabase.assetManifests.get(input.assetId);
  if (!manifestRecord) {
    throw new Error("Asset manifest is missing for locally generated units.");
  }
  const now = new Date().toISOString();
  const records = input.units.map(({ descriptor: rawDescriptor, payload }) => {
    const descriptor = assetUnitDescriptorSchema.parse(rawDescriptor);
    if (
      descriptor.assetId !== input.assetId ||
      descriptor.kind !== manifestRecord.kind ||
      descriptor.unitIndex >= manifestRecord.manifest.unitCount ||
      payload.byteLength !== descriptor.payloadBytes
    ) {
      throw new Error("Locally generated asset unit does not match its manifest.");
    }
    return {
      ...descriptor,
      unitId: assetUnitId(descriptor.assetId, descriptor.unitIndex),
      payload,
      lastAccessedAt: now,
      protectedUntil: null
    } satisfies AudioAssetUnitRecord;
  });
  await soqaroDatabase.transaction(
    "rw",
    soqaroDatabase.assetManifests,
    soqaroDatabase.assetUnits,
    async () => {
      await soqaroDatabase.assetUnits.bulkPut(records);
      if (input.complete) {
        const unitCount = await soqaroDatabase.assetUnits
          .where("assetId")
          .equals(input.assetId)
          .count();
        if (unitCount !== manifestRecord.manifest.unitCount) {
          throw new Error("Locally generated asset is incomplete after persistence.");
        }
        await soqaroDatabase.assetManifests.update(input.assetId, {
          complete: true,
          lastAccessedAt: now
        });
      }
    }
  );
}

export async function getAssetUnit(assetId: string, unitIndex: number) {
  const unitId = assetUnitId(assetId, unitIndex);
  const record = await soqaroDatabase.assetUnits.get(unitId);
  if (record) {
    await soqaroDatabase.assetUnits.update(unitId, {
      lastAccessedAt: new Date().toISOString()
    });
    return record;
  }

  return getLocalPlaybackUnit(assetId, unitIndex);
}

export async function getAssetUnits(assetId: string, unitIndexes: readonly number[]) {
  const uniqueIndexes = [...new Set(unitIndexes.filter((index) => Number.isInteger(index) && index >= 0))];
  if (uniqueIndexes.length === 0) {
    return [];
  }
  const records = await soqaroDatabase.assetUnits.bulkGet(
    uniqueIndexes.map((index) => assetUnitId(assetId, index))
  );
  const byIndex = new Map(
    records
      .filter((record): record is AudioAssetUnitRecord => !!record)
      .map((record) => [record.unitIndex, record] as const)
  );
  if (byIndex.size < uniqueIndexes.length) {
    const repository = await getLocalRepositoryForAssetRead();
    if (repository) {
      for (const unitIndex of uniqueIndexes) {
        if (byIndex.has(unitIndex)) continue;
        const localUnit = await getLocalPlaybackUnitFromRepository(
          repository,
          assetId,
          unitIndex
        );
        if (localUnit) byIndex.set(unitIndex, localUnit);
      }
    }
  }
  return uniqueIndexes.flatMap((unitIndex) => {
    const record = byIndex.get(unitIndex);
    return record ? [record] : [];
  });
}

export async function getAssetUnitIndexes(assetId: string) {
  const keys = await soqaroDatabase.assetUnits.where("assetId").equals(assetId).primaryKeys();
  const indexes = keys.flatMap((key) => {
    if (typeof key !== "string") {
      return [];
    }
    const index = Number(key.slice(key.lastIndexOf(":") + 1));
    return Number.isInteger(index) && index >= 0 ? [index] : [];
  });
  if (indexes.length > 0) return indexes.sort((left, right) => left - right);

  const repository = await getLocalRepositoryForAssetRead();
  if (!repository) return [];
  const playback = await repository.readPlaybackAsset(assetId, playbackProfileId);
  return playback?.units
    .map((unit) => unit.descriptor.unitIndex)
    .sort((left, right) => left - right) ?? [];
}

async function getLocalRepositoryForAssetRead() {
  const directory = await getLocalAudioDirectory();
  if (!directory) return null;
  return LocalRepository.open(directory.handle, { recover: false }).catch(() => null);
}

function createLocalAssetManifestRecord(
  repository: LocalRepository,
  manifest: AudioAssetManifest
): AudioAssetManifestRecord {
  return {
    assetId: manifest.assetId,
    kind: manifest.kind,
    sourceFileHash: manifest.kind === "original" ? manifest.fileHash : manifest.sourceFileHash,
    manifest,
    complete: true,
    createdAt: repository.manifest.createdAt,
    lastAccessedAt: new Date().toISOString()
  };
}

async function getLocalPlaybackUnit(assetId: string, unitIndex: number) {
  const repository = await getLocalRepositoryForAssetRead();
  return repository
    ? getLocalPlaybackUnitFromRepository(repository, assetId, unitIndex)
    : null;
}

async function getLocalPlaybackUnitFromRepository(
  repository: LocalRepository,
  assetId: string,
  unitIndex: number
) {
  const playback = await repository.readPlaybackAsset(assetId, playbackProfileId);
  const unit = playback?.units.find((candidate) => candidate.descriptor.unitIndex === unitIndex);
  if (!unit) return null;
  const file = await repository.readPlaybackUnit(unit);
  if (!file) return null;
  return {
    ...unit.descriptor,
    unitId: assetUnitId(assetId, unitIndex),
    payload: await file.arrayBuffer(),
    lastAccessedAt: new Date().toISOString(),
    protectedUntil: null
  } satisfies AudioAssetUnitRecord;
}

export async function linkTrackAssets(input: Omit<TrackAssetLinkRecord, "linkedAt">) {
  await soqaroDatabase.trackAssetLinks.put({
    ...input,
    linkedAt: new Date().toISOString()
  });
}

export async function getTrackAssetLink(trackId: string) {
  return (await soqaroDatabase.trackAssetLinks.get(trackId)) ?? null;
}

export async function deleteOriginalAssetForTrack(trackId: string) {
  const link = await getTrackAssetLink(trackId);
  if (link?.originalAssetId) {
    await deleteAudioAsset(link.originalAssetId);
  }
}

export async function upsertTranscodeJob(
  input: Omit<TranscodeJobRecord, "updatedAt">,
  options?: { persistRepository?: boolean }
) {
  const record = {
    ...input,
    updatedAt: new Date().toISOString()
  } satisfies TranscodeJobRecord;
  await soqaroDatabase.transcodeJobs.put(record);

  if (options?.persistRepository === false) return;
  const directory = await getLocalAudioDirectory();
  if (directory) {
    await LocalRepository.open(directory.handle, { recover: false })
      .then((repository) => repository.writeTranscodeJob(record))
      .catch(() => undefined);
  }
}

export async function listQueuedTranscodeJobs() {
  return soqaroDatabase.transcodeJobs.where("status").equals("queued").toArray();
}
