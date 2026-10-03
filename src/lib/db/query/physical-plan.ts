import { DatabaseCompilerError } from "./errors";
import type {
  AnyExpression,
  AnyInListExpression,
  RelationScope,
  SqlExpression,
} from "./expression";
import type {
  FilterNode,
  JoinNode,
  LogicalQueryNode,
  OutputField,
  ProjectNode,
  QuerySource,
  Relation,
  ScanNode,
  ValuesRelationNode,
} from "./plan";
import { validateLogicalQueryPlan } from "./validator";

const MAX_SHARED_RELATION_FIELDS = 4;
const MAX_MATERIALIZED_SHARED_RELATION_FIELDS = 16;

export const MAX_D1_JSON_MEMBERSHIP_BYTES = 1_000_000;

export interface PhysicalMembershipUsage {
  readonly expression: AnyInListExpression;
  readonly occurrences: number;
}

export interface PhysicalMembershipStrategy {
  readonly expression: AnyInListExpression;
  readonly occurrences: number;
  readonly strategy: "native" | "json-text";
  readonly jsonText?: string;
  readonly jsonUtf8Bytes?: number;
  readonly nativeBindingsSaved: number;
}

export interface PhysicalMembershipOptimization {
  readonly nativeBindingCount: number;
  readonly selectedBindingCount: number;
  readonly strategies: readonly PhysicalMembershipStrategy[];
  readonly rowStrategies?: readonly PhysicalTextRowStrategy[];
  readonly tupleMemberships?: readonly PositiveTupleMembershipCandidate[];
}

export interface PhysicalMembershipOptimizationFacts {
  readonly nativeBindingCount: number;
  readonly usage: readonly PhysicalMembershipUsage[];
  readonly rowUsage?: readonly PhysicalTextRowUsage[];
}

export interface PhysicalTextRowUsage {
  readonly node: ValuesRelationNode;
  readonly occurrences: number;
}

export interface PhysicalTextRowJsonSegment {
  readonly jsonText: string;
  readonly jsonUtf8Bytes: number;
}

export interface PhysicalTextRowStrategy {
  readonly node: ValuesRelationNode;
  readonly occurrences: number;
  readonly strategy: "native" | "json-rows";
  readonly jsonSegments?: readonly PhysicalTextRowJsonSegment[];
  readonly nativeBindingsSaved: number;
}

/** A left-only Project over an exactly-keyed, finite positive Join. */
export interface PositiveTupleMembershipCandidate {
  readonly project: ProjectNode;
  readonly join: JoinNode;
  readonly valuesRelation: ValuesRelationNode;
  /** Left Join input indexes, in the corresponding RHS output-key order. */
  readonly leftKeyIndexes: readonly number[];
  /** Complete RHS output-key indexes, in tuple comparison order. */
  readonly rightKeyIndexes: readonly number[];
}

export interface SharedRelationDefinition {
  readonly name: string;
  readonly node: LogicalQueryNode;
  readonly scope: RelationScope;
  readonly fields: readonly OutputField[];
  /** Names of shared CTEs referenced by this CTE, in definition order. */
  readonly dependencies: readonly string[];
  /** CTE evaluation policy selected from the canonical logical query shape. */
  readonly materialization: "auto" | "materialized";
}

export interface DirectScanProjectionChoice {
  readonly project: ProjectNode;
  readonly scan: ScanNode;
  /** Actual schema SQL column names in the Project output order. */
  readonly sqlColumnNames: readonly string[];
}

/** A parent Project may skip a pure column-only Project whose scope it does not read. */
export interface PassthroughProjectFusion {
  readonly project: ProjectNode;
  readonly input: QuerySource;
}

/** Join outputs needed by a filter whose only visible projection is constant. */
export interface ConstantFilterJoinProjection {
  readonly project: ProjectNode;
  readonly filter: FilterNode;
  readonly join: JoinNode;
  readonly referencedOutputColumns: readonly number[];
}

export interface PhysicalQueryPlan<
  Row extends object = Record<string, unknown>,
> {
  readonly kind: "physical-query";
  readonly root: LogicalQueryNode;
  readonly scope: QuerySource["scope"];
  readonly fields: QuerySource["fields"];
  readonly sharedRelations: readonly SharedRelationDefinition[];
  /** Safe Project(Scan) column selections chosen by the physical planner. */
  readonly directScanProjections: readonly DirectScanProjectionChoice[];
  /** Safe parent Projects that can bypass an unused pure passthrough Project. */
  readonly passthroughProjectFusions: readonly PassthroughProjectFusion[];
  /** Safe sparse Join outputs for constant Project(Filter(Join)) shapes. */
  readonly constantFilterJoinProjections: readonly ConstantFilterJoinProjection[];
  /** Canonical structural candidates; enabled only when the RHS rows are packed. */
  readonly positiveTupleMembershipCandidates: readonly PositiveTupleMembershipCandidate[];
  /** Backend physical choice, populated after final-shape cost analysis. */
  readonly membershipOptimization?: PhysicalMembershipOptimization;
  readonly __rowType?: Row;
}

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function everyDenseMembershipValue(
  values: readonly unknown[],
  predicate: (value: unknown) => boolean,
): boolean {
  for (let index = 0; index < values.length; index++) {
    if (
      !Object.prototype.hasOwnProperty.call(values, index) ||
      !predicate(values[index])
    )
      return false;
  }
  return true;
}

function encodedJsonMembershipValues(
  expression: AnyInListExpression,
): { jsonText: string; jsonUtf8Bytes: number } | undefined {
  const affinity = expression.expression.resultType.affinity;
  const isTextList =
    affinity === "text" &&
    everyDenseMembershipValue(
      expression.values,
      (value) => typeof value === "string" && hasWellFormedUtf16(value),
    );
  const isSafeIntegerList =
    (affinity === "integer" || affinity === "real" || affinity === "numeric") &&
    everyDenseMembershipValue(
      expression.values,
      (value) => typeof value === "number" && Number.isSafeInteger(value),
    );
  if (expression.values.length < 2 || (!isTextList && !isSafeIntegerList))
    return undefined;
  const jsonText = JSON.stringify(expression.values);
  const jsonUtf8Bytes = new TextEncoder().encode(jsonText).byteLength;
  return jsonUtf8Bytes <= MAX_D1_JSON_MEMBERSHIP_BYTES
    ? { jsonText, jsonUtf8Bytes }
    : undefined;
}

