import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLocalStoredProfile,
  getLocalProfileKey,
  getLocalStoredProfile,
  mergeProfileWithServer,
  recordLocalListeningProgress,
  saveLocalStoredProfile
} from "./local-personalization-store";
import type { PersonalizationProfileResponse } from "@soqaro/shared";

describe("local-personalization-store", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    const mockStorage = {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(() => {
        store.clear();
      })
    };
    vi.stubGlobal("window", { localStorage: mockStorage });
    vi.stubGlobal("localStorage", mockStorage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe("account isolation", () => {
    it("generates separate storage keys for different user IDs and guest", () => {
      expect(getLocalProfileKey("user-1")).toBe("soqaro_local_profile_user-1");
      expect(getLocalProfileKey("user-2")).toBe("soqaro_local_profile_user-2");
      expect(getLocalProfileKey(null)).toBe("soqaro_local_profile_guest");
      expect(getLocalProfileKey(undefined)).toBe("soqaro_local_profile_guest");
    });

    it("keeps profiles completely isolated between users", () => {
      const profileA: PersonalizationProfileResponse = {
        version: "1.0",
        startedAt: new Date().toISOString(),
        totalListenedMs: 60000,
        totalPlayCount: 1,
        trackCount: 1,
        artistCount: 1,
        tasteGroups: [],
        topTracks: [],
        topArtists: [],
        recentTracks: [],
        sourceDistribution: [{ source: "netease", listenedMs: 60000 }]
      };

      saveLocalStoredProfile(profileA, "user-a");
      expect(getLocalStoredProfile("user-a")?.totalListenedMs).toBe(60000);
      expect(getLocalStoredProfile("user-b")).toBeNull();
      expect(getLocalStoredProfile(null)).toBeNull();
    });

    it("clearing profile removes only the target user key", () => {
      const dummyProfile: PersonalizationProfileResponse = {
        version: "1.0",
        startedAt: new Date().toISOString(),
        totalListenedMs: 1000,
        totalPlayCount: 1,
        trackCount: 1,
        artistCount: 1,
        tasteGroups: [],
        topTracks: [],
        topArtists: [],
        recentTracks: [],
        sourceDistribution: []
      };

      saveLocalStoredProfile(dummyProfile, "user-a");
      saveLocalStoredProfile(dummyProfile, "user-b");

      clearLocalStoredProfile("user-a");
      expect(getLocalStoredProfile("user-a")).toBeNull();
      expect(getLocalStoredProfile("user-b")).not.toBeNull();
    });
  });

  describe("recordLocalListeningProgress", () => {
    it("accumulates only incremental deltas without compounding total duration", () => {
      const track = {
        provider: "netease" as const,
        providerTrackId: "track-123",
        title: "夜的第七章",
        artist: "周杰伦",
        album: "依然范特西",
        durationMs: 240000,
        artworkUrl: null
      };

      // Heartbeat 1 (at 15s): 15000ms delta, new play
      recordLocalListeningProgress({
        userId: "user-1",
        track,
        deltaMs: 15000,
        isNewPlay: true
      });

      let profile = getLocalStoredProfile("user-1");
      expect(profile?.totalListenedMs).toBe(15000);
      expect(profile?.totalPlayCount).toBe(1);
      expect(profile?.topTracks[0]?.listenedMs).toBe(15000);
      expect(profile?.topTracks[0]?.playCount).toBe(1);

      // Heartbeat 2 (at 30s): 15000ms delta, not a new play
      recordLocalListeningProgress({
        userId: "user-1",
        track,
        deltaMs: 15000,
        isNewPlay: false
      });

      profile = getLocalStoredProfile("user-1");
      expect(profile?.totalListenedMs).toBe(30000);
      expect(profile?.totalPlayCount).toBe(1); // playCount should NOT increment
      expect(profile?.topTracks[0]?.listenedMs).toBe(30000);
      expect(profile?.topTracks[0]?.playCount).toBe(1); // track playCount should NOT increment

      // Heartbeat 3 (at 45s): 15000ms delta, not a new play
      recordLocalListeningProgress({
        userId: "user-1",
        track,
        deltaMs: 15000,
        isNewPlay: false
      });

      profile = getLocalStoredProfile("user-1");
      expect(profile?.totalListenedMs).toBe(45000);
      expect(profile?.totalPlayCount).toBe(1);
      expect(profile?.topTracks[0]?.listenedMs).toBe(45000);
      expect(profile?.topTracks[0]?.playCount).toBe(1);
    });

    it("correctly tracks multi-source distribution including bilibili and alist", () => {
      recordLocalListeningProgress({
        userId: "user-1",
        track: {
          provider: "bilibili",
          providerTrackId: "bv123",
          title: "Bili Song",
          artist: "UP主",
          album: null,
          durationMs: 180000,
          artworkUrl: null
        },
        deltaMs: 20000,
        isNewPlay: true
      });

      recordLocalListeningProgress({
        userId: "user-1",
        track: {
          provider: "alist",
          providerTrackId: "/music/song.flac",
          title: "Alist Song",
          artist: "歌手",
          album: "专辑",
          durationMs: 200000,
          artworkUrl: null
        },
        deltaMs: 30000,
        isNewPlay: true
      });

      const profile = getLocalStoredProfile("user-1");
      expect(profile?.sourceDistribution).toEqual([
        { source: "bilibili", listenedMs: 20000 },
        { source: "alist", listenedMs: 30000 }
      ]);
    });
  });

  describe("mergeProfileWithServer", () => {
    it("does not resurrect local stale data when server profile is empty or reset", () => {
      const staleLocal: PersonalizationProfileResponse = {
        version: "1.0",
        startedAt: "2026-01-01T00:00:00.000Z",
        totalListenedMs: 500000,
        totalPlayCount: 20,
        trackCount: 5,
        artistCount: 3,
        tasteGroups: [],
        topTracks: [],
        topArtists: [],
        recentTracks: [],
        sourceDistribution: []
      };

      const emptyResetServer: PersonalizationProfileResponse = {
        version: "1.0",
        startedAt: null,
        totalListenedMs: 0,
        totalPlayCount: 0,
        trackCount: 0,
        artistCount: 0,
        tasteGroups: [],
        topTracks: [],
        topArtists: [],
        recentTracks: [],
        sourceDistribution: []
      };

      saveLocalStoredProfile(staleLocal, "user-1");

      const merged = mergeProfileWithServer(staleLocal, emptyResetServer, "user-1");
      expect(merged).toEqual(emptyResetServer);
      expect(getLocalStoredProfile("user-1")).toBeNull();
    });

    it("merges server authoritative data with pending local data", () => {
      const local: PersonalizationProfileResponse = {
        version: "1.0",
        startedAt: "2026-10-31T10:00:00.000Z",
        totalListenedMs: 30000,
        totalPlayCount: 2,
        trackCount: 1,
        artistCount: 1,
        tasteGroups: [],
        topTracks: [
          {
            provider: "netease",
            providerTrackId: "101",
            title: "Song 1",
            artist: "Artist 1",
            album: null,
            durationMs: 200000,
            artworkUrl: null,
            access: "free",
            quality: "standard",
            score: 1,
            reasons: ["本地常听"],
            listenedMs: 30000,
            playCount: 2
          }
        ],
        topArtists: [
          { name: "Artist 1", score: 3, listenedMs: 30000, playCount: 2 }
        ],
        recentTracks: [],
        sourceDistribution: [{ source: "netease", listenedMs: 30000 }]
      };

      const server: PersonalizationProfileResponse = {
        version: "1.0",
        startedAt: "2026-10-30T10:00:00.000Z",
        totalListenedMs: 100000,
        totalPlayCount: 5,
        trackCount: 3,
        artistCount: 2,
        tasteGroups: [],
        topTracks: [
          {
            provider: "netease",
            providerTrackId: "101",
            title: "Song 1",
            artist: "Artist 1",
            album: null,
            durationMs: 200000,
            artworkUrl: null,
            access: "free",
            quality: "standard",
            score: 5,
            reasons: ["长期偏好"],
            listenedMs: 20000,
            playCount: 1
          }
        ],
        topArtists: [
          { name: "Artist 1", score: 5, listenedMs: 20000, playCount: 1 }
        ],
        recentTracks: [],
        sourceDistribution: [{ source: "netease", listenedMs: 100000 }]
      };

      const merged = mergeProfileWithServer(local, server, "user-1");
      expect(merged?.totalListenedMs).toBe(100000);
      expect(merged?.totalPlayCount).toBe(5);
      // Track 101 playCount and listenedMs takes max of local and server
      expect(merged?.topTracks[0]?.listenedMs).toBe(30000);
      expect(merged?.topTracks[0]?.playCount).toBe(2);
    });
  });
});
