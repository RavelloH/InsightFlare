// @vitest-environment node
import { createHash } from "node:crypto";

import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { EVENT_FILTER_PAGE_VISIT_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as execution from "@/lib/edge/analytics/providers/d1/internal/analytics-logical-staged-runtime";
import * as reports from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { queryEventAnalyticsContextCardsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-context";
import * as preparation from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as whole from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-executor";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";
// Full original provider values and ordered SQL/parameter identities captured
// before this finite transport migration. Public is a provider-only contract,
// not an application/HTTP audience admission.
const cases = {
  "api/session/boundary": {
    scope: "session",
    audience: "api-v1",
    dsl: 'first(event.payload("/amount")) gt 0 OR page.path neq "/excluded"',
    selectedKeys: ["entry", "exit"],
    expected: {
      value: {
        eventName: "qualifier",
        cards: {
          page: {
            path: [],
            query: [],
            title: [],
            hostname: [],
            entry: [
              {
                label: "/qualifier",
                views: 5,
                sessions: 4,
                visitors: 3,
              },
            ],
            exit: [
              {
                label: "/qualifier",
                views: 5,
                sessions: 4,
                visitors: 2,
              },
            ],
          },
          source: {
            domain: [],
            link: [],
          },
          client: {
            browser: [],
            osVersion: [],
            deviceType: [],
            language: [],
            screenSize: [],
          },
          geo: {
            country: [],
            region: [],
            city: [],
            continent: [],
            timezone: [],
            organization: [],
          },
        },
      },
    },
    sqlCount: 4,
    sqlFingerprint:
      "232c9003c8d04b4dcdd2e89609ca2e2d918c23cdb4593eaa10a03b77370e87f1",
    coreCalls: 1,
    sameId: false,
    sentinel: false,
    abortAfterCore: false,
  },
  "api/event/same-id": {
    scope: "event",
    audience: "api-v1",
    dsl: 'first(event.payload("/amount")) gt 0 OR page.path neq "/excluded"',
    selectedKeys: ["path", "entry", "exit"],
    expected: {
      value: {
        eventName: "qualifier",
        cards: {
          page: {
            path: [
              {
                label: "/qualifier",
                views: 6,
                sessions: 5,
                visitors: 3,
              },
            ],
            query: [],
            title: [],
            hostname: [],
            entry: [
              {
                label: "/qualifier",
                views: 5,
                sessions: 4,
                visitors: 3,
              },
            ],
            exit: [
              {
                label: "/qualifier",
                views: 5,
                sessions: 4,
                visitors: 2,
              },
            ],
          },
          source: {
            domain: [],
            link: [],
          },
          client: {
            browser: [],
            osVersion: [],
            deviceType: [],
            language: [],
            screenSize: [],
          },
          geo: {
            country: [],
            region: [],
            city: [],
            continent: [],
            timezone: [],
            organization: [],
          },
        },
      },
    },
    sqlCount: 4,
    sqlFingerprint:
      "b2795052d2ed56ffe123bc17f9ef3f647d7ee21ba8a5c9e990d38a81ad78001e",
    coreCalls: 1,
    sameId: true,
    sentinel: false,
    abortAfterCore: false,
  },
  "public-provider-only/event/boundary": {
    scope: "event",
    audience: "public-share",
    dsl: 'first(event.payload("/amount")) gt 0 OR page.path neq "/excluded"',
    selectedKeys: ["entry", "exit"],
    expected: {
      value: {
        eventName: "qualifier",
        cards: {
          page: {
            path: [],
            query: [],
            title: [],
            hostname: [],
            entry: [
              {
                label: "/qualifier",
                views: 5,
                sessions: 4,
                visitors: 3,
              },
            ],
            exit: [
              {
                label: "/qualifier",
                views: 5,
                sessions: 4,
                visitors: 2,
              },
            ],
          },
          source: {
            domain: [],
            link: [],
          },
          client: {
            browser: [],
            osVersion: [],
            deviceType: [],
            language: [],
            screenSize: [],
          },
          geo: {
            country: [],
            region: [],
            city: [],
            continent: [],
            timezone: [],
            organization: [],
          },
        },
      },
    },
    sqlCount: 4,
    sqlFingerprint:
      "f5a1739a1513af60e0ba97b83da499dbcc2a10becd1c98f0ef79f7454c247476",
    coreCalls: 1,
    sameId: false,
    sentinel: false,
    abortAfterCore: false,
  },
  "api/event/provider-empty-means-default": {
    scope: "event",
    audience: "api-v1",
    dsl: 'first(event.payload("/amount")) gt 0 OR page.path neq "/excluded"',
    selectedKeys: [],
    expected: {
      value: {
        eventName: "qualifier",
        cards: {
          page: {
            path: [
              {
                label: "/qualifier",
                views: 6,
                sessions: 5,
                visitors: 3,
              },
            ],
            query: [],
            title: [],
            hostname: [
              {
                label: "c01.example.invalid",
                views: 6,
                sessions: 5,
                visitors: 3,
              },
            ],
            entry: [
              {
                label: "/qualifier",
                views: 5,
                sessions: 4,
                visitors: 3,
              },
            ],
            exit: [
              {
                label: "/qualifier",
                views: 5,
                sessions: 4,
                visitors: 2,
              },
            ],
          },
          source: {
            domain: [
              {
                label: "",
                views: 3,
                sessions: 3,
                visitors: 1,
              },
            ],
            link: [
              {
                label: "",
                views: 3,
                sessions: 3,
                visitors: 1,
              },
            ],
          },
          client: {
            browser: [
              {
                label: "Firefox",
                views: 2,
                sessions: 2,
                visitors: 2,
              },
            ],
            osVersion: [
              {
                label: "Windows",
                views: 4,
                sessions: 3,
                visitors: 3,
              },
            ],
            deviceType: [
              {
                label: "desktop",
                views: 4,
                sessions: 3,
                visitors: 3,
              },
            ],
            language: [],
            screenSize: [],
          },
          geo: {
            country: [
              {
                value: "BR",
                label: "BR",
                views: 2,
                sessions: 2,
                visitors: 2,
              },
            ],
            region: [
              {
                value: "BR::::",
                label: "BR::::",
                views: 2,
                sessions: 2,
                visitors: 2,
              },
            ],
            city: [
              {
                value: "BR::::::",
                label: "BR::::::",
                views: 2,
                sessions: 2,
                visitors: 2,
              },
            ],
            continent: [],
            timezone: [],
            organization: [],
          },
        },
      },
    },
    sqlCount: 4,
    sqlFingerprint:
      "a8cdf199d3ad7df4163310a7972f9e42e09c1407d2c186786987b7b8250a0625",
    coreCalls: 1,
    sameId: false,
    sentinel: false,
    abortAfterCore: false,
  },
  "api/event/original-Core-error": {
    scope: "event",
    audience: "api-v1",
    dsl: 'first(event.payload("/amount")) gt 0 OR page.path neq "/excluded"',
    selectedKeys: ["entry", "exit"],
    expected: null,
    sqlCount: 3,
    sqlFingerprint:
      "0dd9bf69589a41136b99a0d06ba2d326bc546709cc8ba64801623f5ba0f8b5d4",
    coreCalls: 1,
    sameId: false,
    sentinel: true,
    abortAfterCore: false,
  },
  "api/event/post-Core-abort-preserves-success": {
    scope: "event",
    audience: "api-v1",
    dsl: 'first(event.payload("/amount")) gt 0 OR page.path neq "/excluded"',
    selectedKeys: ["entry", "exit"],
    expected: {
      value: {
        eventName: "qualifier",
        cards: {
          page: {
            path: [],
            query: [],
            title: [],
            hostname: [],
            entry: [
              {
                label: "/qualifier",
                views: 5,
                sessions: 4,
                visitors: 3,
              },
            ],
            exit: [
              {
                label: "/qualifier",
                views: 5,
                sessions: 4,
                visitors: 2,
              },
            ],
          },
          source: {
            domain: [],
            link: [],
          },
          client: {
            browser: [],
            osVersion: [],
            deviceType: [],
            language: [],
            screenSize: [],
          },
          geo: {
            country: [],
            region: [],
            city: [],
            continent: [],
            timezone: [],
            organization: [],
          },
        },
      },
    },
    sqlCount: 4,
    sqlFingerprint:
      "f5a1739a1513af60e0ba97b83da499dbcc2a10becd1c98f0ef79f7454c247476",
    coreCalls: 1,
    sameId: false,
    sentinel: false,
    abortAfterCore: true,
  },
} as const;
function time() {
  return createQueryTime(
    SEED_BASE_MS,
    SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
    "UTC",
    SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
  );
}
async function run(key: keyof typeof cases) {
  const sample = cases[key];
  const database = createMigratedDatabase();
  for (const sql of buildJourneyEventFieldsCostFixture(24).seed)
    database.exec(sql);
  if (sample.sameId) {
    database.exec(
      "UPDATE custom_events SET event_id=visit_id WHERE event_name_id=1",
    );
    expect(
      database
        .prepare(
          "SELECT count(*) AS n FROM custom_events c JOIN visits v ON c.event_id=v.visit_id",
        )
        .get(),
    ).toMatchObject({ n: expect.any(Number) });
  }
  const request = prepareScopedQuery("event-context", {
    context: siteQueryContext(SEED_SITE_ID, sample.audience),
    time: time(),
    scopePreference: sample.scope,
    filters: parseFilterDsl(sample.dsl, analyticsFilterRegistry),
    selectedKeys: [...sample.selectedKeys],
    limit: 1,
    eventName: "qualifier",
  });
  const metadata = scopedFilterMetadata(request.filters);
  if (!metadata) throw Error("missing-original-metadata");
  expect(metadata.plan.mode).toBe(
    sample.scope === "event" ? "observation" : "entity",
  );
  const orderedSql: { sql: string; params: readonly unknown[] }[] = [];
  const adapter = createSqliteD1Database(database);
  const DB = new Proxy(adapter, {
    get(target, key) {
      if (key !== "prepare") {
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const wrap = (
          statement: D1PreparedStatement,
          params: readonly unknown[],
        ): D1PreparedStatement =>
          new Proxy(statement, {
            get(prepared, method) {
              if (method === "bind")
                return (...values: unknown[]) =>
                  wrap(prepared.bind(...values), values);
              if (method === "all")
                return (...args: unknown[]) => {
                  orderedSql.push({ sql, params });
                  return Reflect.apply(prepared.all, prepared, args);
                };
              const value = Reflect.get(prepared, method);
              return typeof value === "function" ? value.bind(prepared) : value;
            },
          });
        return wrap(target.prepare(sql), []);
      };
    },
  });
  const diagnostics = createD1ReadDiagnostics();
  const abort = new AbortController(),
    sentinel = new Error("original-context-Core-error");
  const actualCore = core.evaluateFilterDocument;
  const evaluate = vi
    .spyOn(core, "evaluateFilterDocument")
    .mockImplementation((...args) => {
      if (sample.sentinel) throw sentinel;
      const result = actualCore(...args);
      if (sample.abortAfterCore) abort.abort();
      return result;
    });
  const register = vi.spyOn(bridge, "registerPreparedMembership"),
    resolve = vi.spyOn(bridge, "resolvePreparedMembership"),
    old = vi.spyOn(whole, "evaluateWholeFilterMembership"),
    stage = vi.spyOn(execution, "executeAnalyticsLogicalStage");
  const originalCreate = preparation.createPageVisitQualificationPreparation,
    originalBind = preparation.bindPageVisitQualificationPreparation;
  const create = vi.spyOn(
      preparation,
      "createPageVisitQualificationPreparation",
    ),
    bind = vi.spyOn(preparation, "bindPageVisitQualificationPreparation"),
    read = vi.spyOn(reports, "queryAnalyticsReportOutputRowsFromD1");
  const before = database.prepare("SELECT total_changes() AS writes").get();
  try {
    const provider = createD1SiteProviderRegistry({
      env: { DB, MAIN_SECRET: "context-actual-registry" } as Env,
      siteId: SEED_SITE_ID,
      diagnostics,
    }).resolve("event-context");
    if (!provider) throw Error("missing-event-context-provider");
    const pending = provider.execute(request, { signal: abort.signal });
    if (sample.sentinel) {
      await expect(pending).rejects.toBe(sentinel);
      expect(create).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } else {
      expect(await pending).toEqual(sample.expected);
      expect(read).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(bind).toHaveBeenCalledTimes(1);
      const input = create.mock.calls[0]![0],
        binding = bind.mock.calls[0]![0];
      expect(input).toMatchObject({
        maxBindings: 1,
        maxSourcesPerRole: sample.scope === "event" ? 1 : 2,
        qualificationSemantics: "whole-original",
      });
      expect(binding.preparation).toBe(create.mock.results[0]?.value);
      const sources = binding.plan.nodes.filter(
        (node) => node.kind === "source",
      );
      expect(sources.map((source) => source.entity)).toEqual(["event", "page"]);
      expect(
        sources.map((source) => source.selection?.qualificationDependencyRefs),
      ).toEqual(
        sample.scope === "event"
          ? [
              ["event-filter-event-membership-v1"],
              [EVENT_FILTER_PAGE_VISIT_DEPENDENCY],
            ]
          : [
              ["event-filter-entity-membership-v1"],
              ["event-filter-entity-membership-v1"],
            ],
      );
      expect(
        (input.additionalRelations ?? []).map((role) => role.dependencyRef),
      ).toEqual(
        sample.scope === "event" ? [EVENT_FILTER_PAGE_VISIT_DEPENDENCY] : [],
      );
      if (sample.sameId) {
        expect(
          (
            database
              .prepare(
                "SELECT count(*) AS n FROM custom_events c JOIN visits v ON c.event_id=v.visit_id",
              )
              .get() as { n: number }
          ).n,
        ).toBeGreaterThan(0);
        // Removing only Page authority cannot bind the exact successful dual-role
        // plan; this isolated probe performs no SQL or second production bind.
        const invalid = originalCreate({
          ...input,
          additionalRelations: undefined,
        });
        const count = orderedSql.length;
        expect(() =>
          originalBind({ ...binding, preparation: invalid }),
        ).toThrow("qualification_execution_plan_context_mismatch");
        expect(orderedSql).toHaveLength(count);
      }
      if (sample.abortAfterCore) {
        expect(abort.signal.aborted).toBe(true);
        expect(evaluate).toHaveBeenCalledTimes(1);
      }
    }
    expect(register).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(old).not.toHaveBeenCalled();
    expect(stage).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(sample.coreCalls);
    expect(diagnostics.advancedFilterExecution).toMatchObject({
      strategy: "bounded-core",
      coreBounds: {
        maxActivities: 20000,
        maxSequenceMatches: 50000,
        maxSequenceWork: 1000000,
      },
    });
    expect(orderedSql).toHaveLength(sample.sqlCount);
    expect(
      createHash("sha256").update(JSON.stringify(orderedSql)).digest("hex"),
    ).toBe(sample.sqlFingerprint);
    expect(database.prepare("SELECT total_changes() AS writes").get()).toEqual(
      before,
    );
  } finally {
    evaluate.mockRestore();
    register.mockRestore();
    resolve.mockRestore();
    old.mockRestore();
    stage.mockRestore();
    create.mockRestore();
    bind.mockRestore();
    read.mockRestore();
    database.close();
  }
}
it("API entity payload binds the existing two-Source entity contract", () =>
  run("api/session/boundary"));
it("observation visit/Event identical IDs require their distinct roles", () =>
  run("api/event/same-id"));
it("public provider-only boundary retains the exact existing scalar DTO", () =>
  run("public-provider-only/event/boundary"));
it("provider empty selection means default cards", () =>
  run("api/event/provider-empty-means-default"));
it("retains original Core Error identity and post-Core abort success", async () => {
  await run("api/event/original-Core-error");
  await run("api/event/post-Core-abort-preserves-success");
});
it("low-level empty keys return before owner, preparation, Core or SQL", async () => {
  const database = createMigratedDatabase();
  for (const sql of buildJourneyEventFieldsCostFixture(24).seed)
    database.exec(sql);
  const trace = { preparedSql: [] as string[], bindings: [] };
  const env = {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "context-empty",
  } as Env;
  const create = vi.spyOn(
      preparation,
      "createPageVisitQualificationPreparation",
    ),
    read = vi.spyOn(reports, "queryAnalyticsReportOutputRowsFromD1"),
    evaluate = vi.spyOn(core, "evaluateFilterDocument");
  const t = time(),
    before = database.prepare("SELECT total_changes() AS writes").get();
  try {
    expect(
      await queryEventAnalyticsContextCardsFromD1(
        env,
        SEED_SITE_ID,
        {
          startMs: t.range.startMs,
          endExclusiveMs: t.range.endExclusiveMs,
          nowMs: t.capturedAtMs,
          timeZone: "UTC",
        },
        parseFilterDsl(
          'first(event.payload("/amount")) gt 0',
          analyticsFilterRegistry,
        ),
        1,
        "qualifier",
        [],
        { wholeOriginalOwner: {} },
      ),
    ).toEqual({
      page: {
        path: [],
        query: [],
        title: [],
        hostname: [],
        entry: [],
        exit: [],
      },
      source: { domain: [], link: [] },
      client: {
        browser: [],
        osVersion: [],
        deviceType: [],
        language: [],
        screenSize: [],
      },
      geo: {
        country: [],
        region: [],
        city: [],
        continent: [],
        timezone: [],
        organization: [],
      },
    });
    expect(create).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(trace.preparedSql).toEqual([]);
    expect(database.prepare("SELECT total_changes() AS writes").get()).toEqual(
      before,
    );
  } finally {
    create.mockRestore();
    read.mockRestore();
    evaluate.mockRestore();
    database.close();
  }
});