function encodedJsonTextRows(
  node: ValuesRelationNode,
): readonly PhysicalTextRowJsonSegment[] | undefined {
  if (node.rows.length === 0) return undefined;
  const segments: PhysicalTextRowJsonSegment[] = [];
  let tuples: string[] = [];
  let tupleBytes = 0;
  for (const row of node.rows) {
    const tuple = JSON.stringify(row);
    const bytes = new TextEncoder().encode(tuple).byteLength;
    if (bytes + 2 > MAX_D1_JSON_MEMBERSHIP_BYTES) return undefined;
    const nextBytes = tupleBytes + bytes + (tuples.length === 0 ? 0 : 1) + 2;
    if (tuples.length > 0 && nextBytes > MAX_D1_JSON_MEMBERSHIP_BYTES) {
      const jsonText = `[${tuples.join(",")}]`;
      segments.push({
        jsonText,
        jsonUtf8Bytes: new TextEncoder().encode(jsonText).byteLength,
      });
      tuples = [];
      tupleBytes = 0;
    }
    tuples.push(tuple);
    tupleBytes += bytes + (tuples.length === 1 ? 0 : 1);
  }
  if (tuples.length > 0) {
    const jsonText = `[${tuples.join(",")}]`;
    segments.push({
      jsonText,
      jsonUtf8Bytes: new TextEncoder().encode(jsonText).byteLength,
    });
  }
  return segments.every(
    (segment) => segment.jsonUtf8Bytes <= MAX_D1_JSON_MEMBERSHIP_BYTES,
  )
    ? segments
    : undefined;
}

/** Select the generic D1 physical representation from measured final-shape costs. */
export function optimizePhysicalMembershipBudget<Row extends object>(
  plan: PhysicalQueryPlan<Row>,
  facts: PhysicalMembershipOptimizationFacts,
  bindingLimit: number,
): PhysicalQueryPlan<Row> {
  if (
    !Number.isInteger(facts.nativeBindingCount) ||
    facts.nativeBindingCount < 0 ||
    !Number.isInteger(bindingLimit) ||
    bindingLimit < 0
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Invalid physical membership budget facts",
    );

  const usage = facts.usage.map((item) => {
    if (!item || !item.expression || item.expression.kind !== "in-list")
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Invalid physical membership expression facts",
      );
    if (!Number.isInteger(item.occurrences) || item.occurrences < 1)
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Invalid physical membership occurrence count",
      );
    return item;
  });
  const rowUsage = (facts.rowUsage ?? []).map((item) => {
    if (!item || !item.node || item.node.kind !== "values-relation")
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Invalid physical text row relation facts",
      );
    if (!Number.isInteger(item.occurrences) || item.occurrences < 1)
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Invalid physical text row relation occurrence count",
      );
    return item;
  });

  const savingsByExpression = new Map<AnyInListExpression, number>();
  const encodingByExpression = new Map<
    AnyInListExpression,
    { readonly jsonText: string; readonly jsonUtf8Bytes: number } | undefined
  >();
  const savingsByRowNode = new Map<ValuesRelationNode, number>();
  const encodingByRowNode = new Map<
    ValuesRelationNode,
    readonly PhysicalTextRowJsonSegment[] | undefined
  >();
  let remaining = facts.nativeBindingCount;
  if (remaining > bindingLimit) {
    const rowCandidates = rowUsage.map((item, order) => {
      const encoding = encodedJsonTextRows(item.node);
      encodingByRowNode.set(item.node, encoding);
      return {
        ...item,
        order: usage.length + order,
        kind: "text-row" as const,
        saving: encoding
          ? item.occurrences *
            (item.node.rows.length * item.node.columns.length - encoding.length)
          : 0,
      };
    });
    const candidates = [
      ...usage.map((item, order) => ({
        ...item,
        order,
        kind: "membership" as const,
        saving: item.occurrences * (item.expression.values.length - 1),
      })),
      ...rowCandidates,
    ]
      .filter((item) => item.saving > 0)
      .sort(
        (left, right) => right.saving - left.saving || left.order - right.order,
      );
    for (const candidate of candidates) {
      if (remaining <= bindingLimit) break;
      if (candidate.kind === "membership") {
        let encoding = encodingByExpression.get(candidate.expression);
        if (!encoding && !encodingByExpression.has(candidate.expression)) {
          encoding = encodedJsonMembershipValues(candidate.expression);
          encodingByExpression.set(candidate.expression, encoding);
        }
        if (!encoding) continue;
        savingsByExpression.set(candidate.expression, candidate.saving);
        remaining -= candidate.saving;
      } else {
        const encoding = encodingByRowNode.get(candidate.node);
        if (!encoding) continue;
        savingsByRowNode.set(candidate.node, candidate.saving);
        remaining -= candidate.saving;
      }
    }
  }

  const strategies: PhysicalMembershipStrategy[] = usage.map((item) => {
    const nativeBindingsSaved = savingsByExpression.get(item.expression) ?? 0;
    if (nativeBindingsSaved === 0)
      return {
        expression: item.expression,
        occurrences: item.occurrences,
        strategy: "native",
        nativeBindingsSaved: 0,
      };
    const encoding = encodingByExpression.get(item.expression);
    if (!encoding)
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Selected physical membership has no safe JSON encoding",
      );
    return {
      expression: item.expression,
      occurrences: item.occurrences,
      strategy: "json-text",
      jsonText: encoding.jsonText,
      jsonUtf8Bytes: encoding.jsonUtf8Bytes,
      nativeBindingsSaved,
    };
  });
  const rowStrategies: PhysicalTextRowStrategy[] = rowUsage.map((item) => {
    const nativeBindingsSaved = savingsByRowNode.get(item.node) ?? 0;
    if (nativeBindingsSaved === 0)
      return {
        node: item.node,
        occurrences: item.occurrences,
        strategy: "native",
        nativeBindingsSaved: 0,
      };
    const jsonSegments = encodingByRowNode.get(item.node);
    if (!jsonSegments)
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Selected physical text row relation has no safe JSON encoding",
      );
    return {
      node: item.node,
      occurrences: item.occurrences,
      strategy: "json-rows",
      jsonSegments,
      nativeBindingsSaved,
    };
  });
  const packedRows = new Set(
    rowStrategies
      .filter((strategy) => strategy.strategy === "json-rows")
      .map((strategy) => strategy.node),
  );
  const tupleMemberships = (
    plan.positiveTupleMembershipCandidates ?? []
  ).filter((candidate) => packedRows.has(candidate.valuesRelation));

  return {
    ...plan,
    membershipOptimization: {
      nativeBindingCount: facts.nativeBindingCount,
      selectedBindingCount: remaining,
      strategies,
      rowStrategies,
      tupleMemberships,
    },
  };
}

