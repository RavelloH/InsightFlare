import { describe, expect, it } from "vitest";

import { createTimeRange } from "@/lib/edge/analytics/contract";
import type { SiteId } from "@/lib/edge/analytics/contract/types";
import {
  appendAdvancedCountQualification,
  appendAdvancedEventCandidateCountQualification,
  buildAdvancedCountFilterCombinedPlan,
  buildAdvancedCountFilterGuardPlan,
  buildAdvancedCountFilterMatchPlan,
  buildAdvancedCountFilterPayloadCombinedPlan,
  createAdvancedCountQualificationBuilder,
} from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import {
  classifyAdvancedCountFilter,
  classifyAdvancedEventCandidateCountFilter,
} from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const SITE_ID = "count-plan-guard-site" as SiteId;
const RANGE = createTimeRange(0, 10_000);
const SUBJECT = createSemanticSubjectDomain({
  origin: "site",
  siteIds: [SITE_ID],
});

function supported(dsl: string, event = false) {
  const document = parseFilterDsl(dsl, analyticsFilterRegistry);
  const support = event
    ? classifyAdvancedEventCandidateCountFilter(document)
    : classifyAdvancedCountFilter(document, "session");
  if (support.kind !== "supported") throw new Error(`unsupported:${dsl}`);
  return support;
}

function forged(dsl: string, mutate: (root: any) => any, event = false) {
  const support = supported(dsl, event);
  const root = structuredClone(support.analysis.document.root) as any;
  const replaced = mutate(root);
  const analysis = {
    ...support.analysis,
    document: { ...support.analysis.document, root: replaced ?? root },
  } as any;
  return { support, analysis };
}

function matchInput(analysis: any, overrides: Record<string, unknown> = {}) {
  return {
    subject: SUBJECT,
    candidateRange: RANGE,
    readRange: RANGE,
    expressionRange: RANGE,
    expressionUsesExplicitRange: false,
    lowerBounds: [{ siteId: SITE_ID, startMs: RANGE.startMs }],
    scope: "session",
    reportingTimeZone: "UTC",
    capturedAtMs: RANGE.endExclusiveMs,
    analysis,
    ...overrides,
  } as any;
}

const PAYLOAD_DSL = 'count(event { event.payload("/kind") eq "gold" }) eq 1';

describe("advanced count guard plan input checks", () => {
  it("rejects empty and unsafe ranges", () => {
    expect(() =>
      buildAdvancedCountFilterGuardPlan({
        subject: SUBJECT,
        range: { startMs: 5, endExclusiveMs: 5 },
        reportingTimeZone: "UTC",
      }),
    ).toThrow("advanced_filter_count_guard_invalid_range");
    expect(() =>
      buildAdvancedCountFilterGuardPlan({
        subject: SUBJECT,
        range: { startMs: 0, endExclusiveMs: Number.MAX_SAFE_INTEGER + 2 },
        reportingTimeZone: "UTC",
      }),
    ).toThrow("advanced_filter_count_guard_invalid_range");
  });

  it("requires explicit numeric field ids to agree with the requirements", () => {
    const support = supported("count(page { page.durationMs gt 0 }) eq 1");
    expect(support.numericCompatibilityRequirements.length).toBeGreaterThan(0);
    expect(() =>
      buildAdvancedCountFilterGuardPlan({
        subject: SUBJECT,
        range: { startMs: 0, endExclusiveMs: 100 },
        reportingTimeZone: "UTC",
        numericCompatibilityRequirements:
          support.numericCompatibilityRequirements,
        numericCompatibilityFieldIds: ["not.a.field"],
      }),
    ).toThrow("advanced_count_guard_numeric_compatibility_fields_mismatch");
    expect(
      buildAdvancedCountFilterGuardPlan({
        subject: SUBJECT,
        range: { startMs: 0, endExclusiveMs: 100 },
        reportingTimeZone: "UTC",
        numericCompatibilityRequirements:
          support.numericCompatibilityRequirements,
        numericCompatibilityFieldIds:
          support.numericCompatibilityRequirements.map(
            ({ fieldId }) => fieldId,
          ),
      }).outputs.length,
    ).toBeGreaterThan(0);
  });
});

