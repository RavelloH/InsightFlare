import {
  concat as sqlConcat,
  join as sqlJoin,
  parenthesize as sqlParenthesize,
  type SqlFragment,
  text as sqlText,
} from "@/lib/db/sql/fragment";

import type {
  FinalRenderEmission,
  FinalRenderEmissionCounts,
  FinalRenderSession,
} from "./final-render-session";

interface ProvenanceNode {
  readonly session: FinalRenderSession;
  readonly children: readonly ProvenanceNode[];
  readonly emission?: FinalRenderEmission;
}

const fragmentProvenance = new WeakMap<SqlFragment, ProvenanceNode>();

function provenanceOf(
  parts: readonly SqlFragment[],
): ProvenanceNode | undefined {
  let children: ProvenanceNode[] | undefined;
  let session: FinalRenderSession | undefined;
  for (const part of parts) {
    const node = fragmentProvenance.get(part);
    if (!node) continue;
    if (session !== undefined && session !== node.session)
      throw new TypeError("sql_fragments_from_different_render_sessions");
    session = node.session;
    children ??= [];
    children.push(node);
  }
  if (session === undefined) return undefined;
  return { session, children: children! };
}

function preserveComposition(
  result: SqlFragment,
  parts: readonly SqlFragment[],
): SqlFragment {
  const node = provenanceOf(parts);
  if (node) fragmentProvenance.set(result, node);
  return result;
}

export function concat(...parts: readonly SqlFragment[]): SqlFragment {
  return preserveComposition(sqlConcat(...parts), parts);
}

export function join(
  parts: readonly SqlFragment[],
  separator?: SqlFragment,
): SqlFragment {
  const actualSeparator = separator ?? sqlText(", ");
  const result = sqlJoin(parts, separator);
  const hasProvenance =
    fragmentProvenance.has(actualSeparator) ||
    parts.some((part) => fragmentProvenance.has(part));
  if (!hasProvenance) return result;
  const children: SqlFragment[] = [];
  parts.forEach((part, index) => {
    if (index > 0) children.push(actualSeparator);
    children.push(part);
  });
  return preserveComposition(result, children);
}

export function parenthesize(part: SqlFragment): SqlFragment {
  const result = sqlParenthesize(part);
  const node = fragmentProvenance.get(part);
  if (node)
    fragmentProvenance.set(result, {
      session: node.session,
      children: [node],
    });
  return result;
}

export function recordFinalRenderEmission(
  session: FinalRenderSession | undefined,
  fragment: SqlFragment,
  emission: FinalRenderEmission,
): SqlFragment {
  if (!session) return fragment;
  const previous = fragmentProvenance.get(fragment);
  if (previous && previous.session !== session)
    throw new TypeError("sql_fragment_owned_by_another_render_session");
  fragmentProvenance.set(fragment, {
    session,
    children: previous ? [previous] : [],
    emission,
  });
  return fragment;
}

export function inheritFinalRenderProvenance(
  source: SqlFragment,
  target: SqlFragment,
): SqlFragment {
  const node = fragmentProvenance.get(source);
  if (node) fragmentProvenance.set(target, node);
  return target;
}

function addCount(map: Map<object, number>, key: object, value: number): void {
  const next = (map.get(key) ?? 0) + value;
  if (!Number.isSafeInteger(next))
    throw new TypeError("render_emission_count_overflow");
  map.set(key, next);
}

