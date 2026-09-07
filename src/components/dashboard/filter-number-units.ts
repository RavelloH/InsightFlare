/**
 * Canonical units are the units used by the filter contract and query
 * compiler. Display units are only an editor concern; values are converted
 * back to canonical units before a filter is persisted.
 */
export type FilterNumberCanonicalUnit = "ms" | "ratio" | "px";

export type FilterNumberDisplayUnit =
  | "hours"
  | "minutes"
  | "seconds"
  | "milliseconds"
  | "percent"
  | "per-mille"
  | "px";

export type FilterNumberUnitKey =
  FilterNumberCanonicalUnit | FilterNumberDisplayUnit;

export interface FilterNumberUnitDefinition {
  /** Stable key suitable for select values and persisted UI state. */
  readonly key: FilterNumberUnitKey;
  readonly canonicalUnit: FilterNumberCanonicalUnit;
  /** Number of canonical units represented by one value in this unit. */
  readonly multiplier: number;
}

export interface FilterNumberMetadata {
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export interface FilterNumberFormatOptions {
  readonly locale?: string;
  readonly useGrouping?: boolean;
  readonly minimumFractionDigits?: number;
  readonly maximumFractionDigits?: number;
}

const CANONICAL_UNIT_DEFINITIONS: Readonly<
  Record<FilterNumberCanonicalUnit, FilterNumberUnitDefinition>
> = {
  ms: { key: "ms", canonicalUnit: "ms", multiplier: 1 },
  ratio: { key: "ratio", canonicalUnit: "ratio", multiplier: 1 },
  px: { key: "px", canonicalUnit: "px", multiplier: 1 },
};

/** Display unit definitions. The multiplier is canonical units per display unit. */
export const FILTER_NUMBER_UNIT_DEFINITIONS: Readonly<
  Record<FilterNumberDisplayUnit, FilterNumberUnitDefinition>
> = {
  hours: { key: "hours", canonicalUnit: "ms", multiplier: 60 * 60 * 1000 },
  minutes: { key: "minutes", canonicalUnit: "ms", multiplier: 60 * 1000 },
  seconds: { key: "seconds", canonicalUnit: "ms", multiplier: 1000 },
  milliseconds: {
    key: "milliseconds",
    canonicalUnit: "ms",
    multiplier: 1,
  },
  percent: { key: "percent", canonicalUnit: "ratio", multiplier: 0.01 },
  "per-mille": {
    key: "per-mille",
    canonicalUnit: "ratio",
    multiplier: 0.001,
  },
  px: { key: "px", canonicalUnit: "px", multiplier: 1 },
};

/** Stable display choices for each canonical unit. */
export const FILTER_NUMBER_DISPLAY_UNITS: Readonly<
  Record<FilterNumberCanonicalUnit, readonly FilterNumberDisplayUnit[]>
> = {
  ms: ["hours", "minutes", "seconds", "milliseconds"],
  ratio: ["percent", "per-mille"],
  px: ["px"],
};

function isCanonicalUnit(
  unit: FilterNumberUnitKey,
): unit is FilterNumberCanonicalUnit {
  return unit === "ms" || unit === "ratio" || unit === "px";
}

/** Returns the definition for either a canonical or display unit key. */
export function getFilterNumberUnitDefinition(
  unit: FilterNumberUnitKey | null | undefined,
): FilterNumberUnitDefinition | undefined {
  if (!unit) return undefined;
  if (isCanonicalUnit(unit)) return CANONICAL_UNIT_DEFINITIONS[unit];
  return FILTER_NUMBER_UNIT_DEFINITIONS[unit];
}

export function getFilterNumberDisplayUnits(
  canonicalUnit: FilterNumberCanonicalUnit | null | undefined,
): readonly FilterNumberDisplayUnit[] {
  return canonicalUnit ? FILTER_NUMBER_DISPLAY_UNITS[canonicalUnit] : [];
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

/**
 * Converts a finite value between compatible canonical/display units.
 * Missing units mean that no conversion is requested. Incompatible or
 * overflowing conversions return undefined instead of producing NaN/Infinity.
 */
export function convertFilterNumberValue(
  value: number,
  fromUnit: FilterNumberUnitKey | null | undefined,
  toUnit: FilterNumberUnitKey | null | undefined,
): number | undefined {
  if (!isFiniteNumber(value)) return undefined;
  if (!fromUnit || !toUnit) return value;

  const from = getFilterNumberUnitDefinition(fromUnit);
  const to = getFilterNumberUnitDefinition(toUnit);
  if (!from || !to || from.canonicalUnit !== to.canonicalUnit) {
    return undefined;
  }

  const converted = (value * from.multiplier) / to.multiplier;
  return isFiniteNumber(converted) ? converted : undefined;
}

export function convertCanonicalNumberToDisplay(
  value: number,
  canonicalUnit: FilterNumberCanonicalUnit | null | undefined,
  displayUnit: FilterNumberDisplayUnit | null | undefined,
): number | undefined {
  return convertFilterNumberValue(value, canonicalUnit, displayUnit);
}

export function convertDisplayNumberToCanonical(
  value: number,
  displayUnit: FilterNumberDisplayUnit | null | undefined,
  canonicalUnit: FilterNumberCanonicalUnit | null | undefined,
): number | undefined {
  return convertFilterNumberValue(value, displayUnit, canonicalUnit);
}

const NUMBER_PATTERN =
  /^[+-]?(?:(?:\d+(?:\.\d+)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;

function parseFilterNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed || !NUMBER_PATTERN.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return isFiniteNumber(parsed) ? parsed : undefined;
}

export type FilterNumberTextParts =
  readonly [string] | readonly [string, string];

/** Splits a value or a two-value comma-separated range without trimming it. */
export function splitFilterNumberRange(
  value: string,
): FilterNumberTextParts | undefined {
  if (!value.trim()) return undefined;
  const parts = value.split(",");
  if (parts.length === 1) return [parts[0] ?? ""];
  if (parts.length === 2) return [parts[0] ?? "", parts[1] ?? ""];
  return undefined;
}

/** Recombines already validated range parts in the editor's canonical shape. */
export function joinFilterNumberRange(parts: FilterNumberTextParts): string {
  return parts.length === 1
    ? parts[0]
    : `${parts[0].trim()}, ${parts[1].trim()}`;
}

function completeFilterNumberTextParts(
  parts: readonly (string | undefined)[],
): FilterNumberTextParts | undefined {
  const first = parts[0];
  if (first === undefined) return undefined;
  if (parts.length === 1) return [first];
  const second = parts[1];
  return second === undefined ? undefined : [first, second];
}

/**
 * Converts a single value or a complete two-value range. Empty, partial, and
 * invalid input is returned byte-for-byte so an editor can keep editing it.
 */
export function convertFilterNumberText(
  value: string,
  fromUnit: FilterNumberUnitKey | null | undefined,
  toUnit: FilterNumberUnitKey | null | undefined,
): string {
  if (!fromUnit || !toUnit || fromUnit === toUnit) return value;

  const parts = splitFilterNumberRange(value);
  if (!parts) return value;

  const converted = parts.map((part) => {
    const parsed = parseFilterNumber(part);
    if (parsed === undefined) return undefined;
    const next = convertFilterNumberValue(parsed, fromUnit, toUnit);
    return next === undefined ? undefined : String(next);
  });

  const complete = completeFilterNumberTextParts(converted);
  return complete ? joinFilterNumberRange(complete) : value;
}

export function convertCanonicalTextToDisplay(
  value: string,
  canonicalUnit: FilterNumberCanonicalUnit | null | undefined,
  displayUnit: FilterNumberDisplayUnit | null | undefined,
): string {
  return convertFilterNumberText(value, canonicalUnit, displayUnit);
}

export function convertDisplayTextToCanonical(
  value: string,
  displayUnit: FilterNumberDisplayUnit | null | undefined,
  canonicalUnit: FilterNumberCanonicalUnit | null | undefined,
): string {
  return convertFilterNumberText(value, displayUnit, canonicalUnit);
}

function safeFractionDigits(
  value: number | undefined,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(20, Math.max(0, Math.trunc(value as number)));
}

function formatFiniteNumber(
  value: number,
  options: FilterNumberFormatOptions,
): string {
  if (!isFiniteNumber(value)) return "";
  const maximumFractionDigits = safeFractionDigits(
    options.maximumFractionDigits,
    6,
  );
  const minimumFractionDigits = Math.min(
    maximumFractionDigits,
    safeFractionDigits(options.minimumFractionDigits, 0),
  );
  return new Intl.NumberFormat(options.locale, {
    useGrouping: options.useGrouping ?? false,
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(Object.is(value, -0) ? 0 : value);
}

/** Formats finite numbers or valid number/range text without ever creating NaN. */
export function formatFilterNumber(
  value: number | string,
  options: FilterNumberFormatOptions = {},
): string {
  if (typeof value === "number") return formatFiniteNumber(value, options);

  const parts = splitFilterNumberRange(value);
  if (!parts) return value;
  const formatted = parts.map((part) => {
    const parsed = parseFilterNumber(part);
    return parsed === undefined
      ? undefined
      : formatFiniteNumber(parsed, options);
  });
  const complete = completeFilterNumberTextParts(formatted);
  return complete ? joinFilterNumberRange(complete) : value;
}

/** Converts canonical min/max/step metadata for use by a display input. */
export function toDisplayNumberMetadata(
  metadata: FilterNumberMetadata | undefined,
  canonicalUnit: FilterNumberCanonicalUnit | null | undefined,
  displayUnit: FilterNumberDisplayUnit | null | undefined,
): FilterNumberMetadata | undefined {
  if (!metadata) return undefined;

  const result: { min?: number; max?: number; step?: number } = {};
  for (const key of ["min", "max", "step"] as const) {
    const value = metadata[key];
    if (value === undefined || !isFiniteNumber(value)) continue;
    const converted = convertCanonicalNumberToDisplay(
      value,
      canonicalUnit,
      displayUnit,
    );
    if (converted !== undefined) result[key] = converted;
  }
  return result;
}
