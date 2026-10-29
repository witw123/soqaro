import { beforeEach, describe, expect, it, vi } from "vitest";

const indexedDbMocks = vi.hoisted(() => ({
  deleteCachedLibraryTrack: vi.fn(),
  deleteCachedLibraryTrackFile: vi.fn(),
  deleteOriginalAssetForTrack: vi.fn(),
  deleteLocalAudioCacheFileRecord: vi.fn(),
  getAssetManifest: vi.fn(),
  getAssetUnits: vi.fn(),
  getCachedLibraryTrack: vi.fn(),
  getCachedLibraryTrackByProviderTrack: vi.fn(),
  getCachedLibraryTrackSummaryByProviderTrack: vi.fn(),
  getCachedLibraryTrackSummary: vi.fn(),
  getLocalAudioDirectory: vi.fn(),
  getLocalAudioFileRecord: vi.fn(),
  getLocalAudioCacheFileRecord: vi.fn(),
  getLocalPlaylistDirectory: vi.fn(),
  getTrackAssetLink: vi.fn(),
  listCachedLibraryTrackHashes: vi.fn(),
  listCachedLibraryTracks: vi.fn(),
  listCachedLibraryTrackSummaries: vi.fn(),
  listLocalAudioCacheFiles: vi.fn(),
  listLocalAudioFiles: vi.fn(),
  saveLocalAudioCacheFileRecord: vi.fn(),
  saveLocalAudioDirectory: vi.fn(),
  markLocalRepositoryIndexReady: vi.fn(),
  saveLocalAudioFileRecord: vi.fn()
}));

vi.mock("@/features/library/indexeddb", () => indexedDbMocks);
vi.mock("./local-repository-hydration", () => ({ hydrateLocalRepository: vi.fn() }));
import { LocalRepository } from "./local-repository";

import {
  chooseLocalAudioDirectory,
  ensureLocalAudioDirectoryWriteAccess,
  getOriginalAssetFile,
  getLocalAudioStorageState,
  getRoomLocalAudioFile,
  saveCachedAudioFileToLocalDirectory
} from "./local-audio-storage";

function createDirectoryHandle(input: {
  queryPermission: PermissionState;
  requestPermission: PermissionState;
}) {
  const writable = {
    write: vi.fn(),
    close: vi.fn(),
    abort: vi.fn()
  };
  const fileHandle = {
    getFile: vi.fn().mockResolvedValue(new File([JSON.stringify({
      format: "soqaro-local-repository", schemaVersion: 1,
      repositoryId: "repository_1", hashAlgorithm: "sha256",
      playbackProfiles: {}, createdAt: "2026-09-19", updatedAt: "2026-09-19"
    })], "repository.json")),
    createWritable: vi.fn().mockResolvedValue(writable)
  };
  const cacheDirectory = {
    getDirectoryHandle: vi.fn(),
    getFileHandle: vi.fn().mockImplementation(async (_name, options) => {
      if (!options?.create && _name !== "repository.json") {
        throw new DOMException("missing", "NotFoundError");
      }
      return fileHandle;
    }),
    removeEntry: vi.fn()
  };
  cacheDirectory.getDirectoryHandle.mockResolvedValue(cacheDirectory);
  const handle = {
    name: "Soqaro",
    queryPermission: vi.fn().mockResolvedValue(input.queryPermission),
    requestPermission: vi.fn().mockResolvedValue(input.requestPermission),
    getDirectoryHandle: vi.fn().mockResolvedValue(cacheDirectory),
    getFileHandle: vi.fn().mockRejectedValue(new DOMException("missing", "NotFoundError"))
  };
  return { handle, writable };
}

type MemoryFileEntry = {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
  // Needed for `repository.json`; without it `LocalRepository.open` throws and
  // every caller quietly falls back to "no repository", which is not what these
  // tests are measuring.
  createWritable: () => Promise<{
    write: (chunk: unknown) => Promise<void>;
    close: () => Promise<void>;
    abort: () => Promise<void>;
  }>;
};

