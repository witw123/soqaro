import { describe, expect, it } from "vitest";
import {
  createInitialRoomPageState,
  roomPageStateReducer
} from "./use-room-page-state";

describe("roomPageStateReducer", () => {
  it("initializes browser visibility and default playback controls", () => {
    expect(createInitialRoomPageState({ documentHidden: true })).toMatchObject({
      activeDashboardTab: "library",
      audioUnlocked: false,
      connectedPeers: [],
      iceConfig: null,
      iceConfigResolved: false,
      isPageVisible: false,
      isRecoveringRoom: false,
      isNavigatingRoomExit: false,
      mediaConnectedPeers: [],
      volume: 0.72,
      playerResetEpoch: 0,
      audioBlockedOverlay: false,
      isDiagnosticsPanelOpen: false,
      suppressRoomRecovery: false
    });
  });

  it("accepts direct values and updater functions like React setState", () => {
    const initial = createInitialRoomPageState({ documentHidden: false });
    const withEpoch = roomPageStateReducer(initial, {
      type: "set",
      key: "playerResetEpoch",
      value: 1
    });
    const withSameEpoch = roomPageStateReducer(withEpoch, {
      type: "set",
      key: "playerResetEpoch",
      value: (current) => (current === 1 ? current : 0)
    });

    expect(withSameEpoch).toBe(withEpoch);
    expect(withSameEpoch.playerResetEpoch).toBe(1);
  });

  it("updates runtime assembly state without losing other page state", () => {
    const initial = createInitialRoomPageState({ documentHidden: false });
    const withPeers = roomPageStateReducer(initial, {
      type: "set",
      key: "connectedPeers",
      value: ["peer_a"]
    });
    const withMorePeers = roomPageStateReducer(withPeers, {
      type: "set",
      key: "connectedPeers",
      value: (current) => [...current, "peer_b"]
    });
    const withRecovery = roomPageStateReducer(withMorePeers, {
      type: "set",
      key: "isRecoveringRoom",
      value: true
    });
    const withVolume = roomPageStateReducer(withRecovery, {
      type: "set",
      key: "volume",
      value: 0.5
    });

    expect(withMorePeers.connectedPeers).toEqual(["peer_a", "peer_b"]);
    expect(withVolume).toMatchObject({
      isRecoveringRoom: true,
      volume: 0.5
    });
  });
});
