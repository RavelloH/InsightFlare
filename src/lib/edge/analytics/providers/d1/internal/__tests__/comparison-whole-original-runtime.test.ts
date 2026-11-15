// @vitest-environment node
import { createHash } from "node:crypto";

import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  createQueryTime,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { PAGE_DIMENSION_SELECTIONS } from "@/lib/edge/analytics/engine/dimension-report-plan";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as stagedRuntime from "@/lib/edge/analytics/providers/d1/internal/analytics-logical-staged-runtime";
import { buildComparisonDimensionRollupPlan } from "@/lib/edge/analytics/providers/d1/internal/comparison-dimension-source";
import * as comparisonReader from "@/lib/edge/analytics/providers/d1/internal/comparison-dimensions";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as preparation from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import { bindWholeOriginalComparisonChild } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";
const payload = 'first(event.payload("/amount")) gt 0';
const count = 'count(event { event.name eq "qualifier" }) gt 0';
const sequence =
  'sequence([window(page { page.path neq "/excluded" },@range.start,[0ms,604799999ms]),window(event { event.name eq "qualifier" },@range.start,[0ms,604799999ms])]) exists';
type Scope = "session" | "visitor";
type Sample = "private-payload-count" | "private-sequence-payload";

const expected = {
  "session/private-payload-count": {
    value: {
      value: {
        data: {
          items: [
            {
              key: "github.com",
              value: "github.com",
              label: "github.com",
              views: 3,
              sessions: 3,
              visitors: 3,
              reference: {
                views: 2,
                sessions: 2,
                visitors: 2,
              },
              change: {
                views: {
                  absolute: 1,
                  relative: 0.5,
                },
                sessions: {
                  absolute: 1,
                  relative: 0.5,
                },
                visitors: {
                  absolute: 1,
                  relative: 0.5,
                },
              },
            },
            {
              key: "__direct__",
              value: "__direct__",
              label: "__direct__",
              views: 3,
              sessions: 3,
              visitors: 1,
              reference: {
                views: 1,
                sessions: 1,
                visitors: 1,
              },
              change: {
                views: {
                  absolute: 2,
                  relative: 2,
                },
                sessions: {
                  absolute: 2,
                  relative: 2,
                },
                visitors: {
                  absolute: 0,
                  relative: 0,
                },
              },
            },
          ],
          pagination: {
            limit: 2,
            returned: 2,
            hasMore: true,
            nextCursor:
              "eyJ2IjoxLCJiaW5kaW5nIjoiMzcwZDk4NmM2MmVlZjQ4YjU4MWRlZTNhZjZjZWNmNTY0YWMyYjU1YjcwNDNiMzU5NTQ4NTNhYmJlZmVjYjc3MSIsImtleSI6eyJrZXkiOiJfX2RpcmVjdF9fIiwicHJpbWFyeSI6Mywic2Vjb25kYXJ5IjoxLCJzb3J0Q2xhc3MiOjB9fQ.eOFT55o2wyar4Gfcx3XPGQ-ndIHymNUyOJG4Big8sC8",
          },
        },
      },
    },
    orderedSqlFingerprint:
      "f6e540aaa6f8c6e6ffe14ca32d54533ad637dd53df999a339b0c710a4369fc28",
    coreCalls: 1,
    sqlCount: 6,
    strategies: ["bounded-core", "sql-membership"],
  },
  "session/private-sequence-payload": {
    value: {
      value: {
        data: {
          items: [
            {
              key: "github.com",
              value: "github.com",
              label: "github.com",
              views: 3,
              sessions: 3,
              visitors: 3,
              reference: {
                views: 2,
                sessions: 2,
                visitors: 2,
              },
              change: {
                views: {
                  absolute: 1,
                  relative: 0.5,
                },
                sessions: {
                  absolute: 1,
                  relative: 0.5,
                },
                visitors: {
                  absolute: 1,
                  relative: 0.5,
                },
              },
            },
            {
              key: "__direct__",
              value: "__direct__",
              label: "__direct__",
              views: 3,
              sessions: 3,
              visitors: 1,
              reference: {
                views: 1,
                sessions: 1,
                visitors: 1,
              },
              change: {
                views: {
                  absolute: 2,
                  relative: 2,
                },
                sessions: {
                  absolute: 2,
                  relative: 2,
                },
                visitors: {
                  absolute: 0,
                  relative: 0,
                },
              },
            },
          ],
          pagination: {
            limit: 2,
            returned: 2,
            hasMore: true,
            nextCursor:
              "eyJ2IjoxLCJiaW5kaW5nIjoiNGJmYzI0YmE5Njk0ZmI3ODAyOThmNzRhYzJkZTNhNDZiMTNmMzUzMmZlMzc2Yzk4ZDQ2NmVlZTEyN2ZiMWU2ZSIsImtleSI6eyJrZXkiOiJfX2RpcmVjdF9fIiwicHJpbWFyeSI6Mywic2Vjb25kYXJ5IjoxLCJzb3J0Q2xhc3MiOjB9fQ.nILO5h7VhfvBHdu-geC6_b7uJY3setQoZakyzzgsgJ8",
          },
        },
      },
    },
    orderedSqlFingerprint:
      "f53c55a6fbb96000493f4e1a8695d1948be4525cb824ea16a16c71bd194df85f",
    coreCalls: 1,
    sqlCount: 6,
    strategies: ["sql-membership", "bounded-core"],
  },
  "visitor/private-payload-count": {
    value: {
      value: {
        data: {
          items: [
            {
              key: "__direct__",
              value: "__direct__",
              label: "__direct__",
              views: 5,
              sessions: 5,
              visitors: 2,
              reference: {
                views: 2,
                sessions: 2,
                visitors: 1,
              },
              change: {
                views: {
                  absolute: 3,
                  relative: 1.5,
                },
                sessions: {
                  absolute: 3,
                  relative: 1.5,
                },
                visitors: {
                  absolute: 1,
                  relative: 1,
                },
              },
            },
            {
              key: "github.com",
              value: "github.com",
              label: "github.com",
              views: 3,
              sessions: 3,
              visitors: 3,
              reference: {
                views: 2,
                sessions: 2,
                visitors: 2,
              },
              change: {
                views: {
                  absolute: 1,
                  relative: 0.5,
                },
                sessions: {
                  absolute: 1,
                  relative: 0.5,
                },
                visitors: {
                  absolute: 1,
                  relative: 0.5,
                },
              },
            },
          ],
          pagination: {
            limit: 2,
            returned: 2,
            hasMore: true,
            nextCursor:
              "eyJ2IjoxLCJiaW5kaW5nIjoiZDdhNzUxNmMxZDI1ZjkxZDk5ODIwMDhjYjE0Mjc0MzAwZThjNzdhODkwMmY4MjQxZjI2ZjU5ZWFlNWZlNTM3MCIsImtleSI6eyJrZXkiOiJnaXRodWIuY29tIiwicHJpbWFyeSI6Mywic2Vjb25kYXJ5IjoyLCJzb3J0Q2xhc3MiOjB9fQ.PW7bHqv9dQ32XwjneJWqGxRgXO92Uw-ztUkLpAy-6n4",
          },
        },
      },
    },
    orderedSqlFingerprint:
      "54182f302cfb6c96536382ade7d3d9db51b32197808a86939fd57e9434ca92fd",
    coreCalls: 1,
    sqlCount: 6,
    strategies: ["bounded-core", "sql-membership"],
  },
  "visitor/private-sequence-payload": {
    value: {
      value: {
        data: {
          items: [
            {
              key: "__direct__",
              value: "__direct__",
              label: "__direct__",
              views: 5,
              sessions: 5,
              visitors: 2,
              reference: {
                views: 2,
                sessions: 2,
                visitors: 1,
              },
              change: {
                views: {
                  absolute: 3,
                  relative: 1.5,
                },
                sessions: {
                  absolute: 3,
                  relative: 1.5,
                },
                visitors: {
                  absolute: 1,
                  relative: 1,
                },
              },
            },
            {
              key: "github.com",
              value: "github.com",
              label: "github.com",
              views: 3,
              sessions: 3,
              visitors: 3,
              reference: {
                views: 2,
                sessions: 2,
                visitors: 2,
              },
              change: {
                views: {
                  absolute: 1,
                  relative: 0.5,
                },
                sessions: {
                  absolute: 1,
                  relative: 0.5,
                },
                visitors: {
                  absolute: 1,
                  relative: 0.5,
                },
              },
            },
          ],
          pagination: {
            limit: 2,
            returned: 2,
            hasMore: true,
            nextCursor:
              "eyJ2IjoxLCJiaW5kaW5nIjoiMDlmMTdiZTAxYzAwYzc4MTg1MjY3OGU5ZjE5MGE5YzhlN2RmMWRmNGJjMDE5NTYwY2I5MzA5NmU5YjI4ZjExMSIsImtleSI6eyJrZXkiOiJnaXRodWIuY29tIiwicHJpbWFyeSI6Mywic2Vjb25kYXJ5IjoyLCJzb3J0Q2xhc3MiOjB9fQ.1Bp2260X_4jfGFC7CGfyt-t8gfafkx_XAsOxWJih6es",
          },
        },
      },
    },
    orderedSqlFingerprint:
      "7e0feeaffacfeb7ae21a69ecc9f4a55361d1b5f29499caf4ecf76842cd3398e6",
    coreCalls: 1,
    sqlCount: 6,
    strategies: ["sql-membership", "bounded-core"],
  },
} as const;

