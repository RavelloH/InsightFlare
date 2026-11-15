import type { SqlExpression } from "@/lib/db/query/expression";
import {
  isMaterializationSafeExpression,
  isMaterializationSafeNode,
  isOrderStableSumExpression,
} from "@/lib/db/query/materialization-safety";
import type {
  AggregateNode,
  LogicalQueryNode,
  QuerySource,
} from "@/lib/db/query/plan";
import { analyzeRelationalKeyFacts } from "@/lib/db/query/relational-key-facts";

import {
  isTextComparisonStorageClass,
  semiMembershipBinaryCollation,
  semiMembershipComparisonDomain,
} from "./comparison-domains";

interface Edge {
  readonly parent: LogicalQueryNode;
  readonly expression: boolean;
}

function children(node: LogicalQueryNode): readonly QuerySource[] {
  if ("input" in node) return [node.input];
  if ("left" in node) return [node.left, node.right];
  if (node.kind === "recursive-closure") return [node.seed, node.candidates];
  return [];
}

function expressions(node: LogicalQueryNode): readonly SqlExpression[] {
  switch (node.kind) {
    case "project":
      return node.projections.map(({ expression }) => expression);
    case "filter":
    case "recursive-closure":
      return [node.predicate];
    case "join":
    case "semi-join":
    case "anti-join":
      return [node.condition];
    case "aggregate":
      return [...node.groups, ...node.aggregates].map(
        ({ expression }) => expression,
      );
    case "sort":
      return node.keys.map(({ expression }) => expression);
    case "limit":
      return [node.count, ...(node.offset ? [node.offset] : [])];
    case "window":
      return node.windows.flatMap(({ specification }) => [
        ...specification.partitionBy,
        ...(specification.kind === "row-number"
          ? specification.orderBy.map(({ expression }) => expression)
          : []),
      ]);
    default:
      return [];
  }
}

function expressionChildren(
  expression: SqlExpression,
): readonly SqlExpression[] {
  switch (expression.kind) {
    case "binary":
    case "distinct-from":
      return [expression.left, expression.right];
    case "boolean":
    case "coalesce":
      return expression.expressions;
    case "not":
    case "null-check":
    case "cast-integer":
    case "cast-real":
    case "cast-text":
      return [expression.expression];
    case "function":
      return expression.arguments;
    case "aggregate":
      return expression.expression ? [expression.expression] : [];
    case "case":
      return [
        ...expression.branches.flatMap(({ when, then }) => [when, then]),
        ...(expression.else ? [expression.else] : []),
      ];
    case "text-position":
      return [expression.text, expression.needle];
    case "text-substring":
      return [
        expression.text,
        expression.start,
        ...(expression.length ? [expression.length] : []),
      ];
    case "text-like":
      return [expression.text, expression.pattern];
    case "in-list":
    case "in-subquery":
      return [expression.expression];
    default:
      return [];
  }
}

function parentIndex(root: LogicalQueryNode): Map<LogicalQueryNode, Edge[]> {
  const parents = new Map<LogicalQueryNode, Edge[]>();
  const visited = new Set<LogicalQueryNode>();
  const edge = (
    child: LogicalQueryNode,
    parent: LogicalQueryNode,
    expression: boolean,
  ) => {
    const incoming = parents.get(child) ?? [];
    incoming.push({ parent, expression });
    parents.set(child, incoming);
    visit(child);
  };
  const visitExpression = (
    expression: SqlExpression,
    parent: LogicalQueryNode,
  ): void => {
    if (
      expression.kind === "scalar-subquery" ||
      expression.kind === "in-subquery"
    )
      edge(expression.query.node, parent, true);
    expressionChildren(expression).forEach((child) =>
      visitExpression(child, parent),
    );
  };
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    children(node).forEach((child) => edge(child.node, node, false));
    expressions(node).forEach((expression) =>
      visitExpression(expression, node),
    );
  };
  visit(root);
  return parents;
}

function total(expression: SqlExpression, input: QuerySource): boolean {
  return isMaterializationSafeExpression(
    expression,
    new Map([[input.scope, input.fields.length]]),
  );
}

