import {
  ANALYTICS_DIMENSIONS,
  type AnalyticsDimension,
} from "@/lib/edge/analytics/contract/catalog";

import type { SemanticAttributeId } from "./attributes";

export type SemanticDimensionId = AnalyticsDimension;

export interface SemanticDimensionDefinition {
  readonly id: SemanticDimensionId;
  readonly attribute: SemanticAttributeId;
}

/** Every existing contract dimension maps directly to its semantic attribute ID. */
export const semanticDimensionCatalog: readonly SemanticDimensionDefinition[] =
  Object.freeze(
    ANALYTICS_DIMENSIONS.map((id) => Object.freeze({ id, attribute: id })),
  );

export function semanticDimension(
  id: SemanticDimensionId,
): SemanticDimensionDefinition | undefined {
  return semanticDimensionCatalog.find((dimension) => dimension.id === id);
}
