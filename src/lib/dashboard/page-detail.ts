export const PAGE_DETAIL_QUERY_PARAM = "pagePath";

export function normalizePagePath(
  value: string | null | undefined,
): string | null {
  const raw = String(value ?? "").trim();
  if (!raw.startsWith("/")) return null;

  const normalized = raw.replace(/\/{2,}/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }

  return normalized || "/";
}

export function slugifyPagePath(value: string): string {
  const normalized = normalizePagePath(value);
  if (!normalized) return "page";
  if (normalized === "/") return "home";

  const slug = normalized
    .slice(1)
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return slug || "page";
}
