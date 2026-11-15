import { BilibiliService, extractBilibiliMediaId } from "./bilibili.service";
import { sortBilibiliAudioUrls, scoreBilibiliCdnUrl, type BilibiliApiClient } from "./bilibili-api.client";
import { cleanBilibiliTitle } from "./bilibili-title-cleaner";
import { convertBilibiliSubtitlesToLrc } from "./bilibili-subtitle";
import { getMixinKey, encWbi } from "./bilibili-wbi";
import type { NeteaseApiClient } from "../netease/netease-api.client";
import type { QqMusicApiClient } from "../qqmusic/qqmusic-api.client";

describe("BilibiliService and Utilities", () => {
  let service: BilibiliService;
  let mockClient: {
    getVideoView: jest.Mock;
    getPlayUrl: jest.Mock;
    searchVideo: jest.Mock;
    fetchAudioStream: jest.Mock;
    getVideoSubtitles: jest.Mock;
    fetchSubtitleContent: jest.Mock;
    getFavoriteResources: jest.Mock;
    getMusicRanking: jest.Mock;
  };
  let mockNeteaseClient: {
    searchTracks: jest.Mock;
    getLyrics: jest.Mock;
  };
  let mockQqmusicClient: {
    searchTracks: jest.Mock;
    getLyrics: jest.Mock;
  };

  beforeEach(() => {
    mockClient = {
      getVideoView: jest.fn(),
      getPlayUrl: jest.fn(),
      searchVideo: jest.fn(),
      fetchAudioStream: jest.fn(),
      getVideoSubtitles: jest.fn(),
      fetchSubtitleContent: jest.fn(),
      getFavoriteResources: jest.fn(),
      getMusicRanking: jest.fn()
    };
    mockNeteaseClient = {
      searchTracks: jest.fn(),
      getLyrics: jest.fn()
    };
    mockQqmusicClient = {
      searchTracks: jest.fn(),
      getLyrics: jest.fn()
    };
    service = new BilibiliService(
      mockClient as unknown as BilibiliApiClient,
      mockNeteaseClient as unknown as NeteaseApiClient,
      mockQqmusicClient as unknown as QqMusicApiClient
    );
  });

  describe("CDN scoring and sorting", () => {
    it("deprioritizes MCDN and prioritizes bilivideo / hdslb", () => {
      const backboneUrl = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/1.m4a";
      const mcdnUrl = "https://mcdn.bilivideo.cn:4483/upgcxcode/2.m4a";
      const generalUrl = "https://other-cdn.com/upgcxcode/3.m4a";

      expect(scoreBilibiliCdnUrl(backboneUrl)).toBe(10);
      expect(scoreBilibiliCdnUrl(mcdnUrl)).toBe(-10);
      expect(scoreBilibiliCdnUrl(generalUrl)).toBe(0);

      const sorted = sortBilibiliAudioUrls(mcdnUrl, [generalUrl, backboneUrl]);
      expect(sorted[0]).toBe(backboneUrl);
      expect(sorted[1]).toBe(generalUrl);
      expect(sorted[2]).toBe(mcdnUrl);
    });
  });

  describe("bilibili-title-cleaner", () => {
    it("cleans brackets, tags, and noise words", () => {
      const res = cleanBilibiliTitle("【4K60FPS无损】周杰伦 - 晴天 (Official MV)", "周杰伦Official");
      expect(res.songTitle).toBe("晴天");
      expect(res.artist).toBe("周杰伦");
      expect(res.fullQuery).toBe("周杰伦 晴天");
    });

    it("extracts song from book brackets 《...》", () => {
      const res = cleanBilibiliTitle("【纯享】《起风了》 买辣椒也用券 现场版", "音乐UP主");
      expect(res.songTitle).toBe("起风了");
      expect(res.artist).toBe("买辣椒也用券");
      expect(res.fullQuery).toBe("买辣椒也用券 起风了");
    });

    it("strips track index numbers from part title and uploader", () => {
      const res = cleanBilibiliTitle("01 晴天", "001.周杰伦");
      expect(res.songTitle).toBe("晴天");
      expect(res.artist).toBe("周杰伦");
      expect(res.fullQuery).toBe("周杰伦 晴天");
    });

    it("cleans real-world live titles like 周杰伦《花海》超清修复 现场万人大合唱", () => {
      const res = cleanBilibiliTitle("周杰伦《花海》超清修复 现场万人大合唱", "剪辑UP主");
      expect(res.songTitle).toBe("花海");
      expect(res.artist).toBe("周杰伦");
      expect(res.fullQuery).toBe("周杰伦 花海");
    });
  });

  describe("bilibili-subtitle", () => {
    it("converts CC subtitle JSON to standard LRC", () => {
      const lrc = convertBilibiliSubtitlesToLrc([
        { from: 1.5, to: 3.2, content: "第一句歌词" },
        { from: 65.25, to: 68.0, content: "第二句歌词" }
      ]);
      expect(lrc).toContain("[00:01.50] 第一句歌词");
      expect(lrc).toContain("[01:05.25] 第二句歌词");
    });
  });

  describe("getVideoDetail & resolveTrack", () => {
    it("resolves single page track candidate", async () => {
      mockClient.getVideoView!.mockResolvedValueOnce({
        bvid: "BV1xx411c7mD",
        aid: 123456,
        title: "独家单曲",
        pic: "https://i0.hdslb.com/bfs/archive/pic.jpg",
        desc: "",
        duration: 200,
        owner: { mid: 1, name: "原作者", face: "" },
        pages: [{ cid: 8888, page: 1, part: "独家单曲", duration: 200 }]
      });

      const track = await service.resolveTrack("BV1xx411c7mD");
      expect(track.provider).toBe("bilibili");
      expect(track.providerTrackId).toBe("BV1xx411c7mD:8888");
      expect(track.bvid).toBe("BV1xx411c7mD");
      expect(track.cid).toBe(8888);
      expect(track.title).toBe("独家单曲");
      expect(track.artist).toBe("原作者");
      expect(track.durationMs).toBe(200000);
      expect(track.access).toBe("free");
    });
  });

  describe("resolveAudio", () => {
    it("chooses best bandwidth audio and sorts CDN urls", async () => {
      mockClient.getPlayUrl!.mockResolvedValueOnce({
        dash: {
          audio: [
            {
              id: 30280,
              baseUrl: "https://mcdn.bilivideo.cn/320k.m4a",
              backupUrl: ["https://upos-sz-mirrorcos.bilivideo.com/320k.m4a"],
              bandwidth: 320000,
              codecs: "mp4a.40.2"
            }
          ]
        }
      });

      const audio = await service.resolveAudio("BV1xx", 1001);
      // 经过 CDN 排序后，骨干节点排在最前
      expect(audio.url).toBe("https://upos-sz-mirrorcos.bilivideo.com/320k.m4a");
      expect(audio.urls).toEqual([
        "https://upos-sz-mirrorcos.bilivideo.com/320k.m4a",
        "https://mcdn.bilivideo.cn/320k.m4a"
      ]);
      expect(audio.fileType).toBe("m4a");
      expect(audio.mimeType).toBe("audio/mp4");
      expect(mockClient.getPlayUrl).toHaveBeenCalledTimes(1);

      // 二次调用命中 30 分钟内存缓存，不再重复调用底层接口
      const cachedAudio = await service.resolveAudio("BV1xx", 1001);
      expect(cachedAudio.url).toBe("https://upos-sz-mirrorcos.bilivideo.com/320k.m4a");
      expect(mockClient.getPlayUrl).toHaveBeenCalledTimes(1);
    });
  });

  describe("getLyrics", () => {
    it("prioritizes professional Netease lyrics even if CC subtitles exist", async () => {
      mockClient.getVideoView.mockResolvedValueOnce({
        bvid: "BV1xx",
        title: "【4K无损】周杰伦 - 青花瓷",
        duration: 240,
        owner: { name: "UP主" },
        pages: [{ cid: 1001, page: 1, part: "青花瓷", duration: 240 }]
      });

      mockNeteaseClient.searchTracks.mockResolvedValueOnce({
        result: {
          songs: [{ id: 186016, name: "青花瓷", dt: 239000, artists: [{ name: "周杰伦" }] }]
        }
      });
      mockNeteaseClient.getLyrics.mockResolvedValueOnce({
        lrc: { lyric: "[00:02.50]天青色等烟雨 而我在等你" },
        yrc: { lyric: "[2500,3000](2500,500,0)天(3000,500,0)青" }
      });

      const lyrics = await service.getLyrics("BV1xx", 1001);
      expect(lyrics.provider).toBe("bilibili");
      expect(lyrics.providerTrackId).toBe("BV1xx:1001");
      expect(lyrics.plainLyric).toContain("天青色等烟雨 而我在等你");
      expect(lyrics.wordSyncedLyric).toContain("[2500,3000]");
    });

    it("falls back to valid native CC subtitles when cross-platform matching yields no result", async () => {
      mockClient.getVideoView.mockResolvedValueOnce({
        bvid: "BV1xx",
        title: "原创小曲",
        duration: 120,
        owner: { name: "音乐独立人" },
        pages: [{ cid: 1001, page: 1, part: "原创小曲", duration: 120 }]
      });
      mockNeteaseClient.searchTracks.mockResolvedValueOnce({ result: { songs: [] } });
      mockQqmusicClient.searchTracks.mockResolvedValueOnce([]);

      mockClient.getVideoSubtitles.mockResolvedValueOnce([
        {
          id: 1,
          lan: "zh-CN",
          lan_doc: "中文（中国）",
          subtitle_url: "//aisubtitle.hdslb.com/bfs/subtitle/1.json"
        }
      ]);
      mockClient.fetchSubtitleContent.mockResolvedValueOnce([
        { from: 2.0, to: 4.0, content: "天青色等烟雨" },
        { from: 4.0, to: 6.0, content: "而我在等你" }
      ]);

      const lyrics = await service.getLyrics("BV1xx", 1001);
      expect(lyrics.provider).toBe("bilibili");
      expect(lyrics.providerTrackId).toBe("BV1xx:1001");
      expect(lyrics.plainLyric).toContain("[00:02.00] 天青色等烟雨");
    });

    it("rejects native CC subtitles that contain UP host commentary or promotional text", async () => {
      mockClient.getVideoView.mockResolvedValueOnce({
        bvid: "BV1xx",
        title: "周杰伦《花海》",
        duration: 240,
        owner: { name: "剪辑UP主" },
        pages: [{ cid: 1001, page: 1, part: "花海", duration: 240 }]
      });
      mockNeteaseClient.searchTracks.mockResolvedValueOnce({ result: { songs: [] } });
      mockQqmusicClient.searchTracks.mockResolvedValueOnce([]);

      mockClient.getVideoSubtitles.mockResolvedValueOnce([
        {
          id: 1,
          lan: "zh-CN",
          lan_doc: "中文（中国）",
          subtitle_url: "//aisubtitle.hdslb.com/bfs/subtitle/1.json"
        }
      ]);
      mockClient.fetchSubtitleContent.mockResolvedValueOnce([
        { from: 0.5, to: 2.0, content: "作词: 哭泣灰太狼" },
        { from: 2.5, to: 5.0, content: "在评论区~ 大家记得一键三连投币哦" }
      ]);

      const lyrics = await service.getLyrics("BV1xx", 1001);
      expect(lyrics.plainLyric).toBeNull();
    });

    it("matches lyrics when the cleaned title swaps song and artist order", async () => {
      // 标题"花海 - 周杰伦"（歌名在前）在无 UP 主信号时清洗器无法判向，
      // 匹配器需要用反向朝向打分命中真实歌曲，且旧版 search 返回的 duration 字段也要生效
      mockClient.getVideoView.mockResolvedValueOnce({
        bvid: "BV1rev",
        title: "花海 - 周杰伦 【无损音质】",
        duration: 266,
        owner: { name: "音乐铺子" },
        pages: [{ cid: 2001, page: 1, part: "花海 - 周杰伦", duration: 266 }]
      });
      mockNeteaseClient.searchTracks.mockResolvedValueOnce({
        result: {
          songs: [
            { id: 185811, name: "花海", duration: 260000, artists: [{ name: "周杰伦" }] },
            { id: 999, name: "花海（治愈版）", duration: 258000, artists: [{ name: "周杰伦." }] }
          ]
        }
      });
      mockNeteaseClient.getLyrics.mockResolvedValueOnce({
        lrc: { lyric: "[00:10.00]风吹过山丘" },
        yrc: { lyric: "[10000,2000](10000,1000,0)风(11000,1000,0)吹" }
      });

      const lyrics = await service.getLyrics("BV1rev", 2001);
      expect(lyrics.wordSyncedLyric).toContain("[10000,2000]");
      const requestedTrackId = mockNeteaseClient.getLyrics.mock.calls[0]?.[0]?.trackId;
      expect(requestedTrackId).toBe("185811");
    });

    it("retries the search with the bare song title when the polluted query yields no confident match", async () => {
      mockClient.getVideoView.mockResolvedValueOnce({
        bvid: "BV1retry",
        title: "【私藏馆】周杰伦《稻香》超治愈神作",
        duration: 224,
        owner: { name: "私藏馆" },
        pages: [{ cid: 3001, page: 1, part: "稻香", duration: 224 }]
      });
      mockNeteaseClient.searchTracks
        .mockResolvedValueOnce({
          result: {
            songs: [{ id: 777, name: "稻香", dt: 223000, artists: [{ name: "Lucky小爱" }] }]
          }
        })
        .mockResolvedValueOnce({
          result: {
            songs: [
              { id: 185807, name: "稻香", dt: 223000, artists: [{ name: "周杰伦" }] }
            ]
          }
        });
      mockNeteaseClient.getLyrics.mockResolvedValueOnce({
        lrc: { lyric: "[00:05.00]对这个世界如果你有太多的抱怨" },
        yrc: null
      });

      const lyrics = await service.getLyrics("BV1retry", 3001);
      // 第二次搜索应使用纯歌名"稻香"，并命中周杰伦原版（score 110 > 首轮候选）
      expect(mockNeteaseClient.searchTracks).toHaveBeenCalledTimes(2);
      expect(mockNeteaseClient.searchTracks.mock.calls[1]?.[0]?.keywords).toBe("稻香");
      const requestedTrackId = mockNeteaseClient.getLyrics.mock.calls[0]?.[0]?.trackId;
      expect(requestedTrackId).toBe("185807");
      expect(lyrics.plainLyric).toContain("对这个世界");
    });
  });

  describe("importFavorite", () => {
    it("extracts mediaId and returns mapped candidate tracks", async () => {
      expect(extractBilibiliMediaId("https://www.bilibili.com/medialist/detail/ml12345678")).toBe("12345678");
      expect(extractBilibiliMediaId("ml87654321")).toBe("87654321");
      expect(extractBilibiliMediaId("99887766")).toBe("99887766");

      mockClient.getFavoriteResources.mockResolvedValueOnce({
        title: "我的宝藏歌单",
        hasMore: false,
        total: 1,
        items: [
          {
            id: 111,
            title: "歌曲A",
            bvid: "BV1SongA",
            cover: "//i0.hdslb.com/cover.jpg",
            duration: 180,
            upper: { name: "歌手A" },
            attr: 0
          },
          {
            id: 222,
            title: "已失效视频",
            bvid: "BV1Dead",
            attr: 9,
            upper: { name: "" }
          }
        ]
      });

      const result = await service.importFavorite("ml12345678", 1, 20);
      expect(result.title).toBe("我的宝藏歌单");
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.bvid).toBe("BV1SongA");
      expect(result.items[0]?.title).toBe("歌曲A");
      expect(result.items[0]?.artist).toBe("歌手A");
      expect(result.items[0]?.durationMs).toBe(180000);
    });
  });

  describe("getRanking", () => {
    it("returns ranking candidates", async () => {
      mockClient.getMusicRanking.mockResolvedValueOnce([
        {
          aid: "1",
          bvid: "BV1Rank1",
          title: "热歌榜首",
          pic: "//i0.hdslb.com/pic.jpg",
          desc: "",
          duration: 210,
          owner: { mid: 1, name: "知名歌手", face: "" }
        }
      ]);

      const candidates = await service.getRanking("3");
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.bvid).toBe("BV1Rank1");
      expect(candidates[0]?.title).toBe("热歌榜首");
      expect(candidates[0]?.durationMs).toBe(210000);
    });
  });

  describe("bilibili-wbi signer", () => {
    it("generates correct mixinKey with 32 characters", () => {
      const imgKey = "7cd084941338484aae1ad9425b84077c";
      const subKey = "4932caff0ff746eab6f01bf08b70ac45";
      const mixin = getMixinKey(imgKey + subKey);
      expect(mixin).toHaveLength(32);
      expect(typeof mixin).toBe("string");
    });

    it("encodes and signs query params with w_rid and wts", () => {
      const imgKey = "7cd084941338484aae1ad9425b84077c";
      const subKey = "4932caff0ff746eab6f01bf08b70ac45";
      const signed = encWbi({ bvid: "BV1xx411c7mD", cid: 62131, fnval: 4048 }, imgKey, subKey);
      expect(signed).toContain("bvid=BV1xx411c7mD");
      expect(signed).toContain("cid=62131");
      expect(signed).toContain("fnval=4048");
      expect(signed).toContain("&wts=");
      expect(signed).toContain("&w_rid=");
      expect(signed).toMatch(/&w_rid=[a-f0-9]{32}/);
    });
  });

  describe("openAudioStream cache invalidation", () => {
    it("evicts stale cached CDN URLs and retries once with a fresh playurl", async () => {
      mockClient.getVideoView.mockResolvedValue({
        bvid: "BV1Cache1234",
        aid: 42,
        title: "测试曲目",
        pic: "",
        desc: "",
        duration: 180,
        owner: { mid: 1, name: "UP", face: "" },
        pages: [{ cid: 1001, page: 1, part: "P1", duration: 180 }]
      });
      mockClient.getPlayUrl
        .mockResolvedValueOnce({
          dash: {
            audio: [{ id: 30280, baseUrl: "https://upos-stale.bilivideo.com/1.m4s", backupUrl: [], bandwidth: 192000, codecs: "mp4a" }]
          }
        })
        .mockResolvedValueOnce({
          dash: {
            audio: [{ id: 30280, baseUrl: "https://upos-fresh.bilivideo.com/2.m4s", backupUrl: [], bandwidth: 192000, codecs: "mp4a" }]
          }
        });
      mockClient.fetchAudioStream
        .mockResolvedValueOnce({ status: 200, headers: {}, body: null })
        .mockRejectedValueOnce(new Error("All Bilibili audio stream CDNs returned non-200/206 status (last HTTP 403)"))
        .mockResolvedValueOnce({ status: 200, headers: {}, body: null });

      await service.openAudioStream("BV1Cache1234", 1001);
      const retried = await service.openAudioStream("BV1Cache1234", 1001);

      expect(retried.status).toBe(200);
      expect(mockClient.getPlayUrl).toHaveBeenCalledTimes(2);
      expect(mockClient.fetchAudioStream).toHaveBeenLastCalledWith(
        ["https://upos-fresh.bilivideo.com/2.m4s"],
        undefined
      );
    });

    it("includes fallback audio quality streams in candidateUrls when higher-bandwidth CDNs fail", async () => {
      mockClient.getVideoView.mockResolvedValueOnce({
        bvid: "BV1MultiStream",
        aid: 99,
        title: "多音质曲目",
        pic: "",
        desc: "",
        duration: 200,
        owner: { mid: 1, name: "UP", face: "" },
        pages: [{ cid: 2002, page: 1, part: "P1", duration: 200 }]
      });
      mockClient.getPlayUrl.mockResolvedValueOnce({
        dash: {
          audio: [
            { id: 30216, baseUrl: "https://upos-fallback.bilivideo.com/low.m4s", backupUrl: [], bandwidth: 64000, codecs: "mp4a" },
            { id: 30280, baseUrl: "https://upos-primary.bilivideo.com/high.m4s", backupUrl: [], bandwidth: 192000, codecs: "mp4a" }
          ]
        }
      });
      mockClient.fetchAudioStream.mockResolvedValueOnce({ status: 200, headers: {}, body: null });

      await service.openAudioStream("BV1MultiStream", 2002);

      expect(mockClient.fetchAudioStream).toHaveBeenCalledWith(
        [
          "https://upos-primary.bilivideo.com/high.m4s",
          "https://upos-fallback.bilivideo.com/low.m4s"
        ],
        undefined
      );
    });
  });
});