export function hasSamePhysicalMembershipOptimization(
  actual: PhysicalMembershipOptimization | undefined,
  expected: PhysicalMembershipOptimization,
): boolean {
  const actualRowStrategies = actual?.rowStrategies ?? [];
  const expectedRowStrategies = expected.rowStrategies ?? [];
  const actualTupleMemberships = actual?.tupleMemberships ?? [];
  const expectedTupleMemberships = expected.tupleMemberships ?? [];
  if (
    !actual ||
    actual.nativeBindingCount !== expected.nativeBindingCount ||
    actual.selectedBindingCount !== expected.selectedBindingCount ||
    !Array.isArray(actual.strategies) ||
    actual.strategies.length !== expected.strategies.length ||
    !Array.isArray(actualRowStrategies) ||
    actualRowStrategies.length !== expectedRowStrategies.length ||
    !Array.isArray(actualTupleMemberships) ||
    actualTupleMemberships.length !== expectedTupleMemberships.length
  )
    return false;
  return (
    actual.strategies.every((item, index) => {
      const canonical = expected.strategies[index];
      return (
        !!item &&
        typeof item === "object" &&
        !!canonical &&
        item.expression === canonical.expression &&
        item.occurrences === canonical.occurrences &&
        item.strategy === canonical.strategy &&
        item.jsonText === canonical.jsonText &&
        item.jsonUtf8Bytes === canonical.jsonUtf8Bytes &&
        item.nativeBindingsSaved === canonical.nativeBindingsSaved
      );
    }) &&
    actualRowStrategies.every((item, index) => {
      const canonical = expectedRowStrategies[index];
      return (
        !!item &&
        typeof item === "object" &&
        !!canonical &&
        item.node === canonical.node &&
        item.occurrences === canonical.occurrences &&
        item.strategy === canonical.strategy &&
        item.nativeBindingsSaved === canonical.nativeBindingsSaved &&
        Array.isArray(item.jsonSegments) ===
          Array.isArray(canonical.jsonSegments) &&
        (item.jsonSegments ?? []).length ===
          (canonical.jsonSegments ?? []).length &&
        (item.jsonSegments ?? []).every(
          (segment: PhysicalTextRowJsonSegment, segmentIndex: number) => {
            const expectedSegment = canonical.jsonSegments?.[segmentIndex];
            return (
              !!expectedSegment &&
              segment.jsonText === expectedSegment.jsonText &&
              segment.jsonUtf8Bytes === expectedSegment.jsonUtf8Bytes
            );
          },
        )
      );
    }) &&
    actualTupleMemberships.every((item, index) => {
      const canonical = expectedTupleMemberships[index];
      return (
        !!item &&
        !!canonical &&
        item.project === canonical.project &&
        item.join === canonical.join &&
        item.valuesRelation === canonical.valuesRelation &&
        item.leftKeyIndexes.length === canonical.leftKeyIndexes.length &&
        item.leftKeyIndexes.every(
          (column: number, columnIndex: number) =>
            column === canonical.leftKeyIndexes[columnIndex],
        ) &&
        item.rightKeyIndexes.length === canonical.rightKeyIndexes.length &&
        item.rightKeyIndexes.every(
          (column: number, columnIndex: number) =>
            column === canonical.rightKeyIndexes[columnIndex],
        )
      );
    })
  );
}

function nodeExpressions(node: LogicalQueryNode): readonly SqlExpression[] {
  switch (node.kind) {
    case "filter":
      return [node.predicate];
    case "project":
      return node.projections.map(({ expression }) => expression);
    case "join":
    case "semi-join":
    case "anti-join":
      return [node.condition];
    case "aggregate":
      return [
        ...node.groups.map(({ expression }) => expression),
        ...node.aggregates.map(({ expression }) => expression),
      ];
    case "sort":
      return node.keys.map(({ expression }) => expression);
    case "window":
      return node.windows.flatMap(({ specification }) => [
        ...specification.partitionBy,
        ...(specification.kind === "row-number"
          ? specification.orderBy.map(({ expression }) => expression)
          : []),
      ]);
    case "limit":
      return [node.count, ...(node.offset ? [node.offset] : [])];
    case "recursive-closure":
      return [node.predicate];
    case "scan":
    case "values-relation":
    case "json-scalar-array":
    case "distinct":
    case "union":
      return [];
  }
}

function expressionSources(expression: SqlExpression): QuerySource[] {
  const result: QuerySource[] = [];
  const visit = (current: SqlExpression): void => {
    switch (current.kind) {
      case "binary":
      case "distinct-from":
        visit(current.left);
        visit(current.right);
        break;
      case "boolean":
        current.expressions.forEach(visit);
        break;
      case "not":
      case "null-check":
      case "cast-integer":
      case "cast-text":
        visit(current.expression);
        break;
      case "text-position":
        visit(current.text);
        visit(current.needle);
        break;
      case "text-substring":
        visit(current.text);
        visit(current.start);
        if (current.length) visit(current.length);
        break;
      case "text-like":
        visit(current.text);
        visit(current.pattern);
        break;
      case "in-list":
        visit(current.expression);
        break;
      case "in-subquery":
        visit(current.expression);
        result.push(current.query);
        break;
      case "function":
        current.arguments.forEach(visit);
        break;
      case "aggregate":
        if (current.expression) visit(current.expression);
        break;
      case "coalesce":
        current.expressions.forEach(visit);
        break;
      case "case":
        current.branches.forEach((branch) => {
          visit(branch.when);
          visit(branch.then);
        });
        if (current.else) visit(current.else);
        break;
      case "scalar-subquery":
        result.push(current.query);
        break;
      case "column":
      case "parameter":
      case "excluded":
      case "unixepoch":
      case "constant":
        break;
    }
  };
  visit(expression);
  return result;
}

function nodeChildren(node: LogicalQueryNode): QuerySource[] {
  return node.kind === "scan" ||
    node.kind === "values-relation" ||
    node.kind === "json-scalar-array"
    ? []
    : node.kind === "filter" ||
        node.kind === "project" ||
        node.kind === "aggregate" ||
        node.kind === "distinct" ||
        node.kind === "window" ||
        node.kind === "sort" ||
        node.kind === "limit"
      ? [node.input]
      : node.kind === "recursive-closure"
        ? [node.seed, node.candidates]
        : [node.left, node.right];
}

function nodeSources(node: LogicalQueryNode): QuerySource[] {
  return [
    ...nodeChildren(node),
    ...nodeExpressions(node).flatMap(expressionSources),
  ];
}

function directScanProjectionChoices(
  root: LogicalQueryNode,
): readonly DirectScanProjectionChoice[] {
  const postorder: LogicalQueryNode[] = [];
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const source of nodeSources(node)) visit(source.node);
    postorder.push(node);
  };
  visit(root);

  const choices: DirectScanProjectionChoice[] = [];
  for (const node of postorder) {
    if (node.kind !== "project" || node.input.node.kind !== "scan") continue;
    const scan = node.input.node;
    const columns = Object.values(scan.table.columns);
    const sqlColumnNames: string[] = [];
    let eligible = true;
    for (const projection of node.projections) {
      const expression = projection.expression;
      if (
        expression.kind !== "column" ||
        expression.scope !== node.input.scope ||
        !Number.isInteger(expression.index) ||
        expression.index < 0
      ) {
        eligible = false;
        break;
      }
      // Callers validate the logical plan first, which guarantees that this
      // column scope and index belong to the generated Scan input.
      sqlColumnNames.push(columns[expression.index]!.sqlName);
    }
    if (eligible) choices.push({ project: node, scan, sqlColumnNames });
  }
  return choices;
}