function stableDistinctInput(input: QuerySource): boolean {
  if (
    input.fields.every((_field, index) => stableField(input, index, new Set()))
  )
    return true;
  // A surviving, non-null stable key proves every complete row already unique.
  // Do not infer storage from a raw INTEGER key or uniqueness from affinity.
  const facts = analyzeRelationalKeyFacts(input);
  return facts.keys.some(
    (key) =>
      key.requiredNonNull.every((index) => facts.nonNullFields.has(index)) &&
      key.fields.every((index) => stableField(input, index, new Set())),
  );
}

function rejectsNull(
  expression: SqlExpression,
  input: QuerySource,
  index: number,
): boolean {
  const direct = (value: SqlExpression) =>
    value.kind === "column" &&
    value.scope === input.scope &&
    value.index === index;
  if (
    expression.kind === "binary" &&
    ["=", "<>", "<", "<=", ">", ">="].includes(expression.operator)
  )
    return direct(expression.left) || direct(expression.right);
  if (expression.kind === "null-check")
    return expression.not && direct(expression.expression);
  if (expression.kind === "boolean")
    return expression.operator === "AND"
      ? expression.expressions.some((child) => rejectsNull(child, input, index))
      : expression.expressions.length > 0 &&
          expression.expressions.every((child) =>
            rejectsNull(child, input, index),
          );
  return false;
}

/** A nullable unique catalog key is sufficient only when every path discards
 * its NULL rows before any observer. A preserved LEFT input is not such a guard. */
function nullRepresentativesDiscarded(
  node: LogicalQueryNode,
  missing: ReadonlySet<number>,
  root: LogicalQueryNode,
  parents: ReadonlyMap<LogicalQueryNode, readonly Edge[]>,
  active = new Set<LogicalQueryNode>(),
): boolean {
  if (missing.size === 0) return true;
  if (node === root || active.has(node)) return false;
  const incoming = parents.get(node);
  if (!incoming?.length) return false;
  return incoming.every(({ parent, expression }) => {
    if (expression || !isMaterializationSafeNode(parent)) return false;
    const next = new Set([...active, node]);
    if (parent.kind === "project") {
      const mapped = new Set<number>();
      for (const index of missing) {
        const output = parent.projections.findIndex(
          ({ expression }) =>
            expression.kind === "column" &&
            expression.scope === parent.input.scope &&
            expression.index === index,
        );
        if (output < 0) return false;
        mapped.add(output);
      }
      return nullRepresentativesDiscarded(parent, mapped, root, parents, next);
    }
    if (parent.kind === "filter")
      return nullRepresentativesDiscarded(
        parent,
        new Set(
          [...missing].filter(
            (index) => !rejectsNull(parent.predicate, parent.input, index),
          ),
        ),
        root,
        parents,
        next,
      );
    if (parent.kind === "join" && parent.joinType === "inner") {
      const input = parent.left.node === node ? parent.left : parent.right;
      const offset = parent.left.node === node ? 0 : parent.left.fields.length;
      return nullRepresentativesDiscarded(
        parent,
        new Set(
          [...missing]
            .filter((index) => !rejectsNull(parent.condition, input, index))
            .map((index) => index + offset),
        ),
        root,
        parents,
        next,
      );
    }
    return false;
  });
}

function stableDistinctConsumer(
  node: Extract<LogicalQueryNode, { kind: "distinct" }>,
  root: LogicalQueryNode,
  parents: ReadonlyMap<LogicalQueryNode, readonly Edge[]>,
): boolean {
  if (stableDistinctInput(node.input)) return true;
  const facts = analyzeRelationalKeyFacts(node.input);
  if (
    facts.keys.some(
      (key) =>
        key.fields.every((index) =>
          stableField(node.input, index, new Set()),
        ) &&
        nullRepresentativesDiscarded(
          node,
          new Set(
            key.requiredNonNull.filter(
              (index) => !facts.nonNullFields.has(index),
            ),
          ),
          root,
          parents,
        ),
    )
  )
    return true;
  return (
    binarySetInput(node.input) &&
    setRepresentativesUnobserved(
      node,
      new Set(
        node.fields
          .map((_field, index) => index)
          .filter((index) => !stableField(node.input, index, new Set())),
      ),
      root,
      parents,
    )
  );
}

