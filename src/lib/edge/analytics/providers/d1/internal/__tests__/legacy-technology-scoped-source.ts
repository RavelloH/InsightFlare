import type {
  FilterDocument,
  QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core-types";

import { scopedDatasetFor } from "./journey-list-parent-scoped-oracle";
import { buildVisitFilterSql } from "./legacy-core-filters";
import {
  buildVisitSourceCte,
  visitSourceBindings,
} from "./legacy-core-sources";

export interface TechnologyVisitSource {
  readonly ctes: string;
  readonly relation: string;
  readonly bindings: Array<string | number | null>;
  readonly filterClause: string;
  readonly filterBindings: Array<string | number>;
}

export function technologyVisitSource(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
): TechnologyVisitSource {
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  if (scopedDataset) {
    return {
      ctes: scopedDataset.ctes,
      relation: scopedDataset.visitRelation,
      bindings: scopedDataset.bindings.map(({ value }) => value),
      filterClause: "",
      filterBindings: [],
    };
  }

  const filter = buildVisitFilterSql(filters, "visit_source", { window });
  return {
    ctes: buildVisitSourceCte(),
    relation: "visit_source",
    bindings: visitSourceBindings(siteId, window),
    filterClause: filter.clause,
    filterBindings: filter.bindings,
  };
}
