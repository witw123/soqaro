import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadWithDirectFallback } from "./soqaro-api.base";

type FetchCall = { url: string; init?: RequestInit };

function mp4Bytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(size));
  // MP4 / M4A container signature: "ftyp" box at byte offset 4..7
  bytes[4] = 0x66;
  bytes[5] = 0x74;
  bytes[6] = 0x79;
  bytes[7] = 0x70;
  bytes.fill(0x30, 8);
  return bytes;
}

function respond(status: number, body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

function rangeHeader(init?: RequestInit): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers.Range;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("downloadWithDirectFallback", () => {
  it("upgrades http candidates to https before requesting", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return respond(200, new Blob([mp4Bytes(64)]), {
          "content-type": "audio/mp4",
          "content-length": "64",
          "accept-ranges": "bytes"
        });
      })
    );

    const result = await downloadWithDirectFallback({
      resolve: async () => ({
        url: "http://upos.example.com/audio.m4s",
        urls: ["http://upos.example.com/audio.m4s"],
        mimeType: "audio/mp4"
      }),
      fallback: async () => {
        throw new Error("should not fall back");
      }
    });

    expect(calls[0]?.url).toBe("https://upos.example.com/audio.m4s");
    expect(result.contentType).toBe("audio/mp4");
  });

  it("skips failing candidates and downloads from the first healthy one", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.includes("forbidden")) {
          return respond(403, null);
        }
        if (url.includes("broken")) {
          throw new TypeError("Failed to fetch");
        }
        return respond(200, new Blob([mp4Bytes(64)]), {
          "content-type": "audio/mp4",
          "content-length": "64"
        });
      })
    );

    const result = await downloadWithDirectFallback({
      resolve: async () => ({
        url: "https://forbidden.example.com/audio.m4s",
        urls: [
          "https://forbidden.example.com/audio.m4s",
          "https://broken.example.com/audio.m4s",
          "https://healthy.example.com/audio.m4s"
        ],
        mimeType: "audio/mp4"
      }),
      fallback: async () => {
        throw new Error("should not fall back");
      }
    });

    expect(result.blob.size).toBe(64);
    expect(calls.some((call) => call.url.includes("healthy.example.com"))).toBe(true);
  });

  it("does not wait for a hung candidate before using a healthy one", async () => {
    vi.useFakeTimers();
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.includes("hung")) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("probe aborted")));
          });
        }
        return Promise.resolve(
          respond(200, new Blob([mp4Bytes(64)]), {
            "content-type": "audio/mp4",
            "content-length": "64"
          })
        );
      })
    );

    const pending = downloadWithDirectFallback({
      resolve: async () => ({
        url: "https://hung.example.com/audio.m4s",
        urls: ["https://hung.example.com/audio.m4s", "https://healthy.example.com/audio.m4s"],
        mimeType: "audio/mp4"
      }),
      fallback: async () => {
        throw new Error("should not fall back");
      }
    });
    await vi.advanceTimersByTimeAsync(6000);
    const result = await pending;

    expect(result.blob.size).toBe(64);
  });

  it("downloads large range-capable payloads in parallel chunks", async () => {
    const total = 3 * 1024 * 1024;
    const full = mp4Bytes(total);
    const rangeCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const range = rangeHeader(init);
        if (!range) {
          return respond(200, null, {
            "content-type": "audio/mp4",
            "content-length": String(total),
            "accept-ranges": "bytes"
          });
        }
        rangeCalls.push(range);
        const match = range.match(/bytes=(\d+)-(\d+)/);
        const start = Number(match?.[1]);
        const end = Number(match?.[2]);
        return respond(206, new Blob([full.slice(start, end + 1)]), { "content-type": "audio/mp4" });
      })
    );

    const result = await downloadWithDirectFallback({
      resolve: async () => ({
        url: "https://upos.example.com/audio.m4s",
        urls: ["https://upos.example.com/audio.m4s"],
        mimeType: "audio/mp4"
      }),
      fallback: async () => {
        throw new Error("should not fall back");
      }
    });

    expect(rangeCalls).toHaveLength(4);
    expect(result.blob.size).toBe(total);
    expect(result.contentType).toBe("audio/mp4");
  });

  it("falls back to a single download when the CDN ignores range requests", async () => {
    let probeSeen = false;
    const total = 3 * 1024 * 1024;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (!rangeHeader(init)) {
          if (!probeSeen) {
            probeSeen = true;
            return respond(200, null, {
              "content-type": "audio/mp4",
              "content-length": String(total),
              "accept-ranges": "bytes"
            });
          }
          return respond(200, new Blob([mp4Bytes(total)]), { "content-type": "audio/mp4" });
        }
        return respond(200, new Blob([mp4Bytes(1024)]));
      })
    );

    const result = await downloadWithDirectFallback({
      resolve: async () => ({
        url: "https://upos.example.com/audio.m4s",
        urls: ["https://upos.example.com/audio.m4s"],
        mimeType: "audio/mp4"
      }),
      fallback: async () => {
        throw new Error("should not fall back");
      }
    });

    expect(result.blob.size).toBe(total);
  });

  it("falls back to the server proxy when every direct candidate fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(403, null))
    );

    const result = await downloadWithDirectFallback({
      resolve: async () => ({
        url: "https://forbidden.example.com/audio.m4s",
        urls: ["https://forbidden.example.com/audio.m4s"],
        mimeType: "audio/mp4"
      }),
      fallback: async () => ({ blob: new Blob([mp4Bytes(32)]), contentType: "audio/mp4" })
    });

    expect(result.blob.size).toBe(32);
    expect(result.contentType).toBe("audio/mp4");
  });

  it("falls back to the server proxy when CDN stream reading stalls", async () => {
    vi.useFakeTimers();
    let probeSeen = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string) => {
        if (!probeSeen) {
          probeSeen = true;
          return respond(200, null, {
            "content-type": "audio/mp4",
            "content-length": "64"
          });
        }
        // Stalled stream
        const stream = new ReadableStream({
          start() {
            // Never pushes chunks
          }
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "audio/mp4", "content-length": "64" }
        });
      })
    );

    const pending = downloadWithDirectFallback({
      resolve: async () => ({
        url: "https://stalled.example.com/audio.m4s",
        urls: ["https://stalled.example.com/audio.m4s"],
        mimeType: "audio/mp4"
      }),
      fallback: async () => ({ blob: new Blob([mp4Bytes(32)]), contentType: "audio/mp4" }),
      onProgress: () => {}
    });

    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;

    expect(result.blob.size).toBe(32);
    expect(result.contentType).toBe("audio/mp4");
  });

  it("rejects when the outer signal is aborted", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(200, new Blob([mp4Bytes(64)]), { "content-type": "audio/mp4" }))
    );

    const pending = downloadWithDirectFallback({
      resolve: async () => ({
        url: "https://upos.example.com/audio.m4s",
        urls: ["https://upos.example.com/audio.m4s"],
        mimeType: "audio/mp4"
      }),
      fallback: async () => ({ blob: new Blob([mp4Bytes(32)]), contentType: "audio/mp4" }),
      signal: controller.signal
    });
    controller.abort();

    await expect(pending).rejects.toThrow("Download aborted");
  });

  it("skips direct browser probing for referer-protected Bilibili PCDN hosts", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("should not probe referer-protected host in browser");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await downloadWithDirectFallback({
      resolve: async () => ({
        url: "https://upos-sz-mirrorhw.bilivideo.com/audio.m4s",
        urls: [
          "https://upos-sz-mirrorhw.bilivideo.com/audio.m4s",
          "https://b-baacc4.edge.mountaintoys.cn:4483/audio.m4s",
          "https://mcdn.bilivideo.cn/audio.m4s"
        ],
        mimeType: "audio/mp4"
      }),
      fallback: async () => ({ blob: new Blob([mp4Bytes(48)]), contentType: "audio/mp4" })
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.blob.size).toBe(48);
  });
});