function fixture(scope: Scope, sample: Sample) {
  const database = createMigratedDatabase();
  for (const sql of buildJourneyEventFieldsCostFixture(24).seed)
    database.exec(sql);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const DB = createSqliteD1Database(database, trace);
  const time = createQueryTime(
    SEED_BASE_MS,
    SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
    "UTC",
    SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
  );
  const referenceTime = createQueryTime(
    SEED_BASE_MS,
    SEED_BASE_MS + 3 * SEED_DAY_MS,
    "UTC",
    time.capturedAtMs,
  );
  const current = {
    time,
    scopePreference: scope,
    filters: parseFilterDsl(
      sample === "private-payload-count" ? payload : sequence,
      analyticsFilterRegistry,
    ),
  };
  const reference = {
    time: referenceTime,
    scopePreference: scope,
    filters: parseFilterDsl(
      sample === "private-payload-count" ? count : payload,
      analyticsFilterRegistry,
    ),
  };
  const request = prepareScopedQuery("dimension", {
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time,
    scopePreference: scope,
    filters: parseFilterDsl("", analyticsFilterRegistry),
    mode: "overview-tab",
    tab: "source.domain",
    limit: 2,
    current,
    reference,
    comparison: {
      current,
      reference,
      metric: "views",
      sortBy: "current",
      direction: "desc",
    },
  } as const);
  const diagnostics = createD1ReadDiagnostics();
  const provider = createD1SiteProviderRegistry({
    env: { DB, MAIN_SECRET: "w84-original-secret" } as Env,
    siteId: SEED_SITE_ID,
    diagnostics,
  }).resolve("dimension");
  if (!provider) throw Error("missing-comparison-provider");
  return { database, trace, request, diagnostics, provider };
}
for (const scope of ["session", "visitor"] as const)
  for (const sample of [
    "private-payload-count",
    "private-sequence-payload",
  ] as const)
    it(`${scope}: binds completed current and reference ${sample} without a prepared ID`, async () => {
      const f = fixture(scope, sample),
        baseline = expected[`${scope}/${sample}`];
      const register = vi.spyOn(bridge, "registerPreparedMembership"),
        resolve = vi.spyOn(bridge, "resolvePreparedMembership");
      const stage = vi.spyOn(stagedRuntime, "executeAnalyticsLogicalStage"),
        evaluate = vi.spyOn(core, "evaluateFilterDocument");
      const prep = vi.spyOn(
          preparation,
          "createPageVisitQualificationPreparation",
        ),
        bind = vi.spyOn(preparation, "bindPageVisitQualificationPreparation");
      const before = f.database
        .prepare("SELECT total_changes() AS writes")
        .get();
      try {
        expect(await f.provider.execute(f.request)).toEqual(baseline.value);
        expect(
          createHash("sha256")
            .update(JSON.stringify([f.trace.preparedSql, f.trace.bindings]))
            .digest("hex"),
        ).toBe(baseline.orderedSqlFingerprint);
        expect(f.trace.preparedSql).toHaveLength(baseline.sqlCount);
        expect(
          f.diagnostics.advancedFilterExecutionHistory?.map((s) => s.strategy),
        ).toEqual(baseline.strategies);
        expect(evaluate).toHaveBeenCalledTimes(baseline.coreCalls);
        expect(stage).toHaveBeenCalledTimes(2);
        expect(register).toHaveBeenCalledTimes(0);
        expect(resolve).toHaveBeenCalledTimes(0);
        expect(prep).toHaveBeenCalledTimes(2);
        expect(bind).toHaveBeenCalledTimes(2);
        expect(prep.mock.results[0]!.value).not.toBe(
          prep.mock.results[1]!.value,
        );
        expect(
          prep.mock.calls.map(([input]) => ({
            siteId: input.siteId,
            scope: input.scopePlan.scope,
            bindings: input.maxBindings,
            sources: input.maxSourcesPerRole,
            semantics: input.qualificationSemantics,
          })),
        ).toEqual(
          Array.from({ length: 2 }, () => ({
            siteId: SEED_SITE_ID,
            scope,
            bindings: 1,
            sources: 1,
            semantics: "whole-original",
          })),
        );
        expect(
          f.database.prepare("SELECT total_changes() AS writes").get(),
        ).toEqual(before);
      } finally {
        register.mockRestore();
        resolve.mockRestore();
        stage.mockRestore();
        evaluate.mockRestore();
        prep.mockRestore();
        bind.mockRestore();
        f.database.close();
      }
    });
