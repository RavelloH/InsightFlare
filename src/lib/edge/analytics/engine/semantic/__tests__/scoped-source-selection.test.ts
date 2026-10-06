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
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import {
  createSemanticPostObservationFilter,
  createSemanticScopedSourceSelection,
  SEMANTIC_POST_OBSERVATION_FILTER,
  type SemanticScopedSourceSelection,
  snapshotSemanticScopedSourceSelection,
  validateSemanticScopedSourceSelection,
} from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import {
  createSemanticSubjectDomain,
  semanticSubjectFromQuerySubject,
} from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import { parseFilterDsl } from "@/lib/filter-contract/filter-dsl";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

const SITE_ID = "scoped-source-selection-site";
const QUERY_TIME = createQueryTime(0, 100, "UTC", 100);
const SUBJECT = semanticSubjectFromQuerySubject(
  siteQueryContext(SITE_ID, "private-dashboard").subject,
);
const TIME = semanticTemporalDomainsFromQueryTime(QUERY_TIME);

function preparedSelectionInput(
  scope: "event" | "session" | "visitor" = "event",
  filters = EMPTY_FILTER_DOCUMENT,
) {
  const prepared = prepareScopedQuery("event-records", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: QUERY_TIME,
    filters,
    scopePreference: scope,
  } as QueryInput & { time: QueryTime });
  const metadata = scopedFilterMetadata(prepared.filters)!;
  return {
    filters: prepared.filters!,
    plan: prepared.scopePlan!,
    metadata,
  };
}

function selectionFromPrepared(input = preparedSelectionInput()) {
  return createSemanticScopedSourceSelection({
    profile: "prepared-scoped-v1",
    filters: input.filters,
    subject: SUBJECT,
    time: TIME,
    expectedPlan: input.plan,
  });
}

function directSelection(): SemanticScopedSourceSelection {
  return createSemanticScopedSourceSelection({
    profile: "direct-event-records-v1",
    filters: EMPTY_FILTER_DOCUMENT,
    subject: SUBJECT,
    time: TIME,
    eventName: " signup ",
  });
}

function directAnalyticsSelection(
  eventName: string,
): SemanticScopedSourceSelection {
  return createSemanticScopedSourceSelection({
    profile: "direct-event-analytics-v1",
    filters: EMPTY_FILTER_DOCUMENT,
    subject: SUBJECT,
    time: TIME,
    eventName,
    eventNameInputSemantics: "legacy-truthy-raw",
  });
}

function simpleSessionFilter(country: string) {
  return normalizeFilterDocument(
    {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "field", field: "geo.country" },
        operator: "eq",
        value: country,
      },
    },
    analyticsFilterRegistry,
  );
}

function withPreparedMatches(
  scope: "event" | "session",
  advancedMatches: NonNullable<
    ReturnType<typeof preparedSelectionInput>["plan"]["advancedMatches"]
  >,
) {
  const prepared = preparedSelectionInput(scope);
  const plan = { ...prepared.plan, advancedMatches };
  const filters = attachScopedFilterMetadata(prepared.filters, {
    ...prepared.metadata,
    plan,
  });
  return createSemanticScopedSourceSelection({
    profile: "prepared-scoped-v1",
    filters,
    subject: SUBJECT,
    time: TIME,
    expectedPlan: plan,
  });
}

