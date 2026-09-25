import type {
  EventField,
  EventFieldValueStat,
} from "@/lib/dashboard-api/client/edge";

import {
  type EventPayloadFilterRule,
  type EventPayloadFilterValue,
  type EventRecordSortState,
} from "./types";
export const EVENT_PAGE_SIZE = 50;
export const EVENT_SKELETON_ROWS = EVENT_PAGE_SIZE;
export const FIELD_TREE_CHILD_TRANSITION = {
  initial: { opacity: 0, y: -6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
};
export const DEFAULT_EVENT_RECORD_SORT: EventRecordSortState = {
  key: "occurredAt",
  direction: "desc",
};
export function normalizeEventFieldPath(path: string): string {
  const normalized = String(path ?? "").trim();
  if (!normalized || normalized === "/") return "";
  return normalized.startsWith("/")
    ? normalized.replace(/\/+/g, "/")
    : `/${normalized.replace(/^\/+/, "")}`;
}
export function eventFieldKey(
  field: Pick<EventField, "path" | "valueType">,
): string {
  return `${field.valueType}\u0000${normalizeEventFieldPath(field.path)}`;
}
export function eventFieldValueKey(
  value: EventFieldValueStat["value"],
): string {
  return JSON.stringify(value);
}
export function formatFieldValueLabel(
  value: EventFieldValueStat["value"],
): string {
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 0 ? value : '""';
  return String(value);
}
export function payloadFilterValueType(
  value: EventPayloadFilterValue,
): "string" | "number" | "boolean" | "null" {
  if (value === null) return "null";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}
export function payloadFilterValuesEqual(
  left: EventPayloadFilterValue,
  right: EventPayloadFilterValue,
): boolean {
  if (typeof left === "number" || typeof right === "number") {
    return Number(left) === Number(right);
  }
  return left === right;
}
function normalizePayloadFilterInputPath(path: string): string {
  const normalized = path.trim().slice(0, 240);
  if (!normalized || normalized === "/") return "";
  if (normalized.startsWith("/")) return normalizeEventFieldPath(normalized);
  return normalizeEventFieldPath(
    normalized
      .replace(/^\$\.?/, "")
      .replace(/\[(?:\d+|\*)\]/g, ".*")
      .split(".")
      .map((segment) => segment.trim())
      .filter(Boolean)
      .join("/"),
  );
}
function formatPayloadFilterPathForInput(path: string): string {
  const normalized = normalizeEventFieldPath(path);
  if (!normalized) return "";
  return normalized.slice(1).split("/").filter(Boolean).join(".");
}
function formatPayloadFilterValueForInput(
  value: EventPayloadFilterValue,
): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return String(value);
}
export function formatPayloadFilterRules(
  rules: EventPayloadFilterRule[],
): string {
  return rules
    .map(
      (rule) =>
        `${formatPayloadFilterPathForInput(rule.path)} ${
          rule.operator === "neq" ? "!=" : "=="
        } ${formatPayloadFilterValueForInput(rule.value)}`,
    )
    .join("\n");
}
function parsePayloadFilterValue(rawValue: string): EventPayloadFilterValue {
  const value = rawValue.trim();
  if (!value) throw new Error("Empty filter value");
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:\d+|\d*\.\d+)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    if (value.startsWith('"')) {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed !== "string") throw new Error("Invalid string value");
      return parsed;
    }
    return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  }
  return value.slice(0, 240);
}
export function parsePayloadFilterInput(
  input: string,
): { ok: true; rules: EventPayloadFilterRule[] } | { ok: false } {
  const conditions = input
    .split(/\n|&&/g)
    .map((condition) => condition.trim())
    .filter(Boolean);
  const rules: EventPayloadFilterRule[] = [];

  try {
    for (const condition of conditions) {
      const match = condition.match(/^(.+?)\s*(==|!=)\s*(.+)$/);
      if (!match) return { ok: false };
      const path = normalizePayloadFilterInputPath(match[1] ?? "");
      if (!path) return { ok: false };
      const value = parsePayloadFilterValue(match[3] ?? "");
      rules.push({
        path,
        operator: match[2] === "!=" ? "neq" : "eq",
        value,
      });
    }
  } catch {
    return { ok: false };
  }

  return { ok: true, rules };
}
export function isPayloadFilterActive(
  rules: EventPayloadFilterRule[],
  path: string,
  value: EventPayloadFilterValue,
): boolean {
  const normalizedPath = normalizeEventFieldPath(path);
  return rules.some(
    (rule) =>
      rule.operator === "eq" &&
      normalizeEventFieldPath(rule.path) === normalizedPath &&
      payloadFilterValueType(rule.value) === payloadFilterValueType(value) &&
      payloadFilterValuesEqual(rule.value, value),
  );
}
