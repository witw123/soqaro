import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { TurnstileService } from "./turnstile.service";

describe("TurnstileService", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it("does not call Cloudflare when Turnstile is disabled", async () => {
    delete process.env.TURNSTILE_ENABLED;
    const fetchMock = jest.spyOn(globalThis, "fetch");

    await expect(new TurnstileService().verify(undefined, "127.0.0.1")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a token when Turnstile is enabled", async () => {
    process.env.TURNSTILE_ENABLED = "true";
    process.env.TURNSTILE_SECRET_KEY = "secret";

    await expect(new TurnstileService().verify(undefined, "127.0.0.1")).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it("verifies the token, action, hostname and client ip with Cloudflare", async () => {
    process.env.TURNSTILE_ENABLED = "true";
    process.env.TURNSTILE_SECRET_KEY = "secret";
    process.env.APP_DOMAIN = "soqaro.example.com";
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, action: "auth", hostname: "soqaro.example.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );

    await expect(new TurnstileService().verify("token", "203.0.113.10")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("secret")).toBe("secret");
    expect(form.get("response")).toBe("token");
    expect(form.get("remoteip")).toBe("203.0.113.10");
  });

  it("rejects failed or mismatched Cloudflare responses", async () => {
    process.env.TURNSTILE_ENABLED = "true";
    process.env.TURNSTILE_SECRET_KEY = "secret";
    process.env.APP_DOMAIN = "soqaro.example.com";
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, action: "other", hostname: "attacker.example.com" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );

    await expect(new TurnstileService().verify("token", "unknown")).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it("fails closed when Cloudflare cannot be reached", async () => {
    process.env.TURNSTILE_ENABLED = "true";
    process.env.TURNSTILE_SECRET_KEY = "secret";
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    await expect(new TurnstileService().verify("token", "unknown")).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });

  it("fails closed when APP_DOMAIN is malformed or lacks a hostname", async () => {
    process.env.TURNSTILE_ENABLED = "true";
    process.env.TURNSTILE_SECRET_KEY = "secret";
    jest.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ success: true, action: "auth", hostname: "soqaro.example.com" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );

    for (const badDomain of ["https://", ":8080", "not a valid domain///"]) {
      process.env.APP_DOMAIN = badDomain;
      await expect(new TurnstileService().verify("token", "203.0.113.10")).rejects.toBeInstanceOf(
        BadRequestException
      );
    }
  });
});