type MemoryDirectoryEntry = {
  kind: "directory";
  name: string;
  queryPermission: () => Promise<PermissionState>;
  requestPermission: () => Promise<PermissionState>;
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<MemoryDirectoryEntry>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<MemoryFileEntry>;
  values: () => AsyncGenerator<MemoryFileEntry | MemoryDirectoryEntry>;
  removeEntry: (name: string) => Promise<void>;
};

/**
 * A directory tree that answers the OPFS calls `LocalRepository.open` and
 * `getFileByPath` make, recording which segments were requested and whether the
 * caller asked to create them. The create flag is what distinguishes an actual
 * repository open from the read-only path walk, which visits the same
 * `.soqaro` segment.
 */
function createMemoryTree(fileSizes: Record<string, number>) {
  const openedDirectoryPaths: string[] = [];
  const requestedFilePaths: string[] = [];

  const buildDirectory = (name: string, directoryPath: string): MemoryDirectoryEntry => {
    const children = new Map<string, MemoryDirectoryEntry>();
    const files = new Map<string, MemoryFileEntry>();
    const directory: MemoryDirectoryEntry = {
      kind: "directory",
      name,
      queryPermission: async () => "granted",
      requestPermission: async () => "granted",
      async getDirectoryHandle(childName, options) {
        const childPath = `${directoryPath}/${childName}`;
        openedDirectoryPaths.push(options?.create ? `${childPath} [create]` : childPath);
        const existing = children.get(childName);
        if (existing) return existing;
        if (!options?.create) throw new DOMException("missing", "NotFoundError");
        const child = buildDirectory(childName, childPath);
        children.set(childName, child);
        return child;
      },
      async getFileHandle(fileName, options) {
        const filePath = `${directoryPath}/${fileName}`;
        requestedFilePaths.push(options?.create ? `${filePath} [create]` : filePath);
        const existing = files.get(fileName);
        if (existing) return existing;
        if (!(filePath in fileSizes) && !options?.create) {
          throw new DOMException("missing", "NotFoundError");
        }
        let contents = "";
        const entry: MemoryFileEntry = {
          kind: "file",
          name: fileName,
          getFile: async () => new File(
            [fileSizes[filePath] !== undefined ? new Uint8Array(fileSizes[filePath]) : contents],
            fileName
          ),
          createWritable: async () => ({
            write: async (chunk) => {
              contents = String(chunk);
            },
            close: async () => undefined,
            abort: async () => undefined
          })
        };
        files.set(fileName, entry);
        return entry;
      },
      async *values() {
        yield* children.values();
        yield* files.values();
      },
      removeEntry: async () => undefined
    };
    return directory;
  };

  const root = buildDirectory("Soqaro", "") as unknown as FileSystemDirectoryHandle;
  return {
    root,
    async initialize() {
      await LocalRepository.initialize(root);
      for (const path of Object.keys(fileSizes)) {
        const parts = path.slice(1).split("/");
        let directory = root;
        for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
        await directory.getFileHandle(parts.at(-1)!);
      }
      openedDirectoryPaths.length = 0;
      requestedFilePaths.length = 0;
    },
    openedDirectoryPaths,
    requestedFilePaths
  };
}

