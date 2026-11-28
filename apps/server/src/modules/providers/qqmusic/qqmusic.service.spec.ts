import { fetchProviderUrl } from "../provider-fetch";
import { QqMusicService } from "./qqmusic.service";
import { QqMusicApiClient, QqMusicApiError } from "./qqmusic-api.client";

jest.mock("../provider-fetch", () => ({
  fetchProviderUrl: jest.fn()
}));

const mockedFetchProviderUrl = fetchProviderUrl as jest.MockedFunction<typeof fetchProviderUrl>;

describe("QqMusicService", () => {
  const previousEnabled = process.env.QQMUSIC_ENABLED;

  afterEach(() => {
    mockedFetchProviderUrl.mockReset();
    if (previousEnabled === undefined) delete process.env.QQMUSIC_ENABLED;
    else process.env.QQMUSIC_ENABLED = previousEnabled;
  });

  it("requests and decodes QQ word-synced lyrics", async () => {
    mockedFetchProviderUrl.mockResolvedValue(new Response(JSON.stringify({
      req_0: {
        data: {
          lyric: Buffer.from("[00:00.00]普通歌词").toString("base64"),
          qrc: Buffer.from("[0,1000](0,500,0)逐字").toString("base64")
        }
      }
    }), { status: 200 }));
    const client = new QqMusicApiClient();

    await expect(client.getLyrics({ trackId: "song-mid", cookie: "uin=o123; qqmusic_key=key" })).resolves.toMatchObject({
      lyric: "[00:00.00]普通歌词",
      qrc: "[0,1000](0,500,0)逐字"
    });
    const request = mockedFetchProviderUrl.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      comm: { uin: "123" },
      req_0: { param: { songMID: "song-mid", qrc_t: 1, crypt: 0 } }
    });
  });

  it("does not expose QQ encrypted lyric payloads as plain text", async () => {
    mockedFetchProviderUrl.mockResolvedValue(new Response(JSON.stringify({
      req_0: {
        data: {
          lyric: "0F3B54CF70B40B084246660B2D7067338AC33B27799529B6FB1C53A563027ABD66B5BED7887C293947839BD941016030459E",
          qrc: "0"
        }
      }
    }), { status: 200 }));

    await expect(new QqMusicApiClient().getLyrics({
      trackId: "song-mid",
      cookie: "uin=o123; qqmusic_key=key"
    })).resolves.toMatchObject({ lyric: null, qrc: null });
  });

  it("keeps an already-decoded QQ word-synced lyric intact", async () => {
    mockedFetchProviderUrl.mockResolvedValue(new Response(JSON.stringify({
      req_0: {
        data: {
          lyric: "[00:00.00]普通歌词",
          qrc: "[0,1000](0,500,0)逐(500,500,0)字"
        }
      }
    }), { status: 200 }));
    const client = new QqMusicApiClient();

    await expect(client.getLyrics({
      trackId: "song-mid",
      cookie: "uin=o123; qqmusic_key=key"
    })).resolves.toMatchObject({
      lyric: "[00:00.00]普通歌词",
      qrc: "[0,1000](0,500,0)逐(500,500,0)字"
    });
  });

  it("upgrades QQ Music CDN HTTP links before the HTTPS-only provider fetch", async () => {
    process.env.QQMUSIC_ENABLED = "true";
    const api = {
      getAudioUrl: jest.fn().mockResolvedValue({
        url: "http://dl.stream.qqmusic.qq.com/song.mp3"
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
    const service = new QqMusicService(api as never, accounts as never, {} as never);

    await expect(service.openAudio("user_1", "song-mid", "exhigh")).resolves.toMatchObject({
      mimeType: "audio/mpeg",
      fileType: "mp3",
      contentLength: 3
    });
    expect(mockedFetchProviderUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "https:",
        hostname: "dl.stream.qqmusic.qq.com",
        pathname: "/song.mp3"
      }),
      expect.anything(),
      expect.any(Number),
      expect.any(Function),
      { allowSyntheticDns: true }
    );
  });

  it("falls back from lossless to available MP3 quality", async () => {
    process.env.QQMUSIC_ENABLED = "true";
    const api = {
      getAudioUrl: jest.fn()
        .mockResolvedValueOnce({ url: null })
        .mockResolvedValueOnce({ url: "https://dl.stream.qqmusic.qq.com/song.mp3" })
    };
    const accounts = {
      getCookieOrThrow: jest.fn().mockResolvedValue("cookie")
    };
    mockedFetchProviderUrl.mockResolvedValue(
      new Response(Uint8Array.of(1), {
        status: 200,
        headers: { "content-type": "audio/mpeg", "content-length": "1" }
      })
    );
    const service = new QqMusicService(api as never, accounts as never, {} as never);

    await expect(service.openAudio("user_1", "song-mid", "exhigh")).resolves.toMatchObject({
      mimeType: "audio/mpeg"
    });
    expect(api.getAudioUrl.mock.calls.map(([input]) => input.quality)).toEqual(["exhigh", "high"]);
  });

  it("falls back when the first QQ CDN URL is stale", async () => {
    process.env.QQMUSIC_ENABLED = "true";
    const api = {
      getAudioUrl: jest.fn()
        .mockResolvedValueOnce({ url: "https://dl.stream.qqmusic.qq.com/stale.flac" })
        .mockResolvedValueOnce({ url: "https://dl.stream.qqmusic.qq.com/song.mp3" })
        .mockResolvedValueOnce({ url: null })
    };
    const accounts = {
      getCookieOrThrow: jest.fn().mockResolvedValue("cookie")
    };
    mockedFetchProviderUrl
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(Uint8Array.of(1, 2, 3), {
        status: 200,
        headers: { "content-type": "audio/mpeg", "content-length": "3" }
      }));
    const service = new QqMusicService(api as never, accounts as never, {} as never);

    await expect(service.openAudio("user_1", "song-mid", "exhigh")).resolves.toMatchObject({
      mimeType: "audio/mpeg",
      fileType: "mp3"
    });
    expect(api.getAudioUrl.mock.calls.map(([input]) => input.quality)).toEqual(["exhigh", "high"]);
    expect(mockedFetchProviderUrl).toHaveBeenCalledTimes(2);
  });

  it("clears an expired QQ account before requesting audio", async () => {
    process.env.QQMUSIC_ENABLED = "true";
    const api = {
      validateCookie: jest.fn().mockRejectedValue(new QqMusicApiError("auth-expired")),
      getAudioUrl: jest.fn()
    };
    const accounts = {
      getCookieOrThrow: jest.fn().mockResolvedValue("uin=o123; qqmusic_key=expired"),
      getValidationState: jest.fn().mockResolvedValue({
        cookie: "uin=o123; qqmusic_key=expired",
        qqMusicUserId: "123",
        lastValidatedAt: new Date(0)
      }),
      invalidate: jest.fn().mockResolvedValue(undefined)
    };
    const service = new QqMusicService(api as never, accounts as never, {} as never);

    await expect(service.openAudio("user_1", "song-mid", "exhigh")).rejects.toMatchObject({
      response: expect.objectContaining({ code: "QQMUSIC_AUTH_EXPIRED" })
    });
    expect(accounts.invalidate).toHaveBeenCalledWith("user_1");
    expect(api.getAudioUrl).not.toHaveBeenCalled();
  });

  it("invalidates undecryptable QQ credentials and throws QQMUSIC_AUTH_EXPIRED instead of falling back to guest", async () => {
    process.env.QQMUSIC_ENABLED = "true";
    const api = {
      getAudioUrl: jest.fn()
    };
    const accounts = {
      getCookieOrThrow: jest.fn().mockRejectedValue(new Error("QQ Music account credentials are invalid.")),
      invalidate: jest.fn().mockResolvedValue(undefined)
    };
    const service = new QqMusicService(api as never, accounts as never, {} as never);

    await expect(service.resolveAudio("user_1", "song-mid", "exhigh")).rejects.toMatchObject({
      response: expect.objectContaining({ code: "QQMUSIC_AUTH_EXPIRED" })
    });
    expect(accounts.invalidate).toHaveBeenCalledWith("user_1");
    expect(api.getAudioUrl).not.toHaveBeenCalled();
  });

  it("exposes normalized lyrics, playlists, and albums", async () => {
    process.env.QQMUSIC_ENABLED = "true";
    const api = {
      getLyrics: jest.fn().mockResolvedValue({ lyric: "plain", trans: "translated" }),
      searchTracks: jest.fn().mockResolvedValue([{ albumMID: "alb1", albumName: "Album", singerName: "Artist" }]),
      getUserPlaylists: jest.fn().mockResolvedValue({ data: { playlists: [{ dissid: "1", dissname: "Favorites", songnum: 1 }] } }),
      getPlaylist: jest.fn().mockResolvedValue({ cdlist: [{ disstid: "1", dissname: "Favorites", songlist: [{ songmid: "song1", songname: "Song", singername: "Artist" }] }] }),
      getAlbum: jest.fn().mockResolvedValue({ info: { albumMid: "alb1", albumName: "Album", singerName: "Artist" }, songs: { albumSonglist: { data: { songList: [{ songInfo: { mid: "song1", name: "Song", singer: [{ name: "Artist" }], album: { mid: "alb1", name: "Album" } } }] } } } })
    };
    const accounts = {
      getCookieOrThrow: jest.fn().mockResolvedValue("cookie"),
      getStatus: jest.fn().mockResolvedValue({ qqMusicUserId: "123" })
    };
    const service = new QqMusicService(api as never, accounts as never, {} as never);

    await expect(service.getLyrics("user_1", "song1")).resolves.toEqual({
      provider: "qqmusic",
      providerTrackId: "song1",
      plainLyric: "plain",
      wordSyncedLyric: null,
      translatedLyric: "translated",
      romanizedLyric: null
    });
    await expect(service.searchAlbums("user_1", { keywords: "Album", limit: 20, offset: 0 })).resolves.toMatchObject({
      items: [{ providerAlbumId: "alb1", title: "Album", artist: "Artist" }]
    });
    await expect(service.listPlaylists("user_1", { limit: 30, offset: 0 })).resolves.toMatchObject({ items: [{ providerPlaylistId: "1", title: "Favorites" }] });
    await expect(service.getPlaylist("user_1", "1")).resolves.toMatchObject({ tracks: [{ providerTrackId: "song1", title: "Song" }] });
    await expect(service.getAlbum("user_1", "alb1")).resolves.toMatchObject({ providerAlbumId: "alb1", tracks: [{ providerTrackId: "song1" }] });
    expect(api.getUserPlaylists).toHaveBeenCalledWith({ userId: "123", limit: 30, offset: 0, cookie: "cookie" });
  });

  it("recovers QQ albums from song search results when album search is empty", async () => {
    process.env.QQMUSIC_ENABLED = "true";
    const api = {
      searchTracks: jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ albummid: "alb1", albumname: "Album", singername: "Artist" }])
    };
    const accounts = { getCookieOrThrow: jest.fn().mockResolvedValue("cookie") };
    const service = new QqMusicService(api as never, accounts as never, {} as never);

    await expect(service.searchAlbums("user_1", { keywords: "Album", limit: 20, offset: 0 })).resolves.toMatchObject({
      items: [{ providerAlbumId: "alb1", title: "Album", artist: "Artist" }]
    });
    expect(api.searchTracks.mock.calls.map(([input]) => input.kind)).toEqual(["album", "song"]);
  });

  it("does not replace a missing QQ track with an unrelated search result", async () => {
    process.env.QQMUSIC_ENABLED = "true";
    const api = {
      searchTracks: jest.fn().mockResolvedValue([
        { songmid: "different-mid", songname: "Different Song", singername: "Other Artist" }
      ])
    };
    const accounts = { getCookieOrThrow: jest.fn().mockResolvedValue("cookie") };
    const service = new QqMusicService(api as never, accounts as never, {} as never);

    await expect(service.getTrack("user_1", "requested-mid")).rejects.toMatchObject({
      response: expect.objectContaining({ code: "QQMUSIC_TRACK_NOT_FOUND" })
    });
  });

  it("loads third-party library data without importing it", async () => {
    process.env.QQMUSIC_ENABLED = "true";
    const api = {
      getLikedPlaylist: jest.fn().mockResolvedValue({ data: { mymusic: [{ type: 1, id: "9", title: "我喜欢" }] } }),
      getPlaylist: jest.fn().mockResolvedValue({ cdlist: [{ disstid: "9", dissname: "我喜欢", songlist: [{ songmid: "mid-1", songid: 101, songname: "Liked", singername: "Artist" }] }] }),
      getCollectedPlaylists: jest.fn().mockResolvedValue({ data: { disslist: [{ dissid: "11", dissname: "Collected" }] } }),
      getCollectedAlbums: jest.fn().mockResolvedValue({ data: { albumlist: [{ albummid: "alb-1", albumname: "Album", singername: "Artist" }] } }),
      getFollowedArtists: jest.fn().mockResolvedValue({ data: { singerlist: [{ singermid: "singer-1", singername: "Singer" }] } })
    };
    const accounts = {
      getCookieOrThrow: jest.fn().mockResolvedValue("cookie"),
      getStatus: jest.fn().mockResolvedValue({ qqMusicUserId: "123" })
    };
    const service = new QqMusicService(api as never, accounts as never, {} as never);

    await expect(service.getLibrarySnapshot("user_1")).resolves.toMatchObject({
      provider: "qqmusic",
      likedTracks: [{ providerTrackId: "mid-1", relatedTrackId: "101" }],
      collectedPlaylists: [{ providerPlaylistId: "11" }],
      collectedAlbums: [{ providerAlbumId: "alb-1" }],
      followedArtists: [{ providerArtistId: "singer-1", name: "Singer" }]
    });
  });

  it("keeps available QQ library sections when one upstream request fails", async () => {
    process.env.QQMUSIC_ENABLED = "true";
    const api = {
      getLikedPlaylist: jest.fn().mockRejectedValue(new QqMusicApiError("unavailable")),
      getCollectedPlaylists: jest.fn().mockResolvedValue({ data: { disslist: [{ dissid: "11", dissname: "Collected" }] } }),
      getCollectedAlbums: jest.fn().mockResolvedValue({ data: { albumlist: [] } }),
      getFollowedArtists: jest.fn().mockResolvedValue({ data: { singerlist: [] } })
    };
    const accounts = {
      getCookieOrThrow: jest.fn().mockResolvedValue("cookie"),
      getStatus: jest.fn().mockResolvedValue({ qqMusicUserId: "123" })
    };
    const service = new QqMusicService(api as never, accounts as never, {} as never);

    await expect(service.getLibrarySnapshot("user_1")).resolves.toMatchObject({
      likedTracks: [],
      collectedPlaylists: [{ providerPlaylistId: "11" }]
    });
  });

});
