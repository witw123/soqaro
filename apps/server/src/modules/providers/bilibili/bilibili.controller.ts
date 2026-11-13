import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Optional,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException
} from "@nestjs/common";
import type { Request, Response } from "express";
import { AbuseProtectionService } from "../../../common/security/abuse-protection.service";
import { resolveClientIp } from "../../../common/security/client-ip";
import { parseRequestBody } from "../../../common/validation/zod-validation";
import { AuthService } from "../../auth/auth.service";
import {
  bilibiliBvidSchema,
  bilibiliImportFavoriteBodySchema,
  bilibiliImportFavoriteQuerySchema,
  bilibiliRankingQuerySchema,
  bilibiliResolveAudioQuerySchema,
  bilibiliSearchQuerySchema
} from "./bilibili.schemas";
import { pipeWebStreamToResponse } from "../provider-stream";
import { BilibiliService } from "./bilibili.service";

const BILIBILI_STREAM_MAX_BYTES = Number(process.env.BILIBILI_MAX_STREAM_BYTES ?? 209_715_200);
const BYTE_RANGE_HEADER_PATTERN = /^bytes=(\d+-\d*|\d*-\d+)$/i;

@Controller("v1/providers/bilibili")
export class BilibiliController {
  constructor(
    private readonly service: BilibiliService,
    private readonly auth: AuthService,
    @Optional() private readonly abuseProtection?: AbuseProtectionService
  ) {}

  @Get("search")
  async search(
    @Query() query: Record<string, unknown>,
    @Headers("x-session-token") token: string | undefined,
    @Req() request: Request
  ) {
    await this.enforcePublicRateLimit("bilibili:search", request, token, 60, 5 * 60 * 1000);
    const payload = parseRequestBody(bilibiliSearchQuerySchema, query);
    return this.service.search(payload.keyword, payload.page, payload.pageSize, payload.tid);
  }

  @Get("ranking")
  async getRanking(
    @Query() query: Record<string, unknown>,
    @Headers("x-session-token") token: string | undefined,
    @Req() request: Request
  ) {
    await this.enforcePublicRateLimit("bilibili:ranking", request, token, 60, 5 * 60 * 1000);
    const payload = parseRequestBody(bilibiliRankingQuerySchema, query);
    return this.service.getRanking(payload.subType);
  }

  @Post("favorites/import")
  async importFavorite(
    @Headers("x-session-token") token: string | undefined,
    @Req() request: Request,
    @Body() body: Record<string, unknown>,
    @Query() query: Record<string, unknown>
  ) {
    const userId = await this.requireUser(token);
    await this.abuseProtection?.enforce(
      "bilibili:favorites:import",
      [
        { name: "ip", value: resolveClientIp(request) },
        { name: "user", value: userId }
      ],
      { limit: 20, windowMs: 5 * 60 * 1000 }
    );
    const payload = parseRequestBody(bilibiliImportFavoriteBodySchema, body);
    const pagination = parseRequestBody(bilibiliImportFavoriteQuerySchema, query);
    return this.service.importFavorite(payload.url, pagination.page, pagination.pageSize);
  }

  @Get("view/:bvid")
  async getView(
    @Param("bvid") bvid: string,
    @Headers("x-session-token") token: string | undefined,
    @Req() request: Request
  ) {
    await this.enforcePublicRateLimit("bilibili:view", request, token, 90, 5 * 60 * 1000);
    const parsedBvid = bilibiliBvidSchema.safeParse(bvid);
    if (!parsedBvid.success) {
      throw new HttpException("无效的 B 站视频 ID", HttpStatus.BAD_REQUEST);
    }
    return this.service.getVideoDetail(parsedBvid.data);
  }

  @Get("view/:bvid/parts")
  async getVideoParts(
    @Param("bvid") bvid: string,
    @Headers("x-session-token") token: string | undefined,
    @Req() request: Request
  ) {
    await this.enforcePublicRateLimit("bilibili:view-parts", request, token, 90, 5 * 60 * 1000);
    const parsedBvid = bilibiliBvidSchema.safeParse(bvid);
    if (!parsedBvid.success) {
      throw new HttpException("无效的 B 站视频 ID", HttpStatus.BAD_REQUEST);
    }
    return this.service.getVideoParts(parsedBvid.data);
  }

  @Get("tracks/:trackId")
  async getTrack(
    @Param("trackId") trackId: string,
    @Query("cid") cidQuery: string | undefined,
    @Headers("x-session-token") token: string | undefined,
    @Req() request: Request
  ) {
    await this.enforcePublicRateLimit("bilibili:track", request, token, 90, 5 * 60 * 1000);
    const { bvid, cid } = this.parseTrackId(trackId, cidQuery);
    return this.service.resolveTrack(bvid, cid);
  }

  @Get("tracks/:trackId/lyrics")
  async getLyrics(
    @Param("trackId") trackId: string,
    @Query("cid") cidQuery: string | undefined,
    @Headers("x-session-token") token: string | undefined,
    @Req() request: Request
  ) {
    await this.enforcePublicRateLimit("bilibili:lyrics", request, token, 90, 5 * 60 * 1000);
    const { bvid, cid } = this.parseTrackId(trackId, cidQuery);
    return this.service.getLyrics(bvid, cid);
  }

