import { HttpException } from "@nestjs/common";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import type { AbuseProtectionService } from "../../../common/security/abuse-protection.service";
import type { AuthService } from "../../auth/auth.service";
import * as providerStream from "../provider-stream";
import { QqMusicController } from "./qqmusic.controller";
import { resolveArtworkMime } from "./qqmusic.mappers";
import type { QqMusicService } from "./qqmusic.service";

function createRequest(ip = "203.0.113.55"): Request {
  const req = new EventEmitter() as unknown as Request & {
    ip: string;
    headers: Record<string, string>;
    socket: { remoteAddress: string };
  };
  req.ip = ip;
  req.headers = {};
  req.socket = { remoteAddress: ip } as never;
  return req;
}

function createResponse() {
  const headers: Record<string, string> = {};
  const res = new EventEmitter() as unknown as Response & { statusCode: number };
  res.statusCode = 200;
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as never;
  res.setHeader = jest.fn((name: string, value: string | string[]) => {
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(",") : String(value);
    return res;
  }) as never;
  return { res, headers };
}

describe("QQ Music artwork and controller protections", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("blocks active SVG image MIME types in resolveArtworkMime", () => {
    expect(resolveArtworkMime("image/svg+xml")).toBeNull();
    expect(resolveArtworkMime("image/svg+xml; charset=utf-8")).toBeNull();
    expect(resolveArtworkMime("image/jpeg; charset=binary")).toBe("image/jpeg");
    expect(resolveArtworkMime("image/webp")).toBe("image/webp");
  });

  it("sets sandbox CSP on artwork and keys anonymous abuse limit by IP only", async () => {
    jest.spyOn(providerStream, "pipeWebStreamToResponse").mockResolvedValue(undefined);
    const service = {
      openArtwork: jest.fn().mockResolvedValue({
        upstream: new Response("img", { status: 200 }),
        mimeType: "image/jpeg",
        contentLength: 3,
        maxBytes: 1024
      }),
      checkQrLogin: jest.fn(),
      getRelatedPlaylists: jest.fn()
    } as unknown as QqMusicService;

    const auth = {
      getAuthSessionByTokenOrThrow: jest.fn(async (token?: string) => {
        if (token === "valid") return { userId: "user-1" };
        throw new Error("Unauthorized");
      })
    } as unknown as AuthService;

    const abuseProtection = {
      enforce: jest.fn().mockResolvedValue(undefined)
    } as unknown as AbuseProtectionService;

    const controller = new QqMusicController(service, auth, abuseProtection);
    const { res, headers } = createResponse();

    await controller.artwork(
      "https://y.gtimg.cn/music/photo_new/test.jpg",
      undefined,
      createRequest("198.51.100.20"),
      res
    );

    expect(abuseProtection.enforce).toHaveBeenCalledWith(
      "qqmusic:artwork",
      [{ name: "ip", value: "198.51.100.20" }],
      expect.any(Object)
    );
    expect(headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(headers["content-disposition"]).toBe("inline");
    expect(headers["x-content-type-options"]).toBe("nosniff");

    await expect(controller.qrStatus("not-a-uuid", "valid")).rejects.toThrow(HttpException);
    await expect(controller.relatedPlaylists("bad/../id", "valid")).rejects.toThrow(HttpException);
  });
});
