import { valuesRelation } from "@/lib/db";
import type {
  FilterDocument,
  QueryOperation,
  QueryTime,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import {
  attachScopedFilterMetadata,
  type ScopedFilterMetadata,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract/scoped-filter";
import {
  buildCanonicalPageReaderPlan,
  type CanonicalPageReaderInput,
} from "@/lib/edge/analytics/engine/canonical-page-reader-plan";
import { COMPARISON_MEMBERSHIP_CHILD_OUTPUTS } from "@/lib/edge/analytics/engine/comparison-membership-dependency-plan";
import {
  COMPARISON_PAGE_READER_TABS,
  comparisonPageReaderContract,
  type ComparisonPageReaderTab,
} from "@/lib/edge/analytics/engine/comparison-page-reader-contract";
import {
  buildDimensionTopPlan,
  crossBreakdownPageDimensionSelection,
  type DimensionSortKey,
  PAGE_DIMENSION_SELECTIONS,
  type PageDimensionSelection,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import { buildEventContextReportPlan } from "@/lib/edge/analytics/engine/event-context-report-plan";
import {
  buildEventFieldValuesPagePlan,
  type EventFieldValuesPageOptions,
} from "@/lib/edge/analytics/engine/event-field-values-plan";
import {
  buildEventFieldsPagePlan,
  type EventFieldsPageOptions,
} from "@/lib/edge/analytics/engine/event-fields-plan";
import { describeEventMembershipReader } from "@/lib/edge/analytics/engine/event-membership-reader-contract";
import {
  type EventTrendReaderStage,
  eventTrendStageAfterPoints,
  eventTrendStageAfterSeries,
} from "@/lib/edge/analytics/engine/event-membership-reader-contract";
import { buildEventPayloadReportSource } from "@/lib/edge/analytics/engine/event-payload-report-source";
import {
  buildEventRecordPagePlan,
  type EventRecordPageOptions,
} from "@/lib/edge/analytics/engine/event-record-page-plan";
import { buildEventSummaryCardsPlan } from "@/lib/edge/analytics/engine/event-summary-cards-plan";
import { buildEventTypeTrendPlan } from "@/lib/edge/analytics/engine/event-trend-plan";
import {
  buildEventTrendOtherPlan,
  buildEventTrendPointsPlan,
  buildEventTrendSeriesPlan,
} from "@/lib/edge/analytics/engine/event-trend-plan";
import { buildEventTypeOverviewPlan } from "@/lib/edge/analytics/engine/event-type-overview-plan";
import {
  buildEventTypeSummaryPlan,
  type EventTypeListQuery,
  type EventTypePageQuery,
} from "@/lib/edge/analytics/engine/event-type-summary-plan";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { buildOverviewAggregatePlan } from "@/lib/edge/analytics/engine/overview-aggregate-report-plan";
import { buildOverviewTrendPlan } from "@/lib/edge/analytics/engine/overview-trend-report-plan";
import {
  describePageReaderOutputs,
  type PageReaderConsumer,
  pageReaderProfile,
} from "@/lib/edge/analytics/engine/page-membership-reader-catalog";
import {
  type PageWholeOriginalFamily,
  pageWholeOriginalFamilyAccepts,
} from "@/lib/edge/analytics/engine/page-whole-original-family";
import { buildReferrerSummaryPlan } from "@/lib/edge/analytics/engine/referrer-report-plan";
import type { EventContextCardKey } from "@/lib/edge/analytics/engine/semantic/event-context-cards";
import type { EventPayloadValueTypeCode } from "@/lib/edge/analytics/engine/semantic/event-payload-value-type";
import {
  EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
} from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { TeamExactDimensionQuery } from "@/lib/edge/analytics/engine/team-exact-dimension-plan";
import type { TeamExactWholeOriginalReader } from "@/lib/edge/analytics/engine/team-exact-whole-reader-plan";
import type { TeamSitesMembershipQuery } from "@/lib/edge/analytics/engine/team-sites-membership-dependency-plan";
import type { TeamSitesWholeOriginalReaderPlan } from "@/lib/edge/analytics/engine/team-sites-whole-reader-plan";
import {
  buildTechnologyCrossBreakdownPlan,
  TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS,
  TECHNOLOGY_CROSS_BROWSER_OTHER_PRIMARY_TOKEN,
  TECHNOLOGY_CROSS_BROWSER_OTHER_SECONDARY_TOKEN,
  TECHNOLOGY_CROSS_BROWSER_UNKNOWN_TOKEN,
} from "@/lib/edge/analytics/engine/technology-cross-breakdown-report-plan";
import {
  describeWholeFilterReader,
  type WholeFilterReaderConsumer,
  type WholeFilterReaderDescription,
} from "@/lib/edge/analytics/engine/whole-filter-reader-catalog";
import type { AnalyticsDbRelation } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import type { D1ExecutionOptions } from "@/lib/edge/analytics/providers/d1/internal/execution-options";
import { sqliteBoundText } from "@/lib/edge/analytics/providers/d1/internal/lowering/scoped-source/selection-compatibility";
import {
  bindPageVisitQualificationPreparation,
  createPageVisitQualificationPreparation,
  type PageVisitQualificationPreparation,
  pageVisitQualificationRequestSnapshot,
  retirePageVisitQualificationPreparation,
  snapshotPageVisitQualificationPlan,
} from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import { qualificationRequestOwnDataSnapshot } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-request";
import {
  createTeamSitesQualification,
  type TeamSitesQualification,
} from "@/lib/edge/analytics/providers/d1/internal/team-sites-qualification";
import type { QualificationMatchRow } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-executor";
import type { WholeOriginalProjection } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-projection";

import { buildComparisonDimensionRollupPlan } from "./comparison-dimension-source";
import {
  type Interval,
  SHARE_TREND_OTHER_LABEL,
  SHARE_TREND_OTHER_TOKEN,
} from "./core";
import type { QueryWindow } from "./core-types";
import { siteExactDimensionQualificationConsumerKey } from "./dimension-top-qualification";
import {
  isInvalidOverviewSnapshot,
  snapshotOwnDataValue,
} from "./overview-previous-time";
import type { QualificationExecutionInputs } from "./qualification-execution-inputs";

export interface WholeFilterReaderDependency {
  readonly description: WholeFilterReaderDescription;
  readonly preparation: PageVisitQualificationPreparation;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly consumerKey: unknown;
  readonly requestSnapshot: string;
}

// One shared request association, not one registry per reader family. Physical
// relation authority remains exclusively in the existing pageVisit preparation.
export type WholeOriginalConsumer =
  | {
      readonly kind: "team-exact-dimension";
      readonly readers: TeamExactWholeOriginalReader;
    }
  | {
      readonly kind: "team-sites";
      readonly readers: TeamSitesWholeOriginalReaderPlan;
    }
  | {
      readonly kind:
        | "overview"
        | "trend"
        | "event-summary"
        | "event-types"
        | "event-name-dimension"
        | "event-fields"
        | "event-field-values"
        | "event-records"
        | "event-context"
        | "event-trend"
        | "event-type-detail";
    }
  | { readonly kind: "page"; readonly family: PageWholeOriginalFamily }
  | {
      readonly kind: "comparison-page";
      readonly side: "current" | "reference";
      readonly tab: ComparisonPageReaderTab;
    };
type BrowserCrossStageReader = {
  readonly kind: "technology-browser-cross-stage";
  readonly stage: "operatingSystem" | "deviceType";
  readonly configuration: {
    readonly browserLimit: number;
    readonly operatingSystemLimit: number;
    readonly deviceTypeLimit: number;
  };
};

/** Finite reader catalog selection only; the caller retains every authority gate. */
export function selectWholeOriginalConsumer(input: {
  readonly operation: QueryOperation;
  readonly pageFamily: PageWholeOriginalFamily | undefined;
  readonly eventNameDimension: boolean;
}): WholeOriginalConsumer | undefined {
  const { operation, pageFamily, eventNameDimension } = input;
  const wholeOriginalKind =
    operation === "overview" ||
    operation === "trend" ||
    operation === "event-summary" ||
    operation === "event-types" ||
    operation === "event-fields" ||
    operation === "event-field-values" ||
    operation === "event-context" ||
    operation === "event-trend" ||
    operation === "event-type-detail" ||
    operation === "event-records"
      ? operation
      : operation === "dimension" && eventNameDimension
        ? "event-name-dimension"
        : undefined;
  return pageFamily
    ? { kind: "page", family: pageFamily }
    : wholeOriginalKind
      ? { kind: wholeOriginalKind }
      : undefined;
}

export type WholeOriginalReaderConsumer =
  | {
      readonly kind: "event-trend";
      readonly configuration: {
        readonly limit: number;
        readonly interval: Interval;
        readonly eventName?: string;
      };
      readonly stage: EventTrendReaderStage;
    }
  | {
      readonly kind: "event-context";
      readonly configuration: {
        readonly limit: number;
        readonly eventName?: string;
        readonly selectedKeys?: readonly EventContextCardKey[];
      };
    }
  | {
      readonly kind: "page";
      readonly family: PageWholeOriginalFamily;
      readonly reader: PageReaderConsumer | BrowserCrossStageReader;
    }
  | {
      readonly kind: "event-fields";
      readonly configuration: EventFieldsPageOptions & {
        readonly eventName?: string;
      };
    }
  | {
      readonly kind: "event-field-values";
      readonly configuration: Omit<
        EventFieldValuesPageOptions,
        "valueTypeCode"
      > & {
        readonly valueTypeCode: EventPayloadValueTypeCode | null;
        readonly eventName?: string;
      };
    }
  | {
      readonly kind: "event-records";
      readonly configuration: EventRecordPageOptions;
    }
  | { readonly kind: "event-summary" }
  | { readonly kind: "event-types"; readonly configuration: EventTypePageQuery }
  | {
      readonly kind: "event-name-dimension";
      readonly configuration: EventTypeListQuery;
    };

export interface WholeOriginalEventDetailConfiguration {
  readonly eventName: string;
  readonly interval: Interval;
  readonly includeBreakdowns: boolean;
  readonly includeContext: boolean;
}
export type WholeOriginalEventDetailChild = "overview" | "trend" | "context";
/** Data marker only. The exact owner in requests retains all authority. */
export interface WholeOriginalEventDetailMembership {
  readonly kind: "whole-original-event-type-detail";
  readonly owner: object;
  readonly configuration: WholeOriginalEventDetailConfiguration;
}
interface EventDetailCompletion {
  readonly qualificationTimeSnapshot: unknown;
  readonly boundChildren: Set<WholeOriginalEventDetailChild>;
  configuration?: WholeOriginalEventDetailConfiguration;
}

interface WholeOriginalRequestCompletion {
  readonly kind: "whole-original";
  readonly consumer: WholeOriginalConsumer;
  readonly projection: WholeOriginalProjection;
  readonly context: {
    readonly filters: FilterDocument;
    readonly metadata: ScopedFilterMetadata;
    readonly program?: D1ExecutionOptions["program"];
  };
  preparation?: PageVisitQualificationPreparation;
  teamSitesQualification?: TeamSitesQualification;
  teamSitesQualificationTime?: QueryTime;
  teamExactQualificationTime?: QueryTime;
  teamExactPreparations?: Map<
    string,
    {
      readonly preparation: PageVisitQualificationPreparation;
      readonly filters: FilterDocument;
    }
  >;
  overviewStage?: "after-current" | "after-previous" | "done";
  eventTrendStage?:
    EventTrendReaderStage | "series-bound" | "points-bound" | "done";
  eventTrendSeriesNames?: readonly string[];
  preparationFilters?: FilterDocument;
  browserCrossStage?: "deviceType" | "done";
  browserCrossConfigurationSnapshot?: string;
  eventDetail?: EventDetailCompletion;
}
const requests = new WeakMap<
  object,
  WholeFilterReaderDependency | WholeOriginalRequestCompletion
>();

export function associateWholeFilterReaderDependency(
  query: object,
  dependency: WholeFilterReaderDependency,
): void {
  requests.set(query, dependency);
}

export function wholeFilterReaderDependencyFromQuery(
  value: unknown,
  consumer: WholeFilterReaderConsumer["kind"],
): WholeFilterReaderDependency | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = requests.get(value);
  if (
    !state ||
    !("description" in state) ||
    state.description.consumer.kind !== consumer
  )
    return undefined;
  if (qualificationRequestOwnDataSnapshot(value) !== state.requestSnapshot)
    throw new Error("referrers_time_membership_request_changed");
  return state;
}

// The original relation projection and error identities, shared with the
// trusted adapter. No semantic filter/plan carries the resulting relation.
function entityRelation(
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

function readerConsumerKey(description: WholeFilterReaderDescription) {
  return Object.freeze({
    operation: "referrers-summary",
    topN: description.consumer.configuration.topN,
    description,
  });
}

/** Synchronous completion after the caller's historical await/checkpoint. The
 * description was captured before awaiting; it does not authorize execution. */
export function createWholeFilterReaderDependency(input: {
  readonly siteId: string;
  readonly consumer: WholeFilterReaderConsumer;
  readonly readerQueryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly matches: readonly QualificationMatchRow[];
  readonly requestSnapshot: string;
}): WholeFilterReaderDependency {
  const description = describeWholeFilterReader({
    consumer: input.consumer,
    queryTime: input.readerQueryTime,
  });
  if (!description) throw new Error("whole_filter_reader_consumer_invalid");
  const consumerKey = readerConsumerKey(description);
  const sources = description.outputs[0]!.sources;
  return Object.freeze({
    description,
    preparation: createPageVisitQualificationPreparation({
      siteId: input.siteId,
      filters: input.filters,
      queryTime: input.queryTime,
      scopePlan: input.scopePlan,
      consumerKey,
      relation: entityRelation(input.siteId, input.matches),
      dependencyRef: sources[0]!.dependencyRef,
      // The closed Referrers summary has two outputs in one single-Source plan.
      maxBindings: 1,
      maxSourcesPerRole: 1,
    }),
    filters: input.filters,
    queryTime: input.queryTime,
    scopePlan: input.scopePlan,
    consumerKey,
    requestSnapshot: input.requestSnapshot,
  });
}

function assertCanonicalReaderPlan(
  plan: ValidatedLogicalPlan,
  description: WholeFilterReaderDescription,
): void {
  const expected = description.outputs;
  if (
    new Set(expected.map((o) => o.readerKey)).size !== 1 ||
    plan.outputs.length !== expected.length ||
    expected.some(
      (output) => !plan.outputs.some((actual) => actual.id === output.outputId),
    )
  )
    throw new Error("whole_filter_reader_output_mismatch");
  const sources = plan.nodes.filter((node) => node.kind === "source");
  const uses = expected[0]!.sources;
  if (
    sources.length !== uses.length ||
    sources.some(
      (node, i) =>
        node.entity !== uses[i]!.entity ||
        node.selection?.qualificationDependencyRefs?.length !== 1 ||
        node.selection.qualificationDependencyRefs[0] !==
          uses[i]!.dependencyRef,
    )
  )
    throw new Error("whole_filter_reader_sources_mismatch");
}

/** The exact canonical builder and complete existing binder context checks,
 * followed by the existing one-use lowerer input. No arbitrary plan callback. */
export function bindWholeFilterReader(input: {
  readonly dependency: WholeFilterReaderDependency;
  readonly siteId: string;
  readonly consumer: WholeFilterReaderConsumer;
}) {
  const state = input.dependency;
  const expected = describeWholeFilterReader({
    consumer: input.consumer,
    queryTime: state.description.outputs[0]!.queryTime,
  });
  if (
    !expected ||
    JSON.stringify(expected) !== JSON.stringify(state.description)
  )
    throw new Error("qualification_execution_plan_snapshot_mismatch");
  // The catalog value is untrusted data. Re-derive the binder key rather than
  // accepting a copied state object's description as preparation authority.
  const consumerKey = readerConsumerKey(expected);
  if (JSON.stringify(consumerKey) !== JSON.stringify(state.consumerKey))
    throw new Error("qualification_execution_plan_snapshot_mismatch");
  const plan = snapshotPageVisitQualificationPlan(
    buildReferrerSummaryPlan({
      siteId: input.siteId,
      queryTime: state.description.outputs[0]!.queryTime,
      filters: state.filters,
      scopePlan: state.scopePlan,
      topN: input.consumer.configuration.topN,
      qualificationDependencyRefs: [
        state.description.outputs[0]!.sources[0]!.dependencyRef,
      ],
    }),
  );
  assertCanonicalReaderPlan(plan, state.description);
  const executionInputs = bindPageVisitQualificationPreparation({
    preparation: state.preparation,
    siteId: input.siteId,
    filters: state.filters,
    queryTime: state.queryTime,
    scopePlan: state.scopePlan,
    consumerKey,
    plan,
  });
  return { plan, executionInputs };
}

/** Data association only. Exact plan authority is still the existing binder. */
export function associateWholeOriginalCompletion(
  owner: object,
  consumer: WholeOriginalConsumer,
  projection: WholeOriginalProjection,
  context: {
    readonly filters: FilterDocument;
    readonly metadata: ScopedFilterMetadata;
    /** Existing evaluator input for Team/detail readers. No new semantic work here. */
    readonly qualificationTime?: QueryTime;
    readonly program?: D1ExecutionOptions["program"];
  },
): void {
  requests.set(owner, {
    kind: "whole-original",
    consumer,
    projection,
    context,
    ...(consumer.kind === "team-exact-dimension"
      ? { teamExactQualificationTime: context.qualificationTime }
      : {}),
    ...(consumer.kind === "team-sites"
      ? { teamSitesQualificationTime: context.qualificationTime }
      : {}),
    ...(consumer.kind === "event-type-detail"
      ? {
          eventDetail: {
            qualificationTimeSnapshot: snapshotOwnDataValue(
              context.qualificationTime,
            ),
            boundChildren: new Set<WholeOriginalEventDetailChild>(),
          },
        }
      : {}),
  });
}

/** Transfers to the middleware's actual output, without taking a snapshot. */
export function transferWholeOriginalCompletion(
  from: object,
  to: object,
): void {
  const state = requests.get(from);
  if (state && "kind" in state && state.kind === "whole-original")
    requests.set(to, state);
}

export function hasWholeOriginalCompletion(
  owner: object,
  consumer: WholeOriginalConsumer["kind"],
): boolean {
  const state = requests.get(owner);
  return (
    !!state &&
    "kind" in state &&
    state.kind === "whole-original" &&
    state.consumer.kind === consumer
  );
}

/** At the old canonical reader checkpoint. Build/snapshot before preparation
 * so its normalization cannot outrank the old canonical builder's failures. */
interface WholeOriginalReaderInput<
  Consumer extends WholeOriginalReaderConsumer = WholeOriginalReaderConsumer,
> {
  readonly owner: object;
  readonly consumer: Consumer;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan?: ScopedFilterPlan;
  readonly readerQueryTime?: QueryTime;
  readonly execution?: D1ExecutionOptions;
}
type BoundWholeOriginalReader = {
  readonly plan: ValidatedLogicalPlan;
  readonly executionInputs: QualificationExecutionInputs;
  readonly execution?: never;
};
type BoundWholeOriginalProgramReader = {
  readonly plan: ValidatedLogicalPlan;
  readonly executionInputs: undefined;
  readonly execution: D1ExecutionOptions;
};
type EmptyWholeOriginalReader = { readonly kind: "empty" };
export function bindWholeOriginalReader(
  input: WholeOriginalReaderInput<
    Extract<WholeOriginalReaderConsumer, { kind: "event-field-values" }>
  >,
): BoundWholeOriginalReader | EmptyWholeOriginalReader | undefined;
export function bindWholeOriginalReader(
  input: WholeOriginalReaderInput<
    Exclude<WholeOriginalReaderConsumer, { kind: "event-field-values" }>
  > & { readonly execution?: never },
): BoundWholeOriginalReader | undefined;
export function bindWholeOriginalReader(
  input: WholeOriginalReaderInput<
    Extract<WholeOriginalReaderConsumer, { kind: "page" }>
  >,
): BoundWholeOriginalReader | BoundWholeOriginalProgramReader | undefined;
export function bindWholeOriginalReader(
  input: WholeOriginalReaderInput,
):
  | BoundWholeOriginalReader
  | BoundWholeOriginalProgramReader
  | EmptyWholeOriginalReader
  | undefined {
  const state = requests.get(input.owner);
  if (!state || !("kind" in state) || state.kind !== "whole-original")
    return undefined;
  if (state.consumer.kind !== input.consumer.kind)
    throw new Error("whole_filter_reader_consumer_mismatch");
  // The completed physical mode chooses the role. Caller-supplied mode cannot
  // relabel the evaluated identities. Canonical build errors still come first.
  const ref =
    state.projection.mode === "entity"
      ? EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY
      : EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY;
  const readerQueryTime = input.readerQueryTime ?? input.queryTime;
  const program = state.context.program;
  // The parallel browser pair keeps its existing two-attempt schedule. Every
  // ordinary canonical Page plan uses the same post-construction conversion.
  const programPageReader =
    input.consumer.kind === "page" &&
    input.consumer.reader.kind !== "technology-browser-cross-stage";
  const completed =
    programPageReader &&
    input.execution?.program &&
    state.projection.mode === "entity"
      ? (program?.completedWholeOutputs ?? [])
      : [];
  // This batch has one primary producer. Never choose an arbitrary first output
  // from a multi-side program; provenance is checked again at the binding slot.
  const matching = completed.filter(
    ({ plan }) =>
      plan.context.subject.origin === "site" &&
      plan.context.subject.siteIds.length === 1 &&
      plan.context.subject.siteIds[0] === input.siteId &&
      plan.context.scope.logicalScope === state.context.metadata.plan.scope &&
      (input.scopePlan?.scope === "session" ||
        input.scopePlan?.scope === "visitor"),
  );
  const membershipOutput =
    matching.length === 1 ? matching.find(() => true) : undefined;
  const sourceInput = {
    siteId: input.siteId,
    queryTime: readerQueryTime,
    filters: input.filters,
    ...(input.scopePlan
      ? {
          scopePlan: input.scopePlan,
          qualificationDependencyRefs: [ref],
          qualificationSemantics: "whole-original" as const,
        }
      : {}),
  };
  // Starting the fixed parallel pair is distinct from successfully binding a plan.
  // The second original async reader starts even if the first builder throws.
  // Advancing this closed attempt counter neither creates nor consumes a preparation.
  const browserCross =
    input.consumer.kind === "page" &&
    input.consumer.reader.kind === "technology-browser-cross-stage"
      ? input.consumer.reader
      : undefined;
  const browserConfigurationSnapshot = browserCross
    ? qualificationRequestOwnDataSnapshot(browserCross.configuration)
    : undefined;
  const browserAttemptAccepted =
    browserCross !== undefined &&
    state.consumer.kind === "page" &&
    state.consumer.family === "cross-dimension" &&
    input.consumer.kind === "page" &&
    input.consumer.family === "cross-dimension" &&
    state.projection.mode === "entity" &&
    (state.browserCrossStage ?? "operatingSystem") === browserCross.stage &&
    browserConfigurationSnapshot !== undefined &&
    (state.browserCrossConfigurationSnapshot === undefined ||
      state.browserCrossConfigurationSnapshot === browserConfigurationSnapshot);
  if (browserCross && browserAttemptAccepted) {
    state.browserCrossConfigurationSnapshot = browserConfigurationSnapshot;
    state.browserCrossStage =
      browserCross.stage === "operatingSystem" ? "deviceType" : "done";
  }
  let canonical: ValidatedLogicalPlan | undefined;
  switch (input.consumer.kind) {
    case "event-trend": {
      const { stage, configuration } = input.consumer;
      canonical =
        stage.kind === "series"
          ? buildEventTrendSeriesPlan({ ...sourceInput, ...configuration })
          : stage.kind === "points"
            ? buildEventTrendPointsPlan({
                ...sourceInput,
                ...configuration,
                seriesNames: stage.seriesNames,
                otherToken: SHARE_TREND_OTHER_TOKEN,
              })
            : buildEventTrendOtherPlan({
                ...sourceInput,
                ...configuration,
                seriesNames: stage.seriesNames,
                otherLabel: SHARE_TREND_OTHER_LABEL,
              });
      break;
    }
    case "page":
      if (input.consumer.reader.kind === "technology-browser-cross-stage") {
        const reader = input.consumer.reader;
        canonical = buildTechnologyCrossBreakdownPlan({
          ...sourceInput,
          pageVisitQualification: true,
          family: "browser",
          primarySelection: PAGE_DIMENSION_SELECTIONS.browser,
          secondarySelection:
            reader.stage === "operatingSystem"
              ? PAGE_DIMENSION_SELECTIONS.operatingSystem
              : PAGE_DIMENSION_SELECTIONS.deviceType,
          primaryLimit: reader.configuration.browserLimit,
          secondaryLimit:
            reader.stage === "operatingSystem"
              ? reader.configuration.operatingSystemLimit
              : reader.configuration.deviceTypeLimit,
          tokens: {
            unknown: TECHNOLOGY_CROSS_BROWSER_UNKNOWN_TOKEN,
            otherPrimary: TECHNOLOGY_CROSS_BROWSER_OTHER_PRIMARY_TOKEN,
            otherSecondary: TECHNOLOGY_CROSS_BROWSER_OTHER_SECONDARY_TOKEN,
          },
        });
      } else
        canonical = buildCanonicalPageReaderPlan(
          input.consumer.reader,
          sourceInput as CanonicalPageReaderInput,
        );
      break;
    case "event-summary":
      canonical = buildEventSummaryCardsPlan(sourceInput);
      break;
    case "event-types":
    case "event-name-dimension":
      canonical = buildEventTypeSummaryPlan({
        ...sourceInput,
        query: input.consumer.configuration,
      });
      break;
    case "event-context":
      canonical = buildEventContextReportPlan({
        ...input.consumer.configuration,
        ...sourceInput,
        pageVisitDependencyRefs: [
          state.projection.mode === "entity"
            ? EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY
            : EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
        ],
      });
      break;
    case "event-fields":
      canonical = buildEventFieldsPagePlan({
        ...input.consumer.configuration,
        ...sourceInput,
      });
      break;
    case "event-records":
      canonical = buildEventRecordPagePlan({
        ...sourceInput,
        options: input.consumer.configuration,
      });
      break;
    case "event-field-values": {
      const configuration = input.consumer.configuration;
      // Original values reader validates its Source before the unknown-type early return.
      const source = buildEventPayloadReportSource({
        ...sourceInput,
        ...(configuration.eventName !== undefined
          ? { eventName: configuration.eventName }
          : {}),
      });
      if (configuration.valueTypeCode !== null)
        canonical = buildEventFieldValuesPagePlan({
          ...configuration,
          valueTypeCode: configuration.valueTypeCode,
          source,
        });
      break;
    }
  }
  const plan = canonical
    ? snapshotPageVisitQualificationPlan(canonical)
    : undefined;
  const metadata = scopedFilterMetadata(input.filters);
  if (
    input.filters !== state.context.filters ||
    metadata !== state.context.metadata ||
    !input.scopePlan ||
    input.scopePlan !== metadata?.plan ||
    (input.consumer.kind === "event-trend"
      ? JSON.stringify(input.queryTime) !== JSON.stringify(metadata?.time)
      : input.queryTime !== metadata?.time) ||
    input.scopePlan.mode !== state.projection.mode ||
    state.projection.siteIds.length !== 1 ||
    input.siteId !== state.projection.siteIds[0] ||
    metadata.siteIds.length !== state.projection.siteIds.length ||
    metadata.siteIds.some((id, i) => id !== state.projection.siteIds[i])
  )
    throw new Error("qualification_execution_plan_snapshot_mismatch");
  // No fabricated output or preparation for the original empty values branch.
  if (!plan) return { kind: "empty" };
  const browserOutputIds = Object.values(TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS);
  const profile =
    input.consumer.kind === "page" &&
    input.consumer.reader.kind !== "technology-browser-cross-stage"
      ? pageReaderProfile(input.consumer.reader)
      : browserCross
        ? { planOutputIds: browserOutputIds }
        : undefined;
  if (
    browserCross &&
    (state.consumer.kind !== "page" ||
      state.consumer.family !== "cross-dimension" ||
      input.consumer.kind !== "page" ||
      input.consumer.family !== "cross-dimension" ||
      state.projection.mode !== "entity" ||
      !browserAttemptAccepted)
  )
    throw new Error("whole_filter_reader_consumer_mismatch");
  if (
    input.consumer.kind === "page" &&
    (state.consumer.kind !== "page" ||
      state.consumer.family !== input.consumer.family ||
      state.projection.mode !== "entity" ||
      !(
        input.consumer.reader.kind === "technology-browser-cross-stage" ||
        pageWholeOriginalFamilyAccepts(
          input.consumer.family,
          input.consumer.reader,
        )
      ))
  )
    throw new Error("whole_filter_reader_consumer_mismatch");
  const description =
    input.consumer.kind === "page"
      ? {
          outputs:
            input.consumer.reader.kind === "technology-browser-cross-stage"
              ? browserOutputIds.map((outputId) => ({
                  key: outputId,
                  readerKey: `browser-cross-${browserCross!.stage}`,
                  outputId,
                  preparationKey: "original" as const,
                  queryTime: readerQueryTime,
                  sources: [{ entity: "page" as const, dependencyRef: ref }],
                }))
              : (describePageReaderOutputs({
                  consumer: input.consumer.reader,
                  queryTime: readerQueryTime,
                  preparationKey: "original",
                  dependencyRef: ref,
                }) ?? []),
        }
      : describeEventMembershipReader({
          consumer:
            input.consumer.kind === "event-context"
              ? {
                  kind: "event-context",
                  ...(input.consumer.configuration.selectedKeys !== undefined
                    ? {
                        selectedKeys: input.consumer.configuration.selectedKeys,
                      }
                    : {}),
                }
              : input.consumer,
          queryTime: readerQueryTime,
          mode: state.projection.mode,
        });
  if (!description || description.outputs.length === 0)
    throw new Error("whole_filter_reader_consumer_invalid");
  const uses = description.outputs[0]!.sources;
  const sources = plan.nodes.filter((node) => node.kind === "source");
  if (
    new Set(description.outputs.map((o) => o.readerKey)).size !== 1 ||
    plan.outputs.length !==
      (profile?.planOutputIds.length ?? description.outputs.length) ||
    (profile?.planOutputIds.some(
      (id) => !plan.outputs.some((actual) => actual.id === id),
    ) ??
      false) ||
    description.outputs.some(
      (o) => !plan.outputs.some((actual) => actual.id === o.outputId),
    )
  )
    throw new Error("whole_filter_reader_output_mismatch");
  if (
    sources.length !== uses.length ||
    sources.some(
      (source, i) =>
        source.entity !== uses[i]!.entity ||
        source.selection?.qualificationDependencyRefs?.length !== 1 ||
        source.selection.qualificationDependencyRefs[0] !==
          uses[i]!.dependencyRef,
    )
  )
    throw new Error("whole_filter_reader_sources_mismatch");
  if (completed.length > 0 && (completed.length !== 1 || matching.length !== 1))
    throw new Error("whole_filter_reader_program_producer_ambiguous");
  if (
    programPageReader &&
    program &&
    input.execution?.program &&
    input.execution.program !== program
  )
    throw new Error("qualification_execution_program_producer_mismatch");
  const relation =
    state.projection.mode === "entity"
      ? state.projection.relations.entity
      : state.projection.relations.event;
  if (!relation) throw new Error("prepared_membership_role_missing");
  // Only the existing Context descriptor may consume the Page visit role
  // alongside its Event role; both are projections of this one evaluation.
  const contextNeedsPageVisits =
    input.consumer.kind === "event-context" &&
    state.projection.mode === "observation" &&
    uses.some(
      (use) =>
        use.entity === "page" &&
        use.dependencyRef === EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
    );
  const contextPageVisits = contextNeedsPageVisits
    ? state.projection.relations.visit
    : undefined;
  if (contextNeedsPageVisits && !contextPageVisits)
    throw new Error("prepared_membership_role_missing");
  // The closed canonical descriptor owns the complete Source occurrences.
  // This is not a caller-supplied budget, and the actual plan was checked above.
  const sourceCounts = new Map<
    (typeof uses)[number]["dependencyRef"],
    number
  >();
  for (const use of uses)
    sourceCounts.set(
      use.dependencyRef,
      (sourceCounts.get(use.dependencyRef) ?? 0) + 1,
    );
  const maxSourcesPerRole = Math.max(...sourceCounts.values());
  const trendConsumer =
    input.consumer.kind === "event-trend" ? input.consumer : undefined;
  if (trendConsumer) {
    const expected = state.eventTrendStage;
    if (
      trendConsumer.stage.kind === "series"
        ? expected !== undefined
        : !expected ||
          typeof expected !== "object" ||
          expected.kind !== trendConsumer.stage.kind ||
          JSON.stringify(expected) !== JSON.stringify(trendConsumer.stage)
    )
      throw new Error("event_trend_whole_reader_stage_mismatch");
  }
  const consumerKey = browserCross
    ? {
        consumer: {
          kind: "page",
          family: "cross-dimension",
          schedule: "browser-cross-pair-v1",
          configuration: browserCross.configuration,
        },
      }
    : trendConsumer
      ? {
          consumer: {
            kind: "event-trend",
            configuration: trendConsumer.configuration,
          },
          schedule: "series-points-optional-other-v1",
        }
      : { consumer: input.consumer, description };
  const preparationFilters = trendConsumer
    ? (state.preparationFilters ?? sources[0]!.selection!.filter)
    : input.filters;
  if (membershipOutput && program && input.execution) {
    const requestSnapshot = state.preparation
      ? pageVisitQualificationRequestSnapshot(state.preparation)
      : undefined;
    const programPlan = program.bindWholeOriginalPageConsumer({
      consumer: state,
      siteId: input.siteId,
      filters: preparationFilters,
      queryTime: input.queryTime,
      scopePlan: input.scopePlan,
      consumerKey,
      plan,
      readerQueryTime,
      membershipOutput,
      ...(requestSnapshot ? { requestSnapshot } : {}),
    });
    if (state.preparation)
      retirePageVisitQualificationPreparation(
        state.preparation,
        plan,
        programPlan,
      );
    return {
      plan: programPlan,
      executionInputs: undefined,
      execution: input.execution,
    };
  }
  const nativeRequestSnapshot = programPageReader
    ? program?.readWholeOriginalPageConsumerSnapshot(state)
    : undefined;
  const preparation =
    state.preparation ??
    createPageVisitQualificationPreparation({
      siteId: input.siteId,
      filters: preparationFilters,
      queryTime: input.queryTime,
      scopePlan: input.scopePlan,
      consumerKey,
      relation,
      dependencyRef: ref,
      ...(nativeRequestSnapshot
        ? { requestSnapshot: nativeRequestSnapshot }
        : {}),
      ...(contextPageVisits
        ? {
            additionalRelations: [
              {
                dependencyRef: EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
                relation: contextPageVisits,
              },
            ],
          }
        : {}),
      maxBindings: browserCross ? 2 : trendConsumer ? 3 : 1,
      maxSourcesPerRole,
      qualificationSemantics: "whole-original",
    });
  state.preparation = preparation;
  if (trendConsumer) state.preparationFilters = preparationFilters;
  const executionInputs = bindPageVisitQualificationPreparation({
    preparation,
    siteId: input.siteId,
    filters: preparationFilters,
    queryTime: input.queryTime,
    scopePlan: input.scopePlan,
    consumerKey,
    plan,
    readerQueryTime,
    ...(trendConsumer ? { readerFilters: sources[0]!.selection!.filter } : {}),
  });
  if (trendConsumer)
    state.eventTrendStage =
      trendConsumer.stage.kind === "series"
        ? "series-bound"
        : trendConsumer.stage.kind === "points"
          ? "points-bound"
          : "done";
  return { plan, executionInputs };
}

/** Independent parallel child claims at the old synchronous canonical point.
 * No attempt counter, callback, new registry, async frame or cleanup reproof. */
export function bindWholeOriginalEventDetailReader(input: {
  readonly membership: WholeOriginalEventDetailMembership;
  readonly child: WholeOriginalEventDetailChild;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly readerQueryTime: QueryTime;
  readonly scopePlan?: ScopedFilterPlan;
}): BoundWholeOriginalReader | undefined {
  const state = requests.get(input.membership.owner);
  if (!state || !("kind" in state) || state.kind !== "whole-original")
    return undefined;
  const configuration = input.membership.configuration;
  const ref =
    state.projection.mode === "entity"
      ? EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY
      : EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY;
  const sourceInput = {
    siteId: input.siteId,
    queryTime: input.readerQueryTime,
    filters: input.filters,
    ...(input.scopePlan
      ? {
          scopePlan: input.scopePlan,
          qualificationDependencyRefs: [ref],
          qualificationSemantics: "whole-original" as const,
        }
      : {}),
  };
  // These real factories must remain before normalization, slot and context errors.
  const canonical =
    input.child === "overview"
      ? buildEventTypeOverviewPlan({
          ...sourceInput,
          eventName: configuration.eventName,
          includeBreakdowns: configuration.includeBreakdowns,
          denominatorSource: "event-report",
        })
      : input.child === "trend"
        ? buildEventTypeTrendPlan({
            ...sourceInput,
            eventName: configuration.eventName,
            interval: configuration.interval,
          })
        : buildEventContextReportPlan({
            ...sourceInput,
            eventName: configuration.eventName,
            limit: 100,
            pageVisitDependencyRefs: [
              state.projection.mode === "entity"
                ? EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY
                : EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
            ],
          });
  // Context's actual factory reads preparation metadata during this same
  // synchronous section. This does not claim arbitrary getter/wrapper parity.
  const metadata = scopedFilterMetadata(input.filters);
  const readerPreparationTime =
    input.child === "context" ? metadata?.time : input.queryTime;
  const plan = snapshotPageVisitQualificationPlan(canonical);
  if (state.consumer.kind !== "event-type-detail" || !state.eventDetail)
    throw new Error("whole_filter_reader_consumer_mismatch");
  if (
    input.filters !== state.context.filters ||
    metadata !== state.context.metadata ||
    !input.scopePlan ||
    input.scopePlan !== metadata?.plan ||
    input.scopePlan.mode !== state.projection.mode ||
    state.projection.mode !== "entity" ||
    state.projection.siteIds.length !== 1 ||
    input.siteId !== state.projection.siteIds[0] ||
    metadata.siteIds.length !== 1 ||
    metadata.siteIds[0] !== input.siteId ||
    !readerPreparationTime
  )
    throw new Error("qualification_execution_plan_snapshot_mismatch");
  const detail = state.eventDetail;
  if (detail.boundChildren.has(input.child))
    throw new Error("event_type_detail_whole_reader_reused");
  if (
    detail.configuration &&
    (detail.configuration.eventName !== configuration.eventName ||
      !Object.is(detail.configuration.interval, configuration.interval) ||
      detail.configuration.includeBreakdowns !==
        configuration.includeBreakdowns ||
      detail.configuration.includeContext !== configuration.includeContext)
  )
    throw new Error("whole_filter_reader_consumer_mismatch");
  const description = describeEventMembershipReader({
    consumer: {
      kind: "event-type-detail",
      includeBreakdowns: configuration.includeBreakdowns,
      includeContext: configuration.includeContext,
    },
    queryTime: input.readerQueryTime,
    mode: state.projection.mode,
  });
  const readers = new Map(
    description?.outputs.map((o) => [o.readerKey, o.sources]),
  );
  const outputs = description?.outputs.filter(
    (o) => o.readerKey === "event-type-detail:" + input.child,
  );
  if (!outputs?.length) throw new Error("whole_filter_reader_consumer_invalid");
  const sources = plan.nodes.filter((node) => node.kind === "source");
  const uses = outputs[0]!.sources;
  if (
    plan.outputs.length !== outputs.length ||
    outputs.some((o) => !plan.outputs.some((p) => p.id === o.outputId))
  )
    throw new Error("whole_filter_reader_output_mismatch");
  if (
    sources.length !== uses.length ||
    sources.some(
      (s, i) =>
        s.entity !== uses[i]!.entity ||
        s.selection?.qualificationDependencyRefs?.length !== 1 ||
        s.selection.qualificationDependencyRefs[0] !== uses[i]!.dependencyRef,
    )
  )
    throw new Error("whole_filter_reader_sources_mismatch");
  // Count the FULL closed child set, not just the first successful reader.
  const counts = [...readers.values()].flatMap((uses) => {
    const perRole = new Map<(typeof uses)[number]["dependencyRef"], number>();
    for (const use of uses)
      perRole.set(use.dependencyRef, (perRole.get(use.dependencyRef) ?? 0) + 1);
    return [...perRole.values()];
  });
  const qualificationTime = detail.qualificationTimeSnapshot;
  if (
    isInvalidOverviewSnapshot(qualificationTime) ||
    !qualificationTime ||
    typeof qualificationTime !== "object"
  )
    throw new Error("qualification_execution_plan_snapshot_mismatch");
  const preparationTime = qualificationTime as QueryTime;
  const relation = state.projection.relations.entity;
  if (!relation) throw new Error("prepared_membership_role_missing");
  // The raw interval is checked by its own original canonical builder, not
  // prematurely normalized through another child's preparation consumer key.
  const consumerKey = {
    kind: "event-type-detail",
    schedule: "parallel-independent-children-v1",
    eventName: configuration.eventName,
    includeBreakdowns: configuration.includeBreakdowns,
    includeContext: configuration.includeContext,
  };
  const preparationFilters =
    state.preparationFilters ?? sources[0]!.selection!.filter;
  const preparation =
    state.preparation ??
    createPageVisitQualificationPreparation({
      siteId: input.siteId,
      filters: preparationFilters,
      queryTime: preparationTime,
      scopePlan: input.scopePlan,
      consumerKey,
      relation,
      dependencyRef: ref,
      maxBindings: readers.size,
      maxSourcesPerRole: Math.max(...counts),
      qualificationSemantics: "whole-original",
    });
  state.preparation = preparation;
  state.preparationFilters = preparationFilters;
  const executionInputs = bindPageVisitQualificationPreparation({
    preparation,
    siteId: input.siteId,
    filters: preparationFilters,
    queryTime: preparationTime,
    scopePlan: input.scopePlan,
    consumerKey,
    plan,
    readerQueryTime: input.readerQueryTime,
    readerPreparationTime,
    readerFilters: sources[0]!.selection!.filter,
  });
  detail.configuration ??= { ...configuration };
  detail.boundChildren.add(input.child);
  return { plan, executionInputs };
}

/** Closed data marker only: authority is the existing request association. */
export interface WholeOriginalOverviewMembership {
  readonly kind: "whole-original-overview";
  readonly owner: object;
}

/** No post-await context validation: cleanup cannot mask the original error. */
export function finishWholeOriginalOverview(owner: object): void {
  const state = requests.get(owner);
  if (
    state &&
    "kind" in state &&
    state.kind === "whole-original" &&
    (state.consumer.kind === "overview" || state.consumer.kind === "trend")
  )
    state.overviewStage = "done";
}

/** Canonical construction occurs at each original raw reader checkpoint. */
export function bindWholeOriginalOverview(input: {
  readonly owner: object;
  readonly kind: "aggregate" | "trend";
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly readerQueryTime: QueryTime;
  readonly interval?: Interval;
}): BoundWholeOriginalReader {
  const state = requests.get(input.owner);
  if (
    !state ||
    !("kind" in state) ||
    state.kind !== "whole-original" ||
    (state.consumer.kind !== "overview" && state.consumer.kind !== "trend")
  )
    throw new Error("whole_filter_reader_consumer_mismatch");
  const metadata = scopedFilterMetadata(input.filters);
  const source = {
    siteId: input.siteId,
    queryTime: input.readerQueryTime,
    filters: input.filters,
    ...(metadata?.plan
      ? {
          scopePlan: metadata.plan,
          qualificationDependencyRefs: [
            EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
          ],
          pageVisitDependencyRefs: [EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY],
          qualificationSemantics: "whole-original" as const,
        }
      : {}),
  };
  const plan = snapshotPageVisitQualificationPlan(
    input.kind === "aggregate"
      ? buildOverviewAggregatePlan(source)
      : buildOverviewTrendPlan({ ...source, interval: input.interval! }),
  );
  if (
    input.filters !== state.context.filters ||
    metadata !== state.context.metadata ||
    !metadata ||
    metadata.plan.mode !== "entity" ||
    state.projection.mode !== "entity" ||
    state.projection.siteIds.length !== 1 ||
    input.siteId !== state.projection.siteIds[0] ||
    metadata.siteIds.length !== 1 ||
    metadata.siteIds[0] !== input.siteId ||
    (metadata.plan.scope !== "session" && metadata.plan.scope !== "visitor")
  )
    throw new Error("qualification_execution_plan_snapshot_mismatch");
  const stage = state.overviewStage;
  const next =
    state.consumer.kind === "trend"
      ? stage === undefined && input.kind === "trend"
        ? "done"
        : undefined
      : stage === undefined && input.kind === "aggregate"
        ? "after-current"
        : stage === "after-current" && input.kind === "aggregate"
          ? "after-previous"
          : (stage === "after-current" || stage === "after-previous") &&
              input.kind === "trend"
            ? "done"
            : undefined;
  if (!next) throw new Error("overview_whole_reader_stage_mismatch");
  const sources = plan.nodes.filter((node) => node.kind === "source");
  const outputId =
    input.kind === "aggregate" ? "overview-aggregate" : "overview-trend";
  if (
    plan.outputs.length !== 1 ||
    plan.outputs[0]?.id !== outputId ||
    sources.length !== 2 ||
    sources[0]?.entity !== "page" ||
    sources[1]?.entity !== "event" ||
    sources.some(
      (node) =>
        node.selection?.qualificationDependencyRefs?.length !== 1 ||
        node.selection.qualificationDependencyRefs[0] !==
          EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
    ) ||
    JSON.stringify(sources[0]?.selection?.filter) !==
      JSON.stringify(sources[1]?.selection?.filter)
  )
    throw new Error("whole_filter_reader_sources_mismatch");
  const readerFilters = sources[0]!.selection!.filter;
  const preparationFilters = state.preparationFilters ?? readerFilters;
  const relation = state.projection.relations.entity;
  if (!relation) throw new Error("prepared_membership_role_missing");
  const consumerKey =
    state.consumer.kind === "overview"
      ? "whole-original-overview-current-previous-detail-v1"
      : "whole-original-trend-single-v1";
  const preparation =
    state.preparation ??
    createPageVisitQualificationPreparation({
      siteId: input.siteId,
      filters: preparationFilters,
      queryTime: metadata.time,
      scopePlan: metadata.plan,
      consumerKey,
      relation,
      dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
      maxBindings: state.consumer.kind === "overview" ? 3 : 1,
      maxSourcesPerRole: 2,
      qualificationSemantics: "whole-original",
    });
  // Retain even a failed attempted binding; never remint its authority.
  state.preparation = preparation;
  state.preparationFilters = preparationFilters;
  const executionInputs = bindPageVisitQualificationPreparation({
    preparation,
    siteId: input.siteId,
    filters: preparationFilters,
    queryTime: metadata.time,
    scopePlan: metadata.plan,
    consumerKey,
    plan,
    readerQueryTime: input.readerQueryTime,
    readerFilters,
  });
  state.overviewStage = next;
  return { plan, executionInputs };
}

/** Records only the real mapped result at the existing provider await checkpoint.
 * Shape declarations are values; the request association/preparation retains authority. */
export function advanceWholeOriginalEventTrend(
  owner: object,
  result:
    | {
        readonly kind: "series";
        readonly rows: readonly { readonly eventName: string }[];
      }
    | {
        readonly kind: "points";
        readonly rows: readonly { readonly seriesKey: string }[];
      },
): void {
  const state = requests.get(owner);
  if (
    !state ||
    !("kind" in state) ||
    state.kind !== "whole-original" ||
    state.consumer.kind !== "event-trend"
  )
    throw new Error("whole_filter_reader_consumer_mismatch");
  if (result.kind === "series") {
    if (state.eventTrendStage !== "series-bound")
      throw new Error("event_trend_whole_reader_stage_mismatch");
    const next = eventTrendStageAfterSeries(result.rows);
    state.eventTrendSeriesNames = next.seriesNames;
    state.eventTrendStage = next;
  } else {
    if (
      state.eventTrendStage !== "points-bound" ||
      !state.eventTrendSeriesNames
    )
      throw new Error("event_trend_whole_reader_stage_mismatch");
    state.eventTrendStage =
      eventTrendStageAfterPoints(
        { kind: "points", seriesNames: state.eventTrendSeriesNames },
        result.rows,
      ) ?? "done";
  }
}

/** The two original side owners remain independently request-owned. This data
 * marker neither completes evaluation nor grants a relation to a caller. */
export interface WholeOriginalComparisonMembership {
  readonly kind: "whole-original-comparison-page";
  readonly tab: ComparisonPageReaderTab;
  readonly current?: object;
  readonly reference?: object;
}

/** Called only after both original rollups and the outer comparison builder.
 * No async frame, callback, new authority map or alternate qualification work. */
export function bindWholeOriginalComparisonChild(input: {
  readonly owner: object;
  readonly side: "current" | "reference";
  readonly tab: ComparisonPageReaderTab;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly plan: ValidatedLogicalPlan;
}): QualificationExecutionInputs {
  const state = requests.get(input.owner);
  const reader = comparisonPageReaderContract(input.tab);
  // The caller's historical canonical builders already completed. Reject an
  // unknown closed catalog tag explicitly rather than dereferencing it.
  if (
    wholeOriginalComparisonReaderTab(input.tab) === undefined ||
    reader?.route !== "membership-recipe"
  )
    throw new Error("whole_filter_comparison_child_mismatch");
  // Reconstruct the fixed canonical shape after all historical builders ran.
  // The accepted child is the frozen actual child of that outer plan.
  const expected = snapshotPageVisitQualificationPlan(
    buildComparisonDimensionRollupPlan({
      siteId: input.siteId,
      window: input.window,
      filters: input.filters,
      selection: reader.selection,
      entityDependency: true,
      qualificationSemantics: "whole-original",
      outputId: COMPARISON_MEMBERSHIP_CHILD_OUTPUTS[input.side],
    }),
  );
  if (
    !state ||
    !("kind" in state) ||
    state.kind !== "whole-original" ||
    state.consumer.kind !== "comparison-page" ||
    state.consumer.side !== input.side ||
    state.consumer.tab !== input.tab ||
    reader?.route !== "membership-recipe" ||
    qualificationRequestOwnDataSnapshot(input.plan) !==
      qualificationRequestOwnDataSnapshot(expected)
  )
    throw new Error("whole_filter_comparison_child_mismatch");
  const metadata = scopedFilterMetadata(input.filters);
  if (
    input.filters !== state.context.filters ||
    metadata !== state.context.metadata ||
    !metadata?.time ||
    metadata.plan.mode !== "entity" ||
    state.projection.mode !== "entity" ||
    state.projection.siteIds.length !== 1 ||
    state.projection.siteIds[0] !== input.siteId ||
    metadata.siteIds.length !== 1 ||
    metadata.siteIds[0] !== input.siteId
  )
    throw new Error("qualification_execution_plan_snapshot_mismatch");
  const sources = input.plan.nodes.filter((node) => node.kind === "source");
  const ref = EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY;
  if (
    sources.length !== 1 ||
    sources[0]!.entity !== "page" ||
    sources[0]!.selection?.qualificationDependencyRefs?.length !== 1 ||
    sources[0]!.selection.qualificationDependencyRefs[0] !== ref ||
    input.plan.outputs.length !== 1 ||
    input.plan.outputs[0]!.id !==
      COMPARISON_MEMBERSHIP_CHILD_OUTPUTS[input.side]
  )
    throw new Error("whole_filter_reader_sources_mismatch");
  const relation = state.projection.relations.entity;
  if (!relation) throw new Error("prepared_membership_role_missing");
  const consumerKey = {
    kind: "comparison-page",
    side: input.side,
    tab: input.tab,
  };
  const preparationFilters =
    state.preparationFilters ?? sources[0]!.selection!.filter;
  const preparation =
    state.preparation ??
    createPageVisitQualificationPreparation({
      siteId: input.siteId,
      filters: preparationFilters,
      queryTime: metadata.time,
      scopePlan: metadata.plan,
      consumerKey,
      relation,
      dependencyRef: ref,
      maxBindings: 1,
      maxSourcesPerRole: 1,
      qualificationSemantics: "whole-original",
    });
  state.preparation = preparation;
  state.preparationFilters = preparationFilters;
  return bindPageVisitQualificationPreparation({
    preparation,
    siteId: input.siteId,
    filters: preparationFilters,
    queryTime: metadata.time,
    scopePlan: metadata.plan,
    consumerKey,
    plan: input.plan,
    readerQueryTime: queryWindowToTime(input.window),
    readerFilters: sources[0]!.selection!.filter,
  });
}

/** Exact finite catalog lookup. This names a reader, never an audience or cap. */
export function wholeOriginalComparisonReaderTab(
  value: unknown,
): ComparisonPageReaderTab | undefined {
  return COMPARISON_PAGE_READER_TABS.find(
    (tab) =>
      tab === value &&
      comparisonPageReaderContract(tab)?.route === "membership-recipe",
  );
}

/** One existing request association owns the joint projection. No identity rows,
 * coverage map, caller slots or new registry enter this consumer handoff. */
export function wholeOriginalTeamSitesQualificationFromQuery(
  query: TeamSitesMembershipQuery,
): TeamSitesQualification | undefined {
  const state = requests.get(query);
  if (
    !state ||
    !("kind" in state) ||
    state.kind !== "whole-original" ||
    state.consumer.kind !== "team-sites"
  )
    return undefined;
  if (state.teamSitesQualification) return state.teamSitesQualification;
  const recipe = state.consumer.readers;
  const context = state.context;
  const qualificationTime = state.teamSitesQualificationTime;
  const subject = query.context.subject;
  const relation = state.projection.relations.entity;
  const assertFresh = () => {
    const current = scopedFilterMetadata(query.filters);
    if (
      query.filters !== context.filters ||
      current !== context.metadata ||
      current.plan !== query.scopePlan ||
      subject.kind !== "team" ||
      query.context.subject !== subject ||
      query.context.policy.audience !== "private-dashboard" ||
      state.projection.mode !== "entity" ||
      !relation ||
      !qualificationTime ||
      state.projection.siteIds.length !== recipe.siteIds.length ||
      recipe.siteIds.some(
        (id, index) => id !== state.projection.siteIds[index],
      ) ||
      current.siteIds.length !== recipe.siteIds.length ||
      current.siteIds.some((id, index) => id !== recipe.siteIds[index]) ||
      subject.authorizedSiteIds.length !== recipe.siteIds.length ||
      new Set(subject.authorizedSiteIds).size !== recipe.siteIds.length ||
      subject.authorizedSiteIds.some((id) => !recipe.siteIds.includes(id))
    )
      throw new Error("team_sites_whole_original_context_mismatch");
  };
  assertFresh();
  state.teamSitesQualification = createTeamSitesQualification({
    query,
    recipe,
    relation: relation!,
    assertFresh,
    qualificationTime: qualificationTime!,
  });
  return state.teamSitesQualification;
}

/** One original per-site Page reader, backed by the same complete joint relation.
 * Canonical build precedes preparation/claim; a failed builder mints no slot.
 * The opaque owner is the existing request association, never a filter handle. */
export function bindTeamExactWholeOriginalReader(input: {
  readonly owner: object;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly readerQueryTime: QueryTime;
  readonly selection: PageDimensionSelection;
  readonly dimension: string;
  readonly limit: number;
  readonly excludeEmpty?: boolean;
  readonly search?: string;
  readonly sortBy: DimensionSortKey;
  readonly sortDirection: "asc" | "desc";
}) {
  const state = requests.get(input.owner);
  if (
    !state ||
    !("kind" in state) ||
    state.kind !== "whole-original" ||
    state.consumer.kind !== "team-exact-dimension"
  )
    return undefined;
  const query = input.owner as TeamExactDimensionQuery;
  const metadata = scopedFilterMetadata(input.filters);
  const readerFilters = metadata
    ? attachScopedFilterMetadata(input.filters, {
        ...metadata,
        siteIds: [input.siteId],
      })
    : input.filters;
  // Actual selection/options reach the same canonical builder checkpoint first.
  const plan = snapshotPageVisitQualificationPlan(
    buildDimensionTopPlan({
      siteId: input.siteId,
      queryTime: input.readerQueryTime,
      filters: readerFilters,
      ...(metadata ? { scopePlan: metadata.plan } : {}),
      qualificationDependencyRefs: [EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY],
      qualificationSemantics: "whole-original",
      limit: input.limit,
      selection: input.selection,
      excludeEmpty: input.excludeEmpty,
      search: input.search,
      sortBy: input.sortBy,
      sortDirection: input.sortDirection,
    }),
  );
  const recipe = state.consumer.readers;
  const subject = query.context.subject;
  const relation = state.projection.relations.entity;
  if (
    !metadata ||
    metadata !== state.context.metadata ||
    input.filters !== state.context.filters ||
    query.scopePlan !== metadata.plan ||
    subject.kind !== "team" ||
    subject.teamId !== recipe.teamId ||
    query.context.policy.audience !== "private-dashboard" ||
    state.projection.mode !== "entity" ||
    !relation ||
    !state.teamExactQualificationTime ||
    metadata.plan.mode !== "entity" ||
    metadata.plan.membership.kind !== "entity" ||
    (metadata.plan.scope !== "session" && metadata.plan.scope !== "visitor") ||
    input.selection !== crossBreakdownPageDimensionSelection(input.dimension) ||
    input.limit !== 0 ||
    input.excludeEmpty !== true ||
    input.search !== undefined ||
    input.sortBy !== "views" ||
    input.sortDirection !== "desc" ||
    !recipe.siteIds.includes(input.siteId) ||
    metadata.siteIds.length !== recipe.siteIds.length ||
    metadata.siteIds.some((id, i) => id !== recipe.siteIds[i]) ||
    state.projection.siteIds.length !== recipe.siteIds.length ||
    state.projection.siteIds.some((id, i) => id !== recipe.siteIds[i]) ||
    subject.authorizedSiteIds.length !== recipe.siteIds.length ||
    new Set(subject.authorizedSiteIds).size !== recipe.siteIds.length ||
    subject.authorizedSiteIds.some((id) => !recipe.siteIds.includes(id))
  )
    throw new Error("team_exact_whole_original_context_mismatch");
  const sources = plan.nodes.filter((node) => node.kind === "source");
  if (
    plan.outputs.length !== 1 ||
    plan.outputs[0]?.id !== "dimension-top" ||
    sources.length !== 1 ||
    sources[0]?.entity !== "page" ||
    sources[0].selection?.profile !==
      "prepared-whole-filter-reader-window-v1" ||
    sources[0].selection.qualificationDependencyRefs?.length !== 1 ||
    sources[0].selection.qualificationDependencyRefs[0] !==
      EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY
  )
    throw new Error("team_exact_whole_original_reader_shape_mismatch");
  const consumerKey = siteExactDimensionQualificationConsumerKey(
    input.dimension,
  );
  const preparationFilters = sources[0].selection.filter;
  const preparations = (state.teamExactPreparations ??= new Map());
  let cached = preparations.get(input.siteId);
  if (!cached) {
    cached = {
      filters: preparationFilters,
      preparation: createPageVisitQualificationPreparation({
        siteId: input.siteId,
        filters: preparationFilters,
        queryTime: state.teamExactQualificationTime,
        scopePlan: metadata.plan,
        consumerKey,
        relation,
        dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
        qualificationSemantics: "whole-original",
        maxBindings: 1,
        maxSourcesPerRole: 1,
      }),
    };
    preparations.set(input.siteId, cached);
  }
  const executionInputs = bindPageVisitQualificationPreparation({
    preparation: cached.preparation,
    siteId: input.siteId,
    filters: cached.filters,
    queryTime: state.teamExactQualificationTime,
    scopePlan: metadata.plan,
    consumerKey,
    readerFilters: preparationFilters,
    readerPreparationTime: metadata.time,
    readerQueryTime: input.readerQueryTime,
    plan,
  });
  return { plan, executionInputs };
}
