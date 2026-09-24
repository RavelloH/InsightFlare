export function epochSecondsToIso(
  value: number | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value * 1000).toISOString();
}

export function normalizeUnknownDirect(value: unknown): {
  key: string;
  label: string;
} {
  const raw = String(value ?? "").trim();
  if (!raw) return { key: "__unknown__", label: "Unknown" };
  if (raw.toLowerCase() === "direct")
    return { key: "__direct__", label: "Direct" };
  return { key: raw, label: raw };
}
