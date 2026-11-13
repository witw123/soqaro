import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger
} from "@nestjs/common";
import {
  createApiErrorResponse,
  errorCodes,
  type ApiErrorResponse,
  type ErrorCode
} from "@soqaro/shared";
import { ZodError } from "zod";

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== "http") {
      throw exception;
    }

    const context = host.switchToHttp();
    const response = context.getResponse();
    const { status, body } = toHttpApiError(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
    }

    response.status(status).json(body);
  }
}

export function toHttpApiError(exception: unknown): {
  status: number;
  body: ApiErrorResponse;
} {
  if (isZodError(exception)) {
    return {
      status: HttpStatus.BAD_REQUEST,
      body: createApiErrorResponse(
        errorCodes.validationFailed,
        "Invalid request payload.",
        exception.flatten()
      )
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();
    const rawMessage = getExceptionMessage(response, exception.message);
    const explicitCode = getApiErrorCode(response);
    const code = explicitCode ?? (status >= HttpStatus.INTERNAL_SERVER_ERROR
      ? errorCodes.internal
      : mapErrorCode(rawMessage, status));
    const message = publicErrorMessage(
      rawMessage,
      code
    );
    const details = code === errorCodes.internal
      ? undefined
      : typeof response === "object" && response !== null && "details" in response
      ? (response as { details?: unknown }).details
      : undefined;

    return {
      status,
      body: createApiErrorResponse(code, message, details)
    };
  }

  const rawMessage = exception instanceof Error ? exception.message : "Internal server error.";
  const code = mapErrorCode(rawMessage, HttpStatus.INTERNAL_SERVER_ERROR);
  const message = sanitizePlainErrorMessage(rawMessage, code);
  return {
    status: mapErrorStatus(code),
    body: createApiErrorResponse(code, message)
  };
}

function publicErrorMessage(message: string, code: ErrorCode) {
  return code === errorCodes.internal
    ? "Internal server error."
    : message || "Internal server error.";
}

function sanitizePlainErrorMessage(message: string, code: ErrorCode) {
  switch (code) {
    case errorCodes.internal:
      return "Internal server error.";
    case errorCodes.neteaseUnavailable:
      return "NetEase service unavailable.";
    case errorCodes.qqMusicUnavailable:
      return "QQ Music service unavailable.";
    case errorCodes.rateLimited:
      return "Too many requests.";
    case errorCodes.unauthorized:
      return message.includes("Invalid session token") ? "Invalid session token." : "Unauthorized.";
    default:
      return message || "Internal server error.";
  }
}

function isZodError(exception: unknown): exception is ZodError {
  return (
    exception instanceof ZodError ||
    (typeof exception === "object" &&
      exception !== null &&
      (exception as { name?: unknown }).name === "ZodError" &&
      typeof (exception as { flatten?: unknown }).flatten === "function")
  );
}

export function mapErrorCode(message: string, status?: number): ErrorCode {
  if (message.includes("NetEase integration is disabled")) {
    return errorCodes.neteaseDisabled;
  }
  if (message.includes("NetEase account is required")) {
    return errorCodes.neteaseAccountRequired;
  }
  if (message.includes("NetEase account") && message.includes("bound again")) {
    return errorCodes.neteaseAuthExpired;
  }
  if (message.includes("NetEase audio") && message.includes("too large")) {
    return errorCodes.neteaseImportTooLarge;
  }
  if (message.includes("unsupported audio")) {
    return errorCodes.neteaseAudioUnsupported;
  }
  if (message.includes("NetEase")) {
    return errorCodes.neteaseUnavailable;
  }
  if (message.includes("QQ Music integration is disabled")) return errorCodes.qqMusicDisabled;
  if (message.includes("QQ Music account is required")) return errorCodes.qqMusicAccountRequired;
  if (message.includes("QQ Music account") && message.includes("bound again")) return errorCodes.qqMusicAuthExpired;
  if (message.includes("QQ Music audio") && message.includes("too large")) return errorCodes.qqMusicImportTooLarge;
  if (message.includes("QQ Music") && message.includes("unsupported audio")) return errorCodes.qqMusicAudioUnsupported;
  if (message.includes("QQ Music")) return errorCodes.qqMusicUnavailable;

  if (message.includes("Realtime sync unavailable") || message.includes("Redis unavailable")) {
    return errorCodes.realtimeUnavailable;
  }

  if (
    message.includes("Playback state version conflict") ||
    message.includes("Room state revision conflict")
  ) {
    return errorCodes.playbackVersionConflict;
  }

  if (
    message.includes("Track owner is not online") ||
    message.includes("All track uploaders must be online")
  ) {
    return errorCodes.trackOwnerOffline;
  }

  if (
    message.includes("Room not found") ||
    message.includes("room.snapshot.missing") ||
    message.includes("Track not found") ||
    message.includes("Queue item not found") ||
    message.includes("Playlist not found")
  ) {
    return errorCodes.roomNotFound;
  }

  if (
    message.includes("Only room members can perform this action") ||
    message.includes("Only the host") ||
    message.includes("Only the original uploader") ||
    message.includes("Only the playlist owner") ||
    message.includes("does not have the") ||
    message.includes("Room member not found")
  ) {
    return errorCodes.unauthorizedRoomAction;
  }

  if (message.includes("rate limit") || status === HttpStatus.TOO_MANY_REQUESTS) {
    return errorCodes.rateLimited;
  }

  if (message.includes("Invalid username or password")) {
    return errorCodes.invalidCredentials;
  }

  if (
    message.includes("Unauthorized") ||
    message.includes("Invalid session token")
  ) {
    return errorCodes.unauthorized;
  }

  if (
    status === HttpStatus.BAD_REQUEST ||
    message.includes("Username already exists") ||
    message.includes("Queue reorder payload does not match") ||
    message.includes("No tracks from this playlist are available")
  ) {
    return errorCodes.validationFailed;
  }

  if (status === HttpStatus.NOT_FOUND) {
    return errorCodes.roomNotFound;
  }

  if (status === HttpStatus.UNAUTHORIZED) {
    return errorCodes.unauthorized;
  }

  if (status === HttpStatus.FORBIDDEN) {
    return errorCodes.unauthorizedRoomAction;
  }

  if (status === HttpStatus.SERVICE_UNAVAILABLE) {
    return errorCodes.realtimeUnavailable;
  }

  return errorCodes.internal;
}

export function mapErrorStatus(code: ErrorCode): number {
  switch (code) {
    case errorCodes.validationFailed:
      return HttpStatus.BAD_REQUEST;
    case errorCodes.unauthorized:
    case errorCodes.invalidCredentials:
      return HttpStatus.UNAUTHORIZED;
    case errorCodes.rateLimited:
      return HttpStatus.TOO_MANY_REQUESTS;
    case errorCodes.roomNotFound:
      return HttpStatus.NOT_FOUND;
    case errorCodes.playbackVersionConflict:
    case errorCodes.trackOwnerOffline:
      return HttpStatus.CONFLICT;
    case errorCodes.unauthorizedRoomAction:
      return HttpStatus.FORBIDDEN;
    case errorCodes.realtimeUnavailable:
      return HttpStatus.SERVICE_UNAVAILABLE;
    case errorCodes.neteaseUnavailable:
      return HttpStatus.BAD_GATEWAY;
    case errorCodes.neteaseDisabled:
      return HttpStatus.SERVICE_UNAVAILABLE;
    case errorCodes.neteaseAccountRequired:
    case errorCodes.neteaseAuthExpired:
    case errorCodes.neteaseQrExpired:
      return HttpStatus.CONFLICT;
    case errorCodes.neteaseTrackNotFound:
      return HttpStatus.NOT_FOUND;
    case errorCodes.neteaseAudioUnsupported:
      return HttpStatus.UNSUPPORTED_MEDIA_TYPE;
    case errorCodes.neteaseImportTooLarge:
      return HttpStatus.PAYLOAD_TOO_LARGE;
    case errorCodes.qqMusicUnavailable:
      return HttpStatus.BAD_GATEWAY;
    case errorCodes.qqMusicDisabled:
      return HttpStatus.SERVICE_UNAVAILABLE;
    case errorCodes.qqMusicAccountRequired:
    case errorCodes.qqMusicAuthExpired:
    case errorCodes.qqMusicQrExpired:
      return HttpStatus.CONFLICT;
    case errorCodes.qqMusicTrackNotFound:
      return HttpStatus.NOT_FOUND;
    case errorCodes.qqMusicAudioUnsupported:
      return HttpStatus.UNSUPPORTED_MEDIA_TYPE;
    case errorCodes.qqMusicImportTooLarge:
      return HttpStatus.PAYLOAD_TOO_LARGE;
    default:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

function getApiErrorCode(response: string | object): ErrorCode | null {
  if (typeof response !== "object" || response === null || !("code" in response)) {
    return null;
  }

  const code = (response as { code?: unknown }).code;
  return typeof code === "string" && Object.values(errorCodes).includes(code as ErrorCode)
    ? (code as ErrorCode)
    : null;
}

function getExceptionMessage(response: string | object, fallback: string) {
  if (typeof response === "string") {
    return response;
  }

  if (response && typeof response === "object" && "message" in response) {
    const message = (response as { message?: unknown }).message;
    if (Array.isArray(message)) {
      return message.join(", ");
    }
    if (typeof message === "string") {
      return message;
    }
  }

  return fallback || "Internal server error.";
}
