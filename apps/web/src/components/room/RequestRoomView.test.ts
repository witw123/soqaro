import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const requestRoomSource = readFileSync(new URL("./RequestRoomView.tsx", import.meta.url), "utf8");

describe("RequestRoomView layout", () => {
  it("removes the giant RoomStage turntable and provides a balanced split layout", () => {
    expect(requestRoomSource).not.toContain("<RoomStage");
    expect(requestRoomSource).not.toContain('data-testid="request-now-playing-banner"');
    expect(requestRoomSource).toContain("lg:grid-cols-[minmax(0,1.3fr)_minmax(22rem,0.9fr)]");
  });

  it("integrates request search, inbox, queue, and library into a unified station", () => {
    expect(requestRoomSource).toContain("<RequestInbox");
    expect(requestRoomSource).toContain("<RequestHistory");
    expect(requestRoomSource).toContain("<RoomProviderTrackSearch");
    expect(requestRoomSource).toContain("<PlayerQueueList");
    expect(requestRoomSource).toContain("<LibraryTabPanel");
    expect(requestRoomSource).toContain("<LocalStorageTabPanel");
    expect(requestRoomSource).toContain("<MembersPanel");
    expect(requestRoomSource).not.toContain("<RoomReactionToolbar");
    expect(requestRoomSource).toContain('data-testid="request-queue-panel"');
  });
});
