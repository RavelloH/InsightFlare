import type { SqlExpression } from "@/lib/db/query/expression";
import {
  isMaterializationSafeExpression,
  isMaterializationSafeNode,
} from "@/lib/db/query/materialization-safety";
import type { LogicalQueryNode, QuerySource } from "@/lib/db/query/plan";
import { isGeneratedSchemaObject } from "@/lib/db/schema";

function sameField(
  a: QuerySource["fields"][number] | undefined,
  b: QuerySource["fields"][number] | undefined,
): boolean {
  return (
    !!a &&
    !!b &&
    a.name === b.name &&
    a.affinity === b.affinity &&
    a.nullable === b.nullable
  );
}
function matchesColumn(
  e: Extract<SqlExpression, { kind: "column" }>,
  input: QuerySource,
): boolean {
  const f = input.fields[e.index];
  return (
    e.scope === input.scope &&
    Number.isSafeInteger(e.index) &&
    e.index >= 0 &&
    !!f &&
    e.name === f.name &&
    e.resultType.affinity === f.affinity &&
    e.resultType.nullable === f.nullable
  );
}
function realDeclaredType(type: string): boolean {
  const t = type.toUpperCase();
  // SQLite affinity precedence: FLOATING POINT contains INT and is INTEGER.
  return (
    !t.includes("INT") &&
    !/CHAR|CLOB|TEXT|BLOB/.test(t) &&
    /REAL|FLOA|DOUB/.test(t)
  );
}

/** A catalog REAL-affinity read restores numeric INTEGER storage to REAL.
 * Remaining TEXT/BLOB/NULL storage is not SQLITE_INTEGER either. This is a
 * storage-family proof, not a numeric-domain or finite-value proof. ABS only
 * overflows for SQLITE_INTEGER/INT64_MIN (SQLite absFunc).
 * No view, computed cast/arithmetic, INTEGER/NUMERIC or output affinity alone
 * is accepted. Every aligned UNION arm must independently prove the family. */
export function catalogReadExcludesInteger(
  source: QuerySource,
  index: number,
  active = new Map<LogicalQueryNode, Set<number>>(),
): boolean {
  const node = source.node;
  if (
    source.scope !== node.scope ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    !sameField(source.fields[index], node.fields[index]) ||
    active.get(node)?.has(index)
  )
    return false;
  const next = new Map(active);
  next.set(node, new Set([...(active.get(node) ?? []), index]));
  switch (node.kind) {
    case "scan": {
      if (node.table.kind !== "table" || !isGeneratedSchemaObject(node.table))
        return false;
      const entry = Object.entries(node.table.columns)[index];
      if (!entry) return false;
      const [propertyName, c] = entry,
        f = source.fields[index]!;
      return (
        c.kind === "column" &&
        c.table === node.table.name &&
        propertyName === c.propertyName &&
        f.name === propertyName &&
        c.sqlName === propertyName &&
        c.affinity === "real" &&
        f.affinity === "real" &&
        c.nullable === f.nullable &&
        c.generated === false &&
        c.hidden === 0 &&
        realDeclaredType(c.declaredType)
      );
    }
    case "project": {
      const e = node.projections[index]?.expression;
      if (!e || node.projections[index]?.name !== source.fields[index]?.name)
        return false;
      if (e.kind === "constant" && e.value === null) return true;
      return (
        e.kind === "column" &&
        matchesColumn(e, node.input) &&
        catalogReadExcludesInteger(node.input, e.index, next)
      );
    }
    case "filter":
    case "distinct":
    case "sort":
    case "limit":
      return catalogReadExcludesInteger(node.input, index, next);
    case "window":
      return (
        index < node.input.fields.length &&
        catalogReadExcludesInteger(node.input, index, next)
      );
    case "semi-join":
    case "anti-join":
      return catalogReadExcludesInteger(node.left, index, next);
    case "join":
      return index < node.left.fields.length
        ? catalogReadExcludesInteger(node.left, index, next)
        : catalogReadExcludesInteger(
            node.right,
            index - node.left.fields.length,
            next,
          );
    case "union":
      return (
        catalogReadExcludesInteger(node.left, index, next) &&
        catalogReadExcludesInteger(node.right, index, next)
      );
    default:
      return false;
  }
}

