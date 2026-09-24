import type { DemoCustomEventFact } from "@/lib/demo/realtime/events-facts";
import type { DemoSortDirection } from "@/lib/demo/realtime/shared";

export type DemoEventRecordSortKey = "occurredAt" | "eventName" | "pathname";

export function parseDemoEventRecordSort(
  params: Record<string, string | number>,
): {
  key: DemoEventRecordSortKey;
  direction: DemoSortDirection;
} {
  const key = String(params.sortBy ?? "").trim();
  const direction =
    String(params.sortDir ?? "")
      .trim()
      .toLowerCase() === "asc"
      ? "asc"
      : "desc";
  if (key === "eventName" || key === "pathname") return { key, direction };
  return { key: "occurredAt", direction };
}

export function sortDemoEventRecords(
  rows: DemoCustomEventFact[],
  sort: { key: DemoEventRecordSortKey; direction: DemoSortDirection },
) {
  const factor = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    if (sort.key === "eventName") {
      const byName = left.eventName.localeCompare(right.eventName);
      if (byName !== 0) return byName * factor;
    } else if (sort.key === "pathname") {
      const byPath = left.visit.pathname.localeCompare(right.visit.pathname);
      if (byPath !== 0) return byPath * factor;
    } else if (left.occurredAt !== right.occurredAt) {
      return (left.occurredAt - right.occurredAt) * factor;
    }
    return right.occurredAt - left.occurredAt;
  });
}
