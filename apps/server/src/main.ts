import "reflect-metadata";
import dns from "node:dns";
import { Logger } from "@nestjs/common";

dns.setDefaultResultOrder?.("ipv4first");

import { NestFactory } from "@nestjs/core";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module";
import { validateRuntimeConfig } from "./common/config/runtime-config";
import { getCorsOrigins, getRequestOrigin, isAllowedOrigin } from "./common/cors/get-cors-origins";
import { ApiExceptionFilter } from "./common/errors/api-exception.filter";
import { readUserSessionCookie } from "./modules/auth/auth.cookies";
import { createGlobalRateLimitMiddleware } from "./common/http/global-rate-limit.middleware";

async function bootstrap() {
  validateRuntimeConfig();
  const app = await NestFactory.create(AppModule);
  const trustProxy = resolveTrustProxy();
  const corsOrigins = getCorsOrigins();
  const expressApp = app.getHttpAdapter().getInstance() as {
    set?: (setting: string, value: unknown) => void;
    disable?: (setting: string) => void;
  };
  expressApp.disable?.("x-powered-by");
  if (trustProxy !== false) {
    expressApp.set?.("trust proxy", trustProxy);
  }
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use((request: Request, _response: Response, next: NextFunction) => {
    if (!request.headers["x-session-token"]) {
      const token = readUserSessionCookie(request.headers.cookie);
      if (token) {
        request.headers["x-session-token"] = token;
      }
    }
    next();
  });
  app.use((request: Request, response: Response, next: NextFunction) => {
    const isMutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const hasUserCookie = !!readUserSessionCookie(request.headers.cookie);
    const isPublicAuthEndpoint =
      request.path === "/v1/auth/login" ||
      request.path === "/v1/auth/register";
    if (
      process.env.NODE_ENV === "production" &&
      isMutation &&
      hasUserCookie &&
      !isPublicAuthEndpoint &&
      !isAllowedOrigin(request.headers.origin, getRequestOrigin(request), corsOrigins)
    ) {
      response.status(403).json({
        code: "UNAUTHORIZED",
        message: "Origin validation failed."
      });
      return;
    }
    next();
  });
  app.use(createGlobalRateLimitMiddleware());
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableCors({
    origin: corsOrigins,
    credentials: true
  });
  // SIGTERM 时触发各模块的 onModuleDestroy(watchdog 停表、Redis quit、
  // prisma disconnect 等),保证发布/重启时在途状态落盘。
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  Logger.log(`Soqaro server listening on port ${port}`);
}

bootstrap().catch((error) => {
  Logger.error(`Failed to bootstrap server: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});

function resolveTrustProxy() {
  const configured = process.env.TRUST_PROXY?.trim();
  if (configured) {
    if (configured === "true") {
      return true;
    }
    if (configured === "false") {
      return false;
    }
    const numeric = Number(configured);
    if (Number.isInteger(numeric) && numeric >= 0) {
      return numeric;
    }
    const subnets = configured
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return subnets.length === 1 ? subnets[0] : subnets;
  }

  return process.env.NODE_ENV === "production"
    ? ["loopback", "linklocal", "uniquelocal"]
    : false;
}
