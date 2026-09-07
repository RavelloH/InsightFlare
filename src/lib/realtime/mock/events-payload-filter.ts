import { analyticsFilterDefinition } from "@/lib/edge/analytics/contract";
import type {
  FilterCondition,
  FilterDocument,
  FilterExpression,
  FilterValue,
} from "@/lib/filter-contract";
import {
  createDemoCustomEventFacts,
  type DemoCustomEventFact,
} from "@/lib/realtime/mock/events-facts";
import { demoEventRecordPayload } from "@/lib/realtime/mock/events-payload";
import {
  buildCanonicalDemoFacts,
  type CanonicalDemoFacts,
  canonicalFieldValue,
  demoScalarEqual,
} from "@/lib/realtime/mock/fact-filters";
import type {
  DemoFactDataset,
  DemoQueryFilters,
  DemoVisitFact,
} from "@/lib/realtime/mock/types";

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

function matchesDemoEventCondition(
  event: DemoCustomEventFact,
  condition: FilterCondition,
  facts: CanonicalDemoFacts,
): boolean {
  if (condition.target.kind === "event-payload") {
    return matchesDemoPayloadCondition(event, condition);
  }
  const fieldId = condition.target.field;
  const actual = canonicalFieldValue(event.visit, fieldId, facts);
  if (condition.operator === "exists" || condition.operator === "notNull")
    return actual !== undefined && actual !== null;
  if (condition.operator === "notExists" || condition.operator === "isNull")
    return actual === undefined || actual === null;
  if (condition.operator === "isEmpty") return actual === "";
  if (condition.operator === "notEmpty")
    return actual !== undefined && actual !== null && actual !== "";
  const values = Array.isArray(condition.value)
    ? condition.value
    : [condition.value as FilterValue];
  if (condition.operator === "in" || condition.operator === "notIn") {
    const found = values.some((value) =>
      demoScalarEqual(fieldId, actual, value),
    );
    return condition.operator === "in" ? found : !found;
  }
  if (actual === undefined || actual === null) return false;
  const first = values[0];
  if (condition.operator === "eq")
    return demoScalarEqual(fieldId, actual, first!);
  if (condition.operator === "neq")
    return !demoScalarEqual(fieldId, actual, first!);
  if (
    condition.operator === "contains" ||
    condition.operator === "startsWith" ||
    condition.operator === "endsWith"
  ) {
    if (typeof actual !== "string" || typeof first !== "string") return false;
    const definition = analyticsFilterDefinition(fieldId);
    const caseInsensitive = definition?.comparison === "case-insensitive";
    const left = caseInsensitive ? actual.trim().toLowerCase() : actual.trim();
    const right = caseInsensitive ? first.trim().toLowerCase() : first.trim();
    return condition.operator === "contains"
      ? left.includes(right)
      : condition.operator === "startsWith"
        ? left.startsWith(right)
        : left.endsWith(right);
  }
  if (condition.operator === "between") {
    const lower = values[0];
    const upper = values[1];
    return (
      typeof actual === "number" &&
      typeof lower === "number" &&
      typeof upper === "number" &&
      actual >= lower &&
      actual <= upper
    );
  }
  if (typeof actual !== "number" || typeof first !== "number") return false;
  if (condition.operator === "gt") return actual > first;
  if (condition.operator === "gte") return actual >= first;
  if (condition.operator === "lt") return actual < first;
  if (condition.operator === "lte") return actual <= first;
  return false;
}

function matchesDemoEventExpression(
  event: DemoCustomEventFact,
  expression: FilterExpression,
  facts: CanonicalDemoFacts,
): boolean {
  if (expression.kind === "condition")
    return matchesDemoEventCondition(event, expression, facts);
  if (expression.kind === "not")
    return !matchesDemoEventExpression(event, expression.child, facts);
  return expression.kind === "and"
    ? expression.children.every((child) =>
        matchesDemoEventExpression(event, child, facts),
      )
    : expression.children.some((child) =>
        matchesDemoEventExpression(event, child, facts),
      );
}

function matchesDemoScopedEventExpression(
  event: DemoCustomEventFact,
  expression: FilterExpression,
  allVisits: readonly DemoVisitFact[],
  allEvents: readonly DemoCustomEventFact[],
  facts: CanonicalDemoFacts,
  scope: "session" | "visitor",
): boolean {
  const entityId =
    scope === "session" ? event.visit.sessionId : event.visit.visitorId;
  const visits = allVisits.filter((visit) =>
    scope === "session"
      ? visit.sessionId === entityId
      : visit.visitorId === entityId,
  );
  const events = allEvents.filter((candidate) =>
    scope === "session"
      ? candidate.visit.sessionId === entityId
      : candidate.visit.visitorId === entityId,
  );
  const evaluate = (item: FilterExpression): boolean => {
    if (item.kind === "condition") {
      return item.target.kind === "event-payload"
        ? events.some((candidate) =>
            matchesDemoPayloadCondition(candidate, item),
          )
        : visits.some((visit) =>
            matchesDemoEventCondition({ ...event, visit }, item, facts),
          );
    }
    if (item.kind === "not") return !evaluate(item.child);
    return item.kind === "and"
      ? item.children.every(evaluate)
      : item.children.some(evaluate);
  };
  return evaluate(expression);
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
  options: { readonly allVisits?: readonly DemoVisitFact[] } = {},
): DemoCustomEventFact[] {
  const document = filterDocumentFor(filters);
  const root = document.root;
  if (!root) return events;
  const hasPayload = (() => {
    const visit = (expression: FilterExpression): boolean => {
      if (expression.kind === "condition")
        return expression.target.kind === "event-payload";
      if (expression.kind === "not") return visit(expression.child);
      return expression.children.some(visit);
    };
    return visit(root);
  })();
  if (!hasPayload) return events;

  const allVisits = options.allVisits ?? events.map((event) => event.visit);
  const dataset = {
    from: 0,
    to: 0,
    viewWeight: 1,
    visits: [...allVisits],
    sessions: new Map(),
    visitors: new Map(),
  } satisfies DemoFactDataset;
  const facts = buildCanonicalDemoFacts(dataset);
  const allEvents = createDemoCustomEventFacts([...allVisits]);
  const scope = "scope" in filters ? filters.scope : undefined;
  return events.filter((event) =>
    scope === "session" || scope === "visitor"
      ? matchesDemoScopedEventExpression(
          event,
          root,
          allVisits,
          allEvents,
          facts,
          scope,
        )
      : matchesDemoEventExpression(event, root, facts),
  );
}
