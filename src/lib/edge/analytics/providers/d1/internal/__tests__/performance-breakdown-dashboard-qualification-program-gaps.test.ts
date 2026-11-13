import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  createQueryTime,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type * as mod1 from "@/lib/edge/analytics/engine/performance-breakdown-dashboard-qualification-plan";
import type * as mod0 from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  d1AdvancedFilterMiddleware,
  deferredPerformanceSummaryQualificationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type * as mod2 from "@/lib/edge/analytics/providers/d1/internal/qualification-program-envelope";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

const hooks = vi.hoisted(() => ({
  trustAnyRequest: false,
  mutatePlan: undefined as
    undefined | ((plan: Record<string, unknown>) => Record<string, unknown>),
  envelopeOverride: undefined as undefined | (() => unknown),
}));

vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution",
  async (importOriginal) => {
    const actual = await importOriginal<typeof mod0>();
    return {
      ...actual,
      isDeferredPerformanceSummaryQualificationRequest: (value: unknown) =>
        hooks.trustAnyRequest ||
        actual.isDeferredPerformanceSummaryQualificationRequest(value as never),
      deferredPerformanceSummaryQualificationFromQuery: (query: unknown) => {
        if (hooks.trustAnyRequest)
          return (query as { __deferred?: unknown }).__deferred;
        return actual.deferredPerformanceSummaryQualificationFromQuery(
          query as never,
        );
      },
    };
  },
);

vi.mock(
  "@/lib/edge/analytics/engine/performance-breakdown-dashboard-qualification-plan",
  async (importOriginal) => {
    const actual = await importOriginal<typeof mod1>();
    return {
      ...actual,
      buildPerformanceBreakdownDashboardQualificationPlan: (
        ...args: Parameters<
          typeof actual.buildPerformanceBreakdownDashboardQualificationPlan
        >
      ) => {
        const plan = actual.buildPerformanceBreakdownDashboardQualificationPlan(
          ...args,
        );
        return hooks.mutatePlan
          ? (hooks.mutatePlan(
              plan as unknown as Record<string, unknown>,
            ) as unknown as typeof plan)
          : plan;
      },
    };
  },
);

vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/qualification-program-envelope",
  async (importOriginal) => {
    const actual = await importOriginal<typeof mod2>();
    return {
      ...actual,
      compileQualificationProgramEnvelope: (
        ...args: Parameters<typeof actual.compileQualificationProgramEnvelope>
      ) =>
        hooks.envelopeOverride
          ? (hooks.envelopeOverride() as ReturnType<
              typeof actual.compileQualificationProgramEnvelope
            >)
          : actual.compileQualificationProgramEnvelope(...args),
    };
  },
);

import {
  compilePerformanceBreakdownDashboardQualificationProgram,
  executePerformanceBreakdownDashboardQualificationProgram,
} from "@/lib/edge/analytics/providers/d1/internal/performance-breakdown-dashboard-qualification-program";

const SITE = "performance-breakdown-gaps";
const BASE = Date.UTC(2026, 9, 5, 0);
const TIME: QueryTime = createQueryTime(
  BASE,
  BASE + 2 * 60 * 60_000,
  "UTC",
  BASE + 2 * 60 * 60_000,
);

type Row = Record<string, unknown>;
type Mode =
  | { mode: "dashboard"; interval: "hour" }
  | {
      mode: "breakdown";
      dimension: "page.path" | "geo.country";
      metric: "lcp";
      limit: number;
    };
const DASHBOARD: Mode = { mode: "dashboard", interval: "hour" };
const ROUTES: Mode = {
  mode: "breakdown",
  dimension: "page.path",
  metric: "lcp",
  limit: 5,
};
const COUNTRIES: Mode = {
  mode: "breakdown",
  dimension: "geo.country",
  metric: "lcp",
  limit: 5,
};

let database: DatabaseSync;

