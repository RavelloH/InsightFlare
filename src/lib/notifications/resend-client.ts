import { clampString } from "@/lib/edge/utils";

const RESEND_EMAILS_API_URL = "https://api.resend.com/emails";
const NETWORK_ERROR_MESSAGE = "Unable to reach Resend email API";
const DEFAULT_RETRY_DEADLINE_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 15;
const RETRY_INTERVAL_MS = 1_000;

export interface ResendEmailPayload {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  reply_to?: string;
}

export interface ResendSendResult {
  ok: boolean;
  status: number;
  payload: Record<string, unknown>;
  providerMessageId: string;
  errorMessage: string;
  durationMs: number;
  attempts: number;
  retryCount: number;
  reason?: "provider_failed" | "network_failed";
}

export function buildResendFromAddress(input: {
  fromName: string;
  fromEmail: string;
}): string {
  const name = input.fromName.trim();
  if (!name) return input.fromEmail;
  const escaped = name.replace(/["\\]/g, "");
  return `${escaped} <${input.fromEmail}>`;
}

export function sanitizeProviderError(value: unknown): string {
  if (!value || typeof value !== "object") {
    return clampString(String(value || "provider_error"), 180);
  }
  const record = value as Record<string, unknown>;
  const message =
    (typeof record.message === "string" && record.message) ||
    (typeof record.error === "string" && record.error) ||
    (typeof record.name === "string" && record.name) ||
    "provider_error";
  return clampString(message, 180);
}

function sanitizeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name || "Error";
    const message = error.message || "network_failed";
    return clampString(`${name}: ${message}`, 180);
  }
  return clampString(String(error || "network_failed"), 180);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(input: {
  apiKey: string;
  apiUrl: string;
  body: ResendEmailPayload;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    return await input.fetchImpl.call(globalThis, input.apiUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function sendResendEmailWithRetry(input: {
  apiKey: string;
  apiUrl?: string;
  body: ResendEmailPayload;
  fetchImpl?: typeof fetch;
  deadlineMs?: number;
  maxAttempts?: number;
}): Promise<ResendSendResult> {
  const startedAt = Date.now();
  const deadlineAt =
    startedAt + Math.max(500, input.deadlineMs ?? DEFAULT_RETRY_DEADLINE_MS);
  const maxAttempts = Math.max(
    1,
    Math.trunc(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
  );
  const fetchImpl = input.fetchImpl ?? fetch.bind(globalThis);
  const apiUrl = input.apiUrl || RESEND_EMAILS_API_URL;
  let attempts = 0;
  let status = 0;
  let payload: Record<string, unknown> = {};
  let errorMessage = "";
  let reason: "provider_failed" | "network_failed" = "network_failed";

  while (attempts < maxAttempts && Date.now() < deadlineAt) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < 500) break;
    attempts += 1;
    try {
      const response = await fetchWithTimeout({
        apiKey: input.apiKey,
        apiUrl,
        body: input.body,
        fetchImpl,
        timeoutMs: Math.max(250, Math.min(5_000, remainingMs - 250)),
      });
      status = response.status;
      payload = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (response.ok) {
        return {
          ok: true,
          status,
          payload,
          providerMessageId:
            typeof payload.id === "string" ? clampString(payload.id, 120) : "",
          errorMessage: "",
          durationMs: Date.now() - startedAt,
          attempts,
          retryCount: Math.max(0, attempts - 1),
        };
      }
      reason = "provider_failed";
      errorMessage = sanitizeProviderError(payload);
      if (!isRetryableStatus(response.status)) {
        return {
          ok: false,
          status,
          payload,
          providerMessageId: "",
          errorMessage,
          durationMs: Date.now() - startedAt,
          attempts,
          retryCount: Math.max(0, attempts - 1),
          reason,
        };
      }
    } catch (error) {
      status = 0;
      payload = {};
      reason = "network_failed";
      errorMessage = `${NETWORK_ERROR_MESSAGE}: ${sanitizeNetworkError(error)}`;
    }

    if (attempts >= maxAttempts) break;
    const waitMs = RETRY_INTERVAL_MS;
    if (Date.now() + waitMs >= deadlineAt) break;
    await delay(waitMs);
  }

  return {
    ok: false,
    status,
    payload,
    providerMessageId: "",
    errorMessage: errorMessage || NETWORK_ERROR_MESSAGE,
    durationMs: Date.now() - startedAt,
    attempts,
    retryCount: Math.max(0, attempts - 1),
    reason,
  };
}
