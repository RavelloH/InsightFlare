import {
  fetchPrivateJson,
  fetchPrivateJsonMutate,
} from "@/lib/dashboard/client/request";
import { withFilters, withPagination } from "@/lib/dashboard/client/utils";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  GoalDeleteData,
  GoalListData,
  GoalMutationData,
  GoalSummaryData,
  GoalTimeseriesData,
} from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract";
export async function fetchGoals(
  siteId: string,
  options?: {
    limit?: number;
    cursor?: string | null;
    signal?: AbortSignal;
  },
): Promise<GoalListData> {
  const requestParams = withPagination({ siteId }, options, 100);
  return fetchPrivateJson<GoalListData>("/api/private/goals", requestParams, {
    signal: options?.signal,
  });
}
export async function fetchGoalDefinition(
  siteId: string,
  goalId: string,
  options?: { signal?: AbortSignal },
): Promise<GoalMutationData> {
  return fetchPrivateJson<GoalMutationData>(
    "/api/private/goals",
    { siteId, id: goalId.trim() },
    { signal: options?.signal, dedupe: false },
  );
}
export async function fetchGoalSummary(
  siteId: string,
  goalId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: { signal?: AbortSignal; goalSemanticFingerprint?: string },
): Promise<GoalSummaryData> {
  return fetchPrivateJson<GoalSummaryData>(
    "/api/private/goal-summary",
    withFilters(
      {
        siteId,
        id: goalId.trim(),
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        ...(options?.goalSemanticFingerprint
          ? { goalFingerprint: options.goalSemanticFingerprint }
          : {}),
      },
      filters,
    ),
    { dedupe: false, signal: options?.signal },
  );
}
export async function fetchGoalTimeseries(
  siteId: string,
  goalId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: { signal?: AbortSignal; goalSemanticFingerprint?: string },
): Promise<GoalTimeseriesData> {
  return fetchPrivateJson<GoalTimeseriesData>(
    "/api/private/goal-timeseries",
    withFilters(
      {
        siteId,
        id: goalId.trim(),
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        interval: window.interval,
        ...(options?.goalSemanticFingerprint
          ? { goalFingerprint: options.goalSemanticFingerprint }
          : {}),
      },
      filters,
    ),
    { dedupe: false, signal: options?.signal },
  );
}
export async function createGoal(
  siteId: string,
  input: { name: string; filterDsl: string },
): Promise<GoalMutationData> {
  return fetchPrivateJsonMutate<GoalMutationData>(
    "/api/private/goals",
    "POST",
    { siteId },
    { name: input.name, filterDslVersion: 1, filterDsl: input.filterDsl },
  );
}
export async function updateGoal(
  siteId: string,
  goalId: string,
  input: { name?: string; filterDsl?: string },
): Promise<GoalMutationData> {
  return fetchPrivateJsonMutate<GoalMutationData>(
    "/api/private/goals",
    "PATCH",
    { siteId, id: goalId },
    {
      ...input,
      ...(input.filterDsl === undefined ? {} : { filterDslVersion: 1 }),
    },
  );
}
export async function deleteGoal(
  siteId: string,
  goalId: string,
): Promise<GoalDeleteData> {
  return fetchPrivateJsonMutate<GoalDeleteData>(
    "/api/private/goals",
    "DELETE",
    { siteId, id: goalId },
  );
}
