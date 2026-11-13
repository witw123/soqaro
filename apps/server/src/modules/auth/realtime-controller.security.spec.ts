import { InternalServerErrorException, UnauthorizedException } from "@nestjs/common";
import { RealtimeController } from "../realtime/realtime.controller";

describe("RealtimeController security", () => {
  it("enforces IP rate limit and ignores raw x-forwarded-host in favor of Express request.hostname", async () => {
    const realtimeService = {
      buildIceConfig: jest.fn().mockReturnValue({ iceServers: [] })
    };
    const authService = {
      getAuthSessionByTokenOrThrow: jest.fn().mockResolvedValue({ userId: "user_1" })
    };
    const metrics = { incrementIceFailure: jest.fn() };
    const abuseProtection = { enforce: jest.fn().mockResolvedValue(undefined) };

    const controller = new RealtimeController(
      realtimeService as never,
      authService as never,
      metrics as never,
      abuseProtection as never
    );

    const request = {
      ip: "203.0.113.9",
      hostname: "turn-safe.example.com",
      headers: { "x-forwarded-host": "attacker.invalid" },
      socket: { remoteAddress: "203.0.113.9" }
    };

    await controller.getIceConfig("valid-token", "fallback.example.com", request, "203.0.113.9");

    expect(abuseProtection.enforce).toHaveBeenCalledWith(
      "realtime:ice-config",
      [{ name: "ip", value: "203.0.113.9" }],
      { limit: 60, windowMs: 60_000 }
    );
    expect(realtimeService.buildIceConfig).toHaveBeenCalledWith("user_1", {
      requestHost: "turn-safe.example.com"
    });
  });

  it("sanitizes unexpected auth and ICE build errors instead of leaking internals", async () => {
    const realtimeService = {
      buildIceConfig: jest.fn(() => {
        throw new Error("TURN_SHARED_SECRET internal error");
      })
    };
    const authService = {
      getAuthSessionByTokenOrThrow: jest
        .fn()
        .mockRejectedValueOnce(new Error("Prisma connection refused at 10.0.0.5:5432"))
        .mockResolvedValueOnce({ userId: "user_1" })
        .mockRejectedValueOnce(new Error("Invalid session token."))
    };
    const metrics = { incrementIceFailure: jest.fn() };

    const controller = new RealtimeController(
      realtimeService as never,
      authService as never,
      metrics as never
    );

    await expect(controller.getIceConfig("tok", "example.com", { ip: "127.0.0.1" })).rejects.toThrow(
      InternalServerErrorException
    );

    await expect(controller.getIceConfig("tok", "example.com", { ip: "127.0.0.1" })).rejects.toThrow(
      InternalServerErrorException
    );
    expect(metrics.incrementIceFailure).toHaveBeenCalledTimes(1);

    await expect(controller.getIceConfig("tok", "example.com", { ip: "127.0.0.1" })).rejects.toThrow(
      UnauthorizedException
    );
  });
});