describe("local audio storage reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    indexedDbMocks.getLocalAudioDirectory.mockResolvedValue(null);
    indexedDbMocks.getLocalPlaylistDirectory.mockResolvedValue(null);
    indexedDbMocks.listCachedLibraryTrackHashes.mockResolvedValue([]);
    indexedDbMocks.listCachedLibraryTrackSummaries.mockResolvedValue([]);
    indexedDbMocks.listLocalAudioFiles.mockResolvedValue([]);
    indexedDbMocks.listLocalAudioCacheFiles.mockResolvedValue([]);
    indexedDbMocks.getCachedLibraryTrack.mockResolvedValue(null);
    indexedDbMocks.getLocalAudioFileRecord.mockResolvedValue(null);
  });

  async function useRootDirectory(tree: ReturnType<typeof createMemoryTree>) {
    await tree.initialize();
    indexedDbMocks.getLocalAudioDirectory.mockResolvedValue({
      id: "default",
      handle: tree.root,
      name: "Soqaro",
      updatedAt: "2026-09-01T00:00:00.000Z"
    });
  }

  function savedRecords(relativePaths: string[]) {
    return relativePaths.map((relativePath, index) => ({
      fileHash: `hash_${index}`,
      sizeBytes: (index + 1) * 10,
      fileName: relativePath.split("/").pop()!,
      relativePath,
      storageKind: "saved" as const,
      savedAt: "2026-09-01T00:00:00.000Z"
    }));
  }

  it("uses the saved index without opening audio files for statistics", async () => {
    const tree = createMemoryTree({
      "/.soqaro/catalog/tracks/track_0.mp3": 10,
      "/.soqaro/catalog/tracks/track_1.mp3": 20,
      "/.soqaro/catalog/tracks/track_2.mp3": 30
    });
    await useRootDirectory(tree);
    indexedDbMocks.listLocalAudioFiles.mockResolvedValue(savedRecords([
      ".soqaro/catalog/tracks/track_0.mp3",
      ".soqaro/catalog/tracks/track_1.mp3",
      ".soqaro/catalog/tracks/track_2.mp3"
    ]));

    const { getLocalAudioStorageStats } = await import("./local-audio-storage");

    await expect(getLocalAudioStorageStats()).resolves.toMatchObject({
      saved: { fileCount: 3, bytes: 60 }
    });

    expect(tree.requestedFilePaths.some((path) => path.endsWith(".mp3"))).toBe(false);
    expect(indexedDbMocks.listLocalAudioFiles).toHaveBeenCalledTimes(1);
    expect(indexedDbMocks.listLocalAudioCacheFiles).toHaveBeenCalledTimes(1);
    expect(indexedDbMocks.listCachedLibraryTrackSummaries).toHaveBeenCalledTimes(1);
  });

  it("opens the repository once for both storage kinds", async () => {
    const tree = createMemoryTree({ "/.soqaro/catalog/tracks/track_0.mp3": 10 });
    await useRootDirectory(tree);
    indexedDbMocks.listLocalAudioFiles.mockResolvedValue([
      ...savedRecords([".soqaro/catalog/tracks/track_0.mp3"]),
      ...savedRecords([".soqaro/catalog/tracks/gone.mp3"])
    ]);
    indexedDbMocks.listLocalAudioCacheFiles.mockResolvedValue([
      {
        fileHash: "cache_hash",
        fileName: "track_0.mp3",
        relativePath: ".soqaro/catalog/tracks/track_0.mp3",
        storageKind: "cached" as const,
        savedAt: "2026-09-01T00:00:00.000Z"
      }
    ]);

    const { getLocalAudioStorageState } = await import("./local-audio-storage");

    await expect(getLocalAudioStorageState({ verifyFiles: true })).resolves.toMatchObject({
      savedFileHashes: ["hash_0"],
      cachedFileHashes: ["cache_hash"]
    });
    expect(tree.openedDirectoryPaths.some((path) => path.includes("[create]"))).toBe(false);
    expect(tree.requestedFilePaths.filter((path) => path.endsWith("repository.json"))).toHaveLength(1);
  });

  it("resolves a record from a user-picked source directory through that directory", async () => {
    const rootTree = createMemoryTree({});
    const sourceTree = createMemoryTree({ "/song.mp3": 42 });
    await useRootDirectory(rootTree);
    indexedDbMocks.getLocalPlaylistDirectory.mockResolvedValue({
      id: "source_1",
      handle: sourceTree.root,
      name: "Picked Folder"
    });
    indexedDbMocks.getLocalAudioFileRecord.mockResolvedValue({
      fileHash: "hash_0",
      fileName: "song.mp3",
      sourceDirectoryId: "source_1",
      storageKind: "saved",
      savedAt: "2026-09-01T00:00:00.000Z"
    });

    const { getLocalAudioFile } = await import("./local-audio-storage");

    const file = await getLocalAudioFile("hash_0", "source_1", "song.mp3");

    expect(file?.size).toBe(42);
    expect(indexedDbMocks.getLocalPlaylistDirectory).toHaveBeenCalledWith("source_1");
    expect(sourceTree.requestedFilePaths).toContain("/song.mp3");
    expect(rootTree.requestedFilePaths).not.toContain("/song.mp3");
  });

  it("excludes external source files from managed storage statistics", async () => {
    const tree = createMemoryTree({ "/song.mp3": 42 });
    await useRootDirectory(tree);
    indexedDbMocks.listLocalAudioFiles.mockResolvedValue([
      {
        fileHash: "hash_0",
        fileName: "song.mp3",
        // Present, but the source-directory branch wins — the shared repository
        // must not be consulted for these records.
        relativePath: ".soqaro/catalog/tracks/absent.mp3",
        sourceDirectoryId: "source_1",
        storageKind: "saved" as const,
        savedAt: "2026-09-01T00:00:00.000Z"
      }
    ]);

    const { getLocalAudioStorageStats } = await import("./local-audio-storage");

    await expect(getLocalAudioStorageStats()).resolves.toMatchObject({
      saved: { fileCount: 0, bytes: 0 }
    });
    expect(indexedDbMocks.getLocalPlaylistDirectory).not.toHaveBeenCalled();
    expect(tree.requestedFilePaths).not.toContain("/song.mp3");
    expect(tree.requestedFilePaths).not.toContain("/.soqaro/catalog/tracks/absent.mp3");
  });
});

