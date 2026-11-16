import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import type { CanonicalQuery, QueryInput } from "@/lib/edge/analytics/contract";
import {
  createQueryTime,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { d1AdvancedFilterMiddleware } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { executeSessionListQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/session-list-qualification-program";
import { deferredSessionListQualificationFromQuery } from "@/lib/edge/analytics/providers/d1/internal/session-list-qualification-request";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

const SITE_ID = "session-list-program-guards";
const BASE = Date.UTC(2026, 9, 1);
const END = BASE + 24 * 60 * 60 * 1000;
const FILTER_DSL =
  'page.path eq "/match" and count(page { page.path eq "/match" }) gte 1';
const PREFIX = "session_list_qualification";

type Row = Record<string, unknown>;
type Operation = "sessions" | "visitor-sessions";

interface Hooks {
  /** Runs when the Goal/Funnel definition lookup statement executes. */
  readonly onAnalysisLookup?: () => void;
  /** Runs for the Visitor target presence query (neither envelope nor lookup). */
  readonly onPresenceQuery?: () => void;
}

function seedFixture(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  const site = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(SITE_ID) as { readonly site_pk: number };
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'guards-team', 'Session guards', 'baseline.test', 0)`,
    )
    .run(SITE_ID);
  const insert = database.prepare(
    `INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, pathname, hostname
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'baseline.test')`,
  );
  for (const [index, id] of ["one", "two"].entries()) {
    insert.run(
      `visit-${id}`,
      SITE_ID,
      Number(site.site_pk),
      "visitor-shared",
      `session-${id}`,
      BASE + 1_000 * (index + 1),
      BASE + 1_000 * (index + 1) + 400,
      "/match",
    );
  }
  const insertDefinition = database.prepare(
    `INSERT INTO analysis_definitions (
      id, site_id, kind, name, config_json, config_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertDefinition.run(
    "goal-ok",
    SITE_ID,
    "goal",
    "goal-ok",
    JSON.stringify({ filterDslVersion: 1, filterDsl: 'page.path eq "/match"' }),
    1,
    BASE,
    BASE,
  );
  insertDefinition.run(
    "funnel-ok",
    SITE_ID,
    "funnel",
    "funnel-ok",
    JSON.stringify({
      filterDslVersion: 1,
      progressionScope: "session",
      conversionWindowMs: null,
      steps: [
        { id: "step-0", filterDsl: 'page.path eq "/match"' },
        { id: "step-1", filterDsl: 'page.path eq "/never"' },
      ],
    }),
    2,
    BASE,
    BASE,
  );
}

function d1With(
  database: DatabaseSync,
  rewrite: (results: Row[]) => unknown,
  hooks: Hooks,
): NonNullable<Env["DB"]> {
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const base = createSqliteD1Database(database, trace);
  const proxy = {
    prepare(sql: string) {
      const statement = base.prepare(sql);
      const lookup = sql.includes('"analysis_definitions"');
      const envelope = sql.includes('"rowKind"') && sql.includes('"outputId"');
      const prepared = {
        bind(...values: Parameters<typeof statement.bind>) {
          statement.bind(...values);
          return prepared;
        },
        async first<R>() {
          const result = await statement.first<R>();
          if (lookup) hooks.onAnalysisLookup?.();
          return result;
        },
        async all<R>() {
          const result = await statement.all<R>();
          if (lookup) hooks.onAnalysisLookup?.();
          else if (!envelope) hooks.onPresenceQuery?.();
          if (!envelope) return result;
          return {
            ...result,
            results: rewrite(result.results as Row[]) as R[],
          };
        },
        run() {
          return statement.run();
        },
      };
      return prepared;
    },
    batch(statements: Parameters<typeof base.batch>[0]) {
      return base.batch(statements);
    },
  };
  return proxy as unknown as NonNullable<Env["DB"]>;
}

interface ExecuteOptions {
  readonly operation?: Operation;
  readonly visitorId?: string;
  readonly scope?: "session" | "visitor";
  readonly cursor?: string;
  readonly withoutSecret?: boolean;
  readonly analysisContext?: Record<string, unknown>;
  readonly hooks?: Hooks;
  readonly controller?: AbortController;
  /** Called after the middleware branded the query, before the program runs. */
  readonly beforeProgram?: () => void;
}

async function execute(
  rewrite: (results: Row[]) => unknown,
  options: ExecuteOptions = {},
) {
  const operation = options.operation ?? "sessions";
  const database = createMigratedDatabase();
  try {
    seedFixture(database);
    // The middleware runs its own presence checks; only count the program's.
    let armed = false;
    const hooks: Hooks = {
      onAnalysisLookup: () => {
        if (armed) options.hooks?.onAnalysisLookup?.();
      },
      onPresenceQuery: () => {
        if (armed) options.hooks?.onPresenceQuery?.();
      },
    };
    const env = {
      DB: d1With(database, rewrite, hooks),
      ...(options.withoutSecret
        ? {}
        : { MAIN_SECRET: "session-list-program-guards-secret" }),
    } as unknown as Env;
    const base = {
      context: siteQueryContext(SITE_ID, "private-dashboard"),
      time: createQueryTime(BASE, END, "UTC", END),
      filters: parseFilterDsl(FILTER_DSL, analyticsFilterRegistry),
      scopePreference: options.scope ?? "session",
      ...(options.analysisContext
        ? { analysisContext: options.analysisContext }
        : {}),
    };
    const request = (operation === "sessions"
      ? {
          ...base,
          page: { limit: 5, cursor: options.cursor ?? null },
          sort: { key: "startedAt", direction: "desc" },
        }
      : {
          ...base,
          visitorId: options.visitorId ?? "visitor-shared",
          page: { limit: 5, cursor: options.cursor ?? null },
        }) as unknown as CanonicalQuery<"sessions">;
    const prepared = prepareScopedQuery(
      operation,
      request as never,
    ) as unknown as QueryInput & Record<string, unknown>;
    let query: (QueryInput & Record<string, unknown>) | undefined;
    await d1AdvancedFilterMiddleware(env, undefined, SITE_ID)(
      operation,
      prepared,
      async (next) => {
        query = next as QueryInput & Record<string, unknown>;
        return next;
      },
      options.controller ? { signal: options.controller.signal } : undefined,
    );
    const deferred = deferredSessionListQualificationFromQuery(query!);
    armed = true;
    options.beforeProgram?.();
    return await executeSessionListQualificationProgram({
      query: query!,
      deferred: deferred!,
      env,
    });
  } finally {
    database.close();
  }
}

const mapRows =
  (transform: (row: Row, index: number) => unknown) => (results: Row[]) =>
    results.map(transform);

const withControl = (patch: Row) =>
  mapRows((row) => (row.rowKind === "control" ? { ...row, ...patch } : row));

describe("session list qualification program envelope guards", () => {
  it("accepts the untouched envelope as the executed baseline", async () => {
    const result = await execute((results) => results);
    expect(result.kind).toBe("executed");
    if (result.kind === "executed") {
      expect(result.controlRowCount).toBe(1);
      expect(result.reportRowCount).toBe(2);
    }
  });

  it("rejects an unknown row kind", async () => {
    await expect(
      execute((results) => {
        const report = results.findIndex((row) => row.rowKind === "report");
        return results.map((row, index) =>
          index === report ? { ...row, rowKind: "other" } : row,
        );
      }),
    ).rejects.toThrow(`${PREFIX}_envelope_kind_invalid`);
  });

  it("requires one control row addressed to the control output", async () => {
    await expect(
      execute(withControl({ outputId: "elsewhere" })),
    ).rejects.toThrow(`${PREFIX}_control_row_invalid`);
  });

  it("rejects control rows carrying report values", async () => {
    await expect(execute(withControl({ sessionId: "leak" }))).rejects.toThrow(
      `${PREFIX}_control_kind_mismatch`,
    );
  });

  it("rejects empty and repeated session identities", async () => {
    await expect(
      execute(
        mapRows((row) =>
          row.rowKind === "report" ? { ...row, sessionId: "" } : row,
        ),
      ),
    ).rejects.toThrow(`${PREFIX}_report_identity_invalid`);
    await expect(
      execute(
        mapRows((row) =>
          row.rowKind === "report" ? { ...row, sessionId: "dup" } : row,
        ),
      ),
    ).rejects.toThrow(`${PREFIX}_report_identity_invalid`);
  });

  it("rejects control counters that are not safe non-negative integers", async () => {
    for (const bad of [-1, 1.5, "3", null])
      await expect(execute(withControl({ rawCount: bad }))).rejects.toThrow(
        `${PREFIX}_control_invalid:rawCount`,
      );
    await expect(
      execute(withControl({ invalidIdentityCount: "x" })),
    ).rejects.toThrow(`${PREFIX}_control_invalid:invalidIdentityCount`);
  });

  it("raises a gate violation when a fallback control still returns report rows", async () => {
    await expect(
      execute(withControl({ siteIdentityMismatchCount: 1 })),
    ).rejects.toThrow(`${PREFIX}_gate_violation`);
  });

  it("falls back to the legacy reader when the control demands it and no rows leak", async () => {
    const onlyControl = (patch: Row) => (results: Row[]) =>
      results
        .filter((row) => row.rowKind === "control")
        .map((row) => ({ ...row, ...patch }));
    expect(
      await execute(onlyControl({ nullActivityIdCount: 2 })),
    ).toMatchObject({
      kind: "fallback",
      fallbackReason: { kind: "null-activity-id" },
    });
    expect(
      await execute(onlyControl({ siteIdentityMismatchCount: 1 })),
    ).toMatchObject({
      kind: "fallback",
      fallbackReason: { kind: "site-identity-mismatch" },
    });
  });

  it("throws the combined identity errors when the control reports bad identities", async () => {
    await expect(
      execute(withControl({ invalidIdentityCount: 1 })),
    ).rejects.toThrow("advanced_filter_count_combined_identity_invalid");
    await expect(
      execute(withControl({ duplicateIdentityCount: 1 })),
    ).rejects.toThrow("advanced_filter_count_combined_identity_repeated");
  });

  it("rejects an activity count above the cap with a typed domain error", async () => {
    await expect(
      execute(withControl({ rawCount: Number.MAX_SAFE_INTEGER })),
    ).rejects.toMatchObject({ name: "AnalyticsProviderDomainError" });
  });
});

describe("session list qualification program analysis context", () => {
  const goal = { type: "goal", goalId: "missing-goal" };
  const funnel = {
    type: "funnel",
    funnelId: "missing-funnel",
    stepId: "step-1",
  };
  const goalOk = { type: "goal", goalId: "goal-ok" };
  const funnelOk = {
    type: "funnel",
    funnelId: "funnel-ok",
    stepId: "step-0",
  };

  it.each([goal, funnel])(
    "aborts before resolving %j when already aborted",
    async (analysisContext) => {
      const controller = new AbortController();
      let lookups = 0;
      await expect(
        execute((results) => results, {
          analysisContext,
          controller,
          hooks: { onAnalysisLookup: () => (lookups += 1) },
          beforeProgram: () => controller.abort(),
        }),
      ).rejects.toMatchObject({ name: "AbortError", message: "Aborted" });
      expect(lookups).toBe(0);
    },
  );

  it.each([goal, funnel])(
    "reports an abort instead of the lookup error for %j",
    async (analysisContext) => {
      const controller = new AbortController();
      let lookups = 0;
      await expect(
        execute((results) => results, {
          analysisContext,
          controller,
          hooks: {
            onAnalysisLookup: () => {
              lookups += 1;
              controller.abort();
            },
          },
        }),
      ).rejects.toMatchObject({ name: "AbortError", message: "Aborted" });
      expect(lookups).toBe(1);
    },
  );

  it.each([goalOk, funnelOk])(
    "aborts after a successful %j lookup before the Count envelope runs",
    async (analysisContext) => {
      const controller = new AbortController();
      let lookups = 0;
      let envelopes = 0;
      await expect(
        execute(
          (results) => {
            envelopes += 1;
            return results;
          },
          {
            analysisContext,
            controller,
            hooks: {
              onAnalysisLookup: () => {
                lookups += 1;
                controller.abort();
              },
            },
          },
        ),
      ).rejects.toMatchObject({ name: "AbortError", message: "Aborted" });
      expect(lookups).toBe(1);
      expect(envelopes).toBe(0);
    },
  );

  it.each([goalOk, funnelOk])(
    "executes with the resolved analysis for %j",
    async (analysisContext) => {
      const result = await execute((results) => results, { analysisContext });
      expect(result.kind).toBe("executed");
    },
  );

  it.each([goal, funnel])(
    "surfaces the saved lookup error for %j after safe controls",
    async (analysisContext) => {
      await expect(
        execute((results) => results, { analysisContext }),
      ).rejects.toThrow("resource-not-found");
    },
  );
});

describe("visitor sessions qualification program target checks", () => {
  const visitorSessions = { operation: "visitor-sessions" } as const;

  it("executes for an existing visitor and checks its presence", async () => {
    let presence = 0;
    const result = await execute((results) => results, {
      ...visitorSessions,
      hooks: { onPresenceQuery: () => (presence += 1) },
    });
    expect(result.kind).toBe("executed");
    expect(presence).toBe(1);
  });

  it("reports resource-not-found for an unknown visitor", async () => {
    await expect(
      execute((results) => results.filter((row) => row.rowKind === "control"), {
        ...visitorSessions,
        visitorId: "visitor-unknown",
      }),
    ).rejects.toThrow("resource-not-found");
  });

  it("aborts before the presence query when the signal fires while decoding rows", async () => {
    const controller = new AbortController();
    let presence = 0;
    await expect(
      execute(
        mapRows(
          (row) =>
            new Proxy(row, {
              ownKeys(target) {
                controller.abort();
                return Reflect.ownKeys(target);
              },
            }),
        ),
        {
          ...visitorSessions,
          controller,
          hooks: { onPresenceQuery: () => (presence += 1) },
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError", message: "Aborted" });
    expect(presence).toBe(0);
  });

  it("aborts after the presence query when the signal fires during it", async () => {
    const controller = new AbortController();
    let presence = 0;
    await expect(
      execute((results) => results, {
        ...visitorSessions,
        controller,
        hooks: {
          onPresenceQuery: () => {
            presence += 1;
            controller.abort();
          },
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError", message: "Aborted" });
    expect(presence).toBe(1);
  });
});

describe("session list qualification program cursor handling", () => {
  it.each(["sessions", "visitor-sessions"] as const)(
    "returns the malformed %s cursor error only after safe controls",
    async (operation) => {
      let envelopes = 0;
      await expect(
        execute(
          (results) => {
            envelopes += 1;
            return results;
          },
          { operation, cursor: "malformed-cursor" },
        ),
      ).rejects.toMatchObject({ name: "InvalidCursorError" });
      expect(envelopes).toBe(1);
    },
  );

  it("lets a fallback control outrank the malformed cursor", async () => {
    const result = await execute(
      (results) =>
        results
          .filter((row) => row.rowKind === "control")
          .map((row) => ({ ...row, nullActivityIdCount: 1 })),
      { cursor: "malformed-cursor" },
    );
    expect(result).toMatchObject({
      kind: "fallback",
      fallbackReason: { kind: "null-activity-id" },
    });
  });

  it("does not mask a non-cursor decoding failure as an invalid cursor", async () => {
    const error = await execute((results) => results, {
      cursor: "malformed-cursor",
      withoutSecret: true,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).not.toBe("InvalidCursorError");
    expect((error as Error).message).toBe("data-unavailable");
  });
});
