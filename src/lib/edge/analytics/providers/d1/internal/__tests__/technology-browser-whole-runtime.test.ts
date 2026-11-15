// @vitest-environment node
import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import type { CanonicalQuery, QueryTime } from "@/lib/edge/analytics/contract";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as versionPlan from "@/lib/edge/analytics/engine/browser-version-breakdown-report-plan";
import * as cardPlan from "@/lib/edge/analytics/engine/page-card-details-report-plan";
import * as metricPlan from "@/lib/edge/analytics/engine/page-card-metrics-report-plan";
import * as pagePlan from "@/lib/edge/analytics/engine/page-report-plan";
import * as tabPlan from "@/lib/edge/analytics/engine/page-tabs-report-plan";
import * as wholeFamily from "@/lib/edge/analytics/engine/page-whole-original-family";
import * as withTabsPlan from "@/lib/edge/analytics/engine/pages-with-tabs-report-plan";
import * as referrerPlan from "@/lib/edge/analytics/engine/referrer-report-plan";
import * as crossPlan from "@/lib/edge/analytics/engine/technology-cross-breakdown-report-plan";
import * as radarPlan from "@/lib/edge/analytics/engine/technology-radar-report-plan";
import * as sharePlan from "@/lib/edge/analytics/engine/technology-share-trend-report-plan";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as reportQueries from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";

const baseTime = createQueryTime(
  SEED_BASE_MS,
  SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);
const whole =
  'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"';
const count = 'count(event { event.name eq "qualifier" }) gt 0';
const narrow =
  'sequence([window(page { page.path neq "/excluded" },@range.start,[0ms,604799999ms]),window(event { event.name eq "qualifier" },@range.start,[0ms,604799999ms])]) exists';
const fixture = buildJourneyEventFieldsCostFixture(24);
const enrichment =
  "UPDATE visits SET title='Title '||pathname,query_string=CASE WHEN visit_id IN ('v0','v1') THEN '?q=1' ELSE '' END,browser_version=CASE WHEN visit_id IN ('v0','v1','v2') THEN '120.0' ELSE '121.0' END";
type Operation =
  | "pages"
  | "pages-dashboard"
  | "referrers"
  | "dimension"
  | "cross-dimension"
  | "geo-points";