function sameDirectScanProjectionChoices(
  actual: readonly DirectScanProjectionChoice[],
  expected: readonly DirectScanProjectionChoice[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((choice, index) => {
      const canonical = expected[index];
      return (
        !!canonical &&
        choice.project === canonical.project &&
        choice.scan === canonical.scan &&
        Array.isArray(choice.sqlColumnNames) &&
        choice.sqlColumnNames.length === canonical.sqlColumnNames.length &&
        choice.sqlColumnNames.every(
          (name, columnIndex) => name === canonical.sqlColumnNames[columnIndex],
        )
      );
    })
  );
}

function expressionReferencesScope(
  expression: SqlExpression,
  target: RelationScope,
  visitedNodes: Set<LogicalQueryNode>,
): boolean {
  const inspectNode = (node: LogicalQueryNode): boolean => {
    if (visitedNodes.has(node)) return false;
    visitedNodes.add(node);
    return (
      nodeExpressions(node).some((child) =>
        expressionReferencesScope(child, target, visitedNodes),
      ) || nodeChildren(node).some((source) => inspectNode(source.node))
    );
  };
  const inspect = (current: SqlExpression): boolean => {
    if (current.kind === "column" && current.scope === target) return true;
    switch (current.kind) {
      case "binary":
      case "distinct-from":
        if (inspect(current.left) || inspect(current.right)) return true;
        break;
      case "boolean":
        if (current.expressions.some(inspect)) return true;
        break;
      case "not":
      case "null-check":
      case "cast-integer":
      case "cast-text":
      case "in-list":
        if (inspect(current.expression)) return true;
        break;
      case "text-position":
        if (inspect(current.text) || inspect(current.needle)) return true;
        break;
      case "text-substring":
        if (
          inspect(current.text) ||
          inspect(current.start) ||
          (current.length && inspect(current.length))
        )
          return true;
        break;
      case "text-like":
        if (inspect(current.text) || inspect(current.pattern)) return true;
        break;
      case "in-subquery":
        if (inspect(current.expression)) return true;
        break;
      case "function":
        if (current.arguments.some(inspect)) return true;
        break;
      case "aggregate":
        if (current.expression && inspect(current.expression)) return true;
        break;
      case "coalesce":
        if (current.expressions.some(inspect)) return true;
        break;
      case "case":
        if (
          current.branches.some(
            (branch) => inspect(branch.when) || inspect(branch.then),
          ) ||
          (current.else && inspect(current.else))
        )
          return true;
        break;
      case "scalar-subquery":
        break;
      case "column":
      case "parameter":
      case "excluded":
      case "unixepoch":
      case "constant":
        break;
    }
    return expressionSources(current).some((source) =>
      inspectNode(source.node),
    );
  };
  return inspect(expression);
}

function passthroughProjectFusions(
  root: LogicalQueryNode,
  sharedNodes: ReadonlySet<LogicalQueryNode>,
): readonly PassthroughProjectFusion[] {
  const postorder: LogicalQueryNode[] = [];
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const source of nodeSources(node)) visit(source.node);
    postorder.push(node);
  };
  visit(root);

  const choices: PassthroughProjectFusion[] = [];
  for (const node of postorder) {
    if (node.kind !== "project" || node.input.node.kind !== "project") continue;
    const passthrough = node.input.node;
    // This is the relational identity Project(parent, Project(columns, R))
    // = Project(parent, R) only when the inner Project has no computed values
    // and the parent does not read its scope. Keep shared nodes intact so
    // bypassing one reference cannot change CTE reuse/evaluation behavior.
    if (
      passthrough.input.node.kind === "scan" ||
      sharedNodes.has(passthrough) ||
      !passthrough.projections.every(
        ({ expression }) =>
          expression.kind === "column" &&
          expression.scope === passthrough.input.scope &&
          Number.isInteger(expression.index) &&
          expression.index >= 0 &&
          expression.index < passthrough.input.fields.length,
      ) ||
      node.projections.some(({ expression }) =>
        expressionReferencesScope(expression, passthrough.scope, new Set()),
      )
    )
      continue;
    choices.push({ project: node, input: passthrough.input });
  }
  return choices;
}

function samePassthroughProjectFusions(
  actual: readonly PassthroughProjectFusion[],
  expected: readonly PassthroughProjectFusion[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((choice, index) => {
      const canonical = expected[index];
      return (
        !!canonical &&
        choice.project === canonical.project &&
        choice.input.node === canonical.input.node &&
        choice.input.scope === canonical.input.scope &&
        sameFields(choice.input.fields, canonical.input.fields)
      );
    })
  );
}

function expressionColumnIndexes(
  expression: SqlExpression,
  target: RelationScope,
): readonly number[] | undefined {
  const indexes = new Set<number>();
  const visit = (current: SqlExpression): boolean => {
    switch (current.kind) {
      case "column":
        if (current.scope === target) indexes.add(current.index);
        return true;
      case "binary":
      case "distinct-from":
        return visit(current.left) && visit(current.right);
      case "boolean":
        return current.expressions.every(visit);
      case "not":
      case "null-check":
      case "cast-integer":
      case "cast-text":
      case "in-list":
        return visit(current.expression);
      case "text-position":
        return visit(current.text) && visit(current.needle);
      case "text-substring":
        return (
          visit(current.text) &&
          visit(current.start) &&
          (!current.length || visit(current.length))
        );
      case "text-like":
        return visit(current.text) && visit(current.pattern);
      case "function":
        return current.arguments.every(visit);
      case "aggregate":
        return !current.expression || visit(current.expression);
      case "coalesce":
        return current.expressions.every(visit);
      case "case":
        return (
          current.branches.every(
            (branch) => visit(branch.when) && visit(branch.then),
          ) &&
          (!current.else || visit(current.else))
        );
      // Query expressions may refer to the Join output from a correlated
      // subquery, so this narrow projection rule leaves them untouched.
      case "in-subquery":
      case "scalar-subquery":
        return false;
      case "parameter":
      case "excluded":
      case "unixepoch":
      case "constant":
        return true;
    }
  };
  return visit(expression)
    ? [...indexes].sort((left, right) => left - right)
    : undefined;
}

function incomingNodeCounts(
  root: LogicalQueryNode,
): Map<LogicalQueryNode, number> {
  const incoming = new Map<LogicalQueryNode, number>([[root, 1]]);
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const source of nodeSources(node)) {
      incoming.set(source.node, (incoming.get(source.node) ?? 0) + 1);
      visit(source.node);
    }
  };
  visit(root);
  return incoming;
}

function directColumnIndex(
  expression: SqlExpression,
  scope: RelationScope,
): number | undefined {
  return expression.kind === "column" && expression.scope === scope
    ? expression.index
    : undefined;
}

