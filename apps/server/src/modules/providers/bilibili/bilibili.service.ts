import { Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import type { BilibiliSearchResponse, BilibiliTrackCandidate, BilibiliVideoDetail, ProviderLyrics } from "@soqaro/shared";
import { NeteaseApiClient } from "../netease/netease-api.client";
import { QqMusicApiClient } from "../qqmusic/qqmusic-api.client";
import { BilibiliApiClient, sortBilibiliAudioUrls } from "./bilibili-api.client";
import { selectBestSubtitle, convertBilibiliSubtitlesToLrc, isValidLyricSubtitle } from "./bilibili-subtitle";
import { cleanBilibiliTitle } from "./bilibili-title-cleaner";
import { CrossPlatformLyricMatcher } from "./bilibili-lyric-matcher";
import { mapFavoriteItemToCandidate, mapRankingItemToCandidate, mapSearchItemToCandidate, normalizeBilibiliPicUrl } from "./bilibili.mappers";

export function extractBilibiliMediaId(input: string): string {
  const trimmed = input.trim();
  const mlMatch = trimmed.match(/ml(\d+)/i);
  if (mlMatch && mlMatch[1]) return mlMatch[1];

  const fidMatch = trimmed.match(/fid=(\d+)/i);
  if (fidMatch && fidMatch[1]) return fidMatch[1];

  const numMatch = trimmed.match(/^\d+$/);
  if (numMatch) return numMatch[0];

  return trimmed;
}

@Injectable()
export class BilibiliService {
  private readonly logger = new Logger(BilibiliService.name);

  private readonly lyricMatcher: CrossPlatformLyricMatcher;

  constructor(
    private readonly client: BilibiliApiClient,
    @Optional() neteaseApiClient?: NeteaseApiClient,
    @Optional() qqmusicApiClient?: QqMusicApiClient
  ) {
    this.lyricMatcher = new CrossPlatformLyricMatcher(neteaseApiClient, qqmusicApiClient);
  }

  async getVideoDetail(bvid: string): Promise<BilibiliVideoDetail> {
    const data = await this.client.getVideoView(bvid);
    return {
      bvid: data.bvid,
      title: data.title,
      pic: normalizeBilibiliPicUrl(data.pic),
      ownerName: data.owner?.name ?? "未知UP主",
      ownerFace: normalizeBilibiliPicUrl(data.owner?.face),
      duration: data.duration,
      pages: (data.pages ?? []).map((page) => ({
        cid: page.cid,
        page: page.page,
        part: page.part,
        duration: page.duration
      }))
    };
  }

  async resolveTrack(bvid: string, cid?: number): Promise<BilibiliTrackCandidate> {
    const detail = await this.getVideoDetail(bvid);
    const targetPage = cid
      ? detail.pages.find((p) => p.cid === cid) ?? detail.pages[0]
      : detail.pages[0];

    if (!targetPage) {
      throw new NotFoundException(`Bilibili 视频分P未找到: ${bvid}`);
    }

    const cleaned = cleanBilibiliTitle(detail.title, detail.ownerName);
    const mainArtist = cleaned.artist || detail.ownerName;
    const albumTitle = cleaned.songTitle || detail.title;

    // 清洗分 P 标题
    const pageCleaned = detail.pages.length > 1
      ? cleanBilibiliTitle(targetPage.part, mainArtist)
      : cleaned;

    const title = detail.pages.length > 1
      ? (pageCleaned.songTitle || targetPage.part)
      : (cleaned.songTitle || detail.title);

    const artist = pageCleaned.artist || mainArtist;
    const album = detail.pages.length > 1 ? albumTitle : null;

    const providerTrackId = `${bvid}:${targetPage.cid}`;

    return {
      provider: "bilibili",
      providerTrackId,
      bvid,
      cid: targetPage.cid,
      title,
      artist,
      album,
      durationMs: targetPage.duration * 1000,
      artworkUrl: detail.pic,
      access: "free",
      quality: "exhigh",
      pageCount: detail.pages.length
    };
  }

  async getVideoParts(bvid: string): Promise<{
    bvid: string;
    title: string;
    rawTitle: string;
    artist: string;
    artworkUrl: string | null;
    pageCount: number;
    parts: BilibiliTrackCandidate[];
  }> {
    const detail = await this.getVideoDetail(bvid);
    const cleaned = cleanBilibiliTitle(detail.title, detail.ownerName);
    const albumTitle = cleaned.songTitle || detail.title;
    const mainArtist = cleaned.artist || detail.ownerName;

    const parts: BilibiliTrackCandidate[] = (detail.pages || []).map((page) => {
      const pageCleaned = cleanBilibiliTitle(page.part, mainArtist);
      const partSongTitle = pageCleaned.songTitle || page.part || `P${page.page}`;
      const partArtist = pageCleaned.artist || mainArtist;

      return {
        provider: "bilibili",
        providerTrackId: `${bvid}:${page.cid}`,
        bvid,
        cid: page.cid,
        title: partSongTitle,
        artist: partArtist,
        album: detail.pages.length > 1 ? albumTitle : null,
        durationMs: page.duration * 1000,
        artworkUrl: detail.pic,
        access: "free",
        quality: "exhigh",
        pageCount: detail.pages.length
      };
    });

    return {
      bvid,
      title: albumTitle,
      rawTitle: detail.title,
      artist: mainArtist,
      artworkUrl: detail.pic,
      pageCount: detail.pages.length,
      parts
    };
  }

  private readonly audioStreamCache = new Map<
    string,
    { candidateUrls: string[]; mimeType: string; fileType: string; expiresAt: number }
  >();

  /** 写入前顺手淘汰过期项,缓存只增不减的历史问题在此收口。 */
  private pruneAudioStreamCache(now: number) {
    if (this.audioStreamCache.size < 128) return;
    for (const [key, entry] of this.audioStreamCache) {
      if (entry.expiresAt <= now) this.audioStreamCache.delete(key);
    }
  }

  private async getResolvedAudioCandidates(bvid: string, cid?: number): Promise<{
    candidateUrls: string[];
    mimeType: string;
    fileType: string;
    cid: number;
  }> {
    const now = Date.now();
    let viewData = null;
    try {
      viewData = await this.client.getVideoView(bvid);
    } catch {
      viewData = null;
    }
    const resolvedCid = cid ?? viewData?.pages?.[0]?.cid ?? (await this.resolveFirstCid(bvid));
    const targetAid = viewData?.aid ? Number(viewData.aid) : undefined;
    const cacheKey = `${bvid}:${resolvedCid}`;

    const cached = this.audioStreamCache.get(cacheKey);
    if (cached && cached.expiresAt > now && cached.candidateUrls.length > 0) {
      return {
        candidateUrls: cached.candidateUrls,
        mimeType: cached.mimeType,
        fileType: cached.fileType,
        cid: resolvedCid
      };
    }

    // 1. 优先获取 Web PlayUrl（音质最高、纯音频 DASH 体积仅 3~5MB）
    let playData = null;
    try {
      playData = await this.client.getPlayUrl(bvid, resolvedCid, targetAid);
    } catch (err) {
      this.logger.warn(`Failed to fetch Web PlayUrl for ${bvid}:${resolvedCid}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const audioStreams = playData?.dash?.audio ?? [];
    if (audioStreams.length > 0) {
      const bestAudio = [...audioStreams].sort((a, b) => b.bandwidth - a.bandwidth)[0]!;
      const candidateUrls = sortBilibiliAudioUrls(bestAudio.baseUrl, bestAudio.backupUrl).map(
        (url) => url.replace(/^http:\/\//i, "https://")
      );
      if (candidateUrls.length > 0) {
        const result = {
          candidateUrls,
          mimeType: "audio/mp4",
          fileType: "m4a",
          expiresAt: now + 30 * 60 * 1000 // 缓存 30 分钟
        };
        this.pruneAudioStreamCache(now);
        this.audioStreamCache.set(cacheKey, result);
        return {
          candidateUrls,
          mimeType: result.mimeType,
          fileType: result.fileType,
          cid: resolvedCid
        };
      }
    }

    // 2. 只有在缺失 DASH 音频流时（如极老视频投稿），才尝试 Web durl 或 TV 端 durl 兜底
    let fallbackUrl: string | undefined = playData?.durl?.[0]?.url;
    if (!fallbackUrl && targetAid) {
      try {
        const tvData = await this.client.getTvPlayUrl(targetAid, resolvedCid);
        fallbackUrl = tvData?.durl?.[0]?.url;
      } catch (err) {
        this.logger.warn(`Failed to fetch TV PlayUrl fallback for ${bvid}:${resolvedCid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (fallbackUrl) {
      if (fallbackUrl.startsWith("http://")) {
        fallbackUrl = fallbackUrl.replace(/^http:\/\//i, "https://");
      }
      const result = {
        candidateUrls: [fallbackUrl],
        mimeType: "video/mp4",
        fileType: "mp4",
        expiresAt: now + 15 * 60 * 1000 // 兜底缓存 15 分钟
      };
      this.pruneAudioStreamCache(now);
        this.audioStreamCache.set(cacheKey, result);
      return {
        candidateUrls: [fallbackUrl],
        mimeType: result.mimeType,
        fileType: result.fileType,
        cid: resolvedCid
      };
    }

    throw new NotFoundException(`未能解析到 B 站音频流直链: ${bvid} (cid: ${resolvedCid})`);
  }

  async resolveAudio(
    bvid: string,
    cid?: number,
    _quality?: "standard" | "high" | "exhigh"
  ): Promise<{
    url: string;
    urls: string[];
    mimeType: string;
    fileType: string;
    bvid: string;
    cid: number;
  }> {
    const { candidateUrls, mimeType, fileType, cid: resolvedCid } = await this.getResolvedAudioCandidates(bvid, cid);
    const primaryUrl = candidateUrls[0] || "";
    if (!primaryUrl) {
      throw new NotFoundException(`未能解析到 B 站音频流直链: ${bvid}`);
    }

    return {
      url: primaryUrl,
      urls: candidateUrls,
      mimeType,
      fileType,
      bvid,
      cid: resolvedCid
    };
  }

  async openAudioStream(
    bvid: string,
    cid?: number,
    _quality?: "standard" | "high" | "exhigh",
    range?: string
  ) {
    const { candidateUrls } = await this.getResolvedAudioCandidates(bvid, cid);
    return this.client.fetchAudioStream(candidateUrls, range);
  }

  async getLyrics(bvid: string, cid?: number): Promise<ProviderLyrics> {
    const resolvedCid = cid ?? (await this.resolveFirstCid(bvid));
    const providerTrackId = `${bvid}:${resolvedCid}`;

    // 1. 优先尝试标题降噪与专业音乐平台（网易云 / QQ 音乐）匹配
    // 专业音乐平台拥有经过校对的专业歌词、逐字歌词 (YRC) 以及译文，信噪比远高于视频口播字幕
    try {
      const videoDetail = await this.getVideoDetail(bvid);
      const targetPage = videoDetail.pages.find((p) => p.cid === resolvedCid) ?? videoDetail.pages[0];
      const pageTitle = (targetPage && videoDetail.pages.length > 1 && targetPage.part) ? targetPage.part : videoDetail.title;
      const cleaned = cleanBilibiliTitle(pageTitle, videoDetail.ownerName);

      const matchedLyrics = await this.lyricMatcher.match(
        cleaned.fullQuery,
        targetPage?.duration ?? videoDetail.duration,
        cleaned.songTitle,
        cleaned.artist
      );
      if (matchedLyrics) {
        return {
          provider: "bilibili",
          providerTrackId,
          plainLyric: matchedLyrics.plainLyric,
          wordSyncedLyric: matchedLyrics.wordSyncedLyric,
          translatedLyric: matchedLyrics.translatedLyric,
          romanizedLyric: matchedLyrics.romanizedLyric
        };
      }
    } catch (err) {
      this.logger.warn(`Cross-platform lyric lookup failed for ${providerTrackId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. 兜底尝试提取 B 站原生 CC 字幕（需过滤口播/营销导流等伪歌词）
    try {
      const subtitles = await this.client.getVideoSubtitles(bvid, resolvedCid);
      const bestSubtitle = selectBestSubtitle(subtitles);
      if (bestSubtitle) {
        const items = await this.client.fetchSubtitleContent(bestSubtitle.subtitle_url);
        if (isValidLyricSubtitle(items)) {
          const lrc = convertBilibiliSubtitlesToLrc(items);
          if (lrc.trim().length > 0) {
            return {
              provider: "bilibili",
              providerTrackId,
              plainLyric: lrc,
              wordSyncedLyric: null,
              translatedLyric: null,
              romanizedLyric: null
            };
          }
        }
      }
    } catch (err) {
      this.logger.warn(`Bilibili native subtitle lookup failed for ${providerTrackId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      provider: "bilibili",
      providerTrackId,
      plainLyric: null,
      wordSyncedLyric: null,
      translatedLyric: null,
      romanizedLyric: null
    };
  }

  async search(keyword: string, page = 1, pageSize = 10, tid?: number): Promise<BilibiliSearchResponse> {
    const { items, total } = await this.client.searchVideo(keyword, page, pageSize, tid);
    const candidates = items.map((item) => mapSearchItemToCandidate(item));
    return {
      items: candidates,
      total,
      limit: pageSize,
      offset: (page - 1) * pageSize
    };
  }

  async importFavorite(
    urlOrId: string,
    page = 1,
    pageSize = 30
  ): Promise<{
    title: string;
    items: BilibiliTrackCandidate[];
    total: number;
    hasMore: boolean;
  }> {
    const mediaId = extractBilibiliMediaId(urlOrId);
    if (!mediaId) {
      throw new NotFoundException("未提取到有效的 B 站收藏夹 ID");
    }

    const res = await this.client.getFavoriteResources(mediaId, page, pageSize);
    const validItems = (res.items || [])
      .filter((item) => item.bvid && item.title !== "已失效视频" && item.attr === 0)
      .map((item) => mapFavoriteItemToCandidate(item));

    return {
      title: res.title || "B 站导入歌单",
      items: validItems,
      total: res.total,
      hasMore: res.hasMore
    };
  }

  async getRanking(subType = "3"): Promise<BilibiliTrackCandidate[]> {
    const list = await this.client.getMusicRanking(subType);
    return (list || []).map((item) => mapRankingItemToCandidate(item));
  }

  private async resolveFirstCid(bvid: string): Promise<number> {
    const detail = await this.getVideoDetail(bvid);
    const firstCid = detail.pages[0]?.cid;
    if (!firstCid) {
      throw new NotFoundException(`Bilibili 视频不存在有效分P: ${bvid}`);
    }
    return firstCid;
  }
}
