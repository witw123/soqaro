import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const nullBodyStatuses = new Set([101, 204, 205, 304]);
const maxRedirects = 3;

export type ProviderFetchOptions = {
  allowSyntheticDns?: boolean;
  allowHttp?: boolean;
  maxRedirects?: number;
};

type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

export async function fetchProviderUrl(
  initialUrl: URL,
  init: RequestInit,
  timeoutMs: number,
  isAllowedHost: (hostname: string) => boolean,
  options: ProviderFetchOptions = {}
) {
  let url = new URL(initialUrl.toString());
  let currentInit: RequestInit = {
    ...init,
    headers: new Headers(init.headers)
  };
  const redirectLimit = Math.max(0, Math.min(maxRedirects, options.maxRedirects ?? maxRedirects));

  for (let redirectCount = 0; redirectCount <= redirectLimit; redirectCount += 1) {
    const resolvedAddresses = await assertSafeProviderUrl(url, isAllowedHost, options);
    const response = await fetchWithHeadersTimeout(url, currentInit, timeoutMs, resolvedAddresses);

    if (!redirectStatuses.has(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirectCount === redirectLimit) {
      throw new Error("Provider returned too many or invalid redirects.");
    }

    const nextUrl = new URL(location, url);
    currentInit = sanitizeRedirectInit(currentInit, response.status, url, nextUrl);
    url = nextUrl;
  }

  throw new Error("Provider returned too many redirects.");
}

function sanitizeRedirectInit(
  init: RequestInit,
  status: number,
  previousUrl: URL,
  nextUrl: URL
): RequestInit {
  const headers = new Headers(init.headers);
  headers.delete("host");
  if (nextUrl.origin !== previousUrl.origin) {
    headers.delete("cookie");
    headers.delete("authorization");
    headers.delete("proxy-authorization");
  }

  const method = (init.method ?? "GET").toUpperCase();
  const shouldDowngradeToGet =
    status === 303 || ((status === 301 || status === 302) && method === "POST");
  if (shouldDowngradeToGet) {
    headers.delete("content-length");
    headers.delete("content-type");
    return {
      ...init,
      method: "GET",
      headers,
      body: undefined
    };
  }

  return {
    ...init,
    headers
  };
}

async function assertSafeProviderUrl(
  url: URL,
  isAllowedHost: (hostname: string) => boolean,
  options: ProviderFetchOptions
): Promise<ResolvedAddress[]> {
  const protocolAllowed = options.allowHttp
    ? url.protocol === "https:" || url.protocol === "http:"
    : url.protocol === "https:" && (url.port === "" || url.port === "443");

  if (
    !protocolAllowed ||
    !url.hostname ||
    url.username ||
    url.password ||
    !isAllowedHost(url.hostname)
  ) {
    throw new Error("Provider returned an unsupported URL.");
  }

  const bareHost = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const ipVersion = isIP(bareHost);
  const resolved: ResolvedAddress[] = ipVersion
    ? [{ address: bareHost, family: ipVersion as 4 | 6 }]
    : (await lookup(bareHost, { all: true, verbatim: true })).map((entry) => ({
        address: entry.address,
        family: entry.family as 4 | 6
      }));

  const addresses = resolved.map((entry) => entry.address);

  // Some development/network proxies map public provider names to the
  // RFC 2544 benchmark range. It is not routable on the public Internet, but
  // the proxy still needs the original hostname for the request. Only accept
  // this special case when explicitly enabled (non-production or opt-in env)
  // and every resolved address is from that range.
  const syntheticDnsAllowed =
    options.allowSyntheticDns === true &&
    (process.env.NODE_ENV !== "production" || process.env.ALLOW_SYNTHETIC_PROXY_DNS === "true");
  const isSyntheticProxyResolution =
    syntheticDnsAllowed &&
    addresses.length > 0 &&
    addresses.every(isSyntheticProxyAddress);
  if (addresses.length === 0 || (addresses.some(isPrivateAddress) && !isSyntheticProxyResolution)) {
    throw new Error("Provider URL resolved to a private address.");
  }

  return resolved;
}

async function fetchWithHeadersTimeout(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  resolvedAddresses: ResolvedAddress[]
): Promise<Response> {
  const bodyBuffer = await serializeRequestBody(init.body);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });
  if (bodyBuffer !== null && !("content-length" in headers)) {
    headers["content-length"] = String(bodyBuffer.byteLength);
  }

  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");

  const pinnedLookup = (
    _hostname: string,
    lookupOptions: unknown,
    callback: (...args: unknown[]) => void
  ) => {
    const wantsAll =
      typeof lookupOptions === "object" &&
      lookupOptions !== null &&
      "all" in lookupOptions &&
      Boolean((lookupOptions as { all?: boolean }).all);
    if (wantsAll) {
      callback(null, resolvedAddresses);
      return;
    }
    const first = resolvedAddresses[0]!;
    callback(null, first.address, first.family);
  };

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const externalSignal = init.signal;
    if (externalSignal?.aborted) {
      reject(externalSignal.reason ?? new Error("Request aborted."));
      return;
    }

    const request = transport.request(
      {
        protocol: url.protocol,
        hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: (init.method ?? "GET").toUpperCase(),
        headers,
        lookup: pinnedLookup as never,
        ...(isHttps && !isIP(hostname) ? { servername: hostname } : {})
      },
      (res) => {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", onAbort);
        if (settled) {
          res.resume();
          return;
        }
        settled = true;

        const responseHeaders = new Headers();
        for (let index = 0; index < res.rawHeaders.length; index += 2) {
          const name = res.rawHeaders[index];
          const value = res.rawHeaders[index + 1];
          if (name !== undefined && value !== undefined) {
            responseHeaders.append(name, value);
          }
        }

        const status = res.statusCode ?? 502;
        const body = nullBodyStatuses.has(status)
          ? null
          : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
        resolve(
          new Response(body, {
            status,
            statusText: res.statusMessage ?? "",
            headers: responseHeaders
          })
        );
      }
    );

    const fail = (error: unknown) => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const onAbort = () => {
      const reason = externalSignal?.reason ?? new Error("Request aborted.");
      request.destroy(reason instanceof Error ? reason : new Error(String(reason)));
      fail(reason);
    };

    const timer = setTimeout(() => {
      const error = new Error(`Provider request timed out after ${timeoutMs}ms.`);
      request.destroy(error);
      fail(error);
    }, timeoutMs);

    externalSignal?.addEventListener("abort", onAbort, { once: true });
    request.on("error", fail);

    if (bodyBuffer !== null) {
      request.write(bodyBuffer);
    }
    request.end();
  });
}

