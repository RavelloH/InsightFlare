import { describe, expect, it } from "vitest";

import {
  deleteFrom,
  eq,
  excluded,
  insert,
  insertFromQuery,
  onConflictDoUpdate,
  param,
  scan,
  update,
} from "@/lib/db";
import type { MutationNode } from "@/lib/db/mutation/plan";
import { validateMutationPlan } from "@/lib/db/mutation/validator";
import { DatabaseCompilerError } from "@/lib/db/query/errors";
import { parameterExpression } from "@/lib/db/query/expression";
import { schema } from "@/lib/db/schema";
import type { SqlBinding } from "@/lib/db/types";
import { mutationResultContract, unsafeRawMutation } from "@/lib/db/unsafe";

describe("mutation result contracts", () => {
  it("describes results for explicitly supplied raw mutations", () => {
    const contract = mutationResultContract("Rows changed by the update");
    expect(contract).toEqual({
      kind: "mutation-result",
      description: "Rows changed by the update",
    });

    expect(
      unsafeRawMutation("UPDATE users SET active = ?", [1], contract),
    ).toEqual({
      sql: "UPDATE users SET active = ?",
      bindings: [1],
      kind: "mutation",
      resultContract: contract,
    });
  });
});

function expectInvalid(plan: MutationNode): void {
  expect(() => validateMutationPlan(plan)).toThrowError(DatabaseCompilerError);
}

describe("mutation plan validation", () => {
  it("rejects invalid insert sources, columns, and value shapes", () => {
    const valid = insert(schema.site_identities, { site_id: "site-a" });
    expectInvalid({
      ...valid,
      source: { ...scan(schema.users) },
    } as unknown as MutationNode);
    expectInvalid({
      ...valid,
      rows: undefined,
      source: undefined,
    } as unknown as MutationNode);
    expectInvalid({
      ...valid,
      columns: ["site_id", "site_id"],
    } as unknown as MutationNode);
    expectInvalid({
      ...valid,
      columns: ["missing"],
    } as unknown as MutationNode);
    expectInvalid({
      ...valid,
      rows: [[parameterExpression("a"), parameterExpression("b")]],
    } as unknown as MutationNode);
    expectInvalid({
      ...valid,
      rows: [[{ kind: "excluded", name: "site_id" }]],
    } as unknown as MutationNode);
    expectInvalid({
      ...valid,
      rows: [[parameterExpression({} as SqlBinding)]],
    } as unknown as MutationNode);

    const query = scan(schema.users);
    const fromQuery = insertFromQuery(
      schema.site_identities,
      ["site_id"],
      query,
    );
    expectInvalid(fromQuery);
    expectInvalid({
      ...valid,
      table: { ...schema.site_identities },
    } as unknown as MutationNode);
  });

  it("checks conflict targets and update assignments", () => {
    const valid = insert(schema.site_identities, { site_id: "site-a" });
    expectInvalid({ ...valid, conflict: { target: [], action: "nothing" } });
    expectInvalid({
      ...valid,
      conflict: { target: ["missing"], action: "nothing" },
    });
    expectInvalid({
      ...valid,
      conflict: { target: ["site_id"], action: "update", set: [] },
    });
    expectInvalid({
      ...valid,
      conflict: {
        target: ["site_id"],
        action: "update",
        set: [
          { propertyName: "missing", expression: parameterExpression("x") },
        ],
      },
    });

    const validConflict = onConflictDoUpdate(valid, ["site_id"], {
      site_id: excluded(schema.site_identities.columns.site_id),
    });
    expect(() => validateMutationPlan(validConflict)).not.toThrow();
  });

  it("checks update assignments and visible target scopes", () => {
    const valid = update(schema.site_identities, (columns) => ({
      set: { site_id: "next" },
      where: eq(columns.site_pk, param(1)),
    }));
    expectInvalid({ ...valid, set: [] });
    expectInvalid({
      ...valid,
      set: [{ propertyName: "missing", expression: parameterExpression("x") }],
    });

    const other = scan(schema.site_identities);
    const outside = update(schema.site_identities, (columns) => ({
      set: { site_id: "next" },
      where: eq(columns.site_pk, other.columns.site_pk),
    }));
    expectInvalid(outside);

    const outsideDelete = deleteFrom(schema.site_identities, (columns) =>
      eq(columns.site_pk, other.columns.site_pk),
    );
    expectInvalid(outsideDelete);
  });
});
