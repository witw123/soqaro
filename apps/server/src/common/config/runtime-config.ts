import { isIP } from "node:net";

const insecureJwtSecrets = new Set([
  "",
  "replace-this-with-a-long-random-secret",
  "changeme",
  "your-jwt-secret"
]);

const insecureTurnSecrets = new Set([
  "",
  "replace-with-a-turn-shared-secret",
  "changeme",
  "your-turn-shared-secret"
]);

const insecureTurnstileValues = new Set([
  "",
  "replace-with-cloudflare-turnstile-site-key",
  "replace-with-cloudflare-turnstile-secret-key",
  "changeme",
  "your-turnstile-site-key",
  "your-turnstile-secret-key"
]);

const minProductionSecretLength = 16;
const allowedTrustProxySubnets = new Set(["loopback", "linklocal", "uniquelocal"]);

// A ten-member room can use 90 data-side and 18 media-side TURN allocations
// when every endpoint needs relay, plus probes and short-lived recovery
// overlap. Keep enough relay ports for that peak instead of failing halfway
// through a room join.
const minimumTurnRelayPortCount = 256;

export function validateRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV !== "production") {
    return;
  }

  const trustProxy = env.TRUST_PROXY?.trim().toLowerCase();

  if (env.AUTH_FAKE_PERSISTENCE?.trim().toLowerCase() === "true") {
    throw new Error("AUTH_FAKE_PERSISTENCE must be false in production startup.");
  }

  if (env.RATE_LIMIT_DISABLED?.trim().toLowerCase() === "true") {
    throw new Error("RATE_LIMIT_DISABLED must be false in production startup.");
  }

  if (trustProxy === "true") {
    throw new Error("TRUST_PROXY=true is not allowed in production startup.");
  }

  if (trustProxy && trustProxy !== "false" && !isValidProductionTrustProxy(trustProxy)) {
    throw new Error(
      "Production TRUST_PROXY must be false, a non-negative proxy hop count, or a trusted proxy IP/CIDR/subnet list."
    );
  }

  const corsOrigins = (env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (corsOrigins.length === 0) {
    throw new Error("CORS_ORIGINS must be configured in production startup.");
  }

  if (env.NETEASE_ENABLED === "true" && !isValidNeteaseEncryptionKey(env.NETEASE_COOKIE_ENCRYPTION_KEY)) {
    throw new Error(
      "NETEASE_COOKIE_ENCRYPTION_KEY must be a 32-byte hex or base64 key when NetEase is enabled."
    );
  }

  if (env.QQMUSIC_ENABLED === "true" && !isValidQqMusicEncryptionKey(env.QQMUSIC_COOKIE_ENCRYPTION_KEY)) {
    throw new Error(
      "QQMUSIC_COOKIE_ENCRYPTION_KEY must be a 32-byte hex or base64 key when QQ Music is enabled."
    );
  }

  const jwtSecret = env.JWT_SECRET?.trim() ?? "";
  if (insecureJwtSecrets.has(jwtSecret.toLowerCase()) || jwtSecret.length < minProductionSecretLength) {
    throw new Error("Invalid JWT_SECRET for production startup.");
  }

  const auditHashSecret = env.AUDIT_HASH_SECRET?.trim() ?? "";
  if (auditHashSecret.length < minProductionSecretLength) {
    throw new Error("AUDIT_HASH_SECRET must be at least 16 characters in production startup.");
  }

  if (env.TURNSTILE_ENABLED?.trim().toLowerCase() !== "true") {
    throw new Error("TURNSTILE_ENABLED must be true in production startup.");
  }

  const turnstileSiteKey = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  if (insecureTurnstileValues.has(turnstileSiteKey.toLowerCase())) {
    throw new Error("Invalid TURNSTILE_SITE_KEY for production startup.");
  }

  const turnstileSecretKey = env.TURNSTILE_SECRET_KEY?.trim() ?? "";
  if (insecureTurnstileValues.has(turnstileSecretKey.toLowerCase())) {
    throw new Error("Invalid TURNSTILE_SECRET_KEY for production startup.");
  }

  validateTurnConfig(env);

  // Without APP_DOMAIN the Turnstile verification skips hostname binding
  // (turnstile.service), so a token solved for another domain could be accepted.
  if (!env.APP_DOMAIN?.trim()) {
    throw new Error("APP_DOMAIN must be configured in production startup to bind Turnstile tokens.");
  }
}

