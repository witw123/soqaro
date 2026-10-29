"use client";

import type { RoomSnapshot } from "@soqaro/shared";
import { getLocalAudioDirectory } from "@/features/library/indexeddb";
import { LocalRepository } from "./local-repository";
import { enqueueLocalRepositoryWrite } from "./local-repository-queue";

const pendingSnapshotsByRoomId = new Map<string, RoomSnapshot>();
const activeRoomWrites = new Map<string, Promise<boolean>>();

export async function persistRoomSnapshotToLocalRepository(snapshot: RoomSnapshot) {
  const roomId = snapshot.room.id;
  pendingSnapshotsByRoomId.set(roomId, snapshot);

  const existingWrite = activeRoomWrites.get(roomId);
  if (existingWrite) {
    return existingWrite;
  }

  const writePromise = (async () => {
    let wroteAny = false;
    while (pendingSnapshotsByRoomId.has(roomId)) {
      const latestSnapshot = pendingSnapshotsByRoomId.get(roomId)!;
      pendingSnapshotsByRoomId.delete(roomId);
      const wrote = await enqueueLocalRepositoryWrite(async () => {
        const directory = await getLocalAudioDirectory();
        if (!directory) return false;

        const repository = await LocalRepository.open(directory.handle, { recover: false });
        await repository.writeRoomSnapshot(latestSnapshot);
        return true;
      });
      wroteAny = wroteAny || wrote;
    }
    return wroteAny;
  })().finally(() => {
    activeRoomWrites.delete(roomId);
  });

  activeRoomWrites.set(roomId, writePromise);
  return writePromise;
}

export async function deleteRoomSnapshotFromLocalRepository(roomId: string) {
  pendingSnapshotsByRoomId.delete(roomId);
  return enqueueLocalRepositoryWrite(async () => {
    const directory = await getLocalAudioDirectory();
    if (!directory) return false;

    const repository = await LocalRepository.open(directory.handle, { recover: false });
    await repository.removeRoomTrackReferences(roomId);
    await repository.deleteRoom(roomId);
    return true;
  });
}