function binarySetInput(input: QuerySource): boolean {
  const node = input.node;
  if (node.kind === "union")
    // Comparison-domain lineage intentionally stops at compound affinity.
    // BINARY set equality needs no storage/affinity conversion proof: both
    // current, aligned arms must independently retain BINARY collation.
    return (
      node.fields.length === node.left.fields.length &&
      node.fields.length === node.right.fields.length &&
      node.fields.every(
        (field, index) =>
          field.affinity === node.left.fields[index]?.affinity &&
          field.affinity === node.right.fields[index]?.affinity,
      ) &&
      binarySetInput(node.left) &&
      binarySetInput(node.right)
    );
  return input.fields.every(
    (_field, index) =>
      semiMembershipBinaryCollation(input, index).kind === "binary",
  );
}

/** SQL comparison affinity, not a TypeScript number or a claimed storage class.
 * Only direct catalog columns retain this certificate through flattenable
 * projections/filters/joins. UNION, casts and computed expressions do not. */
function catalogNumericComparisonColumn(
  input: QuerySource,
  index: number,
  active = new Set<LogicalQueryNode>(),
): boolean {
  const node = input.node;
  if (active.has(node) || node.scope !== input.scope) return false;
  const next = new Set([...active, node]);
  if (node.kind === "scan" && node.table.kind === "table") {
    const column = Object.values(node.table.columns)[index];
    const field = input.fields[index];
    if (
      !column ||
      !field ||
      column.table !== node.table.name ||
      column.propertyName !== field.name ||
      column.affinity !== field.affinity ||
      column.nullable !== field.nullable
    )
      return false;
    const type = column.declaredType.toUpperCase();
    const affinity = type.includes("INT")
      ? "integer"
      : /CHAR|CLOB|TEXT/.test(type)
        ? "text"
        : type.includes("BLOB") || type.length === 0
          ? "blob"
          : /REAL|FLOA|DOUB/.test(type)
            ? "real"
            : "numeric";
    return (
      affinity === column.affinity &&
      (affinity === "integer" || affinity === "real" || affinity === "numeric")
    );
  }
  if (node.kind === "filter")
    return catalogNumericComparisonColumn(node.input, index, next);
  if (node.kind === "project") {
    const expression = node.projections[index]?.expression;
    return (
      expression?.kind === "column" &&
      expression.scope === node.input.scope &&
      expression.name === node.input.fields[expression.index]?.name &&
      catalogNumericComparisonColumn(node.input, expression.index, next)
    );
  }
  if (node.kind === "join")
    return index < node.left.fields.length
      ? catalogNumericComparisonColumn(node.left, index, next)
      : catalogNumericComparisonColumn(
          node.right,
          index - node.left.fields.length,
          next,
        );
  return false;
}

/** BINARY set equality can choose INTEGER 1 or REAL 1.0, but both remain in
 * the same equivalence class through identity projections and BINARY sets.
 * A complete direct numeric-affinity catalog equality may consume the keys;
 * every exported copy stays tracked until discarded or counted. Raw export,
 * conversion, other predicates, selection and NOCASE sets remain rejected. */
