import type {
  DistinctNode,
  FilterNode,
  JoinNode,
  LogicalQueryNode,
  OutputField,
  ProjectNode,
  QuerySource,
} from "@/lib/db/query/plan";
import type { SchemaObjectReference } from "@/lib/db/schema/types";

import type { SharedRelationDefinition } from "./contracts";
import type { PhysicalSharedRelationBoundaryEvidence } from "./shared-relation-interfaces";

/** The shared tuple-membership proof fields consumed by this pass. */
export interface SelfMembershipTupleCandidate {
  readonly project: ProjectNode;
  readonly join: JoinNode;
  readonly membershipSource: "finite-values" | "dynamic-distinct";
  readonly valuesRelation?: LogicalQueryNode;
  readonly leftKeyIndexes: readonly number[];
  readonly rightKeyIndexes: readonly number[];
}

export type SelfMembershipWitnessPathStep =
  | {
      readonly kind: "project";
      readonly node: ProjectNode;
      readonly outputIndexes: readonly number[];
      readonly inputIndexes: readonly number[];
    }
  | {
      readonly kind: "filter";
      readonly node: FilterNode;
      readonly outputIndexes: readonly number[];
      readonly inputIndexes: readonly number[];
    }
  | {
      readonly kind: "distinct";
      readonly node: DistinctNode;
      readonly outputIndexes: readonly number[];
      readonly inputIndexes: readonly number[];
    }
  | {
      readonly kind: "inner-join";
      readonly node: JoinNode;
      readonly side: "left" | "right";
      readonly outputIndexes: readonly number[];
      readonly inputIndexes: readonly number[];
    };

export interface PhysicalSelfMembershipWitness {
  readonly source: QuerySource;
  readonly definition: SharedRelationDefinition;
  readonly definitionIndex: number;
  readonly producer: LogicalQueryNode;
  readonly producerIndex: number;
  readonly sourceKeyIndexes: readonly number[];
  readonly rightProjectInputIndexes: readonly number[];
  readonly path: readonly SelfMembershipWitnessPathStep[];
  readonly boundary: PhysicalSharedRelationBoundaryEvidence;
}

/** A freshly derived rewrite for a left-only self-membership Join. */
export interface PhysicalSelfMembershipChoice {
  readonly project: ProjectNode;
  readonly join: JoinNode;
  readonly tupleCandidate: SelfMembershipTupleCandidate;
  /** Complete left key tuple in the right projection's comparison order. */
  readonly leftKeyIndexes: readonly number[];
  readonly rightKeyIndexes: readonly number[];
  readonly membershipSource: SelfMembershipTupleCandidate["membershipSource"];
  /** Nullable key fields whose SQL equality semantics require IS NOT NULL. */
  readonly nullableKeyIndexes: readonly number[];
  readonly witness?: PhysicalSelfMembershipWitness;
}

export interface SelfMembershipProducer {
  readonly node: LogicalQueryNode;
  readonly index: number;
}

export interface SelfMembershipDerivationContext {
  readonly definitions: readonly SharedRelationDefinition[];
  readonly boundaries: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >;
  readonly producerFor: (
    project: ProjectNode,
  ) => SelfMembershipProducer | undefined;
  readonly safeFilter: (node: FilterNode) => boolean;
  readonly safeInnerJoin: (node: JoinNode) => boolean;
}

/**
 * Split tuple candidates whose right distinct key source is the exact same
 * Generic QuerySource as the Join's left input. The candidates arrive here
 * only after the normal tuple proof has established complete equality keys
 * and a stable, side-effect-free source.
 */
export function partitionSelfMembershipCandidates<
  Candidate extends SelfMembershipTupleCandidate,
