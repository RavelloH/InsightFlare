import { measureExternalFetch } from "./observability-bindings";
import type { InvocationLogger } from "./observability-logger";

export type TurnstileVerifyError =
  | "missing_token"
  | "siteverify_failed"
  | "hostname_mismatch"
  | "network_error"
  | "invalid_response";

export type TurnstileVerifyResult =
  | {
      ok: true;
      hostname: string;
    }
  | {
      ok: false;
      reason: TurnstileVerifyError;
      errorCodes: string[];
    };

interface TurnstileSiteverifyPayload {
  success?: boolean;
  hostname?: string;
  "error-codes"?: unknown;
}

interface VerifyTurnstileTokenInput {
  requireSiteverifyUrl?: boolean;
  secret: string;
  token: string;
  remoteIp?: string;
  expectedHostname?: string;
  siteverifyUrl?: string;
  logger?: InvocationLogger;
}

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function errorCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, 12);
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function hostnameMatches(actual: string, expected: string): boolean {
  const normalizedActual = normalizeHostname(actual);
  const normalizedExpected = normalizeHostname(expected);
  if (!normalizedActual || !normalizedExpected) return true;
  if (
    normalizedExpected === "localhost" ||
    normalizedExpected === "127.0.0.1" ||
    normalizedExpected === "::1"
  ) {
    return true;
  }
  return normalizedActual === normalizedExpected;
}

export async function verifyTurnstileToken({
  requireSiteverifyUrl,
  secret,
  token,
  remoteIp,
  expectedHostname,
  siteverifyUrl,
  logger,
}: VerifyTurnstileTokenInput): Promise<TurnstileVerifyResult> {
  const responseToken = token.trim();
  if (!responseToken) {
    return { ok: false, reason: "missing_token", errorCodes: [] };
  }
  const configuredSiteverifyUrl = siteverifyUrl?.trim();
  if (requireSiteverifyUrl && !configuredSiteverifyUrl) {
    return { ok: false, reason: "network_error", errorCodes: [] };
  }

  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", responseToken);
  if (remoteIp) body.set("remoteip", remoteIp);

  let response: Response;
  try {
    response = await measureExternalFetch(
      logger,
      "external_fetch.turnstile",
      () =>
        fetch(configuredSiteverifyUrl || SITEVERIFY_URL, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
        }),
    );
  } catch {
    return { ok: false, reason: "network_error", errorCodes: [] };
  }

  let payload: TurnstileSiteverifyPayload;
  try {
    payload = (await response.json()) as TurnstileSiteverifyPayload;
  } catch {
    return { ok: false, reason: "invalid_response", errorCodes: [] };
  }

  const codes = errorCodes(payload["error-codes"]);
  if (!response.ok || payload.success !== true) {
    return { ok: false, reason: "siteverify_failed", errorCodes: codes };
  }

  const hostname = typeof payload.hostname === "string" ? payload.hostname : "";
  if (
    hostname &&
    expectedHostname &&
    !hostnameMatches(hostname, expectedHostname)
  ) {
    return { ok: false, reason: "hostname_mismatch", errorCodes: [] };
  }

  return { ok: true, hostname };
}
