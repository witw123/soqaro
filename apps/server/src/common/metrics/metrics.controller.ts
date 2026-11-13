import { Controller, Get, Header, UnauthorizedException, Headers } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { RedisService } from "../../infra/redis/redis.service";
import { MetricsService } from "./metrics.service";

@Controller()
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService
  ) {}

  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  getMetrics(@Headers("authorization") authorization?: string) {
    const configuredToken = process.env.METRICS_TOKEN?.trim();
    if (process.env.NODE_ENV === "production" && !configuredToken) {
      throw new UnauthorizedException("Metrics authentication is not configured.");
    }
    if (configuredToken) {
      const expected = Buffer.from(`Bearer ${configuredToken}`);
      const actual = Buffer.from(authorization ?? "");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new UnauthorizedException("Metrics authentication required.");
      }
    }
    return this.metrics.renderPrometheus({
      prismaAvailable: this.prisma.isAvailable(),
      redisAvailable: this.redis.isAvailable()
    });
  }
}

