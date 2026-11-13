import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomDirectoryItem } from "@soqaro/shared";
import { RoomDirectoryCard } from "./RoomDirectoryCard";

function createSampleDirectoryItem(): RoomDirectoryItem {
  return {
    room: {
      id: "room_bgm_1",
      name: "系错BGM电台",
      description: "测试房间描述",
      joinCode: "BGM123",
      visibility: "public",
      hasPassword: false,
      roomType: "interactive",
      playbackStatus: "playing",
      directoryOnlineMemberCount: 0,
      directoryQueueDepth: 43,
      directoryPendingRequestCount: 0,
      directoryBroadcastState: "off_air",
      directoryNowPlaying: {
        title: "新しい日の誕生",
        artist: "2814",
        album: "新しい日の誕生",
        artworkUrl: null,
        durationMs: 320000
      },
      createdAt: "2026-11-13T00:00:00.000Z",
      updatedAt: "2026-11-13T00:00:00.000Z"
    }
  } as unknown as RoomDirectoryItem;
}

describe("RoomDirectoryCard", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a full interactive card by default and a vacated modal slot when expanded to modal", () => {
    const item = createSampleDirectoryItem();

    const defaultHtml = renderToStaticMarkup(
      createElement(RoomDirectoryCard, {
        room: item,
        onOpen: () => {}
      })
    );

    expect(defaultHtml).not.toContain('data-morphed-to-modal="true"');
    expect(defaultHtml).not.toContain('data-testid="room-directory-card-morphed-slot"');
    expect(defaultHtml).toContain("系错BGM电台");

    const morphedHtml = renderToStaticMarkup(
      createElement(RoomDirectoryCard, {
        room: item,
        isExpandedToModal: true,
        onOpen: () => {}
      })
    );

    expect(morphedHtml).toContain('data-morphed-to-modal="true"');
    expect(morphedHtml).toContain('data-testid="room-directory-card-morphed-slot"');
    expect(morphedHtml).toContain("disabled");
    expect(morphedHtml).toContain("invisible");
  });
});
