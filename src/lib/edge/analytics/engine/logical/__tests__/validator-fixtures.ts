import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
} from "@/lib/edge/analytics/contract/types";
import {
  type LogicalPlan,
  LogicalPlanBuilder,
} from "@/lib/edge/analytics/engine/logical";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";

export type Obj = Record<string, any>;

export function createBuilder(): LogicalPlanBuilder {
  const candidate = {
    startMs: 0 as EpochMs,
    endExclusiveMs: 10_000 as EpochMs,
  };
  return new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: ["site-a" as SiteId],
    }),
    time: createSemanticTemporalDomains({
      candidate,
      read: { kind: "bounded", range: candidate },
      reportingTimeZone: "UTC" as ReportingTimeZone,
      capturedAtMs: 10_000 as EpochMs,
    }),
    scope: resolveAnalyticsScope("auto"),
  });
}

const PAGE_ATTRIBUTES = [
  "page.report.pathname",
  "page.report.title",
  "page.report.durationMs",
  "page.report.startedAt",
  "page.report.sessionId",
  "page.report.localId",
] as const;

function world() {
  const b = createBuilder();
  const yes = b.literal(true, { kind: "scalar", scalar: "boolean" });
  const pages = b.source("page", {
    attributes: [...PAGE_ATTRIBUTES],
    includeOccurrenceTime: true,
  });
  const pagesB = b.source("page", { attributes: [...PAGE_ATTRIBUTES] });
  const pagesC = b.source("page", { attributes: [...PAGE_ATTRIBUTES] });
  const sessions = b.source("session", { temporalDomain: "read" });
  const events = b.source("event", {
    attributes: ["event.report.ownerSessionId"],
  });
  const eventsOnly = b.source("event");
  const path = (rel: typeof pages) =>
    b.slot(rel, "attribute:page.report.pathname");
  const duration = (rel: typeof pages) =>
    b.slot(rel, "attribute:page.report.durationMs");
  const groupedOf = (rel: typeof pages) =>
    b.aggregate(rel, { path: path(rel) }, [
      { name: "views", kind: "count-rows" },
      { name: "total", kind: "sum", expression: duration(rel) },
      { name: "longest", kind: "max", expression: path(rel) },
      { name: "unique", kind: "count-distinct", expression: path(rel) },
    ]);
  const filtered = b.filter(pages, yes);
  const projected = b.project(pages, {
    entity: b.slot(pages, "entity"),
    path: path(pages),
  });
  const grouped = groupedOf(pages);
  const groupedB = groupedOf(pagesB);
  const groupedC = groupedOf(pagesC);
  const scalarA = b.aggregate(pages, {}, [{ name: "n", kind: "count-rows" }]);
  const scalarB = b.aggregate(pagesB, {}, [{ name: "n", kind: "count-rows" }]);
  const stats = b.sampleStatistics(
    pages,
    { path: path(pages) },
    duration(pages),
    [{ name: "p50", percentile: 50 }],
  );
  const distinct = b.distinct(pages, [
    { input: "attribute:page.report.pathname", output: "path" },
  ]);
  const union = b.setOperation("union", [grouped, groupedB]);
  const appended = b.appendRows([scalarA, scalarB], ["n"]);
  const inner = b.join(grouped, groupedB, [{ left: "path", right: "path" }]);
  const left = b.join(
    grouped,
    groupedC,
    [{ left: "path", right: "path" }],
    "left",
  );
  const semi = b.semiJoin(grouped, groupedB, [{ left: "path", right: "path" }]);
  const sorted = b.sort(grouped, [
    { slot: "views", direction: "desc", nulls: "last" },
  ]);
  const limited = b.limit(sorted, 5);
  const ordered = b.orderedMember(pages, {
    groups: ["attribute:page.report.sessionId"],
    order: [
      {
        slot: "attribute:page.report.startedAt",
        direction: "asc",
        nulls: "last",
      },
      {
        slot: "attribute:page.report.localId",
        direction: "asc",
        nulls: "last",
      },
    ],
  });
  const ordered2 = b.orderedMember(pages, {
    groups: ["attribute:page.report.localId"],
    order: [
      {
        slot: "attribute:page.report.startedAt",
        direction: "asc",
        nulls: "last",
      },
    ],
  });
  const projectedKeyed = b.project(grouped, {
    path: b.slot(grouped, "path"),
    views: b.slot(grouped, "views"),
  });
  const projectedScalar = b.project(scalarA, { n: b.slot(scalarA, "n") });
  const projectedEvents = b.project(eventsOnly, {
    entity: b.slot(eventsOnly, "entity"),
  });
  const entityKeyed = b.distinct(pagesC, [
    { input: "entity" },
    { input: "attribute:page.report.pathname", output: "path" },
  ]);
  const setA = b.aggregate(pages, { k: path(pages) }, [
    { name: "m", kind: "count-rows" },
  ]);
  const setA2 = b.aggregate(pagesB, { k: path(pagesB) }, [
    { name: "m", kind: "count-rows" },
  ]);
  const setB = b.aggregate(pagesC, { k: path(pagesC) }, [
    { name: "m", kind: "max", expression: path(pagesC) },
  ]);
  const union2 = b.setOperation("union", [setA, setA2]);
  const pathTitle = b.aggregate(
    pagesB,
    {
      pathname: b.slot(pagesB, "attribute:page.report.pathname"),
      title: b.slot(pagesB, "attribute:page.report.title"),
    },
    [{ name: "views", kind: "count-rows" }],
  );
  const ranked = b.rankedMembers(pathTitle, {
    groups: ["pathname"],
    order: [
      { slot: "views", direction: "desc", nulls: "last" },
      { slot: "title", direction: "asc", nulls: "first" },
    ],
  });
  const occurrences = b.eventPayloadOccurrences(events);
  const properties = b.eventPayloadProperties(events, ["/tier", "/zone"]);
  const lookup = b.relationshipLookup(sessions, "session.visitor");
  b.output("main", grouped, [
    { name: "path", slot: "path" },
    { name: "views", slot: "views" },
  ]);
  const plan = b.finish() as unknown as LogicalPlan;
  return {
    plan,
    h: {
      pages,
      sessions,
      events,
      eventsOnly,
      filtered,
      projected,
      grouped,
      groupedB,
      scalarA,
      stats,
      distinct,
      union,
      appended,
      inner,
      left,
      semi,
      sorted,
      limited,
      ordered,
      ordered2,
      projectedKeyed,
      projectedScalar,
      projectedEvents,
      entityKeyed,
      setB,
      union2,
      pathTitle,
      ranked,
      occurrences,
      properties,
      lookup,
    },
  };
}

