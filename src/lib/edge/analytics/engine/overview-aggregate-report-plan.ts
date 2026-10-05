import {
  factEntityKindsForFilter,
  type QueryTime,
  scopedFilterMetadata,
  type SiteId,
} from "@/lib/edge/analytics/contract";
import type {
  LogicalExpressionHandle,
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import type { SemanticRelationshipId } from "@/lib/edge/analytics/engine/semantic/relationships";
import { createSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;

function attribute(
  builder: LogicalPlanBuilder,
  source: LogicalRelationHandle,
  entity: "page" | "event",
  name: string,
): LogicalExpressionHandle {
  return builder.slot(source, `attribute:${entity}.report.${name}`);
}

function nonBlankAsciiSpace(
  builder: LogicalPlanBuilder,
  value: LogicalExpressionHandle,
) {
  const normalized = builder.normalizeString(value, "trim-ascii-space");
  return builder.compare("neq", normalized, builder.literal("", STRING));
}

function scalarCount(
  builder: LogicalPlanBuilder,
  input: LogicalRelationHandle,
  name: string,
) {
  return builder.aggregate(input, {}, [{ name, kind: "count-rows" }]);
}

function unionEntities(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  events: LogicalRelationHandle | undefined,
  entity: "session" | "visitor",
): LogicalRelationHandle {
  const pageAttribute = attribute(builder, pages, "page", `${entity}Id`);
  const pageRelationName = `relationship:page.${entity}`;
  const pageQualified = builder.filter(
    pages,
    nonBlankAsciiSpace(builder, pageAttribute),
  );
  const pageEntities = builder.distinctEntity(
    pageQualified,
    pageRelationName,
    entity,
  );
  if (!events) return pageEntities;

  const eventAttribute = attribute(
    builder,
    events,
    "event",
    `owner${entity[0]!.toUpperCase()}${entity.slice(1)}Id`,
  );
  const eventRelationName = `relationship:event.${entity}`;
  const eventQualified = builder.filter(
    events,
    nonBlankAsciiSpace(builder, eventAttribute),
  );
  const eventEntities = builder.distinctEntity(
    eventQualified,
    eventRelationName,
    entity,
  );
  return builder.setOperation("union", [pageEntities, eventEntities]);
}

function countRawDistinctPageValue(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  name: "sessions" | "visitors",
  attributeName: "sessionId" | "visitorId",
) {
  const value = attribute(builder, pages, "page", attributeName);
  const nonempty = builder.compare("neq", value, builder.literal("", STRING));
  const distinctValue = builder.caseWhen(
    [{ when: nonempty, then: value }],
    builder.literal(null, STRING),
  );
  return builder.aggregate(pages, {}, [
    { name, kind: "count-distinct", expression: distinctValue },
  ]);
}

function pageSummary(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
) {
  const duration = attribute(builder, pages, "page", "durationMs");
  if (
    duration.type.kind !== "scalar" ||
    duration.type.scalar !== "number" ||
    duration.type.unit !== "ms"
  )
    throw new Error("overview_duration_attribute_type_mismatch");
  const durationType = duration.type;
  const zeroDuration = builder.literal(0, durationType);
  const validDuration = builder.compare("gte", duration, zeroDuration);
  const durationForSum = builder.caseWhen(
    [{ when: validDuration, then: duration }],
    zeroDuration,
  );
  const durationForCount = builder.caseWhen(
    [{ when: validDuration, then: builder.literal(1, NUMBER) }],
    builder.literal(0, NUMBER),
  );
  const summary = builder.aggregate(pages, {}, [
    { name: "views", kind: "count-rows" },
    { name: "totalDurationRaw", kind: "sum", expression: durationForSum },
    { name: "durationViewsRaw", kind: "sum", expression: durationForCount },
  ]);
  return builder.project(summary, {
    views: builder.slot(summary, "views"),
    totalDuration: builder.coalesce(
      builder.slot(summary, "totalDurationRaw"),
      builder.literal(0, durationType),
    ),
    durationViews: builder.coalesce(
      builder.slot(summary, "durationViewsRaw"),
      builder.literal(0, NUMBER),
    ),
  });
}

function bounceCount(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
) {
  const sessionId = attribute(builder, pages, "page", "sessionId");
  const eligiblePages = builder.filter(
    pages,
    builder.compare("neq", sessionId, builder.literal("", STRING)),
  );
  const pageCounts = builder.aggregate(eligiblePages, { sessionId }, [
    { name: "pageCount", kind: "count-rows" },
  ]);
  const bounceSessions = builder.filter(
    pageCounts,
    builder.compare(
      "eq",
      builder.slot(pageCounts, "pageCount"),
      builder.literal(1, NUMBER),
    ),
  );
  return scalarCount(builder, bounceSessions, "bounces");
}

/** Builds all six legacy Overview metrics from one shared Page/Event context. */
export function buildOverviewAggregatePlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
}): ValidatedLogicalPlan {
  const metadata = scopedFilterMetadata(input.filters);
  const directCompatibilitySelection =
    !metadata && input.filters.root !== null
      ? createSemanticScopedSourceSelection({
          profile: "direct-page-session-compat-v1",
          filters: input.filters,
          subject: createSemanticSubjectDomain({
            origin: "site",
            siteIds: [input.siteId as SiteId],
          }),
          time: semanticTemporalDomainsFromQueryTime(input.queryTime),
        })
      : undefined;
  const scoped = metadata !== undefined || input.filters.root !== null;
  const includeEvents =
    metadata !== undefined ||
    (directCompatibilitySelection !== undefined &&
      input.filters.root !== null &&
      factEntityKindsForFilter(input.filters.root).size > 0);
  const relationships: readonly SemanticRelationshipId[] = scoped
    ? ["page.session", "page.visitor"]
    : [];
  const { builder, pages, selection } = createPageReportSource({
    ...input,
    ...(metadata
      ? {
          scopePlan: metadata.plan,
          preparedTimePolicy: "scoped-reader-window-v1" as const,
        }
      : {}),
    ...(directCompatibilitySelection
      ? { sourceSelection: directCompatibilitySelection }
      : {}),
    attributes: [
      "page.report.sessionId",
      "page.report.visitorId",
      "page.report.durationMs",
    ],
    relationships,
  });

  const events = includeEvents
    ? builder.source("event", {
        temporalDomain: "candidate",
        attributes: [
          "event.report.ownerSessionId",
          "event.report.ownerVisitorId",
        ],
        relationships: ["event.session", "event.visitor"],
        selection,
      })
    : undefined;

  const summary = pageSummary(builder, pages);
  const bounces = bounceCount(builder, pages);
  const outputs = [summary, bounces];

  if (scoped) {
    const sessions = scalarCount(
      builder,
      unionEntities(builder, pages, events, "session"),
      "sessions",
    );
    const visitors = scalarCount(
      builder,
      unionEntities(builder, pages, events, "visitor"),
      "visitors",
    );
    outputs.push(sessions, visitors);
  } else {
    outputs.push(
      countRawDistinctPageValue(builder, pages, "sessions", "sessionId"),
      countRawDistinctPageValue(builder, pages, "visitors", "visitorId"),
    );
  }

  const combined = outputs
    .slice(1)
    .reduce((left, right) => builder.join(left, right, []), outputs[0]!);
  const output = builder.project(combined, {
    views: builder.slot(combined, "views"),
    sessions: builder.slot(combined, "right.sessions"),
    visitors: builder.slot(combined, "right.visitors"),
    bounces: builder.slot(combined, "right.bounces"),
    totalDuration: builder.slot(combined, "totalDuration"),
    durationViews: builder.slot(combined, "durationViews"),
  });
  builder.output("overview-aggregate", output, [
    { name: "views", slot: "views" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
    { name: "bounces", slot: "bounces" },
    { name: "totalDuration", slot: "totalDuration" },
    { name: "durationViews", slot: "durationViews" },
  ]);
  return builder.finish();
}
