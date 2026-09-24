import type { DemoFactDataset } from "@/lib/demo/realtime/types";

export function weightedSessionCount(
  dataset: DemoFactDataset,
  sessionIds: Iterable<string>,
): number {
  let total = 0;
  for (const sessionId of sessionIds) {
    total += dataset.sessions.get(sessionId)?.weight ?? 0;
  }
  return total;
}

export function weightedVisitorCount(
  dataset: DemoFactDataset,
  visitorIds: Iterable<string>,
): number {
  let total = 0;
  for (const visitorId of visitorIds) {
    total += dataset.visitors.get(visitorId)?.weight ?? 0;
  }
  return total;
}