describe("local audio cache persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    indexedDbMocks.getLocalAudioDirectory.mockResolvedValue(null);
    indexedDbMocks.getLocalAudioFileRecord.mockResolvedValue(null);
    indexedDbMocks.getCachedLibraryTrack.mockResolvedValue(null);
    indexedDbMocks.getCachedLibraryTrackByProviderTrack.mockResolvedValue(null);
    indexedDbMocks.getCachedLibraryTrackSummaryByProviderTrack.mockResolvedValue(undefined);
    indexedDbMocks.listCachedLibraryTrackHashes.mockResolvedValue([]);
    indexedDbMocks.listCachedLibraryTrackSummaries.mockResolvedValue([]);
    indexedDbMocks.listLocalAudioFiles.mockResolvedValue([]);
    indexedDbMocks.listLocalAudioCacheFiles.mockResolvedValue([]);
    indexedDbMocks.getTrackAssetLink.mockResolvedValue(null);
    indexedDbMocks.getCachedLibraryTrackSummary.mockResolvedValue(null);
  });

  it("stores the selected root directory in IndexedDB", async () => {
    const { handle } = createDirectoryHandle({
      queryPermission: "granted",
      requestPermission: "granted"
    });
    const picker = vi.fn().mockResolvedValue(handle);
    vi.stubGlobal("window", { showDirectoryPicker: picker, dispatchEvent: vi.fn() });

    await expect(chooseLocalAudioDirectory()).resolves.toBe("Soqaro");

    expect(picker).toHaveBeenCalledWith({ mode: "readwrite" });
    expect(indexedDbMocks.saveLocalAudioDirectory).toHaveBeenCalledWith({
      handle,
      name: "Soqaro",
      repositoryId: expect.any(String),
      schemaVersion: 1
    });

    vi.unstubAllGlobals();
  });

  it("restores the configured root directory from IndexedDB", async () => {
    const { handle } = createDirectoryHandle({
      queryPermission: "granted",
      requestPermission: "granted"
    });
    indexedDbMocks.getLocalAudioDirectory.mockResolvedValue({
      id: "default",
      handle,
      name: "Soqaro",
      repositoryId: "repository_1",
      schemaVersion: 1,
      updatedAt: "2026-08-07T00:00:00.000Z"
    });

    await expect(getLocalAudioStorageState()).resolves.toMatchObject({
      directoryName: "Soqaro",
      permission: "granted"
    });
  });

  it("uses the browser library copy for room-local playback", async () => {
    const file = new Blob(["audio"], { type: "audio/mpeg" });
    indexedDbMocks.getCachedLibraryTrack.mockResolvedValue({ file });

    await expect(getRoomLocalAudioFile({
      trackId: "track_1",
      fileHash: "hash_1",
      title: "Song",
      mimeType: "audio/mpeg"
    })).resolves.toBe(file);
  });

  it("uses a room original asset for local playback", async () => {
    indexedDbMocks.getTrackAssetLink.mockResolvedValue({
      originalAssetId: "asset_1"
    });
    indexedDbMocks.getAssetManifest.mockResolvedValue({
      complete: true,
      manifest: {
        kind: "original",
        assetId: "asset_1",
        fileHash: "hash_1",
        unitCount: 1
      }
    });
    indexedDbMocks.getAssetUnits.mockResolvedValue([
      { unitIndex: 0, payload: new ArrayBuffer(8) }
    ]);

    await expect(getRoomLocalAudioFile({
      trackId: "track_1",
      fileHash: "hash_1",
      title: "Song",
      mimeType: "audio/mpeg"
    })).resolves.toEqual(expect.any(File));

    expect(indexedDbMocks.getAssetManifest).toHaveBeenCalledWith("asset_1");
  });

  it("matches a member's provider cache even when the room hash differs", async () => {
    const file = new Blob(["cached provider audio"], { type: "audio/mpeg" });
    indexedDbMocks.getCachedLibraryTrackByProviderTrack.mockResolvedValue({ file });

    await expect(getRoomLocalAudioFile({
      trackId: "room_track",
      fileHash: "room_hash",
      title: "Song",
      mimeType: "audio/mpeg",
      provider: "netease",
      providerTrackId: "provider_track"
    })).resolves.toBe(file);
  });

  it("reports the actual browser and folder cache sizes", async () => {
    indexedDbMocks.listCachedLibraryTrackHashes.mockResolvedValue(["browser_hash"]);
    indexedDbMocks.listCachedLibraryTrackSummaries.mockResolvedValue([
      { fileHash: "browser_hash", sizeBytes: 12 },
      { fileHash: "folder_hash", sizeBytes: 34 }
    ]);
    indexedDbMocks.listLocalAudioCacheFiles.mockResolvedValue([
      { fileHash: "folder_hash", sizeBytes: 34 }
    ]);

    const { getLocalAudioCacheStats } = await import("./local-audio-storage");

    await expect(getLocalAudioCacheStats()).resolves.toEqual({
      fileCount: 2,
      bytes: 46
    });
    // The summary rows already carry the byte counts; pulling the blobs out of
    // IndexedDB to re-measure them was one read per cached track.
    expect(indexedDbMocks.getCachedLibraryTrack).not.toHaveBeenCalled();
  });

  it("uses the browser blob size when legacy metadata has no size", async () => {
    indexedDbMocks.listCachedLibraryTrackHashes.mockResolvedValue(["browser_hash"]);
    indexedDbMocks.listCachedLibraryTrackSummaries.mockResolvedValue([
      { fileHash: "browser_hash" }
    ]);
    indexedDbMocks.getCachedLibraryTrack.mockResolvedValue({
      file: new Blob(["audio"], { type: "audio/mpeg" })
    });

    const { getLocalAudioCacheStats } = await import("./local-audio-storage");

    await expect(getLocalAudioCacheStats()).resolves.toEqual({
      fileCount: 1,
      bytes: 5
    });
  });

  it("clears cached audio without touching saved audio records", async () => {
    indexedDbMocks.listCachedLibraryTrackHashes.mockResolvedValue(["browser_hash"]);
    indexedDbMocks.listCachedLibraryTrackSummaries.mockResolvedValue([
      { fileHash: "browser_hash", sizeBytes: 12 },
      { fileHash: "saved_hash", sizeBytes: 34 }
    ]);

    const { clearLocalAudioCache } = await import("./local-audio-storage");

    await expect(clearLocalAudioCache()).resolves.toEqual({
      deletedEntryCount: 1,
      failedEntryCount: 0
    });
    expect(indexedDbMocks.deleteCachedLibraryTrack).toHaveBeenCalledWith("browser_hash");
    expect(indexedDbMocks.deleteCachedLibraryTrack).not.toHaveBeenCalledWith("saved_hash");
    expect(indexedDbMocks.deleteLocalAudioCacheFileRecord).not.toHaveBeenCalled();
  });

  it("rebuilds an owner source file from a complete original asset", async () => {
    indexedDbMocks.getAssetManifest.mockResolvedValue({
      kind: "original",
      complete: true,
      manifest: {
        assetId: "asset_1",
        kind: "original",
        fileHash: "hash_1",
        mimeType: "audio/mpeg",
        sizeBytes: 5,
        unitSize: 1024 * 1024,
        unitCount: 2,
        merkleRoot: "root_1"
      }
    });
    indexedDbMocks.getAssetUnits.mockResolvedValue([
      { unitIndex: 1, payload: new Uint8Array([3, 4]).buffer },
      { unitIndex: 0, payload: new Uint8Array([1, 2]).buffer }
    ]);

    const file = await getOriginalAssetFile({
      assetId: "asset_1",
      fileHash: "hash_1",
      title: "Song",
      mimeType: "audio/mpeg"
    });

    expect(file).not.toBeNull();
    expect(file?.name).toBe("Song [hash_1].mp3");
    expect([...new Uint8Array(await file!.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });

  it("requires a root instead of retaining audio in an implicit fallback", async () => {
    await expect(saveCachedAudioFileToLocalDirectory({
      file: new Blob(["audio"], { type: "audio/mpeg" }),
      fileHash: "hash_1",
      title: "Song",
      mimeType: "audio/mpeg"
    })).rejects.toThrow("请先选择 Soqaro 根目录");

    expect(indexedDbMocks.saveLocalAudioCacheFileRecord).not.toHaveBeenCalled();
    expect(indexedDbMocks.deleteCachedLibraryTrackFile).not.toHaveBeenCalled();
  });

  it("writes to cache and removes the browser source copy when a folder is configured", async () => {
    const { handle, writable } = createDirectoryHandle({
      queryPermission: "granted",
      requestPermission: "granted"
    });
    indexedDbMocks.getLocalAudioDirectory.mockResolvedValue({
      handle,
      name: "Soqaro"
    });
    const file = new Blob(["audio"], { type: "audio/mpeg" });

    await expect(saveCachedAudioFileToLocalDirectory({
      file,
      fileHash: "hash_1",
      title: "Song",
      mimeType: "audio/mpeg"
    })).resolves.toMatchObject({ fileName: "Song [hash_1].mp3" });

    expect(writable.write).toHaveBeenCalledWith(file);
    expect(indexedDbMocks.saveLocalAudioCacheFileRecord).toHaveBeenCalledWith({
      fileHash: "hash_1",
      fileName: "Song [hash_1].mp3",
      relativePath: ".soqaro/cache/provider/local_upload/ha/hash_1.mp3",
      sizeBytes: 5
    });
    expect(indexedDbMocks.deleteCachedLibraryTrackFile).toHaveBeenCalledWith("hash_1");
  });

  it("fails instead of falling back when the configured folder is not writable", async () => {
    const { handle } = createDirectoryHandle({
      queryPermission: "denied",
      requestPermission: "denied"
    });
    indexedDbMocks.getLocalAudioDirectory.mockResolvedValue({
      handle,
      name: "Soqaro"
    });

    await expect(ensureLocalAudioDirectoryWriteAccess()).rejects.toThrow(
      "请重新选择根文件夹"
    );
    expect(indexedDbMocks.deleteCachedLibraryTrackFile).not.toHaveBeenCalled();
  });
});
