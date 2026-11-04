import { constant, eq, filter } from "@/lib/db";
import { planObservationFilter } from "@/lib/edge/analytics/contract/observation-planner";
import type { SourceNode } from "@/lib/edge/analytics/engine/logical/nodes";
import { semanticAttribute } from "@/lib/edge/analytics/engine/semantic/attributes";
import type { SemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import {
  type AnalyticsLegacyScopedDataset,
  buildLegacyScopedDataset,
  requiredLegacyVisitColumnNames,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scoped-dataset";
import type {
  AnalyticsLegacyEventRow,
  AnalyticsLegacyPageRow,
  AnalyticsLegacyScopedPredicateContext,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scoped-types";
import type { AnalyticsDbRelation } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import { analyticsPageReportStorageColumn } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";

import type { AnalyticsScopedSourceContext } from "./context";
import type { ScopedSourceMembership } from "./membership";
import {
  filterExpression,
  selectedEventRows,
  selectedPageRows,
} from "./membership";
import { emptyIdentities, eventIdentityRows } from "./primitives";
import {
  postObservationBaseSelectionKey,
  selectionForPostObservationFilter,
  selectionWithoutPostObservationFilter,
} from "./selection-compatibility";

/** Apply the second-stage observation predicate to the selected Page bag. */
export function postObservationPageRows(
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
): AnalyticsDbRelation {
  const pagePlan = planObservationFilter(selection.filter.root).visit;
  if (pagePlan.kind === "all") return dataset.candidatePages.relation;
  if (pagePlan.kind === "none")
    return filter(
      dataset.candidatePages.relation,
      eq(constant(1), constant(0)),
    );
  const context: AnalyticsLegacyScopedPredicateContext = {
    selection,
    storage: dataset.storage,
    readPages: dataset.readPages,
    candidatePages: dataset.candidatePages,
    readEvents: dataset.readEvents,
  };
  return (
    filterExpression(dataset.candidatePages, pagePlan.expression, {
      selection,
      context,
    }) ?? dataset.candidatePages.relation
  );
}

export interface PostObservationBundle {
  readonly dataset: AnalyticsLegacyScopedDataset;
  readonly pages: AnalyticsLegacyPageRow;
  readonly events: AnalyticsLegacyEventRow;
  readonly stageSelection: SemanticScopedSourceSelection;
}

export interface PostObservationBaseDomain {
  readonly dataset: AnalyticsLegacyScopedDataset;
  readonly pages: AnalyticsLegacyPageRow;
  readonly events: AnalyticsLegacyEventRow;
}

export interface PostObservationBaseRequirements {
  readonly pageVisitColumns: readonly string[];
  readonly eventOwnerVisitColumns: readonly string[];
}

export function sourcePageAttributeVisitColumns(source: SourceNode): string[] {
  return source.values.flatMap((binding) => {
    if (binding.kind !== "attribute") return [];
    if (source.entity === "page") {
      const columnName = analyticsPageReportStorageColumn(binding.attribute);
      return columnName ? [columnName] : [];
    }
    if (source.entity !== "event") return [];
    const derivation = semanticAttribute(binding.attribute)?.derivation;
    if (
      derivation?.kind !== "report-relationship" ||
      derivation.relationship !== "event.ownerPage" ||
      !derivation.sourceAttribute
    )
      return [];
    const columnName = analyticsPageReportStorageColumn(
      derivation.sourceAttribute,
    );
    return columnName ? [columnName] : [];
  });
}

export class ScopedPostObservationLowerer {
  readonly #context: AnalyticsScopedSourceContext;
  readonly #membership: ScopedSourceMembership;
  readonly #postObservationBundles = new Map<string, PostObservationBundle>();
  readonly #postObservationBaseDomains = new Map<
    string,
    PostObservationBaseDomain
  >();
  constructor(
    context: AnalyticsScopedSourceContext,
    membership: ScopedSourceMembership,
  ) {
    this.#context = context;
    this.#membership = membership;
  }

  postObservationBundle(
    selection: SemanticScopedSourceSelection,
    requiredPageAttributes: readonly string[] = [],
  ): PostObservationBundle {
    const stage = selection.postObservationFilter;
    if (!stage) throw new Error("legacy_post_observation_filter_missing");
    const baseSelection = selectionWithoutPostObservationFilter(selection);
    const basePageAttributes = new Set([
      "page.report.localId",
      "page.report.rawSiteId",
      "page.report.sessionId",
      "page.report.visitorId",
      "page.report.startedAt",
      "page.report.durationMs",
      "page.report.pathname",
    ]);
    const localPageVisitColumns = requiredLegacyVisitColumnNames(selection, [
      ...requiredPageAttributes.flatMap((attribute) => {
        const columnName = analyticsPageReportStorageColumn(attribute);
        return columnName && !basePageAttributes.has(attribute)
          ? [columnName]
          : [];
      }),
    ]);
    const localEventOwnerVisitColumns =
      requiredLegacyVisitColumnNames(selection);
    const premerged = this.#context.postObservationBaseRequirements.get(
      postObservationBaseSelectionKey(selection),
    );
    const pageVisitColumns =
      premerged?.pageVisitColumns ?? localPageVisitColumns;
    const eventOwnerVisitColumns =
      premerged?.eventOwnerVisitColumns ?? localEventOwnerVisitColumns;
    const baseKey = JSON.stringify([
      postObservationBaseSelectionKey(selection),
      pageVisitColumns,
      eventOwnerVisitColumns,
    ]);
    const key = JSON.stringify([baseKey, stage]);
    const existing = this.#postObservationBundles.get(key);
    if (existing) return existing;

    let baseDomain = this.#postObservationBaseDomains.get(baseKey);
    if (!baseDomain) {
      const rawDataset = buildLegacyScopedDataset({
        selection: baseSelection,
        storage: this.#context.storage,
        additionalPageVisitColumns: pageVisitColumns,
        additionalEventOwnerVisitColumns: eventOwnerVisitColumns,
      });
      const pages = selectedPageRows(
        rawDataset,
        baseSelection,
        this.#membership.matchingPageEventOwnerPairs(rawDataset, baseSelection),
      );
      const events = selectedEventRows(
        rawDataset,
        baseSelection.profile === "direct-page-entity-only-compat-v1"
          ? emptyIdentities(eventIdentityRows(rawDataset.readEvents))
          : this.#membership.matchingEventRows(rawDataset, baseSelection),
      );
      const dataset: AnalyticsLegacyScopedDataset = {
        ...rawDataset,
        readPages: pages,
        candidatePages: pages,
        readEvents: events,
      };
      baseDomain = { dataset, pages, events };
      this.#postObservationBaseDomains.set(baseKey, baseDomain);
    }
    const bundle = {
      ...baseDomain,
      stageSelection: selectionForPostObservationFilter(selection),
    };
    this.#postObservationBundles.set(key, bundle);
    return bundle;
  }
}
