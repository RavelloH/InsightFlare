import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  type CanonicalQuery,
  createQueryTime,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type * as mod1 from "@/lib/edge/analytics/engine/overview-previous-qualification-plan";
import type { OverviewPreviousConfiguration } from "@/lib/edge/analytics/engine/overview-previous-qualification-plan";
import type * as mod0 from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  d1AdvancedFilterMiddleware,
  type DeferredOverviewTrendQualification,
  deferredOverviewTrendQualificationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type * as mod2 from "@/lib/edge/analytics/providers/d1/internal/qualification-program-envelope";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

type PlanMutator = (plan: Record<string, unknown>) => Record<string, unknown>;
const hooks = vi.hoisted(() => ({
  trustFakes: false,
  mutatePlan: undefined as undefined | PlanMutator,
  buildError: undefined as undefined | Error,
  envelopeOverride: undefined as undefined | (() => unknown),
}));

vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution",
  async (importOriginal) => {
    const actual = await importOriginal<typeof mod0>();
    return {
      ...actual,
      isDeferredOverviewTrendQualification: (value: unknown) =>
        hooks.trustFakes ||
        actual.isDeferredOverviewTrendQualification(value as never),
      deferredOverviewTrendQualificationFromQuery: (
        query: unknown,
        operation: unknown,
      ) =>
        hooks.trustFakes
          ? (query as { __deferred?: unknown }).__deferred
          : actual.deferredOverviewTrendQualificationFromQuery(
              query as never,
              operation as never,
            ),
    };
  },
);

