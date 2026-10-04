import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";

const STRING = { kind: "scalar", scalar: "string" } as const;

export type SessionBoundaryKind = "entry" | "exit";

function pageAttribute(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  name: "sessionId" | "visitorId" | "startedAt" | "localId" | "pathname",
) {
  return builder.slot(pages, `attribute:page.report.${name}`);
}

function pathValue(builder: LogicalPlanBuilder, pages: LogicalRelationHandle) {
  return builder.normalizeString(
    builder.coalesce(
      pageAttribute(builder, pages, "pathname"),
      builder.literal("", STRING),
    ),
    "trim-ascii-space",
  );
}

function eligibleSessionPages(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
): LogicalRelationHandle {
  return builder.filter(
    pages,
    builder.and(
      builder.compare(
        "neq",
        pageAttribute(builder, pages, "sessionId"),
        builder.literal("", STRING),
      ),
      builder.compare(
        "neq",
        pathValue(builder, pages),
        builder.literal("", STRING),
      ),
    ),
  );
}

function orderedMember(
  builder: LogicalPlanBuilder,
  source: LogicalRelationHandle,
  direction: "asc" | "desc",
  nulls: "first" | "last",
): LogicalRelationHandle {
  return builder.orderedMember(source, {
    groups: ["attribute:page.report.sessionId"],
    order: [
      {
        slot: "attribute:page.report.startedAt",
        direction,
        nulls,
      },
      {
        slot: "attribute:page.report.localId",
        direction,
        nulls,
      },
    ],
  });
}

function projectBoundary(
  builder: LogicalPlanBuilder,
  member: LogicalRelationHandle,
): LogicalRelationHandle {
  return builder.project(member, {
    sessionId: pageAttribute(builder, member, "sessionId"),
    visitorId: pageAttribute(builder, member, "visitorId"),
    value: pathValue(builder, member),
  });
}

/** Selects the first or last eligible Page per raw session using the shared order contract. */
export function selectedSessionBoundary(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  kind: SessionBoundaryKind,
): LogicalRelationHandle {
  if (kind === "exit") return selectedSessionBoundaryPair(builder, pages).exit;
  const eligible = eligibleSessionPages(builder, pages);
  return projectBoundary(
    builder,
    orderedMember(builder, eligible, "asc", "first"),
  );
}

/** Selects both Page edges while carrying the first Page's visitor onto exit rows. */
export function selectedSessionBoundaryPair(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
): {
  readonly entry: LogicalRelationHandle;
  readonly exit: LogicalRelationHandle;
} {
  const eligible = eligibleSessionPages(builder, pages);
  const first = projectBoundary(
    builder,
    orderedMember(builder, eligible, "asc", "first"),
  );
  const latest = projectBoundary(
    builder,
    orderedMember(builder, eligible, "desc", "last"),
  );
  const joined = builder.join(first, latest, [
    { left: "sessionId", right: "sessionId" },
  ]);
  const exit = builder.project(joined, {
    visitorId: builder.slot(joined, "visitorId"),
    value: builder.slot(joined, "right.value"),
  });
  return { entry: first, exit };
}

/** Aggregates one selected Page per session, preserving the legacy edge metrics. */
export function aggregateSessionBoundaries(
  builder: LogicalPlanBuilder,
  boundaries: LogicalRelationHandle,
): LogicalRelationHandle {
  const visitorId = builder.slot(boundaries, "visitorId");
  const nonemptyVisitor = builder.caseWhen(
    [
      {
        when: builder.compare("neq", visitorId, builder.literal("", STRING)),
        then: visitorId,
      },
    ],
    builder.literal(null, STRING),
  );
  return builder.aggregate(
    boundaries,
    {
      value: builder.coalesce(
        builder.slot(boundaries, "value"),
        builder.literal("", STRING),
      ),
    },
    [
      { name: "views", kind: "count-rows" },
      { name: "sessions", kind: "count-rows" },
      {
        name: "visitors",
        kind: "count-distinct",
        expression: nonemptyVisitor,
      },
    ],
  );
}
