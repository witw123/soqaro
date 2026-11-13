import { createGlobalRateLimitMiddleware } from "./global-rate-limit.middleware";

function requestOf(path: string, ip = "203.0.113.7") {
  return { path, ip, socket: { remoteAddress: ip } } as never;
}

function responseOf() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { status, json } as never;
}

function call(middleware: ReturnType<typeof createGlobalRateLimitMiddleware>, path: string) {
  const next = jest.fn();
  const response = responseOf();
  (middleware as (r: never, res: never, n: () => void) => void)(requestOf(path), response, next);
  const status = (response as { status: jest.Mock }).status;
  return { next, status };
}

describe("createGlobalRateLimitMiddleware", () => {
  it("passes through non-/v1 paths", () => {
    const middleware = createGlobalRateLimitMiddleware({ limitPerMinute: 2, enabled: true });
    for (const path of ["/health/readiness", "/metrics", "/"]) {
      const { next } = call(middleware, path);
      expect(next).toHaveBeenCalled();
    }
  });

  it("allows requests under the limit and returns 429 beyond it", () => {
    const middleware = createGlobalRateLimitMiddleware({ limitPerMinute: 3, enabled: true });
    for (let index = 0; index < 3; index += 1) {
      const { next, status } = call(middleware, "/v1/rooms/room_1");
      expect(next).toHaveBeenCalled();
      expect(status).not.toHaveBeenCalled();
    }
    const { next, status } = call(middleware, "/v1/rooms/room_1");
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(429);
  });

  it("resets the window after one minute", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-26T10:00:00Z"));
    try {
      const middleware = createGlobalRateLimitMiddleware({ limitPerMinute: 1, enabled: true });
      call(middleware, "/v1/a");
      const blocked = call(middleware, "/v1/a");
      expect(blocked.next).not.toHaveBeenCalled();

      jest.setSystemTime(new Date("2026-09-26T10:01:01Z"));
      const afterWindow = call(middleware, "/v1/a");
      expect(afterWindow.next).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("skips entirely when disabled", () => {
    const middleware = createGlobalRateLimitMiddleware({ limitPerMinute: 1, enabled: false });
    for (let index = 0; index < 5; index += 1) {
      const { next, status } = call(middleware, "/v1/a");
      expect(next).toHaveBeenCalled();
      expect(status).not.toHaveBeenCalled();
    }
  });

  it("disables global rate limiting when GLOBAL_RATE_LIMIT_PER_MINUTE is 0", () => {
    const original = process.env.GLOBAL_RATE_LIMIT_PER_MINUTE;
    process.env.GLOBAL_RATE_LIMIT_PER_MINUTE = "0";
    try {
      const middleware = createGlobalRateLimitMiddleware();
      for (let index = 0; index < 150; index += 1) {
        const { next, status } = call(middleware, "/v1/a");
        expect(next).toHaveBeenCalled();
        expect(status).not.toHaveBeenCalled();
      }
    } finally {
      if (original === undefined) {
        delete process.env.GLOBAL_RATE_LIMIT_PER_MINUTE;
      } else {
        process.env.GLOBAL_RATE_LIMIT_PER_MINUTE = original;
      }
    }
  });

  it("evicts oldest IP buckets when distinct IPs exceed cap within a single window", () => {
    const middleware = createGlobalRateLimitMiddleware({ limitPerMinute: 1, enabled: true });
    for (let index = 0; index < 10_050; index += 1) {
      const next = jest.fn();
      const response = responseOf();
      (middleware as (r: never, res: never, n: () => void) => void)(
        requestOf("/v1/rooms/room_1", `198.51.100.${index}`),
        response,
        next
      );
      expect(next).toHaveBeenCalled();
    }
    // First IP was evicted from the bounded 10,000-entry map so it is tracked cleanly again
    const next = jest.fn();
    const response = responseOf();
    (middleware as (r: never, res: never, n: () => void) => void)(
      requestOf("/v1/rooms/room_1", "198.51.100.0"),
      response,
      next
    );
    expect(next).toHaveBeenCalled();
  });
});
