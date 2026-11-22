import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildRoomExitHref,
  shouldAcceptIncomingPeerSignalRecoveryGeneration,
  shouldStartRoomRealtimeRuntime
} from "./use-room-runtime";

const hooksDir = dirname(fileURLToPath(import.meta.url));
const readHookSource = (filename: string) =>
  readFileSync(join(hooksDir, filename), "utf8").replace(/\r\n/g, "\n");

describe("v4 room runtime helpers", () => {
  it("routes authenticated room exits to the workspace", () => {
    expect(buildRoomExitHref({
      activeSession: { userId: "user_1" },
      workspaceEntryHref: "/app",
      authEntryHref: "/auth"
    })).toBe("/app");
  });

  it("routes unauthenticated room exits through auth", () => {
    expect(buildRoomExitHref({
      activeSession: null,
      workspaceEntryHref: "/app",
      authEntryHref: "/auth"
    })).toBe("/auth");
  });

  it("starts realtime only after identity and ICE configuration are ready", () => {
    expect(shouldStartRoomRealtimeRuntime({
      roomId: "room_1",
      hydrated: true,
      iceConfigResolved: true,
      peerId: "peer_1"
    })).toBe(true);
    expect(shouldStartRoomRealtimeRuntime({
      roomId: "room_1",
      hydrated: true,
      iceConfigResolved: false,
      peerId: "peer_1"
    })).toBe(false);
  });

  it("rejects stale recovery-generation signals", () => {
    expect(shouldAcceptIncomingPeerSignalRecoveryGeneration({
      payloadRecoveryGeneration: 4,
      currentRecoveryGeneration: 5
    })).toBe(false);
    expect(shouldAcceptIncomingPeerSignalRecoveryGeneration({
      payloadRecoveryGeneration: 5,
      currentRecoveryGeneration: 5
    })).toBe(true);
  });

  it("does not tear down realtime runtime on ICE refresh or unstable callbacks", () => {
    const runtimeSource = readHookSource("use-room-runtime.ts");
    const runtimeEffectMatch = runtimeSource.match(
      /return createRoomRealtimeRuntime\([\s\S]*?\n\s*\}, \[\n(?<deps>[\s\S]*?)\n\s*\]\);/
    );
    expect(runtimeEffectMatch).not.toBeNull();
    const deps = runtimeEffectMatch?.groups?.deps ?? "";
    expect(deps).not.toMatch(/\biceConfig\b/);
    expect(deps).not.toMatch(/\bexitCurrentRoom\b/);
    expect(deps).not.toMatch(/\bisNavigatingRoomExit\b/);
  });

  it("keys the ICE config lifecycle effect on activeSessionUserId instead of activeSession object identity", () => {
    const lifecycleSource = readHookSource("use-room-runtime-lifecycle.ts");
    const iceEffectMatch = lifecycleSource.match(
      /void loadIceConfig\(false\);[\s\S]*?\n\s*\}, \[\n(?<deps>[\s\S]*?)\n\s*\]\);/
    );
    expect(iceEffectMatch).not.toBeNull();
    const deps = iceEffectMatch?.groups?.deps ?? "";
    expect(deps).toMatch(/\bactiveSessionUserId\b/);
    expect(deps).not.toMatch(/\bactiveSession\b/);
  });

  it("restarts the presence heartbeat when room.subscribe applies bootstrap state", () => {
    const realtimeRuntimeSource = readHookSource("room-realtime-runtime.ts");
    const bootstrapBlockMatch = realtimeRuntimeSource.match(
      /if \(bootstrapApplied\) \{[\s\S]*?\n\s*\}/
    );
    expect(bootstrapBlockMatch).not.toBeNull();
    expect(bootstrapBlockMatch?.[0] ?? "").toContain("startPresenceHeartbeatRef.current()");
  });
});
