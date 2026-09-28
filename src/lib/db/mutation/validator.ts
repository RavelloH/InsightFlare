import { DatabaseCompilerError } from "@/lib/db/query/errors";
import {
  type ExpressionScopeMetadata,
  validateMutationExpression,
  validatePredicate,
} from "@/lib/db/query/validator";
import { isGeneratedSchemaObject } from "@/lib/db/schema";
import type { DatabaseBinding } from "@/lib/db/types";

import type { MutationNode } from "./plan";

function fail(message: string): never {
  throw new DatabaseCompilerError("invalid_plan", message);
}

function isBinding(value: unknown): value is DatabaseBinding {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  );
}

function mutationScopeFields(
  plan: Extract<MutationNode, { kind: "update" | "delete" }>,
): ExpressionScopeMetadata {
  return new Map([
    [
      plan.scope,
      Object.entries(plan.table.columns).map(([name, column]) => ({
        name,
        affinity: column.affinity,
        nullable: column.nullable,
      })),
    ],
  ]);
}

export function validateMutationPlan(plan: MutationNode): void {
  const columns = Object.keys(plan.table.columns);
  if (!isGeneratedSchemaObject(plan.table))
    fail("Mutation requires a table from the generated schema catalog");
  if (plan.table.kind !== "table")
    fail("Mutations require a generated table reference");
  if (plan.kind === "insert") {
    if (plan.rows && plan.source)
      fail("INSERT cannot have both VALUES and a query source");
    if (!plan.rows && !plan.source)
      fail("INSERT requires values or a query source");
    const insertColumns = new Set(plan.columns);
    if (
      insertColumns.size !== plan.columns.length ||
      plan.columns.some((name) => !columns.includes(name))
    )
      fail("INSERT columns must belong to the target table and be unique");
    if (
      plan.rows &&
      plan.rows.some((row) => row.length !== plan.columns.length)
    )
      fail("INSERT row width must match its columns");
    if (plan.source && plan.source.fields.length !== plan.columns.length)
      fail("INSERT source width must match target columns");
    for (const row of plan.rows ?? []) {
      for (const value of row) {
        if (value.kind === "parameter") {
          if (!isBinding(value.value))
            fail("INSERT values must be SQLite/D1 bindings");
        } else if (
          value.kind === "unixepoch" ||
          value.kind === "scalar-subquery"
        ) {
          validateMutationExpression(value, []);
        } else {
          fail(
            "INSERT VALUES supports bindings, unixepoch(), and scalar subqueries",
          );
        }
      }
    }
    if (plan.conflict) {
      if (
        plan.conflict.target.length === 0 ||
        plan.conflict.target.some((name) => !columns.includes(name))
      )
        fail("Conflict target columns must belong to the target table");
      if (plan.conflict.action === "update") {
        if (!plan.conflict.set?.length)
          fail("DO UPDATE requires at least one assignment");
        for (const assignment of plan.conflict.set ?? []) {
          if (!columns.includes(assignment.propertyName))
            fail(
              `Conflict update column "${assignment.propertyName}" is not in the target table`,
            );
          validateMutationExpression(assignment.expression, [], true);
        }
      }
    }
    return;
  }
  const validNames = new Set(plan.fields.map((field) => field.propertyName));
  const scopeFields = mutationScopeFields(plan);
  if (plan.kind === "update") {
    if (plan.set.length === 0) fail("UPDATE requires at least one assignment");
    for (const assignment of plan.set) {
      if (!validNames.has(assignment.propertyName))
        fail(
          `UPDATE column "${assignment.propertyName}" is not in the target table`,
        );
      validateMutationExpression(
        assignment.expression,
        [plan.scope],
        false,
        scopeFields,
      );
    }
  }
  validatePredicate(plan.where, [plan.scope], scopeFields);
}
