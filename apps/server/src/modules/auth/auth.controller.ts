import { BadRequestException, Body, ConflictException, Controller, Get, Headers, HttpException, HttpStatus, InternalServerErrorException, Ip, Post, Req, Res, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { loginRequestSchema, registerRequestSchema, type AuthSession } from "@soqaro/shared";
import type { Response } from "express";
import { AbuseProtectionService } from "../../common/security/abuse-protection.service";
import { RedisService } from "../../infra/redis/redis.service";
import { parseRequestBody } from "../../common/validation/zod-validation";
import { userSessionCookieName } from "./auth.cookies";
import { AuthService } from "./auth.service";
import { TurnstileService } from "./turnstile.service";
import { resolveClientIp } from "../../common/security/client-ip";

type AuthRateLimitBucket = {
  timestamps: number[];
};

@Controller("v1/auth")
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private readonly ipBuckets = new Map<string, AuthRateLimitBucket>();
  private readonly usernameBuckets = new Map<string, AuthRateLimitBucket>();

  constructor(
    private readonly authService: AuthService,
    private readonly turnstileService: TurnstileService,
    private readonly redisService: RedisService,
    private readonly abuseProtection: AbuseProtectionService
  ) {}

  @Get("config")
  getConfig() {
    return this.turnstileService.getPublicConfig();
  }

  @Post("register")
  async register(
    @Body()
    body: {
      username?: string;
      password?: string;
      nickname?: string;
      turnstileToken?: string;
    },
    @Req()
    request: {
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
      socket?: { remoteAddress?: string };
    },
    @Ip() ipAddress?: string,
    @Res({ passthrough: true }) response?: Response
  ) {
    const payload = parseRequestBody(registerRequestSchema, body);
    const username = payload.username;
    const clientIp = resolveClientIp(request, ipAddress);
    await this.assertAuthRateLimit("register", clientIp, username);
    await this.turnstileService.verify(payload.turnstileToken, clientIp);

    try {
      const session = await this.authService.register({
        username,
        password: payload.password,
        nickname: payload.nickname
      });
      this.logger.log(
        this.buildAuthLog("register.accepted", clientIp, username, HttpStatus.CREATED)
      );
      response?.setHeader("Cache-Control", "no-store");
      setUserSessionCookie(response, session.token);
      return toPublicAuthSession(session);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      const rawMessage = error instanceof Error ? error.message : "";
      if (rawMessage.includes("Username already exists")) {
        this.logger.warn(
          this.buildAuthLog("register.rejected", clientIp, username, HttpStatus.CONFLICT, rawMessage)
        );
        throw new ConflictException(rawMessage);
      }
      if (rawMessage.includes("Account storage is temporarily unavailable")) {
        this.logger.warn(
          this.buildAuthLog("register.rejected", clientIp, username, HttpStatus.SERVICE_UNAVAILABLE, rawMessage)
        );
        throw new ServiceUnavailableException(rawMessage);
      }
      const knownValidationErrors = [
        "Username is required",
        "Nickname is required",
        "Password must be at least",
        "Invalid username",
        "Invalid nickname",
        "Invalid payload"
      ];
      if (knownValidationErrors.some((v) => rawMessage.includes(v))) {
        this.logger.warn(
          this.buildAuthLog("register.rejected", clientIp, username, HttpStatus.BAD_REQUEST, rawMessage)
        );
        throw new BadRequestException(rawMessage);
      }
      this.logger.error(
        this.buildAuthLog("register.error", clientIp, username, HttpStatus.INTERNAL_SERVER_ERROR, rawMessage),
        error instanceof Error ? error.stack : undefined
      );
      throw new InternalServerErrorException("注册失败，请稍后重试。");
    }
  }

  @Post("login")
  async login(
    @Body()
    body: { username?: string; password?: string; turnstileToken?: string },
    @Req()
    request: {
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
      socket?: { remoteAddress?: string };
    },
    @Ip() ipAddress?: string,
    @Res({ passthrough: true }) response?: Response
  ) {
    const payload = parseRequestBody(loginRequestSchema, body);
    const username = payload.username;
    const clientIp = resolveClientIp(request, ipAddress);
    await this.assertAuthRateLimit("login", clientIp, username);
    await this.turnstileService.verify(payload.turnstileToken, clientIp);

    try {
      const session = await this.authService.login({
        username,
        password: payload.password
      });
      await this.clearLoginFailures(username);
      this.logger.log(this.buildAuthLog("login.accepted", clientIp, username, HttpStatus.OK));
      response?.setHeader("Cache-Control", "no-store");
      setUserSessionCookie(response, session.token);
      return toPublicAuthSession(session);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Unauthorized.";
      const isCredentialFailure =
        message === "Invalid username or password." ||
        message === "Account is disabled.";
      if (isCredentialFailure) {
        // Per-username throttling counts only attempts that actually reached
        // credential verification (i.e. passed Turnstile) and failed. Pre-auth
        // garbage traffic must not be able to lock a victim's username.
        await this.recordLoginFailure(username).catch(() => undefined);
      }
      if (message.includes("Account storage is temporarily unavailable")) {
        this.logger.warn(
          this.buildAuthLog("login.rejected", clientIp, username, HttpStatus.SERVICE_UNAVAILABLE, message)
        );
        throw new ServiceUnavailableException(message);
      }
      const knownAuthFailures = [
        "Invalid username or password.",
        "Username and password are required.",
        "Account is disabled."
      ];
      if (knownAuthFailures.includes(message)) {
        this.logger.warn(
          this.buildAuthLog("login.rejected", clientIp, username, HttpStatus.UNAUTHORIZED, message)
        );
        throw new UnauthorizedException(message);
      }
      this.logger.error(
        this.buildAuthLog("login.error", clientIp, username, HttpStatus.INTERNAL_SERVER_ERROR, message),
        error instanceof Error ? error.stack : undefined
      );
      throw new InternalServerErrorException("登录失败，请稍后重试。");
    }
  }

  @Post("logout")
  async logout(
    @Headers("x-session-token") sessionToken: string | undefined,
    @Req()
    request?: {
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
      socket?: { remoteAddress?: string };
    },
    @Ip() ipAddress?: string,
    @Res({ passthrough: true }) response?: Response
  ) {
    const clientIp = resolveClientIp(request ?? {}, ipAddress);
    await this.abuseProtection?.enforce(
      "auth:logout",
      [{ name: "ip", value: clientIp }],
      { limit: 60, windowMs: 60_000 }
    );
    response?.setHeader("Cache-Control", "no-store");
    const result = await this.authService.logout(sessionToken);
    response?.clearCookie(userSessionCookieName, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production"
    });
    return result;
  }

  @Get("me")
  async me(
    @Headers("x-session-token") sessionToken: string | undefined,
    @Req()
    request: {
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
      socket?: { remoteAddress?: string };
    },
    @Ip() ipAddress?: string,
    @Res({ passthrough: true }) response?: Response
  ) {
    // Unknown tokens miss every cache and hit the session store; without a
    // limit, garbage-token floods translate directly into database load.
    const clientIp = resolveClientIp(request, ipAddress);
    await this.abuseProtection?.enforce(
      "auth:me",
      [{ name: "ip", value: clientIp }],
      { limit: 120, windowMs: 60_000 }
    );
    response?.setHeader("Cache-Control", "no-store");
    try {
      const session = await this.authService.getAuthSessionByTokenOrThrow(sessionToken);
      return toPublicAuthSession(session);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Unauthorized.";
      if (message.includes("Account storage is temporarily unavailable")) {
        throw new ServiceUnavailableException(message);
      }
      const knownSessionErrors = [
        "Invalid session token.",
        "Session expired.",
        "Account is disabled."
      ];
      if (knownSessionErrors.includes(message)) {
        throw new UnauthorizedException(message);
      }
      this.logger.error(
        `Unexpected error verifying auth session: ${message}`,
        error instanceof Error ? error.stack : undefined
      );
      throw new InternalServerErrorException("获取会话失败，请稍后重试。");
    }
  }

  private getAuthRateLimits(action: "register" | "login") {
    return action === "register"
      ? { perIp: 8, perUsername: 4, windowMs: 60_000 }
      : { perIp: 12, perUsername: 6, windowMs: 60_000 };
  }

  private isAuthRateLimitDisabled() {
    // E2E runs multiple isolated browser contexts through the same loopback IP.
    return process.env.NODE_ENV === "test" && process.env.AUTH_RATE_LIMIT_DISABLED === "true";
  }

  private async assertAuthRateLimit(action: "register" | "login", clientIp: string, username: string) {
    if (this.isAuthRateLimitDisabled()) {
      return;
    }

    const limits = this.getAuthRateLimits(action);
    const now = Date.now();
    const normalizedUsername = username.trim().toLowerCase() || "anonymous";

    const redisLimited = await this.tryAssertRedisRateLimit(
      action,
      clientIp,
      normalizedUsername,
      limits
    );
    if (redisLimited === "accepted") {
      return;
    }

    const ipBucket = this.getRateLimitBucket(
      this.ipBuckets,
      `${action}:ip:${clientIp}`,
      now,
      limits.windowMs
    );

    if (ipBucket.timestamps.length >= limits.perIp) {
      this.logger.warn(
        this.buildAuthLog(
          `${action}.rate-limited`,
          clientIp,
          normalizedUsername,
          HttpStatus.TOO_MANY_REQUESTS,
          "Auth rate limit exceeded."
        )
      );
      throw new HttpException("Auth rate limit exceeded.", HttpStatus.TOO_MANY_REQUESTS);
    }
    ipBucket.timestamps.push(now);

    // Login usernames are peeked without counting: the count is only increased
    // by recordLoginFailure after a failed credential verification.
    const usernameBucket = this.getRateLimitBucket(
      this.usernameBuckets,
      `${action}:username:${normalizedUsername}`,
      now,
      limits.windowMs
    );

    if (usernameBucket.timestamps.length >= limits.perUsername) {
      this.logger.warn(
        this.buildAuthLog(
          `${action}.rate-limited`,
          clientIp,
          normalizedUsername,
          HttpStatus.TOO_MANY_REQUESTS,
          "Auth rate limit exceeded."
        )
      );
      throw new HttpException("Auth rate limit exceeded.", HttpStatus.TOO_MANY_REQUESTS);
    }

    if (action !== "login") {
      usernameBucket.timestamps.push(now);
    }
  }

  private async recordLoginFailure(username: string) {
    if (this.isAuthRateLimitDisabled()) {
      return;
    }
    const limits = this.getAuthRateLimits("login");
    const normalizedUsername = username.trim().toLowerCase() || "anonymous";

    if (
      this.redisService &&
      (typeof this.redisService.isAvailable !== "function" || this.redisService.isAvailable())
    ) {
      await this.incrementRedisRateLimitKey(
        `auth:login:username:${normalizedUsername}`,
        limits.windowMs
      );
    }

    const bucket = this.getRateLimitBucket(
      this.usernameBuckets,
      `login:username:${normalizedUsername}`,
      Date.now(),
      limits.windowMs
    );
    bucket.timestamps.push(Date.now());
  }

  private async clearLoginFailures(username: string) {
    if (this.isAuthRateLimitDisabled()) {
      return;
    }
    const normalizedUsername = username.trim().toLowerCase() || "anonymous";
    try {
      if (this.redisService) {
        await this.redisService.delete(`auth:login:username:${normalizedUsername}`);
      }
    } catch {
      // A stale failure counter only throttles briefly; clearing is best-effort.
    }
    this.usernameBuckets.delete(`login:username:${normalizedUsername}`);
  }

  private async tryAssertRedisRateLimit(
    action: "register" | "login",
    clientIp: string,
    normalizedUsername: string,
    limits: { perIp: number; perUsername: number; windowMs: number }
  ): Promise<"accepted" | "fallback"> {
    if (
      !this.redisService ||
      (typeof this.redisService.isAvailable === "function" && !this.redisService.isAvailable())
    ) {
      if (process.env.NODE_ENV === "production") {
        throw new ServiceUnavailableException("Auth rate limit storage is temporarily unavailable.");
      }
      return "fallback";
    }

    try {
      const ipCount = await this.incrementRedisRateLimitKey(
        `auth:${action}:ip:${clientIp}`,
        limits.windowMs
      );
      if (ipCount > limits.perIp) {
        this.logger.warn(
          this.buildAuthLog(
            `${action}.rate-limited`,
            clientIp,
            normalizedUsername,
            HttpStatus.TOO_MANY_REQUESTS,
            "Auth rate limit exceeded."
          )
        );
        throw new HttpException("Auth rate limit exceeded.", HttpStatus.TOO_MANY_REQUESTS);
      }

      if (action === "login") {
        const usernameCount = await this.peekRedisRateLimitKey(
          `auth:login:username:${normalizedUsername}`
        );
        if (usernameCount > limits.perUsername) {
          this.logger.warn(
            this.buildAuthLog(
              `${action}.rate-limited`,
              clientIp,
              normalizedUsername,
              HttpStatus.TOO_MANY_REQUESTS,
              "Auth rate limit exceeded."
            )
          );
          throw new HttpException("Auth rate limit exceeded.", HttpStatus.TOO_MANY_REQUESTS);
        }
      } else {
        const usernameCount = await this.incrementRedisRateLimitKey(
          `auth:register:username:${normalizedUsername}`,
          limits.windowMs
        );
        if (usernameCount > limits.perUsername) {
          this.logger.warn(
            this.buildAuthLog(
              `${action}.rate-limited`,
              clientIp,
              normalizedUsername,
              HttpStatus.TOO_MANY_REQUESTS,
              "Auth rate limit exceeded."
            )
          );
          throw new HttpException("Auth rate limit exceeded.", HttpStatus.TOO_MANY_REQUESTS);
        }
      }

      return "accepted";
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      if (process.env.NODE_ENV === "production") {
        throw new ServiceUnavailableException("Auth rate limit storage is temporarily unavailable.");
      }
      this.logger.warn(`Auth redis rate limit unavailable; falling back to memory. ${String(error)}`);
      return "fallback";
    }
  }

  private async peekRedisRateLimitKey(key: string) {
    if (!this.redisService) {
      throw new Error("Redis service unavailable.");
    }
    const raw = await this.redisService.getString(key);
    const parsed = Number.parseInt(raw ?? "0", 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private async incrementRedisRateLimitKey(key: string, windowMs: number) {
    if (!this.redisService) {
      throw new Error("Redis service unavailable.");
    }

    return this.redisService.incrementWithTtlMs(key, windowMs);
  }

  private getRateLimitBucket(
    buckets: Map<string, AuthRateLimitBucket>,
    key: string,
    now: number,
    windowMs: number
  ) {
    if (buckets.size >= 10_000) {
      // Buckets are only pruned on re-hit; a caller rotating keys (IPv6
      // source-address rotation) would otherwise grow the maps forever.
      for (const [existingKey, existingBucket] of buckets) {
        if (
          existingBucket.timestamps.length === 0 ||
          now - existingBucket.timestamps[existingBucket.timestamps.length - 1]! >= windowMs
        ) {
          buckets.delete(existingKey);
        }
      }
      while (buckets.size >= 10_000) {
        const oldestKey = buckets.keys().next().value;
        if (oldestKey === undefined) break;
        buckets.delete(oldestKey);
      }
    }
    const bucket = buckets.get(key) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((timestamp) => now - timestamp < windowMs);
    buckets.set(key, bucket);
    return bucket;
  }

  private buildAuthLog(
    event: string,
    clientIp: string,
    username: string,
    statusCode: number,
    reason?: string
  ) {
    return JSON.stringify({
      event,
      statusCode,
      username: username.trim().toLowerCase() || "anonymous",
      clientIp,
      reason: reason ?? null,
      timestamp: new Date().toISOString()
    });
  }
}

function setUserSessionCookie(response: Response | undefined, token: string) {
  response?.cookie(userSessionCookieName, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 14 * 24 * 60 * 60 * 1000,
    path: "/"
  });
}

function toPublicAuthSession(session: AuthSession): AuthSession {
  return { ...session, token: "" };
}

