import {
  inspectTotalMaterializationSubtree,
  isMaterializationSafeNode,
  type SharedMembershipInputIncomingEdge,
} from "./materialization-safety";
import type { AggregateNode, LogicalQueryNode, QuerySource } from "./plan";

export interface SharedScalarCountReuseInput {
  readonly nodes: readonly LogicalQueryNode[];
  readonly incomingCounts: ReadonlyMap<LogicalQueryNode, number>;
  readonly incoming: ReadonlyMap<
    LogicalQueryNode,
    readonly SharedMembershipInputIncomingEdge[]
  >;
  readonly expressionQueryEdges: ReadonlySet<LogicalQueryNode>;
  readonly boundedGroupSummaryCandidates: ReadonlySet<LogicalQueryNode>;
  readonly minimumReferences: number;
}

export interface SharedScalarCountReuseRejection {
  readonly reason: string;
  readonly blocker: LogicalQueryNode;
  readonly relatedNode?: LogicalQueryNode;
  readonly missingKeyIndex?: number;
}

export interface SharedScalarCountInputSafetyProof {
  readonly kind: "finite-closed-input" | "admitted-scan-input";
  readonly unboundedInputs: readonly LogicalQueryNode[];
  readonly maximumRows: number | undefined;
  readonly admissionGate?: LogicalQueryNode;
  readonly controlRelation?: LogicalQueryNode;
  readonly boundedGroupSummary?: LogicalQueryNode;
  readonly controlMaximumRows?: number;
}

export interface SharedScalarCountReuseAssessment {
  readonly node: LogicalQueryNode;
  readonly accepted: boolean;
  readonly rejection?: SharedScalarCountReuseRejection;
  readonly inputSafetyProof?: SharedScalarCountInputSafetyProof;
}

interface RowShape {
  /** Undefined means the relation has no finite structural row bound. */
  readonly maximumRows: number | undefined;
  /** Output field indexes; an empty key denotes at most one row. */
  readonly uniqueKeys: readonly (readonly number[])[];
}

type ShapeResult =
  | { readonly shape: RowShape }
  | { readonly rejection: SharedScalarCountReuseRejection };

function rejection(
  reason: string,
  blocker: LogicalQueryNode,
  relatedNode?: LogicalQueryNode,
  missingKeyIndex?: number,
): ShapeResult {
  return {
    rejection: {
      reason,
      blocker,
      ...(relatedNode ? { relatedNode } : {}),
      ...(missingKeyIndex === undefined ? {} : { missingKeyIndex }),
    },
  };
}

function scalarShape(): RowShape {
  return { maximumRows: 1, uniqueKeys: [[]] };
}

export function isScalarCountRows(
  node: LogicalQueryNode,
): node is AggregateNode {
  if (
    node.kind !== "aggregate" ||
    node.groups.length !== 0 ||
    node.aggregates.length !== 1
  )
    return false;
  const expression = node.aggregates[0]!.expression;
  return (
    expression.kind === "aggregate" &&
    expression.name === "COUNT" &&
    expression.expression === undefined &&
    expression.distinct !== true
  );
}

function relationChildren(node: LogicalQueryNode): readonly QuerySource[] {
  switch (node.kind) {
    case "scan":
    case "values-relation":
    case "json-scalar-array":
      return [];
    case "filter":
    case "project":
    case "aggregate":
    case "distinct":
    case "window":
    case "sort":
    case "limit":
      return [node.input];
    case "recursive-closure":
      return [node.seed, node.candidates];
    case "join":
    case "semi-join":
    case "anti-join":
    case "union":
      return [node.left, node.right];
  }
}

function relationSubtreeNodes(
  root: LogicalQueryNode,
  boundedGroupSummaries: ReadonlySet<LogicalQueryNode>,
): ReadonlySet<LogicalQueryNode> {
  const nodes = new Set<LogicalQueryNode>();
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (nodes.has(node)) continue;
    nodes.add(node);
    if (boundedGroupSummaries.has(node)) continue;
    pending.push(...relationChildren(node).map(({ node: child }) => child));
  }
  return nodes;
}

