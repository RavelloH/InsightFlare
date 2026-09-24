import type { z } from "zod";

import type * as ResourceContract from "@/lib/api-v1/contract/resources";
import {
  analyticsFilterRegistry,
  assertFilterAudience,
  type FilterDocument,
  normalizeFilterDocument,
} from "@/lib/edge/analytics/contract";
export type ApiV1ApplicationErrorCode =
  "not_found" | "internal_error" | "invalid_cursor";
export interface ApiV1ApplicationSuccess<Result, Meta = undefined> {
  readonly data: Result;
  readonly meta: Meta;
}
export type ApiV1ApplicationOutcome<Result, ErrorCode extends string> =
  | { readonly ok: true; readonly value: Result }
  | { readonly ok: false; readonly error: { readonly code: ErrorCode } };
export interface ApiV1ApplicationOperationMap {
  "savedFilters.list": {
    input: ResourceContract.ListTeamVisibleSavedFiltersInput;
    result: ResourceContract.SavedFilterPage;
    error: "internal_error" | "invalid_cursor";
  };
  "savedFilters.get": {
    input: ResourceContract.GetTeamVisibleSavedFilterInput;
    result: ResourceContract.SavedFilterDefinition;
    error: "not_found" | "internal_error";
  };
  "sites.list": {
    input: z.infer<typeof ResourceContract.ListSitesInputSchema>;
    result: z.infer<typeof ResourceContract.SiteResourcePageSchema>;
    error: "internal_error" | "invalid_cursor";
  };
  "sites.create": {
    input: z.infer<typeof ResourceContract.CreateSiteInputSchema>;
    result: z.infer<typeof ResourceContract.SiteResourceSchema>;
    error: "conflict" | "forbidden" | "internal_error";
  };
  "sites.get": {
    input: z.infer<typeof ResourceContract.GetSiteInputSchema>;
    result: z.infer<typeof ResourceContract.SiteResourceSchema>;
    error: "not_found" | "internal_error";
  };
  "sites.update": {
    input: z.infer<typeof ResourceContract.UpdateSiteInputSchema>;
    result: z.infer<typeof ResourceContract.SiteResourceSchema>;
    error: "not_found" | "conflict" | "internal_error";
  };
  "sites.delete": {
    input: z.infer<typeof ResourceContract.DeleteSiteInputSchema>;
    result: undefined;
    error: "not_found" | "internal_error";
  };
  "settings.tracking.get": {
    input: z.infer<typeof ResourceContract.SiteSettingsInputSchema>;
    result: z.infer<typeof ResourceContract.TrackingSettingsSchema>;
    error: "not_found" | "internal_error";
  };
  "settings.tracking.update": {
    input: z.infer<typeof ResourceContract.UpdateTrackingSettingsInputSchema>;
    result: z.infer<typeof ResourceContract.TrackingSettingsSchema>;
    error: "not_found" | "internal_error";
  };
  "settings.privacy.get": {
    input: z.infer<typeof ResourceContract.SiteSettingsInputSchema>;
    result: z.infer<typeof ResourceContract.PrivacySettingsSchema>;
    error: "not_found" | "internal_error";
  };
  "settings.privacy.update": {
    input: z.infer<typeof ResourceContract.UpdatePrivacySettingsInputSchema>;
    result: z.infer<typeof ResourceContract.PrivacySettingsSchema>;
    error: "not_found" | "internal_error";
  };
  "settings.sharing.get": {
    input: z.infer<typeof ResourceContract.SiteSettingsInputSchema>;
    result: z.infer<typeof ResourceContract.SharingSettingsSchema>;
    error: "not_found" | "internal_error";
  };
  "settings.sharing.update": {
    input: z.infer<typeof ResourceContract.UpdateSharingSettingsInputSchema>;
    result: z.infer<typeof ResourceContract.SharingSettingsSchema>;
    error: "not_found" | "conflict" | "internal_error";
  };
  "settings.trackingScript.get": {
    input: z.infer<typeof ResourceContract.TrackingScriptInputSchema>;
    result: z.infer<typeof ResourceContract.TrackingScriptSchema>;
    error: "not_found" | "internal_error";
  };
  "funnels.list": {
    input: z.infer<typeof ResourceContract.ListFunnelsInputSchema>;
    result: z.infer<typeof ResourceContract.FunnelResourcePageSchema>;
    error: "not_found" | "internal_error" | "invalid_cursor";
  };
  "funnels.create": {
    input: z.infer<typeof ResourceContract.CreateFunnelInputSchema>;
    result: z.infer<typeof ResourceContract.FunnelResourceSchema>;
    error: "not_found" | "invalid_input" | "internal_error";
  };
  "funnels.get": {
    input: z.infer<typeof ResourceContract.GetFunnelInputSchema>;
    result: z.infer<typeof ResourceContract.FunnelResourceSchema>;
    error: "not_found" | "internal_error";
  };
  "funnels.update": {
    input: z.infer<typeof ResourceContract.UpdateFunnelInputSchema>;
    result: z.infer<typeof ResourceContract.FunnelResourceSchema>;
    error: "not_found" | "invalid_input" | "internal_error";
  };
  "funnels.delete": {
    input: z.infer<typeof ResourceContract.GetFunnelInputSchema>;
    result: undefined;
    error: "not_found" | "internal_error";
  };
  "goals.list": {
    input: z.infer<typeof ResourceContract.ListGoalsInputSchema>;
    result: z.infer<typeof ResourceContract.GoalResourcePageSchema>;
    error: "not_found" | "internal_error" | "invalid_cursor";
  };
  "goals.create": {
    input: z.infer<typeof ResourceContract.CreateGoalInputSchema>;
    result: z.infer<typeof ResourceContract.GoalResourceSchema>;
    error: "not_found" | "invalid_input" | "internal_error";
  };
  "goals.get": {
    input: z.infer<typeof ResourceContract.GetGoalInputSchema>;
    result: z.infer<typeof ResourceContract.GoalResourceSchema>;
    error: "not_found" | "internal_error";
  };
  "goals.update": {
    input: z.infer<typeof ResourceContract.UpdateGoalInputSchema>;
    result: z.infer<typeof ResourceContract.GoalResourceSchema>;
    error: "not_found" | "invalid_input" | "internal_error";
  };
  "goals.delete": {
    input: z.infer<typeof ResourceContract.GetGoalInputSchema>;
    result: undefined;
    error: "not_found" | "internal_error";
  };
}
export type ApiV1ApplicationOperationId = keyof ApiV1ApplicationOperationMap;
export interface ApiV1ApplicationContext {
  readonly teamId: string;
  readonly siteIds: readonly string[];
}
export interface ApiV1ApplicationService {
  execute<K extends ApiV1ApplicationOperationId>(
    context: ApiV1ApplicationContext,
    operation: K,
    input: ApiV1ApplicationOperationMap[K]["input"],
    execution: { readonly signal?: AbortSignal; readonly deadlineMs?: number },
  ): Promise<
    ApiV1ApplicationOutcome<
      ApiV1ApplicationOperationMap[K]["result"],
      ApiV1ApplicationOperationMap[K]["error"]
    >
  >;
}
/** Runtime field definitions remain owned by the filter registry, not this wire contract. */
export function assertSavedFilterDocument(document: FilterDocument): void {
  if (document.version !== 1) throw new Error("unsupported_filter_version");
  if (document.root) {
    // Re-validate through the canonical registry before a definition crosses the API boundary.
    const normalized = normalizeFilterDocument(
      document,
      analyticsFilterRegistry,
    );
    assertFilterAudience(normalized, analyticsFilterRegistry, "api-v1");
  }
}
