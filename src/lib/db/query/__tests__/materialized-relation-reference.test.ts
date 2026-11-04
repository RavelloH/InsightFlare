import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  constant,
  filter,
  neq,
  project,
  rowNumber,
  scan,
  union,
  window,
} from "@/lib/db";
import {
  compileD1QueryUnoptimizedForTest,
  compileD1QueryWithFinalRenderForTest,
} from "@/lib/db/query/compiler";
import {
  lowerLogicalPlan,
  validatePhysicalQueryPlan,
} from "@/lib/db/query/physical-plan";
import type { QuerySource } from "@/lib/db/query/plan";
import { renderMaterializedRelationReference } from "@/lib/db/query/render/materialized-relation-reference";
import { schema } from "@/lib/db/schema";
import { parameter, text } from "@/lib/db/sql/fragment";

function repeatedWindowInput() {
  const identities = scan(schema.site_identities);
  const sharedInput = filter(
    identities,
    neq(identities.columns.site_id!, constant("ignored")),
  );
  const ascending = window(sharedInput, {
    rank: rowNumber({
      orderBy: [{ expression: sharedInput.columns.site_pk!, direction: "ASC" }],
    }),
  });
  const descending = window(sharedInput, {
    rank: rowNumber({
      orderBy: [
        { expression: sharedInput.columns.site_pk!, direction: "DESC" },
      ],
    }),
  });
  const output = union(
    project(ascending, { siteId: ascending.columns.site_id! }),
    project(descending, { siteId: descending.columns.site_id! }),
    true,
  );
  return { sharedInput, output, physical: lowerLogicalPlan(output) };
}

describe("licensed direct materialized FROM references", () => {
  it("emits the current licensed CTE from the production renderer and keeps result rows", () => {
    const { output, physical } = repeatedWindowInput();
    const definition = physical.sharedRelations.find(
      ({ node }) => node.kind === "filter",
    );
    expect(definition?.materialization).toBe("materialized");
    const compiled = compileD1QueryWithFinalRenderForTest(output);
    const shape = compiled.query.physicalPlanShape;
    expect(compiled.finalRender.query).toBe(compiled.query);
    expect(compiled.query.sql).toMatch(/FROM _d1_shared_\d+ AS [qlrt]\d+/u);
    expect(shape?.version).toBe(12);
    expect(
      shape?.version === 12 ? shape.directMaterializedReferenceCount : 0,
    ).toBeGreaterThan(0);
    expect(
      compiled.finalRender.emissionCounts.materializedReferences.size,
    ).toBeGreaterThan(0);
    if (shape?.version !== 12)
      throw new Error("materialized_v12_shape_missing");
    const emittedReferences = [
      ...compiled.finalRender.emissionCounts.materializedReferences.values(),
    ];
    expect(shape.directMaterializedReferenceCount).toBe(
      emittedReferences.length,
    );
    expect(
      shape.directMaterializedReferences.reduce(
        (count, reference) => count + reference.emissionCount,
        0,
      ),
    ).toBe(
      emittedReferences.reduce(
        (count, reference) => count + reference.emissionCount,
        0,
      ),
    );

    const database = new DatabaseSync(":memory:");
    try {
      database.exec(
        "CREATE TABLE site_identities (site_pk INTEGER, site_id TEXT);" +
          "INSERT INTO site_identities VALUES " +
          "(1, 'alpha'), (2, 'beta'), (2, 'beta-copy'), (3, NULL)",
      );
      const actual = database
        .prepare(compiled.query.sql)
        .all(...(compiled.query.bindings as SQLInputValue[]));
      const original = compileD1QueryUnoptimizedForTest(output);
      const expected = database
        .prepare(original.sql)
        .all(...(original.bindings as SQLInputValue[]));
      expect(actual).toEqual(expected);
    } finally {
      database.close();
    }
  });

  it("falls back for stale source metadata, unlicensed, self, or bound children", () => {
    const { sharedInput, physical } = repeatedWindowInput();
    const interfaces = validatePhysicalQueryPlan(physical);
    const definition = physical.sharedRelations.find(
      ({ node }) => node === sharedInput.node,
    )!;
    const source: QuerySource = {
      node: sharedInput.node,
      scope: sharedInput.scope,
      fields: sharedInput.fields,
    };
    const render = (
      overrides: Partial<
        Parameters<typeof renderMaterializedRelationReference>[0]
      > = {},
    ) =>
      renderMaterializedRelationReference({
        source,
        producer: null,
        interfaces,
        definitionName: definition.name,
        sourceSql: text("SELECT 1"),
        alias: "q0",
        ...overrides,
      });

    expect(render().text).toBe(`${definition.name} AS q0`);
    expect(render({ producer: sharedInput.node }).text).toBe(
      "(SELECT 1) AS q0",
    );
    expect(render({ definitionName: `${definition.name}_stale` }).text).toBe(
      "(SELECT 1) AS q0",
    );
    expect(render({ sourceSql: parameter(42) }).text).toBe("(?) AS q0");
    const autoDefinition = {
      ...definition,
      materialization: "auto" as const,
    };
    expect(
      render({
        interfaces: {
          ...interfaces,
          layout: interfaces.layout.map((candidate) =>
            candidate.node === definition.node ? autoDefinition : candidate,
          ),
        },
      }).text,
    ).toBe("(SELECT 1) AS q0");
    expect(
      render({
        interfaces: {
          ...interfaces,
          interfaces: interfaces.interfaces.filter(
            (candidate) => candidate.definition.node !== definition.node,
          ),
        },
      }).text,
    ).toBe("(SELECT 1) AS q0");
    const futureDefinition = {
      ...definition,
      node: physical.root,
      scope: physical.root.scope,
      fields: physical.root.fields,
    };
    expect(
      render({
        producer: physical.root,
        interfaces: {
          ...interfaces,
          layout: [futureDefinition, definition],
        },
      }).text,
    ).toBe("(SELECT 1) AS q0");
    expect(
      render({
        interfaces: validatePhysicalQueryPlan(
          lowerLogicalPlan(repeatedWindowInput().output),
        ),
      }).text,
    ).toBe("(SELECT 1) AS q0");
    expect(
      render({
        source: {
          ...source,
          scope: scan(schema.site_identities).scope,
        } as QuerySource,
      }).text,
    ).toBe("(SELECT 1) AS q0");
    expect(
      render({
        source: { ...source, fields: source.fields.slice(1) } as QuerySource,
      }).text,
    ).toBe("(SELECT 1) AS q0");
  });
});
