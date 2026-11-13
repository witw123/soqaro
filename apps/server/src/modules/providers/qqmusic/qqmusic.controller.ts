import { Controller, Delete, Get, Header, Headers, HttpException, HttpStatus, Param, Post, Query, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { createApiErrorResponse, errorCodes } from "@soqaro/shared";
import { AuthService } from "../../auth/auth.service";
import { AbuseProtectionService, type AbuseDimension } from "../../../common/security/abuse-protection.service";
import { resolveClientIp } from "../../../common/security/client-ip";
import { parseRequestBody } from "../../../common/validation/zod-validation";
import {
  qqMusicAlbumIdSchema,
  qqMusicCatalogPageQuerySchema,
  qqMusicPlaylistIdSchema,
  qqMusicQualitySchema,
  qqMusicSearchQuerySchema,
  qqMusicSearchSuggestQuerySchema,
  qqMusicTrackIdSchema
} from "./qqmusic.schemas";
import { pipeWebStreamToResponse } from "../provider-stream";
import { QqMusicService } from "./qqmusic.service";

const attemptIdSchema = z.string().uuid();

@Controller("v1/providers/qqmusic")
export class QqMusicController {
  constructor(
    private readonly service: QqMusicService,
    private readonly auth: AuthService,
    private readonly abuseProtection: AbuseProtectionService
  ) {}

  @Get("account")
  async getAccount(@Headers("x-session-token") token?: string) {
    return this.service.getAccountStatus(await this.user(token));
  }

  @Post("account/qr/start")
  async startQr(@Headers("x-session-token") token?: string) {
    return this.service.startQrLogin(await this.user(token));
  }

  @Get("account/qr/:attemptId/status")
  async qrStatus(@Param("attemptId") id: string, @Headers("x-session-token") token?: string) {
    const userId = await this.user(token);
    const parsedAttemptId = attemptIdSchema.safeParse(id);
    if (!parsedAttemptId.success) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.validationFailed, "Invalid QQ Music QR attempt id."),
        HttpStatus.BAD_REQUEST
      );
    }
    return this.service.checkQrLogin(userId, parsedAttemptId.data);
  }

  @Delete("account")
  async disconnect(@Headers("x-session-token") token?: string) {
    return this.service.disconnectAccount(await this.user(token));
  }

  @Get("search")
  async search(
    @Query() query: Record<string, unknown>,
    @Headers("x-session-token") token: string | undefined,
    @Req() request: Request
  ) {
    return this.service.searchTracks(
      await this.optionalUser(token),
      parseRequestBody(qqMusicSearchQuerySchema, query),
      resolveClientIp(request)
    );
  }

  @Get("search/suggest")
  async searchSuggest(
    @Query() query: Record<string, unknown>,
    @Headers("x-session-token") token: string | undefined,
    @Req() request: Request
  ) {
    return this.service.searchSuggestions(
      await this.optionalUser(token),
      parseRequestBody(qqMusicSearchSuggestQuerySchema, query),
      resolveClientIp(request)
    );
  }

  @Get("search/hot")
  async searchHot(
    @Headers("x-session-token") token: string | undefined,
    @Req() request: Request
  ) {
    return this.service.getSearchHot(await this.optionalUser(token), resolveClientIp(request));
  }

  @Get("tracks/:trackId")
  async track(@Param("trackId") id: string, @Headers("x-session-token") token?: string) {
    return this.service.getTrack(await this.optionalUser(token), qqMusicTrackIdSchema.parse(id));
  }

  @Get("search/playlists")
  async searchPlaylists(
    @Query() query: Record<string, unknown>,
    @Headers("x-session-token") token: string | undefined,
    @Req() request: Request
  ) {
    return this.service.searchPlaylists(
      await this.optionalUser(token),
      parseRequestBody(qqMusicSearchQuerySchema, query),
      resolveClientIp(request)
    );
  }

  @Get("search/albums")
  async searchAlbums(
    @Query() query: Record<string, unknown>,
    @Headers("x-session-token") token: string | undefined,
    @Req() request: Request
  ) {
    return this.service.searchAlbums(
      await this.optionalUser(token),
      parseRequestBody(qqMusicSearchQuerySchema, query),
      resolveClientIp(request)
    );
  }

  @Get("library")
  async library(@Headers("x-session-token") token?: string) {
    return this.service.getLibrarySnapshot(await this.user(token));
  }

  @Get("tracks/:trackId/related-playlists")
  async relatedPlaylists(
    @Param("trackId") trackId: string,
    @Headers("x-session-token") token?: string
  ) {
    const userId = await this.user(token);
    const parsedId = qqMusicTrackIdSchema.safeParse(trackId);
    if (!parsedId.success) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.validationFailed, "Invalid QQ Music track id."),
        HttpStatus.BAD_REQUEST
      );
    }
    return this.service.getRelatedPlaylists(userId, parsedId.data);
  }

  @Get("artwork")
  async artwork(
    @Query("url") rawUrl: string | undefined,
    @Headers("x-session-token") token: string | undefined,
    @Req() request: Request,
    @Res() response: Response
  ) {
    const userId = await this.optionalUser(token);
    const dimensions: AbuseDimension[] = [{ name: "ip", value: resolveClientIp(request) }];
    if (userId !== "anonymous") {
      dimensions.push({ name: "user", value: userId });
    }
    await this.abuseProtection?.enforce("qqmusic:artwork", dimensions, { limit: 120, windowMs: 10 * 60 * 1000 });
    if (!rawUrl?.trim()) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.validationFailed, "QQ Music artwork URL is required."),
        HttpStatus.BAD_REQUEST
      );
    }
    const result = await this.service.openArtwork(rawUrl);
    const upstream = result.upstream;
    response
      .status(upstream.status)
      .setHeader("Content-Type", result.mimeType)
      .setHeader("Cache-Control", "public, max-age=86400")
      .setHeader("X-Content-Type-Options", "nosniff")
      .setHeader("Content-Security-Policy", "default-src 'none'; sandbox")
      .setHeader("Content-Disposition", "inline");
    const length = upstream.headers.get("content-length") ??
      (result.contentLength ? String(result.contentLength) : null);
    if (length) response.setHeader("Content-Length", length);

    await pipeWebStreamToResponse({
      request,
      response,
      body: upstream.body,
      maxBytes: { limit: result.maxBytes, message: "QQ Music artwork exceeded the configured proxy size." }
    });
  }

  @Get("tracks/:trackId/audio-url")
  @Header("Cache-Control", "no-store")
  async audioUrl(
    @Param("trackId") id: string,
    @Query("quality") quality: string | undefined,
    @Headers("x-session-token") token?: string
  ) {
    const parsedId = qqMusicTrackIdSchema.safeParse(id);
    if (!parsedId.success) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.validationFailed, "Invalid QQ Music track id."),
        HttpStatus.BAD_REQUEST
      );
    }
    const parsedQuality = qqMusicQualitySchema.safeParse(
      quality ?? process.env.QQMUSIC_DEFAULT_QUALITY ?? "exhigh"
    );
    if (!parsedQuality.success) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.validationFailed, "Invalid QQ Music audio quality."),
        HttpStatus.BAD_REQUEST
      );
    }
    return this.service.resolveAudio(await this.user(token), parsedId.data, parsedQuality.data);
  }

  @Get("tracks/:trackId/audio")
  async audio(
    @Param("trackId") id: string,
    @Query("quality") quality: string | undefined,
    @Headers("range") range: string | undefined,
    @Headers("x-session-token") token: string | undefined,
    @Req() request: Request,
    @Res() response: Response
  ) {
    const userId = await this.user(token);
    const parsedId = qqMusicTrackIdSchema.safeParse(id);
    if (!parsedId.success) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.validationFailed, "Invalid QQ Music track id."),
        HttpStatus.BAD_REQUEST
      );
    }
    const parsedQuality = qqMusicQualitySchema.safeParse(
      quality ?? process.env.QQMUSIC_DEFAULT_QUALITY ?? "exhigh"
    );
    if (!parsedQuality.success) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.validationFailed, "Invalid QQ Music audio quality."),
        HttpStatus.BAD_REQUEST
      );
    }

    const result = await this.service.openAudio(userId, parsedId.data, parsedQuality.data, range);
    await this.streamAudio(request, response, result, parsedId.data);
  }

  @Get("tracks/:trackId/lyrics")
  async lyrics(@Param("trackId") id: string, @Headers("x-session-token") token?: string) {
    const parsed = qqMusicTrackIdSchema.safeParse(id);
    if (!parsed.success) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.validationFailed, "Invalid QQ Music track id."),
        HttpStatus.BAD_REQUEST
      );
    }
    return this.service.getLyrics(await this.optionalUser(token), parsed.data);
  }

  @Get("playlists")
  async playlists(
    @Query() query: Record<string, unknown>,
    @Headers("x-session-token") token?: string
  ) {
    return this.service.listPlaylists(
      await this.optionalUser(token),
      parseRequestBody(qqMusicCatalogPageQuerySchema, query)
    );
  }

  @Get("playlists/:playlistId")
  async playlist(@Param("playlistId") id: string, @Headers("x-session-token") token?: string) {
    const parsed = qqMusicPlaylistIdSchema.safeParse(id);
    if (!parsed.success) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.validationFailed, "Invalid QQ Music playlist id."),
        HttpStatus.BAD_REQUEST
      );
    }
    return this.service.getPlaylist(await this.optionalUser(token), parsed.data);
  }

  @Get("albums/:albumId")
  async album(@Param("albumId") id: string, @Headers("x-session-token") token?: string) {
    const parsed = qqMusicAlbumIdSchema.safeParse(id);
    if (!parsed.success) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.validationFailed, "Invalid QQ Music album id."),
        HttpStatus.BAD_REQUEST
      );
    }
    return this.service.getAlbum(await this.optionalUser(token), parsed.data);
  }

  private async streamAudio(
    request: Request,
    response: Response,
    result: Awaited<ReturnType<QqMusicService["openAudio"]>>,
    trackId: string
  ) {
    const upstream = result.upstream;
    response
      .status(upstream.status)
      .setHeader("Content-Type", result.mimeType)
      .setHeader("Cache-Control", "no-store")
      .setHeader("Accept-Ranges", "bytes")
      .setHeader(
        "Content-Disposition",
        `attachment; filename="qqmusic-${trackId}.${result.fileType}"`
      );
    const length = upstream.headers.get("content-length") ??
      (result.contentLength ? String(result.contentLength) : null);
    if (length) response.setHeader("Content-Length", length);
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) response.setHeader("Content-Range", contentRange);

    await pipeWebStreamToResponse({
      request,
      response,
      body: upstream.body,
      maxBytes: { limit: result.maxBytes, message: "QQ Music audio exceeded the configured import size." }
    });
  }

  private async optionalUser(token?: string): Promise<string> {
    if (!token) return "anonymous";
    try {
      return (await this.auth.getAuthSessionByTokenOrThrow(token)).userId;
    } catch {
      return "anonymous";
    }
  }

  private async user(token?: string) {
    try {
      return (await this.auth.getAuthSessionByTokenOrThrow(token)).userId;
    } catch (error) {
      throw new UnauthorizedException(error instanceof Error ? error.message : "Unauthorized.");
    }
  }
}
