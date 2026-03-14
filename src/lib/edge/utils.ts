export const TEN_MINUTES_MS = 10 * 60 * 1000;
export const ONE_HOUR_MS = 60 * 60 * 1000;
export const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export function coerceString(input: unknown, fallback = ""): string {
  if (typeof input !== "string") {
    return fallback;
  }
  return input;
}

export function coerceNumber(input: unknown, fallback: number | null = null): number | null {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }
  if (typeof input === "string" && input.length > 0) {
    const parsed = Number(input);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

export function jsonCloneRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function safeHostname(urlLike: string): string {
  if (!urlLike) return "";
  try {
    return new URL(urlLike).hostname;
  } catch {
    return "";
  }
}

function normalizeHostnameForComparison(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, "");
}

export function isSameHostname(left: string, right: string): boolean {
  const normalizedLeft = normalizeHostnameForComparison(left);
  const normalizedRight = normalizeHostnameForComparison(right);
  return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}

export function clampString(input: string, maxLen: number): string {
  if (input.length <= maxLen) {
    return input;
  }
  return input.slice(0, maxLen);
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function deriveDailySalt(secret: string, eventAtMs: number): Promise<string> {
  const dayStamp = new Date(eventAtMs).toISOString().slice(0, 10);
  return sha256Hex(`${secret}:${dayStamp}`);
}

export async function deriveEuVisitorId(input: {
  ip: string;
  ua: string;
  eventAtMs: number;
  secret: string;
}): Promise<string> {
  const dailySalt = await deriveDailySalt(input.secret, input.eventAtMs);
  return sha256Hex(`${input.ip}|${input.ua}|${dailySalt}`);
}

export async function deriveSessionId(input: {
  visitorId: string;
  eventAtMs: number;
  sessionWindowMinutes: number;
}): Promise<string> {
  const windowMs = input.sessionWindowMinutes * 60 * 1000;
  const windowIndex = Math.floor(input.eventAtMs / windowMs);
  return sha256Hex(`${input.visitorId}|${windowIndex}`);
}

export function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

