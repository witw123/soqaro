import { UnauthorizedException } from "@nestjs/common";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import type { AbuseProtectionService } from "../../../common/security/abuse-protection.service";
import type { AuthService } from "../../auth/auth.service";
import * as providerStream from "../../providers/provider-stream";
import { AlistController } from "./alist.controller";
import type { AlistService } from "./alist.service";

function createRequest(ip = "203.0.113.10"): Request {
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

describe("AlistController", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createController() {
    const service = {
      testConnection: jest.fn().mockResolvedValue({ ok: true, message: "ok" }),
      listDirectory: jest.fn().mockResolvedValue({ total: 0, items: [], directories: [], currentPath: "/" }),
      getFileDetail: jest.fn().mockResolvedValue({ rawUrl: "https://cdn.example.com/a.mp3", size: 1, name: "a.mp3" }),
      fetchAudioStream: jest.fn().mockResolvedValue({
        status: 200,
        mimeType: "audio/mpeg",
        maxBytes: 1024,
        headers: { "content-length": "10" },
        body: null
      })
    } as unknown as AlistService;

    const auth = {
      getAuthSessionByTokenOrThrow: jest.fn(async (token?: string) => {
        if (token === "valid-token") return { userId: "user-1" };
        throw new Error("Unauthorized.");
      })
    } as unknown as AuthService;

    const abuseProtection = {
      enforce: jest.fn().mockResolvedValue(undefined)
    } as unknown as AbuseProtectionService;

    const controller = new AlistController(service, auth, abuseProtection);
    return { controller, service, abuseProtection };
  }

  it("requires authentication on all AList endpoints", async () => {
    const { controller } = createController();
    const { res } = createResponse();

    await expect(
      controller.testConnection(undefined, createRequest(), { url: "https://alist.example.com" })
    ).rejects.toThrow(UnauthorizedException);

    await expect(
      controller.listDirectory(undefined, createRequest(), { url: "https://alist.example.com" })
    ).rejects.toThrow(UnauthorizedException);

    await expect(
      controller.getFile(undefined, createRequest(), { url: "https://alist.example.com", path: "/a.mp3" })
    ).rejects.toThrow(UnauthorizedException);

    await expect(
      controller.streamAudio(undefined, { url: "https://alist.example.com/a.mp3" }, undefined, createRequest(), res)
    ).rejects.toThrow(UnauthorizedException);
  });

  it("sets hardened headers, omits wildcard CORS, and passes maxBytes on authenticated stream", async () => {
    const pipeSpy = jest.spyOn(providerStream, "pipeWebStreamToResponse").mockResolvedValue(undefined);
    const { controller, abuseProtection } = createController();
    const { res, headers } = createResponse();

    await controller.streamAudio(
      "valid-token",
      { url: "https://cdn.example.com/song.mp3" },
      "bytes=0-10",
      createRequest(),
      res
    );

    expect(abuseProtection.enforce).toHaveBeenCalledWith(
      "storage:alist:stream",
      [
        { name: "ip", value: "203.0.113.10" },
        { name: "user", value: "user-1" }
      ],
      expect.any(Object)
    );
    expect(headers["content-type"]).toBe("audio/mpeg");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(headers["content-disposition"]).toBe("attachment");
    expect(headers["cache-control"]).toBe("no-store");
    expect(headers["access-control-allow-origin"]).toBeUndefined();
    expect(pipeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        maxBytes: expect.objectContaining({ limit: 1024 })
      })
    );
  });
});
