export function normalizeFilterValue(value: string | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, 120);
  return normalized.length > 0 ? normalized : undefined;
}

export function customEventJsonTypeLabel(valueType: number): string {
  if (valueType === 1) return "string";
  if (valueType === 2) return "number";
  if (valueType === 3) return "boolean";
  if (valueType === 4) return "object";
  if (valueType === 5) return "array";
  return "null";
}

export function customEventJsonTypeCode(valueType: string): number | null {
  if (valueType === "null") return 0;
  if (valueType === "string") return 1;
  if (valueType === "number") return 2;
  if (valueType === "boolean") return 3;
  if (valueType === "object") return 4;
  if (valueType === "array") return 5;
  return null;
}