describe("advanced count plan rejects unchecked filter shapes", () => {
  const cases: readonly (readonly [
    string,
    string,
    string,
    (root: any) => any,
  ])[] = [
    [
      "a non condition root expression",
      "advanced_count_plan_received_unchecked_expression",
      "count(page) eq 1",
      () => ({ kind: "sequence" }),
    ],
    [
      "a non numeric comparison value",
      "advanced_count_plan_received_unchecked_value",
      "count(page) eq 1",
      (root) => {
        root.value = "one";
      },
    ],
    [
      "an empty IN set",
      "advanced_count_plan_received_unchecked_set",
      "count(page) in [1, 2]",
      (root) => {
        root.value = [];
      },
    ],
    [
      "an IN set containing a non number",
      "advanced_count_plan_received_unchecked_set",
      "count(page) in [1, 2]",
      (root) => {
        root.value = [1, "two"];
      },
    ],
    [
      "an inverted BETWEEN range",
      "advanced_count_plan_received_unchecked_range",
      "count(page) between [1, 5]",
      (root) => {
        root.value = [5, 1];
      },
    ],
    [
      "an EXISTS over an unresolvable target",
      "advanced_count_plan_received_unchecked_target",
      "count(page) eq 1",
      (root) => {
        root.operator = "exists";
        root.target = { kind: "literal", value: 1 };
      },
    ],
    [
      "a selector over a non entity-root collection",
      "advanced_count_plan_received_unchecked_target",
      'count(page { page.path eq "/a" }) eq 1',
      (root) => {
        root.target.input.collection = { kind: "page" };
      },
    ],
    [
      "a selector over an unsupported entity",
      "advanced_count_plan_received_unchecked_target",
      'count(page { page.path eq "/a" }) eq 1',
      (root) => {
        root.target.input.collection.entity = "session";
      },
    ],
    [
      "a selector predicate over a Page payload",
      "advanced_count_plan_received_unchecked_selector",
      'count(page { page.path eq "/a" }) eq 1',
      (root) => {
        root.target.input.predicate.target = {
          kind: "event-payload",
          path: "/kind",
        };
      },
    ],
    [
      "a non condition selector predicate",
      "advanced_count_plan_received_unchecked_selector",
      'count(page { page.path eq "/a" }) eq 1',
      (root) => {
        root.target.input.predicate = { kind: "sequence" };
      },
    ],
  ];

  it.each(cases)("rejects %s", (_name, message, dsl, mutate) => {
    const { analysis } = forged(dsl, mutate);
    expect(() =>
      buildAdvancedCountFilterMatchPlan(matchInput(analysis)),
    ).toThrow(message);
  });
});

describe("advanced count payload plans", () => {
  it("rejects payload selectors outside the payload combined plan", () => {
    const { analysis } = forged(PAYLOAD_DSL, () => undefined);
    expect(() =>
      buildAdvancedCountFilterCombinedPlan(matchInput(analysis)),
    ).toThrow("advanced_count_plan_missing_payload_property");
  });

  it("rejects non string payload values and unsupported payload operators", () => {
    const numeric = forged(PAYLOAD_DSL, (root) => {
      root.target.input.predicate.value = 5;
    });
    expect(() =>
      buildAdvancedCountFilterPayloadCombinedPlan(matchInput(numeric.analysis)),
    ).toThrow("advanced_count_plan_received_unchecked_payload_value");
    const operator = forged(PAYLOAD_DSL, (root) => {
      root.target.input.predicate.operator = "gt";
    });
    expect(() =>
      buildAdvancedCountFilterPayloadCombinedPlan(
        matchInput(operator.analysis),
      ),
    ).toThrow("advanced_count_plan_received_unchecked_payload_operator");
  });

  it("rejects numeric proofs, missing payload selectors and mixed numeric controls", () => {
    const { analysis } = forged(PAYLOAD_DSL, () => undefined);
    expect(() =>
      buildAdvancedCountFilterPayloadCombinedPlan(
        matchInput(analysis, {
          numericCompatibilityFieldIds: ["page.durationMs"],
        }),
      ),
    ).toThrow("advanced_count_payload_plan_numeric_proof_unsupported");
    const plain = forged("count(page) eq 1", () => undefined);
    expect(() =>
      buildAdvancedCountFilterPayloadCombinedPlan(matchInput(plain.analysis)),
    ).toThrow("event_payload_path_set_requires_nonempty_array");
    const mixed = forged(PAYLOAD_DSL, (root) => ({
      kind: "and",
      children: [
        root,
        {
          kind: "condition",
          target: {
            kind: "reducer",
            reducer: "sum",
            input: {
              kind: "member",
              object: { kind: "entity-root", entity: "page" },
              member: "durationMs",
            },
          },
          operator: "gte",
          value: 0,
        },
      ],
    }));
    expect(() =>
      buildAdvancedCountFilterPayloadCombinedPlan(matchInput(mixed.analysis)),
    ).toThrow("advanced_count_payload_plan_controls_missing");
  });
});

