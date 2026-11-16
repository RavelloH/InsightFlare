// @vitest-environment node
// Real Seq requests are never deferred: the middleware evaluates the whole
// tree once and the consumers read a request-private membership. These tests
// run every consumer family with a Seq filter twice, once through the real SQL
// sequence membership and once with the sequence classifier forced to refuse
// (the independent Core oracle), and require identical, non-empty answers.
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  prepareScopedQuery,
  type QueryInput,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as sequenceSupport from "@/lib/edge/analytics/engine/advanced-filter-sequence-support";
import * as sequenceEnvelope from "@/lib/edge/analytics/engine/advanced-sequence-envelope";
import * as afe from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";

import { COST_TIME } from "./remote-d1/referrers-cost-harness";
import {
  buildDataStatements,
  buildSiteStatements,
  SEED_SITE_ID,
} from "./remote-d1/seed";

afterEach(() => vi.restoreAllMocks());

const END = COST_TIME.range.endExclusiveMs - COST_TIME.range.startMs - 1;
const SEQUENCE = `sequence([window(page { page.path eq "/qualifier" },@range.start,[0ms,${END}ms]),window(event { event.name eq "qualifier" },@range.start,[0ms,${END}ms])]) exists`;
const COUNT = 'count(event { event.name eq "qualifier" }) gte 1';
const SQL_MEMBERSHIP =
  "sql-membership:whole-tree-sequence-membership-supported";
const FORCED_CORE = "bounded-core:forced_sequence_core_oracle";

interface Family {
  readonly name: string;
  readonly operation: string;
  readonly extra: Record<string, unknown>;
  /** Proves the answer is not empty, so equality cannot hold vacuously. */
  readonly nonEmpty: (data: Record<string, unknown>) => boolean;
}
const FAMILIES: readonly Family[] = [
  {
    name: "Referrers summary",
    operation: "referrers",
    extra: { variant: "summary", topN: 10 },
    nonEmpty: (data) => Number(data.totalViews) > 0,
  },
  {
    name: "Visitors list",
    operation: "visitors",
    extra: {
      page: { limit: 2, cursor: null },
      sort: { key: "lastSeenAt", direction: "desc" },
    },
    nonEmpty: (data) => (data.items as unknown[]).length > 0,
  },
  {
    name: "Sessions list",
    operation: "sessions",
    extra: {
      page: { limit: 2, cursor: null },
      sort: { key: "startedAt", direction: "desc" },
    },
    nonEmpty: (data) => (data.items as unknown[]).length > 0,
  },
  {
    name: "Event summary",
    operation: "event-summary",
    extra: {},
    nonEmpty: (data) => Number((data.summary as { events: number }).events) > 0,
  },
  {
    name: "Event types",
    operation: "event-types",
    extra: { limit: 5 },
    nonEmpty: (data) => (data.items as unknown[]).length > 0,
  },
];

type Scope = "session" | "visitor";

function seededDatabase() {
  const database = createMigratedDatabase();
  for (const statement of [
    ...buildSiteStatements(),
    ...buildDataStatements({ visits: 48 }),
  ])
    database.exec(statement);
  return database;
}

function envFor(database: ReturnType<typeof createMigratedDatabase>): Env {
  return {
    DB: createSqliteD1Database(database),
    MAIN_SECRET: "seq-parity-cursor-secret",
  } as Env;
}

function queryFor(
  family: Family,
  scope: Scope,
  dsl: string,
  extra: Record<string, unknown> = {},
) {
  return {
    ...prepareScopedQuery(
      family.operation as never,
      {
        context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
        filters: parseFilterDsl(dsl, analyticsFilterRegistry),
        scopePreference: scope,
        time: COST_TIME,
      } as QueryInput,
    ),
    ...family.extra,
    ...extra,
  };
}

interface Outcome {
  readonly result: {
    readonly ok: boolean;
    readonly data?: Record<string, unknown>;
    readonly error?: unknown;
  };
  readonly strategies: string[];
  readonly fallbackEntries: unknown;
}

async function execute(input: {
  readonly family: Family;
  readonly scope: Scope;
  readonly oracle: boolean;
  readonly extra?: Record<string, unknown>;
  readonly prepare?: () => void;
}): Promise<Outcome> {
  const database = seededDatabase();
  try {
    if (input.oracle)
      vi.spyOn(sequenceSupport, "classifyTwoStepSequence").mockReturnValue({
        kind: "unsupported",
        code: "forced_sequence_core_oracle",
        path: "root",
        reason: "Independent Core oracle.",
      });
    input.prepare?.();
    const diagnostics = createD1ReadDiagnostics();
    const result = await createD1SiteQueryRuntime({
      env: envFor(database),
      siteId: SEED_SITE_ID,
      diagnostics,
    }).execute(
      input.family.operation as never,
      queryFor(input.family, input.scope, SEQUENCE, input.extra) as never,
    );
    return {
      result: result as Outcome["result"],
      strategies: (diagnostics.advancedFilterExecutionHistory ?? []).map(
        ({ strategy, reason }) => `${strategy}:${reason}`,
      ),
      fallbackEntries: diagnostics.advancedFallbackEntries,
    };
  } finally {
    vi.restoreAllMocks();
    database.close();
  }
}

