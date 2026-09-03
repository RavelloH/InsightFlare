/**
 * Shared Analytics Engine contract primitives.
 *
 * Slot names are intentionally kept in the schema-specific modules. This
 * module only contains values that are common to every dataset.
 */

export const ANALYTICS_ENGINE_SCHEMA_VERSION = 2 as const;
export const ANALYTICS_ENGINE_MAX_BLOBS = 20 as const;
export const ANALYTICS_ENGINE_MAX_DOUBLES = 20 as const;
export const ANALYTICS_ENGINE_INDEXES = ["siteId"] as const;
export const ANALYTICS_ENGINE_INDEX_COUNT =
  ANALYTICS_ENGINE_INDEXES.length as 1;

export const REQUEST_ANALYTICS_DATASET = "insightflare_request_events" as const;
export const TRAFFIC_ANALYTICS_DATASET = "insightflare_traffic_events" as const;
export const EVENT_ANALYTICS_DATASET = "insightflare_event_facts" as const;

export type AnalyticsEngineDatasetName =
  | typeof REQUEST_ANALYTICS_DATASET
  | typeof TRAFFIC_ANALYTICS_DATASET
  | typeof EVENT_ANALYTICS_DATASET;

export const DIMENSION_CODE_VERSION = 1 as const;
export const DIMENSION_FAMILIES = [
  "country",
  "continent",
  "deviceType",
  "trafficChannel",
] as const;
export type DimensionFamily = (typeof DIMENSION_FAMILIES)[number];

export const DIMENSION_FAMILY_IDS: Record<DimensionFamily, number> = {
  country: 1,
  continent: 2,
  deviceType: 3,
  trafficChannel: 4,
};

export const DIMENSION_ENUM_VALUES = {
  continent: ["AF", "AN", "AS", "EU", "NA", "OC", "SA", "XX"],
  deviceType: [
    "desktop",
    "mobile",
    "tablet",
    "smart_tv",
    "console",
    "wearable",
    "unknown",
  ],
  trafficChannel: [
    "direct",
    "organic",
    "referral",
    "social",
    "email",
    "paid",
    "display",
    "affiliate",
    "unknown",
  ],
} as const;

export interface DimensionCodeInput {
  dimension: DimensionFamily;
  value: string;
}

export interface DecodedDimensionCode {
  dimension: DimensionFamily;
  value: string;
}

type DimensionCodeObjectInput =
  | DimensionCodeInput
  | { family: DimensionFamily; value: string }
  | { kind: DimensionFamily; value: string }
  | Partial<Record<DimensionFamily, string>>;

const DIMENSION_VERSION_MULTIPLIER = 2 ** 32;
const DIMENSION_FAMILY_MULTIPLIER = 2 ** 24;
const DIMENSION_VALUE_MASK = DIMENSION_FAMILY_MULTIPLIER - 1;

function dimensionCodeParts(
  input: DimensionFamily | DimensionCodeObjectInput,
  value?: string,
): DimensionCodeInput | null {
  if (typeof input === "string") {
    return value === undefined ? null : { dimension: input, value };
  }
  if (
    "dimension" in input &&
    typeof input.dimension === "string" &&
    typeof input.value === "string"
  ) {
    return { dimension: input.dimension, value: input.value };
  }
  if (
    "family" in input &&
    typeof input.family === "string" &&
    typeof input.value === "string"
  ) {
    return { dimension: input.family, value: input.value };
  }
  if (
    "kind" in input &&
    typeof input.kind === "string" &&
    typeof input.value === "string"
  ) {
    return { dimension: input.kind, value: input.value };
  }
  const dimensionValues = input as Partial<Record<DimensionFamily, string>>;
  for (const dimension of DIMENSION_FAMILIES) {
    if (typeof dimensionValues[dimension] === "string") {
      return { dimension, value: dimensionValues[dimension] };
    }
  }
  return null;
}

function dimensionValueCode(dimension: DimensionFamily, value: string): number {
  if (dimension === "country" || dimension === "continent") {
    const normalized = value.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(normalized)) return 0;
    return (
      (normalized.charCodeAt(0) - 65) * 32 + (normalized.charCodeAt(1) - 65) + 1
    );
  }
  const normalized = value.trim().toLowerCase();
  const values = DIMENSION_ENUM_VALUES[dimension];
  const index = values.indexOf(normalized as never);
  return index < 0 ? 0 : index + 1;
}

/**
 * Encode a canonical finite dimension value into one stable numeric code.
 * The version/family/value bit budget leaves family ids 5-255 for future
 * dimensions and 24 bits for each family's value registry.
 */
export function encodeDimensionCode(
  input: DimensionFamily | DimensionCodeObjectInput,
  value?: string,
): number {
  const parts = dimensionCodeParts(input, value);
  if (!parts) return 0;
  const familyId = DIMENSION_FAMILY_IDS[parts.dimension];
  const valueId = dimensionValueCode(parts.dimension, parts.value);
  if (!familyId || !valueId) return 0;
  return (
    DIMENSION_CODE_VERSION * DIMENSION_VERSION_MULTIPLIER +
    familyId * DIMENSION_FAMILY_MULTIPLIER +
    valueId
  );
}

function decodeDimensionValue(
  dimension: DimensionFamily,
  valueId: number,
): string | null {
  if (dimension === "country" || dimension === "continent") {
    const compactValue = valueId - 1;
    const first = Math.floor(compactValue / 32);
    const second = compactValue % 32;
    if (first < 0 || first > 25 || second < 0 || second > 25) return null;
    return String.fromCharCode(65 + first, 65 + second);
  }
  const value = DIMENSION_ENUM_VALUES[dimension][valueId - 1];
  return value ?? null;
}

export function decodeDimensionCode(code: number): DecodedDimensionCode | null {
  if (!Number.isSafeInteger(code) || code <= 0) return null;
  const version = Math.floor(code / DIMENSION_VERSION_MULTIPLIER);
  if (version !== DIMENSION_CODE_VERSION) return null;
  const remainder = code % DIMENSION_VERSION_MULTIPLIER;
  const familyId = Math.floor(remainder / DIMENSION_FAMILY_MULTIPLIER);
  const valueId = remainder & DIMENSION_VALUE_MASK;
  const dimension = DIMENSION_FAMILIES.find(
    (candidate) => DIMENSION_FAMILY_IDS[candidate] === familyId,
  );
  if (!dimension || valueId <= 0) return null;
  const value = decodeDimensionValue(dimension, valueId);
  return value ? { dimension, value } : null;
}

export const encodeDimension = encodeDimensionCode;
export const decodeDimension = decodeDimensionCode;

/** The subset of a Cloudflare Analytics Engine binding used by writers. */
export interface AnalyticsEngineDatasetBinding {
  writeDataPoint(point: {
    indexes?: string[];
    blobs?: string[];
    doubles?: number[];
  }): void;
}

export interface AnalyticsEnginePoint {
  indexes: [string];
  blobs: string[];
  doubles: number[];
}

export interface AnalyticsEngineBindings {
  REQUEST_ANALYTICS?: AnalyticsEngineDatasetBinding;
  TRAFFIC_ANALYTICS?: AnalyticsEngineDatasetBinding;
  EVENT_ANALYTICS?: AnalyticsEngineDatasetBinding;
}

export function isAnalyticsEnginePointWithinLimits(
  point: Pick<AnalyticsEnginePoint, "blobs" | "doubles">,
): boolean {
  return (
    point.blobs.length <= ANALYTICS_ENGINE_MAX_BLOBS &&
    point.doubles.length === ANALYTICS_ENGINE_MAX_DOUBLES
  );
}
