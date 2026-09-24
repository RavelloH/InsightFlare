import type {
  TrackerUaBrandVersion,
  TrackerUaClientHints,
} from "@/lib/edge/types";
const MAX_BRAND_ITEMS = 8;
const MAX_FORM_FACTOR_ITEMS = 8;
function trimString(input: unknown, maxLength: number): string {
  if (typeof input !== "string") return "";
  return input.trim().slice(0, maxLength);
}
function normalizeBrandVersionList(input: unknown): TrackerUaBrandVersion[] {
  if (!Array.isArray(input)) return [];
  const normalized: TrackerUaBrandVersion[] = [];
  for (const item of input.slice(0, MAX_BRAND_ITEMS)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const brand = trimString(record.brand, 80);
    const version = trimString(record.version, 80);
    if (!brand || !version) continue;
    normalized.push({ brand, version });
  }
  return normalized;
}
function normalizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, MAX_FORM_FACTOR_ITEMS)
    .map((item) => trimString(item, 40))
    .filter((item) => item.length > 0);
}
export function normalizeTrackerUaClientHints(
  input: unknown,
): TrackerUaClientHints | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  const normalized: TrackerUaClientHints = {};
  const brands = normalizeBrandVersionList(record.brands);
  const fullVersionList = normalizeBrandVersionList(record.fullVersionList);
  const formFactors = normalizeStringList(record.formFactors);
  const platform = trimString(record.platform, 80);
  const platformVersion = trimString(record.platformVersion, 80);
  const model = trimString(record.model, 120);

  if (brands.length > 0) normalized.brands = brands;
  if (fullVersionList.length > 0) normalized.fullVersionList = fullVersionList;
  if (typeof record.mobile === "boolean") normalized.mobile = record.mobile;
  if (platform) normalized.platform = platform;
  if (platformVersion) normalized.platformVersion = platformVersion;
  if (model) normalized.model = model;
  if (formFactors.length > 0) normalized.formFactors = formFactors;

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
function quoteStructuredString(input: string): string {
  return `"${input.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function serializeBrandVersionList(items: TrackerUaBrandVersion[]): string {
  return items
    .map(
      (item) =>
        `${quoteStructuredString(item.brand ?? "")};v=${quoteStructuredString(
          item.version ?? "",
        )}`,
    )
    .join(", ");
}
function serializeStringList(items: string[]): string {
  return items.map((item) => quoteStructuredString(item)).join(", ");
}
export function mergeUaClientHintsIntoHeaders(
  headers: Record<string, string>,
  input: unknown,
): Record<string, string> {
  const hints = normalizeTrackerUaClientHints(input);
  if (!hints) return headers;

  const next = { ...headers };
  if (hints.brands?.length) {
    next["sec-ch-ua"] = serializeBrandVersionList(hints.brands);
  }
  if (typeof hints.mobile === "boolean") {
    next["sec-ch-ua-mobile"] = hints.mobile ? "?1" : "?0";
  }
  if (hints.platform) {
    next["sec-ch-ua-platform"] = quoteStructuredString(hints.platform);
  }
  if (hints.platformVersion) {
    next["sec-ch-ua-platform-version"] = quoteStructuredString(
      hints.platformVersion,
    );
  }
  if (hints.model) {
    next["sec-ch-ua-model"] = quoteStructuredString(hints.model);
  }
  if (hints.fullVersionList?.length) {
    next["sec-ch-ua-full-version-list"] = serializeBrandVersionList(
      hints.fullVersionList,
    );
  }
  if (hints.formFactors?.length) {
    next["sec-ch-ua-form-factors"] = serializeStringList(hints.formFactors);
  }

  return next;
}
