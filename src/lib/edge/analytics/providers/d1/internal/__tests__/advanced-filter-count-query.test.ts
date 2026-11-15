import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
} from "@/lib/db/d1-budget";
import { createTimeRange } from "@/lib/edge/analytics/contract";
import type { SiteId } from "@/lib/edge/analytics/contract/types";
import {
  ADVANCED_COUNT_FILTER_OUTPUTS,
  buildAdvancedCountFilterCombinedPlan,
  buildAdvancedCountFilterGuardPlan,
  buildAdvancedCountFilterMatchPlan,
  buildAdvancedCountFilterPayloadCombinedPlan,
} from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import { classifyAdvancedCountFilter } from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import { advancedCountSelectorField } from "@/lib/edge/analytics/engine/semantic/count-selector-fields";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import {
  compileAdvancedFilterCountCombinedQuery,
  compileAdvancedFilterCountGuardQuery,
  compileAdvancedFilterCountMatchesQuery,
  compileAdvancedFilterCountPayloadCombinedQuery,
  queryAdvancedFilterCountCombined,
  queryAdvancedFilterCountGuard,
  queryAdvancedFilterCountMatches,
  queryAdvancedFilterCountPayloadCombined,
  validateAdvancedFilterCountCombinedMatches,
  validateAdvancedFilterCountPayloadCombinedMatches,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-count-query";
import { ADVANCED_FILTER_MAX_PAYLOAD_NODES } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-count-resource-policy";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import type { Env } from "@/lib/edge/types";
import {
  analyticsFilterRegistry,
  analyzeFilterDocument,
  parseFilterDsl,
} from "@/lib/filter-contract";

const SITE_ID = "count-query-contract-site" as SiteId;

function countQueryFixture() {
  const document = parseFilterDsl(
    "count(page { page.durationMs gt 0 }) eq 1",
    analyticsFilterRegistry,
  );
  const support = classifyAdvancedCountFilter(document, "session");
  if (support.kind !== "supported")
    throw new Error("expected_supported_count_query_fixture");

  const subject = createSemanticSubjectDomain({
    origin: "site",
    siteIds: [SITE_ID],
  });
  const range = createTimeRange(0, 10_000);
  const numericCompatibilityFields =
    support.numericCompatibilityRequirements.map(({ fieldId }) => {
      const field = advancedCountSelectorField(fieldId);
      if (!field || field.kind !== "number")
        throw new Error("expected_numeric_count_query_field");
      return field;
    });
  const guardPlan = buildAdvancedCountFilterGuardPlan({
    subject,
    range,
    reportingTimeZone: "UTC",
    numericCompatibilityRequirements: support.numericCompatibilityRequirements,
  });
  const matchPlan = buildAdvancedCountFilterMatchPlan({
    subject,
    candidateRange: range,
    readRange: range,
    expressionRange: range,
    expressionUsesExplicitRange: false,
    lowerBounds: [{ siteId: SITE_ID, startMs: range.startMs }],
    scope: "session",
    reportingTimeZone: "UTC",
    capturedAtMs: range.endExclusiveMs,
    analysis: support.analysis,
    numericCompatibilityRequirements: support.numericCompatibilityRequirements,
  });

  return {
    numericCompatibilityFields,
    guardQuery: compileAdvancedFilterCountGuardQuery(guardPlan),
    matchQuery: compileAdvancedFilterCountMatchesQuery(matchPlan),
  };
}

function combinedCountQueryFixture(
  filterDsl = 'count(page { page.path eq "/pricing" }) eq 1',
) {
  const document = parseFilterDsl(filterDsl, analyticsFilterRegistry);
  const support = classifyAdvancedCountFilter(document, "session");
  if (support.kind !== "supported")
    throw new Error("expected_supported_combined_count_query_fixture");
  const subject = createSemanticSubjectDomain({
    origin: "site",
    siteIds: [SITE_ID],
  });
  const range = createTimeRange(0, 10_000);
  const plan = buildAdvancedCountFilterCombinedPlan({
    subject,
    candidateRange: range,
    readRange: range,
    expressionRange: range,
    expressionUsesExplicitRange: false,
    lowerBounds: [{ siteId: SITE_ID, startMs: range.startMs }],
    scope: "session",
    reportingTimeZone: "UTC",
    capturedAtMs: range.endExclusiveMs,
    analysis: support.analysis,
    numericCompatibilityRequirements: support.numericCompatibilityRequirements,
  });
  return { plan, query: compileAdvancedFilterCountCombinedQuery(plan) };
}

function payloadCombinedCountQueryFixture(filterDsl: string) {
  const document = parseFilterDsl(filterDsl, analyticsFilterRegistry);
  const support = classifyAdvancedCountFilter(document, "session");
  if (support.kind !== "supported")
    throw new Error("expected_supported_payload_combined_count_fixture");
  const subject = createSemanticSubjectDomain({
    origin: "site",
    siteIds: [SITE_ID],
  });
  const range = createTimeRange(0, 10_000);
  const plan = buildAdvancedCountFilterPayloadCombinedPlan({
    subject,
    candidateRange: range,
    readRange: range,
    expressionRange: range,
    expressionUsesExplicitRange: false,
    lowerBounds: [{ siteId: SITE_ID, startMs: range.startMs }],
    scope: "session",
    reportingTimeZone: "UTC",
    capturedAtMs: range.endExclusiveMs,
    analysis: support.analysis,
    numericCompatibilityRequirements: support.numericCompatibilityRequirements,
  });
  return {
    plan,
  };
}

function directPayloadPlan(filterDsl: string) {
  const document = parseFilterDsl(filterDsl, analyticsFilterRegistry);
  const analysis = analyzeFilterDocument(document, analyticsFilterRegistry);
  const range = createTimeRange(0, 10_000);
  return buildAdvancedCountFilterPayloadCombinedPlan({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE_ID],
    }),
    candidateRange: range,
    readRange: range,
    expressionRange: range,
    expressionUsesExplicitRange: false,
    lowerBounds: [{ siteId: SITE_ID, startMs: range.startMs }],
    scope: "session",
    reportingTimeZone: "UTC",
    capturedAtMs: range.endExclusiveMs,
    analysis,
    numericCompatibilityRequirements: [],
  });
}

