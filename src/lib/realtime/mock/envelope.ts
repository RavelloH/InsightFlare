import {
  errorEnvelope,
  okEnvelope,
  toErrorCode,
} from "@/lib/response-envelope";

// Demo-mode envelope convenience helpers. These produce bodies whose shape
// matches the real private/public API (src/lib/response.ts): success is
// `{ ok:true, requestId, timestamp, ...body }` and failures are
// `{ ok:false, requestId, timestamp, error:{ code, message, details? } }`.

export { extractErrorMessage, isErrorEnvelope } from "@/lib/response-envelope";

export function demoOk(body: Record<string, unknown>, requestId?: string) {
  return okEnvelope(body, requestId);
}

export function demoErr(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  requestId?: string,
) {
  return errorEnvelope(code, message, details, requestId);
}

export function demoNotFound(message = "Not Found", requestId?: string) {
  return errorEnvelope("not_found", message, undefined, requestId);
}

/** Code is derived from the message via toErrorCode, matching server `bad()`. */
export function demoBadRequest(
  message: string,
  details?: Record<string, unknown>,
  requestId?: string,
) {
  return errorEnvelope(toErrorCode(message), message, details, requestId);
}