type Spec = {
  key: string;
  operation: Operation;
  fields: Record<string, unknown>;
};
const specs: readonly Spec[] = [
  {
    key: "browser-cross",
    operation: "cross-dimension",
    fields: {
      variant: "browser",
      browserLimit: 2,
      osLimit: 2,
      deviceTypeLimit: 2,
    },
  },
  { key: "geo-points", operation: "geo-points", fields: { limit: 2 } },
  {
    key: "page-card-dashboard",
    operation: "pages-dashboard",
    fields: {
      interval: "day",
      page: { limit: 2, cursor: null },
      sort: { key: "views", direction: "desc" },
    },
  },
  {
    key: "entry-boundary",
    operation: "dimension",
    fields: {
      mode: "breakdown",
      dimension: "session.entryPath",
      page: { limit: 2, cursor: null },
    },
  },
  {
    key: "exit-boundary",
    operation: "dimension",
    fields: {
      mode: "breakdown",
      dimension: "session.exitPath",
      page: { limit: 2, cursor: null },
    },
  },
  {
    key: "plain-page-dimension",
    operation: "dimension",
    fields: {
      mode: "breakdown",
      dimension: "client.browser",
      page: { limit: 2, cursor: null },
    },
  },
];
function databaseFixture() {
  const database = createMigratedDatabase();
  for (const sql of [...fixture.seed, enrichment]) database.exec(sql);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "w36-native-only",
  } as unknown as Env;
  return { database, trace, env };
}
const originalBuilders = {
  page: pagePlan.buildPagesPagePlan,
  topPage: pagePlan.buildTopPagesPlan,
  tabs: tabPlan.buildPageTabsPlan,
  withTabs: withTabsPlan.buildPagesWithTabsPlan,
  metrics: metricPlan.buildPageCardMetricsPlan,
  rollup: metricPlan.buildPageCardMetricsRollupPlan,
  details: cardPlan.buildPageCardDetailsPlan,
  referrer: referrerPlan.buildReferrersPagePlan,
  summary: referrerPlan.buildReferrerSummaryPlan,
  radar: radarPlan.buildTechnologyRadarPlan,
  version: versionPlan.buildBrowserVersionBreakdownPlan,
  share: sharePlan.buildTechnologyShareTrendPlan,
  channelShare: sharePlan.buildTechnologyReferrerChannelTrendPlan,
  cross: crossPlan.buildTechnologyCrossBreakdownPlan,
  browserCross: crossPlan.buildTechnologyBrowserCrossBreakdownPlan,
};
function builderSpies(events: string[]) {
  const hit = (kind: string) => events.push(`builder:${kind}`);
  return [
    vi.spyOn(pagePlan, "buildPagesPagePlan").mockImplementation((...a) => {
      hit("pages-page");
      return originalBuilders.page(...a);
    }),
    vi.spyOn(pagePlan, "buildTopPagesPlan").mockImplementation((...a) => {
      hit("pages-top");
      return originalBuilders.topPage(...a);
    }),
    vi.spyOn(tabPlan, "buildPageTabsPlan").mockImplementation((...a) => {
      hit("page-tabs");
      return originalBuilders.tabs(...a);
    }),
    vi
      .spyOn(withTabsPlan, "buildPagesWithTabsPlan")
      .mockImplementation((...a) => {
        hit("pages-with-tabs");
        return originalBuilders.withTabs(...a);
      }),
    vi
      .spyOn(metricPlan, "buildPageCardMetricsPlan")
      .mockImplementation((...a) => {
        hit("page-card-metrics");
        return originalBuilders.metrics(...a);
      }),
    vi
      .spyOn(metricPlan, "buildPageCardMetricsRollupPlan")
      .mockImplementation((...a) => {
        hit("page-card-rollup");
        return originalBuilders.rollup(...a);
      }),
    vi
      .spyOn(cardPlan, "buildPageCardDetailsPlan")
      .mockImplementation((...a) => {
        hit("page-card-details");
        return originalBuilders.details(...a);
      }),
    vi
      .spyOn(referrerPlan, "buildReferrersPagePlan")
      .mockImplementation((...a) => {
        hit("referrers-page");
        return originalBuilders.referrer(...a);
      }),
    vi
      .spyOn(referrerPlan, "buildReferrerSummaryPlan")
      .mockImplementation((...a) => {
        hit("referrers-summary");
        return originalBuilders.summary(...a);
      }),
    vi
      .spyOn(radarPlan, "buildTechnologyRadarPlan")
      .mockImplementation((...a) => {
        hit("technology-radar");
        return originalBuilders.radar(...a);
      }),
    vi
      .spyOn(versionPlan, "buildBrowserVersionBreakdownPlan")
      .mockImplementation((...a) => {
        hit("browser-version");
        return originalBuilders.version(...a);
      }),
    vi
      .spyOn(sharePlan, "buildTechnologyShareTrendPlan")
      .mockImplementation((...a) => {
        hit("technology-share");
        return originalBuilders.share(...a);
      }),
    vi
      .spyOn(sharePlan, "buildTechnologyReferrerChannelTrendPlan")
      .mockImplementation((...a) => {
        hit("referrer-channel-share");
        return originalBuilders.channelShare(...a);
      }),
    vi
      .spyOn(crossPlan, "buildTechnologyCrossBreakdownPlan")
      .mockImplementation((...a) => {
        hit("technology-cross");
        return originalBuilders.cross(...a);
      }),
    vi
      .spyOn(crossPlan, "buildTechnologyBrowserCrossBreakdownPlan")
      .mockImplementation((...a) => {
        hit("browser-cross");
        return originalBuilders.browserCross(...a);
      }),
  ];
}
function pagination(result: unknown): unknown {
  if (!result || typeof result !== "object") return undefined;
  const v = Reflect.get(result, "value");
  if (!v || typeof v !== "object") return undefined;
  return (
    Reflect.get(v, "pagination") ??
    Reflect.get(Reflect.get(v, "pages") ?? {}, "pagination")
  );
}
type Options = {
  scope: "session" | "visitor";
  dsl?: string;
  variant?: string;
  timeMode?: "empty" | "fullHistory" | "independent";
  fields?: Record<string, unknown>;
  page2?: boolean;
  expectError?: boolean;
  coreError?: boolean;
  mutation?: "root-null" | "root-native" | "abort-success";
};
async function capture(spec: Spec, opt: Options) {
  const f = databaseFixture(),
    diagnostics = createD1ReadDiagnostics(),
    events: string[] = [];
  const q0 = prepareScopedQuery(spec.operation, {
    ...spec.fields,
    ...opt.fields,
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time: baseTime,
    filters: parseFilterDsl(opt.dsl ?? whole, analyticsFilterRegistry),
    scopePreference: opt.scope,
  });
  const plannedTime = q0.time;
  const time: QueryTime =
    opt.timeMode === "empty"
      ? { ...plannedTime, filterRangeEmpty: true }
      : opt.timeMode === "fullHistory"
        ? { ...plannedTime, fullHistory: true }
        : opt.timeMode === "independent"
          ? {
              ...plannedTime,
              filterRange: {
                startMs: baseTime.range.startMs + 1,
                endExclusiveMs: baseTime.range.endExclusiveMs,
              },
            }
          : plannedTime;
  const meta = scopedFilterMetadata(q0.filters)!;
  const q = {
    ...q0,
    time,
    filters: opt.timeMode
      ? attachScopedFilterMetadata(q0.filters, { ...meta, time })
      : q0.filters,
  };
  const requestBefore = JSON.parse(JSON.stringify(q)),
    scopedMetadataBefore = JSON.parse(
      JSON.stringify(scopedFilterMetadata(q.filters)),
    );
  const marker = new Error("w36-original-Core-error"),
    abort = new AbortController();
  const actualCore = core.evaluateFilterDocument,
    actualRegister = bridge.registerPreparedMembership;
  const register = vi
    .spyOn(bridge, "registerPreparedMembership")
    .mockImplementation((...a) => {
      events.push("register");
      return actualRegister(...a);
    });
  const evaluate = vi
    .spyOn(core, "evaluateFilterDocument")
    .mockImplementation((...a) => {
      events.push("Core");
      if (opt.coreError) {
        abort.abort();
        throw marker;
      }
      const value = actualCore(...a);
      if (opt.mutation === "root-null")
        Object.assign(q.filters, { root: null });
      if (opt.mutation === "root-native")
        Object.assign(q.filters, {
          root: parseFilterDsl(
            'page.path eq "/excluded"',
            analyticsFilterRegistry,
          ).root,
        });
      if (opt.mutation === "abort-success") abort.abort();
      queueMicrotask(() => events.push("Core-reaction"));
      return value;
    });
  const planCalls: unknown[] = [];
  const summarize = (plan: unknown, kind: string, selection: unknown) => {
    const p = plan as {
      outputs?: unknown[];
      nodes?: {
        kind: string;
        entity?: string;
        selection?: unknown;
        filter?: unknown;
      }[];
    };
    planCalls.push({
      kind,
      selection,
      outputs: p.outputs,
      sources: p.nodes?.filter((n) => n.kind === "source"),
    });
  };
  const originalRows = reportQueries.queryAnalyticsReportOutputRowsFromD1,
    originalSet = reportQueries.queryAnalyticsReportOutputSetRowsFromD1;
  const reportSpies = [
    vi
      .spyOn(reportQueries, "queryAnalyticsReportOutputRowsFromD1")
      .mockImplementation((...a) => {
        summarize(a[1], "rows", a[2]);
        return originalRows(...a);
      }),
    vi
      .spyOn(reportQueries, "queryAnalyticsReportOutputSetRowsFromD1")
      .mockImplementation((...a) => {
        summarize(a[1], "output-set", a[2]);
        return originalSet(...a);
      }),
  ];
  const builders = builderSpies(events);
  try {
    const provider = createD1SiteProviderRegistry({
      env: f.env,
      siteId: SEED_SITE_ID,
      diagnostics,
    }).resolve(spec.operation)!;
    let value: unknown,
      error: unknown,
      errorIdentity = false,
      secondPage: unknown;
    const execute = (input: typeof q) =>
      provider.execute(input as CanonicalQuery<Operation>, {
        signal: abort.signal,
      });
    try {
      const pending = execute(q);
      events.push("execute-returned");
      value = await pending;
      events.push("resolved");
      if (opt.page2) {
        const p = pagination(value);
        const cursor =
          p && typeof p === "object" ? Reflect.get(p, "nextCursor") : undefined;
        expect(typeof cursor).toBe("string");
        const next = { ...q, page: { limit: 2, cursor } };
        secondPage = await execute(next);
      }
    } catch (e) {
      errorIdentity = e === marker;
      error =
        e instanceof Error
          ? {
              name: e.name,
              message: e.message,
              details: Object.fromEntries(
                Object.getOwnPropertyNames(e)
                  .filter((k) => k !== "stack")
                  .map((k) => [k, Reflect.get(e, k)]),
              ),
            }
          : { thrown: String(e) };
      events.push("rejected");
    }
    const record = {
      key: spec.key,
      operation: spec.operation,
      options: opt,
      requestBefore,
      scopedMetadataBefore,
      request: q,
      value,
      secondPage,
      error,
      errorIdentity,
      signalAborted: abort.signal.aborted,
      events,
      planCalls,
      coreCalls: evaluate.mock.calls.length,
      bridgeCalls: register.mock.calls.length,
      diagnostics,
      sql: f.trace.preparedSql.map((sql, i) => ({
        sql,
        params: f.trace.bindings[i],
      })),
      rowsRead: null,
      rowsReadReason: "native adapter has no genuine rows_read metadata",
    };
    if (opt.coreError) {
      expect(errorIdentity).toBe(true);
      expect(register).not.toHaveBeenCalled();
    } else if (opt.expectError) expect(error).toBeDefined();
    else expect(error).toBeUndefined();
    return record;
  } finally {
    for (const s of reportSpies) s.mockRestore();
    for (const s of builders) s.mockRestore();
    register.mockRestore();
    evaluate.mockRestore();
    f.database.close();
  }
}

for (const scope of ["session", "visitor"] as const)
  for (const spec of specs.filter((entry) => entry.key === "browser-cross"))
    for (const [strategy, dsl] of [
      ["whole-core", whole],
      ["count", count],
      ["narrow-seq", narrow],
    ] as const) {
      it(`${spec.key}/${scope}/${strategy} preserves the actual legacy reader`, async () => {
        const legacySelector = vi
          .spyOn(wholeFamily, "pageWholeOriginalFamilyFromQuery")
          .mockReturnValue(undefined);
        let old;
        try {
          old = await capture(spec, { scope, dsl, variant: strategy });
        } finally {
          legacySelector.mockRestore();
        }
        const actual = await capture(spec, { scope, dsl, variant: strategy });
        const observable = ({
          bridgeCalls: _bridge,
          events: _events,
          planCalls: _plans,
          ...record
        }: typeof actual) => JSON.parse(JSON.stringify(record));
        expect(observable(actual)).toEqual(observable(old));
        expect(actual.bridgeCalls).toBe(
          spec.key === "browser-cross" && strategy !== "count"
            ? 0
            : old.bridgeCalls,
        );
        if (spec.key === "browser-cross" && strategy !== "count")
          expect(old.bridgeCalls).toBe(1);
      });
    }
