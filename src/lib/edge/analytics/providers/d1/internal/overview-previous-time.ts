import {
  createQueryTime,
  isReportingTimeZone,
} from "@/lib/edge/analytics/contract/helpers";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";

export interface OwnDataProperty {
  readonly present: boolean;
  readonly valid: boolean;
  readonly value?: unknown;
}

const INVALID_SNAPSHOT = Symbol("invalid-overview-snapshot");

/** Clone JSON-compatible request data without reading accessors or calling toJSON. */
export function snapshotOwnDataValue(
  value: unknown,
): unknown | typeof INVALID_SNAPSHOT {
  let visited = 0;
  const active = new WeakSet<object>();
  const clone = (
    current: unknown,
    depth: number,
  ): unknown | typeof INVALID_SNAPSHOT => {
    if (depth > 40 || ++visited > 20_000) return INVALID_SNAPSHOT;
    if (current === undefined) return undefined;
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    )
      return current;
    if (typeof current === "number")
      return Number.isFinite(current) ? current : INVALID_SNAPSHOT;
    if (typeof current !== "object") return INVALID_SNAPSHOT;
    if (active.has(current)) return INVALID_SNAPSHOT;
    active.add(current);
    try {
      if (Array.isArray(current)) {
        const keys = Reflect.ownKeys(current);
        if (
          keys.length !== current.length + 1 ||
          !keys.includes("length") ||
          keys.some(
            (key) =>
              key !== "length" &&
              (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)),
          )
        )
          return INVALID_SNAPSHOT;
        const result: unknown[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            current,
            String(index),
          );
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
            return INVALID_SNAPSHOT;
          const entry = clone(descriptor.value, depth + 1);
          if (entry === INVALID_SNAPSHOT) return INVALID_SNAPSHOT;
          result.push(entry);
        }
        return result;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null)
        return INVALID_SNAPSHOT;
      const result: Record<string, unknown> = Object.create(null) as Record<
        string,
        unknown
      >;
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== "string") return INVALID_SNAPSHOT;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
          return INVALID_SNAPSHOT;
        const entry = clone(descriptor.value, depth + 1);
        if (entry === INVALID_SNAPSHOT) return INVALID_SNAPSHOT;
        result[key] = entry;
      }
      return result;
    } catch {
      return INVALID_SNAPSHOT;
    } finally {
      active.delete(current);
    }
  };
  return clone(value, 0);
}

export function isInvalidOverviewSnapshot(
  value: unknown,
): value is typeof INVALID_SNAPSHOT {
  return value === INVALID_SNAPSHOT;
}

/** Serialize a prior own-data snapshot without invoking any toJSON method. */
export function serializeOwnDataSnapshot(value: unknown): string | undefined {
  let visited = 0;
  const serialize = (current: unknown, depth: number): string | undefined => {
    if (depth > 40 || ++visited > 20_000) return undefined;
    if (current === undefined) return "null";
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean")
      return JSON.stringify(current);
    if (typeof current === "number")
      return Number.isFinite(current) ? JSON.stringify(current) : undefined;
    if (typeof current !== "object") return undefined;
    try {
      if (Array.isArray(current)) {
        const parts: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            current,
            String(index),
          );
          if (!descriptor || !("value" in descriptor)) return undefined;
          const part = serialize(descriptor.value, depth + 1);
          if (part === undefined) return undefined;
          parts.push(part);
        }
        return `[${parts.join(",")}]`;
      }
      const parts: string[] = [];
      for (const key of Object.keys(current).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !("value" in descriptor)) return undefined;
        if (descriptor.value === undefined) continue;
        const part = serialize(descriptor.value, depth + 1);
        if (part === undefined) return undefined;
        parts.push(`${JSON.stringify(key)}:${part}`);
      }
      return `{${parts.join(",")}}`;
    } catch {
      return undefined;
    }
  };
  return serialize(value, 0);
}

export function readOwnDataProperty(
  value: unknown,
  key: PropertyKey,
): OwnDataProperty {
  if (typeof value !== "object" || value === null)
    return { present: false, valid: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { present: false, valid: true };
    if (!descriptor.enumerable || !("value" in descriptor))
      return { present: true, valid: false };
    return { present: true, valid: true, value: descriptor.value };
  } catch {
    return { present: true, valid: false };
  }
}

function exactPlainDataObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return undefined;
    const output: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

/** Snapshot only the bounded QueryTime shape supported for an Overview previous window. */
export function snapshotBoundedOverviewTime(
  value: unknown,
): QueryTime | undefined {
  const input = exactPlainDataObject(value, [
    "range",
    "reportingTimeZone",
    "capturedAtMs",
  ]);
  const range = exactPlainDataObject(input?.range, [
    "startMs",
    "endExclusiveMs",
  ]);
  if (
    !input ||
    !range ||
    !Number.isSafeInteger(range.startMs) ||
    !Number.isSafeInteger(range.endExclusiveMs) ||
    !Number.isSafeInteger(input.capturedAtMs) ||
    typeof input.reportingTimeZone !== "string" ||
    !isReportingTimeZone(input.reportingTimeZone) ||
    (range.endExclusiveMs as number) <= (range.startMs as number)
  )
    return undefined;
  try {
    const snapshot = createQueryTime(
      range.startMs as number,
      range.endExclusiveMs as number,
      input.reportingTimeZone,
      input.capturedAtMs as number,
    );
    Object.freeze(snapshot.range);
    return Object.freeze(snapshot);
  } catch {
    return undefined;
  }
}
