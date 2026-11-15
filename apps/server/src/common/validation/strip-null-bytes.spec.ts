import { stripNullBytes } from "./strip-null-bytes";

describe("stripNullBytes", () => {
  it("recursively removes NUL bytes from strings, arrays, and objects while preserving Dates", () => {
    const createdAt = new Date("2026-11-15T00:00:00.000Z");
    const sanitized = stripNullBytes({
      title: "晴\u0000天\u0000\u0000",
      lyrics: "[00:01.00] 故事的小黄花\u0000",
      tags: ["a\u0000", "b"],
      nested: [{ text: "x\u0000y", count: 2, active: true, empty: null }],
      createdAt
    });

    expect(sanitized).toEqual({
      title: "晴天",
      lyrics: "[00:01.00] 故事的小黄花",
      tags: ["a", "b"],
      nested: [{ text: "xy", count: 2, active: true, empty: null }],
      createdAt
    });
    expect(sanitized.createdAt).toBe(createdAt);
  });
});
