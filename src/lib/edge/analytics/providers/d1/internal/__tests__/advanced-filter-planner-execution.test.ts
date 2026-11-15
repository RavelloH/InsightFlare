// @vitest-environment node
import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  prepareScopedQuery,
  type QueryAudience,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import {
  checkDifferentialFilterCase,
  generateDifferentialFilterCases,
} from "@/lib/edge/analytics/engine/__tests__/differential/filter-cases";
import * as countSupport from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

import { COST_FILTER, COST_TIME } from "./remote-d1/referrers-cost-harness";
import {
  buildDataStatements,
  buildSiteStatements,
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_SITE_ID,
} from "./remote-d1/seed";

describe("advanced filter execution planner through the real provider", () => {
  let local: DatabaseSync;
  let env: Env;
  beforeAll(() => {
    local = createMigratedDatabase();
    for (const sql of [
      ...buildSiteStatements(),
      ...buildDataStatements({ visits: 96 }),
    ])
      local.exec(sql);
    // Session/visitor identities deliberately collide across sites. Activities
    // have globally unique IDs in the schema, so only those IDs are suffixed.
    local.exec(`
      INSERT INTO site_identities (site_pk, site_id) VALUES (2, 'other-site');
      INSERT INTO sites (id, team_id, name, domain, created_at, updated_at)
      VALUES ('other-site', 'c01-team', 'Other', 'other.invalid', 0, 0);
    `);
    const clone = (
      table: string,
      replacements: Readonly<Record<string, string>>,
      omit: readonly string[] = [],
    ) => {
      const columns = (
        local.prepare(`PRAGMA table_info("${table}")`).all() as {
          name: string;
        }[]
      )
        .map((column) => column.name)
        .filter((name) => !omit.includes(name));
      local.exec(
        `INSERT INTO "${table}" (${columns.map((name) => `"${name}"`).join(", ")})
         SELECT ${columns.map((name) => replacements[name] ?? `"${name}"`).join(", ")}
         FROM "${table}" WHERE site_pk = 1`,
      );
    };
    const foreign = { site_id: "'other-site'", site_pk: "2" };
    clone("custom_event_names", { ...foreign, id: "id + 100" });
    clone("visits", {
      ...foreign,
      visit_id: "visit_id || '-other'",
      pathname: "'/foreign-only'",
    });
    clone(
      "custom_events",
      {
        ...foreign,
        event_id: "event_id || '-other'",
        visit_id: "visit_id || '-other'",
        event_name_id: "event_name_id + 100",
      },
      ["event_pk"],
    );
    env = {
      DB: createSqliteD1Database(local),
      MAIN_SECRET: "execution-planner-test",
    } as unknown as Env;
  });
  afterAll(() => local?.close());

  async function execute(
    scope: "session" | "visitor",
    filterDsl: string,
    time: QueryTime = COST_TIME,
    audience: QueryAudience = "private-dashboard",
  ) {
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SEED_SITE_ID,
      diagnostics,
    }).resolve("referrers")!;
    const query = {
      ...prepareScopedQuery("referrers", {
        context: siteQueryContext(SEED_SITE_ID, audience),
        time,
        filters: parseFilterDsl(filterDsl, analyticsFilterRegistry),
        scopePreference: scope,
      } as QueryInput & { readonly time: typeof COST_TIME }),
      variant: "summary",
      topN: 10,
    };
    const result = await provider.execute(query as never);
    return { value: result.value, diagnostics };
  }

  for (const scope of ["session", "visitor"] as const)
    it.each([
      {
        name: "candidate window",
        dsl: COST_FILTER,
        strategy: "sql-report-fusion",
        reason: "whole-tree-report-fusion-supported",
      },
      {
        name: "independent expression window",
        dsl: `${COST_FILTER} and time gte @range.start+1d`,
        strategy: "sql-membership",
        reason: "independent-membership-time-domains",
      },
    ])(
      `${scope}: $name keeps Core parity and explains its strategy`,
      async (test) => {
        const actual = await execute(scope, test.dsl);
        expect(actual.diagnostics.advancedFilterExecution).toMatchObject({
          strategy: test.strategy,
          reason: test.reason,
          membership: {
            identity: { site: "siteId", grain: scope, roles: [scope] },
          },
        });
        const unsupported = vi
          .spyOn(countSupport, "classifyAdvancedCountFilter")
          .mockReturnValue({
            kind: "unsupported",
            code: "forced_core_oracle",
            path: "root",
            reason: "Exercise the independent Core oracle.",
          });
        try {
          const reference = await execute(scope, test.dsl);
          expect(reference.diagnostics.advancedFilterExecution).toMatchObject({
            strategy: "bounded-core",
            reason: "forced_core_oracle",
            coreBounds: {
              maxActivities: 20000,
              maxSequenceMatches: 50000,
              maxSequenceWork: 1000000,
            },
          });
          expect(actual.value).toEqual(reference.value);
        } finally {
          unsupported.mockRestore();
        }
      },
    );

  const lateWindow = createQueryTime(
    SEED_BASE_MS + 5 * SEED_DAY_MS,
    COST_TIME.range.endExclusiveMs,
    "UTC",
    COST_TIME.capturedAtMs,
  );
  const generated = generateDifferentialFilterCases(0x20261114, 6);
  for (const scope of ["session", "visitor"] as const)
    for (const audience of [
      "private-dashboard",
      "api-v1",
      "public-share",
    ] as const)
      for (const fullHistory of [false, true])
        it.each(generated)(
          `${scope}/${audience}/fullHistory=${fullHistory}: generated time-domain parity, seed $seed case $index`,
          async (sample) => {
            const time = { ...lateWindow, fullHistory };
            const withTime = (dsl: string) =>
              `(${dsl}) and time gte @range.start-1d`;
            await checkDifferentialFilterCase({
              sample,
              reference: async (dsl) => {
                const unsupported = vi
                  .spyOn(countSupport, "classifyAdvancedCountFilter")
                  .mockReturnValue({
                    kind: "unsupported",
                    code: "forced_core_oracle",
                    path: "root",
                    reason: "Generated time-domain Core oracle.",
                  });
                try {
                  return (await execute(scope, withTime(dsl), time, audience))
                    .value;
                } finally {
                  unsupported.mockRestore();
                }
              },
              candidates: {
                sql: async (dsl) => {
                  const actual = await execute(
                    scope,
                    withTime(dsl),
                    time,
                    audience,
                  );
                  expect(
                    actual.diagnostics.advancedFilterExecution,
                  ).toBeDefined();
                  expect(
                    actual.diagnostics.advancedFilterExecution?.strategy,
                  ).not.toBe("bounded-core");
                  return actual.value;
                },
              },
            });
          },
        );
  for (const scope of ["session", "visitor"] as const)
    for (const audience of [
      "private-dashboard",
      "api-v1",
      "public-share",
    ] as const)
      it.each([
        {
          name: "candidate and historical expression windows",
          time: lateWindow,
          dsl: `${COST_FILTER} and time gte @range.start-1d`,
        },
        {
          name: "retained history with a bounded report window",
          time: { ...lateWindow, fullHistory: true },
          dsl: COST_FILTER,
        },
        {
          name: "empty expression window",
          time: lateWindow,
          dsl: `${COST_FILTER} and time gt @now+1d`,
        },
        {
          name: "empty candidate window",
          time: createQueryTime(
            COST_TIME.range.endExclusiveMs,
            COST_TIME.capturedAtMs,
            "UTC",
            COST_TIME.capturedAtMs,
          ),
          dsl: COST_FILTER,
        },
      ])(
        `${scope}/${audience}: $name keeps full DTO parity with colliding foreign identities`,
        async (test) => {
          const actual = await execute(scope, test.dsl, test.time, audience);
          const unsupported = vi
            .spyOn(countSupport, "classifyAdvancedCountFilter")
            .mockReturnValue({
              kind: "unsupported",
              code: "forced_core_oracle",
              path: "root",
              reason: "Compare the independent Core implementation.",
            });
          try {
            const reference = await execute(
              scope,
              test.dsl,
              test.time,
              audience,
            );
            expect(actual.value).toEqual(reference.value);
          } finally {
            unsupported.mockRestore();
          }
        },
      );
});
