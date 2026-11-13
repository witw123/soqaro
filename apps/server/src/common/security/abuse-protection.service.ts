import {
  HttpException,
  Injectable,
  Logger,
  HttpStatus,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { RedisService } from "../../infra/redis/redis.service";

export type AbuseDimension = {
  name: string;
  value: string | undefined | null;
};

export type AbuseLimit = {
  limit: number;
  windowMs: number;
};

type LocalBucket = {
  count: number;
  expiresAt: number;
};

@Injectable()
export class AbuseProtectionService {
  private readonly logger = new Logger(AbuseProtectionService.name);
  private readonly localBuckets = new Map<string, LocalBucket>();

  constructor(private readonly redis: RedisService) {}

  async enforce(scope: string, dimensions: AbuseDimension[], policy: AbuseLimit) {
    if (
      (process.env.RATE_LIMIT_DISABLED === "true" && process.env.NODE_ENV !== "production") ||
      process.env.NODE_ENV === "test"
    ) {
      return;
    }

    const normalizedDimensions = dimensions
      .map((dimension) => ({
        name: dimension.name.trim().toLowerCase(),
        value: dimension.value?.trim() || "unknown"
      }))
      .filter((dimension) => dimension.name.length > 0);

    if (normalizedDimensions.length === 0) {
      return;
    }

    if (this.redis.isAvailable()) {
      try {
        const counts = await Promise.all(
          normalizedDimensions.map((dimension) =>
            this.redis.incrementWithTtlMs(
              this.redisKey(scope, dimension.name, dimension.value),
              policy.windowMs
            )
          )
        );
        if (counts.some((count) => count > policy.limit)) {
          throw new HttpException("请求过于频繁，请稍后重试。", HttpStatus.TOO_MANY_REQUESTS);
        }
        return;
      } catch (error) {
        if (error instanceof HttpException) {
          throw error;
        }
        if (process.env.NODE_ENV === "production") {
          throw new ServiceUnavailableException("安全防护服务暂不可用，请稍后重试。");
        }
        this.logger.warn(`Redis abuse protection unavailable; using memory fallback. ${String(error)}`);
      }
    } else if (process.env.NODE_ENV === "production") {
      throw new ServiceUnavailableException("安全防护服务暂不可用，请稍后重试。");
    }

    const now = Date.now();
    if (this.localBuckets.size >= 10_000) {
      // Bucket keys include caller-supplied values (IP, user, room); without a
      // sweep and hard cap, key rotation within a window grows the map unbounded.
      for (const [existingKey, existingBucket] of this.localBuckets) {
        if (existingBucket.expiresAt <= now) {
          this.localBuckets.delete(existingKey);
        }
      }
      while (this.localBuckets.size >= 10_000) {
        const oldestKey = this.localBuckets.keys().next().value;
        if (oldestKey === undefined) break;
        this.localBuckets.delete(oldestKey);
      }
    }
    const exceeded = normalizedDimensions.some((dimension) => {
      const key = this.localKey(scope, dimension.name, dimension.value);
      const current = this.localBuckets.get(key);
      const bucket = !current || current.expiresAt <= now
        ? { count: 0, expiresAt: now + policy.windowMs }
        : current;
      bucket.count += 1;
      this.localBuckets.set(key, bucket);
      return bucket.count > policy.limit;
    });

    if (exceeded) {
      throw new HttpException("请求过于频繁，请稍后重试。", HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private redisKey(scope: string, name: string, value: string) {
    return `soqaro:abuse:${scope.trim().toLowerCase()}:${name}:${hash(value)}`;
  }

  private localKey(scope: string, name: string, value: string) {
    return `${scope.trim().toLowerCase()}:${name}:${hash(value)}`;
  }
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