/** This does not render altered SQL. It substitutes only separately proven
 * total ABS expressions in the totality analysis, then invokes the unchanged
 * global closed-expression checker. All real execution keeps the original ABS. */
export function isConditionalGuardExpressionTotal(
  expression: SqlExpression,
  inputs: readonly QuerySource[],
): boolean {
  const scopes = new Map(inputs.map((s) => [s.scope, s.fields.length]));
  if (isMaterializationSafeExpression(expression, scopes)) return true;
  const active = new Set<SqlExpression>();
  const rewrite = (e: SqlExpression): SqlExpression | undefined => {
    if (active.has(e)) return undefined;
    active.add(e);
    const many = (
      values: readonly SqlExpression[],
    ): SqlExpression[] | undefined => {
      const result = values.map(rewrite);
      return result.every((v): v is SqlExpression => !!v) ? result : undefined;
    };
    let result: SqlExpression | undefined;
    switch (e.kind) {
      case "constant":
      case "parameter":
      case "column":
        result = e;
        break;
      case "function": {
        if (e.name === "abs") {
          const arg = e.arguments[0],
            source =
              arg?.kind === "column"
                ? inputs.find((s) => s.scope === arg.scope)
                : undefined;
          if (
            e.arguments.length === 1 &&
            arg?.kind === "column" &&
            source &&
            matchesColumn(arg, source) &&
            catalogReadExcludesInteger(source, arg.index)
          )
            result = {
              kind: "constant",
              value: 0,
              resultType: { affinity: "integer", nullable: false },
            };
        } else {
          const args = many(e.arguments);
          if (args) result = { ...e, arguments: args };
        }
        break;
      }
      case "binary":
      case "distinct-from": {
        const left = rewrite(e.left),
          right = rewrite(e.right);
        if (left && right) result = { ...e, left, right };
        break;
      }
      case "boolean":
      case "coalesce": {
        const expressions = many(e.expressions);
        if (expressions) result = { ...e, expressions } as typeof e;
        break;
      }
      case "not":
      case "null-check":
      case "cast-integer":
      case "cast-real":
      case "cast-text": {
        const value = rewrite(e.expression);
        if (value) result = { ...e, expression: value } as typeof e;
        break;
      }
      case "text-position": {
        const text = rewrite(e.text),
          needle = rewrite(e.needle);
        if (text && needle) result = { ...e, text, needle };
        break;
      }
      case "text-substring": {
        const text = rewrite(e.text),
          start = rewrite(e.start),
          length = e.length ? rewrite(e.length) : undefined;
        if (text && start && (!e.length || length))
          result = { ...e, text, start, ...(length ? { length } : {}) };
        break;
      }
      case "text-like": {
        const text = rewrite(e.text),
          pattern = rewrite(e.pattern);
        if (text && pattern) result = { ...e, text, pattern };
        break;
      }
      case "in-list": {
        const value = rewrite(e.expression);
        if (value) result = { ...e, expression: value } as typeof e;
        break;
      }
      case "case": {
        const branches = e.branches.map((b) => {
          const when = rewrite(b.when),
            then = rewrite(b.then);
          return when && then
            ? { when: when as typeof b.when, then }
            : undefined;
        });
        const otherwise = e.else ? rewrite(e.else) : undefined;
        if (
          branches.every((b): b is NonNullable<typeof b> => !!b) &&
          (!e.else || otherwise)
        )
          result = {
            ...e,
            branches,
            ...(otherwise ? { else: otherwise } : {}),
          };
        break;
      }
      default:
        result = undefined;
    }
    active.delete(e);
    return result;
  };
  const analyzed = rewrite(expression);
  return !!analyzed && isMaterializationSafeExpression(analyzed, scopes);
}

export function isConditionalGuardNodeTotal(node: LogicalQueryNode): boolean {
  if (isMaterializationSafeNode(node)) return true;
  switch (node.kind) {
    case "project":
      return node.projections.every((p) =>
        isConditionalGuardExpressionTotal(p.expression, [node.input]),
      );
    case "filter":
      return isConditionalGuardExpressionTotal(node.predicate, [node.input]);
    case "join":
    case "semi-join":
    case "anti-join":
      return isConditionalGuardExpressionTotal(node.condition, [
        node.left,
        node.right,
      ]);
    default:
      return false;
  }
}
