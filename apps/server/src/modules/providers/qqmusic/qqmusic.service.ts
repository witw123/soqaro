import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  ProviderAlbumDetail,
  ProviderAlbumListResponse,
  ProviderAlbumSummary,
  ProviderArtistSummary,
  ProviderLyrics,
  ProviderLibrarySnapshot,
  ProviderPlaylistDetail,
  ProviderPlaylistListResponse,
  ProviderPlaylistSummary,
  ProviderSearchSuggestionListResponse,
  QqMusicSearchResponse,
  QqMusicTrackCandidate
} from "@soqaro/shared";
import { createApiErrorResponse, errorCodes } from "@soqaro/shared";
import { RedisService } from "../../../infra/redis/redis.service";
import { fetchProviderUrl } from "../provider-fetch";
import { ProviderRateLimiter } from "../provider-rate-limiter";
import { QqMusicAccountService } from "./qqmusic-account.service";
import { QqMusicApiClient, QqMusicApiError } from "./qqmusic-api.client";
import {
  accountValidationTtlMs,
  asRecord,
  buildQqAlbumArtwork,
  dedupeAlbums,
  findFirstArray,
  isAllowedHost,
  normalizeQqMusicArtworkUrl,
  normalizeQqMusicAudioUrl,
  qrKeyPrefix,
  qrTtlSeconds,
  readFirstRecord,
  readHttpUrl,
  readWordSyncedLyric,
  readLyricText,
  readNumber,
  readSearchTerms,
  readString,
  readTermCache,
  readTrackArray,
  resolveArtworkMime,
  resolveMime,
  toAlbumSummary,
  toArtistSummary,
  toPlaylistSummary,
  toSearchSuggestions,
  toTrackCandidate,
  trimTermCache,
  unwrapData,
  type QrAttempt,
  type SearchTermCache
} from "./qqmusic.mappers";
import {
  qqMusicQualitySchema,
  type QqMusicCatalogPageQuery,
  type QqMusicQuality,
  type QqMusicSearchQuery,
  type QqMusicSearchSuggestQuery
} from "./qqmusic.schemas";