/** Count only event nodes reachable from the exact final fragment. */
export function finalRenderEmissionCounts(
  session: FinalRenderSession,
  fragment: SqlFragment,
): FinalRenderEmissionCounts {
  const root = fragmentProvenance.get(fragment);
  const lexicographic = new Map<object, number>();
  const semiMembership = new Map<object, number>();
  const singletonRank = new Map<object, number>();
  const nativeNullOrdering = new Map<object, number>();
  const materializedReferences = new Map<
    object,
    { definitionIndex: number; fieldCount: number; emissionCount: number }
  >();
  const materializationDefinitions = new Map<
    object,
    {
      definitionIndex: number;
      selectionKind:
        | "strict-serial-rank-stage"
        | "stage-derived-auto"
        | "current-boundary-derived-auto";
      choiceIndex: number;
      emissionCount: number;
    }
  >();
  const sharedReferences = new Map<
    object,
    { definitionIndex: number; emissionCount: number }
  >();
  const compileOrderHelpers = new Map<
    object,
    {
      leafDefinitionIndexes: readonly number[];
      strategy: "dead-branch-materialization-order";
      emissionCount: number;
    }
  >();
  const derivedSelfMembership = new Map<object, number>();
  if (!root)
    return {
      lexicographic,
      semiMembership,
      singletonRank,
      nativeNullOrdering,
      materializedReferences,
      materializationDefinitions,
      sharedReferences,
      compileOrderHelpers,
      derivedSelfMembership,
      totalEmissionCount: 0,
    };
  if (root.session !== session)
    throw new TypeError("final_query_belongs_to_another_render_session");

  const order: ProvenanceNode[] = [];
  const visited = new Set<ProvenanceNode>();
  const active = new Set<ProvenanceNode>();
  const stack: { readonly node: ProvenanceNode; readonly exit: boolean }[] = [
    { node: root, exit: false },
  ];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.exit) {
      active.delete(item.node);
      order.push(item.node);
      continue;
    }
    if (visited.has(item.node)) continue;
    if (active.has(item.node)) throw new TypeError("render_provenance_cycle");
    visited.add(item.node);
    active.add(item.node);
    stack.push({ node: item.node, exit: true });
    for (let index = item.node.children.length - 1; index >= 0; index -= 1) {
      const child = item.node.children[index]!;
      if (child.session !== session)
        throw new TypeError("render_provenance_crossed_sessions");
      if (!visited.has(child)) stack.push({ node: child, exit: false });
    }
  }

  const multiplicities = new Map<ProvenanceNode, number>([[root, 1]]);
  let totalEmissionCount = 0;
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const node = order[index]!;
    const multiplicity = multiplicities.get(node) ?? 0;
    if (multiplicity === 0) continue;
    const emission = node.emission;
    if (emission) {
      totalEmissionCount += multiplicity;
      if (!Number.isSafeInteger(totalEmissionCount))
        throw new TypeError("render_emission_count_overflow");
      switch (emission.kind) {
        case "lexicographic":
          addCount(lexicographic, emission.choice, multiplicity);
          break;
        case "semi-membership":
          addCount(semiMembership, emission.choice, multiplicity);
          break;
        case "singleton-rank":
          addCount(singletonRank, emission.choice, multiplicity);
          break;
        case "native-null-ordering":
          addCount(nativeNullOrdering, emission.choice, multiplicity);
          break;
        case "materialized-reference": {
          const current = materializedReferences.get(emission.definition);
          if (
            current &&
            (current.definitionIndex !== emission.definitionIndex ||
              current.fieldCount !== emission.fieldCount)
          )
            throw new TypeError("materialized_reference_shape_mismatch");
          materializedReferences.set(emission.definition, {
            definitionIndex: emission.definitionIndex,
            fieldCount: emission.fieldCount,
            emissionCount: (current?.emissionCount ?? 0) + multiplicity,
          });
          break;
        }
        case "materialization-definition": {
          const current = materializationDefinitions.get(emission.definition);
          if (
            current &&
            (current.definitionIndex !== emission.definitionIndex ||
              current.selectionKind !== emission.selectionKind ||
              current.choiceIndex !== emission.choiceIndex)
          )
            throw new TypeError("materialization_definition_shape_mismatch");
          materializationDefinitions.set(emission.definition, {
            definitionIndex: emission.definitionIndex,
            selectionKind: emission.selectionKind,
            choiceIndex: emission.choiceIndex,
            emissionCount: (current?.emissionCount ?? 0) + multiplicity,
          });
          break;
        }
        case "shared-reference": {
          const current = sharedReferences.get(emission.definition);
          if (current && current.definitionIndex !== emission.definitionIndex)
            throw new TypeError("shared_reference_shape_mismatch");
          sharedReferences.set(emission.definition, {
            definitionIndex: emission.definitionIndex,
            emissionCount: (current?.emissionCount ?? 0) + multiplicity,
          });
          break;
        }
        case "compile-order-helper": {
          const current = compileOrderHelpers.get(emission.helper);
          if (
            current &&
            (current.strategy !== emission.strategy ||
              current.leafDefinitionIndexes.length !==
                emission.leafDefinitionIndexes.length ||
              current.leafDefinitionIndexes.some(
                (index, offset) =>
                  index !== emission.leafDefinitionIndexes[offset],
              ))
          )
            throw new TypeError("compile_order_helper_shape_mismatch");
          compileOrderHelpers.set(emission.helper, {
            leafDefinitionIndexes: emission.leafDefinitionIndexes,
            strategy: emission.strategy,
            emissionCount: (current?.emissionCount ?? 0) + multiplicity,
          });
          break;
        }
        case "derived-self-membership":
          addCount(derivedSelfMembership, emission.choice, multiplicity);
          break;
      }
    }
    for (const child of node.children) {
      const next = (multiplicities.get(child) ?? 0) + multiplicity;
      if (!Number.isSafeInteger(next))
        throw new TypeError("render_emission_count_overflow");
      multiplicities.set(child, next);
    }
  }
  return {
    lexicographic,
    semiMembership,
    singletonRank,
    nativeNullOrdering,
    materializedReferences,
    materializationDefinitions,
    sharedReferences,
    compileOrderHelpers,
    derivedSelfMembership,
    totalEmissionCount,
  };
}