function setRepresentativesUnobserved(
  node: LogicalQueryNode,
  tainted: ReadonlySet<number>,
  root: LogicalQueryNode,
  parents: ReadonlyMap<LogicalQueryNode, readonly Edge[]>,
  active = new Set<LogicalQueryNode>(),
): boolean {
  if (tainted.size === 0) return true;
  if (node === root || active.has(node)) return false;
  const incoming = parents.get(node);
  if (!incoming?.length) return false;
  return incoming.every(({ parent, expression }) => {
    if (expression || !isMaterializationSafeNode(parent)) return false;
    const next = new Set([...active, node]);
    if (parent.kind === "aggregate")
      return (
        parent.groups.length === 0 &&
        parent.aggregates.every(
          ({ expression }) =>
            expression.kind === "aggregate" &&
            expression.name === "COUNT" &&
            !expression.expression,
        )
      );
    if (parent.kind === "project") {
      const remaining = new Set<number>();
      for (const [index, projection] of parent.projections.entries()) {
        if (!references(projection.expression, parent.input, tainted)) continue;
        if (
          projection.expression.kind !== "column" ||
          projection.expression.scope !== parent.input.scope
        )
          return false;
        remaining.add(index);
      }
      return setRepresentativesUnobserved(
        parent,
        remaining,
        root,
        parents,
        next,
      );
    }
    if (parent.kind === "join" && parent.joinType === "inner") {
      const left = parent.left.node === node;
      const right = parent.right.node === node;
      if (left === right) return false;
      const observed = new Set<number>();
      const direct = (expression: SqlExpression, source: QuerySource) =>
        expression.kind === "column" &&
        expression.scope === source.scope &&
        expression.name === source.fields[expression.index]?.name
          ? expression.index
          : undefined;
      const equalityKeys = (condition: SqlExpression): boolean => {
        if (condition.kind === "boolean")
          return (
            condition.operator === "AND" &&
            condition.expressions.length > 0 &&
            condition.expressions.every(equalityKeys)
          );
        if (condition.kind !== "binary" || condition.operator !== "=")
          return false;
        const pair = (a: SqlExpression, b: SqlExpression): boolean => {
          const li = direct(a, parent.left);
          const ri = direct(b, parent.right);
          if (li === undefined || ri === undefined) return false;
          const own = left ? li : ri;
          if (!tainted.has(own)) return true;
          if (
            !catalogNumericComparisonColumn(
              left ? parent.right : parent.left,
              left ? ri : li,
            )
          )
            return false;
          observed.add(own);
          return true;
        };
        return (
          pair(condition.left, condition.right) ||
          pair(condition.right, condition.left)
        );
      };
      if (
        !equalityKeys(parent.condition) ||
        [...tainted].some((index) => !observed.has(index))
      )
        return false;
      // Numeric INTEGER/REAL representatives compare alike under a proven
      // numeric-affinity catalog operand. Keep tracking every exported copy;
      // they must still be discarded or observed only by the existing fence.
      return setRepresentativesUnobserved(
        parent,
        new Set(
          [...tainted].map(
            (index) => index + (left ? 0 : parent.left.fields.length),
          ),
        ),
        root,
        parents,
        next,
      );
    }
    if (
      parent.kind === "filter" &&
      !references(parent.predicate, parent.input, tainted)
    )
      return setRepresentativesUnobserved(parent, tainted, root, parents, next);
    if (parent.kind === "distinct" && binarySetInput(parent.input))
      return setRepresentativesUnobserved(parent, tainted, root, parents, next);
    if (
      parent.kind === "union" &&
      (parent.all ||
        (binarySetInput(parent.left) && binarySetInput(parent.right)))
    )
      return setRepresentativesUnobserved(parent, tainted, root, parents, next);
    return false;
  });
}

/** All numeric addends share one emission representation and are 0/1.
 * Removing zero/NULL addends leaves an identical sequence of +1 values.
 * Mixed bound/literal zeros are excluded too: a REAL zero could promote an
 * INTEGER accumulator before an otherwise observable integer overflow. */
function canonicalIndicatorSum(
  expression: SqlExpression,
  input: QuerySource,
): boolean {
  const ones = new Set<string>();
  const active = new Set<LogicalQueryNode>();
  const field = (source: QuerySource, index: number): boolean => {
    const node = source.node;
    if (active.has(node)) return false;
    active.add(node);
    let result = false;
    if (node.kind === "project")
      result = value(node.projections[index]?.expression, node.input);
    else if (node.kind === "filter" || node.kind === "distinct")
      result = field(node.input, index);
    else if (node.kind === "semi-join" || node.kind === "anti-join")
      result = field(node.left, index);
    else if (node.kind === "join")
      result =
        index < node.left.fields.length
          ? field(node.left, index)
          : field(node.right, index - node.left.fields.length);
    else if (node.kind === "union" && node.all)
      result = field(node.left, index) && field(node.right, index);
    active.delete(node);
    return result;
  };
  const value = (
    current: SqlExpression | undefined,
    source: QuerySource,
  ): boolean => {
    if (!current || !total(current, source)) return false;
    if (current.kind === "column")
      return current.scope === source.scope && field(source, current.index);
    if (current.kind === "constant" || current.kind === "parameter") {
      if (current.value === 0 || current.value === 1)
        ones.add(`${current.kind}:${typeof current.value}`);
      return (
        current.value === null || current.value === 0 || current.value === 1
      );
    }
    if (current.kind === "case")
      return (
        current.branches.every(({ then }) => value(then, source)) &&
        (!current.else || value(current.else, source))
      );
    if (current.kind === "coalesce")
      return current.expressions.every((child) => value(child, source));
    if (current.kind === "cast-integer") {
      const before = new Set(ones);
      if (!value(current.expression, source)) return false;
      for (const kind of ones) if (!before.has(kind)) ones.delete(kind);
      ones.add("canonical-integer");
      return true;
    }
    return false;
  };
  return value(expression, input) && ones.size <= 1;
}

