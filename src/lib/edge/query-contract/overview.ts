import { type FilterDocument } from "./filters";
import { EMPTY_FILTER_DOCUMENT } from "./helpers";
import { validateTypedQueryFilters } from "./operations";
import { assertOperationAllowed } from "./policy";
import type {
  AnalyticsResult,
  OverviewMetrics,
  OverviewQuery,
  OverviewResult,
  QueryContext,
  QuerySource,
  QueryTime,
  TrendPoint,
  TrendQuery,
  TrendResult,
} from "./types";

export interface OverviewReaderInput {
  readonly context: QueryContext;
  readonly time: QueryTime;
  readonly filters: FilterDocument;
}

export interface TrendReaderInput extends OverviewReaderInput {
  readonly interval: TrendQuery["interval"];
}

export interface OverviewReaderResult {
  readonly value: OverviewMetrics;
  readonly source: QuerySource;
  readonly approximateVisitors: boolean;
}

export interface TrendReaderResult {
  readonly value: readonly TrendPoint[];
  readonly source: QuerySource;
  readonly approximateVisitors: boolean;
}

export interface OverviewReader {
  readOverview(input: OverviewReaderInput): Promise<OverviewReaderResult>;
  readTrend(input: TrendReaderInput): Promise<TrendReaderResult>;
}

function denied<T>(
  error: NonNullable<ReturnType<typeof assertOperationAllowed>>,
): AnalyticsResult<T> {
  return { ok: false, error };
}

export async function executeOverview(
  reader: OverviewReader,
  input: OverviewQuery,
): Promise<AnalyticsResult<OverviewResult>> {
  const operationError = assertOperationAllowed(input.context, "overview");
  if (operationError) return denied(operationError);

  const filters = input.filters ?? EMPTY_FILTER_DOCUMENT;
  const filterError = validateTypedQueryFilters(input.context, filters);
  if (filterError) return { ok: false, error: filterError };
  const current = await reader.readOverview({
    context: input.context,
    time: input.time,
    filters,
  });
  const previous = input.previousTime
    ? await reader.readOverview({
        context: input.context,
        time: input.previousTime,
        filters,
      })
    : undefined;
  let detail: TrendResult | undefined;
  if (input.detailInterval) {
    const trend = await executeTrend(reader, {
      context: input.context,
      time: input.time,
      filters,
      interval: input.detailInterval,
    });
    if (!trend.ok) return trend;
    detail = trend.data;
  }

  return {
    ok: true,
    data: {
      current: current.value,
      ...(previous ? { previous: previous.value } : {}),
      ...(detail ? { detail } : {}),
    },
    meta: {
      time: input.time,
      source:
        previous && previous.source !== current.source
          ? "mixed"
          : current.source,
      approximateVisitors:
        current.approximateVisitors || Boolean(previous?.approximateVisitors),
    },
  };
}

export async function executeTrend(
  reader: OverviewReader,
  input: TrendQuery,
): Promise<AnalyticsResult<TrendResult>> {
  const operationError = assertOperationAllowed(input.context, "trend");
  if (operationError) return denied(operationError);
  const filters = input.filters ?? EMPTY_FILTER_DOCUMENT;
  const filterError = validateTypedQueryFilters(input.context, filters);
  if (filterError) return { ok: false, error: filterError };
  const result = await reader.readTrend({
    context: input.context,
    time: input.time,
    filters,
    interval: input.interval,
  });
  return {
    ok: true,
    data: { interval: input.interval, points: result.value },
    meta: {
      time: input.time,
      source: result.source,
      approximateVisitors: result.approximateVisitors,
    },
  };
}