for (const scope of ["session", "visitor"] as const)
  it(`${scope}: rejects copied or relabeled owners before storage, then permits the actual pair once`, async () => {
    const f = fixture(scope, "private-payload-count");
    const actual = comparisonReader.queryComparisonDimensionPageFromD1;
    const prep = vi.spyOn(
      preparation,
      "createPageVisitQualificationPreparation",
    );
    const register = vi.spyOn(bridge, "registerPreparedMembership"),
      resolve = vi.spyOn(bridge, "resolvePreparedMembership");
    const hook = vi
      .spyOn(comparisonReader, "queryComparisonDimensionPageFromD1")
      .mockImplementation(async (...args) => {
        const marker = args[13];
        if (!marker?.current || !marker.reference)
          throw Error("missing-completed-pair");
        const before = f.trace.preparedSql.length;
        const childPlan = preparation.snapshotPageVisitQualificationPlan(
          buildComparisonDimensionRollupPlan({
            siteId: args[1],
            window: args[2],
            filters: args[3],
            selection: args[8].selection,
            entityDependency: true,
            qualificationSemantics: "whole-original",
            outputId: "comparison-current-membership-rollup",
          }),
        );
        expect(() =>
          Reflect.apply(bindWholeOriginalComparisonChild, undefined, [
            {
              owner: marker.current,
              side: "current",
              tab: "not-a-known-reader",
              siteId: args[1],
              window: args[2],
              filters: args[3],
              plan: childPlan,
            },
          ]),
        ).toThrow("whole_filter_comparison_child_mismatch");
        expect(f.trace.preparedSql).toHaveLength(before);
        expect(prep).toHaveBeenCalledTimes(0);
        for (const name of ["clone", "swap", "public", "selection"] as const) {
          const probe: Parameters<typeof actual> = [...args];
          if (name === "clone")
            probe[13] = { ...marker, current: { ...marker.current } };
          if (name === "swap")
            probe[13] = {
              ...marker,
              current: marker.reference,
              reference: marker.current,
            };
          if (name === "public") probe[10] = "public-share";
          if (name === "selection")
            probe[8] = {
              ...args[8],
              selection: PAGE_DIMENSION_SELECTIONS.browser,
            };
          await expect(actual(...probe)).rejects.toThrow();
          expect(f.trace.preparedSql).toHaveLength(before);
          expect(prep).toHaveBeenCalledTimes(0);
        }
        const page = await actual(...args),
          after = f.trace.preparedSql.length;
        expect(prep).toHaveBeenCalledTimes(2);
        await expect(actual(...args)).rejects.toThrow();
        expect(f.trace.preparedSql).toHaveLength(after);
        expect(prep).toHaveBeenCalledTimes(2);
        return page;
      });
    try {
      expect(await f.provider.execute(f.request)).toEqual(
        expected[`${scope}/private-payload-count`].value,
      );
      expect(hook).toHaveBeenCalledTimes(1);
      expect(register).toHaveBeenCalledTimes(0);
      expect(resolve).toHaveBeenCalledTimes(0);
    } finally {
      hook.mockRestore();
      prep.mockRestore();
      register.mockRestore();
      resolve.mockRestore();
      f.database.close();
    }
  });
