import { describe, expect, it } from "vitest";

import {
  attachScopedFilterMetadata,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import type {
  QueryInput,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import { relationId, slotId } from "@/lib/edge/analytics/engine/logical/ids";
import type { SourceMembershipInput } from "@/lib/edge/analytics/engine/logical/nodes";
import { EVENT_FILTER_PAGE_VISIT_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import {
  createSemanticPostObservationFilter,
  createSemanticScopedSourceSelection,
  SEMANTIC_POST_OBSERVATION_FILTER,
  type SemanticScopedSourceSelection,
  snapshotSourceMembershipInputs,
  validateSemanticPostObservationFilter,
  validateSemanticScopedSourceSelection,
} from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { semanticSubjectFromQuerySubject } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import { preparedMembershipFromIds } from "@/lib/edge/analytics/providers/d1/internal/__tests__/prepared-membership-fixture";
import { parseFilterDsl } from "@/lib/filter-contract/filter-dsl";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

const SITE_ID = "scoped-source-selection-guards-site";
const QUERY_TIME = createQueryTime(0, 100, "UTC", 100);
const SUBJECT = semanticSubjectFromQuerySubject(
  siteQueryContext(SITE_ID, "private-dashboard").subject,
);
const TIME = semanticTemporalDomainsFromQueryTime(QUERY_TIME);
const PREFIX = "invalid_semantic_scoped_source_selection:";
const CONTEXT = { subject: SUBJECT, time: TIME };

const EVENT_ADVANCED = 'count(event { event.name eq "signup" }) gte 1';

function advanced(dsl: string): FilterDocument {
  return normalizeFilterDocument(
    parseFilterDsl(dsl, analyticsFilterRegistry),
    analyticsFilterRegistry,
  );
}

function prepared(
  scope: "event" | "session" | "visitor",
  filters: FilterDocument = EMPTY_FILTER_DOCUMENT,
) {
  const query = prepareScopedQuery("event-records", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: QUERY_TIME,
    filters,
    scopePreference: scope,
  } as QueryInput & { time: QueryTime });
  return {
    filters: query.filters!,
    plan: query.scopePlan!,
    metadata: scopedFilterMetadata(query.filters!)!,
  };
}

function withHandle(
  input: ReturnType<typeof prepared>,
  preparedMembership: unknown,
) {
  const plan = { ...input.plan, preparedMembership } as typeof input.plan;
  return {
    ...input,
    plan,
    filters: attachScopedFilterMetadata(input.filters, {
      ...input.metadata,
      plan,
    }),
  };
}

function membershipInput(
  overrides: Partial<Record<keyof SourceMembershipInput, unknown>> = {},
) {
  return {
    input: relationId(0),
    role: "event",
    siteId: slotId(1),
    memberId: slotId(2),
    ...overrides,
  } as unknown as SourceMembershipInput;
}

describe("source membership input snapshots", () => {
  it("passes an absent input list through and freezes a valid snapshot", () => {
    expect(snapshotSourceMembershipInputs(undefined)).toBeUndefined();
    const original = [membershipInput()];
    const snapshot = snapshotSourceMembershipInputs(original)!;
    expect(snapshot).toEqual([
      { input: 0, role: "event", siteId: 1, memberId: 2 },
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(snapshot[0]).not.toBe(original[0]);
  });

  it("accepts null-prototype records and two inputs with distinct roles", () => {
    const bare = Object.assign(Object.create(null), membershipInput());
    const snapshot = snapshotSourceMembershipInputs([
      bare,
      membershipInput({ role: "visit" }),
    ])!;
    expect(snapshot.map(({ role }) => role)).toEqual(["event", "visit"]);
  });

  it.each([
    ["a non-array", { length: 1, 0: membershipInput() }],
    ["an empty list", []],
    ["three inputs", [membershipInput(), membershipInput(), membershipInput()]],
  ])("rejects %s", (_, value) => {
    expect(() => snapshotSourceMembershipInputs(value as never)).toThrow(
      PREFIX + "membership_inputs_invalid",
    );
  });

  it("rejects extra own keys on the list and sparse entries", () => {
    const extra = Object.assign([membershipInput()], { extra: 1 });
    expect(() => snapshotSourceMembershipInputs(extra)).toThrow(
      PREFIX + "membership_inputs_invalid",
    );
    const symbol = [membershipInput()] as unknown[];
    Object.defineProperty(symbol, Symbol("hidden"), { value: 1 });
    expect(() => snapshotSourceMembershipInputs(symbol as never)).toThrow(
      PREFIX + "membership_inputs_invalid",
    );
    const sparse = new Array(2) as unknown[];
    sparse[0] = membershipInput();
    expect(() => snapshotSourceMembershipInputs(sparse as never)).toThrow(
      PREFIX + "membership_inputs_invalid",
    );
  });

  it.each([
    ["null", null],
    ["a primitive", 7],
    ["an array", [1, 2, 3, 4]],
    ["a class instance", new (class Input {})()],
    ["a record with a missing key", { input: 0, role: "event", siteId: 1 }],
    [
      "a record with a foreign key",
      { input: 0, role: "event", siteId: 1, other: 2 },
    ],
    ["a negative relation", membershipInput({ input: -1 })],
    ["a fractional relation", membershipInput({ input: 0.5 })],
    ["a non-numeric site slot", membershipInput({ siteId: "1" })],
    ["a negative site slot", membershipInput({ siteId: -1 })],
    ["a non-numeric member slot", membershipInput({ memberId: null })],
    ["a negative member slot", membershipInput({ memberId: -2 })],
    [
      "equal site and member slots",
      membershipInput({ siteId: 3, memberId: 3 }),
    ],
    ["an unknown role", membershipInput({ role: "session" })],
  ])("rejects %s", (_, value) => {
    expect(() => snapshotSourceMembershipInputs([value as never])).toThrow(
      PREFIX + "membership_inputs_invalid",
    );
  });

  it("rejects a repeated role and accessor-backed members", () => {
    expect(() =>
      snapshotSourceMembershipInputs([membershipInput(), membershipInput()]),
    ).toThrow(PREFIX + "membership_inputs_invalid");
    const accessor = membershipInput();
    Object.defineProperty(accessor, "role", { get: () => "event" });
    expect(() => snapshotSourceMembershipInputs([accessor])).toThrow(
      PREFIX + "qualification_dependency_accessor_rejected",
    );
  });
});

describe("qualification dependency ref snapshots on validation", () => {
  function selection() {
    const input = prepared("event", advanced(EVENT_ADVANCED));
    return createSemanticScopedSourceSelection({
      profile: "prepared-scoped-v1",
      filters: input.filters,
      subject: SUBJECT,
      time: TIME,
      expectedPlan: input.plan,
      qualificationDependencyRefs: [EVENT_FILTER_PAGE_VISIT_DEPENDENCY],
    });
  }

  it("accepts the untouched dependency selection", () => {
    expect(() =>
      validateSemanticScopedSourceSelection(selection(), CONTEXT),
    ).not.toThrow();
  });

  it.each([
    ["a non-array", () => "ref"],
    ["an empty list", () => []],
    ["an unknown ref", () => ["not-a-dependency-ref"]],
    [
      "a repeated ref",
      () => [
        EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
        EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
      ],
    ],
    [
      "an accessor-backed element",
      () => {
        const refs: unknown[] = [];
        Object.defineProperty(refs, "0", {
          enumerable: true,
          get: () => EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
        });
        return refs;
      },
    ],
    ["a hole", () => new Array(1)],
  ])("rejects %s", (_, refs) => {
    const altered = {
      ...selection(),
      qualificationDependencyRefs: refs(),
    } as unknown as SemanticScopedSourceSelection;
    expect(() =>
      validateSemanticScopedSourceSelection(altered, CONTEXT),
    ).toThrow(PREFIX + "qualification_dependency_refs_invalid");
  });
});

describe("membership inputs on selection creation", () => {
  const eventAdvanced = () => prepared("event", advanced(EVENT_ADVANCED));
  const create = (
    input: ReturnType<typeof prepared>,
    membership: readonly SourceMembershipInput[] | undefined,
    extra: Record<string, unknown> = {},
  ) =>
    createSemanticScopedSourceSelection(
      {
        profile: "prepared-scoped-v1",
        filters: input.filters,
        subject: SUBJECT,
        time: TIME,
        expectedPlan: input.plan,
        ...extra,
      },
      membership,
    );

  it("creates and validates a selection backed by event membership inputs", () => {
    const input = eventAdvanced();
    const inputs = [membershipInput({ role: "event" })];
    const selection = create(input, inputs);
    expect(selection.preparedMembership).toBeUndefined();
    expect(() =>
      validateSemanticScopedSourceSelection(selection, CONTEXT, inputs),
    ).not.toThrow();
  });

  it("does not combine membership inputs with a prepared legacy handle", () => {
    const input = withHandle(
      eventAdvanced(),
      preparedMembershipFromIds({ eventIds: [] }),
    );
    expect(() => create(input, [membershipInput()])).toThrow(
      PREFIX + "membership_inputs_legacy_dependency_conflict",
    );
  });

  it("does not combine membership inputs with dependency refs", () => {
    expect(() =>
      create(eventAdvanced(), [membershipInput()], {
        qualificationDependencyRefs: [EVENT_FILTER_PAGE_VISIT_DEPENDENCY],
      }),
    ).toThrow(PREFIX + "membership_inputs_legacy_dependency_conflict");
  });

  it("requires event scope observation inputs without an entity role", () => {
    expect(() =>
      create(eventAdvanced(), [membershipInput({ role: "entity" })]),
    ).toThrow(PREFIX + "membership_inputs_semantics_mismatch");
  });

  it("requires exactly one entity input for entity scope selections", () => {
    const session = prepared("session", advanced("count(page) gte 1"));
    expect(() => create(session, [membershipInput({ role: "event" })])).toThrow(
      PREFIX + "membership_inputs_semantics_mismatch",
    );
    expect(() =>
      create(session, [
        membershipInput({ role: "entity" }),
        membershipInput({ role: "visit" }),
      ]),
    ).toThrow(PREFIX + "membership_inputs_semantics_mismatch");
    const selection = create(session, [membershipInput({ role: "entity" })]);
    expect(selection.mode).toBe("entity");
    expect(selection.entityKind).toBe("session");
  });

  it("rejects membership inputs on profiles that cannot carry them", () => {
    expect(() =>
      createSemanticScopedSourceSelection(
        {
          profile: "direct-event-records-v1",
          filters: EMPTY_FILTER_DOCUMENT,
          subject: SUBJECT,
          time: TIME,
        },
        [membershipInput()],
      ),
    ).toThrow(PREFIX + "membership_inputs_semantics_mismatch");
  });

  it("rejects membership inputs on validation for non dependency profiles", () => {
    const direct = createSemanticScopedSourceSelection({
      profile: "direct-event-records-v1",
      filters: EMPTY_FILTER_DOCUMENT,
      subject: SUBJECT,
      time: TIME,
    });
    expect(() =>
      validateSemanticScopedSourceSelection(direct, CONTEXT, [
        membershipInput(),
      ]),
    ).toThrow(PREFIX + "membership_inputs_semantics_mismatch");
  });

  it("rejects membership inputs that accompany a non analysis observation stage", () => {
    const input = eventAdvanced();
    const inputs = [membershipInput()];
    const selection = create(input, inputs, {
      profile: "prepared-scoped-reader-window-v1",
      postObservationFilter: createSemanticPostObservationFilter({
        filter: advanced('page.path eq "/goal"'),
      }),
    });
    expect(selection.postObservationFilter).toBeDefined();
    expect(() =>
      validateSemanticScopedSourceSelection(selection, CONTEXT, inputs),
    ).toThrow(PREFIX + "membership_inputs_semantics_mismatch");
  });
});

describe("post-observation stage validation", () => {
  const stage = createSemanticPostObservationFilter({
    filter: advanced('page.path eq "/goal"'),
  });

  it("rejects a stage whose filter is not in canonical form", () => {
    const wrapped = {
      semantics: SEMANTIC_POST_OBSERVATION_FILTER,
      filter: {
        version: 1,
        root: {
          kind: "and",
          children: [
            {
              kind: "condition",
              target: { kind: "field", field: "page.path" },
              operator: "eq",
              value: "/goal",
            },
          ],
        },
      },
    } as unknown as typeof stage;
    expect(() => validateSemanticPostObservationFilter(wrapped)).toThrow(
      PREFIX + "post_observation_filter_snapshot_not_normalized",
    );
    expect(() => validateSemanticPostObservationFilter(stage)).not.toThrow();
  });

  it("rejects an explicitly present but empty stage on a selection", () => {
    const direct = createSemanticScopedSourceSelection({
      profile: "direct-page-analytics-v1",
      filters: EMPTY_FILTER_DOCUMENT,
      subject: SUBJECT,
      time: TIME,
    });
    expect(() =>
      validateSemanticScopedSourceSelection(
        { ...direct, postObservationFilter: undefined },
        CONTEXT,
      ),
    ).toThrow(PREFIX + "post_observation_filter_descriptor_invalid");
  });

  it("requires a base filter for a Page entity compatibility stage", () => {
    const compatibility = createSemanticScopedSourceSelection({
      profile: "direct-page-entity-only-compat-v1",
      filters: advanced('page.path eq "/entry"'),
      compatibilityScope: "session",
      subject: SUBJECT,
      time: TIME,
    });
    const forged = {
      ...compatibility,
      filter: EMPTY_FILTER_DOCUMENT,
      postObservationFilter: stage,
    } as SemanticScopedSourceSelection;
    expect(() =>
      validateSemanticScopedSourceSelection(forged, CONTEXT),
    ).toThrow(PREFIX + "page_entity_compatibility_requires_filter");
  });
});

describe("prepared selection validation guards", () => {
  it("rejects preparation time on a profile that has none", () => {
    const input = prepared("event");
    const selection = createSemanticScopedSourceSelection({
      profile: "prepared-scoped-v1",
      filters: input.filters,
      subject: SUBJECT,
      time: TIME,
      expectedPlan: input.plan,
    });
    expect(() =>
      validateSemanticScopedSourceSelection(
        { ...selection, preparationTime: TIME },
        CONTEXT,
      ),
    ).toThrow(PREFIX + "unexpected_preparation_time");

    const direct = createSemanticScopedSourceSelection({
      profile: "direct-event-records-v1",
      filters: EMPTY_FILTER_DOCUMENT,
      subject: SUBJECT,
      time: TIME,
    });
    expect(() =>
      validateSemanticScopedSourceSelection(
        { ...direct, preparationTime: TIME },
        CONTEXT,
      ),
    ).toThrow(PREFIX + "unexpected_preparation_time");
  });

  it("requires prepared matches for an advanced reader-window selection", () => {
    const input = prepared("event", advanced(EVENT_ADVANCED));
    const readerWindow = createSemanticScopedSourceSelection({
      profile: "prepared-scoped-reader-window-v1",
      filters: input.filters,
      subject: SUBJECT,
      time: TIME,
      expectedPlan: input.plan,
      qualificationDependencyRefs: [EVENT_FILTER_PAGE_VISIT_DEPENDENCY],
    });
    const { qualificationDependencyRefs: _refs, ...withoutRefs } = readerWindow;
    expect(() =>
      validateSemanticScopedSourceSelection(
        withoutRefs as SemanticScopedSourceSelection,
        CONTEXT,
      ),
    ).toThrow(PREFIX + "prepared_advanced_matches_missing");
  });

  it("rejects advanced prepared creation without any proof", () => {
    const input = prepared("event", advanced(EVENT_ADVANCED));
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "prepared-scoped-v1",
        filters: input.filters,
        subject: SUBJECT,
        time: TIME,
        expectedPlan: input.plan,
      }),
    ).toThrow(PREFIX + "prepared_advanced_matches_missing");
  });

  it("rejects prepared handles that do not describe registered identities", () => {
    const input = withHandle(prepared("event"), {});
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "prepared-scoped-v1",
        filters: input.filters,
        subject: SUBJECT,
        time: TIME,
        expectedPlan: input.plan,
      }),
    ).toThrow(PREFIX + "invalid_prepared_membership");
  });

  it("rejects prepared handles that name sites outside the authorization", () => {
    const input = withHandle(
      prepared("event"),
      preparedMembershipFromIds({ eventIds: [] }, [SITE_ID, "intruder-site"]),
    );
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "prepared-scoped-v1",
        filters: input.filters,
        subject: SUBJECT,
        time: TIME,
        expectedPlan: input.plan,
      }),
    ).toThrow(PREFIX + "prepared_identity_outside_authorization");
  });
});

describe("direct compatibility profile guards", () => {
  it("rejects Page entity compatibility over advanced expressions", () => {
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-page-entity-only-compat-v1",
        filters: advanced("count(page) gte 1"),
        compatibilityScope: "session",
        subject: SUBJECT,
        time: TIME,
      }),
    ).toThrow(
      PREFIX + "page_entity_compatibility_requires_prepared_advanced_matches",
    );
  });

  it("rejects Page entity compatibility over filters the entity plan cannot own", () => {
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-page-entity-only-compat-v1",
        filters: advanced("session.views gte 1"),
        compatibilityScope: "session",
        subject: SUBJECT,
        time: TIME,
      }),
    ).toThrow(PREFIX + "page_entity_compatibility_plan_mismatch");
  });
});
