import type { TrackerPayloadKind } from "./types";

export const AE_LAYOUT_VERSION = 5;

export const AE_COORDINATE_MISSING = 999;

export const AE_ROW_TYPE_VISIT_START = 0;
export const AE_ROW_TYPE_VISIT_FINALIZE = 1;
export const AE_ROW_TYPE_CUSTOM_EVENT = 2;

const DEVICE_TYPE_CODE_BY_VALUE = new Map<string, number>([
  ["desktop", 1],
  ["mobile", 2],
  ["tablet", 3],
  ["smarttv", 4],
  ["console", 5],
  ["wearable", 6],
  ["embedded", 7],
  ["other", 255],
]);

const DEVICE_TYPE_VALUE_BY_CODE = new Map<number, string>(
  [...DEVICE_TYPE_CODE_BY_VALUE.entries()].map(([value, code]) => [code, value]),
);

const CONTINENT_CODE_BY_VALUE = new Map<string, number>([
  ["AF", 1],
  ["AN", 2],
  ["AS", 3],
  ["EU", 4],
  ["NA", 5],
  ["OC", 6],
  ["SA", 7],
  ["OTHER", 255],
]);

const CONTINENT_VALUE_BY_CODE = new Map<number, string>(
  [...CONTINENT_CODE_BY_VALUE.entries()].map(([value, code]) => [code, value === "OTHER" ? "other" : value]),
);

export function encodeAeRowType(kind: TrackerPayloadKind): number {
  switch (kind) {
    case "visit_start":
      return AE_ROW_TYPE_VISIT_START;
    case "visit_finalize":
      return AE_ROW_TYPE_VISIT_FINALIZE;
    case "custom_event":
      return AE_ROW_TYPE_CUSTOM_EVENT;
  }
}

export function encodeAeDeviceType(value: string): number {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return 0;
  return DEVICE_TYPE_CODE_BY_VALUE.get(normalized) ?? 255;
}

export function decodeAeDeviceType(code: number): string {
  if (!Number.isFinite(code)) return "";
  return DEVICE_TYPE_VALUE_BY_CODE.get(Math.trunc(code)) ?? "";
}

export function encodeAeContinent(value: string): number {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return 0;
  return CONTINENT_CODE_BY_VALUE.get(normalized) ?? 255;
}

export function decodeAeContinent(code: number): string {
  if (!Number.isFinite(code)) return "";
  return CONTINENT_VALUE_BY_CODE.get(Math.trunc(code)) ?? "";
}

export function toAeCoordinate(value: number | null | undefined): number {
  return Number.isFinite(value) ? Number(value) : AE_COORDINATE_MISSING;
}