>(
  candidates: readonly Candidate[],
  context?: SelfMembershipDerivationContext,
): {
  readonly selfMembershipChoices: readonly PhysicalSelfMembershipChoice[];
  readonly positiveTupleMembershipCandidates: readonly Candidate[];
} {
  const selfMembershipChoices: PhysicalSelfMembershipChoice[] = [];
  const selfProjects = new Set<ProjectNode>();

  for (const candidate of candidates) {
    const prepared = prepareTupleCandidate(candidate);
    if (!prepared) continue;
    const source = prepared.source;
    const directSource =
      source.node === candidate.join.left.node &&
      source.scope === candidate.join.left.scope &&
      source.fields === candidate.join.left.fields &&
      prepared.leftKeyIndexes.every(
        (index, position) =>
          prepared.rightProjectInputIndexes[position] === index,
      );
    let witness: PhysicalSelfMembershipWitness | undefined;
    if (!directSource && context)
      witness = deriveCurrentMaterializedWitness(candidate, prepared, context);
    if (!directSource && !witness) continue;

    selfProjects.add(candidate.project);
    selfMembershipChoices.push({
      project: candidate.project,
      join: candidate.join,
      tupleCandidate: candidate,
      leftKeyIndexes: prepared.leftKeyIndexes,
      rightKeyIndexes: candidate.rightKeyIndexes,
      membershipSource: candidate.membershipSource,
      nullableKeyIndexes: candidate.leftKeyIndexes.filter(
        (index) => candidate.join.left.fields[index]!.nullable,
      ),
      ...(witness ? { witness } : {}),
    });
  }

  return {
    selfMembershipChoices,
    positiveTupleMembershipCandidates: candidates.filter(
      ({ project }) => !selfProjects.has(project),
    ),
  };
}

/** Direct scan columns are eligible only when their schema proves BINARY. */
export function hasKnownBinaryTableColumn(
  table: SchemaObjectReference,
  index: number,
  field: OutputField | undefined,
): boolean {
  const column = Object.values(table.columns)[index];
  return (
    table.kind === "table" &&
    table.defaultCollation === "BINARY" &&
    field !== undefined &&
    field.affinity !== "unknown" &&
    !!column &&
    column.kind === "column" &&
    !column.generated &&
    column.hidden === 0 &&
    column.affinity === field.affinity
  );
}

function hasKnownBinaryColumnSource(
  source: QuerySource,
  index: number,
  visited = new Set<object>(),
): boolean {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= source.fields.length ||
    visited.has(source.node)
  )
    return false;
  const node = source.node;
  visited.add(node);
  switch (node.kind) {
    case "scan": {
      return hasKnownBinaryTableColumn(node.table, index, source.fields[index]);
    }
    case "values-relation":
      return source.fields[index]?.affinity === "text";
    case "filter":
    case "distinct":
      return hasKnownBinaryColumnSource(node.input, index, visited);
    case "window":
      return (
        index < node.input.fields.length &&
        hasKnownBinaryColumnSource(node.input, index, visited)
      );
    case "project": {
      const expression = node.projections[index]?.expression;
      return (
        expression?.kind === "column" &&
        expression.scope === node.input.scope &&
        hasKnownBinaryColumnSource(node.input, expression.index, visited)
      );
    }
    case "join": {
      if (index < node.left.fields.length)
        return hasKnownBinaryColumnSource(node.left, index, visited);
      return hasKnownBinaryColumnSource(
        node.right,
        index - node.left.fields.length,
        visited,
      );
    }
    case "semi-join":
    case "anti-join":
      return (
        index < node.left.fields.length &&
        hasKnownBinaryColumnSource(node.left, index, visited)
      );
    default:
      return false;
  }
}

interface PreparedTupleCandidate {
  readonly source: QuerySource;
  readonly rightProjectInputIndexes: readonly number[];
  readonly leftKeyIndexes: readonly number[];
}