function trace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function envWithTransform(transform: (rows: readonly Row[]) => readonly Row[]) {
  const base = createSqliteD1Database(database, trace());
  return {
    DB: {
      prepare(sql: string) {
        const statement = base.prepare(sql);
        return {
          bind(...values: Parameters<typeof statement.bind>) {
            const bound = statement.bind(...values);
            return {
              async all<R extends object>() {
                const result = await bound.all<R>();
                return {
                  ...result,
                  results: transform(
                    result.results as unknown as readonly Row[],
                  ) as unknown as R[],
                };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
}

const setupCache = new Map<Mode, ReturnType<typeof setupUncached>>();
function setup(mode: Mode) {
  let entry = setupCache.get(mode);
  if (!entry) {
    entry = setupUncached(mode);
    setupCache.set(mode, entry);
  }
  return entry;
}

async function setupUncached(mode: Mode) {
  const prepared = prepareScopedQuery("performance", {
    context: siteQueryContext(SITE, "private-dashboard"),
    time: TIME,
    filters: parseFilterDsl(
      'count(event { event.name eq "qualifier" }) gte 1',
      analyticsFilterRegistry,
    ),
    scopePreference: "session",
  } as QueryInput & { readonly time: QueryTime });
  const query = (await d1AdvancedFilterMiddleware(
    { DB: createSqliteD1Database(database, trace()) } as unknown as Env,
    undefined,
    SITE,
  )(
    "performance",
    { ...prepared, time: TIME, ...mode } as never,
    async (value) => value,
  )) as QueryInput & Record<string, unknown>;
  const deferred = deferredPerformanceSummaryQualificationFromQuery(query);
  if (!deferred) throw new Error("performance_gaps_deferred_missing");
  return { query, deferred };
}

beforeAll(() => {
  database = createMigratedDatabase();
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE);
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'gaps-team', 'Performance gaps', 'perf.test', 0)`,
    )
    .run(SITE);
});

afterAll(() => database.close());

describe("performance breakdown/dashboard compile guards", () => {
  it("rejects requests that are not the trusted deferred brand", async () => {
    const { query, deferred } = await setup(DASHBOARD);
    expect(() =>
      compilePerformanceBreakdownDashboardQualificationProgram({
        query,
        deferred: { ...deferred } as never,
      }),
    ).toThrow("performance_breakdown_dashboard_qualification_request_invalid");
    expect(() =>
      compilePerformanceBreakdownDashboardQualificationProgram({
        query: { ...query },
        deferred,
      }),
    ).toThrow("performance_breakdown_dashboard_qualification_request_changed");
  });

  it("detects a query whose mode, dimension, metric, or interval drifted", async () => {
    const dashboard = await setup(DASHBOARD);
    const routes = await setup(ROUTES);
    const changed =
      "performance_breakdown_dashboard_qualification_request_changed";
    try {
      hooks.trustAnyRequest = true;
      const compile = (query: Record<string, unknown>, deferred: unknown) =>
        compilePerformanceBreakdownDashboardQualificationProgram({
          query: { ...query, __deferred: deferred } as never,
          deferred: deferred as never,
        });
      expect(() =>
        compile({ ...routes.query, mode: "dashboard" }, routes.deferred),
      ).toThrow(changed);
      expect(() =>
        compile({ ...routes.query, metric: "ttfb" }, routes.deferred),
      ).toThrow(changed);
      expect(() =>
        compile({ ...routes.query, dimension: "geo.country" }, routes.deferred),
      ).toThrow(changed);
      expect(() =>
        compile({ ...dashboard.query, interval: "day" }, dashboard.deferred),
      ).toThrow(changed);
      expect(() =>
        compile(dashboard.query, {
          ...dashboard.deferred,
          configuration: { mode: "unsupported" },
        }),
      ).toThrow("performance_breakdown_dashboard_qualification_mode_invalid");
    } finally {
      hooks.trustAnyRequest = false;
    }
  });

  it("rejects plans whose output identity drifted", async () => {
    const { query, deferred } = await setup(COUNTRIES);
    const compile = () =>
      compilePerformanceBreakdownDashboardQualificationProgram({
        query,
        deferred,
      });
    try {
      hooks.mutatePlan = (plan) => ({
        ...plan,
        reportOutputIds: (plan.reportOutputIds as string[]).slice(1),
      });
      expect(compile).toThrow(
        "performance_breakdown_dashboard_qualification_plan_identity_invalid",
      );
      hooks.mutatePlan = (plan) => {
        const inner = plan.plan as { outputs: { id: string }[] };
        const [first] = plan.reportOutputIds as string[];
        return {
          ...plan,
          plan: {
            ...inner,
            outputs: inner.outputs.filter((output) => output.id !== first),
          },
        };
      };
      expect(compile).toThrow(
        /^performance_breakdown_dashboard_qualification_output:/,
      );
    } finally {
      hooks.mutatePlan = undefined;
    }
  });

  it("surfaces an unavailable compilation and records its reason", async () => {
    const { query, deferred } = await setup(ROUTES);
    const fallbackReason = {
      kind: "grouped-summary-unavailable",
      groupWidth: 2,
    };
    try {
      hooks.envelopeOverride = () => ({ kind: "unavailable", fallbackReason });
      const diagnostics = createD1ReadDiagnostics();
      await expect(
        executePerformanceBreakdownDashboardQualificationProgram({
          env: envWithTransform((rows) => rows),
          query,
          deferred,
          diagnostics,
        }),
      ).resolves.toEqual({ kind: "unavailable", fallbackReason });
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual(
        fallbackReason,
      );
      await expect(
        executePerformanceBreakdownDashboardQualificationProgram({
          env: envWithTransform((rows) => rows),
          query,
          deferred,
        }),
      ).resolves.toEqual({ kind: "unavailable", fallbackReason });
    } finally {
      hooks.envelopeOverride = undefined;
    }
  });
});

describe("performance breakdown/dashboard row decoding", () => {
  type RowFactory = (
    rowType: "summary" | "trend" | "route" | "country",
    overrides?: Row,
    metric?: string,
  ) => Row;
  type Build = (context: { control: Row; row: RowFactory }) => Row[];

  async function run(
    mode: Mode,
    build: Build,
    diagnostics?: ReturnType<typeof createD1ReadDiagnostics>,
  ) {
    const { query, deferred } = await setup(mode);
    const compiled = compilePerformanceBreakdownDashboardQualificationProgram({
      query,
      deferred,
    });
    if (compiled.kind !== "compiled") throw new Error("not compiled");
    const descriptors = compiled.evidence.outputDescriptors;
    const controlFields = compiled.evidence.controlFields;
    return executePerformanceBreakdownDashboardQualificationProgram({
      env: envWithTransform((rows) => {
        const control = rows.find((row) => row.rowKind === "control");
        if (!control) throw new Error("control row missing");
        const blank: Row = {};
        for (const key of Object.keys(control)) blank[key] = null;
        for (const field of controlFields) blank[field] = null;
        const row: RowFactory = (rowType, overrides = {}, metric = "lcp") => {
          const descriptor = descriptors.find(
            (candidate) =>
              candidate.rowType === rowType &&
              candidate.outputId.endsWith(`-${metric}`),
          );
          if (!descriptor) throw new Error(`no output for ${rowType}`);
          return {
            ...blank,
            rowKind: "report",
            outputId: descriptor.outputId,
            rowType,
            metric,
            [`${metric}Samples`]: 2,
            [`${metric}AvgValue`]: 150,
            [`${metric}P50`]: 150,
            [`${metric}P75`]: 175,
            [`${metric}P95`]: 190,
            ...overrides,
          };
        };
        return build({ control, row });
      }),
      query,
      deferred,
      ...(diagnostics ? { diagnostics } : {}),
    });
  }

  const P = "performance_breakdown_dashboard_qualification_";

  it("maps a well-formed dashboard envelope", async () => {
    const result = await run(DASHBOARD, ({ control, row }) => [
      control,
      row("summary"),
      row("trend", { bucket: 1 }),
      row("trend", { bucket: 0 }),
      row("route", { pathname: "/b", views: 1 }),
      row("route", { pathname: "/a", views: 3 }),
      row("route", { pathname: "/c", views: 3 }),
      row("route", { pathname: "/a", views: 3 }, "ttfb"),
      row("country", { country: "US", views: 2 }),
    ]);
    expect(result.kind).toBe("executed");
  });

  it("maps route and country breakdown envelopes in sqlite order", async () => {
    const routes = await run(ROUTES, ({ control, row }) => [
      control,
      row("route", { pathname: "/z", views: 1 }),
      row("route", { pathname: "/é", views: 2 }),
      row("route", { pathname: "/a", views: 2 }),
      row("route", { pathname: "/ab", views: 2 }),
    ]).catch((error: unknown) => error);
    expect(routes).not.toBeInstanceOf(Error);
    expect(routes).toMatchObject({
      kind: "executed",
      value: { mode: "breakdown", dimension: "page.path", metric: "lcp" },
    });
    const countries = await run(COUNTRIES, ({ control, row }) => [
      control,
      row("country", { country: "US", views: 2 }),
      row("country", { country: "CA", views: 2 }),
    ]);
    expect(countries).toMatchObject({
      kind: "executed",
      value: { mode: "breakdown", dimension: "geo.country" },
    });
  });

  it("returns and records a control fallback", async () => {
    const diagnostics = createD1ReadDiagnostics();
    const result = await run(
      ROUTES,
      ({ control }) => [{ ...control, siteIdentityMismatchCount: 1 }],
      diagnostics,
    );
    expect(result).toEqual({
      kind: "fallback",
      fallbackReason: { kind: "site-identity-mismatch" },
    });
    expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
      kind: "site-identity-mismatch",
    });
  });

  const cases: readonly [string, Mode, Build, string | RegExp][] = [
    [
      "a missing control row",
      ROUTES,
      ({ row }) => [row("route", { pathname: "/a", views: 1 })],
      `${P}control_row_invalid`,
    ],
    [
      "a control row carrying report fields",
      ROUTES,
      ({ control }) => [{ ...control, metric: "lcp" }],
      `${P}control_kind_mismatch`,
    ],
    [
      "a negative control counter",
      ROUTES,
      ({ control }) => [{ ...control, duplicateIdentityCount: -1 }],
      `${P}control_invalid:duplicateIdentityCount`,
    ],
    [
      "report rows alongside a failed gate",
      ROUTES,
      ({ control, row }) => [
        { ...control, nullActivityIdCount: 1 },
        row("route", { pathname: "/a", views: 1 }),
      ],
      `${P}gate_violation`,
    ],
    [
      "invalid identities",
      ROUTES,
      ({ control }) => [{ ...control, invalidIdentityCount: 1 }],
      "advanced_filter_count_combined_identity_invalid",
    ],
    [
      "duplicate identities",
      ROUTES,
      ({ control }) => [{ ...control, duplicateIdentityCount: 1 }],
      "advanced_filter_count_combined_identity_repeated",
    ],
    [
      "an unknown output id",
      ROUTES,
      ({ control, row }) => [
        control,
        { ...row("route", { pathname: "/a", views: 1 }), outputId: "nope" },
      ],
      `${P}report_row_invalid`,
    ],
    [
      "a row type that disagrees with its output",
      ROUTES,
      ({ control, row }) => [
        control,
        row("route", { pathname: "/a", views: 1, rowType: "country" }),
      ],
      `${P}report_row_invalid`,
    ],
    [
      "a metric that disagrees with its output",
      ROUTES,
      ({ control, row }) => [
        control,
        row("route", { pathname: "/a", views: 1, metric: "ttfb" }),
      ],
      `${P}report_row_invalid`,
    ],
    [
      "a surplus report key",
      ROUTES,
      ({ control, row }) => [
        control,
        { ...row("route", { pathname: "/a", views: 1 }), surplus: 1 },
      ],
      `${P}report_row_invalid`,
    ],
    [
      "a control value on a report row",
      ROUTES,
      ({ control, row }) => [
        control,
        row("route", { pathname: "/a", views: 1, rawCount: 0 }),
      ],
      `${P}report_row_invalid`,
    ],
    [
      "foreign metric values on a report row",
      ROUTES,
      ({ control, row }) => [
        control,
        row("route", { pathname: "/a", views: 1, ttfbP50: 3 }),
      ],
      `${P}report_row_invalid`,
    ],
    [
      "negative samples",
      ROUTES,
      ({ control, row }) => [
        control,
        row("route", { pathname: "/a", views: 1, lcpSamples: -1 }),
      ],
      `${P}report_row_invalid`,
    ],
    [
      "non-numeric percentile",
      ROUTES,
      ({ control, row }) => [
        control,
        row("route", { pathname: "/a", views: 1, lcpP95: "fast" }),
      ],
      `${P}report_row_invalid`,
    ],
    [
      "a summary row with a bucket",
      DASHBOARD,
      ({ control, row }) => [control, row("summary", { bucket: 0 })],
      `${P}report_null_shape_invalid`,
    ],
    [
      "a trend bucket out of range",
      DASHBOARD,
      ({ control, row }) => [control, row("trend", { bucket: 2 })],
      `${P}report_null_shape_invalid`,
    ],
    [
      "a trend row with a pathname",
      DASHBOARD,
      ({ control, row }) => [
        control,
        row("trend", { bucket: 0, pathname: "/" }),
      ],
      `${P}report_null_shape_invalid`,
    ],
    [
      "a route row without a pathname",
      ROUTES,
      ({ control, row }) => [control, row("route", { views: 1 })],
      `${P}report_null_shape_invalid`,
    ],
    [
      "a route row with a country",
      ROUTES,
      ({ control, row }) => [
        control,
        row("route", { pathname: "/a", views: 1, country: "US" }),
      ],
      `${P}report_null_shape_invalid`,
    ],
    [
      "a country row with an empty country",
      COUNTRIES,
      ({ control, row }) => [
        control,
        row("country", { country: "", views: 1 }),
      ],
      `${P}report_null_shape_invalid`,
    ],
    [
      "a country row without views",
      COUNTRIES,
      ({ control, row }) => [control, row("country", { country: "US" })],
      `${P}report_null_shape_invalid`,
    ],
    [
      "duplicate route rows",
      ROUTES,
      ({ control, row }) => [
        control,
        row("route", { pathname: "/a", views: 1 }),
        row("route", { pathname: "/a", views: 2 }),
      ],
      `${P}report_duplicate`,
    ],
  ];

  it.each(cases)("rejects %s", async (_name, mode, build, message) => {
    await expect(run(mode, build)).rejects.toThrow(message);
  });
});
