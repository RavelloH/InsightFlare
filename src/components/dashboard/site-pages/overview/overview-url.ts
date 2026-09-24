import { ABSOLUTE_URL_PATTERN } from "./overview-filter-model";

export function sanitizeHostname(value: string): string {
  return value
    .trim()
    .replace(/^[a-z][a-z\d+\-.]*:\/\//i, "")
    .replace(/\/+.*$/, "");
}

export function toAbsoluteHttpsUrl(value: string): string | null {
  const raw = value.trim();
  if (raw.length === 0) return null;
  try {
    if (ABSOLUTE_URL_PATTERN.test(raw)) {
      return new URL(raw).toString();
    }
    if (raw.startsWith("//")) {
      return new URL(`https:${raw}`).toString();
    }
    return new URL(`https://${raw}`).toString();
  } catch {
    return null;
  }
}

export function resolveFaviconUrlForLabel(value: string): string | null {
  const raw = value.trim();
  if (raw.length === 0 || (raw.startsWith("/") && !raw.startsWith("//"))) {
    return null;
  }
  try {
    if (ABSOLUTE_URL_PATTERN.test(raw)) {
      const parsed = new URL(raw);
      return `${parsed.origin}/favicon.ico`;
    }
    if (raw.startsWith("//")) {
      const parsed = new URL(`https:${raw}`);
      return `${parsed.origin}/favicon.ico`;
    }
    const hostname = sanitizeHostname(raw);
    if (!hostname) return null;
    const parsed = new URL(`https://${hostname}`);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

export function leadingLabelLetter(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "?";
  return normalized.slice(0, 1).toUpperCase();
}
