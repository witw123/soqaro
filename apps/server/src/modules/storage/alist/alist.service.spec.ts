import { HttpException, HttpStatus } from "@nestjs/common";
import * as providerFetch from "../../providers/provider-fetch";
import { AlistService } from "./alist.service";

describe("AlistService", () => {
  let service: AlistService;

  beforeEach(() => {
    service = new AlistService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("testConnection", () => {
    it("returns ok true when list succeeds", async () => {
      jest.spyOn(providerFetch, "fetchProviderUrl").mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 200, message: "success" }), { status: 200 })
      );

      const res = await service.testConnection("https://alist.example.com:5244", "/Music");
      expect(res.ok).toBe(true);
      expect(res.message).toContain("连接成功");
    });

    it("returns sanitized message on upstream error code and network errors", async () => {
      jest.spyOn(providerFetch, "fetchProviderUrl").mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 403, message: "internal db stack trace" }), { status: 200 })
      );

      const non200 = await service.testConnection("https://alist.example.com:5244", "/Music");
      expect(non200.ok).toBe(false);
      expect(non200.message).toContain("403");
      expect(non200.message).not.toContain("internal db stack trace");

      jest
        .spyOn(providerFetch, "fetchProviderUrl")
        .mockRejectedValueOnce(new Error("ECONNREFUSED 10.0.0.5:5244 internal"));
      const networkErr = await service.testConnection("https://alist.example.com:5244", "/Music");
      expect(networkErr.ok).toBe(false);
      expect(networkErr.message).not.toContain("ECONNREFUSED");
      expect(networkErr.message).not.toContain("10.0.0.5");
    });
  });

  describe("listDirectory", () => {
    it("filters audio files, matches lrc lyric files, splits artist - title, and drops unsafe entry names", async () => {
      jest.spyOn(providerFetch, "fetchProviderUrl").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 200,
            message: "success",
            data: {
              total: 7,
              content: [
                { name: "SubFolder", size: 0, isDir: true, modified: "2026-01-01" },
                { name: "../escape", size: 0, isDir: true, modified: "2026-01-01" },
                { name: "bad/name.mp3", size: 1000, isDir: false, modified: "2026-01-01" },
                { name: "周杰伦 - 晴天.flac", size: 30000000, isDir: false, modified: "2026-01-01" },
                { name: "周杰伦 - 晴天.lrc", size: 1200, isDir: false, modified: "2026-01-01" },
                { name: "陈奕迅 - 十年.mp3", size: 8000000, isDir: false, modified: "2026-01-01" },
                { name: "image.png", size: 500000, isDir: false, modified: "2026-01-01" }
              ]
            }
          }),
          { status: 200 }
        )
      );

      const result = await service.listDirectory("https://alist.example.com:5244", "/Music");
      expect(result.directories).toEqual(["SubFolder"]);
      expect(result.items).toHaveLength(2);

      const track1 = result.items.find((i) => i.name === "周杰伦 - 晴天.flac")!;
      expect(track1.artist).toBe("周杰伦");
      expect(track1.title).toBe("晴天");
      expect(track1.ext).toBe("flac");
      expect(track1.lrcPath).toBe("/Music/周杰伦 - 晴天.lrc");

      const track2 = result.items.find((i) => i.name === "陈奕迅 - 十年.mp3")!;
      expect(track2.artist).toBe("陈奕迅");
      expect(track2.title).toBe("十年");
      expect(track2.lrcPath).toBeNull();
    });

    it("rejects path traversal in dirPath", async () => {
      await expect(
        service.listDirectory("https://alist.example.com:5244", "/Music/../secret")
      ).rejects.toThrow(HttpException);
    });
  });

  describe("getFileDetail", () => {
    it("returns raw url and size", async () => {
      jest.spyOn(providerFetch, "fetchProviderUrl").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 200,
            message: "success",
            data: {
              raw_url: "https://pan.example.com/download/song.flac",
              size: 45000000,
              name: "song.flac"
            }
          }),
          { status: 200 }
        )
      );

      const res = await service.getFileDetail("https://alist.example.com:5244", "/Music/song.flac");
      expect(res.rawUrl).toBe("https://pan.example.com/download/song.flac");
      expect(res.size).toBe(45000000);
      expect(res.name).toBe("song.flac");
    });

    it("rejects unsafe raw_url schemes", async () => {
      jest.spyOn(providerFetch, "fetchProviderUrl").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 200,
            message: "success",
            data: {
              raw_url: "file:///etc/passwd",
              size: 100,
              name: "passwd"
            }
          }),
          { status: 200 }
        )
      );

      await expect(
        service.getFileDetail("https://alist.example.com:5244", "/Music/song.flac")
      ).rejects.toThrow(HttpException);
    });
  });

  describe("SSRF and MIME protections on fetchAudioStream", () => {
    it("blocks private IP and metadata endpoints via real fetchProviderUrl", async () => {
      await expect(
        service.fetchAudioStream("http://127.0.0.1:5244/d/song.flac")
      ).rejects.toThrow("private address");

      await expect(
        service.fetchAudioStream("http://169.254.169.254/latest/meta-data/")
      ).rejects.toThrow("private address");

      await expect(
        service.fetchAudioStream("http://[::1]:5244/d/song.flac")
      ).rejects.toThrow("private address");
    });

    it("rejects active HTML/SVG MIME types and allows audio and plain lrc text", async () => {
      jest.spyOn(providerFetch, "fetchProviderUrl").mockResolvedValueOnce(
        new Response("<script>alert(1)</script>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        })
      );

      await expect(
        service.fetchAudioStream("https://cdn.example.com/evil.html")
      ).rejects.toMatchObject({ status: HttpStatus.UNSUPPORTED_MEDIA_TYPE });

      jest.spyOn(providerFetch, "fetchProviderUrl").mockResolvedValueOnce(
        new Response("[00:01.00]lyric", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" }
        })
      );

      const lrcResult = await service.fetchAudioStream("https://cdn.example.com/song.lrc");
      expect(lrcResult.mimeType).toBe("text/plain");
    });
  });
});