function expressionUsesOnlyScope(
  expression: SqlExpression,
  scope: RelationScope,
): boolean {
  switch (expression.kind) {
    case "column":
      return expression.scope === scope;
    case "binary":
    case "distinct-from":
      return (
        expressionUsesOnlyScope(expression.left, scope) &&
        expressionUsesOnlyScope(expression.right, scope)
      );
    case "boolean":
      return expression.expressions.every((item) =>
        expressionUsesOnlyScope(item, scope),
      );
    case "not":
    case "null-check":
    case "cast-integer":
    case "cast-text":
    case "in-list":
      return expressionUsesOnlyScope(expression.expression, scope);
    case "text-position":
      return (
        expressionUsesOnlyScope(expression.text, scope) &&
        expressionUsesOnlyScope(expression.needle, scope)
      );
    case "text-substring":
      return (
        expressionUsesOnlyScope(expression.text, scope) &&
        expressionUsesOnlyScope(expression.start, scope) &&
        (!expression.length ||
          expressionUsesOnlyScope(expression.length, scope))
      );
    case "text-like":
      return (
        expressionUsesOnlyScope(expression.text, scope) &&
        expressionUsesOnlyScope(expression.pattern, scope)
      );
    case "function":
      return expression.arguments.every((item) =>
        expressionUsesOnlyScope(item, scope),
      );
    case "aggregate":
      return (
        !expression.expression ||
        expressionUsesOnlyScope(expression.expression, scope)
      );
    case "coalesce":
      return expression.expressions.every((item) =>
        expressionUsesOnlyScope(item, scope),
      );
    case "case":
      return (
        expression.branches.every(
          (branch) =>
            expressionUsesOnlyScope(branch.when, scope) &&
            expressionUsesOnlyScope(branch.then, scope),
        ) &&
        (!expression.else || expressionUsesOnlyScope(expression.else, scope))
      );
    case "in-subquery":
    case "scalar-subquery":
      return false;
    case "parameter":
    case "excluded":
    case "unixepoch":
    case "constant":
      return true;
  }
}

function equalityPairs(
  expression: SqlExpression,
  leftScope: RelationScope,
  rightScope: RelationScope,
): { readonly left: number; readonly right: number }[] | undefined {
  if (
    expression.kind === "boolean" &&
    expression.operator === "AND" &&
    expression.expressions.length > 0
  ) {
    const pairs: { readonly left: number; readonly right: number }[] = [];
    for (const child of expression.expressions) {
      const nested = equalityPairs(child, leftScope, rightScope);
      if (!nested) return undefined;
      pairs.push(...nested);
    }
    return pairs;
  }
  if (expression.kind !== "binary" || expression.operator !== "=")
    return undefined;
  const leftIndex = directColumnIndex(expression.left, leftScope);
  const rightIndex = directColumnIndex(expression.right, rightScope);
  return leftIndex === undefined || rightIndex === undefined
    ? undefined
    : [{ left: leftIndex, right: rightIndex }];
}

