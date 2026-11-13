// Same-host fallback note: the request Host is attacker-controllable on
// direct-to-server deployments, so the origin-equals-host fallback here is
// defense-in-depth only. The boundaries that actually protect cookie-mutating
// endpoints are SameSite=strict session cookies and the admin double-submit
// CSRF token; see the audit notes before changing this contract — the
// reverse-proxy same-origin behavior is codified in get-cors-origins.spec.ts.

const defaultCorsOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
  "capacitor://localhost",
  "http://localhost",
  "https://localhost",
  "tauri://localhost",
  "https://tauri.localhost"
];

function normalizeOriginVariant(origin: string) {
  try {
    const parsed = new URL(origin);
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return origin.trim().replace(/\/$/, "");
  }
}

type OriginRequest = {
  protocol?: string;
  headers?: {
    host?: string | string[];
    "x-forwarded-proto"?: string | string[];
  };
  get?: (header: string) => string | undefined;
};

export function getCorsOrigins() {
  const configuredOrigins = process.env.CORS_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configuredOrigins?.length) {
    return [...new Set(configuredOrigins.map(normalizeOriginVariant))];
  }

  if (process.env.NODE_ENV === "production") {
    return [];
  }

  return [...new Set(defaultCorsOrigins.map(normalizeOriginVariant))];
}

export function getRequestOrigin(request: OriginRequest) {
  // Rely on Express's trust-proxy-aware `request.protocol` rather than reading
  // raw `x-forwarded-proto`, which an untrusted direct peer can forge.
  const rawProtocol = request.protocol?.trim().toLowerCase();
  const protocol = rawProtocol === "http" || rawProtocol === "https" ? rawProtocol : null;
  const rawHost = request.get?.("host") ?? request.headers?.host;
  const host = Array.isArray(rawHost) ? rawHost[0]?.trim() : rawHost?.trim();
  if (!protocol || !host) return null;
  return normalizeOriginVariant(`${protocol}://${host}`);
}

export function isAllowedOrigin(
  origin: string | undefined,
  requestOrigin: string | null,
  allowedOrigins = getCorsOrigins()
) {
  if (!origin) return false;
  const normalizedOrigin = normalizeOriginVariant(origin);
  return (
    allowedOrigins.includes(normalizedOrigin) ||
    (requestOrigin !== null && normalizedOrigin === normalizeOriginVariant(requestOrigin))
  );
}
