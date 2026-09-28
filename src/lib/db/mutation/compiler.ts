import {
  compileD1Expression,
  compileD1Query,
  type ScopeBinding,
} from "@/lib/db/query/compiler";
import { DatabaseCompilerError } from "@/lib/db/query/errors";
import type { RelationScope } from "@/lib/db/query/expression";
import type { PhysicalQueryPlan } from "@/lib/db/query/physical-plan";
import { concat, join, type SqlFragment, text } from "@/lib/db/sql/fragment";
import { identifier } from "@/lib/db/sql/identifier";
import type { DatabaseBinding } from "@/lib/db/types";

import type { CompiledMutation, MutationNode } from "./plan";
import { validateMutationPlan } from "./validator";

export interface MutationCompileOptions {
  readonly tag?: string;
}

function insertValues(
  plan: Extract<MutationNode, { kind: "insert" }>,
): SqlFragment {
  if (plan.source) {
    const query = compileD1Query({
      kind: "physical-query",
      root: plan.source.node,
      scope: plan.source.scope,
      fields: plan.source.fields,
    } as PhysicalQueryPlan<object>);
    const alias = "q0";
    return concat(
      text("SELECT "),
      join(
        plan.source.fields.map((field) =>
          concat(
            identifier(alias),
            text("."),
            identifier(field.name),
            text(" AS "),
            identifier(field.name),
          ),
        ),
      ),
      text(" FROM ("),
      { text: query.sql, bindings: query.bindings ?? [] },
      text(") AS "),
      identifier(alias),
      text(" WHERE 1"),
    );
  }
  const rows = plan.rows ?? [];
  if (plan.columns.length === 0 && rows.length === 1)
    return text("DEFAULT VALUES");
  if (plan.columns.length === 0)
    throw new DatabaseCompilerError(
      "unsupported_mutation",
      "Multi-row DEFAULT VALUES is not supported",
    );
  const rowFragments = rows.map((row) =>
    concat(
      text("("),
      join(row.map((value) => compileD1Expression(value, new Map()))),
      text(")"),
    ),
  );
  return concat(text("VALUES "), join(rowFragments));
}

function fieldSqlName(
  plan: Extract<MutationNode, { kind: "update" | "delete" }>,
  propertyName: string,
): string {
  const field = plan.fields.find((item) => item.propertyName === propertyName);
  if (!field)
    throw new DatabaseCompilerError(
      "invalid_plan",
      `Unknown target column: ${propertyName}`,
    );
  return field.sqlName;
}

function compileInsert(
  plan: Extract<MutationNode, { kind: "insert" }>,
): SqlFragment {
  const prefix = plan.orIgnore ? "INSERT OR IGNORE INTO " : "INSERT INTO ";
  const columns = plan.columns.map((name) =>
    identifier(plan.table.columns[name]!.sqlName),
  );
  const target = concat(text(prefix), identifier(plan.table.name));
  const statement =
    plan.columns.length === 0
      ? concat(target, text(" "), insertValues(plan))
      : concat(
          target,
          text(" ("),
          join(columns),
          text(") "),
          insertValues(plan),
        );
  if (!plan.conflict) return statement;
  const conflictTarget = join(
    plan.conflict.target.map((name) =>
      identifier(plan.table.columns[name]!.sqlName),
    ),
  );
  if (plan.conflict.action === "nothing")
    return concat(
      statement,
      text(" ON CONFLICT ("),
      conflictTarget,
      text(") DO NOTHING"),
    );
  const assignments = (plan.conflict.set ?? []).map((assignment) =>
    concat(
      identifier(plan.table.columns[assignment.propertyName]!.sqlName),
      text(" = "),
      compileD1Expression(assignment.expression, new Map()),
    ),
  );
  return concat(
    statement,
    text(" ON CONFLICT ("),
    conflictTarget,
    text(") DO UPDATE SET "),
    join(assignments),
  );
}

function compileUpdate(
  plan: Extract<MutationNode, { kind: "update" }>,
): SqlFragment {
  const alias = "t0";
  const names = plan.fields.map((field) => field.sqlName);
  const scopes = new Map<RelationScope, ScopeBinding>([
    [plan.scope, { alias, fieldNames: names }],
  ]);
  const assignments = plan.set.map(({ propertyName, expression }) =>
    concat(
      identifier(fieldSqlName(plan, propertyName)),
      text(" = "),
      compileD1Expression(expression, scopes),
    ),
  );
  return concat(
    text("UPDATE "),
    identifier(plan.table.name),
    text(" AS "),
    identifier(alias),
    text(" SET "),
    join(assignments),
    text(" WHERE "),
    compileD1Expression(plan.where, scopes),
  );
}

function compileDelete(
  plan: Extract<MutationNode, { kind: "delete" }>,
): SqlFragment {
  const alias = "t0";
  const names = plan.fields.map((field) => field.sqlName);
  const scopes = new Map<RelationScope, ScopeBinding>([
    [plan.scope, { alias, fieldNames: names }],
  ]);
  return concat(
    text("DELETE FROM "),
    identifier(plan.table.name),
    text(" AS "),
    identifier(alias),
    text(" WHERE "),
    compileD1Expression(plan.where, scopes),
  );
}

export function compileD1Mutation(
  plan: MutationNode,
  options: MutationCompileOptions = {},
): CompiledMutation<D1Result> {
  validateMutationPlan(plan);
  const fragment =
    plan.kind === "insert"
      ? compileInsert(plan)
      : plan.kind === "update"
        ? compileUpdate(plan)
        : compileDelete(plan);
  return {
    sql: fragment.text,
    bindings: fragment.bindings as readonly DatabaseBinding[],
    kind: "mutation",
    ...(options.tag === undefined ? {} : { tag: options.tag }),
  };
}
