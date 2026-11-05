import { describe, expect, it } from "vitest";

import {
  aggregate,
  callFunction,
  constant,
  count,
  eq,
  filter,
  join,
  limit,
  neq,
  project,
  rowNumber,
  scan,
  sum,
  union,
  window,
} from "@/lib/db";
import type { AnyExpression, SqlExpression } from "@/lib/db/query/expression";
import {
  inspectTotalMaterializationSubtree,
  isMaterializationSafeAggregateExpression,
  isMaterializationSafeNode,
} from "@/lib/db/query/materialization-safety";
import {
  assertPhysicalSharedRelationInterfaceViewMatches,
  findPhysicalSharedRelationInterface,
  type PhysicalSharedRelationInterfaceView,
} from "@/lib/db/query/physical/shared-relation-interfaces";
import {
  lowerLogicalPlan,
  validatePhysicalQueryPlan,
} from "@/lib/db/query/physical-plan";
import type { LogicalQueryNode, Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

function repeatedWindowInput(): {
  readonly physical: ReturnType<typeof lowerLogicalPlan>;
  readonly sharedInput: Relation;
  readonly output: Relation;
} {
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
  const ascendingOutput = project(ascending, {
    siteId: ascending.columns.site_id!,
  });
  const descendingOutput = project(descending, {
    siteId: descending.columns.site_id!,
  });
  const output = union(ascendingOutput, descendingOutput, true);
  return { physical: lowerLogicalPlan(output), sharedInput, output };
}

function expectInvalidPlan(operation: () => unknown): void {
  try {
    operation();
    throw new Error("expected invalid_plan");
  } catch (error) {
    expect(error).toMatchObject({ code: "invalid_plan" });
  }
}

type AnyRelation = Relation<object, Readonly<Record<string, AnyExpression>>>;

function safeUnitSum(
  input: AnyRelation,
  value: SqlExpression = constant(1),
): boolean {
  return isMaterializationSafeAggregateExpression(
    sum(value as SqlExpression<number | null>),
    input,
  );
}

describe("validated physical shared-relation interfaces", () => {
  it("bounds unit SUM only through current finite relation shapes", () => {
    const unbounded = scan(schema.site_identities) as AnyRelation;
    const bounded = limit(unbounded, 20_001) as AnyRelation;
    const projected = project(bounded, {
      indicator: constant(1),
    }) as AnyRelation;
    const filtered = filter(
      projected,
      eq(projected.columns.indicator!, constant(1) as never),
    ) as AnyRelation;
    expect(safeUnitSum(filtered)).toBe(true);

    const scalarInput = aggregate(unbounded, {
      groupBy: {},
      aggregates: { rowCount: count() },
    }) as AnyRelation;
    const scalarProjection = project(scalarInput, {
      marker: constant(1),
    }) as AnyRelation;
    const scalarFilter = filter(
      scalarProjection,
      eq(scalarProjection.columns.marker!, constant(1) as never),
    ) as AnyRelation;
    const innerBounded = join(
      bounded,
      scalarFilter,
      eq(constant(1), constant(1)),
    ) as AnyRelation;
    const leftBounded = join(
      bounded,
      scalarFilter,
      eq(constant(1), constant(1)),
      "left",
    ) as AnyRelation;
    expect(safeUnitSum(innerBounded)).toBe(true);
    expect(safeUnitSum(leftBounded)).toBe(true);

    const multirowRight = join(
      bounded,
      unbounded,
      eq(constant(1), constant(1)),
    ) as AnyRelation;
    expect(safeUnitSum(unbounded)).toBe(false);
    expect(safeUnitSum(multirowRight)).toBe(false);
    expect(safeUnitSum(bounded, constant(2))).toBe(false);

    const offsetLimit = limit(unbounded, 8, 1) as AnyRelation;
    expect(safeUnitSum(offsetLimit)).toBe(false);
    const computedLimit = limit(unbounded, 8) as AnyRelation;
    Reflect.set(computedLimit.node, "count", callFunction("abs", constant(8)));
    expect(safeUnitSum(computedLimit)).toBe(false);

    const wrongScope = {
      ...projected,
      scope: { marker: Symbol("wrong-scope") },
    } as unknown as AnyRelation;
    expect(safeUnitSum(wrongScope)).toBe(false);
    const wrongFields = {
      ...projected,
      fields: projected.fields.map((field, index) =>
        index === 0 ? { ...field, name: "forged" } : field,
      ),
    } as AnyRelation;
    expect(safeUnitSum(wrongFields)).toBe(false);

    const cyclic = project(bounded, { indicator: constant(1) }) as AnyRelation;
    Reflect.set(cyclic.node, "input", {
      node: cyclic.node,
      scope: cyclic.scope,
      fields: cyclic.fields,
    });
    expect(safeUnitSum(cyclic)).toBe(false);
  });

  it("keeps finite row safety separate from full materialization permission", () => {
    const capped = limit(scan(schema.site_identities) as AnyRelation, 4);
    const input = project(capped, { indicator: constant(1) }) as AnyRelation;
    const summary = aggregate(input, {
      groupBy: {},
      aggregates: { units: sum(constant(1)) },
    }) as AnyRelation;

    expect(safeUnitSum(input)).toBe(true);
    expect(isMaterializationSafeNode(summary.node)).toBe(true);
    expect(
      inspectTotalMaterializationSubtree(summary.node, new Set()),
    ).toMatchObject({
      safe: false,
      blocker: capped.node as LogicalQueryNode,
      reason: "limit-barrier",
    });
  });

  it("only lets a shared producer read an earlier certified definition", () => {
    const first = repeatedWindowInput();
    const second = repeatedWindowInput();
    const physical = lowerLogicalPlan(union(first.output, second.output, true));
    const view = validatePhysicalQueryPlan(physical);
    const ordered = view.interfaces;
    expect(ordered.length).toBeGreaterThanOrEqual(2);
    const earlier = ordered[0]!;
    const later = ordered[ordered.length - 1]!;
    expect(
      findPhysicalSharedRelationInterface(
        view,
        later.definition.node,
        earlier.definition.node,
      ),
    ).toBeUndefined();
    expect(
      findPhysicalSharedRelationInterface(
        view,
        earlier.definition.node,
        later.definition.node,
      ),
    ).toBe(earlier);
    expect(
      findPhysicalSharedRelationInterface(
        view,
        later.definition.node,
        physical.root,
      ),
    ).toBe(later);
    expect(
      findPhysicalSharedRelationInterface(
        view,
        earlier.definition.node,
        scan(schema.site_identities).node,
      ),
    ).toBeUndefined();
  });

  it("returns only current materialized licenses and keeps auto boundaries unlicensed", () => {
    const { physical, sharedInput } = repeatedWindowInput();
    const interfaceView = validatePhysicalQueryPlan(physical);
    const materialized = physical.sharedRelations.find(
      ({ node }) => node === sharedInput.node,
    );

    expect(materialized?.materialization).toBe("materialized");
    const certified = interfaceView.interfaces.find(
      ({ definition }) => definition.node === sharedInput.node,
    );
    expect(certified).toMatchObject({
      boundary: { kind: "materialized-relation" },
      license: { kind: "strict-generic-facts" },
      selective: true,
      closure: { kind: "scope-and-exported-columns-closed" },
      totality: { kind: "checked-through-current-boundaries" },
    });
    expect(certified?.definition).toMatchObject({
      name: materialized?.name,
      node: sharedInput.node,
      scope: sharedInput.scope,
      fields: sharedInput.fields,
      dependencies: materialized?.dependencies,
      materialization: "materialized",
    });
    expect(interfaceView.analysis).toMatchObject({
      sharedGraphPasses: 1,
      materializedBoundaryPasses: 2,
      materializedDefinitionsChecked:
        2 *
        physical.sharedRelations.filter(
          ({ materialization }) => materialization === "materialized",
        ).length,
    });
    expect(
      findPhysicalSharedRelationInterface(
        interfaceView,
        sharedInput.node,
        physical.root,
      ),
    ).toBe(certified);
    expect(
      findPhysicalSharedRelationInterface(
        interfaceView,
        sharedInput.node,
        sharedInput.node,
      ),
    ).toBeUndefined();
    expect(
      findPhysicalSharedRelationInterface(
        {
          root: physical.root,
          layout: [],
          interfaces: [{ definition: { node: sharedInput.node } }],
          unlicensed: [],
          analysis: {
            sharedGraphPasses: 1,
            materializedBoundaryPasses: 1,
            materializedDefinitionsChecked: 0,
          },
        } as unknown as PhysicalSharedRelationInterfaceView,
        sharedInput.node,
        physical.root,
      ),
    ).toBeUndefined();

    const autoDefinitions = physical.sharedRelations.filter(
      ({ materialization }) => materialization === "auto",
    );
    for (const definition of autoDefinitions) {
      expect(
        interfaceView.interfaces.some(
          ({ definition: candidate }) => candidate.node === definition.node,
        ),
      ).toBe(false);
      expect(interfaceView.unlicensed).toContainEqual(
        expect.objectContaining({
          definition: expect.objectContaining({
            node: definition.node,
            materialization: "auto",
          }),
          reason: "automatic-materialization-is-not-a-license",
        }),
      );
    }

    const identities = scan(schema.site_identities);
    const autoInput = filter(
      identities,
      neq(identities.columns.site_id!, constant("ignored")),
    );
    const autoLeft = project(autoInput, {
      siteId: autoInput.columns.site_id!,
    });
    const autoRight = project(autoInput, {
      siteId: autoInput.columns.site_id!,
    });
    const autoPhysical = lowerLogicalPlan(union(autoLeft, autoRight, true));
    const autoDefinition = autoPhysical.sharedRelations.find(
      ({ node }) => node === autoInput.node,
    );
    expect(autoDefinition?.materialization).toBe("auto");
    const autoView = validatePhysicalQueryPlan(autoPhysical);
    expect(
      autoView.interfaces.some(
        ({ definition }) => definition.node === autoInput.node,
      ),
    ).toBe(false);
    expect(autoView.unlicensed).toContainEqual(
      expect.objectContaining({
        definition: expect.objectContaining({
          node: autoInput.node,
          materialization: "auto",
        }),
        reason: "automatic-materialization-is-not-a-license",
      }),
    );
  });

  it("revalidates the exact ordered layout and rejects malformed metadata", () => {
    const { physical, sharedInput } = repeatedWindowInput();
    const interfaceView = validatePhysicalQueryPlan(physical);
    const definitionIndex = physical.sharedRelations.findIndex(
      ({ node }) => node === sharedInput.node,
    );
    const definition = physical.sharedRelations[definitionIndex];
    expect(definition).toBeDefined();
    if (!definition) throw new Error("fixture must have a shared input");

    const forged = (
      replacement: typeof definition | null,
      replacementIndex = definitionIndex,
    ) => {
      const sharedRelations = [...physical.sharedRelations];
      if (replacement === null)
        Reflect.deleteProperty(sharedRelations, replacementIndex);
      else sharedRelations[replacementIndex] = replacement;
      return { ...physical, sharedRelations };
    };
    const reject = (plan: unknown) =>
      expectInvalidPlan(() =>
        validatePhysicalQueryPlan(plan as typeof physical),
      );

    reject(forged({ ...definition, name: `${definition.name}_forged` }));
    reject(forged({ ...definition, scope: Symbol("wrong-scope") as never }));
    reject(
      forged({
        ...definition,
        fields: [
          { ...definition.fields[0]!, name: "forged-field" },
          ...definition.fields.slice(1),
        ],
      }),
    );
    const sparseFields = [...definition.fields];
    delete sparseFields[0];
    reject(forged({ ...definition, fields: sparseFields }));
    reject(forged({ ...definition, materialization: "auto" }));
    reject(
      forged({
        ...definition,
        dependencies: [...definition.dependencies, "forged-dependency"],
      }),
    );
    reject(forged({ ...definition, dependencies: new Array<string>(1) }));
    if (definition.dependencies.length > 0) {
      reject(forged({ ...definition, dependencies: [] }));
      if (definition.dependencies.length > 1)
        reject(
          forged({
            ...definition,
            dependencies: [...definition.dependencies].reverse(),
          }),
        );
    }
    reject(forged(null));

    const sparseDefinitions = [...physical.sharedRelations];
    Reflect.deleteProperty(sparseDefinitions, definitionIndex);
    reject({ ...physical, sharedRelations: sparseDefinitions });

    let definitionAccessorRead = false;
    const accessorDefinitions = [...physical.sharedRelations];
    Object.defineProperty(accessorDefinitions, definitionIndex, {
      get: () => {
        definitionAccessorRead = true;
        throw new Error("shared definition accessor must not run");
      },
    });
    reject({ ...physical, sharedRelations: accessorDefinitions });
    expect(definitionAccessorRead).toBe(false);

    const nonObjectDefinitions = [...physical.sharedRelations] as unknown[];
    nonObjectDefinitions[definitionIndex] = null;
    reject({ ...physical, sharedRelations: nonObjectDefinitions });

    let fieldAccessorRead = false;
    const accessorFields = [...definition.fields];
    Object.defineProperty(accessorFields, 0, {
      get: () => {
        fieldAccessorRead = true;
        throw new Error("shared field accessor must not run");
      },
    });
    reject(forged({ ...definition, fields: accessorFields }));
    expect(fieldAccessorRead).toBe(false);

    const accessorPlan = { ...physical };
    Object.defineProperty(accessorPlan, "sharedRelations", {
      get: () => {
        throw new Error("shared relation accessor must not run");
      },
    });
    reject(accessorPlan);

    expectInvalidPlan(() =>
      assertPhysicalSharedRelationInterfaceViewMatches(
        interfaceView,
        physical.root,
        sparseDefinitions,
      ),
    );
  });

  it("does not retain a certificate from a failed validation", () => {
    const { physical, sharedInput } = repeatedWindowInput();
    const beforeFailure = validatePhysicalQueryPlan(physical);
    const invalid = { ...physical, sharedRelations: [] };

    expectInvalidPlan(() => validatePhysicalQueryPlan(invalid));

    const afterFailure = validatePhysicalQueryPlan(physical);
    expect(afterFailure).not.toBe(beforeFailure);
    expect(
      afterFailure.interfaces.some(
        ({ definition }) => definition.node === sharedInput.node,
      ),
    ).toBe(true);
  });

  it("does not expose a proof for a changed mutable definition snapshot", () => {
    const { physical, sharedInput } = repeatedWindowInput();
    const interfaceView = validatePhysicalQueryPlan(physical);
    const definition = physical.sharedRelations.find(
      ({ node }) => node === sharedInput.node,
    );
    expect(definition).toBeDefined();
    if (!definition) throw new Error("fixture must have a shared input");
    const originalName = definition.name;
    (definition as { name: string }).name = `${originalName}_changed`;
    try {
      expectInvalidPlan(() =>
        assertPhysicalSharedRelationInterfaceViewMatches(
          interfaceView,
          physical.root,
          physical.sharedRelations,
        ),
      );
      expectInvalidPlan(() => validatePhysicalQueryPlan(physical));
    } finally {
      (definition as { name: string }).name = originalName;
    }
    expect(
      validatePhysicalQueryPlan(physical).interfaces.length,
    ).toBeGreaterThan(0);
  });
});