describe("Seq through the request-private membership", () => {
  for (const family of FAMILIES)
    for (const scope of ["session", "visitor"] as const)
      it(`${family.name} (${scope}) equals the complete Core oracle`, async () => {
        const real = await execute({ family, scope, oracle: false });
        const oracle = await execute({ family, scope, oracle: true });
        expect(real.result.ok).toBe(true);
        expect(oracle.result.ok).toBe(true);
        // Not vacuous: there is a real, non-empty answer to compare.
        expect(family.nonEmpty(real.result.data!)).toBe(true);
        expect(real.result).toEqual(oracle.result);
        // The routes really differ: SQL sequence membership against Core.
        expect(real.strategies).toEqual([SQL_MEMBERSHIP]);
        expect(oracle.strategies).toEqual([FORCED_CORE]);
        // Neither route used the complete event-qualification fallback door.
        expect(real.fallbackEntries).toBeUndefined();
        expect(oracle.fallbackEntries).toBeUndefined();
      });

  for (const family of FAMILIES.filter((entry) =>
    ["visitors", "sessions"].includes(entry.operation),
  ))
    it(`${family.name} continues a signed cursor identically on both routes`, async () => {
      const first = await execute({ family, scope: "session", oracle: false });
      const firstOracle = await execute({
        family,
        scope: "session",
        oracle: true,
      });
      const cursor = (
        first.result.data as { pagination: { nextCursor: string | null } }
      ).pagination.nextCursor;
      expect(cursor).not.toBeNull();
      const extra = { page: { limit: 2, cursor } };
      const second = await execute({
        family,
        scope: "session",
        oracle: false,
        extra,
      });
      const secondOracle = await execute({
        family,
        scope: "session",
        oracle: true,
        extra,
      });
      expect(firstOracle.result).toEqual(first.result);
      expect(second.result.ok).toBe(true);
      expect(second.result).toEqual(secondOracle.result);
      expect(second.result.data).not.toEqual(first.result.data);
    });

  it("never defers a Seq request, while the same request with a Count filter is deferred", async () => {
    const database = seededDatabase();
    try {
      const env = envFor(database);
      for (const family of FAMILIES) {
        const middleware = afe.d1AdvancedFilterMiddleware(
          env,
          undefined,
          SEED_SITE_ID,
        );
        const forward = async (dsl: string) =>
          middleware(
            family.operation as never,
            queryFor(family, "session", dsl) as never,
            async (value: unknown) => value,
          );
        const sequence = await forward(SEQUENCE);
        const count = await forward(COUNT);
        expect(
          afe.deferredEventQualificationFromQuery(
            sequence,
            family.operation as never,
          ),
          `${family.name} (Seq)`,
        ).toBeUndefined();
        expect(
          afe.deferredEventQualificationFromQuery(
            count,
            family.operation as never,
          ),
          `${family.name} (Count)`,
        ).toBeDefined();
        // The list consumers carry a registered membership for Seq.
        if (["visitors", "sessions"].includes(family.operation))
          expect(
            scopedFilterMetadata((sequence as { filters: never }).filters)?.plan
              .preparedMembership,
            `${family.name} membership`,
          ).toBeDefined();
      }
    } finally {
      database.close();
    }
  });

  it.each([
    ["filter_sequence_match_limit_exceeded", "sequence_match_limit"],
    ["filter_sequence_work_limit_exceeded", "sequence_work_limit"],
  ])(
    "an exceeded Seq bound (%s) ends the same way when the SQL acceptance refuses and when Core is forced",
    async (code, acceptance) => {
      const family = FAMILIES[0]!;
      const boundedCoreRefusal = () =>
        vi.spyOn(core, "evaluateFilterDocument").mockImplementation(() => {
          throw new Error(code);
        });
      // The SQL membership refuses (its own bound), so the whole original
      // Core request continues and reports the bound.
      const afterSqlRefusal = await execute({
        family,
        scope: "session",
        oracle: false,
        prepare: () => {
          vi.spyOn(sequenceEnvelope, "acceptSequenceAggregate").mockReturnValue(
            {
              kind: "fallback",
              reason: acceptance,
            },
          );
          boundedCoreRefusal();
        },
      });
      const forcedCore = await execute({
        family,
        scope: "session",
        oracle: true,
        prepare: boundedCoreRefusal,
      });
      expect(afterSqlRefusal.result.ok).toBe(false);
      expect(afterSqlRefusal.result).toEqual(forcedCore.result);
      // The executor records the SQL attempt, then the continued Core request.
      expect(afterSqlRefusal.strategies).toEqual([
        SQL_MEMBERSHIP,
        `bounded-core:sql-runtime-${acceptance}`,
      ]);
      expect(forcedCore.strategies).toEqual([FORCED_CORE]);
    },
  );
});
