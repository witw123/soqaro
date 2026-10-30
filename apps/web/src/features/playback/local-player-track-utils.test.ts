import { describe, expect, it, vi } from "vitest";
import type { LocalPlaylistTrackRecord } from "@/features/library/indexeddb";

vi.mock("@/features/library/indexeddb", () => ({
  getCachedLibraryTrack: vi.fn(),
  upsertCachedLibraryTrack: vi.fn(),
  upsertLocalPlaylistTrack: vi.fn()
}));
vi.mock("@/features/library/local-audio-storage", () => ({
  getLocalAudioCacheFile: vi.fn(),
  getLocalAudioFile: vi.fn()
}));
vi.mock("@/features/library/audio-metadata", () => ({
  readEmbeddedAudioMetadata: vi.fn()
}));
vi.mock("./loudness", () => ({
  analyzeAudioBlobLoudness: vi.fn()
}));

import {
  popPreviousPlayedTrackIndex,
  pushPlayedTrackHistory,
  resolveBatchPlaySelection
} from "./local-player-track-utils";

function makeTrack(id: string): LocalPlaylistTrackRecord {
  return {
    id,
    title: `Song ${id}`,
    artist: "Artist",
    album: null,
    durationMs: 180_000,
    mimeType: "audio/mpeg",
    sizeBytes: 1_000_000,
    artworkUrl: null,
    lyrics: null,
    provider: "netease",
    providerTrackId: id,
    fileName: `song-${id}.mp3`,
    fileHash: `hash-${id}`,
    availableOffline: true,
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z"
  };
}

describe("local playback mode batch selection and shuffle history", () => {
  const tracks = ["1", "2", "3", "4"].map(makeTrack);

  it("starts at index 0 with empty shuffle bag in sequence and single modes", () => {
    expect(resolveBatchPlaySelection({
      tracks,
      playbackMode: "sequence",
      isPlayable: () => true
    })).toEqual({ selectedIndex: 0, shuffleBag: [] });

    expect(resolveBatchPlaySelection({
      tracks,
      playbackMode: "single",
      isPlayable: () => true
    })).toEqual({ selectedIndex: 0, shuffleBag: [] });
  });

  it("picks a shuffled initial track and populates remaining shuffle bag in shuffle mode", () => {
    const selection = resolveBatchPlaySelection({
      tracks,
      playbackMode: "shuffle",
      isPlayable: () => true,
      random: () => 0
    });

    // With deterministic random () => 0 on ["1", "2", "3", "4"], Fisher-Yates rotates to ["2", "3", "4", "1"]
    expect(selection.selectedIndex).toBe(1);
    expect(selection.shuffleBag).toEqual(["3", "4", "1"]);
  });

  it("honors an explicit startIndex while shuffling remaining tracks in shuffle mode", () => {
    const selection = resolveBatchPlaySelection({
      tracks,
      playbackMode: "shuffle",
      startIndex: 0,
      isPlayable: () => true,
      random: () => 0
    });

    expect(selection.selectedIndex).toBe(0);
    expect(new Set(selection.shuffleBag)).toEqual(new Set(["2", "3", "4"]));
    expect(selection.shuffleBag).not.toContain("1");
  });

  it("tracks played history and pops previous playable track in shuffle mode", () => {
    let history: string[] = [];
    history = pushPlayedTrackHistory(history, "1", "3");
    history = pushPlayedTrackHistory(history, "3", "2");
    expect(history).toEqual(["1", "3"]);

    const firstBack = popPreviousPlayedTrackIndex(history, tracks, "2");
    expect(firstBack).toEqual({ index: 2, remainingHistory: ["1"] });

    const secondBack = popPreviousPlayedTrackIndex(firstBack.remainingHistory, tracks, "3");
    expect(secondBack).toEqual({ index: 0, remainingHistory: [] });
  });
});
