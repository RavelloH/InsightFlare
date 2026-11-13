import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

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
import { preparedMembershipIdentities } from "@/lib/edge/analytics/providers/d1/internal/__tests__/prepared-membership-fixture";
import * as countSupport from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-count-support";
import { d1AdvancedFilterMiddleware } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const SITE = "time-leaf-site";
// Candidate window [100, 200); the capture instant leaves room for later data.
const TIME = createQueryTime(100, 200, "UTC", 300);

interface Activity {
  readonly visit: string;
  readonly session: string;
  readonly visitor: string;
  readonly at: number;
  readonly path: string;
  readonly events?: readonly { readonly at: number; readonly name: string }[];
}

// Every session is crafted so the loaded-activity window changes the answer.
const ACTIVITIES: readonly Activity[] = [
  // Only before the lifted window: never a candidate once it applies.
  {
    visit: "v-early-1",
    session: "s-early",
    visitor: "u-early",
    at: 110,
    path: "/a",
  },
  {
    visit: "v-early-2",
    session: "s-early",
    visitor: "u-early",
    at: 120,
    path: "/b",
  },
  // One page before and one inside the window.
  {
    visit: "v-mixed-1",
    session: "s-mixed",
    visitor: "u-mixed",
    at: 110,
    path: "/a",
  },
  {
    visit: "v-mixed-2",
    session: "s-mixed",
    visitor: "u-mixed",
    at: 150,
    path: "/c",
    events: [{ at: 151, name: "qualifier" }],
  },
  // Active only after the candidate window, still inside the Filter window.
  {
    visit: "v-late",
    session: "s-late",
    visitor: "u-late",
    at: 250,
    path: "/d",
    events: [{ at: 252, name: "qualifier" }],
  },
  // Straddles the candidate end.
  {
    visit: "v-edge",
    session: "s-edge",
    visitor: "u-edge",
    at: 199,
    path: "/e",
    events: [{ at: 205, name: "other" }],
  },
  // A visitor that spans two sessions across the boundary.
  {
    visit: "v-span-1",
    session: "s-span-1",
    visitor: "u-span",
    at: 125,
    path: "/f",
  },
  {
    visit: "v-span-2",
    session: "s-span-2",
    visitor: "u-span",
    at: 240,
    path: "/g",
  },
];

