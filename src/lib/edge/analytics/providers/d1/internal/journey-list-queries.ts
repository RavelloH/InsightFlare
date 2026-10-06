import { compileD1Query, lowerLogicalPlan } from "@/lib/db";
import type {
  FilterDocument,
  FunnelConfigV2,
} from "@/lib/edge/analytics/contract";
import {
  buildJourneySessionListReportPlan,
  buildJourneyVisitorListReportPlan,
  JOURNEY_SESSION_LIST_REPORT_OUTPUT,
  JOURNEY_VISITOR_LIST_REPORT_OUTPUT,
} from "@/lib/edge/analytics/engine/journey-entity-list-report-plan";
import {
  buildJourneyEventPageReportPlan,
  JOURNEY_EVENT_PAGE_REPORT_OUTPUT,
} from "@/lib/edge/analytics/engine/journey-event-page-report-plan";
import { buildJourneyTargetPresencePlan } from "@/lib/edge/analytics/engine/journey-target-presence-plan";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { currentD1Operation } from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
import { pageResult } from "@/lib/pagination";

import type {
  JourneyEventRow,
  ListSort,
  QueryWindow,
  SessionListSortKey,
  SessionRow,
  VisitorListSortKey,
  VisitorRow,
} from "./core";
import {
  DEFAULT_SESSION_LIST_SORT,
  DEFAULT_VISITOR_LIST_SORT,
  queryD1CompiledAll,
} from "./core";
import {
  mapJourneyEventRow,
  mapSessionRow,
  mapVisitorRow,
} from "./journey-helpers";
import { queryJourneyPageReportRowsFromD1 } from "./journey-page-report-query";
export type JourneyListAnalysis =
  | { readonly type: "goal"; readonly filter: FilterDocument }
  | {
      readonly type: "funnel";
      readonly config: FunnelConfigV2;
      readonly stepIndex: number;
      readonly outcome?: "converted" | "dropoff";
    };
export interface VisitorListCursor {
  sortValue: number;
  lastSeenAt?: number;
  visitorId: string;
}
export interface SessionListCursor {
  sortValue: number;
  startedAt?: number;
  sessionId: string;
}
export interface VisitorListPage {
  rows: VisitorRow[];
  nextCursor: VisitorListCursor | null;
}
export interface SessionListPage {
  rows: SessionRow[];
  nextCursor: SessionListCursor | null;
}
export interface JourneyEventCursor {
  readonly occurredAt: number;
  readonly id: string;
}
export interface JourneyEventPage {
  readonly items: readonly JourneyEventRow[];
  readonly pagination: {
    readonly limit: number;
    readonly returned: number;
    readonly hasMore: boolean;
    readonly nextCursor: JourneyEventCursor | null;
  };
}
/**
 * Establishes a target's site/window scope before reading its trajectory.
 * Empty trajectories are valid. Presence is established from the unfiltered
 * observation universe, so a target with only an in-window custom event (or a
 * session whose visit began before the window) is still a real target.
 */
