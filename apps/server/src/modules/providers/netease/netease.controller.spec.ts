import { HttpException } from "@nestjs/common";
import { EventEmitter } from "node:events";
import type { Request } from "express";
import type { AuthService } from "../../auth/auth.service";
import { NeteaseController } from "./netease.controller";
import type { NeteaseService } from "./netease.service";
import { NeteaseService as RealNeteaseService } from "./netease.service";

function createRequest(ip: string): Request {
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

describe("NeteaseController protections", () => {
  const previousEnabled = process.env.NETEASE_ENABLED;

  afterEach(() => {
    if (previousEnabled === undefined) {
      delete process.env.NETEASE_ENABLED;
    } else {
      process.env.NETEASE_ENABLED = previousEnabled;
    }
  });

  it("isolates anonymous search rate limits by client IP instead of a shared bucket", async () => {
    process.env.NETEASE_ENABLED = "true";
    const api = {
      getSearchHot: jest.fn().mockResolvedValue({ result: { hots: [{ first: "test" }] } })
    };
    const accounts = { getCookieOrThrow: jest.fn() };
    const redis = { isAvailable: () => false };
    const service = new RealNeteaseService(api as never, accounts as never, redis as never);
    const auth = {
      getAuthSessionByTokenOrThrow: jest.fn()
    } as unknown as AuthService;
    const controller = new NeteaseController(service, auth);

    for (let i = 0; i < 12; i += 1) {
      await controller.searchHot(undefined, createRequest("203.0.113.10"));
    }

    await expect(
      controller.searchHot(undefined, createRequest("203.0.113.10"))
    ).rejects.toMatchObject({ status: 429 });

    await expect(
      controller.searchHot(undefined, createRequest("203.0.113.11"))
    ).resolves.toMatchObject({ items: expect.any(Array) });
    expect(accounts.getCookieOrThrow).not.toHaveBeenCalled();
  });

  it("validates qr attemptId UUID and relatedPlaylists trackId", async () => {
    const service = {
      checkQrLogin: jest.fn(),
      getRelatedPlaylists: jest.fn()
    } as unknown as NeteaseService;
    const auth = {
      getAuthSessionByTokenOrThrow: jest.fn().mockResolvedValue({ userId: "user-1" })
    } as unknown as AuthService;
    const controller = new NeteaseController(service, auth);

    await expect(controller.getQrStatus("not-a-uuid", "valid-token")).rejects.toThrow(HttpException);
    await expect(controller.relatedPlaylists("bad-track-id", "valid-token")).rejects.toThrow(HttpException);
  });
});
