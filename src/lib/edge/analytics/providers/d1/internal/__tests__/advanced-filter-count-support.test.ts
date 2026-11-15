import { describe, expect, it } from "vitest";

import type { SiteId } from "@/lib/edge/analytics/contract/types";
import { buildAdvancedCountFilterMatchPlan } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import {
  classifyAdvancedCountFilter,
  classifyAdvancedEventCandidateCountFilter,
} from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import {
  analyticsFilterRegistry,
  analyzeFilterDocument,
  parseFilterDsl,
} from "@/lib/filter-contract";
import type { FilterDocument } from "@/lib/filter-contract/filters";

function classify(source: string, scope: "session" | "visitor" = "session") {
  return classifyAdvancedCountFilter(
    parseFilterDsl(source, analyticsFilterRegistry),
    scope,
  );
}

describe("advanced count SQL capability preflight", () => {
  it("keeps the default Event gate closed and admits only the narrow candidate Count slice", () => {
    const document = parseFilterDsl(
      'count(event { event.name eq "purchase" }) eq 1 AND (page.path eq "/pricing" OR NOT event.name eq "internal")',
      analyticsFilterRegistry,
    );
    expect(classifyAdvancedCountFilter(document, "event")).toMatchObject({
      kind: "unsupported",
      code: "count_sql_requires_session_or_visitor_scope",
    });
    expect(classifyAdvancedEventCandidateCountFilter(document)).toMatchObject({
      kind: "supported",
      code: "supported_event_candidate_count_sql",
    });
    for (const source of [
      'page.path eq "/pricing"',
      "sum(page.durationMs) gt 0 AND count(event) gte 1",
      'count(event { event.payload("/kind") eq "purchase" }) eq 1',
      'count(session { event.name eq "purchase" }) eq 1',
      'count(event) eq 1 AND sequence([event { event.name eq "first" }, event { event.name eq "second" }]) exists',
    ])
      expect(
        classifyAdvancedEventCandidateCountFilter(
          parseFilterDsl(source, analyticsFilterRegistry),
        ),
        source,
      ).toMatchObject({ kind: "unsupported" });
  });

  it("supports the complete boolean and arithmetic count tree", () => {
    expect(
      classify(
        "count(page) gte 1 AND NOT (div(count(event), count(page)) eq 0.5 OR count(event) isNull)",
      ),
    ).toMatchObject({ kind: "supported", code: "supported_count_sql" });
  });

  it("accepts legal Visitor-scoped counts and keeps payload numeric-proof mixes on whole-tree fallback", () => {
    expect(classify("count(event) gte 1", "visitor")).toMatchObject({
      kind: "supported",
      code: "supported_count_sql",
    });
    expect(
      classify(
        'count(event { event.payload("/tier") eq "gold" }) eq 1 AND sum(page.durationMs) gte 0',
      ),
    ).toMatchObject({
      kind: "unsupported",
      path: "root",
      code: "count_sql_payload_numeric_proof_unsupported",
    });
  });

  it("uses explicit numeric-value nodes for Filter count arithmetic", () => {
    for (const expression of [
      "add(count(page), div(count(event), count(page))) gt 2",
      "sub(count(page), div(count(event), count(page))) eq 1.5",
      "mul(div(count(event), count(page)), div(count(event), count(page))) eq 0.25",
    ])
      expect(classify(expression)).toMatchObject({
        kind: "supported",
        code: "supported_count_sql",
      });

    for (const expression of [
      "add(div(count(event), count(page)), div(count(event), count(page))) eq 1",
      "mul(count(page), div(count(event), count(page))) eq 1",
    ])
      expect(classify(expression)).toMatchObject({
        kind: "supported",
        code: "supported_count_sql",
      });
  });

  it("supports numeric set membership and closed count ranges", () => {
    for (const expression of [
      "count(page) in [0, 2, 2]",
      "count(page) notIn [0, 1]",
      "count(page) in [null]",
      "count(page) notIn [null]",
      "div(count(event), count(page)) in [0.5, 0.25]",
      "sub(count(event), count(page)) in [-1, -0]",
      "count(page) between [2, 2]",
    ])
      expect(classify(expression)).toMatchObject({
        kind: "supported",
        code: "supported_count_sql",
      });
  });

  it("preserves invalid set and range errors and keeps unsupported trees whole", () => {
    expect(() =>
      parseFilterDsl("count(page) in []", analyticsFilterRegistry),
    ).toThrow(/invalid_set/u);
    expect(() =>
      parseFilterDsl("count(page) in [null, 2]", analyticsFilterRegistry),
    ).toThrow(/heterogeneous_set_values/u);
    expect(() =>
      parseFilterDsl("count(page) between [3, 1]", analyticsFilterRegistry),
    ).toThrow(/reversed_range/u);
    expect(() =>
      parseFilterDsl("count(page) between [1]", analyticsFilterRegistry),
    ).toThrow(/invalid_range/u);
    expect(() =>
      parseFilterDsl("count(page) in [1e309]", analyticsFilterRegistry),
    ).toThrow();
    expect(() => classify('count(page) in ["2"]')).toThrow(
      /condition_type_mismatch/u,
    );
    expect(
      classify("count(page) in [0, 2] AND countDistinct(page) gte 0"),
    ).toMatchObject({
      kind: "unsupported",
      path: "root.children[1].target",
    });

    const nonfiniteDocument = {
      version: 1,
      root: {
        kind: "condition",
        target: {
          kind: "reducer",
          reducer: "count",
          input: { kind: "entity-root", entity: "page" },
        },
        operator: "in",
        value: [Number.POSITIVE_INFINITY],
      },
    } as unknown as FilterDocument;
    expect(
      classifyAdvancedCountFilter(nonfiniteDocument, "session"),
    ).toMatchObject({ kind: "unsupported" });
  });

  it("supports a root bare field alongside count predicates", () => {
    expect(
      classify('count(event) gte 1 AND page.path eq "/pricing"'),
    ).toMatchObject({ kind: "supported", code: "supported_count_sql" });
  });

  it("keeps Geo closed by default and accepts only qualified ASCII country/region eq/in", () => {
    const supportedPrivate = (source: string) =>
      classifyAdvancedCountFilter(
        parseFilterDsl(source, analyticsFilterRegistry),
        "session",
        { allowPrivateQualifiedGeoBareFields: true },
      );

    expect(classify('geo.country eq "US"')).toMatchObject({
      kind: "unsupported",
      code: "count_sql_bare_field_requires_registered_string",
    });
    for (const expression of [
      'geo.country eq "US"',
      'geo.region in ["CA", "NY"]',
      'NOT (geo.country eq "US" OR geo.region eq "CA")',
    ])
      expect(supportedPrivate(expression)).toMatchObject({
        kind: "supported",
        code: "supported_count_sql",
      });
    for (const expression of [
      'geo.country neq "US"',
      'geo.region notIn ["CA"]',
      'geo.city eq "Oakland"',
      'geo.country eq "日本"',
    ])
      expect(supportedPrivate(expression)).toMatchObject({
        kind: "unsupported",
      });
  });

  it("supports registered root bare string fields with their existing operators", () => {
    const fields = [
      "page.path",
      "page.title",
      "page.query",
      "page.hash",
      "event.name",
    ];
    const conditions = [
      (field: string) => `${field} eq "x"`,
      (field: string) => `${field} neq "x"`,
      (field: string) => `${field} in ["x", "y"]`,
      (field: string) => `${field} notIn ["x", "y"]`,
      (field: string) => `${field} contains "x"`,
      (field: string) => `${field} startsWith "x"`,
      (field: string) => `${field} endsWith "x"`,
      (field: string) => `${field} isNull`,
      (field: string) => `${field} notNull`,
      (field: string) => `${field} exists`,
      (field: string) => `${field} notExists`,
      (field: string) => `${field} isEmpty`,
      (field: string) => `${field} notEmpty`,
    ];

    for (const field of fields)
      for (const condition of conditions)
        expect(
          classify(condition(field)),
          `${field}: ${condition(field)}`,
        ).toMatchObject({ kind: "supported", code: "supported_count_sql" });

    expect(
      classify(
        'page.path eq "/pricing" AND count(page { page.path eq "/pricing" }) eq 0',
      ),
    ).toMatchObject({ kind: "supported", code: "supported_count_sql" });
  });

  it("rejects unsupported root bare fields", () => {
    expect(classify('page.hostname eq "example.test"')).toMatchObject({
      kind: "unsupported",
      path: "root.target",
      code: "count_sql_bare_field_requires_registered_string",
    });
  });

  it("supports bare Page numeric comparisons and derives Event-owner proof", () => {
    for (const field of [
      "page.durationMs",
      "performance.ttfbMs",
      "performance.fcpMs",
      "performance.lcpMs",
      "performance.cls",
      "performance.inpMs",
    ]) {
      for (const operator of [
        "eq 5",
        "neq 5",
        "gt 5",
        "gte 5",
        "lt 5",
        "lte 5",
        "in [1, 5]",
        "notIn [1, 5]",
        "between [1, 5]",
      ])
        expect(
          classify(`${field} ${operator}`),
          `${field} ${operator}`,
        ).toMatchObject({
          kind: "supported",
          numericCompatibilityFieldIds: [field],
          numericCompatibilityRequirements: [
            { fieldId: field, domain: "page-and-event" },
          ],
        });

      for (const operator of ["isNull", "notNull", "exists", "notExists"])
        expect(
          classify(`${field} ${operator}`),
          `${field} ${operator}`,
        ).toMatchObject({
          kind: "supported",
          numericCompatibilityFieldIds: [],
          numericCompatibilityRequirements: [],
        });
    }

    expect(
      classify(
        "page.durationMs gt 5 AND count(page { page.durationMs gt 1 }) eq 0",
      ),
    ).toMatchObject({
      kind: "supported",
      numericCompatibilityRequirements: [
        { fieldId: "page.durationMs", domain: "page-and-event" },
      ],
    });
  });

  it("supports only the finite Page numeric scalar count slice", () => {
    const numericScalars = [
      ["page.durationMs", "durationMs"],
      ["page.performance.ttfbMs", "performance.ttfbMs"],
      ["page.performance.fcpMs", "performance.fcpMs"],
      ["page.performance.lcpMs", "performance.lcpMs"],
      ["page.performance.cls", "performance.cls"],
      ["page.performance.inpMs", "performance.inpMs"],
    ] as const;

    for (const [scalar, selectorMember] of numericScalars) {
      for (const reducer of [
        "count",
        "countDistinct",
        "min",
        "max",
        "sum",
        "avg",
      ])
        expect(
          classify(`${reducer}(${scalar}) eq 2`),
          `${reducer}(${scalar})`,
        ).toMatchObject({
          kind: "supported",
          code: "supported_count_sql",
        });
      for (const reducer of ["min", "max"])
        expect(classify(`${reducer}(${scalar}) eq 2`)).toMatchObject({
          kind: "supported",
          numericCompatibilityRequirements: [
            {
              fieldId:
                selectorMember === "durationMs"
                  ? "page.durationMs"
                  : selectorMember,
              domain: "page-only",
            },
          ],
        });
      for (const reducer of ["sum", "avg"])
        expect(classify(`${reducer}(${scalar}) eq 2`)).toMatchObject({
          kind: "supported",
          numericCompatibilityRequirements: [
            {
              fieldId:
                selectorMember === "durationMs"
                  ? "page.durationMs"
                  : selectorMember,
              domain: "page-only",
              proof: "exact-aggregate",
            },
          ],
        });
      expect(
        classify(
          `count(page { page.path eq "/selected" }.${selectorMember}) eq 2`,
        ),
      ).toMatchObject({ kind: "supported", code: "supported_count_sql" });
      expect(
        classify(
          `countDistinct(page { page.path eq "/selected" }.${selectorMember}) eq 2`,
        ),
      ).toMatchObject({ kind: "supported", code: "supported_count_sql" });
      for (const reducer of ["min", "max"])
        expect(
          classify(
            `${reducer}(page { page.path eq "/selected" }.${selectorMember}) eq 2`,
          ),
          `${reducer} selector ${selectorMember}`,
        ).toMatchObject({ kind: "supported", code: "supported_count_sql" });
      for (const reducer of ["sum", "avg"])
        expect(
          classify(
            `${reducer}(page { page.path eq "/selected" }.${selectorMember}) eq 2`,
          ),
          `${reducer} selector ${selectorMember}`,
        ).toMatchObject({ kind: "supported", code: "supported_count_sql" });
    }

    for (const expression of [
      "count(page.durationMs) eq 2",
      "countDistinct(page.durationMs) eq 2",
      "countDistinct(page.performance.cls) eq 2",
      'count(page { page.path eq "/selected" }.durationMs) eq 1',
      'countDistinct(page { page.path eq "/selected" }.performance.cls) eq 2',
      "countDistinct(page { page.durationMs gt 1 }.durationMs) eq 2",
    ])
      expect(classify(expression), expression).toMatchObject({
        kind: "supported",
        code: "supported_count_sql",
      });

    expect(classify("count(page.durationMs) eq 2")).toMatchObject({
      kind: "supported",
      numericCompatibilityRequirements: [],
    });
    expect(classify("countDistinct(page.durationMs) eq 2")).toMatchObject({
      kind: "supported",
      numericCompatibilityRequirements: [
        { fieldId: "page.durationMs", domain: "page-only" },
      ],
    });
    expect(
      classify("count(page { page.durationMs gt 1 }.durationMs) eq 1"),
    ).toMatchObject({
      kind: "supported",
      numericCompatibilityRequirements: [
        { fieldId: "page.durationMs", domain: "page-only" },
      ],
    });

    for (const expression of [
      "min(page.durationMs) eq 2.5",
      "max(page.performance.ttfbMs) gte 3",
      "min(page { page.durationMs gt 1 }.durationMs) eq 2.5",
      'max(page { page.path eq "/selected" }.performance.cls) lte 0.75',
      "add(min(page.durationMs), count(page)) gt 0",
    ])
      expect(classify(expression), expression).toMatchObject({
        kind: "supported",
        code: "supported_count_sql",
      });

    for (const expression of [
      "min(page.durationMs) eq 2.5",
      "max(page { page.durationMs gt 1 }.durationMs) eq 2.5",
    ])
      expect(classify(expression), expression).toMatchObject({
        kind: "supported",
        numericCompatibilityRequirements: [
          { fieldId: "page.durationMs", domain: "page-only" },
        ],
      });

    expect(
      classify("min(page.durationMs) eq -5 AND max(page.durationMs) eq 2.5"),
    ).toMatchObject({ kind: "supported", code: "supported_count_sql" });
    expect(
      classify("min(page.durationMs) eq 2 AND page.durationMs gt 1"),
    ).toMatchObject({
      kind: "supported",
      numericCompatibilityRequirements: [
        { fieldId: "page.durationMs", domain: "page-and-event" },
      ],
    });

    expect(
      classify("sum(page.durationMs) eq 2 AND page.durationMs gt 1"),
    ).toMatchObject({
      kind: "supported",
      numericCompatibilityRequirements: [
        {
          fieldId: "page.durationMs",
          domain: "page-and-event",
          proof: "exact-aggregate",
        },
      ],
    });
    expect(
      classify("div(count(page), avg(page.durationMs)) eq 1"),
    ).toMatchObject({
      kind: "unsupported",
      code: "count_sql_unbounded_division",
    });

    expect(
      classify("div(count(page), min(page.durationMs)) eq 1"),
    ).toMatchObject({
      kind: "unsupported",
      code: "count_sql_unbounded_division",
    });

    for (const expression of [
      "countDistinct(page) eq 1",
      "countDistinct(page.path) eq 1",
      "countDistinct(page.title) eq 1",
      'min(event.payload("/amount")) isNull',
      "max(page.path) isNull",
      'countDistinct(event { event.name eq "purchase" }.payload("/amount")) eq 1',
    ])
      expect(classify(expression), expression).toMatchObject({
        kind: "unsupported",
      });
  });

  it("counts finite Page and Event string members without numeric proofs", () => {
    const expressions = [
      "count(page.path) eq 2",
      "count(page.title) eq 2",
      "count(page.query) eq 2",
      "count(page.hash) eq 2",
      "count(event.name) eq 2",
      'count(page { page.path eq "/selected" }.hash) eq 2',
      'count(event { event.name eq "purchase" }.name) eq 2',
    ];

    for (const expression of expressions)
      expect(classify(expression), expression).toMatchObject({
        kind: "supported",
        code: "supported_count_sql",
      });

    for (const expression of [
      "count(page.path) eq 2",
      'count(page { page.path eq "/selected" }.hash) eq 2',
      'count(event { event.name eq "purchase" }.name) eq 2',
    ])
      expect(classify(expression), expression).toMatchObject({
        numericCompatibilityRequirements: [],
      });

    expect(
      classify("count(page { page.durationMs gt 5 }.path) eq 1"),
    ).toMatchObject({
      kind: "supported",
      numericCompatibilityRequirements: [
        { fieldId: "page.durationMs", domain: "page-only" },
      ],
    });

    for (const expression of [
      "countDistinct(page.path) eq 1",
      'min(page.title) eq "x"',
      'max(event.name) eq "x"',
    ])
      expect(classify(expression), expression).toMatchObject({
        kind: "unsupported",
      });
    expect(() => classify("sum(page.query) eq 1")).toThrow();
    expect(() => classify("avg(page.hash) eq 1")).toThrow();
  });

  it("lowers finite collection presence with the shared count contract", () => {
    const expressions = [
      "page exists",
      "page notExists",
      "event exists",
      "event notExists",
      'page { page.path eq "/selected" } exists',
      'page { page.path eq "/selected" } notExists',
      'page { page.path eq "/selected" }.path exists',
      'page { page.path eq "/selected" }.hash notExists',
      'event { event.name eq "purchase" } exists',
      'event { event.name eq "purchase" }.name notExists',
      'NOT (page { page.path eq "/selected" }.path exists)',
    ];

    for (const expression of expressions)
      expect(classify(expression), expression).toMatchObject({
        kind: "supported",
        code: "supported_count_sql",
      });

    expect(classify("page { page.durationMs gt 5 }.path exists")).toMatchObject(
      {
        kind: "supported",
        numericCompatibilityRequirements: [
          { fieldId: "page.durationMs", domain: "page-only" },
        ],
      },
    );

    expect(
      classify(
        "sum(page.durationMs) eq 10 AND page.durationMs gt 1 AND page { page.durationMs gt 5 }.path exists",
      ),
    ).toMatchObject({
      kind: "supported",
      numericCompatibilityRequirements: [
        {
          fieldId: "page.durationMs",
          domain: "page-and-event",
          proof: "exact-aggregate",
        },
      ],
    });

    expect(() => classify("page isEmpty")).toThrow();
    expect(() => classify("event notEmpty")).toThrow();
    for (const expression of [
      'page { page.path eq "/selected" }.path isEmpty',
      'event { event.name eq "purchase" }.name notEmpty',
    ])
      expect(classify(expression), expression).toMatchObject({
        kind: "unsupported",
      });
  });

  it("requires the derived exact proof profile for sum and average plans", () => {
    const document = parseFilterDsl(
      "sum(page.durationMs) eq 2 AND avg(page.durationMs) eq 1",
      analyticsFilterRegistry,
    );
    const analysis = analyzeFilterDocument(document, analyticsFilterRegistry);
    const siteId = "site-advanced-count-proof-api" as SiteId;
    const common = {
      subject: createSemanticSubjectDomain({
        origin: "site",
        siteIds: [siteId],
      }),
      candidateRange: { startMs: 0, endExclusiveMs: 100 },
      readRange: { startMs: 0, endExclusiveMs: 100 },
      expressionRange: { startMs: 0, endExclusiveMs: 100 },
      expressionUsesExplicitRange: false,
      lowerBounds: [{ siteId, startMs: 0 }],
      scope: "session" as const,
      reportingTimeZone: "UTC",
      capturedAtMs: 100,
      analysis,
    };
    expect(() =>
      buildAdvancedCountFilterMatchPlan({
        ...common,
        numericCompatibilityRequirements: [
          { fieldId: "page.durationMs", domain: "page-only" },
        ],
      }),
    ).toThrow(
      "advanced_count_match_numeric_compatibility_requirements_mismatch",
    );
    expect(() =>
      buildAdvancedCountFilterMatchPlan({
        ...common,
        numericCompatibilityRequirements: [
          {
            fieldId: "page.durationMs",
            domain: "page-only",
            proof: "safe-number",
          },
        ],
      }),
    ).toThrow(
      "advanced_count_match_numeric_compatibility_requirements_mismatch",
    );
    expect(() => buildAdvancedCountFilterMatchPlan(common)).not.toThrow();
  });

  it("keeps min/max aggregate inputs in their registered numeric units", () => {
    const document = parseFilterDsl(
      "min(page.durationMs) eq -1 AND max(page.durationMs) eq 2 AND countDistinct(page.durationMs) eq 3 AND min(page.performance.cls) eq 0.5 AND max(page.performance.cls) eq 0.5",
      analyticsFilterRegistry,
    );
    const analysis = analyzeFilterDocument(document, analyticsFilterRegistry);
    const siteId = "site-advanced-count-support" as SiteId;
    const plan = buildAdvancedCountFilterMatchPlan({
      subject: createSemanticSubjectDomain({
        origin: "site",
        siteIds: [siteId],
      }),
      candidateRange: { startMs: 0, endExclusiveMs: 100 },
      readRange: { startMs: 0, endExclusiveMs: 100 },
      expressionRange: { startMs: 0, endExclusiveMs: 100 },
      expressionUsesExplicitRange: false,
      lowerBounds: [{ siteId, startMs: 0 }],
      scope: "session",
      reportingTimeZone: "UTC",
      capturedAtMs: 100,
      analysis,
    });
    const aggregate = plan.nodes.find(
      (node) =>
        node.kind === "aggregate" &&
        node.measures.some((measure) => measure.kind === "min") &&
        node.measures.some((measure) => measure.kind === "max"),
    );
    expect(aggregate?.kind).toBe("aggregate");
    if (!aggregate || aggregate.kind !== "aggregate")
      throw new Error("expected scalar min/max aggregate");
    const durationMeasures = aggregate.measures.flatMap((measure) => {
      if (measure.kind === "count-rows") return [];
      const input = measure.input;
      if (input.kind !== "slot") return [];
      const inputSlot = plan.slots.find(({ id }) => id === input.slot);
      return inputSlot?.type.kind === "scalar" && inputSlot.type.unit === "ms"
        ? [{ kind: measure.kind, input }]
        : [];
    });
    expect(durationMeasures.map((measure) => measure.kind).sort()).toEqual([
      "count-distinct",
      "max",
      "min",
    ]);
    expect(
      new Set(durationMeasures.map(({ input }) => JSON.stringify(input))).size,
    ).toBe(1);
    expect(
      aggregate.measures
        .filter((measure) => measure.kind === "min" || measure.kind === "max")
        .map((measure) => {
          const slot = plan.slots.find(({ id }) => id === measure.output);
          return {
            kind: measure.kind,
            type: slot?.type,
            nullable: slot?.nullable,
          };
        }),
    ).toEqual([
      {
        kind: "min",
        type: { kind: "scalar", scalar: "number", unit: "ms" },
        nullable: true,
      },
      {
        kind: "max",
        type: { kind: "scalar", scalar: "number", unit: "ms" },
        nullable: true,
      },
      {
        kind: "min",
        type: { kind: "scalar", scalar: "number", unit: "ratio" },
        nullable: true,
      },
      {
        kind: "max",
        type: { kind: "scalar", scalar: "number", unit: "ratio" },
        nullable: true,
      },
    ]);
  });

  it("uses one typed scalar contribution for bounded sum and average", () => {
    const document = parseFilterDsl(
      "sum(page.durationMs) eq -3 AND avg(page.durationMs) eq -1.5 AND min(page.durationMs) eq -5 AND max(page.durationMs) eq 2",
      analyticsFilterRegistry,
    );
    const analysis = analyzeFilterDocument(document, analyticsFilterRegistry);
    const siteId = "site-advanced-count-sum-average" as SiteId;
    const plan = buildAdvancedCountFilterMatchPlan({
      subject: createSemanticSubjectDomain({
        origin: "site",
        siteIds: [siteId],
      }),
      candidateRange: { startMs: 0, endExclusiveMs: 100 },
      readRange: { startMs: 0, endExclusiveMs: 100 },
      expressionRange: { startMs: 0, endExclusiveMs: 100 },
      expressionUsesExplicitRange: false,
      lowerBounds: [{ siteId, startMs: 0 }],
      scope: "session",
      reportingTimeZone: "UTC",
      capturedAtMs: 100,
      analysis,
    });
    const aggregate = plan.nodes.find(
      (node) =>
        node.kind === "aggregate" &&
        node.measures.some((measure) => measure.kind === "sum") &&
        node.measures.some((measure) => measure.kind === "avg") &&
        node.measures.some((measure) => measure.kind === "min") &&
        node.measures.some((measure) => measure.kind === "max"),
    );
    expect(aggregate?.kind).toBe("aggregate");
    if (!aggregate || aggregate.kind !== "aggregate")
      throw new Error("expected scalar sum/average aggregate");

    const measures = new Map(
      aggregate.measures.flatMap((measure) =>
        measure.kind === "sum" ||
        measure.kind === "avg" ||
        measure.kind === "min" ||
        measure.kind === "max"
          ? [[measure.kind, measure] as const]
          : [],
      ),
    );
    const sum = measures.get("sum");
    const average = measures.get("avg");
    const minimum = measures.get("min");
    const maximum = measures.get("max");
    expect(sum?.input).toMatchObject({ kind: "numeric-value" });
    expect(average?.input).toEqual(sum?.input);
    if (
      !sum ||
      sum.kind !== "sum" ||
      !average ||
      average.kind !== "avg" ||
      !minimum ||
      minimum.kind !== "min" ||
      !maximum ||
      maximum.kind !== "max"
    )
      throw new Error("expected typed scalar reducer measures");
    const sumOutput = plan.slots.find(({ id }) => id === sum.output);
    const averageOutput = plan.slots.find(({ id }) => id === average.output);
    const minimumOutput = plan.slots.find(({ id }) => id === minimum.output);
    const maximumOutput = plan.slots.find(({ id }) => id === maximum.output);
    expect(sumOutput?.type).toEqual({ kind: "scalar", scalar: "number" });
    expect(averageOutput?.type).toEqual({ kind: "scalar", scalar: "number" });
    expect(minimumOutput?.type).toEqual({
      kind: "scalar",
      scalar: "number",
      unit: "ms",
    });
    expect(maximumOutput?.type).toEqual(minimumOutput?.type);
    if (sum.input.kind !== "numeric-value")
      throw new Error("expected numeric-value reducer input");
    const sumInput = sum.input.input;
    expect(sumInput.kind).toBe("slot");
    if (sumInput.kind !== "slot") throw new Error("expected scalar slot input");
    expect(plan.slots.find(({ id }) => id === sumInput.slot)?.type).toEqual({
      kind: "scalar",
      scalar: "number",
      unit: "ms",
    });
    expect(minimum.input).toEqual(sumInput);
    expect(maximum.input).toEqual(sumInput);
  });

  it("supports bounded same-field Page and Event count selectors", () => {
    for (const expression of [
      'count(page { page.path eq "/pricing" }) eq 1',
      'count(page { page.path in ["/pricing", "/docs"] }) gte 1',
      'count(page { page.path contains "pricing" }) eq 1',
      'count(page { page.path startsWith "/pricing" }) eq 1',
      'count(page { page.path endsWith "pricing" }) eq 1',
      'count(page { page.title eq "Pricing" }) eq 1',
      'count(page { page.title contains "Pricing" }) eq 1',
      'count(page { page.query startsWith "?utm=" }) eq 1',
      'count(page { page.hash endsWith "section" }) eq 1',
      "count(page { page.path exists }) eq 1",
      "count(page { page.title notExists }) eq 0",
      "count(page { page.query isEmpty }) eq 0",
      "count(page { page.hash notEmpty }) eq 0",
      "count(event { event.name exists }) eq 1",
      "count(event { event.name notExists }) eq 0",
      "count(event { event.name isEmpty }) eq 0",
      "count(event { event.name notEmpty }) eq 1",
      'count(page { page.path eq "/pricing" AND page.title contains "Pricing" AND page.query startsWith "?utm=" AND page.hash endsWith "section" }) eq 1',
      'count(page { NOT (page.path neq "/pricing") }) between [0, 2]',
      "count(page { page.path isNull }) eq 0",
      'count(event { event.name contains "pur" }) eq 1',
      'count(event { event.name startsWith "pur" }) eq 1',
      'count(event { event.name endsWith "chase" }) eq 1',
      'count(event { event.name notIn ["signup", "purchase"] }) neq 0',
      'count(page { page.path startsWith "/pricing" AND page.path endsWith "ing" }) eq 1',
      'add(count(page { page.path eq "/pricing" }), count(event { event.name eq "purchase" })) in [0, 1, 2]',
      'count(page { page.path eq "/pricing" }) eq 1 AND count(event { event.name isNull }) eq 0',
    ])
      expect(classify(expression), expression).toMatchObject({
        kind: "supported",
        code: "supported_count_sql",
      });
  });

  it("rejects mixed-field and unsupported selector predicates as a whole", () => {
    expect(
      classify('count(page { page.hostname eq "example.test" }) eq 1'),
    ).toMatchObject({
      kind: "unsupported",
      path: "root.target.input.predicate.target",
      code: "count_sql_selector_field_mismatch",
    });
    expect(
      classify('count(event { event.payload("/kind") exists }) eq 1'),
    ).toMatchObject({
      kind: "unsupported",
      path: "root.target.input.predicate",
      code: "count_sql_payload_selector_unsupported_operator",
    });
    expect(
      classify('count(page { page.hostname contains "example.test" }) eq 1'),
    ).toMatchObject({
      kind: "unsupported",
      path: "root.target.input.predicate.target",
      code: "count_sql_selector_field_mismatch",
    });
    expect(
      classify(
        'count(page { page.path eq "/pricing" AND page.hostname eq "other" }) eq 0',
      ),
    ).toMatchObject({
      kind: "unsupported",
      path: "root.target.input.predicate.children[0].target",
      code: "count_sql_selector_field_mismatch",
    });
    const orderedStringTarget = {
      version: 1,
      root: {
        kind: "condition",
        target: {
          kind: "reducer",
          reducer: "count",
          input: {
            kind: "selector",
            collection: { kind: "entity-root", entity: "page" },
            predicate: {
              kind: "condition",
              target: { kind: "field", field: "page.path" },
              operator: "gt",
              value: "/pricing",
            },
          },
        },
        operator: "eq",
        value: 1,
      },
    } as unknown as FilterDocument;
    expect(
      classifyAdvancedCountFilter(orderedStringTarget, "session"),
    ).toMatchObject({
      kind: "unsupported",
      path: "root.target.input.predicate.operator",
      code: "operator_not_allowed",
    });
  });

  it("keeps Unicode, NUL, and paired-surrogate literals supported", () => {
    for (const expression of [
      'count(page { page.path eq "/café" }) eq 0',
      'count(page { page.path eq "\\u0000" }) eq 0',
      'count(page { page.path eq "\\uD83D\\uDE00" }) eq 0',
      'count(page { page.path in ["/café", "\\uD83D\\uDE00"] }) eq 0',
    ])
      expect(classify(expression), expression).toMatchObject({
        kind: "supported",
        code: "supported_count_sql",
      });
  });

  it("routes unpaired surrogate selector literals to whole-tree compatibility", () => {
    for (const escaped of ["\\uD800", "\\uDC00"]) {
      const result = classify(`count(page { page.path eq "${escaped}" }) eq 0`);
      expect(result).toMatchObject({
        kind: "unsupported",
        path: "root.target.input.predicate.value",
        code: "count_sql_selector_unpaired_surrogate_literal",
      });
    }
    expect(
      classify('count(page { page.path in ["/ok", "\\uD800"] }) eq 0'),
    ).toMatchObject({
      kind: "unsupported",
      path: "root.target.input.predicate.value",
      code: "count_sql_selector_unpaired_surrogate_literal",
    });
    expect(
      classify(
        'count(page { page.path eq "\\uD800" }) eq 0 AND count(page) gte 0',
      ),
    ).toMatchObject({
      kind: "unsupported",
      path: "root.children[1].target.input.predicate.value",
      code: "count_sql_selector_unpaired_surrogate_literal",
    });
  });

  it("supports predicate counts on the SQL selector slice", () => {
    expect(
      classify('count(event { event.name eq "purchase" }) eq 1'),
    ).toMatchObject({ kind: "supported", code: "supported_count_sql" });
  });

  it("gates numeric Page selector operators and data compatibility by field", () => {
    for (const operator of [
      "eq 10",
      "neq 10",
      "gt 5",
      "gte 5",
      "lt 5",
      "lte 5",
      "in [2.5, 10]",
      "notIn [2.5, 10]",
      "between [0, 10]",
    ])
      expect(
        classify(`count(page { page.durationMs ${operator} }) eq 1`),
        operator,
      ).toMatchObject({
        kind: "supported",
        numericCompatibilityFieldIds: ["page.durationMs"],
        numericCompatibilityRequirements: [
          { fieldId: "page.durationMs", domain: "page-only" },
        ],
      });

    for (const operator of ["isNull", "notNull", "exists", "notExists"])
      expect(
        classify(`count(page { page.durationMs ${operator} }) eq 1`),
        operator,
      ).toMatchObject({
        kind: "supported",
        numericCompatibilityFieldIds: [],
        numericCompatibilityRequirements: [],
      });

    expect(
      classify(
        'count(page { page.durationMs gt 5 AND page.path contains "/slow" }) eq 1',
      ),
    ).toMatchObject({
      kind: "supported",
      numericCompatibilityFieldIds: ["page.durationMs"],
    });
    const numericStringMatch = {
      version: 1,
      root: {
        kind: "condition",
        target: {
          kind: "reducer",
          reducer: "count",
          input: {
            kind: "selector",
            collection: { kind: "entity-root", entity: "page" },
            predicate: {
              kind: "condition",
              target: { kind: "field", field: "page.durationMs" },
              operator: "contains",
              value: "10",
            },
          },
        },
        operator: "eq",
        value: 1,
      },
    } as unknown as FilterDocument;
    expect(
      classifyAdvancedCountFilter(numericStringMatch, "session"),
    ).toMatchObject({
      kind: "unsupported",
      path: "root.target.input.predicate.operator",
      code: "operator_not_allowed",
    });
  });

  it("supports finite binary64 count results above the safe integer range", () => {
    expect(
      classify(
        "mul(mul(count(page), count(page)), mul(count(page), count(page))) eq 159968002399920000",
      ),
    ).toMatchObject({
      kind: "supported",
      code: "supported_count_sql",
    });
  });

  it("rejects unsafe fractional and unsupported right-hand count targets", () => {
    expect(
      classify("div(count(page), div(count(event), count(page))) eq 4"),
    ).toMatchObject({
      kind: "unsupported",
      path: "root.target.right",
      code: "count_sql_unbounded_division",
    });
    expect(
      classify("div(count(page), countDistinct(page)) eq 2"),
    ).toMatchObject({
      kind: "unsupported",
      path: "root.target.right",
      code: "count_sql_unsupported_numeric_target",
    });
    expect(
      classify("add(countDistinct(page), count(page)) eq 3"),
    ).toMatchObject({
      kind: "unsupported",
      path: "root.target.left",
      code: "count_sql_unsupported_numeric_target",
    });
  });

  it("keeps potentially non-finite count arithmetic on the whole-tree fallback", () => {
    let target = "count(page)";
    for (let depth = 0; depth < 7; depth++)
      target = `mul(${target}, ${target})`;
    expect(classify(`${target} eq 1`)).toMatchObject({
      kind: "unsupported",
      code: "count_sql_numeric_range_exceeds_binary64_margin",
    });
  });

  it("checks registered string literals nested inside payload count selectors", () => {
    for (const expression of [
      'count(event { event.name eq "购买" AND event.payload("/tier") eq "gold" }) gte 1',
      'count(event { NOT (event.name in ["购买"] AND event.payload("/tier") eq "gold") }) gte 1',
    ])
      expect(classify(expression)).toMatchObject({
        kind: "unsupported",
        code: "count_sql_payload_registered_non_ascii_literal",
      });

    for (const expression of [
      'count(event { event.name eq "purchase" AND event.payload("/tier") eq "gold" }) gte 1',
      'count(event { event.payload("/雪") eq "gold" }) gte 1',
      'count(page { page.path eq "/café" }) eq 0',
    ])
      expect(classify(expression)).toMatchObject({
        kind: "supported",
        code: "supported_count_sql",
      });

    const asciiBoundary = String.fromCharCode(0, 10, 0x7f);
    expect(
      classify(
        "count(event { event.name eq " +
          JSON.stringify(asciiBoundary) +
          ' AND event.payload("/tier") eq "gold" }) gte 1',
      ),
    ).toMatchObject({ kind: "supported", code: "supported_count_sql" });

    const nonAsciiBoundary = String.fromCharCode(0x80);
    expect(
      classify(
        "count(event { event.name eq " +
          JSON.stringify(nonAsciiBoundary) +
          ' AND event.payload("/tier") eq "gold" }) gte 1',
      ),
    ).toMatchObject({
      kind: "unsupported",
      code: "count_sql_payload_registered_non_ascii_literal",
    });
  });

  it("rejects scopes outside the initial Session and Visitor slice", () => {
    const result = classifyAdvancedCountFilter(
      parseFilterDsl("count(event) eq 1", analyticsFilterRegistry),
      "event",
    );
    expect(result).toMatchObject({
      kind: "unsupported",
      path: "root",
      code: "count_sql_requires_session_or_visitor_scope",
    });
  });
});
