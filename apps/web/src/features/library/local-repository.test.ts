import { describe, expect, it, vi } from "vitest";
import type { RoomSnapshot, TrackMeta } from "@soqaro/shared";
import {
  createRepositoryTrackRecord,
  LocalRepository
} from "./local-repository";

class MemoryFileHandle {
  readonly kind = "file" as const;
  blob = new Blob();

  constructor(public readonly name: string) {}

  async getFile() {
    return new File([this.blob], this.name);
  }

  async createWritable() {
    let pending = this.blob;
    return {
      write: async (value: Blob | string) => {
        pending = typeof value === "string" ? new Blob([value]) : value;
      },
      close: async () => {
        this.blob = pending;
      },
      abort: async () => undefined
    };
  }
}

class MemoryDirectoryHandle {
  readonly kind = "directory" as const;
  private readonly directories = new Map<string, MemoryDirectoryHandle>();
  private readonly files = new Map<string, MemoryFileHandle>();

  constructor(public readonly name: string) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!options?.create) throw new DOMException("missing", "NotFoundError");
    const directory = new MemoryDirectoryHandle(name);
    this.directories.set(name, directory);
    return directory;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.files.get(name);
    if (existing) return existing;
    if (!options?.create) throw new DOMException("missing", "NotFoundError");
    const file = new MemoryFileHandle(name);
    this.files.set(name, file);
    return file;
  }

  async removeEntry(name: string) {
    if (this.files.delete(name) || this.directories.delete(name)) return;
    throw new DOMException("missing", "NotFoundError");
  }

  async *values() {
    yield* this.directories.values();
    yield* this.files.values();
  }
}