@Injectable()
export class QqMusicService {
  private readonly rateLimiter = new ProviderRateLimiter({ providerLabel: "QQ Music" });
  private readonly searchSuggestionCache = new Map<string, SearchTermCache>();
  private readonly accountValidation = new Map<string, Promise<void>>();
  private searchHotCache: SearchTermCache | null = null;
  constructor(private readonly api: QqMusicApiClient, private readonly accounts: QqMusicAccountService, private readonly redis: RedisService) {}
  async getAccountStatus(userId: string) {
    this.assertEnabled();
    const status = await this.accounts.getStatus(userId);
    if (!status.connected || !status.qqMusicUserId || typeof this.api.validateCookie !== "function" || typeof this.accounts.getValidationState !== "function") {
      return status;
    }
    try {
      const state = await this.accounts.getValidationState(userId);
      if (!state.qqMusicUserId) return status;
      if (state.lastValidatedAt && Date.now() - state.lastValidatedAt.getTime() < accountValidationTtlMs) return status;
      await this.validateAccount(userId, state.cookie, state.qqMusicUserId, true);
      return this.accounts.getStatus(userId);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.CONFLICT) {
        return { connected: false, qqMusicUserId: null, nickname: null, avatarUrl: null, lastValidatedAt: null };
      }
      return status;
    }
  }
  async startQrLogin(userId: string) {
    this.assertEnabled(); this.assertRateLimit(`qr:${userId}`, 3);
    const qr = await this.callProvider(() => this.api.createQrCode()); const attemptId = randomUUID();
    await this.redis.setJson(`${qrKeyPrefix}${attemptId}`, { userId, qrsig: qr.qrsig, ptqrtoken: qr.ptqrtoken }, qrTtlSeconds);
    return { attemptId, qrimg: qr.qrimg, expiresAt: new Date(Date.now() + qrTtlSeconds * 1000).toISOString() };
  }
  async checkQrLogin(userId: string, attemptId: string) {
    this.assertEnabled(); const key = `${qrKeyPrefix}${attemptId}`; const attempt = await this.redis.getJson<QrAttempt>(key);
    if (!attempt) return { status: "expired" as const }; if (attempt.userId !== userId) throw new HttpException(createApiErrorResponse(errorCodes.unauthorized, "This QR login attempt belongs to another user."), HttpStatus.FORBIDDEN);
    const result = await this.callProvider(() => this.api.checkQrCode(attempt));
    if (result.status === "connected" && result.session) {
      if (typeof this.api.validateCookie === "function") {
        try {
          if (!result.session.userId) throw new QqMusicApiError("auth-expired");
          await this.api.validateCookie({ userId: result.session.userId, cookie: result.session.cookie });
        } catch {
          await this.redis.delete(key);
          return { status: "failed" as const, message: "二维码已扫码，但 QQ 音乐登录验证失败，请重新生成二维码。" };
        }
      }
      await this.accounts.saveAccount({ userId, cookie: result.session.cookie, qqMusicUserId: result.session.userId, nickname: result.session.nickname, avatarUrl: result.session.avatarUrl });
      await this.redis.delete(key); return { status: "connected" as const, account: await this.accounts.getStatus(userId) };
    }
    if (result.status === "expired") await this.redis.delete(key);
    return { status: result.status, ...(result.message ? { message: result.message } : {}) };
  }
  async disconnectAccount(userId: string) { this.assertEnabled(); return this.accounts.disconnect(userId); }
  async searchTracks(userId: string, query: QqMusicSearchQuery, clientIp?: string): Promise<QqMusicSearchResponse> {
    this.assertEnabled(); this.assertRateLimit(`search:${this.resolveRateLimitSubject(userId, clientIp)}`, 30); const cookie = await this.getOptionalCookie(userId);
    const records = await this.callProvider(() => this.api.searchTracks({ ...query, cookie }));
    return { items: records.map((record) => toTrackCandidate(record)).filter((value): value is QqMusicTrackCandidate => !!value), limit: query.limit, offset: query.offset };
  }

  async searchPlaylists(userId: string, query: QqMusicSearchQuery, clientIp?: string): Promise<ProviderPlaylistListResponse> {
    this.assertEnabled();
    this.assertRateLimit(`search:${this.resolveRateLimitSubject(userId, clientIp)}`, 30);
    const cookie = await this.getOptionalCookie(userId);
    const records = await this.callProvider(() => this.api.searchPlaylists({ ...query, cookie }));
    return {
      items: records.map((record) => toPlaylistSummary(record)).filter((value): value is ProviderPlaylistSummary => !!value),
      limit: query.limit,
      offset: query.offset
    };
  }

  async searchAlbums(userId: string, query: QqMusicSearchQuery, clientIp?: string): Promise<ProviderAlbumListResponse> {
    this.assertEnabled();
    this.assertRateLimit(`search:${this.resolveRateLimitSubject(userId, clientIp)}`, 30);
    const cookie = await this.getOptionalCookie(userId);
    const records = await this.callProvider(() => this.api.searchTracks({ ...query, cookie, kind: "album" }));
    const albumItems = records
      .map((record) => toAlbumSummary(record))
      .filter((value): value is ProviderAlbumSummary => !!value);
    const fallbackRecords = albumItems.length > 0
      ? []
      : await this.callProvider(() => this.api.searchTracks({ ...query, cookie, kind: "song" }));
    const items = albumItems.length > 0
      ? dedupeAlbums(albumItems)
      : dedupeAlbums(fallbackRecords
        .map((record) => toAlbumSummary(record))
        .filter((value): value is ProviderAlbumSummary => !!value));
    return {
      items,
      limit: query.limit,
      offset: query.offset
    };
  }

  async searchSuggestions(userId: string, query: QqMusicSearchSuggestQuery, clientIp?: string): Promise<ProviderSearchSuggestionListResponse> {
    this.assertEnabled();
    this.assertRateLimit(`search-suggest:${this.resolveRateLimitSubject(userId, clientIp)}`, 60);
    const key = query.keywords.trim().toLocaleLowerCase();
    const cached = readTermCache(this.searchSuggestionCache.get(key));
    if (cached) return { items: cached };

    try {
      const body = await this.callProvider(() => this.api.searchSuggestions({ keywords: query.keywords }));
      const items = toSearchSuggestions(readSearchTerms(body, ["keyword", "name", "searchWord", "word", "title", "query", "k"]), "联想");
      this.searchSuggestionCache.set(key, { items, expiresAt: Date.now() + 45_000 });
      trimTermCache(this.searchSuggestionCache);
      return { items };
    } catch {
      return { items: readTermCache(this.searchSuggestionCache.get(key), true) ?? [] };
    }
  }

  async getSearchHot(userId: string, clientIp?: string): Promise<ProviderSearchSuggestionListResponse> {
    this.assertEnabled();
    this.assertRateLimit(`search-hot:${this.resolveRateLimitSubject(userId, clientIp)}`, 12);
    const cached = readTermCache(this.searchHotCache);
    if (cached) return { items: cached };

    try {
      const body = await this.callProvider(() => this.api.getSearchHot());
      const items = toSearchSuggestions(readSearchTerms(body, ["searchWord", "searchword", "keyword", "word", "name", "k", "title"]), "热词");
      this.searchHotCache = { items, expiresAt: Date.now() + 10 * 60_000 };
      return { items };
    } catch {
      return { items: readTermCache(this.searchHotCache, true) ?? [] };
    }
  }

  async getTrack(userId: string, trackId: string) {
    this.assertEnabled(); const cookie = await this.getOptionalCookie(userId); const records = await this.callProvider(() => this.api.searchTracks({ keywords: trackId, limit: 20, offset: 0, cookie }));
    const track = records
      .map((record) => toTrackCandidate(record))
      .find((value) => value?.providerTrackId === trackId);
    if (!track) throw new HttpException(createApiErrorResponse(errorCodes.qqMusicTrackNotFound, "QQ Music track was not found."), HttpStatus.NOT_FOUND); return track;
  }

  async getLyrics(userId: string, trackId: string): Promise<ProviderLyrics> {
    this.assertEnabled();
    const cookie = await this.getOptionalCookie(userId);
    const body = await this.callProvider(() => this.api.getLyrics({ trackId, cookie }));
    return {
      provider: "qqmusic",
      providerTrackId: trackId,
      plainLyric: readLyricText(body.lyric),
      wordSyncedLyric: readWordSyncedLyric(body.qrc),
      translatedLyric: readLyricText(body.trans),
      romanizedLyric: readLyricText(body.roma)
    };
  }

  async getLibrarySnapshot(userId: string): Promise<ProviderLibrarySnapshot> {
    this.assertEnabled();
    const cookie = await this.getCookie(userId);
    const account = await this.accounts.getStatus(userId);
    if (!account.qqMusicUserId) {
      throw new HttpException(createApiErrorResponse(errorCodes.qqMusicAuthExpired, "The QQ Music account needs to be bound again."), HttpStatus.CONFLICT);
    }
    const providerUserId = account.qqMusicUserId;
    const results = await Promise.allSettled([
      this.callProvider(() => this.api.getLikedPlaylist({ userId: providerUserId, cookie })),
      this.callProvider(() => this.api.getCollectedPlaylists({ userId: providerUserId, limit: 500, offset: 0, cookie })),
      this.callProvider(() => this.api.getCollectedAlbums({ userId: providerUserId, limit: 500, offset: 0, cookie })),
      this.callProvider(() => this.api.getFollowedArtists({ userId: providerUserId, limit: 500, offset: 0, cookie }))
    ]);
    const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (results.every((result) => result.status === "rejected") && firstFailure) throw firstFailure.reason;
    const profile = results[0].status === "fulfilled" ? results[0].value : {};
    const playlistBody = results[1].status === "fulfilled" ? results[1].value : {};
    const albumBody = results[2].status === "fulfilled" ? results[2].value : {};
    const artistBody = results[3].status === "fulfilled" ? results[3].value : {};
    const likedEntry = findFirstArray(profile, ["mymusic", "myMusic", "list"])
      .map(asRecord)
      .find((item) => item && (item.type === 1 || readString(item.title)?.includes("喜欢")));
    const likedPlaylistId = readString(likedEntry?.id ?? likedEntry?.dissid ?? likedEntry?.tid);
    let likedTracks: QqMusicTrackCandidate[] = [];
    if (likedPlaylistId) {
      try {
        const liked = await this.callProvider(() => this.api.getPlaylist({ playlistId: likedPlaylistId, cookie }));
        const playlist = readFirstRecord(liked, ["cdlist", "playlist", "playlists", "disslist", "dissList", "list"]);
        likedTracks = playlist ? readTrackArray(playlist).map((item) => toTrackCandidate(item)).filter((item): item is QqMusicTrackCandidate => !!item) : [];
      } catch {
        likedTracks = [];
      }
    }
    const collectedPlaylists = findFirstArray(playlistBody, ["cdlist", "disslist", "dissList", "list", "playlists"])
      .map((item) => toPlaylistSummary(item))
      .filter((item): item is ProviderPlaylistSummary => !!item);
    const collectedAlbums = findFirstArray(albumBody, ["albumlist", "albumList", "list", "albums"])
      .map((item) => toAlbumSummary(item))
      .filter((item): item is ProviderAlbumSummary => !!item);
    const followedArtists = findFirstArray(artistBody, ["singerlist", "singerList", "list", "singers"])
      .map((item) => toArtistSummary(item))
      .filter((item): item is ProviderArtistSummary => !!item);
    return { provider: "qqmusic", likedTracks, collectedPlaylists, collectedAlbums, followedArtists };
  }

  async getRelatedPlaylists(userId: string, trackId: string): Promise<ProviderPlaylistListResponse> {
    this.assertEnabled();
    const cookie = await this.getOptionalCookie(userId);
    const body = await this.callProvider(() => this.api.getRelatedPlaylists({ trackId, cookie }));
    const items = findFirstArray(body, ["vec_sim_diss", "disslist", "dissList", "list", "playlists"])
      .map((item) => toPlaylistSummary(item))
      .filter((item): item is ProviderPlaylistSummary => !!item);
    return { items, limit: Math.max(1, items.length), offset: 0 };
  }

  async listPlaylists(userId: string, query: QqMusicCatalogPageQuery): Promise<ProviderPlaylistListResponse> {
    this.assertEnabled();
    const cookie = await this.getCookie(userId);
    const account = await this.accounts.getStatus(userId);
    if (!account.qqMusicUserId) {
      throw new HttpException(createApiErrorResponse(errorCodes.qqMusicAuthExpired, "The QQ Music account needs to be bound again."), HttpStatus.CONFLICT);
    }
    const body = await this.callProvider(() => this.api.getUserPlaylists({ userId: account.qqMusicUserId!, ...query, cookie }));
    const data = asRecord(body.data);
    const candidateLists: unknown[] = [
      data?.playlists,
      data?.list,
      body.playlists,
      asRecord(data?.mydiss)?.list
    ];
    const records = candidateLists.find(
      (candidate): candidate is unknown[] => Array.isArray(candidate)
    ) ?? [];
    return {
      items: records
        .map((item: unknown) => toPlaylistSummary(item))
        .filter((item: ProviderPlaylistSummary | null): item is ProviderPlaylistSummary => !!item),
      limit: query.limit,
      offset: query.offset
    };
  }

  async getPlaylist(userId: string, playlistId: string): Promise<ProviderPlaylistDetail> {
    this.assertEnabled();
    const cookie = await this.getOptionalCookie(userId);
    const body = await this.callProvider(() => this.api.getPlaylist({ playlistId, cookie }));
    const playlist = readFirstRecord(body, ["cdlist", "playlist", "playlists", "disslist", "dissList", "list"]);
    if (!playlist) throw this.unavailableError();
    const summary = toPlaylistSummary(playlist);
    if (!summary) throw this.unavailableError();
    const tracks = readTrackArray(playlist)
      .map((item) => toTrackCandidate(item))
      .filter((item): item is QqMusicTrackCandidate => !!item);
    return { ...summary, tracks };
  }

  async getAlbum(userId: string, albumId: string): Promise<ProviderAlbumDetail> {
    this.assertEnabled();
    const cookie = await this.getOptionalCookie(userId);
    const body = await this.callProvider(() => this.api.getAlbum({ albumId, cookie }));
    const info = unwrapData(body.info);
    const tracks = readTrackArray(body.songs)
      .map((item) => toTrackCandidate(item))
      .filter((item): item is QqMusicTrackCandidate => !!item);
    return {
      provider: "qqmusic",
      providerAlbumId: readString(info?.albumMid ?? info?.albummid ?? info?.albumMID ?? info?.albumid ?? info?.albumID ?? info?.id) ?? albumId,
      title: readString(info?.albumName ?? info?.albumname ?? info?.name) ?? "未命名专辑",
      artist: readString(info?.singerName ?? info?.singername ?? info?.artist) ?? "未知歌手",
      description: readString(info?.desc ?? info?.description),
      artworkUrl: readHttpUrl(
        info?.albumPic,
        info?.album_pic,
        info?.albumPicUrl,
        info?.picUrl,
        info?.picurl,
        info?.imgUrl,
        info?.imgurl,
        info?.coverUrl,
        info?.coverImgUrl
      ) ?? buildQqAlbumArtwork(readString(info?.albumMid ?? info?.albummid ?? info?.albumMID) ?? albumId),
      releaseTime: readString(info?.pubTime ?? info?.publishTime ?? info?.time_public ?? info?.aDate),
      trackCount: readNumber(info?.songNum ?? info?.songnum ?? info?.cur_song_num ?? info?.total) ?? tracks.length,
      tracks
    };
  }
  async resolveAudio(userId: string, trackId: string, quality: QqMusicQuality) {
    this.assertEnabled();
    this.assertRateLimit(`audio:${userId}`, 120);
    const source = await this.resolveAudioSource(userId, trackId, quality);
    const mimeType = resolveMime(null, source.url.toString());
    return {
      provider: "qqmusic" as const,
      providerTrackId: trackId,
      url: source.url.toString(),
      mimeType,
      fileType: mimeType === "audio/flac" ? "flac" as const : "mp3" as const
    };
  }

  async openArtwork(rawUrl: string) {
    this.assertEnabled();
    let url: URL;
    try {
      url = normalizeQqMusicArtworkUrl(rawUrl);
    } catch {
      throw this.unavailableError();
    }
    if (!isAllowedHost(url.hostname)) throw this.unavailableError();

    const upstream = await fetchProviderUrl(
      url,
      { headers: new Headers({ accept: "image/*" }) },
      this.requestTimeoutMs(),
      isAllowedHost,
      { allowSyntheticDns: true }
    ).catch(() => null);
    if (!upstream?.ok || !upstream.body) throw this.unavailableError();

    const mimeType = resolveArtworkMime(upstream.headers.get("content-type"));
    if (!mimeType) {
      await upstream.body.cancel().catch(() => undefined);
      throw this.unavailableError();
    }
    const contentLength = Number(upstream.headers.get("content-length") ?? "0");
    if (contentLength > this.maxArtworkBytes()) {
      await upstream.body.cancel().catch(() => undefined);
      throw this.unavailableError();
    }
    return {
      upstream,
      mimeType,
      contentLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null,
      maxBytes: this.maxArtworkBytes()
    };
  }

  async openAudio(userId: string, trackId: string, quality: string, range?: string) {
    this.assertEnabled(); this.assertRateLimit(`audio:${userId}`, 120);
    const selected = qqMusicQualitySchema.safeParse(quality).success ? quality as QqMusicQuality : this.defaultQuality();
    const cookie = await this.getOptionalCookie(userId);
    if (cookie) {
      await this.ensureAccountValidated(userId, cookie);
    }
    const qualities = this.qualitiesForQuality(selected);

    let sawUnsupported = false;
    let sawOversized = false;
    let sawUrl = false;
    for (const candidateQuality of qualities) {
      const result = await this.callProvider(() => this.api.getAudioUrl({ trackId, quality: candidateQuality, cookie }));
      if (!result.url) continue;
      let source: URL;
      try {
        source = normalizeQqMusicAudioUrl(result.url);
      } catch {
        continue;
      }
      if (!isAllowedHost(source.hostname)) continue;
      sawUrl = true;
      const headers = new Headers({
        accept: "audio/*,*/*;q=0.8",
        referer: "https://y.qq.com/"
      });
      if (range) headers.set("range", range);
      const upstream = await fetchProviderUrl(source, { headers }, this.requestTimeoutMs(), isAllowedHost, { allowSyntheticDns: true }).catch(() => null);
      if (!upstream?.ok || !upstream.body) {
        await upstream?.body?.cancel().catch(() => undefined);
        continue;
      }
      const mimeType = resolveMime(upstream.headers.get("content-type"), source.toString());
      if (!mimeType) {
        sawUnsupported = true;
        await upstream.body.cancel().catch(() => undefined);
        continue;
      }
      const contentLength = Number(upstream.headers.get("content-length") ?? "0");
      if (contentLength > this.maxImportBytes()) {
        sawOversized = true;
        await upstream.body.cancel().catch(() => undefined);
        continue;
      }
      return { upstream, mimeType, contentLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null, fileType: mimeType === "audio/flac" ? "flac" : "mp3", maxBytes: this.maxImportBytes() };
    }

    if (!sawUrl) throw new HttpException(createApiErrorResponse(errorCodes.qqMusicTrackNotFound, "QQ Music audio is unavailable."), HttpStatus.NOT_FOUND);
    if (sawOversized) throw new HttpException(createApiErrorResponse(errorCodes.qqMusicImportTooLarge, "QQ Music audio is too large."), HttpStatus.PAYLOAD_TOO_LARGE);
    if (sawUnsupported) throw new HttpException(createApiErrorResponse(errorCodes.qqMusicAudioUnsupported, "QQ Music returned an unsupported audio format."), HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    throw this.unavailableError();
  }

  private async resolveAudioSource(userId: string, trackId: string, quality: QqMusicQuality) {
    const cookie = await this.getOptionalCookie(userId);
    if (cookie) {
      await this.ensureAccountValidated(userId, cookie);
    }
    const qualities = this.qualitiesForQuality(quality);
    for (const candidateQuality of qualities) {
      const result = await this.callProvider(() => this.api.getAudioUrl({ trackId, quality: candidateQuality, cookie }));
      if (!result.url) continue;
      try {
        const url = normalizeQqMusicAudioUrl(result.url);
        if (isAllowedHost(url.hostname)) return { url };
      } catch {
        // Keep trying a lower quality when QQ returns a stale or malformed URL.
      }
    }
    throw new HttpException(createApiErrorResponse(errorCodes.qqMusicTrackNotFound, "QQ Music audio is unavailable."), HttpStatus.NOT_FOUND);
  }

  private resolveRateLimitSubject(userId: string, clientIp?: string): string {
    if (userId && userId !== "anonymous") {
      return `user:${userId}`;
    }
    return `ip:${clientIp?.trim() || "unknown"}`;
  }

  private async getOptionalCookie(userId: string): Promise<string> {
    if (!userId || userId === "anonymous") {
      return "";
    }
    try {
      return await this.accounts.getCookieOrThrow(userId);
    } catch {
      return "";
    }
  }

  private async getCookie(userId: string) {
    try {
      return await this.accounts.getCookieOrThrow(userId);
    } catch {
      throw new HttpException(createApiErrorResponse(errorCodes.qqMusicAccountRequired, "QQ Music account is required."), HttpStatus.CONFLICT);
    }
  }

  private async ensureAccountValidated(userId: string, cookie: string) {
    if (!cookie) return;
    if (typeof this.api.validateCookie !== "function" || typeof this.accounts.getValidationState !== "function") return;
    const state = await this.accounts.getValidationState(userId).catch(() => null);
    if (!state?.qqMusicUserId) {
      throw new HttpException(createApiErrorResponse(errorCodes.qqMusicAuthExpired, "The QQ Music account needs to be bound again."), HttpStatus.CONFLICT);
    }
    if (state.lastValidatedAt && Date.now() - state.lastValidatedAt.getTime() < accountValidationTtlMs) return;
    await this.validateAccount(userId, cookie, state.qqMusicUserId, false);
  }

  private async validateAccount(userId: string, cookie: string, qqMusicUserId: string, returnHttpError: boolean) {
    const pending = this.accountValidation.get(userId);
    if (pending) return pending;
    const validation = (async () => {
      try {
        await this.api.validateCookie({ userId: qqMusicUserId, cookie });
        if (typeof this.accounts.markValidated === "function") await this.accounts.markValidated(userId);
      } catch (error) {
        if (error instanceof QqMusicApiError && error.kind === "auth-expired") {
          await this.accounts.invalidate(userId).catch(() => undefined);
          throw new HttpException(createApiErrorResponse(errorCodes.qqMusicAuthExpired, "The QQ Music account needs to be bound again."), HttpStatus.CONFLICT);
        }
        if (returnHttpError) throw this.unavailableError();
      } finally {
        this.accountValidation.delete(userId);
      }
    })();
    this.accountValidation.set(userId, validation);
    return validation;
  }

  private assertEnabled() {
    if (process.env.QQMUSIC_ENABLED !== "true") {
      throw new HttpException(createApiErrorResponse(errorCodes.qqMusicDisabled, "QQ Music integration is disabled."), HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  private assertRateLimit(key: string, limit: number) {
    this.rateLimiter.assert(key, limit);
  }

  private async callProvider<T>(operation: () => Promise<T>) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof QqMusicApiError && error.kind === "auth-expired") {
        throw new HttpException(createApiErrorResponse(errorCodes.qqMusicAuthExpired, "The QQ Music account needs to be bound again."), HttpStatus.CONFLICT);
      }
      throw this.unavailableError();
    }
  }

  private unavailableError() {
    return new HttpException(createApiErrorResponse(errorCodes.qqMusicUnavailable, "QQ Music is temporarily unavailable."), HttpStatus.BAD_GATEWAY);
  }

  private defaultQuality(): QqMusicQuality {
    return qqMusicQualitySchema.safeParse(process.env.QQMUSIC_DEFAULT_QUALITY).success
      ? (process.env.QQMUSIC_DEFAULT_QUALITY as QqMusicQuality)
      : "exhigh";
  }

  private qualitiesForQuality(quality: QqMusicQuality): QqMusicQuality[] {
    if (quality === "hires" || quality === "lossless") {
      return [quality, "exhigh", "high", "standard"];
    }
    if (quality === "exhigh") return ["exhigh", "high", "standard"];
    if (quality === "high") return ["high", "standard"];
    return ["standard", "high"];
  }

  private requestTimeoutMs() {
    const value = Number(process.env.QQMUSIC_REQUEST_TIMEOUT_MS ?? 15_000);
    return Number.isFinite(value) ? Math.max(1_000, Math.floor(value)) : 15_000;
  }

  private maxImportBytes() {
    const value = Number(process.env.QQMUSIC_MAX_IMPORT_BYTES ?? 209_715_200);
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 209_715_200;
  }

  private maxArtworkBytes() {
    const value = Number(process.env.QQMUSIC_MAX_ARTWORK_BYTES ?? 10_485_760);
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 10_485_760;
  }
}

