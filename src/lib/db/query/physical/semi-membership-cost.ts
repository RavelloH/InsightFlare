import type { SqlExpression } from "@/lib/db/query/expression";
import type {
  LogicalQueryNode,
  OutputField,
  QuerySource,
  ScanNode,
} from "@/lib/db/query/plan";
import type {
  SchemaColumnReference,
  SchemaIndexReference,
} from "@/lib/db/schema/types";

import type { PhysicalSemiMembershipChoice } from "./semi-membership";

export type SemiMembershipCostReason =
  | "selected-materialized-right-membership"
  | "anti-source-is-not-materialized"
  | "selected-unique-right-point-lookup-with-left-index"
  | "right-source-has-no-unique-point-lookup-proof"
  | "left-source-is-not-an-unfiltered-catalog-scan"
  | "left-membership-key-has-no-proven-index-access";

export interface SemiMembershipRightLookupEvidence {
  readonly tableName: string;
  readonly columnName: string;
  readonly access: "rowid" | "unique-index";
  readonly indexName?: string;
  readonly constraint: "parameter" | "constant";
  readonly valueClass: "text" | "integer" | "real";
}

export interface SemiMembershipLeftAccessEvidence {
  readonly tableName: string;
  readonly access: "rowid" | "binary-index";
  readonly indexName?: string;
  readonly keyColumns: readonly string[];
}

export interface SemiMembershipCostEvidence {
  readonly right: SemiMembershipRightLookupEvidence;
  readonly left: SemiMembershipLeftAccessEvidence;
}

/**
 * Cost strategy for a semantically safe membership candidate. `choice` is
 * still the independently recomputed domain/totality proof. This layer only
 * selects IN for an already materialized right relation (build its membership
 * index once), or when both catalog access paths have explicit schema evidence.
 */
export interface PhysicalSemiMembershipCostSelection {
  readonly choice: PhysicalSemiMembershipChoice;
  readonly strategy: "in" | "exists";
  readonly reason: SemiMembershipCostReason;
  readonly evidence?: SemiMembershipCostEvidence;
}

interface TracedScan {
  readonly scan: ScanNode;
  /** Root-source output indexes mapped to scan output indexes. */
  readonly outputToScan: readonly number[];
  readonly filters: readonly {
    readonly predicate: SqlExpression;
    readonly input: QuerySource;
  }[];
}

interface ScanColumn {
  readonly propertyName: string;
  readonly column: SchemaColumnReference;
}

interface UniquePointLookup {
  readonly column: ScanColumn;
  readonly access: "rowid" | "unique-index";
  readonly indexName?: string;
  readonly constraint: "parameter" | "constant";
  readonly valueClass: "text" | "integer" | "real";
}

const TOTAL_COMPARISON_OPERATORS = new Set(["=", "<>", ">", ">=", "<", "<="]);

function sameField(
  left: OutputField | undefined,
  right: OutputField | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.name === right.name &&
    left.affinity === right.affinity &&
    left.nullable === right.nullable,
  );
}

function exactScanColumn(
  scan: ScanNode,
  index: number,
): ScanColumn | undefined {
  if (scan.table.kind !== "table") return undefined;
  const [propertyName, column] =
    Object.entries(scan.table.columns)[index] ?? [];
  const field = scan.fields[index];
  if (
    !propertyName ||
    !column ||
    !field ||
    column.kind !== "column" ||
    column.table !== scan.table.name ||
    column.propertyName !== propertyName ||
    column.hidden !== 0 ||
    column.generated ||
    field.name !== propertyName ||
    field.affinity !== column.affinity ||
    field.nullable !== column.nullable
  )
    return undefined;
  return { propertyName, column };
}

function directInputIndex(
  expression: SqlExpression,
  input: QuerySource,
): number | undefined {
  if (
    expression.kind !== "column" ||
    expression.scope !== input.scope ||
    !Number.isSafeInteger(expression.index) ||
    expression.index < 0 ||
    expression.index >= input.fields.length
  )
    return undefined;
  const field = input.fields[expression.index];
  return field &&
    expression.name === field.name &&
    expression.resultType.affinity === field.affinity &&
    expression.resultType.nullable === field.nullable
    ? expression.index
    : undefined;
}

function safeScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function safeTerm(expression: SqlExpression, input: QuerySource): boolean {
  if (expression.kind === "column")
    return directInputIndex(expression, input) !== undefined;
  if (expression.kind !== "parameter" && expression.kind !== "constant")
    return false;
  const value = expression.value;
  if (!safeScalar(value)) return false;
  if (value === null) return expression.resultType.nullable;
  if (typeof value === "string")
    return (
      expression.resultType.affinity === "text" &&
      !expression.resultType.nullable
    );
  if (typeof value === "boolean")
    return (
      expression.resultType.affinity === "integer" &&
      !expression.resultType.nullable
    );
  return (
    (expression.resultType.affinity === "numeric" ||
      expression.resultType.affinity === "integer" ||
      expression.resultType.affinity === "real") &&
    !expression.resultType.nullable
  );
}

function safeTotalFilter(
  expression: SqlExpression,
  input: QuerySource,
): boolean {
  if (expression.kind === "boolean")
    return (
      expression.operator === "AND" &&
      expression.expressions.length > 0 &&
      expression.expressions.every((child) => safeTotalFilter(child, input))
    );
  if (expression.kind === "binary")
    return (
      TOTAL_COMPARISON_OPERATORS.has(expression.operator) &&
      safeTerm(expression.left, input) &&
      safeTerm(expression.right, input)
    );
  if (expression.kind === "null-check")
    return (
      expression.expression.kind === "column" &&
      directInputIndex(expression.expression, input) !== undefined
    );
  if (expression.kind === "in-list")
    return (
      expression.expression.kind === "column" &&
      directInputIndex(expression.expression, input) !== undefined &&
      Array.isArray(expression.values) &&
      Reflect.ownKeys(expression.values).length ===
        expression.values.length + 1 &&
      expression.values.every(
        (value, index) =>
          Object.hasOwn(expression.values, index) && safeScalar(value),
      )
    );
  return false;
}

function traceCatalogScan(
  source: QuerySource,
  allowFilters: boolean,
): TracedScan | undefined {
  let current = source;
  let outputToScan = current.fields.map((_field, index) => index);
  const visited = new Set<LogicalQueryNode>();
  const filters: { predicate: SqlExpression; input: QuerySource }[] = [];

  while (current.node.kind === "project" || current.node.kind === "filter") {
    const node = current.node;
    if (visited.has(node) || current.scope !== node.scope) return undefined;
    visited.add(node);
    if (node.kind === "project") {
      if (
        node.projections.length !== current.fields.length ||
        node.projections.length === 0
      )
        return undefined;
      const currentToInput: number[] = [];
      for (let index = 0; index < node.projections.length; index++) {
        const projection = node.projections[index];
        const expression = projection?.expression;
        if (!projection || !expression) return undefined;
        const inputIndex = directInputIndex(expression, node.input);
        const outputField = current.fields[index];
        if (
          inputIndex === undefined ||
          !outputField ||
          outputField.name !== projection.name ||
          outputField.affinity !== expression.resultType.affinity ||
          outputField.nullable !== expression.resultType.nullable
        )
          return undefined;
        currentToInput.push(inputIndex);
      }
      // Compose root -> current with current -> input. Reversing this
      // composition can turn a non-unique predicate into a claimed lookup.
      const next: number[] = [];
      for (const currentIndex of outputToScan) {
        const inputIndex = currentToInput[currentIndex];
        if (inputIndex === undefined) return undefined;
        next.push(inputIndex);
      }
      outputToScan = next;
      current = node.input;
      continue;
    }

    if (
      !allowFilters ||
      current.fields.length !== node.input.fields.length ||
      !current.fields.every((field, index) =>
        sameField(field, node.input.fields[index]),
      ) ||
      !safeTotalFilter(node.predicate, node.input)
    )
      return undefined;
    filters.push({ predicate: node.predicate, input: node.input });
    current = node.input;
  }

  const scan = current.node;
  if (
    scan.kind !== "scan" ||
    current.scope !== scan.scope ||
    current.fields.length !== scan.fields.length ||
    !current.fields.every((field, index) =>
      sameField(field, scan.fields[index]),
    ) ||
    outputToScan.length !== source.fields.length ||
    outputToScan.some((index) => !exactScanColumn(scan, index))
  )
    return undefined;

  return { scan, outputToScan, filters };
}