/** Equality of group/DISTINCT keys must imply the same observable value, not
 * merely the same declared affinity. INTEGER affinity alone is insufficient. */
function stableField(
  input: QuerySource,
  index: number,
  active: Set<LogicalQueryNode>,
): boolean {
  const domain = semiMembershipComparisonDomain(input, index);
  if (domain.kind === "proven") {
    if (
      domain.domain.storageClasses.every(
        (kind) => kind === "integer" || kind === "null",
      )
    )
      return true;
    if (
      domain.domain.storageClasses.every(isTextComparisonStorageClass) &&
      semiMembershipBinaryCollation(input, index).kind === "binary"
    )
      return true;
  }
  const node = input.node;
  if (active.has(node)) return false;
  const next = new Set([...active, node]);
  if (node.kind === "filter" || node.kind === "distinct")
    return stableField(node.input, index, next);
  if (node.kind === "semi-join" || node.kind === "anti-join")
    return stableField(node.left, index, next);
  if (node.kind === "join")
    return index < node.left.fields.length
      ? stableField(node.left, index, next)
      : stableField(node.right, index - node.left.fields.length, next);
  if (node.kind === "union")
    return (
      stableBinaryTextField(node.left, index, next) &&
      stableBinaryTextField(node.right, index, next)
    );
  if (node.kind === "project")
    return stableExpression(
      node.projections[index]?.expression,
      node.input,
      next,
    );
  if (node.kind === "aggregate") {
    if (index < node.groups.length)
      return stableExpression(
        node.groups[index]?.expression,
        node.input,
        active,
      );
    const expression = node.aggregates[index - node.groups.length]?.expression;
    if (
      expression?.kind === "aggregate" &&
      (expression.name === "MIN" || expression.name === "MAX") &&
      expression.expression
    )
      // A canonical operand has one storage representative per equality class.
      // Propagate that same fresh proof; affinity alone cannot license MIN/MAX.
      return stableExpression(expression.expression, node.input, next);
    return (
      expression?.kind === "aggregate" &&
      expression.name === "COUNT" &&
      total(
        expression.expression ?? {
          kind: "constant",
          value: 1,
          resultType: { affinity: "integer", nullable: false },
        },
        node.input,
      )
    );
  }
  return false;
}

/** Membership comparison domains intentionally reject UNION DISTINCT affinity.
 * Consumer representative proof needs no affinity conversion: BINARY TEXT,
 * BLOB and NULL values have a unique representative under set equality on
 * either arm. Numeric arms deliberately do not use this shortcut. */
function stableBinaryTextField(
  input: QuerySource,
  index: number,
  active: ReadonlySet<LogicalQueryNode>,
): boolean {
  const domain = semiMembershipComparisonDomain(input, index);
  if (
    domain.kind === "proven" &&
    domain.domain.storageClasses.every(isTextComparisonStorageClass) &&
    semiMembershipBinaryCollation(input, index).kind === "binary"
  )
    return true;
  const node = input.node;
  if (active.has(node)) return false;
  const next = new Set([...active, node]);
  if (node.kind === "project") {
    const expression = node.projections[index]?.expression;
    return (
      expression?.kind === "column" &&
      expression.scope === node.input.scope &&
      stableBinaryTextField(node.input, expression.index, next)
    );
  }
  if (node.kind === "filter" || node.kind === "distinct")
    return stableBinaryTextField(node.input, index, next);
  if (node.kind === "semi-join" || node.kind === "anti-join")
    return stableBinaryTextField(node.left, index, next);
  if (node.kind === "join")
    return index < node.left.fields.length
      ? stableBinaryTextField(node.left, index, next)
      : stableBinaryTextField(
          node.right,
          index - node.left.fields.length,
          next,
        );
  if (node.kind === "union")
    return (
      stableBinaryTextField(node.left, index, next) &&
      stableBinaryTextField(node.right, index, next)
    );
  return false;
}

