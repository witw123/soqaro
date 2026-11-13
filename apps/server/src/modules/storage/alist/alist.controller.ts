import {
  Body,
  Controller,
  Get,
  Headers,
  Optional,
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
import { pipeWebStreamToResponse } from "../../providers/provider-stream";
import {
  alistGetFileBodySchema,
  alistListDirectoryBodySchema,
  alistStreamQuerySchema,
  alistTestConfigBodySchema
} from "./alist.schemas";
import { AlistService } from "./alist.service";

@Controller("v1/storage/alist")
export class AlistController {
  constructor(
    private readonly service: AlistService,
    private readonly auth: AuthService,
    @Optional() private readonly abuseProtection?: AbuseProtectionService
  ) {}

  @Post("test")
  async testConnection(
    @Headers("x-session-token") sessionToken: string | undefined,
    @Req() request: Request,
    @Body() body: Record<string, unknown>
  ) {
    const userId = await this.requireUser(sessionToken);
    await this.abuseProtection?.enforce(
      "storage:alist:test",
      [
        { name: "ip", value: resolveClientIp(request) },
        { name: "user", value: userId }
      ],
      { limit: 20, windowMs: 5 * 60 * 1000 }
    );
    const payload = parseRequestBody(alistTestConfigBodySchema, body);
    return this.service.testConnection(payload.url, payload.mountPath, payload.token);
  }

  @Post("list")
  async listDirectory(
    @Headers("x-session-token") sessionToken: string | undefined,
    @Req() request: Request,
    @Body() body: Record<string, unknown>
  ) {
    const userId = await this.requireUser(sessionToken);
    await this.abuseProtection?.enforce(
      "storage:alist:list",
      [
        { name: "ip", value: resolveClientIp(request) },
        { name: "user", value: userId }
      ],
      { limit: 120, windowMs: 5 * 60 * 1000 }
    );
    const payload = parseRequestBody(alistListDirectoryBodySchema, body);
    return this.service.listDirectory(
      payload.url,
      payload.path,
      payload.page,
      payload.perPage,
      payload.refresh,
      payload.token
    );
  }

  @Post("file")
  async getFile(
    @Headers("x-session-token") sessionToken: string | undefined,
    @Req() request: Request,
    @Body() body: Record<string, unknown>
  ) {
    const userId = await this.requireUser(sessionToken);
    await this.abuseProtection?.enforce(
      "storage:alist:file",
      [
        { name: "ip", value: resolveClientIp(request) },
        { name: "user", value: userId }
      ],
      { limit: 120, windowMs: 5 * 60 * 1000 }
    );
    const payload = parseRequestBody(alistGetFileBodySchema, body);
    return this.service.getFileDetail(payload.url, payload.path, payload.token);
  }

  @Get("stream")
  async streamAudio(
    @Headers("x-session-token") sessionToken: string | undefined,
    @Query() query: Record<string, unknown>,
    @Headers("range") range: string | undefined,
    @Req() req: Request,
    @Res() res: Response
  ) {
    const userId = await this.requireUser(sessionToken);
    await this.abuseProtection?.enforce(
      "storage:alist:stream",
      [
        { name: "ip", value: resolveClientIp(req) },
        { name: "user", value: userId }
      ],
      { limit: 180, windowMs: 10 * 60 * 1000 }
    );
    const payload = parseRequestBody(alistStreamQuerySchema, query);
    const streamResult = await this.service.fetchAudioStream(payload.url, range);

    res
      .status(streamResult.status)
      .setHeader("Content-Type", streamResult.mimeType)
      .setHeader("X-Content-Type-Options", "nosniff")
      .setHeader("Content-Security-Policy", "default-src 'none'; sandbox")
      .setHeader("Content-Disposition", "attachment")
      .setHeader("Cache-Control", "no-store");

    for (const [key, value] of Object.entries(streamResult.headers)) {
      if (
        key === "content-range" ||
        key === "content-length" ||
        key === "accept-ranges"
      ) {
        res.setHeader(key, value);
      }
    }

    await pipeWebStreamToResponse({
      request: req,
      response: res,
      body: streamResult.body,
      maxBytes: {
        limit: streamResult.maxBytes,
        message: "Alist audio stream exceeded the configured size limit."
      }
    });
  }

  private async requireUser(token?: string): Promise<string> {
    try {
      return (await this.auth.getAuthSessionByTokenOrThrow(token)).userId;
    } catch (error) {
      throw new UnauthorizedException(error instanceof Error ? error.message : "Unauthorized.");
    }
  }
}