function validateTurnConfig(env: NodeJS.ProcessEnv) {
  const turnEnabled = env.TURN_ENABLED !== "false";
  const turnProtocols = (env.TURN_PROTOCOLS ?? "udp,tcp,tls")
    .split(",")
    .map((protocol) => protocol.trim().toLowerCase())
    .filter(Boolean);
  if (turnProtocols.length === 0 || turnProtocols.some((protocol) => !["udp", "tcp", "tls"].includes(protocol))) {
    throw new Error("Production TURN_PROTOCOLS must contain only udp, tcp, or tls.");
  }
  if (hasUnsupportedStaticTurnProtocol(env)) {
    throw new Error("Production ICE configuration contains an unsupported TURN transport.");
  }
  const hasStaticTurnConfig = hasStaticTurnIceConfig(env);
  if (!turnEnabled) {
    if (!hasStaticTurnConfig) {
      throw new Error("TURN is required for production startup.");
    }
    return;
  }

  const turnPublicHost = env.TURN_PUBLIC_HOST?.trim() ?? "";
  const appDomain = env.APP_DOMAIN?.trim() ?? "";
  const requestHostAllowlist = (env.TURN_REQUEST_HOST_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const turnSecret = env.TURN_SHARED_SECRET?.trim() ?? "";
  const useRequestHostForTurn = env.TURN_PUBLIC_HOST_USE_REQUEST_HOST === "1";
  if (useRequestHostForTurn && !turnPublicHost && !appDomain && requestHostAllowlist.length === 0) {
    throw new Error(
      "TURN request-host mode requires TURN_PUBLIC_HOST, APP_DOMAIN, or TURN_REQUEST_HOST_ALLOWLIST."
    );
  }
  const hasTurnHostSource = !!turnPublicHost || !!appDomain || useRequestHostForTurn;
  if (turnPublicHost && !useRequestHostForTurn && isLocalHost(turnPublicHost)) {
    throw new Error("TURN_PUBLIC_HOST cannot be localhost in production startup.");
  }
  if (!turnPublicHost && !useRequestHostForTurn && appDomain && isLocalHost(appDomain)) {
    throw new Error("APP_DOMAIN cannot be localhost for TURN in production startup.");
  }
  const hasEphemeralTurnConfig = hasTurnHostSource && !!turnSecret;
  if (hasEphemeralTurnConfig) {
    if (insecureTurnSecrets.has(turnSecret.toLowerCase()) || turnSecret.length < minProductionSecretLength) {
      throw new Error("Invalid TURN_SHARED_SECRET for production startup.");
    }
    validateTurnRelayPortRange(env);
    return;
  }

  if (hasStaticTurnConfig) {
    return;
  }

  if (!hasTurnHostSource) {
    throw new Error("TURN requires TURN_PUBLIC_HOST or APP_DOMAIN in production startup.");
  }

  throw new Error("TURN requires TURN_SHARED_SECRET in production startup.");
}

function isValidProductionTrustProxy(value: string) {
  if (/^\d+$/.test(value)) {
    return true;
  }
  const entries = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return entries.length > 0 && entries.every(isValidTrustProxySubnetEntry);
}

function isValidTrustProxySubnetEntry(entry: string) {
  if (allowedTrustProxySubnets.has(entry)) {
    return true;
  }
  const slashIndex = entry.indexOf("/");
  if (slashIndex === -1) {
    return isIP(entry) !== 0;
  }
  const ip = entry.slice(0, slashIndex);
  const prefixRaw = entry.slice(slashIndex + 1);
  if (!/^\d+$/.test(prefixRaw)) {
    return false;
  }
  const version = isIP(ip);
  const prefix = Number.parseInt(prefixRaw, 10);
  if (version === 4) {
    return prefix >= 0 && prefix <= 32;
  }
  if (version === 6) {
    return prefix >= 0 && prefix <= 128;
  }
  return false;
}

function validateTurnRelayPortRange(env: NodeJS.ProcessEnv) {
  const rawMinPort = env.TURN_MIN_PORT?.trim() ?? "";
  const rawMaxPort = env.TURN_MAX_PORT?.trim() ?? "";
  if (!rawMinPort && !rawMaxPort) {
    // External TURN deployments may manage their relay range outside this
    // application. The bundled production compose file supplies both values.
    return;
  }

  const minPort = Number.parseInt(rawMinPort, 10);
  const maxPort = Number.parseInt(rawMaxPort, 10);
  if (
    !/^\d+$/.test(rawMinPort) ||
    !/^\d+$/.test(rawMaxPort) ||
    !Number.isInteger(minPort) ||
    !Number.isInteger(maxPort) ||
    minPort < 1 ||
    maxPort > 65_535 ||
    minPort > maxPort
  ) {
    throw new Error("TURN_MIN_PORT and TURN_MAX_PORT must define a valid relay port range.");
  }

  if (maxPort - minPort + 1 < minimumTurnRelayPortCount) {
    throw new Error(
      `TURN relay port range must contain at least ${minimumTurnRelayPortCount} ports for ten-member rooms.`
    );
  }
}

function hasStaticTurnIceConfig(env: NodeJS.ProcessEnv) {
  const directTurnUrl = env.NEXT_PUBLIC_TURN_URL?.trim() ?? "";
  if (isTurnUrl(directTurnUrl)) {
    return true;
  }

  const rawJson = env.NEXT_PUBLIC_WEBRTC_ICE_SERVERS?.trim() ?? "";
  if (!rawJson) {
    return false;
  }

  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!Array.isArray(parsed)) {
      return false;
    }

    return parsed.some((server) => {
      if (!server || typeof server !== "object" || !("urls" in server)) {
        return false;
      }

      const urls = (server as { urls?: unknown }).urls;
      if (typeof urls === "string") {
        return isTurnUrl(urls);
      }

      return Array.isArray(urls) && urls.some((value) => typeof value === "string" && isTurnUrl(value));
    });
  } catch {
    return false;
  }
}

