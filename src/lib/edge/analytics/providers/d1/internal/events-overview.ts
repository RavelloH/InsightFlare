import {
  planObservationFilter,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import {
  buildEventTypeOverviewPlan,
  EVENT_TYPE_OVERVIEW_FIELDS,
  EVENT_TYPE_OVERVIEW_OUTPUTS,
} from "@/lib/edge/analytics/engine/event-type-overview-plan";
import type { Env } from "@/lib/edge/types";

import { queryAnalyticsReportOutputSetRowsFromD1 } from "./analytics-report-query";
import type { DimensionRow, FilterDocument, QueryWindow } from "./core";
import type { EventMembershipFallback } from "./event-membership-fallback";

interface EventTypeOverviewRow extends Record<string, unknown> {
  readonly cardType?: unknown;
  readonly value?: unknown;
  readonly events?: unknown;
  readonly eventTypes?: unknown;
  readonly sessions?: unknown;
  readonly visitors?: unknown;
  readonly scopedEvents?: unknown;
}

export async function queryEventTypeOverviewFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  eventName: string,
  options?: {
    includeBreakdowns?: boolean;
    /** Request-private Event membership shared by the type-detail reports. */
    membership?: EventMembershipFallback;
  },
) {
  const metadata = scopedFilterMetadata(filters);
  const includeBreakdowns = options?.includeBreakdowns !== false;
  const denominatorSource =
    metadata || options?.membership
      ? "event-report"
      : planObservationFilter(filters.root).event.kind === "all"
        ? "raw-event-domain"
        : "event-report";
  const bound = options?.membership?.bindPlan((context) =>
    buildEventTypeOverviewPlan({
      siteId,
      queryTime: context.queryTime,
      filters,
      scopePlan: context.scopePlan,
      qualificationDependencyRefs: context.qualificationDependencyRefs,
      eventName,
      includeBreakdowns,
      denominatorSource,
    }),
  );
  const plan =
    bound?.plan ??
    buildEventTypeOverviewPlan({
      siteId,
      queryTime: metadata?.time ?? queryWindowToTime(window),
      filters,
      ...(metadata ? { scopePlan: metadata.plan } : {}),
      eventName,
      includeBreakdowns,
      denominatorSource,
    });
  const outputIds = [
    EVENT_TYPE_OVERVIEW_OUTPUTS.summary,
    ...(includeBreakdowns
      ? [
          EVENT_TYPE_OVERVIEW_OUTPUTS.page,
          EVENT_TYPE_OVERVIEW_OUTPUTS.country,
          EVENT_TYPE_OVERVIEW_OUTPUTS.device,
          EVENT_TYPE_OVERVIEW_OUTPUTS.browser,
        ]
      : []),
  ];
  const rows = (await queryAnalyticsReportOutputSetRowsFromD1(
    env,
    plan,
    {
      outputIds,
      fields: EVENT_TYPE_OVERVIEW_FIELDS.map(({ name }) => name),
      orderBy: [
        { field: "cardType", direction: "asc", nulls: "first" },
        { field: "events", direction: "desc", nulls: "last" },
        { field: "sessions", direction: "desc", nulls: "last" },
        { field: "value", direction: "asc", nulls: "first" },
      ],
    },
    undefined,
    bound?.executionInputs,
  )) as EventTypeOverviewRow[];
  const summaryRow = rows.find((row) => row.cardType === "summary");
  const readDimension = (cardType: string): DimensionRow[] =>
    rows
      .filter((row) => row.cardType === cardType)
      .map((row) => ({
        value: String(row.value ?? ""),
        views: Number(row.events ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
      }));
  const summary = summaryRow ?? {};
  const summaryEvents = Number(summary.events ?? 0);
  const summaryEventTypes = Number(summary.eventTypes ?? 0);
  const summarySessions = Number(summary.sessions ?? 0);
  const summaryVisitors = Number(summary.visitors ?? 0);
  const scopedEvents = Number(summary.scopedEvents ?? 0);
  return {
    summary: {
      events: summaryEvents,
      eventTypes: summaryEventTypes,
      sessions: summarySessions,
      visitors: summaryVisitors,
      avgEventsPerSession:
        summarySessions > 0 ? summaryEvents / summarySessions : 0,
      shareOfAllEvents: scopedEvents > 0 ? summaryEvents / scopedEvents : 0,
    },
    breakdowns: {
      pages: readDimension("page"),
      countries: readDimension("country"),
      devices: readDimension("device"),
      browsers: readDimension("browser"),
    },
  };
}
