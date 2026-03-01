export function parseFormBool(value: FormDataEntryValue | null, fallback = false): boolean {
  if (value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

export function safeRedirectPath(input: FormDataEntryValue | null, fallback = "/app"): string {
  const raw = String(input || "").trim();
  if (!raw.startsWith("/")) return fallback;
  return raw;
}