describe("advanced count qualification context checks", () => {
  it("rejects combined plans whose lower bounds do not match the subject", () => {
    const { analysis } = forged("count(page) eq 1", () => undefined);
    expect(() =>
      buildAdvancedCountFilterCombinedPlan(
        matchInput(analysis, { lowerBounds: [] }),
      ),
    ).toThrow("advanced_count_combined_plan_not_applicable");
    expect(() =>
      buildAdvancedCountFilterCombinedPlan(
        matchInput(analysis, { expressionUsesExplicitRange: true }),
      ),
    ).toThrow("advanced_count_combined_plan_not_applicable");
  });

  it("rejects event scope outside the event candidate qualification path", () => {
    const { analysis } = forged("count(page) eq 1", () => undefined);
    expect(() =>
      buildAdvancedCountFilterCombinedPlan(
        matchInput(analysis, {
          scope: "event",
          candidateAnchor: { kind: "event-candidate" },
        }),
      ),
    ).toThrow("advanced_count_event_candidate_plan_not_applicable");
  });

  it("rejects builders whose context differs from the qualification input", () => {
    const { analysis } = forged("count(page) eq 1", () => undefined);
    const input = matchInput(analysis);
    const builder = createAdvancedCountQualificationBuilder(input);
    expect(() =>
      appendAdvancedCountQualification(builder, {
        ...input,
        capturedAtMs: input.capturedAtMs - 1,
      }),
    ).toThrow("advanced_count_qualification_context_mismatch");
    expect(() =>
      appendAdvancedCountQualification(builder, {
        ...input,
        scope: "visitor",
      }),
    ).toThrow("advanced_count_qualification_context_mismatch");
    expect(appendAdvancedCountQualification(builder, input).scope).toBe(
      "session",
    );
  });

  it("rejects private qualified geo bare fields outside the combined plan", () => {
    const { analysis } = forged("count(page) eq 1", () => undefined);
    expect(() =>
      buildAdvancedCountFilterMatchPlan(
        matchInput(analysis, { allowPrivateQualifiedGeoBareFields: true }),
      ),
    ).toThrow("advanced_count_geo_comparison_resource_witness_invalid");
  });
});

describe("advanced event candidate count plan input checks", () => {
  const eventInput = (analysis: any, overrides: Record<string, unknown> = {}) =>
    matchInput(analysis, {
      scope: "event",
      candidateAnchor: { kind: "event-candidate" },
      ...overrides,
    });

  it("rejects mismatched lower bounds and missing roots", () => {
    const { analysis } = forged("count(page) eq 1", () => undefined, true);
    const input = eventInput(analysis);
    expect(
      appendAdvancedEventCandidateCountQualification(
        createAdvancedCountQualificationBuilder(input),
        input,
      ).scope,
    ).toBe("event");
    const bounds = eventInput(analysis, { lowerBounds: [] });
    expect(() =>
      appendAdvancedEventCandidateCountQualification(
        createAdvancedCountQualificationBuilder(bounds),
        bounds,
      ),
    ).toThrow("advanced_count_event_candidate_plan_not_applicable");
    const rootless = eventInput({
      ...analysis,
      document: { ...analysis.document, root: undefined },
    });
    expect(() =>
      appendAdvancedEventCandidateCountQualification(
        createAdvancedCountQualificationBuilder(rootless),
        rootless,
      ),
    ).toThrow("advanced_count_event_candidate_plan_requires_root");
  });

  it("rejects scalar reducers in event candidate filters", () => {
    const { analysis } = forged(
      "count(page) eq 1",
      () => ({
        kind: "condition",
        target: {
          kind: "reducer",
          reducer: "sum",
          input: {
            kind: "member",
            object: { kind: "entity-root", entity: "page" },
            member: "durationMs",
          },
        },
        operator: "gte",
        value: 1,
      }),
      true,
    );
    const input = eventInput(analysis);
    expect(() =>
      appendAdvancedEventCandidateCountQualification(
        createAdvancedCountQualificationBuilder(input),
        input,
      ),
    ).toThrow("advanced_count_event_candidate_scalar_reducer_unsupported");
  });
});
