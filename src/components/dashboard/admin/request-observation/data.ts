import type { TimeWindow } from "@/lib/dashboard/query-state";
import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";

import {
  BOT_EVENT_FETCH_LIMIT,
  type BotEvent,
  type NormalRequestEvent,
  type RequestNetworkDimensionRow,
  type RequestObservationData,
  type RequestObservationDetailData,
  type RequestObservationDimensionData,
  type RequestObservationPageData,
  withRequestObservabilityDefaults,
} from "./model";
export async function fetchRequestObservation(
  timeWindow: TimeWindow,
  signal?: AbortSignal,
): Promise<RequestObservationData> {
  const payload = await requestAdminService<RequestObservationData>(
    "request-observation",
    {
      params: {
        from: String(Math.floor(timeWindow.from)),
        to: String(Math.floor(timeWindow.to)),
        interval: timeWindow.interval,
        timeZone: timeWindow.timeZone,
        limit: String(BOT_EVENT_FETCH_LIMIT),
      },
      signal,
    },
  );
  return withRequestObservabilityDefaults(payload);
}
export async function fetchRequestObservationPage(
  timeWindow: TimeWindow,
  source: "blocked" | "included",
  cursor: string,
): Promise<RequestObservationPageData> {
  return requestAdminService<RequestObservationPageData>(
    "request-observation",
    {
      params: {
        from: String(Math.floor(timeWindow.from)),
        to: String(Math.floor(timeWindow.to)),
        interval: timeWindow.interval,
        timeZone: timeWindow.timeZone,
        source,
        limit: String(BOT_EVENT_FETCH_LIMIT),
        cursor,
      },
    },
  );
}
export async function fetchRequestObservationDimension(
  timeWindow: TimeWindow,
  source: "blocked" | "included",
  group: "detection" | "target" | "network" | "client",
  tab: string,
  signal?: AbortSignal,
): Promise<RequestNetworkDimensionRow[]> {
  const payload = await requestAdminService<RequestObservationDimensionData>(
    "request-observation",
    {
      params: {
        from: String(Math.floor(timeWindow.from)),
        to: String(Math.floor(timeWindow.to)),
        interval: timeWindow.interval,
        timeZone: timeWindow.timeZone,
        dimensionSource: source,
        dimensionGroup: group,
        dimensionTab: tab,
      },
      signal,
    },
  );
  if (!payload.dimension) {
    throw new Error("load_bot_protection_failed");
  }
  return payload.dimension.rows;
}
export async function fetchRequestObservationDetail<
  T extends BotEvent | NormalRequestEvent,
>(timeWindow: TimeWindow, event: T, signal?: AbortSignal): Promise<T | null> {
  const payload = await requestAdminService<RequestObservationDetailData>(
    "request-observation",
    {
      params: {
        from: String(Math.floor(timeWindow.from)),
        to: String(Math.floor(timeWindow.to)),
        interval: timeWindow.interval,
        timeZone: timeWindow.timeZone,
        detail: "1",
        ...(event.traceId ? { traceId: event.traceId } : {}),
        ...(event.rayId ? { rayId: event.rayId } : {}),
      },
      signal,
    },
  );
  return payload.detail as T | null;
}
