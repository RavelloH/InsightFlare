import {
  factEntityKindsForFilter,
  type QueryTime,
  scopedFilterMetadata,
  type SiteId,
} from "@/lib/edge/analytics/contract";
import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import type { SemanticRelationshipId } from "@/lib/edge/analytics/engine/semantic/relationships";
import {
  createSemanticScopedSourceSelection,
  type SemanticScopedSourceSelection,
} from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import type { FilterDocument } from "@/lib/filter-contract/filters";

/** Shared source-selection contract for the Overview aggregate and Trend reports. */
export function createOverviewReportSource(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly pageAttributes: readonly string[];
  readonly pageRelationships?: readonly SemanticRelationshipId[];
  readonly eventAttributes: readonly string[];
  readonly eventRelationships?: readonly SemanticRelationshipId[];
}): {
  readonly builder: LogicalPlanBuilder;
  readonly pages: LogicalRelationHandle;
  readonly events?: LogicalRelationHandle;
  readonly selection: SemanticScopedSourceSelection;
  readonly scoped: boolean;
} {
  const metadata = scopedFilterMetadata(input.filters);
  const directCompatibilitySelection =
    !metadata && input.filters.root !== null
      ? createSemanticScopedSourceSelection({
          profile: "direct-page-session-compat-v1",
          filters: input.filters,
          subject: createSemanticSubjectDomain({
            origin: "site",
            siteIds: [input.siteId as SiteId],
          }),
          time: semanticTemporalDomainsFromQueryTime(input.queryTime),
        })
      : undefined;
  const scoped = metadata !== undefined || input.filters.root !== null;
  const includeEvents =
    metadata !== undefined ||
    (directCompatibilitySelection !== undefined &&
      input.filters.root !== null &&
      factEntityKindsForFilter(input.filters.root).size > 0);
  const source = createPageReportSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(metadata
      ? {
          scopePlan: metadata.plan,
          preparedTimePolicy: "scoped-reader-window-v1" as const,
        }
      : {}),
    ...(directCompatibilitySelection
      ? { sourceSelection: directCompatibilitySelection }
      : {}),
    attributes: input.pageAttributes,
    ...(scoped && input.pageRelationships
      ? { relationships: input.pageRelationships }
      : {}),
  });
  const events = includeEvents
    ? source.builder.source("event", {
        temporalDomain: "candidate",
        attributes: input.eventAttributes,
        ...(input.eventRelationships
          ? { relationships: input.eventRelationships }
          : {}),
        selection: source.selection,
      })
    : undefined;
  return { ...source, ...(events ? { events } : {}), scoped };
}