function safeFinitePredicate(expression: SqlExpression): boolean {
  switch (expression.kind) {
    case "binary":
      return (
        ["=", "<>", ">", ">=", "<", "<="].includes(expression.operator) &&
        (expression.left.kind === "column" ||
          expression.left.kind === "parameter" ||
          expression.left.kind === "constant") &&
        (expression.right.kind === "column" ||
          expression.right.kind === "parameter" ||
          expression.right.kind === "constant")
      );
    case "boolean":
      return (
        expression.operator === "AND" &&
        expression.expressions.length > 0 &&
        expression.expressions.every(safeFinitePredicate)
      );
    case "in-list":
      return (
        expression.expression.kind === "column" &&
        Array.isArray(expression.values) &&
        Reflect.ownKeys(expression.values).length ===
          expression.values.length + 1 &&
        expression.values.every(
          (value, index) =>
            Object.prototype.hasOwnProperty.call(expression.values, index) &&
            (value === null ||
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean"),
        )
      );
    case "column":
    case "parameter":
    case "constant":
      return true;
    default:
      return false;
  }
}

function safeEqualityCondition(
  expression: SqlExpression,
  leftScope: RelationScope,
  rightScope: RelationScope,
  leftFields: readonly OutputField[],
  rightFields: readonly OutputField[],
): boolean {
  const pairs = equalityPairs(expression, leftScope, rightScope);
  return (
    !!pairs &&
    pairs.length > 0 &&
    pairs.every(
      ({ left, right }) =>
        left >= 0 &&
        left < leftFields.length &&
        right >= 0 &&
        right < rightFields.length,
    )
  );
}

/**
 * Shared inputs remain CTE references; inspect only to prove they are pure,
 * local, read-only generated-schema lookups before treating them as a boundary.
 */
function isSafeSharedLookup(root: LogicalQueryNode): boolean {
  const visited = new Set<LogicalQueryNode>();
  let hasGeneratedScan = false;
  const visit = (node: LogicalQueryNode): boolean => {
    if (visited.has(node)) return true;
    visited.add(node);
    switch (node.kind) {
      case "scan":
        hasGeneratedScan = true;
        return true;
      case "filter":
        return (
          safeFinitePredicate(node.predicate) &&
          expressionUsesOnlyScope(node.predicate, node.input.scope) &&
          visit(node.input.node)
        );
      case "project":
        return (
          node.projections.every(({ expression }) => {
            const index = directColumnIndex(expression, node.input.scope);
            return (
              index !== undefined &&
              index >= 0 &&
              index < node.input.fields.length
            );
          }) && visit(node.input.node)
        );
      case "join":
        return (
          node.joinType === "inner" &&
          safeEqualityCondition(
            node.condition,
            node.left.scope,
            node.right.scope,
            node.left.fields,
            node.right.fields,
          ) &&
          visit(node.left.node) &&
          visit(node.right.node)
        );
      default:
        return false;
    }
  };
  return visit(root) && hasGeneratedScan;
}

/**
 * The current generated catalog and ValuesRelation have only default BINARY
 * columns; the validated expression algebra has no COLLATE or raw-SQL node.
 * Trace direct fields only, so future/unknown computed sources opt out.
 */
function hasKnownBinaryColumnSource(
  source: QuerySource,
  index: number,
  visited = new Set<LogicalQueryNode>(),
): boolean {
  if (index < 0 || index >= source.fields.length || visited.has(source.node))
    return false;
  const node = source.node;
  visited.add(node);
  switch (node.kind) {
    case "scan":
    case "values-relation":
      return true;
    case "filter":
    case "distinct":
      return hasKnownBinaryColumnSource(node.input, index, visited);
    case "project": {
      const inputIndex = directColumnIndex(
        node.projections[index]!.expression,
        node.input.scope,
      );
      return (
        inputIndex !== undefined &&
        hasKnownBinaryColumnSource(node.input, inputIndex, visited)
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
    default:
      return false;
  }
}

function hasSafeFiniteValuesAncestor(
  root: QuerySource,
  incoming: ReadonlyMap<LogicalQueryNode, number>,
  sharedNodes: ReadonlySet<LogicalQueryNode>,
): ValuesRelationNode | undefined {
  const visited = new Set<LogicalQueryNode>();
  const values = new Set<ValuesRelationNode>();
  const visit = (node: LogicalQueryNode): boolean => {
    const incomingCount = incoming.get(node) ?? 0;
    // A repeated CTE reference and a repeated non-CTE DAG node are both
    // boundaries only after proving the complete subtree is a safe lookup.
    if (sharedNodes.has(node) || incomingCount > 1)
      return incomingCount > 1 && isSafeSharedLookup(node);
    if (visited.has(node) || incomingCount !== 1) return false;
    visited.add(node);
    switch (node.kind) {
      case "values-relation":
        values.add(node);
        return true;
      case "scan":
        return true;
      case "filter":
        return (
          safeFinitePredicate(node.predicate) &&
          expressionUsesOnlyScope(node.predicate, node.input.scope) &&
          visit(node.input.node)
        );
      case "project":
        return (
          node.projections.every(
            ({ expression }) =>
              expression.kind === "column" &&
              expression.scope === node.input.scope,
          ) && visit(node.input.node)
        );
      case "join":
        return (
          node.joinType === "inner" &&
          safeEqualityCondition(
            node.condition,
            node.left.scope,
            node.right.scope,
            node.left.fields,
            node.right.fields,
          ) &&
          visit(node.left.node) &&
          visit(node.right.node)
        );
      default:
        return false;
    }
  };
  return visit(root.node) && values.size === 1
    ? values.values().next().value
    : undefined;
}

function positiveTupleMembershipCandidates(
  root: LogicalQueryNode,
  sharedNodes: ReadonlySet<LogicalQueryNode>,
): readonly PositiveTupleMembershipCandidate[] {
  const incoming = incomingNodeCounts(root);
  const postorder: LogicalQueryNode[] = [];
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const source of nodeSources(node)) visit(source.node);
    postorder.push(node);
  };
  visit(root);

  const candidates: PositiveTupleMembershipCandidate[] = [];
  for (const node of postorder) {
    if (
      node.kind !== "project" ||
      node.input.node.kind !== "join" ||
      node.projections.length === 0
    )
      continue;
    const join = node.input.node;
    if (
      join.joinType !== "inner" ||
      sharedNodes.has(node) ||
      sharedNodes.has(join) ||
      incoming.get(node) !== 1 ||
      incoming.get(join) !== 1 ||
      !node.projections.every(({ expression }) => {
        const index = directColumnIndex(expression, join.scope);
        return index !== undefined && index < join.left.fields.length;
      }) ||
      join.right.node.kind !== "distinct"
    )
      continue;

    const distinct = join.right.node;
    if (distinct.input.node.kind !== "project") continue;
    const keyProjection = distinct.input.node;
    const keyCount = distinct.fields.length;
    if (
      keyCount === 0 ||
      distinct.fields.length !== distinct.input.fields.length ||
      keyProjection.projections.length !== keyCount ||
      sharedNodes.has(distinct) ||
      sharedNodes.has(keyProjection) ||
      incoming.get(distinct) !== 1 ||
      incoming.get(keyProjection) !== 1
    )
      continue;

    const rightKeyIndexes: number[] = [];
    const uniqueSourceIndexes = new Set<number>();
    let validKeys = true;
    for (let index = 0; index < keyCount; index++) {
      const expression = keyProjection.projections[index]!.expression;
      const sourceIndex = directColumnIndex(
        expression,
        keyProjection.input.scope,
      );
      if (
        sourceIndex === undefined ||
        sourceIndex < 0 ||
        sourceIndex >= keyProjection.input.fields.length ||
        uniqueSourceIndexes.has(sourceIndex) ||
        !hasKnownBinaryColumnSource(keyProjection.input, sourceIndex)
      ) {
        validKeys = false;
        break;
      }
      uniqueSourceIndexes.add(sourceIndex);
      rightKeyIndexes.push(index);
    }
    if (!validKeys) continue;

    const pairs = equalityPairs(
      join.condition,
      join.left.scope,
      join.right.scope,
    );
    if (
      !pairs ||
      pairs.length !== keyCount ||
      new Set(pairs.map(({ right }) => right)).size !== keyCount ||
      pairs.some(({ right }) => right < 0 || right >= keyCount)
    )
      continue;
    const leftKeyIndexes: number[] = [];
    for (const right of rightKeyIndexes) {
      const pair = pairs.find((item) => item.right === right);
      if (
        !pair ||
        pair.left < 0 ||
        pair.left >= join.left.fields.length ||
        join.left.fields[pair.left]!.affinity === "unknown" ||
        join.right.fields[right]!.affinity === "unknown" ||
        join.left.fields[pair.left]!.affinity !==
          join.right.fields[right]!.affinity ||
        !hasKnownBinaryColumnSource(join.left, pair.left)
      ) {
        validKeys = false;
        break;
      }
      leftKeyIndexes.push(pair.left);
    }
    if (!validKeys) continue;

    const valuesRelation = hasSafeFiniteValuesAncestor(
      distinct.input,
      incoming,
      sharedNodes,
    );
    if (!valuesRelation) continue;
    candidates.push({
      project: node,
      join,
      valuesRelation,
      leftKeyIndexes,
      rightKeyIndexes,
    });
  }
  return candidates;
}

function constantFilterJoinProjections(
  root: LogicalQueryNode,
  sharedNodes: ReadonlySet<LogicalQueryNode>,
  fusions: readonly PassthroughProjectFusion[],
): readonly ConstantFilterJoinProjection[] {
  const incoming = incomingNodeCounts(root);
  const fusedInputs = new Map(
    fusions.map((fusion) => [fusion.project, fusion.input] as const),
  );
  const postorder: LogicalQueryNode[] = [];
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const source of nodeSources(node)) visit(source.node);
    postorder.push(node);
  };
  visit(root);

  const choices: ConstantFilterJoinProjection[] = [];
  for (const node of postorder) {
    if (
      node.kind !== "project" ||
      node.projections.length === 0 ||
      !node.projections.every(
        ({ expression }) => expression.kind === "constant",
      )
    )
      continue;
    const input = fusedInputs.get(node) ?? node.input;
    if (input.node.kind !== "filter") continue;
    const filter = input.node;
    if (filter.input.node.kind !== "join") continue;
    const join = filter.input.node;
    if (
      sharedNodes.has(node) ||
      sharedNodes.has(filter) ||
      sharedNodes.has(join) ||
      incoming.get(filter) !== 1 ||
      incoming.get(join) !== 1
    )
      continue;
    const referencedOutputColumns = expressionColumnIndexes(
      filter.predicate,
      join.scope,
    );
    if (
      referencedOutputColumns === undefined ||
      referencedOutputColumns.some(
        (index) => index < 0 || index >= join.fields.length,
      )
    )
      continue;
    choices.push({ project: node, filter, join, referencedOutputColumns });
  }
  return choices;
}

function sameConstantFilterJoinProjections(
  actual: readonly ConstantFilterJoinProjection[],
  expected: readonly ConstantFilterJoinProjection[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((choice, index) => {
      const canonical = expected[index];
      return (
        !!canonical &&
        choice.project === canonical.project &&
        choice.filter === canonical.filter &&
        choice.join === canonical.join &&
        choice.referencedOutputColumns.length ===
          canonical.referencedOutputColumns.length &&
        choice.referencedOutputColumns.every(
          (column, columnIndex) =>
            column === canonical.referencedOutputColumns[columnIndex],
        )
      );
    })
  );
}

