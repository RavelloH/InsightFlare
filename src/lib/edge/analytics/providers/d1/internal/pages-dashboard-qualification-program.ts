import type {
  PagesDashboardMetric,
  PagesDashboardReaderInput,
  QueryInput,
  QueryTime,
  ScopedFilterPlan,
} from "@/lib/edge/analytics/contract";
import type { PagesDashboardResult } from "@/lib/edge/analytics/contract";
import {
  PAGES_DASHBOARD_QUALIFICATION_OUTPUTS,
  PAGES_DASHBOARD_REPORT_FIELDS,
} from "@/lib/edge/analytics/engine/pages-dashboard-qualification-plan";
import type {
  FilterDocument,
  PageCardAggregateRow,
  PageCardTitleRow,
  PageCardTrendRow,
  QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  type DeferredPagesDashboardQualification,
  deferredPagesDashboardQualificationFromQuery,
  pagesDashboardQualificationConfigurationsEqual,
} from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-request";
import type { Env } from "@/lib/edge/types";

import {
  buildTimeBuckets,
  mapPageCardMetrics,
  timeBucketTimestamp,
} from "./core";
import { queryD1CompiledAll } from "./core";
import type {
  AdvancedCountSqlFallbackReason,
  D1ReadDiagnostics,
} from "./diagnostics";
import {
  mapPagesDashboardResultRows,
  type PageDashboardCursor,
  pageDashboardCursor,
  pagesDashboardCursorBinding,
} from "./pages-dashboard";
import { compilePagesDashboardQualificationProgram } from "./pages-dashboard-qualification-compiler";
import {
  decodePageCursor,
  encodePageCursor,
  InvalidCursorError,
} from "./pagination";
import type { QualificationEnvelopeCompilationEvidence } from "./qualification-program-envelope";
import {
  decodeQualificationControl,
  executeQualificationQuery,
  judgeQualificationControl,
} from "./qualification-program-runtime";

type PreparedDashboardQuery = QueryInput &
  Record<string, unknown> & {
    readonly time: QueryTime;
    readonly filters: FilterDocument;
    readonly scopePlan: ScopedFilterPlan;
  };

export type PagesDashboardQualificationExecution =
  | { readonly kind: "empty"; readonly value: PagesDashboardResult }
  | {
      readonly kind: "executed";
      readonly value: PagesDashboardResult;
      readonly evidence: QualificationEnvelopeCompilationEvidence;
      readonly reportRowCount: number;
      readonly controlRowCount: 1;
    }
  | {
      readonly kind: "fallback" | "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    };

function queryWindow(time: QueryTime): QueryWindow {
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}

function exactKeys(row: Record<string, unknown>, fields: readonly string[]) {
  const actual = Object.keys(row).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length &&
    actual.every((field, index) => field === expected[index])
  );
}

function countValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function trimAsciiSpaces(value: string): string {
  return value.replace(/^ +| +$/gu, "");
}

function durationValue(value: unknown): value is number {
  return typeof value === "number" && !Number.isNaN(value) && value >= 0;
}

function reportNumber(
  row: Record<string, unknown>,
  field: string,
  kind: "count" | "duration",
): number {
  const value = row[field];
  if (kind === "count") {
    if (!countValue(value))
      throw new Error(
        `pages_dashboard_qualification_report_scalar_invalid:${field}`,
      );
    return value;
  }
  if (!durationValue(value))
    throw new Error(
      `pages_dashboard_qualification_report_scalar_invalid:${field}`,
    );
  return value;
}

function emptyReportFields(
  row: Record<string, unknown>,
  populatedFields: ReadonlySet<string>,
): boolean {
  return PAGES_DASHBOARD_REPORT_FIELDS.every(
    (field) => populatedFields.has(field) || row[field] === null,
  );
}