function prepareTupleCandidate(
  candidate: SelfMembershipTupleCandidate,
): PreparedTupleCandidate | undefined {
  const { project, join } = candidate;
  if (
    project.input.node !== join ||
    join.joinType !== "inner" ||
    join.right.node.kind !== "distinct" ||
    join.right.node.input.node.kind !== "project" ||
    candidate.leftKeyIndexes.length === 0 ||
    candidate.leftKeyIndexes.length !== candidate.rightKeyIndexes.length ||
    join.right.fields.length !== candidate.rightKeyIndexes.length ||
    join.right.node.fields.length !== candidate.rightKeyIndexes.length ||
    join.right.node.input.node.projections.length !==
      candidate.rightKeyIndexes.length ||
    !project.projections.every(
      ({ expression }) =>
        expression.kind === "column" &&
        expression.scope === join.scope &&
        Number.isSafeInteger(expression.index) &&
        expression.index >= 0 &&
        expression.index < join.left.fields.length,
    )
  )
    return undefined;

  const keyProject = join.right.node.input.node;
  const source = keyProject.input;
  const leftKeys = new Set<number>();
  const rightKeys = new Set<number>();
  const rightProjectInputIndexes: number[] = [];
  for (
    let position = 0;
    position < candidate.leftKeyIndexes.length;
    position++
  ) {
    const leftIndex = candidate.leftKeyIndexes[position]!;
    const rightIndex = candidate.rightKeyIndexes[position]!;
    const rightExpression = keyProject.projections[rightIndex]?.expression;
    const leftField = join.left.fields[leftIndex];
    const rightField = join.right.fields[rightIndex];
    const sourceIndex =
      rightExpression?.kind === "column" &&
      rightExpression.scope === source.scope &&
      Number.isSafeInteger(rightExpression.index)
        ? rightExpression.index
        : -1;
    const sourceField = source.fields[sourceIndex];
    if (
      !Number.isSafeInteger(leftIndex) ||
      leftIndex < 0 ||
      leftIndex >= join.left.fields.length ||
      !Number.isSafeInteger(rightIndex) ||
      rightIndex < 0 ||
      rightIndex >= join.right.fields.length ||
      leftKeys.has(leftIndex) ||
      rightKeys.has(rightIndex) ||
      sourceIndex < 0 ||
      sourceIndex >= source.fields.length ||
      !leftField ||
      !rightField ||
      !sourceField ||
      leftField.affinity === "unknown" ||
      leftField.affinity !== rightExpression?.resultType.affinity ||
      leftField.nullable !== rightExpression?.resultType.nullable ||
      leftField.affinity !== rightField.affinity ||
      leftField.nullable !== rightField.nullable ||
      sourceField.affinity !== rightExpression?.resultType.affinity ||
      sourceField.nullable !== rightExpression?.resultType.nullable ||
      !hasKnownBinaryColumnSource(join.left, leftIndex) ||
      !hasKnownBinaryColumnSource(source, sourceIndex)
    )
      return undefined;
    leftKeys.add(leftIndex);
    rightKeys.add(rightIndex);
    rightProjectInputIndexes.push(sourceIndex);
  }
  if (
    rightKeys.size !== join.right.fields.length ||
    leftKeys.size !== candidate.leftKeyIndexes.length
  )
    return undefined;

  return {
    source,
    rightProjectInputIndexes,
    leftKeyIndexes: candidate.leftKeyIndexes,
  };
}

function deriveCurrentMaterializedWitness(
  candidate: SelfMembershipTupleCandidate,
  prepared: PreparedTupleCandidate,
  context: SelfMembershipDerivationContext,
): PhysicalSelfMembershipWitness | undefined {
  const definitionIndex = context.definitions.findIndex(
    (definition) => definition.node === prepared.source.node,
  );
  const producer = context.producerFor(candidate.project);
  const definition = context.definitions[definitionIndex];
  const boundary = context.boundaries.get(prepared.source.node);
  if (
    definitionIndex < 0 ||
    !definition ||
    !producer ||
    definition.materialization !== "materialized" ||
    definitionIndex >= producer.index ||
    producer.node === definition.node ||
    prepared.source.scope !== definition.scope ||
    !sameFields(prepared.source.fields, definition.fields) ||
    !boundary ||
    boundary.definition.node !== definition.node ||
    boundary.definition.scope !== definition.scope ||
    boundary.definition.materialization !== "materialized" ||
    boundary.boundary.kind !== "materialized-relation" ||
    !boundary.closure.scopeCount ||
    boundary.closure.referencedScopeCount > boundary.closure.scopeCount ||
    boundary.totality.kind !== "checked-through-current-boundaries"
  )
    return undefined;

  const traced = traceWholeTuple(
    candidate.join.left,
    prepared.leftKeyIndexes,
    prepared.source,
    context,
  );
  if (
    !traced ||
    traced.sourceIndexes.length !== prepared.rightProjectInputIndexes.length ||
    traced.sourceIndexes.some(
      (index, position) =>
        index !== prepared.rightProjectInputIndexes[position],
    )
  )
    return undefined;

  return {
    source: prepared.source,
    definition,
    definitionIndex,
    producer: producer.node,
    producerIndex: producer.index,
    sourceKeyIndexes: traced.sourceIndexes,
    rightProjectInputIndexes: prepared.rightProjectInputIndexes,
    path: traced.path,
    boundary,
  };
}

