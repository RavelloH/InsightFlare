import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import {
  d1AdvancedFilterMiddleware,
  deferredEventRecordsQualificationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { executeEventRecordsQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/analytics-event-record-qualification-program";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const SITE_ID = "event-records-program-guards";
const START = Date.UTC(2026, 0, 1, 8);
const END = Date.UTC(2026, 0, 4, 8);
const NOW = Date.UTC(2026, 0, 5, 8);
const TIME_ZONE = "UTC";
const DEFAULT_DSL = 'count(page { page.path eq "/scoped" }) eq 1';

type Row = Record<string, unknown>;

const databases = new Set<DatabaseSync>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  const sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { readonly site_pk: number }
    ).site_pk,
  );
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'guards-team', 'Event record guards', 'records.test', 0)`,
    )
    .run(SITE_ID);
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (1, ?, 'purchase', ?, ?)`,
    )
    .run(SITE_ID, END - 1, sitePk);
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname
      ) VALUES ('visit-scoped', ?, ?, 'visitor-a', 'session-a', 'closed',
        ?, ?, '/scoped', 'records.test')`,
    )
    .run(SITE_ID, sitePk, START + 1, START + 1);
  const insertEvent = database.prepare(
    `INSERT INTO custom_events (
      event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
      received_at, sequence, node_count, value_count
    ) VALUES (?, ?, ?, 'visit-scoped', 1, ?, ?, ?, 0, 0)`,
  );
  for (const [index, id] of ["event-a", "event-b"].entries())
    insertEvent.run(
      id,
      SITE_ID,
      sitePk,
      START + 1_000 * (index + 1),
      START + 1_000 * (index + 1),
      index + 1,
    );
  return database;
}

interface Harness {
  readonly env: Env;
  readonly deferred: NonNullable<
    ReturnType<typeof deferredEventRecordsQualificationFromQuery>
  >;
  readonly controller: AbortController;
}

interface Hooks {
  /** Rewrites the envelope result rows returned by the compiled query. */
  readonly rewrite?: (results: Row[]) => unknown;
  /** Runs once the envelope statement was executed. */
  readonly onEnvelope?: () => void;
}

async function harness(
  input: {
    readonly dsl?: string;
    readonly scope?: "session" | "visitor" | "event";
    readonly hooks?: Hooks;
  } = {},
): Promise<Harness> {
  const database = createFixture();
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const base = createSqliteD1Database(database, trace);
  const hooks = input.hooks ?? {};
  const env = {
    MAIN_SECRET: "event-records-program-guards-secret",
    DB: {
      prepare(sql: string) {
        const statement = base.prepare(sql);
        const envelope =
          sql.includes('"rowKind"') && sql.includes('"outputId"');
        const prepared = {
          bind(...values: Parameters<typeof statement.bind>) {
            statement.bind(...values);
            return prepared;
          },
          first<R>() {
            return statement.first<R>();
          },
          async all<R>() {
            const result = await statement.all<R>();
            if (!envelope) return result;
            hooks.onEnvelope?.();
            return {
              ...result,
              results: (hooks.rewrite
                ? hooks.rewrite(result.results as Row[])
                : result.results) as R[],
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
    },
  } as unknown as Env;
  const time: QueryTime = createQueryTime(START, END, TIME_ZONE, NOW);
  const prepared = prepareScopedQuery("event-records", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time,
    filters: parseFilterDsl(input.dsl ?? DEFAULT_DSL, analyticsFilterRegistry),
    scopePreference: input.scope ?? "session",
  } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
    readonly time: QueryTime;
  };
  const query = {
    ...prepared,
    sort: { key: "occurredAt", direction: "desc" },
    page: { limit: 10, cursor: null },
  };
  const controller = new AbortController();
  const forwarded = await d1AdvancedFilterMiddleware(env)(
    "event-records",
    query as never,
    async (value) => value,
    { signal: controller.signal },
  );
  const deferred = deferredEventRecordsQualificationFromQuery(forwarded);
  if (!deferred) throw new Error("event_records_guard_deferred_missing");
  return { env, deferred, controller };
}

const OPTIONS = {
  limit: 10,
  sort: { key: "occurredAt", direction: "desc" },
} as const;

function run(
  prepared: Harness,
  overrides: {
    readonly options?: Record<string, unknown>;
    readonly cursorToken?: string | null;
    readonly diagnostics?: ReturnType<typeof createD1ReadDiagnostics>;
    readonly deferred?: unknown;
  } = {},
) {
  return executeEventRecordsQualificationProgram({
    env: prepared.env,
    deferred: (overrides.deferred ?? prepared.deferred) as never,
    options: { ...OPTIONS, ...overrides.options } as never,
    cursorToken: overrides.cursorToken ?? null,
    ...(overrides.diagnostics ? { diagnostics: overrides.diagnostics } : {}),
  });
}

const mapRows =
  (transform: (row: Row, index: number) => unknown) => (results: Row[]) =>
    results.map(transform);

const withControl = (patch: Row) =>
  mapRows((row) => (row.rowKind === "control" ? { ...row, ...patch } : row));

describe("event records qualification program request gates", () => {
  it("executes the untouched envelope and exposes the recorded events", async () => {
    const result = await run(await harness());
    expect(result.kind).toBe("executed");
    if (result.kind === "executed") {
      expect(result.rows.map((row) => row.eventId)).toEqual([
        "event-b",
        "event-a",
      ]);
      expect(Object.isFrozen(result.rows)).toBe(true);
    }
  });

  it("rejects deferred requests that were not branded by the middleware", async () => {
    await expect(
      run(await harness(), { deferred: { operation: "event-records" } }),
    ).rejects.toThrow("event_records_qualification_request_untrusted");
  });

  it.each([
    ["limit", { limit: 11 }],
    ["search", { search: "other" }],
    ["event name", { eventName: "purchase" }],
    ["sort direction", { sort: { key: "occurredAt", direction: "asc" } }],
  ])(
    "rejects options whose %s differs from the prepared request",
    async (_, options) => {
      await expect(run(await harness(), { options })).rejects.toThrow(
        "event_records_qualification_request_mismatch",
      );
    },
  );

  it("rejects a cursor token that differs from the prepared request", async () => {
    await expect(
      run(await harness(), { cursorToken: "unexpected-cursor" }),
    ).rejects.toThrow("event_records_qualification_request_mismatch");
  });
});

describe("event records qualification program aborts", () => {
  it("aborts before compiling when the request signal is already aborted", async () => {
    const prepared = await harness();
    prepared.controller.abort();
    await expect(run(prepared)).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });
  });

  it("aborts after compilation without reading the database", async () => {
    let envelopes = 0;
    const prepared = await harness({
      hooks: { onEnvelope: () => (envelopes += 1) },
    });
    const diagnostics = createD1ReadDiagnostics();
    diagnostics.onEventRecordsQualificationCompile = () =>
      prepared.controller.abort();
    await expect(run(prepared, { diagnostics })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(envelopes).toBe(0);
  });

  it("aborts after the envelope read instead of decoding its rows", async () => {
    const prepared = await harness();
    const aborting = await harness({
      hooks: { onEnvelope: () => aborting.controller.abort() },
    });
    await expect(run(aborting)).rejects.toMatchObject({ name: "AbortError" });
    expect((await run(prepared)).kind).toBe("executed");
  });
});

describe("event records qualification program envelope decoding", () => {
  it("rejects missing, repeated or foreign control rows", async () => {
    await expect(
      run(
        await harness({
          hooks: {
            rewrite: (results) =>
              results.filter((row) => row.rowKind !== "control"),
          },
        }),
      ),
    ).rejects.toThrow("event_records_qualification_control_row_invalid");
    await expect(
      run(
        await harness({
          hooks: { rewrite: withControl({ outputId: "elsewhere" }) },
        }),
      ),
    ).rejects.toThrow("event_records_qualification_control_row_invalid");
    await expect(
      run(
        await harness({
          hooks: { rewrite: withControl({ extra: 1 }) },
        }),
      ),
    ).rejects.toThrow("event_records_qualification_control_row_invalid");
  });

  it("rejects a control row for another entity scope", async () => {
    await expect(
      run(
        await harness({
          hooks: { rewrite: withControl({ entityKind: "visitor" }) },
        }),
      ),
    ).rejects.toThrow("event_records_qualification_control_scope_mismatch");
  });

  it("rejects non-integer control counters", async () => {
    await expect(
      run(
        await harness({
          hooks: { rewrite: withControl({ rawCount: "2" }) },
        }),
      ),
    ).rejects.toThrow("event_records_qualification_control_invalid:rawCount");
  });

  it("rejects rows that are neither control nor record rows", async () => {
    await expect(
      run(
        await harness({
          hooks: {
            rewrite: mapRows((row) =>
              row.rowKind === "record" ? { ...row, rowKind: "other" } : row,
            ),
          },
        }),
      ),
    ).rejects.toThrow("event_records_qualification_row_kind_invalid");
  });

  it("rejects record rows with another output or schema", async () => {
    await expect(
      run(
        await harness({
          hooks: {
            rewrite: mapRows((row) =>
              row.rowKind === "record" ? { ...row, outputId: "other" } : row,
            ),
          },
        }),
      ),
    ).rejects.toThrow("event_records_qualification_record_row_invalid");
    await expect(
      run(
        await harness({
          hooks: {
            rewrite: mapRows((row) =>
              row.rowKind === "record" ? { ...row, surplus: 1 } : row,
            ),
          },
        }),
      ),
    ).rejects.toThrow("event_records_qualification_record_row_invalid");
  });

  it("raises a gate violation when a fallback control still returns records", async () => {
    await expect(
      run(
        await harness({
          hooks: { rewrite: withControl({ nullActivityIdCount: 1 }) },
        }),
      ),
    ).rejects.toThrow("event_records_qualification_gate_violation");
  });

  it("falls back when the control demands it and no records leak", async () => {
    const result = await run(
      await harness({
        hooks: {
          rewrite: (results) =>
            results
              .filter((row) => row.rowKind === "control")
              .map((row) => ({ ...row, siteIdentityMismatchCount: 1 })),
        },
      }),
    );
    expect(result).toEqual({
      kind: "fallback",
      fallbackReason: { kind: "site-identity-mismatch" },
    });
  });

  it("throws identity errors when the control reports bad identities", async () => {
    await expect(
      run(
        await harness({
          hooks: { rewrite: withControl({ invalidIdentityCount: 1 }) },
        }),
      ),
    ).rejects.toThrow("event_records_qualification_identity_invalid");
    await expect(
      run(
        await harness({
          hooks: { rewrite: withControl({ duplicateIdentityCount: 1 }) },
        }),
      ),
    ).rejects.toThrow("event_records_qualification_identity_duplicated");
  });
});
