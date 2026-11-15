import { afterEach, describe, expect, it, vi } from "vitest";

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
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { SiteId } from "@/lib/edge/analytics/contract/types";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import {
  type SequenceSqlExecutionInput,
  tryEvaluateSequenceSql,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-sequence-query";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";
import type { FilterDocument } from "@/lib/filter-contract/filters";

import { createMigratedDatabase } from "../../../../../../../../scripts/schema/database";
import {
  buildDataStatements,
  buildSiteStatements,
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "./remote-d1/seed";

const databases: ReturnType<typeof createMigratedDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});
function fixture(
  scope: "session" | "visitor" = "session",
  firstPredicate = 'page.path eq "/qualifier"',
  bare = false,
) {
  const db = createMigratedDatabase();
  databases.push(db);
  for (const statement of [
    ...buildSiteStatements(),
    ...buildDataStatements({ visits: 30 }),
  ])
    db.exec(statement);
  const trace: SqliteD1Trace = {
    preparedSql: [],
    bindings: [],
    readBigIntsAsNumbers: true,
  };
  const end = SEED_BASE_MS + SEED_DAY_MS * SEED_DAYS;
  const wrap = (step: string) =>
    bare
      ? step
      : `window(${step},@range.start,[0ms,${end - SEED_BASE_MS - 1}ms])`;
  const document = parseFilterDsl(
    `sequence([${wrap(`page { ${firstPredicate} }`)},${wrap('event { event.name eq "qualifier" }')}]) exists`,
    analyticsFilterRegistry,
  );
  const prepared = prepareScopedQuery("performance", {
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    filters: document,
    scopePreference: scope,
    time: createQueryTime(SEED_BASE_MS, end, "UTC", end),
  } as QueryInput) as unknown as {
    filters: FilterDocument;
    scopePlan: ScopedFilterPlan;
    time: QueryTime;
  };
  const diagnostics = createD1ReadDiagnostics();
  const input: SequenceSqlExecutionInput = {
    env: { DB: createSqliteD1Database(db, trace) } as Env,
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SEED_SITE_ID as SiteId],
    }),
    siteIds: [SEED_SITE_ID],
    filters: prepared.filters,
    plan: prepared.scopePlan,
    time: prepared.time,
    diagnostics,
  };
  return { db, trace, input, diagnostics };
}
describe("one-statement Seq execution port", () => {
  it.each(["session", "visitor"] as const)(
    "executes a prepared explicit window exactly once for %s",
    async (scope) => {
      const f = fixture(scope),
        evaluator = vi.spyOn(core, "evaluateFilterDocument");
      const result = await tryEvaluateSequenceSql(f.input);
      expect(result.kind).toBe("evaluated");
      if (result.kind !== "evaluated") throw new Error(result.reason);
      expect(result.matches.length).toBeGreaterThan(0);
      expect(evaluator).not.toHaveBeenCalled();
      expect(f.trace.preparedSql).toHaveLength(1);
      // The native SQLite adapter has no D1 read metadata; do not invent it.
      expect(f.diagnostics.rowsReadAvailable).toBe(false);
      const bounds = [...f.trace.preparedSql[0]!.matchAll(/LIMIT \?(?:\d+)?/g)];
      expect(bounds).toHaveLength(1);
      expect(
        f.trace.bindings[0]!.filter((value) => value === 20001),
      ).toHaveLength(1);
    },
  );
  it("keeps bare prepared Seq full-history and reads nothing before Core fallback", async () => {
    const f = fixture("session", undefined, true);
    expect(f.input.time.fullHistory).toBe(true);
    expect(await tryEvaluateSequenceSql(f.input)).toEqual({
      kind: "fallback",
      reason: "sequence_sql_independent_time_domains",
    });
    expect(f.trace.preparedSql).toEqual([]);
  });
  it("rejects a site outside the authorized subject without storage access", async () => {
    const f = fixture();
    expect(
      await tryEvaluateSequenceSql({ ...f.input, siteIds: ["unauthorized"] }),
    ).toEqual({ kind: "fallback", reason: "sequence_site_context_mismatch" });
    expect(f.trace.preparedSql).toEqual([]);
  });
  it("preserves cancellation before the read", async () => {
    const f = fixture(),
      controller = new AbortController();
    controller.abort();
    await expect(
      tryEvaluateSequenceSql({ ...f.input, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.trace.preparedSql).toEqual([]);
  });
  it("preserves cancellation after the single read", async () => {
    const f = fixture(),
      controller = new AbortController(),
      database = f.input.env.DB;
    const wrapped = {
      prepare(sql: string) {
        const statement = database.prepare(sql),
          all = statement.all.bind(statement);
        statement.all = async <T>() => {
          const result = await all<T>();
          controller.abort();
          return result;
        };
        return statement;
      },
    } as D1Database;
    await expect(
      tryEvaluateSequenceSql({
        ...f.input,
        env: { ...f.input.env, DB: wrapped },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.trace.preparedSql).toHaveLength(1);
  });
  it("declines D1 statement budgets before a new read or public error", async () => {
    const predicate = Array.from(
      { length: 100 },
      (_, index) => `page.path contains "/unique-${index}"`,
    ).join(" OR ");
    const f = fixture("session", predicate);
    expect(await tryEvaluateSequenceSql(f.input)).toEqual({
      kind: "fallback",
      reason: "sequence_compile_budget",
    });
    expect(f.trace.preparedSql).toEqual([]);
  });
});