export const W = world();
export const H = W.h;
export type Handle = (typeof H)[keyof typeof H];

export function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Rewrites one node of a deep-cloned valid plan. */
export function edit(
  handle: Handle,
  mutate: (node: Obj, plan: Obj) => void,
): LogicalPlan {
  const plan = clone(W.plan) as Obj;
  const node = plan.nodes.find((candidate: Obj) => candidate.id === handle.id);
  if (!node) throw new Error("missing_node");
  mutate(node, plan);
  return plan as LogicalPlan;
}

export function slotsOf(handle: Handle, name: string): string {
  return (handle.slots as unknown as Record<string, string>)[name]!;
}

export function editSlot(
  plan: LogicalPlan,
  id: string,
  mutate: (slot: Obj) => void,
): LogicalPlan {
  const slot = (plan.slots as readonly Obj[]).find((item) => item.id === id);
  if (!slot) throw new Error("missing_slot");
  mutate(slot);
  return plan;
}

export function nodeIndex(handle: Handle): number {
  return W.plan.nodes.findIndex((node) => node.id === handle.id);
}

/** Moves a node to the end so it may reference relations created after it. */
export function moveLast(plan: Obj, node: Obj): void {
  plan.nodes.push(...plan.nodes.splice(plan.nodes.indexOf(node), 1));
}
