import type { DemoCustomEventFact } from "@/lib/demo/realtime/events-facts";
import {
  demoEventRecordPayload,
  demoJsonTypeLabel,
} from "@/lib/demo/realtime/events-payload";
export function collectDemoEventFields(
  eventFacts: DemoCustomEventFact[],
  limit: number,
) {
  const rows = new Map<
    string,
    {
      path: string;
      valueType: string;
      events: Set<string>;
      occurrences: number;
      firstSeenAt: number;
      lastSeenAt: number;
      exampleValue?: string | number | boolean | null;
    }
  >();

  const addValue = (
    event: DemoCustomEventFact,
    path: string,
    value: unknown,
  ) => {
    const valueType = demoJsonTypeLabel(value);
    const rowKey = `${path}:${valueType}`;
    const current = rows.get(rowKey) ?? {
      path,
      valueType,
      events: new Set<string>(),
      occurrences: 0,
      firstSeenAt: event.occurredAt,
      lastSeenAt: event.occurredAt,
    };
    current.events.add(event.eventId);
    current.occurrences += 1;
    current.firstSeenAt = Math.min(current.firstSeenAt, event.occurredAt);
    current.lastSeenAt = Math.max(current.lastSeenAt, event.occurredAt);
    if (
      current.exampleValue === undefined &&
      (value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean")
    ) {
      current.exampleValue = value;
    }
    rows.set(rowKey, current);
  };

  const walk = (
    event: DemoCustomEventFact,
    value: unknown,
    pathSegments: string[],
  ) => {
    const path = `/${pathSegments.join("/")}`;
    addValue(event, path === "/" ? "" : path, value);
    if (Array.isArray(value)) {
      value.forEach((item) => walk(event, item, [...pathSegments, "*"]));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        walk(event, child, [...pathSegments, key]);
      }
    }
  };

  for (const event of eventFacts) {
    walk(event, demoEventRecordPayload(event), []);
  }

  return [...rows.values()]
    .map((row) => ({
      path: row.path,
      valueType: row.valueType,
      events: row.events.size,
      occurrences: row.occurrences,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      exampleValue: row.exampleValue ?? null,
    }))
    .sort(
      (left, right) =>
        right.events - left.events ||
        right.occurrences - left.occurrences ||
        left.path.localeCompare(right.path) ||
        left.valueType.localeCompare(right.valueType),
    )
    .slice(0, limit);
}
export function collectDemoEventFieldValues(
  eventFacts: DemoCustomEventFact[],
  fieldPath: string,
  fieldValueType: string,
  limit: number,
) {
  const rows = new Map<
    string,
    {
      value: string | number | boolean | null;
      events: Set<string>;
      occurrences: number;
      firstSeenAt: number;
      lastSeenAt: number;
    }
  >();

  const addValue = (
    event: DemoCustomEventFact,
    value: string | number | boolean | null,
  ) => {
    const key = JSON.stringify(value);
    const current = rows.get(key) ?? {
      value,
      events: new Set<string>(),
      occurrences: 0,
      firstSeenAt: event.occurredAt,
      lastSeenAt: event.occurredAt,
    };
    current.events.add(event.eventId);
    current.occurrences += 1;
    current.firstSeenAt = Math.min(current.firstSeenAt, event.occurredAt);
    current.lastSeenAt = Math.max(current.lastSeenAt, event.occurredAt);
    rows.set(key, current);
  };

  const walk = (
    event: DemoCustomEventFact,
    value: unknown,
    pathSegments: string[],
  ) => {
    const currentPath = `/${pathSegments.join("/")}`;
    const normalizedPath = currentPath === "/" ? "" : currentPath;
    if (normalizedPath === fieldPath) {
      const valueType = demoJsonTypeLabel(value);
      if (valueType === fieldValueType) {
        if (
          value === null ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          addValue(event, value);
        }
      }
    }

    if (Array.isArray(value)) {
      value.forEach((item) => walk(event, item, [...pathSegments, "*"]));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        walk(event, child, [...pathSegments, key]);
      }
    }
  };

  for (const event of eventFacts) {
    walk(event, demoEventRecordPayload(event), []);
  }

  return [...rows.values()]
    .map((row) => ({
      value: row.value,
      events: row.events.size,
      occurrences: row.occurrences,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
    }))
    .sort(
      (left, right) =>
        right.occurrences - left.occurrences ||
        right.events - left.events ||
        String(left.value ?? "").localeCompare(String(right.value ?? "")),
    )
    .slice(0, limit);
}
