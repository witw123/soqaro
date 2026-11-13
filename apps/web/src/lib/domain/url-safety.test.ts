import { describe, expect, it } from "vitest";
import { resolveSafeRedirectPath, sanitizeArtworkUrl, toCssUrlValue } from "./url-safety";

describe("resolveSafeRedirectPath", () => {
  const fallback = "/app";

  it("allows normal internal app routes with query and hash", () => {
    expect(resolveSafeRedirectPath("/rooms/abc?tab=queue#top", fallback)).toBe(
      "/rooms/abc?tab=queue#top"
    );
    expect(resolveSafeRedirectPath(" /app ", fallback)).toBe("/app");
  });

  it("blocks protocol-relative, backslash, and external URLs", () => {
    expect(resolveSafeRedirectPath("//evil.example/phish", fallback)).toBe(fallback);
    expect(resolveSafeRedirectPath("/\\evil.example", fallback)).toBe(fallback);
    expect(resolveSafeRedirectPath("https://evil.example/app", fallback)).toBe(fallback);
    expect(resolveSafeRedirectPath("javascript:alert(1)", fallback)).toBe(fallback);
    expect(resolveSafeRedirectPath("", fallback)).toBe(fallback);
    expect(resolveSafeRedirectPath(null, fallback)).toBe(fallback);
  });
});

describe("sanitizeArtworkUrl", () => {
  it("allows https, upgraded http/protocol-relative, relative paths, blob, and raster data URLs", () => {
    expect(sanitizeArtworkUrl("https://cdn.example.com/cover.jpg")).toBe(
      "https://cdn.example.com/cover.jpg"
    );
    expect(sanitizeArtworkUrl("http://p1.music.126.net/cover.jpg")).toBe(
      "https://p1.music.126.net/cover.jpg"
    );
    expect(sanitizeArtworkUrl("//cdn.example.com/cover.jpg")).toBe(
      "https://cdn.example.com/cover.jpg"
    );
    expect(sanitizeArtworkUrl("/room-covers/1.png")).toBe("/room-covers/1.png");
    expect(sanitizeArtworkUrl("blob:http://localhost:3000/abc")).toBe(
      "blob:http://localhost:3000/abc"
    );
    expect(sanitizeArtworkUrl("data:image/png;base64,AAAA")).toBe(
      "data:image/png;base64,AAAA"
    );
  });

  it("rejects javascript, svg/html data URLs, and CSS breakout characters", () => {
    expect(sanitizeArtworkUrl("javascript:alert(1)")).toBeUndefined();
    expect(sanitizeArtworkUrl("data:text/html,<script>alert(1)</script>")).toBeUndefined();
    expect(sanitizeArtworkUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBeUndefined();
    expect(sanitizeArtworkUrl('https://cdn.example.com/a.jpg");background:url(//x)')).toBeUndefined();
    expect(sanitizeArtworkUrl("https://cdn.example.com/a(1).jpg")).toBeUndefined();
    expect(toCssUrlValue('https://cdn.example.com/a.jpg")')).toBeUndefined();
    expect(toCssUrlValue("https://cdn.example.com/cover.jpg")).toBe(
      'url("https://cdn.example.com/cover.jpg")'
    );
  });
});
