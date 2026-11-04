import {
  and,
  type AnyExpression,
  caseWhen,
  constant,
  eq,
  type Predicate,
  type SqlExpression,
} from "@/lib/db/query/expression";
import type {
  JoinNode,
  LogicalQueryNode,
  QuerySource,
  ScanNode,
} from "@/lib/db/query/plan";
import type {
  SchemaColumnReference,
  SchemaObjectReference,
} from "@/lib/db/schema/types";

export interface ConditionalLookupKey {
  readonly name: string;
  readonly leftIndex: number;
  readonly rightIndex: number;
}

/** Freshly-derived proof metadata for one safe LEFT JOIN lookup rewrite. */
export interface PhysicalConditionalLookupChoice {
  readonly join: JoinNode;
  readonly tableName: string;
  readonly indexName: string;
  /** The actual generated-schema index prefix used by the original keys. */
  readonly keyColumns: readonly ConditionalLookupKey[];
  readonly selectedKey: ConditionalLookupKey;
  /** Original top-level residual conjuncts, preserved by identity and order. */
  readonly guardConjuncts: readonly Predicate[];
}

interface ColumnProof {
  readonly table: SchemaObjectReference;
  readonly column: SchemaColumnReference;
  readonly affinity: "integer";
  readonly collation: "BINARY";
}

interface EqualityPair {
  readonly expression: Extract<SqlExpression, { readonly kind: "binary" }>;
  readonly leftIndex: number;
  readonly rightIndex: number;
}

function foldSqlIdentifierAscii(value: string): string {
  let folded = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    folded +=
      code >= 0x41 && code <= 0x5a
        ? String.fromCharCode(code + 0x20)
        : value[index];
  }
  return folded;
}

function sameSqlIdentifier(left: string, right: string): boolean {
  return foldSqlIdentifierAscii(left) === foldSqlIdentifierAscii(right);
}