function unboundedInputNodes(
  root: LogicalQueryNode,
  boundedGroupSummaries: ReadonlySet<LogicalQueryNode>,
): ReadonlySet<LogicalQueryNode> {
  const nodes = relationSubtreeNodes(root, boundedGroupSummaries);
  return new Set(
    [...nodes].filter(
      (node) => node.kind === "scan" || node.kind === "json-scalar-array",
    ),
  );
}

type SourcePathProof =
  | { readonly safe: true }
  | {
      readonly safe: false;
      readonly blocker: LogicalQueryNode;
      readonly reason: string;
    };

/**
 * A gate protects only source paths that cross its left data input. Walk each
 * node once for each protection state so a shared DAG node reached through a
 * guarded and an unguarded branch is checked both ways.
 */
function inspectUnboundedSourcePaths(
  root: LogicalQueryNode,
  gate: LogicalQueryNode,
  boundedGroupSummaries: ReadonlySet<LogicalQueryNode>,
): SourcePathProof {
  const pending: Array<{
    readonly node: LogicalQueryNode;
    readonly protectedByGate: boolean;
  }> = [{ node: root, protectedByGate: false }];
  const visitedStates = new Map<LogicalQueryNode, number>();

  while (pending.length > 0) {
    const { node, protectedByGate } = pending.pop()!;
    const stateBit = protectedByGate ? 2 : 1;
    const previousStates = visitedStates.get(node) ?? 0;
    if ((previousStates & stateBit) !== 0) continue;
    visitedStates.set(node, previousStates | stateBit);

    if (boundedGroupSummaries.has(node)) continue;
    if (
      (node.kind === "scan" || node.kind === "json-scalar-array") &&
      !protectedByGate
    )
      return {
        safe: false,
        blocker: node,
        reason: "unbounded-count-input-has-unprotected-source-path",
      };

    if (node === gate && node.kind === "semi-join") {
      pending.push({ node: node.left.node, protectedByGate: true });
      pending.push({ node: node.right.node, protectedByGate });
      continue;
    }

    for (const child of relationChildren(node))
      pending.push({ node: child.node, protectedByGate });
  }

  return { safe: true };
}

type FiniteInputResult =
  | { readonly finite: true; readonly maximumRows: number | undefined }
  | {
      readonly finite: false;
      readonly blocker: LogicalQueryNode;
      readonly reason: string;
    };

function finiteInputRows(
  node: LogicalQueryNode,
  boundedGroupSummaries: ReadonlySet<LogicalQueryNode>,
  memo: Map<LogicalQueryNode, FiniteInputResult>,
  active: Set<LogicalQueryNode>,
): FiniteInputResult {
  const cached = memo.get(node);
  if (cached) return cached;
  if (active.has(node))
    return { finite: false, blocker: node, reason: "finite-input-cycle" };
  if (boundedGroupSummaries.has(node))
    return { finite: true, maximumRows: undefined };
  active.add(node);
  const child = (source: QuerySource) =>
    finiteInputRows(source.node, boundedGroupSummaries, memo, active);
  const finish = (result: FiniteInputResult): FiniteInputResult => {
    active.delete(node);
    memo.set(node, result);
    return result;
  };
  switch (node.kind) {
    case "values-relation":
      return finish({ finite: true, maximumRows: node.rows.length });
    case "scan":
    case "json-scalar-array":
      return finish({
        finite: false,
        blocker: node,
        reason: "unbounded-input",
      });
    case "filter":
    case "project":
    case "distinct": {
      const input = child(node.input);
      return finish(input);
    }
    case "aggregate": {
      if (node.groups.length === 0)
        return finish({ finite: true, maximumRows: 1 });
      return finish(child(node.input));
    }
    case "semi-join":
    case "anti-join": {
      const left = child(node.left);
      if (!left.finite) return finish(left);
      const right = child(node.right);
      return finish(right.finite ? left : right);
    }
    case "join": {
      const left = child(node.left);
      if (!left.finite) return finish(left);
      const right = child(node.right);
      if (!right.finite) return finish(right);
      if (node.joinType === "inner") {
        if (left.maximumRows === 0 || right.maximumRows === 0)
          return finish({ finite: true, maximumRows: 0 });
        if (left.maximumRows === 1) return finish(right);
        if (right.maximumRows === 1) return finish(left);
        return finish({
          finite: false,
          blocker: node,
          reason: "finite-input-join-product-not-bounded-by-scalar-side",
        });
      }
      if (node.joinType === "left") {
        if (left.maximumRows === 0)
          return finish({ finite: true, maximumRows: 0 });
        if (left.maximumRows === 1) {
          return finish({
            finite: true,
            maximumRows:
              right.maximumRows === undefined
                ? undefined
                : Math.max(1, right.maximumRows),
          });
        }
        if (right.maximumRows === 0 || right.maximumRows === 1)
          return finish(left);
      }
      return finish({
        finite: false,
        blocker: node,
        reason: "finite-input-join-multiplicity-not-proved",
      });
    }
    case "union":
      return finish({
        finite: false,
        blocker: node,
        reason: "finite-input-union-not-proved",
      });
    case "sort":
    case "limit":
    case "window":
    case "recursive-closure":
      return finish({
        finite: false,
        blocker: node,
        reason: "finite-input-barrier-not-proved",
      });
  }
}