function decodeRows(input: {
  readonly rows: readonly Record<string, unknown>[];
  readonly request: DeferredPagesDashboardQualification;
  readonly evidence: QualificationEnvelopeCompilationEvidence;
  readonly window: QueryWindow;
  readonly interval: PagesDashboardReaderInput["interval"];
  readonly limit: number;
}):
  | {
      readonly kind: "executed";
      readonly valueRows: {
        readonly currentRows: readonly PageCardAggregateRow[];
        readonly previousRows: readonly PageCardAggregateRow[];
        readonly details: {
          readonly titles: readonly PageCardTitleRow[];
          readonly trend: readonly PageCardTrendRow[];
        };
        readonly hasMore: boolean;
      };
      readonly reportRowCount: number;
      readonly evidence: QualificationEnvelopeCompilationEvidence;
    }
  | {
      readonly kind: "fallback";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    } {
  const { rows, evidence, request, window, interval, limit } = input;
  const envelopeFields = [
    "rowKind",
    "outputId",
    ...PAGES_DASHBOARD_REPORT_FIELDS,
    ...evidence.controlFields,
  ];
  const expectedOutputTypes = new Map<string, string>([
    [PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.current, "pages-dashboard-current"],
    [PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.titles, "pages-dashboard-title"],
    [PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.trend, "pages-dashboard-trend"],
  ]);
  if (
    evidence.outputDescriptors.length !== expectedOutputTypes.size ||
    evidence.outputDescriptors.some(
      ({ outputId, rowType }) => expectedOutputTypes.get(outputId) !== rowType,
    )
  )
    throw new Error("pages_dashboard_qualification_output_descriptor_invalid");

  const controlRows: Record<string, unknown>[] = [];
  const reportRows: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (!exactKeys(row, envelopeFields))
      throw new Error("pages_dashboard_qualification_envelope_row_invalid");
    if (row.rowKind === "control") controlRows.push(row);
    else if (row.rowKind === "report") reportRows.push(row);
    else throw new Error("pages_dashboard_qualification_row_kind_invalid");
  }
  if (
    controlRows.length !== 1 ||
    rows.length !== controlRows.length + reportRows.length
  )
    throw new Error("pages_dashboard_qualification_control_row_invalid");
  const control = controlRows[0]!;
  if (
    control.outputId !== evidence.controlOutputId ||
    control.entityKind !== request.qualification.countInput.scope ||
    PAGES_DASHBOARD_REPORT_FIELDS.some((field) => control[field] !== null)
  )
    throw new Error("pages_dashboard_qualification_control_kind_mismatch");
  const decodedControl = decodeQualificationControl({
    read: (field) => control[field],
    compatibilityFields: evidence.compatibilityFields,
    errorLabel: (field) =>
      `pages_dashboard_qualification_control_invalid:${field}`,
  });
  const judgment = judgeQualificationControl(decodedControl, {
    reportRowCount: reportRows.length,
    gateViolation: () =>
      new Error("pages_dashboard_qualification_gate_violation"),
    invalidIdentity: () =>
      new Error("advanced_filter_count_combined_identity_invalid"),
    duplicateIdentity: () =>
      new Error("advanced_filter_count_combined_identity_repeated"),
  });
  if (judgment.kind === "fallback") return judgment;

  const buckets = buildTimeBuckets(window, interval);
  const currentDescriptor = evidence.outputDescriptors.find(
    ({ outputId }) =>
      outputId === PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.current,
  );
  const titleDescriptor = evidence.outputDescriptors.find(
    ({ outputId }) => outputId === PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.titles,
  );
  const trendDescriptor = evidence.outputDescriptors.find(
    ({ outputId }) => outputId === PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.trend,
  );
  if (!currentDescriptor || !titleDescriptor || !trendDescriptor)
    throw new Error("pages_dashboard_qualification_output_descriptor_missing");

  const currentRows: PageCardAggregateRow[] = [];
  const previousRowsAll: PageCardAggregateRow[] = [];
  const currentPaths = new Set<string>();
  const displayNormalizedPaths = new Set(
    reportRows
      .filter(
        (row) =>
          row.outputId === PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.current &&
          typeof row.pathname === "string" &&
          Number.isSafeInteger(row.rowOrder) &&
          (row.rowOrder as number) > 0 &&
          (row.rowOrder as number) <= limit,
      )
      .map((row) => (row.pathname as string).trim())
      .filter((pathname) => pathname.length > 0),
  );
  const currentOrders = new Set<number>();
  let lastCurrentOrder = -1;
  const titles: PageCardTitleRow[] = [];
  const titleRanks = new Set<string>();
  const titleCounts = new Map<string, number>();
  const trends: PageCardTrendRow[] = [];
  const trendBuckets = new Set<string>();
  const reportKeys = new Set<string>();
  const controlsFields = evidence.controlFields;

  for (const row of reportRows) {
    const outputId = row.outputId;
    if (!expectedOutputTypes.has(String(outputId)))
      throw new Error("pages_dashboard_qualification_report_output_invalid");
    if (controlsFields.some((field) => row[field] !== null))
      throw new Error(
        "pages_dashboard_qualification_report_control_shape_invalid",
      );

    if (outputId === PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.current) {
      if (
        !emptyReportFields(
          row,
          new Set(
            PAGES_DASHBOARD_REPORT_FIELDS.filter(
              (field) => field !== "bucket" && field !== "title",
            ),
          ),
        ) ||
        typeof row.pathname !== "string" ||
        !countValue(row.rowOrder)
      )
        throw new Error("pages_dashboard_qualification_current_shape_invalid");
      const pathname = row.pathname;
      const rowOrder = row.rowOrder;
      if (
        currentPaths.has(pathname) ||
        currentOrders.has(rowOrder) ||
        rowOrder !== currentRows.length + 1 ||
        rowOrder <= lastCurrentOrder ||
        reportKeys.has(`current\0${pathname}`)
      )
        throw new Error("pages_dashboard_qualification_report_duplicate");
      currentPaths.add(pathname);
      currentOrders.add(rowOrder);
      lastCurrentOrder = rowOrder;
      reportKeys.add(`current\0${pathname}`);
      const current: PageCardAggregateRow = {
        pathname,
        views: reportNumber(row, "views", "count"),
        sessions: reportNumber(row, "sessions", "count"),
        visitors: reportNumber(row, "visitors", "count"),
        bounces: reportNumber(row, "bounces", "count"),
        totalDuration: reportNumber(row, "totalDuration", "duration"),
        durationViews: reportNumber(row, "durationViews", "count"),
      };
      const previous: PageCardAggregateRow = {
        pathname,
        views: reportNumber(row, "previousViews", "count"),
        sessions: reportNumber(row, "previousSessions", "count"),
        visitors: reportNumber(row, "previousVisitors", "count"),
        bounces: reportNumber(row, "previousBounces", "count"),
        totalDuration: reportNumber(row, "previousTotalDuration", "duration"),
        durationViews: reportNumber(row, "previousDurationViews", "count"),
      };
      currentRows.push(current);
      previousRowsAll.push(previous);
      continue;
    }

    if (outputId === PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.titles) {
      if (
        !emptyReportFields(
          row,
          new Set(["pathname", "title", "views", "rowOrder"]),
        ) ||
        typeof row.pathname !== "string" ||
        typeof row.title !== "string" ||
        !countValue(row.views) ||
        !countValue(row.rowOrder)
      )
        throw new Error("pages_dashboard_qualification_title_shape_invalid");
      const key = `${row.pathname}\0${row.rowOrder}`;
      if (
        titleRanks.has(key) ||
        !displayNormalizedPaths.has(trimAsciiSpaces(row.pathname)) ||
        reportKeys.has(`title\0${key}`)
      )
        throw new Error("pages_dashboard_qualification_report_duplicate");
      titleRanks.add(key);
      reportKeys.add(`title\0${key}`);
      const count = (titleCounts.get(row.pathname) ?? 0) + 1;
      if (count > 3)
        throw new Error(
          "pages_dashboard_qualification_title_cardinality_invalid",
        );
      titleCounts.set(row.pathname, count);
      titles.push({
        pathname: row.pathname,
        title: row.title,
        views: row.views,
      });
      continue;
    }

    if (outputId === PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.trend) {
      if (
        !emptyReportFields(
          row,
          new Set(["pathname", "bucket", "views", "visitors"]),
        ) ||
        typeof row.pathname !== "string" ||
        !countValue(row.bucket) ||
        row.bucket >= buckets.length ||
        !displayNormalizedPaths.has(trimAsciiSpaces(row.pathname)) ||
        !countValue(row.views) ||
        !countValue(row.visitors)
      )
        throw new Error("pages_dashboard_qualification_trend_shape_invalid");
      const key = `${row.pathname}\0${row.bucket}`;
      if (trendBuckets.has(key) || reportKeys.has(`trend\0${key}`))
        throw new Error("pages_dashboard_qualification_report_duplicate");
      trendBuckets.add(key);
      reportKeys.add(`trend\0${key}`);
      trends.push({
        pathname: row.pathname,
        bucket: row.bucket,
        timestampMs: timeBucketTimestamp(buckets, row.bucket),
        views: row.views,
        visitors: row.visitors,
      });
      continue;
    }
    throw new Error("pages_dashboard_qualification_report_output_invalid");
  }

  if (currentRows.length > limit + 1)
    throw new Error(
      "pages_dashboard_qualification_current_cardinality_invalid",
    );
  const hasMore = currentRows.length > limit;
  const displayRows = currentRows.slice(0, limit);
  const displayPaths = new Set(displayRows.map(({ pathname }) => pathname));
  const previousRows = previousRowsAll.slice(0, limit);
  const details = {
    titles: titles.filter(({ pathname }) => displayPaths.has(pathname)),
    trend: trends.filter(({ pathname }) => displayPaths.has(pathname)),
  };
  return {
    kind: "executed",
    valueRows: { currentRows: displayRows, previousRows, details, hasMore },
    reportRowCount: reportRows.length,
    evidence,
  };
}

