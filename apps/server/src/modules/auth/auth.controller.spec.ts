import {
  ConflictException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  UnauthorizedException
} from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { TurnstileService } from "./turnstile.service";

describe("AuthController", () => {
  const request = {
    ip: "127.0.0.1",
    headers: {} as Record<string, string>,
    socket: { remoteAddress: "127.0.0.1" }
  };

  it("rate limits repeated login attempts by IP and username", async () => {
    const authService = {
      login: jest.fn().mockRejectedValue(new Error("Invalid username or password."))
    };
    const controller = new AuthController(authService as never, new TurnstileService(), undefined as never, undefined as never);

    for (let index = 0; index < 6; index += 1) {
      await expect(
        controller.login({ username: "tester", password: "bad-pass" }, request, "127.0.0.1")
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }

    await expect(
      controller
        .login({ username: "tester", password: "bad-pass" }, request, "127.0.0.1")
        .catch((error: unknown) => {
          expect(error).toBeInstanceOf(HttpException);
          expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        })
    ).resolves.toBeUndefined();
  });

  it("rate limits repeated register attempts by IP and username", async () => {
    const authService = {
      register: jest.fn().mockRejectedValue(new Error("Username already exists."))
    };
    const controller = new AuthController(authService as never, new TurnstileService(), undefined as never, undefined as never);

    for (let index = 0; index < 4; index += 1) {
      await expect(
        controller.register(
          { username: "tester", password: "bad-pass", nickname: "Tester" },
          request,
          "127.0.0.1"
        )
      ).rejects.toBeInstanceOf(ConflictException);
    }

    await expect(
      controller
        .register(
          { username: "tester", password: "bad-pass", nickname: "Tester" },
          request,
          "127.0.0.1"
        )
        .catch((error: unknown) => {
          expect(error).toBeInstanceOf(HttpException);
          expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        })
    ).resolves.toBeUndefined();
  });

  it("uses trusted request ip instead of spoofable forwarded headers", async () => {
    const authService = {
      login: jest.fn().mockRejectedValue(new Error("Invalid username or password."))
    };
    const controller = new AuthController(authService as never, new TurnstileService(), undefined as never, undefined as never);
    const spoofedRequest = {
      ...request,
      ip: "10.0.0.10",
      headers: {
        "x-forwarded-for": "1.2.3.4",
        "x-real-ip": "5.6.7.8"
      }
    };

    for (let index = 0; index < 12; index += 1) {
      await expect(
        controller.login(
          { username: `tester_${index}`, password: "bad-pass" },
          spoofedRequest,
          "10.0.0.10"
        )
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }

    await expect(
      controller.login(
        { username: "tester_12", password: "bad-pass" },
        spoofedRequest,
        "10.0.0.10"
      )
    ).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS
    });
  });

  it("uses redis counters when redis is available", async () => {
    const authService = {
      login: jest.fn().mockRejectedValue(new Error("Invalid username or password."))
    };
    const redisService = {
      isAvailable: jest.fn(() => true),
      incrementWithTtlMs: jest.fn().mockResolvedValue(1)
    };
    const controller = new AuthController(
      authService as never,
      new TurnstileService(),
      redisService as never,
      undefined as never
    );

    await expect(
      controller.login({ username: "tester", password: "bad-pass" }, request, "127.0.0.1")
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(redisService.incrementWithTtlMs).toHaveBeenCalledWith(
      "auth:login:ip:127.0.0.1",
      60_000
    );
    expect(redisService.incrementWithTtlMs).toHaveBeenCalledWith(
      "auth:login:username:tester",
      60_000
    );
  });

  it("verifies Turnstile before authenticating when the challenge is enabled", async () => {
    const authService = { login: jest.fn() };
    const turnstileService = {
      verify: jest.fn().mockRejectedValue(new HttpException("Human verification failed.", 400))
    };
    const controller = new AuthController(
      authService as never,
      turnstileService as never,
      undefined as never,
      undefined as never
    );

    await expect(
      controller.login(
        { username: "tester", password: "password", turnstileToken: "token" },
        request,
        "127.0.0.1"
      )
    ).rejects.toBeInstanceOf(HttpException);
    expect(turnstileService.verify).toHaveBeenCalledWith("token", "127.0.0.1");
    expect(authService.login).not.toHaveBeenCalled();
  });

  it("sanitizes unexpected internal errors during register and returns 500", async () => {
    const authService = {
      register: jest.fn().mockRejectedValue(new Error("PrismaClientKnownRequestError: table does not exist"))
    };
    const controller = new AuthController(authService as never, new TurnstileService(), undefined as never, undefined as never);

    await expect(
      controller.register(
        { username: "newuser", password: "password123", nickname: "Newbie" },
        request,
        "127.0.0.1"
      )
    ).rejects.toMatchObject({
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: "注册失败，请稍后重试。"
    });
  });

  it("maps known validation errors to BadRequestException during register", async () => {
    const authService = {
      register: jest.fn().mockRejectedValue(new Error("Password must be at least 8 characters."))
    };
    const controller = new AuthController(authService as never, new TurnstileService(), undefined as never, undefined as never);

    await expect(
      controller.register(
        { username: "newuser", password: "password123", nickname: "Newbie" },
        request,
        "127.0.0.1"
      )
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      message: "Password must be at least 8 characters."
    });
  });

  it("sets Cache-Control: no-store on register, login, logout, and me", async () => {
    const fakeSession = {
      id: "user_1",
      username: "alice",
      nickname: "Alice",
      token: "secret-session-token",
      createdAt: "2026-01-01T00:00:00.000Z"
    };
    const authService = {
      register: jest.fn().mockResolvedValue(fakeSession),
      login: jest.fn().mockResolvedValue(fakeSession),
      logout: jest.fn().mockResolvedValue({ ok: true }),
      getAuthSessionByTokenOrThrow: jest.fn().mockResolvedValue(fakeSession)
    };
    const abuseProtection = { enforce: jest.fn().mockResolvedValue(undefined) };
    const controller = new AuthController(
      authService as never,
      new TurnstileService(),
      undefined as never,
      abuseProtection as never
    );

    const makeResponse = () => ({
      setHeader: jest.fn(),
      cookie: jest.fn(),
      clearCookie: jest.fn()
    });

    const regRes = makeResponse();
    await controller.register(
      { username: "alice", password: "password123", nickname: "Alice" },
      request,
      "127.0.0.1",
      regRes as never
    );
    expect(regRes.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");

    const loginRes = makeResponse();
    await controller.login(
      { username: "alice", password: "password123" },
      request,
      "127.0.0.1",
      loginRes as never
    );
    expect(loginRes.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");

    const logoutRes = makeResponse();
    await controller.logout("secret-session-token", request, "127.0.0.1", logoutRes as never);
    expect(logoutRes.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(abuseProtection.enforce).toHaveBeenCalledWith(
      "auth:logout",
      [{ name: "ip", value: "127.0.0.1" }],
      { limit: 60, windowMs: 60_000 }
    );

    const meRes = makeResponse();
    await controller.me("secret-session-token", request, "127.0.0.1", meRes as never);
    expect(meRes.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  });

  it("sanitizes unexpected DB errors in login and me without counting them as credential failures", async () => {
    const authService = {
      login: jest.fn().mockRejectedValue(new Error("ECONNREFUSED 10.0.0.4:5432")),
      getAuthSessionByTokenOrThrow: jest.fn().mockRejectedValue(new Error("P1001: Can't reach database"))
    };
    const redisService = {
      isAvailable: jest.fn(() => true),
      getString: jest.fn().mockResolvedValue(null),
      incrementWithTtlMs: jest.fn().mockResolvedValue(1),
      delete: jest.fn().mockResolvedValue(undefined)
    };
    const controller = new AuthController(
      authService as never,
      new TurnstileService(),
      redisService as never,
      undefined as never
    );

    await expect(
      controller.login({ username: "alice", password: "password123" }, request, "127.0.0.1")
    ).rejects.toThrow(InternalServerErrorException);

    // Only IP key should have incremented; username failure counter must NOT increment on DB outage
    expect(redisService.incrementWithTtlMs).toHaveBeenCalledTimes(1);
    expect(redisService.incrementWithTtlMs).toHaveBeenCalledWith("auth:login:ip:127.0.0.1", 60_000);

    await expect(
      controller.me("some-token", request, "127.0.0.1")
    ).rejects.toThrow(InternalServerErrorException);
  });
});
