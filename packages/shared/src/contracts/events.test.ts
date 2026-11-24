import { describe, expect, it } from "vitest";
import { roomChatDeletedPayloadSchema } from "../room/models";
import {
  roomChatInputPayloadSchema,
  roomChatPayloadSchema,
  roomTrackAssetUnavailablePayloadSchema
} from "./events";

describe("websocket event contracts", () => {
  it("parses a room.chat payload", () => {
    expect(
      roomChatPayloadSchema.parse({
        id: "chat_1",
        roomId: "room_1",
        senderId: "user_1",
        senderName: "Alice",
        content: "hello",
        timestamp: Date.now()
      })
    ).toMatchObject({
      id: "chat_1",
      roomId: "room_1",
      senderId: "user_1",
      senderName: "Alice",
      content: "hello"
    });
  });

  it("parses a room.chat.deleted payload", () => {
    expect(
      roomChatDeletedPayloadSchema.parse({ roomId: "room_1", messageId: "chat_1" })
    ).toEqual({ roomId: "room_1", messageId: "chat_1" });
  });

  it("trims and validates client room.chat input", () => {
    expect(
      roomChatInputPayloadSchema.parse({
        roomId: "room_1",
        content: " hello "
      })
    ).toEqual({
      roomId: "room_1",
      content: "hello"
    });

    expect(() =>
      roomChatInputPayloadSchema.parse({
        roomId: "room_1",
        senderId: "forged",
        content: ""
      })
    ).toThrow();
  });

  it("parses a room.track.asset.unavailable payload", () => {
    expect(
      roomTrackAssetUnavailablePayloadSchema.parse({
        roomId: "room_1",
        trackId: "track_1",
        reason: "source-missing"
      })
    ).toEqual({
      roomId: "room_1",
      trackId: "track_1",
      reason: "source-missing"
    });
  });
});
