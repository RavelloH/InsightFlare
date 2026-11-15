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
import {
  EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
} from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as stage from "@/lib/edge/analytics/providers/d1/internal/analytics-logical-staged-runtime";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as preparation from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as whole from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-executor";
import * as projection from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-projection";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";

const payload = 'first(event.payload("/amount")) gt 0';
const sequence =
  'sequence([window(page { page.path neq "/excluded" },@range.start,[0ms,604799999ms]),window(event { event.name eq "qualifier" },@range.start,[0ms,604799999ms])]) exists';

const expected = {
  "session/api-v1/payload": {
    value: {
      value: {
        summary: {
          events: 9,
          eventTypes: 2,
          sessions: 5,
          visitors: 3,
          avgEventsPerSession: 1.8,
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
                views: 3,
                sessions: 3,
                visitors: 3,
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
                views: 9,
                sessions: 5,
                visitors: 3,
              },
            ],
          },
        },
      },
    },
    orderedSqlFingerprint:
      "5123955e8ceaa29a7ec3fef20196dcf263500158e5106a824d21ae6a30261a93",
    sqlCount: 4,
    coreCalls: 1,
    strategies: ["bounded-core"],
  },
  "visitor/api-v1/payload": {
    value: {
      value: {
        summary: {
          events: 10,
          eventTypes: 2,
          sessions: 6,
          visitors: 3,
          avgEventsPerSession: 1.6666666666666667,
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
                views: 4,
                sessions: 4,
                visitors: 3,
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
                views: 10,
                sessions: 6,
                visitors: 3,
              },
            ],
          },
        },
      },
    },
    orderedSqlFingerprint:
      "2a8d88313b2596686a36e1f6a2f7bfd153580ef818e34c1de27da398a72ff089",
    sqlCount: 4,
    coreCalls: 1,
    strategies: ["bounded-core"],
  },
  "event/private-dashboard/payload": {
    value: {
      value: {
        summary: {
          events: 9,
          eventTypes: 2,
          sessions: 5,
          visitors: 3,
          avgEventsPerSession: 1.8,
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
                views: 3,
                sessions: 3,
                visitors: 3,
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
                views: 9,
                sessions: 5,
                visitors: 3,
              },
            ],
          },
        },
      },
    },
    orderedSqlFingerprint:
      "f1402b87517a47d524a7624c412838e11eb92185307dd3b8f72dbf5470f5f546",
    sqlCount: 4,
    coreCalls: 1,
    strategies: ["bounded-core"],
  },
  "event/api-v1/payload": {
    value: {
      value: {
        summary: {
          events: 9,
          eventTypes: 2,
          sessions: 5,
          visitors: 3,
          avgEventsPerSession: 1.8,
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
                views: 3,
                sessions: 3,
                visitors: 3,
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
                views: 9,
                sessions: 5,
                visitors: 3,
              },
            ],
          },
        },
      },
    },
    orderedSqlFingerprint:
      "f1402b87517a47d524a7624c412838e11eb92185307dd3b8f72dbf5470f5f546",
    sqlCount: 4,
    coreCalls: 1,
    strategies: ["bounded-core"],
  },
  "event/private-dashboard/same-id": {
    value: {
      value: {
        summary: {
          events: 9,
          eventTypes: 2,
          sessions: 5,
          visitors: 3,
          avgEventsPerSession: 1.8,
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
                views: 3,
                sessions: 3,
                visitors: 3,
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
                views: 9,
                sessions: 5,
                visitors: 3,
              },
            ],
          },
        },
      },
    },
    orderedSqlFingerprint:
      "5854436ddfa5410b49e0e1ff62d7f90fd11e2282f1d8b1aacf9d7dadacd3acda",
    sqlCount: 4,
    coreCalls: 1,
    strategies: ["bounded-core"],
  },
} as const;