type CountInputSafetyResult =
  | { readonly proof: SharedScalarCountInputSafetyProof }
  | { readonly rejection: SharedScalarCountReuseRejection };

function inspectCountInputSafety(
  root: LogicalQueryNode,
  boundedGroupSummaries: ReadonlySet<LogicalQueryNode>,
  expressionQueryEdges: ReadonlySet<LogicalQueryNode>,
  rowShapeMemo: Map<LogicalQueryNode, ShapeResult>,
  rowShapeActive: Set<LogicalQueryNode>,
): CountInputSafetyResult {
  const unboundedInputs = unboundedInputNodes(root, boundedGroupSummaries);
  if (unboundedInputs.size === 0) {
    const finite = finiteInputRows(
      root,
      boundedGroupSummaries,
      new Map(),
      new Set(),
    );
    if (!finite.finite)
      return {
        rejection: { reason: finite.reason, blocker: finite.blocker },
      };
    return {
      proof: {
        kind: "finite-closed-input",
        unboundedInputs: [],
        maximumRows: finite.maximumRows,
      },
    };
  }

  const nodes = relationSubtreeNodes(root, boundedGroupSummaries);
  let unprotectedPath: SourcePathProof | undefined;
  for (const gate of nodes) {
    if (gate.kind !== "semi-join" || gate.right.node.kind !== "filter")
      continue;

    const controlSubtree = relationSubtreeNodes(
      gate.right.node,
      boundedGroupSummaries,
    );
    const anchors = new Set(
      [...controlSubtree].filter((node) => boundedGroupSummaries.has(node)),
    );
    if (anchors.size !== 1) continue;
    const control = inferRowShape(
      gate.right,
      expressionQueryEdges,
      rowShapeMemo,
      rowShapeActive,
    );
    if ("rejection" in control || control.shape.maximumRows !== 1) continue;

    const pathProof = inspectUnboundedSourcePaths(
      root,
      gate,
      boundedGroupSummaries,
    );
    if (!pathProof.safe) {
      unprotectedPath = pathProof;
      continue;
    }

    return {
      proof: {
        kind: "admitted-scan-input",
        unboundedInputs: [...unboundedInputs],
        maximumRows: undefined,
        admissionGate: gate,
        controlRelation: gate.right.node,
        boundedGroupSummary: [...anchors][0]!,
        controlMaximumRows: control.shape.maximumRows,
      },
    };
  }
  if (unprotectedPath && !unprotectedPath.safe)
    return {
      rejection: {
        reason: unprotectedPath.reason,
        blocker: unprotectedPath.blocker,
      },
    };
  return {
    rejection: {
      reason: "unbounded-count-input-lacks-guarded-bounded-control",
      blocker: root,
    },
  };
}

function safePositiveLimit(
  node: Extract<LogicalQueryNode, { kind: "limit" }>,
): { readonly safe: true; readonly rows: number } | { readonly safe: false } {
  if (
    node.offset !== undefined ||
    (node.count.kind !== "constant" && node.count.kind !== "parameter")
  )
    return { safe: false };
  const rows = node.count.value;
  return typeof rows === "number" && Number.isSafeInteger(rows) && rows > 0
    ? { safe: true, rows }
    : { safe: false };
}

