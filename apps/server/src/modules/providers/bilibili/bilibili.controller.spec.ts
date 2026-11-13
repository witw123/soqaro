import { HttpException, UnauthorizedException } from "@nestjs/common";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import type { AbuseProtectionService } from "../../../common/security/abuse-protection.service";
import type { AuthService } from "../../auth/auth.service";
import * as providerStream from "../provider-stream";
import { BilibiliController } from "./bilibili.controller";
import type { BilibiliService } from "./bilibili.service";

function createRequest(ip = "198.51.100.7"): Request {
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
  const res = new EventEmitter() as unknown as Response & {
    statusCode: number;
  };
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

describe("BilibiliController", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createController() {
    const service = {
      search: jest.fn().mockResolvedValue({ items: [] }),
      getRanking: jest.fn().mockResolvedValue({ items: [] }),
      importFavorite: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      getVideoDetail: jest.fn().mockResolvedValue({ bvid: "BV1xx411c7mD" }),
      getVideoParts: jest.fn().mockResolvedValue([]),
      resolveTrack: jest.fn().mockResolvedValue({}),
      getLyrics: jest.fn().mockResolvedValue({ lines: [] }),
      resolveAudio: jest.fn().mockResolvedValue({ url: "https://cdn.bilivideo.com/a.m4s" }),
      openAudioStream: jest.fn().mockResolvedValue({
        status: 200,
        headers: { "content-length": "123" },
        body: null
      })
    } as unknown as BilibiliService;

    const auth = {
      getAuthSessionByTokenOrThrow: jest.fn(async (token?: string) => {
        if (token === "valid-token") return { userId: "user-42" };
        throw new Error("Unauthorized.");
      })
    } as unknown as AuthService;

    const abuseProtection = {
      enforce: jest.fn().mockResolvedValue(undefined)
    } as unknown as AbuseProtectionService;

    return {
      controller: new BilibiliController(service, auth, abuseProtection),
      service,
      abuseProtection
    };
  }

  it("requires authentication on favorite import, audio-url, and audio proxy", async () => {
    const { controller } = createController();
    const { res } = createResponse();

    await expect(
      controller.importFavorite(undefined, createRequest(), { url: "123456" }, {})
    ).rejects.toThrow(UnauthorizedException);

    await expect(
      controller.getAudioUrl("BV1xx411c7mD", {}, undefined, createRequest())
    ).rejects.toThrow(UnauthorizedException);

    await expect(
      controller.getAudioStream("BV1xx411c7mD", {}, undefined, undefined, createRequest(), res)
    ).rejects.toThrow(UnauthorizedException);
  });

  it("validates trackId bvid/cid and favorite pagination bounds", async () => {
    const { controller } = createController();

    await expect(
      controller.getTrack("../../etc/passwd", undefined, undefined, createRequest())
    ).rejects.toThrow(HttpException);

    await expect(
      controller.getTrack("BV1xx411c7mD:notanumber", undefined, undefined, createRequest())
    ).rejects.toThrow(HttpException);

    await expect(
      controller.importFavorite("valid-token", createRequest(), { url: "123456" }, { pageSize: "999" })
    ).rejects.toThrow(HttpException);
  });

  it("enforces IP rate limits without an anonymous user bucket on public routes", async () => {
    const { controller, abuseProtection } = createController();
    await controller.search({ keyword: "test" }, undefined, createRequest("203.0.113.99"));

    expect(abuseProtection.enforce).toHaveBeenCalledWith(
      "bilibili:search",
      [{ name: "ip", value: "203.0.113.99" }],
      expect.any(Object)
    );
  });

  it("omits wildcard CORS and sets nosniff on authenticated audio stream", async () => {
    jest.spyOn(providerStream, "pipeWebStreamToResponse").mockResolvedValue(undefined);
    const { controller } = createController();
    const { res, headers } = createResponse();

    await controller.getAudioStream(
      "BV1xx411c7mD",
      {},
      "valid-token",
      "bytes=0-100",
      createRequest(),
      res
    );

    expect(headers["access-control-allow-origin"]).toBeUndefined();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-type"]).toBe("audio/mp4");
  });
});