function stableExpression(
  expression: SqlExpression | undefined,
  input: QuerySource,
  active = new Set<LogicalQueryNode>(),
): boolean {
  if (!expression || !total(expression, input)) return false;
  if (expression.kind === "column")
    return (
      expression.scope === input.scope &&
      stableField(input, expression.index, active)
    );
  if (expression.kind === "constant" || expression.kind === "parameter")
    return (
      expression.value === null ||
      typeof expression.value === "string" ||
      (typeof expression.value === "number" &&
        Number.isFinite(expression.value))
    );
  if (
    expression.kind === "cast-integer" ||
    expression.kind === "null-check" ||
    expression.kind === "boolean" ||
    expression.kind === "not" ||
    (expression.kind === "binary" &&
      ["=", "<>", "<", "<=", ">", ">="].includes(expression.operator))
  )
    return true;
  if (expression.kind === "case") {
    const outputs = [
      ...expression.branches.map(({ then }) => then),
      ...(expression.else ? [expression.else] : []),
    ];
    // Constants are canonical SQL integers/text/NULL. Do not mix literal and
    // bound numeric representations as an INTEGER storage certificate.
    return outputs.every(
      (value) =>
        value.kind === "constant" &&
        (value.value === null ||
          typeof value.value === "string" ||
          Number.isSafeInteger(value.value)),
    );
  }
  return false;
}

function references(
  expression: SqlExpression,
  input: QuerySource,
  tainted: ReadonlySet<number>,
): boolean {
  return (
    (expression.kind === "column" &&
      expression.scope === input.scope &&
      tainted.has(expression.index)) ||
    expressionChildren(expression).some((child) =>
      references(child, input, tainted),
    )
  );
}

function numericLiteral(expression: SqlExpression): boolean {
  return (
    (expression.kind === "constant" || expression.kind === "parameter") &&
    typeof expression.value === "number" &&
    Number.isFinite(expression.value)
  );
}

/** Only numeric truth or canonical integer buckets may observe an unstable
 * numeric MIN/MAX representative. Raw output, typeof and text observers veto. */
function canonicalObserver(
  expression: SqlExpression,
  input: QuerySource,
  tainted: ReadonlySet<number>,
): boolean {
  if (!references(expression, input, tainted)) return total(expression, input);
  if (
    expression.kind === "binary" &&
    ["=", "<>", "<", "<=", ">", ">="].includes(expression.operator)
  ) {
    const operand = (value: SqlExpression) =>
      value.kind === "column" &&
      value.scope === input.scope &&
      tainted.has(value.index);
    return (
      (operand(expression.left) && numericLiteral(expression.right)) ||
      (operand(expression.right) && numericLiteral(expression.left))
    );
  }
  if (expression.kind === "null-check")
    return (
      expression.expression.kind === "column" &&
      expression.expression.scope === input.scope &&
      tainted.has(expression.expression.index)
    );
  if (expression.kind === "boolean")
    return expression.expressions.every((child) =>
      canonicalObserver(child, input, tainted),
    );
  if (expression.kind === "not")
    return canonicalObserver(expression.expression, input, tainted);
  if (expression.kind === "case")
    return (
      expression.branches.every(
        ({ when, then }) =>
          canonicalObserver(when, input, tainted) &&
          then.kind === "constant" &&
          (then.value === null ||
            (typeof then.value === "number" &&
              Number.isSafeInteger(then.value))),
      ) &&
      (!expression.else ||
        (expression.else.kind === "constant" &&
          (expression.else.value === null ||
            (typeof expression.else.value === "number" &&
              Number.isSafeInteger(expression.else.value)))))
    );
  return false;
}