function scalarLookupClass(
  expression: Extract<
    SqlExpression,
    { readonly kind: "parameter" | "constant" }
  >,
  column: SchemaColumnReference,
): "text" | "integer" | "real" | undefined {
  const value = expression.value;
  if (value === null || !safeScalar(value)) return undefined;
  if (typeof value === "string")
    return column.affinity === "text" &&
      expression.resultType.affinity === "text" &&
      !expression.resultType.nullable
      ? "text"
      : undefined;
  if (typeof value === "boolean")
    return column.affinity === "integer" &&
      expression.resultType.affinity === "integer" &&
      !expression.resultType.nullable
      ? "integer"
      : undefined;
  if (!Number.isSafeInteger(value)) return undefined;
  if (
    column.affinity === "integer" &&
    (expression.resultType.affinity === "numeric" ||
      expression.resultType.affinity === "integer") &&
    !expression.resultType.nullable
  )
    return "integer";
  if (
    column.affinity === "real" &&
    (expression.resultType.affinity === "numeric" ||
      expression.resultType.affinity === "real") &&
    !expression.resultType.nullable
  )
    return "real";
  return undefined;
}

function uniqueAccess(
  scan: ScanNode,
  resolved: ScanColumn,
  valueClass: "text" | "integer" | "real",
):
  | { readonly access: "rowid" | "unique-index"; readonly indexName?: string }
  | undefined {
  const table = scan.table;
  const column = resolved.column;
  if (
    column.rowidAlias === true &&
    column.declaredType.trim().toUpperCase() === "INTEGER" &&
    column.affinity === "integer" &&
    column.primaryKeyPosition === 1 &&
    table.primaryKey.length === 1 &&
    table.primaryKey[0] === column.sqlName &&
    !column.nullable &&
    valueClass === "integer"
  )
    return { access: "rowid" };

  if (table.defaultCollation !== "BINARY") return undefined;
  const index = table.indexes.find(
    (candidate: SchemaIndexReference) =>
      candidate.unique &&
      !candidate.partial &&
      candidate.rawExpressionSql === undefined &&
      candidate.columns.length === 1 &&
      candidate.columns[0] === resolved.column.sqlName &&
      candidate.collations?.length === 1 &&
      candidate.collations[0] === "BINARY",
  );
  return index ? { access: "unique-index", indexName: index.name } : undefined;
}

function findUniquePointLookup(
  source: QuerySource,
): UniquePointLookup | undefined {
  const traced = traceCatalogScan(source, true);
  if (!traced || traced.filters.length === 0) return undefined;

  const inspect = (
    expression: SqlExpression,
    input: QuerySource,
  ): UniquePointLookup | undefined => {
    if (expression.kind === "boolean" && expression.operator === "AND") {
      for (const child of expression.expressions) {
        const found = inspect(child, input);
        if (found) return found;
      }
      return undefined;
    }
    if (expression.kind !== "binary" || expression.operator !== "=")
      return undefined;
    for (const [columnExpression, scalarExpression] of [
      [expression.left, expression.right],
      [expression.right, expression.left],
    ] as const) {
      const outputIndex = directInputIndex(columnExpression, input);
      if (
        outputIndex === undefined ||
        (scalarExpression.kind !== "parameter" &&
          scalarExpression.kind !== "constant")
      )
        continue;
      const inputTrace = traceCatalogScan(input, true);
      if (!inputTrace || inputTrace.scan !== traced.scan) continue;
      const scanIndex = inputTrace.outputToScan[outputIndex];
      if (scanIndex === undefined) continue;
      const resolved = exactScanColumn(inputTrace.scan, scanIndex);
      if (!resolved) continue;
      const valueClass = scalarLookupClass(scalarExpression, resolved.column);
      if (!valueClass) continue;
      const access = uniqueAccess(inputTrace.scan, resolved, valueClass);
      if (!access) continue;
      return {
        column: resolved,
        access: access.access,
        ...(access.indexName === undefined
          ? {}
          : { indexName: access.indexName }),
        constraint: scalarExpression.kind,
        valueClass,
      };
    }
    return undefined;
  };

  for (const filter of traced.filters) {
    const found = inspect(filter.predicate, filter.input);
    if (found) return found;
  }
  return undefined;
}

