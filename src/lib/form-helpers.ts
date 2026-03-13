export function parseFormBool(value: unknown, fallback = false): boolean {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

export function safeRedirectPath(input: FormDataEntryValue | null | string | undefined, fallback = "/app"): string {
  const raw = String(input || "").trim();
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  return raw;
}

/**
 * Parse request body as a Record regardless of Content-Type.
 * Supports both JSON and FormData submissions.
 */
export async function parseRequestBody(request: Request): Promise<Record<string, unknown>> {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    return (await request.json()) as Record<string, unknown>;
  }
  const formData = await request.formData();
  const result: Record<string, unknown> = {};
  formData.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

/** Safely read a string field from the parsed body. */
export function bodyStr(body: Record<string, unknown>, key: string): string {
  return String(body[key] ?? "").trim();
}