  @Get("tracks/:trackId/audio-url")
  async getAudioUrl(
    @Param("trackId") trackId: string,
    @Query() query: Record<string, unknown>,
    @Headers("x-session-token") token: string | undefined,
    @Req() request: Request
  ) {
    const userId = await this.requireUser(token);
    await this.abuseProtection?.enforce(
      "bilibili:audio-url",
      [
        { name: "ip", value: resolveClientIp(request) },
        { name: "user", value: userId }
      ],
      { limit: 90, windowMs: 10 * 60 * 1000 }
    );
    const payload = parseRequestBody(bilibiliResolveAudioQuerySchema, query);
    const { bvid, cid } = this.parseTrackId(trackId, payload.cid?.toString());
    return this.service.resolveAudio(bvid, cid, payload.quality);
  }

  @Get("tracks/:trackId/audio")
  async getAudioStream(
    @Param("trackId") trackId: string,
    @Query() query: Record<string, unknown>,
    @Headers("x-session-token") token: string | undefined,
    @Headers("range") range: string | undefined,
    @Req() req: Request,
    @Res() res: Response
  ) {
    const userId = await this.requireUser(token);
    await this.abuseProtection?.enforce(
      "bilibili:audio",
      [
        { name: "ip", value: resolveClientIp(req) },
        { name: "user", value: userId }
      ],
      { limit: 90, windowMs: 10 * 60 * 1000 }
    );
    const payload = parseRequestBody(bilibiliResolveAudioQuerySchema, query);
    const { bvid, cid } = this.parseTrackId(trackId, payload.cid?.toString());

    const normalizedRange = range?.trim();
    if (normalizedRange && !BYTE_RANGE_HEADER_PATTERN.test(normalizedRange)) {
      throw new HttpException("Range 请求头格式无效", HttpStatus.BAD_REQUEST);
    }

    let streamResult;
    try {
      streamResult = await this.service.openAudioStream(
        bvid,
        cid,
        payload.quality,
        normalizedRange
      );
    } catch (error) {
      throw new HttpException(
        error instanceof Error ? error.message : "获取 B 站音频流失败",
        HttpStatus.BAD_GATEWAY
      );
    }

    if (streamResult.status !== 200 && streamResult.status !== 206) {
      await streamResult.body?.cancel().catch(() => {});
      throw new HttpException(
        `B 站音频流上游返回异常状态 (${streamResult.status})`,
        HttpStatus.BAD_GATEWAY
      );
    }

    // 设置响应状态码（200 或 206）
    res.status(streamResult.status);

    // 标准流媒体响应头
    res.setHeader("Content-Type", "audio/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (streamResult.headers["content-length"]) {
      res.setHeader("Content-Length", streamResult.headers["content-length"]);
    }
    if (streamResult.headers["content-range"]) {
      res.setHeader("Content-Range", streamResult.headers["content-range"]);
    }

    // 将 Fetch ReadableStream 桥接到 Node.js Response
    await pipeWebStreamToResponse({
      request: req,
      response: res,
      body: streamResult.body,
      maxBytes: { limit: BILIBILI_STREAM_MAX_BYTES, message: "Bilibili audio stream exceeded the configured proxy size." },
      onError: (error) => {
        if (!res.headersSent) {
          res.status(502).end();
        } else if (!res.destroyed) {
          res.destroy(error instanceof Error ? error : undefined);
        }
      }
    });
  }

  private async enforcePublicRateLimit(
    scope: string,
    request: Request,
    token: string | undefined,
    limit: number,
    windowMs: number
  ) {
    const userId = await this.optionalUser(token);
    const dimensions = [{ name: "ip", value: resolveClientIp(request) }];
    if (userId) {
      dimensions.push({ name: "user", value: userId });
    }
    await this.abuseProtection?.enforce(scope, dimensions, { limit, windowMs });
  }

  private async optionalUser(token?: string): Promise<string | undefined> {
    if (!token) return undefined;
    try {
      return (await this.auth.getAuthSessionByTokenOrThrow(token)).userId;
    } catch {
      return undefined;
    }
  }

  private async requireUser(token?: string): Promise<string> {
    try {
      return (await this.auth.getAuthSessionByTokenOrThrow(token)).userId;
    } catch (error) {
      throw new UnauthorizedException(error instanceof Error ? error.message : "Unauthorized.");
    }
  }

  private parseTrackId(trackId: string, fallbackCid?: string): { bvid: string; cid?: number } {
    const colonIndex = trackId.indexOf(":");
    const rawBvid = colonIndex > 0 ? trackId.slice(0, colonIndex) : trackId;
    const rawCid = colonIndex > 0 ? trackId.slice(colonIndex + 1) : fallbackCid;

    const parsedBvid = bilibiliBvidSchema.safeParse(rawBvid);
    if (!parsedBvid.success) {
      throw new HttpException("无效的 B 站视频 ID", HttpStatus.BAD_REQUEST);
    }

    if (rawCid === undefined || rawCid === "") {
      return { bvid: parsedBvid.data };
    }

    if (!/^\d+$/.test(rawCid)) {
      throw new HttpException("无效的 B 站分 P CID", HttpStatus.BAD_REQUEST);
    }
    const cidNum = Number(rawCid);
    if (!Number.isSafeInteger(cidNum) || cidNum <= 0) {
      throw new HttpException("无效的 B 站分 P CID", HttpStatus.BAD_REQUEST);
    }
    return { bvid: parsedBvid.data, cid: cidNum };
  }
}
