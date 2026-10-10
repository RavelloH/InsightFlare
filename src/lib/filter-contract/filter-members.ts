import type {
  FilterEntityRoot,
  FilterFieldDefinition,
  FilterFieldId,
  FilterFieldRegistry,
} from "./filters";

const ENTITY_NAMESPACES = new Set([
  "geo",
  "client",
  "referrer",
  "utm",
  "user",
  "performance",
]);

export interface ResolvedEntityMember {
  readonly entity: FilterEntityRoot;
  readonly memberPath: string;
  readonly fieldId: FilterFieldId;
  readonly definition: FilterFieldDefinition;
}

/** Resolve an explicitly entity-bound member through the canonical registry. */
export function resolveEntityMember(
  entity: string,
  memberPath: string,
  registry: FilterFieldRegistry,
): ResolvedEntityMember | undefined {
  if (!memberPath || !["event", "page", "session", "visitor"].includes(entity))
    return undefined;

  const entityRoot = entity as FilterEntityRoot;
  const direct = `${entityRoot}.${memberPath}`;
  const namespace = memberPath.split(".")[0] ?? "";
  const namespaced = ENTITY_NAMESPACES.has(namespace) ? memberPath : undefined;
  const fieldId = registry.has(direct)
    ? direct
    : namespaced && registry.has(namespaced)
      ? namespaced
      : undefined;
  const definition = fieldId ? registry.get(fieldId) : undefined;
  if (!fieldId || !definition) return undefined;

  const applicable = definition.conditionEntity;
  if (
    applicable !== undefined &&
    applicable !== entityRoot &&
    !(
      applicable === "activity" &&
      (entityRoot === "page" || entityRoot === "event")
    )
  )
    return undefined;

  return {
    entity: entityRoot,
    memberPath,
    fieldId: fieldId as FilterFieldId,
    definition,
  };
}

export function isEntityMemberNamespace(value: string): boolean {
  return ENTITY_NAMESPACES.has(value);
}
