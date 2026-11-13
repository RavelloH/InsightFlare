import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import type {
  CanonicalQuery,
  QueryInput,
  QueryTime,
} from "@/lib/edge/analytics/contract";
import {
  createQueryTime,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type * as mod0 from "@/lib/edge/analytics/engine/technology-share-trend-qualification-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredShareTrendQualificationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type * as mod1 from "@/lib/edge/analytics/providers/d1/internal/qualification-program-envelope";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

type PlanMutator = (plan: Record<string, unknown>) => Record<string, unknown>;
const hooks = vi.hoisted(() => ({
  mutatePlan: undefined as undefined | PlanMutator,
  envelopeOverride: undefined as undefined | (() => unknown),
}));

vi.mock(
  "@/lib/edge/analytics/engine/technology-share-trend-qualification-plan",
  async (importOriginal) => {
    const actual = await importOriginal<typeof mod0>();
    return {
      ...actual,
      buildTechnologyShareTrendQualificationPlan: (
        ...args: Parameters<
          typeof actual.buildTechnologyShareTrendQualificationPlan
        >
      ) => {
        const plan = actual.buildTechnologyShareTrendQualificationPlan(...args);
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
    const actual = await importOriginal<typeof mod1>();
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
  compileShareTrendQualificationProgram,
  executeShareTrendQualificationProgram,
} from "@/lib/edge/analytics/providers/d1/internal/technology/share-trend-qualification-program";

const SITE = "share-trend-gaps";
const BASE = Date.UTC(2026, 1, 1);
const HOUR = 60 * 60 * 1000;
const TIME = createQueryTime(BASE, BASE + 3 * HOUR, "UTC", BASE + 3 * HOUR);
const FILTER_DSL =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1';

type ShareQuery = CanonicalQuery<"share-trend">;
type Row = Record<string, unknown>;

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

function queryFor(variant: "browser" | "referrer-channel"): ShareQuery {
  const prepared = prepareScopedQuery("share-trend", {
    context: siteQueryContext(SITE, "private-dashboard"),
    time: TIME,
    filters: parseFilterDsl(FILTER_DSL, analyticsFilterRegistry),
    scopePreference: "session",
  } as QueryInput & { readonly time: QueryTime });
  return {
    ...prepared,
    time: TIME,
    interval: "hour",
    variant,
    limit: 2,
  } as unknown as ShareQuery;
}

const setupCache = new Map<string, ReturnType<typeof setupUncached>>();
function setup(variant: "browser" | "referrer-channel" = "browser") {
  let entry = setupCache.get(variant);
  if (!entry) {
    entry = setupUncached(variant);
    setupCache.set(variant, entry);
  }
  return entry;
}

async function setupUncached(
  variant: "browser" | "referrer-channel" = "browser",
) {
  const query = queryFor(variant);
  const forwarded = await d1AdvancedFilterMiddleware(
    { DB: createSqliteD1Database(database, trace()) } as unknown as Env,
    createD1ReadDiagnostics(),
    SITE,
  )("share-trend", query, async (next) => next);
  const deferred = deferredShareTrendQualificationFromQuery(forwarded);
  if (!deferred) throw new Error("share_trend_gaps_deferred_missing");
  return { deferred, forwarded };
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
       VALUES (?, 'gaps-team', 'Share trend gaps', 'share-trend.test', 0)`,
    )
    .run(SITE);
});

afterAll(() => database.close());

describe("share-trend qualification compile gaps", () => {
  it("rejects configurations that do not normalize to the deferred one", async () => {
    const { deferred, forwarded } = await setup();
    const configuration = deferred.configuration as unknown as Record<
      string,
      unknown
    >;
    const compile = (candidate: unknown) =>
      compileShareTrendQualificationProgram({
        deferred,
        query: forwarded,
        configuration: candidate as never,
      });
    const untrusted = "share_trend_qualification_request_untrusted";
    expect(() => compile(null)).toThrow(untrusted);
    expect(() => compile([])).toThrow(untrusted);
    expect(() => compile(Object.create({ ...configuration }))).toThrow(
      untrusted,
    );
    expect(() => compile({ ...configuration, interval: 1 })).toThrow(untrusted);
    expect(() => compile({ ...configuration, limit: 0 })).toThrow(untrusted);
    expect(() => compile({ ...configuration, limit: 13 })).toThrow(untrusted);
    expect(() => compile({ ...configuration, limit: 1.5 })).toThrow(untrusted);
    expect(() => compile({ ...configuration, extra: true })).toThrow(untrusted);
    expect(() => compile({ ...configuration, dimension: 3 })).toThrow(
      untrusted,
    );
    expect(() => compile({ ...configuration, dimension: "nope" })).toThrow(
      untrusted,
    );
    expect(() => compile({ ...configuration, kind: "bogus" })).toThrow(
      untrusted,
    );
    expect(() =>
      compile({ kind: "dual", interval: "hour", limit: 2, extra: 1 }),
    ).toThrow(untrusted);
    expect(() => compile({ kind: "dual", interval: "hour", limit: 2 })).toThrow(
      untrusted,
    );
    expect(() => compile({ ...configuration, dimension: "language" })).toThrow(
      untrusted,
    );
    expect(() =>
      compile(
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("boom");
            },
          },
        ),
      ),
    ).toThrow(untrusted);
    const accessor = Object.defineProperty({ ...configuration }, "interval", {
      get: () => "hour",
      enumerable: true,
    });
    expect(() => compile(accessor)).toThrow(untrusted);
  });

  it("rejects plans whose identity or schema drifted", async () => {
    const { deferred, forwarded } = await setup();
    const compile = () =>
      compileShareTrendQualificationProgram({
        deferred,
        query: forwarded,
        configuration: deferred.configuration,
      });
    try {
      hooks.mutatePlan = (plan) => ({ ...plan, controlOutputId: "wrong" });
      expect(compile).toThrow(
        "share_trend_qualification_plan_identity_invalid",
      );

      hooks.mutatePlan = (plan) => {
        const inner = plan.plan as { outputs: { id: string }[] };
        const reportIds = plan.reportOutputIds as string[];
        return {
          ...plan,
          plan: {
            ...inner,
            outputs: inner.outputs.filter(
              (output) => output.id !== reportIds[0],
            ),
          },
        };
      };
      expect(compile).toThrow(/^share_trend_qualification_output:/);

      hooks.mutatePlan = (plan) => {
        const inner = plan.plan as {
          outputs: { id: string; fields: unknown[] }[];
        };
        const reportIds = plan.reportOutputIds as string[];
        return {
          ...plan,
          plan: {
            ...inner,
            outputs: inner.outputs.map((output) =>
              output.id === reportIds[0]
                ? { ...output, fields: output.fields.slice(1) }
                : output,
            ),
          },
        };
      };
      expect(compile).toThrow(/^share_trend_qualification_schema:/);

      hooks.mutatePlan = (plan) => {
        const inner = plan.plan as {
          outputs: { id: string; fields: unknown[] }[];
        };
        return {
          ...plan,
          plan: {
            ...inner,
            outputs: inner.outputs.map((output) =>
              output.id === plan.controlOutputId
                ? { ...output, fields: output.fields.slice(1) }
                : output,
            ),
          },
        };
      };
      expect(compile).toThrow("share_trend_qualification_controls_invalid");
    } finally {
      hooks.mutatePlan = undefined;
    }
  });

  it("returns an unavailable compilation and records the fallback reason", async () => {
    const { deferred, forwarded } = await setup();
    const fallbackReason = {
      kind: "grouped-summary-unavailable",
      groupWidth: 3,
    };
    try {
      hooks.envelopeOverride = () => ({ kind: "unavailable", fallbackReason });
      expect(
        compileShareTrendQualificationProgram({
          deferred,
          query: forwarded,
          configuration: deferred.configuration,
        }),
      ).toEqual({ kind: "unavailable", fallbackReason });
      const diagnostics = createD1ReadDiagnostics();
      const withDiagnostics = await executeShareTrendQualificationProgram({
        env: envWithTransform((rows) => rows),
        deferred,
        query: forwarded,
        configuration: deferred.configuration,
        diagnostics,
      });
      expect(withDiagnostics).toEqual({ kind: "unavailable", fallbackReason });
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual(
        fallbackReason,
      );
      await expect(
        executeShareTrendQualificationProgram({
          env: envWithTransform((rows) => rows),
          deferred,
          query: forwarded,
          configuration: deferred.configuration,
        }),
      ).resolves.toEqual({ kind: "unavailable", fallbackReason });
    } finally {
      hooks.envelopeOverride = undefined;
    }
  });
});

describe("share-trend qualification row decoding", () => {
  async function run(
    build: (context: {
      control: Row;
      report: (overrides: Row) => Row;
      ids: { top: string; series: string; bucket: string };
    }) => Row[],
    variant: "browser" | "referrer-channel" = "browser",
    diagnostics?: ReturnType<typeof createD1ReadDiagnostics>,
  ) {
    const { deferred, forwarded } = await setup(variant);
    const compiled = compileShareTrendQualificationProgram({
      deferred,
      query: forwarded,
      configuration: deferred.configuration,
    });
    if (compiled.kind !== "compiled") throw new Error("not compiled");
    const [top, series, bucket] = compiled.evidence.descriptors.map(
      (descriptor) => descriptor.outputId,
    );
    return executeShareTrendQualificationProgram({
      env: envWithTransform((rows) => {
        const control = rows.find((row) => row.rowKind === "control");
        if (!control) throw new Error("control row missing");
        const blank: Row = {};
        for (const key of Object.keys(control)) blank[key] = null;
        const report = (overrides: Row): Row => ({
          ...blank,
          rowKind: "report",
          outputId: top,
          trendKind: "single",
          rowType: "top",
          bucket: null,
          label: "Chrome",
          views: 1,
          visitors: 1,
          sessions: 1,
          rowOrder: 1,
          ...overrides,
        });
        return build({
          control,
          report,
          ids: { top: top!, series: series!, bucket: bucket! },
        });
      }),
      deferred,
      query: forwarded,
      configuration: deferred.configuration,
      ...(diagnostics ? { diagnostics } : {}),
    });
  }

  it("accepts a well-formed envelope and freezes the report rows", async () => {
    const result = await run(({ control, report, ids }) => [
      control,
      report({}),
      report({
        outputId: ids.series,
        rowType: "series",
        rowOrder: 0,
        label: "Chrome",
      }),
      report({
        outputId: ids.bucket,
        rowType: "bucket",
        rowOrder: 0,
        bucket: 3,
        label: "Chrome",
      }),
      report({
        outputId: ids.bucket,
        rowType: "bucket",
        rowOrder: 0,
        bucket: null,
        label: "Chrome",
        visitors: 0,
        views: 0,
        sessions: 0,
      }),
    ]);
    expect(result.kind).toBe("executed");
    if (result.kind !== "executed") return;
    expect(result.rows).toHaveLength(4);
    expect(Object.isFrozen(result.rows)).toBe(true);
  });

  it("records a control fallback reason when no report rows exist", async () => {
    const diagnostics = createD1ReadDiagnostics();
    const result = await run(
      ({ control }) => [{ ...control, nullActivityIdCount: 1 }],
      "browser",
      diagnostics,
    );
    expect(result).toEqual({
      kind: "fallback",
      fallbackReason: { kind: "null-activity-id" },
    });
    expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
      kind: "null-activity-id",
    });
  });

  type Build = Parameters<typeof run>[0];
  const bucketBase = (
    report: (overrides: Row) => Row,
    ids: { bucket: string },
    overrides: Row = {},
  ) =>
    report({
      outputId: ids.bucket,
      rowType: "bucket",
      rowOrder: 0,
      bucket: 2,
      label: "a",
      ...overrides,
    });
  const P = "share_trend_qualification_";
  const cases: readonly [string, Build, string][] = [
    [
      "negative rawCount",
      ({ control }) => [{ ...control, rawCount: -1 }],
      `${P}control_invalid:rawCount`,
    ],
    [
      "gate violation",
      ({ control, report }) => [
        { ...control, nullActivityIdCount: 1 },
        report({}),
      ],
      `${P}gate_violation`,
    ],
    [
      "invalid identity",
      ({ control }) => [{ ...control, invalidIdentityCount: 1 }],
      "advanced_filter_count_combined_identity_invalid",
    ],
    [
      "duplicate identity",
      ({ control }) => [{ ...control, duplicateIdentityCount: 1 }],
      "advanced_filter_count_combined_identity_repeated",
    ],
    [
      "control carrying report fields",
      ({ control }) => [{ ...control, label: "unexpected" }],
      `${P}control_kind_mismatch`,
    ],
    [
      "two control rows",
      ({ control }) => [control, control],
      `${P}control_row_invalid`,
    ],
    [
      "report row with surplus key",
      ({ control, report }) => [control, { ...report({}), surplus: 1 }],
      `${P}report_row_invalid`,
    ],
    [
      "report row with control value",
      ({ control, report }) => [control, report({ rawCount: 0 })],
      `${P}report_row_invalid`,
    ],
    [
      "report row with non-string outputId",
      ({ control, report }) => [control, report({ outputId: 5 })],
      `${P}report_row_invalid`,
    ],
    [
      "unknown outputId",
      ({ control, report }) => [control, report({ outputId: "unknown" })],
      `${P}report_descriptor_invalid`,
    ],
    [
      "rowType mismatch",
      ({ control, report }) => [control, report({ rowType: "series" })],
      `${P}report_descriptor_invalid`,
    ],
    [
      "non-string label",
      ({ control, report }) => [control, report({ label: 1 })],
      `${P}report_descriptor_invalid`,
    ],
    ...["views", "visitors", "sessions", "rowOrder"].flatMap(
      (field): [string, Build, string][] => [
        [
          `negative ${field}`,
          ({ control, report }) => [control, report({ [field]: -1 })],
          `${P}value_invalid:${field}`,
        ],
        [
          `string ${field}`,
          ({ control, report }) => [control, report({ [field]: "1" })],
          `${P}value_invalid:${field}`,
        ],
      ],
    ),
    [
      "top row without rank",
      ({ control, report }) => [control, report({ rowOrder: 0 })],
      `${P}row_order_invalid`,
    ],
    [
      "series row with rank",
      ({ control, report, ids }) => [
        control,
        report({ outputId: ids.series, rowType: "series", rowOrder: 1 }),
      ],
      `${P}row_order_invalid`,
    ],
    ...[-1, 1.5, "7"].map((bucket): [string, Build, string] => [
      `bucket ${String(bucket)}`,
      ({ control, report, ids }) => [
        control,
        bucketBase(report, ids, { bucket }),
      ],
      `${P}bucket_invalid`,
    ]),
    [
      "top row with bucket",
      ({ control, report }) => [control, report({ bucket: 4 })],
      `${P}bucket_unexpected`,
    ],
    [
      "views without visitors",
      ({ control, report }) => [
        control,
        report({ visitors: 0, views: 1, sessions: 0 }),
      ],
      `${P}empty_counts_invalid`,
    ],
    [
      "sessions without visitors",
      ({ control, report }) => [
        control,
        report({ visitors: 0, views: 0, sessions: 1 }),
      ],
      `${P}empty_counts_invalid`,
    ],
    [
      "more top rows than the limit",
      ({ control, report }) => [
        control,
        report({ label: "a", rowOrder: 1 }),
        report({ label: "b", rowOrder: 2 }),
        report({ label: "c", rowOrder: 3 }),
      ],
      `${P}top_limit_invalid`,
    ],
    [
      "duplicate labels",
      ({ control, report }) => [
        control,
        report({ label: "a", rowOrder: 1 }),
        report({ label: "a", rowOrder: 2 }),
      ],
      `${P}report_duplicate_label`,
    ],
    [
      "duplicate bucket and label",
      ({ control, report, ids }) => [
        control,
        bucketBase(report, ids),
        bucketBase(report, ids),
      ],
      `${P}report_duplicate_bucket_label`,
    ],
  ];

  it.each(cases)("rejects %s", async (_name, build, message) => {
    await expect(run(build)).rejects.toThrow(message);
  });
});
