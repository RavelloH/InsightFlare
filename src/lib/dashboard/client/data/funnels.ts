import {
  fetchPrivateJson,
  fetchPrivateJsonMutate,
} from "@/lib/dashboard/client/request";
import { withFilters, withPagination } from "@/lib/dashboard/client/utils";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  FunnelDeleteData,
  FunnelDetailData,
  FunnelListData,
  FunnelMutationData,
  FunnelStep,
} from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract";
export async function fetchFunnels(
  siteId: string,
  options?: {
    limit?: number;
    cursor?: string | null;
    signal?: AbortSignal;
  },
): Promise<FunnelListData> {
  const requestParams = withPagination({ siteId }, options, 100);
  return options?.signal
    ? fetchPrivateJson<FunnelListData>("/api/private/funnels", requestParams, {
        signal: options.signal,
      })
    : fetchPrivateJson<FunnelListData>("/api/private/funnels", requestParams);
}
export async function fetchFunnelDetail(
  siteId: string,
  funnelId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: { signal?: AbortSignal },
): Promise<FunnelDetailData> {
  const normalizedFunnelId = funnelId.trim();
  if (!normalizedFunnelId) {
    throw new Error("Funnel id is required");
  }
  return fetchPrivateJson<FunnelDetailData>(
    "/api/private/funnels",
    withFilters(
      {
        siteId,
        id: normalizedFunnelId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
      },
      filters,
    ),
    { dedupe: false, signal: options?.signal },
  );
}
export async function createFunnel(
  siteId: string,
  input: {
    name: string;
    progressionScope: "session" | "visitor";
    conversionWindowMs: number | null;
    steps: FunnelStep[];
  },
): Promise<FunnelMutationData> {
  return fetchPrivateJsonMutate<FunnelMutationData>(
    "/api/private/funnels",
    "POST",
    { siteId },
    input,
  );
}
export async function updateFunnel(
  siteId: string,
  funnelId: string,
  input: {
    name?: string;
    progressionScope?: "session" | "visitor";
    conversionWindowMs?: number | null;
    steps?: FunnelStep[];
  },
): Promise<FunnelMutationData> {
  return fetchPrivateJsonMutate<FunnelMutationData>(
    "/api/private/funnels",
    "PATCH",
    { siteId, id: funnelId },
    input,
  );
}
export async function deleteFunnel(
  siteId: string,
  funnelId: string,
): Promise<FunnelDeleteData> {
  return fetchPrivateJsonMutate<FunnelDeleteData>(
    "/api/private/funnels",
    "DELETE",
    { siteId, id: funnelId },
  );
}
