// @vitest-environment node
import { createHash } from "node:crypto";

import { afterEach, expect, it, vi } from "vitest";

import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1TeamQueryRuntime } from "@/lib/edge/analytics/composition/d1";
import { createFixture } from "@/lib/edge/analytics/composition/d1/__tests__/team-sites-membership-fixture";
import {
  createQueryTime,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import { EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import * as preparation from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as whole from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-executor";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";
const A = "b04-site-a",
  B = "b04-site-b";
const dsl =
  'sequence([window(page { page.path eq "/q" },@range.start,[0ms,99ms]),window(event { event.name eq "qualifier" },@range.start,[0ms,99ms])]) exists';
// Frozen actual old-route DTOs and ordered SQL+parameter digests, before this
// transport migration. Runtime still exercises the real registry and SQLite.
const cases = [
  {
    scope: "session",
    kind: "sql",
    value: {
      ok: true,
      data: {
        items: [
          {
            key: "/p",
            label: "/p",
            views: 3,
            sessions: 2,
            visitors: 2,
          },
          {
            key: "/q",
            label: "/q",
            views: 2,
            sessions: 2,
            visitors: 2,
          },
        ],
      },
      meta: {
        time: {
          range: {
            startMs: 100,
            endExclusiveMs: 200,
          },
          reportingTimeZone: "UTC",
          capturedAtMs: 300,
          readRange: {
            startMs: 100,
            endExclusiveMs: 200,
          },
        },
        source: "raw",
        approximateVisitors: false,
        filterScope: {
          requested: "session",
          resolved: "session",
        },
      },
    },
    sqlCount: 5,
    sqlSha256:
      "4f80361ece6de634818b36f6cf3f8ebcceb105ff8504e19c53018625c9e1da73",
    coreCalls: 0,
  },
  {
    scope: "session",
    kind: "storage-refusal",
    value: {
      ok: true,
      data: {
        items: [
          {
            key: "/p",
            label: "/p",
            views: 2,
            sessions: 1,
            visitors: 1,
          },
          {
            key: "/q",
            label: "/q",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
        ],
      },
      meta: {
        time: {
          range: {
            startMs: 100,
            endExclusiveMs: 200,
          },
          reportingTimeZone: "UTC",
          capturedAtMs: 300,
          readRange: {
            startMs: 100,
            endExclusiveMs: 200,
          },
        },
        source: "raw",
        approximateVisitors: false,
        filterScope: {
          requested: "session",
          resolved: "session",
        },
      },
    },
    sqlCount: 6,
    sqlSha256:
      "ee5b64c29a35f77078a37d0738a7606bd11f16835ccb02d7587a9a6f1374a9a4",
    coreCalls: 2,
  },
  {
    scope: "session",
    kind: "empty-listing",
    value: {
      ok: true,
      data: {
        items: [],
      },
      meta: {
        time: {
          range: {
            startMs: 100,
            endExclusiveMs: 200,
          },
          reportingTimeZone: "UTC",
          capturedAtMs: 300,
          readRange: {
            startMs: 100,
            endExclusiveMs: 200,
          },
        },
        source: "raw",
        approximateVisitors: false,
        filterScope: {
          requested: "session",
          resolved: "session",
        },
      },
    },
    sqlCount: 3,
    sqlSha256:
      "be5bf525832d67b631cd96d386379e06ae226c01e81435db75012f5ee47a22d4",
    coreCalls: 0,
  },
  {
    scope: "visitor",
    kind: "sql",
    value: {
      ok: true,
      data: {
        items: [
          {
            key: "/p",
            label: "/p",
            views: 3,
            sessions: 2,
            visitors: 2,
          },
          {
            key: "/q",
            label: "/q",
            views: 2,
            sessions: 2,
            visitors: 2,
          },
        ],
      },
      meta: {
        time: {
          range: {
            startMs: 100,
            endExclusiveMs: 200,
          },
          reportingTimeZone: "UTC",
          capturedAtMs: 300,
          readRange: {
            startMs: 100,
            endExclusiveMs: 200,
          },
        },
        source: "raw",
        approximateVisitors: false,
        filterScope: {
          requested: "visitor",
          resolved: "visitor",
        },
      },
    },
    sqlCount: 5,
    sqlSha256:
      "18e7fe5d07d774fe28c2b974f9c03bbe321fdf8872b5e8d7dd325117a631c2b4",
    coreCalls: 0,
  },
  {
    scope: "visitor",
    kind: "storage-refusal",
    value: {
      ok: true,
      data: {
        items: [
          {
            key: "/p",
            label: "/p",
            views: 2,
            sessions: 1,
            visitors: 1,
          },
          {
            key: "/q",
            label: "/q",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
        ],
      },
      meta: {
        time: {
          range: {
            startMs: 100,
            endExclusiveMs: 200,
          },
          reportingTimeZone: "UTC",
          capturedAtMs: 300,
          readRange: {
            startMs: 100,
            endExclusiveMs: 200,
          },
        },
        source: "raw",
        approximateVisitors: false,
        filterScope: {
          requested: "visitor",
          resolved: "visitor",
        },
      },
    },
    sqlCount: 6,
    sqlSha256:
      "2f39f0c76001910a91438cdcd28e18aa35bc80fdc3633fdfc1e55fcc2324f11a",
    coreCalls: 2,
  },
  {
    scope: "visitor",
    kind: "empty-listing",
    value: {
      ok: true,
      data: {
        items: [],
      },
      meta: {
        time: {
          range: {
            startMs: 100,
            endExclusiveMs: 200,
          },
          reportingTimeZone: "UTC",
          capturedAtMs: 300,
          readRange: {
            startMs: 100,
            endExclusiveMs: 200,
          },
        },
        source: "raw",
        approximateVisitors: false,
        filterScope: {
          requested: "visitor",
          resolved: "visitor",
        },
      },
    },
    sqlCount: 3,
    sqlSha256:
      "fabb7d16af468f548c4f19ba637cb667184b3248c103304de475b87b7911cb3b",
    coreCalls: 0,
  },
  {
    scope: "session",
    kind: "zero-domain",
    value: {
      ok: false,
      error: {
        kind: "internal",
        operation: "dimension",
      },
    },
    sqlCount: 0,
    sqlSha256:
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    coreCalls: 0,
  },
  {
    scope: "session",
    kind: "missing-coverage",
    value: {
      ok: false,
      error: {
        kind: "invalid-input",
        issues: [
          {
            path: "readRange",
            code: "filter_evaluation_range_unavailable",
          },
        ],
      },
    },
    sqlCount: 1,
    sqlSha256:
      "bc13a0d5d29530b61eeb68069fffe21e7e5b74317ef0936787924b3ca5ace701",
    coreCalls: 0,
  },
] as const;
afterEach(() => vi.restoreAllMocks());
it.each(cases)(
  "$scope / $kind keeps the original joint Seq outcome and complete read sequence",
  async (sample) => {
    const db = createFixture();
    if (sample.kind === "storage-refusal")
      db.exec(
        `UPDATE visits SET started_at=started_at+0.5 WHERE site_id='${A}'`,
      );
    if (sample.kind === "missing-coverage")
      db.exec(`DELETE FROM sites WHERE id='${B}'`);
    const domain = sample.kind === "zero-domain" ? [] : [A, B];
    const input = {
      context: teamQueryContext("b04-team", "private-dashboard", domain),
      time: createQueryTime(100, 200, "UTC", 300),
      filters: parseFilterDsl(dsl, analyticsFilterRegistry),
      scopePreference: sample.scope,
      teamId: "b04-team",
      allowedSiteIds: sample.kind === "empty-listing" ? [] : domain,
      mode: "breakdown" as const,
      dimension: "page.path",
      limit: 20,
    };
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const evaluate = vi.spyOn(core, "evaluateFilterDocument"),
      joint = vi.spyOn(whole, "evaluateWholeFilterMembership"),
      register = vi.spyOn(bridge, "registerPreparedMembership"),
      resolve = vi.spyOn(bridge, "resolvePreparedMembership"),
      create = vi.spyOn(preparation, "createPageVisitQualificationPreparation"),
      bind = vi.spyOn(preparation, "bindPageVisitQualificationPreparation");
    const result = await createD1TeamQueryRuntime({
      env: {
        DB: createSqliteD1Database(db, trace),
        MAIN_SECRET: "team-seq-local-test",
      } as Env,
    }).execute("dimension", input);
    expect(result).toEqual(sample.value);
    expect(evaluate).toHaveBeenCalledTimes(sample.coreCalls);
    expect(joint).toHaveBeenCalledTimes(1);
    expect(joint.mock.calls[0]![0].siteIds).toEqual(domain);
    expect(register).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(trace.preparedSql).toHaveLength(sample.sqlCount);
    const actualSql = trace.preparedSql.map((sql, i) => ({
      sql,
      params: trace.bindings[i],
    }));
    expect(
      createHash("sha256").update(JSON.stringify(actualSql)).digest("hex"),
    ).toBe(sample.sqlSha256);
    const completes =
      sample.kind !== "zero-domain" && sample.kind !== "missing-coverage";
    expect(create).toHaveBeenCalledTimes(completes ? 2 : 0);
    expect(bind).toHaveBeenCalledTimes(
      completes && sample.kind !== "empty-listing" ? 2 : 0,
    );
    for (const [i, siteId] of (completes ? [A, B] : []).entries()) {
      const arg = create.mock.calls[i]![0];
      expect(arg).toMatchObject({
        siteId,
        dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
        maxBindings: 1,
        maxSourcesPerRole: 1,
        scopePlan: { scope: sample.scope, mode: "entity" },
      });
      expect(arg.scopePlan.preparedMembership).toBeUndefined();
      if (sample.kind !== "empty-listing") {
        expect(bind.mock.calls[i]![0].preparation).toBe(
          create.mock.results[i]!.value,
        );
        expect(bind.mock.calls[i]![0].siteId).toBe(siteId);
      }
    }
  },
);
