import {
  apiErrorResponseSchema,
  createApiErrorResponse,
  errorCodes
} from "./errors";
import { describe, expect, it } from "vitest";

describe("api error responses", () => {
  it("validates standard error response envelopes", () => {
    expect(
      apiErrorResponseSchema.parse(
        createApiErrorResponse(errorCodes.realtimeUnavailable, "Realtime sync unavailable.")
      )
    ).toEqual({
      code: "REALTIME_UNAVAILABLE",
      message: "Realtime sync unavailable."
    });

    expect(
      apiErrorResponseSchema.parse(
        createApiErrorResponse(errorCodes.bilibiliUnavailable, "Bilibili service unavailable.")
      )
    ).toEqual({
      code: "BILIBILI_UNAVAILABLE",
      message: "Bilibili service unavailable."
    });
  });
});
