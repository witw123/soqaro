import {
  HttpException,
  HttpStatus,
  Injectable
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  ProviderAlbumDetail,
  ProviderAlbumListResponse,
  ProviderAlbumSummary,
  ProviderArtistSummary,
  ProviderLibrarySnapshot,
  ProviderLyrics,
  ProviderPlaylistDetail,
  ProviderPlaylistListResponse,
  ProviderPlaylistSummary,
  ProviderSearchSuggestionListResponse,
  NeteaseSearchResponse,
  NeteaseTrackCandidate
} from "@soqaro/shared";
import {
  createApiErrorResponse,
  errorCodes
} from "@soqaro/shared";
import { RedisService } from "../../../infra/redis/redis.service";
import { fetchProviderUrl } from "../provider-fetch";
import { ProviderRateLimiter } from "../provider-rate-limiter";
import { NeteaseAccountService } from "./netease-account.service";
import { NeteaseApiClient, NeteaseApiError } from "./netease-api.client";
import {
  neteaseQualitySchema,
  type NeteaseCatalogPageQuery,
  type NeteaseQuality,
  type NeteaseSearchQuery,
  type NeteaseSearchSuggestQuery
} from "./netease.schemas";

import {
  asRecord,
  findCatalogArray,
  isAllowedAudioHost,
  isNeteaseUnavailableError,
  normalizeNeteaseAudioUrl,
  qrKeyPrefix,
  qrTtlSeconds,
  readArtistNames,
  readAudioRecord,
  readLyricText,
  readNeteaseArtworkUrl,
  readNeteaseTrackArray,
  readNumber,
  readProviderTags,
  readSearchTerms,
  readString,
  readTermCache,
  resolveAudioMimeType,
  resolveTrackAccess,
  resolveTrackQuality,
  toSearchSuggestions,
  trimTermCache,
  type QrAttempt,
  type SearchTermCache,
  type SongRecord
} from "./netease.mappers";

@Injectable()
export class NeteaseService {
  private readonly searchSuggestionCache = new Map<string, SearchTermCache>();
  private searchHotCache: SearchTermCache | null = null;

  private readonly rateLimiter = new ProviderRateLimiter({ providerLabel: "NetEase" });

  constructor(
    private readonly api: NeteaseApiClient,
    private readonly accounts: NeteaseAccountService,
    private readonly redis: RedisService
  ) {}

  async getAccountStatus(userId: string) {
    this.assertEnabled();
    return this.accounts.getStatus(userId);
  }

  async startQrLogin(userId: string) {
    this.assertEnabled();
    this.assertRateLimit(`qr:${userId}`, 3, 60_000);
    const qr = await this.callProvider(undefined, () => this.api.createQrCode());
    const attemptId = randomUUID();
    await this.redis.setJson(`${qrKeyPrefix}${attemptId}`, { userId, key: qr.key }, qrTtlSeconds);
    return {
      attemptId,
      qrimg: qr.qrimg,
      expiresAt: new Date(Date.now() + qrTtlSeconds * 1000).toISOString()
    };
  }

