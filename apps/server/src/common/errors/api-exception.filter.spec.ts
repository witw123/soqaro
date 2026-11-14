import { HttpException, HttpStatus } from "@nestjs/common";
import { errorCodes } from "@soqaro/shared";
import { z } from "zod";
import { toHttpApiError } from "./api-exception.filter";

describe("toHttpApiError", () => {
  it("never exposes internal exception details to clients", () => {
    expect(toHttpApiError(new Error("Invalid prisma invocation at /app/server.js"))).toEqual({
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: errorCodes.internal,
        message: "Internal server error."
      }
    });
  });

  it("maps plain business errors to their HTTP status instead of 500", () => {
    expect(toHttpApiError(new Error("Only room members can perform this action."))).toEqual({
      status: HttpStatus.FORBIDDEN,
      body: {
        code: errorCodes.unauthorizedRoomAction,
        message: "Only room members can perform this action."
      }
    });

    expect(toHttpApiError(new Error("Playback state version conflict."))).toEqual({
      status: HttpStatus.CONFLICT,
      body: {
        code: errorCodes.playbackVersionConflict,
        message: "Playback state version conflict."
      }
    });

    expect(toHttpApiError(new Error("Realtime sync unavailable."))).toEqual({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      body: {
        code: errorCodes.realtimeUnavailable,
        message: "Realtime sync unavailable."
      }
    });
  });

  it("maps missing room resources and offline owners to API statuses", () => {
    expect(toHttpApiError(new Error("Track not found in room: track_1"))).toEqual({
      status: HttpStatus.NOT_FOUND,
      body: {
        code: errorCodes.roomNotFound,
        message: "Track not found in room: track_1"
      }
    });

    expect(
      toHttpApiError(
        new Error("Track owner is not online, so this song cannot be played right now.")
      )
    ).toEqual({
      status: HttpStatus.CONFLICT,
      body: {
        code: errorCodes.trackOwnerOffline,
        message: "Track owner is not online, so this song cannot be played right now."
      }
    });
  });

  it("maps ZodError to 400 VALIDATION_FAILED with flattened details", () => {
    const schema = z.object({ reason: z.string().min(1) });
    const parsed = schema.safeParse({ reason: "" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const result = toHttpApiError(parsed.error);
    expect(result.status).toBe(HttpStatus.BAD_REQUEST);
    expect(result.body.code).toBe(errorCodes.validationFailed);
    expect(result.body.message).toBe("Invalid request payload.");
    expect(result.body.details).toEqual(parsed.error.flatten());
  });

  it("sanitizes 5xx HttpException messages without explicit API error code", () => {
    const error = new HttpException("select * from users leaked", HttpStatus.INTERNAL_SERVER_ERROR);
    expect(toHttpApiError(error)).toEqual({
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: errorCodes.internal,
        message: "Internal server error."
      }
    });

    const badGateway = new HttpException("NetEase upstream cookie=abc failed", HttpStatus.BAD_GATEWAY);
    expect(toHttpApiError(badGateway)).toEqual({
      status: HttpStatus.BAD_GATEWAY,
      body: {
        code: errorCodes.internal,
        message: "Internal server error."
      }
    });
  });

  it("sanitizes broad plain-Error matches for upstream/rate-limit/unauthorized", () => {
    expect(toHttpApiError(new Error("Unauthorized: secret session=xyz"))).toEqual({
      status: HttpStatus.UNAUTHORIZED,
      body: {
        code: errorCodes.unauthorized,
        message: "Unauthorized."
      }
    });

    expect(toHttpApiError(new Error("Upstream rate limit hit with key=secret"))).toEqual({
      status: HttpStatus.TOO_MANY_REQUESTS,
      body: {
        code: errorCodes.rateLimited,
        message: "Too many requests."
      }
    });
  });

  it("maps body-parser entity.too.large / 413 errors to 413 VALIDATION_FAILED", () => {
    const payloadTooLarge = Object.assign(new Error("request entity too large"), {
      status: 413,
      statusCode: 413,
      type: "entity.too.large"
    });
    expect(toHttpApiError(payloadTooLarge)).toEqual({
      status: HttpStatus.PAYLOAD_TOO_LARGE,
      body: {
        code: errorCodes.validationFailed,
        message: "Request payload is too large."
      }
    });
  });
});
