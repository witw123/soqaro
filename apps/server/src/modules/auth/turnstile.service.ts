import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";

const siteverifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

type SiteverifyResponse = {
  success?: boolean;
  action?: string;
  hostname?: string;
};

@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);

  getPublicConfig() {
    const enabled = this.isEnabled();
    return {
      enabled,
      siteKey: enabled ? process.env.TURNSTILE_SITE_KEY?.trim() ?? "" : ""
    };
  }

  async verify(token: string | undefined, remoteIp: string) {
    if (!this.isEnabled()) {
      return;
    }

    if (!token) {
      throw new BadRequestException("请完成人机验证后再继续。");
    }

    const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
    if (!secret) {
      this.logger.error("TURNSTILE_SECRET_KEY is not configured while Turnstile is enabled.");
      throw new ServiceUnavailableException("人机验证服务暂不可用，请稍后重试。");
    }

    const form = new URLSearchParams({ secret, response: token });
    if (remoteIp && remoteIp !== "unknown") {
      form.set("remoteip", remoteIp);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    let response: Response;
    try {
      response = await fetch(siteverifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
        signal: controller.signal
      });
    } catch (error) {
      this.logger.warn(`Turnstile verification request failed: ${String(error)}`);
      throw new ServiceUnavailableException("人机验证服务暂不可用，请稍后重试。");
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      this.logger.warn(`Turnstile verification returned HTTP ${response.status}.`);
      throw new ServiceUnavailableException("人机验证服务暂不可用，请稍后重试。");
    }

    let result: SiteverifyResponse;
    try {
      result = (await response.json()) as SiteverifyResponse;
    } catch (error) {
      this.logger.warn(`Turnstile verification returned invalid JSON: ${String(error)}`);
      throw new ServiceUnavailableException("人机验证服务暂不可用，请稍后重试。");
    }

    if (
      result.success !== true ||
      result.action !== "auth" ||
      !this.matchesConfiguredHostname(result.hostname)
    ) {
      throw new BadRequestException("人机验证未通过，请重试。");
    }
  }

  private isEnabled() {
    return process.env.TURNSTILE_ENABLED?.trim().toLowerCase() === "true";
  }

  private matchesConfiguredHostname(hostname: string | undefined) {
    const configuredDomain = process.env.APP_DOMAIN?.trim().toLowerCase();
    if (!configuredDomain) {
      return true;
    }

    if (!hostname) {
      return false;
    }

    let expectedHostname: string;
    try {
      const candidateUrl = /^https?:\/\//.test(configuredDomain)
        ? configuredDomain
        : `https://${configuredDomain}`;
      expectedHostname = new URL(candidateUrl).hostname.toLowerCase();
    } catch {
      return false;
    }

    if (!expectedHostname) {
      return false;
    }

    return hostname.trim().toLowerCase() === expectedHostname;
  }
}
