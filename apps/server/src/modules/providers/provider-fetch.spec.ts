jest.mock("node:dns/promises", () => ({
  lookup: jest.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }])
}));

import { EventEmitter } from "node:events";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { PassThrough } from "node:stream";
import { fetchProviderUrl, isPrivateAddress } from "./provider-fetch";

const mockedLookup = lookup as jest.MockedFunction<typeof lookup>;

type MockResponseSpec = {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
};

function mockHttpsSequence(responses: MockResponseSpec[]) {
  const capturedOptions: Array<Record<string, unknown>> = [];
  const spy = jest.spyOn(https, "request").mockImplementation(((
    options: Record<string, unknown>,
    callback?: (res: unknown) => void
  ) => {
    capturedOptions.push(options);
    const spec = responses.shift() ?? { statusCode: 200, headers: {}, body: "" };
    const req = new EventEmitter() as EventEmitter & {
      write: jest.Mock;
      end: jest.Mock;
      destroy: jest.Mock;
    };
    req.write = jest.fn();
    req.destroy = jest.fn();
    req.end = jest.fn(() => {
      const res = new PassThrough() as PassThrough & {
        statusCode?: number;
        statusMessage?: string;
        headers: Record<string, string>;
        rawHeaders: string[];
      };
      res.statusCode = spec.statusCode;
      res.statusMessage = spec.statusCode === 200 ? "OK" : "Redirect";
      res.headers = spec.headers ?? {};
      res.rawHeaders = Object.entries(res.headers).flatMap(([k, v]) => [k, v]);
      callback?.(res);
      if (spec.body) {
        res.write(spec.body);
      }
      res.end();
    });
    return req as never;
  }) as never);

  return { spy, capturedOptions };
}

describe("provider URL safeguards", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSyntheticEnv = process.env.ALLOW_SYNTHETIC_PROXY_DNS;

  afterEach(() => {
    jest.restoreAllMocks();
    mockedLookup.mockClear();
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    process.env.NODE_ENV = originalNodeEnv;
    if (originalSyntheticEnv === undefined) {
      delete process.env.ALLOW_SYNTHETIC_PROXY_DNS;
    } else {
      process.env.ALLOW_SYNTHETIC_PROXY_DNS = originalSyntheticEnv;
    }
  });

  it("blocks private IPv4-mapped and transition IPv6 addresses", () => {
    expect(isPrivateAddress("::ffff:172.16.0.1")).toBe(true);
    expect(isPrivateAddress("0:0:0:0:0:ffff:7f00:1")).toBe(true);
    expect(isPrivateAddress("100::1")).toBe(true);
    expect(isPrivateAddress("2001::1")).toBe(true);
    expect(isPrivateAddress("2002:0a00:0001::1")).toBe(true);
    expect(isPrivateAddress("64:ff9b::127.0.0.1")).toBe(true);
    expect(isPrivateAddress("64:ff9b:1::1")).toBe(true);
    expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);
  });

  it("blocks bracketed loopback IPv6 literals", async () => {
    await expect(
      fetchProviderUrl(
        new URL("http://[::1]:5244/api/fs/list"),
        {},
        1_000,
        () => true,
        { allowHttp: true }
      )
    ).rejects.toThrow("private address");
  });

  it("rejects redirects that leave HTTPS", async () => {
    const { spy } = mockHttpsSequence([
      {
        statusCode: 302,
        headers: { location: "http://cdn.example.com/audio.mp3" }
      }
    ]);

    await expect(
      fetchProviderUrl(
        new URL("https://cdn.example.com/audio.mp3"),
        {},
        1_000,
        (hostname) => hostname.endsWith(".example.com")
      )
    ).rejects.toThrow("unsupported URL");

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("strips Cookie and Authorization on cross-origin redirects and pins resolved DNS", async () => {
    mockedLookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never)
      .mockResolvedValueOnce([{ address: "93.184.216.35", family: 4 }] as never);

    const { spy, capturedOptions } = mockHttpsSequence([
      {
        statusCode: 302,
        headers: { location: "https://other.example.com/final.mp3" }
      },
      {
        statusCode: 200,
        headers: { "content-type": "audio/mpeg" },
        body: "ok"
      }
    ]);

    const response = await fetchProviderUrl(
      new URL("https://cdn.example.com/audio.mp3"),
      {
        headers: {
          Cookie: "secret=1",
          Authorization: "Bearer abc",
          Host: "cdn.example.com",
          Range: "bytes=0-10"
        }
      },
      1_000,
      (hostname) => hostname.endsWith(".example.com")
    );

    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(mockedLookup).toHaveBeenCalledTimes(2);

    const redirectedHeaders = capturedOptions[1]!.headers as Record<string, string>;
    expect(redirectedHeaders.cookie).toBeUndefined();
    expect(redirectedHeaders.authorization).toBeUndefined();
    expect(redirectedHeaders.host).toBeUndefined();
    expect(redirectedHeaders.range).toBe("bytes=0-10");

    const pinnedLookup = capturedOptions[0]!.lookup as (
      host: string,
      opts: { all?: boolean },
      cb: (err: unknown, addr: unknown, family?: number) => void
    ) => void;
    let resolvedAddr: unknown;
    pinnedLookup("cdn.example.com", { all: true }, (_err, addr) => {
      resolvedAddr = addr;
    });
    expect(resolvedAddr).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("gates synthetic benchmark-range DNS aliases outside opt-in development", async () => {
    mockedLookup.mockResolvedValue([{ address: "198.18.0.143", family: 4 }] as never);
    const { spy } = mockHttpsSequence([
      {
        statusCode: 200,
        headers: { "content-type": "audio/mpeg" }
      }
    ]);

    await expect(
      fetchProviderUrl(
        new URL("https://m10.music.126.net/audio.mp3"),
        {},
        1_000,
        (hostname) => hostname.endsWith(".126.net")
      )
    ).rejects.toThrow("private address");

    process.env.NODE_ENV = "production";
    await expect(
      fetchProviderUrl(
        new URL("https://m10.music.126.net/audio.mp3"),
        {},
        1_000,
        (hostname) => hostname.endsWith(".126.net"),
        { allowSyntheticDns: true }
      )
    ).rejects.toThrow("private address");

    process.env.NODE_ENV = "test";
    await expect(
      fetchProviderUrl(
        new URL("https://m10.music.126.net/audio.mp3"),
        {},
        1_000,
        (hostname) => hostname.endsWith(".126.net"),
        { allowSyntheticDns: true }
      )
    ).resolves.toMatchObject({ status: 200 });

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