const databases = new Set<DatabaseSync>();

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases) database.close();
  databases.clear();
});

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE);
  const pk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE) as { readonly site_pk: number }
    ).site_pk,
  );
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'time-leaf-team', 'Time leaf', 'time-leaf.test', 0)`,
    )
    .run(SITE);
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (1, ?, 'qualifier', 300, ?), (2, ?, 'other', 300, ?)`,
    )
    .run(SITE, pk, SITE, pk);
  const insertVisit = database.prepare(
    `INSERT INTO visits (
       visit_id, site_id, site_pk, visitor_id, session_id, status,
       started_at, last_activity_at, pathname, hostname, duration_ms
     ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'time-leaf.test', 10)`,
  );
  const insertEvent = database.prepare(
    `INSERT INTO custom_events (
       event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
       received_at, sequence, node_count, value_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
  );
  for (const activity of ACTIVITIES) {
    insertVisit.run(
      activity.visit,
      SITE,
      pk,
      activity.visitor,
      activity.session,
      activity.at,
      activity.at,
      activity.path,
    );
    for (const [index, event] of (activity.events ?? []).entries())
      insertEvent.run(
        `${activity.visit}-event-${index}`,
        SITE,
        pk,
        activity.visit,
        event.name === "qualifier" ? 1 : 2,
        event.at,
        event.at,
      );
  }
  return database;
}

interface Evaluation {
  readonly ids: readonly string[];
  readonly diagnostics: ReturnType<typeof createD1ReadDiagnostics>;
  readonly classifications: readonly string[];
  readonly trace: SqliteD1Trace;
}

async function evaluate(
  dsl: string,
  scope: "session" | "visitor",
  options: { readonly forceCore?: boolean; readonly time?: QueryTime } = {},
): Promise<Evaluation> {
  const database = createFixture();
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    DB: createSqliteD1Database(database, trace),
  } as unknown as Env;
  const diagnostics = createD1ReadDiagnostics();
  const classify = vi.spyOn(countSupport, "classifyAdvancedCountFilter");
  if (options.forceCore)
    classify.mockReturnValue({
      kind: "unsupported",
      path: "root",
      code: "forced_core_oracle",
      reason: "The test forces the Core evaluator as the oracle.",
    });
  const input = prepareScopedQuery("overview", {
    context: siteQueryContext(SITE, "private-dashboard"),
    time: options.time ?? TIME,
    filters: parseFilterDsl(dsl, analyticsFilterRegistry),
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime });
  const prepared = (await d1AdvancedFilterMiddleware(env, diagnostics)(
    "performance",
    input,
    async (value) => value,
  )) as typeof input;
  const ids = (
    preparedMembershipIdentities(prepared.scopePlan?.preparedMembership)
      .entityIds ?? []
  )
    .map((identity) => identity.id)
    .sort();
  const classifications = classify.mock.results.map((result) =>
    result.type === "return"
      ? (result.value as { readonly kind: string }).kind
      : "throw",
  );
  classify.mockRestore();
  return { ids, diagnostics, classifications, trace };
}

const CASES = [
  ["a lifted lower bound", "time gte @range.start+30ms"],
  ["a strict lower bound", "time gt @range.start+50ms"],
  ["an upper bound beyond the candidate window", "time lt @range.end+60ms"],
  ["an inclusive upper bound", "time lte @range.start+25ms"],
  ["a closed interval", "time between [@range.start+15ms, @range.start+60ms]"],
  [
    "two independent leaves",
    "time gte @range.start+20ms and time lt @range.end+10ms",
  ],
  [
    "a time leaf with an event-count leaf",
    'time gte @range.start+30ms and count(event { event.name eq "qualifier" }) gte 1',
  ],
  [
    "a time leaf with a bare Page field leaf",
    'time gte @range.start+30ms and page.path neq "/a"',
  ],
  ["an absolute RFC3339 bound", 'time gte "1970-01-01T00:00:00.140Z"'],
  [
    "an absolute closed interval",
    'time between ["1970-01-01T00:00:00.130Z", "1970-01-01T00:00:00.260Z"]',
  ],
  ["a bound relative to the capture instant", "time gte @now-100ms"],
] as const;

describe("SQL Count top-level time leaves", () => {
  it.each(
    CASES.flatMap(([name, dsl]) =>
      (["session", "visitor"] as const).map((scope) => ({ name, dsl, scope })),
    ),
  )(
    "matches the Core evaluator for $name at $scope scope",
    async ({ dsl, scope }) => {
      const sql = await evaluate(dsl, scope);
      const core = await evaluate(dsl, scope, { forceCore: true });
      // The SQL slice really evaluated it: classified as supported, no
      // compatibility fallback, and the answer is not trivially empty.
      expect(sql.classifications).toContain("supported");
      expect(sql.diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      expect(core.classifications).not.toContain("supported");
      expect(sql.ids).toEqual(core.ids);
    },
  );

  it("changes the answer relative to the same Filter without its time leaf", async () => {
    // Guards the fixture: the lifted window must exclude sessions that the
    // plain event filter keeps, otherwise the parity cases prove nothing.
    const withLeaf = await evaluate("time gte @range.start+30ms", "session");
    const withoutLeaf = await evaluate('page.path neq "/zzz"', "session");
    expect(withLeaf.ids).not.toEqual(withoutLeaf.ids);
    expect(withLeaf.ids).not.toContain("s-early");
    // Active only after the candidate window yet inside the Filter window.
    expect(withLeaf.ids).toContain("s-late");
  });

  it("keeps the Core evaluator for endpoints the SQL slice cannot resolve", async () => {
    for (const dsl of ["time eq 150", "time notExists", "time in [150]"]) {
      const result = await evaluate(dsl, "session").catch(
        (error: unknown) => error,
      );
      // Either the parser rejects the form, or the SQL slice declines it.
      if (result instanceof Error) continue;
      expect((result as Evaluation).classifications).not.toContain("supported");
    }
  });

  it("keeps the Core evaluator when the Filter has no explicit window", async () => {
    // A hand-built QueryTime without filterRange never reaches the time leaf
    // context, so the classifier refuses it and Core answers.
    const document = parseFilterDsl(
      "time gte @range.start+30ms",
      analyticsFilterRegistry,
    );
    const result = countSupport.classifyAdvancedCountFilter(
      document,
      "session",
    );
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported")
      expect(result.code).toBe("count_sql_time_leaf_unsupported");
  });
});