function canonicallyObserved(
  node: LogicalQueryNode,
  tainted: ReadonlySet<number>,
  root: LogicalQueryNode,
  parents: ReadonlyMap<LogicalQueryNode, readonly Edge[]>,
  active = new Set<LogicalQueryNode>(),
): boolean {
  if (tainted.size === 0) return true;
  if (node === root || active.has(node)) return false;
  const incoming = parents.get(node);
  if (!incoming?.length) return false;
  return incoming.every(({ parent, expression }) => {
    if (expression || !isMaterializationSafeNode(parent)) return false;
    const next = new Set([...active, node]);
    if (parent.kind === "project") {
      const remaining = new Set<number>();
      for (const [index, projection] of parent.projections.entries()) {
        if (!references(projection.expression, parent.input, tainted)) continue;
        if (
          projection.expression.kind === "column" &&
          projection.expression.scope === parent.input.scope &&
          tainted.has(projection.expression.index)
        )
          remaining.add(index);
        else if (
          !canonicalObserver(projection.expression, parent.input, tainted)
        )
          return false;
      }
      return canonicallyObserved(parent, remaining, root, parents, next);
    }
    if (
      parent.kind === "filter" &&
      canonicalObserver(parent.predicate, parent.input, tainted)
    )
      return canonicallyObserved(parent, tainted, root, parents, next);
    // No implicit DISTINCT/grouping/selection or cross-relation coercion is
    // licensed before all representative differences have been eliminated.
    return false;
  });
}

function aggregateFence(
  node: AggregateNode,
  root: LogicalQueryNode,
  parents: ReadonlyMap<LogicalQueryNode, readonly Edge[]>,
): boolean {
  if (
    !node.groups.every(({ expression }) =>
      stableExpression(expression, node.input),
    )
  )
    return false;
  const representatives = new Set<number>();
  for (const [index, { expression }] of node.aggregates.entries()) {
    if (expression.kind !== "aggregate") return false;
    if (expression.name === "COUNT") {
      if (expression.expression && !total(expression.expression, node.input))
        return false;
    } else if (expression.name === "SUM") {
      if (
        !isOrderStableSumExpression(expression, node.input) &&
        !(
          expression.expression &&
          canonicalIndicatorSum(expression.expression, node.input)
        )
      )
        return false;
    } else if (
      (expression.name === "MIN" || expression.name === "MAX") &&
      expression.expression &&
      total(expression.expression, node.input)
    ) {
      if (stableExpression(expression.expression, node.input)) continue;
      if (
        !["integer", "real", "numeric"].includes(
          expression.expression.resultType.affinity,
        )
      )
        return false;
      representatives.add(node.groups.length + index);
    } else return false;
  }
  return canonicallyObserved(node, representatives, root, parents);
}

/** Fresh candidate-to-every-consumer proof. A stable aggregate is an output
 * order/value fence; unrelated consumers above it cannot observe input order.
 * Shared paths and expression-query observations are checked independently. */
export function hasOrderStableConsumers(
  candidate: LogicalQueryNode,
  root: LogicalQueryNode,
): boolean {
  const parents = parentIndex(root);
  const active = new Set<LogicalQueryNode>();
  const checked = new Map<LogicalQueryNode, boolean>();
  const visit = (node: LogicalQueryNode): boolean => {
    if (node === root) return true;
    if (active.has(node)) return false;
    const prior = checked.get(node);
    if (prior !== undefined) return prior;
    const incoming = parents.get(node);
    if (!incoming?.length) return false;
    active.add(node);
    const safe = incoming.every(({ parent, expression }) => {
      if (expression) return false;
      if (parent.kind === "aggregate")
        return aggregateFence(parent, root, parents);
      if (
        ["limit", "sort", "window", "recursive-closure"].includes(
          parent.kind,
        ) ||
        !isMaterializationSafeNode(parent)
      )
        return false;
      if (
        parent.kind === "distinct" &&
        !stableDistinctConsumer(parent, root, parents)
      )
        return false;
      if (
        parent.kind === "union" &&
        !parent.all &&
        !parent.fields.every(
          (_field, index) =>
            stableField(parent.left, index, new Set()) &&
            stableField(parent.right, index, new Set()),
        ) &&
        !(
          binarySetInput(parent.left) &&
          binarySetInput(parent.right) &&
          setRepresentativesUnobserved(
            parent,
            new Set(
              parent.fields
                .map((_field, index) => index)
                .filter(
                  (index) =>
                    !stableField(parent.left, index, new Set()) ||
                    !stableField(parent.right, index, new Set()),
                ),
            ),
            root,
            parents,
          )
        )
      )
        return false;
      return visit(parent);
    });
    active.delete(node);
    checked.set(node, safe);
    return safe;
  };
  return visit(candidate);
}