describe("semantic scoped source selection", () => {
  it("snapshots a finite post-observation stage without changing the base selection", () => {
    const mutableFilter = {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "field", field: "page.path" },
        operator: "eq",
        value: "/goal",
      },
    };
    const stage = createSemanticPostObservationFilter({
      filter: mutableFilter as FilterDocument,
    });
    mutableFilter.root.value = "/changed";
    expect(stage).toEqual({
      semantics: SEMANTIC_POST_OBSERVATION_FILTER,
      filter: expect.objectContaining({
        root: expect.objectContaining({ value: "/goal" }),
      }),
    });
    expect(Object.isFrozen(stage)).toBe(true);
    expect(Object.isFrozen(stage.filter)).toBe(true);
    expect(Object.isFrozen(stage.filter.root)).toBe(true);

    const direct = createSemanticScopedSourceSelection({
      profile: "direct-page-analytics-v1",
      filters: EMPTY_FILTER_DOCUMENT,
      postObservationFilter: stage,
      subject: SUBJECT,
      time: TIME,
    });
    expect(direct.filter).toEqual(EMPTY_FILTER_DOCUMENT);
    expect(direct.postObservationFilter).toEqual(stage);
    expect(Object.isFrozen(direct.postObservationFilter?.filter.root)).toBe(
      true,
    );
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-event-analytics-v1",
        filters: EMPTY_FILTER_DOCUMENT,
        postObservationFilter: stage,
        subject: SUBJECT,
        time: TIME,
      }),
    ).not.toThrow();
  });

  it("allows prepared reader-window stages and rejects untrusted or widened stage profiles", () => {
    const prepared = preparedSelectionInput(
      "session",
      simpleSessionFilter("US"),
    );
    const stage = createSemanticPostObservationFilter({
      filter: parseFilterDsl(
        'event.name eq "purchase"',
        analyticsFilterRegistry,
      ),
    });
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "prepared-scoped-reader-window-v1",
        filters: prepared.filters,
        expectedPlan: prepared.plan,
        postObservationFilter: stage,
        subject: SUBJECT,
        time: TIME,
      }),
    ).not.toThrow();

    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-page-analytics-v1",
        filters: simpleSessionFilter("US"),
        postObservationFilter: stage,
        subject: SUBJECT,
        time: TIME,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:direct_post_observation_filter_requires_empty_base",
    );
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-event-records-v1",
        filters: EMPTY_FILTER_DOCUMENT,
        postObservationFilter: stage,
        subject: SUBJECT,
        time: TIME,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:post_observation_filter_profile_unsupported",
    );
    expect(() =>
      createSemanticPostObservationFilter({
        filter: parseFilterDsl(
          "session.durationMs gt 1",
          analyticsFilterRegistry,
        ),
      }),
    ).toThrow();
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-page-analytics-v1",
        filters: EMPTY_FILTER_DOCUMENT,
        postObservationFilter: {
          ...stage,
          semantics: "future-filter-profile-v2",
        } as never,
        subject: SUBJECT,
        time: TIME,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:post_observation_filter_descriptor_invalid",
    );
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-page-analytics-v1",
        filters: EMPTY_FILTER_DOCUMENT,
        postObservationFilter: { ...stage, extra: true } as never,
        subject: SUBJECT,
        time: TIME,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:post_observation_filter_descriptor_invalid",
    );
  });

  it("snapshots and sorts prepared observation and entity matches", () => {
    const observations = withPreparedMatches("event", {
      visitIds: [
        { siteId: SITE_ID, id: "visit-z" },
        { siteId: SITE_ID, id: "visit-a" },
        { siteId: SITE_ID, id: "visit-a" },
      ],
      eventIds: [{ siteId: SITE_ID, id: "event-1" }],
    });
    expect(observations.preparedMatches?.identities).toEqual([
      { siteId: SITE_ID, kind: "event", id: "event-1" },
      { siteId: SITE_ID, kind: "page", id: "visit-a" },
      { siteId: SITE_ID, kind: "page", id: "visit-z" },
    ]);
    expect(Object.isFrozen(observations.preparedMatches?.identities)).toBe(
      true,
    );

    const entities = withPreparedMatches("session", {
      entityIds: [{ siteId: SITE_ID, id: "session-1" }],
    });
    expect(entities.preparedMatches?.identities).toEqual([
      { siteId: SITE_ID, kind: "session", id: "session-1" },
    ]);
  });

  it("preserves prepared proof while validating the actual Page reader window", () => {
    const prepared = preparedSelectionInput(
      "session",
      simpleSessionFilter("US"),
    );
    const readerTime = createQueryTime(100, 200, "UTC", 200);
    const readerDomains = semanticTemporalDomainsFromQueryTime(readerTime);
    const readerSelection = createSemanticScopedSourceSelection({
      profile: "prepared-page-reader-window-v1",
      filters: prepared.filters,
      subject: SUBJECT,
      time: readerDomains,
      expectedPlan: prepared.plan,
    });

    expect(readerSelection).toMatchObject({
      profile: "prepared-page-reader-window-v1",
      scope: "session",
      mode: "entity",
      time: readerDomains,
      preparationTime: TIME,
    });
    expect(Object.isFrozen(readerSelection.preparationTime)).toBe(true);
    validateSemanticScopedSourceSelection(readerSelection, {
      subject: SUBJECT,
      time: readerDomains,
    });
    const readerContext = {
      subject: SUBJECT,
      time: readerDomains,
      scope: resolveAnalyticsScope("session"),
      originOperation: "pages" as const,
    };
    expect(
      snapshotSemanticScopedSourceSelection(readerSelection, {
        ...readerContext,
      }).preparationTime,
    ).toEqual(TIME);

    expect(() => selectionFromPrepared(prepared)).not.toThrow();
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "prepared-scoped-v1",
        filters: prepared.filters,
        subject: SUBJECT,
        time: readerDomains,
        expectedPlan: prepared.plan,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:prepared_time_mismatch",
    );
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "prepared-page-reader-window-v1",
        filters: EMPTY_FILTER_DOCUMENT,
        subject: SUBJECT,
        time: readerDomains,
        expectedPlan: prepared.plan,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:prepared_plan_identity_mismatch",
    );
    const unauthorizedFilters = attachScopedFilterMetadata(prepared.filters, {
      ...prepared.metadata,
      siteIds: ["other-site"],
    });
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "prepared-page-reader-window-v1",
        filters: unauthorizedFilters,
        subject: SUBJECT,
        time: readerDomains,
        expectedPlan: prepared.plan,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:subject_outside_prepared_authorization",
    );
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "prepared-page-reader-window-v1",
        filters: prepared.filters,
        subject: SUBJECT,
        time: readerDomains,
        expectedPlan: prepared.plan,
        eventName: "purchase",
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:page_reader_window_event_name_unsupported",
    );
    const advancedFilters = normalizeFilterDocument(
      parseFilterDsl(
        "session { session.views gte 1 } exists",
        analyticsFilterRegistry,
      ),
      analyticsFilterRegistry,
    );
    const advancedPrepared = preparedSelectionInput("session", advancedFilters);
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "prepared-page-reader-window-v1",
        filters: advancedPrepared.filters,
        subject: SUBJECT,
        time: readerDomains,
        expectedPlan: advancedPrepared.plan,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:prepared_advanced_matches_missing",
    );
    const advancedPlan = {
      ...advancedPrepared.plan,
      advancedMatches: {
        entityIds: [{ siteId: SITE_ID, id: "session-1" }],
      },
    };
    const advancedWithMatches = attachScopedFilterMetadata(
      advancedPrepared.filters,
      { ...advancedPrepared.metadata, plan: advancedPlan },
    );
    const invalidAdvancedPlan = {
      ...advancedPrepared.plan,
      advancedMatches: {
        entityIds: [{ siteId: "other-site", id: "session-1" }],
      },
    };
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "prepared-page-reader-window-v1",
        filters: attachScopedFilterMetadata(advancedPrepared.filters, {
          ...advancedPrepared.metadata,
          plan: invalidAdvancedPlan,
        }),
        subject: SUBJECT,
        time: readerDomains,
        expectedPlan: invalidAdvancedPlan,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:prepared_identity_outside_authorization",
    );
    const advancedSelection = createSemanticScopedSourceSelection({
      profile: "prepared-page-reader-window-v1",
      filters: advancedWithMatches,
      subject: SUBJECT,
      time: readerDomains,
      expectedPlan: advancedPlan,
    });
    expect(() =>
      validateSemanticScopedSourceSelection(
        {
          ...advancedSelection,
          preparedMatches: {
            identities: [
              {
                ...advancedSelection.preparedMatches!.identities[0]!,
                kind: "visitor",
              },
            ],
          },
        },
        { subject: SUBJECT, time: readerDomains },
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:invalid_entity_identity_kind",
    );

    expect(() =>
      validateSemanticScopedSourceSelection(
        { ...readerSelection, preparationTime: undefined },
        { subject: SUBJECT, time: readerDomains },
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:prepared_time_snapshot_missing",
    );
    expect(() =>
      validateSemanticScopedSourceSelection(
        {
          ...readerSelection,
          preparationTime: {
            ...readerSelection.preparationTime!,
            candidate: {
              startMs: 200 as never,
              endExclusiveMs: 100 as never,
            },
          },
        },
        { subject: SUBJECT, time: readerDomains },
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:preparation_time_snapshot_invalid",
    );
    expect(() =>
      validateSemanticScopedSourceSelection(
        { ...readerSelection, profile: "prepared-scoped-v1" },
        { subject: SUBJECT, time: readerDomains },
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:unexpected_preparation_time",
    );
    expect(() =>
      validateSemanticScopedSourceSelection(
        {
          ...readerSelection,
          profile: "prepared-scoped-v1",
          preparationTime: undefined,
        },
        { subject: SUBJECT, time: readerDomains },
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:unexpected_preparation_time",
    );
  });

  it("preserves prepared proof for the scoped Page/Event reader window only", () => {
    const prepared = preparedSelectionInput("event");
    const readerTime = createQueryTime(100, 200, "UTC", 200);
    const readerDomains = semanticTemporalDomainsFromQueryTime(readerTime);
    const readerSelection = createSemanticScopedSourceSelection({
      profile: "prepared-scoped-reader-window-v1",
      filters: prepared.filters,
      subject: SUBJECT,
      time: readerDomains,
      expectedPlan: prepared.plan,
    });

    expect(readerSelection).toMatchObject({
      profile: "prepared-scoped-reader-window-v1",
      scope: "event",
      mode: "observation",
      time: readerDomains,
      preparationTime: TIME,
    });
    expect(Object.isFrozen(readerSelection.preparationTime)).toBe(true);
    const context = {
      subject: SUBJECT,
      time: readerDomains,
      scope: resolveAnalyticsScope("event"),
      originOperation: "event-records" as const,
    };
    validateSemanticScopedSourceSelection(readerSelection, context);
    expect(
      snapshotSemanticScopedSourceSelection(readerSelection, context)
        .preparationTime,
    ).toEqual(TIME);

    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "prepared-scoped-reader-window-v1",
        filters: prepared.filters,
        subject: SUBJECT,
        time: readerDomains,
        expectedPlan: prepared.plan,
        eventName: "purchase",
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:prepared_scoped_reader_window_event_name_unsupported",
    );
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "prepared-scoped-reader-window-v1",
        filters: prepared.filters,
        subject: SUBJECT,
        time: readerDomains,
        expectedPlan: prepared.plan,
        eventNameInputSemantics: "legacy-truthy-raw",
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:prepared_scoped_reader_window_event_name_unsupported",
    );
    expect(() =>
      validateSemanticScopedSourceSelection(
        { ...readerSelection, preparationTime: undefined },
        { subject: SUBJECT, time: readerDomains },
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:prepared_time_snapshot_missing",
    );
    expect(() =>
      validateSemanticScopedSourceSelection(
        {
          ...readerSelection,
          preparationTime: {
            ...readerSelection.preparationTime!,
            candidate: {
              startMs: 200 as never,
              endExclusiveMs: 100 as never,
            },
          },
        },
        { subject: SUBJECT, time: readerDomains },
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:preparation_time_snapshot_invalid",
    );
    expect(() =>
      validateSemanticScopedSourceSelection(
        { ...readerSelection, profile: "prepared-scoped-v1" },
        { subject: SUBJECT, time: readerDomains },
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:unexpected_preparation_time",
    );
  });

  it("validates and snapshots direct and prepared descriptors", () => {
    const direct = directSelection();
    const context = { subject: SUBJECT, time: TIME };
    validateSemanticScopedSourceSelection(direct, context);
    expect(direct).toMatchObject({
      profile: "direct-event-records-v1",
      eventNameGate: {
        value: "signup",
        semantics: "direct-subject-local-exact-name-v1",
      },
    });

    const preparedInput = preparedSelectionInput();
    const prepared = selectionFromPrepared(preparedInput);
    const snapshot = snapshotSemanticScopedSourceSelection(prepared, {
      ...context,
      scope: resolveAnalyticsScope("event"),
      originOperation: "event-records",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual(prepared);
  });

  it("preserves raw-truthy Event analytics names while records keep trimming", () => {
    expect(directSelection().eventNameGate).toEqual({
      value: "signup",
      semantics: "direct-subject-local-exact-name-v1",
    });
    expect(directAnalyticsSelection(" signup ").eventNameGate).toEqual({
      value: " signup ",
      semantics: "direct-subject-local-exact-name-v1",
    });
    expect(directAnalyticsSelection("  ").eventNameGate).toEqual({
      value: "  ",
      semantics: "direct-subject-local-exact-name-v1",
    });
    expect(directAnalyticsSelection("").eventNameGate).toBeUndefined();

    const preparedInput = preparedSelectionInput();
    const preparedAnalytics = createSemanticScopedSourceSelection({
      profile: "prepared-scoped-v1",
      filters: preparedInput.filters,
      subject: SUBJECT,
      time: TIME,
      expectedPlan: preparedInput.plan,
      eventName: " signup ",
      eventNameInputSemantics: "legacy-truthy-raw",
    });
    expect(preparedAnalytics.eventNameGate).toEqual({
      value: " signup ",
      semantics: "prepared-trimmed-label-v1",
    });
  });

  it("keeps an explicitly defined empty prepared Event name as a gate", () => {
    const prepared = preparedSelectionInput();
    expect(
      createSemanticScopedSourceSelection({
        profile: "prepared-scoped-v1",
        filters: prepared.filters,
        subject: SUBJECT,
        time: TIME,
        expectedPlan: prepared.plan,
        eventName: "",
        eventNameInputSemantics: "defined-raw-value",
      }).eventNameGate,
    ).toEqual({
      value: "",
      semantics: "prepared-defined-raw-value-v1",
    });

    expect(
      createSemanticScopedSourceSelection({
        profile: "direct-event-analytics-v1",
        filters: EMPTY_FILTER_DOCUMENT,
        subject: SUBJECT,
        time: TIME,
        eventName: "",
        eventNameInputSemantics: "defined-raw-value",
      }).eventNameGate,
    ).toBeUndefined();
  });

  it("rejects malformed Event-name gate contracts", () => {
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-event-analytics-v1",
        filters: EMPTY_FILTER_DOCUMENT,
        subject: SUBJECT,
        time: TIME,
        eventName: "signup",
        eventNameInputSemantics: "unknown" as "trimmed-nonempty",
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:invalid_event_name_input_semantics",
    );

    const direct = directSelection();
    expect(() =>
      validateSemanticScopedSourceSelection(
        {
          ...direct,
          eventNameGate: {
            ...direct.eventNameGate!,
            value: null as unknown as string,
          },
        },
        { subject: SUBJECT, time: TIME },
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:invalid_event_name_gate_value",
    );
  });

  it("rejects malformed descriptors and mismatched logical context", () => {
    const direct = directSelection();
    const context = { subject: SUBJECT, time: TIME };

    expect(() =>
      validateSemanticScopedSourceSelection(null as never, context),
    ).toThrow("invalid_semantic_scoped_source_selection:invalid_descriptor");
    expect(() =>
      validateSemanticScopedSourceSelection(
        { ...direct, version: 2 } as never,
        context,
      ),
    ).toThrow("invalid_semantic_scoped_source_selection:invalid_descriptor");
    expect(() =>
      validateSemanticScopedSourceSelection(direct, {
        subject: semanticSubjectFromQuerySubject(
          siteQueryContext("another-site", "private-dashboard").subject,
        ),
        time: TIME,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:logical_context_mismatch",
    );
    expect(() =>
      validateSemanticScopedSourceSelection(
        { ...direct, authorizedSiteIds: [SITE_ID, SITE_ID] },
        context,
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:authorization_snapshot_not_canonical",
    );
    expect(() =>
      validateSemanticScopedSourceSelection(
        { ...direct, authorizedSiteIds: [] },
        context,
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:invalid_authorized_sites",
    );
    const prepared = selectionFromPrepared(preparedSelectionInput());
    expect(() =>
      validateSemanticScopedSourceSelection(
        { ...prepared, entityKind: "session" },
        context,
      ),
    ).toThrow("invalid_semantic_scoped_source_selection:invalid_entity_kind");
    expect(() =>
      validateSemanticScopedSourceSelection(
        {
          ...direct,
          eventNameGate: {
            value: "signup",
            semantics: "prepared-trimmed-label-v1",
          },
        },
        context,
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:event_name_profile_mismatch",
    );
  });

  it("rejects noncanonical snapshots and incomplete prepared identities", () => {
    const context = { subject: SUBJECT, time: TIME };
    const direct = directSelection();
    expect(() =>
      validateSemanticScopedSourceSelection(
        {
          ...direct,
          filter: { ...direct.filter, ignored: true } as never,
        },
        context,
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:filter_snapshot_not_normalized",
    );
    expect(() =>
      validateSemanticScopedSourceSelection(
        { ...direct, scope: "session" },
        context,
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:invalid_direct_profile",
    );

    const prepared = selectionFromPrepared(preparedSelectionInput());
    expect(() =>
      validateSemanticScopedSourceSelection(
        { ...prepared, scope: "visitor" },
        context,
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:prepared_plan_mismatch",
    );

    const outsideSubject = semanticSubjectFromQuerySubject(
      siteQueryContext("another-site", "private-dashboard").subject,
    );
    expect(() =>
      validateSemanticScopedSourceSelection(
        { ...prepared, subject: outsideSubject },
        { subject: outsideSubject, time: TIME },
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:subject_outside_prepared_authorization",
    );

    const advancedFilters = normalizeFilterDocument(
      parseFilterDsl(
        "session { session.views gte 1 } exists",
        analyticsFilterRegistry,
      ),
      analyticsFilterRegistry,
    );
    const advancedPrepared = preparedSelectionInput("session", advancedFilters);
    const advancedPlan = {
      ...advancedPrepared.plan,
      advancedMatches: { entityIds: [] },
    };
    const advancedMetadata = attachScopedFilterMetadata(
      advancedPrepared.filters,
      { ...advancedPrepared.metadata, plan: advancedPlan },
    );
    const completeAdvanced = createSemanticScopedSourceSelection({
      profile: "prepared-scoped-v1",
      filters: advancedMetadata,
      subject: SUBJECT,
      time: TIME,
      expectedPlan: advancedPlan,
    });
    expect(() =>
      validateSemanticScopedSourceSelection(
        { ...completeAdvanced, preparedMatches: undefined },
        context,
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:prepared_advanced_matches_missing",
    );
  });

  it("rejects prepared selections whose plan, time, or authorization changed", () => {
    const prepared = preparedSelectionInput();

    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "prepared-scoped-v1",
        filters: EMPTY_FILTER_DOCUMENT,
        subject: SUBJECT,
        time: TIME,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:prepared_plan_identity_mismatch",
    );
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "prepared-scoped-v1",
        filters: prepared.filters,
        subject: SUBJECT,
        time: semanticTemporalDomainsFromQueryTime(
          createQueryTime(0, 200, "UTC", 200),
        ),
        expectedPlan: prepared.plan,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:prepared_time_mismatch",
    );

    const otherSubject = semanticSubjectFromQuerySubject(
      siteQueryContext("another-site", "private-dashboard").subject,
    );
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "prepared-scoped-v1",
        filters: prepared.filters,
        subject: otherSubject,
        time: TIME,
        expectedPlan: prepared.plan,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:subject_outside_prepared_authorization",
    );
  });

  it("rejects invalid prepared plan snapshots and identity kinds", () => {
    const prepared = preparedSelectionInput();
    const mismatchedScopeFilters = attachScopedFilterMetadata(
      prepared.filters,
      { ...prepared.metadata, resolvedScope: "visitor" },
    );
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "prepared-scoped-v1",
        filters: mismatchedScopeFilters,
        subject: SUBJECT,
        time: TIME,
        expectedPlan: prepared.plan,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:prepared_scope_mismatch",
    );

    const mismatchedPlan = {
      ...prepared.plan,
      expansion: "matching-visitors" as const,
    };
    const mismatchedPlanFilters = attachScopedFilterMetadata(prepared.filters, {
      ...prepared.metadata,
      plan: mismatchedPlan,
    });
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "prepared-scoped-v1",
        filters: mismatchedPlanFilters,
        subject: SUBJECT,
        time: TIME,
        expectedPlan: mismatchedPlan,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:prepared_plan_mismatch",
    );

    const advancedFilters = normalizeFilterDocument(
      parseFilterDsl(
        "session { session.views gte 1 } exists",
        analyticsFilterRegistry,
      ),
      analyticsFilterRegistry,
    );
    const advancedPrepared = preparedSelectionInput("session", advancedFilters);
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "prepared-scoped-v1",
        filters: advancedPrepared.filters,
        subject: SUBJECT,
        time: TIME,
        expectedPlan: advancedPrepared.plan,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:prepared_advanced_matches_missing",
    );

    const observations = withPreparedMatches("event", {
      eventIds: [{ siteId: SITE_ID, id: "event-1" }],
    });
    const context = {
      subject: SUBJECT,
      time: TIME,
    };
    const observationSnapshot = snapshotSemanticScopedSourceSelection(
      observations,
      {
        ...context,
        scope: resolveAnalyticsScope("event"),
        originOperation: "event-records",
      },
    );
    expect(observationSnapshot.preparedMatches?.identities[0]).not.toBe(
      observations.preparedMatches?.identities[0],
    );
    expect(() =>
      validateSemanticScopedSourceSelection(
        {
          ...observations,
          preparedMatches: {
            identities: [
              {
                ...observations.preparedMatches!.identities[0]!,
                kind: "session",
              },
            ],
          },
        },
        context,
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:invalid_observation_identity_kind",
    );

    const entities = withPreparedMatches("session", {
      entityIds: [{ siteId: SITE_ID, id: "session-1" }],
    });
    expect(() =>
      validateSemanticScopedSourceSelection(
        {
          ...entities,
          preparedMatches: {
            identities: [
              { ...entities.preparedMatches!.identities[0]!, kind: "visitor" },
            ],
          },
        },
        context,
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:invalid_entity_identity_kind",
    );

    const invalidIdentityPlan = {
      ...prepared.plan,
      advancedMatches: { visitIds: [{ siteId: "", id: "visit-1" }] },
    };
    const invalidIdentityFilters = attachScopedFilterMetadata(
      prepared.filters,
      {
        ...prepared.metadata,
        plan: invalidIdentityPlan,
      },
    );
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "prepared-scoped-v1",
        filters: invalidIdentityFilters,
        subject: SUBJECT,
        time: TIME,
        expectedPlan: invalidIdentityPlan,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:invalid_prepared_identity",
    );

    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "future-profile" as "direct-event-records-v1",
        filters: EMPTY_FILTER_DOCUMENT,
        subject: SUBJECT,
        time: TIME,
      }),
    ).toThrow("invalid_semantic_scoped_source_selection:unknown_profile");
  });

  it("rejects direct metadata, advanced direct filters, and invalid match snapshots", () => {
    const prepared = preparedSelectionInput();
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-event-records-v1",
        filters: prepared.filters,
        subject: SUBJECT,
        time: TIME,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:direct_profile_has_prepared_metadata",
    );

    const advancedFilters = normalizeFilterDocument(
      parseFilterDsl(
        "session { session.views gte 1 } exists",
        analyticsFilterRegistry,
      ),
      analyticsFilterRegistry,
    );
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-event-records-v1",
        filters: advancedFilters,
        subject: SUBJECT,
        time: TIME,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:direct_profile_requires_prepared_advanced_matches",
    );

    const validObservation = withPreparedMatches("event", {
      eventIds: [{ siteId: SITE_ID, id: "event-1" }],
    });
    expect(() =>
      validateSemanticScopedSourceSelection(
        {
          ...validObservation,
          preparedMatches: {
            identities: [
              {
                siteId: "unauthorized-site",
                kind: "event",
                id: "event-1",
              },
            ],
          },
        },
        { subject: SUBJECT, time: TIME },
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:invalid_prepared_identity_snapshot",
    );
  });

  it("enforces direct Page profile metadata, expression, and name gates", () => {
    const prepared = preparedSelectionInput();
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-page-analytics-v1",
        filters: prepared.filters,
        subject: SUBJECT,
        time: TIME,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:direct_profile_has_prepared_metadata",
    );

    const advancedFilters = normalizeFilterDocument(
      parseFilterDsl(
        "session { session.views gte 1 } exists",
        analyticsFilterRegistry,
      ),
      analyticsFilterRegistry,
    );
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-page-analytics-v1",
        filters: advancedFilters,
        subject: SUBJECT,
        time: TIME,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:direct_profile_requires_prepared_advanced_matches",
    );

    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-page-analytics-v1",
        filters: EMPTY_FILTER_DOCUMENT,
        subject: SUBJECT,
        time: TIME,
        eventName: "signup",
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:page_selection_event_name_unsupported",
    );
  });

  it("rejects compatibility selections with prepared or event-name metadata", () => {
    const prepared = preparedSelectionInput();
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-page-session-compat-v1",
        filters: prepared.filters,
        subject: SUBJECT,
        time: TIME,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:direct_profile_has_prepared_metadata",
    );

    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-page-session-compat-v1",
        filters: simpleSessionFilter("US"),
        subject: SUBJECT,
        time: TIME,
        eventName: "signup",
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:session_compatibility_event_name_unsupported",
    );

    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-page-session-compat-v1",
        filters: EMPTY_FILTER_DOCUMENT,
        subject: SUBJECT,
        time: TIME,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:session_compatibility_requires_filter",
    );

    const advancedFilters = normalizeFilterDocument(
      parseFilterDsl(
        "session { session.views gte 1 } exists",
        analyticsFilterRegistry,
      ),
      analyticsFilterRegistry,
    );
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-page-session-compat-v1",
        filters: advancedFilters,
        subject: SUBJECT,
        time: TIME,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:session_compatibility_requires_prepared_advanced_matches",
    );

    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-page-session-compat-v1",
        filters: simpleSessionFilter("US"),
        subject: createSemanticSubjectDomain({
          origin: "team",
          teamId: "compat-team" as never,
          siteIds: [SITE_ID as never, "another-site" as never],
        }),
        time: TIME,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:session_compatibility_requires_single_site",
    );
  });

  it("rejects tampered compatibility authorization and direct Page name gates", () => {
    const compatibility = createSemanticScopedSourceSelection({
      profile: "direct-page-session-compat-v1",
      filters: simpleSessionFilter("US"),
      subject: SUBJECT,
      time: TIME,
    });
    expect(() =>
      validateSemanticScopedSourceSelection(
        {
          ...compatibility,
          authorizedSiteIds: ["another-site", SITE_ID],
        },
        { subject: SUBJECT, time: TIME },
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:invalid_session_compatibility_profile",
    );
    expect(() =>
      validateSemanticScopedSourceSelection(
        { ...compatibility, scope: "event" },
        { subject: SUBJECT, time: TIME },
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:invalid_session_compatibility_profile",
    );

    const page = createSemanticScopedSourceSelection({
      profile: "direct-page-analytics-v1",
      filters: EMPTY_FILTER_DOCUMENT,
      subject: SUBJECT,
      time: TIME,
    });
    expect(() =>
      validateSemanticScopedSourceSelection(
        {
          ...page,
          eventNameGate: {
            value: "signup",
            semantics: "direct-subject-local-exact-name-v1",
          },
        },
        { subject: SUBJECT, time: TIME },
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:page_selection_event_name_unsupported",
    );
  });

  it("limits Journey no-fact Page compatibility to the requested entity scope", () => {
    const filter = simpleSessionFilter("US");
    const stage = createSemanticPostObservationFilter({
      filter: simpleSessionFilter("CA"),
    });
    const session = createSemanticScopedSourceSelection({
      profile: "direct-page-entity-only-compat-v1",
      filters: filter,
      subject: SUBJECT,
      time: TIME,
      compatibilityScope: "session",
      postObservationFilter: stage,
    });
    expect(session).toMatchObject({
      profile: "direct-page-entity-only-compat-v1",
      scope: "session",
      mode: "entity",
      entityKind: "session",
      postObservationFilter: stage,
      authorizedSiteIds: [SITE_ID],
    });
    const visitor = createSemanticScopedSourceSelection({
      profile: "direct-page-entity-only-compat-v1",
      filters: filter,
      subject: SUBJECT,
      time: TIME,
      compatibilityScope: "visitor",
    });
    expect(visitor).toMatchObject({
      scope: "visitor",
      mode: "entity",
      entityKind: "visitor",
    });

    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-page-entity-only-compat-v1",
        filters: EMPTY_FILTER_DOCUMENT,
        subject: SUBJECT,
        time: TIME,
        compatibilityScope: "visitor",
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:page_entity_compatibility_requires_filter",
    );
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-page-entity-only-compat-v1",
        filters: preparedSelectionInput("visitor", filter).filters,
        subject: SUBJECT,
        time: TIME,
        compatibilityScope: "visitor",
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:compatibility_profile_has_prepared_metadata",
    );
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-page-entity-only-compat-v1",
        filters: filter,
        subject: SUBJECT,
        time: TIME,
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:page_entity_compatibility_scope_required",
    );
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-page-entity-only-compat-v1",
        filters: filter,
        subject: SUBJECT,
        time: TIME,
        compatibilityScope: "visitor",
        eventName: "signup",
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:page_entity_compatibility_event_name_unsupported",
    );
    expect(() =>
      createSemanticScopedSourceSelection({
        profile: "direct-page-entity-only-compat-v1",
        filters: simpleSessionFilter("US"),
        subject: createSemanticSubjectDomain({
          origin: "team",
          teamId: "compat-team" as never,
          siteIds: [SITE_ID as never, "another-site" as never],
        }),
        time: TIME,
        compatibilityScope: "session",
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:page_entity_compatibility_requires_single_site",
    );

    expect(() =>
      validateSemanticScopedSourceSelection(
        { ...session, scope: "visitor" },
        { subject: SUBJECT, time: TIME },
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:invalid_page_entity_compatibility_profile",
    );
    expect(() =>
      validateSemanticScopedSourceSelection(
        { ...session, entityKind: "visitor" },
        { subject: SUBJECT, time: TIME },
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:invalid_page_entity_compatibility_profile",
    );
  });
});