async function serializeRequestBody(body: RequestInit["body"] | null | undefined): Promise<Buffer | null> {
  if (body === null || body === undefined) {
    return null;
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  if (body instanceof URLSearchParams) {
    return Buffer.from(body.toString(), "utf8");
  }
  throw new Error("Unsupported provider request body type.");
}

export function isPrivateAddress(address: string) {
  if (isIP(address) === 4) {
    return isPrivateIpv4(address);
  }

  if (isIP(address) !== 6) {
    return true;
  }

  const bytes = parseIpv6(address);
  if (!bytes) {
    return true;
  }

  const isAllZero = bytes.every((value) => value === 0);
  const isLoopback = bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1;
  const isIpv4Mapped = bytes.slice(0, 10).every((value) => value === 0) && bytes[10] === 255 && bytes[11] === 255;
  const isIpv4Compatible = bytes.slice(0, 12).every((value) => value === 0);
  const isIpv4Translated =
    bytes.slice(0, 8).every((value) => value === 0) &&
    bytes[8] === 255 &&
    bytes[9] === 255 &&
    bytes[10] === 0 &&
    bytes[11] === 0;

  if (isIpv4Mapped || isIpv4Compatible || isIpv4Translated) {
    return isPrivateIpv4(bytes.slice(12));
  }

  const first = bytes[0];
  const second = bytes[1];
  const isDiscard = first === 0x01 && second === 0x00 && bytes.slice(2, 8).every((value) => value === 0);
  const isTeredo = first === 0x20 && second === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00;
  const is6to4 = first === 0x20 && second === 0x02;
  const isNat64WellKnown =
    first === 0x00 &&
    second === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((value) => value === 0);
  const isNat64Local =
    first === 0x00 &&
    second === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0x00 &&
    bytes[5] === 0x01;

  return isAllZero ||
    isLoopback ||
    isDiscard ||
    isTeredo ||
    is6to4 ||
    isNat64WellKnown ||
    isNat64Local ||
    first === 0xff ||
    (first & 0xfe) === 0xfc ||
    (first === 0xfe && (second & 0xc0) === 0x80) ||
    (first === 0xfe && (second & 0xc0) === 0xc0);
}

function isPrivateIpv4(value: string | number[]) {
  const octets = typeof value === "string" ? value.split(".").map(Number) : value;
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true;
  }

  const [first, second, third] = octets;
  return first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && (second === 0 || (second === 0 && third === 113))) ||
    first >= 224;
}

function isSyntheticProxyAddress(address: string) {
  const octets = address.split(".").map(Number);
  return octets.length === 4 &&
    octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) &&
    octets[0] === 198 &&
    (octets[1] === 18 || octets[1] === 19);
}

function parseIpv6(address: string) {
  const normalized = address.toLowerCase().split("%")[0];
  const sections = normalized.split("::");
  if (sections.length > 2) {
    return null;
  }

  const parseSection = (section: string) => {
    if (!section) return [];
    const parts = section.split(":");
    const values: number[] = [];
    for (const part of parts) {
      if (part.includes(".")) {
        const octets = part.split(".").map(Number);
        if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
        values.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      values.push(Number.parseInt(part, 16));
    }
    return values;
  };

  const left = parseSection(sections[0]);
  const right = parseSection(sections[1] ?? "");
  if (!left || !right) return null;

  const missing = sections.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (sections.length === 2 && missing === 0)) return null;
  const groups = sections.length === 2 ? [...left, ...Array<number>(missing).fill(0), ...right] : left;
  if (groups.length !== 8) return null;

  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}
