import { scopedFilterMetadata } from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import {
  buildEventContextReportPlan,
  EVENT_CONTEXT_REPORT_OUTPUT,
} from "@/lib/edge/analytics/engine/event-context-report-plan";
import {
  EVENT_CONTEXT_CARD_KEYS,
  EVENT_CONTEXT_CARDS,
  type EventContextCardKey,
} from "@/lib/edge/analytics/engine/semantic/event-context-cards";
import type { Env } from "@/lib/edge/types";

import { queryAnalyticsReportOutputRowsFromD1 } from "./analytics-report-query";
import type {
  DimensionRow,
  EventAnalyticsContextCards,
  FilterDocument,
  GeoTabRow,
  QueryWindow,
} from "./core";

export { EVENT_CONTEXT_CARD_KEYS };
export type { EventContextCardKey };

function emptyCards(): EventAnalyticsContextCards {
  return {
    page: {
      path: [],
      query: [],
      title: [],
      hostname: [],
      entry: [],
      exit: [],
    },
    source: { domain: [], link: [] },
    client: {
      browser: [],
      osVersion: [],
      deviceType: [],
      language: [],
      screenSize: [],
    },
    geo: {
      country: [],
      region: [],
      city: [],
      continent: [],
      timezone: [],
      organization: [],
    },
  };
}

function mapContextCardRows(
  rows: readonly Record<string, unknown>[],
): EventAnalyticsContextCards {
  const cards = emptyCards();
  for (const row of rows) {
    const key = String(row.cardType ?? "") as EventContextCardKey;
    if (!Object.hasOwn(EVENT_CONTEXT_CARDS, key)) continue;
    const dimension: DimensionRow = {
      value: String(row.value ?? ""),
      views: Number(row.views ?? 0),
      sessions: Number(row.sessions ?? 0),
      visitors: Number(row.visitors ?? 0),
    };
    const geo: GeoTabRow = {
      ...dimension,
      label: String(row.label ?? row.value ?? ""),
    };
    switch (key) {
      case "path":
      case "query":
      case "title":
      case "hostname":
      case "entry":
      case "exit":
        cards.page[key] = [...cards.page[key], dimension];
        break;
      case "sourceDomain":
        cards.source.domain.push(dimension);
        break;
      case "sourceLink":
        cards.source.link.push(dimension);
        break;
      case "browser":
      case "osVersion":
      case "deviceType":
      case "language":
      case "screenSize":
        cards.client[key].push(dimension);
        break;
      case "country":
      case "region":
      case "city":
      case "continent":
      case "timezone":
      case "organization":
        cards.geo[key].push(geo);
        break;
    }
  }
  return cards;
}

/** Reads Event-owner context cards in one validated Logical D1 query. */
export async function queryEventAnalyticsContextCardsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  eventName?: string,
  selectedKeys: readonly EventContextCardKey[] = EVENT_CONTEXT_CARD_KEYS,
): Promise<EventAnalyticsContextCards> {
  const selected = new Set(selectedKeys);
  const plan = buildEventContextReportPlan({
    siteId,
    // The reader window is the candidate range; prepared scope time remains
    // available on its validated selection as preparation-time metadata.
    queryTime: queryWindowToTime(window),
    filters,
    ...(scopedFilterMetadata(filters)
      ? { scopePlan: scopedFilterMetadata(filters)!.plan }
      : {}),
    ...(eventName !== undefined ? { eventName } : {}),
    limit,
    selectedKeys: EVENT_CONTEXT_CARD_KEYS.filter((key) => selected.has(key)),
  });
  if (selected.size === 0) return emptyCards();
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    EVENT_CONTEXT_REPORT_OUTPUT,
  );
  return mapContextCardRows(rows);
}
