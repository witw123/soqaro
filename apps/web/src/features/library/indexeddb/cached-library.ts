import {
  backfillCachedLibraryTrackMetadataIfNeeded,
  soqaroDatabase,
  toCachedLibraryTrackSummaryRecord,
  type AssetUnitDescriptor,
  type CachedLibraryTrackRecord,
  type CachedLibraryTrackSummaryRecord
} from "./database";

export { backfillCachedLibraryTrackMetadataIfNeeded, toCachedLibraryTrackSummaryRecord };

export function removeCachedLibrarySourceReferences(
  record: Pick<
    CachedLibraryTrackRecord,
    "sourceTrackIds" | "sourceRoomIds" | "lastSourceTrackId" | "lastSourceRoomId" | "lastOwnerNickname"
  >,
  removedTrackIds: readonly string[],
  removedRoomId?: string
) {
  const removed = new Set(removedTrackIds);
  const shouldRemoveReference = (trackId: string | undefined, index: number) =>
    !!trackId &&
    removed.has(trackId) &&
    (!removedRoomId || record.sourceRoomIds[index] === removedRoomId || record.sourceRoomIds[index] === undefined);
  const sourceTrackIds = record.sourceTrackIds.filter(
    (trackId, index) => !shouldRemoveReference(trackId, index)
  );
  const sourceRoomIds = record.sourceRoomIds.filter(
    (_, index) => !shouldRemoveReference(record.sourceTrackIds[index], index)
  );
  const lastSourceTrackId = record.lastSourceTrackId && sourceTrackIds.includes(record.lastSourceTrackId)
    ? record.lastSourceTrackId
    : sourceTrackIds[sourceTrackIds.length - 1] ?? null;
  const lastSourceWasRemoved = lastSourceTrackId !== record.lastSourceTrackId;

  return {
    sourceTrackIds,
    sourceRoomIds,
    lastSourceTrackId,
    lastSourceRoomId: lastSourceWasRemoved ? null : record.lastSourceRoomId,
    lastOwnerNickname: lastSourceWasRemoved ? null : record.lastOwnerNickname,
    isUnreferenced: sourceTrackIds.length === 0
  };
}


export async function upsertCachedLibraryTrack(input: Omit<CachedLibraryTrackRecord, "cachedAt"> & {
  cachedAt?: string;
}) {
  const existing = await soqaroDatabase.cachedTrackLibraryMetadata.get(input.fileHash);
  const cachedAt = input.cachedAt ?? existing?.cachedAt ?? new Date().toISOString();
  const record: CachedLibraryTrackRecord = {
    ...input,
    ...(input.loudness ?? existing?.loudness
      ? { loudness: input.loudness ?? existing?.loudness }
      : {}),
    cachedAt,
    sourceTrackIds: [...new Set([...(existing?.sourceTrackIds ?? []), ...input.sourceTrackIds])],
    sourceRoomIds: [...new Set([...(existing?.sourceRoomIds ?? []), ...input.sourceRoomIds])]
  };
  await soqaroDatabase.transaction(
    "rw",
    soqaroDatabase.cachedTrackLibrary,
    soqaroDatabase.cachedTrackLibraryMetadata,
    async () => {
      await soqaroDatabase.cachedTrackLibrary.put(record);
      await soqaroDatabase.cachedTrackLibraryMetadata.put(
        toCachedLibraryTrackSummaryRecord(record)
      );
    }
  );
}

export async function updateCachedLibraryTrackMetadata(
  fileHash: string,
  metadata: Partial<Pick<CachedLibraryTrackRecord,
    "artworkUrl" | "lyrics" | "translatedLyrics" | "romanizedLyrics" | "loudness">>
) {
  // Patch existing rows only: background enrichment must not recreate released audio.
  await soqaroDatabase.transaction(
    "rw",
    soqaroDatabase.cachedTrackLibrary,
    soqaroDatabase.cachedTrackLibraryMetadata,
    async () => {
      await soqaroDatabase.cachedTrackLibrary.update(fileHash, metadata);
      await soqaroDatabase.cachedTrackLibraryMetadata.update(fileHash, metadata);
    }
  );
}

export async function putPlaybackAssetDraftUnit(input: {
  draftId: string;
  unitIndex: number;
  descriptor: Omit<AssetUnitDescriptor, "assetId" | "contentHash" | "proof">;
  contentHash: string;
  payload: ArrayBuffer;
}) {
  await putPlaybackAssetDraftUnits({
    draftId: input.draftId,
    units: [input]
  });
}

