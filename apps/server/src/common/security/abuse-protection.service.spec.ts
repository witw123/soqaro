import { HttpException, HttpStatus } from "@nestjs/common";
import { AbuseProtectionService } from "./abuse-protection.service";

describe("AbuseProtectionService", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it("does not allow RATE_LIMIT_DISABLED=true to bypass enforcement in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.RATE_LIMIT_DISABLED = "true";
    const redis = {
      isAvailable: jest.fn(() => true),
      incrementWithTtlMs: jest.fn().mockResolvedValue(2)
    };
    const service = new AbuseProtectionService(redis as never);

    await expect(
      service.enforce("auth:logout", [{ name: "ip", value: "203.0.113.10" }], {
        limit: 1,
        windowMs: 60_000
      })
    ).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS
    });
  });

  it("bounds memory fallback buckets at 10,000 entries when keys rotate", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.RATE_LIMIT_DISABLED;
    const redis = { isAvailable: jest.fn(() => false) };
    const service = new AbuseProtectionService(redis as never);

    for (let index = 0; index < 10_050; index += 1) {
      await service.enforce(
        "realtime:ice-config",
        [{ name: "ip", value: `198.51.100.${index}` }],
        { limit: 1, windowMs: 60_000 }
      );
    }

    // Oldest entry was evicted at the 10,000 cap, so a repeat request starts fresh at 1
    await expect(
      service.enforce(
        "realtime:ice-config",
        [{ name: "ip", value: "198.51.100.0" }],
        { limit: 1, windowMs: 60_000 }
      )
    ).resolves.toBeUndefined();

    // Still enforces within the cap for recent entries
    await expect(
      service.enforce(
        "realtime:ice-config",
        [{ name: "ip", value: "198.51.100.10049" }],
        { limit: 1, windowMs: 60_000 }
      )
    ).rejects.toBeInstanceOf(HttpException);
  });
});
