/* Generated from ApiV1RouteRegistry. Keep transport behavior stable. */
import type { ZodType } from "zod";

import {
  CreateFunnelInputSchema,
  CreateSiteInputSchema,
  type FunnelResource,
  FunnelResourceSchema,
  GetTeamVisibleSavedFilterInputSchema,
  type ListTeamVisibleSavedFiltersInput,
  ListTeamVisibleSavedFiltersInputSchema,
  type PrivacySettings,
  PrivacySettingsSchema,
  type SavedFilterDefinition,
  type SavedFilterPage,
  type SharingSettings,
  SharingSettingsSchema,
  type SiteResource,
  SiteResourceSchema,
  type TrackingScript,
  TrackingScriptSchema,
  type TrackingSettings,
  TrackingSettingsSchema,
  UpdateFunnelBodySchema,
  UpdatePrivacySettingsBodySchema,
  UpdateSharingSettingsBodySchema,
  UpdateSiteBodySchema,
  UpdateTrackingSettingsBodySchema,
} from "@/lib/api-v1/application-registry";
import {
  type CapabilitiesData,
  CapabilitiesDataSchema,
  type RootData,
  RootDataSchema,
  type TeamData,
  TeamDataSchema,
  type TeamUsageData,
  TeamUsageDataSchema,
  type TokenCheckData,
  TokenCheckDataSchema,
  type TokenCheckInput,
  TokenCheckSchema,
  type TokenData,
  TokenDataSchema,
} from "@/lib/api-v1/core-registry";
import {
  type SiteBreakdownQueryDtoInput,
  SiteBreakdownQueryDtoSchema,
  type SiteChannelsQueryDtoInput,
  SiteChannelsQueryDtoSchema,
  type SiteComparisonBreakdownV2QueryDtoInput,
  SiteComparisonBreakdownV2QueryDtoSchema,
  type SiteComparisonQueryDtoInput,
  SiteComparisonQueryDtoSchema,
  type SiteCrossBreakdownQueryDtoInput,
  SiteCrossBreakdownQueryDtoSchema,
  type SiteEventDetailQueryDtoInput,
  SiteEventDetailQueryDtoSchema,
  type SiteEventFieldsQueryDtoInput,
  SiteEventFieldsQueryDtoSchema,
  type SiteEventFieldValuesQueryDtoInput,
  SiteEventFieldValuesQueryDtoSchema,
  type SiteEventsSearchQueryDtoInput,
  SiteEventsSearchQueryDtoSchema,
  type SiteEventsSummaryQueryDtoInput,
  SiteEventsSummaryQueryDtoSchema,
  type SiteEventsTimeseriesQueryDtoInput,
  SiteEventsTimeseriesQueryDtoSchema,
  type SiteEventTypeDetailQueryDtoInput,
  SiteEventTypeDetailQueryDtoSchema,
  type SiteEventTypesQueryDtoInput,
  SiteEventTypesQueryDtoSchema,
  type SiteFilterValuesQueryDtoInput,
  SiteFilterValuesQueryDtoSchema,
  type SiteFunnelAnalysisQueryDtoInput,
  SiteFunnelAnalysisQueryDtoSchema,
  type SiteJourneyEventDetailQueryDtoInput,
  SiteJourneyEventDetailQueryDtoSchema,
  type SiteOverviewQueryDto,
  SiteOverviewQueryDtoSchema,
  type SitePagesQueryDtoInput,
  SitePagesQueryDtoSchema,
  type SitePerformanceBreakdownQueryDtoInput,
  SitePerformanceBreakdownQueryDtoSchema,
  type SitePerformanceSummaryQueryDtoInput,
  SitePerformanceSummaryQueryDtoSchema,
  type SitePerformanceTimeseriesQueryDtoInput,
  SitePerformanceTimeseriesQueryDtoSchema,
  type SiteRealtimeActiveVisitorsQueryDtoInput,
  SiteRealtimeActiveVisitorsQueryDtoSchema,
  type SiteRealtimeEventsQueryDtoInput,
  SiteRealtimeEventsQueryDtoSchema,
  type SiteRealtimeSessionsQueryDtoInput,
  SiteRealtimeSessionsQueryDtoSchema,
  type SiteRealtimeSnapshotQueryDtoInput,
  SiteRealtimeSnapshotQueryDtoSchema,
  type SiteReferrersQueryDtoInput,
  SiteReferrersQueryDtoSchema,
  type SiteRetentionCohortsQueryDtoInput,
  SiteRetentionCohortsQueryDtoSchema,
  type SiteSessionDetailQueryDtoInput,
  SiteSessionDetailQueryDtoSchema,
  type SiteSessionEventsQueryDtoInput,
  SiteSessionEventsQueryDtoSchema,
  type SiteSessionsSearchQueryDtoInput,
  SiteSessionsSearchQueryDtoSchema,
  type SiteTimeseriesQueryDto,
  SiteTimeseriesQueryDtoSchema,
  type SiteVisitorDetailQueryDtoInput,
  SiteVisitorDetailQueryDtoSchema,
  type SiteVisitorEventsQueryDtoInput,
  SiteVisitorEventsQueryDtoSchema,
  type SiteVisitorSessionsQueryDtoInput,
  SiteVisitorSessionsQueryDtoSchema,
  type SiteVisitorsSearchQueryDtoInput,
  SiteVisitorsSearchQueryDtoSchema,
  type TeamBreakdownQueryDto,
  TeamBreakdownQueryDtoSchema,
  type TeamComparisonBreakdownV2QueryDtoInput,
  TeamComparisonBreakdownV2QueryDtoSchema,
  type TeamComparisonQueryDtoInput,
  TeamComparisonQueryDtoSchema,
  type TeamOverviewQueryDto,
  TeamOverviewQueryDtoSchema,
  type TeamSitesQueryDtoInput,
  TeamSitesQueryDtoSchema,
  type TeamTimeseriesQueryDto,
  TeamTimeseriesQueryDtoSchema,
} from "@/lib/api-v1/dto/analytics";
import {
  type TypedBatchRequest,
  TypedBatchRequestSchema,
} from "@/lib/api-v1/dto/batch";
import {
  apiV1GeneratedRouteMethod,
  apiV1GeneratedRoutePath,
} from "@/lib/api-v1/generated-client/route-metadata";
import {
  type AnalyticsBreakdownData,
  AnalyticsBreakdownResponseSchema,
  type AnalyticsChannelsData,
  AnalyticsChannelsResponseSchema,
  type AnalyticsComparisonBreakdownDataV2,
  AnalyticsComparisonBreakdownV2ResponseSchema,
  type AnalyticsComparisonData,
  AnalyticsComparisonResponseSchema,
  type AnalyticsCrossBreakdownData,
  AnalyticsCrossBreakdownResponseSchema,
  type AnalyticsEventDetailData,
  AnalyticsEventDetailResponseSchema,
  type AnalyticsEventFieldsData,
  AnalyticsEventFieldsResponseSchema,
  type AnalyticsEventFieldValuesData,
  AnalyticsEventFieldValuesResponseSchema,
  type AnalyticsEventsSearchData,
  AnalyticsEventsSearchResponseSchema,
  type AnalyticsEventsSummaryData,
  AnalyticsEventsSummaryResponseSchema,
  type AnalyticsEventsTimeseriesData,
  AnalyticsEventsTimeseriesResponseSchema,
  type AnalyticsEventTypeDetailData,
  AnalyticsEventTypeDetailResponseSchema,
  type AnalyticsEventTypesData,
  AnalyticsEventTypesResponseSchema,
  type AnalyticsFilterValuesData,
  AnalyticsFilterValuesResponseSchema,
  type AnalyticsFunnelAnalysisData,
  AnalyticsFunnelAnalysisResponseSchema,
  type AnalyticsJourneyEventDetailData,
  AnalyticsJourneyEventDetailResponseSchema,
  type AnalyticsJourneyEventsData,
  AnalyticsJourneyEventsResponseSchema,
  type AnalyticsJourneySessionsData,
  AnalyticsJourneySessionsResponseSchema,
  type AnalyticsOverviewData,
  AnalyticsOverviewResponseSchema,
  type AnalyticsPagesData,
  AnalyticsPagesResponseSchema,
  type AnalyticsPerformanceBreakdownData,
  AnalyticsPerformanceBreakdownResponseSchema,
  type AnalyticsPerformanceSummaryData,
  AnalyticsPerformanceSummaryResponseSchema,
  type AnalyticsPerformanceTimeseriesData,
  AnalyticsPerformanceTimeseriesResponseSchema,
  type AnalyticsRealtimeActiveVisitorsData,
  AnalyticsRealtimeActiveVisitorsResponseSchema,
  type AnalyticsRealtimeEventsData,
  AnalyticsRealtimeEventsResponseSchema,
  type AnalyticsRealtimeSessionsData,
  AnalyticsRealtimeSessionsResponseSchema,
  type AnalyticsRealtimeSnapshotData,
  AnalyticsRealtimeSnapshotResponseSchema,
  type AnalyticsReferrersData,
  AnalyticsReferrersResponseSchema,
  type AnalyticsRetentionCohortsData,
  AnalyticsRetentionCohortsResponseSchema,
  type AnalyticsSchemaData,
  AnalyticsSchemaResponseSchema,
  type AnalyticsSessionDetailData,
  AnalyticsSessionDetailResponseSchema,
  type AnalyticsSessionsSearchData,
  AnalyticsSessionsSearchResponseSchema,
  type AnalyticsTimeseriesData,
  AnalyticsTimeseriesResponseSchema,
  type AnalyticsVisitorDetailData,
  AnalyticsVisitorDetailResponseSchema,
  type AnalyticsVisitorsSearchData,
  AnalyticsVisitorsSearchResponseSchema,
  ApiV1ErrorEnvelopeSchema,
  apiV1SuccessEnvelopeSchema,
  SavedFilterDefinitionResponseSchema,
  SavedFilterPageResponseSchema,
  TeamAnalyticsOverviewResponseSchema,
  type TeamAnalyticsSitesData,
  TeamAnalyticsSitesResponseSchema,
  type TypedBatchData,
  TypedBatchResponseSchema,
} from "@/lib/api-v1/wire";