function samePositiveTupleMembershipCandidates(
  actual: readonly PositiveTupleMembershipCandidate[],
  expected: readonly PositiveTupleMembershipCandidate[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((candidate, index) => {
      const canonical = expected[index];
      return (
        !!canonical &&
        candidate.project === canonical.project &&
        candidate.join === canonical.join &&
        candidate.valuesRelation === canonical.valuesRelation &&
        candidate.leftKeyIndexes.length === canonical.leftKeyIndexes.length &&
        candidate.leftKeyIndexes.every(
          (column, columnIndex) =>
            column === canonical.leftKeyIndexes[columnIndex],
        ) &&
        candidate.rightKeyIndexes.length === canonical.rightKeyIndexes.length &&
        candidate.rightKeyIndexes.every(
          (column, columnIndex) =>
            column === canonical.rightKeyIndexes[columnIndex],
        )
      );
    })
  );
}

interface HoistEligibility {
  readonly forbidden: Set<LogicalQueryNode>;
  readonly windowInput: Set<LogicalQueryNode>;
}

/** Keep selection-sensitive barriers while permitting safe inputs below Window. */
function hoistEligibility(root: LogicalQueryNode): HoistEligibility {
  const forbidden = new Set<LogicalQueryNode>();
  const windowInput = new Set<LogicalQueryNode>();
  const visited = new Map<LogicalQueryNode, Set<string>>();
  const visit = (
    node: LogicalQueryNode,
    inheritedForbidden: boolean,
    underWindow: boolean,
    underBranchTopN: boolean,
  ): void => {
    let contexts = visited.get(node);
    if (!contexts) {
      contexts = new Set();
      visited.set(node, contexts);
    }
    const context = `${inheritedForbidden}:${underWindow}`;
    if (contexts.has(context)) return;
    contexts.add(context);
    if (inheritedForbidden || node.kind === "window") forbidden.add(node);
    if (underWindow && !inheritedForbidden && node.kind !== "window")
      windowInput.add(node);

    const terminalRootSort = node === root && node.kind === "sort";
    const branchTopN =
      node !== root &&
      !inheritedForbidden &&
      node.kind === "limit" &&
      nodeChildren(node).some((child) => child.node.kind === "sort");
    const safeBranchTopN = underBranchTopN || branchTopN;
    const selectionBoundary =
      inheritedForbidden ||
      (node.kind === "sort" && !terminalRootSort && !safeBranchTopN) ||
      node.kind === "recursive-closure" ||
      (node.kind === "limit" && !branchTopN);
    for (const child of nodeChildren(node))
      visit(
        child.node,
        selectionBoundary,
        underWindow || node.kind === "window",
        safeBranchTopN,
      );
    for (const query of nodeExpressions(node).flatMap(expressionSources))
      visit(query.node, true, false, false);
  };
  visit(root, false, false, false);
  return { forbidden, windowInput };
}

interface CandidateFacts {
  readonly scopes: Set<RelationScope>;
  readonly referencedScopes: RelationScope[];
  selective: boolean;
  forbidden: boolean;
}

function candidateFacts(root: LogicalQueryNode): CandidateFacts {
  const facts: CandidateFacts = {
    scopes: new Set(),
    referencedScopes: [],
    selective: false,
    forbidden: false,
  };
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    facts.scopes.add(node.scope);
    if (
      node.kind === "filter" ||
      node.kind === "semi-join" ||
      node.kind === "anti-join"
    )
      facts.selective = true;
    if (
      node.kind === "sort" ||
      node.kind === "limit" ||
      node.kind === "window" ||
      node.kind === "recursive-closure"
    )
      facts.forbidden = true;
    for (const expression of nodeExpressions(node)) {
      const inspect = (current: SqlExpression): void => {
        if (current.kind === "column")
          facts.referencedScopes.push(current.scope);
        if (
          current.kind === "unixepoch" ||
          current.kind === "scalar-subquery" ||
          current.kind === "in-subquery"
        )
          facts.forbidden = true;
        switch (current.kind) {
          case "binary":
          case "distinct-from":
            inspect(current.left);
            inspect(current.right);
            break;
          case "boolean":
            current.expressions.forEach(inspect);
            break;
          case "not":
          case "null-check":
          case "in-list":
            inspect(current.expression);
            break;
          case "cast-text":
            inspect(current.expression);
            break;
          case "text-position":
            inspect(current.text);
            inspect(current.needle);
            break;
          case "text-substring":
            inspect(current.text);
            inspect(current.start);
            if (current.length) inspect(current.length);
            break;
          case "text-like":
            inspect(current.text);
            inspect(current.pattern);
            break;
          case "cast-integer":
            inspect(current.expression);
            break;
          case "in-subquery":
            inspect(current.expression);
            break;
          case "function":
            current.arguments.forEach(inspect);
            break;
          case "aggregate":
            if (current.expression) inspect(current.expression);
            break;
          case "coalesce":
            current.expressions.forEach(inspect);
            break;
          case "case":
            current.branches.forEach((branch) => {
              inspect(branch.when);
              inspect(branch.then);
            });
            if (current.else) inspect(current.else);
            break;
          case "column":
          case "parameter":
          case "excluded":
          case "unixepoch":
          case "scalar-subquery":
          case "constant":
            break;
        }
      };
      inspect(expression);
    }
    nodeSources(node).forEach((source) => visit(source.node));
  };
  visit(root);
  return facts;
}

