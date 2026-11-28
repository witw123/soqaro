import * as providerFetch from "../provider-fetch";
import {
  BilibiliApiClient,
  isAllowedBilibiliAudioHost,
  isAllowedBilibiliSubtitleHost,
  sortBilibiliAudioUrls
} from "./bilibili-api.client";
import { BilibiliWbiSigner } from "./bilibili-wbi";

describe("BilibiliApiClient SSRF protections", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("restricts subtitle and audio CDN hostnames to expected Bilibili suffixes", () => {
    expect(isAllowedBilibiliSubtitleHost("i0.hdslb.com")).toBe(true);
    expect(isAllowedBilibiliSubtitleHost("169.254.169.254")).toBe(false);
    expect(isAllowedBilibiliSubtitleHost("evil-hdslb.com")).toBe(false);

    expect(isAllowedBilibiliAudioHost("upos-sz-mirrorcos.bilivideo.com")).toBe(true);
    expect(isAllowedBilibiliAudioHost("b-baacc4.edge.mountaintoys.cn")).toBe(true);
    expect(isAllowedBilibiliAudioHost("127.0.0.1")).toBe(false);
    expect(isAllowedBilibiliAudioHost("metadata.google.internal")).toBe(false);
  });

  it("prioritizes official upos mirrors ahead of cn PCDN and MCDN nodes", () => {
    const sorted = sortBilibiliAudioUrls(
      "https://cn-sh-cc-01-13.bilivideo.com/track.m4s",
      [
        "https://b-baacc4.edge.mountaintoys.cn:4483/track.m4s",
        "https://upos-sz-mirrorhw.bilivideo.com/track.m4s"
      ]
    );
    expect(sorted).toEqual([
      "https://upos-sz-mirrorhw.bilivideo.com/track.m4s",
      "https://cn-sh-cc-01-13.bilivideo.com/track.m4s",
      "https://b-baacc4.edge.mountaintoys.cn:4483/track.m4s"
    ]);
  });

  it("refreshes guest cookies and retries WBI playurl once on -412 WAF rejection", async () => {
    const client = new BilibiliApiClient();
    const guestSpy = jest
      .spyOn(client, "getGuestCookies")
      .mockResolvedValueOnce("buvid3=stale")
      .mockResolvedValueOnce("buvid3=fresh");
    jest.spyOn(BilibiliWbiSigner, "sign").mockResolvedValue("bvid=BV1Test&cid=1&w_rid=abc&wts=1");
    const fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: -412, message: "WAF blocked" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            message: "0",
            data: { dash: { audio: [{ id: 30280, baseUrl: "https://upos-sz-mirrorhw.bilivideo.com/1.m4s", bandwidth: 192000, codecs: "mp4a" }] } }
          }),
          { status: 200 }
        )
      );

    const data = await client.getPlayUrl("BV1Test", 1);
    expect(data.dash?.audio).toHaveLength(1);
    expect(guestSpy).toHaveBeenNthCalledWith(1);
    expect(guestSpy).toHaveBeenNthCalledWith(2, true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not cache buvid-less fallback cookies when homepage and spi fail to return buvid3", async () => {
    const client = new BilibiliApiClient();
    const fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("home failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: -1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { b_3: "REAL_B3", b_4: "REAL_B4" } }), { status: 200 }));

    const first = await client.getGuestCookies();
    expect(first).toContain("buvid3=auto");
    // Second call must hit upstream again rather than reusing an unauthenticated fallback.
    const second = await client.getGuestCookies();
    expect(second).toContain("buvid3=REAL_B3");
    expect(second).toContain("buvid4=REAL_B4");
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("refreshes guest cookies and retries searchVideo on HTTP 412", async () => {
    const client = new BilibiliApiClient();
    const guestSpy = jest
      .spyOn(client, "getGuestCookies")
      .mockResolvedValueOnce("buvid3=stale")
      .mockResolvedValueOnce("buvid3=fresh");
    const fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("blocked", { status: 412 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: { result: [{ bvid: "BV1SearchOk", title: "晴天", author: "周杰伦", duration: "04:29", pic: "" }], numResults: 1 }
          }),
          { status: 200 }
        )
      );

    const result = await client.searchVideo("晴天", 1, 10);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.bvid).toBe("BV1SearchOk");
    expect(guestSpy).toHaveBeenNthCalledWith(2, true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
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
      { maxRedirects: 2, allowSyntheticDns: true }
    );
  });

  it("rejects non-200/206 responses in fetchAudioStream instead of returning error bodies", async () => {
    const spy = jest
      .spyOn(providerFetch, "fetchProviderUrl")
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
      .mockResolvedValueOnce(new Response("still forbidden", { status: 403 }));

    const client = new BilibiliApiClient();
    await expect(
      client.fetchAudioStream(["http://upos-sz-mirrorcos.bilivideo.com/track.m4s"])
    ).rejects.toThrow("non-200/206");
    expect(spy).toHaveBeenCalledWith(
      new URL("https://upos-sz-mirrorcos.bilivideo.com/track.m4s"),
      expect.any(Object),
      expect.any(Number),
      expect.any(Function),
      { maxRedirects: 3, allowNonStandardPorts: true, allowSyntheticDns: true }
    );
  });
});
