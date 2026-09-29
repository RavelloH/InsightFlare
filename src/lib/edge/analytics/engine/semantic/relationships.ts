import type { AnalyticsEntityKind } from "./entities";

export const SEMANTIC_RELATIONSHIP_IDS = [
  "page.observation",
  "page.session",
  "page.visitor",
  "event.observation",
  "event.session",
  "event.visitor",
  "session.visitor",
] as const;

export type SemanticRelationshipId = (typeof SEMANTIC_RELATIONSHIP_IDS)[number];

export interface SemanticRelationshipDefinition {
  readonly id: SemanticRelationshipId;
  readonly from: AnalyticsEntityKind;
  readonly to: AnalyticsEntityKind;
  readonly cardinality: "one-to-one" | "many-to-one";
  readonly optional: boolean;
}

export const semanticRelationshipCatalog: readonly SemanticRelationshipDefinition[] =
  Object.freeze([
    {
      id: "page.observation",
      from: "page",
      to: "observation",
      cardinality: "one-to-one",
      optional: false,
    },
    {
      id: "page.session",
      from: "page",
      to: "session",
      cardinality: "many-to-one",
      optional: true,
    },
    {
      id: "page.visitor",
      from: "page",
      to: "visitor",
      cardinality: "many-to-one",
      optional: true,
    },
    {
      id: "event.observation",
      from: "event",
      to: "observation",
      cardinality: "one-to-one",
      optional: false,
    },
    {
      id: "event.session",
      from: "event",
      to: "session",
      cardinality: "many-to-one",
      optional: true,
    },
    {
      id: "event.visitor",
      from: "event",
      to: "visitor",
      cardinality: "many-to-one",
      optional: true,
    },
    {
      id: "session.visitor",
      from: "session",
      to: "visitor",
      cardinality: "many-to-one",
      optional: true,
    },
  ] satisfies readonly SemanticRelationshipDefinition[]);

export function semanticRelationship(
  id: SemanticRelationshipId,
): SemanticRelationshipDefinition | undefined {
  return semanticRelationshipCatalog.find((item) => item.id === id);
}

export function isSemanticRelationshipId(
  value: unknown,
): value is SemanticRelationshipId {
  return (
    typeof value === "string" &&
    SEMANTIC_RELATIONSHIP_IDS.includes(value as SemanticRelationshipId)
  );
}
