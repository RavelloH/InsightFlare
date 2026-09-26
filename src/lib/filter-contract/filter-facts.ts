export interface FilterActivityFact {
  readonly kind: "page" | "event";
  readonly id: string;
  readonly time?: number;
  readonly sessionId?: string;
  readonly visitorId?: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface CanonicalFilterScopeFacts {
  readonly sessions: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  readonly visitors: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

function compareActivity(left: FilterActivityFact, right: FilterActivityFact) {
  return (
    (left.time ?? 0) - (right.time ?? 0) ||
    (left.kind === right.kind ? 0 : left.kind === "page" ? -1 : 1) ||
    left.id.localeCompare(right.id)
  );
}

function durationOf(page: FilterActivityFact): number {
  const duration = page.fields["page.durationMs"];
  return typeof duration === "number" && Number.isFinite(duration)
    ? duration
    : 0;
}

/**
 * Canonical Session and Visitor facts for a set of activity records.
 * Callers choose the candidate or evaluation history before invoking this
 * helper, so every executor uses the same aggregation rules over its range.
 */
export function buildCanonicalFilterScopeFacts(
  records: readonly FilterActivityFact[],
): CanonicalFilterScopeFacts {
  const sessions = new Map<string, FilterActivityFact[]>();
  const visitors = new Map<string, FilterActivityFact[]>();

  for (const record of records) {
    if (record.sessionId) {
      const items = sessions.get(record.sessionId) ?? [];
      items.push(record);
      sessions.set(record.sessionId, items);
    }
    if (record.visitorId) {
      const items = visitors.get(record.visitorId) ?? [];
      items.push(record);
      visitors.set(record.visitorId, items);
    }
  }

  const sessionFacts = new Map<string, Readonly<Record<string, unknown>>>();
  for (const [id, items] of sessions) {
    const pages = items
      .filter((item) => item.kind === "page")
      .sort(compareActivity);
    const events = items.filter((item) => item.kind === "event");
    sessionFacts.set(id, {
      "session.durationMs": pages.reduce(
        (sum, page) => sum + durationOf(page),
        0,
      ),
      "session.views": pages.length,
      "session.events": events.length,
      "session.bounce": pages.length === 1,
      "session.entryPath": pages[0]?.fields["page.path"],
      "session.exitPath": pages.at(-1)?.fields["page.path"],
    });
  }

  const visitorFacts = new Map<string, Readonly<Record<string, unknown>>>();
  for (const [id, items] of visitors) {
    visitorFacts.set(id, {
      "visitor.sessions": new Set(
        items.map((item) => item.sessionId).filter(Boolean),
      ).size,
      "visitor.views": items.filter((item) => item.kind === "page").length,
      "visitor.events": items.filter((item) => item.kind === "event").length,
    });
  }

  return { sessions: sessionFacts, visitors: visitorFacts };
}
