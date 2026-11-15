// @vitest-environment node
// Direct lower-layer F/S/R contract. Calls the real canonical builder and opaque
// preparation/binder; it does not reproduce their validation implementation.
// Calls the production lower-layer contract; the relation below is a unit fixture.
import { expect, it } from "vitest";

import {
  attachScopedFilterMetadata,
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { buildEventContextReportPlan } from "@/lib/edge/analytics/engine/event-context-report-plan";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import {
  bindPageVisitQualificationPreparation,
  createPageVisitQualificationPreparation,
  snapshotPageVisitQualificationPlan,
} from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import { projectWholeOriginalMembership } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-projection";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const siteId = "detail-time-site";
const ref = "event-filter-entity-membership-v1" as const;
const qualificationTime = createQueryTime(100, 200, "UTC", 300);
const sourcePreparationTime = createQueryTime(110, 190, "UTC", 300);
const readerTime = createQueryTime(120, 180, "UTC", 300);

function fixture(whole = true, separateSourceTime = true) {
  const q = prepareScopedQuery("event-context", {
    context: siteQueryContext(siteId, "private-dashboard"),
    time: qualificationTime,
    filters: parseFilterDsl("count(page) gt 0", analyticsFilterRegistry),
    scopePreference: "session",
  });
  const filters = q.filters!;
  const metadata = scopedFilterMetadata(filters)!;
  const sourceTime = separateSourceTime
    ? sourcePreparationTime
    : qualificationTime;
  const readFilters = attachScopedFilterMetadata(filters, {
    ...metadata,
    time: sourceTime,
  });
  const relation = projectWholeOriginalMembership({
    siteIds: [siteId],
    mode: "entity",
    matches: [],
  }).relations.entity!;
  const consumerKey = { kind: "event-type-detail", test: "F-S-R" };
  const preparation = createPageVisitQualificationPreparation({
    siteId,
    filters,
    queryTime: qualificationTime,
    scopePlan: metadata.plan,
    consumerKey,
    relation,
    dependencyRef: ref,
    maxSourcesPerRole: 2,
    ...(whole ? { qualificationSemantics: "whole-original" as const } : {}),
  });
  const plan = snapshotPageVisitQualificationPlan(
    buildEventContextReportPlan({
      siteId,
      limit: 10,
      filters: readFilters,
      queryTime: whole ? readerTime : sourceTime,
      scopePlan: metadata.plan,
      qualificationDependencyRefs: [ref],
      pageVisitDependencyRefs: [ref],
      ...(whole ? { qualificationSemantics: "whole-original" as const } : {}),
    }),
  );
  return {
    plan,
    sourceTime,
    binding: {
      preparation,
      siteId,
      filters,
      queryTime: qualificationTime,
      scopePlan: metadata.plan,
      consumerKey,
      plan,
      readerQueryTime: readerTime,
      ...(whole ? { readerFilters: readFilters } : {}),
    },
  };
}

it("checks fixed F while the canonical Event and Page Sources have separate S and R", () => {
  const f = fixture();
  const sources = f.plan.nodes.filter((node) => node.kind === "source");
  expect(sources.map((source) => source.entity)).toEqual(["event", "page"]);
  for (const source of sources) {
    expect(source.selection?.preparationTime).toEqual(
      semanticTemporalDomainsFromQueryTime(sourcePreparationTime),
    );
    expect(source.selection?.time).toEqual(
      semanticTemporalDomainsFromQueryTime(readerTime),
    );
  }
  expect(() =>
    bindPageVisitQualificationPreparation({
      ...f.binding,
      readerPreparationTime: sourcePreparationTime,
    }),
  ).not.toThrow();
});

it("does not let the new S input replace any fixed F validation", () => {
  const f = fixture();
  expect(() =>
    bindPageVisitQualificationPreparation({
      ...f.binding,
      queryTime: sourcePreparationTime,
      readerPreparationTime: sourcePreparationTime,
    }),
  ).toThrow("qualification_execution_plan_snapshot_mismatch");
});

it("rejects wrong S and wrong R independently", () => {
  const f = fixture();
  expect(() =>
    bindPageVisitQualificationPreparation({
      ...f.binding,
      readerPreparationTime: qualificationTime,
    }),
  ).toThrow("qualification_execution_plan_context_mismatch");
  expect(() =>
    bindPageVisitQualificationPreparation({
      ...f.binding,
      readerPreparationTime: sourcePreparationTime,
      readerQueryTime: qualificationTime,
    }),
  ).toThrow("qualification_execution_plan_context_mismatch");
});

it("does not infer S from a matching first Source while the Page Source differs", () => {
  const f = fixture();
  const changed = snapshotPageVisitQualificationPlan({
    ...f.plan,
    nodes: f.plan.nodes.map((node) =>
      node.kind === "source" && node.entity === "page" && node.selection
        ? {
            ...node,
            selection: {
              ...node.selection,
              preparationTime:
                semanticTemporalDomainsFromQueryTime(qualificationTime),
            },
          }
        : node,
    ),
  });
  expect(() =>
    bindPageVisitQualificationPreparation({
      ...f.binding,
      plan: changed,
      readerPreparationTime: sourcePreparationTime,
    }),
  ).toThrow("qualification_execution_plan_context_mismatch");
});

it("preserves whole-without-R rejection even when S is supplied", () => {
  const f = fixture();
  const {
    readerQueryTime: _reader,
    readerFilters: _filters,
    ...binding
  } = f.binding;
  expect(() =>
    bindPageVisitQualificationPreparation({
      ...binding,
      readerPreparationTime: sourcePreparationTime,
    }),
  ).toThrow("qualification_execution_plan_context_mismatch");
});

it("does not grant the S override to ordinary prepared readers", () => {
  const f = fixture(false, false);
  const { readerQueryTime: _reader, ...binding } = f.binding;
  expect(() => bindPageVisitQualificationPreparation(binding)).not.toThrow();
  const rejected = fixture(false, false);
  const { readerQueryTime: _rejectedReader, ...unsupported } = rejected.binding;
  expect(() =>
    bindPageVisitQualificationPreparation({
      ...unsupported,
      readerPreparationTime: sourcePreparationTime,
    }),
  ).toThrow("qualification_execution_reader_preparation_time_unsupported");
});

it("keeps the omitted-S whole path bound to the original fixed F", () => {
  const f = fixture(true, false);
  expect(() => bindPageVisitQualificationPreparation(f.binding)).not.toThrow();
});
