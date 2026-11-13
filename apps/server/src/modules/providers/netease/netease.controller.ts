import {
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { createApiErrorResponse, errorCodes } from "@soqaro/shared";
import { resolveClientIp } from "../../../common/security/client-ip";
import { AuthService } from "../../auth/auth.service";
import { parseRequestBody } from "../../../common/validation/zod-validation";
import {
  neteaseQualitySchema,
  neteaseAlbumIdSchema,
  neteaseCatalogPageQuerySchema,
  neteasePlaylistIdSchema,
  neteaseSearchQuerySchema,
  neteaseSearchSuggestQuerySchema,
  neteaseTrackIdSchema
} from "./netease.schemas";
import { pipeWebStreamToResponse } from "../provider-stream";
import { NeteaseService } from "./netease.service";

const attemptIdSchema = z.string().uuid();

@Controller("v1/providers/netease")
export class NeteaseController {
  constructor(
    private readonly service: NeteaseService,
    private readonly auth: AuthService
  ) {}

  @Get("account")
  async getAccount(@Headers("x-session-token") sessionToken: string | undefined) {
    return this.service.getAccountStatus(await this.getCurrentUserId(sessionToken));
  }

  @Post("account/qr/start")
  async startQr(@Headers("x-session-token") sessionToken: string | undefined) {
    return this.service.startQrLogin(await this.getCurrentUserId(sessionToken));
  }

  @Get("account/qr/:attemptId/status")
  async getQrStatus(
    @Param("attemptId") attemptId: string,
    @Headers("x-session-token") sessionToken: string | undefined
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    const parsedAttemptId = attemptIdSchema.safeParse(attemptId);
    if (!parsedAttemptId.success) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.validationFailed, "Invalid NetEase QR attempt id."),
        HttpStatus.BAD_REQUEST
      );
    }
    return this.service.checkQrLogin(userId, parsedAttemptId.data);
  }

  @Delete("account")
  async disconnect(@Headers("x-session-token") sessionToken: string | undefined) {
    return this.service.disconnectAccount(await this.getCurrentUserId(sessionToken));
  }

  @Get("search")
  async search(
    @Query() query: Record<string, unknown>,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Req() request: Request
  ) {
    const userId = await this.getOptionalUserId(sessionToken);
    const payload = parseRequestBody(neteaseSearchQuerySchema, query);
    return this.service.searchTracks(userId, payload, resolveClientIp(request));
  }

  @Get("search/suggest")
  async searchSuggest(
    @Query() query: Record<string, unknown>,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Req() request: Request
  ) {
    return this.service.searchSuggestions(
      await this.getOptionalUserId(sessionToken),
      parseRequestBody(neteaseSearchSuggestQuerySchema, query),
      resolveClientIp(request)
    );
  }

  @Get("search/hot")
  async searchHot(
    @Headers("x-session-token") sessionToken: string | undefined,
    @Req() request: Request
  ) {
    return this.service.getSearchHot(
      await this.getOptionalUserId(sessionToken),
      resolveClientIp(request)
    );
  }

  @Get("tracks/:trackId")
  async getTrack(
    @Param("trackId") trackId: string,
    @Headers("x-session-token") sessionToken: string | undefined
  ) {
    const userId = await this.getOptionalUserId(sessionToken);
    return this.service.getTrack(userId, neteaseTrackIdSchema.parse(trackId));
  }

  @Get("search/playlists")
  async searchPlaylists(
    @Query() query: Record<string, unknown>,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Req() request: Request
  ) {
    return this.service.searchPlaylists(
      await this.getOptionalUserId(sessionToken),
      parseRequestBody(neteaseSearchQuerySchema, query),
      resolveClientIp(request)
    );
  }

  @Get("search/albums")
  async searchAlbums(
    @Query() query: Record<string, unknown>,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Req() request: Request
  ) {
    return this.service.searchAlbums(
      await this.getOptionalUserId(sessionToken),
      parseRequestBody(neteaseSearchQuerySchema, query),
      resolveClientIp(request)
    );
  }

  @Get("library")
  async library(@Headers("x-session-token") sessionToken: string | undefined) {
    return this.service.getLibrarySnapshot(await this.getCurrentUserId(sessionToken));
  }

  @Get("tracks/:trackId/related-playlists")
  async relatedPlaylists(
    @Param("trackId") trackId: string,
    @Headers("x-session-token") sessionToken: string | undefined
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    const parsedTrackId = neteaseTrackIdSchema.safeParse(trackId);
    if (!parsedTrackId.success) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.validationFailed, "Invalid NetEase track id."),
        HttpStatus.BAD_REQUEST
      );
    }
    return this.service.getRelatedPlaylists(userId, parsedTrackId.data);
  }

  @Get("tracks/:trackId/audio-url")
  @Header("Cache-Control", "no-store")
  async audioUrl(
    @Param("trackId") trackId: string,
    @Query("quality") quality: string | undefined,
    @Headers("x-session-token") sessionToken: string | undefined
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    const parsedTrackId = neteaseTrackIdSchema.safeParse(trackId);
    if (!parsedTrackId.success) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.validationFailed, "Invalid NetEase track id."),
        HttpStatus.BAD_REQUEST
      );
    }
    const parsedQuality = neteaseQualitySchema.safeParse(
      quality ?? process.env.NETEASE_DEFAULT_QUALITY ?? "exhigh"
    );
    if (!parsedQuality.success) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.validationFailed, "Invalid NetEase audio quality."),
        HttpStatus.BAD_REQUEST
      );
    }
    return this.service.resolveAudio(userId, parsedTrackId.data, parsedQuality.data);
  }

  @Get("tracks/:trackId/audio")
  async audio(
    @Param("trackId") trackId: string,
    @Query("quality") quality: string | undefined,
    @Headers("range") range: string | undefined,
    @Headers("x-session-token") sessionToken: string | undefined,
    @Req() request: Request,
    @Res() response: Response
  ) {
    const userId = await this.getCurrentUserId(sessionToken);
    const parsedTrackId = neteaseTrackIdSchema.safeParse(trackId);
    if (!parsedTrackId.success) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.validationFailed, "Invalid NetEase track id."),
        HttpStatus.BAD_REQUEST
      );
    }
    const parsedQuality = neteaseQualitySchema.safeParse(
      quality ?? process.env.NETEASE_DEFAULT_QUALITY ?? "exhigh"
    );
    if (!parsedQuality.success) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.validationFailed, "Invalid NetEase audio quality."),
        HttpStatus.BAD_REQUEST
      );
    }

    const result = await this.service.openAudio(userId, parsedTrackId.data, parsedQuality.data, range);
    return this.streamAudio(request, response, result, parsedTrackId.data);
  }

  private async streamAudio(
    request: Request,
    response: Response,
    result: Awaited<ReturnType<NeteaseService["openAudio"]>>,
    trackId: string
  ) {
    const upstream = result.upstream;
    response.status(upstream.status);
    response.setHeader("Content-Type", result.mimeType);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="netease-${trackId}.${result.fileType}"`
    );
    const contentLength = upstream.headers.get("content-length") ??
      (result.contentLength ? String(result.contentLength) : null);
    if (contentLength) response.setHeader("Content-Length", contentLength);
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) response.setHeader("Content-Range", contentRange);

    await pipeWebStreamToResponse({
      request,
      response,
      body: upstream.body,
      maxBytes: { limit: result.maxBytes, message: "NetEase audio exceeded the configured import size." }
    });
  }

  @Get("tracks/:trackId/lyrics")
  async lyrics(
    @Param("trackId") trackId: string,
    @Headers("x-session-token") sessionToken: string | undefined
  ) {
    const userId = await this.getOptionalUserId(sessionToken);
    const parsed = neteaseTrackIdSchema.safeParse(trackId);
    if (!parsed.success) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.validationFailed, "Invalid NetEase track id."),
        HttpStatus.BAD_REQUEST
      );
    }
    return this.service.getLyrics(userId, parsed.data);
  }

  @Get("playlists")
  async playlists(
    @Query() query: Record<string, unknown>,
    @Headers("x-session-token") sessionToken: string | undefined
  ) {
    return this.service.listPlaylists(
      await this.getOptionalUserId(sessionToken),
      parseRequestBody(neteaseCatalogPageQuerySchema, query)
    );
  }

  @Get("playlists/:playlistId")
  async playlist(
    @Param("playlistId") playlistId: string,
    @Headers("x-session-token") sessionToken: string | undefined
  ) {
    const parsed = neteasePlaylistIdSchema.safeParse(playlistId);
    if (!parsed.success) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.validationFailed, "Invalid NetEase playlist id."),
        HttpStatus.BAD_REQUEST
      );
    }
    return this.service.getPlaylist(await this.getOptionalUserId(sessionToken), parsed.data);
  }

  @Get("albums/:albumId")
  async album(
    @Param("albumId") albumId: string,
    @Headers("x-session-token") sessionToken: string | undefined
  ) {
    const parsed = neteaseAlbumIdSchema.safeParse(albumId);
    if (!parsed.success) {
      throw new HttpException(
        createApiErrorResponse(errorCodes.validationFailed, "Invalid NetEase album id."),
        HttpStatus.BAD_REQUEST
      );
    }
    return this.service.getAlbum(await this.getOptionalUserId(sessionToken), parsed.data);
  }

  private async getOptionalUserId(sessionToken?: string): Promise<string> {
    if (!sessionToken) return "anonymous";
    try {
      const session = await this.auth.getAuthSessionByTokenOrThrow(sessionToken);
      return session.userId;
    } catch {
      return "anonymous";
    }
  }

  private async getCurrentUserId(sessionToken?: string) {
    try {
      const session = await this.auth.getAuthSessionByTokenOrThrow(sessionToken);
      return session.userId;
    } catch (error) {
      throw new UnauthorizedException(error instanceof Error ? error.message : "Unauthorized.");
    }
  }
}