function d1EnvWithRows(rows: readonly Record<string, unknown>[]) {
  const preparedSql: string[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        preparedSql.push(sql);
        return {
          bind() {
            return {
              async all() {
                return { success: true, results: [...rows] };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, preparedSql };
}

function payloadGuardRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    rowKind: "guard",
    matched: 0,
    rawCount: 0,
    nullActivityIdCount: 0,
    siteIdentityMismatchCount: 0,
    payloadNodeCount: 0,
    payloadMissingFactCount: 0,
    payloadStructureInvalidCount: 0,
    payloadValueInvalidCount: 0,
    payloadMultiplicityInvalidCount: 0,
    siteId: "",
    entityId: "",
    ...overrides,
  };
}

function payloadScopeRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    rowKind: "scope",
    matched: 0,
    rawCount: 1,
    nullActivityIdCount: 0,
    siteIdentityMismatchCount: 0,
    payloadNodeCount: 0,
    payloadMissingFactCount: 0,
    payloadStructureInvalidCount: 0,
    payloadValueInvalidCount: 0,
    payloadMultiplicityInvalidCount: 0,
    siteId: SITE_ID,
    entityId: "session-a",
    ...overrides,
  };
}

describe("advanced count typed query results", () => {
  it("independently rejects registered Unicode literals in payload plans", () => {
    for (const expression of [
      'count(event { NOT (event.name in ["购买"] AND event.payload("/tier") eq "gold") }) gte 1',
      'count(event { event.name eq "购买" AND event.payload("/tier") eq "gold" }) gte 1',
    ])
      expect(() => directPayloadPlan(expression)).toThrow(
        "advanced_count_payload_plan_registered_non_ascii_literal",
      );

    for (const expression of [
      'count(event { event.name eq "purchase" AND event.payload("/tier") eq "gold" }) gte 1',
      'count(event { event.payload("/雪") eq "gold" }) gte 1',
    ])
      expect(() => directPayloadPlan(expression)).not.toThrow();
  });

  it("declares the derived numeric proof fields in a combined output", () => {
    const document = parseFilterDsl(
      "count(page { page.durationMs gt 0 }) eq 1 AND min(page.durationMs) gte 0 AND sum(page.durationMs) gte 0",
      analyticsFilterRegistry,
    );
    const support = classifyAdvancedCountFilter(document, "session");
    if (support.kind !== "supported")
      throw new Error("expected_supported_numeric_combined_fixture");
    expect(support.numericCompatibilityRequirements.length).toBeGreaterThan(0);
    const subject = createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE_ID],
    });
    const range = createTimeRange(0, 10_000);

    const plan = buildAdvancedCountFilterCombinedPlan({
      subject,
      candidateRange: range,
      readRange: range,
      expressionRange: range,
      expressionUsesExplicitRange: false,
      lowerBounds: [{ siteId: SITE_ID, startMs: range.startMs }],
      scope: "session",
      reportingTimeZone: "UTC",
      capturedAtMs: range.endExclusiveMs,
      analysis: support.analysis,
      numericCompatibilityRequirements:
        support.numericCompatibilityRequirements,
    });
    const output = plan.outputs.find(
      ({ id }) => id === "advanced-filter-count-combined",
    );
    expect(output?.fields.map(({ name }) => name)).toContain(
      "invalidContextPageDurationMsCount",
    );
    const query = compileAdvancedFilterCountCombinedQuery(plan);
    if (!query) throw new Error("numeric_combined_query_not_materialized");
    expect(
      query.numericCompatibilityFields.map(({ fieldId }) => fieldId),
    ).toEqual(["page.durationMs"]);
    expect(Object.isFrozen(query)).toBe(true);
    expect(Object.isFrozen(query.numericCompatibilityFields)).toBe(true);
    expect(Object.isFrozen(query.numericCompatibilityFields[0])).toBe(true);

    expect(() =>
      buildAdvancedCountFilterCombinedPlan({
        subject,
        candidateRange: range,
        readRange: range,
        expressionRange: range,
        expressionUsesExplicitRange: false,
        lowerBounds: [{ siteId: SITE_ID, startMs: range.startMs }],
        scope: "session",
        reportingTimeZone: "UTC",
        capturedAtMs: range.endExclusiveMs,
        analysis: support.analysis,
        numericCompatibilityRequirements: [],
      }),
    ).toThrow(
      "advanced_count_match_numeric_compatibility_requirements_mismatch",
    );
  });

  it("preflights one materialized combined group summary", () => {
    const fixture = combinedCountQueryFixture();

    expect(fixture.query).not.toBeNull();
    expect(fixture.query?.query.sql).toContain("AS MATERIALIZED");
    expect(fixture.plan.outputs.map(({ id }) => id)).toContain(
      "advanced-filter-count-combined",
    );
  });

  it.each([
    [
      "one selected payload path",
      'count(event { event.payload("/tier") eq "gold" }) eq 1',
      ["/tier"],
    ],
    [
      "two selected payload paths",
      'count(event { event.payload("/tier") eq "gold" AND event.payload("/coupon") notEmpty }) eq 1',
      ["/coupon", "/tier"],
    ],
  ] as const)(
    "compiles the payload scope summary for %s without repeating its grouping",
    (_name, filterDsl, paths) => {
      const fixture = payloadCombinedCountQueryFixture(filterDsl);

      const scopeGroup = fixture.plan.nodes.find(
        (node) =>
          node.kind === "aggregate" &&
          node.groups.length === 2 &&
          fixture.plan.nodes.some(
            (candidate) =>
              candidate.kind === "limit" && candidate.id === node.input,
          ),
      );
      if (!scopeGroup || scopeGroup.kind !== "aggregate")
        throw new Error("payload_scope_group_missing");
      const directConsumers = fixture.plan.nodes.filter(
        (node) =>
          ("input" in node && node.input === scopeGroup.id) ||
          ((node.kind === "join" ||
            node.kind === "semi-join" ||
            node.kind === "anti-join") &&
            (node.left === scopeGroup.id || node.right === scopeGroup.id)),
      );
      expect(directConsumers).toHaveLength(1);
      expect(directConsumers[0]?.kind).toBe("project");
      expect(
        fixture.plan.nodes.filter(
          (node) => node.kind === "event-payload-properties",
        ),
      ).toHaveLength(1);
      expect(fixture.plan.outputs.map(({ id }) => id)).toContain(
        ADVANCED_COUNT_FILTER_OUTPUTS.payloadCombinedGuard,
      );
      expect(fixture.plan.outputs.map(({ id }) => id)).toContain(
        ADVANCED_COUNT_FILTER_OUTPUTS.payloadCombinedScope,
      );
      const query = compileAdvancedFilterCountPayloadCombinedQuery(
        fixture.plan,
      );
      expect(query.query.sql.length).toBeGreaterThan(0);
      expect(
        new TextEncoder().encode(query.query.sql).byteLength,
      ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(query.query.bindings?.length ?? 0).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(query.paths.map(({ path }) => path)).toEqual(paths);
      expect(query.maximumNodes).toBe(ADVANCED_FILTER_MAX_PAYLOAD_NODES);
      const sqlHash = createHash("sha256")
        .update(query.query.sql, "utf8")
        .digest("hex");
      expect(sqlHash).toMatch(/^[0-9a-f]{64}$/u);
      const repeated = compileAdvancedFilterCountPayloadCombinedQuery(
        fixture.plan,
      );
      expect(repeated.query.sql).toBe(query.query.sql);
      expect(repeated.query.bindings).toEqual(query.query.bindings);
      expect(repeated.query.physicalPlanShape).toEqual(
        query.query.physicalPlanShape,
      );
    },
  );

  it("keeps the exact payload counter dependent on bounded selected nodes", () => {
    const plan = directPayloadPlan(
      'count(event { event.payload("/tier") eq "gold" }) eq 1',
    );
    const properties = plan.nodes.find(
      (node) => node.kind === "event-payload-properties",
    );
    const guard = plan.outputs.find(
      ({ id }) => id === ADVANCED_COUNT_FILTER_OUTPUTS.payloadCombinedGuard,
    );
    const scope = plan.outputs.find(
      ({ id }) => id === ADVANCED_COUNT_FILTER_OUTPUTS.payloadCombinedScope,
    );
    if (properties?.kind !== "event-payload-properties" || !guard || !scope)
      throw new Error("payload_properties_outputs_missing");
    const lowerer = new AnalyticsLogicalToDbLowerer(
      plan,
      {
        siteIds: plan.context.subject.siteIds,
        time: plan.context.time,
      },
      {
        eventPayloadAdmissionPolicy: {
          propertiesRelation: properties.id,
          maximumNodes: ADVANCED_FILTER_MAX_PAYLOAD_NODES,
        },
      },
    );
    lowerer.lowerMany([guard, scope]);
    const packet = lowerer.eventPayloadAdmissionPacket(properties.id);
    if (!packet) throw new Error("payload_provider_packet_missing");
    const boundedNode = packet.boundedNodes.node;
    const counterNode = packet.counter.node;
    const admissionNode = packet.admittedCounter.node;
    expect(boundedNode).toMatchObject({
      kind: "limit",
      count: {
        kind: "parameter",
        value: ADVANCED_FILTER_MAX_PAYLOAD_NODES + 1,
      },
    });
    if (boundedNode.kind !== "limit" || counterNode.kind !== "aggregate")
      throw new Error("payload_provider_counter_shape_invalid");
    expect(boundedNode.input.node).toBe(packet.selectedNodes.node);
    expect(counterNode.input.node).toBe(packet.boundedNodes.node);
    expect(counterNode.groups).toEqual([]);
    expect(counterNode.aggregates).toMatchObject([
      {
        name: "payloadNodeCount",
        expression: { kind: "aggregate", name: "COUNT" },
      },
    ]);
    expect(packet.counterValue).toBe(packet.counter.columns.payloadNodeCount);
    expect(admissionNode).toMatchObject({
      kind: "filter",
      predicate: {
        kind: "binary",
        operator: "<=",
        right: { kind: "constant", value: ADVANCED_FILTER_MAX_PAYLOAD_NODES },
      },
    });
    expect(packet.propertyReadNodeRelation).toBe(packet.admittedNodes);
    expect(packet.propertyReadInputRelation).toBe(packet.admittedEvents);
    expect(packet.propertyReadRelation).toBeTruthy();
    const compiled = compileAdvancedFilterCountPayloadCombinedQuery(plan);
    expect(compiled.query.sql).toContain("COUNT(*)");
    expect(compiled.query.sql).toContain('"custom_events"');
  });

  it("rejects missing, mismatched, and cloned Provider admission evidence", async () => {
    const plan = directPayloadPlan(
      'count(event { event.payload("/tier") eq "gold" }) eq 1',
    );
    const withoutProperties = {
      ...plan,
      nodes: plan.nodes.filter(
        (node) => node.kind !== "event-payload-properties",
      ),
    };
    expect(() =>
      compileAdvancedFilterCountPayloadCombinedQuery(
        withoutProperties as unknown as typeof plan,
      ),
    ).toThrow("advanced_filter_count_payload_properties_missing");

    const mismatchedProperties = {
      ...plan,
      nodes: plan.nodes.map((node) =>
        node.kind === "event-payload-properties"
          ? { ...node, paths: [{ path: "/other", key: "other" }] }
          : node,
      ),
    };
    expect(() =>
      compileAdvancedFilterCountPayloadCombinedQuery(
        mismatchedProperties as unknown as typeof plan,
      ),
    ).toThrow("advanced_filter_count_payload_source_witness_invalid");
    const compiled = compileAdvancedFilterCountPayloadCombinedQuery(plan);
    const clonedMetadata = { ...compiled };
    const { env } = d1EnvWithRows([payloadGuardRow()]);
    await expect(
      queryAdvancedFilterCountPayloadCombined({
        env,
        query: clonedMetadata as typeof compiled,
      }),
    ).rejects.toThrow(
      "advanced_filter_count_payload_admission_metadata_invalid",
    );
  });

  it("decodes a resource-only payload guard when there are no scope rows", async () => {
    const query = compileAdvancedFilterCountPayloadCombinedQuery(
      directPayloadPlan(
        'count(event { event.payload("/tier") eq "gold" }) eq 1',
      ),
    );
    const { env } = d1EnvWithRows([payloadGuardRow({ payloadNodeCount: 0 })]);

    await expect(
      queryAdvancedFilterCountPayloadCombined({ env, query }),
    ).resolves.toEqual({
      rawCount: 0,
      nullActivityIdCount: 0,
      siteIdentityMismatchCount: 0,
      payloadNodeCount: 0,
      payloadMissingFactCount: 0,
      payloadStructureInvalidCount: 0,
      payloadValueInvalidCount: 0,
      payloadMultiplicityInvalidCount: 0,
      matches: [],
    });
  });

  it.each([
    ["nonempty guard identity", { siteId: SITE_ID }],
    ["nonzero guard match flag", { matched: 1 }],
    ["nonzero guard activity placeholder", { rawCount: 1 }],
  ])("rejects payload guard with %s", async (_name, overrides) => {
    const query = compileAdvancedFilterCountPayloadCombinedQuery(
      directPayloadPlan(
        'count(event { event.payload("/tier") eq "gold" }) eq 1',
      ),
    );
    const { env } = d1EnvWithRows([payloadGuardRow(overrides)]);

    await expect(
      queryAdvancedFilterCountPayloadCombined({ env, query }),
    ).rejects.toThrow("advanced_filter_count_payload_guard_invalid");
  });

  it("sums scope controls while preserving the zeroed resource-row placeholders", async () => {
    const query = compileAdvancedFilterCountPayloadCombinedQuery(
      directPayloadPlan(
        'count(event { event.payload("/tier") eq "gold" }) eq 1',
      ),
    );
    const { env } = d1EnvWithRows([
      payloadGuardRow({ payloadNodeCount: 4 }),
      payloadScopeRow({
        matched: 1,
        rawCount: 2,
        nullActivityIdCount: 1,
        payloadMissingFactCount: 1,
        siteId: SITE_ID,
        entityId: "session-a",
      }),
      payloadScopeRow({
        rawCount: 3,
        siteId: SITE_ID,
        entityId: null,
      }),
    ]);

    await expect(
      queryAdvancedFilterCountPayloadCombined({ env, query }),
    ).resolves.toEqual({
      rawCount: 5,
      nullActivityIdCount: 1,
      siteIdentityMismatchCount: 0,
      payloadNodeCount: 4,
      payloadMissingFactCount: 1,
      payloadStructureInvalidCount: 0,
      payloadValueInvalidCount: 0,
      payloadMultiplicityInvalidCount: 0,
      matches: [
        {
          matched: 1,
          rawCount: 2,
          nullActivityIdCount: 1,
          siteIdentityMismatchCount: 0,
          payloadMissingFactCount: 1,
          siteId: SITE_ID,
          entityId: "session-a",
        },
        {
          matched: 0,
          rawCount: 3,
          nullActivityIdCount: 0,
          siteIdentityMismatchCount: 0,
          payloadMissingFactCount: 0,
          siteId: SITE_ID,
          entityId: null,
        },
      ],
    });
  });

  it("leaves the 20,001 activity sentinel for middleware cap priority", async () => {
    const query = compileAdvancedFilterCountPayloadCombinedQuery(
      directPayloadPlan(
        'count(event { event.payload("/tier") eq "gold" }) eq 1',
      ),
    );
    const { env } = d1EnvWithRows([
      payloadGuardRow(),
      payloadScopeRow({ rawCount: 20_001 }),
    ]);

    await expect(
      queryAdvancedFilterCountPayloadCombined({ env, query }),
    ).resolves.toMatchObject({ rawCount: 20_001 });
  });

  it.each([
    ["missing guard", [], "advanced_filter_count_payload_guard_missing"],
    [
      "repeated guard",
      [payloadGuardRow(), payloadGuardRow()],
      "advanced_filter_count_payload_guard_repeated",
    ],
    [
      "unknown row kind",
      [payloadGuardRow(), payloadScopeRow({ rowKind: "unexpected" })],
      "advanced_filter_count_payload_row_kind_invalid",
    ],
    [
      "missing scope identity column",
      [
        payloadGuardRow(),
        Object.fromEntries(
          Object.entries(payloadScopeRow()).filter(
            ([key]) => key !== "entityId",
          ),
        ),
      ],
      "advanced_filter_count_payload_scope_identity_invalid",
    ],
    [
      "invalid scope control",
      [payloadGuardRow(), payloadScopeRow({ nullActivityIdCount: 2 })],
      "advanced_filter_count_payload_scope_control_invalid",
    ],
    [
      "matched flag greater than one",
      [payloadGuardRow(), payloadScopeRow({ matched: 2 })],
      "advanced_filter_count_payload_match_flag_invalid",
    ],
    [
      "repeated scope identity",
      [payloadGuardRow(), payloadScopeRow(), payloadScopeRow()],
      "advanced_filter_count_payload_scope_repeated",
    ],
    [
      "scope sum overflow",
      [
        payloadGuardRow(),
        payloadScopeRow({ rawCount: Number.MAX_SAFE_INTEGER }),
        payloadScopeRow({ entityId: "session-b", rawCount: 1 }),
      ],
      "advanced_filter_count_invalid_raw_count_sum",
    ],
  ] as const)("rejects payload output with %s", async (_name, rows, error) => {
    const query = compileAdvancedFilterCountPayloadCombinedQuery(
      directPayloadPlan(
        'count(event { event.payload("/tier") eq "gold" }) eq 1',
      ),
    );
    const { env } = d1EnvWithRows(rows);

    await expect(
      queryAdvancedFilterCountPayloadCombined({ env, query }),
    ).rejects.toThrow(error);
  });

  it("validates matched payload identities after decoding the complete response", async () => {
    const query = compileAdvancedFilterCountPayloadCombinedQuery(
      directPayloadPlan(
        'count(event { event.payload("/tier") eq "gold" }) eq 1',
      ),
    );
    const { env } = d1EnvWithRows([
      payloadGuardRow(),
      payloadScopeRow({ matched: 0, siteId: null, entityId: null }),
      payloadScopeRow({ matched: 1, siteId: "", entityId: "session-a" }),
    ]);
    const decoded = await queryAdvancedFilterCountPayloadCombined({
      env,
      query,
    });

    expect(() =>
      validateAdvancedFilterCountPayloadCombinedMatches(
        decoded.matches,
        SITE_ID,
      ),
    ).toThrow("advanced_filter_count_payload_identity_invalid");
  });

  it("skips null identities for unmatched payload scopes and validates matched scopes", async () => {
    const query = compileAdvancedFilterCountPayloadCombinedQuery(
      directPayloadPlan(
        'count(event { event.payload("/tier") eq "gold" }) eq 1',
      ),
    );
    const { env } = d1EnvWithRows([
      payloadGuardRow(),
      payloadScopeRow({ matched: 0, siteId: null, entityId: null }),
      payloadScopeRow({ matched: 1, siteId: SITE_ID, entityId: "session-a" }),
    ]);
    const decoded = await queryAdvancedFilterCountPayloadCombined({
      env,
      query,
    });

    expect(
      validateAdvancedFilterCountPayloadCombinedMatches(
        decoded.matches,
        SITE_ID,
      ),
    ).toEqual([{ siteId: SITE_ID, entityId: "session-a" }]);
  });

  it("keeps the saved Wave89B split SQL signatures for the fixed count DSL", () => {
    const document = parseFilterDsl(
      'count(page) gte 1 AND count(event { event.name eq "purchase" }) gte 1',
      analyticsFilterRegistry,
    );
    const support = classifyAdvancedCountFilter(document, "session");
    if (support.kind !== "supported")
      throw new Error("expected_supported_historical_split_fixture");
    const subject = createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE_ID],
    });
    const range = createTimeRange(0, 1_000);
    const guardPlan = buildAdvancedCountFilterGuardPlan({
      subject,
      range,
      reportingTimeZone: "UTC",
      numericCompatibilityRequirements:
        support.numericCompatibilityRequirements,
    });
    const matchPlan = buildAdvancedCountFilterMatchPlan({
      subject,
      candidateRange: range,
      readRange: range,
      expressionRange: range,
      expressionUsesExplicitRange: false,
      lowerBounds: [{ siteId: SITE_ID, startMs: range.startMs }],
      scope: "session",
      reportingTimeZone: "UTC",
      capturedAtMs: range.endExclusiveMs,
      analysis: support.analysis,
      numericCompatibilityRequirements:
        support.numericCompatibilityRequirements,
    });
    const signatures = [
      compileAdvancedFilterCountGuardQuery(guardPlan),
      compileAdvancedFilterCountMatchesQuery(matchPlan),
    ].map(({ sql }) => createHash("sha256").update(sql).digest("hex"));

    expect(signatures).toEqual([
      "6da539556643bbebcb5c67a10fecae8c519ca44fb94b0634f448eaf03faca7fa",
      "6697d5894ca9c3ea90f16913c1a09735caebab1d65c6ff69a1bb7efd7b4abdcc",
    ]);
  });

  it("decodes a combined guard after match rows without partial results", async () => {
    const fixture = combinedCountQueryFixture();
    if (!fixture.query) throw new Error("combined_query_not_materialized");
    const { env } = d1EnvWithRows([
      {
        rowKind: "match",
        rawCount: 0,
        nullActivityIdCount: 0,
        siteIdentityMismatchCount: 0,
        siteId: SITE_ID,
        entityId: "session-a",
      },
      {
        rowKind: "guard",
        rawCount: 1,
        nullActivityIdCount: 0,
        siteIdentityMismatchCount: 0,
        siteId: "",
        entityId: "",
      },
    ]);

    await expect(
      queryAdvancedFilterCountCombined({ env, query: fixture.query }),
    ).resolves.toEqual({
      rawCount: 1,
      nullActivityIdCount: 0,
      siteIdentityMismatchCount: 0,
      numericCompatibilityFieldIds: [],
      matches: [{ siteId: SITE_ID, entityId: "session-a" }],
    });
  });

  it("rejects a nonzero combined match raw-count control without numeric proof fields", async () => {
    const fixture = combinedCountQueryFixture();
    if (!fixture.query) throw new Error("combined_query_not_materialized");
    const { env } = d1EnvWithRows([
      {
        rowKind: "match",
        rawCount: 1,
        nullActivityIdCount: 0,
        siteIdentityMismatchCount: 0,
        siteId: SITE_ID,
        entityId: "session-a",
      },
      {
        rowKind: "guard",
        rawCount: 1,
        nullActivityIdCount: 0,
        siteIdentityMismatchCount: 0,
        siteId: "",
        entityId: "",
      },
    ]);

    await expect(
      queryAdvancedFilterCountCombined({ env, query: fixture.query }),
    ).rejects.toThrow("advanced_filter_count_combined_match_control_invalid");
  });

  it("decodes complete numeric proof controls from the compiled output", async () => {
    const fixture = combinedCountQueryFixture(
      "count(page { page.durationMs gt 0 }) eq 1 AND sum(page.durationMs) gte 0",
    );
    if (!fixture.query) throw new Error("combined_query_not_materialized");
    expect(
      fixture.query.numericCompatibilityFields.map(({ fieldId }) => fieldId),
    ).toEqual(["page.durationMs"]);
    const { env } = d1EnvWithRows([
      {
        rowKind: "match",
        rawCount: 0,
        nullActivityIdCount: 0,
        siteIdentityMismatchCount: 0,
        invalidContextPageDurationMsCount: 0,
        siteId: SITE_ID,
        entityId: "session-a",
      },
      {
        rowKind: "guard",
        rawCount: 2,
        nullActivityIdCount: 0,
        siteIdentityMismatchCount: 0,
        invalidContextPageDurationMsCount: 1,
        siteId: "",
        entityId: "",
      },
    ]);

    await expect(
      queryAdvancedFilterCountCombined({ env, query: fixture.query }),
    ).resolves.toEqual({
      rawCount: 2,
      nullActivityIdCount: 0,
      siteIdentityMismatchCount: 0,
      numericCompatibilityFieldIds: ["page.durationMs"],
      matches: [{ siteId: SITE_ID, entityId: "session-a" }],
    });
  });

  it.each([
    [
      "guard proof is missing",
      [
        {
          rowKind: "guard",
          rawCount: 1,
          nullActivityIdCount: 0,
          siteIdentityMismatchCount: 0,
        },
      ],
      "advanced_filter_count_invalid_invalidContextPageDurationMsCount",
    ],
    [
      "guard proof exceeds the raw bag",
      [
        {
          rowKind: "guard",
          rawCount: 1,
          nullActivityIdCount: 0,
          siteIdentityMismatchCount: 0,
          invalidContextPageDurationMsCount: 2,
        },
      ],
      "advanced_filter_count_combined_numeric_proof_invalid",
    ],
    [
      "match proof is missing",
      [
        {
          rowKind: "match",
          rawCount: 0,
          nullActivityIdCount: 0,
          siteIdentityMismatchCount: 0,
          siteId: SITE_ID,
          entityId: "session-a",
        },
        {
          rowKind: "guard",
          rawCount: 1,
          nullActivityIdCount: 0,
          siteIdentityMismatchCount: 0,
          invalidContextPageDurationMsCount: 0,
        },
      ],
      "advanced_filter_count_invalid_invalidContextPageDurationMsCount",
    ],
    [
      "match carries a nonzero proof control",
      [
        {
          rowKind: "match",
          rawCount: 0,
          nullActivityIdCount: 0,
          siteIdentityMismatchCount: 0,
          invalidContextPageDurationMsCount: 1,
          siteId: SITE_ID,
          entityId: "session-a",
        },
        {
          rowKind: "guard",
          rawCount: 1,
          nullActivityIdCount: 0,
          siteIdentityMismatchCount: 0,
          invalidContextPageDurationMsCount: 0,
        },
      ],
      "advanced_filter_count_combined_match_control_invalid",
    ],
  ])("rejects combined output when %s", async (_case, rows, error) => {
    const fixture = combinedCountQueryFixture(
      "count(page { page.durationMs gt 0 }) eq 1 AND sum(page.durationMs) gte 0",
    );
    if (!fixture.query) throw new Error("combined_query_not_materialized");
    const { env } = d1EnvWithRows(rows as readonly Record<string, unknown>[]);

    await expect(
      queryAdvancedFilterCountCombined({ env, query: fixture.query }),
    ).rejects.toThrow(error as string);
  });

  it.each([
    ["missing guard", [], "advanced_filter_count_combined_guard_missing"],
    [
      "repeated guard",
      [
        {
          rowKind: "guard",
          rawCount: 0,
          nullActivityIdCount: 0,
          siteIdentityMismatchCount: 0,
        },
        {
          rowKind: "guard",
          rawCount: 0,
          nullActivityIdCount: 0,
          siteIdentityMismatchCount: 0,
        },
      ],
      "advanced_filter_count_combined_guard_repeated",
    ],
    [
      "bad guard count",
      [
        {
          rowKind: "guard",
          rawCount: "1",
          nullActivityIdCount: 0,
          siteIdentityMismatchCount: 0,
        },
      ],
      "advanced_filter_count_invalid_raw_count",
    ],
    [
      "guard counters exceed its raw bag",
      [
        {
          rowKind: "guard",
          rawCount: 1,
          nullActivityIdCount: 2,
          siteIdentityMismatchCount: 0,
        },
      ],
      "advanced_filter_count_combined_guard_invalid",
    ],
  ])("rejects combined result with %s", async (_name, rows, error) => {
    const fixture = combinedCountQueryFixture();
    if (!fixture.query) throw new Error("combined_query_not_materialized");
    const { env } = d1EnvWithRows(rows as readonly Record<string, unknown>[]);

    await expect(
      queryAdvancedFilterCountCombined({ env, query: fixture.query }),
    ).rejects.toThrow(error as string);
  });

  it("validates all combined identities together after guard priority", async () => {
    const fixture = combinedCountQueryFixture();
    if (!fixture.query) throw new Error("combined_query_not_materialized");
    const { env } = d1EnvWithRows([
      {
        rowKind: "match",
        rawCount: 0,
        nullActivityIdCount: 0,
        siteIdentityMismatchCount: 0,
        siteId: SITE_ID,
        entityId: "valid-session-before-invalid-identity",
      },
      {
        rowKind: "match",
        rawCount: 0,
        nullActivityIdCount: 0,
        siteIdentityMismatchCount: 0,
        siteId: SITE_ID,
        entityId: 42,
      },
      {
        rowKind: "guard",
        rawCount: 1,
        nullActivityIdCount: 0,
        siteIdentityMismatchCount: 0,
        siteId: "",
        entityId: "",
      },
    ]);
    const result = await queryAdvancedFilterCountCombined({
      env,
      query: fixture.query,
    });

    expect(result.rawCount).toBe(1);
    expect(() =>
      validateAdvancedFilterCountCombinedMatches(result.matches, SITE_ID),
    ).toThrow("advanced_filter_count_combined_identity_invalid");
  });

  it("rejects duplicate combined identities from a valid compiled query after decoding", async () => {
    const fixture = combinedCountQueryFixture();
    if (!fixture.query) throw new Error("combined_query_not_materialized");
    const { env } = d1EnvWithRows([
      {
        rowKind: "match",
        rawCount: 0,
        nullActivityIdCount: 0,
        siteIdentityMismatchCount: 0,
        siteId: SITE_ID,
        entityId: "session-a",
      },
      {
        rowKind: "match",
        rawCount: 0,
        nullActivityIdCount: 0,
        siteIdentityMismatchCount: 0,
        siteId: SITE_ID,
        entityId: "session-a",
      },
      {
        rowKind: "guard",
        rawCount: 2,
        nullActivityIdCount: 0,
        siteIdentityMismatchCount: 0,
        siteId: "",
        entityId: "",
      },
    ]);
    const decoded = await queryAdvancedFilterCountCombined({
      env,
      query: fixture.query,
    });

    expect(() =>
      validateAdvancedFilterCountCombinedMatches(decoded.matches, SITE_ID),
    ).toThrow("advanced_filter_count_combined_identity_repeated");
  });

  it("rejects an empty guard response instead of treating it as a zero count", async () => {
    const fixture = countQueryFixture();
    const { env, preparedSql } = d1EnvWithRows([]);

    await expect(
      queryAdvancedFilterCountGuard({
        env,
        query: fixture.guardQuery,
        numericCompatibilityFields: fixture.numericCompatibilityFields,
      }),
    ).rejects.toThrow("advanced_filter_count_guard_result_missing");
    expect(preparedSql).toEqual([fixture.guardQuery.sql]);
  });

  it.each([
    ["negative raw count", "rawCount", -1, "raw_count"],
    ["fractional raw count", "rawCount", 1.5, "raw_count"],
    [
      "negative numeric proof count",
      "invalidContextPageDurationMsCount",
      -1,
      "invalidContextPageDurationMsCount",
    ],
    [
      "fractional numeric proof count",
      "invalidContextPageDurationMsCount",
      0.5,
      "invalidContextPageDurationMsCount",
    ],
  ])("rejects a %s", async (_caseName, field, value, errorName) => {
    const fixture = countQueryFixture();
    const row = {
      rawCount: 1,
      nullActivityIdCount: 0,
      siteIdentityMismatchCount: 0,
      invalidContextPageDurationMsCount: 0,
      [field]: value,
    };
    const { env } = d1EnvWithRows([row]);

    await expect(
      queryAdvancedFilterCountGuard({
        env,
        query: fixture.guardQuery,
        numericCompatibilityFields: fixture.numericCompatibilityFields,
      }),
    ).rejects.toThrow(`advanced_filter_count_invalid_${errorName}`);
  });

  it("rejects an unknown control row after a valid match", async () => {
    const fixture = countQueryFixture();
    const { env } = d1EnvWithRows([
      {
        rowKind: "match",
        siteId: SITE_ID,
        entityId: "valid-session-before-control",
      },
      {
        rowKind: "unexpected-control",
        siteId: SITE_ID,
        entityId: "invalid-control-session",
      },
    ]);

    await expect(
      queryAdvancedFilterCountMatches({
        env,
        query: fixture.matchQuery,
        numericCompatibilityFields: fixture.numericCompatibilityFields,
      }),
    ).rejects.toThrow("advanced_filter_count_match_control_row_invalid");
  });

  it("rejects an invalid identity after a valid match instead of returning partial matches", async () => {
    const fixture = countQueryFixture();
    const { env } = d1EnvWithRows([
      {
        rowKind: "match",
        siteId: SITE_ID,
        entityId: "valid-session-before-invalid-identity",
      },
      {
        rowKind: "match",
        siteId: SITE_ID,
        entityId: 42,
      },
    ]);

    await expect(
      queryAdvancedFilterCountMatches({
        env,
        query: fixture.matchQuery,
        numericCompatibilityFields: fixture.numericCompatibilityFields,
      }),
    ).rejects.toThrow("advanced_filter_count_match_identity_invalid");
  });
});
