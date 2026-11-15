// @vitest-environment node
import { expect, it } from "vitest";

import type { SiteId } from "@/lib/edge/analytics/contract";
import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  buildEventReportSource,
  createEventReportSourceContextForBuilder,
} from "@/lib/edge/analytics/engine/event-source-plan";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import { EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import {
  createSemanticScopedSourceSelection,
  type CreateSemanticScopedSourceSelectionInput,
  type SemanticScopedSourceSelection,
  snapshotSemanticScopedSourceSelection,
  validateSemanticScopedSourceSelection,
} from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const time = createQueryTime(0, 100, "UTC", 200);
const request = prepareScopedQuery("event-trend", {
  context: siteQueryContext("policy-site", "private-dashboard"),
  time,
  filters: parseFilterDsl(
    'sequence([event { event.name eq "a" },event { event.name eq "b" }]) exists',
    analyticsFilterRegistry,
  ),
  scopePreference: "session",
  interval: "day",
  limit: 1,
});
const metadata = scopedFilterMetadata(request.filters)!;
const subject = createSemanticSubjectDomain({
  origin: "site",
  siteIds: [metadata.siteIds[0]! as SiteId],
});
const domains = semanticTemporalDomainsFromQueryTime(metadata.time);
const context = {
  subject,
  time: domains,
  scope: {
    requested: "session",
    contractScope: "session",
    logicalScope: "session",
  },
  originOperation: "event-records",
} as const;
const input: CreateSemanticScopedSourceSelectionInput = {
  profile: "prepared-whole-filter-reader-window-v1",
  wholeOriginalSourcePolicy: "prepared-scoped-v1",
  filters: request.filters,
  subject,
  time: domains,
  expectedPlan: metadata.plan,
  qualificationDependencyRefs: [EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY],
  eventName: " a ",
  eventNameInputSemantics: "legacy-truthy-raw",
};
const raw = (value: unknown) => value as SemanticScopedSourceSelection;

it("retains prepared name semantics, same-value time, and policy through immutable snapshots", () => {
  const selection = createSemanticScopedSourceSelection(input);
  expect(selection.eventNameGate).toEqual({
    value: " a ",
    semantics: "prepared-trimmed-label-v1",
  });
  expect(selection.preparationTime).toEqual(selection.time);
  validateSemanticScopedSourceSelection(selection, context);
  const snapshot = snapshotSemanticScopedSourceSelection(selection, context);
  expect(snapshot.wholeOriginalSourcePolicy).toBe("prepared-scoped-v1");
  expect(Object.isFrozen(snapshot)).toBe(true);
  validateSemanticScopedSourceSelection(snapshot, context);
  const defined = createSemanticScopedSourceSelection({
    ...input,
    eventName: "",
    eventNameInputSemantics: "defined-raw-value",
  });
  expect(defined.eventNameGate).toEqual({
    value: "",
    semantics: "prepared-defined-raw-value-v1",
  });
  expect(
    createSemanticScopedSourceSelection({
      ...input,
      time: JSON.parse(JSON.stringify(domains)),
    }).time,
  ).toEqual(domains);
});

it.each([
  "prepared-scoped-v1",
  "prepared-page-reader-window-v1",
  "prepared-scoped-reader-window-v1",
  "direct-event-records-v1",
  "direct-event-analytics-v1",
  "direct-page-analytics-v1",
  "direct-page-session-compat-v1",
  "direct-page-entity-only-compat-v1",
] as const)(
  "rejects original policy on %s in create and both fresh rounds",
  (profile) => {
    expect(() =>
      createSemanticScopedSourceSelection({ ...input, profile }),
    ).toThrow("whole_original_source_policy_invalid");
    const selection = raw({
      ...createSemanticScopedSourceSelection(input),
      profile,
    });
    expect(() =>
      validateSemanticScopedSourceSelection(selection, context),
    ).toThrow("whole_original_source_policy_invalid");
    expect(() =>
      snapshotSemanticScopedSourceSelection(selection, context),
    ).toThrow("whole_original_source_policy_invalid");
  },
);

it.each([undefined, null, "unknown", false, 0])(
  "rejects an explicitly present invalid policy %s without coercion",
  (policy) => {
    expect(() =>
      createSemanticScopedSourceSelection({
        ...input,
        wholeOriginalSourcePolicy: policy,
      } as unknown as CreateSemanticScopedSourceSelectionInput),
    ).toThrow("whole_original_source_policy_invalid");
    const selection = raw({
      ...createSemanticScopedSourceSelection(input),
      wholeOriginalSourcePolicy: policy,
    });
    expect(() =>
      validateSemanticScopedSourceSelection(selection, context),
    ).toThrow("whole_original_source_policy_invalid");
    expect(() =>
      snapshotSemanticScopedSourceSelection(selection, context),
    ).toThrow("whole_original_source_policy_invalid");
  },
);

it("never invokes a policy getter in creator, fresh validator, snapshot, or source factory", () => {
  let reads = 0;
  const accessor = {
    get() {
      reads++;
      throw Error("must-not-read");
    },
    enumerable: true,
  };
  const invalid = Object.defineProperty(
    { ...input },
    "wholeOriginalSourcePolicy",
    accessor,
  );
  expect(() => createSemanticScopedSourceSelection(invalid)).toThrow(
    "qualification_dependency_accessor_rejected",
  );
  const selection = Object.defineProperty(
    { ...createSemanticScopedSourceSelection(input) },
    "wholeOriginalSourcePolicy",
    accessor,
  );
  expect(() =>
    validateSemanticScopedSourceSelection(selection, context),
  ).toThrow("qualification_dependency_accessor_rejected");
  expect(() =>
    snapshotSemanticScopedSourceSelection(selection, context),
  ).toThrow("qualification_dependency_accessor_rejected");
  const source = Object.defineProperty(
    {
      siteId: "policy-site",
      queryTime: time,
      filters: request.filters,
      scopePlan: metadata.plan,
      qualificationSemantics: "whole-original",
      attributes: [],
    },
    "wholeOriginalSourcePolicy",
    accessor,
  );
  expect(() =>
    buildEventReportSource(
      source as Parameters<typeof buildEventReportSource>[0],
    ),
  ).toThrow("event_source_whole_original_policy_invalid");
  expect(reads).toBe(0);
});

it("does not opt in through an inherited policy", () => {
  const {
    wholeOriginalSourcePolicy: _,
    eventName: __,
    eventNameInputSemantics: ___,
    ...ordinary
  } = input;
  const inherited = Object.assign(
    Object.create({ wholeOriginalSourcePolicy: "prepared-scoped-v1" }),
    ordinary,
  ) as CreateSemanticScopedSourceSelectionInput;
  expect(
    createSemanticScopedSourceSelection(inherited).wholeOriginalSourcePolicy,
  ).toBeUndefined();
});

it("retains default whole name prohibition and original profile behavior", () => {
  const { wholeOriginalSourcePolicy: _, ...ordinary } = input;
  expect(() => createSemanticScopedSourceSelection(ordinary)).toThrow(
    "prepared_scoped_reader_window_event_name_unsupported",
  );
  const selected = createSemanticScopedSourceSelection(input);
  const { wholeOriginalSourcePolicy: __, ...without } = selected;
  expect(() => validateSemanticScopedSourceSelection(without, context)).toThrow(
    "prepared_scoped_reader_window_event_name_unsupported",
  );
  const original = createSemanticScopedSourceSelection({
    ...ordinary,
    profile: "prepared-scoped-v1",
  });
  expect(original.eventNameGate).toEqual(selected.eventNameGate);
  expect(original.preparationTime).toBeUndefined();
});

it("retains prepared time mismatch before binding and rejects changed raw snapshot time", () => {
  const changed = semanticTemporalDomainsFromQueryTime(
    createQueryTime(1, 100, "UTC", 200),
  );
  expect(() =>
    createSemanticScopedSourceSelection({ ...input, time: changed }),
  ).toThrow("prepared_time_mismatch");
  const selection = raw({
    ...createSemanticScopedSourceSelection(input),
    preparationTime: changed,
  });
  expect(() =>
    validateSemanticScopedSourceSelection(selection, context),
  ).toThrow("prepared_time_mismatch");
  expect(() =>
    snapshotSemanticScopedSourceSelection(selection, context),
  ).toThrow("prepared_time_mismatch");
});

it("requires the same nonempty typed relation and forbids opaque membership conflicts", () => {
  for (const refs of [
    undefined,
    [],
    [
      EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
      EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
    ],
  ]) {
    expect(() =>
      createSemanticScopedSourceSelection({
        ...input,
        qualificationDependencyRefs: refs,
      }),
    ).toThrow();
    expect(() =>
      validateSemanticScopedSourceSelection(
        raw({
          ...createSemanticScopedSourceSelection(input),
          qualificationDependencyRefs: refs,
        }),
        context,
      ),
    ).toThrow();
  }
  expect(() =>
    validateSemanticScopedSourceSelection(
      raw({
        ...createSemanticScopedSourceSelection(input),
        preparedMembership: {},
      }),
      context,
    ),
  ).toThrow("whole_original_dependency_required");
});

it("source factory requires explicit whole semantics and scope, including builder-context entry", () => {
  const source = {
    siteId: "policy-site",
    queryTime: time,
    filters: request.filters,
    scopePlan: metadata.plan,
    wholeOriginalSourcePolicy: "prepared-scoped-v1" as const,
    attributes: [],
  };
  expect(() => buildEventReportSource(source)).toThrow(
    "event_source_whole_original_policy_invalid",
  );
  expect(() =>
    buildEventReportSource({
      ...source,
      scopePlan: undefined,
      qualificationSemantics: "whole-original",
    }),
  ).toThrow("event_source_whole_original_policy_invalid");
  const builder = new LogicalPlanBuilder(context);
  expect(() =>
    createEventReportSourceContextForBuilder(builder, request.filters, {
      scopePlan: metadata.plan,
      wholeOriginalSourcePolicy: "prepared-scoped-v1",
    }),
  ).toThrow("event_source_whole_original_policy_invalid");
});