export function isValidNeteaseEncryptionKey(value: string | undefined) {
  if (!value?.trim()) {
    return false;
  }

  const normalized = value.trim();
  if (/^[a-f0-9]{64}$/i.test(normalized)) {
    return true;
  }

  try {
    return Buffer.from(normalized, "base64").length === 32;
  } catch {
    return false;
  }
}

export const isValidQqMusicEncryptionKey = isValidNeteaseEncryptionKey;

function hasUnsupportedStaticTurnProtocol(env: NodeJS.ProcessEnv) {
  const values: string[] = [env.NEXT_PUBLIC_TURN_URL?.trim() ?? ""];
  const rawJson = env.NEXT_PUBLIC_WEBRTC_ICE_SERVERS?.trim() ?? "";
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      if (Array.isArray(parsed)) {
        for (const server of parsed) {
          if (!server || typeof server !== "object" || !("urls" in server)) continue;
          const urls = (server as { urls?: unknown }).urls;
          if (typeof urls === "string") values.push(urls);
          else if (Array.isArray(urls)) values.push(...urls.filter((url): url is string => typeof url === "string"));
        }
      }
    } catch {
      return false;
    }
  }
  return values.some((value) => {
    const normalized = value.toLowerCase();
    if (normalized.startsWith("turns:")) {
      return /(?:[?&]transport=)(udp|tls)\b/.test(normalized);
    }
    if (!normalized.startsWith("turn:")) return false;
    const transport = normalized.match(/(?:[?&]transport=)([^&]+)/)?.[1];
    return transport !== undefined && !["udp", "tcp"].includes(transport);
  });
}

function isTurnUrl(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("turn:") || normalized.startsWith("turns:");
}

function isLocalHost(value: string) {
  const firstHost = value.split(",")[0]?.trim().toLowerCase() ?? "";
  const normalized = firstHost.startsWith("[")
    ? firstHost.slice(1, firstHost.indexOf("]") > 0 ? firstHost.indexOf("]") : undefined)
    : firstHost.includes(":") && firstHost.split(":").length <= 2
      ? firstHost.split(":")[0]
      : firstHost;

  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized === "127.0.0.1" ||
    !!normalized?.startsWith("127.")
  );
}