vi.mock(
  "@/lib/edge/analytics/engine/overview-previous-qualification-plan",
  async (importOriginal) => {
    const actual = await importOriginal<typeof mod1>();
    return {
      ...actual,
      buildOverviewPreviousQualificationPlan: (
        ...args: Parameters<
          typeof actual.buildOverviewPreviousQualificationPlan
        >
      ) => {
        if (hooks.buildError) throw hooks.buildError;
        const plan = actual.buildOverviewPreviousQualificationPlan(...args);
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
  compileOverviewPreviousQualificationProgram,
  executeOverviewPreviousQualificationProgram,
} from "@/lib/edge/analytics/providers/d1/internal/overview-previous-qualification-program";

const SITE = "overview-previous-gaps";
const BASE = Date.UTC(2024, 0, 1);
const DAY = 24 * 60 * 60 * 1000;
const CURRENT = createQueryTime(BASE, BASE + 21 * DAY, "UTC", BASE + 21 * DAY);
const PREVIOUS = createQueryTime(BASE - 21 * DAY, BASE, "UTC", BASE + 21 * DAY);

type Row = Record<string, unknown>;
type Captured = {
  readonly forwarded: CanonicalQuery<"overview">;
  readonly deferred: DeferredOverviewTrendQualification;
  readonly configuration: OverviewPreviousConfiguration;
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
    MAIN_SECRET: "overview-previous-gaps-secret",
  } as unknown as Env;
}

const captureCache = new Map<boolean, Promise<Captured>>();
function capture(detail: boolean) {
  let entry = captureCache.get(detail);
  if (!entry) {
    entry = captureUncached(detail);
    captureCache.set(detail, entry);
  }
  return entry;
}

async function captureUncached(detail: boolean): Promise<Captured> {
  const prepared = prepareScopedQuery("overview", {
    context: siteQueryContext(SITE, "private-dashboard"),
    time: CURRENT,
    filters: parseFilterDsl(
      'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1',
      analyticsFilterRegistry,
    ),
    scopePreference: "session",
  } as QueryInput & { readonly time: QueryTime });
  let forwarded: CanonicalQuery<"overview"> | undefined;
  let deferred: DeferredOverviewTrendQualification | undefined;
  await d1AdvancedFilterMiddleware(
    envWithTransform((rows) => rows),
    createD1ReadDiagnostics(),
    SITE,
  )(
    "overview",
    {
      ...prepared,
      time: CURRENT,
      previousTime: PREVIOUS,
      ...(detail ? { detailInterval: "week" } : {}),
    } as never,
    (next) => {
      forwarded = next as CanonicalQuery<"overview">;
      deferred = deferredOverviewTrendQualificationFromQuery(
        forwarded,
        "overview",
      );
      return Promise.resolve(undefined);
    },
  );
  if (!forwarded || !deferred) throw new Error("overview_gaps_missing");
  return {
    forwarded,
    deferred,
    configuration: deferred.configuration as OverviewPreviousConfiguration,
  };
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
       VALUES (?, 'gaps-team', 'Overview previous gaps', 'ov.test', 0)`,
    )
    .run(SITE);
});

afterAll(() => database.close());

const UNTRUSTED = "overview_previous_qualification_request_untrusted";

describe("overview previous request verification", () => {
  it("rejects configurations that are not deeply frozen trusted data", async () => {
    const { forwarded, deferred, configuration } = await capture(true);
    const compile = (candidate: unknown) =>
      compileOverviewPreviousQualificationProgram({
        query: forwarded,
        deferred,
        configuration: candidate as never,
      });
    expect(() => compile({ ...configuration })).toThrow(UNTRUSTED);
    expect(() =>
      compile(Object.freeze({ ...configuration, nested: { a: 1 } })),
    ).toThrow(UNTRUSTED);
    const cyclic: Record<string, unknown> = { ...configuration };
    cyclic.self = cyclic;
    expect(() => compile(Object.freeze(cyclic))).toThrow(UNTRUSTED);
    expect(() =>
      compile(
        Object.freeze(
          Object.defineProperty({ ...configuration }, "kind", {
            get: () => configuration.kind,
            enumerable: true,
          }),
        ),
      ),
    ).toThrow(UNTRUSTED);
    expect(() =>
      compile(
        new Proxy(Object.freeze({}), {
          ownKeys() {
            throw new Error("boom");
          },
        }),
      ),
    ).toThrow(UNTRUSTED);
    expect(() =>
      compile(Object.freeze({ ...configuration, when: new Date(0) })),
    ).toThrow(UNTRUSTED);
    expect(() =>
      compile(Object.freeze({ ...configuration, extra: true })),
    ).toThrow(UNTRUSTED);
    expect(() => compile(Object.freeze({ ...configuration, big: 1n }))).toThrow(
      UNTRUSTED,
    );
  });

  it("rejects forged deferred requests", async () => {
    const { forwarded, deferred, configuration } = await capture(true);
    expect(() =>
      compileOverviewPreviousQualificationProgram({
        query: forwarded,
        deferred: { ...deferred } as never,
        configuration,
      }),
    ).toThrow(UNTRUSTED);
    try {
      hooks.trustFakes = true;
      const attempt = (fake: unknown, config: unknown = configuration) =>
        compileOverviewPreviousQualificationProgram({
          query: { ...forwarded, __deferred: fake } as never,
          deferred: fake as never,
          configuration: config as never,
        });
      for (const badConfiguration of [
        "text",
        null,
        Object.freeze({ kind: "something-else" }),
        Object.freeze({}),
      ])
        expect(() =>
          attempt(
            Object.freeze({ ...deferred, configuration: badConfiguration }),
            badConfiguration,
          ),
        ).toThrow(UNTRUSTED);
      expect(() =>
        attempt(Object.freeze({ ...deferred, operation: "other" })),
      ).toThrow(UNTRUSTED);
      expect(() =>
        attempt(
          Object.freeze({
            ...deferred,
            qualification: Object.freeze({
              ...deferred.qualification,
              requestTime: undefined,
            }),
          }),
        ),
      ).toThrow(UNTRUSTED);
      expect(() => attempt({ ...deferred })).toThrow(UNTRUSTED);
    } finally {
      hooks.trustFakes = false;
    }
  });
});

describe("overview previous plan verification", () => {
  type Plan = {
    childQualification: Record<string, unknown> & {
      plan: { outputs: { id: string; fields: unknown[] }[] };
    };
    plan: { outputs: { id: string; fields: unknown[] }[]; nodes: unknown[] };
  };
  const mutate = (change: (plan: Plan) => Record<string, unknown>) => {
    hooks.mutatePlan = (plan) => change(plan as unknown as Plan);
  };
  const compileDetail = async () => {
    const { forwarded, deferred, configuration } = await capture(true);
    return () =>
      compileOverviewPreviousQualificationProgram({
        query: forwarded,
        deferred,
        configuration,
      });
  };

  it("rejects child and parent identity or schema drift", async () => {
    const compile = await compileDetail();
    try {
      mutate((plan) => ({
        ...plan,
        childQualification: {
          ...plan.childQualification,
          controlOutputId: "wrong",
        },
      }));
      expect(compile).toThrow(
        "overview_previous_qualification_child_identity_invalid",
      );

      mutate((plan) => ({
        ...plan,
        childQualification: {
          ...plan.childQualification,
          plan: {
            ...plan.childQualification.plan,
            outputs: plan.childQualification.plan.outputs.filter(
              (output) => output.id !== "overview-aggregate",
            ),
          },
        },
      }));
      expect(compile).toThrow(
        "overview_previous_qualification_output:overview-aggregate",
      );

      mutate((plan) => ({
        ...plan,
        childQualification: {
          ...plan.childQualification,
          plan: {
            ...plan.childQualification.plan,
            outputs: plan.childQualification.plan.outputs.map((output) =>
              output.id === "overview-aggregate"
                ? { ...output, fields: output.fields.slice(1) }
                : output,
            ),
          },
        },
      }));
      expect(compile).toThrow(
        "overview_previous_qualification_schema:overview-aggregate",
      );

      mutate((plan) => {
        const controlId = plan.childQualification.controlOutputId as string;
        return {
          ...plan,
          childQualification: {
            ...plan.childQualification,
            plan: {
              ...plan.childQualification.plan,
              outputs: plan.childQualification.plan.outputs.map((output) =>
                output.id === controlId
                  ? { ...output, fields: output.fields.slice(1) }
                  : output,
              ),
            },
          },
        };
      });
      expect(compile).toThrow(
        "overview_previous_qualification_controls_invalid",
      );

      mutate((plan) => ({ ...plan, controlOutputId: "wrong" }));
      expect(compile).toThrow(
        "overview_previous_qualification_parent_identity_invalid",
      );

      mutate((plan) => ({
        ...plan,
        plan: {
          ...plan.plan,
          nodes: plan.plan.nodes.filter(
            (node) => (node as { kind?: string }).kind !== "analysis-result",
          ),
        },
      }));
      expect(compile).toThrow(
        "overview_previous_qualification_child_snapshot_invalid",
      );
    } finally {
      hooks.mutatePlan = undefined;
    }
  });

  it("maps unsupported native splits to an unavailable result and rethrows others", async () => {
    const { forwarded, deferred, configuration } = await capture(false);
    const input = { query: forwarded, deferred, configuration };
    try {
      for (const message of [
        "overview_previous_native_filter_split_unsupported",
        "overview_previous_native_scope_plan_missing",
      ]) {
        hooks.buildError = new Error(message);
        expect(compileOverviewPreviousQualificationProgram(input)).toEqual({
          kind: "unavailable",
          fallbackReason: { kind: "compiler-unavailable" },
        });
        await expect(
          executeOverviewPreviousQualificationProgram({
            ...input,
            env: envWithTransform((rows) => rows),
          }),
        ).resolves.toEqual({
          kind: "unavailable",
          fallbackReason: { kind: "compiler-unavailable" },
        });
      }
      hooks.buildError = new Error("something_else");
      expect(() => compileOverviewPreviousQualificationProgram(input)).toThrow(
        "something_else",
      );
      hooks.buildError = "not an error" as unknown as Error;
      expect(() => compileOverviewPreviousQualificationProgram(input)).toThrow(
        "not an error",
      );
    } finally {
      hooks.buildError = undefined;
    }
  });

  it("returns an unavailable envelope compilation unchanged", async () => {
    const { forwarded, deferred, configuration } = await capture(false);
    const fallbackReason = {
      kind: "grouped-summary-unavailable",
      groupWidth: 1,
    };
    try {
      hooks.envelopeOverride = () => ({ kind: "unavailable", fallbackReason });
      expect(
        compileOverviewPreviousQualificationProgram({
          query: forwarded,
          deferred,
          configuration,
        }),
      ).toEqual({ kind: "unavailable", fallbackReason });
    } finally {
      hooks.envelopeOverride = undefined;
    }
  });
});

describe("overview previous row decoding", () => {
  const CURRENT_ID = "overview-current-aggregate";
  const PREVIOUS_ID = "overview-previous-aggregate";
  const TREND_ID = "overview-trend";
  type Make = (outputId: string, overrides?: Row) => Row;
  type Build = (context: { control: Row; make: Make }) => Row[];

  async function run(detail: boolean, build: Build) {
    const { forwarded, deferred, configuration } = await capture(detail);
    return executeOverviewPreviousQualificationProgram({
      env: envWithTransform((rows) => {
        const control = rows.find((row) => row.rowKind === "control");
        if (!control) throw new Error("control row missing");
        const blank: Row = {};
        for (const key of Object.keys(control)) blank[key] = null;
        const make: Make = (outputId, overrides = {}) => ({
          ...blank,
          rowKind: "report",
          outputId,
          bucket: outputId === TREND_ID ? 0 : null,
          views: 4,
          visitors: 2,
          sessions: 3,
          bounces: 1,
          totalDuration: 100,
          durationViews: 2,
          ...overrides,
        });
        return build({ control, make });
      }),
      query: forwarded,
      deferred,
      configuration,
    });
  }

  const P = "overview_previous_qualification_";

  it("orders aggregate rows first and trend rows by bucket", async () => {
    const result = await run(true, ({ control, make }) => [
      control,
      make(TREND_ID, { bucket: 2, totalDuration: null }),
      make(PREVIOUS_ID),
      make(CURRENT_ID),
      make(TREND_ID, { bucket: 1 }),
    ]);
    expect(result.kind).toBe("executed");
    if (result.kind !== "executed") return;
    expect(result.rows.map((row) => row.outputId)).toEqual([
      CURRENT_ID,
      PREVIOUS_ID,
      TREND_ID,
      TREND_ID,
    ]);
    expect(result.rows.slice(2).map((row) => row.bucket)).toEqual([1, 2]);
    expect(Object.isFrozen(result.rows)).toBe(true);
  });

  it("returns a control fallback", async () => {
    await expect(
      run(false, ({ control }) => [{ ...control, nullActivityIdCount: 2 }]),
    ).resolves.toEqual({
      kind: "fallback",
      fallbackReason: { kind: "null-activity-id" },
    });
  });

  const both = (make: Make) => [make(CURRENT_ID), make(PREVIOUS_ID)];
  const cases: readonly [string, boolean, Build, string][] = [
    [
      "a missing control row",
      false,
      ({ make }) => both(make),
      `${P}control_row_invalid`,
    ],
    [
      "a control row carrying report fields",
      false,
      ({ control }) => [{ ...control, views: 1 }],
      `${P}control_kind_mismatch`,
    ],
    [
      "an invalid control counter",
      false,
      ({ control }) => [{ ...control, rawCount: "1" }],
      `${P}control_invalid:rawCount`,
    ],
    [
      "report rows alongside a failed gate",
      false,
      ({ control, make }) => [
        { ...control, nullActivityIdCount: 1 },
        ...both(make),
      ],
      `${P}gate_violation`,
    ],
    [
      "invalid identities",
      false,
      ({ control }) => [{ ...control, invalidIdentityCount: 1 }],
      "advanced_filter_count_combined_identity_invalid",
    ],
    [
      "duplicate identities",
      false,
      ({ control }) => [{ ...control, duplicateIdentityCount: 1 }],
      "advanced_filter_count_combined_identity_repeated",
    ],
    [
      "a surplus report key",
      false,
      ({ control, make }) => [
        control,
        { ...make(CURRENT_ID), extra: 1 },
        make(PREVIOUS_ID),
      ],
      `${P}report_row_invalid`,
    ],
    [
      "an unexpected output id",
      false,
      ({ control, make }) => [control, make("overview-other")],
      `${P}report_row_invalid`,
    ],
    [
      "a trend row when detail is not requested",
      false,
      ({ control, make }) => [control, ...both(make), make(TREND_ID)],
      `${P}report_row_invalid`,
    ],
    [
      "a control value on a report row",
      false,
      ({ control, make }) => [control, make(CURRENT_ID, { rawCount: 0 })],
      `${P}report_row_invalid`,
    ],
    [
      "an aggregate row with a bucket",
      false,
      ({ control, make }) => [control, make(CURRENT_ID, { bucket: 0 })],
      `${P}aggregate_invalid`,
    ],
    [
      "a fractional aggregate count",
      false,
      ({ control, make }) => [control, make(CURRENT_ID, { views: 1.5 })],
      `${P}aggregate_invalid`,
    ],
    [
      "a negative aggregate count",
      false,
      ({ control, make }) => [control, make(CURRENT_ID, { bounces: -1 })],
      `${P}value_invalid:bounces`,
    ],
    [
      "a non-numeric aggregate duration",
      false,
      ({ control, make }) => [
        control,
        make(CURRENT_ID, { totalDuration: "x" }),
      ],
      `${P}value_invalid:totalDuration`,
    ],
    [
      "a repeated aggregate row",
      false,
      ({ control, make }) => [
        control,
        make(CURRENT_ID),
        make(CURRENT_ID),
        make(PREVIOUS_ID),
      ],
      `${P}report_cardinality_invalid`,
    ],
    [
      "a missing previous aggregate",
      false,
      ({ control, make }) => [control, make(CURRENT_ID)],
      `${P}report_cardinality_invalid`,
    ],
    [
      "a negative trend bucket",
      true,
      ({ control, make }) => [
        control,
        ...both(make),
        make(TREND_ID, { bucket: -1 }),
      ],
      `${P}value_invalid:bucket`,
    ],
    [
      "a negative trend count",
      true,
      ({ control, make }) => [
        control,
        ...both(make),
        make(TREND_ID, { visitors: -1 }),
      ],
      `${P}value_invalid:visitors`,
    ],
    [
      "a non-numeric trend duration",
      true,
      ({ control, make }) => [
        control,
        ...both(make),
        make(TREND_ID, { totalDuration: {} }),
      ],
      `${P}value_invalid:totalDuration`,
    ],
    [
      "duplicate trend buckets",
      true,
      ({ control, make }) => [
        control,
        ...both(make),
        make(TREND_ID, { bucket: 1 }),
        make(TREND_ID, { bucket: 1 }),
      ],
      `${P}report_cardinality_invalid`,
    ],
  ];

  it.each(cases)("rejects %s", async (_name, detail, build, message) => {
    await expect(run(detail, build)).rejects.toThrow(message);
  });
});
