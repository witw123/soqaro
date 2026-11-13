import { getCorsOrigins, getRequestOrigin, isAllowedOrigin } from "./get-cors-origins";

describe("origin validation", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalCorsOrigins = process.env.CORS_ORIGINS;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalCorsOrigins === undefined) {
      delete process.env.CORS_ORIGINS;
    } else {
      process.env.CORS_ORIGINS = originalCorsOrigins;
    }
  });

  it("uses Express request.protocol and ignores unparsed x-forwarded-proto", () => {
    const trustedHttpsOrigin = getRequestOrigin({
      protocol: "https",
      get: (header) => (header === "host" ? "soqaro.invalid" : undefined)
    });
    expect(trustedHttpsOrigin).toBe("https://soqaro.invalid");
    expect(isAllowedOrigin("https://soqaro.invalid", trustedHttpsOrigin, [])).toBe(true);

    const spoofedOrigin = getRequestOrigin({
      protocol: "http",
      get: (header) => {
        if (header === "host") return "soqaro.invalid";
        if (header === "x-forwarded-proto") return "https";
        return undefined;
      }
    });
    expect(spoofedOrigin).toBe("http://soqaro.invalid");
  });

  it("normalizes configured origins but rejects another host", () => {
    expect(isAllowedOrigin("https://admin.invalid/", null, ["https://admin.invalid"])).toBe(true);
    expect(isAllowedOrigin("https://attacker.invalid", "https://soqaro.invalid", [])).toBe(false);
  });

  it("returns no fallback origins in production when CORS_ORIGINS is unset", () => {
    process.env.NODE_ENV = "production";
    delete process.env.CORS_ORIGINS;

    expect(getCorsOrigins()).toEqual([]);
  });
});
