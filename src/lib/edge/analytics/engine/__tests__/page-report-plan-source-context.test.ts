import { describe, expect, it } from "vitest";

import {
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import type {
  QueryInput,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import { createSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

const SITE_ID = "page-report-source-context-site";
const QUERY_TIME = createQueryTime(0, 100, "UTC", 100);

function filter(country: string) {
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

function sessionCompatibilitySelection(input: {
  readonly siteId?: string;
  readonly queryTime?: QueryTime;
  readonly filters?: ReturnType<typeof filter>;
}) {
  return createSemanticScopedSourceSelection({
    profile: "direct-page-session-compat-v1",
    filters: input.filters ?? filter("US"),
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [(input.siteId ?? SITE_ID) as never],
    }),
    time: semanticTemporalDomainsFromQueryTime(input.queryTime ?? QUERY_TIME),
  });
}

function createPreparedSessionSelection() {
  const prepared = prepareScopedQuery("event-records", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: QUERY_TIME,
    filters: filter("US"),
    scopePreference: "session",
  } as QueryInput & { time: QueryTime });
  return createSemanticScopedSourceSelection({
    profile: "prepared-scoped-v1",
    filters: prepared.filters!,
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE_ID as never],
    }),
    time: semanticTemporalDomainsFromQueryTime(QUERY_TIME),
    expectedPlan: prepared.scopePlan!,
  });
}

describe("page report source context binding", () => {
  it.each([
    [
      "foreign subject",
      sessionCompatibilitySelection({ siteId: "other-site" }),
    ],
    [
      "foreign candidate and read time",
      sessionCompatibilitySelection({
        queryTime: createQueryTime(500, 600, "UTC", 600),
      }),
    ],
  ])("rejects an override with a %s before lowering", (_label, selection) => {
    expect(() =>
      createPageReportSource({
        siteId: SITE_ID,
        queryTime: QUERY_TIME,
        filters: filter("US"),
        sourceSelection: selection,
        attributes: [],
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:logical_context_mismatch",
    );
  });

  it("rejects an override whose filter differs from the requested filter", () => {
    expect(() =>
      createPageReportSource({
        siteId: SITE_ID,
        queryTime: QUERY_TIME,
        filters: filter("CA"),
        sourceSelection: sessionCompatibilitySelection({
          filters: filter("US"),
        }),
        attributes: [],
      }),
    ).toThrow("invalid_page_report_source_selection:override_mismatch");
  });

  it("does not allow prepared selections or scope plans through the override", () => {
    expect(() =>
      createPageReportSource({
        siteId: SITE_ID,
        queryTime: QUERY_TIME,
        filters: filter("US"),
        sourceSelection: createPreparedSessionSelection(),
        attributes: [],
      }),
    ).toThrow(
      "invalid_page_report_source_selection:override_profile_not_allowed",
    );

    expect(() =>
      createPageReportSource({
        siteId: SITE_ID,
        queryTime: QUERY_TIME,
        filters: filter("US"),
        scopePlan: {} as never,
        sourceSelection: sessionCompatibilitySelection({}),
        attributes: [],
      }),
    ).toThrow(
      "invalid_page_report_source_selection:override_with_prepared_scope_plan",
    );
  });

  it("keeps prepared proof time separate from a Page reader window", () => {
    const prepared = prepareScopedQuery("event-records", {
      context: siteQueryContext(SITE_ID, "private-dashboard"),
      time: QUERY_TIME,
      filters: filter("US"),
      scopePreference: "session",
    } as QueryInput & { time: QueryTime });
    const readerTime = createQueryTime(100, 200, "UTC", 200);
    const { builder, pages } = createPageReportSource({
      siteId: SITE_ID,
      queryTime: readerTime,
      filters: prepared.filters!,
      scopePlan: prepared.scopePlan!,
      preparedTimePolicy: "reader-window-v1",
      attributes: [],
    });
    const count = builder.aggregate(pages, {}, [
      { name: "rows", kind: "count-rows" },
    ]);
    builder.output("rows", count, [{ name: "rows", slot: "rows" }]);
    const plan = builder.finish();
    const source = plan.nodes.find((node) => node.kind === "source");
    expect(plan.context.time).toEqual(
      semanticTemporalDomainsFromQueryTime(readerTime),
    );
    expect(source).toMatchObject({
      kind: "source",
      selection: {
        profile: "prepared-page-reader-window-v1",
        time: semanticTemporalDomainsFromQueryTime(readerTime),
        preparationTime: semanticTemporalDomainsFromQueryTime(QUERY_TIME),
        scope: "session",
      },
    });

    expect(() =>
      createPageReportSource({
        siteId: SITE_ID,
        queryTime: readerTime,
        filters: prepared.filters!,
        scopePlan: prepared.scopePlan!,
        attributes: [],
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:prepared_time_mismatch",
    );
    expect(() =>
      createPageReportSource({
        siteId: SITE_ID,
        queryTime: readerTime,
        filters: filter("US"),
        preparedTimePolicy: "reader-window-v1",
        attributes: [],
      }),
    ).toThrow(
      "invalid_page_report_source_selection:reader_window_requires_prepared_scope_plan",
    );
  });

  it("accepts the matching direct session compatibility selection", () => {
    const { builder, pages } = createPageReportSource({
      siteId: SITE_ID,
      queryTime: QUERY_TIME,
      filters: filter("US"),
      sourceSelection: sessionCompatibilitySelection({}),
      attributes: [],
    });
    const count = builder.aggregate(pages, {}, [
      { name: "rows", kind: "count-rows" },
    ]);
    builder.output("rows", count, [{ name: "rows", slot: "rows" }]);

    const plan = builder.finish();
    const source = plan.nodes.find((node) => node.kind === "source");
    expect(plan.context.subject.siteIds).toEqual([SITE_ID]);
    expect(plan.context.time).toEqual(
      semanticTemporalDomainsFromQueryTime(QUERY_TIME),
    );
    expect(source).toMatchObject({
      kind: "source",
      selection: {
        profile: "direct-page-session-compat-v1",
        filter: filter("US"),
        subject: { siteIds: [SITE_ID] },
      },
    });
  });

  it("rejects prepared filter metadata paired with a compatibility override", () => {
    const prepared = prepareScopedQuery("event-records", {
      context: siteQueryContext(SITE_ID, "private-dashboard"),
      time: QUERY_TIME,
      filters: filter("US"),
      scopePreference: "session",
    } as QueryInput & { time: QueryTime });

    expect(() =>
      createPageReportSource({
        siteId: SITE_ID,
        queryTime: QUERY_TIME,
        filters: prepared.filters!,
        sourceSelection: sessionCompatibilitySelection({}),
        attributes: [],
      }),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:direct_profile_has_prepared_metadata",
    );
  });
});