export async function queryJourneyTargetExistsFromD1(
  env: Env,
  siteId: string,
  target: { readonly type: "visitor" | "session"; readonly value: string },
  window: QueryWindow,
): Promise<boolean> {
  const logicalPlan = buildJourneyTargetPresencePlan({
    siteId,
    target,
    window,
  });
  const output = logicalPlan.outputs[0];
  if (!output || output.fields.length !== 1)
    throw new Error("journey_target_presence_output_invalid");
  const lowerer = new AnalyticsLogicalToDbLowerer(logicalPlan, {
    siteId,
    time: logicalPlan.context.time,
  });
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(lowered, [
    { name: "present", slot: output.fields[0]!.slot },
  ]);
  const query = compileD1Query(lowerLogicalPlan(relation), {
    tag: currentD1Operation() ?? "analytics.query.all",
  });
  const rows = await queryD1CompiledAll(env, query);
  return rows.length > 0;
}
function visitorCursorFromRow(
  row: VisitorRow,
  sort: ListSort<VisitorListSortKey>,
): VisitorListCursor {
  return sort.key === "lastSeenAt"
    ? { sortValue: row.lastSeenAt, visitorId: row.visitorId }
    : {
        sortValue: row[sort.key],
        lastSeenAt: row.lastSeenAt,
        visitorId: row.visitorId,
      };
}
function sessionCursorFromRow(
  row: SessionRow,
  sort: ListSort<SessionListSortKey>,
): SessionListCursor {
  return sort.key === "startedAt"
    ? { sortValue: row.startedAt, sessionId: row.sessionId }
    : {
        sortValue: sort.key === "durationMs" ? row.durationMs : row[sort.key],
        startedAt: row.startedAt,
        sessionId: row.sessionId,
      };
}
export async function queryVisitorsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  targetVisitorId?: string,
  sort: ListSort<VisitorListSortKey> = DEFAULT_VISITOR_LIST_SORT,
  search?: string,
): Promise<VisitorRow[]> {
  const rows: VisitorRow[] = [];
  let cursor: VisitorListCursor | null = null;
  const pageLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  while (rows.length < limit) {
    const page = await queryVisitorListPageFromD1(
      env,
      siteId,
      window,
      filters,
      { limit: pageLimit, sort, search, cursor },
    );
    const candidates = targetVisitorId
      ? page.rows.filter((row) => row.visitorId === targetVisitorId)
      : page.rows;
    rows.push(...candidates.slice(0, limit - rows.length));
    if (rows.length >= limit || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return rows;
}
export async function queryVisitorListPageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  options: {
    limit: number;
    sort: ListSort<VisitorListSortKey>;
    search?: string;
    cursor?: VisitorListCursor | null;
    analysis?: JourneyListAnalysis;
  },
): Promise<VisitorListPage> {
  const plan = buildJourneyVisitorListReportPlan({
    siteId,
    window,
    filters,
    limit: options.limit,
    sort: options.sort,
    search: options.search,
    cursor: options.cursor,
    analysis: options.analysis,
  });
  const records = await queryJourneyPageReportRowsFromD1(
    env,
    plan,
    JOURNEY_VISITOR_LIST_REPORT_OUTPUT,
  );
  const hasMore = records.length > options.limit;
  const pageRecords = hasMore ? records.slice(0, options.limit) : records;
  const rows = pageRecords.map(mapVisitorRow);
  const lastRow = rows.at(-1);
  return {
    rows,
    nextCursor:
      hasMore && lastRow ? visitorCursorFromRow(lastRow, options.sort) : null,
  };
}
export async function querySessionsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  target?: { type: "visitor" | "session"; value: string },
  sort: ListSort<SessionListSortKey> = DEFAULT_SESSION_LIST_SORT,
  search?: string,
): Promise<SessionRow[]> {
  const rows: SessionRow[] = [];
  let cursor: SessionListCursor | null = null;
  const pageLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  while (rows.length < limit) {
    const page = await querySessionListPageFromD1(
      env,
      siteId,
      window,
      filters,
      {
        limit: pageLimit,
        sort,
        search,
        cursor,
        target,
      },
    );
    rows.push(...page.rows.slice(0, limit - rows.length));
    if (rows.length >= limit || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return rows;
}
export async function querySessionListPageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  options: {
    limit: number;
    sort: ListSort<SessionListSortKey>;
    search?: string;
    cursor?: SessionListCursor | null;
    target?: { readonly type: "visitor" | "session"; readonly value: string };
    analysis?: JourneyListAnalysis;
  },
): Promise<SessionListPage> {
  const plan = buildJourneySessionListReportPlan({
    siteId,
    window,
    filters,
    limit: options.limit,
    sort: options.sort,
    search: options.search,
    cursor: options.cursor,
    sessionTarget: options.target,
    analysis: options.analysis,
  });
  const records = await queryJourneyPageReportRowsFromD1(
    env,
    plan,
    JOURNEY_SESSION_LIST_REPORT_OUTPUT,
  );
  const hasMore = records.length > options.limit;
  const pageRecords = hasMore ? records.slice(0, options.limit) : records;
  const rows = pageRecords.map(mapSessionRow);
  const lastRow = rows.at(-1);
  return {
    rows,
    nextCursor:
      hasMore && lastRow ? sessionCursorFromRow(lastRow, options.sort) : null,
  };
}
export async function queryJourneyEventsPageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  target: { type: "visitor" | "session"; value: string },
  limit: number,
  cursor?: JourneyEventCursor | null,
): Promise<JourneyEventPage> {
  const plan = buildJourneyEventPageReportPlan({
    siteId,
    window,
    filters,
    target,
    limit,
    cursor,
  });
  const rows = await queryJourneyPageReportRowsFromD1(
    env,
    plan,
    JOURNEY_EVENT_PAGE_REPORT_OUTPUT,
  );
  const mapped = rows.map(mapJourneyEventRow);
  const page = pageResult(mapped, limit);
  const last = page.last;
  return {
    items: page.rows,
    pagination: {
      limit,
      returned: page.rows.length,
      hasMore: page.hasMore,
      nextCursor:
        page.hasMore && last
          ? { occurredAt: last.occurredAt, id: last.id }
          : null,
    },
  };
}
export async function queryJourneyEventsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  target: { type: "visitor" | "session"; value: string },
  limit: number,
): Promise<JourneyEventRow[]> {
  const page = await queryJourneyEventsPageFromD1(
    env,
    siteId,
    window,
    filters,
    target,
    limit,
  );
  return [...page.items];
}
