import type { SourceNode } from "@/lib/edge/analytics/engine/logical/nodes";
import { requiredLegacyVisitColumnNames } from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scoped-dataset";
import type { AnalyticsRelationalStorageContext } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";

import {
  type PostObservationBaseRequirements,
  sourcePageAttributeVisitColumns,
} from "./post-observation";
import type { IdentityRelation } from "./primitives";
import {
  entityQualificationCacheKey,
  postObservationBaseSelectionKey,
} from "./selection-compatibility";

export class AnalyticsScopedSourceContext {
  readonly storage: AnalyticsRelationalStorageContext;
  readonly entityQualificationSourceCounts = new Map<string, number>();
  readonly entityQualifications = new Map<string, IdentityRelation>();
  readonly rowLocalEventMatches = new Map<string, IdentityRelation>();
  readonly pageEventOwnerPairs = new Map<string, IdentityRelation>();
  readonly postObservationBaseRequirements = new Map<
    string,
    PostObservationBaseRequirements
  >();
  constructor(
    storage: AnalyticsRelationalStorageContext,
    sources: readonly SourceNode[] = [],
  ) {
    this.storage = storage;
    for (const source of sources) {
      if (!source.selection) continue;
      const key = entityQualificationCacheKey(
        source.selection,
        source.temporalDomain,
      );
      if (!key) continue;
      this.entityQualificationSourceCounts.set(
        key,
        (this.entityQualificationSourceCounts.get(key) ?? 0) + 1,
      );
    }
    const accumulated = new Map<
      string,
      { readonly page: Set<string>; readonly owners: Set<string> }
    >();
    for (const source of sources) {
      const selection = source.selection;
      if (!selection?.postObservationFilter) continue;
      const key = postObservationBaseSelectionKey(selection);
      let requirements = accumulated.get(key);
      if (!requirements) {
        requirements = { page: new Set(), owners: new Set() };
        accumulated.set(key, requirements);
      }
      const sourceColumns = sourcePageAttributeVisitColumns(source);
      for (const columnName of requiredLegacyVisitColumnNames(
        selection,
        sourceColumns,
      ))
        requirements.page.add(columnName);
      for (const columnName of requiredLegacyVisitColumnNames(
        selection,
        source.entity === "event" ? sourceColumns : [],
      ))
        requirements.owners.add(columnName);
    }
    for (const [key, requirements] of accumulated)
      this.postObservationBaseRequirements.set(key, {
        pageVisitColumns: [...requirements.page].sort(),
        eventOwnerVisitColumns: [...requirements.owners].sort(),
      });
  }
}
