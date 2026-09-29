import { ANALYTICS_DIMENSIONS } from "@/lib/edge/analytics/contract/catalog";
import {
  analyticsFilterRegistry,
  type FilterNativeEntity,
} from "@/lib/filter-contract/filter-registry";

import {
  semanticAttributeCatalog,
  type SemanticAttributeDefinition,
} from "./attributes";
import {
  semanticDimensionCatalog,
  type SemanticDimensionDefinition,
} from "./dimensions";
import {
  SEMANTIC_RELATIONSHIP_IDS,
  semanticRelationshipCatalog,
} from "./relationships";

export interface SemanticCatalogIssue {
  readonly code:
    | "duplicate-attribute"
    | "missing-attribute"
    | "invalid-observation-kind"
    | "invalid-derived-attribute"
    | "duplicate-dimension"
    | "missing-dimension-attribute"
    | "missing-contract-dimension"
    | "duplicate-relationship"
    | "missing-relationship";
  readonly path: string;
  readonly message: string;
}

function nativeEntityForFilter(value: FilterNativeEntity): string {
  return value === "visit" ? "page" : value;
}

export function validateSemanticCatalog(input?: {
  readonly attributes?: readonly SemanticAttributeDefinition[];
  readonly dimensions?: readonly SemanticDimensionDefinition[];
}): readonly SemanticCatalogIssue[] {
  const attributes = input?.attributes ?? semanticAttributeCatalog;
  const dimensions = input?.dimensions ?? semanticDimensionCatalog;
  const issues: SemanticCatalogIssue[] = [];
  const attributeIds = new Set(attributes.map((attribute) => attribute.id));
  const seenAttributeIds = new Set<string>();
  for (const attribute of attributes) {
    if (seenAttributeIds.has(attribute.id)) {
      issues.push({
        code: "duplicate-attribute",
        path: `attributes.${attribute.id}`,
        message: `Semantic attribute ${attribute.id} is duplicated.`,
      });
    }
    seenAttributeIds.add(attribute.id);
    const registered = analyticsFilterRegistry.get(attribute.id);
    if (
      registered &&
      attribute.nativeEntity !== nativeEntityForFilter(registered.nativeEntity)
    ) {
      issues.push({
        code: "missing-attribute",
        path: `attributes.${attribute.id}.nativeEntity`,
        message: `Semantic attribute ${attribute.id} does not preserve its registered entity meaning.`,
      });
    }
    for (const [index, kind] of attribute.observationKinds.entries()) {
      if (kind !== "page" && kind !== "event") {
        issues.push({
          code: "invalid-observation-kind",
          path: `attributes.${attribute.id}.observationKinds[${index}]`,
          message: `Observation kind ${String(kind)} is not supported.`,
        });
      }
    }
    if (attribute.derivation) {
      const dependencies = new Set<string>();
      for (const [
        index,
        dependency,
      ] of attribute.derivation.dependencies.entries()) {
        if (!attributeIds.has(dependency) || dependencies.has(dependency)) {
          issues.push({
            code: "invalid-derived-attribute",
            path: `attributes.${attribute.id}.derivation.dependencies[${index}]`,
            message: `Derived attribute dependency ${dependency} is missing or duplicated.`,
          });
        }
        dependencies.add(dependency);
      }
    }
  }

  const dimensionIds = new Set<string>();
  for (const [index, dimension] of dimensions.entries()) {
    if (dimensionIds.has(dimension.id)) {
      issues.push({
        code: "duplicate-dimension",
        path: `dimensions[${index}].id`,
        message: `Semantic dimension ${dimension.id} is duplicated.`,
      });
    }
    dimensionIds.add(dimension.id);
    if (!attributeIds.has(dimension.attribute)) {
      issues.push({
        code: "missing-dimension-attribute",
        path: `dimensions.${dimension.id}.attribute`,
        message: `Semantic dimension ${dimension.id} references missing attribute ${dimension.attribute}.`,
      });
    }
  }
  for (const id of ANALYTICS_DIMENSIONS) {
    if (!dimensionIds.has(id)) {
      issues.push({
        code: "missing-contract-dimension",
        path: `dimensions.${id}`,
        message: `Contract dimension ${id} has no semantic definition.`,
      });
    }
  }

  const relationshipIds = new Set<string>();
  for (const relationship of semanticRelationshipCatalog) {
    if (relationshipIds.has(relationship.id)) {
      issues.push({
        code: "duplicate-relationship",
        path: `relationships.${relationship.id}`,
        message: `Semantic relationship ${relationship.id} is duplicated.`,
      });
    }
    relationshipIds.add(relationship.id);
  }
  for (const id of SEMANTIC_RELATIONSHIP_IDS) {
    if (!relationshipIds.has(id)) {
      issues.push({
        code: "missing-relationship",
        path: `relationships.${id}`,
        message: `Semantic relationship ${id} has no definition.`,
      });
    }
  }
  return Object.freeze(issues);
}
