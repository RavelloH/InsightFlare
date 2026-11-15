// @vitest-environment node
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1TeamQueryRuntime } from "@/lib/edge/analytics/composition/d1";
import {
  createQueryTime,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import * as afe from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import * as stage from "@/lib/edge/analytics/providers/d1/internal/analytics-logical-staged-runtime";
import * as overview from "@/lib/edge/analytics/providers/d1/internal/overview";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as team from "@/lib/edge/analytics/providers/d1/internal/team";
import * as whole from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-executor";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";

const TEAM = "w121-team";
const AUTHORIZED = ["w121-site-a", "w121-site-b"];
const FOREIGN = "w121-site-c";
/** 24 actual visits per site; only A/B authorized. Role IDs deliberately
 * collide across sites; event and Page spelling also overlap across kinds.
 * event_id itself stays globally unique, as required by the real schema. */
function fixture(): DatabaseSync {
  const db = createMigratedDatabase();
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare(
    "INSERT INTO teams(id,name,slug,owner_user_id,created_at,updated_at) VALUES(?,?,?,?,0,0)",
  ).run(TEAM, TEAM, TEAM, "w121-user");
  for (const [siteIndex, site] of [...AUTHORIZED, FOREIGN].entries()) {
    const sitePk = siteIndex + 1;
    db.prepare("INSERT INTO site_identities(site_pk,site_id) VALUES(?,?)").run(
      sitePk,
      site,
    );
    db.prepare(
      "INSERT INTO sites(id,team_id,name,domain,created_at,updated_at) VALUES(?,?,?,?,0,0)",
    ).run(site, TEAM, site, `${site}.invalid`);
    db.prepare(
      "INSERT INTO custom_event_names(id,site_id,site_pk,name,last_seen_at) VALUES(?,?,?,'qualifier',0)",
    ).run(sitePk, site, sitePk);
    for (let i = 0; i < 24; i++) {
      const selected = siteIndex === 2 || i % 2 === siteIndex;
      const id = `${site}:page:${i}`;
      const at = 110 + i;
      db.prepare(
        `INSERT INTO visits(visit_id,site_id,site_pk,visitor_id,session_id,status,started_at,last_activity_at,pathname,hostname,duration_ms)
        VALUES(?,?,?,?,?,'closed',?,?,?,?,?)`,
      ).run(
        id,
        site,
        sitePk,
        `v${i % 2}`,
        `s${i % 2}`,
        at,
        at,
        "/qualifier",
        `${site}.invalid`,
        10,
      );
      if (selected)
        db.prepare(
          `INSERT INTO custom_events(event_id,site_id,site_pk,visit_id,event_name_id,occurred_at,received_at,sequence,node_count,value_count)
        VALUES(?,?,?,?,?,?,?,1,0,0)`,
        ).run(
          siteIndex === 1 && i === 1
            ? `${AUTHORIZED[0]}:page:0`
            : `${site}:event:${i}`,
          site,
          sitePk,
          id,
          sitePk,
          at + 1,
          at + 1,
        );
    }
  }
  db.exec("PRAGMA query_only=ON");
  return db;
}

type Scenario =
  | "page1"
  | "page2"
  | "timezone-after-listing"
  | "root-after-overview"
  | "core-error-identity"
  | "noncanonical-authorized-order";
function query(scope: "session" | "visitor", cursor: string | null = null) {
  return {
    context: teamQueryContext(TEAM, "private-dashboard", AUTHORIZED),
    teamId: TEAM,
    allowedSiteIds: AUTHORIZED,
    time: createQueryTime(100, 200, "UTC", 300),
    scopePreference: scope,
    filters: parseFilterDsl(
      'sequence([page { page.path eq "/qualifier" },event { event.name eq "qualifier" }]) exists',
      analyticsFilterRegistry,
    ),
    page: { limit: 1, cursor },
    interval: "day" as const,
  };
}
async function execute(
  scope: "session" | "visitor",
  scenario: Scenario,
  cursor: string | null = null,
) {
  const db = fixture();
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const input = query(scope, cursor);
  if (scenario === "noncanonical-authorized-order")
    input.context = teamQueryContext(
      TEAM,
      "private-dashboard",
      [...AUTHORIZED].reverse(),
    );
  const register = vi.spyOn(bridge, "registerPreparedMembership");
  const resolve = vi.spyOn(bridge, "resolvePreparedMembership");
  const stageSpy = vi.spyOn(stage, "executeAnalyticsLogicalStage");
  const wholeSpy = vi.spyOn(whole, "evaluateWholeFilterMembership");
  const coreSpy = vi.spyOn(core, "evaluateFilterDocument");
  const originalPrepare = afe.prepareTeamSitesQualification;
  let captured: Parameters<typeof originalPrepare>[0]["query"] | undefined;
  vi.spyOn(afe, "prepareTeamSitesQualification").mockImplementation((value) => {
    captured = value.query;
    return originalPrepare(value);
  });
  const originalList = team.queryTeamSitesPageFromD1;
  const originalOverview = overview.queryOverviewAggregate;
  let mutationCount = 0;
  if (scenario === "timezone-after-listing")
    vi.spyOn(team, "queryTeamSitesPageFromD1").mockImplementation(
      async (...args) => {
        const result = await originalList(...args);
        if (!captured) throw new Error("actual_forwarded_request_not_observed");
        Object.assign(captured.time, { reportingTimeZone: "Asia/Tokyo" });
        mutationCount++;
        return result;
      },
    );
  if (scenario === "root-after-overview")
    vi.spyOn(overview, "queryOverviewAggregate").mockImplementation(
      async (...args) => {
        const result = await originalOverview(...args);
        if (!captured?.filters)
          throw new Error("actual_forwarded_filters_not_observed");
        Object.assign(captured.filters, {
          root: parseFilterDsl(
            'page.path eq "/absent"',
            analyticsFilterRegistry,
          ).root,
        });
        mutationCount++;
        return result;
      },
    );
  const sentinel = new Error("Team whole original Core checkpoint sentinel");
  if (scenario === "core-error-identity")
    coreSpy.mockImplementation(() => {
      throw sentinel;
    });
  const providerErrors: unknown[] = [];
  const reactions: string[] = [];
  try {
    const promise = createD1TeamQueryRuntime({
      env: {
        DB: createSqliteD1Database(db, trace),
        MAIN_SECRET: "w121-local-only",
      } as Env,
    }).execute("team-sites", input, {
      onProviderError(error) {
        providerErrors.push(error);
      },
    });
    reactions.push("returned");
    queueMicrotask(() => reactions.push("caller-microtask"));
    const response = await promise;
    reactions.push("fulfilled");
    const record = {
      key: `${scope}/${scenario}`,
      response,
      sql: [...trace.preparedSql],
      params: [...trace.bindings],
      reactions,
      mutationCount,
      exactSentinel: providerErrors[0] === sentinel,
      providerErrors: providerErrors.map((error) =>
        error instanceof Error
          ? { name: error.name, message: error.message }
          : error,
      ),
      counts: {
        register: register.mock.calls.length,
        resolve: resolve.mock.calls.length,
        stage: stageSpy.mock.calls.length,
        wholeEvaluator: wholeSpy.mock.calls.length,
        corePerSite: coreSpy.mock.calls.length,
      },
      stageKinds: stageSpy.mock.calls.map((call) => call[0].kind),
    };
    // The scratch observer records this real result before these default assertions.
    if (scenario === "core-error-identity") {
      expect(providerErrors).toHaveLength(1);
      expect(providerErrors[0]).toBe(sentinel);
      expect(response).toEqual({
        ok: false,
        error: { kind: "internal", operation: "team-sites" },
      });
      expect(coreSpy).toHaveBeenCalledTimes(1);
    } else {
      expect(providerErrors).toEqual([]);
      expect(response.ok).toBe(true);
      if (!response.ok) throw new Error("expected actual team-sites success");
      expect(response.data.items).toHaveLength(1);
      expect(response.data.items.every((row) => row.siteId !== FOREIGN)).toBe(
        true,
      );
      if (scenario === "page2")
        expect(response.data.items[0]?.siteId).toBe(AUTHORIZED[1]);
      else expect(response.data.pagination.nextCursor).toBeTypeOf("string");
      expect(coreSpy).toHaveBeenCalledTimes(2);
    }
    if (
      scenario === "timezone-after-listing" ||
      scenario === "root-after-overview"
    )
      expect(mutationCount).toBeGreaterThan(0);
    if (scenario === "noncanonical-authorized-order") {
      expect(stageSpy).not.toHaveBeenCalled();
      expect(register).toHaveBeenCalledTimes(1);
      expect(resolve.mock.calls.length).toBeGreaterThan(0);
    } else {
      expect(stageSpy).toHaveBeenCalledTimes(1);
      expect(register).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(wholeSpy).not.toHaveBeenCalled();
    }
    expect(trace.preparedSql.length).toBeGreaterThan(0);
    expect(trace.bindings.length).toBe(trace.preparedSql.length);
    return record;
  } finally {
    vi.restoreAllMocks();
    db.close();
  }
}
afterEach(() => vi.restoreAllMocks());
describe.sequential("Team sites whole-original actual runtime", () => {
  for (const scope of ["session", "visitor"] as const) {
    it(`${scope}/real-bare-sequence-two-pages`, async () => {
      const first = await execute(scope, "page1");
      expect(first.response.ok).toBe(true);
      if (!first.response.ok) throw new Error("expected first page success");
      const cursor = first.response.data.pagination.nextCursor;
      expect(cursor).toBeTypeOf("string");
      await execute(scope, "page2", cursor);
    });
    for (const scenario of [
      "timezone-after-listing",
      "root-after-overview",
      "core-error-identity",
      "noncanonical-authorized-order",
    ] as const)
      it(`${scope}/${scenario}`, () => execute(scope, scenario));
  }
});
