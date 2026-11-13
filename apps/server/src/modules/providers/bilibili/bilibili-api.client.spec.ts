import * as providerFetch from "../provider-fetch";
import {
  BilibiliApiClient,
  isAllowedBilibiliAudioHost,
  isAllowedBilibiliSubtitleHost
} from "./bilibili-api.client";

describe("BilibiliApiClient SSRF protections", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("restricts subtitle and audio CDN hostnames to expected Bilibili suffixes", () => {
    expect(isAllowedBilibiliSubtitleHost("i0.hdslb.com")).toBe(true);
    expect(isAllowedBilibiliSubtitleHost("169.254.169.254")).toBe(false);
    expect(isAllowedBilibiliSubtitleHost("evil-hdslb.com")).toBe(false);

    expect(isAllowedBilibiliAudioHost("upos-sz-mirrorcos.bilivideo.com")).toBe(true);
    expect(isAllowedBilibiliAudioHost("127.0.0.1")).toBe(false);
    expect(isAllowedBilibiliAudioHost("metadata.google.internal")).toBe(false);
  });

  it("routes subtitle fetches through fetchProviderUrl with https upgrade and allowlist", async () => {
    const spy = jest.spyOn(providerFetch, "fetchProviderUrl").mockResolvedValueOnce(
      new Response(JSON.stringify({ body: [{ from: 0, to: 1, content: "line" }] }), { status: 200 })
    );

    const client = new BilibiliApiClient();
    const lines = await client.fetchSubtitleContent("http://i0.hdslb.com/bfs/subtitle/test.json");
    expect(lines).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith(
      new URL("https://i0.hdslb.com/bfs/subtitle/test.json"),
      expect.any(Object),
      expect.any(Number),
      isAllowedBilibiliSubtitleHost,
      { maxRedirects: 2 }
    );
  });

  it("rejects non-200/206 responses in fetchAudioStream instead of returning error bodies", async () => {
    jest
      .spyOn(providerFetch, "fetchProviderUrl")
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
      .mockResolvedValueOnce(new Response("still forbidden", { status: 403 }));

    const client = new BilibiliApiClient();
    await expect(
      client.fetchAudioStream(["http://upos-sz-mirrorcos.bilivideo.com/track.m4s"])
    ).rejects.toThrow("non-200/206");
  });
});
