import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const radioRoomSource = readFileSync(new URL("./RadioRoomView.tsx", import.meta.url), "utf8");
const chatSource = readFileSync(new URL("./RoomChatOverlay.tsx", import.meta.url), "utf8");

describe("RadioRoomView layout", () => {
  it("removes the giant RoomStage turntable and provides a balanced split layout", () => {
    expect(radioRoomSource).not.toContain("<RoomStage");
    expect(radioRoomSource).not.toContain('data-testid="radio-now-playing-banner"');
    expect(radioRoomSource).toContain("lg:grid-cols-[minmax(0,1.3fr)_minmax(22rem,0.9fr)]");
  });

  it("organizes broadcast desk, queue, library, and audience interactions cleanly", () => {
    expect(radioRoomSource).toContain("<HostBroadcastDesk");
    expect(radioRoomSource).toContain("<PlayerQueueList");
    expect(radioRoomSource).toContain("<RadioLibraryList");
    expect(radioRoomSource).toContain("<RoomChatPanel");
    expect(radioRoomSource).toContain("<RadioMembersPanel");
    expect(radioRoomSource).not.toContain("<RoomReactionToolbar");
    expect(radioRoomSource).toContain('data-testid="radio-queue-panel"');
  });

  it("lets chat scrolling hand control back to the room page at its boundary", () => {
    expect(chatSource).toContain("flex h-full min-h-[24rem]");
    expect(chatSource).toContain("onClick={onActivateScroll}");
    expect(chatSource).toContain("data-scroll-enabled");
    expect(chatSource).not.toContain("lg:overscroll-contain");
  });

  it("matches the reference chat message hierarchy", () => {
    expect(chatSource).toContain("text-accent/65");
    expect(chatSource).toContain("rounded-[0.875rem]");
    expect(chatSource).toContain("h-12 w-12");
    expect(chatSource).toContain("getFullYear()");
    expect(chatSource.indexOf("formatChatTime(message.timestamp)")).toBeLessThan(chatSource.indexOf("message.content"));
  });

  it("uses '加入曲库' instead of '加入节目单' for broadcast desk track search", () => {
    expect(radioRoomSource).toContain('mode="import"');
    expect(radioRoomSource).not.toContain('mode="program"');
    expect(radioRoomSource).toContain("加入曲库");
    expect(radioRoomSource).not.toContain("加入电台节目单");
  });
});
