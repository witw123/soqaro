import { errorCodes } from "@soqaro/shared";
import { describe, expect, it } from "vitest";
import { SoqaroApiError } from "@/lib/network/soqaro-api";
import { shouldSuppressRoomRecoveryAfterFailure } from "./use-room-runtime-lifecycle";

describe("shouldSuppressRoomRecoveryAfterFailure", () => {
  it("never suppresses when effect execution was cancelled", () => {
    expect(
      shouldSuppressRoomRecoveryAfterFailure({
        cancelled: true,
        error: new SoqaroApiError("Missing", errorCodes.roomNotFound)
      })
    ).toBe(false);
  });

  it("suppresses only terminal missing or unauthorized errors", () => {
    expect(
      shouldSuppressRoomRecoveryAfterFailure({
        cancelled: false,
        error: new SoqaroApiError("Not found", errorCodes.roomNotFound)
      })
    ).toBe(true);
    expect(
      shouldSuppressRoomRecoveryAfterFailure({
        cancelled: false,
        error: new SoqaroApiError("Closed", errorCodes.roomClosed)
      })
    ).toBe(true);
    expect(
      shouldSuppressRoomRecoveryAfterFailure({
        cancelled: false,
        error: new SoqaroApiError("Forbidden", errorCodes.unauthorizedRoomAction)
      })
    ).toBe(true);
  });

  it("does not suppress transient errors or existing valid snapshots", () => {
    expect(
      shouldSuppressRoomRecoveryAfterFailure({
        cancelled: false,
        error: new Error("Failed to fetch"),
        hasExistingSnapshot: false
      })
    ).toBe(false);
    expect(
      shouldSuppressRoomRecoveryAfterFailure({
        cancelled: false,
        error: new SoqaroApiError("Temp error", errorCodes.internal),
        hasExistingSnapshot: true
      })
    ).toBe(false);
  });
});
