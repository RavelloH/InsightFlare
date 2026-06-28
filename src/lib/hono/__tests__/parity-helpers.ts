import { expect } from "vitest";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface NormalizedResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  json: JsonValue | null;
}

const DYNAMIC_JSON_KEYS = new Set(["requestId", "timestamp", "date", "now"]);

const COMPARED_HEADERS = [
  "access-control-allow-origin",
  "cache-control",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "location",
  "set-cookie",
  "vary",
  "x-edge-cache",
] as const;

function normalizeSetCookie(value: string): string {
  if (!value) return "";
  return value
    .split(/,(?=\s*[^;,]+=)/)
    .map((cookie) =>
      cookie
        .replace(/(if_session=)[^;]*/g, "$1<token>")
        .replace(/(Max-Age=)\d+/gi, "$1<number>")
        .trim(),
    )
    .join(", ");
}

function normalizeJson(value: unknown): JsonValue | null {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item) as JsonValue);
  }
  if (value && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (DYNAMIC_JSON_KEYS.has(key)) continue;
      out[key] = normalizeJson(child) as JsonValue;
    }
    return out;
  }
  return null;
}

function normalizeHeader(name: string, value: string): string {
  if (name.toLowerCase() === "set-cookie") {
    return normalizeSetCookie(value);
  }
  return value;
}

export async function normalizeResponse(
  response: Response,
): Promise<NormalizedResponse> {
  const clone = response.clone();
  const bodyText = await clone.text();
  let json: JsonValue | null = null;
  try {
    json = normalizeJson(JSON.parse(bodyText));
  } catch {
    json = null;
  }

  const headers: Record<string, string> = {};
  for (const name of COMPARED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = normalizeHeader(name, value);
  }

  return {
    status: response.status,
    headers,
    bodyText: json === null ? bodyText : "",
    json,
  };
}

export async function expectResponsesToMatch(
  actual: Response,
  expected: Response,
): Promise<void> {
  expect(await normalizeResponse(actual)).toEqual(
    await normalizeResponse(expected),
  );
}