function sourceChildren(node: LogicalQueryNode): readonly QuerySource[] {
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

function scanColumn(scan: ScanNode, index: number): ColumnProof | undefined {
  const table = scan.table;
  const column = Object.values(table.columns)[index];
  const field = scan.fields[index];
  if (
    table.kind !== "table" ||
    table.defaultCollation !== "BINARY" ||
    !column ||
    !field ||
    column.kind !== "column" ||
    column.generated ||
    column.hidden !== 0 ||
    column.affinity !== "integer" ||
    field.affinity !== "integer" ||
    !sameSqlIdentifier(column.table, table.name)
  )
    return undefined;
  return { table, column, affinity: "integer", collation: "BINARY" };
}

function directInputColumn(
  expression: SqlExpression,
  input: QuerySource,
): number | undefined {
  return expression.kind === "column" &&
    expression.scope === input.scope &&
    Number.isSafeInteger(expression.index) &&
    expression.index >= 0 &&
    expression.index < input.fields.length &&
    expression.resultType.affinity === "integer" &&
    input.fields[expression.index]?.affinity === "integer"
    ? expression.index
    : undefined;
}

/** Prove that a key is the same INTEGER/BINARY table value on every path. */
function proveIntegerBinaryColumn(
  node: LogicalQueryNode,
  index: number,
  memo: Map<LogicalQueryNode, Map<number, ColumnProof | null>>,
  active: Map<LogicalQueryNode, Set<number>>,
): ColumnProof | undefined {
  if (!Number.isSafeInteger(index) || index < 0 || index >= node.fields.length)
    return undefined;
  const known = memo.get(node)?.get(index);
  if (known !== undefined) return known ?? undefined;
  let activeIndexes = active.get(node);
  if (activeIndexes?.has(index)) return undefined;
  if (!activeIndexes) {
    activeIndexes = new Set();
    active.set(node, activeIndexes);
  }
  activeIndexes.add(index);
  const field = node.fields[index];
  let proof: ColumnProof | undefined;
  if (field?.affinity === "integer") {
    switch (node.kind) {
      case "scan":
        proof = scanColumn(node, index);
        break;
      case "project": {
        const inputIndex = directInputColumn(
          node.projections[index]?.expression ?? constant(null),
          node.input,
        );
        if (inputIndex !== undefined)
          proof = proveIntegerBinaryColumn(
            node.input.node,
            inputIndex,
            memo,
            active,
          );
        break;
      }
      case "filter":
      case "sort":
      case "limit":
      case "distinct":
        if (node.input.fields[index]?.affinity === "integer")
          proof = proveIntegerBinaryColumn(
            node.input.node,
            index,
            memo,
            active,
          );
        break;
      case "join":
        if (index < node.left.fields.length) {
          if (node.left.fields[index]?.affinity === "integer")
            proof = proveIntegerBinaryColumn(
              node.left.node,
              index,
              memo,
              active,
            );
        } else {
          const rightIndex = index - node.left.fields.length;
          if (node.right.fields[rightIndex]?.affinity === "integer")
            proof = proveIntegerBinaryColumn(
              node.right.node,
              rightIndex,
              memo,
              active,
            );
        }
        break;
      case "semi-join":
      case "anti-join":
        if (node.left.fields[index]?.affinity === "integer")
          proof = proveIntegerBinaryColumn(node.left.node, index, memo, active);
        break;
      case "aggregate": {
        const inputIndex = directInputColumn(
          node.groups[index]?.expression ?? constant(null),
          node.input,
        );
        if (inputIndex !== undefined)
          proof = proveIntegerBinaryColumn(
            node.input.node,
            inputIndex,
            memo,
            active,
          );
        break;
      }
      case "window":
        if (
          index < node.input.fields.length &&
          node.input.fields[index]?.affinity === "integer"
        )
          proof = proveIntegerBinaryColumn(
            node.input.node,
            index,
            memo,
            active,
          );
        break;
      case "union": {
        const left = proveIntegerBinaryColumn(
          node.left.node,
          index,
          memo,
          active,
        );
        const right = proveIntegerBinaryColumn(
          node.right.node,
          index,
          memo,
          active,
        );
        if (left && right) proof = left;
        break;
      }
      case "recursive-closure": {
        const seed = proveIntegerBinaryColumn(
          node.seed.node,
          index,
          memo,
          active,
        );
        const candidates = proveIntegerBinaryColumn(
          node.candidates.node,
          index,
          memo,
          active,
        );
        if (seed && candidates) proof = seed;
        break;
      }
      case "values-relation":
      case "json-scalar-array":
        break;
    }
  }
  activeIndexes.delete(index);
  if (activeIndexes.size === 0) active.delete(node);
  let nodeMemo = memo.get(node);
  if (!nodeMemo) {
    nodeMemo = new Map();
    memo.set(node, nodeMemo);
  }
  nodeMemo.set(index, proof ?? null);
  return proof;
}

function primitiveBinding(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** A per-analysis proof that left-side values and guards are safe to move. */
class SafeLeftAnalysis {
  private readonly fieldMemo = new Map<
    LogicalQueryNode,
    Map<number, boolean>
  >();
  private readonly activeFields = new Map<LogicalQueryNode, Set<number>>();

  public constructor(private readonly left: QuerySource) {}

  public guard(conjuncts: readonly Predicate[]): boolean {
    return (
      conjuncts.length > 0 &&
      conjuncts.every((conjunct) => this.predicate(conjunct, this.left))
    );
  }

  private field(node: LogicalQueryNode, index: number): boolean {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= node.fields.length ||
      node.fields[index]?.affinity === "unknown"
    )
      return false;
    const known = this.fieldMemo.get(node)?.get(index);
    if (known !== undefined) return known;
    let active = this.activeFields.get(node);
    if (active?.has(index)) return false;
    if (!active) {
      active = new Set();
      this.activeFields.set(node, active);
    }
    active.add(index);
    let safe = false;
    switch (node.kind) {
      case "scan": {
        const table = node.table;
        const column = Object.values(table.columns)[index];
        safe =
          table.kind === "table" &&
          table.defaultCollation === "BINARY" &&
          !!column &&
          column.kind === "column" &&
          !column.generated &&
          column.hidden === 0 &&
          column.affinity === node.fields[index]?.affinity &&
          sameSqlIdentifier(column.table, table.name);
        break;
      }
      case "values-relation":
      case "json-scalar-array":
        safe = true;
        break;
      case "filter":
      case "sort":
      case "limit":
      case "distinct":
        safe =
          node.input.fields[index]?.affinity === node.fields[index]?.affinity &&
          this.field(node.input.node, index);
        break;
      case "project": {
        const expression = node.projections[index]?.expression;
        safe =
          !!expression &&
          expression.resultType.affinity === node.fields[index]?.affinity &&
          this.scalar(expression, node.input);
        break;
      }
      case "join":
        safe =
          index < node.left.fields.length
            ? node.left.fields[index]?.affinity ===
                node.fields[index]?.affinity &&
              this.field(node.left.node, index)
            : node.right.fields[index - node.left.fields.length]?.affinity ===
                node.fields[index]?.affinity &&
              this.field(node.right.node, index - node.left.fields.length);
        break;
      case "semi-join":
      case "anti-join":
        safe =
          node.left.fields[index]?.affinity === node.fields[index]?.affinity &&
          this.field(node.left.node, index);
        break;
      case "aggregate": {
        const expression = node.groups[index]?.expression;
        safe =
          expression?.kind === "column" &&
          expression.scope === node.input.scope &&
          expression.resultType.affinity === node.fields[index]?.affinity &&
          this.field(node.input.node, expression.index);
        break;
      }
      case "window":
        safe =
          index < node.input.fields.length &&
          node.input.fields[index]?.affinity === node.fields[index]?.affinity &&
          this.field(node.input.node, index);
        break;
      case "union":
        safe =
          node.left.fields[index]?.affinity === node.fields[index]?.affinity &&
          node.right.fields[index]?.affinity === node.fields[index]?.affinity &&
          this.field(node.left.node, index) &&
          this.field(node.right.node, index);
        break;
      case "recursive-closure":
        safe =
          node.seed.fields[index]?.affinity === node.fields[index]?.affinity &&
          node.candidates.fields[index]?.affinity ===
            node.fields[index]?.affinity &&
          this.field(node.seed.node, index) &&
          this.field(node.candidates.node, index);
        break;
    }
    active.delete(index);
    if (active.size === 0) this.activeFields.delete(node);
    let nodeMemo = this.fieldMemo.get(node);
    if (!nodeMemo) {
      nodeMemo = new Map();
      this.fieldMemo.set(node, nodeMemo);
    }
    nodeMemo.set(index, safe);
    return safe;
  }

  private scalar(expression: SqlExpression, source: QuerySource): boolean {
    switch (expression.kind) {
      case "column":
        return (
          expression.scope === source.scope &&
          expression.resultType.affinity ===
            source.fields[expression.index]?.affinity &&
          this.field(source.node, expression.index)
        );
      case "constant":
        return (
          expression.value === null ||
          (typeof expression.value === "string" &&
            !expression.value.includes("\0") &&
            wellFormed(expression.value)) ||
          (typeof expression.value === "number" &&
            Number.isFinite(expression.value))
        );
      case "parameter":
        return primitiveBinding(expression.value);
      case "binary":
        return (
          isComparison(expression.operator) &&
          this.scalar(expression.left, source) &&
          this.scalar(expression.right, source)
        );
      case "boolean":
        return expression.expressions.every((part) =>
          this.predicate(part, source),
        );
      case "not":
        return this.predicate(expression.expression, source);
      case "null-check":
        return this.scalar(expression.expression, source);
      case "in-list":
        return (
          expression.values.every(primitiveBinding) &&
          this.scalar(expression.expression, source)
        );
      case "case":
        return (
          expression.branches.length > 0 &&
          expression.branches.every(
            (branch) =>
              this.predicate(branch.when, source) &&
              this.scalar(branch.then, source),
          ) &&
          (expression.else === undefined ||
            this.scalar(expression.else, source))
        );
      case "coalesce":
        // COALESCE is an explicit safe-composition license: every child must
        // recursively satisfy this deterministic, non-throwing scalar
        // whitelist. Functions, casts, arithmetic, and subqueries remain
        // rejected even when nested under COALESCE.
        return expression.expressions.every((part) =>
          this.scalar(part, source),
        );
      case "distinct-from":
      case "cast-integer":
      case "cast-real":
      case "cast-text":
      case "text-position":
      case "text-substring":
      case "text-like":
      case "function":
      case "aggregate":
      case "unixepoch":
      case "scalar-subquery":
      case "in-subquery":
      case "excluded":
        return false;
    }
  }

  private predicate(expression: SqlExpression, source: QuerySource): boolean {
    if (expression.kind === "boolean" || expression.kind === "not")
      return this.scalar(expression, source);
    if (expression.kind === "null-check")
      return this.scalar(expression.expression, source);
    if (expression.kind === "in-list") return this.scalar(expression, source);
    return (
      expression.kind === "binary" &&
      isComparison(expression.operator) &&
      this.scalar(expression.left, source) &&
      this.scalar(expression.right, source)
    );
  }
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function isComparison(operator: string): boolean {
  return (
    operator === "=" ||
    operator === "<>" ||
    operator === "<" ||
    operator === "<=" ||
    operator === ">" ||
    operator === ">="
  );
}

function directEqualityPair(
  join: JoinNode,
  expression: SqlExpression,
): EqualityPair | undefined {
  if (expression.kind !== "binary" || expression.operator !== "=")
    return undefined;
  const { left, right } = expression;
  if (
    left.kind === "column" &&
    right.kind === "column" &&
    left.scope === join.left.scope &&
    right.scope === join.right.scope
  )
    return { expression, leftIndex: left.index, rightIndex: right.index };
  if (
    left.kind === "column" &&
    right.kind === "column" &&
    right.scope === join.left.scope &&
    left.scope === join.right.scope
  )
    return { expression, leftIndex: right.index, rightIndex: left.index };
  return undefined;
}

function flattenAnd(expression: SqlExpression): SqlExpression[] {
  if (expression.kind !== "boolean" || expression.operator !== "AND")
    return [expression];
  return expression.expressions.flatMap(flattenAnd);
}

function scanIndexKeys(
  join: JoinNode,
  scan: ScanNode,
  pairsByRightIndex: ReadonlyMap<number, EqualityPair>,
  proofMemo: Map<LogicalQueryNode, Map<number, ColumnProof | null>>,
  proofActive: Map<LogicalQueryNode, Set<number>>,
): readonly {
  readonly indexName: string;
  readonly keyColumns: readonly ConditionalLookupKey[];
}[] {
  if (scan.table.kind !== "table" || scan.table.defaultCollation !== "BINARY")
    return [];
  const columns = Object.values(scan.table.columns);
  return scan.table.indexes.flatMap((index) => {
    if (
      index.partial ||
      index.rawExpressionSql !== undefined ||
      !index.columns.length ||
      !index.collations ||
      index.collations.length !== index.columns.length
    )
      return [];
    const keyColumns: ConditionalLookupKey[] = [];
    const seenNames = new Set<string>();
    const seenLeft = new Set<number>();
    const seenRight = new Set<number>();
    for (let keyIndex = 0; keyIndex < index.columns.length; keyIndex++) {
      const name = index.columns[keyIndex];
      if (typeof name !== "string" || index.collations[keyIndex] !== "BINARY")
        break;
      const folded = foldSqlIdentifierAscii(name);
      if (seenNames.has(folded)) break;
      seenNames.add(folded);
      const schemaIndex = columns.findIndex((column) =>
        sameSqlIdentifier(column.sqlName, name),
      );
      const column = columns[schemaIndex];
      const pair = pairsByRightIndex.get(schemaIndex);
      if (
        schemaIndex < 0 ||
        !column ||
        column.generated ||
        column.hidden !== 0 ||
        column.affinity !== "integer" ||
        !pair ||
        seenLeft.has(pair.leftIndex) ||
        seenRight.has(pair.rightIndex)
      )
        break;
      const leftProof = proveIntegerBinaryColumn(
        join.left.node,
        pair.leftIndex,
        proofMemo,
        proofActive,
      );
      const rightProof = scanColumn(scan, schemaIndex);
      if (
        !leftProof ||
        !rightProof ||
        leftProof.affinity !== rightProof.affinity ||
        leftProof.collation !== rightProof.collation
      )
        break;
      seenLeft.add(pair.leftIndex);
      seenRight.add(pair.rightIndex);
      keyColumns.push({
        name,
        leftIndex: pair.leftIndex,
        rightIndex: pair.rightIndex,
      });
    }
    return keyColumns.length === 0
      ? []
      : [{ indexName: index.name, keyColumns }];
  });
}

function sameCandidateOrder(
  left: { indexName: string; keyColumns: readonly ConditionalLookupKey[] },
  right: { indexName: string; keyColumns: readonly ConditionalLookupKey[] },
): number {
  return (
    right.keyColumns.length - left.keyColumns.length ||
    (foldSqlIdentifierAscii(left.indexName) <
    foldSqlIdentifierAscii(right.indexName)
      ? -1
      : foldSqlIdentifierAscii(left.indexName) >
          foldSqlIdentifierAscii(right.indexName)
        ? 1
        : 0) ||
    (left.indexName < right.indexName
      ? -1
      : left.indexName > right.indexName
        ? 1
        : 0)
  );
}

function conditionalLookupForJoin(
  join: JoinNode,
): PhysicalConditionalLookupChoice | undefined {
  if (join.joinType !== "left" || join.right.node.kind !== "scan")
    return undefined;
  const scan = join.right.node;
  if (scan.table.kind !== "table") return undefined;
  const conjuncts = flattenAnd(join.condition);
  const pairs: EqualityPair[] = [];
  const guardConjuncts: Predicate[] = [];
  const usedLeft = new Set<number>();
  const usedRight = new Set<number>();
  for (const conjunct of conjuncts) {
    const pair = directEqualityPair(join, conjunct);
    if (!pair) {
      guardConjuncts.push(conjunct as Predicate);
      continue;
    }
    if (
      pair.leftIndex < 0 ||
      pair.leftIndex >= join.left.fields.length ||
      pair.rightIndex < 0 ||
      pair.rightIndex >= join.right.fields.length ||
      usedLeft.has(pair.leftIndex) ||
      usedRight.has(pair.rightIndex)
    )
      return undefined;
    usedLeft.add(pair.leftIndex);
    usedRight.add(pair.rightIndex);
    pairs.push(pair);
  }
  if (
    pairs.length === 0 ||
    guardConjuncts.length === 0 ||
    !new SafeLeftAnalysis(join.left).guard(guardConjuncts)
  )
    return undefined;
  const proofMemo = new Map<
    LogicalQueryNode,
    Map<number, ColumnProof | null>
  >();
  const proofActive = new Map<LogicalQueryNode, Set<number>>();
  for (const pair of pairs) {
    const leftProof = proveIntegerBinaryColumn(
      join.left.node,
      pair.leftIndex,
      proofMemo,
      proofActive,
    );
    const rightProof = scanColumn(scan, pair.rightIndex);
    if (
      !leftProof ||
      !rightProof ||
      leftProof.affinity !== rightProof.affinity ||
      leftProof.collation !== rightProof.collation
    )
      return undefined;
  }
  const pairsByRightIndex = new Map(
    pairs.map((pair) => [pair.rightIndex, pair] as const),
  );
  const indexes = [
    ...scanIndexKeys(join, scan, pairsByRightIndex, proofMemo, proofActive),
  ].sort(sameCandidateOrder);
  const selectedIndex = indexes[0];
  if (!selectedIndex) return undefined;
  const selectedKey = selectedIndex.keyColumns[0];
  if (!selectedKey) return undefined;
  return {
    join,
    tableName: scan.table.name,
    indexName: selectedIndex.indexName,
    keyColumns: selectedIndex.keyColumns,
    selectedKey,
    guardConjuncts,
  };
}

export function analyzeConditionalLookupChoices(
  root: LogicalQueryNode,
): readonly PhysicalConditionalLookupChoice[] {
  const choices: PhysicalConditionalLookupChoice[] = [];
  const visited = new Set<LogicalQueryNode>();
  const visitedExpressions = new Set<SqlExpression>();
  const visitSource = (source: QuerySource): void => visit(source.node);
  const visitExpression = (expression: SqlExpression): void => {
    if (visitedExpressions.has(expression)) return;
    visitedExpressions.add(expression);
    switch (expression.kind) {
      case "binary":
      case "distinct-from":
        visitExpression(expression.left);
        visitExpression(expression.right);
        break;
      case "boolean":
        expression.expressions.forEach(visitExpression);
        break;
      case "not":
      case "null-check":
      case "cast-integer":
      case "cast-real":
      case "cast-text":
        visitExpression(expression.expression);
        break;
      case "text-position":
        visitExpression(expression.text);
        visitExpression(expression.needle);
        break;
      case "text-substring":
        visitExpression(expression.text);
        visitExpression(expression.start);
        if (expression.length) visitExpression(expression.length);
        break;
      case "text-like":
        visitExpression(expression.text);
        visitExpression(expression.pattern);
        break;
      case "in-list":
        visitExpression(expression.expression);
        break;
      case "in-subquery":
        visitExpression(expression.expression);
        visitSource(expression.query);
        break;
      case "function":
        expression.arguments.forEach(visitExpression);
        break;
      case "aggregate":
        if (expression.expression) visitExpression(expression.expression);
        break;
      case "coalesce":
        expression.expressions.forEach(visitExpression);
        break;
      case "case":
        expression.branches.forEach((branch) => {
          visitExpression(branch.when);
          visitExpression(branch.then);
        });
        if (expression.else) visitExpression(expression.else);
        break;
      case "scalar-subquery":
        visitSource(expression.query);
        break;
      case "column":
      case "parameter":
      case "excluded":
      case "unixepoch":
      case "constant":
        break;
    }
  };
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const child of sourceChildren(node)) visit(child.node);
    for (const expression of nodeExpressions(node)) visitExpression(expression);
    if (node.kind === "join") {
      const choice = conditionalLookupForJoin(node);
      if (choice) choices.push(choice);
    }
  };
  visit(root);
  return choices;
}

