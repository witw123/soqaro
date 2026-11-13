import { validateRuntimeConfig } from "./runtime-config";

const validTurnstileConfig = {
  CORS_ORIGINS: "https://example.com",
  AUDIT_HASH_SECRET: "super-secret-audit-hash-key",
  TURNSTILE_ENABLED: "true",
  TURNSTILE_SITE_KEY: "1x0000000000000000000000000000000AA",
  TURNSTILE_SECRET_KEY: "0x0000000000000000000000000000000AA",
  // Production startup binds Turnstile tokens to APP_DOMAIN; tests below that
  // exercise a missing APP_DOMAIN override it with an empty value.
  APP_DOMAIN: "example.com"
};

describe("validateRuntimeConfig", () => {
  it("allows placeholder secrets outside production", () => {
    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "development",
        JWT_SECRET: "replace-this-with-a-long-random-secret",
        TURN_ENABLED: "true",
        TURN_SHARED_SECRET: "replace-with-a-turn-shared-secret"
      })
    ).not.toThrow();
  });

  it("rejects placeholder JWT secret in production", () => {
    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        JWT_SECRET: "replace-this-with-a-long-random-secret",
        TURN_ENABLED: "false",
        NEXT_PUBLIC_TURN_URL: "turn:static.example.com:3478?transport=udp"
      })
    ).toThrow("Invalid JWT_SECRET for production startup.");
  });

  it("rejects placeholder TURN secret in production when TURN is enabled", () => {
    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        JWT_SECRET: "super-secret-jwt",
        TURN_PUBLIC_HOST: "turn.example.com",
        TURN_ENABLED: "true",
        TURN_SHARED_SECRET: "replace-with-a-turn-shared-secret"
      })
    ).toThrow("Invalid TURN_SHARED_SECRET for production startup.");
  });

  it("requires Turnstile in production", () => {
    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        TURNSTILE_ENABLED: "false",
        JWT_SECRET: "super-secret-jwt",
        TURN_ENABLED: "false",
        NEXT_PUBLIC_TURN_URL: "turn:static.example.com:3478?transport=udp"
      })
    ).toThrow("TURNSTILE_ENABLED must be true in production startup.");
  });

  it("rejects non-numeric proxy trust modes in production", () => {
    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        TRUST_PROXY: "all",
        JWT_SECRET: "super-secret-jwt",
        TURN_ENABLED: "false",
        NEXT_PUBLIC_TURN_URL: "turn:static.example.com:3478?transport=udp"
      })
    ).toThrow(
      "Production TRUST_PROXY must be false, a non-negative proxy hop count, or a trusted proxy IP/CIDR/subnet list."
    );
  });

  it("allows valid trusted proxy subnet and CIDR lists in production", () => {
    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        TRUST_PROXY: "loopback, linklocal, uniquelocal",
        JWT_SECRET: "super-secret-jwt",
        TURN_ENABLED: "false",
        NEXT_PUBLIC_TURN_URL: "turn:static.example.com:3478?transport=udp"
      })
    ).not.toThrow();

    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        TRUST_PROXY: "10.0.0.0/8, 127.0.0.1",
        JWT_SECRET: "super-secret-jwt",
        TURN_ENABLED: "false",
        NEXT_PUBLIC_TURN_URL: "turn:static.example.com:3478?transport=udp"
      })
    ).not.toThrow();
  });

  it("rejects RATE_LIMIT_DISABLED=true in production", () => {
    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        RATE_LIMIT_DISABLED: "true",
        JWT_SECRET: "super-secret-jwt",
        TURN_ENABLED: "false",
        NEXT_PUBLIC_TURN_URL: "turn:static.example.com:3478?transport=udp"
      })
    ).toThrow("RATE_LIMIT_DISABLED must be false in production startup.");
  });

  it("requires CORS_ORIGINS in production", () => {
    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        CORS_ORIGINS: "   ",
        JWT_SECRET: "super-secret-jwt",
        TURN_ENABLED: "false",
        NEXT_PUBLIC_TURN_URL: "turn:static.example.com:3478?transport=udp"
      })
    ).toThrow("CORS_ORIGINS must be configured in production startup.");
  });

  it("rejects short JWT_SECRET, AUDIT_HASH_SECRET, and TURN_SHARED_SECRET in production", () => {
    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        JWT_SECRET: "too-short",
        TURN_ENABLED: "false",
        NEXT_PUBLIC_TURN_URL: "turn:static.example.com:3478?transport=udp"
      })
    ).toThrow("Invalid JWT_SECRET for production startup.");

    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        JWT_SECRET: "super-secret-jwt",
        AUDIT_HASH_SECRET: "short",
        TURN_ENABLED: "false",
        NEXT_PUBLIC_TURN_URL: "turn:static.example.com:3478?transport=udp"
      })
    ).toThrow("AUDIT_HASH_SECRET must be at least 16 characters in production startup.");

    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        JWT_SECRET: "super-secret-jwt",
        TURN_PUBLIC_HOST: "turn.example.com",
        TURN_ENABLED: "true",
        TURN_SHARED_SECRET: "short-turn-sec"
      })
    ).toThrow("Invalid TURN_SHARED_SECRET for production startup.");
  });

  it("requires APP_DOMAIN even when TURN_PUBLIC_HOST is configured in production", () => {
    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        APP_DOMAIN: "",
        JWT_SECRET: "super-secret-jwt",
        TURN_PUBLIC_HOST: "turn.example.com",
        TURN_ENABLED: "true",
        TURN_SHARED_SECRET: "super-secret-turn"
      })
    ).toThrow("APP_DOMAIN must be configured in production startup to bind Turnstile tokens.");
  });

  it("requires an explicit TURN host or app domain in production when TURN is enabled", () => {
    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        APP_DOMAIN: "",
        JWT_SECRET: "super-secret-jwt",
        TURN_ENABLED: "true",
        TURN_SHARED_SECRET: "super-secret-turn"
      })
    ).toThrow("TURN requires TURN_PUBLIC_HOST or APP_DOMAIN in production startup.");
  });

  it("allows production startup when TURN host is derived from request host", () => {
    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        JWT_SECRET: "super-secret-jwt",
        TURN_ENABLED: "true",
        TURN_PUBLIC_HOST_USE_REQUEST_HOST: "1",
        TURN_REQUEST_HOST_ALLOWLIST: "example.com",
        TURN_SHARED_SECRET: "super-secret-turn"
      })
    ).not.toThrow();
  });

  it("allows request-host TURN derivation to replace a local TURN placeholder", () => {
    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        JWT_SECRET: "super-secret-jwt",
        TURN_ENABLED: "true",
        TURN_PUBLIC_HOST: "localhost",
        TURN_PUBLIC_HOST_USE_REQUEST_HOST: "1",
        TURN_SHARED_SECRET: "super-secret-turn"
      })
    ).not.toThrow();
  });

  it("rejects local TURN hosts in production when no static TURN fallback exists", () => {
    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        JWT_SECRET: "super-secret-jwt",
        TURN_ENABLED: "true",
        TURN_PUBLIC_HOST: "localhost",
        TURN_SHARED_SECRET: "super-secret-turn"
      })
    ).toThrow("TURN_PUBLIC_HOST cannot be localhost in production startup.");
  });

  it("rejects production startup when TURN is disabled without a static TURN server", () => {
    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        JWT_SECRET: "super-secret-jwt",
        TURN_ENABLED: "false"
      })
    ).toThrow("TURN is required for production startup.");
  });

  it("allows production startup with static TURN when ephemeral TURN is disabled", () => {
    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        JWT_SECRET: "super-secret-jwt",
        TURN_ENABLED: "false",
        NEXT_PUBLIC_TURN_URL: "turn:static.example.com:3478?transport=udp"
      })
    ).not.toThrow();
  });

  it("allows production startup with static TURN fallback when ephemeral TURN vars are incomplete", () => {
    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        JWT_SECRET: "super-secret-jwt",
        TURN_ENABLED: "true",
        NEXT_PUBLIC_WEBRTC_ICE_SERVERS: JSON.stringify([
          { urls: "stun:stun.example.com:19302" },
          { urls: "turn:static.example.com:3478?transport=udp" }
        ])
      })
    ).not.toThrow();
  });

  it("allows valid production secrets", () => {
    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        ...validTurnstileConfig,
        JWT_SECRET: "super-secret-jwt",
        TURN_PUBLIC_HOST: "turn.example.com",
        TURN_ENABLED: "true",
        TURN_SHARED_SECRET: "super-secret-turn"
      })
    ).not.toThrow();
  });
});
