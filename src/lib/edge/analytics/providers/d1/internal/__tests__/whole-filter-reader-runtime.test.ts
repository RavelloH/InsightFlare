import { afterEach, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as cards from "@/lib/edge/analytics/engine/event-summary-cards-plan";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as stagedRuntime from "@/lib/edge/analytics/providers/d1/internal/analytics-logical-staged-runtime";
import * as prep from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as whole from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-executor";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";

const originalFilter =
  'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"';
const queryTime = createQueryTime(
  SEED_BASE_MS,
  SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);
// Complete old whole-original results, captured before request-private binding.
const expected = {
  session: {
    value: {
      summary: {
        events: 6,
        eventTypes: 2,
        sessions: 3,
        visitors: 3,
        avgEventsPerSession: 2,
      },
      cards: {
        event: {
          name: [
            {
              label: "other",
              views: 3,
              sessions: 3,
              visitors: 3,
            },
            {
              label: "qualifier",
              views: 3,
              sessions: 2,
              visitors: 2,
            },
          ],
        },
        page: {
          path: [
            {
              label: "/qualifier",
              views: 3,
              sessions: 2,
              visitors: 2,
            },
            {
              label: "/",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
            {
              label: "/blog/c",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
            {
              label: "/docs/guide",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
          ],
          title: [],
          hostname: [
            {
              label: "c01.example.invalid",
              views: 6,
              sessions: 3,
              visitors: 3,
            },
          ],
        },
      },
    },
  },
  visitor: {
    value: {
      summary: {
        events: 11,
        eventTypes: 2,
        sessions: 7,
        visitors: 4,
        avgEventsPerSession: 1.5714285714285714,
      },
      cards: {
        event: {
          name: [
            {
              label: "qualifier",
              views: 6,
              sessions: 5,
              visitors: 3,
            },
            {
              label: "other",
              views: 5,
              sessions: 5,
              visitors: 4,
            },
          ],
        },
        page: {
          path: [
            {
              label: "/qualifier",
              views: 6,
              sessions: 5,
              visitors: 3,
            },
            {
              label: "/",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
            {
              label: "/blog/c",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
            {
              label: "/docs/guide",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
            {
              label: "/excluded",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
            {
              label: "/pricing",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
          ],
          title: [],
          hostname: [
            {
              label: "c01.example.invalid",
              views: 11,
              sessions: 7,
              visitors: 4,
            },
          ],
        },
      },
    },
  },
};

function fixture() {
  const database = createMigratedDatabase();
  for (const sql of buildJourneyEventFieldsCostFixture(24).seed)
    database.exec(sql);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "whole-original-native-test",
  } as unknown as Env;
  return { database, trace, env };
}
function request(scope: "session" | "visitor") {
  return prepareScopedQuery("event-summary", {
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time: queryTime,
    filters: parseFilterDsl(originalFilter, analyticsFilterRegistry),
    scopePreference: scope,
  });
}
afterEach(() => vi.restoreAllMocks());

it.each([
  ["session", "null"],
  ["session", "replace"],
  ["session", "in-place"],
  ["visitor", "null"],
  ["visitor", "replace"],
  ["visitor", "in-place"],
] as const)(
  "%s preserves completed whole qualification after a successful %s root change",
  async (scope, change) => {
    const f = fixture(),
      q = request(scope);
    const actual = core.evaluateFilterDocument;
    const register = vi.spyOn(bridge, "registerPreparedMembership");
    const evaluate = vi
      .spyOn(core, "evaluateFilterDocument")
      .mockImplementation((...args) => {
        const value = actual(...args);
        const nativeRoot = parseFilterDsl(
          'page.path eq "/excluded"',
          analyticsFilterRegistry,
        ).root!;
        if (change === "null") Object.assign(q.filters, { root: null });
        else if (change === "replace")
          Object.assign(q.filters, { root: nativeRoot });
        else {
          const root = q.filters.root!;
          for (const key of Object.keys(root))
            Reflect.deleteProperty(root, key);
          Object.assign(root, nativeRoot);
        }
        return value;
      });
    try {
      const result = await createD1SiteProviderRegistry({
        env: f.env,
        siteId: SEED_SITE_ID,
      })
        .resolve("event-summary")!
        .execute(q);
      expect(result).toEqual(expected[scope]);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(register).not.toHaveBeenCalled();
      expect(f.trace.preparedSql).toHaveLength(3);
    } finally {
      f.database.close();
    }
  },
);

it.each(["session", "visitor"] as const)(
  "%s evaluates the same canonical request independently on consecutive registry executions",
  async (scope) => {
    const f = fixture(),
      q = request(scope);
    const register = vi.spyOn(bridge, "registerPreparedMembership"),
      evaluate = vi.spyOn(core, "evaluateFilterDocument");
    const provider = createD1SiteProviderRegistry({
      env: f.env,
      siteId: SEED_SITE_ID,
    }).resolve("event-summary")!;
    try {
      expect(await provider.execute(q)).toEqual(expected[scope]);
      const firstSql = [...f.trace.preparedSql],
        firstParams = [...f.trace.bindings];
      expect(firstSql).toHaveLength(3);
      expect(await provider.execute(q)).toEqual(expected[scope]);
      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(register).not.toHaveBeenCalled();
      expect(f.trace.preparedSql.slice(3)).toEqual(firstSql);
      expect(f.trace.bindings.slice(3)).toEqual(firstParams);
    } finally {
      f.database.close();
    }
  },
);

it("retains the original Core Error object before reader preparation when abort and metadata change together", async () => {
  const f = fixture(),
    q = request("session"),
    abort = new AbortController(),
    sentinel = new Error("whole_original_core_error");
  const register = vi.spyOn(bridge, "registerPreparedMembership");
  const preparation = vi.spyOn(prep, "createPageVisitQualificationPreparation");
  const builder = vi.spyOn(cards, "buildEventSummaryCardsPlan");
  const evaluate = vi
    .spyOn(core, "evaluateFilterDocument")
    .mockImplementation(() => {
      Object.assign(scopedFilterMetadata(q.filters)!, { siteIds: ["foreign"] });
      abort.abort();
      throw sentinel;
    });
  try {
    await expect(
      createD1SiteProviderRegistry({ env: f.env, siteId: SEED_SITE_ID })
        .resolve("event-summary")!
        .execute(q, { signal: abort.signal }),
    ).rejects.toBe(sentinel);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(register).not.toHaveBeenCalled();
    expect(preparation).not.toHaveBeenCalled();
    expect(builder).not.toHaveBeenCalled();
    expect(f.trace.preparedSql).toHaveLength(2);
  } finally {
    f.database.close();
  }
});

it("keeps the original whole await checkpoint and canonical builder before synchronous preparation", async () => {
  // Exercise the existing staged adapter's exact controlled-Promise contract.
  // The actual providers, AFE middleware and request remain unchanged; only
  // the newer D1 Program dispatcher is omitted in this one compatibility
  // control. Actual Program behavior is covered by real-registry tests.
  const createAdapterCheckpointRegistry = (
    options: Parameters<typeof createD1SiteProviderRegistry>[0],
  ) => {
    const registry = createD1SiteProviderRegistry(options);
    Object.defineProperty(registry, "resolve", {
      value: AnalyticsProviderRegistry.prototype.resolve,
    });
    return registry;
  };

  const f = fixture(),
    q = request("session"),
    events: string[] = [];
  let release!: (value: whole.QualificationMatchRow[]) => void;
  const pending = new Promise<whole.QualificationMatchRow[]>((resolve) => {
    release = resolve;
  });
  const stage = vi.spyOn(stagedRuntime, "executeAnalyticsLogicalStage");
  const legacy = vi.spyOn(whole, "evaluateWholeFilterMembership");
  const evaluate = vi.spyOn(core, "evaluateFilterDocument");
  const provider = createAdapterCheckpointRegistry({
    env: f.env,
    siteId: SEED_SITE_ID,
  }).resolve("event-summary")!;
  const register = vi.spyOn(bridge, "registerPreparedMembership");
  try {
    // Native SQL/Core execution protects the active route; the controlled Promise
    // below separately checks its original continuation checkpoint.
    expect(await provider.execute(q)).toEqual(expected.session);
    expect(stage).toHaveBeenCalledTimes(1);
    expect(stage.mock.calls[0]![0].kind).toBe(
      "whole-original-completion-at-original-checkpoint",
    );
    expect(legacy).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(f.trace.preparedSql).toHaveLength(3);
    expect(f.trace.bindings).toHaveLength(3);
    f.trace.preparedSql.length = 0;
    f.trace.bindings.length = 0;
    stage.mockImplementation((input) => {
      expect(input.kind).toBe(
        "whole-original-completion-at-original-checkpoint",
      );
      events.push("executor");
      return pending;
    });
    const actualBuilder = cards.buildEventSummaryCardsPlan;
    vi.spyOn(cards, "buildEventSummaryCardsPlan").mockImplementation(
      (...args) => {
        events.push("canonical-builder");
        return actualBuilder(...args);
      },
    );
    const actualPrep = prep.createPageVisitQualificationPreparation;
    vi.spyOn(
      prep,
      "createPageVisitQualificationPreparation",
    ).mockImplementation((...args) => {
      events.push("create-preparation");
      return actualPrep(...args);
    });
    const result = createAdapterCheckpointRegistry({
      env: f.env,
      siteId: SEED_SITE_ID,
    })
      .resolve("event-summary")!
      .execute(q);
    events.push("returned");
    for (let n = 0; !events.includes("executor") && n < 30; n++)
      await Promise.resolve();
    expect(events).toContain("executor");
    events.push("release");
    release([{ siteId: SEED_SITE_ID, kind: "entity", id: "ses0" }]);
    const pulse = (n: number) =>
      queueMicrotask(() => {
        events.push(`reaction-${n}`);
        if (n < 12) pulse(n + 1);
      });
    pulse(1);
    await result;
    events.push("resolved");
    expect(events).toEqual([
      "returned",
      "executor",
      "release",
      "reaction-1",
      "reaction-2",
      "canonical-builder",
      "create-preparation",
      ...Array.from({ length: 10 }, (_, n) => `reaction-${n + 3}`),
      "resolved",
    ]);
    expect(register).not.toHaveBeenCalled();
    expect(f.trace.preparedSql).toHaveLength(1);
    expect(stage).toHaveBeenCalledTimes(2);
    expect(legacy).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledTimes(1);
  } finally {
    f.database.close();
  }
});