function sortCoversUniqueKey(
  node: Extract<LogicalQueryNode, { kind: "sort" }>,
  shape: RowShape,
):
  | { readonly covered: true }
  | { readonly covered: false; readonly missingIndex?: number } {
  const directOrderIndexes = new Set<number>();
  for (const key of node.keys) {
    if (
      key.expression.kind === "column" &&
      key.expression.scope === node.input.scope &&
      Number.isInteger(key.expression.index) &&
      key.expression.index >= 0 &&
      key.expression.index < node.input.fields.length
    )
      directOrderIndexes.add(key.expression.index);
  }

  const nonEmptyKeys = shape.uniqueKeys.filter((key) => key.length > 0);
  if (nonEmptyKeys.length === 0) return { covered: false };
  for (const key of nonEmptyKeys) {
    if (key.every((index) => directOrderIndexes.has(index)))
      return { covered: true };
  }
  const firstKey = nonEmptyKeys[0]!;
  return {
    covered: false,
    missingIndex: firstKey.find((index) => !directOrderIndexes.has(index)),
  };
}

function inferRowShape(
  source: QuerySource,
  expressionQueryEdges: ReadonlySet<LogicalQueryNode>,
  memo: Map<LogicalQueryNode, ShapeResult>,
  active: Set<LogicalQueryNode>,
): ShapeResult {
  const node = source.node;
  const cached = memo.get(node);
  if (cached) return cached;
  if (active.has(node)) return rejection("row-shape-cycle", node);
  if (expressionQueryEdges.has(node))
    return rejection("row-shape-expression-query-edge", node);
  if (!isMaterializationSafeNode(node))
    return rejection("row-shape-local-expression-not-total", node);

  active.add(node);
  const childShape = (child: QuerySource) =>
    inferRowShape(child, expressionQueryEdges, memo, active);
  let result: ShapeResult;
  switch (node.kind) {
    case "scan":
    case "json-scalar-array":
      result = { shape: { maximumRows: undefined, uniqueKeys: [] } };
      break;
    case "values-relation":
      result = {
        shape: {
          maximumRows: node.rows.length,
          uniqueKeys: node.rows.length <= 1 ? [[]] : [],
        },
      };
      break;
    case "aggregate": {
      if (node.groups.length === 0) {
        result = { shape: scalarShape() };
      } else {
        result = {
          shape: {
            maximumRows: undefined,
            uniqueKeys: [
              Array.from(
                { length: node.groups.length },
                (_value, index) => index,
              ),
            ],
          },
        };
      }
      break;
    }
    case "filter": {
      const input = childShape(node.input);
      result = input;
      break;
    }
    case "project": {
      const input = childShape(node.input);
      if ("rejection" in input || input.shape.maximumRows === 1) {
        result = input;
        break;
      }
      const mappedKeys = input.shape.uniqueKeys.flatMap((key) => {
        if (key.length === 0) return [[]];
        const mapped = key.map((inputIndex) =>
          node.projections.findIndex(
            ({ expression }) =>
              expression.kind === "column" &&
              expression.scope === node.input.scope &&
              expression.index === inputIndex,
          ),
        );
        return mapped.every((index) => index >= 0) ? [mapped] : [];
      });
      result = {
        shape: { maximumRows: input.shape.maximumRows, uniqueKeys: mappedKeys },
      };
      break;
    }
    case "sort": {
      const input = childShape(node.input);
      result = input;
      break;
    }
    case "limit": {
      const input = childShape(node.input);
      if ("rejection" in input) {
        result = input;
        break;
      }
      const limit = safePositiveLimit(node);
      if (!limit.safe) {
        result = rejection(
          "limit-count-not-positive-integer-or-has-offset",
          node,
        );
        break;
      }
      if (input.shape.maximumRows !== 1) {
        if (node.input.node.kind !== "sort") {
          result = rejection("top-k-missing-total-order", node);
          break;
        }
        const sortedInput = childShape(node.input.node.input);
        if ("rejection" in sortedInput) {
          result = sortedInput;
          break;
        }
        const ordering = sortCoversUniqueKey(
          node.input.node,
          sortedInput.shape,
        );
        if (!ordering.covered) {
          result = rejection(
            "top-k-sort-does-not-cover-a-complete-proven-group-key",
            node,
            node.input.node,
            ordering.missingIndex,
          );
          break;
        }
      }
      result = {
        shape: {
          maximumRows:
            input.shape.maximumRows === undefined
              ? limit.rows
              : Math.min(input.shape.maximumRows, limit.rows),
          uniqueKeys: input.shape.uniqueKeys,
        },
      };
      break;
    }
    case "join": {
      if (node.joinType !== "inner") {
        result = rejection("ancestor-join-is-not-inner", node);
        break;
      }
      const left = childShape(node.left);
      if ("rejection" in left) {
        result = left;
        break;
      }
      const right = childShape(node.right);
      if ("rejection" in right) {
        result = right;
        break;
      }
      if (left.shape.maximumRows === 1 && right.shape.maximumRows === 1) {
        result = { shape: scalarShape() };
      } else if (left.shape.maximumRows === 1) {
        result = {
          shape: {
            maximumRows: right.shape.maximumRows,
            uniqueKeys: right.shape.uniqueKeys.map((key) =>
              key.map((index) => index + node.left.fields.length),
            ),
          },
        };
      } else if (right.shape.maximumRows === 1) {
        result = { shape: left.shape };
      } else {
        result = rejection("inner-join-has-no-proven-scalar-side", node);
      }
      break;
    }
    case "semi-join":
    case "anti-join":
      result = childShape(node.left);
      break;
    case "union":
      result = node.all
        ? { shape: { maximumRows: undefined, uniqueKeys: [] } }
        : rejection("distinct-union-does-not-preserve-proved-bag-keys", node);
      break;
    case "distinct":
      result = rejection("distinct-row-shape-is-outside-this-proof", node);
      break;
    case "window":
      result = rejection("window-row-shape-is-outside-this-proof", node);
      break;
    case "recursive-closure":
      result = rejection("recursive-row-shape-is-outside-this-proof", node);
      break;
  }
  active.delete(node);
  memo.set(node, result);
  return result;
}

