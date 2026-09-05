export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonRecord = Record<string, JsonValue>;

export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

export function safeParseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function asJsonRecord(value: unknown): JsonRecord {
  const record = safeParseRecord(value);
  const result: JsonRecord = {};
  for (const [key, item] of Object.entries(record)) {
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean" ||
      Array.isArray(item) ||
      (item && typeof item === "object")
    ) {
      result[key] = JSON.parse(JSON.stringify(item)) as JsonValue;
    }
  }
  return result;
}
