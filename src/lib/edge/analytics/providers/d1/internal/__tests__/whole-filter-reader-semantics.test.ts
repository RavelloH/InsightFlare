// @vitest-environment node
import { expect, it } from "vitest";

import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createPreparedMembership } from "@/lib/edge/analytics/contract/prepared-membership";
import type { SiteId } from "@/lib/edge/analytics/contract/types";
import { buildEventSummaryCardsPlan } from "@/lib/edge/analytics/engine/event-summary-cards-plan";
import {
  createSemanticPostObservationFilter,
  createSemanticScopedSourceSelection,
  type CreateSemanticScopedSourceSelectionInput,
  type SemanticScopedSourceSelection,
  validateSemanticScopedSourceSelection,
} from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import {
  bindPageVisitQualificationPreparation,
  createPageVisitQualificationPreparation,
  snapshotPageVisitQualificationPlan,
} from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import { projectWholeOriginalMembership } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-projection";
import {
  associateWholeOriginalCompletion,
  bindWholeOriginalReader,
} from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
const WHOLE = "prepared-whole-filter-reader-window-v1";
const REF = "event-filter-entity-membership-v1" as const;
function prepared(root: "advanced" | "native" | "empty" = "advanced") {
  const q = prepareScopedQuery("event-summary", {
    context: siteQueryContext("profile-site", "private-dashboard"),
    time: createQueryTime(100, 200, "UTC", 300),
    scopePreference: "session",
    filters: parseFilterDsl("count(page) gt 0", analyticsFilterRegistry),
  });
  const filters = q.filters!;
  if (root !== "advanced")
    Object.assign(filters, {
      root:
        root === "empty"
          ? null
          : parseFilterDsl('page.path eq "/a"', analyticsFilterRegistry).root,
    });
  const metadata = scopedFilterMetadata(filters)!;
  const subject = createSemanticSubjectDomain({
    origin: "site",
    siteIds: ["profile-site" as SiteId],
  });
  const time = semanticTemporalDomainsFromQueryTime(metadata.time!);
  const input = {
    profile: WHOLE,
    filters,
    subject,
    time,
    expectedPlan: metadata.plan,
    qualificationDependencyRefs: [REF],
  } satisfies CreateSemanticScopedSourceSelectionInput;
  return { q, filters, metadata, subject, time, input };
}
function reject(run: () => unknown) {
  let error: unknown;
  try {
    run();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}
function raw(
  selection: SemanticScopedSourceSelection,
  overrides: Record<string, unknown>,
) {
  return {
    ...JSON.parse(JSON.stringify(selection)),
    ...overrides,
  } as SemanticScopedSourceSelection;
}
function validate(selection: SemanticScopedSourceSelection) {
  validateSemanticScopedSourceSelection(selection, {
    subject: selection.subject,
    time: selection.time,
  });
}
it.each(["advanced", "native", "empty"] as const)(
  "explicit whole profile accepts genuine prepared %s tree but grants no lowering authority",
  (root) => {
    const f = prepared(root);
    const s = createSemanticScopedSourceSelection(f.input);
    expect(s.profile).toBe(WHOLE);
    expect(s.qualificationDependencyRefs).toEqual([REF]);
    expect(s.preparationTime).toEqual(f.time);
    validate(s);
    const plan = snapshotPageVisitQualificationPlan(
      buildEventSummaryCardsPlan({
        siteId: "profile-site",
        filters: f.filters,
        queryTime: f.metadata.time!,
        scopePlan: f.metadata.plan,
        qualificationDependencyRefs: [REF],
        qualificationSemantics: "whole-original",
      }),
    );
    expect(
      plan.nodes
        .filter((n) => n.kind === "source")
        .map((n) => n.selection?.profile),
    ).toEqual([WHOLE]);
    expect(
      () =>
        new AnalyticsLogicalToDbLowerer(plan, {
          siteIds: ["profile-site"],
          time: plan.context.time,
        }),
    ).toThrow("qualification_execution_dependency_unbound");
  },
);
it.each([
  "missing",
  "undefined",
  "empty",
  "duplicate",
  "wrong-role",
  "unknown",
] as const)(
  "creator and raw fresh validator reject %s refs for native/empty whole profile",
  (kind) => {
    for (const root of ["native", "empty"] as const) {
      const f = prepared(root);
      const s = createSemanticScopedSourceSelection(f.input);
      const input = { ...f.input } as unknown as Record<string, unknown>;
      const selection = raw(s, {});
      const refs =
        kind === "undefined"
          ? undefined
          : kind === "empty"
            ? []
            : kind === "duplicate"
              ? [REF, REF]
              : kind === "wrong-role"
                ? ["event-filter-page-visit-membership-v1"]
                : ["invented-ref"];
      if (kind === "missing") {
        delete input.qualificationDependencyRefs;
        Reflect.deleteProperty(selection, "qualificationDependencyRefs");
      } else {
        input.qualificationDependencyRefs = refs;
        Object.assign(selection, { qualificationDependencyRefs: refs });
      }
      reject(() =>
        createSemanticScopedSourceSelection(
          input as unknown as CreateSemanticScopedSourceSelectionInput,
        ),
      );
      reject(() => validate(selection));
    }
  },
);
it("requires real metadata, exact expected plan, full preparation time and authorization", () => {
  const f = prepared("empty");
  for (const change of [
    { filters: { version: 1, root: null } },
    { expectedPlan: { ...f.metadata.plan } },
    {
      subject: createSemanticSubjectDomain({
        origin: "site",
        siteIds: ["foreign" as SiteId],
      }),
    },
  ]) {
    reject(() =>
      createSemanticScopedSourceSelection({
        ...f.input,
        ...change,
      } as CreateSemanticScopedSourceSelectionInput),
    );
  }
  const s = createSemanticScopedSourceSelection(f.input);
  for (const change of [
    { preparationTime: undefined },
    {
      preparationTime: { ...s.preparationTime, read: { kind: "not-a-domain" } },
    },
    { scope: "visitor" },
    { authorizedSiteIds: ["foreign"] },
  ]) {
    reject(() => validate(raw(s, change)));
  }
});
it("legacy membership handle is forbidden in whole profile at both validation stages", () => {
  const f = prepared("empty");
  const s = createSemanticScopedSourceSelection(f.input);
  const handle = createPreparedMembership({
    siteIds: ["profile-site"],
    payload: {},
  });
  Object.assign(f.metadata.plan, { preparedMembership: handle });
  expect(() => createSemanticScopedSourceSelection(f.input)).toThrow(
    "prepared_matches_and_qualification_dependency_conflict",
  );
  expect(() => validate(raw(s, { preparedMembership: handle }))).toThrow(
    "whole_original_dependency_required",
  );
});
it.each([
  "prepared-scoped-v1",
  "prepared-page-reader-window-v1",
  "prepared-scoped-reader-window-v1",
] as const)("old %s remains advanced-only for refs", (profile) => {
  for (const root of ["native", "empty"] as const) {
    const f = prepared(root);
    const s = createSemanticScopedSourceSelection(f.input);
    expect(() =>
      createSemanticScopedSourceSelection({ ...f.input, profile }),
    ).toThrow("qualification_dependency_semantics_mismatch");
    expect(() =>
      validate(
        raw(s, {
          profile,
          ...(profile === "prepared-scoped-v1"
            ? { preparationTime: undefined }
            : {}),
        }),
      ),
    ).toThrow();
  }
});
it("direct/native default does not acquire whole-original permission or accept metadata", () => {
  const f = prepared("native");
  expect(() =>
    createSemanticScopedSourceSelection({
      ...f.input,
      profile: "direct-event-analytics-v1",
    }),
  ).toThrow("direct_profile_has_prepared_metadata");
  expect(() =>
    buildEventSummaryCardsPlan({
      siteId: "profile-site",
      filters: f.filters,
      queryTime: f.metadata.time!,
      scopePlan: f.metadata.plan,
      qualificationDependencyRefs: [REF],
    }),
  ).toThrow("qualification_dependency_semantics_mismatch");
});
it("new profile does not authorize postObservation or Event name gates", () => {
  const f = prepared("native");
  const s = createSemanticScopedSourceSelection(f.input);
  expect(() =>
    createSemanticScopedSourceSelection({ ...f.input, eventName: "other" }),
  ).toThrow("prepared_scoped_reader_window_event_name_unsupported");
  const stage = createSemanticPostObservationFilter({
    filter: parseFilterDsl('page.path eq "/"', analyticsFilterRegistry),
  });
  expect(() =>
    createSemanticScopedSourceSelection({
      ...f.input,
      postObservationFilter: stage,
    }),
  ).toThrow("post_observation_filter_profile_unsupported");
  expect(() => validate(raw(s, { postObservationFilter: stage }))).toThrow(
    "post_observation_filter_profile_unsupported",
  );
});
it("only existing opaque whole-original preparation can bind the new profile and exact frozen plan", () => {
  const f = prepared("empty");
  const projection = projectWholeOriginalMembership({
    siteIds: ["profile-site"],
    mode: "entity",
    matches: [],
  });
  const owner = { ...f.q };
  associateWholeOriginalCompletion(
    owner,
    { kind: "event-summary" },
    projection,
    { filters: f.filters, metadata: f.metadata },
  );
  const bound = bindWholeOriginalReader({
    owner,
    consumer: { kind: "event-summary" },
    siteId: "profile-site",
    filters: f.filters,
    queryTime: f.metadata.time!,
    scopePlan: f.metadata.plan,
  })!;
  const copied = snapshotPageVisitQualificationPlan(
    JSON.parse(JSON.stringify(bound.plan)),
  );
  expect(
    () =>
      new AnalyticsLogicalToDbLowerer(
        copied,
        { siteIds: ["profile-site"], time: copied.context.time },
        { qualificationExecutionInputs: bound.executionInputs },
      ),
  ).toThrow("qualification_execution_input_plan_mismatch");
  expect(
    () =>
      new AnalyticsLogicalToDbLowerer(
        bound.plan,
        { siteIds: ["profile-site"], time: bound.plan.context.time },
        { qualificationExecutionInputs: bound.executionInputs },
      ),
  ).not.toThrow();
  expect(
    () =>
      new AnalyticsLogicalToDbLowerer(
        bound.plan,
        { siteIds: ["profile-site"], time: bound.plan.context.time },
        { qualificationExecutionInputs: bound.executionInputs },
      ),
  ).toThrow("qualification_execution_input_plan_mismatch");
});
it("ordinary preparation cannot accept empty root or the new profile; whole prep cannot bind old profile", () => {
  const empty = prepared("empty");
  const projection = projectWholeOriginalMembership({
    siteIds: ["profile-site"],
    mode: "entity",
    matches: [],
  });
  const relation = projection.relations.entity!;
  expect(() =>
    createPageVisitQualificationPreparation({
      siteId: "profile-site",
      filters: empty.filters,
      queryTime: empty.metadata.time!,
      scopePlan: empty.metadata.plan,
      consumerKey: {},
      relation,
      dependencyRef: REF,
    }),
  ).toThrow("qualification_execution_preparation_invalid");
  for (const whole of [false, true]) {
    const f = prepared("advanced");
    const key = { review: "profile-pair" };
    const preparation = createPageVisitQualificationPreparation({
      siteId: "profile-site",
      filters: f.filters,
      queryTime: f.metadata.time!,
      scopePlan: f.metadata.plan,
      consumerKey: key,
      relation,
      dependencyRef: REF,
      ...(whole ? { qualificationSemantics: "whole-original" as const } : {}),
    });
    const plan = snapshotPageVisitQualificationPlan(
      buildEventSummaryCardsPlan({
        siteId: "profile-site",
        filters: f.filters,
        queryTime: f.metadata.time!,
        scopePlan: f.metadata.plan,
        qualificationDependencyRefs: [REF],
        ...(whole ? {} : { qualificationSemantics: "whole-original" as const }),
      }),
    );
    expect(() =>
      bindPageVisitQualificationPreparation({
        preparation,
        siteId: "profile-site",
        filters: f.filters,
        queryTime: f.metadata.time!,
        scopePlan: f.metadata.plan,
        consumerKey: key,
        plan,
        readerQueryTime: f.metadata.time!,
      }),
    ).toThrow("qualification_execution_plan_context_mismatch");
    if (!whole)
      expect(() =>
        bindPageVisitQualificationPreparation({
          preparation,
          siteId: "profile-site",
          filters: f.filters,
          queryTime: f.metadata.time!,
          scopePlan: f.metadata.plan,
          consumerKey: key,
          plan,
        }),
      ).toThrow("qualification_execution_plan_context_mismatch");
  }
});
it("present owner with replaced/missing metadata refuses rather than returning no association", () => {
  const f = prepared("native");
  const projection = projectWholeOriginalMembership({
    siteIds: ["profile-site"],
    mode: "entity",
    matches: [],
  });
  const owner = { ...f.q };
  associateWholeOriginalCompletion(
    owner,
    { kind: "event-summary" },
    projection,
    { filters: f.filters, metadata: f.metadata },
  );
  const filters = JSON.parse(JSON.stringify(f.filters));
  expect(() =>
    bindWholeOriginalReader({
      owner,
      consumer: { kind: "event-summary" },
      siteId: "profile-site",
      filters,
      queryTime: f.metadata.time!,
    }),
  ).toThrow("qualification_execution_plan_snapshot_mismatch");
});
it("whole-original preparation cannot downgrade to old prepared-scoped profile by omitting readerQueryTime", () => {
  const f = prepared("advanced");
  const projection = projectWholeOriginalMembership({
    siteIds: ["profile-site"],
    mode: "entity",
    matches: [],
  });
  const key = { review: "no-omitted-reader-downgrade" };
  const preparation = createPageVisitQualificationPreparation({
    siteId: "profile-site",
    filters: f.filters,
    queryTime: f.metadata.time!,
    scopePlan: f.metadata.plan,
    consumerKey: key,
    relation: projection.relations.entity!,
    dependencyRef: REF,
    qualificationSemantics: "whole-original",
  });
  const plan = snapshotPageVisitQualificationPlan(
    buildEventSummaryCardsPlan({
      siteId: "profile-site",
      filters: f.filters,
      queryTime: f.metadata.time!,
      scopePlan: f.metadata.plan,
      qualificationDependencyRefs: [REF],
    }),
  );
  expect(
    plan.nodes
      .filter((n) => n.kind === "source")
      .map((n) => n.selection?.profile),
  ).toEqual(["prepared-scoped-v1"]);
  expect(() =>
    bindPageVisitQualificationPreparation({
      preparation,
      siteId: "profile-site",
      filters: f.filters,
      queryTime: f.metadata.time!,
      scopePlan: f.metadata.plan,
      consumerKey: key,
      plan,
    }),
  ).toThrow("qualification_execution_plan_context_mismatch");
});
