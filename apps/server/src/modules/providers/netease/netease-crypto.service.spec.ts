import { NeteaseCryptoService } from "./netease-crypto.service";

describe("NeteaseCryptoService", () => {
  const previousKey = process.env.NETEASE_COOKIE_ENCRYPTION_KEY;

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.NETEASE_COOKIE_ENCRYPTION_KEY;
    } else {
      process.env.NETEASE_COOKIE_ENCRYPTION_KEY = previousKey;
    }
  });

  it("encrypts and decrypts a cookie with a base64 key", () => {
    process.env.NETEASE_COOKIE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const service = new NeteaseCryptoService();
    const encrypted = service.encrypt("MUSIC_U=secret; __csrf=token");

    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toContain("MUSIC_U");
    expect(service.decrypt(encrypted)).toBe("MUSIC_U=secret; __csrf=token");
  });

  it("binds encrypted cookies to the provided AAD user context", () => {
    process.env.NETEASE_COOKIE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const service = new NeteaseCryptoService();
    const encrypted = service.encrypt("MUSIC_U=secret", "user-1");

    expect(service.decrypt(encrypted, "user-1")).toBe("MUSIC_U=secret");
    expect(() => service.decrypt(encrypted, "user-2")).toThrow();
    expect(() => service.decrypt(encrypted)).toThrow();
  });

  it("rejects an invalid encryption key", () => {
    process.env.NETEASE_COOKIE_ENCRYPTION_KEY = "invalid";
    expect(() => new NeteaseCryptoService().encrypt("cookie")).toThrow(
      "NETEASE_COOKIE_ENCRYPTION_KEY"
    );
  });
});