export async function putPlaybackAssetDraftUnits(input: {
  draftId: string;
  units: Array<{
    unitIndex: number;
    descriptor: Omit<AssetUnitDescriptor, "assetId" | "contentHash" | "proof">;
    contentHash: string;
    payload: ArrayBuffer;
  }>;
}) {
  if (input.units.length === 0) return;
  const createdAt = new Date().toISOString();
  await soqaroDatabase.playbackAssetDraftUnits.bulkPut(
    input.units.map((unit) => ({
      draftUnitId: `${input.draftId}:${unit.unitIndex}`,
      draftId: input.draftId,
      unitIndex: unit.unitIndex,
      descriptor: unit.descriptor,
      contentHash: unit.contentHash,
      payload: unit.payload,
      createdAt
    }))
  );
}

export async function getPlaybackAssetDraftUnitBatch(
  draftId: string,
  offset: number,
  limit: number
) {
  return soqaroDatabase.playbackAssetDraftUnits
    .where("[draftId+unitIndex]")
    .between(
      [draftId, Math.max(0, offset)],
      [draftId, Number.MAX_SAFE_INTEGER],
      true,
      false
    )
    .limit(Math.max(1, limit))
    .toArray();
}

export async function deletePlaybackAssetDraft(draftId: string) {
  await soqaroDatabase.playbackAssetDraftUnits.where("draftId").equals(draftId).delete();
}

export async function releaseAssetUnitsToLocalRepository(assetId: string) {
  await soqaroDatabase.assetUnits.where("assetId").equals(assetId).delete();
}

export async function listCachedLibraryTracks() {
  return soqaroDatabase.cachedTrackLibrary.orderBy("cachedAt").reverse().toArray();
}

export async function listCachedLibraryTrackSummaries() {
  await backfillCachedLibraryTrackMetadataIfNeeded();
  return soqaroDatabase.cachedTrackLibraryMetadata.orderBy("cachedAt").reverse().toArray();
}

export async function listCachedLibraryTrackHashes() {
  const keys = await soqaroDatabase.cachedTrackLibrary.toCollection().primaryKeys();
  return keys.filter((key): key is string => typeof key === "string");
}

export async function getCachedLibraryTrack(fileHash: string) {
  return soqaroDatabase.cachedTrackLibrary.get(fileHash);
}

export async function getCachedLibraryTrackSummaryByProviderTrack(
  provider: string,
  providerTrackId: string
) {
  if (!provider || !providerTrackId) {
    return undefined;
  }
  await backfillCachedLibraryTrackMetadataIfNeeded();
  return soqaroDatabase.cachedTrackLibraryMetadata
    .where("[provider+providerTrackId]")
    .equals([provider, providerTrackId])
    .first();
}

export async function getCachedLibraryTrackByProviderTrack(
  provider: string,
  providerTrackId: string
) {
  const summary = await getCachedLibraryTrackSummaryByProviderTrack(provider, providerTrackId);
  if (!summary) {
    return undefined;
  }
  return soqaroDatabase.cachedTrackLibrary.get(summary.fileHash);
}

export async function deleteCachedLibraryTrackFile(fileHash: string) {
  await soqaroDatabase.cachedTrackLibrary.delete(fileHash);
}

export async function getCachedLibraryTrackSummary(fileHash: string) {
  const summary = await soqaroDatabase.cachedTrackLibraryMetadata.get(fileHash);
  if (summary) {
    return summary;
  }

  const record = await soqaroDatabase.cachedTrackLibrary.get(fileHash);
  if (!record) {
    return null;
  }

  const backfilledSummary = toCachedLibraryTrackSummaryRecord(record);
  await soqaroDatabase.cachedTrackLibraryMetadata.put(backfilledSummary);
  return backfilledSummary;
}

export async function getCachedLibraryTrackCount() {
  await backfillCachedLibraryTrackMetadataIfNeeded();
  return soqaroDatabase.cachedTrackLibraryMetadata.count();
}

export async function deleteCachedLibraryTrack(fileHash: string) {
  const record = await soqaroDatabase.cachedTrackLibrary.get(fileHash);
  if (!record) {
    await soqaroDatabase.cachedTrackLibraryMetadata.delete(fileHash);
    return null;
  }

  await soqaroDatabase.transaction(
    "rw",
    soqaroDatabase.cachedTrackLibrary,
    soqaroDatabase.cachedTrackLibraryMetadata,
    async () => {
      await soqaroDatabase.cachedTrackLibrary.delete(fileHash);
      await soqaroDatabase.cachedTrackLibraryMetadata.delete(fileHash);
    }
  );
  return record;
}

export async function upsertCachedLibraryTrackSummary(
  input: CachedLibraryTrackSummaryRecord
) {
  const existing = await soqaroDatabase.cachedTrackLibraryMetadata.get(input.fileHash);
  await soqaroDatabase.cachedTrackLibraryMetadata.put({
    ...existing,
    ...input,
    sourceTrackIds: [...new Set([...(existing?.sourceTrackIds ?? []), ...input.sourceTrackIds])],
    sourceRoomIds: [...new Set([...(existing?.sourceRoomIds ?? []), ...input.sourceRoomIds])]
  });
}