  async checkQrLogin(userId: string, attemptId: string) {
    this.assertEnabled();
    const key = `${qrKeyPrefix}${attemptId}`;
    const attempt = await this.redis.getJson<QrAttempt>(key);
    if (!attempt) {
      return { status: "expired" as const };
    }
    if (attempt.userId !== userId) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.unauthorized, "This QR login attempt belongs to another user."),
        HttpStatus.FORBIDDEN
      );
    }

    const result = await this.callProvider(userId, () => this.api.checkQrCode(attempt.key));
    if (result.status === "connected" && result.cookie) {
      let profile;
      try {
        profile = await this.callProvider(userId, () => this.api.validateCookie(result.cookie!));
      } catch (error) {
        if (!isNeteaseUnavailableError(error)) {
          throw error;
        }
        await this.redis.delete(key);
        return {
          status: "failed" as const,
          message: "二维码已扫码，但网易云登录验证失败，请重新生成二维码。"
        };
      }
      await this.accounts.saveAccount({
        userId,
        cookie: result.cookie,
        ...profile
      });
      await this.redis.delete(key);
      return {
        status: "connected" as const,
        account: await this.accounts.getStatus(userId)
      };
    }
    if (result.status === "connected") {
      await this.redis.delete(key);
      return {
        status: "failed" as const,
        message: "NetEase QR login did not return a session cookie."
      };
    }
    if (result.status === "expired" || result.status === "failed") {
      await this.redis.delete(key);
    }

    return {
      status: result.status,
      ...(result.message ? { message: result.message } : {})
    };
  }

  async disconnectAccount(userId: string) {
    this.assertEnabled();
    return this.accounts.disconnect(userId);
  }

  async searchTracks(userId: string, query: NeteaseSearchQuery, clientIp?: string): Promise<NeteaseSearchResponse> {
    this.assertEnabled();
    this.assertRateLimit(`search:${this.resolveRateLimitSubject(userId, clientIp)}`, 30, 60_000);
    const cookie = await this.getOptionalCookie(userId);
    const response = await this.callProvider(userId, () =>
      this.api.searchTracks({ ...query, cookie })
    );
    const songs = response.result?.songs ?? [];
    const detailByTrackId = await this.getSearchTrackDetails(userId, cookie, songs);
    return {
      items: songs
        .map((song) => {
          const trackId = readString(asRecord(song)?.id);
          const detail = trackId ? detailByTrackId.get(trackId) : undefined;
          return this.toTrackCandidate({
            ...(asRecord(song) ?? {}),
            ...(asRecord(detail) ?? {})
          });
        })
        .filter((song): song is NeteaseTrackCandidate => !!song),
      limit: query.limit,
      offset: query.offset
    };
  }

  async searchPlaylists(userId: string, query: NeteaseSearchQuery, clientIp?: string): Promise<ProviderPlaylistListResponse> {
    this.assertEnabled();
    this.assertRateLimit(`search:${this.resolveRateLimitSubject(userId, clientIp)}`, 30, 60_000);
    const cookie = await this.getOptionalCookie(userId);
    const response = await this.callProvider(userId, () => this.api.searchPlaylists({ ...query, cookie }));
    return {
      items: (response.result?.playlists ?? [])
        .map((item) => this.toPlaylistSummary(item))
        .filter((item): item is ProviderPlaylistSummary => !!item),
      limit: query.limit,
      offset: query.offset
    };
  }

  async searchAlbums(userId: string, query: NeteaseSearchQuery, clientIp?: string): Promise<ProviderAlbumListResponse> {
    this.assertEnabled();
    this.assertRateLimit(`search:${this.resolveRateLimitSubject(userId, clientIp)}`, 30, 60_000);
    const cookie = await this.getOptionalCookie(userId);
    const response = await this.callProvider(userId, () => this.api.searchAlbums({ ...query, cookie }));
    return {
      items: (response.result?.albums ?? [])
        .map((item) => this.toAlbumSummary(item))
        .filter((item): item is ProviderAlbumSummary => !!item),
      limit: query.limit,
      offset: query.offset
    };
  }

  async searchSuggestions(userId: string, query: NeteaseSearchSuggestQuery, clientIp?: string): Promise<ProviderSearchSuggestionListResponse> {
    this.assertEnabled();
    this.assertRateLimit(`search-suggest:${this.resolveRateLimitSubject(userId, clientIp)}`, 60, 60_000);
    const key = query.keywords.trim().toLocaleLowerCase();
    const cached = readTermCache(this.searchSuggestionCache.get(key));
    if (cached) return { items: cached };

    try {
      const body = await this.callProvider(userId, () => this.api.searchSuggestions({ keywords: query.keywords }));
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
    this.assertRateLimit(`search-hot:${this.resolveRateLimitSubject(userId, clientIp)}`, 12, 60_000);
    const cached = readTermCache(this.searchHotCache);
    if (cached) return { items: cached };

    try {
      const body = await this.callProvider(userId, () => this.api.getSearchHot());
      const items = toSearchSuggestions(readSearchTerms(body, ["first", "searchWord", "searchword", "keyword", "word", "name", "k", "title"]), "热词");
      this.searchHotCache = { items, expiresAt: Date.now() + 10 * 60_000 };
      return { items };
    } catch {
      return { items: readTermCache(this.searchHotCache, true) ?? [] };
    }
  }

  async getTrack(userId: string, trackId: string) {
    this.assertEnabled();
    const cookie = await this.getOptionalCookie(userId);
    const response = await this.callProvider(userId, () =>
      this.api.getTrack({ trackId, cookie })
    );
    const songs = response.songs;
    const track = songs.map((song) => this.toTrackCandidate(song)).find(Boolean);
    if (!track) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.neteaseTrackNotFound, "NetEase track was not found."),
        HttpStatus.NOT_FOUND
      );
    }
    return track;
  }

  async getLyrics(userId: string, trackId: string): Promise<ProviderLyrics> {
    this.assertEnabled();
    const cookie = await this.getOptionalCookie(userId);
    const body = await this.callProvider(userId, () => this.api.getLyrics({ trackId, cookie }));
    return {
      provider: "netease",
      providerTrackId: trackId,
      plainLyric: readLyricText(asRecord(body?.lrc)?.lyric),
      wordSyncedLyric: readLyricText(asRecord(body?.yrc)?.lyric),
      translatedLyric: readLyricText(asRecord(body?.tlyric)?.lyric),
      romanizedLyric: readLyricText(asRecord(body?.romalrc)?.lyric)
    };
  }

  async getLibrarySnapshot(userId: string): Promise<ProviderLibrarySnapshot> {
    this.assertEnabled();
    const cookie = await this.getCookie(userId);
    const account = await this.accounts.getStatus(userId);
    if (!account.neteaseUserId) {
      throw new HttpException(createApiErrorResponse(errorCodes.neteaseAuthExpired, "The NetEase account needs to be bound again."), HttpStatus.CONFLICT);
    }
    const results = await Promise.allSettled([
      this.callProvider(userId, () => this.api.getLikedTrackIds({ userId: account.neteaseUserId!, cookie })),
      this.callProvider(userId, () => this.api.getUserPlaylists({ userId: account.neteaseUserId!, limit: 500, offset: 0, cookie })),
      this.callProvider(userId, () => this.api.getCollectedAlbums({ limit: 500, offset: 0, cookie })),
      this.callProvider(userId, () => this.api.getFollowedArtists({ limit: 500, offset: 0, cookie }))
    ]);
    const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (results.every((result) => result.status === "rejected") && firstFailure) throw firstFailure.reason;
    const likedBody = results[0].status === "fulfilled" ? results[0].value : {};
    const playlistBody = results[1].status === "fulfilled" ? results[1].value : {};
    const albumBody = results[2].status === "fulfilled" ? results[2].value : {};
    const artistBody = results[3].status === "fulfilled" ? results[3].value : {};
    const likedIds = (Array.isArray(likedBody.ids) ? likedBody.ids : [])
      .map(readString)
      .filter((id): id is string => !!id && /^\d+$/.test(id));
    const likedTracks: NeteaseTrackCandidate[] = [];
    for (let offset = 0; offset < likedIds.length; offset += 500) {
      try {
        const body = await this.callProvider(userId, () => this.api.getTracks({ trackIds: likedIds.slice(offset, offset + 500), cookie }));
        likedTracks.push(...body.songs.map((item) => this.toTrackCandidate(item)).filter((item): item is NeteaseTrackCandidate => !!item));
      } catch {
        break;
      }
    }
    const playlists = Array.isArray(playlistBody.playlist) ? playlistBody.playlist : Array.isArray(playlistBody.playlists) ? playlistBody.playlists : [];
    const albums = findCatalogArray(albumBody, ["data", "albums", "list"]);
    const artists = findCatalogArray(artistBody, ["data", "artists", "list"]);
    return {
      provider: "netease",
      likedTracks,
      collectedPlaylists: playlists
        .filter((item) => asRecord(item)?.subscribed === true)
        .map((item) => this.toPlaylistSummary(item))
        .filter((item): item is ProviderPlaylistSummary => !!item),
      collectedAlbums: albums.map((item) => this.toAlbumSummary(item)).filter((item): item is ProviderAlbumSummary => !!item),
      followedArtists: artists.map((item) => this.toArtistSummary(item)).filter((item): item is ProviderArtistSummary => !!item)
    };
  }

  async getRelatedPlaylists(userId: string, trackId: string): Promise<ProviderPlaylistListResponse> {
    this.assertEnabled();
    const cookie = await this.getOptionalCookie(userId);
    const body = await this.callProvider(userId, () => this.api.getRelatedPlaylists({ trackId, cookie }));
    const records = Array.isArray(body.playlists) ? body.playlists : [];
    const items = records.map((item) => this.toPlaylistSummary(item)).filter((item): item is ProviderPlaylistSummary => !!item);
    return { items, limit: Math.max(1, items.length), offset: 0 };
  }

  async listPlaylists(userId: string, query: NeteaseCatalogPageQuery): Promise<ProviderPlaylistListResponse> {
    this.assertEnabled();
    const cookie = await this.getCookie(userId);
    const account = await this.accounts.getStatus(userId);
    if (!account.neteaseUserId) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.neteaseAuthExpired, "The NetEase account needs to be bound again."),
        HttpStatus.CONFLICT
      );
    }
    const body = await this.callProvider(userId, () => this.api.getUserPlaylists({ userId: account.neteaseUserId!, ...query, cookie }));
    const records = Array.isArray(body.playlist) ? body.playlist : Array.isArray(body.playlists) ? body.playlists : [];
    return {
      items: records.map((item) => this.toPlaylistSummary(item)).filter((item): item is ProviderPlaylistSummary => !!item),
      limit: query.limit,
      offset: query.offset
    };
  }

  async getPlaylist(userId: string, playlistId: string): Promise<ProviderPlaylistDetail> {
    this.assertEnabled();
    const cookie = await this.getOptionalCookie(userId);
    const body = await this.callProvider(userId, () => this.api.getPlaylist({ playlistId, cookie }));
    const playlist = asRecord(body.playlist);
    if (!playlist) throw this.unavailableError();
    const summary = this.toPlaylistSummary(playlist);
    if (!summary) throw this.unavailableError();
    const rawTracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    const tracks = rawTracks
      .map((item) => this.toTrackCandidate(item))
      .filter((item): item is NeteaseTrackCandidate => !!item);
    const trackIds = Array.isArray(playlist.trackIds)
      ? playlist.trackIds.map((item) => readString(asRecord(item)?.id ?? item)).filter((item): item is string => !!item && /^\d+$/.test(item))
      : [];
    if (trackIds.length > tracks.length) {
      for (let offset = tracks.length; offset < trackIds.length; offset += 1_000) {
        const page = await this.callProvider(userId, () => this.api.getPlaylistTracks({ playlistId, limit: 1_000, offset, cookie }));
        const pageTracks = Array.isArray(page.songs) ? page.songs : [];
        tracks.push(
          ...pageTracks
            .map((item) => this.toTrackCandidate(item))
            .filter((item): item is NeteaseTrackCandidate => !!item)
        );
      }
    }
    return { ...summary, tracks };
  }

  async getAlbum(userId: string, albumId: string): Promise<ProviderAlbumDetail> {
    this.assertEnabled();
    const cookie = await this.getOptionalCookie(userId);
    const body = await this.callProvider(userId, () => this.api.getAlbum({ albumId, cookie }));
    const album = asRecord(body.album) ?? asRecord(body);
    if (!album) throw this.unavailableError();
    const tracks = readNeteaseTrackArray(body, album)
      .map((item) => this.toTrackCandidate(item))
      .filter((item): item is NeteaseTrackCandidate => !!item);
    const summary = this.toAlbumSummary({ ...album, id: album.id ?? albumId });
    if (!summary) throw this.unavailableError();
    return {
      ...summary,
      tracks
    };
  }

  async resolveAudio(userId: string, trackId: string, quality: NeteaseQuality) {
    this.assertEnabled();
    this.assertRateLimit(`audio:${userId}`, 120, 60_000);
    const source = await this.resolveAudioSource(userId, trackId, quality);
    const mimeType = resolveAudioMimeType(source.type, source.url.pathname);
    return {
      provider: "netease" as const,
      providerTrackId: trackId,
      url: source.url.toString(),
      mimeType,
      fileType: mimeType === "audio/flac" ? "flac" as const : "mp3" as const
    };
  }

  async openAudio(userId: string, trackId: string, quality: string, range?: string) {
    this.assertEnabled();
    this.assertRateLimit(`audio:${userId}`, 120, 60_000);
    const parsedQuality = neteaseQualitySchema.safeParse(quality);
    const source = await this.resolveAudioSource(
      userId,
      trackId,
      parsedQuality.success ? parsedQuality.data : this.defaultQuality()
    );
    const headers = new Headers();
    if (range) {
      headers.set("range", range);
    }
    const upstream = await fetchProviderUrl(
      source.url,
      { headers },
      this.requestTimeoutMs(),
      isAllowedAudioHost,
      { allowSyntheticDns: true }
    ).catch(() => {
      throw this.unavailableError();
    });

    if (!upstream.ok || !upstream.body) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.neteaseUnavailable, "NetEase audio could not be fetched."),
        HttpStatus.BAD_GATEWAY
      );
    }

    const mimeType = resolveAudioMimeType(source.type, upstream.headers.get("content-type"));
    if (!mimeType) {
      await upstream.body.cancel().catch(() => undefined);
      throw new HttpException(
        createApiErrorResponse(errorCodes.neteaseAudioUnsupported, "NetEase returned an unsupported audio format."),
        HttpStatus.UNSUPPORTED_MEDIA_TYPE
      );
    }

    const contentLength = Number(upstream.headers.get("content-length") ?? "0");
    if (contentLength > this.maxImportBytes()) {
      await upstream.body.cancel().catch(() => undefined);
      throw new HttpException(
        createApiErrorResponse(errorCodes.neteaseImportTooLarge, "The NetEase audio file is too large."),
        HttpStatus.PAYLOAD_TOO_LARGE
      );
    }

    return {
      upstream,
      mimeType,
      contentLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null,
      fileType: mimeType === "audio/flac" ? "flac" : "mp3",
      maxBytes: this.maxImportBytes()
    };
  }

  private async resolveAudioSource(
    userId: string,
    trackId: string,
    quality: NeteaseQuality
  ) {
    const cookie = await this.getOptionalCookie(userId);
    const bitrates = this.bitratesForQuality(quality);
    let audio: { url: string; type?: string | null } | null = null;
    for (const candidateBitrate of bitrates) {
      const response = await this.callProvider(userId, () =>
        this.api.getAudioUrl({ trackId, bitrate: candidateBitrate, cookie })
      );
      audio = readAudioRecord(response);
      if (audio?.url) break;
    }

    if (!audio?.url) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.neteaseTrackNotFound, "NetEase audio is unavailable."),
        HttpStatus.NOT_FOUND
      );
    }

    let url: URL;
    try {
      url = normalizeNeteaseAudioUrl(audio.url);
    } catch {
      throw this.unavailableError();
    }
    if (!isAllowedAudioHost(url.hostname)) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.neteaseUnavailable, "NetEase returned an unsupported audio URL."),
        HttpStatus.BAD_GATEWAY
      );
    }
    return { url, type: audio.type ?? null };
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "NetEase account is required.";
      if (message.includes("required")) {
        throw new HttpException(
          createApiErrorResponse(errorCodes.neteaseAccountRequired, "Bind a NetEase account first."),
          HttpStatus.CONFLICT
        );
      }
      throw new HttpException(
        createApiErrorResponse(errorCodes.neteaseAuthExpired, "The NetEase account needs to be bound again."),
        HttpStatus.CONFLICT
      );
    }
  }

  private toTrackCandidate(value: unknown): NeteaseTrackCandidate | null {
    const song = asRecord(value) as SongRecord | null;
    if (!song) {
      return null;
    }
    const trackId = readString(song?.id);
    const title = readString(song?.name);
    if (!trackId || !/^\d+$/.test(trackId) || !title) {
      return null;
    }

    const artists = Array.isArray(song?.artists)
      ? song.artists
      : Array.isArray(song?.ar)
        ? song.ar
        : [];
    const artistNames = artists
      .map((artist) => readString(asRecord(artist)?.name))
      .filter((name): name is string => !!name);
    const albumRecord = asRecord(song?.album);
    const legacyAlbumRecord = asRecord(song?.al);
    const songRecord = asRecord(song);
    const albumName = readString(albumRecord?.name) ?? readString(legacyAlbumRecord?.name);
    const providerAlbumId =
      readString(albumRecord?.id ?? albumRecord?.albumId) ??
      readString(legacyAlbumRecord?.id ?? legacyAlbumRecord?.albumId);
    const artworkUrl = readNeteaseArtworkUrl(
      albumRecord?.picUrl,
      legacyAlbumRecord?.picUrl
    );
    return {
      provider: "netease",
      providerTrackId: trackId,
      access: resolveTrackAccess(song),
      quality: resolveTrackQuality(song),
      title,
      artist: artistNames.join(" / ") || "未知歌手",
      album: albumName,
      tags: readProviderTags(song),
      ...(providerAlbumId ? { providerAlbumId } : {}),
      releaseTime: readString(songRecord?.publishTime ?? songRecord?.publish_time ?? albumRecord?.publishTime ?? legacyAlbumRecord?.publishTime),
      durationMs: readNumber(song?.duration) ?? readNumber(song?.dt) ?? 0,
      artworkUrl
    };
  }

  private toPlaylistSummary(value: unknown): ProviderPlaylistSummary | null {
    const playlist = asRecord(value);
    const id = readString(playlist?.id);
    if (!playlist || !id) return null;
    return {
      provider: "netease",
      providerPlaylistId: id,
      title: readString(playlist.name) ?? "未命名歌单",
      description: readString(playlist.description) ?? readString(playlist.desc),
      tags: readProviderTags(playlist),
      artworkUrl: readNeteaseArtworkUrl(
        playlist.coverImgUrl,
        playlist.coverImgUrlStr,
        playlist.picUrl,
        playlist.picurl,
        playlist.coverUrl,
        playlist.imgUrl,
        playlist.imgurl
      ),
      creatorName: readString(asRecord(playlist.creator)?.nickname),
      trackCount: readNumber(playlist.trackCount) ?? readNumber(playlist.trackNumber) ?? (Array.isArray(playlist.tracks) ? playlist.tracks.length : 0),
    };
  }

  private toAlbumSummary(value: unknown): ProviderAlbumSummary | null {
    const album = asRecord(value);
    const id = readString(album?.id ?? album?.albumId);
    const title = readString(album?.name ?? album?.albumName);
    if (!album || !id || !title) return null;
    const artistRecord = asRecord(album.artist);
    return {
      provider: "netease",
      providerAlbumId: id,
      title,
      artist: readString(album.artist) ?? readString(artistRecord?.name) ?? readString(album.artistName) ?? readArtistNames(album.artists),
      description: readString(album.description) ?? readString(album.briefDesc),
      artworkUrl: readNeteaseArtworkUrl(album.picUrl, album.blurPicUrl),
      releaseTime: readString(album.publishTime) ?? readString(album.company),
      trackCount: readNumber(album.size) ?? readNumber(album.trackCount) ?? 0
    };
  }

  private toArtistSummary(value: unknown): ProviderArtistSummary | null {
    const artist = asRecord(value);
    const id = readString(artist?.id);
    const name = readString(artist?.name);
    if (!artist || !id || !name) return null;
    return {
      provider: "netease",
      providerArtistId: id,
      name,
      artworkUrl: readNeteaseArtworkUrl(artist.picUrl, artist.img1v1Url),
      description: readString(artist.briefDesc) ?? readString(artist.alias)
    };
  }

  private async getSearchTrackDetails(userId: string, cookie: string, songs: unknown[]) {
    const trackIds = songs
      .map((song) => readString(asRecord(song)?.id))
      .filter((trackId): trackId is string => !!trackId && /^\d+$/.test(trackId));
    if (trackIds.length === 0) {
      return new Map<string, unknown>();
    }

    try {
      const response = await this.callProvider(userId, () =>
        this.api.getTracks({ trackIds, cookie })
      );
      const detailByTrackId = new Map<string, unknown>();
      for (const song of response.songs) {
        const trackId = readString(asRecord(song)?.id);
        if (trackId) {
          detailByTrackId.set(trackId, song);
        }
      }
      return detailByTrackId;
    } catch (error) {
      if (isNeteaseUnavailableError(error)) {
        return new Map<string, unknown>();
      }
      throw error;
    }
  }

  private assertEnabled() {
    if (process.env.NETEASE_ENABLED !== "true") {
      throw new HttpException(
        createApiErrorResponse(errorCodes.neteaseDisabled, "NetEase integration is disabled."),
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }
  }

  private assertRateLimit(key: string, limit: number, windowMs: number) {
    this.rateLimiter.assert(key, limit, windowMs);
  }

  private unavailableError() {
    return new HttpException(
      createApiErrorResponse(
        errorCodes.neteaseUnavailable,
        "NetEase is temporarily unavailable."
      ),
      HttpStatus.BAD_GATEWAY
    );
  }

  private async callProvider<T>(userId: string | undefined, operation: () => Promise<T>) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof NeteaseApiError && error.kind === "auth-expired") {
        if (userId) {
          await this.accounts.invalidate(userId).catch(() => undefined);
        }
        throw new HttpException(
          createApiErrorResponse(
            errorCodes.neteaseAuthExpired,
            "The NetEase account needs to be bound again."
          ),
          HttpStatus.CONFLICT
        );
      }
      throw this.unavailableError();
    }
  }

  private defaultQuality(): NeteaseQuality {
    return neteaseQualitySchema.safeParse(process.env.NETEASE_DEFAULT_QUALITY).success
      ? (process.env.NETEASE_DEFAULT_QUALITY as NeteaseQuality)
      : "exhigh";
  }

  private bitratesForQuality(quality: NeteaseQuality): number[] {
    if (quality === "hires" || quality === "lossless") {
      return [999_000, 320_000, 192_000, 128_000];
    }
    if (quality === "exhigh") {
      return [320_000, 192_000, 128_000];
    }
    if (quality === "high") {
      return [192_000, 128_000];
    }
    return [128_000, 192_000];
  }

  private requestTimeoutMs() {
    const value = Number(process.env.NETEASE_REQUEST_TIMEOUT_MS ?? 15_000);
    return Number.isFinite(value) ? Math.max(1_000, Math.floor(value)) : 15_000;
  }

  private maxImportBytes() {
    const value = Number(process.env.NETEASE_MAX_IMPORT_BYTES ?? 209_715_200);
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 209_715_200;
  }
}