function traceWholeTuple(
  initial: QuerySource,
  initialIndexes: readonly number[],
  target: QuerySource,
  context: SelfMembershipDerivationContext,
):
  | {
      readonly sourceIndexes: readonly number[];
      readonly path: readonly SelfMembershipWitnessPathStep[];
    }
  | undefined {
  let current = initial;
  let indexes = [...initialIndexes];
  const path: SelfMembershipWitnessPathStep[] = [];
  const visited = new Set<LogicalQueryNode>();
  for (;;) {
    if (current.node === target.node) {
      if (
        current.scope !== target.scope ||
        !sameFields(current.fields, target.fields) ||
        indexes.some(
          (index) =>
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= current.fields.length,
        )
      )
        return undefined;
      return { sourceIndexes: indexes, path };
    }
    if (visited.has(current.node)) return undefined;
    visited.add(current.node);
    const before = indexes;
    switch (current.node.kind) {
      case "project": {
        const node = current.node;
        const inputIndexes: number[] = [];
        for (const outputIndex of indexes) {
          const projection = node.projections[outputIndex];
          const expression = projection?.expression;
          if (
            !projection ||
            expression?.kind !== "column" ||
            expression.scope !== node.input.scope ||
            !Number.isSafeInteger(expression.index) ||
            expression.index < 0 ||
            expression.index >= node.input.fields.length ||
            current.fields[outputIndex]?.name !== projection.name ||
            current.fields[outputIndex]?.affinity !==
              expression.resultType.affinity ||
            current.fields[outputIndex]?.nullable !==
              expression.resultType.nullable ||
            node.input.fields[expression.index]?.affinity !==
              expression.resultType.affinity ||
            node.input.fields[expression.index]?.nullable !==
              expression.resultType.nullable
          )
            return undefined;
          inputIndexes.push(expression.index);
        }
        indexes = inputIndexes;
        path.push({
          kind: "project",
          node,
          outputIndexes: before,
          inputIndexes: indexes,
        });
        current = node.input;
        break;
      }
      case "filter": {
        const node = current.node;
        if (!context.safeFilter(node)) return undefined;
        if (!sameFields(current.fields, node.input.fields)) return undefined;
        path.push({
          kind: "filter",
          node,
          outputIndexes: before,
          inputIndexes: before,
        });
        current = node.input;
        break;
      }
      case "distinct": {
        const node = current.node;
        if (!sameFields(current.fields, node.input.fields)) return undefined;
        path.push({
          kind: "distinct",
          node,
          outputIndexes: before,
          inputIndexes: before,
        });
        current = node.input;
        break;
      }
      case "join": {
        const node = current.node;
        if (!context.safeInnerJoin(node)) return undefined;
        const leftWidth = node.left.fields.length;
        const whollyLeft = indexes.every((index) => index < leftWidth);
        const whollyRight = indexes.every((index) => index >= leftWidth);
        if (!whollyLeft && !whollyRight) return undefined;
        const side = whollyLeft ? "left" : "right";
        const input = whollyLeft ? node.left : node.right;
        const inputIndexes = whollyLeft
          ? [...indexes]
          : indexes.map((index) => index - leftWidth);
        if (
          inputIndexes.some(
            (index) =>
              !Number.isSafeInteger(index) ||
              index < 0 ||
              index >= input.fields.length,
          )
        )
          return undefined;
        indexes = inputIndexes;
        path.push({
          kind: "inner-join",
          node,
          side,
          outputIndexes: before,
          inputIndexes: indexes,
        });
        current = input;
        break;
      }
      default:
        return undefined;
    }
  }
}

function sameFields(
  left: readonly OutputField[],
  right: readonly OutputField[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (field, index) =>
        field.name === right[index]?.name &&
        field.affinity === right[index]?.affinity &&
        field.nullable === right[index]?.nullable,
    )
  );
}
