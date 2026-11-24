import { HttpException } from "@nestjs/common";
import type { NeteaseAccountStatus } from "@soqaro/shared";
import { errorCodes } from "@soqaro/shared";
import { fetchProviderUrl } from "../provider-fetch";
import { NeteaseApiError } from "./netease-api.client";
import { NeteaseService } from "./netease.service";

jest.mock("../provider-fetch", () => ({
  fetchProviderUrl: jest.fn()
}));

const mockedFetchProviderUrl = fetchProviderUrl as jest.MockedFunction<typeof fetchProviderUrl>;

describe("NeteaseService", () => {
  const previousEnabled = process.env.NETEASE_ENABLED;

  afterEach(() => {
    mockedFetchProviderUrl.mockReset();
    if (previousEnabled === undefined) delete process.env.NETEASE_ENABLED;
    else process.env.NETEASE_ENABLED = previousEnabled;
  });

  it("normalizes search results and requires a bound account", async () => {
    process.env.NETEASE_ENABLED = "true";
    const api = {
      searchTracks: jest.fn().mockResolvedValue({
        code: 200,
        result: {
          songs: [
            {
              id: 123,
              name: "Test Song",
              fee: 1,
              dt: 123000,
              artists: [{ name: "Artist A" }, { name: "Artist B" }],
              album: { name: "Album", picUrl: null },
              al: { id: 456, name: "Album", picUrl: "http://p1.music.126.net/abc/cover.jpg" },
              h: { br: 320000 }
            }
          ]
        }
      }),
      getTracks: jest.fn().mockResolvedValue({ songs: [] })
    };
    const accounts = {
      getCookieOrThrow: jest.fn().mockResolvedValue("cookie"),
      getStatus: jest.fn().mockResolvedValue({
        connected: true,
        neteaseUserId: "1",
        nickname: "User",
        avatarUrl: null,
        lastValidatedAt: null
      } satisfies NeteaseAccountStatus)
    };
    const redis = {};
    const service = new NeteaseService(api as never, accounts as never, redis as never);

    await expect(
      service.searchTracks("user_1", { keywords: "test", limit: 20, offset: 0 })
    ).resolves.toEqual({
      items: [
        {
          provider: "netease",
          providerTrackId: "123",
          access: "vip",
          quality: "exhigh",
          title: "Test Song",
          artist: "Artist A / Artist B",
          album: "Album",
          providerAlbumId: "456",
          durationMs: 123000,
          artworkUrl: "https://p1.music.126.net/abc/cover.jpg",
          releaseTime: null,
          tags: []
        }
      ],
      limit: 20,
      offset: 0
    });
    expect(api.searchTracks).toHaveBeenCalledWith({
      keywords: "test",
      limit: 20,
      offset: 0,
      cookie: "cookie"
    });
  });

  it("returns a stable disabled error when the feature is off", async () => {
    process.env.NETEASE_ENABLED = "false";
    const service = new NeteaseService({} as never, {} as never, {} as never);

    try {
      await service.getAccountStatus("user_1");
      throw new Error("Expected getAccountStatus to throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const response = (error as HttpException).getResponse() as { code: string };
      expect(response.code).toBe(errorCodes.neteaseDisabled);
    }
  });

  it("limits QR login starts to three attempts per minute", async () => {
    process.env.NETEASE_ENABLED = "true";
    const api = {
      createQrCode: jest.fn().mockResolvedValue({
        key: "qr-key",
        qrimg: "data:image/png;base64,qr"
      })
    };
    const redis = {
      setJson: jest.fn().mockResolvedValue(undefined)
    };
    const service = new NeteaseService(api as never, {} as never, redis as never);

    await service.startQrLogin("user_1");
    await service.startQrLogin("user_1");
    await service.startQrLogin("user_1");

    await expect(service.startQrLogin("user_1")).rejects.toMatchObject({
      response: expect.objectContaining({ code: errorCodes.rateLimited })
    });
  });

  it("returns a recoverable QR failure when login validation is unavailable", async () => {
    process.env.NETEASE_ENABLED = "true";
    const api = {
      checkQrCode: jest.fn().mockResolvedValue({
        status: "connected",
        cookie: "MUSIC_U=music-u"
      }),
      validateCookie: jest.fn().mockRejectedValue(new NeteaseApiError("unavailable"))
    };
    const redis = {
      getJson: jest.fn().mockResolvedValue({ userId: "user_1", key: "qr-key" }),
      delete: jest.fn().mockResolvedValue(undefined)
    };
    const service = new NeteaseService(api as never, {} as never, redis as never);

    await expect(service.checkQrLogin("user_1", "attempt_1")).resolves.toEqual({
      status: "failed",
      message: "二维码已扫码，但网易云登录验证失败，请重新生成二维码。"
    });
    expect(redis.delete).toHaveBeenCalledWith("soqaro:netease:qr:attempt_1");
  });

  it("upgrades NetEase CDN HTTP links before the HTTPS-only provider fetch", async () => {
    process.env.NETEASE_ENABLED = "true";
    const api = {
      getAudioUrl: jest.fn().mockResolvedValue({
        code: 200,
        data: [{
          url: "http://m10.music.126.net/song.mp3",
          type: "mp3"
        }]
      })
    };
    const accounts = {
      getCookieOrThrow: jest.fn().mockResolvedValue("cookie")
    };
    mockedFetchProviderUrl.mockResolvedValue(
      new Response(Uint8Array.of(1, 2, 3), {
        status: 200,
        headers: {
          "content-type": "audio/mpeg",
          "content-length": "3"
        }
      })
    );
    const service = new NeteaseService(api as never, accounts as never, {} as never);

    await expect(service.openAudio("user_1", "123", "exhigh")).resolves.toMatchObject({
      mimeType: "audio/mpeg",
      fileType: "mp3",
      contentLength: 3
    });
    expect(mockedFetchProviderUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "https:",
        hostname: "m10.music.126.net",
        pathname: "/song.mp3"
      }),
      expect.anything(),
      expect.any(Number),
      expect.any(Function),
      { allowSyntheticDns: true }
    );
  });

  it("exposes normalized lyrics, playlists, and albums", async () => {
    process.env.NETEASE_ENABLED = "true";
    const api = {
      getLyrics: jest.fn().mockResolvedValue({
        lrc: { lyric: "plain" },
        yrc: { lyric: "[0,1000](0,500,0)逐(500,500,0)字" },
        tlyric: { lyric: "translated" }
      }),
      getUserPlaylists: jest.fn().mockResolvedValue({ playlist: [{ id: 11, name: "Favorites", trackCount: 1 }] }),
      getPlaylist: jest.fn().mockResolvedValue({ playlist: { id: 11, name: "Favorites", tracks: [{ id: 7, name: "Song", ar: [{ name: "Artist" }] }], trackIds: [{ id: 7 }, { id: 8 }] } }),
      getPlaylistTracks: jest.fn().mockResolvedValue({ songs: [{ id: 8, name: "Song 2", ar: [{ name: "Artist" }] }] }),
      getAlbum: jest.fn().mockResolvedValue({ album: { id: 22, name: "Album", artist: { name: "Artist" }, songs: [] }, songs: [{ id: 7, name: "Song", ar: [{ name: "Artist" }], al: { id: 22, name: "Album" } }] })
    };
    const accounts = {
      getCookieOrThrow: jest.fn().mockResolvedValue("cookie"),
      getStatus: jest.fn().mockResolvedValue({ neteaseUserId: "99" })
    };
    const service = new NeteaseService(api as never, accounts as never, {} as never);

    await expect(service.getLyrics("user_1", "7")).resolves.toEqual({
      provider: "netease",
      providerTrackId: "7",
      plainLyric: "plain",
      wordSyncedLyric: "[0,1000](0,500,0)逐(500,500,0)字",
      translatedLyric: "translated",
      romanizedLyric: null
    });
    await expect(service.listPlaylists("user_1", { limit: 30, offset: 0 })).resolves.toMatchObject({ items: [{ providerPlaylistId: "11", title: "Favorites" }] });
    await expect(service.getPlaylist("user_1", "11")).resolves.toMatchObject({ tracks: [{ providerTrackId: "7", title: "Song" }, { providerTrackId: "8", title: "Song 2" }] });
    await expect(service.getAlbum("user_1", "22")).resolves.toMatchObject({ providerAlbumId: "22", tracks: [{ providerTrackId: "7" }] });
    expect(api.getUserPlaylists).toHaveBeenCalledWith({ userId: "99", limit: 30, offset: 0, cookie: "cookie" });
  });

  it("loads third-party library data without importing it", async () => {
    process.env.NETEASE_ENABLED = "true";
    const api = {
      getLikedTrackIds: jest.fn().mockResolvedValue({ ids: [7] }),
      getTracks: jest.fn().mockResolvedValue({ songs: [{ id: 7, name: "Liked", ar: [{ name: "Artist" }] }] }),
      getUserPlaylists: jest.fn().mockResolvedValue({ playlist: [{ id: 11, name: "Collected", subscribed: true }] }),
      getCollectedAlbums: jest.fn().mockResolvedValue({ data: [{ id: 22, name: "Album", artist: { name: "Artist" } }] }),
      getFollowedArtists: jest.fn().mockResolvedValue({ data: [{ id: 33, name: "Singer" }] })
    };
    const accounts = {
      getCookieOrThrow: jest.fn().mockResolvedValue("cookie"),
      getStatus: jest.fn().mockResolvedValue({ neteaseUserId: "99" })
    };
    const service = new NeteaseService(api as never, accounts as never, {} as never);

    await expect(service.getLibrarySnapshot("user_1")).resolves.toMatchObject({
      provider: "netease",
      likedTracks: [{ providerTrackId: "7" }],
      collectedPlaylists: [{ providerPlaylistId: "11" }],
      collectedAlbums: [{ providerAlbumId: "22" }],
      followedArtists: [{ providerArtistId: "33", name: "Singer" }]
    });
  });

  it("keeps available NetEase library sections when one upstream request fails", async () => {
    process.env.NETEASE_ENABLED = "true";
    const api = {
      getLikedTrackIds: jest.fn().mockRejectedValue(new NeteaseApiError("unavailable")),
      getUserPlaylists: jest.fn().mockResolvedValue({ playlist: [{ id: 11, name: "Collected", subscribed: true }] }),
      getCollectedAlbums: jest.fn().mockResolvedValue({ data: [] }),
      getFollowedArtists: jest.fn().mockResolvedValue({ data: [] })
    };
    const accounts = {
      getCookieOrThrow: jest.fn().mockResolvedValue("cookie"),
      getStatus: jest.fn().mockResolvedValue({ neteaseUserId: "99" })
    };
    const service = new NeteaseService(api as never, accounts as never, {} as never);

    await expect(service.getLibrarySnapshot("user_1")).resolves.toMatchObject({
      likedTracks: [],
      collectedPlaylists: [{ providerPlaylistId: "11" }]
    });
  });

  it("rejects NetEase VIP trial-only preview URLs instead of serving truncated 30s audio", async () => {
    process.env.NETEASE_ENABLED = "true";
    const api = {
      getAudioUrl: jest.fn().mockResolvedValue({
        code: 200,
        data: [{
          url: "http://m10.music.126.net/trial-30s.mp3",
          type: "mp3",
          freeTrialInfo: { start: 0, end: 30 }
        }]
      })
    };
    const accounts = {
      getCookieOrThrow: jest.fn().mockResolvedValue("")
    };
    const service = new NeteaseService(api as never, accounts as never, {} as never);

    await expect(service.resolveAudio("user_1", "150667", "exhigh")).rejects.toThrow(
      "NetEase only returned a VIP trial preview."
    );
    expect(api.getAudioUrl).toHaveBeenCalledTimes(3);
  });

  it("falls back to a lower NetEase bitrate when a higher bitrate returns a VIP trial preview", async () => {
    process.env.NETEASE_ENABLED = "true";
    const api = {
      getAudioUrl: jest
        .fn()
        .mockResolvedValueOnce({
          code: 200,
          data: [{
            url: "http://m10.music.126.net/trial.mp3",
            type: "mp3",
            freeTrialInfo: { start: 0, end: 30 }
          }]
        })
        .mockResolvedValueOnce({
          code: 200,
          data: [{
            url: "http://m10.music.126.net/full.mp3",
            type: "mp3",
            freeTrialInfo: null
          }]
        })
    };
    const accounts = {
      getCookieOrThrow: jest.fn().mockResolvedValue("cookie")
    };
    const service = new NeteaseService(api as never, accounts as never, {} as never);

    await expect(service.resolveAudio("user_1", "150667", "exhigh")).resolves.toMatchObject({
      url: "https://m10.music.126.net/full.mp3",
      mimeType: "audio/mpeg"
    });
  });
});