const CreateFunnelBodySchema = CreateFunnelInputSchema.omit({ siteId: true });

export interface ApiV1GeneratedClientConfig {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly bearer?: () => Promise<string | null> | string | null;
}

export interface ApiV1GeneratedRequestOptions {
  readonly signal?: AbortSignal;
}

export interface ApiV1GeneratedSuccess<T> {
  readonly ok: true;
  readonly status: number;
  readonly data: T;
  readonly meta: Record<string, unknown>;
  readonly headers: Headers;
}

export interface ApiV1GeneratedFailure {
  readonly ok: false;
  readonly status: number;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
    readonly issues?: readonly {
      readonly path: string;
      readonly code: string;
    }[];
  };
  readonly meta: Record<string, unknown>;
  readonly headers: Headers;
}

export type ApiV1GeneratedResult<T> =
  | ApiV1GeneratedSuccess<T>
  | ApiV1GeneratedFailure;

export class ApiV1GeneratedTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiV1GeneratedTransportError";
  }
}

export class ApiV1GeneratedAbortError extends Error {
  constructor() {
    super("API v1 request was aborted.");
    this.name = "ApiV1GeneratedAbortError";
  }
}

export class ApiV1GeneratedContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiV1GeneratedContractError";
  }
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("API v1 baseUrl must use http or https");
  }
  return parsed.toString().replace(/\/+$/u, "");
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    contentType !== "application/json" &&
    !/^application\/[^/]+\+json$/u.test(contentType ?? "")
  ) {
    throw new ApiV1GeneratedContractError(
      "Response content type is not application/json.",
    );
  }
  try {
    return await response.json();
  } catch {
    throw new ApiV1GeneratedContractError("Response body is not valid JSON.");
  }
}

