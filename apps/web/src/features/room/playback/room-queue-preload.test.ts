import { describe, expect, it, vi } from "vitest";
import type { RoomSnapshot, TrackMeta } from "@soqaro/shared";
import { getRoomQueuePreloadTracks, RoomAudioPreloader } from "./room-queue-preload";

const tracks = ["a", "b", "c", "d"].map((id) => ({ id, fileHash: id } as TrackMeta));
function snapshot(mode = "sequence", nextQueueItemId: string | null = null) {
  return {
    room: { playback: {
      currentTrackId: "a", currentQueueItemId: "qa",
      playbackMode: mode, nextQueueItemId, shuffleBagTrackIds: ["d", "c", "b"]
    } },
    tracks,
    queue: tracks.map((track) => ({ id: `q${track.id}`, trackId: track.id }))
  } as RoomSnapshot;
}

describe("room queue preload", () => {
  it("prepares two sequential tracks and prioritizes an explicit next item", () => {
    expect(getRoomQueuePreloadTracks(snapshot()).map((track) => track.id)).toEqual(["b", "c"]);
    expect(getRoomQueuePreloadTracks(snapshot("sequence", "qd")).map((track) => track.id))
      .toEqual(["d", "b"]);
  });
  it("uses the shuffle bag and avoids unrelated preloads in single mode", () => {
    expect(getRoomQueuePreloadTracks(snapshot("shuffle")).map((track) => track.id))
      .toEqual(["d", "c"]);
    expect(getRoomQueuePreloadTracks(snapshot("single"))).toEqual([]);
    expect(getRoomQueuePreloadTracks(snapshot("single", "qc")).map((track) => track.id))
      .toEqual(["c"]);
  });
  it("preloads the beginning of the queue when sequential playback wraps", () => {
    const room = snapshot();
    room.room.playback.currentTrackId = "d";
    room.room.playback.currentQueueItemId = "qd";
    expect(getRoomQueuePreloadTracks(room).map((track) => track.id)).toEqual(["a", "b"]);
  });
  it("reuses the pending preload on track switch and releases removed entries", async () => {
    let finish!: (file: Blob) => void;
    const read = vi.fn(() => new Promise<Blob>((resolve) => { finish = resolve; }));
    const preloader = new RoomAudioPreloader(read);
    preloader.update([tracks[1]!]);
    const playing = preloader.get(tracks[1]!);
    expect(read).toHaveBeenCalledTimes(1);
    const file = new Blob(["audio"]);
    finish(file);
    await expect(playing).resolves.toBe(file);
    preloader.update([]);
    preloader.update([tracks[1]!]);
    expect(read).toHaveBeenCalledTimes(2);
    finish(file);
  });
  it("does not repeatedly read missing files on room updates", async () => {
    const read = vi.fn(async () => null);
    const preloader = new RoomAudioPreloader(read);
    preloader.update([tracks[1]!]);
    await preloader.get(tracks[1]!);
    preloader.update([tracks[1]!]);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("re-reads previously missing files after clear()", async () => {
    const cachedBlob = new Blob(["cached-audio"]);
    const read = vi.fn<() => Promise<Blob | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(cachedBlob);
    const preloader = new RoomAudioPreloader(read);
    await expect(preloader.get(tracks[1]!)).resolves.toBeNull();
    preloader.clear();
    await expect(preloader.get(tracks[1]!)).resolves.toBe(cachedBlob);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