function rowidAlias(
  scan: ScanNode,
  columnIndex: number,
): ScanColumn | undefined {
  const resolved = exactScanColumn(scan, columnIndex);
  const column = resolved?.column;
  return column?.rowidAlias === true &&
    column.declaredType.trim().toUpperCase() === "INTEGER" &&
    column.affinity === "integer" &&
    column.primaryKeyPosition === 1 &&
    scan.table.primaryKey.length === 1 &&
    scan.table.primaryKey[0] === column.sqlName &&
    !column.nullable
    ? resolved
    : undefined;
}

function leftAccess(
  choice: PhysicalSemiMembershipChoice,
): SemiMembershipLeftAccessEvidence | undefined {
  const traced = traceCatalogScan(choice.left, false);
  if (!traced) return undefined;
  const scan = traced.scan;
  const keyColumns = choice.leftKeyIndexes.map((outputIndex) => {
    const scanIndex = traced.outputToScan[outputIndex];
    return scanIndex === undefined
      ? undefined
      : exactScanColumn(scan, scanIndex);
  });
  if (keyColumns.length === 0 || keyColumns.some((column) => !column))
    return undefined;
  const sqlNames = keyColumns.map((column) => column!.column.sqlName);

  if (sqlNames.length === 1) {
    const scanIndex = traced.outputToScan[choice.leftKeyIndexes[0]!];
    if (scanIndex !== undefined && rowidAlias(scan, scanIndex))
      return {
        tableName: scan.table.name,
        access: "rowid",
        keyColumns: sqlNames,
      };
  }

  if (scan.table.defaultCollation !== "BINARY") return undefined;
  const index = scan.table.indexes.find(
    (candidate: SchemaIndexReference) =>
      !candidate.partial &&
      candidate.rawExpressionSql === undefined &&
      candidate.columns.length >= sqlNames.length &&
      sqlNames.every((name, index) => candidate.columns[index] === name) &&
      candidate.collations?.length === candidate.columns.length &&
      sqlNames.every(
        (_name, index) => candidate.collations?.[index] === "BINARY",
      ),
  );
  return index
    ? {
        tableName: scan.table.name,
        access: "binary-index",
        indexName: index.name,
        keyColumns: sqlNames,
      }
    : undefined;
}

