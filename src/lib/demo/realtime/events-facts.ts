import type { DemoVisitFact } from "@/lib/demo/realtime/types";

export interface DemoCustomEventFact {
  eventId: string;
  eventName: string;
  occurredAt: number;
  receivedAt: number;
  sequence: number;
  visit: DemoVisitFact;
}

function demoCustomEventOccurredAt(visit: DemoVisitFact): number {
  return Math.min(
    visit.startedAt + 1000,
    visit.startedAt + Math.max(1000, visit.durationMs),
  );
}

export function createDemoCustomEventFacts(
  visits: DemoVisitFact[],
): DemoCustomEventFact[] {
  const eventCounters = new Map<string, number>();
  return visits
    .filter((visit) => visit.eventType.trim().toLowerCase() !== "pageview")
    .map((visit) => {
      const sequence = (eventCounters.get(visit.visitId) ?? 0) + 1;
      eventCounters.set(visit.visitId, sequence);
      return {
        eventId: `${visit.visitId}:${visit.eventType}`,
        eventName: visit.eventType,
        occurredAt: demoCustomEventOccurredAt(visit),
        receivedAt: demoCustomEventOccurredAt(visit) + 120,
        sequence,
        visit,
      };
    })
    .sort(
      (left, right) =>
        right.occurredAt - left.occurredAt ||
        right.eventId.localeCompare(left.eventId),
    );
}
