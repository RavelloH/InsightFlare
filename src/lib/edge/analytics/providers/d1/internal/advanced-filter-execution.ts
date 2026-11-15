import { valuesRelation } from "@/lib/db";
import { AnalyticsProviderDomainError } from "@/lib/edge/analytics/application/errors";
import { checkPageMembershipAudiencePolicy } from "@/lib/edge/analytics/application/page-membership-audience-policy";
import {
  createSiteExactDimensionQualificationProjection,
  type SiteExactDimensionQualificationProjection,
} from "@/lib/edge/analytics/application/site-exact-dimension";
import type {
  CalendarGranularity,
  Interval,
  PerformanceMetricKey,
  QueryAudience,
  QueryInput,
  QueryOperation,
  QueryTime,
} from "@/lib/edge/analytics/contract";
import {
  EMPTY_FILTER_DOCUMENT,
  queryWindowToTime,
} from "@/lib/edge/analytics/contract";
import { INTERVALS } from "@/lib/edge/analytics/contract/catalog";
import {
  type SitePerformanceBreakdownDimension,
  SitePerformanceBreakdownDimensionSchema,
} from "@/lib/edge/analytics/contract/performance-dimensions";
import {
  isPreparedMembership,
  type PreparedMembership,
} from "@/lib/edge/analytics/contract/prepared-membership";
import {
  attachScopedFilterMetadata,
  createScopedFilterPlan,
  type ScopedFilterMetadata,
  scopedFilterMetadata,
  type ScopedFilterPlan,
} from "@/lib/edge/analytics/contract/scoped-filter";
import {
  type AdvancedCountFilterMatchPlanInput,
  type AdvancedCountQualificationPlanInput,
  type AdvancedEventCandidateCountPlanInput,
} from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import { advancedCountPayloadPaths } from "@/lib/edge/analytics/engine/advanced-count-payload-selector";
import {
  classifyAdvancedCountFilter,
  classifyAdvancedEventCandidateCountFilter,
} from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import { planAdvancedFilterExecution } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import {
  type ComparisonMembershipDependencyPlan,
  planComparisonMembershipDependencies,
} from "@/lib/edge/analytics/engine/comparison-membership-dependency-plan";
import { comparisonPageReaderContract } from "@/lib/edge/analytics/engine/comparison-page-reader-contract";
import type { ComparisonReportFamily } from "@/lib/edge/analytics/engine/comparison-report-plan";
import {
  dimensionPageSelection,
  type NormalizedDimensionPageRequest,
  normalizeDimensionPageRequest,
  type NormalizedOverviewPageTableRequest,
  normalizeOverviewPageTableRequest,
  overviewPageTableDescriptor,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import {
  type EventNameDimensionListRequest,
  normalizeEventNameDimensionListRequest,
} from "@/lib/edge/analytics/engine/event-type-summary-plan";
import { resolveJourneyListQualificationFilters } from "@/lib/edge/analytics/engine/journey-list-qualification-filters";
import {
  type MembershipPreparationStep,
  normalizeMembershipPreparations,
} from "@/lib/edge/analytics/engine/membership-dependency-plan";
import {
  type OverviewMembershipDependencyPlan,
  planOverviewMembershipDependencies,
} from "@/lib/edge/analytics/engine/overview-membership-dependency-plan";
import type { OverviewTrendQualificationConfiguration } from "@/lib/edge/analytics/engine/overview-trend-qualification-plan";
import {
  type PageChannelMembershipReader,
  planPageChannelMembershipDependencies,
} from "@/lib/edge/analytics/engine/page-channel-membership-dependency-plan";
import { splitPageDimensionNativeFilters } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import type { PageReaderConsumer } from "@/lib/edge/analytics/engine/page-membership-reader-catalog";
import { pageWholeOriginalFamilyFromQuery } from "@/lib/edge/analytics/engine/page-whole-original-family";
import { PERFORMANCE_METRICS } from "@/lib/edge/analytics/engine/performance-sample-statistics-report-plan";
import {
  type QualifiedSourceFilterMode,
  resolveQualifiedSourceFilters,
} from "@/lib/edge/analytics/engine/qualified-page-source";
import {
  type DeferredReferrerOverviewTableRequest,
  normalizeReferrerOverviewTableRequest,
  type ReferrerPageSortKey,
} from "@/lib/edge/analytics/engine/referrer-report-plan";
import {
  planReferrersPageMembershipDependencies,
  type ReferrersPageMembershipDependencyPlan,
  type ReferrersPageReaderConfiguration,
} from "@/lib/edge/analytics/engine/referrers-page-membership-dependency-plan";
import { planReferrersTimeMembershipDependency } from "@/lib/edge/analytics/engine/referrers-time-membership-plan";
import {
  EVENT_CONTEXT_CARD_KEYS,
  type EventContextCardKey,
} from "@/lib/edge/analytics/engine/semantic/event-context-cards";
import { eventPayloadValueTypeCode } from "@/lib/edge/analytics/engine/semantic/event-payload-value-type";
import {
  EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
} from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { SemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticSubjectFromQuerySubject } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import {
  type NormalizedSessionBoundaryDimensionRequest,
  normalizeSessionBoundaryDimensionRequest,
} from "@/lib/edge/analytics/engine/session-path-report-plan";
import {
  planTeamExactDimensionExecution,
  type TeamExactDimensionQuery,
} from "@/lib/edge/analytics/engine/team-exact-dimension-plan";
import { planTeamExactMembershipDependencies } from "@/lib/edge/analytics/engine/team-exact-membership-dependency-plan";
import { planTeamExactWholeOriginalReader } from "@/lib/edge/analytics/engine/team-exact-whole-reader-plan";
import {
  planTeamSitesMembershipDependencies,
  type TeamSitesMembershipQuery,
} from "@/lib/edge/analytics/engine/team-sites-membership-dependency-plan";
import { planTeamSitesWholeOriginalReaders } from "@/lib/edge/analytics/engine/team-sites-whole-reader-plan";
import {
  sameTechnologyCrossQualificationConfiguration,
  type TechnologyCrossQualificationConfiguration,
} from "@/lib/edge/analytics/engine/technology-cross-qualification-plan";
import type { TechnologyRadarQualificationConfiguration } from "@/lib/edge/analytics/engine/technology-radar-report-plan";
import {
  type TechnologyShareTrendQualificationConfiguration,
  technologyShareTrendQualificationConfiguration,
} from "@/lib/edge/analytics/engine/technology-share-trend-report-plan";
import { pageVisitQualificationConsumerKey } from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import {
  createPageVisitQualificationPreparation,
  type PageVisitQualificationPreparation,
} from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import {
  createReferrersSummaryQualificationPreparation,
  type ReferrersSummaryQualificationPreparation,
} from "@/lib/edge/analytics/providers/d1/internal/referrers-qualification-execution";
import {
  createTeamSitesQualification,
  type TeamSitesQualification,
} from "@/lib/edge/analytics/providers/d1/internal/team-sites-qualification";
import {
  evaluateWholeFilterMembership as evaluateForSitesCore,
  type QualificationMatchRow,
} from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-executor";
import {
  projectWholeOriginalMembership,
  type WholeOriginalProjection,
} from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-projection";
import { wholeOriginalTeamSitesQualificationFromQuery } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import {
  associateWholeOriginalCompletion,
  selectWholeOriginalConsumer,
  transferWholeOriginalCompletion,
  wholeOriginalComparisonReaderTab,
  type WholeOriginalConsumer,
} from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import {
  associateWholeFilterReaderDependency,
  createWholeFilterReaderDependency,
  type WholeFilterReaderDependency,
  wholeFilterReaderDependencyFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import {
  isCanonicalPrivateChannelListWholeFilterRequest,
  isCanonicalPrivateChannelOverviewWholeFilterRequest,
  isCanonicalPrivatePageDimensionWholeFilterRequest,
} from "@/lib/edge/analytics/providers/d1/internal/whole-filter-request";
import { createTeamWholeOriginalMembershipInvocation } from "@/lib/edge/analytics/providers/d1/internal/whole-membership-stage-program";
import type { Env } from "@/lib/edge/types";
import { filterDocumentUsesAdvancedExpressions } from "@/lib/filter-contract/filter-types";
import type {
  FilterDocument,
  FilterExpression,
  FilterTargetExpression,
} from "@/lib/filter-contract/filters";

import { sqliteBoundText } from "./lowering/scoped-source/selection-compatibility";
import { siteCoverage } from "./advanced-filter-site-coverage";
import { executeAnalyticsLogicalStage } from "./analytics-logical-staged-runtime";
import type { AnalyticsDbRelation } from "./analytics-relational-storage";
import { semanticSubjectForAuthorizedSubset } from "./authorized-site-subject";
import { comparisonReportFamilyForTab } from "./comparison-report-family";
import { resolveCrossBreakdownPageDimension } from "./core-dimensions";
import type { D1ReadDiagnostics } from "./diagnostics";
import {
  recordAdvancedFilterExecution,
  recordScopedFilterDiagnostics,
} from "./diagnostics";
import { siteExactDimensionQualificationConsumerKey } from "./dimension-top-qualification";
import type { D1QueryProviderMiddleware } from "./execution-options";
import {
  attachFilterValuesQualificationToQuery,
  type DeferredFilterValuesQualificationInput,
  type FilterValuesQualificationConfiguration,
  filterValuesQualificationConfigurationFromQuery,
  filterValuesQualificationConfigurationsEqual,
} from "./filter-values-qualification-request";
import {
  attachGeoPointsQualificationToQuery,
  type DeferredGeoPointsQualificationInput,
  geoPointsQualificationConfigurationFromQuery,
  geoPointsQualificationConfigurationsEqual,
} from "./geo-points-qualification-request";
import {
  attachJourneyEventPageQualificationToQuery,
  type DeferredJourneyEventPageQualificationInput,
  type JourneyEventPageQualificationConfiguration,
  journeyEventPageQualificationConfigurationFromQuery,
} from "./journey-event-page-qualification-request";
import type { D1LogicalProgramExecution } from "./logical-program-execution";
import {
  isInvalidOverviewSnapshot,
  readOwnDataProperty,
  serializeOwnDataSnapshot,
  snapshotBoundedOverviewTime,
  snapshotOwnDataValue,
} from "./overview-previous-time";
import {
  attachPagesDashboardQualificationToQuery,
  type DeferredPagesDashboardQualificationInput,
  pagesDashboardOwnDataSnapshotsEqual,
  type PagesDashboardQualificationConfiguration,
  pagesDashboardQualificationConfigurationFromQuery,
  qualificationRequestOwnDataSnapshot,
} from "./pages-dashboard-qualification-request";
import { entityMembershipRelation } from "./prepared-membership-relations";
import { registerPreparedMembership } from "./prepared-membership-relations";
import {
  attachRetentionQualificationToQuery,
  type DeferredRetentionQualificationInput,
  retentionQualificationConfigurationFromQuery,
  retentionQualificationConfigurationsEqual,
} from "./retention-qualification-request";
import {
  attachSessionListQualificationToQuery,
  type DeferredSessionListQualificationInput,
  type SessionListQualificationConfiguration,
  sessionListQualificationConfigurationFromQuery,
} from "./session-list-qualification-request";
import {
  attachVisitorListQualificationToQuery,
  type DeferredVisitorListQualificationInput,
  type VisitorListQualificationConfiguration,
  visitorListQualificationConfigurationFromQuery,
} from "./visitor-list-qualification-request";
import {
  createChannelsWholeMembershipInvocation,
  createDeferredWholeOriginalCompletionMembershipInvocation,
  createPageWholeMembershipInvocation,
  createWholeOriginalCompletionMembershipInvocation,
} from "./whole-membership-stage-program";
export { deferredFilterValuesQualificationFromQuery } from "./filter-values-qualification-request";

const DEFERRED_EVENT_QUALIFICATION = Symbol(
  "insightflare.deferred-event-qualification",
);
const deferredEventQualifications = new WeakSet<object>();
const deferredPageVisitEligibility = new WeakMap<
  object,
  {
    readonly audience: QueryAudience;
    readonly performancePrivateOptIn: boolean;
    readonly geoPointsPrivateOptIn: boolean;
    readonly technologyPrivateOptIn: boolean;
  }
>();
const DEFERRED_COMPARISON_PAGE_QUALIFICATION = Symbol(
  "insightflare.deferred-comparison-page-qualification",
);
const deferredComparisonPageQualifications = new WeakSet<object>();
const DEFERRED_OVERVIEW_TREND_QUALIFICATION = Symbol(
  "insightflare.deferred-overview-trend-qualification",
);
const deferredOverviewTrendQualifications = new WeakSet<object>();
const deferredOverviewTrendQueryOrigins = new WeakMap<object, object>();
const DEFERRED_SHARE_TREND_QUALIFICATION = Symbol(
  "insightflare.deferred-share-trend-qualification",
);
const deferredShareTrendQualifications = new WeakSet<object>();
const DEFERRED_RADAR_QUALIFICATION = Symbol(
  "insightflare.deferred-radar-qualification",
);
const deferredRadarQualifications = new WeakSet<object>();
const DEFERRED_CROSS_DIMENSION_QUALIFICATION = Symbol(
  "insightflare.deferred-cross-dimension-qualification",
);
const deferredCrossDimensionQualifications = new WeakSet<object>();
const DEFERRED_PERFORMANCE_SUMMARY_QUALIFICATION = Symbol(
  "insightflare.deferred-performance-summary-qualification",
);
const deferredPerformanceSummaryQualifications = new WeakSet<object>();

export type DeferredEventQualificationOperation =
  | "overview"
  | "trend"
  | "share-trend"
  | "radar"
  | "cross-dimension"
  | "performance"
  | "event-summary"
  | "event-types"
  | "event-trend"
  | "event-context"
  | "event-type-detail"
  | "event-records"
  | "event-fields"
  | "event-field-values"
  | "event-name-dimension"
  | "page-dimension"
  | "referrers"
  | "pages-aggregate-page"
  | "pages-tabs"
  | "geo-points"
  | "channel-overview"
  | "channel-list"
  | "session-boundary-dimension"
  | "session-boundary-overview-page"
  | "pages-dashboard"
  | "filter-values"
  | "retention"
  | "visitors"
  | "sessions"
  | "visitor-sessions"
  | "visitor-events"
  | "session-events";

export interface DeferredEventTypeDetailRequest {
  readonly eventName: string;
  readonly interval: CalendarGranularity;
  readonly includeBreakdowns: boolean;
  readonly includeContext: boolean;
  readonly contextLimit: number;
  readonly selectedKeys: readonly EventContextCardKey[];
}

export interface DeferredEventRecordsRequest {
  readonly search?: string;
  readonly eventName?: string;
  readonly sort: {
    readonly field: "occurredAt";
    readonly direction: "asc" | "desc";
  };
  readonly page: { readonly limit: number; readonly cursor: string | null };
  readonly audience: QueryAudience;
}

export interface DeferredEventFieldsRequest {
  readonly eventName?: string;
  readonly limit: number;
  readonly cursor: string | null;
  readonly audience: QueryAudience;
}

export interface DeferredEventFieldValuesRequest {
  readonly eventName?: string;
  readonly fieldPath: string;
  readonly fieldValueType: string;
  readonly search?: string;
  readonly limit: number;
  readonly cursor: string | null;
  readonly audience: QueryAudience;
}

export interface DeferredPageDimensionRequest extends NormalizedDimensionPageRequest {
  readonly audience: QueryAudience;
}

export type DeferredReferrersRequest =
  | {
      readonly kind: "summary";
      readonly topN: number;
      readonly audience: QueryAudience;
    }
  | {
      readonly kind: "page";
      readonly limit: number;
      readonly cursorText: string | null;
      readonly includeFullUrl: boolean;
      readonly search?: string;
      readonly sortBy: ReferrerPageSortKey;
      readonly sortDirection: "asc" | "desc";
      readonly audience: QueryAudience;
    };

export interface DeferredPagesAggregatePageRequest {
  readonly limit: number;
  readonly includeDetails: boolean;
  readonly cursorText: string | null;
  readonly audience: QueryAudience;
  readonly variant: string | undefined;
  readonly includeTabs: boolean | undefined;
}

export interface DeferredPagesTabsRequest {
  readonly configuration: "tabs-only" | "pages-with-tabs";
  readonly limit: number;
  readonly includeDetails: boolean;
  readonly cursorText: string | null;
  readonly audience: QueryAudience;
  readonly variant: string | undefined;
  readonly includeTabs: boolean | undefined;
}

export interface DeferredOverviewPageTableRequest extends NormalizedOverviewPageTableRequest {
  readonly audience: QueryAudience;
}

export interface DeferredChannelListRequest {
  readonly mode: "list";
  readonly limit: number;
  readonly sourceLimit: number | undefined;
  readonly audience: QueryAudience;
  readonly hasComparison: false;
  readonly hasCurrent: false;
  readonly hasReference: false;
}

export interface DeferredEventContextRequest {
  readonly eventName: string;
  readonly limit: number;
  readonly selectedKeys: readonly EventContextCardKey[];
}

export interface DeferredEventQualification {
  readonly operation: DeferredEventQualificationOperation;
  readonly env: Env;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly metadata: ScopedFilterMetadata;
  readonly time: QueryTime;
  readonly requestTime?: QueryTime;
  readonly requestScopePlan?: ScopedFilterPlan;
  readonly subject: SemanticSubjectDomain;
  readonly countInput: AdvancedCountFilterMatchPlanInput;
  readonly coverage: ReadonlyMap<string, number>;
  readonly channelMembershipInvocation?: ReturnType<
    typeof createChannelsWholeMembershipInvocation
  >;
  readonly wholeOriginalMembership?: {
    readonly consumer: WholeOriginalConsumer;
    readonly invocation: ReturnType<
      typeof createDeferredWholeOriginalCompletionMembershipInvocation
    >;
  };
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
  readonly eventContextRequest?: DeferredEventContextRequest;
  readonly eventTypeDetailRequest?: DeferredEventTypeDetailRequest;
  readonly eventRecordsRequest?: DeferredEventRecordsRequest;
  readonly eventFieldsRequest?: DeferredEventFieldsRequest;
  readonly eventFieldValuesRequest?: DeferredEventFieldValuesRequest;
  readonly eventNameDimensionRequest?: EventNameDimensionListRequest;
  readonly eventNameDimensionReportFilters?: FilterDocument;
  readonly pageDimensionRequest?: DeferredPageDimensionRequest;
  readonly pageDimensionFilterMode?: "allow-whole-filter";
  readonly geoPointsFilterMode?: "allow-whole-filter";
  readonly retentionFilterMode?: "allow-whole-filter";
  readonly performanceFilterMode?: "allow-whole-filter";
  readonly technologyFilterMode?: "allow-whole-filter";
  readonly referrersRequest?: DeferredReferrersRequest;
  readonly pagesAggregatePageRequest?: DeferredPagesAggregatePageRequest;
  readonly pagesTabsRequest?: DeferredPagesTabsRequest;
  readonly overviewPageTableRequest?: DeferredOverviewPageTableRequest;
  readonly channelListRequest?: DeferredChannelListRequest;
  readonly channelListFilterMode?: "allow-whole-filter";
  readonly referrerOverviewRequest?: DeferredReferrerOverviewTableRequest;
  readonly sessionBoundaryDimensionRequest?: NormalizedSessionBoundaryDimensionRequest;
  readonly sessionBoundaryOverviewPageRequest?: DeferredSessionBoundaryOverviewPageRequest;
  readonly sessionBoundaryFilterMode?: "allow-whole-filter";
  readonly pagesDashboardRequest?: PagesDashboardQualificationConfiguration;
  readonly filterValuesRequest?: FilterValuesQualificationConfiguration;
  readonly filterValuesFilterMode?: QualifiedSourceFilterMode;
  readonly filterValuesReportFilters?: FilterDocument;
  readonly visitorListRequest?: VisitorListQualificationConfiguration;
  readonly sessionListRequest?: SessionListQualificationConfiguration;
  readonly journeyEventPageRequest?: JourneyEventPageQualificationConfiguration;
}

export type PerformanceSummaryQualificationConfiguration =
  | { readonly mode: "summary" }
  | { readonly mode: "timeseries"; readonly interval: Interval }
  | {
      readonly mode: "breakdown";
      readonly dimension: SitePerformanceBreakdownDimension;
      readonly metric: PerformanceMetricKey;
      readonly limitPresent: boolean;
      readonly limitValue: number | null | undefined;
    }
  | {
      readonly mode: "dashboard";
      readonly interval: Interval;
      readonly routeLimitPresent: boolean;
      readonly routeLimitValue: number | null | undefined;
    };

export interface DeferredPerformanceSummaryQualification {
  readonly operation: "performance";
  readonly configuration: PerformanceSummaryQualificationConfiguration;
  readonly qualification:
    | (DeferredEventQualification & {
        readonly operation: "performance";
        readonly requestTime: QueryTime;
      })
    | DeferredEventCandidatePageProjectionFor<"performance">;
  readonly requestSnapshot: string;
}

export interface DeferredOverviewTrendQualification {
  readonly operation: "overview" | "trend";
  readonly configuration: OverviewTrendQualificationConfiguration;
  readonly qualification: DeferredEventQualification & {
    readonly operation: "overview" | "trend";
    readonly requestTime: QueryTime;
  };
  readonly requestSnapshot: string;
}

export interface DeferredShareTrendQualification {
  readonly operation: "share-trend";
  readonly configuration: TechnologyShareTrendQualificationConfiguration;
  readonly qualification:
    | (DeferredEventQualification & {
        readonly operation: "share-trend";
        readonly requestTime: QueryTime;
      })
    | DeferredEventCandidatePageProjectionFor<"share-trend">;
  readonly requestSnapshot: string;
}

export interface DeferredRadarQualification {
  readonly operation: "radar";
  readonly configuration: TechnologyRadarQualificationConfiguration;
  readonly qualification:
    | (DeferredEventQualification & {
        readonly operation: "radar";
        readonly requestTime: QueryTime;
      })
    | DeferredEventCandidatePageProjectionFor<"radar">;
  readonly requestSnapshot: string;
}

export interface DeferredCrossDimensionQualification {
  readonly operation: "cross-dimension";
  readonly configuration: TechnologyCrossQualificationConfiguration;
  readonly qualification:
    | (DeferredEventQualification & {
        readonly operation: "cross-dimension";
        readonly requestTime: QueryTime;
      })
    | DeferredEventCandidatePageProjectionFor<"cross-dimension">;
  readonly requestSnapshot: string;
}

export interface DeferredComparisonPageQualification {
  readonly operation: "dimension";
  readonly current: DeferredComparisonPageSide;
  readonly reference: DeferredComparisonPageSide;
  readonly tab: string;
  readonly expression: string;
  readonly reportFamily: ComparisonReportFamily;
  readonly metric: "views" | "sessions" | "visitors";
  readonly sortBy: "current" | "reference" | "change";
  readonly direction: "asc" | "desc";
  readonly limit: number;
  readonly search?: string;
  readonly cursorToken: string | null;
  readonly audience: QueryAudience;
  readonly requestSnapshot: string;
}

export type DeferredComparisonPageSide =
  | {
      readonly kind: "qualified";
      readonly qualification: DeferredEventQualification;
    }
  | {
      readonly kind: "native";
      readonly filters: FilterDocument;
      readonly time: QueryTime;
    };

export interface DeferredSessionBoundaryOverviewPageRequest {
  readonly mode: "overview-tab";
  readonly tab: "page.entry" | "page.exit";
  readonly kind: "entry" | "exit";
  readonly dimension: "session.entryPath" | "session.exitPath";
  readonly limit: number;
  readonly cursorToken: string | null;
  readonly search?: string;
  readonly sortBy: "views" | "sessions" | "visitors";
  readonly sortDirection: "asc" | "desc";
  readonly audience: QueryAudience;
}

export type DeferredEventSummaryQualification =
  | (DeferredEventQualification & {
      readonly operation: "event-summary";
    })
  | (Omit<DeferredEventQualification, "operation" | "countInput"> & {
      readonly operation: "event-summary";
      readonly countInput: AdvancedEventCandidateCountPlanInput;
    });

export type DeferredEventTypesQualification = Omit<
  DeferredEventQualification,
  "operation" | "countInput"
> & {
  readonly operation: "event-types";
  readonly countInput: AdvancedCountQualificationPlanInput;
};

export type DeferredEventNameDimensionQualification = Omit<
  DeferredEventQualification,
  "operation" | "countInput" | "eventNameDimensionReportFilters"
> & {
  readonly operation: "event-name-dimension";
  readonly countInput: AdvancedCountQualificationPlanInput;
  readonly eventNameDimensionRequest: EventNameDimensionListRequest;
  readonly eventNameDimensionReportFilters?: FilterDocument;
};

export type DeferredEventTrendQualification =
  | (DeferredEventQualification & {
      readonly operation: "event-trend";
    })
  | (Omit<DeferredEventQualification, "operation" | "countInput"> & {
      readonly operation: "event-trend";
      readonly countInput: AdvancedEventCandidateCountPlanInput;
    });

export type DeferredEventContextQualification =
  | (DeferredEventQualification & {
      readonly operation: "event-context";
      readonly eventContextRequest: DeferredEventContextRequest;
    })
  | (Omit<DeferredEventQualification, "operation" | "countInput"> & {
      readonly operation: "event-context";
      readonly countInput: AdvancedEventCandidateCountPlanInput;
      readonly eventContextRequest: DeferredEventContextRequest;
    });

export type DeferredEventTypeDetailQualification =
  | (DeferredEventQualification & {
      readonly operation: "event-type-detail";
      readonly eventTypeDetailRequest: DeferredEventTypeDetailRequest;
    })
  | (Omit<DeferredEventQualification, "operation" | "countInput"> & {
      readonly operation: "event-type-detail";
      readonly countInput: AdvancedEventCandidateCountPlanInput;
      readonly eventTypeDetailRequest: DeferredEventTypeDetailRequest;
    });

export type DeferredEventRecordsQualification =
  | (DeferredEventQualification & {
      readonly operation: "event-records";
      readonly eventRecordsRequest: DeferredEventRecordsRequest;
    })
  | (Omit<DeferredEventQualification, "operation" | "countInput"> & {
      readonly operation: "event-records";
      readonly countInput: AdvancedEventCandidateCountPlanInput;
      readonly eventRecordsRequest: DeferredEventRecordsRequest;
    });

export type DeferredEventFieldsQualification =
  | (DeferredEventQualification & {
      readonly operation: "event-fields";
      readonly eventFieldsRequest: DeferredEventFieldsRequest;
    })
  | (Omit<DeferredEventQualification, "operation" | "countInput"> & {
      readonly operation: "event-fields";
      readonly countInput: AdvancedEventCandidateCountPlanInput;
      readonly eventFieldsRequest: DeferredEventFieldsRequest;
    });

export type DeferredEventFieldValuesQualification =
  | (DeferredEventQualification & {
      readonly operation: "event-field-values";
      readonly eventFieldValuesRequest: DeferredEventFieldValuesRequest;
    })
  | (Omit<DeferredEventQualification, "operation" | "countInput"> & {
      readonly operation: "event-field-values";
      readonly countInput: AdvancedEventCandidateCountPlanInput;
      readonly eventFieldValuesRequest: DeferredEventFieldValuesRequest;
    });

export type DeferredEventCandidatePageProjection = Omit<
  DeferredEventQualification,
  "countInput"
> & {
  readonly countInput: AdvancedEventCandidateCountPlanInput;
  readonly eventCandidateReportProjection: "page-visits";
};

export type DeferredEventCandidatePageProjectionFor<
  Operation extends DeferredEventQualificationOperation,
> = Operation extends DeferredEventQualificationOperation
  ? DeferredEventCandidatePageProjection & {
      readonly operation: Operation;
      readonly requestTime: QueryTime;
    }
  : never;

type EventCandidatePageReportOperation =
  | "cross-dimension"
  | "radar"
  | "share-trend"
  | "performance"
  | "geo-points"
  | "page-dimension"
  | "referrers"
  | "channel-overview"
  | "channel-list"
  | "session-boundary-dimension"
  | "session-boundary-overview-page";

export type DeferredPageDimensionQualification =
  | (DeferredEventQualification & {
      readonly operation: "page-dimension";
      readonly pageDimensionRequest: DeferredPageDimensionRequest;
    })
  | (DeferredEventCandidatePageProjection & {
      readonly operation: "page-dimension";
      readonly pageDimensionRequest: DeferredPageDimensionRequest;
    });

export type DeferredReferrersQualification =
  | (DeferredEventQualification & {
      readonly operation: "referrers";
      readonly referrersRequest: DeferredReferrersRequest;
    })
  | (DeferredEventCandidatePageProjectionFor<"referrers"> & {
      readonly referrersRequest: DeferredReferrersRequest;
    });

export type DeferredPagesAggregatePageQualification =
  | (DeferredEventQualification & {
      readonly operation: "pages-aggregate-page";
      readonly pagesAggregatePageRequest: DeferredPagesAggregatePageRequest;
    })
  | (DeferredEventCandidatePageProjection & {
      readonly operation: "pages-aggregate-page";
      readonly pagesAggregatePageRequest: DeferredPagesAggregatePageRequest;
    });

export type DeferredPagesTabsQualification =
  | (DeferredEventQualification & {
      readonly operation: "pages-tabs";
      readonly pagesTabsRequest: DeferredPagesTabsRequest;
    })
  | (DeferredEventCandidatePageProjectionFor<"pages-tabs"> & {
      readonly pagesTabsRequest: DeferredPagesTabsRequest;
    });

export type DeferredOverviewPageTableQualification =
  | (DeferredEventQualification & {
      readonly operation: "page-dimension";
      readonly overviewPageTableRequest: DeferredOverviewPageTableRequest;
    })
  | (DeferredEventCandidatePageProjection & {
      readonly operation: "page-dimension";
      readonly overviewPageTableRequest: DeferredOverviewPageTableRequest;
    });

export type DeferredChannelOverviewQualification =
  | (DeferredEventQualification & {
      readonly operation: "channel-overview";
      readonly overviewPageTableRequest: DeferredOverviewPageTableRequest;
    })
  | (DeferredEventCandidatePageProjectionFor<"channel-overview"> & {
      readonly overviewPageTableRequest: DeferredOverviewPageTableRequest;
    });

export type DeferredChannelListQualification =
  | (DeferredEventQualification & {
      readonly operation: "channel-list";
      readonly channelListRequest: DeferredChannelListRequest;
    })
  | (DeferredEventCandidatePageProjectionFor<"channel-list"> & {
      readonly channelListRequest: DeferredChannelListRequest;
    });

export type DeferredReferrerOverviewQualification =
  | (DeferredEventQualification & {
      readonly operation: "page-dimension";
      readonly referrerOverviewRequest: DeferredReferrerOverviewTableRequest;
    })
  | (DeferredEventCandidatePageProjectionFor<"page-dimension"> & {
      readonly referrerOverviewRequest: DeferredReferrerOverviewTableRequest;
    });

export type DeferredPageQualification =
  | DeferredPageDimensionQualification
  | DeferredOverviewPageTableQualification
  | DeferredChannelOverviewQualification
  | DeferredReferrerOverviewQualification;

export type DeferredSessionBoundaryDimensionQualification =
  | (DeferredEventQualification & {
      readonly operation: "session-boundary-dimension";
      readonly sessionBoundaryDimensionRequest: NormalizedSessionBoundaryDimensionRequest;
    })
  | (DeferredEventCandidatePageProjectionFor<"session-boundary-dimension"> & {
      readonly sessionBoundaryDimensionRequest: NormalizedSessionBoundaryDimensionRequest;
    });

export type DeferredSessionBoundaryOverviewPageQualification =
  | (DeferredEventQualification & {
      readonly operation: "session-boundary-overview-page";
      readonly sessionBoundaryOverviewPageRequest: DeferredSessionBoundaryOverviewPageRequest;
    })
  | (DeferredEventCandidatePageProjectionFor<"session-boundary-overview-page"> & {
      readonly sessionBoundaryOverviewPageRequest: DeferredSessionBoundaryOverviewPageRequest;
    });

function invalidInput(
  path: string,
  code: string,
): AnalyticsProviderDomainError {
  return new AnalyticsProviderDomainError({
    kind: "invalid-input",
    issues: [{ path, code }],
  });
}

type WholeEvaluationInput = {
  readonly env: Env;
  readonly subject: SemanticSubjectDomain;
  readonly siteIds: readonly string[];
  readonly filters: FilterDocument;
  readonly plan: ScopedFilterPlan;
  readonly time: QueryTime;
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
  readonly coverage?: ReadonlyMap<string, number>;
  readonly program?: D1LogicalProgramExecution;
  readonly deferredInvocation?: ReturnType<
    typeof createDeferredWholeOriginalCompletionMembershipInvocation
  >;
};
function evaluateForSites(
  input: WholeEvaluationInput & { readonly program: D1LogicalProgramExecution },
): Promise<PreparedMembership | undefined>;
function evaluateForSites(
  input: WholeEvaluationInput,
): Promise<PreparedMembership>;
function evaluateForSites(
  input: WholeEvaluationInput & { readonly completion: WholeOriginalConsumer },
): Promise<WholeOriginalProjection>;
async function evaluateForSites(
  input: WholeEvaluationInput & { readonly completion?: WholeOriginalConsumer },
): Promise<PreparedMembership | WholeOriginalProjection | undefined> {
  // The raw staged evaluator retains the caller's original completion or
  // registered projection. Its finite domain does not authorize a reader.
  const stagedEntityEvaluation =
    input.subject.origin === "site" &&
    input.subject.siteIds.length === 1 &&
    input.siteIds.length === 1 &&
    input.siteIds[0] === input.subject.siteIds[0] &&
    ((input.plan.mode === "entity" &&
      (input.plan.scope === "session" || input.plan.scope === "visitor")) ||
      (input.plan.mode === "observation" && input.plan.scope === "event")) &&
    input.coverage === undefined;
  // Only closed Team whole-original completions can opt into a joint raw program.
  // Keep exact authorized domain/order; no caller coverage or arbitrary slots.
  const stagedTeamEvaluation =
    (input.completion?.kind === "team-sites" ||
      input.completion?.kind === "team-exact-dimension") &&
    input.subject.origin === "team" &&
    input.coverage === undefined &&
    input.plan.mode === "entity" &&
    (input.plan.scope === "session" || input.plan.scope === "visitor") &&
    input.siteIds.length === input.subject.siteIds.length &&
    input.siteIds.every(
      (siteId, index) => siteId === input.subject.siteIds[index],
    );
  // Retain the same actual single-site S/V invocation in the D1-owned
  // program, including an existing private completion. Deferred coverage
  // predecessors keep their original invocation and execution route.
  const programInvocation =
    input.program &&
    (!input.completion || input.deferredInvocation === undefined) &&
    stagedEntityEvaluation &&
    input.plan.mode === "entity" &&
    (input.plan.scope === "session" || input.plan.scope === "visitor")
      ? createWholeOriginalCompletionMembershipInvocation({
          env: input.env,
          subject: input.subject,
          filters: input.filters,
          queryTime: input.time,
          scope: input.plan.scope,
          originalScopePlan: input.plan,
          ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        })
      : undefined;
  const matches = await (programInvocation
    ? input.program!.executeWholeAtOriginalCheckpoint(programInvocation)
    : input.deferredInvocation
      ? executeAnalyticsLogicalStage({
          kind: "whole-original-completion-at-original-checkpoint",
          invocation: input.deferredInvocation,
        })
      : stagedEntityEvaluation || stagedTeamEvaluation
        ? executeAnalyticsLogicalStage({
            kind: "whole-original-completion-at-original-checkpoint",
            invocation: stagedTeamEvaluation
              ? createTeamWholeOriginalMembershipInvocation({
                  env: input.env,
                  subject: input.subject,
                  filters: input.filters,
                  queryTime: input.time,
                  scope: input.plan.scope as "session" | "visitor",
                  originalScopePlan: input.plan,
                  ...(input.diagnostics
                    ? { diagnostics: input.diagnostics }
                    : {}),
                  ...(input.signal ? { signal: input.signal } : {}),
                })
              : createWholeOriginalCompletionMembershipInvocation({
                  env: input.env,
                  subject: input.subject,
                  filters: input.filters,
                  queryTime: input.time,
                  scope: input.plan.scope,
                  originalScopePlan: input.plan,
                  ...(input.diagnostics
                    ? { diagnostics: input.diagnostics }
                    : {}),
                  ...(input.signal ? { signal: input.signal } : {}),
                }),
          })
        : evaluateForSitesCore(input));
  if (input.completion) {
    // Preserve the original selected-role projection/error checkpoint before
    // declaring the actual terminal. Completion still returns its projection;
    // early [] has no terminal and retains the original owner/reader route.
    const projection = projectWholeOriginalMembership({
      siteIds: input.siteIds,
      mode: input.plan.mode,
      matches,
    });
    if (programInvocation)
      input.program!.completedWholeOutput(programInvocation);
    return projection;
  }
  if (
    programInvocation &&
    input.program!.completedWholeOutput(programInvocation)
  )
    return undefined;
  return registerPreparedMembership({
    siteIds: input.siteIds,
    mode: input.plan.mode,
    matches,
  });
}

export interface IndependentOverviewMembershipDependency {
  readonly operation: "overview" | "trend";
  readonly enginePlan: OverviewMembershipDependencyPlan<{
    readonly operation: "overview" | "trend";
    readonly configuration: OverviewTrendQualificationConfiguration;
  }>;
  readonly preparation: PageVisitQualificationPreparation;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly consumerKey: ReturnType<typeof pageVisitQualificationConsumerKey>;
  readonly siteId: string;
  readonly requestSnapshot: string;
}
const independentOverviewMembershipDependencies = new WeakMap<
  object,
  IndependentOverviewMembershipDependency
>();
export function independentOverviewMembershipDependencyFromQuery(
  value: unknown,
  operation: "overview" | "trend",
): IndependentOverviewMembershipDependency | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = independentOverviewMembershipDependencies.get(value);
  if (
    state &&
    (state.operation !== operation ||
      qualificationRequestOwnDataSnapshot(value) !== state.requestSnapshot)
  )
    throw new Error("overview_membership_request_changed");
  return state;
}
async function prepareIndependentOverviewMembershipDependency(input: {
  readonly env: Env;
  readonly query: QueryInput & Record<string, unknown>;
  readonly operation: "overview" | "trend";
  readonly subject: SemanticSubjectDomain;
  readonly siteIds: readonly string[];
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
}): Promise<IndependentOverviewMembershipDependency | undefined> {
  const q = input.query,
    filters = q.filters,
    metadata = scopedFilterMetadata(filters);
  if (
    !filters?.root ||
    !metadata ||
    !queryHasNoComparisonState(q) ||
    q.context.policy.audience !== "private-dashboard" ||
    input.subject.origin !== "site" ||
    input.siteIds.length !== 1 ||
    input.subject.siteIds.length !== 1 ||
    input.subject.siteIds[0] !== input.siteIds[0] ||
    metadata.siteIds.length !== 1 ||
    metadata.siteIds[0] !== input.siteIds[0] ||
    metadata.plan.preparedMembership !== undefined ||
    metadata.plan.mode !== "entity" ||
    metadata.plan.scope === "event" ||
    metadata.plan.membership.kind !== "entity" ||
    !metadata.time?.filterRange ||
    metadata.time.fullHistory === true ||
    metadata.time.filterRangeEmpty === true ||
    !q.time ||
    !sameEventFieldsQueryTime(q.time as QueryTime, metadata.time)
  )
    return undefined;
  const time = metadata.time;
  // Overview's actual reader reconstructs this report window. The preparation
  // keeps the independent original C/F/R, rather than substituting this C.
  const readerTime = queryWindowToTime({
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  });
  const configuration = overviewTrendConfigurationForQuery(input.operation, {
    ...q,
    time: readerTime,
  });
  if (!configuration) return undefined;
  const execution = planAdvancedFilterExecution({
    subject: input.subject,
    filters,
    scope: metadata.plan.scope,
    time,
    reportFusionAvailable: false,
  });
  const keys =
    configuration.kind === "trend"
      ? ["current-trend" as const]
      : [
          "current-overview" as const,
          ...(configuration.kind === "overview-with-previous" ||
          configuration.kind === "overview-with-previous-and-detail"
            ? ["previous-overview" as const]
            : []),
          ...(configuration.kind === "overview-with-detail" ||
          configuration.kind === "overview-with-previous-and-detail"
            ? ["current-detail" as const]
            : []),
        ];
  const enginePlan = planOverviewMembershipDependencies({
    preparation: { key: "original", execution, filters, queryTime: time },
    readerQueryTime: readerTime,
    operation: input.operation,
    configuration,
    importedOutputs: keys.map((childKey) => ({ childKey, outputId: childKey })),
    consumer: { operation: input.operation, configuration },
  });
  if (!enginePlan) return undefined;
  const requestSnapshot = qualificationRequestOwnDataSnapshot(q);
  if (requestSnapshot === undefined) return undefined;
  const step = enginePlan.preparation;
  // This is the same whole-original-filter evaluator prepareSide used. Its
  // fresh admission enforces the fixed descriptor bounds and error order.
  const matches = await evaluateForSitesCore({
    env: input.env,
    subject: step.membership.subject,
    siteIds: metadata.siteIds,
    filters: step.filters,
    plan: metadata.plan,
    time: step.queryTime,
    diagnostics: input.diagnostics,
    signal: input.signal,
  });
  if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (qualificationRequestOwnDataSnapshot(q) !== requestSnapshot)
    throw new Error("overview_membership_request_changed");
  const consumerKey = pageVisitQualificationConsumerKey(
    input.operation,
    enginePlan,
  );
  const preparation = createPageVisitQualificationPreparation({
    siteId: input.siteIds[0]!,
    filters,
    queryTime: time,
    scopePlan: metadata.plan,
    consumerKey,
    relation: createEntityMembershipRelation(input.siteIds[0]!, matches),
    dependencyRef: step.dependencyRef,
    maxBindings: enginePlan.children.length,
    maxSourcesPerRole: 2,
  });
  return Object.freeze({
    operation: input.operation,
    enginePlan,
    preparation,
    filters,
    queryTime: time,
    scopePlan: metadata.plan,
    consumerKey,
    siteId: input.siteIds[0]!,
    requestSnapshot,
  });
}

interface IndependentPageChannelMembershipState {
  readonly enginePlan: NonNullable<
    ReturnType<typeof planPageChannelMembershipDependencies>
  >;
  readonly relation: AnalyticsDbRelation;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly siteId: string;
  readonly requestSnapshot: string;
  claimed: boolean;
}
const independentPageChannelMemberships = new WeakMap<
  object,
  IndependentPageChannelMembershipState
>();
function independentPageChannelMembershipState(query: unknown) {
  if (!query || typeof query !== "object") return undefined;
  const state = independentPageChannelMemberships.get(query);
  if (
    state &&
    qualificationRequestOwnDataSnapshot(query) !== state.requestSnapshot
  )
    throw new Error("page_channel_membership_request_changed");
  return state;
}
export function hasIndependentPageChannelMembershipDependency(
  query: unknown,
): boolean {
  return independentPageChannelMembershipState(query) !== undefined;
}
function independentPageChannelReader(
  q: QueryInput & Record<string, unknown>,
  operation: "dimension" | "channels",
): PageChannelMembershipReader | undefined {
  if (operation === "dimension") {
    if (q.mode === "overview-tab") return undefined;
    const normalized = normalizeDimensionPageRequest({
      dimension: typeof q.dimension === "string" ? q.dimension : "",
      page: q.page,
      limit: q.limit,
      sort: q.sort,
      search: q.search,
    });
    if (!normalized) return undefined;
    return {
      kind: "dimension-page",
      dimension: normalized.dimension,
      limit: normalized.limit,
      cursorText: normalized.cursorText,
      ...(normalized.search !== undefined ? { search: normalized.search } : {}),
      sortBy: normalized.sortBy ?? "views",
      sortDirection: normalized.sortDirection ?? "desc",
      excludeEmpty: false,
      audience: "private-dashboard",
    };
  }
  if (q.mode !== "list") return undefined;
  const sourceLimit = q.limit;
  if (sourceLimit !== undefined && typeof sourceLimit !== "number")
    return undefined;
  return {
    kind: "channels-list",
    mode: "list",
    limit: sourceLimit ?? 100,
    sourceLimit,
    audience: "private-dashboard",
    hasComparison: false,
    hasCurrent: false,
    hasReference: false,
  };
}
async function prepareIndependentPageChannelMembershipDependency(input: {
  readonly env: Env;
  readonly query: QueryInput & Record<string, unknown>;
  readonly operation: "dimension" | "channels";
  readonly subject: SemanticSubjectDomain;
  readonly siteIds: readonly string[];
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
}): Promise<IndependentPageChannelMembershipState | undefined> {
  const q = input.query,
    filters = q.filters,
    metadata = scopedFilterMetadata(filters);
  if (
    !filters?.root ||
    !metadata ||
    !queryHasNoComparisonState(q) ||
    q.context.policy.audience !== "private-dashboard" ||
    input.subject.origin !== "site" ||
    input.siteIds.length !== 1 ||
    input.subject.siteIds.length !== 1 ||
    input.subject.siteIds[0] !== input.siteIds[0] ||
    metadata.siteIds.length !== 1 ||
    metadata.siteIds[0] !== input.siteIds[0] ||
    !queryScopePlanMatchesMetadata(q, metadata.plan) ||
    metadata.plan.preparedMembership !== undefined ||
    metadata.plan.mode !== "entity" ||
    metadata.plan.scope === "event" ||
    metadata.plan.membership.kind !== "entity" ||
    !metadata.time?.filterRange ||
    metadata.time.fullHistory ||
    metadata.time.filterRangeEmpty ||
    !q.time ||
    !sameEventFieldsQueryTime(q.time as QueryTime, metadata.time) ||
    advancedCountPayloadPaths(filters.root).length > 0 ||
    filtersUseSequenceSemantics(filters) ||
    q.analysisContext !== undefined ||
    q.goalId !== undefined ||
    q.funnelId !== undefined
  )
    return undefined;
  const time = metadata.time,
    reader = independentPageChannelReader(q, input.operation);
  if (
    !reader ||
    [time.range, time.readRange ?? time.range, time.filterRange].some(
      (r) =>
        !r ||
        typeof r.startMs !== "number" ||
        typeof r.endExclusiveMs !== "number" ||
        !Number.isFinite(r.startMs) ||
        !Number.isFinite(r.endExclusiveMs) ||
        r.startMs >= r.endExclusiveMs,
    )
  )
    return undefined;
  const derive = () =>
    planPageChannelMembershipDependencies({
      preparation: {
        key: "original",
        filters,
        queryTime: time,
        execution: planAdvancedFilterExecution({
          subject: input.subject,
          filters,
          scope: metadata.plan.scope,
          time,
          reportFusionAvailable: false,
        }),
      },
      readerQueryTime: time,
      reader,
    });
  const enginePlan = derive(),
    requestSnapshot = qualificationRequestOwnDataSnapshot(q);
  if (!enginePlan || requestSnapshot === undefined) return undefined;
  const step = enginePlan.preparations[0]!;
  const matches = await evaluateForSitesCore({
    env: input.env,
    subject: step.membership.subject,
    siteIds: metadata.siteIds,
    filters: step.filters,
    plan: metadata.plan,
    time: step.queryTime,
    diagnostics: input.diagnostics,
    signal: input.signal,
  });
  if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (
    qualificationRequestOwnDataSnapshot(q) !== requestSnapshot ||
    qualificationRequestOwnDataSnapshot(derive()) !==
      qualificationRequestOwnDataSnapshot(enginePlan)
  )
    throw new Error("page_channel_membership_request_changed");
  return {
    enginePlan,
    relation: createEntityMembershipRelation(input.siteIds[0]!, matches),
    filters,
    queryTime: time,
    scopePlan: metadata.plan,
    siteId: input.siteIds[0]!,
    requestSnapshot,
    claimed: false,
  };
}
export function claimIndependentPageChannelMembershipDependency(
  query: unknown,
  reader: PageChannelMembershipReader,
  cursor: {
    readonly primary: number;
    readonly secondary: number;
    readonly value: string;
  } | null,
) {
  const state = independentPageChannelMembershipState(query);
  if (!state) return undefined;
  if (state.claimed) throw new Error("page_channel_membership_replayed");
  const readerSnapshot = qualificationRequestOwnDataSnapshot(reader);
  const expected = state.enginePlan.consumer;
  // JSON snapshots omit undefined optional fields. Restore this one declared
  // channel field, while preserving the exact complete caller-reader snapshot.
  const expectedReader =
    expected.kind === "channels-list"
      ? { ...expected, sourceLimit: expected.sourceLimit }
      : expected;
  if (
    readerSnapshot === undefined ||
    readerSnapshot !== qualificationRequestOwnDataSnapshot(expectedReader) ||
    (cursor !== null &&
      (reader.kind !== "dimension-page" ||
        Object.keys(cursor).sort().join(",") !== "primary,secondary,value" ||
        !Number.isFinite(cursor.primary) ||
        !Number.isFinite(cursor.secondary) ||
        typeof cursor.value !== "string"))
  )
    throw new Error("page_channel_membership_reader_mismatch");
  const cursorSnapshot = qualificationRequestOwnDataSnapshot(cursor);
  if (cursor !== null && cursorSnapshot === undefined)
    throw new Error("page_channel_membership_reader_mismatch");
  const consumer = "independent-dimension-page";
  const consumerKey =
    reader.kind === "dimension-page"
      ? pageVisitQualificationConsumerKey(consumer, {
          limit: reader.limit,
          selection: dimensionPageSelection(reader.dimension)!,
          excludeEmpty: false,
          search: reader.search,
          sortBy: reader.sortBy,
          sortDirection: reader.sortDirection,
          cursor,
          audience: reader.audience,
        })
      : pageVisitQualificationConsumerKey("channel-list", {
          limit: reader.limit,
          sourceLimit: reader.sourceLimit,
          audience: reader.audience,
          hasComparison: reader.hasComparison,
          hasCurrent: reader.hasCurrent,
          hasReference: reader.hasReference,
        });
  const preparation = createPageVisitQualificationPreparation({
    siteId: state.siteId,
    filters: state.filters,
    queryTime: state.queryTime,
    scopePlan: state.scopePlan,
    consumerKey,
    relation: state.relation,
    dependencyRef: state.enginePlan.preparations[0]!.dependencyRef,
    maxBindings: 1,
    maxSourcesPerRole: 1,
  });
  state.claimed = true;
  return {
    preparation,
    queryTime: state.queryTime,
    scopePlan: state.scopePlan,
    consumer,
    assertFresh() {
      independentPageChannelMembershipState(query);
      if (
        qualificationRequestOwnDataSnapshot(reader) !== readerSnapshot ||
        qualificationRequestOwnDataSnapshot(cursor) !== cursorSnapshot
      )
        throw new Error("page_channel_membership_reader_mismatch");
    },
  };
}

interface IndependentReferrersPageMembershipState {
  readonly enginePlan: ReferrersPageMembershipDependencyPlan;
  readonly relation: AnalyticsDbRelation;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly siteId: string;
  readonly requestSnapshot: string;
  claimed: boolean;
}
const independentReferrersPageMemberships = new WeakMap<
  object,
  IndependentReferrersPageMembershipState
>();
function independentReferrersPageMembershipState(query: unknown) {
  if (!query || typeof query !== "object") return undefined;
  const state = independentReferrersPageMemberships.get(query);
  if (
    state &&
    qualificationRequestOwnDataSnapshot(query) !== state.requestSnapshot
  )
    throw new Error("referrers_page_membership_request_changed");
  return state;
}
/** Check both before and after the owner's unchanged cursor-decoding await. */
export function hasIndependentReferrersPageMembershipDependency(
  query: unknown,
): boolean {
  return independentReferrersPageMembershipState(query) !== undefined;
}
function independentReferrersPageConfiguration(
  q: QueryInput & Record<string, unknown>,
): ReferrersPageReaderConfiguration | undefined {
  if (
    q.variant === "summary" ||
    (q.variant !== undefined && q.variant !== "page")
  )
    return undefined;
  const page =
    q.page && typeof q.page === "object"
      ? (q.page as Record<string, unknown>)
      : {};
  const limit =
    typeof page.limit === "number" && Number.isFinite(page.limit)
      ? page.limit
      : typeof q.limit === "number" && Number.isFinite(q.limit)
        ? q.limit
        : 20;
  if (!Number.isSafeInteger(limit) || limit < 0) return undefined;
  return {
    limit,
    includeFullUrl: q.includeFullUrl === true,
    ...(typeof q.search === "string" ? { search: q.search } : {}),
    cursorText: typeof page.cursor === "string" ? page.cursor : null,
    audience: "private-dashboard",
    sortBy: q.sort === "visitors" ? "visitors" : "views",
    sortDirection: q.direction === "asc" ? "asc" : "desc",
  };
}
async function prepareIndependentReferrersPageMembershipDependency(input: {
  readonly env: Env;
  readonly query: QueryInput & Record<string, unknown>;
  readonly subject: SemanticSubjectDomain;
  readonly siteIds: readonly string[];
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
}): Promise<IndependentReferrersPageMembershipState | undefined> {
  const q = input.query,
    filters = q.filters,
    metadata = scopedFilterMetadata(filters);
  if (
    !filters?.root ||
    !metadata ||
    !queryHasNoComparisonState(q) ||
    q.context.policy.audience !== "private-dashboard" ||
    input.subject.origin !== "site" ||
    input.siteIds.length !== 1 ||
    input.subject.siteIds.length !== 1 ||
    input.subject.siteIds[0] !== input.siteIds[0] ||
    metadata.siteIds.length !== 1 ||
    metadata.siteIds[0] !== input.siteIds[0] ||
    !queryScopePlanMatchesMetadata(q, metadata.plan) ||
    metadata.plan.preparedMembership !== undefined ||
    metadata.plan.mode !== "entity" ||
    metadata.plan.scope === "event" ||
    metadata.plan.membership.kind !== "entity" ||
    !metadata.time?.filterRange ||
    metadata.time.fullHistory ||
    metadata.time.filterRangeEmpty ||
    !q.time ||
    !sameEventFieldsQueryTime(q.time as QueryTime, metadata.time) ||
    advancedCountPayloadPaths(filters.root).length > 0 ||
    filtersUseSequenceSemantics(filters) ||
    q.analysisContext !== undefined ||
    q.goalId !== undefined ||
    q.funnelId !== undefined
  )
    return undefined;
  const time = metadata.time,
    configuration = independentReferrersPageConfiguration(q);
  if (
    !configuration ||
    [time.range, time.readRange ?? time.range, time.filterRange].some(
      (r) =>
        !r ||
        typeof r.startMs !== "number" ||
        typeof r.endExclusiveMs !== "number" ||
        !Number.isFinite(r.startMs) ||
        !Number.isFinite(r.endExclusiveMs) ||
        r.startMs >= r.endExclusiveMs,
    )
  )
    return undefined;
  const execution = planAdvancedFilterExecution({
    subject: input.subject,
    filters,
    scope: metadata.plan.scope,
    time,
    reportFusionAvailable: false,
  });
  const enginePlan = planReferrersPageMembershipDependencies({
    preparation: { key: "original", execution, filters, queryTime: time },
    // This reader historically uses metadata.time, including original C/F/R.
    readerQueryTime: time,
    configuration,
  });
  const requestSnapshot = qualificationRequestOwnDataSnapshot(q);
  if (!enginePlan || requestSnapshot === undefined) return undefined;
  const step = enginePlan.steps[0]!;
  const matches = await evaluateForSitesCore({
    env: input.env,
    subject: step.membership.subject,
    siteIds: metadata.siteIds,
    filters: step.filters,
    plan: metadata.plan,
    time: step.queryTime,
    diagnostics: input.diagnostics,
    signal: input.signal,
  });
  if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (qualificationRequestOwnDataSnapshot(q) !== requestSnapshot)
    throw new Error("referrers_page_membership_request_changed");
  return {
    enginePlan,
    filters,
    queryTime: time,
    scopePlan: metadata.plan,
    siteId: input.siteIds[0]!,
    relation: createEntityMembershipRelation(input.siteIds[0]!, matches),
    requestSnapshot,
    claimed: false,
  };
}
/** Called only after the owner's original cursor decoder and its context checks. */
export function claimIndependentReferrersPageMembershipDependency(
  query: unknown,
  configuration: {
    readonly limit: number;
    readonly includeFullUrl: boolean;
    readonly search?: string;
    readonly cursor: {
      readonly primary: number;
      readonly secondary: number;
      readonly referrer: string;
    } | null;
    readonly audience: QueryAudience;
    readonly sortBy: "views" | "visitors";
    readonly sortDirection: "asc" | "desc";
  },
) {
  const state = independentReferrersPageMembershipState(query);
  if (!state) return undefined;
  if (state.claimed) throw new Error("referrers_page_membership_replayed");
  const expected = state.enginePlan.consumer.configuration;
  const { cursor, ...actual } = configuration;
  const expectedReader = {
    limit: expected.limit,
    includeFullUrl: expected.includeFullUrl,
    search: expected.search,
    audience: expected.audience,
    sortBy: expected.sortBy,
    sortDirection: expected.sortDirection,
  };
  const readerSnapshot = qualificationRequestOwnDataSnapshot(configuration);
  if (
    readerSnapshot === undefined ||
    qualificationRequestOwnDataSnapshot(actual) !==
      qualificationRequestOwnDataSnapshot(expectedReader) ||
    (cursor !== null &&
      (Object.keys(cursor).sort().join(",") !== "primary,referrer,secondary" ||
        !Number.isFinite(cursor.primary) ||
        !Number.isFinite(cursor.secondary) ||
        typeof cursor.referrer !== "string"))
  )
    throw new Error("referrers_page_membership_reader_mismatch");
  const consumerKey = pageVisitQualificationConsumerKey(
    "referrers-page",
    configuration,
  );
  const readStep = state.enginePlan.steps[2];
  const preparation = createPageVisitQualificationPreparation({
    siteId: state.siteId,
    filters: state.filters,
    queryTime: state.queryTime,
    scopePlan: state.scopePlan,
    consumerKey,
    relation: state.relation,
    dependencyRef: state.enginePlan.steps[0]!.dependencyRef,
    maxBindings: readStep.maxPlans,
    maxSourcesPerRole: readStep.maxSources,
  });
  state.claimed = true;
  return {
    preparation,
    queryTime: readStep.queryTime,
    scopePlan: state.scopePlan,
    assertFresh() {
      independentReferrersPageMembershipState(query);
      if (qualificationRequestOwnDataSnapshot(configuration) !== readerSnapshot)
        throw new Error("referrers_page_membership_reader_mismatch");
    },
  };
}

export type ReferrersTimeMembershipDependency = WholeFilterReaderDependency;
export function referrersTimeMembershipDependencyFromQuery(
  value: unknown,
): ReferrersTimeMembershipDependency | undefined {
  return wholeFilterReaderDependencyFromQuery(value, "referrers-summary");
}
async function prepareReferrersTimeMembershipDependency(input: {
  env: Env;
  query: QueryInput & Record<string, unknown>;
  subject: SemanticSubjectDomain;
  siteIds: readonly string[];
  diagnostics?: D1ReadDiagnostics;
  signal?: AbortSignal;
}): Promise<ReferrersTimeMembershipDependency | undefined> {
  const q = input.query;
  const filters = q.filters;
  const metadata = scopedFilterMetadata(filters);
  if (
    !filters?.root ||
    !metadata ||
    !queryHasNoComparisonState(q) ||
    q.variant !== "summary" ||
    q.context.policy.audience !== "private-dashboard" ||
    input.subject.origin !== "site" ||
    input.siteIds.length !== 1 ||
    input.subject.siteIds.length !== 1 ||
    input.subject.siteIds[0] !== input.siteIds[0] ||
    metadata.siteIds.length !== 1 ||
    metadata.siteIds[0] !== input.siteIds[0] ||
    metadata.plan.preparedMembership !== undefined ||
    metadata.plan.mode !== "entity" ||
    metadata.plan.scope === "event" ||
    metadata.plan.membership.kind !== "entity" ||
    !metadata.time?.filterRange ||
    !q.time ||
    !sameEventFieldsQueryTime(q.time as QueryTime, metadata.time)
  )
    return undefined;
  const time = metadata.time;
  const topN =
    typeof q.topN === "number" && Number.isFinite(q.topN)
      ? q.topN
      : typeof q.limit === "number" && Number.isFinite(q.limit)
        ? q.limit
        : 5;
  if (!Number.isSafeInteger(topN) || topN < 0) return undefined;
  const execution = planAdvancedFilterExecution({
    subject: input.subject,
    filters,
    scope: metadata.plan.scope,
    time,
    reportFusionAvailable: false,
  });
  const enginePlan = planReferrersTimeMembershipDependency({
    execution,
    topN,
    filters,
    queryTime: time,
  });
  if (!enginePlan) return undefined;
  const requestSnapshot = qualificationRequestOwnDataSnapshot(q);
  if (requestSnapshot === undefined) return undefined;
  // The original whole-filter SQL/Core evaluator completes before any report is constructed.
  const [prepareStep, readStep] = enginePlan.steps;
  const matches = await evaluateForSitesCore({
    env: input.env,
    subject: enginePlan.membership.subject,
    siteIds: enginePlan.membership.subject.siteIds,
    filters: prepareStep.filters,
    plan: metadata.plan,
    time: prepareStep.queryTime,
    diagnostics: input.diagnostics,
    signal: input.signal,
  });
  if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return createWholeFilterReaderDependency({
    siteId: input.siteIds[0]!,
    consumer: { kind: "referrers-summary", configuration: { topN } },
    readerQueryTime: readStep.queryTime,
    filters,
    queryTime: time,
    scopePlan: metadata.plan,
    matches,
    requestSnapshot,
  });
}

export interface ComparisonMembershipSideDependency {
  readonly preparation: PageVisitQualificationPreparation;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly readerQueryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly consumerKey: unknown;
}
export interface ComparisonMembershipDependencies {
  readonly enginePlan: ComparisonMembershipDependencyPlan;
  readonly current: ComparisonMembershipSideDependency;
  readonly reference: ComparisonMembershipSideDependency;
  readonly requestSnapshot: string;
}
const comparisonMembershipDependencies = new WeakMap<
  object,
  ComparisonMembershipDependencies
>();
export function comparisonMembershipDependenciesFromQuery(
  q: unknown,
): ComparisonMembershipDependencies | undefined {
  if (typeof q !== "object" || q === null) return undefined;
  const state = comparisonMembershipDependencies.get(q);
  if (
    state &&
    comparisonPageRequestSnapshot(
      q as QueryInput & Record<string, unknown>,
      "dimension",
    ) !== state.requestSnapshot
  )
    throw new Error("comparison_membership_request_changed");
  return state;
}
async function prepareComparisonMembershipDependencies(input: {
  env: Env;
  query: QueryInput & Record<string, unknown>;
  subject: SemanticSubjectDomain;
  siteIds: readonly string[];
  diagnostics?: D1ReadDiagnostics;
  signal?: AbortSignal;
}): Promise<ComparisonMembershipDependencies | undefined> {
  const q = input.query;
  if (
    q.mode !== "overview-tab" ||
    typeof q.tab !== "string" ||
    comparisonPageReaderContract(q.tab)?.route !== "membership-recipe" ||
    q.context.policy.audience !== "private-dashboard" ||
    input.subject.origin !== "site" ||
    input.subject.siteIds.length !== 1 ||
    input.siteIds.length !== 1 ||
    input.subject.siteIds[0] !== input.siteIds[0] ||
    !q.current ||
    !q.reference ||
    !q.comparison
  )
    return undefined;
  const sides = {} as Record<
    "current" | "reference",
    {
      side: FilterSide;
      metadata: NonNullable<ReturnType<typeof scopedFilterMetadata>>;
      execution: ReturnType<typeof planAdvancedFilterExecution>;
      readerQueryTime: QueryTime;
    }
  >;
  for (const name of ["current", "reference"] as const) {
    const side = q[name] as FilterSide,
      metadata = scopedFilterMetadata(side.filters);
    if (
      !side.filters?.root ||
      !side.time ||
      !metadata ||
      metadata.plan.preparedMembership !== undefined ||
      metadata.plan.mode !== "entity" ||
      metadata.plan.scope === "event" ||
      metadata.plan.membership.kind !== "entity" ||
      metadata.siteIds.length !== 1 ||
      metadata.siteIds[0] !== input.siteIds[0]
    )
      return undefined;
    const time = metadata.time ?? side.time;
    sides[name] = {
      side,
      metadata,
      readerQueryTime: canonicalComparisonQueryTime(side.time),
      execution: planAdvancedFilterExecution({
        subject: input.subject,
        filters: side.filters,
        scope: metadata.plan.scope,
        time,
        reportFusionAvailable: false,
      }),
    };
  }
  const comparison = q.comparison as {
    metric: unknown;
    sortBy: unknown;
    direction: unknown;
  };
  const consumer = {
    operation: "dimension",
    siteId: input.siteIds[0],
    mode: q.mode,
    tab: q.tab,
    limit:
      typeof q.limit === "number" && Number.isFinite(q.limit) ? q.limit : 100,
    cursorToken:
      typeof q.cursor === "string" && q.cursor.length > 0 ? q.cursor : null,
    search:
      typeof q.search === "string" && q.search.length > 0
        ? q.search
        : undefined,
    metric: comparison.metric,
    sortBy: comparison.sortBy,
    direction: comparison.direction,
    audience: q.context.policy.audience,
  };
  const enginePlan = planComparisonMembershipDependencies({
    current: {
      execution: sides.current.execution,
      filters: sides.current.side.filters!,
      queryTime: sides.current.metadata.time ?? sides.current.side.time!,
      readerQueryTime: sides.current.readerQueryTime,
    },
    reference: {
      execution: sides.reference.execution,
      filters: sides.reference.side.filters!,
      queryTime: sides.reference.metadata.time ?? sides.reference.side.time!,
      readerQueryTime: sides.reference.readerQueryTime,
    },
    consumer,
  });
  if (!enginePlan) return undefined;
  const requestSnapshot = comparisonPageRequestSnapshot(q, "dimension");
  const prepared = {} as Record<
    "current" | "reference",
    ComparisonMembershipSideDependency
  >;
  for (const step of enginePlan.steps) {
    if (step.kind !== "prepare-membership") continue;
    const original = sides[step.side],
      time = step.queryTime;
    const matches = await evaluateForSitesCore({
      env: input.env,
      subject: step.membership.subject,
      siteIds: step.membership.subject.siteIds,
      filters: step.filters,
      plan: original.metadata.plan,
      time,
      diagnostics: input.diagnostics,
      signal: input.signal,
    });
    if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const consumerKey = Object.freeze({
      operation: "comparison-dimension-side",
      side: step.side,
      enginePlan,
    });
    prepared[step.side] = Object.freeze({
      preparation: createPageVisitQualificationPreparation({
        siteId: input.siteIds[0]!,
        filters: original.side.filters!,
        queryTime: time,
        scopePlan: original.metadata.plan,
        consumerKey,
        relation: createEntityMembershipRelation(input.siteIds[0]!, matches),
        dependencyRef: step.dependencyRef,
        maxBindings: enginePlan.steps[2].maxPlansPerSide,
        maxSourcesPerRole: enginePlan.steps[2].maxSourcesPerSide,
      }),
      filters: original.side.filters!,
      queryTime: time,
      readerQueryTime: step.readerQueryTime,
      scopePlan: original.metadata.plan,
      consumerKey,
    });
  }
  return Object.freeze({ enginePlan, ...prepared, requestSnapshot });
}

function sameRange(
  left: { readonly startMs: number; readonly endExclusiveMs: number },
  right: { readonly startMs: number; readonly endExclusiveMs: number },
): boolean {
  return (
    left.startMs === right.startMs &&
    left.endExclusiveMs === right.endExclusiveMs
  );
}

type ComparisonParentRequestProof = {
  readonly kind: "absent" | "unsafe" | "mismatch" | "matched";
  readonly allowWholeFilter: boolean;
};

const COMPARISON_PARENT_REQUEST_KEYS = [
  "context",
  "filters",
  "scopePreference",
  "scopePlan",
  "time",
  "mode",
  "tab",
  "limit",
  "cursor",
  "sort",
  "direction",
  "search",
  "current",
  "reference",
  "comparison",
] as const;
const COMPARISON_SIDE_REQUEST_KEYS = [
  "filters",
  "time",
  "scopePreference",
] as const;
const COMPARISON_REQUEST_KEYS = [
  "current",
  "reference",
  "metric",
  "sortBy",
  "direction",
] as const;

function comparisonOwnDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  allowedHiddenSymbols: readonly symbol[] = [],
): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) return undefined;
      if (typeof key === "symbol") {
        if (
          allowedHiddenSymbols.includes(key) &&
          !descriptor.enumerable &&
          "value" in descriptor
        )
          continue;
        return undefined;
      }
      if (typeof key !== "string" || !allowedKeys.includes(key))
        return undefined;
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        return undefined;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return undefined;
  }
}

function comparisonOwnPropertiesAreData(value: unknown): boolean {
  if (
    value === undefined ||
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  )
    return true;
  try {
    if (typeof value === "function" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) return false;
      if (
        typeof key === "symbol" &&
        !descriptor.enumerable &&
        "value" in descriptor
      )
        continue;
      if (!descriptor.enumerable || !("value" in descriptor)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

type ComparisonRequestOwnDataSnapshot =
  | { readonly kind: "unsafe" }
  | { readonly kind: "incomplete" }
  | { readonly kind: "matched"; readonly snapshot: string };

type ComparisonRequestComponentSnapshot = ComparisonRequestOwnDataSnapshot;

function comparisonRequestComponentSnapshot(
  value: unknown,
): ComparisonRequestComponentSnapshot {
  if (value === undefined || value === null) return { kind: "incomplete" };
  if (typeof value === "function") return { kind: "unsafe" };
  if (typeof value !== "object") return { kind: "incomplete" };
  if (!comparisonOwnPropertiesAreData(value)) return { kind: "unsafe" };
  try {
    const snapshot = qualificationRequestOwnDataSnapshot(value);
    return snapshot === undefined
      ? { kind: "unsafe" }
      : { kind: "matched", snapshot };
  } catch {
    return { kind: "unsafe" };
  }
}

function comparisonRequestOwnDataSnapshot(
  query: Record<string, unknown>,
  comparison: Record<string, unknown>,
): ComparisonRequestOwnDataSnapshot {
  const [current, reference, comparisonCurrent, comparisonReference, controls] =
    [
      query.current,
      query.reference,
      comparison.current,
      comparison.reference,
      {
        metric: comparison.metric,
        sortBy: comparison.sortBy,
        direction: comparison.direction,
      },
    ].map(comparisonRequestComponentSnapshot);
  const remainder = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(query)) {
    if (key !== "current" && key !== "reference" && key !== "comparison")
      remainder[key] = value;
  }
  const rest = comparisonRequestComponentSnapshot(remainder);
  const components = [
    current,
    reference,
    comparisonCurrent,
    comparisonReference,
    controls,
    rest,
  ];
  if (components.some((component) => component.kind === "unsafe"))
    return { kind: "unsafe" };
  if (components.some((component) => component.kind === "incomplete"))
    return { kind: "incomplete" };
  if (
    current.kind !== "matched" ||
    reference.kind !== "matched" ||
    comparisonCurrent.kind !== "matched" ||
    comparisonReference.kind !== "matched" ||
    controls.kind !== "matched" ||
    rest.kind !== "matched"
  )
    return { kind: "incomplete" };
  return {
    kind: "matched",
    snapshot: JSON.stringify({
      rest: rest.snapshot,
      current: current.snapshot,
      reference: reference.snapshot,
      comparison: {
        current: comparisonCurrent.snapshot,
        reference: comparisonReference.snapshot,
        controls: controls.snapshot,
      },
    }),
  };
}

function comparisonSideSemanticSnapshot(
  value: unknown,
  fallbackScopePreference: unknown,
): string | undefined {
  const side = comparisonOwnDataRecord(value, COMPARISON_SIDE_REQUEST_KEYS);
  if (!side || !Object.hasOwn(side, "filters") || !Object.hasOwn(side, "time"))
    return undefined;
  const snapshot = qualificationRequestOwnDataSnapshot(value);
  if (snapshot === undefined) return undefined;

  try {
    const safeSide = JSON.parse(snapshot) as Record<string, unknown>;
    const time = safeSide.time as Record<string, unknown> | null;
    const filters = safeSide.filters as Record<string, unknown> | null;
    if (
      !time ||
      typeof time !== "object" ||
      Array.isArray(time) ||
      !filters ||
      typeof filters !== "object" ||
      Array.isArray(filters)
    )
      return undefined;
    const range = time.range as Record<string, unknown> | null;
    if (!range || typeof range !== "object" || Array.isArray(range))
      return undefined;

    const symbolMetadata = filters.$internalSymbols as
      Record<string, unknown> | undefined;
    const scopedMetadata = symbolMetadata?.[
      "insightflare.scoped-filter-metadata"
    ] as Record<string, unknown> | undefined;
    const requestedScope =
      scopedMetadata?.requestedScope ??
      safeSide.scopePreference ??
      fallbackScopePreference;
    const { $internalSymbols: _internalSymbols, ...filterDocument } = filters;
    void _internalSymbols;

    // These values came from the own-data snapshot above, not from the input.
    return JSON.stringify({
      time: {
        range: {
          startMs: range.startMs,
          endExclusiveMs: range.endExclusiveMs,
        },
        reportingTimeZone: time.reportingTimeZone,
        capturedAtMs: time.capturedAtMs,
        ...(time.paginationBinding !== undefined
          ? { paginationBinding: time.paginationBinding }
          : {}),
      },
      filters: filterDocument,
      requestedScope,
    });
  } catch {
    return undefined;
  }
}

function comparisonParentRequestProof(
  value: unknown,
  operation: QueryOperation,
  expectedSiteId?: string,
): ComparisonParentRequestProof {
  if (operation !== "dimension")
    return { kind: "absent", allowWholeFilter: false };
  if (typeof value !== "object" || value === null)
    return { kind: "absent", allowWholeFilter: false };

  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return { kind: "unsafe", allowWholeFilter: false };
  }
  let carriesComparisonState = false;
  let hasDefinedComparisonState = false;
  const comparisonComponents: unknown[] = [];
  let comparisonValue: unknown;
  for (const key of ["comparison", "current", "reference"] as const) {
    if (!keys.includes(key)) continue;
    carriesComparisonState = true;
    const descriptor = ownDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
      return { kind: "unsafe", allowWholeFilter: false };
    if (key === "comparison") comparisonValue = descriptor.value;
    else comparisonComponents.push(descriptor.value);
    if (descriptor.value !== undefined) hasDefinedComparisonState = true;
  }
  let nestedComparisonComponents: unknown[] = [];
  if (
    comparisonValue !== undefined &&
    comparisonValue !== null &&
    (typeof comparisonValue === "object" ||
      typeof comparisonValue === "function")
  ) {
    if (!comparisonOwnPropertiesAreData(comparisonValue))
      return { kind: "unsafe", allowWholeFilter: false };
    nestedComparisonComponents = [];
    for (const key of ["current", "reference"] as const) {
      const descriptor = ownDescriptor(comparisonValue, key);
      if (!descriptor) continue;
      if (!descriptor.enumerable || !("value" in descriptor))
        return { kind: "unsafe", allowWholeFilter: false };
      nestedComparisonComponents.push(descriptor.value);
    }
  }
  const componentSnapshots = [
    ...comparisonComponents,
    ...nestedComparisonComponents,
  ].map(comparisonRequestComponentSnapshot);
  if (componentSnapshots.some((component) => component.kind === "unsafe"))
    return { kind: "unsafe", allowWholeFilter: false };
  if (!carriesComparisonState || !hasDefinedComparisonState)
    return { kind: "absent", allowWholeFilter: false };

  const query = comparisonOwnDataRecord(value, COMPARISON_PARENT_REQUEST_KEYS);
  if (!query) {
    if (!comparisonOwnPropertiesAreData(value))
      return { kind: "unsafe", allowWholeFilter: false };
    return { kind: "mismatch", allowWholeFilter: false };
  }
  const comparison = comparisonOwnDataRecord(
    query.comparison,
    COMPARISON_REQUEST_KEYS,
  );
  if (!comparison) {
    if (!comparisonOwnPropertiesAreData(query.comparison))
      return { kind: "unsafe", allowWholeFilter: false };
    return { kind: "mismatch", allowWholeFilter: false };
  }
  const requestSnapshot = comparisonRequestOwnDataSnapshot(query, comparison);
  if (requestSnapshot.kind === "unsafe")
    return { kind: "unsafe", allowWholeFilter: false };
  if (requestSnapshot.kind === "incomplete")
    return { kind: "mismatch", allowWholeFilter: false };

  const parentScopePreference = query.scopePreference;
  const currentTop = comparisonSideSemanticSnapshot(
    query.current,
    parentScopePreference,
  );
  const referenceTop = comparisonSideSemanticSnapshot(
    query.reference,
    parentScopePreference,
  );
  const currentNested = comparisonSideSemanticSnapshot(
    comparison.current,
    parentScopePreference,
  );
  const referenceNested = comparisonSideSemanticSnapshot(
    comparison.reference,
    parentScopePreference,
  );
  if (
    currentTop === undefined ||
    referenceTop === undefined ||
    currentNested === undefined ||
    referenceNested === undefined
  )
    return { kind: "mismatch", allowWholeFilter: false };
  if (currentTop !== currentNested || referenceTop !== referenceNested)
    return { kind: "mismatch", allowWholeFilter: false };

  const context = query.context;
  const subject = ownDataValue(context, "subject");
  const policy = ownDataValue(context, "policy");
  const subjectKind = ownDataValue(subject, "kind");
  const siteId = ownDataValue(subject, "siteId");
  const audience = ownDataValue(policy, "audience");
  const tab = query.tab;
  const family =
    typeof tab === "string"
      ? comparisonReportFamilyForTab(tab)?.family
      : undefined;
  const allowedWholeFilterTab =
    tab === "page.path" ||
    tab === "page.query" ||
    tab === "page.title" ||
    tab === "page.hostname" ||
    tab === "page.entry" ||
    tab === "page.exit";
  const limit = query.limit === undefined ? 100 : query.limit;
  const controlsAreCanonical =
    typeof limit === "number" &&
    Number.isFinite(limit) &&
    Number.isSafeInteger(limit) &&
    limit >= 1 &&
    (query.search === undefined || typeof query.search === "string") &&
    (query.cursor === undefined ||
      query.cursor === null ||
      typeof query.cursor === "string") &&
    typeof comparison.metric === "string" &&
    ["views", "sessions", "visitors"].includes(comparison.metric) &&
    typeof comparison.sortBy === "string" &&
    ["current", "reference", "change"].includes(comparison.sortBy) &&
    (comparison.direction === "asc" || comparison.direction === "desc");
  const allowWholeFilter =
    query.mode === "overview-tab" &&
    subjectKind === "site" &&
    typeof siteId === "string" &&
    (expectedSiteId === undefined || expectedSiteId === siteId) &&
    audience === "private-dashboard" &&
    allowedWholeFilterTab &&
    family !== undefined &&
    controlsAreCanonical;
  return { kind: "matched", allowWholeFilter };
}

function comparisonPageRequestSnapshot(
  query: QueryInput & Record<string, unknown>,
  operation: QueryOperation,
): string {
  const parent = comparisonOwnDataRecord(
    query,
    COMPARISON_PARENT_REQUEST_KEYS,
    [DEFERRED_COMPARISON_PAGE_QUALIFICATION],
  );
  const comparison = comparisonOwnDataRecord(
    parent?.comparison,
    COMPARISON_REQUEST_KEYS,
  );
  const snapshot =
    parent && comparison
      ? comparisonRequestOwnDataSnapshot(parent, comparison)
      : { kind: "incomplete" as const };
  if (snapshot.kind !== "matched")
    throw new Error("comparison_page_request_own_data_invalid");
  return `${operation}:${snapshot.snapshot}`;
}

function canonicalComparisonQueryTime(time: QueryTime): QueryTime {
  return queryWindowToTime({
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  });
}

function comparisonSideCanBeQualified(
  side: FilterSide | undefined,
  siteId: string,
  filterMode: QualifiedSourceFilterMode,
): boolean {
  const filters = side?.filters;
  if (!filters?.root || !filterDocumentUsesAdvancedExpressions(filters))
    return false;
  const metadata = scopedFilterMetadata(filters);
  if (
    !metadata ||
    metadata.plan.preparedMembership !== undefined ||
    (metadata.plan.scope !== "session" && metadata.plan.scope !== "visitor") ||
    metadata.siteIds.length !== 1 ||
    metadata.siteIds[0] !== siteId ||
    !side?.time ||
    !sameEventFieldsQueryTime(metadata.time, side.time) ||
    !sameEventFieldsQueryTime(
      metadata.time,
      canonicalComparisonQueryTime(side.time),
    ) ||
    metadata.time.fullHistory === true ||
    metadata.time.filterRange !== undefined ||
    metadata.time.filterRangeEmpty === true ||
    !sameRange(
      metadata.time.readRange ?? metadata.time.range,
      metadata.time.range,
    ) ||
    resolveQualifiedSourceFilters(filters, filterMode).kind !== "supported"
  )
    return false;
  const support = classifyAdvancedCountFilter(filters, metadata.plan.scope);
  return (
    support.kind === "supported" &&
    advancedCountPayloadPaths(support.document.root!).length === 0
  );
}

function comparisonSideQualificationKind(
  side: FilterSide | undefined,
  siteId: string,
  allowWholeFilter: boolean,
): "native" | "qualified" | "unsupported" {
  if (!side?.time) return "unsupported";
  const filters = side.filters ?? EMPTY_FILTER_DOCUMENT;
  if (!filterDocumentUsesAdvancedExpressions(filters)) return "native";
  return comparisonSideCanBeQualified(
    { ...side, filters },
    siteId,
    allowWholeFilter ? "allow-whole-filter" : "split-only",
  )
    ? "qualified"
    : "unsupported";
}

async function prepareDeferredComparisonPageQualification(input: {
  readonly env: Env;
  readonly query: QueryInput & Record<string, unknown>;
  readonly parentWholeFilterProof: boolean;
  readonly operation: QueryOperation;
  readonly subject: SemanticSubjectDomain;
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
  readonly expectedSiteId?: string;
}): Promise<DeferredComparisonPageQualification | null> {
  const { query } = input;
  if (
    input.operation !== "dimension" ||
    query.mode !== "overview-tab" ||
    query.context.subject.kind !== "site" ||
    query.context.policy.audience === "public-share"
  )
    return null;
  const tab = typeof query.tab === "string" ? query.tab : "";
  const tabConfig = comparisonReportFamilyForTab(tab);
  const comparison = query.comparison as
    | {
        readonly current?: unknown;
        readonly reference?: unknown;
        readonly metric?: unknown;
        readonly sortBy?: unknown;
        readonly direction?: unknown;
      }
    | undefined;
  const current = query.current as FilterSide | undefined;
  const reference = query.reference as FilterSide | undefined;
  if (
    !tabConfig ||
    !comparison ||
    !current?.time ||
    !reference?.time ||
    (input.expectedSiteId !== undefined &&
      input.expectedSiteId !== query.context.subject.siteId) ||
    !["views", "sessions", "visitors"].includes(String(comparison.metric)) ||
    !["current", "reference", "change"].includes(String(comparison.sortBy)) ||
    (comparison.direction !== "asc" && comparison.direction !== "desc")
  )
    return null;

  const currentKind = comparisonSideQualificationKind(
    current,
    query.context.subject.siteId,
    input.parentWholeFilterProof,
  );
  const referenceKind = comparisonSideQualificationKind(
    reference,
    query.context.subject.siteId,
    input.parentWholeFilterProof,
  );
  if (
    currentKind === "unsupported" ||
    referenceKind === "unsupported" ||
    (currentKind !== "qualified" && referenceKind !== "qualified")
  )
    return null;

  const rawLimit = query.limit;
  const limit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit) ? rawLimit : 100;
  if (!Number.isSafeInteger(limit) || limit < 1) return null;
  const search =
    typeof query.search === "string" && query.search.length > 0
      ? query.search
      : undefined;
  const cursorToken =
    typeof query.cursor === "string" && query.cursor.length > 0
      ? query.cursor
      : null;
  const sideQuery = (side: FilterSide) =>
    ({
      ...query,
      mode: "overview-tab",
      tab,
      filters: side.filters,
      time: side.time,
      scopePlan: undefined,
      comparison: undefined,
      current: undefined,
      reference: undefined,
    }) as QueryInput & Record<string, unknown>;
  const prepareSide = async (
    side: FilterSide,
    kind: "native" | "qualified",
  ): Promise<DeferredComparisonPageSide | null> => {
    const filters = side.filters ?? EMPTY_FILTER_DOCUMENT;
    if (kind === "native")
      return Object.freeze({ kind, filters, time: side.time! });
    const sessionBoundary = tabConfig.family.kind === "session-boundary";
    const qualification = await prepareDeferredEventQualification({
      env: input.env,
      query: sideQuery(side),
      operation: sessionBoundary
        ? "session-boundary-overview-page"
        : "page-dimension",
      subject: input.subject,
      diagnostics: input.diagnostics,
      signal: input.signal,
      expectedSiteId: input.expectedSiteId,
      ...(input.parentWholeFilterProof && sessionBoundary
        ? { allowPrivateSessionBoundaryWholeFilterOptIn: true }
        : {}),
      ...(input.parentWholeFilterProof && !sessionBoundary
        ? { allowPageFieldWholeFilterOptIn: true }
        : {}),
    });
    const reportRequest = sessionBoundary
      ? qualification?.sessionBoundaryOverviewPageRequest
      : qualification?.overviewPageTableRequest;
    return qualification && reportRequest
      ? Object.freeze({
          kind,
          qualification: qualification as DeferredEventQualification,
        })
      : null;
  };
  const currentDeferred = await prepareSide(current!, currentKind);
  if (!currentDeferred) return null;
  const referenceDeferred = await prepareSide(reference!, referenceKind);
  if (!referenceDeferred) return null;
  const deferred: DeferredComparisonPageQualification = Object.freeze({
    operation: input.operation,
    current: currentDeferred,
    reference: referenceDeferred,
    tab,
    expression: tabConfig.cursorExpression,
    reportFamily: tabConfig.family,
    metric: comparison.metric as "views" | "sessions" | "visitors",
    sortBy: comparison.sortBy as "current" | "reference" | "change",
    direction: comparison.direction,
    limit,
    ...(search !== undefined ? { search } : {}),
    cursorToken,
    audience: query.context.policy.audience,
    requestSnapshot: comparisonPageRequestSnapshot(query, input.operation),
  });
  deferredComparisonPageQualifications.add(deferred);
  return deferred;
}

function channelListHasUnsupportedBoolean(
  expression: FilterExpression | null | undefined,
): boolean {
  if (!expression) return false;
  if (expression.kind === "not" || expression.kind === "or") return true;
  return (
    expression.kind === "and" &&
    expression.children.some(channelListHasUnsupportedBoolean)
  );
}

function isCalendarGranularity(value: unknown): value is CalendarGranularity {
  return (
    value === "minute" ||
    value === "hour" ||
    value === "day" ||
    value === "week" ||
    value === "month"
  );
}

function overviewTrendConfigurationForQuery(
  operation: QueryOperation,
  query: QueryInput & Record<string, unknown>,
): OverviewTrendQualificationConfiguration | undefined {
  if (operation === "overview") {
    const previous = readOwnDataProperty(query, "previousTime");
    if (!previous.valid) return undefined;
    if (previous.present && previous.value !== undefined) {
      const currentValue = readOwnDataProperty(query, "time");
      const currentTime = currentValue.valid
        ? snapshotBoundedOverviewTime(currentValue.value)
        : undefined;
      const previousTime = snapshotBoundedOverviewTime(previous.value);
      const detail = readOwnDataProperty(query, "detailInterval");
      if (
        !currentTime ||
        !previousTime ||
        !detail.valid ||
        previousTime.range.endExclusiveMs > currentTime.range.startMs
      )
        return undefined;
      if (detail.present && detail.value !== undefined) {
        if (!isCalendarGranularity(detail.value)) return undefined;
        return Object.freeze({
          kind: "overview-with-previous-and-detail",
          previousTime,
          interval: detail.value,
        });
      }
      return Object.freeze({ kind: "overview-with-previous", previousTime });
    }
    if (query.detailInterval === undefined)
      return Object.freeze({ kind: "aggregate" });
    if (!isCalendarGranularity(query.detailInterval)) return undefined;
    return Object.freeze({
      kind: "overview-with-detail",
      interval: query.detailInterval,
    });
  }
  if (operation === "trend" && isCalendarGranularity(query.interval))
    return Object.freeze({ kind: "trend", interval: query.interval });
  return undefined;
}

function scopePlanRequestSnapshot(plan: ScopedFilterPlan | undefined) {
  if (!plan) return null;
  return {
    scope: plan.scope,
    mode: plan.mode,
    membership: plan.membership,
    expansion: plan.expansion,
    requiredSources: [...plan.requiredSources].sort(),
    requiresRawSource: plan.requiresRawSource,
    ...(plan.preparedMembership
      ? { preparedMembership: plan.preparedMembership.id }
      : {}),
  };
}

function safeScopePlanRequestSnapshot(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const scope = readOwnDataProperty(value, "scope");
  const mode = readOwnDataProperty(value, "mode");
  const membership = readOwnDataProperty(value, "membership");
  const expansion = readOwnDataProperty(value, "expansion");
  const requiredSources = readOwnDataProperty(value, "requiredSources");
  const requiresRawSource = readOwnDataProperty(value, "requiresRawSource");
  const preparedMembership = readOwnDataProperty(value, "preparedMembership");
  if (
    !scope.valid ||
    !mode.valid ||
    !membership.valid ||
    !expansion.valid ||
    !requiredSources.valid ||
    !requiresRawSource.valid ||
    !preparedMembership.valid ||
    !(requiredSources.value instanceof Set)
  )
    return undefined;
  const required: unknown[] = [];
  try {
    Set.prototype.forEach.call(requiredSources.value, (entry: unknown) =>
      required.push(entry),
    );
  } catch {
    return undefined;
  }
  if (required.some((entry) => typeof entry !== "string")) return undefined;
  required.sort((left, right) => String(left).localeCompare(String(right)));
  // Only the handle's label enters a request snapshot; a foreign object that
  // merely looks like a handle makes the whole snapshot invalid.
  if (
    preparedMembership.present &&
    !isPreparedMembership(preparedMembership.value)
  )
    return undefined;
  const preparedSnapshot = preparedMembership.present
    ? (preparedMembership.value as PreparedMembership).id
    : undefined;
  const snapshot = snapshotOwnDataValue({
    scope: scope.value,
    mode: mode.value,
    membership: membership.value,
    expansion: expansion.value,
    requiredSources: required.sort(),
    requiresRawSource: requiresRawSource.value,
    ...(preparedMembership.present
      ? { preparedMembership: preparedSnapshot }
      : {}),
  });
  return isInvalidOverviewSnapshot(snapshot) ? undefined : snapshot;
}

function safeSetRequestSnapshot(
  value: unknown,
): readonly unknown[] | undefined {
  if (
    !(value instanceof Set) ||
    Object.getPrototypeOf(value) !== Set.prototype ||
    Reflect.ownKeys(value).length !== 0
  )
    return undefined;
  const entries: unknown[] = [];
  try {
    Set.prototype.forEach.call(value, (entry: unknown) => entries.push(entry));
  } catch {
    return undefined;
  }
  if (entries.some((entry) => typeof entry !== "string")) return undefined;
  entries.sort((left, right) => String(left).localeCompare(String(right)));
  const snapshot = snapshotOwnDataValue(entries);
  return isInvalidOverviewSnapshot(snapshot)
    ? undefined
    : (snapshot as unknown[]);
}

function safeOverviewContextRequestSnapshot(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const subject = readOwnDataProperty(value, "subject");
  const policy = readOwnDataProperty(value, "policy");
  if (
    !subject.valid ||
    !policy.valid ||
    typeof subject.value !== "object" ||
    subject.value === null ||
    typeof policy.value !== "object" ||
    policy.value === null
  )
    return undefined;
  const subjectSnapshot = snapshotOwnDataValue(subject.value);
  if (isInvalidOverviewSnapshot(subjectSnapshot)) return undefined;
  const policyFields = [
    "revision",
    "audience",
    "allowedOperations",
    "allowedDimensions",
    "allowedFilters",
    "allowedDetails",
    "limits",
    "cursorPagination",
  ] as const;
  const safePolicy: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const field of policyFields) {
    const property = readOwnDataProperty(policy.value, field);
    if (!property.valid) return undefined;
    if (
      field === "allowedOperations" ||
      field === "allowedDimensions" ||
      field === "allowedFilters" ||
      field === "allowedDetails"
    ) {
      const setSnapshot = safeSetRequestSnapshot(property.value);
      if (!setSnapshot) return undefined;
      safePolicy[field] = setSnapshot;
      continue;
    }
    const propertySnapshot = snapshotOwnDataValue(property.value ?? null);
    if (isInvalidOverviewSnapshot(propertySnapshot)) return undefined;
    safePolicy[field] = propertySnapshot;
  }
  const snapshot = snapshotOwnDataValue({
    subject: subjectSnapshot,
    policy: safePolicy,
  });
  return isInvalidOverviewSnapshot(snapshot) ? undefined : snapshot;
}

function safeOverviewFilterRequestSnapshot(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const version = readOwnDataProperty(value, "version");
  const root = readOwnDataProperty(value, "root");
  if (!version.valid || !root.valid) return undefined;
  const rootSnapshot = snapshotOwnDataValue(root.value ?? null);
  if (isInvalidOverviewSnapshot(rootSnapshot)) return undefined;

  let metadataValue: unknown;
  try {
    const metadataKeys = Reflect.ownKeys(value).filter(
      (key) =>
        typeof key === "symbol" &&
        key.description === "insightflare.scoped-filter-metadata",
    );
    if (metadataKeys.length > 1) return undefined;
    if (metadataKeys.length === 1) {
      const descriptor = Object.getOwnPropertyDescriptor(
        value,
        metadataKeys[0]!,
      );
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable)
        return undefined;
      const metadata = descriptor.value;
      if (typeof metadata !== "object" || metadata === null) return undefined;
      const requestedScope = readOwnDataProperty(metadata, "requestedScope");
      const resolvedScope = readOwnDataProperty(metadata, "resolvedScope");
      const plan = readOwnDataProperty(metadata, "plan");
      const time = readOwnDataProperty(metadata, "time");
      const siteIds = readOwnDataProperty(metadata, "siteIds");
      const planSnapshot = plan.valid
        ? safeScopePlanRequestSnapshot(plan.value)
        : undefined;
      const timeSnapshot = time.valid
        ? snapshotBoundedOverviewTime(time.value)
        : undefined;
      const siteIdsSnapshot = siteIds.valid
        ? snapshotOwnDataValue(siteIds.value)
        : undefined;
      if (
        !requestedScope.valid ||
        !resolvedScope.valid ||
        !plan.valid ||
        !time.valid ||
        !siteIds.valid ||
        planSnapshot === undefined ||
        !timeSnapshot ||
        isInvalidOverviewSnapshot(siteIdsSnapshot)
      )
        return undefined;
      metadataValue = {
        requestedScope: requestedScope.value,
        resolvedScope: resolvedScope.value,
        plan: planSnapshot,
        time: timeSnapshot,
        siteIds: siteIdsSnapshot,
      };
    }
  } catch {
    return undefined;
  }
  const enumerable: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  try {
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        return undefined;
      const entry = snapshotOwnDataValue(descriptor.value);
      if (isInvalidOverviewSnapshot(entry)) return undefined;
      enumerable[key] = entry;
    }
  } catch {
    return undefined;
  }
  enumerable.version = version.value;
  enumerable.root = rootSnapshot;
  enumerable.metadata = metadataValue ?? null;
  const result = snapshotOwnDataValue(enumerable);
  return isInvalidOverviewSnapshot(result) ? undefined : result;
}

function overviewTrendRequestSnapshot(
  query: QueryInput & Record<string, unknown>,
  operation: "overview" | "trend",
  configuration: OverviewTrendQualificationConfiguration,
): string {
  if (
    configuration.kind === "overview-with-previous" ||
    configuration.kind === "overview-with-previous-and-detail"
  ) {
    const context = readOwnDataProperty(query, "context");
    const time = readOwnDataProperty(query, "time");
    const filters = readOwnDataProperty(query, "filters");
    const scopePlan = readOwnDataProperty(query, "scopePlan");
    const interval = readOwnDataProperty(query, "detailInterval");
    const safeContext = context.valid
      ? safeOverviewContextRequestSnapshot(context.value)
      : undefined;
    const safeFilters = filters.valid
      ? safeOverviewFilterRequestSnapshot(filters.value)
      : undefined;
    const safeScopePlan = scopePlan.valid
      ? safeScopePlanRequestSnapshot(scopePlan.value)
      : undefined;
    const safeInterval = interval.valid
      ? snapshotOwnDataValue(interval.value ?? null)
      : undefined;
    const safeConfiguration = snapshotOwnDataValue(configuration);
    const safeTime = time.valid
      ? snapshotBoundedOverviewTime(time.value)
      : undefined;
    if (
      !context.valid ||
      !time.valid ||
      !filters.valid ||
      !scopePlan.valid ||
      !interval.valid ||
      !safeTime ||
      isInvalidOverviewSnapshot(safeContext) ||
      isInvalidOverviewSnapshot(safeFilters) ||
      isInvalidOverviewSnapshot(safeScopePlan) ||
      isInvalidOverviewSnapshot(safeInterval) ||
      isInvalidOverviewSnapshot(safeConfiguration)
    )
      return "";
    const serialized = serializeOwnDataSnapshot({
      operation,
      configuration: safeConfiguration,
      context: safeContext,
      time: safeTime,
      filters: safeFilters,
      scopePlan: safeScopePlan,
      previousTimePresent: true,
      detailInterval: safeInterval,
      detailIntervalPresent: interval.present,
    });
    return serialized ?? "";
  }
  const metadata = query.filters
    ? scopedFilterMetadata(query.filters as FilterDocument)
    : undefined;
  return JSON.stringify({
    operation,
    configuration,
    subject: query.context.subject,
    policy: query.context.policy,
    time: query.time ?? null,
    filters: query.filters
      ? {
          version: (query.filters as FilterDocument).version,
          root: (query.filters as FilterDocument).root,
          metadata: metadata
            ? {
                requestedScope: metadata.requestedScope,
                resolvedScope: metadata.resolvedScope,
                plan: scopePlanRequestSnapshot(metadata.plan),
                time: metadata.time,
                siteIds: [...metadata.siteIds],
              }
            : null,
        }
      : null,
    scopePlan: scopePlanRequestSnapshot(
      query.scopePlan as ScopedFilterPlan | undefined,
    ),
    previousTime: {
      present: Object.prototype.hasOwnProperty.call(query, "previousTime"),
      value: query.previousTime ?? null,
    },
    detailInterval: {
      present: Object.prototype.hasOwnProperty.call(query, "detailInterval"),
      value: query.detailInterval ?? null,
    },
    interval: {
      present: Object.prototype.hasOwnProperty.call(query, "interval"),
      value: query.interval ?? null,
    },
  });
}

function sameOverviewTrendConfiguration(
  left: OverviewTrendQualificationConfiguration,
  right: OverviewTrendQualificationConfiguration,
): boolean {
  const leftSnapshot = snapshotOwnDataValue(left);
  const rightSnapshot = snapshotOwnDataValue(right);
  if (
    isInvalidOverviewSnapshot(leftSnapshot) ||
    isInvalidOverviewSnapshot(rightSnapshot)
  )
    return false;
  const leftSerialized = serializeOwnDataSnapshot(leftSnapshot);
  return (
    leftSerialized !== undefined &&
    leftSerialized === serializeOwnDataSnapshot(rightSnapshot)
  );
}

const SHARE_TREND_QUERY_FIELDS = new Set([
  "context",
  "filters",
  "scopePreference",
  "scopePlan",
  "time",
  "interval",
  "variant",
  "dimension",
  "limit",
]);

const shareTrendQualificationStamps = new WeakMap<
  object,
  {
    readonly qualification:
      | DeferredEventQualification
      | DeferredEventCandidatePageProjectionFor<"share-trend">;
    readonly countInput: AdvancedCountQualificationPlanInput;
    readonly analysis: object;
  }
>();

function stableShareTrendValue(
  value: unknown,
  ancestors = new WeakSet<object>(),
): unknown | undefined {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object") return undefined;
  if (ancestors.has(value)) return undefined;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (const item of value) {
        const stable = stableShareTrendValue(item, ancestors);
        if (stable === undefined) return undefined;
        output.push(stable);
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return undefined;
    const output: Record<string, unknown> = {};
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        return undefined;
      const stable = stableShareTrendValue(descriptor.value, ancestors);
      if (stable === undefined) return undefined;
      output[key] = stable;
    }
    return output;
  } catch {
    return undefined;
  } finally {
    ancestors.delete(value);
  }
}

function sameShareTrendQueryTime(left: QueryTime, right: QueryTime): boolean {
  const snapshot = (time: QueryTime) => ({
    range: time.range,
    readRange: time.readRange ?? time.range,
    filterRange: time.filterRange ?? null,
    filterRangeEmpty: time.filterRangeEmpty ?? false,
    fullHistory: time.fullHistory ?? false,
    reportingTimeZone: time.reportingTimeZone,
    capturedAtMs: time.capturedAtMs,
  });
  const stableLeft = stableShareTrendValue(snapshot(left));
  const stableRight = stableShareTrendValue(snapshot(right));
  return (
    stableLeft !== undefined &&
    stableRight !== undefined &&
    JSON.stringify(stableLeft) === JSON.stringify(stableRight)
  );
}

function sameShareTrendScopePlan(
  left: ScopedFilterPlan,
  right: ScopedFilterPlan,
): boolean {
  const stableLeft = stableShareTrendValue(scopePlanRequestSnapshot(left));
  const stableRight = stableShareTrendValue(scopePlanRequestSnapshot(right));
  return (
    stableLeft !== undefined &&
    stableRight !== undefined &&
    JSON.stringify(stableLeft) === JSON.stringify(stableRight)
  );
}

function shareTrendRequestSnapshot(
  query: QueryInput & Record<string, unknown>,
  qualification:
    | DeferredEventQualification
    | DeferredEventCandidatePageProjectionFor<"share-trend">,
  configuration: TechnologyShareTrendQualificationConfiguration,
  expectedBrand?: DeferredShareTrendQualification,
): string | undefined {
  try {
    const ownKeys = Reflect.ownKeys(query);
    for (const key of ownKeys) {
      if (typeof key === "symbol") {
        if (key !== DEFERRED_SHARE_TREND_QUALIFICATION) return undefined;
        const brand = Object.getOwnPropertyDescriptor(query, key);
        if (
          !brand ||
          brand.enumerable ||
          !("value" in brand) ||
          brand.value !== expectedBrand
        )
          return undefined;
        continue;
      }
      if (!SHARE_TREND_QUERY_FIELDS.has(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(query, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        return undefined;
    }
    const queryConfiguration = technologyShareTrendQualificationConfiguration({
      variant: query.variant,
      dimension: query.dimension,
      interval: query.interval,
      limit: query.limit,
    });
    if (
      !queryConfiguration ||
      JSON.stringify(queryConfiguration) !== JSON.stringify(configuration) ||
      query.context?.subject?.kind !== "site" ||
      query.context.policy.audience !== "private-dashboard" ||
      query.context.subject.siteId !== qualification.siteId ||
      query.filters !== qualification.filters ||
      scopedFilterMetadata(query.filters as FilterDocument) !==
        qualification.metadata ||
      !sameShareTrendQueryTime(
        query.time as QueryTime,
        qualification.requestTime!,
      )
    )
      return undefined;
    const metadata = scopedFilterMetadata(query.filters as FilterDocument);
    const count = qualification.countInput;
    const snapshot = {
      operation: "share-trend",
      configuration,
      siteId: qualification.siteId,
      audience: query.context.policy.audience,
      subject: query.context.subject,
      time: query.time,
      scopePreference: query.scopePreference ?? null,
      filters: {
        version: query.filters.version,
        root: query.filters.root,
        metadata: metadata
          ? {
              requestedScope: metadata.requestedScope,
              resolvedScope: metadata.resolvedScope,
              plan: scopePlanRequestSnapshot(metadata.plan),
              time: metadata.time,
              siteIds: [...metadata.siteIds],
            }
          : null,
      },
      scopePlan: scopePlanRequestSnapshot(
        query.scopePlan as ScopedFilterPlan | undefined,
      ),
      qualification: {
        operation: qualification.operation,
        technologyFilterMode:
          qualification.technologyFilterMode ?? "split-only",
        siteId: qualification.siteId,
        time: qualification.time,
        requestTime: qualification.requestTime,
        requestScopePlan: scopePlanRequestSnapshot(
          qualification.requestScopePlan,
        ),
        metadata: {
          requestedScope: qualification.metadata.requestedScope,
          resolvedScope: qualification.metadata.resolvedScope,
          plan: scopePlanRequestSnapshot(qualification.metadata.plan),
          time: qualification.metadata.time,
          siteIds: [...qualification.metadata.siteIds],
        },
        countInput: {
          subject: count.subject,
          candidateRange: count.candidateRange,
          readRange: count.readRange,
          filterRange: count.filterRange ?? null,
          expressionRange: count.expressionRange,
          expressionUsesExplicitRange: count.expressionUsesExplicitRange,
          lowerBounds: count.lowerBounds,
          scope: count.scope,
          reportingTimeZone: count.reportingTimeZone,
          capturedAtMs: count.capturedAtMs,
          analysisDocument: count.analysis.document,
          numericCompatibilityFieldIds:
            count.numericCompatibilityFieldIds ?? null,
          numericCompatibilityRequirements:
            count.numericCompatibilityRequirements ?? null,
        },
      },
    };
    const stable = stableShareTrendValue(snapshot);
    return stable === undefined ? undefined : JSON.stringify(stable);
  } catch {
    return undefined;
  }
}

function hasSafeShareTrendQueryShape(
  query: QueryInput & Record<string, unknown>,
  expectedBrand?: DeferredShareTrendQualification,
): boolean {
  try {
    for (const key of Reflect.ownKeys(query)) {
      if (typeof key === "symbol") {
        if (key !== DEFERRED_SHARE_TREND_QUALIFICATION) return false;
        const brand = Object.getOwnPropertyDescriptor(query, key);
        if (
          !brand ||
          brand.enumerable ||
          !("value" in brand) ||
          brand.value !== expectedBrand
        )
          return false;
        continue;
      }
      if (!SHARE_TREND_QUERY_FIELDS.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(query, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isDeferredShareTrendQualification(
  value: unknown,
): value is DeferredShareTrendQualification {
  return (
    typeof value === "object" &&
    value !== null &&
    deferredShareTrendQualifications.has(value) &&
    shareTrendQualificationStamps.has(value)
  );
}

function normalizedShareTrendConfigurationFromQuery(
  query: QueryInput & Record<string, unknown>,
): TechnologyShareTrendQualificationConfiguration | undefined {
  return technologyShareTrendQualificationConfiguration({
    variant: query.variant,
    dimension: query.dimension,
    interval: query.interval,
    limit: query.limit,
  });
}

/** Reads and revalidates the request-local qualification brand. */
export function deferredShareTrendQualificationFromQuery(
  input: unknown,
): DeferredShareTrendQualification | undefined {
  if (!input || typeof input !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(
    input,
    DEFERRED_SHARE_TREND_QUALIFICATION,
  );
  if (!descriptor) return undefined;
  if (descriptor.enumerable || !("value" in descriptor))
    throw new Error("share_trend_qualification_request_untrusted");
  const deferred = descriptor.value;
  if (!isDeferredShareTrendQualification(deferred))
    throw new Error("share_trend_qualification_request_untrusted");
  const query = input as QueryInput & Record<string, unknown>;
  const stamp = shareTrendQualificationStamps.get(deferred)!;
  const configuration = normalizedShareTrendConfigurationFromQuery(query);
  const requestSnapshot = shareTrendRequestSnapshot(
    query,
    deferred.qualification,
    deferred.configuration,
    deferred,
  );
  if (
    deferred.operation !== "share-trend" ||
    !Object.isFrozen(deferred) ||
    !Object.isFrozen(deferred.configuration) ||
    !configuration ||
    JSON.stringify(configuration) !== JSON.stringify(deferred.configuration) ||
    (!isDeferredEventQualification(deferred.qualification) &&
      !isDeferredEventCandidatePageProjection(deferred.qualification)) ||
    deferred.qualification.operation !== "share-trend" ||
    stamp.qualification !== deferred.qualification ||
    stamp.countInput !== deferred.qualification.countInput ||
    stamp.analysis !== deferred.qualification.countInput.analysis ||
    requestSnapshot === undefined ||
    requestSnapshot !== deferred.requestSnapshot
  )
    throw new Error("share_trend_qualification_request_changed");
  return deferred;
}

/** Checks the outer brand at a direct compiler boundary. */
export function isDeferredShareTrendQualificationRequest(
  value: unknown,
): value is DeferredShareTrendQualification {
  return isDeferredShareTrendQualification(value);
}

const CROSS_DIMENSION_QUERY_FIELDS = new Set([
  "context",
  "filters",
  "scopePreference",
  "scopePlan",
  "time",
  "variant",
  "primaryDimension",
  "secondaryDimension",
  "primaryLimit",
  "secondaryLimit",
]);

const BROWSER_CROSS_DIMENSION_QUERY_FIELDS = new Set([
  "context",
  "filters",
  "scopePreference",
  "scopePlan",
  "time",
  "variant",
  "browserLimit",
  "osLimit",
  "deviceTypeLimit",
]);

const crossDimensionQualificationStamps = new WeakMap<
  object,
  {
    readonly qualification:
      | DeferredEventQualification
      | DeferredEventCandidatePageProjectionFor<"cross-dimension">;
    readonly countInput: AdvancedCountQualificationPlanInput;
    readonly analysis: object;
  }
>();

function hasSafeCrossDimensionQueryShape(
  query: QueryInput & Record<string, unknown>,
  expectedBrand?: DeferredCrossDimensionQualification,
): boolean {
  try {
    const prototype = Object.getPrototypeOf(query);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const variant = Object.getOwnPropertyDescriptor(query, "variant");
    if (
      variant &&
      (!variant.enumerable ||
        !("value" in variant) ||
        (variant.value !== "browser" && variant.value !== "generic"))
    )
      return false;
    const browser = variant?.value === "browser";
    const requiredFields = browser
      ? ["context", "filters", "time", "variant"]
      : [
          "context",
          "filters",
          "time",
          "primaryDimension",
          "secondaryDimension",
          "primaryLimit",
          "secondaryLimit",
        ];
    const allowedFields = browser
      ? BROWSER_CROSS_DIMENSION_QUERY_FIELDS
      : CROSS_DIMENSION_QUERY_FIELDS;
    for (const key of requiredFields) {
      const descriptor = Object.getOwnPropertyDescriptor(query, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        return false;
    }
    for (const key of Reflect.ownKeys(query)) {
      if (typeof key === "symbol") {
        if (key !== DEFERRED_CROSS_DIMENSION_QUALIFICATION) return false;
        const brand = Object.getOwnPropertyDescriptor(query, key);
        if (
          !brand ||
          brand.enumerable ||
          !("value" in brand) ||
          brand.value !== expectedBrand
        )
          return false;
        continue;
      }
      if (!allowedFields.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(query, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

function technologyCrossDimensionQualificationConfigurationFromQuery(
  query: QueryInput & Record<string, unknown>,
  expectedBrand?: DeferredCrossDimensionQualification,
): TechnologyCrossQualificationConfiguration | undefined {
  try {
    if (
      !hasSafeCrossDimensionQueryShape(query, expectedBrand) ||
      !query.filters?.root ||
      !filterDocumentUsesAdvancedExpressions(query.filters)
    )
      return undefined;
    if (query.variant === "browser") {
      const browserLimit = query.browserLimit;
      const osLimit = query.osLimit;
      const deviceTypeLimit = query.deviceTypeLimit;
      const safeBrowserLimit = (value: unknown) =>
        value == null ||
        (typeof value === "number" &&
          Number.isFinite(value) &&
          Number.isInteger(value));
      if (
        !safeBrowserLimit(browserLimit) ||
        !safeBrowserLimit(osLimit) ||
        !safeBrowserLimit(deviceTypeLimit)
      )
        return undefined;
      return Object.freeze({
        family: "browser",
        variant: "browser",
        browserLimitPresent: Object.hasOwn(query, "browserLimit"),
        browserLimit: browserLimit as number | null | undefined,
        osLimitPresent: Object.hasOwn(query, "osLimit"),
        osLimit: osLimit as number | null | undefined,
        deviceTypeLimitPresent: Object.hasOwn(query, "deviceTypeLimit"),
        deviceTypeLimit: deviceTypeLimit as number | null | undefined,
      });
    }
    if (
      (Object.hasOwn(query, "variant") && query.variant !== "generic") ||
      typeof query.primaryDimension !== "string" ||
      typeof query.secondaryDimension !== "string" ||
      query.primaryDimension === query.secondaryDimension ||
      typeof query.primaryLimit !== "number" ||
      !Number.isFinite(query.primaryLimit) ||
      !Number.isInteger(query.primaryLimit) ||
      typeof query.secondaryLimit !== "number" ||
      !Number.isFinite(query.secondaryLimit) ||
      !Number.isInteger(query.secondaryLimit)
    )
      return undefined;
    const primary = resolveCrossBreakdownPageDimension(query.primaryDimension);
    const secondary = resolveCrossBreakdownPageDimension(
      query.secondaryDimension,
    );
    if (!primary || !secondary) return undefined;
    return Object.freeze({
      primaryDimension: query.primaryDimension,
      secondaryDimension: query.secondaryDimension,
      primarySelection: Object.freeze({ ...primary.selection }),
      secondarySelection: Object.freeze({ ...secondary.selection }),
      primaryFallbackKeyBase: primary.fallbackKeyBase,
      secondaryFallbackKeyBase: secondary.fallbackKeyBase,
      primaryLimit: query.primaryLimit,
      secondaryLimit: query.secondaryLimit,
    });
  } catch {
    return undefined;
  }
}

function sameCrossDimensionConfiguration(
  left: unknown,
  right: TechnologyCrossQualificationConfiguration,
): boolean {
  if (
    !left ||
    typeof left !== "object" ||
    Array.isArray(left) ||
    (Object.getPrototypeOf(left) !== Object.prototype &&
      Object.getPrototypeOf(left) !== null)
  )
    return false;
  try {
    return sameTechnologyCrossQualificationConfiguration(left, right);
  } catch {
    return false;
  }
}

function crossDimensionRequestSnapshot(
  query: QueryInput & Record<string, unknown>,
  qualification:
    | DeferredEventQualification
    | DeferredEventCandidatePageProjectionFor<"cross-dimension">,
  configuration: TechnologyCrossQualificationConfiguration,
  expectedBrand?: DeferredCrossDimensionQualification,
): string | undefined {
  try {
    if (!hasSafeCrossDimensionQueryShape(query, expectedBrand))
      return undefined;
    const filterDocument = query.filters as FilterDocument;
    if (
      stableShareTrendValue({
        version: filterDocument.version,
        root: filterDocument.root,
      }) === undefined
    )
      return undefined;
    const queryConfiguration =
      technologyCrossDimensionQualificationConfigurationFromQuery(
        query,
        expectedBrand,
      );
    if (
      !queryConfiguration ||
      !sameCrossDimensionConfiguration(queryConfiguration, configuration) ||
      query.context?.subject?.kind !== "site" ||
      query.context.policy.audience !== "private-dashboard" ||
      query.context.subject.siteId !== qualification.siteId ||
      query.filters !== qualification.filters ||
      scopedFilterMetadata(query.filters as FilterDocument) !==
        qualification.metadata ||
      !sameShareTrendQueryTime(
        query.time as QueryTime,
        qualification.requestTime!,
      )
    )
      return undefined;
    const metadata = scopedFilterMetadata(query.filters as FilterDocument);
    const count = qualification.countInput;
    const stable = stableShareTrendValue({
      operation: "cross-dimension",
      configuration,
      variant: Object.hasOwn(query, "variant")
        ? { present: true, value: query.variant }
        : { present: false },
      subject: query.context.subject,
      audience: query.context.policy.audience,
      time: query.time,
      scopePreference: query.scopePreference ?? null,
      filters: {
        version: query.filters.version,
        root: query.filters.root,
        metadata: metadata
          ? {
              requestedScope: metadata.requestedScope,
              resolvedScope: metadata.resolvedScope,
              plan: scopePlanRequestSnapshot(metadata.plan),
              time: metadata.time,
              siteIds: [...metadata.siteIds],
            }
          : null,
      },
      scopePlan: scopePlanRequestSnapshot(
        query.scopePlan as ScopedFilterPlan | undefined,
      ),
      qualification: {
        operation: qualification.operation,
        technologyFilterMode:
          qualification.technologyFilterMode ?? "split-only",
        siteId: qualification.siteId,
        time: qualification.time,
        requestTime: qualification.requestTime,
        requestScopePlan: scopePlanRequestSnapshot(
          qualification.requestScopePlan,
        ),
        countInput: {
          subject: count.subject,
          candidateRange: count.candidateRange,
          readRange: count.readRange,
          filterRange: count.filterRange ?? null,
          expressionRange: count.expressionRange,
          expressionUsesExplicitRange: count.expressionUsesExplicitRange,
          lowerBounds: count.lowerBounds,
          scope: count.scope,
          reportingTimeZone: count.reportingTimeZone,
          capturedAtMs: count.capturedAtMs,
          analysisDocument: count.analysis.document,
          numericCompatibilityFieldIds:
            count.numericCompatibilityFieldIds ?? null,
          numericCompatibilityRequirements:
            count.numericCompatibilityRequirements ?? null,
        },
        metadata: {
          requestedScope: qualification.metadata.requestedScope,
          resolvedScope: qualification.metadata.resolvedScope,
          plan: scopePlanRequestSnapshot(qualification.metadata.plan),
          time: qualification.metadata.time,
          siteIds: [...qualification.metadata.siteIds],
        },
      },
    });
    return stable === undefined ? undefined : JSON.stringify(stable);
  } catch {
    return undefined;
  }
}

function isDeferredCrossDimensionQualification(
  value: unknown,
): value is DeferredCrossDimensionQualification {
  return (
    typeof value === "object" &&
    value !== null &&
    deferredCrossDimensionQualifications.has(value) &&
    crossDimensionQualificationStamps.has(value)
  );
}

/** Reads and revalidates the request-local Cross qualification brand. */
export function deferredCrossDimensionQualificationFromQuery(
  input: unknown,
): DeferredCrossDimensionQualification | undefined {
  if (!input || typeof input !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(
    input,
    DEFERRED_CROSS_DIMENSION_QUALIFICATION,
  );
  if (!descriptor) return undefined;
  if (descriptor.enumerable || !("value" in descriptor))
    throw new Error("cross_dimension_qualification_request_untrusted");
  const deferred = descriptor.value;
  if (!isDeferredCrossDimensionQualification(deferred))
    throw new Error("cross_dimension_qualification_request_untrusted");
  const query = input as QueryInput & Record<string, unknown>;
  const stamp = crossDimensionQualificationStamps.get(deferred)!;
  const configuration =
    technologyCrossDimensionQualificationConfigurationFromQuery(
      query,
      deferred,
    );
  const requestSnapshot = crossDimensionRequestSnapshot(
    query,
    deferred.qualification,
    deferred.configuration,
    deferred,
  );
  if (
    deferred.operation !== "cross-dimension" ||
    !Object.isFrozen(deferred) ||
    !Object.isFrozen(deferred.configuration) ||
    !configuration ||
    !sameCrossDimensionConfiguration(configuration, deferred.configuration) ||
    (!isDeferredEventQualification(deferred.qualification) &&
      !isDeferredEventCandidatePageProjection(deferred.qualification)) ||
    deferred.qualification.operation !== "cross-dimension" ||
    stamp.qualification !== deferred.qualification ||
    stamp.countInput !== deferred.qualification.countInput ||
    stamp.analysis !== deferred.qualification.countInput.analysis ||
    requestSnapshot === undefined ||
    requestSnapshot !== deferred.requestSnapshot
  )
    throw new Error("cross_dimension_qualification_request_changed");
  return deferred;
}

/** Checks the outer brand at a direct compiler boundary. */
export function isDeferredCrossDimensionQualificationRequest(
  value: unknown,
): value is DeferredCrossDimensionQualification {
  return isDeferredCrossDimensionQualification(value);
}

const RADAR_QUERY_FIELDS = new Set([
  "context",
  "filters",
  "scopePreference",
  "scopePlan",
  "time",
  "variant",
  "limit",
  "browserLimit",
  "versionLimit",
]);

const radarQualificationStamps = new WeakMap<
  object,
  {
    readonly qualification:
      | DeferredEventQualification
      | DeferredEventCandidatePageProjectionFor<"radar">;
    readonly countInput: AdvancedCountQualificationPlanInput;
    readonly analysis: object;
  }
>();

function technologyRadarQualificationConfigurationFromQuery(
  query: QueryInput & Record<string, unknown>,
): TechnologyRadarQualificationConfiguration | undefined {
  try {
    if (query.variant === "version") {
      if (
        Object.hasOwn(query, "limit") ||
        !query.filters?.root ||
        !filterDocumentUsesAdvancedExpressions(query.filters)
      )
        return undefined;
      const browserLimit = query.browserLimit ?? 0;
      const versionLimit = query.versionLimit ?? 5;
      if (
        typeof browserLimit !== "number" ||
        !Number.isFinite(browserLimit) ||
        typeof versionLimit !== "number" ||
        !Number.isFinite(versionLimit)
      )
        return undefined;
      return { dimension: "version", browserLimit, versionLimit };
    }
    if (query.variant === undefined || query.variant === "browser") {
      if (
        Object.hasOwn(query, "limit") ||
        Object.hasOwn(query, "browserLimit") ||
        Object.hasOwn(query, "versionLimit")
      )
        return undefined;
      return { dimension: "browser" };
    }
    if (query.variant !== "referrer") return undefined;
    if (
      Object.hasOwn(query, "browserLimit") ||
      Object.hasOwn(query, "versionLimit")
    )
      return undefined;
    const rawLimit = query.limit;
    const limit = rawLimit == null ? 24 : rawLimit;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit))
      return undefined;
    return { dimension: "referrer", limit };
  } catch {
    return undefined;
  }
}

function hasSafeRadarQueryShape(
  query: QueryInput & Record<string, unknown>,
  expectedBrand?: DeferredRadarQualification,
): boolean {
  try {
    for (const key of Reflect.ownKeys(query)) {
      if (typeof key === "symbol") {
        if (key !== DEFERRED_RADAR_QUALIFICATION) return false;
        const brand = Object.getOwnPropertyDescriptor(query, key);
        if (
          !brand ||
          brand.enumerable ||
          !("value" in brand) ||
          brand.value !== expectedBrand
        )
          return false;
        continue;
      }
      if (!RADAR_QUERY_FIELDS.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(query, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

function hasPrivateTechnologyWholeFilterOptIn(
  operation: "share-trend" | "radar" | "cross-dimension",
  input: unknown,
): boolean {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input))
      return false;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const query = input as QueryInput & Record<string, unknown>;
    if (Reflect.ownKeys(query).some((key) => typeof key === "symbol"))
      return false;
    const context = ownDataValue(query, "context");
    const subject = ownDataValue(context, "subject");
    const policy = ownDataValue(context, "policy");
    const isPlainRecord = (value: unknown): boolean => {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
      const valuePrototype = Object.getPrototypeOf(value);
      return valuePrototype === Object.prototype || valuePrototype === null;
    };
    const filters = ownDataValue(query, "filters") as
      FilterDocument | undefined;
    const filterVersion = ownDataValue(filters, "version");
    const filterRoot = ownDataValue(filters, "root");
    if (
      !isPlainRecord(context) ||
      !isPlainRecord(subject) ||
      !isPlainRecord(policy) ||
      !filters ||
      !isPlainRecord(filters) ||
      ownDataValue(subject, "kind") !== "site" ||
      typeof ownDataValue(subject, "siteId") !== "string" ||
      ownDataValue(subject, "siteId") === "" ||
      ownDataValue(policy, "audience") !== "private-dashboard" ||
      stableShareTrendValue(subject) === undefined ||
      filterVersion !== 1 ||
      !filterRoot ||
      stableShareTrendValue({ version: filterVersion, root: filterRoot }) ===
        undefined ||
      !filterDocumentUsesAdvancedExpressions(filters)
    )
      return false;
    if (operation === "share-trend")
      return (
        hasSafeShareTrendQueryShape(query) &&
        normalizedShareTrendConfigurationFromQuery(query) !== undefined
      );
    if (operation === "radar")
      return (
        hasSafeRadarQueryShape(query) &&
        technologyRadarQualificationConfigurationFromQuery(query) !== undefined
      );
    return (
      technologyCrossDimensionQualificationConfigurationFromQuery(query) !==
      undefined
    );
  } catch {
    return false;
  }
}

function isDeferredRadarQualification(
  value: unknown,
): value is DeferredRadarQualification {
  return (
    typeof value === "object" &&
    value !== null &&
    deferredRadarQualifications.has(value) &&
    radarQualificationStamps.has(value)
  );
}

function radarRequestSnapshot(
  query: QueryInput & Record<string, unknown>,
  qualification:
    | DeferredEventQualification
    | DeferredEventCandidatePageProjectionFor<"radar">,
  configuration: TechnologyRadarQualificationConfiguration,
  expectedBrand?: DeferredRadarQualification,
): string | undefined {
  try {
    if (!hasSafeRadarQueryShape(query, expectedBrand)) return undefined;
    const filterDocument = query.filters as FilterDocument;
    if (
      stableShareTrendValue({
        version: filterDocument.version,
        root: filterDocument.root,
      }) === undefined
    )
      return undefined;
    const queryConfiguration =
      technologyRadarQualificationConfigurationFromQuery(query);
    if (
      !queryConfiguration ||
      JSON.stringify(queryConfiguration) !== JSON.stringify(configuration) ||
      query.context?.subject?.kind !== "site" ||
      query.context.policy.audience !== "private-dashboard" ||
      query.context.subject.siteId !== qualification.siteId ||
      query.filters !== qualification.filters ||
      scopedFilterMetadata(query.filters as FilterDocument) !==
        qualification.metadata ||
      !sameShareTrendQueryTime(
        query.time as QueryTime,
        qualification.requestTime!,
      )
    )
      return undefined;
    const metadata = scopedFilterMetadata(query.filters as FilterDocument);
    const count = qualification.countInput;
    const stable = stableShareTrendValue({
      operation: "radar",
      configuration,
      subject: query.context.subject,
      audience: query.context.policy.audience,
      time: query.time,
      scopePreference: query.scopePreference ?? null,
      filters: {
        version: query.filters.version,
        root: query.filters.root,
        metadata: metadata
          ? {
              requestedScope: metadata.requestedScope,
              resolvedScope: metadata.resolvedScope,
              plan: scopePlanRequestSnapshot(metadata.plan),
              time: metadata.time,
              siteIds: [...metadata.siteIds],
            }
          : null,
      },
      scopePlan: scopePlanRequestSnapshot(
        query.scopePlan as ScopedFilterPlan | undefined,
      ),
      qualification: {
        operation: qualification.operation,
        technologyFilterMode:
          qualification.technologyFilterMode ?? "split-only",
        siteId: qualification.siteId,
        time: qualification.time,
        requestTime: qualification.requestTime,
        requestScopePlan: scopePlanRequestSnapshot(
          qualification.requestScopePlan,
        ),
        countInput: {
          subject: count.subject,
          candidateRange: count.candidateRange,
          readRange: count.readRange,
          filterRange: count.filterRange ?? null,
          expressionRange: count.expressionRange,
          expressionUsesExplicitRange: count.expressionUsesExplicitRange,
          lowerBounds: count.lowerBounds,
          scope: count.scope,
          reportingTimeZone: count.reportingTimeZone,
          capturedAtMs: count.capturedAtMs,
          analysisDocument: count.analysis.document,
          numericCompatibilityFieldIds:
            count.numericCompatibilityFieldIds ?? null,
          numericCompatibilityRequirements:
            count.numericCompatibilityRequirements ?? null,
        },
        metadata: {
          requestedScope: qualification.metadata.requestedScope,
          resolvedScope: qualification.metadata.resolvedScope,
          plan: scopePlanRequestSnapshot(qualification.metadata.plan),
          time: qualification.metadata.time,
          siteIds: [...qualification.metadata.siteIds],
        },
      },
      radarParameters: {
        browserLimit: Object.hasOwn(query, "browserLimit")
          ? {
              present: true,
              value: Object.getOwnPropertyDescriptor(query, "browserLimit")
                ?.value,
            }
          : { present: false },
        versionLimit: Object.hasOwn(query, "versionLimit")
          ? {
              present: true,
              value: Object.getOwnPropertyDescriptor(query, "versionLimit")
                ?.value,
            }
          : { present: false },
      },
    });
    return stable === undefined ? undefined : JSON.stringify(stable);
  } catch {
    return undefined;
  }
}

/** Reads and revalidates the request-local Radar qualification brand. */
export function deferredRadarQualificationFromQuery(
  input: unknown,
): DeferredRadarQualification | undefined {
  if (!input || typeof input !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(
    input,
    DEFERRED_RADAR_QUALIFICATION,
  );
  if (!descriptor) return undefined;
  if (descriptor.enumerable || !("value" in descriptor))
    throw new Error("radar_qualification_request_untrusted");
  const deferred = descriptor.value;
  if (!isDeferredRadarQualification(deferred))
    throw new Error("radar_qualification_request_untrusted");
  const query = input as QueryInput & Record<string, unknown>;
  if (!hasSafeRadarQueryShape(query, deferred))
    throw new Error("radar_qualification_request_changed");
  const stamp = radarQualificationStamps.get(deferred)!;
  const configuration =
    technologyRadarQualificationConfigurationFromQuery(query);
  const requestSnapshot = radarRequestSnapshot(
    query,
    deferred.qualification,
    deferred.configuration,
    deferred,
  );
  if (
    deferred.operation !== "radar" ||
    !Object.isFrozen(deferred) ||
    !Object.isFrozen(deferred.configuration) ||
    !configuration ||
    JSON.stringify(configuration) !== JSON.stringify(deferred.configuration) ||
    (!isDeferredEventQualification(deferred.qualification) &&
      !isDeferredEventCandidatePageProjection(deferred.qualification)) ||
    deferred.qualification.operation !== "radar" ||
    stamp.qualification !== deferred.qualification ||
    stamp.countInput !== deferred.qualification.countInput ||
    stamp.analysis !== deferred.qualification.countInput.analysis ||
    requestSnapshot === undefined ||
    requestSnapshot !== deferred.requestSnapshot
  )
    throw new Error("radar_qualification_request_changed");
  return deferred;
}

/** Checks the outer brand at a direct compiler boundary. */
export function isDeferredRadarQualificationRequest(
  value: unknown,
): value is DeferredRadarQualification {
  return isDeferredRadarQualification(value);
}

function ownDataValue(value: unknown, key: string): unknown {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor && descriptor.enumerable
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function ownDescriptor(
  value: unknown,
  key: PropertyKey,
): PropertyDescriptor | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return undefined;
  }
}

function queryHasNoComparisonState(query: unknown): boolean {
  return ["comparison", "current", "reference"].every((key) => {
    const descriptor = ownDescriptor(query, key);
    return (
      descriptor === undefined ||
      ("value" in descriptor && descriptor.value === undefined)
    );
  });
}

function queryScopePlanMatchesMetadata(
  query: unknown,
  metadataPlan: ScopedFilterPlan,
): boolean {
  const descriptor = ownDescriptor(query, "scopePlan");
  if (descriptor === undefined) return true;
  if (!descriptor.enumerable || !("value" in descriptor)) return false;
  if (descriptor.value === undefined || descriptor.value === metadataPlan)
    return true;
  const requestSnapshot = qualificationRequestOwnDataSnapshot(descriptor.value);
  const metadataSnapshot = qualificationRequestOwnDataSnapshot(metadataPlan);
  return (
    requestSnapshot !== undefined &&
    metadataSnapshot !== undefined &&
    requestSnapshot === metadataSnapshot
  );
}

function canonicalPrivateFilterValuesWholeFilterOptIn(
  query: unknown,
  configuration: FilterValuesQualificationConfiguration | undefined,
): boolean {
  if (
    !configuration ||
    configuration.audience !== "private-dashboard" ||
    !queryHasNoComparisonState(query)
  )
    return false;
  const allowedKeys = new Set([
    "context",
    "time",
    "filters",
    "scopePreference",
    "scopePlan",
    "field",
    "search",
    "page",
  ]);
  try {
    if (!query || typeof query !== "object" || Array.isArray(query))
      return false;
    for (const key of Reflect.ownKeys(query)) {
      if (typeof key !== "string" || !allowedKeys.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(query, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        return false;
    }
  } catch {
    return false;
  }
  const context = ownDataValue(query, "context");
  const subject = ownDataValue(context, "subject");
  const policy = ownDataValue(context, "policy");
  const time = ownDataValue(query, "time");
  const filters = ownDataValue(query, "filters");
  const scopePlan = ownDataValue(query, "scopePlan");
  const subjectKind = ownDataValue(subject, "kind");
  const subjectSiteId = ownDataValue(subject, "siteId");
  const policyAudience = ownDataValue(policy, "audience");
  return (
    context !== null &&
    typeof context === "object" &&
    subject !== null &&
    typeof subject === "object" &&
    subjectKind === "site" &&
    typeof subjectSiteId === "string" &&
    policy !== null &&
    typeof policy === "object" &&
    policyAudience === "private-dashboard" &&
    time !== null &&
    typeof time === "object" &&
    ownDescriptor(time, "filterRange") === undefined &&
    ownDescriptor(time, "filterRangeEmpty") === undefined &&
    ownDescriptor(time, "fullHistory") === undefined &&
    filters !== null &&
    typeof filters === "object" &&
    scopePlan !== null &&
    typeof scopePlan === "object"
  );
}

function canonicalPrivateJourneyWholeFilterRequest(
  query: unknown,
  operation: "geo-points" | "retention",
  configurationValid: boolean,
): boolean {
  if (!configurationValid || !queryHasNoComparisonState(query)) return false;
  const allowedKeys = new Set([
    "context",
    "time",
    "filters",
    "scopePreference",
    "scopePlan",
    operation === "geo-points" ? "limit" : "granularity",
  ]);
  try {
    if (!query || typeof query !== "object" || Array.isArray(query))
      return false;
    for (const key of Reflect.ownKeys(query)) {
      if (typeof key !== "string" || !allowedKeys.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(query, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        return false;
    }
  } catch {
    return false;
  }
  const context = ownDataValue(query, "context");
  const subject = ownDataValue(context, "subject");
  const policy = ownDataValue(context, "policy");
  const time = ownDataValue(query, "time");
  const filters = ownDataValue(query, "filters");
  const scopePlan = ownDataValue(query, "scopePlan");
  const siteId = ownDataValue(subject, "siteId");
  return (
    time !== null &&
    typeof time === "object" &&
    filters !== null &&
    typeof filters === "object" &&
    scopePlan !== null &&
    typeof scopePlan === "object" &&
    ownDescriptor(time, "filterRange") === undefined &&
    ownDescriptor(time, "filterRangeEmpty") === undefined &&
    ownDescriptor(time, "fullHistory") === undefined &&
    ownDataValue(subject, "kind") === "site" &&
    typeof siteId === "string" &&
    siteId.length > 0 &&
    ownDataValue(policy, "audience") === "private-dashboard"
  );
}

function privatePageDimensionWholeFilterOptIn(
  query: unknown,
  request:
    | (NormalizedDimensionPageRequest & { readonly audience: QueryAudience })
    | undefined,
): boolean {
  if (!request || !queryHasNoComparisonState(query)) return false;
  return isCanonicalPrivatePageDimensionWholeFilterRequest({
    mode: ownDataValue(query, "mode"),
    audience: request.audience,
    dimension: request.dimension,
    selection: request.selection,
    excludeEmpty: request.excludeEmpty,
  });
}

function privatePageOverviewWholeFilterOptIn(
  query: unknown,
  request:
    | (NormalizedOverviewPageTableRequest & {
        readonly audience: QueryAudience;
      })
    | undefined,
): boolean {
  if (!request || !queryHasNoComparisonState(query)) return false;
  return isCanonicalPrivatePageDimensionWholeFilterRequest({
    mode: ownDataValue(query, "mode"),
    audience: request.audience,
    tab: request.tab,
    overviewFamily: request.family,
    selection: request.selection,
    excludeEmpty: request.excludeEmpty,
  });
}

function privateSessionBoundaryWholeFilterOptIn(
  query: unknown,
  input: {
    readonly allowedByMiddleware: boolean;
    readonly operation: DeferredEventQualificationOperation;
    readonly dimensionRequest?: NormalizedSessionBoundaryDimensionRequest;
    readonly overviewPageRequest?: DeferredSessionBoundaryOverviewPageRequest;
  },
): boolean {
  if (!input.allowedByMiddleware || !queryHasNoComparisonState(query))
    return false;
  if (input.operation === "session-boundary-dimension") {
    const request = input.dimensionRequest;
    const dimension = ownDataValue(query, "dimension");
    return (
      request !== undefined &&
      ownDataValue(query, "mode") === "breakdown" &&
      request.audience === "private-dashboard" &&
      dimension === request.dimension &&
      ((request.kind === "entry" &&
        request.dimension === "session.entryPath") ||
        (request.kind === "exit" && request.dimension === "session.exitPath"))
    );
  }
  if (input.operation === "session-boundary-overview-page") {
    const request = input.overviewPageRequest;
    const tab = ownDataValue(query, "tab");
    return (
      request !== undefined &&
      ownDataValue(query, "mode") === "overview-tab" &&
      request.audience === "private-dashboard" &&
      tab === request.tab &&
      ((request.tab === "page.entry" &&
        request.kind === "entry" &&
        request.dimension === "session.entryPath") ||
        (request.tab === "page.exit" &&
          request.kind === "exit" &&
          request.dimension === "session.exitPath"))
    );
  }
  return false;
}

function privateChannelListWholeFilterOptIn(
  query: unknown,
  request: DeferredChannelListRequest | undefined,
): boolean {
  if (!request || !queryHasNoComparisonState(query)) return false;
  return isCanonicalPrivateChannelListWholeFilterRequest({
    mode: ownDataValue(query, "mode"),
    audience: request.audience,
  });
}

function privateChannelOverviewWholeFilterOptIn(
  query: unknown,
  request: DeferredOverviewPageTableRequest | undefined,
): boolean {
  if (!request || !queryHasNoComparisonState(query)) return false;
  return isCanonicalPrivateChannelOverviewWholeFilterRequest({
    mode: ownDataValue(query, "mode"),
    audience: request.audience,
    tab: ownDataValue(query, "tab"),
    family: request.family,
    selection: request.selection,
    excludeEmpty: request.excludeEmpty,
  });
}

function isPerformanceInterval(value: unknown): value is Interval {
  return (
    typeof value === "string" &&
    (INTERVALS as readonly string[]).includes(value)
  );
}

function isPerformanceMetric(value: unknown): value is PerformanceMetricKey {
  return PERFORMANCE_METRICS.some(({ key }) => key === value);
}

function capturedOptionalPerformanceLimit(
  value: unknown,
  key: string,
):
  | { readonly present: boolean; readonly value: number | null | undefined }
  | undefined {
  const descriptor = ownDescriptor(value, key);
  if (!descriptor) return { present: false, value: undefined };
  if (!("value" in descriptor) || !descriptor.enumerable) return undefined;
  const limit = descriptor.value;
  if (
    limit !== undefined &&
    limit !== null &&
    (typeof limit !== "number" || !Number.isFinite(limit))
  )
    return undefined;
  return { present: true, value: limit as number | null | undefined };
}

function performanceQualificationConfigurationFromQuery(
  value: unknown,
): PerformanceSummaryQualificationConfiguration | undefined {
  const mode = ownDescriptor(value, "mode");
  if (!mode || !("value" in mode) || !mode.enumerable) return undefined;
  if (mode.value === "summary") return { mode: "summary" };
  if (mode.value === "timeseries" || mode.value === "dashboard") {
    const interval = ownDescriptor(value, "interval");
    if (
      !interval ||
      !("value" in interval) ||
      !interval.enumerable ||
      !isPerformanceInterval(interval.value)
    )
      return undefined;
    if (mode.value === "timeseries")
      return { mode: "timeseries", interval: interval.value };
    const limit = capturedOptionalPerformanceLimit(value, "limit");
    return limit && Number.isInteger(limit.value ?? 18)
      ? {
          mode: "dashboard",
          interval: interval.value,
          routeLimitPresent: limit.present,
          routeLimitValue: limit.value,
        }
      : undefined;
  }
  if (mode.value !== "breakdown") return undefined;
  const dimension = ownDescriptor(value, "dimension");
  const metric = ownDescriptor(value, "metric");
  const limit = capturedOptionalPerformanceLimit(value, "limit");
  const parsedDimension =
    dimension && "value" in dimension && dimension.enumerable
      ? SitePerformanceBreakdownDimensionSchema.safeParse(dimension.value)
      : undefined;
  return parsedDimension?.success &&
    metric &&
    "value" in metric &&
    metric.enumerable &&
    isPerformanceMetric(metric.value) &&
    limit &&
    (parsedDimension.data !== "page.path" ||
      Number.isInteger(limit.value ?? 20))
    ? {
        mode: "breakdown",
        dimension: parsedDimension.data,
        metric: metric.value,
        limitPresent: limit.present,
        limitValue: limit.value,
      }
    : undefined;
}

function queryHasNoPerformanceAnalysisContext(query: unknown): boolean {
  const descriptor = ownDescriptor(query, "analysisContext");
  return (
    descriptor === undefined ||
    ("value" in descriptor &&
      descriptor.enumerable === true &&
      descriptor.value === undefined)
  );
}

function knownRawPerformanceConfigurationShape(
  query: unknown,
  configuration: PerformanceSummaryQualificationConfiguration,
): boolean {
  const allowed = new Set<string>(
    configuration.mode === "summary"
      ? ["mode"]
      : configuration.mode === "timeseries"
        ? ["mode", "interval"]
        : configuration.mode === "breakdown"
          ? ["mode", "dimension", "metric", "limit"]
          : ["mode", "interval", "limit"],
  );
  for (const key of ["mode", "interval", "dimension", "metric", "limit"]) {
    const descriptor = ownDescriptor(query, key);
    if (
      descriptor !== undefined &&
      (!allowed.has(key) || !descriptor.enumerable || !("value" in descriptor))
    )
      return false;
  }
  return true;
}

/** Captures a narrow raw-request proof before performance input is copied. */
function privatePerformanceWholeFilterConfigurationFromQuery(
  query: unknown,
): PerformanceSummaryQualificationConfiguration | undefined {
  try {
    if (typeof query !== "object" || query === null || Array.isArray(query))
      return undefined;
    const prototype = Object.getPrototypeOf(query);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const configuration = performanceQualificationConfigurationFromQuery(query);
    if (
      !configuration ||
      !queryHasNoComparisonState(query) ||
      !queryHasNoPerformanceAnalysisContext(query) ||
      !knownRawPerformanceConfigurationShape(query, configuration)
    )
      return undefined;

    const context = ownDataValue(query, "context");
    const subject = ownDataValue(context, "subject");
    const policy = ownDataValue(context, "policy");
    if (
      ownDataValue(subject, "kind") !== "site" ||
      typeof ownDataValue(subject, "siteId") !== "string" ||
      ownDataValue(subject, "siteId") === "" ||
      ownDataValue(policy, "audience") !== "private-dashboard"
    )
      return undefined;

    return Object.freeze(configuration);
  } catch {
    return undefined;
  }
}

function knownPerformanceSummaryConfiguration(
  value: unknown,
): PerformanceSummaryQualificationConfiguration | undefined {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    )
      return undefined;
    const keys = Reflect.ownKeys(value);
    const mode = Object.getOwnPropertyDescriptor(value, "mode");
    if (
      !mode ||
      !("value" in mode) ||
      !mode.enumerable ||
      typeof mode.value !== "string"
    )
      return undefined;
    if (mode.value === "summary" && keys.length === 1 && keys.includes("mode"))
      return { mode: "summary" };
    const descriptor = (key: string) =>
      Object.getOwnPropertyDescriptor(value, key);
    const validNumberOrNull = (candidate: unknown) =>
      candidate === undefined ||
      candidate === null ||
      (typeof candidate === "number" && Number.isFinite(candidate));
    if (mode.value === "timeseries" && keys.length === 2) {
      const interval = descriptor("interval");
      if (
        !keys.includes("mode") ||
        !keys.includes("interval") ||
        !interval ||
        !("value" in interval) ||
        !interval.enumerable ||
        !isPerformanceInterval(interval.value)
      )
        return undefined;
      return { mode: "timeseries", interval: interval.value };
    }
    if (mode.value === "breakdown" && keys.length === 5) {
      const dimension = descriptor("dimension");
      const metric = descriptor("metric");
      const limitPresent = descriptor("limitPresent");
      const limitValue = descriptor("limitValue");
      const parsedDimension =
        dimension && "value" in dimension && dimension.enumerable
          ? SitePerformanceBreakdownDimensionSchema.safeParse(dimension.value)
          : undefined;
      if (
        !["mode", "dimension", "metric", "limitPresent", "limitValue"].every(
          (key) => keys.includes(key),
        ) ||
        !parsedDimension?.success ||
        !metric ||
        !("value" in metric) ||
        !metric.enumerable ||
        !isPerformanceMetric(metric.value) ||
        !limitPresent ||
        !("value" in limitPresent) ||
        !limitPresent.enumerable ||
        typeof limitPresent.value !== "boolean" ||
        !limitValue ||
        !("value" in limitValue) ||
        !limitValue.enumerable ||
        !validNumberOrNull(limitValue.value) ||
        (!limitPresent.value && limitValue.value !== undefined)
      )
        return undefined;
      return {
        mode: "breakdown",
        dimension: parsedDimension.data,
        metric: metric.value,
        limitPresent: limitPresent.value,
        limitValue: limitValue.value,
      };
    }
    if (mode.value === "dashboard" && keys.length === 4) {
      const interval = descriptor("interval");
      const limitPresent = descriptor("routeLimitPresent");
      const limitValue = descriptor("routeLimitValue");
      if (
        !["mode", "interval", "routeLimitPresent", "routeLimitValue"].every(
          (key) => keys.includes(key),
        ) ||
        !interval ||
        !("value" in interval) ||
        !interval.enumerable ||
        !isPerformanceInterval(interval.value) ||
        !limitPresent ||
        !("value" in limitPresent) ||
        !limitPresent.enumerable ||
        typeof limitPresent.value !== "boolean" ||
        !limitValue ||
        !("value" in limitValue) ||
        !limitValue.enumerable ||
        !validNumberOrNull(limitValue.value) ||
        (!limitPresent.value && limitValue.value !== undefined)
      )
        return undefined;
      return {
        mode: "dashboard",
        interval: interval.value,
        routeLimitPresent: limitPresent.value,
        routeLimitValue: limitValue.value,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function matchesPerformanceSummaryQualificationConfiguration(
  requested: unknown,
  frozen: PerformanceSummaryQualificationConfiguration,
): boolean {
  try {
    if (!Object.isFrozen(frozen)) return false;
    const left = knownPerformanceSummaryConfiguration(requested);
    const right = knownPerformanceSummaryConfiguration(frozen);
    return Boolean(
      left &&
      right &&
      left.mode === right.mode &&
      ((left.mode === "summary" && right.mode === "summary") ||
        (left.mode === "timeseries" &&
          right.mode === "timeseries" &&
          left.interval === right.interval) ||
        (left.mode === "breakdown" &&
          right.mode === "breakdown" &&
          left.dimension === right.dimension &&
          left.metric === right.metric &&
          left.limitPresent === right.limitPresent &&
          Object.is(left.limitValue, right.limitValue)) ||
        (left.mode === "dashboard" &&
          right.mode === "dashboard" &&
          left.interval === right.interval &&
          left.routeLimitPresent === right.routeLimitPresent &&
          Object.is(left.routeLimitValue, right.routeLimitValue))),
    );
  } catch {
    return false;
  }
}

function safeOwnDataSerialization(
  value: unknown,
  visiting: Set<object> = new Set(),
): string | undefined {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value !== "object") return undefined;
  if (visiting.has(value)) return undefined;
  visiting.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      const length = value.length;
      if (keys.length !== length + 1 || !keys.includes("length"))
        return undefined;
      const entries: string[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
          return undefined;
        const entry = safeOwnDataSerialization(descriptor.value, visiting);
        if (entry === undefined) return undefined;
        entries.push(entry);
      }
      return "[" + entries.join(",") + "]";
    }
    if (Object.getPrototypeOf(value) === Set.prototype) {
      const entries = Array.from(
        Set.prototype.values.call(value) as Iterable<unknown>,
      );
      const serialized = entries.map((entry) =>
        safeOwnDataSerialization(entry, visiting),
      );
      if (serialized.some((entry) => entry === undefined)) return undefined;
      return "set[" + serialized.join(",") + "]";
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return undefined;
    const entries: string[] = [];
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        return undefined;
      const entry = safeOwnDataSerialization(descriptor.value, visiting);
      if (entry === undefined) return undefined;
      entries.push(JSON.stringify(key) + ":" + entry);
    }
    return "{" + entries.join(",") + "}";
  } catch {
    return undefined;
  } finally {
    visiting.delete(value);
  }
}

function performanceSummaryRequestSnapshot(
  query: unknown,
  configuration: PerformanceSummaryQualificationConfiguration,
  performanceFilterMode?: "allow-whole-filter",
): string | undefined {
  const actualConfiguration =
    performanceQualificationConfigurationFromQuery(query);
  const context = ownDataValue(query, "context");
  const subject = ownDataValue(context, "subject");
  const policy = ownDataValue(context, "policy");
  const filters = ownDataValue(query, "filters");
  const metadata = scopedFilterMetadata(filters as FilterDocument | undefined);
  const scopePlan = ownDataValue(query, "scopePlan") ?? metadata?.plan;
  if (
    !metadata ||
    !scopePlan ||
    !actualConfiguration ||
    !matchesPerformanceSummaryQualificationConfiguration(
      actualConfiguration,
      configuration,
    )
  )
    return undefined;
  const value = {
    operation: "performance",
    mode: actualConfiguration.mode,
    ...(actualConfiguration.mode === "timeseries" ||
    actualConfiguration.mode === "dashboard"
      ? { interval: actualConfiguration.interval }
      : {}),
    ...(actualConfiguration.mode === "breakdown"
      ? {
          dimension: actualConfiguration.dimension,
          metric: actualConfiguration.metric,
          limit: {
            present: actualConfiguration.limitPresent,
            value: actualConfiguration.limitValue,
          },
        }
      : actualConfiguration.mode === "dashboard"
        ? {
            routeLimit: {
              present: actualConfiguration.routeLimitPresent,
              value: actualConfiguration.routeLimitValue,
            },
          }
        : {}),
    siteId: ownDataValue(subject, "siteId"),
    audience: ownDataValue(policy, "audience"),
    time: ownDataValue(query, "time"),
    filters: {
      version: ownDataValue(filters, "version"),
      root: ownDataValue(filters, "root"),
    },
    scopePlan,
    metadata: {
      siteIds: metadata.siteIds,
      time: metadata.time,
      plan: metadata.plan,
    },
    ...(performanceFilterMode === "allow-whole-filter"
      ? {
          performanceFilterMode,
          excludedRequestFields: {
            comparison: ownPerformanceRequestFieldSnapshot(query, "comparison"),
            current: ownPerformanceRequestFieldSnapshot(query, "current"),
            reference: ownPerformanceRequestFieldSnapshot(query, "reference"),
            analysisContext: ownPerformanceRequestFieldSnapshot(
              query,
              "analysisContext",
            ),
          },
        }
      : {}),
  };
  return safeOwnDataSerialization(value);
}

function ownPerformanceRequestFieldSnapshot(
  query: unknown,
  key: string,
): unknown {
  const descriptor = ownDescriptor(query, key);
  if (!descriptor) return { present: false };
  if (!("value" in descriptor))
    return { present: true, enumerable: descriptor.enumerable, accessor: true };
  return {
    present: true,
    enumerable: descriptor.enumerable,
    value: descriptor.value,
  };
}

function copyPerformanceMiddlewareInput(
  value: unknown,
): QueryInput & Record<string, unknown> {
  const output = Object.create(null) as Record<string, unknown>;
  try {
    if (typeof value !== "object" || value === null)
      return output as QueryInput & Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        continue;
      Object.defineProperty(output, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  } catch {
    return Object.create(null) as QueryInput & Record<string, unknown>;
  }
  return output as QueryInput & Record<string, unknown>;
}

export function isDeferredPerformanceSummaryQualificationRequest(
  value: unknown,
): value is DeferredPerformanceSummaryQualification {
  try {
    const deferred = value as DeferredPerformanceSummaryQualification;
    return (
      typeof value === "object" &&
      value !== null &&
      deferredPerformanceSummaryQualifications.has(value) &&
      deferred.operation === "performance" &&
      deferred.qualification.operation === "performance" &&
      deferred.qualification.requestTime !== undefined &&
      typeof deferred.requestSnapshot === "string" &&
      (deferred.qualification.performanceFilterMode === undefined ||
        deferred.qualification.performanceFilterMode ===
          "allow-whole-filter") &&
      Object.isFrozen(deferred) &&
      Object.isFrozen(deferred.configuration) &&
      matchesPerformanceSummaryQualificationConfiguration(
        deferred.configuration,
        deferred.configuration,
      )
    );
  } catch {
    return false;
  }
}

export function deferredPerformanceSummaryQualificationFromQuery(
  query: QueryInput & Record<string, unknown>,
): DeferredPerformanceSummaryQualification | undefined {
  const descriptor = (() => {
    try {
      return Object.getOwnPropertyDescriptor(
        query,
        DEFERRED_PERFORMANCE_SUMMARY_QUALIFICATION,
      );
    } catch {
      return undefined;
    }
  })();
  if (!descriptor) return undefined;
  if (!("value" in descriptor))
    throw new Error("performance_summary_qualification_request_changed");
  const candidate: unknown = descriptor.value;
  if (candidate === undefined) return undefined;
  const configuration = performanceQualificationConfigurationFromQuery(query);
  if (
    !isDeferredPerformanceSummaryQualificationRequest(candidate) ||
    !configuration ||
    !matchesPerformanceSummaryQualificationConfiguration(
      configuration,
      candidate.configuration,
    ) ||
    performanceSummaryRequestSnapshot(
      query,
      candidate.configuration,
      candidate.qualification.performanceFilterMode,
    ) !== candidate.requestSnapshot
  )
    throw new Error("performance_summary_qualification_request_changed");
  return candidate;
}

async function prepareDeferredEventQualification(input: {
  readonly env: Env;
  readonly query: QueryInput & Record<string, unknown>;
  readonly operation: DeferredEventQualificationOperation;
  readonly allowPrivatePerformanceWholeFilterOptIn?: boolean;
  readonly allowPrivateTechnologyWholeFilterOptIn?: boolean;
  readonly allowPageFieldWholeFilterOptIn?: boolean;
  readonly allowPrivateSessionBoundaryWholeFilterOptIn?: boolean;
  readonly allowPrivateChannelListWholeFilterOptIn?: boolean;
  readonly allowPrivateChannelOverviewWholeFilterOptIn?: boolean;
  readonly allowPrivateGeoPointsWholeFilterOptIn?: boolean;
  readonly allowPrivateRetentionWholeFilterOptIn?: boolean;
  readonly allowPrivateFilterValuesWholeFilterOptIn?: boolean;
  readonly allowEventNameDimensionEventCandidate?: boolean;
  readonly eventSummaryRequestSnapshot?: string;
  readonly eventRecordsRequestSnapshot?: string;
  readonly eventTrendRequestSnapshot?: string;
  readonly eventContextRequestSnapshot?: string;
  readonly eventTypeDetailRequestSnapshot?: string;
  readonly eventPayloadRequestSnapshot?: string;
  readonly subject: SemanticSubjectDomain;
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
  readonly expectedSiteId?: string;
}): Promise<
  | DeferredEventQualification
  | DeferredEventSummaryQualification
  | DeferredEventRecordsQualification
  | DeferredEventFieldsQualification
  | DeferredEventFieldValuesQualification
  | DeferredEventTypesQualification
  | DeferredEventNameDimensionQualification
  | DeferredEventTrendQualification
  | DeferredEventContextQualification
  | DeferredEventTypeDetailQualification
  | DeferredPageQualification
  | DeferredPagesAggregatePageQualification
  | DeferredPagesTabsQualification
  | DeferredEventCandidatePageProjectionFor<
      | "cross-dimension"
      | "radar"
      | "share-trend"
      | "performance"
      | "geo-points"
      | "pages-tabs"
      | "referrers"
      | "channel-overview"
      | "channel-list"
      | "session-boundary-dimension"
      | "session-boundary-overview-page"
    >
  | DeferredFilterValuesQualificationInput
  | null
> {
  const { query } = input;
  const filterValuesRequest =
    input.operation === "filter-values"
      ? filterValuesQualificationConfigurationFromQuery(query)
      : undefined;
  const rawRequestAudience = ownDataValue(
    ownDataValue(ownDataValue(query, "context"), "policy"),
    "audience",
  );
  const rawPageDimensionRequest =
    input.operation === "page-dimension" &&
    ownDataValue(query, "mode") === "breakdown"
      ? normalizeDimensionPageRequest({
          dimension:
            typeof ownDataValue(query, "dimension") === "string"
              ? (ownDataValue(query, "dimension") as string)
              : "",
          page: ownDataValue(query, "page"),
          limit: ownDataValue(query, "limit"),
          sort: ownDataValue(query, "sort"),
          search: ownDataValue(query, "search"),
        })
      : null;
  const rawOverviewPageTableRequest =
    (input.operation === "page-dimension" ||
      input.operation === "channel-overview") &&
    ownDataValue(query, "mode") === "overview-tab"
      ? normalizeOverviewPageTableRequest({
          operation:
            input.operation === "channel-overview" ? "channels" : "dimension",
          mode: "overview-tab",
          tab: ownDataValue(query, "tab"),
          limit: ownDataValue(query, "limit"),
          cursor: ownDataValue(query, "cursor"),
          sort: ownDataValue(query, "sort"),
          direction: ownDataValue(query, "direction"),
          search: ownDataValue(query, "search"),
        })
      : null;
  const rawOverviewPageDescriptor = rawOverviewPageTableRequest
    ? overviewPageTableDescriptor(rawOverviewPageTableRequest.tab)
    : null;
  const rawReferrerOverviewRequest =
    input.operation === "page-dimension" &&
    ownDataValue(query, "mode") === "overview-tab"
      ? normalizeReferrerOverviewTableRequest({
          mode: ownDataValue(query, "mode"),
          tab: ownDataValue(query, "tab"),
          limit: ownDataValue(query, "limit"),
          cursor: ownDataValue(query, "cursor"),
          sort: ownDataValue(query, "sort"),
          direction: ownDataValue(query, "direction"),
          search: ownDataValue(query, "search"),
        })
      : null;
  const eventCandidatePageReportOperation =
    (input.operation === "cross-dimension" &&
      input.allowPrivateTechnologyWholeFilterOptIn === true &&
      technologyCrossDimensionQualificationConfigurationFromQuery(query) !==
        undefined) ||
    (input.operation === "radar" &&
      input.allowPrivateTechnologyWholeFilterOptIn === true &&
      hasSafeRadarQueryShape(query) &&
      technologyRadarQualificationConfigurationFromQuery(query) !==
        undefined) ||
    (input.operation === "share-trend" &&
      input.allowPrivateTechnologyWholeFilterOptIn === true &&
      hasSafeShareTrendQueryShape(query) &&
      normalizedShareTrendConfigurationFromQuery(query) !== undefined) ||
    (input.operation === "performance" &&
      input.allowPrivatePerformanceWholeFilterOptIn === true &&
      performanceQualificationConfigurationFromQuery(query) !== undefined) ||
    (input.operation === "geo-points" &&
      input.allowPrivateGeoPointsWholeFilterOptIn === true &&
      geoPointsQualificationConfigurationFromQuery(query) !== undefined) ||
    (input.operation === "channel-list" &&
      input.allowPrivateChannelListWholeFilterOptIn === true &&
      isCanonicalPrivateChannelListWholeFilterRequest({
        mode: ownDataValue(query, "mode"),
        audience: rawRequestAudience,
      }) &&
      queryHasNoComparisonState(query)) ||
    (input.operation === "channel-overview" &&
      input.allowPrivateChannelOverviewWholeFilterOptIn === true &&
      rawOverviewPageTableRequest !== null &&
      isCanonicalPrivateChannelOverviewWholeFilterRequest({
        mode: ownDataValue(query, "mode"),
        audience: rawRequestAudience,
        tab: rawOverviewPageTableRequest.tab,
        family: rawOverviewPageTableRequest.family,
        selection: rawOverviewPageTableRequest.selection,
        excludeEmpty: rawOverviewPageTableRequest.excludeEmpty,
      }) &&
      queryHasNoComparisonState(query)) ||
    (input.operation === "referrers" &&
      rawRequestAudience === "private-dashboard" &&
      queryHasNoComparisonState(query)) ||
    ((input.operation === "session-boundary-dimension" ||
      input.operation === "session-boundary-overview-page") &&
      input.allowPrivateSessionBoundaryWholeFilterOptIn === true &&
      rawRequestAudience === "private-dashboard" &&
      queryHasNoComparisonState(query) &&
      ((input.operation === "session-boundary-dimension" &&
        ownDataValue(query, "mode") === "breakdown" &&
        (ownDataValue(query, "dimension") === "session.entryPath" ||
          ownDataValue(query, "dimension") === "session.exitPath")) ||
        (input.operation === "session-boundary-overview-page" &&
          ownDataValue(query, "mode") === "overview-tab" &&
          (ownDataValue(query, "tab") === "page.entry" ||
            ownDataValue(query, "tab") === "page.exit")))) ||
    (input.operation === "pages-tabs" &&
      ownDataValue(query, "mode") === undefined &&
      ownDataValue(
        ownDataValue(ownDataValue(query, "context"), "policy"),
        "audience",
      ) === "private-dashboard" &&
      (ownDataValue(query, "variant") === "tabs" ||
        ownDataValue(query, "includeTabs") === true));
  const eventCandidateConsumerOperation =
    input.operation === "event-summary" ||
    input.operation === "event-context" ||
    input.operation === "event-type-detail" ||
    input.operation === "event-records" ||
    input.operation === "event-types" ||
    input.operation === "event-name-dimension" ||
    input.operation === "event-trend" ||
    input.operation === "event-fields" ||
    input.operation === "event-field-values" ||
    (input.operation === "page-dimension" &&
      input.allowPageFieldWholeFilterOptIn === true) ||
    input.operation === "pages-aggregate-page" ||
    eventCandidatePageReportOperation ||
    (input.operation === "filter-values" &&
      (filterValuesRequest?.reportKind === "event" ||
        (input.allowPrivateFilterValuesWholeFilterOptIn === true &&
          (filterValuesRequest?.reportKind === "page" ||
            filterValuesRequest?.reportKind === "referrer" ||
            filterValuesRequest?.reportKind === "session-boundary"))));
  const eventCandidateFiltersDescriptor = eventCandidateConsumerOperation
    ? ownDescriptor(query, "filters")
    : undefined;
  if (
    eventCandidateConsumerOperation &&
    eventCandidateFiltersDescriptor !== undefined &&
    (!eventCandidateFiltersDescriptor.enumerable ||
      !("value" in eventCandidateFiltersDescriptor))
  )
    throw invalidInput(
      "query",
      input.operation === "event-summary"
        ? "event_summary_qualification_request_context_mismatch"
        : input.operation === "event-context"
          ? "event_context_qualification_request_context_mismatch"
          : input.operation === "event-type-detail"
            ? "event_type_detail_qualification_request_context_mismatch"
            : input.operation === "event-records"
              ? "event_records_qualification_request_context_mismatch"
              : input.operation === "event-types"
                ? "event_types_qualification_request_context_mismatch"
                : input.operation === "filter-values"
                  ? "filter_values_request_context_mismatch"
                  : input.operation === "event-trend"
                    ? "event_trend_qualification_request_context_mismatch"
                    : input.operation === "event-fields"
                      ? "event_fields_qualification_request_context_mismatch"
                      : input.operation === "event-field-values"
                        ? "event_field_values_qualification_request_context_mismatch"
                        : input.operation === "page-dimension"
                          ? "page_dimension_request_context_mismatch"
                          : input.operation === "pages-aggregate-page"
                            ? "pages_aggregate_page_request_context_mismatch"
                            : input.operation === "pages-tabs"
                              ? "pages_tabs_request_context_mismatch"
                              : input.operation === "geo-points"
                                ? "geo_points_request_context_mismatch"
                                : input.operation === "channel-overview"
                                  ? "channel_overview_request_context_mismatch"
                                  : input.operation === "channel-list"
                                    ? "channel_list_request_context_mismatch"
                                    : input.operation === "referrers"
                                      ? "referrers_request_context_mismatch"
                                      : input.operation ===
                                          "session-boundary-dimension"
                                        ? "session_boundary_dimension_request_context_mismatch"
                                        : input.operation ===
                                            "session-boundary-overview-page"
                                          ? "session_boundary_overview_page_request_context_mismatch"
                                          : input.operation === "performance"
                                            ? "performance_qualification_request_context_mismatch"
                                            : input.operation ===
                                                "cross-dimension"
                                              ? "cross_dimension_qualification_request_changed"
                                              : input.operation === "radar"
                                                ? "radar_qualification_request_changed"
                                                : input.operation ===
                                                    "share-trend"
                                                  ? "share_trend_qualification_request_changed"
                                                  : "event_name_dimension_request_context_mismatch",
    );
  const eventCandidateFilters = eventCandidateConsumerOperation
    ? (ownDataValue(query, "filters") as FilterDocument | undefined)
    : undefined;
  const eventCandidateMetadata = eventCandidateConsumerOperation
    ? scopedFilterMetadata(eventCandidateFilters)
    : undefined;
  const eventCandidateRequestSnapshot = eventCandidateConsumerOperation
    ? qualificationRequestOwnDataSnapshot(query)
    : undefined;
  const eventNameDimensionRequest =
    input.operation === "event-name-dimension"
      ? (normalizeEventNameDimensionListRequest({
          mode: ownDataValue(query, "mode"),
          dimension: ownDataValue(query, "dimension"),
          page: ownDataValue(query, "page"),
          limit: ownDataValue(query, "limit"),
          search: ownDataValue(query, "search"),
          audience: query.context.policy.audience,
        }) ?? undefined)
      : undefined;
  const eventCandidateScopePlanMatches = eventCandidateMetadata
    ? queryScopePlanMatchesMetadata(query, eventCandidateMetadata.plan)
    : false;
  if (
    eventCandidateConsumerOperation &&
    eventCandidateMetadata?.plan.scope === "event" &&
    (eventCandidateRequestSnapshot === undefined ||
      !eventCandidateScopePlanMatches)
  )
    throw invalidInput(
      "query",
      input.operation === "event-summary"
        ? "event_summary_qualification_request_context_mismatch"
        : input.operation === "event-context"
          ? "event_context_qualification_request_context_mismatch"
          : input.operation === "event-type-detail"
            ? "event_type_detail_qualification_request_context_mismatch"
            : input.operation === "event-records"
              ? "event_records_qualification_request_context_mismatch"
              : input.operation === "event-types"
                ? "event_types_qualification_request_context_mismatch"
                : input.operation === "filter-values"
                  ? "filter_values_request_context_mismatch"
                  : input.operation === "event-trend"
                    ? "event_trend_qualification_request_context_mismatch"
                    : input.operation === "event-fields"
                      ? "event_fields_qualification_request_context_mismatch"
                      : input.operation === "event-field-values"
                        ? "event_field_values_qualification_request_context_mismatch"
                        : input.operation === "page-dimension"
                          ? "page_dimension_request_context_mismatch"
                          : input.operation === "pages-aggregate-page"
                            ? "pages_aggregate_page_request_context_mismatch"
                            : input.operation === "pages-tabs"
                              ? "pages_tabs_request_context_mismatch"
                              : input.operation === "geo-points"
                                ? "geo_points_request_context_mismatch"
                                : input.operation === "channel-overview"
                                  ? "channel_overview_request_context_mismatch"
                                  : input.operation === "channel-list"
                                    ? "channel_list_request_context_mismatch"
                                    : input.operation === "referrers"
                                      ? "referrers_request_context_mismatch"
                                      : input.operation ===
                                          "session-boundary-dimension"
                                        ? "session_boundary_dimension_request_context_mismatch"
                                        : input.operation ===
                                            "session-boundary-overview-page"
                                          ? "session_boundary_overview_page_request_context_mismatch"
                                          : input.operation === "performance"
                                            ? "performance_qualification_request_context_mismatch"
                                            : input.operation ===
                                                "cross-dimension"
                                              ? "cross_dimension_qualification_request_changed"
                                              : input.operation === "radar"
                                                ? "radar_qualification_request_changed"
                                                : input.operation ===
                                                    "share-trend"
                                                  ? "share_trend_qualification_request_changed"
                                                  : "event_name_dimension_request_context_mismatch",
    );
  const eventCandidateBaseRequest =
    eventCandidateMetadata?.plan.scope === "event" &&
    eventCandidateRequestSnapshot !== undefined &&
    ownDataValue(
      ownDataValue(ownDataValue(query, "context"), "policy"),
      "audience",
    ) === "private-dashboard" &&
    queryHasNoComparisonState(query) &&
    eventCandidateScopePlanMatches;
  const rawCandidateRequestTime = ownDataValue(query, "time");
  const eventCandidateRequestTimeMatches =
    rawCandidateRequestTime !== null &&
    typeof rawCandidateRequestTime === "object" &&
    eventCandidateMetadata?.time !== undefined &&
    sameEventFieldsQueryTime(
      rawCandidateRequestTime as QueryTime,
      eventCandidateMetadata.time,
    );
  const eventCandidatePageReportRequest =
    eventCandidatePageReportOperation &&
    eventCandidateBaseRequest &&
    eventCandidateRequestTimeMatches;
  if (
    eventCandidatePageReportOperation &&
    eventCandidateMetadata?.plan.scope === "event" &&
    !eventCandidateRequestTimeMatches
  )
    throw invalidInput(
      "time",
      input.operation === "geo-points"
        ? "geo_points_request_context_mismatch"
        : input.operation === "pages-tabs"
          ? "pages_tabs_request_context_mismatch"
          : input.operation === "channel-list"
            ? "channel_list_request_context_mismatch"
            : input.operation === "channel-overview"
              ? "channel_overview_request_context_mismatch"
              : input.operation === "referrers"
                ? "referrers_request_context_mismatch"
                : input.operation === "session-boundary-dimension"
                  ? "session_boundary_dimension_request_context_mismatch"
                  : input.operation === "session-boundary-overview-page"
                    ? "session_boundary_overview_page_request_context_mismatch"
                    : input.operation === "performance"
                      ? "performance_qualification_request_context_mismatch"
                      : input.operation === "cross-dimension"
                        ? "cross_dimension_qualification_request_changed"
                        : input.operation === "radar"
                          ? "radar_qualification_request_changed"
                          : "share_trend_qualification_request_changed",
    );
  if (
    eventCandidateMetadata?.plan.scope === "event" &&
    !eventCandidateRequestTimeMatches &&
    ((input.operation === "page-dimension" &&
      input.allowPageFieldWholeFilterOptIn === true) ||
      input.operation === "pages-aggregate-page" ||
      (input.operation === "filter-values" &&
        (filterValuesRequest?.reportKind === "page" ||
          filterValuesRequest?.reportKind === "referrer" ||
          filterValuesRequest?.reportKind === "session-boundary")))
  )
    throw invalidInput(
      "time",
      input.operation === "page-dimension"
        ? "page_dimension_request_context_mismatch"
        : input.operation === "pages-aggregate-page"
          ? "pages_aggregate_page_request_context_mismatch"
          : "filter_values_request_context_mismatch",
    );
  const eventCandidatePageRequest =
    input.operation === "event-types" &&
    eventCandidateBaseRequest &&
    ownDataValue(query, "mode") === undefined;
  const eventCandidateDimensionListRequest =
    input.operation === "event-name-dimension" &&
    input.allowEventNameDimensionEventCandidate === true &&
    eventCandidateBaseRequest &&
    eventNameDimensionRequest !== undefined;
  const eventCandidateFilterValuesRequest =
    input.operation === "filter-values" &&
    input.allowPrivateFilterValuesWholeFilterOptIn === true &&
    filterValuesRequest?.reportKind === "event" &&
    eventCandidateBaseRequest;
  const eventCandidatePageFilterValuesRequest =
    input.operation === "filter-values" &&
    input.allowPrivateFilterValuesWholeFilterOptIn === true &&
    (filterValuesRequest?.reportKind === "page" ||
      filterValuesRequest?.reportKind === "referrer" ||
      filterValuesRequest?.reportKind === "session-boundary") &&
    eventCandidateBaseRequest &&
    eventCandidateRequestTimeMatches;
  const eventCandidatePageDimensionRequest =
    input.operation === "page-dimension" &&
    input.allowPageFieldWholeFilterOptIn === true &&
    eventCandidateBaseRequest &&
    eventCandidateRequestTimeMatches &&
    ((rawPageDimensionRequest !== null &&
      isCanonicalPrivatePageDimensionWholeFilterRequest({
        mode: "breakdown",
        audience: rawRequestAudience,
        dimension: rawPageDimensionRequest.dimension,
        selection: rawPageDimensionRequest.selection,
        excludeEmpty: rawPageDimensionRequest.excludeEmpty,
      })) ||
      (rawOverviewPageTableRequest !== null &&
        rawOverviewPageDescriptor?.family === "page" &&
        isCanonicalPrivatePageDimensionWholeFilterRequest({
          mode: "overview-tab",
          audience: rawRequestAudience,
          tab: rawOverviewPageTableRequest.tab,
          overviewFamily: rawOverviewPageTableRequest.family,
          selection: rawOverviewPageTableRequest.selection,
          excludeEmpty: rawOverviewPageTableRequest.excludeEmpty,
        })) ||
      (rawReferrerOverviewRequest !== null &&
        rawRequestAudience === "private-dashboard" &&
        queryHasNoComparisonState(query)));
  const rawAggregateTime = ownDataValue(query, "time");
  const eventCandidatePagesAggregateRequest =
    input.operation === "pages-aggregate-page" &&
    eventCandidateBaseRequest &&
    eventCandidateRequestTimeMatches &&
    rawRequestAudience === "private-dashboard" &&
    ownDataValue(query, "mode") === undefined &&
    ownDataValue(query, "variant") !== "tabs" &&
    ownDataValue(query, "includeTabs") !== true &&
    rawAggregateTime !== null &&
    typeof rawAggregateTime === "object" &&
    eventCandidateMetadata?.time !== undefined &&
    sameEventFieldsQueryTime(
      rawAggregateTime as QueryTime,
      eventCandidateMetadata.time,
    );
  const eventCandidateEventTrendRequest =
    input.operation === "event-trend" &&
    eventCandidateBaseRequest &&
    input.eventTrendRequestSnapshot !== undefined &&
    eventCandidateRequestSnapshot === input.eventTrendRequestSnapshot;
  const eventCandidateSummaryRequest =
    input.operation === "event-summary" &&
    eventCandidateBaseRequest &&
    input.eventSummaryRequestSnapshot !== undefined &&
    eventCandidateRequestSnapshot === input.eventSummaryRequestSnapshot;
  const rawEventContextSelectedKeys =
    input.operation === "event-context"
      ? ownDataValue(query, "selectedKeys")
      : undefined;
  const eventCandidateContextRequest =
    input.operation === "event-context" &&
    eventCandidateBaseRequest &&
    (!Array.isArray(rawEventContextSelectedKeys) ||
      rawEventContextSelectedKeys.length > 0) &&
    input.eventContextRequestSnapshot !== undefined &&
    eventCandidateRequestSnapshot === input.eventContextRequestSnapshot;
  const eventCandidateTypeDetailRequest =
    input.operation === "event-type-detail" &&
    eventCandidateBaseRequest &&
    input.eventTypeDetailRequestSnapshot !== undefined &&
    eventCandidateRequestSnapshot === input.eventTypeDetailRequestSnapshot;
  const eventCandidateRecordsRequest =
    input.operation === "event-records" &&
    eventCandidateBaseRequest &&
    input.eventRecordsRequestSnapshot !== undefined &&
    eventCandidateRequestSnapshot === input.eventRecordsRequestSnapshot;
  const eventCandidateFieldsRequest =
    input.operation === "event-fields" &&
    eventCandidateBaseRequest &&
    input.eventPayloadRequestSnapshot !== undefined &&
    eventCandidateRequestSnapshot === input.eventPayloadRequestSnapshot &&
    (() => {
      const requestedLimit = ownDataValue(query, "limit");
      const limit =
        typeof requestedLimit === "number" && Number.isFinite(requestedLimit)
          ? requestedLimit
          : 100;
      return Number.isSafeInteger(limit) && limit >= 1 && limit <= 200;
    })();
  const eventCandidateFieldValuesRequest =
    input.operation === "event-field-values" &&
    eventCandidateBaseRequest &&
    input.eventPayloadRequestSnapshot !== undefined &&
    eventCandidateRequestSnapshot === input.eventPayloadRequestSnapshot &&
    (() => {
      const requestedType = ownDataValue(query, "fieldValueType");
      const fieldValueType =
        typeof requestedType === "string" ? requestedType : "";
      const requestedLimit = ownDataValue(query, "limit");
      const limit =
        typeof requestedLimit === "number" && Number.isFinite(requestedLimit)
          ? requestedLimit
          : 25;
      return (
        eventPayloadValueTypeCode(fieldValueType) !== null &&
        Number.isSafeInteger(limit) &&
        limit >= 1 &&
        limit <= 200
      );
    })();
  const eventCandidateRequest =
    eventCandidatePageRequest ||
    eventCandidatePageDimensionRequest ||
    eventCandidatePagesAggregateRequest ||
    eventCandidateDimensionListRequest ||
    eventCandidateFilterValuesRequest ||
    eventCandidatePageFilterValuesRequest ||
    eventCandidateSummaryRequest ||
    eventCandidateContextRequest ||
    eventCandidateTypeDetailRequest ||
    eventCandidateRecordsRequest ||
    eventCandidateEventTrendRequest ||
    eventCandidateFieldsRequest ||
    eventCandidateFieldValuesRequest ||
    eventCandidatePageReportRequest;
  const overviewTrendConfiguration =
    input.operation === "overview" || input.operation === "trend"
      ? overviewTrendConfigurationForQuery(input.operation, query)
      : undefined;
  const shareTrendConfiguration =
    input.operation === "share-trend" && hasSafeShareTrendQueryShape(query)
      ? normalizedShareTrendConfigurationFromQuery(query)
      : undefined;
  const radarConfiguration =
    input.operation === "radar" && hasSafeRadarQueryShape(query)
      ? technologyRadarQualificationConfigurationFromQuery(query)
      : undefined;
  const crossDimensionConfiguration =
    input.operation === "cross-dimension"
      ? technologyCrossDimensionQualificationConfigurationFromQuery(query)
      : undefined;
  const performanceQualificationConfiguration =
    input.operation === "performance"
      ? performanceQualificationConfigurationFromQuery(query)
      : undefined;
  const pagesDashboardQualificationConfiguration =
    input.operation === "pages-dashboard"
      ? pagesDashboardQualificationConfigurationFromQuery(query)
      : undefined;
  const geoPointsQualificationConfiguration =
    input.operation === "geo-points"
      ? geoPointsQualificationConfigurationFromQuery(query)
      : undefined;
  const retentionConfiguration =
    input.operation === "retention"
      ? retentionQualificationConfigurationFromQuery(query)
      : undefined;
  const sessionListRequest =
    input.operation === "sessions" || input.operation === "visitor-sessions"
      ? sessionListQualificationConfigurationFromQuery(query, input.operation)
      : undefined;
  const visitorListRequest =
    input.operation === "visitors"
      ? visitorListQualificationConfigurationFromQuery(query)
      : undefined;
  const journeyEventPageRequest =
    input.operation === "visitor-events" || input.operation === "session-events"
      ? journeyEventPageQualificationConfigurationFromQuery(
          query,
          input.operation,
        )
      : undefined;
  if (
    query.current !== undefined ||
    query.reference !== undefined ||
    query.context.subject.kind !== "site" ||
    ((input.operation === "overview" || input.operation === "trend") &&
      (overviewTrendConfiguration === undefined ||
        query.context.policy.audience !== "private-dashboard")) ||
    (input.operation === "share-trend" &&
      (shareTrendConfiguration === undefined ||
        query.context.policy.audience !== "private-dashboard")) ||
    (input.operation === "radar" &&
      (radarConfiguration === undefined ||
        query.context.policy.audience !== "private-dashboard")) ||
    (input.operation === "cross-dimension" &&
      (crossDimensionConfiguration === undefined ||
        query.context.policy.audience !== "private-dashboard")) ||
    (input.operation === "performance" &&
      (performanceQualificationConfiguration === undefined ||
        query.context.policy.audience !== "private-dashboard")) ||
    (input.operation === "pages-dashboard" &&
      pagesDashboardQualificationConfiguration === undefined) ||
    (input.operation === "geo-points" &&
      (geoPointsQualificationConfiguration === undefined ||
        query.context.policy.audience !== "private-dashboard" ||
        query.mode !== undefined ||
        query.comparison !== undefined ||
        query.current !== undefined ||
        query.reference !== undefined)) ||
    (input.operation === "filter-values" &&
      (filterValuesRequest === undefined ||
        query.context.policy.audience !== "private-dashboard" ||
        query.mode !== undefined ||
        query.comparison !== undefined ||
        query.current !== undefined ||
        query.reference !== undefined)) ||
    (input.operation === "retention" &&
      (retentionConfiguration === undefined ||
        query.context.policy.audience !== "private-dashboard" ||
        query.mode !== undefined ||
        query.comparison !== undefined ||
        query.current !== undefined ||
        query.reference !== undefined)) ||
    ((input.operation === "sessions" ||
      input.operation === "visitor-sessions") &&
      (sessionListRequest === undefined ||
        sessionListRequest.audience !== query.context.policy.audience)) ||
    (input.operation === "visitors" &&
      (visitorListRequest === undefined ||
        visitorListRequest.audience !== query.context.policy.audience)) ||
    ((input.operation === "visitor-events" ||
      input.operation === "session-events") &&
      (journeyEventPageRequest === undefined ||
        query.context.policy.audience !== "private-dashboard"))
  )
    return null;
  const filters = query.filters;
  if (!filters?.root || !filterDocumentUsesAdvancedExpressions(filters))
    return null;
  const allowWholeJourneyListFilter =
    (input.operation === "visitors" &&
      visitorListRequest !== undefined &&
      ((visitorListRequest.audience === "private-dashboard" &&
        (visitorListRequest.analysisContext === undefined ||
          visitorListRequest.analysisContext.type === "goal" ||
          visitorListRequest.analysisContext.type === "funnel")) ||
        (visitorListRequest.audience === "api-v1" &&
          visitorListRequest.analysisContext === undefined))) ||
    (input.operation === "sessions" &&
      sessionListRequest?.operation === "sessions" &&
      ((sessionListRequest.audience === "private-dashboard" &&
        (sessionListRequest.analysisContext === undefined ||
          sessionListRequest.analysisContext.type === "goal" ||
          sessionListRequest.analysisContext.type === "funnel")) ||
        (sessionListRequest.audience === "api-v1" &&
          sessionListRequest.analysisContext === undefined))) ||
    (input.operation === "visitor-sessions" &&
      sessionListRequest?.operation === "visitor-sessions" &&
      sessionListRequest.audience === "private-dashboard" &&
      sessionListRequest.analysisContext === undefined &&
      typeof sessionListRequest.visitorId === "string" &&
      sessionListRequest.visitorId.length > 0);
  const journeyListFilterResolution =
    visitorListRequest !== undefined || sessionListRequest !== undefined
      ? resolveJourneyListQualificationFilters(
          filters,
          allowWholeJourneyListFilter ? "allow-whole-filter" : "split-only",
        )
      : undefined;
  const journeyEventPageFilterResolution = journeyEventPageRequest
    ? resolveQualifiedSourceFilters(
        filters,
        journeyEventPageRequest.filterMode ?? "split-only",
      )
    : undefined;
  const filterValuesFilterResolution = filterValuesRequest
    ? resolveQualifiedSourceFilters(
        filters,
        input.allowPrivateFilterValuesWholeFilterOptIn === true
          ? "allow-whole-filter"
          : "split-only",
      )
    : undefined;
  const geoPointsWholeFilterOptIn =
    input.allowPrivateGeoPointsWholeFilterOptIn === true &&
    input.operation === "geo-points" &&
    geoPointsQualificationConfiguration !== undefined &&
    canonicalPrivateJourneyWholeFilterRequest(query, "geo-points", true);
  const retentionWholeFilterOptIn =
    input.allowPrivateRetentionWholeFilterOptIn === true &&
    input.operation === "retention" &&
    retentionConfiguration !== undefined &&
    canonicalPrivateJourneyWholeFilterRequest(query, "retention", true);
  const geoPointsFilterResolution =
    geoPointsQualificationConfiguration !== undefined
      ? resolveQualifiedSourceFilters(
          filters,
          geoPointsWholeFilterOptIn ? "allow-whole-filter" : "split-only",
        )
      : undefined;
  const retentionFilterResolution =
    retentionConfiguration !== undefined
      ? resolveQualifiedSourceFilters(
          filters,
          retentionWholeFilterOptIn ? "allow-whole-filter" : "split-only",
        )
      : undefined;
  const performanceFilterResolution = performanceQualificationConfiguration
    ? resolveQualifiedSourceFilters(
        filters,
        input.allowPrivatePerformanceWholeFilterOptIn === true
          ? "allow-whole-filter"
          : "split-only",
      )
    : undefined;
  const technologyFilterResolution =
    shareTrendConfiguration !== undefined ||
    radarConfiguration !== undefined ||
    crossDimensionConfiguration !== undefined
      ? resolveQualifiedSourceFilters(
          filters,
          input.allowPrivateTechnologyWholeFilterOptIn === true
            ? "allow-whole-filter"
            : "split-only",
        )
      : undefined;
  if (journeyEventPageRequest !== undefined) {
    if (journeyEventPageFilterResolution?.kind !== "supported") return null;
    if (
      (journeyEventPageFilterResolution.mode === "whole-filter") !==
      (journeyEventPageRequest.filterMode === "allow-whole-filter")
    )
      return null;
  }
  if (
    (input.operation === "performance" &&
      performanceFilterResolution?.kind !== "supported") ||
    ((input.operation === "share-trend" ||
      input.operation === "radar" ||
      input.operation === "cross-dimension") &&
      technologyFilterResolution?.kind !== "supported") ||
    (input.operation === "filter-values" &&
      filterValuesFilterResolution?.kind !== "supported") ||
    (geoPointsQualificationConfiguration !== undefined &&
      geoPointsFilterResolution?.kind !== "supported") ||
    (retentionConfiguration !== undefined &&
      retentionFilterResolution?.kind !== "supported")
  )
    return null;
  if (
    (visitorListRequest !== undefined || sessionListRequest !== undefined) &&
    journeyListFilterResolution?.kind !== "supported"
  )
    return null;
  const metadata = scopedFilterMetadata(filters);
  if (
    !metadata ||
    metadata.plan.preparedMembership !== undefined ||
    (metadata.plan.scope !== "session" &&
      metadata.plan.scope !== "visitor" &&
      !(metadata.plan.scope === "event" && eventCandidateRequest)) ||
    (metadata.plan.scope === "event" && !eventCandidateRequest) ||
    metadata.siteIds.length !== 1 ||
    metadata.siteIds[0] !== query.context.subject.siteId ||
    (eventCandidateRequest && !eventCandidateScopePlanMatches)
  )
    return null;
  const time = metadata.time;
  const requestTime = query.time as QueryTime | undefined;
  if (
    (input.operation === "performance" ||
      input.operation === "retention" ||
      visitorListRequest !== undefined ||
      journeyEventPageRequest !== undefined ||
      sessionListRequest !== undefined) &&
    (!requestTime || !sameEventFieldsQueryTime(requestTime, time))
  )
    return null;
  const pageDimensionRequestCandidate =
    input.operation === "page-dimension" && query.mode !== "overview-tab"
      ? normalizeDimensionPageRequest({
          dimension: typeof query.dimension === "string" ? query.dimension : "",
          page: query.page,
          limit: query.limit,
          sort: query.sort,
          search: query.search,
        })
      : null;
  const pageDimensionRequest = pageDimensionRequestCandidate
    ? Object.freeze({
        ...pageDimensionRequestCandidate,
        audience: query.context.policy.audience,
      })
    : undefined;
  const pagesAggregatePageRequestCandidate =
    input.operation === "pages-aggregate-page" &&
    query.mode === undefined &&
    query.variant !== "tabs" &&
    query.includeTabs !== true &&
    query.context.policy.audience === "private-dashboard" &&
    query.comparison === undefined &&
    query.current === undefined &&
    query.reference === undefined &&
    requestTime !== undefined &&
    sameEventFieldsQueryTime(requestTime, time)
      ? (() => {
          if (
            (query.variant !== undefined &&
              typeof query.variant !== "string") ||
            (query.includeTabs !== undefined &&
              typeof query.includeTabs !== "boolean")
          )
            return null;
          const page =
            query.page && typeof query.page === "object"
              ? (query.page as Record<string, unknown>)
              : {};
          const pageLimit = page.limit;
          const requestLimit = query.limit;
          const limit =
            typeof pageLimit === "number" && Number.isFinite(pageLimit)
              ? pageLimit
              : typeof requestLimit === "number" &&
                  Number.isFinite(requestLimit)
                ? requestLimit
                : 20;
          if (!Number.isSafeInteger(limit) || limit < 1) return null;
          return Object.freeze({
            limit,
            includeDetails: query.includeDetails === true,
            cursorText: typeof page.cursor === "string" ? page.cursor : null,
            audience: query.context.policy.audience,
            variant: query.variant as string | undefined,
            includeTabs: query.includeTabs as boolean | undefined,
          });
        })()
      : null;
  const pagesTabsRequestCandidate =
    input.operation === "pages-tabs" &&
    query.mode === undefined &&
    query.context.policy.audience === "private-dashboard" &&
    (query.variant === "tabs" || query.includeTabs === true) &&
    query.comparison === undefined &&
    query.current === undefined &&
    query.reference === undefined &&
    requestTime !== undefined &&
    sameEventFieldsQueryTime(requestTime, time)
      ? (() => {
          if (
            (query.variant !== undefined &&
              typeof query.variant !== "string") ||
            (query.includeTabs !== undefined &&
              typeof query.includeTabs !== "boolean") ||
            (query.includeDetails !== undefined &&
              typeof query.includeDetails !== "boolean") ||
            (query.page !== undefined &&
              (!query.page || typeof query.page !== "object"))
          )
            return null;
          const page =
            query.page && typeof query.page === "object"
              ? (query.page as Record<string, unknown>)
              : {};
          const tabsOnly = query.variant === "tabs";
          let limit: number;
          if (tabsOnly) {
            if (
              query.limit !== undefined &&
              (typeof query.limit !== "number" ||
                !Number.isSafeInteger(query.limit) ||
                query.limit < 1)
            )
              return null;
            limit = (query.limit as number | undefined) ?? 20;
          } else if (page.limit !== undefined) {
            if (
              typeof page.limit !== "number" ||
              !Number.isSafeInteger(page.limit) ||
              page.limit < 1
            )
              return null;
            limit = page.limit;
          } else {
            if (
              query.limit !== undefined &&
              (typeof query.limit !== "number" ||
                !Number.isSafeInteger(query.limit) ||
                query.limit < 1)
            )
              return null;
            limit = (query.limit as number | undefined) ?? 20;
          }
          return Object.freeze({
            configuration: tabsOnly ? "tabs-only" : "pages-with-tabs",
            limit,
            includeDetails: !tabsOnly && query.includeDetails === true,
            cursorText:
              !tabsOnly && typeof page.cursor === "string" ? page.cursor : null,
            audience: query.context.policy.audience,
            variant: query.variant as string | undefined,
            includeTabs: query.includeTabs as boolean | undefined,
          });
        })()
      : null;
  const pagesAggregatePageRequest =
    pagesAggregatePageRequestCandidate ?? undefined;
  if (input.operation === "pages-aggregate-page" && !pagesAggregatePageRequest)
    return null;
  const pagesTabsRequest = pagesTabsRequestCandidate ?? undefined;
  if (input.operation === "pages-tabs" && !pagesTabsRequest) return null;
  const overviewPageTableRequestCandidate =
    (input.operation === "page-dimension" &&
      query.mode === "overview-tab" &&
      query.comparison === undefined) ||
    (input.operation === "channel-overview" &&
      query.mode === "overview-tab" &&
      query.tab === "source.channel" &&
      query.context.policy.audience !== "public-share" &&
      query.comparison === undefined)
      ? normalizeOverviewPageTableRequest({
          operation:
            input.operation === "channel-overview" ? "channels" : "dimension",
          mode: query.mode,
          tab: query.tab,
          limit: query.limit,
          cursor: query.cursor,
          sort: query.sort,
          direction: query.direction,
          search: query.search,
        })
      : null;
  const overviewPageTableRequest =
    overviewPageTableRequestCandidate &&
    Number.isSafeInteger(overviewPageTableRequestCandidate.limit) &&
    overviewPageTableRequestCandidate.limit >= 1
      ? Object.freeze({
          ...overviewPageTableRequestCandidate,
          audience: query.context.policy.audience,
        })
      : undefined;
  const channelListRequestCandidate =
    input.operation === "channel-list" &&
    query.mode === "list" &&
    query.comparison === undefined &&
    query.context.policy.audience !== "public-share"
      ? (() => {
          const sourceLimit = query.limit;
          const limit = sourceLimit === undefined ? 100 : sourceLimit;
          if (
            typeof limit !== "number" ||
            !Number.isSafeInteger(limit) ||
            limit < 1
          )
            return null;
          return Object.freeze({
            mode: "list" as const,
            limit,
            sourceLimit: sourceLimit as number | undefined,
            audience: query.context.policy.audience,
            hasComparison: false as const,
            hasCurrent: false as const,
            hasReference: false as const,
          });
        })()
      : null;
  const channelListRequest = channelListRequestCandidate ?? undefined;
  const channelListWholeFilterOptIn =
    input.allowPrivateChannelListWholeFilterOptIn === true &&
    input.operation === "channel-list" &&
    privateChannelListWholeFilterOptIn(query, channelListRequest);
  const channelOverviewWholeFilterOptIn =
    input.allowPrivateChannelOverviewWholeFilterOptIn === true &&
    input.operation === "channel-overview" &&
    privateChannelOverviewWholeFilterOptIn(query, overviewPageTableRequest);
  const referrerOverviewRequestCandidate =
    rawReferrerOverviewRequest &&
    input.allowPageFieldWholeFilterOptIn === true &&
    queryHasNoComparisonState(query)
      ? rawReferrerOverviewRequest
      : undefined;
  const referrerOverviewRequest = referrerOverviewRequestCandidate
    ? Object.freeze({
        ...referrerOverviewRequestCandidate,
        audience: query.context.policy.audience,
      })
    : undefined;
  const referrersRequestCandidate =
    input.operation === "referrers" &&
    query.context.policy.audience === "private-dashboard" &&
    query.comparison === undefined &&
    query.current === undefined &&
    query.reference === undefined &&
    requestTime !== undefined &&
    sameEventFieldsQueryTime(requestTime, time)
      ? (() => {
          if (query.variant === "summary") {
            const topN =
              typeof query.topN === "number" && Number.isFinite(query.topN)
                ? query.topN
                : typeof query.limit === "number" &&
                    Number.isFinite(query.limit)
                  ? query.limit
                  : 5;
            if (!Number.isSafeInteger(topN) || topN < 0) return null;
            return Object.freeze({
              kind: "summary" as const,
              topN,
              audience: query.context.policy.audience,
            });
          }
          const page =
            query.page && typeof query.page === "object"
              ? (query.page as Record<string, unknown>)
              : {};
          const pageLimit = page.limit;
          const requestLimit = query.limit;
          const limit =
            typeof pageLimit === "number" && Number.isFinite(pageLimit)
              ? pageLimit
              : typeof requestLimit === "number" &&
                  Number.isFinite(requestLimit)
                ? requestLimit
                : 20;
          if (!Number.isSafeInteger(limit) || limit < 0) return null;
          return Object.freeze({
            kind: "page" as const,
            limit,
            cursorText: typeof page.cursor === "string" ? page.cursor : null,
            includeFullUrl: query.includeFullUrl === true,
            ...(typeof query.search === "string"
              ? { search: query.search }
              : {}),
            sortBy: query.sort === "visitors" ? "visitors" : "views",
            sortDirection: query.direction === "asc" ? "asc" : "desc",
            audience: query.context.policy.audience,
          });
        })()
      : null;
  const referrersRequest = referrersRequestCandidate ?? undefined;
  if (input.operation === "referrers" && !referrersRequest) return null;
  const sessionBoundaryDimensionRequest =
    input.operation === "session-boundary-dimension"
      ? (normalizeSessionBoundaryDimensionRequest({
          mode: query.mode,
          dimension: typeof query.dimension === "string" ? query.dimension : "",
          page: query.page,
          limit: query.limit,
          sort: query.sort,
          search: query.search,
          audience: query.context.policy.audience,
        }) ?? undefined)
      : undefined;
  const pagesDashboardRequest = pagesDashboardQualificationConfiguration;
  const sessionBoundaryOverviewPageRequestCandidate =
    input.operation === "session-boundary-overview-page" &&
    query.mode === "overview-tab" &&
    (query.tab === "page.entry" || query.tab === "page.exit") &&
    query.comparison === undefined &&
    query.current === undefined &&
    query.reference === undefined &&
    query.context.policy.audience !== "public-share"
      ? (() => {
          const kind = query.tab === "page.entry" ? "entry" : "exit";
          const limit =
            typeof query.limit === "number" && Number.isFinite(query.limit)
              ? query.limit
              : 100;
          if (!Number.isSafeInteger(limit) || limit < 1) return null;
          const sort =
            query.sort === "sessions" || query.sort === "visitors"
              ? query.sort
              : "views";
          return Object.freeze({
            mode: "overview-tab" as const,
            tab: query.tab,
            kind,
            dimension:
              kind === "entry"
                ? ("session.entryPath" as const)
                : ("session.exitPath" as const),
            limit,
            cursorToken:
              typeof query.cursor === "string" && query.cursor.length > 0
                ? query.cursor
                : null,
            ...(typeof query.search === "string" && query.search.length > 0
              ? { search: query.search }
              : {}),
            sortBy: sort,
            sortDirection: query.direction === "asc" ? "asc" : "desc",
            audience: query.context.policy.audience,
          });
        })()
      : null;
  const sessionBoundaryOverviewPageRequest =
    sessionBoundaryOverviewPageRequestCandidate
      ? Object.freeze(sessionBoundaryOverviewPageRequestCandidate)
      : undefined;
  const sessionBoundaryWholeFilterOptIn =
    privateSessionBoundaryWholeFilterOptIn(query, {
      allowedByMiddleware:
        input.allowPrivateSessionBoundaryWholeFilterOptIn === true,
      operation: input.operation,
      ...(sessionBoundaryDimensionRequest
        ? { dimensionRequest: sessionBoundaryDimensionRequest }
        : {}),
      ...(sessionBoundaryOverviewPageRequest
        ? { overviewPageRequest: sessionBoundaryOverviewPageRequest }
        : {}),
    });
  if (
    input.operation === "page-dimension" &&
    !pageDimensionRequest &&
    !overviewPageTableRequest &&
    !referrerOverviewRequest
  )
    return null;
  if (input.operation === "referrers" && !referrersRequest) return null;
  if (input.operation === "pages-dashboard" && !pagesDashboardRequest)
    return null;
  if (input.operation === "channel-overview" && !overviewPageTableRequest)
    return null;
  if (input.operation === "channel-list" && !channelListRequest) return null;
  if (
    input.operation === "session-boundary-dimension" &&
    !sessionBoundaryDimensionRequest
  )
    return null;
  if (
    input.operation === "session-boundary-overview-page" &&
    !sessionBoundaryOverviewPageRequest
  )
    return null;
  if (
    input.operation === "event-name-dimension" &&
    (!eventNameDimensionRequest ||
      !Number.isSafeInteger(eventNameDimensionRequest.limit) ||
      eventNameDimensionRequest.limit < 1)
  )
    return null;
  if (
    (input.operation === "page-dimension" ||
      input.operation === "referrers" ||
      input.operation === "pages-aggregate-page" ||
      input.operation === "pages-tabs" ||
      input.operation === "channel-overview" ||
      input.operation === "channel-list" ||
      input.operation === "session-boundary-dimension" ||
      input.operation === "session-boundary-overview-page" ||
      geoPointsQualificationConfiguration !== undefined ||
      pagesDashboardRequest !== undefined ||
      filterValuesRequest !== undefined ||
      visitorListRequest !== undefined ||
      journeyEventPageRequest !== undefined ||
      input.operation === "event-name-dimension" ||
      eventCandidateRequest ||
      radarConfiguration !== undefined ||
      shareTrendConfiguration !== undefined) &&
    input.expectedSiteId !== undefined &&
    input.expectedSiteId !== metadata.siteIds[0]
  )
    throw invalidInput(
      "siteId",
      input.operation === "share-trend"
        ? "share_trend_request_context_mismatch"
        : input.operation === "event-trend"
          ? "event_trend_qualification_request_context_mismatch"
          : input.operation === "event-summary"
            ? "event_summary_qualification_request_context_mismatch"
            : input.operation === "event-records"
              ? "event_records_qualification_request_context_mismatch"
              : input.operation === "radar"
                ? "radar_request_context_mismatch"
                : input.operation === "cross-dimension"
                  ? "cross_dimension_request_context_mismatch"
                  : input.operation === "performance"
                    ? `performance_${performanceQualificationConfiguration?.mode ?? "qualification"}_request_context_mismatch`
                    : input.operation === "event-name-dimension"
                      ? "event_name_dimension_request_context_mismatch"
                      : input.operation === "channel-overview"
                        ? "channel_overview_request_context_mismatch"
                        : input.operation === "channel-list"
                          ? "channel_list_request_context_mismatch"
                          : input.operation === "session-boundary-dimension"
                            ? "session_boundary_dimension_request_context_mismatch"
                            : input.operation ===
                                "session-boundary-overview-page"
                              ? "session_boundary_overview_page_request_context_mismatch"
                              : input.operation === "pages-aggregate-page"
                                ? "pages_aggregate_page_request_context_mismatch"
                                : input.operation === "pages-tabs"
                                  ? "pages_tabs_request_context_mismatch"
                                  : input.operation === "pages-dashboard"
                                    ? "pages_dashboard_request_context_mismatch"
                                    : input.operation === "geo-points"
                                      ? "geo_points_request_context_mismatch"
                                      : input.operation === "filter-values"
                                        ? "filter_values_request_context_mismatch"
                                        : input.operation === "referrers"
                                          ? "referrers_request_context_mismatch"
                                          : input.operation ===
                                                "visitor-events" ||
                                              input.operation ===
                                                "session-events"
                                            ? "journey_event_page_qualification_request_context_mismatch"
                                            : "page_dimension_request_context_mismatch",
    );
  const requestContextMismatchCode =
    input.operation === "share-trend"
      ? "share_trend_request_context_mismatch"
      : input.operation === "event-trend"
        ? "event_trend_qualification_request_context_mismatch"
        : input.operation === "event-summary"
          ? "event_summary_qualification_request_context_mismatch"
          : input.operation === "event-records"
            ? "event_records_qualification_request_context_mismatch"
            : input.operation === "radar"
              ? "radar_request_context_mismatch"
              : input.operation === "cross-dimension"
                ? "cross_dimension_qualification_request_changed"
                : input.operation === "performance"
                  ? "performance_qualification_request_context_mismatch"
                  : input.operation === "event-field-values"
                    ? "event_field_values_request_context_mismatch"
                    : input.operation === "channel-overview"
                      ? "channel_overview_request_context_mismatch"
                      : input.operation === "channel-list"
                        ? "channel_list_request_context_mismatch"
                        : input.operation === "page-dimension"
                          ? "page_dimension_request_context_mismatch"
                          : input.operation === "referrers"
                            ? "referrers_request_context_mismatch"
                            : input.operation === "pages-aggregate-page"
                              ? "pages_aggregate_page_request_context_mismatch"
                              : input.operation === "pages-tabs"
                                ? "pages_tabs_request_context_mismatch"
                                : input.operation === "event-name-dimension"
                                  ? "event_name_dimension_request_context_mismatch"
                                  : input.operation === "geo-points"
                                    ? "geo_points_request_context_mismatch"
                                    : input.operation ===
                                        "session-boundary-dimension"
                                      ? "session_boundary_dimension_request_context_mismatch"
                                      : input.operation ===
                                          "session-boundary-overview-page"
                                        ? "session_boundary_overview_page_request_context_mismatch"
                                        : input.operation === "pages-dashboard"
                                          ? "pages_dashboard_request_context_mismatch"
                                          : input.operation === "filter-values"
                                            ? "filter_values_request_context_mismatch"
                                            : input.operation === "visitors"
                                              ? "visitor_list_qualification_request_context_mismatch"
                                              : input.operation ===
                                                    "visitor-events" ||
                                                  input.operation ===
                                                    "session-events"
                                                ? "journey_event_page_qualification_request_context_mismatch"
                                                : input.operation ===
                                                      "overview" ||
                                                    input.operation === "trend"
                                                  ? "overview_trend_request_context_mismatch"
                                                  : "event_fields_request_context_mismatch";
  if (
    (input.operation === "event-fields" ||
      input.operation === "event-field-values" ||
      eventCandidateRequest ||
      pageDimensionRequest !== undefined ||
      pagesAggregatePageRequest !== undefined ||
      pagesTabsRequest !== undefined ||
      overviewPageTableRequest !== undefined ||
      channelListRequest !== undefined ||
      overviewTrendConfiguration !== undefined ||
      shareTrendConfiguration !== undefined ||
      radarConfiguration !== undefined ||
      referrerOverviewRequest !== undefined ||
      referrersRequest !== undefined ||
      sessionBoundaryDimensionRequest !== undefined ||
      sessionBoundaryOverviewPageRequest !== undefined ||
      pagesDashboardRequest !== undefined ||
      geoPointsQualificationConfiguration !== undefined ||
      filterValuesRequest !== undefined ||
      visitorListRequest !== undefined ||
      journeyEventPageRequest !== undefined ||
      eventNameDimensionRequest !== undefined) &&
    (!requestTime ||
      (pagesDashboardRequest ||
      geoPointsQualificationConfiguration ||
      filterValuesRequest
        ? !pagesDashboardOwnDataSnapshotsEqual(requestTime, time)
        : shareTrendConfiguration || radarConfiguration
          ? !sameShareTrendQueryTime(requestTime, time)
          : !sameEventFieldsQueryTime(requestTime, time)))
  )
    throw invalidInput("time", requestContextMismatchCode);
  if (
    (input.operation === "event-fields" ||
      input.operation === "event-field-values" ||
      eventCandidateRequest ||
      pageDimensionRequest !== undefined ||
      pagesAggregatePageRequest !== undefined ||
      pagesTabsRequest !== undefined ||
      overviewPageTableRequest !== undefined ||
      channelListRequest !== undefined ||
      overviewTrendConfiguration !== undefined ||
      shareTrendConfiguration !== undefined ||
      radarConfiguration !== undefined ||
      referrerOverviewRequest !== undefined ||
      referrersRequest !== undefined ||
      sessionBoundaryDimensionRequest !== undefined ||
      sessionBoundaryOverviewPageRequest !== undefined ||
      pagesDashboardRequest !== undefined ||
      geoPointsQualificationConfiguration !== undefined ||
      filterValuesRequest !== undefined ||
      visitorListRequest !== undefined ||
      journeyEventPageRequest !== undefined ||
      eventNameDimensionRequest !== undefined) &&
    query.scopePlan !== undefined &&
    (pagesDashboardRequest ||
    geoPointsQualificationConfiguration ||
    filterValuesRequest
      ? !pagesDashboardOwnDataSnapshotsEqual(query.scopePlan, metadata.plan)
      : shareTrendConfiguration || radarConfiguration
        ? !sameShareTrendScopePlan(
            query.scopePlan as ScopedFilterPlan,
            metadata.plan,
          )
        : eventCandidateRequest
          ? !eventCandidateScopePlanMatches
          : JSON.stringify(query.scopePlan) !== JSON.stringify(metadata.plan))
  )
    throw invalidInput("scopePlan", requestContextMismatchCode);
  const readRange = time.readRange ?? time.range;
  if (
    time.fullHistory === true ||
    time.filterRange !== undefined ||
    time.filterRangeEmpty === true ||
    !sameRange(readRange, time.range) ||
    !Number.isSafeInteger(time.range.startMs) ||
    !Number.isSafeInteger(time.range.endExclusiveMs) ||
    time.range.startMs >= time.range.endExclusiveMs ||
    time.range.endExclusiveMs > time.capturedAtMs + 1
  )
    return null;
  const pagesQualificationRequested =
    pagesAggregatePageRequest !== undefined ||
    pagesTabsRequest !== undefined ||
    pagesDashboardRequest !== undefined;
  const pagesFilterResolution = pagesQualificationRequested
    ? resolveQualifiedSourceFilters(filters, "allow-whole-filter")
    : undefined;
  if (
    pagesQualificationRequested &&
    pagesFilterResolution?.kind !== "supported"
  )
    return null;
  const referrersFilterResolution = referrersRequest
    ? resolveQualifiedSourceFilters(filters, "allow-whole-filter")
    : undefined;
  if (
    referrersRequest !== undefined &&
    referrersFilterResolution?.kind !== "supported"
  )
    return null;
  const pageDimensionWholeFilterOptIn =
    input.allowPageFieldWholeFilterOptIn === true &&
    privatePageDimensionWholeFilterOptIn(query, pageDimensionRequest);
  const pageDimensionFilterResolution = pageDimensionRequest
    ? resolveQualifiedSourceFilters(
        filters,
        pageDimensionWholeFilterOptIn ? "allow-whole-filter" : "split-only",
      )
    : undefined;
  if (
    pageDimensionRequest !== undefined &&
    pageDimensionFilterResolution?.kind !== "supported"
  )
    return null;
  const overviewPageWholeFilterOptIn =
    input.allowPageFieldWholeFilterOptIn === true &&
    input.operation === "page-dimension" &&
    privatePageOverviewWholeFilterOptIn(query, overviewPageTableRequest);
  const overviewPageFilterResolution =
    input.operation === "page-dimension" && overviewPageTableRequest
      ? resolveQualifiedSourceFilters(
          filters,
          overviewPageWholeFilterOptIn ? "allow-whole-filter" : "split-only",
        )
      : undefined;
  if (
    input.operation === "page-dimension" &&
    overviewPageTableRequest !== undefined &&
    overviewPageFilterResolution?.kind !== "supported"
  )
    return null;
  const eventCandidatePageDimensionProjectionRequest =
    eventCandidatePageDimensionRequest &&
    ((pageDimensionRequest !== undefined && pageDimensionWholeFilterOptIn) ||
      (overviewPageTableRequest !== undefined &&
        overviewPageTableRequest.family === "page" &&
        overviewPageWholeFilterOptIn) ||
      (referrerOverviewRequest !== undefined &&
        referrerOverviewRequest.audience === "private-dashboard"));
  if (
    eventCandidatePageDimensionRequest &&
    !eventCandidatePageDimensionProjectionRequest
  )
    return null;
  const channelListFilterResolution = channelListRequest
    ? resolveQualifiedSourceFilters(
        filters,
        channelListWholeFilterOptIn ? "allow-whole-filter" : "split-only",
      )
    : undefined;
  if (
    channelListRequest !== undefined &&
    channelListFilterResolution?.kind !== "supported"
  )
    return null;
  const channelOverviewFilterResolution =
    input.operation === "channel-overview" && overviewPageTableRequest
      ? resolveQualifiedSourceFilters(
          filters,
          channelOverviewWholeFilterOptIn ? "allow-whole-filter" : "split-only",
        )
      : undefined;
  if (
    input.operation === "channel-overview" &&
    overviewPageTableRequest !== undefined &&
    channelOverviewFilterResolution?.kind !== "supported"
  )
    return null;
  const referrerOverviewFilterResolution = referrerOverviewRequest
    ? resolveQualifiedSourceFilters(
        filters,
        referrerOverviewRequest.audience === "private-dashboard"
          ? "allow-whole-filter"
          : "split-only",
      )
    : undefined;
  if (
    referrerOverviewRequest !== undefined &&
    referrerOverviewFilterResolution?.kind !== "supported"
  )
    return null;
  const sessionBoundaryFilterResolution =
    sessionBoundaryDimensionRequest || sessionBoundaryOverviewPageRequest
      ? resolveQualifiedSourceFilters(
          filters,
          sessionBoundaryWholeFilterOptIn ? "allow-whole-filter" : "split-only",
        )
      : undefined;
  if (
    (sessionBoundaryDimensionRequest || sessionBoundaryOverviewPageRequest) &&
    sessionBoundaryFilterResolution?.kind !== "supported"
  )
    return null;
  const geoNativeSplit =
    geoPointsQualificationConfiguration !== undefined
      ? splitPageDimensionNativeFilters(filters)
      : undefined;
  const supportFilters = eventCandidateRequest
    ? filters
    : journeyListFilterResolution?.kind === "supported"
      ? journeyListFilterResolution.countFilters
      : journeyEventPageFilterResolution?.kind === "supported"
        ? journeyEventPageFilterResolution.countFilters
        : filterValuesFilterResolution?.kind === "supported"
          ? filterValuesFilterResolution.countFilters
          : geoPointsFilterResolution?.kind === "supported" &&
              geoPointsFilterResolution.mode === "whole-filter"
            ? geoPointsFilterResolution.countFilters
            : geoNativeSplit?.kind === "supported"
              ? geoNativeSplit.advancedFilters
              : filters;
  const allowPrivateQualifiedGeoBareFields =
    geoPointsWholeFilterOptIn &&
    geoPointsFilterResolution?.kind === "supported" &&
    geoPointsFilterResolution.mode === "whole-filter";
  // Deliberately classified without a time-leaf context: a top-level `time`
  // leaf needs an explicit expression window, which the fused single-statement
  // Count plans cannot carry (they require the exact candidate window). Such
  // requests stay undeferred, and the middleware evaluates their membership in
  // SQL through `evaluateForSitesCore`, which does pass the context.
  const executionPlan =
    metadata.plan.scope === "event"
      ? undefined
      : planAdvancedFilterExecution({
          subject: input.subject,
          filters: supportFilters,
          scope: metadata.plan.scope,
          time,
          reportFusionAvailable: true,
          ...(allowPrivateQualifiedGeoBareFields
            ? { allowPrivateQualifiedGeoBareFields: true as const }
            : {}),
        });
  const support =
    executionPlan?.support ??
    classifyAdvancedEventCandidateCountFilter(supportFilters);
  if (
    (executionPlan !== undefined &&
      executionPlan.decision.strategy !== "sql-report-fusion") ||
    support.kind !== "supported" ||
    advancedCountPayloadPaths(support.document.root!).length > 0 ||
    (input.operation === "channel-list" &&
      !channelListWholeFilterOptIn &&
      channelListHasUnsupportedBoolean(filters.root))
  )
    return null;
  if (
    ((input.operation === "channel-overview" &&
      overviewPageTableRequest !== undefined &&
      !channelOverviewWholeFilterOptIn) ||
      (channelListRequest !== undefined && !channelListWholeFilterOptIn) ||
      overviewTrendConfiguration) &&
    splitPageDimensionNativeFilters(filters).kind !== "supported"
  )
    return null;
  if (
    (visitorListRequest !== undefined || sessionListRequest !== undefined) &&
    journeyListFilterResolution?.kind !== "supported"
  )
    return null;
  let eventNameDimensionReportFilters: FilterDocument | undefined;
  let filterValuesReportFilters: FilterDocument | undefined;
  if (eventNameDimensionRequest && !eventCandidateDimensionListRequest) {
    const split = splitPageDimensionNativeFilters(filters);
    if (split.kind === "unsupported") return null;
    const nativeScopePlan = createScopedFilterPlan(
      "dimension",
      split.filters,
      metadata.plan.scope,
    );
    if (!nativeScopePlan || nativeScopePlan.scope !== metadata.plan.scope)
      return null;
    eventNameDimensionReportFilters = attachScopedFilterMetadata(
      split.filters,
      {
        ...metadata,
        requestedScope: metadata.plan.scope,
        resolvedScope: nativeScopePlan.scope,
        plan: nativeScopePlan,
      },
    );
  }
  if (
    filterValuesRequest?.reportKind === "event" &&
    !eventCandidateFilterValuesRequest
  ) {
    const filterResolution = filterValuesFilterResolution;
    if (filterResolution?.kind !== "supported") return null;
    const nativeScopePlan = createScopedFilterPlan(
      "dimension",
      filterResolution.nativeFilters,
      metadata.plan.scope,
    );
    if (!nativeScopePlan || nativeScopePlan.scope !== metadata.plan.scope)
      return null;
    filterValuesReportFilters = attachScopedFilterMetadata(
      filterResolution.nativeFilters,
      {
        ...metadata,
        requestedScope: metadata.plan.scope,
        resolvedScope: nativeScopePlan.scope,
        plan: nativeScopePlan,
      },
    );
  }
  if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const eventFieldsRequest =
    input.operation === "event-fields"
      ? (() => {
          const rawEventName =
            typeof query.eventName === "string" ? query.eventName : "";
          const limit =
            typeof query.limit === "number" && Number.isFinite(query.limit)
              ? query.limit
              : 100;
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
            throw invalidInput("limit", "invalid_event_fields_limit");
          return Object.freeze({
            ...(rawEventName ? { eventName: rawEventName } : {}),
            limit,
            cursor:
              typeof query.cursor === "string" && query.cursor.length > 0
                ? query.cursor
                : null,
            audience: query.context.policy.audience,
          });
        })()
      : undefined;
  const eventFieldValuesRequest =
    input.operation === "event-field-values"
      ? (() => {
          const fieldPath =
            typeof query.fieldPath === "string" ? query.fieldPath : "";
          const fieldValueType =
            typeof query.fieldValueType === "string"
              ? query.fieldValueType
              : "";
          if (eventPayloadValueTypeCode(fieldValueType) === null) return null;
          const limit =
            typeof query.limit === "number" && Number.isFinite(query.limit)
              ? query.limit
              : 25;
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
            return null;
          const rawEventName =
            typeof query.eventName === "string" ? query.eventName : "";
          const rawSearch =
            typeof query.search === "string" ? query.search : "";
          return Object.freeze({
            ...(rawEventName ? { eventName: rawEventName } : {}),
            fieldPath,
            fieldValueType,
            ...(rawSearch ? { search: rawSearch } : {}),
            limit,
            cursor:
              typeof query.cursor === "string" && query.cursor.length > 0
                ? query.cursor
                : null,
            audience: query.context.policy.audience,
          });
        })()
      : undefined;
  if (input.operation === "event-field-values" && !eventFieldValuesRequest)
    return null;
  const siteId = metadata.siteIds[0]!;
  // This branch is reached only after the original fusion/Count/no-payload and
  // channel request gates above. It does not admit Seq-only or Core requests.
  // Late root changes on an already admitted request are read by Stage 0 at the
  // original fallback checkpoint, not rejected by a fresh Count-only gate.
  const channelMembershipInvocation =
    ((input.operation === "channel-list" && channelListRequest !== undefined) ||
      (input.operation === "page-dimension" &&
        pageDimensionRequest !== undefined)) &&
    query.context.policy.audience === "private-dashboard" &&
    input.subject.origin === "site" &&
    input.subject.siteIds.length === 1 &&
    input.subject.siteIds[0] === siteId &&
    metadata.plan.mode === "entity" &&
    (metadata.plan.scope === "session" || metadata.plan.scope === "visitor")
      ? (input.operation === "channel-list"
          ? createChannelsWholeMembershipInvocation
          : createPageWholeMembershipInvocation)({
          env: input.env,
          subject: input.subject,
          filters,
          queryTime: time,
          scope: metadata.plan.scope,
          ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        })
      : undefined;
  // This is the existing Count-admitted deferred branch. Select only the
  // already closed one-plan Event readers; application exposure is unchanged.
  const deferredWholeConsumer =
    (input.operation === "event-summary" ||
      input.operation === "event-types" ||
      input.operation === "event-fields" ||
      input.operation === "event-field-values" ||
      input.operation === "event-records") &&
    input.subject.origin === "site" &&
    input.subject.siteIds.length === 1 &&
    input.subject.siteIds[0] === siteId &&
    ((metadata.plan.mode === "entity" &&
      (metadata.plan.scope === "session" ||
        metadata.plan.scope === "visitor")) ||
      (metadata.plan.mode === "observation" && metadata.plan.scope === "event"))
      ? Object.freeze({ kind: input.operation })
      : undefined;
  const wholeOriginalMembershipInvocation = deferredWholeConsumer
    ? createDeferredWholeOriginalCompletionMembershipInvocation({
        env: input.env,
        subject: input.subject,
        filters,
        queryTime: time,
        scope: metadata.plan.scope,
        originalScopePlan: metadata.plan,
        ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      })
    : undefined;
  const coverageInvocation =
    channelMembershipInvocation ?? wholeOriginalMembershipInvocation;
  const coverage = await (coverageInvocation
    ? coverageInvocation.readCoverageAtOriginalCheckpoint()
    : siteCoverage(input.env, [siteId], input.diagnostics, input.signal));
  if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const createdAt = coverage.get(siteId);
  if (createdAt === undefined || readRange.startMs < createdAt)
    throw invalidInput("readRange", "filter_evaluation_range_unavailable");
  const countInput: AdvancedCountQualificationPlanInput = {
    subject: semanticSubjectForAuthorizedSubset(
      input.subject,
      [siteId],
      "activity",
    ),
    candidateRange: time.range,
    readRange,
    expressionRange: time.range,
    expressionUsesExplicitRange: false,
    lowerBounds: [{ siteId, startMs: readRange.startMs }],
    ...(metadata.plan.scope === "event"
      ? {
          scope: "event" as const,
          candidateAnchor: { kind: "event-candidate" as const },
        }
      : { scope: metadata.plan.scope }),
    reportingTimeZone: time.reportingTimeZone,
    capturedAtMs: time.capturedAtMs,
    analysis: support.analysis,
    numericCompatibilityRequirements: support.numericCompatibilityRequirements,
    ...(allowPrivateQualifiedGeoBareFields
      ? { allowPrivateQualifiedGeoBareFields: true as const }
      : {}),
  };
  recordScopedFilterDiagnostics(input.diagnostics, metadata);
  const eventContextRequest =
    input.operation === "event-context"
      ? (() => {
          const rawKeys = Array.isArray(query.selectedKeys)
            ? query.selectedKeys
            : EVENT_CONTEXT_CARD_KEYS;
          const keySet = new Set(
            rawKeys.filter(
              (key): key is EventContextCardKey =>
                typeof key === "string" &&
                EVENT_CONTEXT_CARD_KEYS.includes(key as EventContextCardKey),
            ),
          );
          const selectedKeys = EVENT_CONTEXT_CARD_KEYS.filter((key) =>
            keySet.has(key),
          );
          return Object.freeze({
            eventName:
              typeof query.eventName === "string" ? query.eventName : "",
            limit:
              typeof query.limit === "number" && Number.isFinite(query.limit)
                ? query.limit
                : 100,
            selectedKeys: Object.freeze(selectedKeys),
          });
        })()
      : undefined;
  const eventTypeDetailRequest =
    input.operation === "event-type-detail"
      ? (() => {
          const rawKeys = Array.isArray(query.selectedKeys)
            ? query.selectedKeys
            : EVENT_CONTEXT_CARD_KEYS;
          const keySet = new Set(
            rawKeys.filter(
              (key): key is EventContextCardKey =>
                typeof key === "string" &&
                EVENT_CONTEXT_CARD_KEYS.includes(key as EventContextCardKey),
            ),
          );
          const selectedKeys = EVENT_CONTEXT_CARD_KEYS.filter((key) =>
            keySet.has(key),
          );
          return Object.freeze({
            eventName:
              typeof query.eventName === "string" ? query.eventName : "",
            interval:
              typeof query.interval === "string"
                ? (query.interval as CalendarGranularity)
                : ("day" as const),
            includeBreakdowns: query.includeBreakdowns !== false,
            includeContext: query.includeContext !== false,
            contextLimit:
              typeof query.contextLimit === "number" &&
              Number.isFinite(query.contextLimit)
                ? query.contextLimit
                : 100,
            selectedKeys: Object.freeze(selectedKeys),
          });
        })()
      : undefined;
  const eventRecordsRequest =
    input.operation === "event-records"
      ? (() => {
          const page =
            query.page && typeof query.page === "object"
              ? (query.page as Record<string, unknown>)
              : undefined;
          const search =
            typeof query.search === "string"
              ? query.search.trim() || undefined
              : undefined;
          const eventName =
            typeof query.eventName === "string"
              ? query.eventName.trim() || undefined
              : undefined;
          return Object.freeze({
            ...(search ? { search } : {}),
            ...(eventName ? { eventName } : {}),
            sort: Object.freeze({
              field: "occurredAt" as const,
              direction:
                (query.sort as { direction?: unknown } | undefined)
                  ?.direction === "asc"
                  ? ("asc" as const)
                  : ("desc" as const),
            }),
            page: Object.freeze({
              limit:
                typeof page?.limit === "number"
                  ? page.limit
                  : typeof query.limit === "number"
                    ? query.limit
                    : 80,
              cursor:
                typeof page?.cursor === "string" || page?.cursor === null
                  ? page.cursor
                  : null,
            }),
            audience: query.context.policy.audience,
          });
        })()
      : undefined;
  const deferredBase = {
    operation: input.operation,
    env: input.env,
    siteId,
    filters,
    metadata,
    time,
    ...(query.time ? { requestTime: query.time as QueryTime } : {}),
    ...(query.scopePlan
      ? { requestScopePlan: query.scopePlan as ScopedFilterPlan }
      : {}),
    subject: input.subject,
    coverage,
    ...(channelMembershipInvocation ? { channelMembershipInvocation } : {}),
    ...(deferredWholeConsumer && wholeOriginalMembershipInvocation
      ? {
          wholeOriginalMembership: Object.freeze({
            consumer: deferredWholeConsumer,
            invocation: wholeOriginalMembershipInvocation,
          }),
        }
      : {}),
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(eventContextRequest ? { eventContextRequest } : {}),
    ...(eventTypeDetailRequest ? { eventTypeDetailRequest } : {}),
    ...(eventRecordsRequest ? { eventRecordsRequest } : {}),
    ...(eventFieldsRequest ? { eventFieldsRequest } : {}),
    ...(eventFieldValuesRequest ? { eventFieldValuesRequest } : {}),
    ...(eventNameDimensionRequest
      ? {
          eventNameDimensionRequest,
          ...(eventNameDimensionReportFilters
            ? { eventNameDimensionReportFilters }
            : {}),
        }
      : {}),
    ...(pageDimensionRequest ? { pageDimensionRequest } : {}),
    ...(geoPointsFilterResolution?.kind === "supported" &&
    geoPointsFilterResolution.mode === "whole-filter"
      ? { geoPointsFilterMode: "allow-whole-filter" as const }
      : {}),
    ...(retentionFilterResolution?.kind === "supported" &&
    retentionFilterResolution.mode === "whole-filter"
      ? { retentionFilterMode: "allow-whole-filter" as const }
      : {}),
    ...(pageDimensionWholeFilterOptIn ||
    overviewPageWholeFilterOptIn ||
    channelOverviewWholeFilterOptIn
      ? { pageDimensionFilterMode: "allow-whole-filter" as const }
      : {}),
    ...(input.allowPrivatePerformanceWholeFilterOptIn === true &&
    performanceFilterResolution?.kind === "supported" &&
    performanceFilterResolution.mode === "whole-filter"
      ? { performanceFilterMode: "allow-whole-filter" as const }
      : {}),
    ...(input.allowPrivateTechnologyWholeFilterOptIn === true &&
    technologyFilterResolution?.kind === "supported" &&
    technologyFilterResolution.mode === "whole-filter"
      ? { technologyFilterMode: "allow-whole-filter" as const }
      : {}),
    ...(referrersRequest ? { referrersRequest } : {}),
    ...(pagesAggregatePageRequest ? { pagesAggregatePageRequest } : {}),
    ...(pagesTabsRequest ? { pagesTabsRequest } : {}),
    ...(overviewPageTableRequest ? { overviewPageTableRequest } : {}),
    ...(channelListRequest ? { channelListRequest } : {}),
    ...(channelListWholeFilterOptIn
      ? { channelListFilterMode: "allow-whole-filter" as const }
      : {}),
    ...(referrerOverviewRequest ? { referrerOverviewRequest } : {}),
    ...(sessionBoundaryDimensionRequest
      ? { sessionBoundaryDimensionRequest }
      : {}),
    ...(sessionBoundaryOverviewPageRequest
      ? { sessionBoundaryOverviewPageRequest }
      : {}),
    ...(sessionBoundaryFilterResolution?.kind === "supported" &&
    sessionBoundaryFilterResolution.mode === "whole-filter"
      ? { sessionBoundaryFilterMode: "allow-whole-filter" as const }
      : {}),
    ...(pagesDashboardRequest ? { pagesDashboardRequest } : {}),
    ...(filterValuesRequest ? { filterValuesRequest } : {}),
    ...(filterValuesFilterResolution?.kind === "supported"
      ? {
          filterValuesFilterMode:
            eventCandidateFilterValuesRequest ||
            eventCandidatePageFilterValuesRequest ||
            filterValuesFilterResolution.mode === "whole-filter"
              ? ("allow-whole-filter" as const)
              : ("split-only" as const),
        }
      : {}),
    ...(filterValuesReportFilters ? { filterValuesReportFilters } : {}),
    ...(visitorListRequest ? { visitorListRequest } : {}),
    ...(sessionListRequest ? { sessionListRequest } : {}),
    ...(journeyEventPageRequest ? { journeyEventPageRequest } : {}),
  };
  const deferred:
    | DeferredEventQualification
    | DeferredEventSummaryQualification
    | DeferredEventRecordsQualification
    | DeferredEventFieldsQualification
    | DeferredEventFieldValuesQualification
    | DeferredEventTypesQualification
    | DeferredEventNameDimensionQualification
    | DeferredEventTrendQualification
    | DeferredEventContextQualification
    | DeferredEventTypeDetailQualification
    | DeferredPageQualification
    | DeferredPagesAggregatePageQualification
    | DeferredPagesTabsQualification
    | DeferredEventCandidatePageProjectionFor<
        | "cross-dimension"
        | "radar"
        | "share-trend"
        | "performance"
        | "geo-points"
        | "pages-tabs"
        | "referrers"
        | "channel-overview"
        | "channel-list"
        | "session-boundary-dimension"
        | "session-boundary-overview-page"
      >
    | DeferredFilterValuesQualificationInput
    | null = eventCandidatePageReportRequest
    ? (Object.freeze({
        ...deferredBase,
        countInput: countInput as AdvancedEventCandidateCountPlanInput,
        eventCandidateReportProjection: "page-visits" as const,
      }) as DeferredEventCandidatePageProjectionFor<
        | "cross-dimension"
        | "radar"
        | "share-trend"
        | "performance"
        | "geo-points"
        | "pages-tabs"
        | "referrers"
        | "channel-overview"
        | "channel-list"
        | "session-boundary-dimension"
        | "session-boundary-overview-page"
      >)
    : eventCandidateSummaryRequest
      ? (Object.freeze({
          ...deferredBase,
          operation: "event-summary" as const,
          countInput: countInput as AdvancedEventCandidateCountPlanInput,
        }) as DeferredEventSummaryQualification)
      : eventCandidateRecordsRequest
        ? (Object.freeze({
            ...deferredBase,
            operation: "event-records" as const,
            countInput: countInput as AdvancedEventCandidateCountPlanInput,
            eventRecordsRequest: eventRecordsRequest!,
          }) as DeferredEventRecordsQualification)
        : eventCandidateFieldsRequest
          ? (Object.freeze({
              ...deferredBase,
              operation: "event-fields" as const,
              countInput: countInput as AdvancedEventCandidateCountPlanInput,
              eventFieldsRequest: eventFieldsRequest!,
            }) as DeferredEventFieldsQualification)
          : eventCandidateFieldValuesRequest
            ? (Object.freeze({
                ...deferredBase,
                operation: "event-field-values" as const,
                countInput: countInput as AdvancedEventCandidateCountPlanInput,
                eventFieldValuesRequest: eventFieldValuesRequest!,
              }) as DeferredEventFieldValuesQualification)
            : eventCandidateEventTrendRequest
              ? (Object.freeze({
                  ...deferredBase,
                  operation: "event-trend" as const,
                  countInput:
                    countInput as AdvancedEventCandidateCountPlanInput,
                }) as DeferredEventTrendQualification)
              : eventCandidateContextRequest
                ? (Object.freeze({
                    ...deferredBase,
                    operation: "event-context" as const,
                    countInput:
                      countInput as AdvancedEventCandidateCountPlanInput,
                    eventContextRequest: eventContextRequest!,
                  }) as DeferredEventContextQualification)
                : eventCandidateTypeDetailRequest
                  ? (Object.freeze({
                      ...deferredBase,
                      operation: "event-type-detail" as const,
                      countInput:
                        countInput as AdvancedEventCandidateCountPlanInput,
                      eventTypeDetailRequest: eventTypeDetailRequest!,
                    }) as DeferredEventTypeDetailQualification)
                  : eventCandidatePageRequest
                    ? (Object.freeze({
                        ...deferredBase,
                        operation: "event-types" as const,
                        countInput:
                          countInput as AdvancedEventCandidateCountPlanInput,
                      }) as DeferredEventTypesQualification)
                    : eventCandidateDimensionListRequest
                      ? (Object.freeze({
                          ...deferredBase,
                          operation: "event-name-dimension" as const,
                          countInput:
                            countInput as AdvancedEventCandidateCountPlanInput,
                        }) as DeferredEventNameDimensionQualification)
                      : eventCandidateFilterValuesRequest
                        ? (Object.freeze({
                            ...deferredBase,
                            operation: "filter-values" as const,
                            countInput:
                              countInput as AdvancedEventCandidateCountPlanInput,
                          }) as DeferredFilterValuesQualificationInput)
                        : eventCandidatePageFilterValuesRequest
                          ? (Object.freeze({
                              ...deferredBase,
                              operation: "filter-values" as const,
                              countInput:
                                countInput as AdvancedEventCandidateCountPlanInput,
                              eventCandidateReportProjection:
                                "page-visits" as const,
                              filterValuesFilterMode:
                                "allow-whole-filter" as const,
                            }) as DeferredFilterValuesQualificationInput)
                          : eventCandidatePageDimensionProjectionRequest
                            ? (Object.freeze({
                                ...deferredBase,
                                operation: "page-dimension" as const,
                                countInput:
                                  countInput as AdvancedEventCandidateCountPlanInput,
                                eventCandidateReportProjection:
                                  "page-visits" as const,
                              }) as DeferredPageQualification)
                            : eventCandidatePagesAggregateRequest &&
                                pagesAggregatePageRequest !== undefined
                              ? (Object.freeze({
                                  ...deferredBase,
                                  operation: "pages-aggregate-page" as const,
                                  countInput:
                                    countInput as AdvancedEventCandidateCountPlanInput,
                                  eventCandidateReportProjection:
                                    "page-visits" as const,
                                }) as DeferredPagesAggregatePageQualification)
                              : countInput.scope !== "event"
                                ? (Object.freeze({
                                    ...deferredBase,
                                    countInput,
                                  }) as DeferredEventQualification)
                                : null;
  if (!deferred) return null;
  deferredEventQualifications.add(deferred);
  channelMembershipInvocation?.retainDeferredOwnerAtOriginalConstruction(
    deferred,
  );
  wholeOriginalMembershipInvocation?.retainDeferredOwnerAtOriginalConstruction(
    deferred,
  );
  deferredPageVisitEligibility.set(
    deferred,
    Object.freeze({
      audience: query.context.policy.audience,
      performancePrivateOptIn:
        input.allowPrivatePerformanceWholeFilterOptIn === true,
      geoPointsPrivateOptIn:
        input.allowPrivateGeoPointsWholeFilterOptIn === true,
      technologyPrivateOptIn:
        input.allowPrivateTechnologyWholeFilterOptIn === true,
    }),
  );
  if (executionPlan)
    recordAdvancedFilterExecution(input.diagnostics, executionPlan.decision);
  return deferred;
}

function sameEventFieldsQueryTime(left: QueryTime, right: QueryTime): boolean {
  const leftRead = left.readRange ?? left.range;
  const rightRead = right.readRange ?? right.range;
  return (
    left.range.startMs === right.range.startMs &&
    left.range.endExclusiveMs === right.range.endExclusiveMs &&
    leftRead.startMs === rightRead.startMs &&
    leftRead.endExclusiveMs === rightRead.endExclusiveMs &&
    JSON.stringify(left.filterRange) === JSON.stringify(right.filterRange) &&
    left.filterRangeEmpty === right.filterRangeEmpty &&
    left.fullHistory === right.fullHistory &&
    left.reportingTimeZone === right.reportingTimeZone &&
    left.capturedAtMs === right.capturedAtMs
  );
}

/** Read a branded request-local qualification for its matching operation. */
export function deferredEventQualificationFromQuery(
  input: unknown,
  operation: "event-summary",
): DeferredEventSummaryQualification | undefined;
export function deferredEventQualificationFromQuery(
  input: unknown,
  operation: "event-records",
): DeferredEventRecordsQualification | undefined;
export function deferredEventQualificationFromQuery(
  input: unknown,
  operation: "event-fields",
): DeferredEventFieldsQualification | undefined;
export function deferredEventQualificationFromQuery(
  input: unknown,
  operation: "event-field-values",
): DeferredEventFieldValuesQualification | undefined;
export function deferredEventQualificationFromQuery(
  input: unknown,
  operation: "event-types",
): DeferredEventTypesQualification | undefined;
export function deferredEventQualificationFromQuery(
  input: unknown,
  operation: "event-name-dimension",
): DeferredEventNameDimensionQualification | undefined;
export function deferredEventQualificationFromQuery(
  input: unknown,
  operation: "event-trend",
): DeferredEventTrendQualification | undefined;
export function deferredEventQualificationFromQuery(
  input: unknown,
  operation: "event-context",
): DeferredEventContextQualification | undefined;
export function deferredEventQualificationFromQuery(
  input: unknown,
  operation: "event-type-detail",
): DeferredEventTypeDetailQualification | undefined;
export function deferredEventQualificationFromQuery(
  input: unknown,
  operation: "page-dimension",
): DeferredPageQualification | undefined;
export function deferredEventQualificationFromQuery(
  input: unknown,
  operation: "pages-aggregate-page",
): DeferredPagesAggregatePageQualification | undefined;
export function deferredEventQualificationFromQuery(
  input: unknown,
  operation: "pages-tabs",
): DeferredPagesTabsQualification | undefined;
export function deferredEventQualificationFromQuery<
  Operation extends EventCandidatePageReportOperation,
>(
  input: unknown,
  operation: Operation,
):
  | (DeferredEventQualification & { readonly operation: Operation })
  | DeferredEventCandidatePageProjectionFor<Operation>
  | undefined;
export function deferredEventQualificationFromQuery(
  input: unknown,
  operation: Exclude<
    DeferredEventQualificationOperation,
    | "event-summary"
    | "event-records"
    | "event-fields"
    | "event-field-values"
    | "event-types"
    | "event-name-dimension"
    | "event-trend"
    | "event-context"
    | "event-type-detail"
    | "page-dimension"
    | "pages-aggregate-page"
    | "pages-tabs"
    | EventCandidatePageReportOperation
  >,
): DeferredEventQualification | undefined;
export function deferredEventQualificationFromQuery(
  input: unknown,
  operation: DeferredEventQualificationOperation,
):
  | DeferredEventQualification
  | DeferredEventSummaryQualification
  | DeferredEventRecordsQualification
  | DeferredEventFieldsQualification
  | DeferredEventFieldValuesQualification
  | DeferredEventTypesQualification
  | DeferredEventNameDimensionQualification
  | DeferredEventTrendQualification
  | DeferredEventContextQualification
  | DeferredEventTypeDetailQualification
  | DeferredPageQualification
  | DeferredPagesAggregatePageQualification
  | DeferredPagesTabsQualification
  | DeferredEventCandidatePageProjectionFor<EventCandidatePageReportOperation>
  | DeferredFilterValuesQualificationInput
  | undefined;
export function deferredEventQualificationFromQuery(
  input: unknown,
  operation: DeferredEventQualificationOperation,
):
  | DeferredEventQualification
  | DeferredEventSummaryQualification
  | DeferredEventRecordsQualification
  | DeferredEventFieldsQualification
  | DeferredEventFieldValuesQualification
  | DeferredEventTypesQualification
  | DeferredEventNameDimensionQualification
  | DeferredEventTrendQualification
  | DeferredEventContextQualification
  | DeferredEventTypeDetailQualification
  | DeferredPageQualification
  | DeferredPagesAggregatePageQualification
  | DeferredPagesTabsQualification
  | DeferredEventCandidatePageProjectionFor<EventCandidatePageReportOperation>
  | DeferredFilterValuesQualificationInput
  | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<PropertyKey, unknown>)[
    DEFERRED_EVENT_QUALIFICATION
  ];
  return value &&
    typeof value === "object" &&
    deferredEventQualifications.has(value) &&
    (value as DeferredEventQualification | DeferredEventTypesQualification)
      .operation === operation
    ? (value as
        | DeferredEventQualification
        | DeferredEventSummaryQualification
        | DeferredEventRecordsQualification
        | DeferredEventFieldsQualification
        | DeferredEventFieldValuesQualification
        | DeferredEventTypesQualification
        | DeferredEventNameDimensionQualification
        | DeferredEventTrendQualification
        | DeferredEventContextQualification
        | DeferredEventTypeDetailQualification
        | DeferredPageQualification
        | DeferredPagesAggregatePageQualification
        | DeferredPagesTabsQualification
        | DeferredEventCandidatePageProjectionFor<EventCandidatePageReportOperation>
        | DeferredFilterValuesQualificationInput)
    : undefined;
}

export function deferredOverviewTrendQualificationFromQuery(
  input: unknown,
  expectedOperation?: "overview" | "trend",
): DeferredOverviewTrendQualification | undefined {
  if (!input || typeof input !== "object") return undefined;
  const query = input as QueryInput & Record<string, unknown>;
  const symbolDescriptor = ownDescriptor(
    input,
    DEFERRED_OVERVIEW_TREND_QUALIFICATION,
  );
  if (!symbolDescriptor) return undefined;
  if (!("value" in symbolDescriptor))
    throw new Error("overview_trend_qualification_request_changed");
  const symbolValue = symbolDescriptor.value;
  if (!isDeferredOverviewTrendQualification(symbolValue)) return undefined;
  const deferred = symbolValue as DeferredOverviewTrendQualification;
  const currentConfiguration = overviewTrendConfigurationForQuery(
    deferred.operation,
    query,
  );
  if (
    (expectedOperation !== undefined &&
      deferred.operation !== expectedOperation) ||
    !isDeferredEventQualification(deferred.qualification) ||
    deferred.qualification.operation !== deferred.operation ||
    !currentConfiguration ||
    ((deferred.configuration.kind === "overview-with-previous" ||
      deferred.configuration.kind === "overview-with-previous-and-detail") &&
      deferredOverviewTrendQueryOrigins.get(deferred) !== input) ||
    !sameOverviewTrendConfiguration(
      currentConfiguration,
      deferred.configuration,
    ) ||
    overviewTrendRequestSnapshot(
      query,
      deferred.operation,
      deferred.configuration,
    ) !== deferred.requestSnapshot
  )
    throw new Error("overview_trend_qualification_request_changed");
  return deferred;
}

/** Check the request-local outer brand used by the Overview/Trend compiler. */
export function isDeferredOverviewTrendQualification(
  value: unknown,
): value is DeferredOverviewTrendQualification {
  return (
    typeof value === "object" &&
    value !== null &&
    deferredOverviewTrendQualifications.has(value)
  );
}

export function deferredComparisonPageQualificationFromQuery(
  input: unknown,
): DeferredComparisonPageQualification | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<PropertyKey, unknown>)[
    DEFERRED_COMPARISON_PAGE_QUALIFICATION
  ];
  if (
    !value ||
    typeof value !== "object" ||
    !deferredComparisonPageQualifications.has(value)
  )
    return undefined;
  const deferred = value as DeferredComparisonPageQualification;
  if (
    comparisonPageRequestSnapshot(
      input as QueryInput & Record<string, unknown>,
      deferred.operation,
    ) !== deferred.requestSnapshot
  )
    throw new Error("deferred_comparison_page_request_changed");
  return deferred;
}

export async function prepareDeferredComparisonPageQualificationFallback(
  deferred: DeferredComparisonPageQualification,
): Promise<{
  readonly currentFilters: FilterDocument;
  readonly referenceFilters: FilterDocument;
}> {
  if (!deferredComparisonPageQualifications.has(deferred))
    throw new Error("deferred_comparison_page_qualification_untrusted");
  const fallbackFilters = async (side: DeferredComparisonPageSide) =>
    side.kind === "qualified"
      ? prepareDeferredEventQualificationFallback(side.qualification)
      : side.filters;
  const currentFilters = await fallbackFilters(deferred.current);
  const referenceFilters = await fallbackFilters(deferred.reference);
  return { currentFilters, referenceFilters };
}

export function deferredEventSummaryQualificationFromQuery(
  input: unknown,
): DeferredEventSummaryQualification | undefined {
  return deferredEventQualificationFromQuery(input, "event-summary") as
    DeferredEventSummaryQualification | undefined;
}

export function deferredEventTypesQualificationFromQuery(
  input: unknown,
): DeferredEventTypesQualification | undefined {
  return deferredEventQualificationFromQuery(input, "event-types") as
    DeferredEventTypesQualification | undefined;
}

export function deferredEventNameDimensionQualificationFromQuery(
  input: unknown,
): DeferredEventNameDimensionQualification | undefined {
  return deferredEventQualificationFromQuery(input, "event-name-dimension") as
    DeferredEventNameDimensionQualification | undefined;
}

export function deferredEventTrendQualificationFromQuery(
  input: unknown,
): DeferredEventTrendQualification | undefined {
  return deferredEventQualificationFromQuery(input, "event-trend");
}

export function deferredEventContextQualificationFromQuery(
  input: unknown,
): DeferredEventContextQualification | undefined {
  return deferredEventQualificationFromQuery(input, "event-context") as
    DeferredEventContextQualification | undefined;
}

export function deferredEventTypeDetailQualificationFromQuery(
  input: unknown,
): DeferredEventTypeDetailQualification | undefined {
  return deferredEventQualificationFromQuery(input, "event-type-detail") as
    DeferredEventTypeDetailQualification | undefined;
}

export function deferredEventRecordsQualificationFromQuery(
  input: unknown,
): DeferredEventRecordsQualification | undefined {
  return deferredEventQualificationFromQuery(input, "event-records") as
    DeferredEventRecordsQualification | undefined;
}

export function deferredEventFieldsQualificationFromQuery(
  input: unknown,
): DeferredEventFieldsQualification | undefined {
  return deferredEventQualificationFromQuery(input, "event-fields") as
    DeferredEventFieldsQualification | undefined;
}

export function deferredEventFieldValuesQualificationFromQuery(
  input: unknown,
): DeferredEventFieldValuesQualification | undefined {
  return deferredEventQualificationFromQuery(input, "event-field-values") as
    DeferredEventFieldValuesQualification | undefined;
}

export function deferredPageDimensionQualificationFromQuery(
  input: unknown,
): DeferredPageDimensionQualification | undefined {
  const deferred = deferredEventQualificationFromQuery(input, "page-dimension");
  return deferred &&
    "pageDimensionRequest" in deferred &&
    deferred.pageDimensionRequest
    ? (deferred as DeferredPageDimensionQualification)
    : undefined;
}

export function deferredPagesAggregatePageQualificationFromQuery(
  input: unknown,
): DeferredPagesAggregatePageQualification | undefined {
  const deferred = deferredEventQualificationFromQuery(
    input,
    "pages-aggregate-page",
  );
  if (!deferred?.pagesAggregatePageRequest) return undefined;
  const query = input as QueryInput & Record<string, unknown>;
  const prepared = deferred.pagesAggregatePageRequest;
  const page =
    query.page && typeof query.page === "object"
      ? (query.page as Record<string, unknown>)
      : {};
  const pageLimit = page.limit;
  const requestLimit = query.limit;
  const limit =
    typeof pageLimit === "number" && Number.isFinite(pageLimit)
      ? pageLimit
      : typeof requestLimit === "number" && Number.isFinite(requestLimit)
        ? requestLimit
        : 20;
  if (
    query.mode !== undefined ||
    query.variant !== prepared.variant ||
    query.includeTabs !== prepared.includeTabs ||
    query.context.policy.audience !== prepared.audience ||
    query.context.subject.kind !== "site" ||
    query.context.subject.siteId !== deferred.siteId ||
    (query.includeDetails === true) !== prepared.includeDetails ||
    limit !== prepared.limit ||
    (typeof page.cursor === "string" ? page.cursor : null) !==
      prepared.cursorText ||
    query.comparison !== undefined ||
    query.current !== undefined ||
    query.reference !== undefined ||
    JSON.stringify(query.filters) !== JSON.stringify(deferred.filters) ||
    (query.time !== undefined &&
      (deferred.requestTime === undefined ||
        !sameEventFieldsQueryTime(
          query.time as QueryTime,
          deferred.requestTime,
        ))) ||
    (query.scopePlan !== undefined &&
      JSON.stringify(query.scopePlan) !==
        JSON.stringify(deferred.requestScopePlan ?? deferred.metadata.plan))
  )
    throw new Error("deferred_pages_aggregate_page_request_changed");
  return deferred as DeferredPagesAggregatePageQualification;
}

export function deferredPagesTabsQualificationFromQuery(
  input: unknown,
): DeferredPagesTabsQualification | undefined {
  const deferred = deferredEventQualificationFromQuery(input, "pages-tabs");
  if (!deferred?.pagesTabsRequest) return undefined;
  const query = input as QueryInput & Record<string, unknown>;
  const prepared = deferred.pagesTabsRequest;
  const page =
    query.page && typeof query.page === "object"
      ? (query.page as Record<string, unknown>)
      : {};
  const tabsOnly = prepared.configuration === "tabs-only";
  const pageLimit = page.limit;
  const requestLimit = query.limit;
  const limit = tabsOnly
    ? ((requestLimit as number | undefined) ?? 20)
    : typeof pageLimit === "number" && Number.isFinite(pageLimit)
      ? pageLimit
      : ((requestLimit as number | undefined) ?? 20);
  const cursorText =
    !tabsOnly && typeof page.cursor === "string" ? page.cursor : null;
  const configuration =
    query.variant === "tabs"
      ? "tabs-only"
      : query.includeTabs === true
        ? "pages-with-tabs"
        : undefined;
  if (
    query.mode !== undefined ||
    configuration !== prepared.configuration ||
    query.variant !== prepared.variant ||
    query.includeTabs !== prepared.includeTabs ||
    query.context.policy.audience !== prepared.audience ||
    query.context.subject.kind !== "site" ||
    query.context.subject.siteId !== deferred.siteId ||
    (!tabsOnly &&
      (query.includeDetails === true) !== prepared.includeDetails) ||
    limit !== prepared.limit ||
    cursorText !== prepared.cursorText ||
    query.comparison !== undefined ||
    query.current !== undefined ||
    query.reference !== undefined ||
    JSON.stringify(query.filters) !== JSON.stringify(deferred.filters) ||
    query.time === undefined ||
    deferred.requestTime === undefined ||
    !sameEventFieldsQueryTime(query.time as QueryTime, deferred.requestTime) ||
    JSON.stringify(query.scopePlan ?? deferred.metadata.plan) !==
      JSON.stringify(deferred.requestScopePlan ?? deferred.metadata.plan)
  )
    throw new Error("deferred_pages_tabs_request_changed");
  return deferred as DeferredPagesTabsQualification;
}

export function deferredOverviewPageTableQualificationFromQuery(
  input: unknown,
): DeferredOverviewPageTableQualification | undefined {
  const deferred = deferredEventQualificationFromQuery(input, "page-dimension");
  return deferred &&
    "overviewPageTableRequest" in deferred &&
    deferred.overviewPageTableRequest
    ? (deferred as DeferredOverviewPageTableQualification)
    : undefined;
}

export function deferredChannelOverviewQualificationFromQuery(
  input: unknown,
): DeferredChannelOverviewQualification | undefined {
  const deferred = deferredEventQualificationFromQuery(
    input,
    "channel-overview",
  );
  return deferred?.overviewPageTableRequest
    ? (deferred as DeferredChannelOverviewQualification)
    : undefined;
}

export function deferredChannelListQualificationFromQuery(
  input: unknown,
): DeferredChannelListQualification | undefined {
  const deferred = deferredEventQualificationFromQuery(input, "channel-list");
  return deferred?.channelListRequest
    ? (deferred as DeferredChannelListQualification)
    : undefined;
}

export function deferredReferrerOverviewQualificationFromQuery(
  input: unknown,
): DeferredReferrerOverviewQualification | undefined {
  const deferred = deferredEventQualificationFromQuery(input, "page-dimension");
  return deferred &&
    "referrerOverviewRequest" in deferred &&
    deferred.referrerOverviewRequest
    ? (deferred as DeferredReferrerOverviewQualification)
    : undefined;
}

export function deferredReferrersQualificationFromQuery(
  input: unknown,
): DeferredReferrersQualification | undefined {
  const deferred = deferredEventQualificationFromQuery(input, "referrers");
  if (!deferred?.referrersRequest) return undefined;
  const query = input as QueryInput & Record<string, unknown>;
  const prepared = deferred.referrersRequest;
  const page =
    query.page && typeof query.page === "object"
      ? (query.page as Record<string, unknown>)
      : {};
  const matchesConfiguration =
    prepared.kind === "summary"
      ? (() => {
          const topN =
            typeof query.topN === "number" && Number.isFinite(query.topN)
              ? query.topN
              : typeof query.limit === "number" && Number.isFinite(query.limit)
                ? query.limit
                : 5;
          return query.variant === "summary" && topN === prepared.topN;
        })()
      : (() => {
          const pageLimit = page.limit;
          const requestLimit = query.limit;
          const limit =
            typeof pageLimit === "number" && Number.isFinite(pageLimit)
              ? pageLimit
              : typeof requestLimit === "number" &&
                  Number.isFinite(requestLimit)
                ? requestLimit
                : 20;
          return (
            query.variant !== "summary" &&
            limit === prepared.limit &&
            (typeof page.cursor === "string" ? page.cursor : null) ===
              prepared.cursorText &&
            (query.includeFullUrl === true) === prepared.includeFullUrl &&
            (typeof query.search === "string" ? query.search : undefined) ===
              prepared.search &&
            (query.sort === "visitors" ? "visitors" : "views") ===
              prepared.sortBy &&
            (query.direction === "asc" ? "asc" : "desc") ===
              prepared.sortDirection
          );
        })();
  if (
    query.context.policy.audience !== "private-dashboard" ||
    query.context.subject.kind !== "site" ||
    query.context.subject.siteId !== deferred.siteId ||
    query.comparison !== undefined ||
    query.current !== undefined ||
    query.reference !== undefined ||
    !matchesConfiguration ||
    JSON.stringify(query.filters) !== JSON.stringify(deferred.filters) ||
    query.time === undefined ||
    deferred.requestTime === undefined ||
    !sameEventFieldsQueryTime(query.time as QueryTime, deferred.requestTime) ||
    !sameEventFieldsQueryTime(deferred.time, deferred.requestTime) ||
    JSON.stringify(query.scopePlan ?? deferred.metadata.plan) !==
      JSON.stringify(deferred.requestScopePlan ?? deferred.metadata.plan)
  )
    throw new Error("deferred_referrers_request_changed");
  return deferred as DeferredReferrersQualification;
}

export function deferredSessionBoundaryDimensionQualificationFromQuery(
  input: unknown,
): DeferredSessionBoundaryDimensionQualification | undefined {
  return deferredEventQualificationFromQuery(
    input,
    "session-boundary-dimension",
  ) as DeferredSessionBoundaryDimensionQualification | undefined;
}

export function deferredSessionBoundaryOverviewPageQualificationFromQuery(
  input: unknown,
): DeferredSessionBoundaryOverviewPageQualification | undefined {
  const deferred = deferredEventQualificationFromQuery(
    input,
    "session-boundary-overview-page",
  );
  return deferred?.sessionBoundaryOverviewPageRequest
    ? (deferred as DeferredSessionBoundaryOverviewPageQualification)
    : undefined;
}

export function isDeferredEventQualification(
  value: unknown,
): value is
  | DeferredEventQualification
  | DeferredEventSummaryQualification
  | DeferredEventRecordsQualification
  | DeferredEventFieldsQualification
  | DeferredEventFieldValuesQualification
  | DeferredEventTypesQualification
  | DeferredEventNameDimensionQualification
  | DeferredEventTrendQualification
  | DeferredEventContextQualification
  | DeferredEventTypeDetailQualification
  | DeferredPageQualification
  | DeferredPagesAggregatePageQualification
  | DeferredPagesTabsQualification
  | DeferredEventCandidatePageProjectionFor<EventCandidatePageReportOperation>
  | DeferredFilterValuesQualificationInput {
  return (
    typeof value === "object" &&
    value !== null &&
    deferredEventQualifications.has(value)
  );
}

export function isDeferredEventCandidatePageProjection(
  value: unknown,
): value is DeferredEventCandidatePageProjection {
  if (
    typeof value !== "object" ||
    value === null ||
    !deferredEventQualifications.has(value)
  )
    return false;
  const candidate = value as {
    readonly operation?: unknown;
    readonly countInput?: {
      readonly scope?: unknown;
      readonly candidateAnchor?: { readonly kind?: unknown };
    };
    readonly eventCandidateReportProjection?: unknown;
  };
  return (
    (candidate.operation === "page-dimension" ||
      candidate.operation === "pages-aggregate-page" ||
      candidate.operation === "filter-values" ||
      candidate.operation === "pages-tabs" ||
      candidate.operation === "cross-dimension" ||
      candidate.operation === "radar" ||
      candidate.operation === "share-trend" ||
      candidate.operation === "performance" ||
      candidate.operation === "geo-points" ||
      candidate.operation === "referrers" ||
      candidate.operation === "channel-overview" ||
      candidate.operation === "channel-list" ||
      candidate.operation === "session-boundary-dimension" ||
      candidate.operation === "session-boundary-overview-page") &&
    candidate.countInput?.scope === "event" &&
    candidate.countInput.candidateAnchor?.kind === "event-candidate" &&
    candidate.eventCandidateReportProjection === "page-visits"
  );
}

function filtersUseSequenceSemantics(filters: FilterDocument): boolean {
  let found = false;
  const visit = (expression: FilterExpression | null): void => {
    if (!expression || found) return;
    if (expression.kind === "condition") {
      target(expression.target);
      if (
        expression.value &&
        typeof expression.value === "object" &&
        !Array.isArray(expression.value) &&
        "kind" in expression.value
      )
        target(expression.value as FilterTargetExpression);
    } else if (expression.kind === "not") visit(expression.child);
    else expression.children.forEach(visit);
  };
  const target = (value: FilterTargetExpression): void => {
    if (found) return;
    if (
      value.kind === "sequence" ||
      value.kind === "adjacent" ||
      value.kind === "without" ||
      (value.kind === "context-root" && value.context === "sequence") ||
      (value.kind === "context-intrinsic" && value.context === "sequence")
    ) {
      found = true;
      return;
    }
    if (value.kind === "member") target(value.object);
    else if (value.kind === "occurrence-time") target(value.input);
    else if (value.kind === "selector") {
      target(value.collection);
      visit(value.predicate);
    } else if (value.kind === "projection") target(value.collection);
    else if (value.kind === "reducer") target(value.input);
    else if (value.kind === "arithmetic") {
      target(value.left);
      target(value.right);
    } else if (value.kind === "bucket") target(value.input);
    else if (value.kind === "window") {
      target(value.collection);
      target(value.anchor);
    } else if (value.kind === "periods") target(value.collection);
  };
  visit(filters.root);
  return found;
}

function sameCandidateReadAndFilterWindow(time: QueryTime): boolean {
  const candidate = time.range;
  if (
    time.fullHistory === true ||
    time.filterRangeEmpty === true ||
    !Number.isFinite(candidate.startMs) ||
    !Number.isFinite(candidate.endExclusiveMs) ||
    candidate.startMs >= candidate.endExclusiveMs
  )
    return false;
  const read = time.readRange ?? candidate;
  if (!sameRange(candidate, read)) return false;
  return (
    time.filterRange === undefined ||
    (time.filterRange.startMs === candidate.startMs &&
      time.filterRange.endExclusiveMs === candidate.endExclusiveMs)
  );
}

function isPrivatePageVisitConsumer(
  deferred: DeferredEventCandidatePageProjection,
  readerAudience?: QueryAudience,
): boolean {
  const eligibility = deferredPageVisitEligibility.get(deferred);
  const request = deferred as DeferredEventCandidatePageProjection & {
    readonly referrersRequest?: { readonly audience?: unknown };
    readonly referrerOverviewRequest?: { readonly audience?: unknown };
    readonly overviewPageTableRequest?: { readonly audience?: unknown };
    readonly channelListRequest?: { readonly audience?: unknown };
    readonly sessionBoundaryDimensionRequest?: {
      readonly audience?: unknown;
    };
    readonly sessionBoundaryOverviewPageRequest?: {
      readonly audience?: unknown;
    };
    readonly filterValuesRequest?: { readonly audience?: unknown };
  };
  // Only adapt provider request shapes here; all audience rules live in the
  // application policy. The WeakMap above supplies trusted preparation facts.
  const consumerAudience = (() => {
    switch (deferred.operation) {
      case "pages-aggregate-page":
        return request.pagesAggregatePageRequest?.audience;
      case "pages-tabs":
        return request.pagesTabsRequest?.audience;
      case "referrers":
        return request.referrersRequest?.audience;
      case "page-dimension":
        return request.referrerOverviewRequest?.audience;
      case "channel-overview":
        return request.overviewPageTableRequest?.audience;
      case "channel-list":
        return request.channelListRequest?.audience;
      case "session-boundary-dimension":
        return request.sessionBoundaryDimensionRequest?.audience;
      case "session-boundary-overview-page":
        return request.sessionBoundaryOverviewPageRequest?.audience;
      case "filter-values":
        return request.filterValuesRequest?.audience;
      default:
        return undefined;
    }
  })();
  return checkPageMembershipAudiencePolicy({
    exposure: "event-page-visits",
    operation: deferred.operation,
    preparationAudience: eligibility?.audience,
    readerAudience,
    consumerAudience,
    privateOptIns: eligibility && {
      performance: eligibility.performancePrivateOptIn,
      geoPoints: eligibility.geoPointsPrivateOptIn,
      technology: eligibility.technologyPrivateOptIn,
    },
  }).allowed;
}

/**
 * Evaluates the existing Core fallback into a request-local Page visit
 * relation for the already-supported private single-site report consumers.
 * A reader-window caller may supply its exact QueryTime; when any semantic
 * temporal domain differs from the preparation, this returns undefined before
 * Core evaluation so the caller can keep its complete existing fallback.
 */
export async function prepareDeferredPageVisitQualification(
  deferredInput: unknown,
  consumerKey: unknown,
  options?: {
    readonly readerQueryTime?: QueryTime;
    readonly readerAudience?: QueryAudience;
  },
): Promise<PageVisitQualificationPreparation | undefined> {
  if (!isDeferredEventCandidatePageProjection(deferredInput))
    return prepareDeferredEntityPageQualification(
      deferredInput,
      consumerKey,
      options,
    );
  const deferred = deferredInput;
  if (deferred.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const queryTime = deferred.requestTime ?? deferred.time;
  if (
    !isPrivatePageVisitConsumer(deferred, options?.readerAudience) ||
    deferred.subject.origin !== "site" ||
    deferred.subject.siteIds.length !== 1 ||
    deferred.subject.siteIds[0] !== deferred.siteId ||
    deferred.countInput.scope !== "event" ||
    deferred.metadata.plan.scope !== "event" ||
    deferred.metadata.plan.mode !== "observation" ||
    deferred.metadata.plan.membership.kind === "entity" ||
    deferred.metadata.plan.preparedMembership !== undefined ||
    !sameCandidateReadAndFilterWindow(deferred.time) ||
    !sameCandidateReadAndFilterWindow(queryTime) ||
    JSON.stringify(semanticTemporalDomainsFromQueryTime(deferred.time)) !==
      JSON.stringify(semanticTemporalDomainsFromQueryTime(queryTime)) ||
    (options?.readerQueryTime !== undefined &&
      JSON.stringify(
        semanticTemporalDomainsFromQueryTime(options.readerQueryTime),
      ) !== JSON.stringify(semanticTemporalDomainsFromQueryTime(queryTime))) ||
    filtersUseSequenceSemantics(deferred.filters)
  )
    return undefined;

  const matches = await evaluateForSitesCore({
    env: deferred.env,
    subject: deferred.subject,
    siteIds: [deferred.siteId],
    filters: deferred.filters,
    plan: deferred.metadata.plan,
    time: deferred.time,
    diagnostics: deferred.diagnostics,
    signal: deferred.signal,
    coverage: deferred.coverage,
  });
  if (deferred.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return createPageVisitQualificationPreparation({
    siteId: deferred.siteId,
    filters: deferred.filters,
    queryTime,
    scopePlan: deferred.metadata.plan,
    consumerKey,
    relation: createReferrersVisitRelation(deferred.siteId, matches),
  });
}

/**
 * Page-role consumers of a session or visitor filter: evaluate the existing
 * Core fallback into a request-private entity membership. The entity relation
 * is only a set of IDs for one authorized site, so unlike the event-scope
 * Page projections it does not depend on a private-audience opt-in. Anything
 * outside one site, one window or the Count slice returns undefined before
 * Core evaluation so the caller keeps its complete existing fallback.
 */
async function prepareDeferredEntityPageQualification(
  deferredInput: unknown,
  consumerKey: unknown,
  options?: {
    readonly readerQueryTime?: QueryTime;
    readonly readerAudience?: QueryAudience;
  },
): Promise<PageVisitQualificationPreparation | undefined> {
  if (!isDeferredEventQualification(deferredInput)) return undefined;
  const deferred = deferredInput;
  const plan = deferred.metadata.plan;
  if (
    !checkPageMembershipAudiencePolicy({
      exposure: "entity-membership",
      operation: deferred.operation,
    }).allowed ||
    plan.mode !== "entity" ||
    plan.scope === "event" ||
    plan.membership.kind !== "entity" ||
    plan.preparedMembership !== undefined ||
    deferred.countInput.scope !== plan.scope ||
    deferred.subject.origin !== "site" ||
    deferred.subject.siteIds.length !== 1 ||
    deferred.subject.siteIds[0] !== deferred.siteId
  )
    return undefined;
  if (deferred.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const queryTime = deferred.requestTime ?? deferred.time;
  if (
    !sameCandidateReadAndFilterWindow(deferred.time) ||
    !sameCandidateReadAndFilterWindow(queryTime) ||
    JSON.stringify(semanticTemporalDomainsFromQueryTime(deferred.time)) !==
      JSON.stringify(semanticTemporalDomainsFromQueryTime(queryTime)) ||
    options?.readerQueryTime === undefined ||
    JSON.stringify(
      semanticTemporalDomainsFromQueryTime(options.readerQueryTime),
    ) !== JSON.stringify(semanticTemporalDomainsFromQueryTime(queryTime)) ||
    filtersUseSequenceSemantics(deferred.filters)
  )
    return undefined;

  const matches = await evaluateForSitesCore({
    env: deferred.env,
    subject: deferred.subject,
    siteIds: [deferred.siteId],
    filters: deferred.filters,
    plan,
    time: deferred.time,
    diagnostics: deferred.diagnostics,
    signal: deferred.signal,
    coverage: deferred.coverage,
  });
  if (deferred.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return createPageVisitQualificationPreparation({
    siteId: deferred.siteId,
    filters: deferred.filters,
    queryTime,
    scopePlan: plan,
    consumerKey,
    relation: createEntityMembershipRelation(deferred.siteId, matches),
    dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
  });
}

function createEventMembershipRelation(
  siteId: string,
  matches: readonly QualificationMatchRow[],
): AnalyticsDbRelation {
  const unique = new Map<string, string>();
  for (const match of matches) {
    if (!match) throw new Error("qualification_execution_match_invalid");
    if (match.kind !== "event") continue;
    if (match.siteId !== siteId || typeof match.id !== "string")
      throw new Error("qualification_execution_event_identity_invalid");
    unique.set(match.id, match.id);
  }
  const rows = [...unique.values()].sort((left, right) =>
    left.localeCompare(right),
  );
  return valuesRelation(
    {
      site_id: { affinity: "text", nullable: false },
      event_id: { affinity: "text", nullable: false },
    },
    rows.map((id) => ({
      site_id: sqliteBoundText(siteId),
      event_id: sqliteBoundText(id),
    })),
  ) as AnalyticsDbRelation;
}

function createEntityMembershipRelation(
  siteId: string,
  matches: readonly QualificationMatchRow[],
): AnalyticsDbRelation {
  const unique = new Set<string>();
  for (const match of matches) {
    if (!match) throw new Error("qualification_execution_match_invalid");
    if (match.kind !== "entity") continue;
    if (match.siteId !== siteId || typeof match.id !== "string")
      throw new Error("qualification_execution_entity_identity_invalid");
    unique.add(match.id);
  }
  const rows = [...unique].sort((left, right) => left.localeCompare(right));
  return valuesRelation(
    {
      site_id: { affinity: "text", nullable: false },
      entity_id: { affinity: "text", nullable: false },
    },
    rows.map((id) => ({
      site_id: sqliteBoundText(siteId),
      entity_id: sqliteBoundText(id),
    })),
  ) as AnalyticsDbRelation;
}

/**
 * Evaluate the existing Core fallback into a request-local Event membership
 * relation for a private, one-site, same-window Event report consumer. Any
 * other shape returns undefined before Core evaluation so the caller keeps its
 * complete existing fallback.
 */
export async function prepareDeferredEventMembershipQualification(
  deferredInput: unknown,
  consumerKey: unknown,
  operations: readonly DeferredEventQualificationOperation[],
  options: {
    readonly maxBindings?: number;
    readonly maxSourcesPerRole?: number;
    /** Exact frozen engine value. It grants no eligibility and is freshly rederived. */
    readonly evaluationStep?: MembershipPreparationStep;
    /** Also expose the Page visits of the same evaluation (session-boundary reads). */
    readonly withPageVisits?: boolean;
  } = {},
): Promise<PageVisitQualificationPreparation | undefined> {
  if (!isDeferredEventQualification(deferredInput)) return undefined;
  const deferred = deferredInput;
  if (!operations.includes(deferred.operation)) return undefined;
  if (deferred.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const entityMode = deferred.metadata.plan.mode === "entity";
  if (
    deferred.subject.origin !== "site" ||
    deferred.subject.siteIds.length !== 1 ||
    deferred.subject.siteIds[0] !== deferred.siteId ||
    (entityMode
      ? deferred.metadata.plan.scope === "event" ||
        deferred.metadata.plan.membership.kind !== "entity" ||
        deferred.countInput.scope !== deferred.metadata.plan.scope
      : deferred.countInput.scope !== "event" ||
        deferred.metadata.plan.scope !== "event" ||
        deferred.metadata.plan.mode !== "observation" ||
        deferred.metadata.plan.membership.kind === "entity") ||
    deferred.metadata.plan.preparedMembership !== undefined ||
    !sameCandidateReadAndFilterWindow(deferred.time) ||
    filtersUseSequenceSemantics(deferred.filters)
  )
    return undefined;

  let evaluationFilters = deferred.filters;
  let evaluationTime = deferred.time;
  const evaluationStep = options.evaluationStep;
  const originalScope = evaluationStep
    ? JSON.stringify(scopePlanRequestSnapshot(deferred.metadata.plan))
    : undefined;
  const assertEvaluationStep = () => {
    if (!evaluationStep) return;
    const expected = normalizeMembershipPreparations([
      {
        key: evaluationStep.key,
        execution: planAdvancedFilterExecution({
          subject: deferred.subject,
          filters: deferred.filters,
          scope: deferred.metadata.plan.scope,
          time: deferred.time,
          reportFusionAvailable: false,
        }),
        filters: deferred.filters,
        queryTime: deferred.time,
      },
    ])?.[0];
    // Fresh evaluator admission enforces these same fixed activity/work/match
    // bounds. This value never supplies an alternative limit or subject.
    if (
      !Object.isFrozen(evaluationStep) ||
      !expected ||
      JSON.stringify(expected) !== JSON.stringify(evaluationStep) ||
      JSON.stringify(scopePlanRequestSnapshot(deferred.metadata.plan)) !==
        originalScope
    )
      throw new Error("overview_membership_preparation_step_mismatch");
  };
  if (evaluationStep) {
    assertEvaluationStep();
    evaluationFilters = evaluationStep.filters;
    evaluationTime = evaluationStep.queryTime;
  }
  const matches = await evaluateForSitesCore({
    env: deferred.env,
    subject: deferred.subject,
    siteIds: [deferred.siteId],
    filters: evaluationFilters,
    plan: deferred.metadata.plan,
    time: evaluationTime,
    diagnostics: deferred.diagnostics,
    signal: deferred.signal,
    coverage: deferred.coverage,
  });
  if (deferred.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  assertEvaluationStep();
  return createPageVisitQualificationPreparation({
    siteId: deferred.siteId,
    filters: evaluationFilters,
    queryTime: evaluationTime,
    scopePlan: deferred.metadata.plan,
    consumerKey,
    relation: entityMode
      ? createEntityMembershipRelation(deferred.siteId, matches)
      : createEventMembershipRelation(deferred.siteId, matches),
    dependencyRef: entityMode
      ? EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY
      : EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
    ...(options.withPageVisits && !entityMode
      ? {
          additionalRelations: [
            {
              dependencyRef: EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
              relation: createReferrersVisitRelation(deferred.siteId, matches),
            },
          ],
        }
      : {}),
    maxBindings: options.maxBindings ?? 1,
    ...(options.maxSourcesPerRole
      ? { maxSourcesPerRole: options.maxSourcesPerRole }
      : {}),
  });
}

/** Describe and execute only the existing private Overview entity fallback. */
export async function prepareDeferredOverviewMembershipRecipe(
  deferred: DeferredOverviewTrendQualification,
) {
  if (
    !isDeferredOverviewTrendQualification(deferred) ||
    !isDeferredEventQualification(deferred.qualification)
  )
    return undefined;
  const qualification = deferred.qualification;
  if (
    qualification.metadata.plan.mode !== "entity" ||
    qualification.metadata.plan.scope === "event" ||
    !sameCandidateReadAndFilterWindow(qualification.time)
  )
    return undefined;
  const configuration = deferred.configuration;
  const childKeys =
    configuration.kind === "trend"
      ? ["current-trend" as const]
      : [
          "current-overview" as const,
          ...(configuration.kind === "overview-with-previous" ||
          configuration.kind === "overview-with-previous-and-detail"
            ? ["previous-overview" as const]
            : []),
          ...(configuration.kind === "overview-with-detail" ||
          configuration.kind === "overview-with-previous-and-detail"
            ? ["current-detail" as const]
            : []),
        ];
  const enginePlan = planOverviewMembershipDependencies({
    preparation: {
      key: "original",
      execution: planAdvancedFilterExecution({
        subject: qualification.subject,
        filters: qualification.filters,
        scope: qualification.metadata.plan.scope,
        time: qualification.time,
        reportFusionAvailable: false,
      }),
      filters: qualification.filters,
      queryTime: qualification.time,
    },
    readerQueryTime: qualification.requestTime,
    operation: deferred.operation,
    configuration,
    importedOutputs: childKeys.map((childKey) => ({
      childKey,
      outputId: childKey,
    })),
    consumer: { operation: deferred.operation, configuration },
  });
  if (!enginePlan) return undefined;
  const consumerKey = pageVisitQualificationConsumerKey(
    deferred.operation,
    enginePlan,
  );
  const preparation = await prepareDeferredEventMembershipQualification(
    qualification,
    consumerKey,
    [deferred.operation],
    {
      maxBindings: enginePlan.children.length,
      maxSourcesPerRole: 2,
      evaluationStep: enginePlan.preparation,
    },
  );
  return preparation
    ? {
        enginePlan,
        preparation,
        consumerKey,
        filters: qualification.filters,
        queryTime: qualification.time,
        scopePlan: qualification.metadata.plan,
        siteId: qualification.siteId,
      }
    : undefined;
}

/** Prepare only the private, one-site, same-window Referrers summary slice. */
export async function prepareDeferredReferrersSummaryQualification(
  deferred: DeferredReferrersQualification,
): Promise<ReferrersSummaryQualificationPreparation | undefined> {
  if (!isDeferredEventCandidatePageProjection(deferred)) return undefined;
  if (deferred.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (
    deferred.operation !== "referrers" ||
    deferred.referrersRequest?.kind !== "summary" ||
    deferred.referrersRequest.audience !== "private-dashboard" ||
    deferred.subject.origin !== "site" ||
    deferred.subject.siteIds.length !== 1 ||
    deferred.subject.siteIds[0] !== deferred.siteId ||
    deferred.countInput.scope !== "event" ||
    deferred.metadata.plan.scope !== "event" ||
    deferred.metadata.plan.mode !== "observation" ||
    deferred.metadata.plan.membership.kind === "entity" ||
    deferred.metadata.plan.preparedMembership !== undefined ||
    !sameCandidateReadAndFilterWindow(deferred.time) ||
    filtersUseSequenceSemantics(deferred.filters)
  )
    return undefined;

  const matches = await evaluateForSitesCore({
    env: deferred.env,
    subject: deferred.subject,
    siteIds: [deferred.siteId],
    filters: deferred.filters,
    plan: deferred.metadata.plan,
    time: deferred.time,
    diagnostics: deferred.diagnostics,
    signal: deferred.signal,
    coverage: deferred.coverage,
  });
  if (deferred.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return createReferrersSummaryQualificationPreparation({
    siteId: deferred.siteId,
    filters: deferred.filters,
    queryTime: deferred.time,
    metadata: deferred.metadata,
    topN: deferred.referrersRequest.topN,
    relation: createReferrersVisitRelation(deferred.siteId, matches),
  });
}

function createReferrersVisitRelation(
  siteId: string,
  matches: readonly QualificationMatchRow[],
): AnalyticsDbRelation {
  const unique = new Map<
    string,
    { readonly siteId: string; readonly id: string }
  >();
  for (const match of matches) {
    if (!match) throw new Error("qualification_execution_match_invalid");
    if (match.kind !== "visit") continue;
    if (match.siteId !== siteId || typeof match.id !== "string")
      throw new Error("qualification_execution_visit_identity_invalid");
    unique.set(JSON.stringify([match.siteId, "page", match.id]), {
      siteId: match.siteId,
      id: match.id,
    });
  }
  const rows = [...unique.values()].sort(
    (left, right) =>
      left.siteId.localeCompare(right.siteId) ||
      left.id.localeCompare(right.id),
  );
  return valuesRelation(
    {
      site_id: { affinity: "text", nullable: false },
      visit_id: { affinity: "text", nullable: false },
    },
    rows.map((row) => ({
      site_id: sqliteBoundText(row.siteId),
      visit_id: sqliteBoundText(row.id),
    })),
  ) as AnalyticsDbRelation;
}

export function isDeferredComparisonPageQualification(
  value: unknown,
): value is DeferredComparisonPageQualification {
  return (
    typeof value === "object" &&
    value !== null &&
    deferredComparisonPageQualifications.has(value)
  );
}

/** Prepare the existing evaluator route if fused compilation is refused. */
export async function prepareDeferredEventQualificationFallback(
  deferred:
    | DeferredEventQualification
    | DeferredEventSummaryQualification
    | DeferredEventRecordsQualification
    | DeferredEventFieldsQualification
    | DeferredEventFieldValuesQualification
    | DeferredEventTypesQualification
    | DeferredEventNameDimensionQualification
    | DeferredEventTrendQualification
    | DeferredEventContextQualification
    | DeferredEventTypeDetailQualification
    | DeferredPageQualification
    | DeferredPagesAggregatePageQualification
    | DeferredPagesTabsQualification
    | DeferredEventCandidatePageProjection
    | DeferredFilterValuesQualificationInput,
): Promise<FilterDocument> {
  if (
    !isDeferredEventQualification(deferred) &&
    !isDeferredEventCandidatePageProjection(deferred)
  )
    throw new Error("deferred_event_qualification_untrusted");
  if (deferred.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const wholeOriginal = deferred.wholeOriginalMembership;
  wholeOriginal?.invocation.assertSameDeferredOwner(deferred);
  const evaluationInput = {
    env: deferred.env,
    subject: deferred.subject,
    siteIds: [deferred.siteId],
    filters: deferred.filters,
    plan: deferred.metadata.plan,
    time: deferred.time,
    diagnostics: deferred.diagnostics,
    signal: deferred.signal,
    coverage: deferred.coverage,
  };
  const result = await (wholeOriginal
    ? evaluateForSites({
        ...evaluationInput,
        completion: wholeOriginal.consumer,
        deferredInvocation: wholeOriginal.invocation,
      })
    : evaluateForSites(evaluationInput));
  if (deferred.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const filters = attachScopedFilterMetadata(deferred.filters, {
    ...deferred.metadata,
    plan: wholeOriginal
      ? { ...deferred.metadata.plan }
      : {
          ...deferred.metadata.plan,
          preparedMembership: result as PreparedMembership,
        },
  });
  if (wholeOriginal)
    associateWholeOriginalCompletion(
      deferred,
      wholeOriginal.consumer,
      result as WholeOriginalProjection,
      {
        filters,
        metadata: scopedFilterMetadata(filters)!,
      },
    );
  return filters;
}

/** The existing deferred WeakSet remains the only entry authentication. A
 * declaration, physical frame, reader key or LogicalPlan is not a substitute. */
export function hasDeferredChannelMembershipProgram(
  deferred: DeferredChannelListQualification,
): boolean {
  return (
    isDeferredEventQualification(deferred) &&
    deferred.operation === "channel-list" &&
    deferred.channelMembershipInvocation !== undefined
  );
}

/** Corresponds to evaluateForSites' original async frame and projection await.
 * Stage 0 owns its own original evaluator frame through the common runtime. */
async function evaluateDeferredChannelMembershipProgram(
  deferred:
    DeferredChannelListQualification | DeferredPageDimensionQualification,
): Promise<void> {
  const invocation = deferred.channelMembershipInvocation;
  if (!invocation) throw new Error("channels_membership_invocation_missing");
  invocation.assertSameDeferredOwner(deferred);
  await executeAnalyticsLogicalStage({
    kind: "channels-whole-membership-at-original-checkpoint",
    invocation,
  });
  invocation.projectAtOriginalRegistrationCheckpoint(deferred);
}

/** The old fallback outer frame, authentication, abort checkpoints and shallow
 * scoped-filter copy remain here. Only the register transport is replaced. */
export async function prepareDeferredPageMembershipFallback(
  deferred:
    DeferredChannelListQualification | DeferredPageDimensionQualification,
  readerConsumer?: PageReaderConsumer,
): Promise<FilterDocument> {
  if (
    !isDeferredEventQualification(deferred) ||
    (deferred.operation !== "channel-list" &&
      deferred.operation !== "page-dimension") ||
    !deferred.channelMembershipInvocation
  )
    throw new Error("deferred_event_qualification_untrusted");
  if (deferred.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (deferred.operation === "page-dimension") {
    if (!readerConsumer)
      throw new Error("page_membership_reader_consumer_missing");
    deferred.channelMembershipInvocation.retainReaderConsumerAtOriginalFallbackCheckpoint(
      deferred,
      readerConsumer,
    );
  }
  await evaluateDeferredChannelMembershipProgram(deferred);
  if (deferred.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const filters = attachScopedFilterMetadata(deferred.filters, {
    ...deferred.metadata,
    plan: { ...deferred.metadata.plan },
  });
  deferred.channelMembershipInvocation.retainReaderFiltersAtOriginalReturnCheckpoint(
    deferred,
    filters,
  );
  return filters;
}

/** Keep the original exported function/promise identity for the first consumer. */
export const prepareDeferredChannelMembershipFallback =
  prepareDeferredPageMembershipFallback;

export function hasDeferredPageMembershipProgram(
  deferred: DeferredPageDimensionQualification,
): boolean {
  return (
    isDeferredEventQualification(deferred) &&
    deferred.operation === "page-dimension" &&
    deferred.channelMembershipInvocation !== undefined
  );
}

/** Runs at queryChannelsFromD1's original builder checkpoint, after the whole
 * result and old fallback copy exist. No canonical reader is built earlier. */
export function bindDeferredChannelMembershipSuccessor(input: {
  readonly deferred: DeferredChannelListQualification;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly limit: number;
}) {
  const deferred = input.deferred;
  if (
    !isDeferredEventQualification(deferred) ||
    deferred.operation !== "channel-list" ||
    !deferred.channelMembershipInvocation
  )
    throw new Error("deferred_event_qualification_untrusted");
  if (
    input.siteId !== deferred.siteId ||
    input.scopePlan !== scopedFilterMetadata(input.filters)?.plan ||
    input.queryTime !==
      (scopedFilterMetadata(input.filters)?.time ?? deferred.time)
  )
    throw new Error("channels_membership_reader_context_mismatch");
  return deferred.channelMembershipInvocation.bindSuccessorAtOriginalBuilderCheckpoint(
    {
      owner: deferred,
      siteId: input.siteId,
      filters: input.filters,
      queryTime: input.queryTime,
      scopePlan: input.scopePlan,
      limit: input.limit,
    },
  );
}

export function bindDeferredPageMembershipSuccessor(input: {
  readonly deferred: DeferredPageDimensionQualification;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly consumer: Extract<PageReaderConsumer, { kind: "dimension-page" }>;
}) {
  const deferred = input.deferred;
  if (
    !isDeferredEventQualification(deferred) ||
    deferred.operation !== "page-dimension" ||
    !deferred.channelMembershipInvocation
  )
    throw new Error("deferred_event_qualification_untrusted");
  const metadata = scopedFilterMetadata(input.filters);
  if (
    input.siteId !== deferred.siteId ||
    input.scopePlan !== metadata?.plan ||
    input.queryTime !== (metadata?.time ?? deferred.time)
  )
    throw new Error("page_membership_reader_context_mismatch");
  const configuration = input.consumer.configuration;
  const original = deferred.pageDimensionRequest;
  if (
    configuration.dimension !== original.dimension ||
    configuration.limit !== original.limit ||
    configuration.cursorText !== original.cursorText ||
    configuration.search !== original.search ||
    configuration.sortBy !== original.sortBy ||
    configuration.sortDirection !== original.sortDirection ||
    configuration.excludeEmpty !== false ||
    configuration.audience !== original.audience
  )
    throw new Error("page_membership_reader_configuration_mismatch");
  return deferred.channelMembershipInvocation.bindSuccessorAtOriginalBuilderCheckpoint(
    {
      owner: deferred,
      siteId: input.siteId,
      filters: input.filters,
      queryTime: input.queryTime,
      scopePlan: input.scopePlan,
      limit: original.limit,
      consumer: input.consumer,
    },
  );
}

/**
 * Runs the deferred Count evaluation only for its observable effects (the
 * activity cap, aborts and database errors) so that they keep their legacy
 * precedence over a later invalid-cursor error. Nothing is attached to any
 * plan and the result is discarded.
 */
export async function assertDeferredEventQualificationEvaluates(
  deferred: Parameters<typeof prepareDeferredEventQualificationFallback>[0],
): Promise<void> {
  if (
    !isDeferredEventQualification(deferred) &&
    !isDeferredEventCandidatePageProjection(deferred)
  )
    throw new Error("deferred_event_qualification_untrusted");
  if (deferred.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  await evaluateForSitesCore({
    env: deferred.env,
    subject: deferred.subject,
    siteIds: [deferred.siteId],
    filters: deferred.filters,
    plan: deferred.metadata.plan,
    time: deferred.time,
    diagnostics: deferred.diagnostics,
    signal: deferred.signal,
    coverage: deferred.coverage,
  });
  if (deferred.signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

export async function prepareDeferredEventSummaryFallback(
  deferred: DeferredEventSummaryQualification,
): Promise<FilterDocument> {
  return prepareDeferredEventQualificationFallback(deferred);
}

interface FilterSide {
  readonly filters?: FilterDocument;
  readonly time?: QueryTime;
  readonly [key: string]: unknown;
}

interface PreparedFilterSide {
  readonly side: FilterSide;
  readonly plan: ScopedFilterPlan;
}

function prepareSide(
  env: Env,
  subject: SemanticSubjectDomain,
  siteIds: readonly string[],
  side: FilterSide,
  diagnostics?: D1ReadDiagnostics,
  signal?: AbortSignal,
  completion?: WholeOriginalConsumer,
  program?: D1LogicalProgramExecution,
): Promise<PreparedFilterSide> | null {
  const filters = side.filters;
  if (!filters?.root || !filterDocumentUsesAdvancedExpressions(filters))
    return null;
  const metadata = scopedFilterMetadata(filters);
  if (!metadata)
    throw invalidInput("filters", "advanced_filter_execution_context_required");
  const time = metadata.time ?? side.time;
  if (!time)
    throw invalidInput("time", "advanced_filter_execution_context_required");
  const evaluationInput = {
    env,
    subject,
    siteIds: metadata.siteIds.length ? metadata.siteIds : siteIds,
    filters,
    plan: metadata.plan,
    time,
    diagnostics,
    signal,
  };
  const evaluation = completion
    ? evaluateForSites({
        ...evaluationInput,
        completion,
        ...(program ? { program } : {}),
      })
    : program
      ? evaluateForSites({ ...evaluationInput, program })
      : evaluateForSites(evaluationInput);
  return evaluation.then((result) => {
    const plan =
      completion || result === undefined
        ? { ...metadata.plan }
        : {
            ...metadata.plan,
            preparedMembership: result as PreparedMembership,
          };
    const preparedSide = {
      ...side,
      filters: attachScopedFilterMetadata(filters, { ...metadata, plan }),
    };
    if (completion)
      associateWholeOriginalCompletion(
        preparedSide,
        completion,
        result as WholeOriginalProjection,
        {
          filters: preparedSide.filters,
          metadata: scopedFilterMetadata(preparedSide.filters)!,
          ...(program ? { program } : {}),
          ...(completion.kind === "event-type-detail" ||
          completion.kind === "team-sites" ||
          completion.kind === "team-exact-dimension"
            ? { qualificationTime: time }
            : {}),
        },
      );
    return { side: preparedSide, plan };
  });
}

export interface SiteExactDimensionInput {
  readonly filters: FilterDocument;
  readonly qualifiedPlan?: ScopedFilterPlan;
  readonly qualification?: SiteExactDimensionQualificationProjection;
}
/** Joint admission is intentionally not a per-site prepare loop. */
export async function prepareSiteExactDimensionInputs(input: {
  readonly env: Env;
  readonly query: TeamExactDimensionQuery;
  readonly siteIds: readonly string[];
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
}): Promise<ReadonlyMap<string, SiteExactDimensionInput>> {
  const decision = planTeamExactDimensionExecution(input.query);
  if (decision.kind !== "exact")
    return await Promise.reject(
      invalidInput("filters", "site_exact_dimension_qualification_unavailable"),
    );
  if (decision.qualification === "native") {
    // Replace the removed async helper's native frame, including rejected
    // authorization checks, without adding a checkpoint to the SQL branch.
    const native = await (async () => {
      const subject = semanticSubjectFromQuerySubject(
        input.query.context.subject,
      );
      if (
        input.siteIds.some(
          (siteId) => !subject.siteIds.some((id) => id === siteId),
        )
      )
        throw invalidInput(
          "filters",
          "advanced_filter_execution_site_context_mismatch",
        );
      const filters = input.query.filters ?? EMPTY_FILTER_DOCUMENT;
      return new Map(input.siteIds.map((siteId) => [siteId, filters]));
    })();
    return new Map(
      [...native].map(([siteId, filters]) => [siteId, { filters }]),
    );
  }
  const recipe = planTeamExactMembershipDependencies(input.query);
  if (!recipe)
    return await Promise.reject(
      invalidInput("filters", "site_exact_dimension_qualification_unavailable"),
    );
  if (
    input.siteIds.some((siteId) => !recipe.admission.siteIds.includes(siteId))
  )
    throw invalidInput(
      "filters",
      "advanced_filter_execution_site_context_mismatch",
    );
  const query = input.query;
  const metadata = scopedFilterMetadata(query.filters)!;
  const originalFilters = query.filters;
  const originalTime = query.time;
  const originalMetadataTime = metadata.time;
  const originalPlan = metadata.plan;
  const originalSiteIds = metadata.siteIds;
  const originalTargetSiteIds = input.siteIds;
  const originalContext = query.context;
  const contextSnapshot = () => {
    const request = qualificationRequestOwnDataSnapshot(query);
    const targets = qualificationRequestOwnDataSnapshot({
      requestedSiteIds: input.siteIds,
    });
    return request === undefined || targets === undefined
      ? undefined
      : `${request}|${targets}`;
  };
  const originalContextSnapshot = contextSnapshot();
  const recipeSnapshot = JSON.stringify(recipe);
  const assertAdmissionContext = () => {
    const currentMetadata = scopedFilterMetadata(query.filters);
    if (
      query.filters !== originalFilters ||
      query.time !== originalTime ||
      query.context !== originalContext ||
      currentMetadata !== metadata ||
      currentMetadata.time !== originalMetadataTime ||
      currentMetadata.plan !== originalPlan ||
      currentMetadata.siteIds !== originalSiteIds ||
      input.siteIds !== originalTargetSiteIds ||
      originalContextSnapshot === undefined ||
      contextSnapshot() !== originalContextSnapshot ||
      JSON.stringify(planTeamExactMembershipDependencies(query)) !==
        recipeSnapshot
    )
      throw invalidInput(
        "filters",
        "team_exact_membership_admission_context_mismatch",
      );
  };
  assertAdmissionContext();
  const matches = await evaluateForSitesCore({
    env: input.env,
    subject: semanticSubjectFromQuerySubject(query.context.subject),
    siteIds: recipe.admission.siteIds,
    filters: recipe.admission.filters,
    plan: metadata.plan,
    time: recipe.admission.queryTime,
    diagnostics: input.diagnostics,
    signal: input.signal,
  });
  assertAdmissionContext();
  const children = new Map(
    recipe.children.map((child) => [child.siteId, child]),
  );
  return new Map(
    input.siteIds.map((siteId) => {
      const child = children.get(siteId)!;
      const filters = attachScopedFilterMetadata(query.filters!, {
        ...metadata,
        siteIds: [siteId],
      });
      const preparation = createPageVisitQualificationPreparation({
        siteId,
        filters,
        queryTime: metadata.time,
        scopePlan: metadata.plan,
        consumerKey: siteExactDimensionQualificationConsumerKey(
          query.dimension,
        ),
        relation: entityMembershipRelation(
          [siteId],
          matches.filter((match) => match.siteId === siteId),
        ),
        dependencyRef: child.dependencyRef,
        maxBindings: child.maxPlans,
        maxSourcesPerRole: child.maxSources,
      });
      return [
        siteId,
        {
          filters,
          qualifiedPlan: metadata.plan,
          qualification: createSiteExactDimensionQualificationProjection({
            siteId,
            audience: query.context.policy.audience,
            dimension: query.dimension,
            filters,
            time: metadata.time,
            scopePlan: metadata.plan,
            ...(query.scopePreference !== undefined
              ? { scopePreference: query.scopePreference }
              : {}),
            preparation,
          }),
        },
      ];
    }),
  );
}

/** Team-site listing retains one joint admission before any cursor or page I/O. */
export async function prepareTeamSitesQualification(input: {
  readonly env: Env;
  readonly query: TeamSitesMembershipQuery;
  readonly signal?: AbortSignal;
}): Promise<TeamSitesQualification | undefined> {
  const whole = wholeOriginalTeamSitesQualificationFromQuery(input.query);
  if (whole) return whole;
  const query = input.query,
    recipe = planTeamSitesMembershipDependencies(query);
  if (!recipe) return undefined;
  const metadata = scopedFilterMetadata(query.filters)!;
  const original = {
    filters: query.filters,
    time: query.time,
    context: query.context,
    metadata,
    plan: metadata.plan,
    siteIds: metadata.siteIds,
    metadataTime: metadata.time,
  };
  const contextSnapshot = () => qualificationRequestOwnDataSnapshot(query);
  const before = contextSnapshot(),
    recipeSnapshot = JSON.stringify(recipe);
  const assertFresh = () => {
    const current = scopedFilterMetadata(query.filters);
    if (
      query.filters !== original.filters ||
      query.time !== original.time ||
      query.context !== original.context ||
      current !== original.metadata ||
      current.plan !== original.plan ||
      current.time !== original.metadataTime ||
      current.siteIds !== original.siteIds ||
      before === undefined ||
      contextSnapshot() !== before ||
      JSON.stringify(planTeamSitesMembershipDependencies(query)) !==
        recipeSnapshot
    )
      throw invalidInput(
        "filters",
        "team_sites_membership_admission_context_mismatch",
      );
  };
  assertFresh();
  const matches = await evaluateForSitesCore({
    env: input.env,
    subject: semanticSubjectFromQuerySubject(query.context.subject),
    siteIds: recipe.admission.siteIds,
    filters: recipe.admission.filters,
    plan: metadata.plan,
    time: recipe.admission.queryTime,
    signal: input.signal,
  });
  assertFresh();
  return createTeamSitesQualification({
    query,
    recipe,
    relation: entityMembershipRelation(recipe.admission.siteIds, matches),
    assertFresh,
  });
}

/** Resolve Core/Relation expressions once, then let every D1 operation reuse
 * the scoped dataset's selected identities. The ordinary v1 SQL fast path is
 * untouched. */
export function d1AdvancedFilterMiddleware(
  env: Env,
  diagnostics?: D1ReadDiagnostics,
  expectedSiteId?: string,
): D1QueryProviderMiddleware {
  return async (operation: QueryOperation, input: unknown, next, execution) => {
    const rawEventContextRequestSnapshot =
      operation === "event-context"
        ? qualificationRequestOwnDataSnapshot(input)
        : undefined;
    const rawEventTypeDetailRequestSnapshot =
      operation === "event-type-detail"
        ? qualificationRequestOwnDataSnapshot(input)
        : undefined;
    if (operation === "event-context" || operation === "event-type-detail") {
      const rawRequestSnapshot =
        operation === "event-context"
          ? rawEventContextRequestSnapshot
          : rawEventTypeDetailRequestSnapshot;
      const filters = ownDataValue(input, "filters") as
        FilterDocument | undefined;
      const metadata = scopedFilterMetadata(filters);
      const filtersDescriptor = ownDescriptor(input, "filters");
      const ownDataRequiredCode =
        operation === "event-context"
          ? "event_context_qualification_request_own_data_required"
          : "event_type_detail_qualification_request_own_data_required";
      const contextMismatchCode =
        operation === "event-context"
          ? "event_context_qualification_request_context_mismatch"
          : "event_type_detail_qualification_request_context_mismatch";
      if (
        rawRequestSnapshot === undefined &&
        (metadata?.plan.scope === "event" ||
          (filtersDescriptor !== undefined && !("value" in filtersDescriptor)))
      )
        throw invalidInput("query", ownDataRequiredCode);
      if (metadata?.plan.scope === "event") {
        const context = ownDataValue(input, "context");
        const subject = ownDataValue(context, "subject");
        const siteId = ownDataValue(subject, "siteId");
        const requestTime = ownDataValue(input, "time");
        if (
          ownDataValue(subject, "kind") !== "site" ||
          metadata.siteIds.length !== 1 ||
          metadata.siteIds[0] !== siteId ||
          (expectedSiteId !== undefined && expectedSiteId !== siteId) ||
          !metadata.time ||
          !requestTime ||
          !sameEventFieldsQueryTime(requestTime as QueryTime, metadata.time) ||
          !queryScopePlanMatchesMetadata(input, metadata.plan)
        )
          throw invalidInput("query", contextMismatchCode);
      }
    }
    const rawEventRecordsRequestSnapshot =
      operation === "event-records"
        ? qualificationRequestOwnDataSnapshot(input)
        : undefined;
    if (operation === "event-records") {
      const filters = ownDataValue(input, "filters") as
        FilterDocument | undefined;
      const metadata = scopedFilterMetadata(filters);
      const filtersDescriptor = ownDescriptor(input, "filters");
      if (
        rawEventRecordsRequestSnapshot === undefined &&
        (metadata?.plan.scope === "event" ||
          (filtersDescriptor !== undefined && !("value" in filtersDescriptor)))
      )
        throw invalidInput(
          "query",
          "event_records_qualification_request_own_data_required",
        );
      if (metadata?.plan.scope === "event") {
        const context = ownDataValue(input, "context");
        const subject = ownDataValue(context, "subject");
        const siteId = ownDataValue(subject, "siteId");
        const requestTime = ownDataValue(input, "time");
        if (
          ownDataValue(subject, "kind") !== "site" ||
          metadata.siteIds.length !== 1 ||
          metadata.siteIds[0] !== siteId ||
          (expectedSiteId !== undefined && expectedSiteId !== siteId) ||
          !metadata.time ||
          !requestTime ||
          !sameEventFieldsQueryTime(requestTime as QueryTime, metadata.time) ||
          !queryScopePlanMatchesMetadata(input, metadata.plan)
        )
          throw invalidInput(
            "query",
            "event_records_qualification_request_context_mismatch",
          );
      }
    }
    const rawEventPayloadRequestSnapshot =
      operation === "event-fields" || operation === "event-field-values"
        ? qualificationRequestOwnDataSnapshot(input)
        : undefined;
    if (operation === "event-fields" || operation === "event-field-values") {
      const filters = ownDataValue(input, "filters") as
        FilterDocument | undefined;
      const metadata = scopedFilterMetadata(filters);
      const filtersDescriptor = ownDescriptor(input, "filters");
      const contextMismatchCode =
        operation === "event-fields"
          ? "event_fields_qualification_request_context_mismatch"
          : "event_field_values_qualification_request_context_mismatch";
      if (
        rawEventPayloadRequestSnapshot === undefined &&
        (metadata?.plan.scope === "event" ||
          (filtersDescriptor !== undefined && !("value" in filtersDescriptor)))
      )
        throw invalidInput(
          "query",
          operation === "event-fields"
            ? "event_fields_qualification_request_own_data_required"
            : "event_field_values_qualification_request_own_data_required",
        );
      if (metadata?.plan.scope === "event") {
        const context = ownDataValue(input, "context");
        const subject = ownDataValue(context, "subject");
        const siteId = ownDataValue(subject, "siteId");
        const requestTime = ownDataValue(input, "time");
        if (
          ownDataValue(subject, "kind") !== "site" ||
          metadata.siteIds.length !== 1 ||
          metadata.siteIds[0] !== siteId
        )
          throw invalidInput("query", contextMismatchCode);
        if (expectedSiteId !== undefined && expectedSiteId !== siteId)
          throw invalidInput("siteId", contextMismatchCode);
        if (
          !metadata.time ||
          !requestTime ||
          !sameEventFieldsQueryTime(requestTime as QueryTime, metadata.time)
        )
          throw invalidInput("time", contextMismatchCode);
        if (!queryScopePlanMatchesMetadata(input, metadata.plan))
          throw invalidInput("scopePlan", contextMismatchCode);
      }
    }
    const rawEventSummaryRequestSnapshot =
      operation === "event-summary"
        ? qualificationRequestOwnDataSnapshot(input)
        : undefined;
    if (operation === "event-summary") {
      const filters = ownDataValue(input, "filters") as
        FilterDocument | undefined;
      const metadata = scopedFilterMetadata(filters);
      const filtersDescriptor = ownDescriptor(input, "filters");
      if (
        rawEventSummaryRequestSnapshot === undefined &&
        (metadata?.plan.scope === "event" ||
          (filtersDescriptor !== undefined && !("value" in filtersDescriptor)))
      )
        throw invalidInput(
          "query",
          "event_summary_qualification_request_own_data_required",
        );
      if (metadata?.plan.scope === "event") {
        const context = ownDataValue(input, "context");
        const siteId = ownDataValue(ownDataValue(context, "subject"), "siteId");
        const requestTime = ownDataValue(input, "time");
        if (
          metadata.siteIds.length !== 1 ||
          metadata.siteIds[0] !== siteId ||
          !metadata.time ||
          !requestTime ||
          !sameEventFieldsQueryTime(requestTime as QueryTime, metadata.time) ||
          !queryScopePlanMatchesMetadata(input, metadata.plan)
        )
          throw invalidInput(
            "query",
            "event_summary_qualification_request_context_mismatch",
          );
      }
    }
    const rawEventTrendRequestSnapshot =
      operation === "event-trend"
        ? qualificationRequestOwnDataSnapshot(input)
        : undefined;
    if (
      operation === "event-trend" &&
      rawEventTrendRequestSnapshot === undefined
    )
      throw invalidInput(
        "query",
        "event_trend_qualification_request_own_data_required",
      );
    if (operation === "event-types") {
      const filtersDescriptor = ownDescriptor(input, "filters");
      const eventTypesFilters =
        filtersDescriptor && "value" in filtersDescriptor
          ? (filtersDescriptor.value as FilterDocument | undefined)
          : undefined;
      const eventTypesMetadata = scopedFilterMetadata(eventTypesFilters);
      if (
        eventTypesMetadata?.plan.scope === "event" &&
        qualificationRequestOwnDataSnapshot(input) === undefined
      )
        throw invalidInput(
          "query",
          "event_types_qualification_request_context_mismatch",
        );
    }
    const comparisonRequestProof = comparisonParentRequestProof(
      input,
      operation,
      expectedSiteId,
    );
    if (comparisonRequestProof.kind === "unsafe")
      throw invalidInput("comparison", "comparison_request_own_data_required");
    const rawAudience = ownDataValue(
      ownDataValue(input, "context") &&
        ownDataValue(ownDataValue(input, "context"), "policy"),
      "audience",
    );
    const rawPageDimension = ownDataValue(input, "dimension");
    const rawPageDimensionSelection =
      typeof rawPageDimension === "string"
        ? dimensionPageSelection(rawPageDimension)
        : null;
    const rawOverviewTab = ownDataValue(input, "tab");
    const rawOverviewPageDescriptor =
      typeof rawOverviewTab === "string"
        ? overviewPageTableDescriptor(rawOverviewTab)
        : null;
    const rawPrivatePageDimensionCandidate =
      operation === "dimension" &&
      ownDataValue(input, "mode") === "breakdown" &&
      queryHasNoComparisonState(input) &&
      rawPageDimensionSelection !== null &&
      isCanonicalPrivatePageDimensionWholeFilterRequest({
        mode: "breakdown",
        audience: rawAudience,
        dimension: rawPageDimension,
        selection: rawPageDimensionSelection,
        excludeEmpty: false,
      });
    const rawPrivateOverviewPageCandidate =
      operation === "dimension" &&
      ownDataValue(input, "mode") === "overview-tab" &&
      queryHasNoComparisonState(input) &&
      rawOverviewPageDescriptor?.family === "page" &&
      isCanonicalPrivatePageDimensionWholeFilterRequest({
        mode: "overview-tab",
        audience: rawAudience,
        tab: rawOverviewTab,
        overviewFamily: rawOverviewPageDescriptor.family,
        selection: rawOverviewPageDescriptor.selection,
        excludeEmpty: rawOverviewPageDescriptor.excludeEmpty,
      });
    const rawPrivatePagesAggregateCandidate =
      operation === "pages" &&
      rawAudience === "private-dashboard" &&
      ownDataValue(input, "mode") === undefined &&
      ownDataValue(input, "variant") !== "tabs" &&
      ownDataValue(input, "includeTabs") !== true &&
      queryHasNoComparisonState(input);
    const rawPrivateMultiOutputPageCandidate =
      rawAudience === "private-dashboard" &&
      queryHasNoComparisonState(input) &&
      (operation === "cross-dimension" ||
        operation === "radar" ||
        operation === "share-trend" ||
        operation === "performance" ||
        operation === "geo-points" ||
        (operation === "pages" &&
          ownDataValue(input, "mode") === undefined &&
          (ownDataValue(input, "variant") === "tabs" ||
            ownDataValue(input, "includeTabs") === true)));
    const rawCandidateFiltersDescriptor = ownDescriptor(input, "filters");
    const rawCandidateFiltersMetadata =
      rawCandidateFiltersDescriptor && "value" in rawCandidateFiltersDescriptor
        ? scopedFilterMetadata(
            rawCandidateFiltersDescriptor.value as FilterDocument | undefined,
          )
        : undefined;
    const rawCandidateMayUseEventProjection =
      rawCandidateFiltersMetadata?.plan.scope === "event" ||
      (rawCandidateFiltersDescriptor !== undefined &&
        !("value" in rawCandidateFiltersDescriptor));
    const rawPageCandidateRequestSnapshot =
      (rawPrivatePageDimensionCandidate ||
        rawPrivateOverviewPageCandidate ||
        rawPrivatePagesAggregateCandidate ||
        rawPrivateMultiOutputPageCandidate) &&
      rawCandidateMayUseEventProjection
        ? qualificationRequestOwnDataSnapshot(input)
        : undefined;
    if (
      (rawPrivatePageDimensionCandidate ||
        rawPrivateOverviewPageCandidate ||
        rawPrivatePagesAggregateCandidate ||
        rawPrivateMultiOutputPageCandidate) &&
      rawCandidateMayUseEventProjection &&
      rawPageCandidateRequestSnapshot === undefined
    )
      throw invalidInput(
        "query",
        "page_qualification_request_own_data_required",
      );
    const rawFilterValuesRequestSnapshot =
      operation === "filter-values"
        ? qualificationRequestOwnDataSnapshot(input)
        : undefined;
    if (
      operation === "filter-values" &&
      rawFilterValuesRequestSnapshot === undefined
    )
      throw invalidInput("query", "filter_values_request_own_data_required");
    const rawFilterValuesQualificationConfiguration =
      operation === "filter-values"
        ? filterValuesQualificationConfigurationFromQuery(input)
        : undefined;
    const rawPrivateFilterValuesWholeFilterOptIn =
      operation === "filter-values" &&
      canonicalPrivateFilterValuesWholeFilterOptIn(
        input,
        rawFilterValuesQualificationConfiguration,
      );
    const rawEventNameDimensionCandidate =
      operation === "dimension" &&
      ownDataValue(input, "mode") === "breakdown" &&
      ownDataValue(input, "dimension") === "event.name";
    const rawEventNameDimensionRequestSnapshot = rawEventNameDimensionCandidate
      ? qualificationRequestOwnDataSnapshot(input)
      : undefined;
    if (
      rawEventNameDimensionCandidate &&
      rawEventNameDimensionRequestSnapshot === undefined
    )
      throw invalidInput(
        "query",
        "event_name_dimension_request_own_data_required",
      );
    const rawEventNameDimensionContext = ownDataValue(input, "context");
    const rawEventNameDimensionPolicy = ownDataValue(
      rawEventNameDimensionContext,
      "policy",
    );
    const rawEventNameDimensionAudience = ownDataValue(
      rawEventNameDimensionPolicy,
      "audience",
    ) as QueryAudience;
    const rawEventNameDimensionRequest = rawEventNameDimensionCandidate
      ? normalizeEventNameDimensionListRequest({
          mode: ownDataValue(input, "mode"),
          dimension: ownDataValue(input, "dimension"),
          page: ownDataValue(input, "page"),
          limit: ownDataValue(input, "limit"),
          search: ownDataValue(input, "search"),
          audience: rawEventNameDimensionAudience,
        })
      : null;
    const rawPrivateTechnologyWholeFilterOptIn =
      operation === "share-trend" ||
      operation === "radar" ||
      operation === "cross-dimension"
        ? hasPrivateTechnologyWholeFilterOptIn(operation, input)
        : false;
    const rawGeoPointsWholeFilterConfiguration =
      operation === "geo-points"
        ? geoPointsQualificationConfigurationFromQuery(input)
        : undefined;
    const rawRetentionWholeFilterConfiguration =
      operation === "retention"
        ? retentionQualificationConfigurationFromQuery(input)
        : undefined;
    const rawPrivateGeoPointsWholeFilterOptIn =
      operation === "geo-points" &&
      canonicalPrivateJourneyWholeFilterRequest(
        input,
        "geo-points",
        rawGeoPointsWholeFilterConfiguration !== undefined,
      );
    const rawPrivateRetentionWholeFilterOptIn =
      operation === "retention" &&
      canonicalPrivateJourneyWholeFilterRequest(
        input,
        "retention",
        rawRetentionWholeFilterConfiguration !== undefined,
      );
    const rawPerformanceWholeFilterConfiguration =
      operation === "performance"
        ? privatePerformanceWholeFilterConfigurationFromQuery(input)
        : undefined;
    const rawModeDescriptor =
      operation === "performance" ? ownDescriptor(input, "mode") : undefined;
    const query =
      operation === "performance"
        ? copyPerformanceMiddlewareInput(input)
        : (input as QueryInput & Record<string, unknown>);
    if (
      operation === "performance" &&
      rawModeDescriptor &&
      !("value" in rawModeDescriptor)
    )
      return next(query);
    if (
      operation === "performance" &&
      rawModeDescriptor &&
      "value" in rawModeDescriptor &&
      (typeof rawModeDescriptor.value !== "string" ||
        !["summary", "timeseries", "dashboard", "breakdown"].includes(
          rawModeDescriptor.value,
        ))
    )
      return next(query);
    const querySubject = query.context.subject;
    const subject = semanticSubjectFromQuerySubject(querySubject);
    const siteIds =
      querySubject.kind === "site"
        ? [querySubject.siteId]
        : [...querySubject.authorizedSiteIds];
    const allowPageFieldWholeFilterOptIn =
      operation === "dimension" && queryHasNoComparisonState(input);
    const rawMode = ownDataValue(input, "mode");
    const rawDimension = ownDataValue(input, "dimension");
    const rawTab = ownDataValue(input, "tab");
    const allowPrivateSessionBoundaryWholeFilterOptIn =
      operation === "dimension" &&
      query.context.policy.audience === "private-dashboard" &&
      queryHasNoComparisonState(input) &&
      ((rawMode === "breakdown" &&
        (rawDimension === "session.entryPath" ||
          rawDimension === "session.exitPath")) ||
        (rawMode === "overview-tab" &&
          (rawTab === "page.entry" || rawTab === "page.exit")));
    const allowPrivateChannelListWholeFilterOptIn =
      operation === "channels" &&
      query.context.policy.audience === "private-dashboard" &&
      queryHasNoComparisonState(input) &&
      ownDataValue(input, "mode") === "list";
    const allowPrivateChannelOverviewWholeFilterOptIn =
      operation === "channels" &&
      query.context.policy.audience === "private-dashboard" &&
      queryHasNoComparisonState(input) &&
      ownDataValue(input, "mode") === "overview-tab" &&
      ownDataValue(input, "tab") === "source.channel";
    const output = { ...query } as Record<string, unknown>;
    if (
      rawPageCandidateRequestSnapshot !== undefined &&
      qualificationRequestOwnDataSnapshot(output) !==
        rawPageCandidateRequestSnapshot
    )
      throw invalidInput(
        "query",
        "page_qualification_request_context_mismatch",
      );
    if (
      operation === "event-trend" &&
      qualificationRequestOwnDataSnapshot(output) !==
        rawEventTrendRequestSnapshot
    )
      throw invalidInput(
        "query",
        "event_trend_qualification_request_context_mismatch",
      );
    if (
      operation === "event-context" &&
      qualificationRequestOwnDataSnapshot(output) !==
        rawEventContextRequestSnapshot
    )
      throw invalidInput(
        "query",
        "event_context_qualification_request_context_mismatch",
      );
    if (
      operation === "event-type-detail" &&
      qualificationRequestOwnDataSnapshot(output) !==
        rawEventTypeDetailRequestSnapshot
    )
      throw invalidInput(
        "query",
        "event_type_detail_qualification_request_context_mismatch",
      );
    const outputEventNameDimensionRequest =
      rawEventNameDimensionRequest !== null
        ? normalizeEventNameDimensionListRequest({
            mode: ownDataValue(query, "mode"),
            dimension: ownDataValue(query, "dimension"),
            page: ownDataValue(query, "page"),
            limit: ownDataValue(query, "limit"),
            search: ownDataValue(query, "search"),
            audience: query.context.policy.audience,
          })
        : null;
    const allowEventNameDimensionEventCandidate =
      rawEventNameDimensionRequest !== null &&
      outputEventNameDimensionRequest !== null &&
      rawEventNameDimensionRequestSnapshot !== undefined &&
      qualificationRequestOwnDataSnapshot(output) ===
        rawEventNameDimensionRequestSnapshot &&
      rawEventNameDimensionAudience === "private-dashboard" &&
      queryHasNoComparisonState(input) &&
      queryHasNoComparisonState(query) &&
      rawEventNameDimensionRequest.mode ===
        outputEventNameDimensionRequest.mode &&
      rawEventNameDimensionRequest.dimension ===
        outputEventNameDimensionRequest.dimension &&
      rawEventNameDimensionRequest.limit ===
        outputEventNameDimensionRequest.limit &&
      rawEventNameDimensionRequest.search ===
        outputEventNameDimensionRequest.search &&
      rawEventNameDimensionRequest.audience ===
        outputEventNameDimensionRequest.audience;
    const channelOverviewRequest =
      operation === "channels" &&
      query.mode === "overview-tab" &&
      query.tab === "source.channel";
    const channelListRequest =
      operation === "channels" && query.mode === "list";
    const pagesAggregatePageRequest =
      operation === "pages" &&
      query.mode === undefined &&
      query.variant !== "tabs" &&
      query.includeTabs !== true &&
      query.context.policy.audience === "private-dashboard";
    const pagesTabsRequest =
      operation === "pages" &&
      query.mode === undefined &&
      query.context.policy.audience === "private-dashboard" &&
      (query.variant === "tabs" || query.includeTabs === true);
    const overviewTrendConfiguration =
      operation === "overview" || operation === "trend"
        ? overviewTrendConfigurationForQuery(operation, query)
        : undefined;
    const shareTrendConfiguration =
      operation === "share-trend" && hasSafeShareTrendQueryShape(query)
        ? normalizedShareTrendConfigurationFromQuery(query)
        : undefined;
    const radarConfiguration =
      operation === "radar" && hasSafeRadarQueryShape(query)
        ? technologyRadarQualificationConfigurationFromQuery(query)
        : undefined;
    const crossDimensionConfiguration =
      operation === "cross-dimension"
        ? technologyCrossDimensionQualificationConfigurationFromQuery(query)
        : undefined;
    const performanceQualificationConfiguration =
      operation === "performance"
        ? performanceQualificationConfigurationFromQuery(query)
        : undefined;
    const allowPrivatePerformanceWholeFilterOptIn =
      performanceQualificationConfiguration !== undefined &&
      rawPerformanceWholeFilterConfiguration !== undefined &&
      matchesPerformanceSummaryQualificationConfiguration(
        performanceQualificationConfiguration,
        rawPerformanceWholeFilterConfiguration,
      );
    const allowPrivateTechnologyWholeFilterOptIn =
      rawPrivateTechnologyWholeFilterOptIn &&
      (shareTrendConfiguration !== undefined ||
        radarConfiguration !== undefined ||
        crossDimensionConfiguration !== undefined);
    const pagesDashboardQualificationConfiguration =
      operation === "pages-dashboard"
        ? pagesDashboardQualificationConfigurationFromQuery(query)
        : undefined;
    const geoPointsQualificationConfiguration =
      operation === "geo-points"
        ? geoPointsQualificationConfigurationFromQuery(query)
        : undefined;
    const allowPrivateGeoPointsWholeFilterOptIn =
      rawPrivateGeoPointsWholeFilterOptIn &&
      rawGeoPointsWholeFilterConfiguration !== undefined &&
      geoPointsQualificationConfiguration !== undefined &&
      geoPointsQualificationConfigurationsEqual(
        rawGeoPointsWholeFilterConfiguration,
        geoPointsQualificationConfiguration,
      );
    const filterValuesQualificationConfiguration =
      operation === "filter-values"
        ? filterValuesQualificationConfigurationFromQuery(query)
        : undefined;
    const allowPrivateFilterValuesWholeFilterOptIn =
      rawPrivateFilterValuesWholeFilterOptIn &&
      rawFilterValuesQualificationConfiguration !== undefined &&
      filterValuesQualificationConfiguration !== undefined &&
      filterValuesQualificationConfigurationsEqual(
        rawFilterValuesQualificationConfiguration,
        filterValuesQualificationConfiguration,
      ) &&
      qualificationRequestOwnDataSnapshot(output) ===
        rawFilterValuesRequestSnapshot;
    const retentionConfiguration =
      operation === "retention"
        ? retentionQualificationConfigurationFromQuery(query)
        : undefined;
    const allowPrivateRetentionWholeFilterOptIn =
      rawPrivateRetentionWholeFilterOptIn &&
      rawRetentionWholeFilterConfiguration !== undefined &&
      retentionConfiguration !== undefined &&
      retentionQualificationConfigurationsEqual(
        rawRetentionWholeFilterConfiguration,
        retentionConfiguration,
      );
    const sessionListQualificationConfiguration =
      operation === "sessions" || operation === "visitor-sessions"
        ? sessionListQualificationConfigurationFromQuery(query, operation)
        : undefined;
    const visitorListQualificationConfiguration =
      operation === "visitors"
        ? visitorListQualificationConfigurationFromQuery(query)
        : undefined;
    const journeyEventPageQualificationConfiguration =
      operation === "visitor-events" || operation === "session-events"
        ? journeyEventPageQualificationConfigurationFromQuery(query, operation)
        : undefined;
    if (
      overviewTrendConfiguration !== undefined &&
      expectedSiteId !== undefined &&
      querySubject.kind === "site" &&
      querySubject.siteId !== expectedSiteId
    )
      throw invalidInput("siteId", "overview_trend_request_context_mismatch");
    if (
      shareTrendConfiguration !== undefined &&
      expectedSiteId !== undefined &&
      querySubject.kind === "site" &&
      querySubject.siteId !== expectedSiteId
    )
      throw invalidInput("siteId", "share_trend_request_context_mismatch");
    if (
      radarConfiguration !== undefined &&
      expectedSiteId !== undefined &&
      querySubject.kind === "site" &&
      querySubject.siteId !== expectedSiteId
    )
      throw invalidInput("siteId", "radar_request_context_mismatch");
    if (
      crossDimensionConfiguration !== undefined &&
      expectedSiteId !== undefined &&
      querySubject.kind === "site" &&
      querySubject.siteId !== expectedSiteId
    )
      throw invalidInput("siteId", "cross_dimension_request_context_mismatch");
    if (
      performanceQualificationConfiguration !== undefined &&
      expectedSiteId !== undefined &&
      querySubject.kind === "site" &&
      querySubject.siteId !== expectedSiteId
    )
      throw invalidInput(
        "siteId",
        `performance_${performanceQualificationConfiguration.mode}_request_context_mismatch`,
      );
    if (
      pagesDashboardQualificationConfiguration !== undefined &&
      expectedSiteId !== undefined &&
      querySubject.kind === "site" &&
      querySubject.siteId !== expectedSiteId
    )
      throw invalidInput("siteId", "pages_dashboard_request_context_mismatch");
    if (
      geoPointsQualificationConfiguration !== undefined &&
      expectedSiteId !== undefined &&
      querySubject.kind === "site" &&
      querySubject.siteId !== expectedSiteId
    )
      throw invalidInput("siteId", "geo_points_request_context_mismatch");
    if (
      filterValuesQualificationConfiguration !== undefined &&
      expectedSiteId !== undefined &&
      querySubject.kind === "site" &&
      querySubject.siteId !== expectedSiteId
    )
      throw invalidInput("siteId", "filter_values_request_context_mismatch");
    if (
      retentionConfiguration !== undefined &&
      expectedSiteId !== undefined &&
      querySubject.kind === "site" &&
      querySubject.siteId !== expectedSiteId
    )
      throw invalidInput(
        "siteId",
        "retention_qualification_request_context_mismatch",
      );
    if (
      sessionListQualificationConfiguration !== undefined &&
      expectedSiteId !== undefined &&
      querySubject.kind === "site" &&
      querySubject.siteId !== expectedSiteId
    )
      throw invalidInput(
        "siteId",
        "session_list_qualification_request_context_mismatch",
      );
    if (
      visitorListQualificationConfiguration !== undefined &&
      expectedSiteId !== undefined &&
      querySubject.kind === "site" &&
      querySubject.siteId !== expectedSiteId
    )
      throw invalidInput(
        "siteId",
        "visitor_list_qualification_request_context_mismatch",
      );
    if (
      journeyEventPageQualificationConfiguration !== undefined &&
      expectedSiteId !== undefined &&
      querySubject.kind === "site" &&
      querySubject.siteId !== expectedSiteId
    )
      throw invalidInput(
        "siteId",
        "journey_event_page_qualification_request_context_mismatch",
      );
    if (
      overviewTrendConfiguration !== undefined ||
      shareTrendConfiguration !== undefined ||
      radarConfiguration !== undefined ||
      crossDimensionConfiguration !== undefined ||
      performanceQualificationConfiguration !== undefined ||
      pagesDashboardQualificationConfiguration !== undefined ||
      geoPointsQualificationConfiguration !== undefined ||
      filterValuesQualificationConfiguration !== undefined ||
      retentionConfiguration !== undefined ||
      sessionListQualificationConfiguration !== undefined ||
      visitorListQualificationConfiguration !== undefined ||
      journeyEventPageQualificationConfiguration !== undefined ||
      operation === "event-summary" ||
      operation === "event-types" ||
      operation === "event-trend" ||
      operation === "event-context" ||
      operation === "event-type-detail" ||
      operation === "event-records" ||
      operation === "event-fields" ||
      operation === "event-field-values" ||
      operation === "dimension" ||
      operation === "referrers" ||
      pagesAggregatePageRequest ||
      pagesTabsRequest ||
      channelOverviewRequest ||
      channelListRequest
    ) {
      if (
        operation === "dimension" &&
        comparisonRequestProof.kind === "matched"
      ) {
        const deferredComparison =
          await prepareDeferredComparisonPageQualification({
            env,
            query,
            parentWholeFilterProof: comparisonRequestProof.allowWholeFilter,
            operation,
            subject,
            diagnostics,
            signal: execution?.signal,
            expectedSiteId,
          });
        if (deferredComparison) {
          Object.defineProperty(
            output,
            DEFERRED_COMPARISON_PAGE_QUALIFICATION,
            {
              value: deferredComparison,
              enumerable: false,
              writable: false,
            },
          );
          return next(output);
        }
      }
      if (
        (operation === "event-fields" || operation === "event-field-values") &&
        expectedSiteId !== undefined &&
        querySubject.kind === "site" &&
        querySubject.siteId !== expectedSiteId
      )
        throw invalidInput(
          "siteId",
          operation === "event-field-values"
            ? "event_field_values_request_context_mismatch"
            : "event_fields_request_context_mismatch",
        );
      const deferredOperation: DeferredEventQualificationOperation =
        filterValuesQualificationConfiguration !== undefined
          ? "filter-values"
          : geoPointsQualificationConfiguration !== undefined
            ? "geo-points"
            : pagesDashboardQualificationConfiguration !== undefined
              ? "pages-dashboard"
              : performanceQualificationConfiguration !== undefined
                ? "performance"
                : radarConfiguration !== undefined
                  ? "radar"
                  : shareTrendConfiguration !== undefined
                    ? "share-trend"
                    : overviewTrendConfiguration !== undefined
                      ? (operation as "overview" | "trend")
                      : pagesTabsRequest
                        ? "pages-tabs"
                        : pagesAggregatePageRequest
                          ? "pages-aggregate-page"
                          : operation === "channels"
                            ? query.mode === "list"
                              ? "channel-list"
                              : "channel-overview"
                            : operation === "dimension"
                              ? query.mode === "breakdown" &&
                                query.dimension === "event.name"
                                ? "event-name-dimension"
                                : query.mode === "overview-tab" &&
                                    (query.tab === "page.entry" ||
                                      query.tab === "page.exit")
                                  ? "session-boundary-overview-page"
                                  : query.mode !== "overview-tab" &&
                                      (query.dimension ===
                                        "session.entryPath" ||
                                        query.dimension === "session.exitPath")
                                    ? "session-boundary-dimension"
                                    : "page-dimension"
                              : operation === "pages"
                                ? "pages-aggregate-page"
                                : (operation as DeferredEventQualificationOperation);
      const deferred = await prepareDeferredEventQualification({
        env,
        query,
        operation: deferredOperation,
        allowPrivatePerformanceWholeFilterOptIn,
        allowPrivateTechnologyWholeFilterOptIn,
        allowPageFieldWholeFilterOptIn,
        allowPrivateSessionBoundaryWholeFilterOptIn,
        allowPrivateChannelListWholeFilterOptIn,
        allowPrivateChannelOverviewWholeFilterOptIn,
        allowPrivateGeoPointsWholeFilterOptIn,
        allowPrivateRetentionWholeFilterOptIn,
        allowPrivateFilterValuesWholeFilterOptIn,
        allowEventNameDimensionEventCandidate,
        ...(operation === "event-trend"
          ? { eventTrendRequestSnapshot: rawEventTrendRequestSnapshot }
          : {}),
        ...(operation === "event-summary"
          ? { eventSummaryRequestSnapshot: rawEventSummaryRequestSnapshot }
          : {}),
        ...(operation === "event-context"
          ? { eventContextRequestSnapshot: rawEventContextRequestSnapshot }
          : {}),
        ...(operation === "event-type-detail"
          ? {
              eventTypeDetailRequestSnapshot: rawEventTypeDetailRequestSnapshot,
            }
          : {}),
        ...(operation === "event-records"
          ? { eventRecordsRequestSnapshot: rawEventRecordsRequestSnapshot }
          : {}),
        ...(operation === "event-fields" || operation === "event-field-values"
          ? { eventPayloadRequestSnapshot: rawEventPayloadRequestSnapshot }
          : {}),
        subject,
        diagnostics,
        signal: execution?.signal,
        expectedSiteId,
      });
      if (deferred) {
        if (performanceQualificationConfiguration !== undefined) {
          const prefix =
            performanceQualificationConfiguration.mode === "summary"
              ? "performance_summary"
              : `performance_${performanceQualificationConfiguration.mode}`;
          if (deferred.operation !== "performance" || !deferred.requestTime)
            throw new Error(prefix + "_qualification_request_time_missing");
          const configuration = Object.freeze({
            ...performanceQualificationConfiguration,
          });
          const requestSnapshot = performanceSummaryRequestSnapshot(
            query,
            configuration,
            deferred.performanceFilterMode,
          );
          if (requestSnapshot === undefined)
            throw new Error(prefix + "_qualification_request_snapshot_invalid");
          const qualifiedRequest: DeferredPerformanceSummaryQualification =
            Object.freeze({
              operation: "performance",
              configuration,
              qualification:
                deferred as DeferredPerformanceSummaryQualification["qualification"],
              requestSnapshot,
            });
          deferredPerformanceSummaryQualifications.add(qualifiedRequest);
          Object.defineProperty(
            output,
            DEFERRED_PERFORMANCE_SUMMARY_QUALIFICATION,
            { value: qualifiedRequest, enumerable: false, writable: false },
          );
          return next(output);
        }
        if (radarConfiguration !== undefined) {
          if (deferred.operation !== "radar" || !deferred.requestTime)
            throw new Error("radar_qualification_request_time_missing");
          const configuration = Object.freeze({ ...radarConfiguration });
          const requestSnapshot = radarRequestSnapshot(
            query,
            deferred,
            configuration,
          );
          if (requestSnapshot === undefined)
            throw new Error("radar_qualification_request_snapshot_invalid");
          const qualifiedRequest: DeferredRadarQualification = Object.freeze({
            operation: "radar",
            configuration,
            qualification:
              deferred as DeferredRadarQualification["qualification"],
            requestSnapshot,
          });
          deferredRadarQualifications.add(qualifiedRequest);
          radarQualificationStamps.set(qualifiedRequest, {
            qualification: deferred,
            countInput: deferred.countInput,
            analysis: deferred.countInput.analysis,
          });
          Object.defineProperty(output, DEFERRED_RADAR_QUALIFICATION, {
            value: qualifiedRequest,
            enumerable: false,
            writable: false,
          });
          return next(output);
        }
        if (shareTrendConfiguration !== undefined) {
          if (deferred.operation !== "share-trend" || !deferred.requestTime)
            throw new Error("share_trend_qualification_request_time_missing");
          const configuration = Object.freeze({
            ...shareTrendConfiguration,
          });
          const requestSnapshot = shareTrendRequestSnapshot(
            query,
            deferred,
            configuration,
          );
          if (requestSnapshot === undefined)
            throw new Error(
              "share_trend_qualification_request_snapshot_invalid",
            );
          const qualifiedRequest: DeferredShareTrendQualification =
            Object.freeze({
              operation: "share-trend",
              configuration,
              qualification:
                deferred as DeferredShareTrendQualification["qualification"],
              requestSnapshot,
            });
          deferredShareTrendQualifications.add(qualifiedRequest);
          shareTrendQualificationStamps.set(qualifiedRequest, {
            qualification: deferred,
            countInput: deferred.countInput,
            analysis: deferred.countInput.analysis,
          });
          Object.defineProperty(output, DEFERRED_SHARE_TREND_QUALIFICATION, {
            value: qualifiedRequest,
            enumerable: false,
            writable: false,
          });
          return next(output);
        }
        if (overviewTrendConfiguration !== undefined) {
          if (
            deferred.operation !== "overview" &&
            deferred.operation !== "trend"
          )
            throw new Error("overview_trend_qualification_operation_invalid");
          if (!deferred.requestTime)
            throw new Error(
              "overview_trend_qualification_request_time_missing",
            );
          const requestSnapshot = overviewTrendRequestSnapshot(
            query,
            deferred.operation,
            overviewTrendConfiguration,
          );
          if (requestSnapshot === "")
            throw new Error(
              "overview_trend_qualification_request_snapshot_invalid",
            );
          const qualifiedRequest: DeferredOverviewTrendQualification =
            Object.freeze({
              operation: deferred.operation,
              configuration: overviewTrendConfiguration,
              qualification: deferred as DeferredEventQualification & {
                readonly operation: "overview" | "trend";
                readonly requestTime: QueryTime;
              },
              requestSnapshot,
            });
          deferredOverviewTrendQualifications.add(qualifiedRequest);
          if (
            overviewTrendConfiguration.kind === "overview-with-previous" ||
            overviewTrendConfiguration.kind ===
              "overview-with-previous-and-detail"
          )
            deferredOverviewTrendQueryOrigins.set(qualifiedRequest, output);
          Object.defineProperty(output, DEFERRED_OVERVIEW_TREND_QUALIFICATION, {
            value: qualifiedRequest,
            enumerable: false,
            writable: false,
          });
          return next(output);
        }
        if (crossDimensionConfiguration !== undefined) {
          if (deferred.operation !== "cross-dimension" || !deferred.requestTime)
            throw new Error(
              "cross_dimension_qualification_request_time_missing",
            );
          const configuration = Object.freeze({
            ...crossDimensionConfiguration,
          });
          const requestSnapshot = crossDimensionRequestSnapshot(
            query,
            deferred,
            configuration,
          );
          if (requestSnapshot === undefined)
            throw new Error(
              "cross_dimension_qualification_request_snapshot_invalid",
            );
          const qualifiedRequest: DeferredCrossDimensionQualification =
            Object.freeze({
              operation: "cross-dimension",
              configuration,
              qualification:
                deferred as DeferredCrossDimensionQualification["qualification"],
              requestSnapshot,
            });
          deferredCrossDimensionQualifications.add(qualifiedRequest);
          crossDimensionQualificationStamps.set(qualifiedRequest, {
            qualification: deferred,
            countInput: deferred.countInput,
            analysis: deferred.countInput.analysis,
          });
          Object.defineProperty(
            output,
            DEFERRED_CROSS_DIMENSION_QUALIFICATION,
            {
              value: qualifiedRequest,
              enumerable: false,
              writable: false,
            },
          );
          return next(output);
        }
        if (pagesDashboardQualificationConfiguration !== undefined) {
          if (
            deferred.operation !== "pages-dashboard" ||
            !deferred.requestTime ||
            !deferred.pagesDashboardRequest
          )
            throw new Error("pages_dashboard_qualification_request_invalid");
          attachPagesDashboardQualificationToQuery(
            output as QueryInput & Record<string, unknown>,
            deferred as DeferredPagesDashboardQualificationInput,
            pagesDashboardQualificationConfiguration,
          );
          Object.defineProperty(output, DEFERRED_EVENT_QUALIFICATION, {
            value: deferred,
            enumerable: false,
            writable: false,
          });
          return next(output);
        }
        if (geoPointsQualificationConfiguration !== undefined) {
          if (deferred.operation !== "geo-points" || !deferred.requestTime)
            throw new Error("geo_points_qualification_request_invalid");
          attachGeoPointsQualificationToQuery(
            output as QueryInput & Record<string, unknown>,
            deferred as DeferredGeoPointsQualificationInput,
            geoPointsQualificationConfiguration,
          );
          Object.defineProperty(output, DEFERRED_EVENT_QUALIFICATION, {
            value: deferred,
            enumerable: false,
            writable: false,
          });
          return next(output);
        }
        if (filterValuesQualificationConfiguration !== undefined) {
          if (
            deferred.operation !== "filter-values" ||
            !deferred.requestTime ||
            !deferred.filterValuesRequest
          )
            throw new Error("filter_values_qualification_request_invalid");
          attachFilterValuesQualificationToQuery(
            output as QueryInput & Record<string, unknown>,
            deferred as DeferredFilterValuesQualificationInput,
            filterValuesQualificationConfiguration,
          );
          Object.defineProperty(output, DEFERRED_EVENT_QUALIFICATION, {
            value: deferred,
            enumerable: false,
            writable: false,
          });
          return next(output);
        }
        if (retentionConfiguration !== undefined) {
          if (deferred.operation !== "retention" || !deferred.requestTime)
            throw new Error("retention_qualification_request_invalid");
          attachRetentionQualificationToQuery(
            output as QueryInput & Record<string, unknown>,
            deferred as DeferredRetentionQualificationInput,
            retentionConfiguration,
          );
          Object.defineProperty(output, DEFERRED_EVENT_QUALIFICATION, {
            value: deferred,
            enumerable: false,
            writable: false,
          });
          return next(output);
        }
        if (sessionListQualificationConfiguration !== undefined) {
          if (
            (deferred.operation !== "sessions" &&
              deferred.operation !== "visitor-sessions") ||
            deferred.operation !==
              sessionListQualificationConfiguration.operation ||
            !deferred.requestTime ||
            !deferred.sessionListRequest
          )
            throw new Error("session_list_qualification_request_invalid");
          attachSessionListQualificationToQuery(
            output as QueryInput & Record<string, unknown>,
            deferred as DeferredSessionListQualificationInput,
            sessionListQualificationConfiguration,
          );
          Object.defineProperty(output, DEFERRED_EVENT_QUALIFICATION, {
            value: deferred,
            enumerable: false,
            writable: false,
          });
          return next(output);
        }
        if (visitorListQualificationConfiguration !== undefined) {
          if (
            deferred.operation !== "visitors" ||
            !deferred.requestTime ||
            !deferred.visitorListRequest
          )
            throw new Error("visitor_list_qualification_request_invalid");
          attachVisitorListQualificationToQuery(
            output as QueryInput & Record<string, unknown>,
            deferred as DeferredVisitorListQualificationInput,
            visitorListQualificationConfiguration,
          );
          Object.defineProperty(output, DEFERRED_EVENT_QUALIFICATION, {
            value: deferred,
            enumerable: false,
            writable: false,
          });
          return next(output);
        }
        if (journeyEventPageQualificationConfiguration !== undefined) {
          if (
            deferred.operation !== operation ||
            !deferred.requestTime ||
            !deferred.requestScopePlan ||
            !deferred.journeyEventPageRequest
          )
            throw new Error("journey_event_page_qualification_request_invalid");
          attachJourneyEventPageQualificationToQuery(
            output as QueryInput & Record<string, unknown>,
            deferred as DeferredJourneyEventPageQualificationInput,
            journeyEventPageQualificationConfiguration,
          );
          Object.defineProperty(output, DEFERRED_EVENT_QUALIFICATION, {
            value: deferred,
            enumerable: false,
            writable: false,
          });
          return next(output);
        }
        Object.defineProperty(output, DEFERRED_EVENT_QUALIFICATION, {
          value: deferred,
          enumerable: false,
          writable: false,
        });
        return next(output);
      }
    }
    if (operation === "dimension" || operation === "channels") {
      const dependency =
        await prepareIndependentPageChannelMembershipDependency({
          env,
          query,
          operation,
          subject,
          siteIds,
          diagnostics,
          signal: execution?.signal,
        });
      if (dependency) {
        independentPageChannelMemberships.set(output, dependency);
        return next(output);
      }
    }
    if (operation === "referrers") {
      const dependency = await prepareReferrersTimeMembershipDependency({
        env,
        query,
        subject,
        siteIds,
        diagnostics,
        signal: execution?.signal,
      });
      if (dependency) {
        associateWholeFilterReaderDependency(output, dependency);
        return next(output);
      }
      const pageDependency =
        await prepareIndependentReferrersPageMembershipDependency({
          env,
          query,
          subject,
          siteIds,
          diagnostics,
          signal: execution?.signal,
        });
      if (pageDependency) {
        independentReferrersPageMemberships.set(output, pageDependency);
        return next(output);
      }
    }
    if (
      operation === "dimension" &&
      comparisonRequestProof.kind === "matched"
    ) {
      const dependency = await prepareComparisonMembershipDependencies({
        env,
        query,
        subject,
        siteIds,
        diagnostics,
        signal: execution?.signal,
      });
      if (dependency) {
        comparisonMembershipDependencies.set(output, dependency);
        return next(output);
      }
    }
    if (operation === "overview" || operation === "trend") {
      const dependency = await prepareIndependentOverviewMembershipDependency({
        env,
        query,
        operation,
        subject,
        siteIds,
        diagnostics,
        signal: execution?.signal,
      });
      if (dependency) {
        independentOverviewMembershipDependencies.set(output, dependency);
        return next(output);
      }
    }
    let preparedPrimaryPlan: ScopedFilterPlan | undefined;
    const pageWholeFamily = pageWholeOriginalFamilyFromQuery(operation, query);
    const teamSitesWholeReaders =
      operation === "team-sites"
        ? planTeamSitesWholeOriginalReaders(
            query as unknown as TeamSitesMembershipQuery,
          )
        : undefined;
    const teamExactWholeReader =
      operation === "dimension"
        ? planTeamExactWholeOriginalReader(
            query as unknown as TeamExactDimensionQuery,
          )
        : undefined;
    const selectedWholeOriginalConsumer: WholeOriginalConsumer | undefined =
      teamExactWholeReader
        ? { kind: "team-exact-dimension", readers: teamExactWholeReader }
        : teamSitesWholeReaders
          ? { kind: "team-sites", readers: teamSitesWholeReaders }
          : selectWholeOriginalConsumer({
              operation,
              pageFamily: pageWholeFamily,
              eventNameDimension: outputEventNameDimensionRequest !== null,
            });
    const originalMetadata =
      selectedWholeOriginalConsumer !== undefined
        ? scopedFilterMetadata(query.filters)
        : undefined;
    const singleEventWholeConsumer =
      selectedWholeOriginalConsumer?.kind === "event-summary" ||
      selectedWholeOriginalConsumer?.kind === "event-types" ||
      selectedWholeOriginalConsumer?.kind === "event-fields" ||
      selectedWholeOriginalConsumer?.kind === "event-field-values" ||
      selectedWholeOriginalConsumer?.kind === "event-records";
    const stagedEventTrendWholeConsumer =
      selectedWholeOriginalConsumer?.kind === "event-trend";
    const dualRoleEventContextWholeConsumer =
      selectedWholeOriginalConsumer?.kind === "event-context";
    // Reuse the existing entity Page-role exposure only for this original
    // API summary path. Private whole-filter opt-ins and Event-to-Page rules
    // remain in their existing branches above.
    const apiReferrersSummaryWholeConsumer =
      selectedWholeOriginalConsumer?.kind === "page" &&
      selectedWholeOriginalConsumer.family === "referrers" &&
      query.context.policy.audience === "api-v1" &&
      ownDataValue(query, "variant") === "summary" &&
      checkPageMembershipAudiencePolicy({
        exposure: "entity-membership",
        operation: "referrers",
      }).allowed;
    const siteCompletion: WholeOriginalConsumer | undefined =
      selectedWholeOriginalConsumer !== undefined &&
      (query.context.policy.audience === "private-dashboard" ||
        apiReferrersSummaryWholeConsumer ||
        ((singleEventWholeConsumer ||
          stagedEventTrendWholeConsumer ||
          dualRoleEventContextWholeConsumer) &&
          (query.context.policy.audience === "api-v1" ||
            query.context.policy.audience === "public-share"))) &&
      querySubject.kind === "site" &&
      siteIds.length === 1 &&
      originalMetadata?.siteIds.length === 1 &&
      originalMetadata.siteIds[0] === siteIds[0] &&
      originalMetadata.time !== undefined &&
      ((originalMetadata.plan.mode === "entity" &&
        (originalMetadata.plan.scope === "session" ||
          originalMetadata.plan.scope === "visitor")) ||
        ((singleEventWholeConsumer ||
          stagedEventTrendWholeConsumer ||
          dualRoleEventContextWholeConsumer) &&
          originalMetadata.plan.mode === "observation" &&
          originalMetadata.plan.scope === "event"))
        ? selectedWholeOriginalConsumer
        : undefined;
    const completion =
      (teamSitesWholeReaders &&
        selectedWholeOriginalConsumer?.kind === "team-sites") ||
      (teamExactWholeReader &&
        selectedWholeOriginalConsumer?.kind === "team-exact-dimension")
        ? selectedWholeOriginalConsumer
        : siteCompletion;
    if (query.current && query.reference) {
      for (const sideName of ["current", "reference"] as const) {
        const side = query[sideName] as FilterSide;
        const sideMetadata = scopedFilterMetadata(side.filters);
        const comparisonReaderTab = wholeOriginalComparisonReaderTab(query.tab);
        const comparisonCompletion: WholeOriginalConsumer | undefined =
          operation === "dimension" &&
          query.mode === "overview-tab" &&
          comparisonReaderTab !== undefined &&
          query.context.policy.audience === "private-dashboard" &&
          querySubject.kind === "site" &&
          siteIds.length === 1 &&
          sideMetadata?.siteIds.length === 1 &&
          sideMetadata.siteIds[0] === siteIds[0] &&
          sideMetadata.time !== undefined &&
          sideMetadata.plan.preparedMembership === undefined &&
          sideMetadata.plan.mode === "entity" &&
          (sideMetadata.plan.scope === "session" ||
            sideMetadata.plan.scope === "visitor")
            ? {
                kind: "comparison-page",
                side: sideName,
                tab: comparisonReaderTab,
              }
            : undefined;
        const pending = prepareSide(
          env,
          subject,
          siteIds,
          side,
          diagnostics,
          execution?.signal,
          comparisonCompletion,
        );
        if (!pending) continue;
        const prepared = await pending;
        output[sideName] = prepared.side;
        if (sideName === "current") preparedPrimaryPlan = prepared.plan;
      }
    } else {
      const side: FilterSide = {
        filters: query.filters,
        ...(query.time ? { time: query.time as QueryTime } : {}),
      };
      const pending = prepareSide(
        env,
        subject,
        siteIds,
        side,
        diagnostics,
        execution?.signal,
        completion,
        (completion !== undefined &&
          query.context.policy.audience === "private-dashboard" &&
          querySubject.kind === "site") ||
          operation === "geo-points" ||
          (operation === "channels" &&
            ownDataValue(query, "mode") === "list") ||
          (operation === "pages" &&
            pageWholeFamily === "pages" &&
            ownDataValue(query, "mode") === undefined &&
            ownDataValue(query, "variant") !== "tabs" &&
            ownDataValue(query, "includeTabs") !== true) ||
          (operation === "dimension" &&
            pageWholeFamily === "dimension" &&
            ownDataValue(query, "dimension") !== "session.entryPath" &&
            ownDataValue(query, "dimension") !== "session.exitPath")
          ? execution?.program
          : undefined,
      );
      if (pending) {
        const prepared = await pending;
        output.filters = prepared.side.filters;
        transferWholeOriginalCompletion(prepared.side, output);
        preparedPrimaryPlan = prepared.plan;
      }
    }
    if (preparedPrimaryPlan) output.scopePlan = preparedPrimaryPlan;
    return next(output);
  };
}