function cursorFor(
  row: PageCardAggregateRow,
  sort: PagesDashboardMetric,
): PageDashboardCursor {
  const metrics = mapPageCardMetrics(row);
  return {
    primary:
      sort === "visitors"
        ? metrics.visitors
        : sort === "sessions"
          ? metrics.sessions
          : sort === "bounceRate"
            ? metrics.bounceRate
            : sort === "pagesPerSession"
              ? metrics.pagesPerSession
              : sort === "avgDurationMs"
                ? metrics.avgDurationMs
                : metrics.views,
    secondary:
      sort === "views" || sort === "bounceRate"
        ? metrics.sessions
        : metrics.views,
    pathname: row.pathname,
  };
}

export async function executePagesDashboardQualificationProgram(input: {
  readonly env: Env;
  readonly siteId: string;
  readonly query: QueryInput & Record<string, unknown>;
  readonly diagnostics?: D1ReadDiagnostics;
  readonly compileProgram?: typeof compilePagesDashboardQualificationProgram;
}): Promise<PagesDashboardQualificationExecution> {
  const query = input.query as PreparedDashboardQuery;
  const request = deferredPagesDashboardQualificationFromQuery(query);
  if (!request)
    throw new Error("pages_dashboard_qualification_request_untrusted");
  const { qualification, configuration } = request;
  if (
    qualification.siteId !== input.siteId ||
    qualification.requestTime !== query.time ||
    qualification.filters !== query.filters ||
    qualification.requestScopePlan !== query.scopePlan ||
    !pagesDashboardQualificationConfigurationsEqual(
      qualification.pagesDashboardRequest,
      configuration,
    )
  )
    throw new Error("pages_dashboard_qualification_request_changed");

  const window = queryWindow(qualification.requestTime);
  const readerInput: PagesDashboardReaderInput = {
    window,
    filters: qualification.filters,
    interval: configuration.interval,
    page: { limit: configuration.limit, cursor: configuration.cursorText },
    search: configuration.search,
    sort: { key: configuration.sort, direction: configuration.direction },
    audience: configuration.audience,
  };
  const cursorBinding = await pagesDashboardCursorBinding(
    input.siteId,
    readerInput,
  );
  let cursor: PageDashboardCursor | null = null;
  let invalidCursor = false;
  if (configuration.cursorText) {
    try {
      cursor = await decodePageCursor<PageDashboardCursor>(
        input.env,
        cursorBinding,
        configuration.cursorText,
        "pages-dashboard",
        pageDashboardCursor,
      );
    } catch (error) {
      if (!(error instanceof InvalidCursorError)) throw error;
      invalidCursor = true;
    }
    if (!cursor) invalidCursor = true;
  }
  if (invalidCursor) cursor = null;

  const compilation = (
    input.compileProgram ?? compilePagesDashboardQualificationProgram
  )({
    query,
    qualification: {
      siteId: input.siteId,
      queryTime: qualification.requestTime,
      filters: qualification.filters,
      scopePlan: query.scopePlan,
      count: qualification.countInput,
      interval: configuration.interval,
      limit: configuration.limit,
      sort: configuration.sort,
      direction: configuration.direction,
      cursor,
      ...(configuration.search?.trim()
        ? { search: configuration.search.trim().toLowerCase() }
        : {}),
    },
  });
  if (compilation.kind === "unavailable")
    return { kind: "unavailable", fallbackReason: compilation.fallbackReason };
  const rows = await executeQualificationQuery(qualification.signal, () =>
    queryD1CompiledAll<Record<string, unknown>>(
      input.env,
      compilation.query,
      input.diagnostics,
    ),
  );
  const decoded = decodeRows({
    rows,
    request,
    evidence: compilation.evidence,
    window,
    interval: configuration.interval,
    limit: configuration.limit,
  });
  if (decoded.kind === "fallback") return decoded;
  if (invalidCursor) throw new InvalidCursorError("pages-dashboard");
  if (configuration.limit === 0) {
    return {
      kind: "empty",
      value: mapPagesDashboardResultRows({
        interval: configuration.interval,
        limit: 0,
        currentRows: [],
        previousRows: [],
        details: { titles: [], trend: [] },
        hasMore: false,
        nextCursor: null,
      }),
    };
  }

  const lastRow = decoded.valueRows.currentRows.at(-1);
  const nextCursor =
    decoded.valueRows.hasMore && lastRow
      ? await encodePageCursor(
          input.env,
          cursorBinding,
          cursorFor(lastRow, configuration.sort),
        )
      : null;
  const value = mapPagesDashboardResultRows({
    interval: configuration.interval,
    limit: configuration.limit,
    currentRows: decoded.valueRows.currentRows,
    previousRows: decoded.valueRows.previousRows,
    details: decoded.valueRows.details,
    hasMore: decoded.valueRows.hasMore,
    nextCursor,
  });
  return {
    kind: "executed",
    value,
    evidence: decoded.evidence,
    reportRowCount: decoded.reportRowCount,
    controlRowCount: 1,
  };
}
