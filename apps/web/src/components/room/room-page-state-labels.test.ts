import { describe, expect, it } from "vitest";
import { resolveCurrentSourceNickname } from "./RoomWorkspace";

describe("room page state labels", () => {
  it("shows the active source provider instead of the original uploader", () => {
    expect(resolveCurrentSourceNickname([
      { id: "uploader", nickname: "Uploader" },
      { id: "provider", nickname: "Provider" }
    ], "provider")).toBe("Provider");
  });
});
