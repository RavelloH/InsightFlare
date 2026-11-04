import type { LogicalValueType } from "@/lib/edge/analytics/engine/semantic/value-types";

export interface EventPayloadTopLevelPath {
  readonly path: string;
  readonly key: string;
}

export const EVENT_PAYLOAD_PROPERTY_FIELDS = {
  present: { type: { kind: "scalar", scalar: "boolean" }, nullable: false },
  valueType: { type: { kind: "scalar", scalar: "number" }, nullable: true },
  stringValue: { type: { kind: "scalar", scalar: "string" }, nullable: true },
  numberValue: { type: { kind: "scalar", scalar: "number" }, nullable: true },
  booleanValue: { type: { kind: "scalar", scalar: "boolean" }, nullable: true },
  structureCompatible: {
    type: { kind: "scalar", scalar: "boolean" },
    nullable: false,
  },
  valueCompatible: {
    type: { kind: "scalar", scalar: "boolean" },
    nullable: false,
  },
} as const satisfies Readonly<
  Record<
    string,
    {
      readonly type: LogicalValueType;
      readonly nullable: boolean;
    }
  >
>;

export type EventPayloadPropertyField =
  keyof typeof EVENT_PAYLOAD_PROPERTY_FIELDS;

function hasPairedSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function decodeTopLevelPointer(path: string): string | undefined {
  if (typeof path !== "string" || !path.startsWith("/")) return undefined;
  const encoded = path.slice(1);
  if (encoded.length === 0 || encoded.includes("/")) return undefined;
  let key = "";
  for (let index = 0; index < encoded.length; index += 1) {
    const char = encoded[index]!;
    if (char !== "~") {
      key += char;
      continue;
    }
    const escape = encoded[index + 1];
    if (escape === "0") key += "~";
    else if (escape === "1") key += "/";
    else return undefined;
    index += 1;
  }
  if (
    key.length === 0 ||
    key === "*" ||
    key === "__proto__" ||
    key === "constructor" ||
    key === "prototype" ||
    !hasPairedSurrogates(key)
  )
    return undefined;
  return key;
}

/** Snapshot a finite set of supported one-segment RFC 6901 paths. */
export function snapshotEventPayloadTopLevelPaths(
  paths: readonly string[],
): readonly EventPayloadTopLevelPath[] {
  if (!Array.isArray(paths) || paths.length === 0)
    throw new Error("event_payload_path_set_requires_nonempty_array");
  const byKey = new Map<string, EventPayloadTopLevelPath>();
  for (const path of paths) {
    const key = decodeTopLevelPointer(path);
    if (key === undefined)
      throw new Error("event_payload_path_set_unsupported_pointer");
    if (byKey.has(key)) throw new Error("event_payload_path_set_duplicate_key");
    byKey.set(key, Object.freeze({ path, key }));
  }
  return Object.freeze(
    [...byKey.values()].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  );
}

export function isEventPayloadTopLevelPathSnapshot(
  value: unknown,
): value is readonly EventPayloadTopLevelPath[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  try {
    const snapshot = snapshotEventPayloadTopLevelPaths(
      value.map((entry) => {
        if (!entry || typeof entry !== "object" || !("path" in entry))
          throw new Error("invalid_path_entry");
        return (entry as { readonly path: string }).path;
      }),
    );
    return (
      snapshot.length === value.length &&
      snapshot.every(
        (entry, index) =>
          entry.path === value[index]?.path && entry.key === value[index]?.key,
      )
    );
  } catch {
    return false;
  }
}