describe("LocalRepository", () => {
  it("opens an existing repository without creating directories or rewriting the manifest", async () => {
    const root = new MemoryDirectoryHandle("Soqaro");
    await LocalRepository.initialize(root);
    const getDirectory = vi.spyOn(root, "getDirectoryHandle");
    const data = await root.getDirectoryHandle(".soqaro");
    const manifest = await data.getFileHandle("repository.json");
    const write = vi.spyOn(manifest, "createWritable");
    getDirectory.mockClear();
    await LocalRepository.open(root, { recover: false });
    expect(getDirectory).toHaveBeenCalledExactlyOnceWith(".soqaro");
    expect(write).not.toHaveBeenCalled();
  });

  it("does not scan audio directories when listing auxiliary files", async () => {
    const root = new MemoryDirectoryHandle("Soqaro");
    const repository = await LocalRepository.initialize(root);
    const audioPath = await repository.writeManagedSource({
      file: new Blob(["audio"]), fileHash: "a".repeat(64), mimeType: "audio/mpeg"
    });
    await repository.writeLyrics("a".repeat(64), "lyrics");
    const library = await (await root.getDirectoryHandle(".soqaro")).getDirectoryHandle("library");
    const audioDirectory = await (await library.getDirectoryHandle("sources")).getDirectoryHandle("aa");
    const audio = await audioDirectory.getFileHandle(audioPath.split("/").at(-1)!);
    const readAudio = vi.spyOn(audio, "getFile");
    expect(await repository.listFiles([".soqaro/library/lyrics/"])).toHaveLength(1);
    expect(readAudio).not.toHaveBeenCalled();
  });

  it("does not regenerate a global catalog when writing one track", async () => {
    const repository = await LocalRepository.initialize(new MemoryDirectoryHandle("Soqaro"));
    const listTracks = vi.spyOn(repository, "listTracks");
    await repository.writeTrack(createRepositoryTrackRecord({
      fileHash: "a".repeat(64), title: "Song", artist: "Artist",
      mimeType: "audio/mpeg", durationMs: 1000, sizeBytes: 5,
      source: { kind: "managed", relativePath: ".soqaro/library/sources/a.mp3" },
      retention: "library"
    }));
    expect(listTracks).not.toHaveBeenCalled();
    expect(await repository.readPath(".soqaro/catalog/index.json")).toBeNull();
  });
  function buildTrack(id: string, fileHash: string, ownerSessionId: string): TrackMeta {
    return {
      id,
      title: id,
      artist: `Artist ${ownerSessionId}`,
      album: "Album",
      lyrics: `[00:00.00]${id}`,
      durationMs: 1_000,
      bitrate: 128_000,
      sizeBytes: 5,
      codec: "mp3",
      mimeType: "audio/mpeg",
      fileHash,
      artworkUrl: `https://example.com/${id}.jpg`,
      ownerSessionId,
      ownerNickname: ownerSessionId,
      sourceType: "local_upload"
    };
  }

  function buildRoomSnapshot(tracks: TrackMeta[]): RoomSnapshot {
    return {
      room: {
        id: "room-1",
        hostId: "owner-a",
        joinCode: "ROOM01",
        visibility: "private",
        roomType: "interactive",
        radioAutopilot: { enabled: false },
        members: [],
        playback: {
          status: "paused",
          currentTrackId: null,
          currentQueueItemId: null,
          playbackAssetId: null,
          sourceSessionId: null,
          sourcePeerId: null,
          sourceTrackId: null,
          positionMs: 0,
          startedAt: null,
          queueVersion: 1,
          playbackRevision: 1,
          mediaEpoch: 0
        },
        presenceRevision: 0,
        roomRevision: 1
      },
      tracks,
      queue: [],
      playlists: []
    };
  }

  it("mirrors room track metadata and keeps uploader references separate", async () => {
    const root = new MemoryDirectoryHandle("Soqaro") as unknown as FileSystemDirectoryHandle;
    const repository = await LocalRepository.initialize(root);
    const firstTrack = buildTrack("track-a", "a".repeat(64), "owner-a");
    const secondTrack = buildTrack("track-b", "b".repeat(64), "owner-b");

    await repository.writeRoomSnapshot(buildRoomSnapshot([firstTrack, secondTrack]));

    const room = await repository.readRoom("room-1");
    expect(room?.tracks.map((track) => track.id)).toEqual(["track-a", "track-b"]);
    expect((await repository.readTrack(firstTrack.fileHash))?.roomRefs).toEqual([
      {
        roomId: "room-1",
        trackId: "track-a",
        ownerSessionId: "owner-a",
        ownerNickname: "owner-a"
      }
    ]);
    expect((await repository.readTrack(secondTrack.fileHash))?.roomRefs?.[0]?.ownerSessionId).toBe("owner-b");

    await repository.writeRoomSnapshot(buildRoomSnapshot([secondTrack]));

    expect((await repository.readTrack(firstTrack.fileHash))?.roomRefs).toBeUndefined();
    expect((await repository.readTrack(secondTrack.fileHash))?.roomRefs).toHaveLength(1);
    expect((await repository.listRooms())).toHaveLength(1);
  });

  it("creates a repository and persists source, track, and playlist records", async () => {
    const root = new MemoryDirectoryHandle("Soqaro") as unknown as FileSystemDirectoryHandle;
    const repository = await LocalRepository.initialize(root);
    const sourcePath = await repository.writeManagedSource({
      file: new Blob(["audio"], { type: "audio/mpeg" }),
      fileHash: "a".repeat(64),
      mimeType: "audio/mpeg"
    });
    const track = createRepositoryTrackRecord({
      fileHash: "a".repeat(64),
      title: "Song",
      artist: "Artist",
      mimeType: "audio/mpeg",
      durationMs: 1_000,
      sizeBytes: 5,
      source: { kind: "managed", relativePath: sourcePath },
      retention: "library"
    });
    await repository.writeTrack(track);
    await repository.writePlaylist({
      schemaVersion: 1,
      id: "playlist-1",
      title: "Favorites",
      description: null,
      trackRefs: [{ kind: "content", fileHash: "a".repeat(64) }],
      createdAt: track.createdAt,
      updatedAt: track.updatedAt
    });

    expect(await repository.readPath(sourcePath)).not.toBeNull();
    expect((await repository.listTracks()).map((item) => item.fileHash)).toEqual(["a".repeat(64)]);
    expect((await repository.listPlaylists()).map((item) => item.id)).toEqual(["playlist-1"]);
  });

  it("persists playback units under the profile and asset id", async () => {
    const root = new MemoryDirectoryHandle("Soqaro") as unknown as FileSystemDirectoryHandle;
    const repository = await LocalRepository.initialize(root);
    const assetId = "b".repeat(64);
    const sourceFileHash = "c".repeat(64);
    const manifest = {
      assetId,
      kind: "playback" as const,
      sourceFileHash,
      profileId: "opus-music-v4" as const,
      codec: "opus" as const,
      container: "audio/ogg" as const,
      sampleRate: 48_000 as const,
      channels: 1 as const,
      bitrate: 128_000 as const,
      durationMs: 2_000,
      segmentDurationMs: 2_000 as const,
      seekPrerollMs: 80 as const,
      unitCount: 1,
      merkleRoot: "d".repeat(64),
      encoder: { name: "@audio/opus-encode" as const, version: "3.4.0" as const }
    };
    const descriptor = {
      assetId,
      kind: "playback" as const,
      unitIndex: 0,
      payloadBytes: 3,
      contentHash: "e".repeat(64),
      proof: [],
      startMs: 0,
      durationMs: 2_000,
      trimStartSamples: 0,
      trimEndSamples: 0
    };
    await repository.writePlaybackAsset({
      manifest,
      units: [{ descriptor, payload: new Uint8Array([1, 2, 3]).buffer }]
    });

    const persisted = await repository.listPlaybackAssets();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.manifest.assetId).toBe(assetId);
    const file = await repository.readPlaybackUnit(persisted[0]!.units[0]!);
    expect(file).not.toBeNull();
    expect([...new Uint8Array(await file!.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("writes data-url artwork without network fetch", async () => {
    const root = new MemoryDirectoryHandle("Soqaro") as unknown as FileSystemDirectoryHandle;
    const repository = await LocalRepository.initialize(root);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const dataUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
    const path = await repository.writeArtworkFromUrl({
      fileHash: "f".repeat(64),
      artworkUrl: dataUrl,
      retention: "library"
    });
    expect(path).toBe(`.soqaro/library/artwork/${"f".repeat(64)}.jpg`);
    expect(fetchSpy).not.toHaveBeenCalled();
    const file = await repository.readPath(path!);
    expect(file).not.toBeNull();
    fetchSpy.mockRestore();
  });

  it("does not rewrite unchanged track records when appending a track to a room snapshot", async () => {
    const root = new MemoryDirectoryHandle("Soqaro");
    const repository = await LocalRepository.initialize(root as unknown as FileSystemDirectoryHandle);
    const firstTrack = buildTrack("track-a", "a".repeat(64), "owner-a");
    const secondTrack = buildTrack("track-b", "b".repeat(64), "owner-b");

    await repository.writeRoomSnapshot(buildRoomSnapshot([firstTrack]));
    const writeTrackSpy = vi.spyOn(repository, "writeTrack");

    await repository.writeRoomSnapshot(buildRoomSnapshot([firstTrack, secondTrack]));

    expect(writeTrackSpy).toHaveBeenCalledTimes(1);
    expect(writeTrackSpy.mock.calls[0]?.[0]?.fileHash).toBe(secondTrack.fileHash);
  });

  it("skips playback unit directories when listing playback manifests", async () => {
    const root = new MemoryDirectoryHandle("Soqaro");
    const repository = await LocalRepository.initialize(root as unknown as FileSystemDirectoryHandle);
    const assetId = "b".repeat(64);
    await repository.writePlaybackAsset({
      manifest: {
        assetId,
        kind: "playback",
        sourceFileHash: "c".repeat(64),
        profileId: "opus-music-v4",
        codec: "opus",
        container: "audio/ogg",
        sampleRate: 48_000,
        channels: 1,
        bitrate: 128_000,
        durationMs: 2_000,
        segmentDurationMs: 2_000,
        seekPrerollMs: 80,
        unitCount: 1,
        merkleRoot: "d".repeat(64),
        encoder: { name: "@audio/opus-encode", version: "3.4.0" }
      },
      units: [{
        descriptor: {
          assetId,
          kind: "playback",
          unitIndex: 0,
          payloadBytes: 3,
          contentHash: "e".repeat(64),
          proof: [],
          startMs: 0,
          durationMs: 2_000,
          trimStartSamples: 0,
          trimEndSamples: 0
        },
        payload: new Uint8Array([1, 2, 3]).buffer
      }]
    });

    const unitsDir = await (
      await (
        await (
          await (await root.getDirectoryHandle(".soqaro")).getDirectoryHandle("assets")
        ).getDirectoryHandle("playback")
      ).getDirectoryHandle("opus-music-v4")
    ).getDirectoryHandle(assetId).then((dir) => dir.getDirectoryHandle("units"));
    const unitsValuesSpy = vi.spyOn(unitsDir, "values");

    const assets = await repository.listPlaybackAssets();
    expect(assets).toHaveLength(1);
    expect(unitsValuesSpy).not.toHaveBeenCalled();
  });
});