export function sameConditionalLookupChoices(
  actual: readonly PhysicalConditionalLookupChoice[],
  expected: readonly PhysicalConditionalLookupChoice[],
): boolean {
  return (
    actual.length === expected.length &&
    denseArray(actual) &&
    actual.every((choice, index) => {
      const canonical = expected[index];
      return (
        !!canonical &&
        !!choice &&
        typeof choice === "object" &&
        exactOwnKeys(choice, [
          "guardConjuncts",
          "indexName",
          "join",
          "keyColumns",
          "selectedKey",
          "tableName",
        ]) &&
        denseArray(choice.keyColumns) &&
        denseArray(choice.guardConjuncts) &&
        !!choice.selectedKey &&
        typeof choice.selectedKey === "object" &&
        exactOwnKeys(choice.selectedKey, ["leftIndex", "name", "rightIndex"]) &&
        choice.join === canonical.join &&
        choice.tableName === canonical.tableName &&
        choice.indexName === canonical.indexName &&
        sameKeyColumns(choice.keyColumns, canonical.keyColumns) &&
        sameKeyColumns([choice.selectedKey], [canonical.selectedKey]) &&
        choice.guardConjuncts.length === canonical.guardConjuncts.length &&
        choice.guardConjuncts.every(
          (conjunct, conjunctIndex) =>
            conjunct === canonical.guardConjuncts[conjunctIndex],
        )
      );
    })
  );
}

function exactOwnKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key))
  );
}

function denseArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++)
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  return true;
}

function sameKeyColumns(
  actual: readonly ConditionalLookupKey[],
  expected: readonly ConditionalLookupKey[],
): boolean {
  return (
    actual.length === expected.length &&
    denseArray(actual) &&
    actual.every((key, index) => {
      const canonical = expected[index];
      return (
        !!canonical &&
        !!key &&
        typeof key === "object" &&
        exactOwnKeys(key, ["leftIndex", "name", "rightIndex"]) &&
        key.name === canonical.name &&
        key.leftIndex === canonical.leftIndex &&
        key.rightIndex === canonical.rightIndex
      );
    })
  );
}

function directPairFromConjunct(
  join: JoinNode,
  expression: SqlExpression,
): EqualityPair | undefined {
  return directEqualityPair(join, expression);
}

/** Build a temporary typed ON condition without changing the Generic Join. */
export function compileConditionalLookupCondition(
  choice: PhysicalConditionalLookupChoice,
): Predicate {
  const join = choice.join;
  const conjuncts = flattenAnd(join.condition);
  const guardSet = new Set<SqlExpression>(choice.guardConjuncts);
  const guard =
    choice.guardConjuncts.length === 1
      ? choice.guardConjuncts[0]!
      : and(choice.guardConjuncts[0]!, ...choice.guardConjuncts.slice(1));
  const rewritten: Predicate[] = [];
  let replaced = false;
  for (const conjunct of conjuncts) {
    if (guardSet.has(conjunct)) continue;
    const pair = directPairFromConjunct(join, conjunct);
    if (
      !replaced &&
      pair?.leftIndex === choice.selectedKey.leftIndex &&
      pair.rightIndex === choice.selectedKey.rightIndex
    ) {
      const expression = pair.expression;
      const leftColumn =
        expression.left.kind === "column" &&
        expression.left.scope === join.left.scope
          ? expression.left
          : expression.right;
      const rightColumn =
        expression.left.kind === "column" &&
        expression.left.scope === join.right.scope
          ? expression.left
          : expression.right;
      const guardedKey = caseWhen(
        [{ when: guard, then: leftColumn as AnyExpression }],
        constant(null),
      );
      // SQLite CASE has no column affinity, so its comparison with the
      // untouched INTEGER-affinity RHS applies NUMERIC affinity to the CASE
      // value. The original left column's INTEGER affinity already normalized
      // values when they were stored: numeric values remain numeric, while
      // nonnumeric TEXT, BLOB, and NULL remain unchanged. Applying NUMERIC
      // affinity again preserves those stored values and their equality
      // behavior, without adding a CAST.
      rewritten.push(
        (leftColumn === expression.left
          ? eq(guardedKey, rightColumn as AnyExpression)
          : eq(rightColumn as AnyExpression, guardedKey)) as Predicate,
      );
      replaced = true;
    } else {
      rewritten.push(conjunct as Predicate);
    }
  }
  if (!replaced || rewritten.length === 0)
    throw new Error(
      "Validated conditional lookup metadata did not match its Join",
    );
  return rewritten.length === 1
    ? rewritten[0]!
    : and(rewritten[0]!, ...rewritten.slice(1));
}