async function request<T>(
  config: Required<Pick<ApiV1GeneratedClientConfig, "baseUrl">> &
    Pick<ApiV1GeneratedClientConfig, "fetch" | "bearer">,
  input: {
    readonly path: string;
    readonly method: "GET" | "POST" | "PATCH" | "DELETE";
    readonly body?: unknown;
    readonly responseSchema: ZodType<{ data: T; meta: unknown }>;
    readonly signal?: AbortSignal;
  },
): Promise<ApiV1GeneratedResult<T>> {
  const bearer = config.bearer ? await config.bearer() : null;
  const headers = new Headers({ Accept: "application/json" });
  if (input.body !== undefined) headers.set("Content-Type", "application/json");
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  let response: Response;
  try {
    response = await (config.fetch ?? fetch)(`${config.baseUrl}${input.path}`, {
      method: input.method,
      headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      redirect: "error",
      signal: input.signal,
    });
  } catch (error) {
    if (
      input.signal?.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      throw new ApiV1GeneratedAbortError();
    }
    throw new ApiV1GeneratedTransportError("API v1 request failed.");
  }
  const payload = await readJson(response);
  if (!response.ok) {
    const parsed = ApiV1ErrorEnvelopeSchema.safeParse(payload);
    if (!parsed.success)
      throw new ApiV1GeneratedContractError(
        "Error response contract is invalid.",
      );
    return {
      ok: false,
      status: response.status,
      error: parsed.data.error,
      meta: parsed.data.meta,
      headers: response.headers,
    };
  }
  const parsed = input.responseSchema.safeParse(payload);
  if (!parsed.success)
    throw new ApiV1GeneratedContractError(
      "Success response contract is invalid.",
    );
  const envelope = parsed.data;
  return {
    ok: true,
    status: response.status,
    data: envelope.data,
    meta: envelope.meta as Record<string, unknown>,
    headers: response.headers,
  };
}

async function requestNoContent(
  config: Required<Pick<ApiV1GeneratedClientConfig, "baseUrl">> &
    Pick<ApiV1GeneratedClientConfig, "fetch" | "bearer">,
  input: {
    readonly path: string;
    readonly method: "GET" | "POST" | "PATCH" | "DELETE";
    readonly signal?: AbortSignal;
  },
): Promise<ApiV1GeneratedResult<undefined>> {
  const bearer = config.bearer ? await config.bearer() : null;
  const headers = new Headers({ Accept: "application/json" });
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  let response: Response;
  try {
    response = await (config.fetch ?? fetch)(`${config.baseUrl}${input.path}`, {
      method: input.method,
      headers,
      redirect: "error",
      signal: input.signal,
    });
  } catch (error) {
    if (
      input.signal?.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      throw new ApiV1GeneratedAbortError();
    }
    throw new ApiV1GeneratedTransportError("API v1 request failed.");
  }
  if (response.status === 204) {
    return {
      ok: true,
      status: 204,
      data: undefined,
      meta: {},
      headers: response.headers,
    };
  }
  const payload = await readJson(response);
  const parsed = ApiV1ErrorEnvelopeSchema.safeParse(payload);
  if (!parsed.success)
    throw new ApiV1GeneratedContractError(
      "Delete response contract is invalid.",
    );
  return {
    ok: false,
    status: response.status,
    error: parsed.data.error,
    meta: parsed.data.meta,
    headers: response.headers,
  };
}

