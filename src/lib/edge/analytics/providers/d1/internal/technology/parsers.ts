import type {
  ClientDimensionKey,
  UtmDimensionKey,
} from "@/lib/edge/analytics/providers/d1/internal/core";

export function parseClientDimensionKey(
  value: string | null,
): ClientDimensionKey | null {
  const normalized = String(value ?? "").trim();
  if (
    normalized === "browser" ||
    normalized === "operatingSystem" ||
    normalized === "osVersion" ||
    normalized === "deviceType" ||
    normalized === "language" ||
    normalized === "screenSize"
  ) {
    return normalized as ClientDimensionKey;
  }
  return null;
}

export function parseUtmDimensionKey(
  value: string | null,
): UtmDimensionKey | null {
  const normalized = String(value ?? "").trim();
  if (
    normalized === "source" ||
    normalized === "medium" ||
    normalized === "campaign" ||
    normalized === "term" ||
    normalized === "content"
  ) {
    return normalized as UtmDimensionKey;
  }
  return null;
}
