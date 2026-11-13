import {
  Controller,
  Get,
  Headers,
  HttpException,
  InternalServerErrorException,
  Ip,
  Logger,
  Optional,
  Req,
  ServiceUnavailableException,
  UnauthorizedException
} from "@nestjs/common";
import { createApiErrorResponse, errorCodes } from "@soqaro/shared";
import { MetricsService } from "../../common/metrics/metrics.service";
import { AbuseProtectionService } from "../../common/security/abuse-protection.service";
import { resolveClientIp } from "../../common/security/client-ip";
import { AuthService } from "../auth/auth.service";
import { RealtimeService } from "./realtime.service";

@Controller("v1/realtime")
export class RealtimeController {
  private readonly logger = new Logger(RealtimeController.name);

  constructor(
    private readonly realtimeService: RealtimeService,
    private readonly authService: AuthService,
    private readonly metrics: MetricsService,
    @Optional() private readonly abuseProtection?: AbuseProtectionService
  ) {}

  @Get("ice-config")
  async getIceConfig(
    @Headers("x-session-token") sessionToken: string | undefined,
    @Headers("host") host: string | undefined,
    @Req()
    request?: {
      ip?: string;
      hostname?: string;
      socket?: { remoteAddress?: string };
    },
    @Ip() ipAddress?: string
  ) {
    const clientIp = resolveClientIp(request ?? {}, ipAddress);
    await this.abuseProtection?.enforce(
      "realtime:ice-config",
      [{ name: "ip", value: clientIp }],
      { limit: 60, windowMs: 60_000 }
    );

    let userId: string;
    try {
      const session = await this.authService.getAuthSessionByTokenOrThrow(sessionToken);
      userId = session.userId;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Unauthorized.";
      if (message.includes("Account storage is temporarily unavailable")) {
        throw new ServiceUnavailableException("Account storage is temporarily unavailable.");
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
        `Unexpected error verifying ICE config session: ${message}`,
        error instanceof Error ? error.stack : undefined
      );
      throw new InternalServerErrorException("Failed to verify session.");
    }

    // Rely on Express's trust-proxy-aware `request.hostname` rather than raw
    // `x-forwarded-host`, preventing host spoofing from untrusted peers.
    const resolvedRequestHost = request?.hostname?.trim() || host;

    try {
      return this.realtimeService.buildIceConfig(userId, {
        requestHost: resolvedRequestHost
      });
    } catch (error) {
      this.metrics.incrementIceFailure();
      this.logger.error(
        `Failed to build ICE config: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined
      );
      throw new InternalServerErrorException(
        createApiErrorResponse(
          errorCodes.realtimeUnavailable,
          "Failed to build ICE config."
        )
      );
    }
  }
}