function selectSemiMembershipCost(
  choice: PhysicalSemiMembershipChoice,
): PhysicalSemiMembershipCostSelection {
  // A materialized relation has no catalog index on its exported columns.
  // EXISTS can therefore rescan it for every left row. IN builds the lookup
  // once, also through total filters/projections over that current boundary.
  let rightNode = choice.right.node;
  const visited = new Set<LogicalQueryNode>();
  while (!visited.has(rightNode)) {
    visited.add(rightNode);
    if (choice.materializedStops.includes(rightNode))
      return {
        choice,
        strategy: "in",
        reason: "selected-materialized-right-membership",
      };
    if (rightNode.kind !== "project" && rightNode.kind !== "filter") break;
    rightNode = rightNode.input.node;
  }
  // Anti membership has measured benefit for a materialized set. Keep the
  // existing NOT EXISTS access path for other sources until separately costed.
  if (choice.node.kind === "anti-join")
    return {
      choice,
      strategy: "exists",
      reason: "anti-source-is-not-materialized",
    };
  const right = findUniquePointLookup(choice.right);
  if (!right)
    return {
      choice,
      strategy: "exists",
      reason: "right-source-has-no-unique-point-lookup-proof",
    };
  const left = leftAccess(choice);
  if (!left) {
    const leftTrace = traceCatalogScan(choice.left, true);
    return {
      choice,
      strategy: "exists",
      reason:
        !leftTrace || leftTrace.filters.length > 0
          ? "left-source-is-not-an-unfiltered-catalog-scan"
          : "left-membership-key-has-no-proven-index-access",
    };
  }
  return {
    choice,
    strategy: "in",
    reason: "selected-unique-right-point-lookup-with-left-index",
    evidence: {
      right: {
        tableName: traceCatalogScan(choice.right, true)!.scan.table.name,
        columnName: right.column.column.sqlName,
        access: right.access,
        ...(right.indexName === undefined
          ? {}
          : { indexName: right.indexName }),
        constraint: right.constraint,
        valueClass: right.valueClass,
      },
      left,
    },
  };
}

export function semiMembershipCostSelections(
  choices: readonly PhysicalSemiMembershipChoice[],
): readonly PhysicalSemiMembershipCostSelection[] {
  return choices.map(selectSemiMembershipCost);
}

function denseValues(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value))
    return undefined;
  if (Reflect.ownKeys(value).length !== length.value + 1) return undefined;
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !("value" in descriptor)) return undefined;
    result.push(descriptor.value);
  }
  return result;
}

function ownData(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function hasExactOwnDataKeys(
  value: object,
  expected: readonly string[],
): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string")
  )
    return false;
  const actual = (keys as string[]).sort();
  const wanted = [...expected].sort();
  return actual.every(
    (key, index) =>
      key === wanted[index] &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"),
  );
}

function stableEvidenceJson(value: unknown): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number")
    return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const values = denseValues(value);
    if (!values) return undefined;
    const children = values.map(stableEvidenceJson);
    return children.some((child) => child === undefined)
      ? undefined
      : `[${children.join(",")}]`;
  }
  if (!value || typeof value !== "object") return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const entries: [string, string][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    const encoded = stableEvidenceJson(descriptor.value);
    if (encoded === undefined) return undefined;
    entries.push([key, encoded]);
  }
  entries.sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, encoded]) => `${JSON.stringify(key)}:${encoded}`).join(",")}}`;
}

export function sameSemiMembershipCostSelections(
  actual: unknown,
  expected: readonly PhysicalSemiMembershipCostSelection[],
  sameChoices: (
    actual: unknown,
    expected: readonly PhysicalSemiMembershipChoice[],
  ) => boolean,
): boolean {
  const actualValues = denseValues(actual);
  if (!actualValues || actualValues.length !== expected.length) return false;
  const actualChoices: unknown[] = [];
  for (const value of actualValues) {
    if (!value || typeof value !== "object") return false;
    actualChoices.push(ownData(value, "choice"));
  }
  if (
    !sameChoices(
      actualChoices,
      expected.map(({ choice }) => choice),
    )
  )
    return false;
  return actualValues.every((value, index) => {
    const canonical = expected[index];
    if (!canonical || !value || typeof value !== "object") return false;
    if (
      !hasExactOwnDataKeys(
        value,
        canonical.evidence === undefined
          ? ["choice", "strategy", "reason"]
          : ["choice", "strategy", "reason", "evidence"],
      )
    )
      return false;
    if (
      ownData(value, "strategy") !== canonical.strategy ||
      ownData(value, "reason") !== canonical.reason
    )
      return false;
    const evidence = ownData(value, "evidence");
    const expectedEvidence = canonical.evidence;
    if (evidence === undefined || expectedEvidence === undefined)
      return evidence === undefined && expectedEvidence === undefined;
    const actualJson = stableEvidenceJson(evidence);
    const expectedJson = stableEvidenceJson(expectedEvidence);
    return actualJson !== undefined && actualJson === expectedJson;
  });
}
