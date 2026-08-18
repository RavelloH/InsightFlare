import type {
  FilterCondition,
  FilterDocument,
  FilterExpression,
  FilterValue,
} from "@/lib/filter-contract";
import type { DemoCustomEventFact } from "@/lib/realtime/mock/events-facts";
import { demoEventRecordPayload } from "@/lib/realtime/mock/events-payload";
import type { DemoQueryFilters } from "@/lib/realtime/mock/types";

function demoPayloadValue(value: unknown): FilterValue | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value;
  return undefined;
}

function demoPayloadFilterValueType(
  value: FilterValue,
): "string" | "number" | "boolean" {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

function collectDemoPayloadValuesAtPath(
  value: unknown,
  targetPath: string,
): FilterValue[] {
  const values: FilterValue[] = [];
  const walk = (current: unknown, pathSegments: string[]) => {
    const path = `/${pathSegments.join("/")}`;
    const normalizedPath = path === "/" ? "" : path;
    if (normalizedPath === targetPath) {
      const payloadValue = demoPayloadValue(current);
      if (
        payloadValue === null ||
        typeof payloadValue === "string" ||
        typeof payloadValue === "number" ||
        typeof payloadValue === "boolean"
      ) {
        values.push(payloadValue);
      }
    }

    if (Array.isArray(current)) {
      current.forEach((item) => walk(item, [...pathSegments, "*"]));
      return;
    }
    if (current && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) {
        walk(child, [...pathSegments, key]);
      }
    }
  };

  walk(value, []);
  return values;
}

function demoPayloadValuesEqual(
  left: FilterValue,
  right: FilterValue,
): boolean {
  if (typeof left === "number" || typeof right === "number") {
    return Number(left) === Number(right);
  }
  return left === right;
}

function comparePayloadValue(
  value: FilterValue,
  operator: FilterCondition["operator"],
  expected: FilterValue | readonly FilterValue[] | undefined,
): boolean {
  const values = Array.isArray(expected) ? expected : [expected!];
  const first = values[0]!;
  if (operator === "eq") return demoPayloadValuesEqual(value, first);
  if (operator === "neq") return !demoPayloadValuesEqual(value, first);
  if (operator === "in")
    return values.some(
      (candidate) =>
        candidate !== undefined && demoPayloadValuesEqual(value, candidate),
    );
  if (operator === "notIn")
    return values.every(
      (candidate) =>
        candidate === undefined || !demoPayloadValuesEqual(value, candidate),
    );
  if (operator === "contains")
    return (
      typeof value === "string" &&
      typeof first === "string" &&
      value.includes(first)
    );
  if (operator === "startsWith")
    return (
      typeof value === "string" &&
      typeof first === "string" &&
      value.startsWith(first)
    );
  if (operator === "endsWith")
    return (
      typeof value === "string" &&
      typeof first === "string" &&
      value.endsWith(first)
    );
  const orderedValue = value as string | number;
  const orderedFirst = first as string | number;
  if (operator === "gt")
    return value !== null && first !== null && orderedValue > orderedFirst;
  if (operator === "gte")
    return value !== null && first !== null && orderedValue >= orderedFirst;
  if (operator === "lt")
    return value !== null && first !== null && orderedValue < orderedFirst;
  if (operator === "lte")
    return value !== null && first !== null && orderedValue <= orderedFirst;
  if (operator === "between") {
    const lower = values[0];
    const upper = values[1];
    return (
      lower !== undefined &&
      upper !== undefined &&
      lower !== null &&
      upper !== null &&
      value !== null &&
      orderedValue >= (lower as string | number) &&
      orderedValue <= (upper as string | number)
    );
  }
  return false;
}

function matchesDemoPayloadCondition(
  event: DemoCustomEventFact,
  condition: FilterCondition,
): boolean {
  if (condition.target.kind !== "event-payload") return true;
  const expectedType =
    condition.value === undefined || Array.isArray(condition.value)
      ? null
      : demoPayloadFilterValueType(condition.value as FilterValue);
  const values = collectDemoPayloadValuesAtPath(
    demoEventRecordPayload(event),
    condition.target.path,
  );
  if (condition.operator === "exists") return values.length > 0;
  if (condition.operator === "notExists") return values.length === 0;
  if (condition.operator === "isNull")
    return values.some((value) => value === null);
  if (condition.operator === "notNull")
    return values.some((value) => value !== null);
  if (condition.operator === "isEmpty")
    return values.some((value) => value === "");
  if (condition.operator === "notEmpty")
    return values.some((value) => value !== "");
  return values.some((value) => {
    if (expectedType && demoPayloadFilterValueType(value) !== expectedType)
      return false;
    return comparePayloadValue(value, condition.operator, condition.value);
  });
}

function matchesDemoPayloadExpression(
  event: DemoCustomEventFact,
  expression: FilterExpression,
): boolean {
  if (expression.kind === "condition")
    return matchesDemoPayloadCondition(event, expression);
  if (expression.kind === "not")
    return !matchesDemoPayloadExpression(event, expression.child);
  if (expression.kind === "and")
    return expression.children.every((child) =>
      matchesDemoPayloadExpression(event, child),
    );
  return expression.children.some((child) =>
    matchesDemoPayloadExpression(event, child),
  );
}

function filterDocumentFor(
  filters: DemoQueryFilters | FilterDocument,
): FilterDocument {
  return "version" in filters
    ? filters
    : (filters.filterDocument ?? { version: 1, root: null });
}

export function filterDemoCustomEventsByPayload(
  events: DemoCustomEventFact[],
  filters: DemoQueryFilters | FilterDocument,
): DemoCustomEventFact[] {
  const document = filterDocumentFor(filters);
  const root = document.root;
  if (!root) return events;
  return events.filter((event) => matchesDemoPayloadExpression(event, root));
}
