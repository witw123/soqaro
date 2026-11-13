import { createApiErrorResponse, errorCodes } from "@soqaro/shared";
import type { NextFunction, Request, Response } from "express";

type Bucket = { windowStart: number; count: number };

const DEFAULT_LIMIT_PER_MINUTE = 1200;
const MAX_TRACKED_IPS = 10_000;
const WINDOW_MS = 60_000;

/**
 * /v1/* 的进程内兜底限流(固定窗口,按 IP):nginx 层有 30r/s 的前端限速,
 * 这里防的是绕过 nginx 直打、或裸机部署没有前端限速的场景。
 * 端点级精细限流仍由 AbuseProtectionService 负责,本层只做粗粒度兜底。
 * 可用 GLOBAL_RATE_LIMIT_PER_MINUTE 调整(0 = 关闭),单测环境默认跳过。
 */
export function createGlobalRateLimitMiddleware(
  options: { limitPerMinute?: number; enabled?: boolean } = {}
) {
  const rawEnvLimit = process.env.GLOBAL_RATE_LIMIT_PER_MINUTE?.trim();
  const parsedEnvLimit = rawEnvLimit !== undefined && rawEnvLimit !== "" ? Number(rawEnvLimit) : NaN;
  const limit =
    options.limitPerMinute ??
    (Number.isFinite(parsedEnvLimit) && parsedEnvLimit >= 0 ? parsedEnvLimit : DEFAULT_LIMIT_PER_MINUTE);
  const enabled = options.enabled ?? process.env.NODE_ENV !== "test";
  const buckets = new Map<string, Bucket>();

  return function globalRateLimit(request: Request, response: Response, next: NextFunction) {
    if (!enabled || limit <= 0) {
      next();
      return;
    }
    if (request.path !== "/v1" && !request.path.startsWith("/v1/")) {
      next();
      return;
    }

    const ip = request.ip ?? request.socket?.remoteAddress ?? "unknown";
    const now = Date.now();
    const bucket = buckets.get(ip);
    if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
      if (buckets.size >= MAX_TRACKED_IPS) {
        for (const [key, entry] of buckets) {
          if (now - entry.windowStart >= WINDOW_MS) buckets.delete(key);
        }
        while (buckets.size >= MAX_TRACKED_IPS) {
          const oldestKey = buckets.keys().next().value;
          if (oldestKey === undefined) break;
          buckets.delete(oldestKey);
        }
      }
      buckets.set(ip, { windowStart: now, count: 1 });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      response.status(429).json(
        createApiErrorResponse(errorCodes.rateLimited, "请求过于频繁，请稍后再试。")
      );
      return;
    }
    next();
  };
}
