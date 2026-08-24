import { typedQueryProvider } from "@/lib/edge/analytics/application/provider-registry";
import type {
  OverviewQuery,
  OverviewReader,
  OverviewResult,
  TrendQuery,
  TrendResult,
} from "@/lib/edge/analytics/contract";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";

export function overviewProvider(reader: OverviewReader) {
  return typedQueryProvider<OverviewResult>(async (input) => {
    const query = input as OverviewQuery;
    const filters = query.filters ?? EMPTY_FILTER_DOCUMENT;
    const current = await reader.readOverview({
      time: query.time,
      filters,
    });
    const previous = query.previousTime
      ? await reader.readOverview({
          time: query.previousTime,
          filters,
        })
      : undefined;
    const detailInterval = query.detailInterval;
    const detail = detailInterval
      ? await reader.readTrend({
          time: query.time,
          filters,
          interval: detailInterval,
        })
      : undefined;
    const detailResult =
      detail && detailInterval
        ? { interval: detailInterval, points: detail.value }
        : undefined;

    return {
      value: {
        current: current.value,
        ...(previous ? { previous: previous.value } : {}),
        ...(detailResult ? { detail: detailResult } : {}),
      },
      source:
        previous && previous.source !== current.source
          ? "mixed"
          : current.source,
      approximateVisitors:
        current.approximateVisitors || Boolean(previous?.approximateVisitors),
    };
  });
}

export function trendProvider(reader: OverviewReader) {
  return typedQueryProvider<TrendResult>(async (input) => {
    const query = input as TrendQuery;
    const result = await reader.readTrend({
      time: query.time,
      filters: query.filters ?? EMPTY_FILTER_DOCUMENT,
      interval: query.interval,
    });
    return {
      value: {
        interval: query.interval,
        points: result.value,
      },
      source: result.source,
      approximateVisitors: result.approximateVisitors,
    };
  });
}