function isRelationInput(
  parent: LogicalQueryNode,
  child: LogicalQueryNode,
): boolean {
  switch (parent.kind) {
    case "filter":
    case "project":
    case "aggregate":
    case "distinct":
    case "window":
    case "sort":
    case "limit":
      return parent.input.node === child;
    case "join":
    case "semi-join":
    case "anti-join":
    case "union":
      return parent.left.node === child || parent.right.node === child;
    case "recursive-closure":
      return parent.seed.node === child || parent.candidates.node === child;
    case "scan":
    case "values-relation":
    case "json-scalar-array":
      return false;
  }
}

function assessScalarCount(
  node: LogicalQueryNode,
  input: SharedScalarCountReuseInput,
): SharedScalarCountReuseAssessment {
  const fail = (
    reason: string,
    blocker: LogicalQueryNode = node,
    relatedNode?: LogicalQueryNode,
    missingKeyIndex?: number,
  ): SharedScalarCountReuseAssessment => ({
    node,
    accepted: false,
    rejection: {
      reason,
      blocker,
      ...(relatedNode ? { relatedNode } : {}),
      ...(missingKeyIndex === undefined ? {} : { missingKeyIndex }),
    },
  });

  if (!isScalarCountRows(node) || node.fields.length !== 1)
    return fail("not-one-field-global-count-rows");
  if (input.expressionQueryEdges.has(node))
    return fail("count-result-has-expression-query-edge");
  if (!isMaterializationSafeNode(node))
    return fail("count-expression-is-not-materialization-safe");

  const inputProof = inspectTotalMaterializationSubtree(
    node.input.node,
    input.boundedGroupSummaryCandidates,
    {
      allowUnionAll: false,
      expressionQueryEdges: input.expressionQueryEdges,
    },
  );
  if (!inputProof.safe)
    return fail(`count-input-${inputProof.reason}`, inputProof.blocker);

  const rowShapeMemo = new Map<LogicalQueryNode, ShapeResult>();
  const rowShapeActive = new Set<LogicalQueryNode>();
  const inputSafety = inspectCountInputSafety(
    node.input.node,
    input.boundedGroupSummaryCandidates,
    input.expressionQueryEdges,
    rowShapeMemo,
    rowShapeActive,
  );
  if ("rejection" in inputSafety)
    return fail(
      `count-input-${inputSafety.rejection.reason}`,
      inputSafety.rejection.blocker,
    );

  const consumers = input.incoming.get(node) ?? [];
  if (consumers.length < input.minimumReferences)
    return fail("count-result-has-too-few-relation-consumers");
  if (consumers.length !== (input.incomingCounts.get(node) ?? 0))
    return fail("count-result-incoming-edge-count-mismatch");
  if (consumers.some(({ kind }) => kind !== "relation"))
    return fail("count-result-has-expression-consumer");
  if (new Set(consumers.map(({ parent }) => parent)).size !== consumers.length)
    return fail("count-result-has-repeated-edge-from-one-parent");

  for (const { parent } of consumers) {
    if (
      parent.kind !== "join" ||
      parent.joinType !== "inner" ||
      (parent.left.node !== node && parent.right.node !== node)
    )
      return fail("direct-count-consumer-is-not-an-inner-join", parent);
    if (
      input.expressionQueryEdges.has(parent) ||
      !isMaterializationSafeNode(parent)
    )
      return fail("direct-count-consumer-is-not-closed-total", parent);
    const shape = inferRowShape(
      { node: parent, scope: parent.scope, fields: parent.fields },
      input.expressionQueryEdges,
      rowShapeMemo,
      rowShapeActive,
    );
    if ("rejection" in shape)
      return fail(
        shape.rejection.reason,
        shape.rejection.blocker,
        shape.rejection.relatedNode,
        shape.rejection.missingKeyIndex,
      );
  }

  const pending: LogicalQueryNode[] = [node];
  const visited = new Set<LogicalQueryNode>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of input.incoming.get(current) ?? []) {
      if (edge.kind !== "relation")
        return fail("ancestor-path-has-expression-edge", edge.parent, current);
      const parent = edge.parent;
      if (!isRelationInput(parent, current))
        return fail(
          "ancestor-edge-does-not-match-relation-input",
          parent,
          current,
        );
      if (input.expressionQueryEdges.has(parent))
        return fail("ancestor-path-has-expression-query-edge", parent, current);
      if (!isMaterializationSafeNode(parent))
        return fail(
          "ancestor-local-expression-is-not-closed-total",
          parent,
          current,
        );
      const rightMembershipInput =
        (parent.kind === "semi-join" || parent.kind === "anti-join") &&
        parent.right.node === current &&
        parent.left.node !== current;
      if (rightMembershipInput) continue;
      if (
        parent.kind === "window" ||
        parent.kind === "recursive-closure" ||
        parent.kind === "distinct"
      )
        return fail(`ancestor-${parent.kind}-is-not-proved`, parent, current);
      if (parent.kind === "union" && !parent.all)
        return fail("ancestor-distinct-union-is-not-proved", parent, current);
      if (parent.kind === "join" && parent.joinType !== "inner")
        return fail("ancestor-join-is-not-inner", parent, current);

      const shape = inferRowShape(
        { node: parent, scope: parent.scope, fields: parent.fields },
        input.expressionQueryEdges,
        rowShapeMemo,
        rowShapeActive,
      );
      if ("rejection" in shape)
        return fail(
          shape.rejection.reason,
          shape.rejection.blocker,
          shape.rejection.relatedNode,
          shape.rejection.missingKeyIndex,
        );
      pending.push(parent);
    }
  }

  return {
    node,
    accepted: true,
    inputSafetyProof: inputSafety.proof,
  };
}

export function inspectSharedScalarCountReuseCandidates(
  input: SharedScalarCountReuseInput,
): readonly SharedScalarCountReuseAssessment[] {
  return input.nodes
    .filter((node): node is AggregateNode => node.kind === "aggregate")
    .map((node) => assessScalarCount(node, input));
}

export function sharedScalarCountReuseCandidates(
  input: SharedScalarCountReuseInput,
): ReadonlySet<LogicalQueryNode> {
  return new Set(
    inspectSharedScalarCountReuseCandidates(input)
      .filter(({ accepted }) => accepted)
      .map(({ node }) => node),
  );
}
