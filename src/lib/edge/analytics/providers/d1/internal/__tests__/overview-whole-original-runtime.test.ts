// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import * as composition from "@/lib/edge/analytics/composition/d1/overview";
import type { CanonicalQuery } from "@/lib/edge/analytics/contract";
import {
  createQueryTime,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY as ENTITY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as prep from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as whole from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import * as readers from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";
const end = SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
  split = SEED_BASE_MS + 3 * SEED_DAY_MS;
const current = createQueryTime(split, end, "UTC", end + SEED_DAY_MS),
  previous = createQueryTime(SEED_BASE_MS, split, "UTC", end + SEED_DAY_MS);
const originalFilter =
  'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"';
// Complete small SQLite results captured from the original whole-ID-bridge route.
const expected = {
  session: {
    whole: {
      value: {
        current: {
          views: 10,
          sessions: 4,
          visitors: 3,
          bounces: 1,
          totalDurationMs: 179021,
          durationViews: 10,
        },
        previous: {
          views: 2,
          sessions: 1,
          visitors: 1,
          bounces: 0,
          totalDurationMs: 20563,
          durationViews: 2,
        },
        detail: {
          interval: "day",
          points: [
            {
              bucket: 1,
              timestampMs: 1700265600000,
              views: 3,
              sessions: 2,
              visitors: 2,
              bounces: 1,
              totalDurationMs: 38172,
              durationViews: 3,
            },
            {
              bucket: 2,
              timestampMs: 1700352000000,
              views: 1,
              sessions: 0,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 14678,
              durationViews: 1,
            },
            {
              bucket: 3,
              timestampMs: 1700438400000,
              views: 3,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 58689,
              durationViews: 3,
            },
            {
              bucket: 4,
              timestampMs: 1700524800000,
              views: 3,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 67482,
              durationViews: 3,
            },
          ],
        },
      },
      source: "raw",
      approximateVisitors: false,
    },
    previous: {
      value: {
        current: {
          views: 10,
          sessions: 4,
          visitors: 3,
          bounces: 1,
          totalDurationMs: 179021,
          durationViews: 10,
        },
        previous: {
          views: 2,
          sessions: 1,
          visitors: 1,
          bounces: 0,
          totalDurationMs: 20563,
          durationViews: 2,
        },
        detail: {
          interval: "day",
          points: [
            {
              bucket: 1,
              timestampMs: 1700265600000,
              views: 3,
              sessions: 2,
              visitors: 2,
              bounces: 1,
              totalDurationMs: 38172,
              durationViews: 3,
            },
            {
              bucket: 2,
              timestampMs: 1700352000000,
              views: 1,
              sessions: 0,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 14678,
              durationViews: 1,
            },
            {
              bucket: 3,
              timestampMs: 1700438400000,
              views: 3,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 58689,
              durationViews: 3,
            },
            {
              bucket: 4,
              timestampMs: 1700524800000,
              views: 3,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 67482,
              durationViews: 3,
            },
          ],
        },
      },
      source: "raw",
      approximateVisitors: false,
    },
    detail: {
      value: {
        current: {
          views: 10,
          sessions: 4,
          visitors: 3,
          bounces: 1,
          totalDurationMs: 179021,
          durationViews: 10,
        },
        previous: {
          views: 2,
          sessions: 1,
          visitors: 1,
          bounces: 0,
          totalDurationMs: 20563,
          durationViews: 2,
        },
        detail: {
          interval: "week",
          points: [
            {
              bucket: 0,
              timestampMs: 1699833600000,
              views: 4,
              sessions: 2,
              visitors: 2,
              bounces: 1,
              totalDurationMs: 52850,
              durationViews: 4,
            },
            {
              bucket: 1,
              timestampMs: 1700438400000,
              views: 6,
              sessions: 2,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 126171,
              durationViews: 6,
            },
          ],
        },
      },
      source: "raw",
      approximateVisitors: false,
    },
    time: {
      value: {
        current: {
          views: 10,
          sessions: 4,
          visitors: 3,
          bounces: 1,
          totalDurationMs: 179021,
          durationViews: 10,
        },
        previous: {
          views: 2,
          sessions: 1,
          visitors: 1,
          bounces: 0,
          totalDurationMs: 20563,
          durationViews: 2,
        },
        detail: {
          interval: "day",
          points: [
            {
              bucket: 3,
              timestampMs: 1700179200000,
              views: 2,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 20563,
              durationViews: 2,
            },
          ],
        },
      },
      source: "raw",
      approximateVisitors: false,
    },
    count: {
      value: {
        current: {
          views: 6,
          sessions: 4,
          visitors: 3,
          bounces: 3,
          totalDurationMs: 70436,
          durationViews: 4,
        },
        previous: {
          views: 2,
          sessions: 1,
          visitors: 1,
          bounces: 0,
          totalDurationMs: 20563,
          durationViews: 2,
        },
        detail: {
          interval: "day",
          points: [
            {
              bucket: 0,
              timestampMs: 1700179200000,
              views: 1,
              visitors: 1,
              sessions: 1,
              bounces: 1,
              totalDurationMs: 0,
              durationViews: 0,
            },
            {
              bucket: 1,
              timestampMs: 1700265600000,
              views: 2,
              visitors: 2,
              sessions: 2,
              bounces: 2,
              totalDurationMs: 11747,
              durationViews: 1,
            },
            {
              bucket: 3,
              timestampMs: 1700438400000,
              views: 3,
              visitors: 1,
              sessions: 1,
              bounces: 0,
              totalDurationMs: 58689,
              durationViews: 3,
            },
          ],
        },
      },
      source: "raw",
      approximateVisitors: false,
    },
  },
  visitor: {
    whole: {
      value: {
        current: {
          views: 15,
          sessions: 7,
          visitors: 4,
          bounces: 3,
          totalDurationMs: 228917,
          durationViews: 13,
        },
        previous: {
          views: 11,
          sessions: 4,
          visitors: 2,
          bounces: 0,
          totalDurationMs: 64735,
          durationViews: 11,
        },
        detail: {
          interval: "day",
          points: [
            {
              bucket: 0,
              timestampMs: 1700179200000,
              views: 1,
              sessions: 1,
              visitors: 1,
              bounces: 1,
              totalDurationMs: 0,
              durationViews: 0,
            },
            {
              bucket: 1,
              timestampMs: 1700265600000,
              views: 4,
              sessions: 3,
              visitors: 3,
              bounces: 2,
              totalDurationMs: 38172,
              durationViews: 3,
            },
            {
              bucket: 2,
              timestampMs: 1700352000000,
              views: 4,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 64574,
              durationViews: 4,
            },
            {
              bucket: 3,
              timestampMs: 1700438400000,
              views: 3,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 58689,
              durationViews: 3,
            },
            {
              bucket: 4,
              timestampMs: 1700524800000,
              views: 3,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 67482,
              durationViews: 3,
            },
          ],
        },
      },
      source: "raw",
      approximateVisitors: false,
    },
    previous: {
      value: {
        current: {
          views: 15,
          sessions: 7,
          visitors: 4,
          bounces: 3,
          totalDurationMs: 228917,
          durationViews: 13,
        },
        previous: {
          views: 7,
          sessions: 3,
          visitors: 2,
          bounces: 0,
          totalDurationMs: 54873,
          durationViews: 7,
        },
        detail: {
          interval: "day",
          points: [
            {
              bucket: 0,
              timestampMs: 1700179200000,
              views: 1,
              sessions: 1,
              visitors: 1,
              bounces: 1,
              totalDurationMs: 0,
              durationViews: 0,
            },
            {
              bucket: 1,
              timestampMs: 1700265600000,
              views: 4,
              sessions: 3,
              visitors: 3,
              bounces: 2,
              totalDurationMs: 38172,
              durationViews: 3,
            },
            {
              bucket: 2,
              timestampMs: 1700352000000,
              views: 4,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 64574,
              durationViews: 4,
            },
            {
              bucket: 3,
              timestampMs: 1700438400000,
              views: 3,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 58689,
              durationViews: 3,
            },
            {
              bucket: 4,
              timestampMs: 1700524800000,
              views: 3,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 67482,
              durationViews: 3,
            },
          ],
        },
      },
      source: "raw",
      approximateVisitors: false,
    },
    detail: {
      value: {
        current: {
          views: 15,
          sessions: 7,
          visitors: 4,
          bounces: 3,
          totalDurationMs: 228917,
          durationViews: 13,
        },
        previous: {
          views: 11,
          sessions: 4,
          visitors: 2,
          bounces: 0,
          totalDurationMs: 64735,
          durationViews: 11,
        },
        detail: {
          interval: "week",
          points: [
            {
              bucket: 0,
              timestampMs: 1699833600000,
              views: 9,
              sessions: 5,
              visitors: 3,
              bounces: 3,
              totalDurationMs: 102746,
              durationViews: 7,
            },
            {
              bucket: 1,
              timestampMs: 1700438400000,
              views: 6,
              sessions: 2,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 126171,
              durationViews: 6,
            },
          ],
        },
      },
      source: "raw",
      approximateVisitors: false,
    },
    time: {
      value: {
        current: {
          views: 15,
          sessions: 7,
          visitors: 4,
          bounces: 3,
          totalDurationMs: 228917,
          durationViews: 13,
        },
        previous: {
          views: 11,
          sessions: 4,
          visitors: 2,
          bounces: 0,
          totalDurationMs: 64735,
          durationViews: 11,
        },
        detail: {
          interval: "day",
          points: [
            {
              bucket: 0,
              timestampMs: 1699920000000,
              views: 1,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 1000,
              durationViews: 1,
            },
            {
              bucket: 1,
              timestampMs: 1700006400000,
              views: 3,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 8862,
              durationViews: 3,
            },
            {
              bucket: 2,
              timestampMs: 1700092800000,
              views: 4,
              sessions: 1,
              visitors: 2,
              bounces: 0,
              totalDurationMs: 25494,
              durationViews: 4,
            },
            {
              bucket: 3,
              timestampMs: 1700179200000,
              views: 3,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 29379,
              durationViews: 3,
            },
          ],
        },
      },
      source: "raw",
      approximateVisitors: false,
    },
    count: {
      value: {
        current: {
          views: 9,
          sessions: 5,
          visitors: 3,
          bounces: 3,
          totalDurationMs: 137918,
          durationViews: 7,
        },
        previous: {
          views: 11,
          sessions: 4,
          visitors: 2,
          bounces: 0,
          totalDurationMs: 64735,
          durationViews: 11,
        },
        detail: {
          interval: "day",
          points: [
            {
              bucket: 0,
              timestampMs: 1700179200000,
              views: 1,
              visitors: 1,
              sessions: 1,
              bounces: 1,
              totalDurationMs: 0,
              durationViews: 0,
            },
            {
              bucket: 1,
              timestampMs: 1700265600000,
              views: 2,
              visitors: 2,
              sessions: 2,
              bounces: 2,
              totalDurationMs: 11747,
              durationViews: 1,
            },
            {
              bucket: 3,
              timestampMs: 1700438400000,
              views: 3,
              visitors: 1,
              sessions: 1,
              bounces: 0,
              totalDurationMs: 58689,
              durationViews: 3,
            },
            {
              bucket: 4,
              timestampMs: 1700524800000,
              views: 3,
              visitors: 1,
              sessions: 1,
              bounces: 0,
              totalDurationMs: 67482,
              durationViews: 3,
            },
          ],
        },
      },
      source: "raw",
      approximateVisitors: false,
    },
  },
};

type Scope = "session" | "visitor";
type Change =
  | "aggregate"
  | "whole"
  | "previous"
  | "detail"
  | "time"
  | "root-null"
  | "root-native"
  | "trend"
  | "count";
const originalReader = readers.createOverviewReader,
  originalOverview = composition.overviewProvider,
  originalTrend = composition.trendProvider;
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const database = createMigratedDatabase();
  for (const sql of buildJourneyEventFieldsCostFixture(24).seed)
    database.exec(sql);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "whole-overview-native-test",
  } as unknown as Env;
  return { database, trace, env };
}
async function run(
  scope: Scope,
  change: Change,
  errorKind?: "Core" | "current",
) {
  const f = fixture(),
    operation = change === "trend" ? "trend" : "overview";
  const q = prepareScopedQuery(operation, {
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time: current,
    filters: parseFilterDsl(
      change === "count"
        ? 'count(event { event.name eq "qualifier" }) gt 0'
        : originalFilter,
      analyticsFilterRegistry,
    ),
    scopePreference: scope,
    ...(operation === "overview" && change !== "aggregate"
      ? { previousTime: previous, detailInterval: "day" as const }
      : operation === "trend"
        ? { interval: "day" as const }
        : {}),
  });
  let owner: CanonicalQuery<"overview"> | CanonicalQuery<"trend"> | undefined,
    reads = 0;
  const sentinel = new Error("original-overview-error");
  const register = vi.spyOn(bridge, "registerPreparedMembership"),
    evaluate = vi.spyOn(core, "evaluateFilterDocument"),
    create = vi.spyOn(prep, "createPageVisitQualificationPreparation"),
    bind = vi.spyOn(prep, "bindPageVisitQualificationPreparation");
  if (errorKind === "Core")
    evaluate.mockImplementation(() => {
      throw sentinel;
    });
  vi.spyOn(composition, "overviewProvider").mockImplementation((...a) => {
    const p = originalOverview(...a);
    return {
      execute: (query, execution) => {
        owner = query;
        return p.execute(query, execution);
      },
    };
  });
  vi.spyOn(composition, "trendProvider").mockImplementation((...a) => {
    const p = originalTrend(...a);
    return {
      execute: (query, execution) => {
        owner = query;
        return p.execute(query, execution);
      },
    };
  });
  function mutate(stage: number) {
    if (!owner) throw new Error("missing_actual_provider_owner");
    if (stage === 1 && change === "previous")
      Object.assign(owner, {
        previousTime: createQueryTime(
          SEED_BASE_MS + SEED_DAY_MS,
          split,
          "UTC",
          end + SEED_DAY_MS,
        ),
      });
    if (stage === 2 && change === "detail")
      Object.assign(owner, { detailInterval: "week" });
    if (stage === 2 && change === "time")
      Object.assign(owner, { time: previous });
    if (stage === 1 && change === "root-native")
      Object.assign(owner.filters!, {
        root: parseFilterDsl(
          'page.path eq "/excluded"',
          analyticsFilterRegistry,
        ).root,
      });
  }
  vi.spyOn(readers, "createOverviewReader").mockImplementation((...a) => {
    const reader = originalReader(...a);
    return {
      readOverview(input) {
        const stage = ++reads;
        const pending = reader.readOverview(input);
        if (stage === 1 && change === "root-null")
          Object.assign(input.filters, { root: null });
        pending.then(
          () => mutate(stage),
          () => undefined,
        );
        return errorKind === "current" && stage === 1
          ? pending.then(() => {
              throw sentinel;
            })
          : pending;
      },
      readTrend(input) {
        reads++;
        return reader.readTrend(input);
      },
    };
  });
  try {
    const provider = createD1SiteProviderRegistry({
      env: f.env,
      siteId: SEED_SITE_ID,
    }).resolve(operation)!;
    if (errorKind) {
      await expect(provider.execute(q)).rejects.toBe(sentinel);
      expect(register).not.toHaveBeenCalled();
      expect(evaluate).toHaveBeenCalledTimes(1);
      if (errorKind === "Core") {
        expect(reads).toBe(0);
        expect(create).not.toHaveBeenCalled();
        expect(f.trace.preparedSql).toHaveLength(2);
      } else {
        expect(reads).toBe(1);
        expect(create).toHaveBeenCalledTimes(1);
        expect(f.trace.preparedSql).toHaveLength(3);
      }
      return;
    }
    const fixed = expected[scope];
    const expectedResult =
      change === "aggregate"
        ? { ...fixed.whole, value: { current: fixed.whole.value.current } }
        : change === "trend"
          ? {
              ...fixed.whole,
              value: {
                interval: "day",
                points: fixed.whole.value.detail.points,
              },
            }
          : change === "root-null" || change === "root-native"
            ? fixed.whole
            : fixed[change];
    expect(await provider.execute(q)).toEqual(expectedResult);
    expect(register).not.toHaveBeenCalled();
    if (change === "count") {
      expect(evaluate).not.toHaveBeenCalled();
      return;
    }
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledTimes(
      change === "trend" || change === "aggregate" ? 1 : 3,
    );
    expect(
      new Set(bind.mock.calls.map(([input]) => input.preparation)).size,
    ).toBe(1);
    const first = bind.mock.calls[0]![0];
    expect(Object.isFrozen(first.filters)).toBe(true);
    for (const [input] of bind.mock.calls) {
      expect(input.filters).toBe(first.filters);
      const sources = input.plan.nodes.filter((node) => node.kind === "source");
      expect(sources.map((source) => source.entity)).toEqual(["page", "event"]);
      expect(
        sources.map((source) => source.selection?.qualificationDependencyRefs),
      ).toEqual([[ENTITY], [ENTITY]]);
    }
    expect(f.trace.preparedSql).toHaveLength(
      change === "trend" || change === "aggregate" ? 3 : 5,
    );
    const beforeReplay = f.trace.preparedSql.length;
    expect(() =>
      whole.bindWholeOriginalOverview({
        owner: owner!,
        kind: "aggregate",
        siteId: SEED_SITE_ID,
        filters: owner!.filters!,
        readerQueryTime: current,
      }),
    ).toThrow("overview_whole_reader_stage_mismatch");
    expect(f.trace.preparedSql).toHaveLength(beforeReplay);
    expect(create).toHaveBeenCalledTimes(1);
  } finally {
    f.database.close();
  }
}
it.each(["session", "visitor"] as const)(
  "%s preserves original complete Overview results, three Sources pairs and one preparation",
  async (scope) => run(scope, "whole"),
);
it.each(["session", "visitor"] as const)(
  "%s aggregate-only completion closes both unused optional stages",
  async (scope) => run(scope, "aggregate"),
);
it.each(["session", "visitor"] as const)(
  "%s standalone Trend is one plan and closes replay",
  async (scope) => run(scope, "trend"),
);
it.each(["session", "visitor"] as const)(
  "%s existing Count fusion remains zero bridge and zero Core",
  async (scope) => run(scope, "count"),
);
for (const change of [
  "previous",
  "detail",
  "time",
  "root-null",
  "root-native",
] as const)
  it.each(["session", "visitor"] as const)(
    `%s keeps the original late ${change} checkpoint`,
    async (scope) => run(scope, change),
  );
for (const error of ["Core", "current"] as const)
  it.each(["session", "visitor"] as const)(
    `%s preserves ${error} Error identity and stops later reads`,
    async (scope) => run(scope, "whole", error),
  );