function sameFields(
  left: readonly OutputField[],
  right: readonly OutputField[],
) {
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

function sharedRelationDefinitions(
  root: LogicalQueryNode,
): readonly SharedRelationDefinition[] {
  const incoming = new Map<LogicalQueryNode, number>([[root, 1]]);
  const visited = new Set<LogicalQueryNode>();
  const active = new Set<LogicalQueryNode>();
  const postorder: LogicalQueryNode[] = [];
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    if (active.has(node))
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Query plan contains a cycle",
      );
    active.add(node);
    for (const source of nodeSources(node)) {
      incoming.set(source.node, (incoming.get(source.node) ?? 0) + 1);
      visit(source.node);
    }
    active.delete(node);
    visited.add(node);
    postorder.push(node);
  };
  visit(root);
  const hoist = hoistEligibility(root);

  const sharedMaterializations = new Map<
    LogicalQueryNode,
    SharedRelationDefinition["materialization"]
  >();
  for (const node of postorder) {
    const incomingCount = incoming.get(node) ?? 0;
    if (
      incomingCount < 2 ||
      node.kind === "scan" ||
      hoist.forbidden.has(node) ||
      node.fields.length === 0 ||
      node.fields.length > MAX_MATERIALIZED_SHARED_RELATION_FIELDS
    )
      continue;
    const facts = candidateFacts(node);
    const isSafe =
      facts.selective &&
      !facts.forbidden &&
      facts.referencedScopes.every((scope) => facts.scopes.has(scope));
    if (!isSafe) continue;

    if (node.fields.length <= MAX_SHARED_RELATION_FIELDS) {
      sharedMaterializations.set(
        node,
        hoist.windowInput.has(node) ? "materialized" : "auto",
      );
      continue;
    }
    if (node.kind === "project" && incomingCount >= 3)
      sharedMaterializations.set(node, "materialized");
  }

  const shared = new Set(sharedMaterializations.keys());
  if (shared.size === 0) return [];

  const names = new Map<LogicalQueryNode, string>();
  const reservedNames = new Set(
    postorder
      .filter((node) => node.kind === "scan")
      .map((node) => node.table.name),
  );
  let nextName = 0;
  postorder.forEach((node) => {
    if (shared.has(node)) {
      let name = `_d1_shared_${nextName++}`;
      while (reservedNames.has(name)) name = `_d1_shared_${nextName++}`;
      names.set(node, name);
      reservedNames.add(name);
    }
  });

  return postorder
    .filter((node) => shared.has(node))
    .map((node) => {
      const dependencies = new Set<string>();
      const descendants = new Set<LogicalQueryNode>();
      const collect = (current: LogicalQueryNode): void => {
        if (descendants.has(current)) return;
        descendants.add(current);
        for (const source of nodeSources(current)) {
          const dependency = names.get(source.node);
          if (dependency) dependencies.add(dependency);
          collect(source.node);
        }
      };
      collect(node);
      dependencies.delete(names.get(node)!);
      const orderedDependencies = [...dependencies].sort(
        (left, right) =>
          postorder.findIndex((item) => names.get(item) === left) -
          postorder.findIndex((item) => names.get(item) === right),
      );
      return {
        name: names.get(node)!,
        node,
        scope: node.scope,
        fields: node.fields,
        dependencies: orderedDependencies,
        materialization: sharedMaterializations.get(node)!,
      };
    });
}

/** Validate optimizer metadata against a fresh analysis of the logical root. */
export function validatePhysicalQueryPlan<Row extends object>(
  plan: PhysicalQueryPlan<Row>,
): void {
  if (
    !plan ||
    typeof plan !== "object" ||
    !plan.root ||
    typeof plan.root !== "object"
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Invalid physical query plan",
    );
  validateLogicalQueryPlan(plan.root);
  if (
    plan.scope !== plan.root.scope ||
    !Array.isArray(plan.fields) ||
    !sameFields(plan.fields, plan.root.fields)
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical query root metadata does not match its logical node",
    );
  const expected = sharedRelationDefinitions(plan.root);
  const expectedDirectScanProjections = directScanProjectionChoices(plan.root);
  const expectedPassthroughProjectFusions = passthroughProjectFusions(
    plan.root,
    new Set(expected.map(({ node }) => node)),
  );
  const expectedConstantFilterJoinProjections = constantFilterJoinProjections(
    plan.root,
    new Set(expected.map(({ node }) => node)),
    expectedPassthroughProjectFusions,
  );
  const expectedPositiveTupleMembershipCandidates =
    positiveTupleMembershipCandidates(
      plan.root,
      new Set(expected.map(({ node }) => node)),
    );
  if (
    !Array.isArray(plan.directScanProjections) ||
    !sameDirectScanProjectionChoices(
      plan.directScanProjections,
      expectedDirectScanProjections,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical direct scan projection choices are inconsistent",
    );
  if (
    !Array.isArray(plan.passthroughProjectFusions) ||
    !samePassthroughProjectFusions(
      plan.passthroughProjectFusions,
      expectedPassthroughProjectFusions,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical passthrough projection fusions are inconsistent",
    );
  if (
    !Array.isArray(plan.constantFilterJoinProjections) ||
    !sameConstantFilterJoinProjections(
      plan.constantFilterJoinProjections,
      expectedConstantFilterJoinProjections,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical constant filter Join projections are inconsistent",
    );
  if (
    !Array.isArray(plan.positiveTupleMembershipCandidates) ||
    !samePositiveTupleMembershipCandidates(
      plan.positiveTupleMembershipCandidates,
      expectedPositiveTupleMembershipCandidates,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical tuple membership candidates are inconsistent",
    );
  const actualDefinitions = plan.sharedRelations;
  let inconsistent =
    !Array.isArray(actualDefinitions) ||
    actualDefinitions.length !== expected.length;
  if (!inconsistent) {
    for (let index = 0; index < expected.length; index++) {
      const actual = actualDefinitions[index]!;
      const canonical = expected[index]!;
      if (
        !actual ||
        typeof actual !== "object" ||
        !Array.isArray(actual.fields) ||
        !Array.isArray(actual.dependencies) ||
        actual.name !== canonical.name ||
        actual.node !== canonical.node ||
        actual.scope !== canonical.scope ||
        actual.materialization !== canonical.materialization ||
        !sameFields(actual.fields, canonical.fields) ||
        actual.dependencies.length !== canonical.dependencies.length ||
        actual.dependencies.some(
          (dependency: string, dependencyIndex: number) =>
            dependency !== canonical.dependencies[dependencyIndex],
        )
      ) {
        inconsistent = true;
        break;
      }
    }
  }
  if (inconsistent)
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical query shared relation metadata is inconsistent",
    );
}

export function lowerLogicalQuerySource<Row extends object>(
  source: QuerySource,
): PhysicalQueryPlan<Row> {
  validateLogicalQueryPlan(
    "kind" in source && source.kind === "relation"
      ? (source as Relation<object>)
      : source.node,
  );
  if (
    source.scope !== source.node.scope ||
    !sameFields(source.fields, source.node.fields)
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Query source metadata does not match its logical node",
    );
  const sharedRelations = sharedRelationDefinitions(source.node);
  const sharedNodes = new Set(sharedRelations.map(({ node }) => node));
  const projectFusions = passthroughProjectFusions(source.node, sharedNodes);
  return {
    kind: "physical-query",
    root: source.node,
    scope: source.scope,
    fields: source.fields,
    sharedRelations,
    directScanProjections: directScanProjectionChoices(source.node),
    passthroughProjectFusions: projectFusions,
    constantFilterJoinProjections: constantFilterJoinProjections(
      source.node,
      sharedNodes,
      projectFusions,
    ),
    positiveTupleMembershipCandidates: positiveTupleMembershipCandidates(
      source.node,
      sharedNodes,
    ),
  };
}

/** Number of distinct recursive closure nodes rendered as local CTEs. */
export function recursiveClosureCount(root: LogicalQueryNode): number {
  const visited = new Set<LogicalQueryNode>();
  let count = 0;
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.kind === "recursive-closure") count += 1;
    for (const source of nodeSources(node)) visit(source.node);
  };
  visit(root);
  return count;
}

export function lowerLogicalPlan<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
>(relation: Relation<Row, Columns>): PhysicalQueryPlan<Row> {
  return lowerLogicalQuerySource<Row>(relation);
}
