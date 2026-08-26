// Shared response envelope primitives for the browser and mock layers. Their
// shapes mirror the server-side response helpers, so demo mode produces
// byte-for-byte compatible bodies with the real private/public API.
export interface ErrorDetails {
  [key: string]: unknown;
}

export interface ErrorEnvelope {
  ok: false;
  requestId: string;
  timestamp: string;
  error: {
    code: string;
    message: string;
    details?: ErrorDetails;
  };
}

export type SuccessEnvelope = {
  ok: true;
  requestId: string;
  timestamp: string;
} & Record<string, unknown>;

function generateRequestId(): string {
  try {
    return crypto.randomUUID().slice(0, 12);
  } catch {
    return `req_${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function toErrorCode(message: string): string {
  return (
    message
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 64) || "error"
  );
}

export function okEnvelope(
  body: Record<string, unknown>,
  requestId?: string,
): SuccessEnvelope {
  return {
    ok: true,
    requestId: requestId ?? generateRequestId(),
    timestamp: new Date().toISOString(),
    ...body,
  };
}

export function errorEnvelope(
  code: string,
  message: string,
  details?: ErrorDetails,
  requestId?: string,
): ErrorEnvelope {
  return {
    ok: false,
    requestId: requestId ?? generateRequestId(),
    timestamp: new Date().toISOString(),
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}

/** Recognizes a standard failure envelope: `{ ok:false, error: {...} }`. */
export function isErrorEnvelope(payload: unknown): payload is ErrorEnvelope {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  return record.ok === false && record.error !== undefined;
}

/** Extracts a human-readable failure message from an Error or any response body. */
export function extractErrorMessage(
  payload: unknown,
  fallback = "request_failed",
): string {
  if (payload instanceof Error) return payload.message || fallback;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const error = record.error;
    if (error && typeof error === "object") {
      const errorRecord = error as Record<string, unknown>;
      if (typeof errorRecord.message === "string" && errorRecord.message) {
        return errorRecord.message;
      }
      if (typeof errorRecord.code === "string" && errorRecord.code) {
        return errorRecord.code;
      }
    }
    if (typeof error === "string" && error) return error;
    if (typeof record.message === "string" && record.message)
      return record.message;
  }
  if (typeof payload === "string" && payload) return payload;
  return fallback;
}