export interface ApiV1GeneratedClient {
  getRoot(
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<RootData>>;
  getToken(
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<TokenData>>;
  checkToken(
    input: TokenCheckInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<TokenCheckData>>;
  getCapabilities(
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<CapabilitiesData>>;
  getTeam(
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<TeamData>>;
  getTeamUsage(
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<TeamUsageData>>;
  listSites(
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<readonly SiteResource[]>>;
  createSite(
    input: Parameters<typeof CreateSiteInputSchema.parse>[0],
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<SiteResource>>;
  getSite(
    siteId: string,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<SiteResource>>;
  updateSite(
    siteId: string,
    input: Parameters<typeof UpdateSiteBodySchema.parse>[0],
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<SiteResource>>;
  deleteSite(
    siteId: string,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<undefined>>;
  getTrackingSettings(
    siteId: string,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<TrackingSettings>>;
  updateTrackingSettings(
    siteId: string,
    input: Parameters<typeof UpdateTrackingSettingsBodySchema.parse>[0],
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<TrackingSettings>>;
  getPrivacySettings(
    siteId: string,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<PrivacySettings>>;
  updatePrivacySettings(
    siteId: string,
    input: Parameters<typeof UpdatePrivacySettingsBodySchema.parse>[0],
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<PrivacySettings>>;
  getSharingSettings(
    siteId: string,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<SharingSettings>>;
  updateSharingSettings(
    siteId: string,
    input: Parameters<typeof UpdateSharingSettingsBodySchema.parse>[0],
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<SharingSettings>>;
  getTrackingScript(
    siteId: string,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<TrackingScript>>;
  listFunnels(
    siteId: string,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<readonly FunnelResource[]>>;
  createFunnel(
    siteId: string,
    input: Parameters<typeof CreateFunnelBodySchema.parse>[0],
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<FunnelResource>>;
  getFunnel(
    siteId: string,
    funnelId: string,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<FunnelResource>>;
  updateFunnel(
    siteId: string,
    funnelId: string,
    input: Parameters<typeof UpdateFunnelBodySchema.parse>[0],
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<FunnelResource>>;
  deleteFunnel(
    siteId: string,
    funnelId: string,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<undefined>>;
  siteAnalyticsSchema(
    siteId: string,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsSchemaData>>;
  teamAnalyticsSchema(
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsSchemaData>>;
  siteAnalyticsOverview(
    siteId: string,
    input: SiteOverviewQueryDto,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsOverviewData>>;
  siteAnalyticsComparison(
    siteId: string,
    input: SiteComparisonQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsComparisonData>>;
  siteAnalyticsComparisonBreakdown(
    siteId: string,
    dimension: string,
    input: SiteComparisonBreakdownV2QueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsComparisonBreakdownDataV2>>;
  siteAnalyticsTimeseries(
    siteId: string,
    input: SiteTimeseriesQueryDto,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsTimeseriesData>>;
  teamAnalyticsComparison(
    input: TeamComparisonQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsComparisonData>>;
  teamAnalyticsComparisonBreakdown(
    dimension: string,
    input: TeamComparisonBreakdownV2QueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsComparisonBreakdownDataV2>>;
  siteAnalyticsBreakdown(
    siteId: string,
    dimension: string,
    input: SiteBreakdownQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsBreakdownData>>;
  siteAnalyticsCrossBreakdown(
    siteId: string,
    input: SiteCrossBreakdownQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsCrossBreakdownData>>;
  siteAnalyticsPages(
    siteId: string,
    input: SitePagesQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsPagesData>>;
  siteAnalyticsReferrers(
    siteId: string,
    input: SiteReferrersQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsReferrersData>>;
  siteAnalyticsChannels(
    siteId: string,
    input: SiteChannelsQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsChannelsData>>;
  siteAnalyticsFilterValues(
    siteId: string,
    input: SiteFilterValuesQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsFilterValuesData>>;
  siteAnalyticsRetentionCohorts(
    siteId: string,
    input: SiteRetentionCohortsQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsRetentionCohortsData>>;
  siteAnalyticsFunnelAnalysis(
    siteId: string,
    input: SiteFunnelAnalysisQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsFunnelAnalysisData>>;
  siteAnalyticsPerformanceSummary(
    siteId: string,
    input: SitePerformanceSummaryQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsPerformanceSummaryData>>;
  siteAnalyticsPerformanceTimeseries(
    siteId: string,
    input: SitePerformanceTimeseriesQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsPerformanceTimeseriesData>>;
  siteAnalyticsPerformanceBreakdown(
    siteId: string,
    dimension: string,
    input: SitePerformanceBreakdownQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsPerformanceBreakdownData>>;
  siteAnalyticsEventsSummary(
    siteId: string,
    input: SiteEventsSummaryQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsEventsSummaryData>>;
  siteAnalyticsEventsTimeseries(
    siteId: string,
    input: SiteEventsTimeseriesQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsEventsTimeseriesData>>;
  siteAnalyticsEventsSearch(
    siteId: string,
    input: SiteEventsSearchQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsEventsSearchData>>;
  siteAnalyticsEventDetail(
    siteId: string,
    input: SiteEventDetailQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsEventDetailData>>;
  siteAnalyticsJourneyEventDetail(
    siteId: string,
    input: SiteJourneyEventDetailQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsJourneyEventDetailData>>;
  siteAnalyticsEventTypes(
    siteId: string,
    input: SiteEventTypesQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsEventTypesData>>;
  siteAnalyticsEventTypeDetail(
    siteId: string,
    input: SiteEventTypeDetailQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsEventTypeDetailData>>;
  siteAnalyticsEventFields(
    siteId: string,
    input: SiteEventFieldsQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsEventFieldsData>>;
  siteAnalyticsEventFieldValues(
    siteId: string,
    input: SiteEventFieldValuesQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsEventFieldValuesData>>;
  siteAnalyticsVisitorDetail(
    siteId: string,
    input: SiteVisitorDetailQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsVisitorDetailData>>;
  siteAnalyticsSessionDetail(
    siteId: string,
    input: SiteSessionDetailQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsSessionDetailData>>;
  siteAnalyticsVisitorsSearch(
    siteId: string,
    input: SiteVisitorsSearchQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsVisitorsSearchData>>;
  siteAnalyticsSessionsSearch(
    siteId: string,
    input: SiteSessionsSearchQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsSessionsSearchData>>;
  siteAnalyticsVisitorEvents(
    siteId: string,
    input: SiteVisitorEventsQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsJourneyEventsData>>;
  siteAnalyticsVisitorSessions(
    siteId: string,
    input: SiteVisitorSessionsQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsJourneySessionsData>>;
  siteAnalyticsSessionEvents(
    siteId: string,
    input: SiteSessionEventsQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsJourneyEventsData>>;
  siteAnalyticsRealtimeSnapshot(
    siteId: string,
    input: SiteRealtimeSnapshotQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsRealtimeSnapshotData>>;
  siteAnalyticsRealtimeActiveVisitors(
    siteId: string,
    input: SiteRealtimeActiveVisitorsQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsRealtimeActiveVisitorsData>>;
  siteAnalyticsRealtimeEvents(
    siteId: string,
    input: SiteRealtimeEventsQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsRealtimeEventsData>>;
  siteAnalyticsRealtimeSessions(
    siteId: string,
    input: SiteRealtimeSessionsQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsRealtimeSessionsData>>;
  teamAnalyticsOverview(
    input: TeamOverviewQueryDto,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsOverviewData>>;
  teamAnalyticsTimeseries(
    input: TeamTimeseriesQueryDto,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsTimeseriesData>>;
  teamAnalyticsSites(
    input: TeamSitesQueryDtoInput,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<TeamAnalyticsSitesData>>;
  teamAnalyticsBreakdown(
    dimension: string,
    input: TeamBreakdownQueryDto,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<AnalyticsBreakdownData>>;
  listSavedFilters(
    siteId: string,
    input?: Partial<Omit<ListTeamVisibleSavedFiltersInput, "siteId">>,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<SavedFilterPage>>;
  getSavedFilter(
    siteId: string,
    savedFilterId: string,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<SavedFilterDefinition>>;
  batch(
    input: TypedBatchRequest,
    options?: ApiV1GeneratedRequestOptions,
  ): Promise<ApiV1GeneratedResult<TypedBatchData>>;
}

export function createApiV1GeneratedClient(
  config: ApiV1GeneratedClientConfig,
): ApiV1GeneratedClient {
  const normalized = normalizeBaseUrl(config.baseUrl);
  const transport = {
    baseUrl: normalized,
    fetch: config.fetch,
    bearer: config.bearer,
  } as const;
  return {
    getRoot(options) {
      return request(transport, {
        path: apiV1GeneratedRoutePath("core.root"),
        method: apiV1GeneratedRouteMethod("core.root"),
        responseSchema: apiV1SuccessEnvelopeSchema(RootDataSchema),
        signal: options?.signal,
      });
    },
    getToken(options) {
      return request(transport, {
        path: apiV1GeneratedRoutePath("core.token.get"),
        method: apiV1GeneratedRouteMethod("core.token.get"),
        responseSchema: apiV1SuccessEnvelopeSchema(TokenDataSchema),
        signal: options?.signal,
      });
    },
    checkToken(input, options) {
      const parsed = TokenCheckSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("core.token.check"),
        method: apiV1GeneratedRouteMethod("core.token.check"),
        body: parsed,
        responseSchema: apiV1SuccessEnvelopeSchema(TokenCheckDataSchema),
        signal: options?.signal,
      });
    },
    getCapabilities(options) {
      return request(transport, {
        path: apiV1GeneratedRoutePath("core.capabilities"),
        method: apiV1GeneratedRouteMethod("core.capabilities"),
        responseSchema: apiV1SuccessEnvelopeSchema(CapabilitiesDataSchema),
        signal: options?.signal,
      });
    },
    getTeam(options) {
      return request(transport, {
        path: apiV1GeneratedRoutePath("core.team.get"),
        method: apiV1GeneratedRouteMethod("core.team.get"),
        responseSchema: apiV1SuccessEnvelopeSchema(TeamDataSchema),
        signal: options?.signal,
      });
    },
    getTeamUsage(options) {
      return request(transport, {
        path: apiV1GeneratedRoutePath("core.team.usage"),
        method: apiV1GeneratedRouteMethod("core.team.usage"),
        responseSchema: apiV1SuccessEnvelopeSchema(TeamUsageDataSchema),
        signal: options?.signal,
      });
    },
    listSites(options) {
      return request(transport, {
        path: apiV1GeneratedRoutePath("sites.list"),
        method: apiV1GeneratedRouteMethod("sites.list"),
        responseSchema: apiV1SuccessEnvelopeSchema(SiteResourceSchema.array()),
        signal: options?.signal,
      });
    },
    createSite(input, options) {
      const parsed = CreateSiteInputSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("sites.create"),
        method: apiV1GeneratedRouteMethod("sites.create"),
        body: parsed,
        responseSchema: apiV1SuccessEnvelopeSchema(SiteResourceSchema),
        signal: options?.signal,
      });
    },
    getSite(siteId, options) {
      return request(transport, {
        path: apiV1GeneratedRoutePath("sites.get", { siteId: siteId }),
        method: apiV1GeneratedRouteMethod("sites.get"),
        responseSchema: apiV1SuccessEnvelopeSchema(SiteResourceSchema),
        signal: options?.signal,
      });
    },
    updateSite(siteId, input, options) {
      const parsed = UpdateSiteBodySchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("sites.update", { siteId: siteId }),
        method: apiV1GeneratedRouteMethod("sites.update"),
        body: parsed,
        responseSchema: apiV1SuccessEnvelopeSchema(SiteResourceSchema),
        signal: options?.signal,
      });
    },
    deleteSite(siteId, options) {
      return requestNoContent(transport, {
        path: apiV1GeneratedRoutePath("sites.delete", { siteId: siteId }),
        method: apiV1GeneratedRouteMethod("sites.delete"),
        signal: options?.signal,
      });
    },
    getTrackingSettings(siteId, options) {
      return request(transport, {
        path: apiV1GeneratedRoutePath("settings.tracking.get", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("settings.tracking.get"),
        responseSchema: apiV1SuccessEnvelopeSchema(TrackingSettingsSchema),
        signal: options?.signal,
      });
    },
    updateTrackingSettings(siteId, input, options) {
      const parsed = UpdateTrackingSettingsBodySchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("settings.tracking.update", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("settings.tracking.update"),
        body: parsed,
        responseSchema: apiV1SuccessEnvelopeSchema(TrackingSettingsSchema),
        signal: options?.signal,
      });
    },
    getPrivacySettings(siteId, options) {
      return request(transport, {
        path: apiV1GeneratedRoutePath("settings.privacy.get", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("settings.privacy.get"),
        responseSchema: apiV1SuccessEnvelopeSchema(PrivacySettingsSchema),
        signal: options?.signal,
      });
    },
    updatePrivacySettings(siteId, input, options) {
      const parsed = UpdatePrivacySettingsBodySchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("settings.privacy.update", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("settings.privacy.update"),
        body: parsed,
        responseSchema: apiV1SuccessEnvelopeSchema(PrivacySettingsSchema),
        signal: options?.signal,
      });
    },
    getSharingSettings(siteId, options) {
      return request(transport, {
        path: apiV1GeneratedRoutePath("settings.sharing.get", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("settings.sharing.get"),
        responseSchema: apiV1SuccessEnvelopeSchema(SharingSettingsSchema),
        signal: options?.signal,
      });
    },
    updateSharingSettings(siteId, input, options) {
      const parsed = UpdateSharingSettingsBodySchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("settings.sharing.update", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("settings.sharing.update"),
        body: parsed,
        responseSchema: apiV1SuccessEnvelopeSchema(SharingSettingsSchema),
        signal: options?.signal,
      });
    },
    getTrackingScript(siteId, options) {
      return request(transport, {
        path: apiV1GeneratedRoutePath("settings.tracking-script.get", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("settings.tracking-script.get"),
        responseSchema: apiV1SuccessEnvelopeSchema(TrackingScriptSchema),
        signal: options?.signal,
      });
    },
    listFunnels(siteId, options) {
      return request(transport, {
        path: apiV1GeneratedRoutePath("funnels.list", { siteId: siteId }),
        method: apiV1GeneratedRouteMethod("funnels.list"),
        responseSchema: apiV1SuccessEnvelopeSchema(
          FunnelResourceSchema.array(),
        ),
        signal: options?.signal,
      });
    },
    createFunnel(siteId, input, options) {
      const parsed = CreateFunnelBodySchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("funnels.create", { siteId: siteId }),
        method: apiV1GeneratedRouteMethod("funnels.create"),
        body: parsed,
        responseSchema: apiV1SuccessEnvelopeSchema(FunnelResourceSchema),
        signal: options?.signal,
      });
    },
    getFunnel(siteId, funnelId, options) {
      return request(transport, {
        path: apiV1GeneratedRoutePath("funnels.get", {
          siteId: siteId,
          funnelId: funnelId,
        }),
        method: apiV1GeneratedRouteMethod("funnels.get"),
        responseSchema: apiV1SuccessEnvelopeSchema(FunnelResourceSchema),
        signal: options?.signal,
      });
    },
    updateFunnel(siteId, funnelId, input, options) {
      const parsed = UpdateFunnelBodySchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("funnels.update", {
          siteId: siteId,
          funnelId: funnelId,
        }),
        method: apiV1GeneratedRouteMethod("funnels.update"),
        body: parsed,
        responseSchema: apiV1SuccessEnvelopeSchema(FunnelResourceSchema),
        signal: options?.signal,
      });
    },
    deleteFunnel(siteId, funnelId, options) {
      return requestNoContent(transport, {
        path: apiV1GeneratedRoutePath("funnels.delete", {
          siteId: siteId,
          funnelId: funnelId,
        }),
        method: apiV1GeneratedRouteMethod("funnels.delete"),
        signal: options?.signal,
      });
    },
    siteAnalyticsSchema(siteId, options) {
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.schema", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.schema"),
        responseSchema: AnalyticsSchemaResponseSchema,
        signal: options?.signal,
      });
    },
    teamAnalyticsSchema(options) {
      return request(transport, {
        path: apiV1GeneratedRoutePath("team.analytics.schema"),
        method: apiV1GeneratedRouteMethod("team.analytics.schema"),
        responseSchema: AnalyticsSchemaResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsOverview(siteId, input, options) {
      const parsed = SiteOverviewQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.overview", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.overview"),
        body: parsed,
        responseSchema: AnalyticsOverviewResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsComparison(siteId, input, options) {
      const parsed = SiteComparisonQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.comparison", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.comparison"),
        body: parsed,
        responseSchema: AnalyticsComparisonResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsComparisonBreakdown(siteId, dimension, input, options) {
      const parsed = SiteComparisonBreakdownV2QueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.comparisonBreakdown", {
          siteId,
          dimension,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.comparisonBreakdown"),
        body: parsed,
        responseSchema: AnalyticsComparisonBreakdownV2ResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsTimeseries(siteId, input, options) {
      const parsed = SiteTimeseriesQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.timeseries", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.timeseries"),
        body: parsed,
        responseSchema: AnalyticsTimeseriesResponseSchema,
        signal: options?.signal,
      });
    },
    teamAnalyticsComparison(input, options) {
      const parsed = TeamComparisonQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("team.analytics.comparison"),
        method: apiV1GeneratedRouteMethod("team.analytics.comparison"),
        body: parsed,
        responseSchema: AnalyticsComparisonResponseSchema,
        signal: options?.signal,
      });
    },
    teamAnalyticsComparisonBreakdown(dimension, input, options) {
      const parsed = TeamComparisonBreakdownV2QueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("team.analytics.comparisonBreakdown", {
          dimension,
        }),
        method: apiV1GeneratedRouteMethod("team.analytics.comparisonBreakdown"),
        body: parsed,
        responseSchema: AnalyticsComparisonBreakdownV2ResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsBreakdown(siteId, dimension, input, options) {
      const parsed = SiteBreakdownQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.breakdown", {
          siteId: siteId,
          dimension: dimension,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.breakdown"),
        body: parsed,
        responseSchema: AnalyticsBreakdownResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsCrossBreakdown(siteId, input, options) {
      const parsed = SiteCrossBreakdownQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.crossBreakdown", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.crossBreakdown"),
        body: parsed,
        responseSchema: AnalyticsCrossBreakdownResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsPages(siteId, input, options) {
      const parsed = SitePagesQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.pages", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.pages"),
        body: parsed,
        responseSchema: AnalyticsPagesResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsReferrers(siteId, input, options) {
      const parsed = SiteReferrersQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.referrers", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.referrers"),
        body: parsed,
        responseSchema: AnalyticsReferrersResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsChannels(siteId, input, options) {
      const parsed = SiteChannelsQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.channels", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.channels"),
        body: parsed,
        responseSchema: AnalyticsChannelsResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsFilterValues(siteId, input, options) {
      const parsed = SiteFilterValuesQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.filterValues", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.filterValues"),
        body: parsed,
        responseSchema: AnalyticsFilterValuesResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsRetentionCohorts(siteId, input, options) {
      const parsed = SiteRetentionCohortsQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.retentionCohorts", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.retentionCohorts"),
        body: parsed,
        responseSchema: AnalyticsRetentionCohortsResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsFunnelAnalysis(siteId, input, options) {
      const parsed = SiteFunnelAnalysisQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.funnelAnalysis", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.funnelAnalysis"),
        body: parsed,
        responseSchema: AnalyticsFunnelAnalysisResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsPerformanceSummary(siteId, input, options) {
      const parsed = SitePerformanceSummaryQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.performanceSummary", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.performanceSummary"),
        body: parsed,
        responseSchema: AnalyticsPerformanceSummaryResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsPerformanceTimeseries(siteId, input, options) {
      const parsed = SitePerformanceTimeseriesQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.performanceTimeseries", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod(
          "site.analytics.performanceTimeseries",
        ),
        body: parsed,
        responseSchema: AnalyticsPerformanceTimeseriesResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsPerformanceBreakdown(siteId, dimension, input, options) {
      const parsed = SitePerformanceBreakdownQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.performanceBreakdown", {
          siteId: siteId,
          dimension: dimension,
        }),
        method: apiV1GeneratedRouteMethod(
          "site.analytics.performanceBreakdown",
        ),
        body: parsed,
        responseSchema: AnalyticsPerformanceBreakdownResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsEventsSummary(siteId, input, options) {
      const parsed = SiteEventsSummaryQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.eventsSummary", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.eventsSummary"),
        body: parsed,
        responseSchema: AnalyticsEventsSummaryResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsEventsTimeseries(siteId, input, options) {
      const parsed = SiteEventsTimeseriesQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.eventsTimeseries", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.eventsTimeseries"),
        body: parsed,
        responseSchema: AnalyticsEventsTimeseriesResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsEventsSearch(siteId, input, options) {
      const parsed = SiteEventsSearchQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.eventsSearch", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.eventsSearch"),
        body: parsed,
        responseSchema: AnalyticsEventsSearchResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsEventDetail(siteId, input, options) {
      const parsed = SiteEventDetailQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.eventDetail", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.eventDetail"),
        body: parsed,
        responseSchema: AnalyticsEventDetailResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsJourneyEventDetail(siteId, input, options) {
      const parsed = SiteJourneyEventDetailQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.journeyEventDetail", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.journeyEventDetail"),
        body: parsed,
        responseSchema: AnalyticsJourneyEventDetailResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsEventTypes(siteId, input, options) {
      const parsed = SiteEventTypesQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.eventTypes", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.eventTypes"),
        body: parsed,
        responseSchema: AnalyticsEventTypesResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsEventTypeDetail(siteId, input, options) {
      const parsed = SiteEventTypeDetailQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.eventTypeDetail", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.eventTypeDetail"),
        body: parsed,
        responseSchema: AnalyticsEventTypeDetailResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsEventFields(siteId, input, options) {
      const parsed = SiteEventFieldsQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.eventFields", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.eventFields"),
        body: parsed,
        responseSchema: AnalyticsEventFieldsResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsEventFieldValues(siteId, input, options) {
      const parsed = SiteEventFieldValuesQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.eventFieldValues", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.eventFieldValues"),
        body: parsed,
        responseSchema: AnalyticsEventFieldValuesResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsVisitorDetail(siteId, input, options) {
      const parsed = SiteVisitorDetailQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.visitorDetail", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.visitorDetail"),
        body: parsed,
        responseSchema: AnalyticsVisitorDetailResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsSessionDetail(siteId, input, options) {
      const parsed = SiteSessionDetailQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.sessionDetail", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.sessionDetail"),
        body: parsed,
        responseSchema: AnalyticsSessionDetailResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsVisitorsSearch(siteId, input, options) {
      const parsed = SiteVisitorsSearchQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.visitorsSearch", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.visitorsSearch"),
        body: parsed,
        responseSchema: AnalyticsVisitorsSearchResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsSessionsSearch(siteId, input, options) {
      const parsed = SiteSessionsSearchQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.sessionsSearch", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.sessionsSearch"),
        body: parsed,
        responseSchema: AnalyticsSessionsSearchResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsVisitorEvents(siteId, input, options) {
      const parsed = SiteVisitorEventsQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.visitorEvents", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.visitorEvents"),
        body: parsed,
        responseSchema: AnalyticsJourneyEventsResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsVisitorSessions(siteId, input, options) {
      const parsed = SiteVisitorSessionsQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.visitorSessions", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.visitorSessions"),
        body: parsed,
        responseSchema: AnalyticsJourneySessionsResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsSessionEvents(siteId, input, options) {
      const parsed = SiteSessionEventsQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.sessionEvents", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.sessionEvents"),
        body: parsed,
        responseSchema: AnalyticsJourneyEventsResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsRealtimeSnapshot(siteId, input, options) {
      const parsed = SiteRealtimeSnapshotQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.realtimeSnapshot", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.realtimeSnapshot"),
        body: parsed,
        responseSchema: AnalyticsRealtimeSnapshotResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsRealtimeActiveVisitors(siteId, input, options) {
      const parsed = SiteRealtimeActiveVisitorsQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.realtimeActiveVisitors", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod(
          "site.analytics.realtimeActiveVisitors",
        ),
        body: parsed,
        responseSchema: AnalyticsRealtimeActiveVisitorsResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsRealtimeEvents(siteId, input, options) {
      const parsed = SiteRealtimeEventsQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.realtimeEvents", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.realtimeEvents"),
        body: parsed,
        responseSchema: AnalyticsRealtimeEventsResponseSchema,
        signal: options?.signal,
      });
    },
    siteAnalyticsRealtimeSessions(siteId, input, options) {
      const parsed = SiteRealtimeSessionsQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.analytics.realtimeSessions", {
          siteId: siteId,
        }),
        method: apiV1GeneratedRouteMethod("site.analytics.realtimeSessions"),
        body: parsed,
        responseSchema: AnalyticsRealtimeSessionsResponseSchema,
        signal: options?.signal,
      });
    },
    teamAnalyticsOverview(input, options) {
      const parsed = TeamOverviewQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("team.analytics.overview"),
        method: apiV1GeneratedRouteMethod("team.analytics.overview"),
        body: parsed,
        responseSchema: TeamAnalyticsOverviewResponseSchema,
        signal: options?.signal,
      });
    },
    teamAnalyticsTimeseries(input, options) {
      const parsed = TeamTimeseriesQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("team.analytics.timeseries"),
        method: apiV1GeneratedRouteMethod("team.analytics.timeseries"),
        body: parsed,
        responseSchema: AnalyticsTimeseriesResponseSchema,
        signal: options?.signal,
      });
    },
    teamAnalyticsSites(input, options) {
      const parsed = TeamSitesQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("team.analytics.sites"),
        method: apiV1GeneratedRouteMethod("team.analytics.sites"),
        body: parsed,
        responseSchema: TeamAnalyticsSitesResponseSchema,
        signal: options?.signal,
      });
    },
    teamAnalyticsBreakdown(dimension, input, options) {
      const parsed = TeamBreakdownQueryDtoSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("team.analytics.breakdown", {
          dimension: dimension,
        }),
        method: apiV1GeneratedRouteMethod("team.analytics.breakdown"),
        body: parsed,
        responseSchema: AnalyticsBreakdownResponseSchema,
        signal: options?.signal,
      });
    },
    listSavedFilters(siteId, input, options) {
      const parsed = ListTeamVisibleSavedFiltersInputSchema.parse({
        siteId,
        ...(input ?? {}),
      });
      const query = new URLSearchParams();
      if (parsed.limit !== 100) query.set("limit", String(parsed.limit));
      if (parsed.cursor) query.set("cursor", parsed.cursor);
      const suffix = query.toString() ? `?${query.toString()}` : "";
      return request(transport, {
        path:
          apiV1GeneratedRoutePath("site.saved-filters.list", {
            siteId: siteId,
          }) + suffix,
        method: apiV1GeneratedRouteMethod("site.saved-filters.list"),
        responseSchema: SavedFilterPageResponseSchema,
        signal: options?.signal,
      });
    },
    getSavedFilter(siteId, savedFilterId, options) {
      const parsed = GetTeamVisibleSavedFilterInputSchema.parse({
        siteId,
        id: savedFilterId,
      });
      return request(transport, {
        path: apiV1GeneratedRoutePath("site.saved-filters.get", {
          siteId: parsed.siteId,
          savedFilterId: parsed.id,
        }),
        method: apiV1GeneratedRouteMethod("site.saved-filters.get"),
        responseSchema: SavedFilterDefinitionResponseSchema,
        signal: options?.signal,
      });
    },
    batch(input, options) {
      const parsed = TypedBatchRequestSchema.parse(input);
      return request(transport, {
        path: apiV1GeneratedRoutePath("batch"),
        method: apiV1GeneratedRouteMethod("batch"),
        body: parsed,
        responseSchema: TypedBatchResponseSchema,
        signal: options?.signal,
      });
    },
  };
}