const samples = [
  {
    key: "session/api-v1/payload",
    scope: "session",
    audience: "api-v1",
    sample: "payload",
  },
  {
    key: "visitor/api-v1/payload",
    scope: "visitor",
    audience: "api-v1",
    sample: "payload",
  },
  {
    key: "event/private-dashboard/payload",
    scope: "event",
    audience: "private-dashboard",
    sample: "payload",
  },
  {
    key: "event/api-v1/payload",
    scope: "event",
    audience: "api-v1",
    sample: "payload",
  },
  {
    key: "event/private-dashboard/same-id",
    scope: "event",
    audience: "private-dashboard",
    sample: "same-id",
  },
] as const;
for (const sample of samples)
  it(`${sample.scope}/${sample.audience}/${sample.sample}: binds the completed original qualification without an ID`, async () => {
    const database = createMigratedDatabase();
    for (const sql of buildJourneyEventFieldsCostFixture(24).seed)
      database.exec(sql);
    if (sample.sample === "same-id")
      database.exec(
        "UPDATE custom_events SET event_id=visit_id WHERE event_name_id=1",
      );
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const DB = createSqliteD1Database(database, trace);
    const time = createQueryTime(
      SEED_BASE_MS,
      SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
      "UTC",
      SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
    );
    const request = prepareScopedQuery("event-summary", {
      context: siteQueryContext(SEED_SITE_ID, sample.audience),
      time,
      scopePreference: sample.scope,
      filters: parseFilterDsl(
        sample.sample === "same-id"
          ? 'page.path eq "/qualifier" or first(event.payload("/amount")) gt 0'
          : payload,
        analyticsFilterRegistry,
      ),
    });
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: { DB, MAIN_SECRET: "w84-original-secret" } as Env,
      siteId: SEED_SITE_ID,
      diagnostics,
    }).resolve("event-summary");
    if (!provider) throw Error("missing-summary-provider");
    const baseline = expected[sample.key];
    const register = vi.spyOn(bridge, "registerPreparedMembership"),
      resolve = vi.spyOn(bridge, "resolvePreparedMembership");
    const execute = vi.spyOn(stage, "executeAnalyticsLogicalStage"),
      old = vi.spyOn(whole, "evaluateWholeFilterMembership"),
      evaluate = vi.spyOn(core, "evaluateFilterDocument");
    const project = vi.spyOn(projection, "projectWholeOriginalMembership"),
      create = vi.spyOn(preparation, "createPageVisitQualificationPreparation"),
      bind = vi.spyOn(preparation, "bindPageVisitQualificationPreparation");
    const before = database.prepare("SELECT total_changes() AS writes").get();
    try {
      expect(await provider.execute(request)).toEqual(baseline.value);
      expect(
        createHash("sha256")
          .update(JSON.stringify([trace.preparedSql, trace.bindings]))
          .digest("hex"),
      ).toBe(baseline.orderedSqlFingerprint);
      expect(trace.preparedSql).toHaveLength(baseline.sqlCount);
      expect(
        diagnostics.advancedFilterExecutionHistory?.map((row) => row.strategy),
      ).toEqual(baseline.strategies);
      expect(evaluate).toHaveBeenCalledTimes(baseline.coreCalls);
      expect(old).toHaveBeenCalledTimes(0);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(register).toHaveBeenCalledTimes(0);
      expect(resolve).toHaveBeenCalledTimes(0);
      expect(project).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(bind).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0]![0]).toMatchObject({
        siteId: SEED_SITE_ID,
        maxBindings: 1,
        maxSourcesPerRole: 1,
        qualificationSemantics: "whole-original",
        dependencyRef:
          sample.scope === "event"
            ? EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY
            : EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
      });
      expect(
        bind.mock.calls[0]![0].plan.nodes.filter(
          (node) => node.kind === "source",
        ).map((node) => node.entity),
      ).toEqual(["event"]);
      expect(bind.mock.calls[0]![0].plan.outputs).toHaveLength(5);
      if (sample.sample === "same-id") {
        const matches = project.mock.calls[0]![0].matches;
        expect(project.mock.calls[0]![0].mode).toBe("observation");
        expect(matches.some((match) => match.kind === "entity")).toBe(false);
        const visits = new Set(
          matches
            .filter((match) => match.kind === "visit")
            .map((match) => match.id),
        );
        const events = new Set(
          matches
            .filter((match) => match.kind === "event")
            .map((match) => match.id),
        );
        expect(
          [...events].filter((id) => visits.has(id)).length,
        ).toBeGreaterThan(0);
        expect(matches.every((match) => match.siteId === SEED_SITE_ID)).toBe(
          true,
        );
      }
      expect(
        database.prepare("SELECT total_changes() AS writes").get(),
      ).toEqual(before);
    } finally {
      register.mockRestore();
      resolve.mockRestore();
      execute.mockRestore();
      old.mockRestore();
      evaluate.mockRestore();
      project.mockRestore();
      create.mockRestore();
      bind.mockRestore();
      database.close();
    }
  });
it("rejects event-scoped sequence at the original request boundary before qualification or storage", () => {
  const execute = vi.spyOn(stage, "executeAnalyticsLogicalStage"),
    evaluate = vi.spyOn(core, "evaluateFilterDocument"),
    register = vi.spyOn(bridge, "registerPreparedMembership"),
    create = vi.spyOn(preparation, "createPageVisitQualificationPreparation");
  try {
    const time = createQueryTime(
      SEED_BASE_MS,
      SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
      "UTC",
      SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
    );
    expect(() =>
      prepareScopedQuery("event-summary", {
        context: siteQueryContext(SEED_SITE_ID, "api-v1"),
        time,
        scopePreference: "event",
        filters: parseFilterDsl(sequence, analyticsFilterRegistry),
      }),
    ).toThrow("Relation expressions require visitor or session scope.");
    expect(execute).toHaveBeenCalledTimes(0);
    expect(evaluate).toHaveBeenCalledTimes(0);
    expect(register).toHaveBeenCalledTimes(0);
    expect(create).toHaveBeenCalledTimes(0);
  } finally {
    execute.mockRestore();
    evaluate.mockRestore();
    register.mockRestore();
    create.mockRestore();
  }
});
