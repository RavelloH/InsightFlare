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
  type FilterDocument,
  prepareScopedQuery,
  scopedFilterMetadata,
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
import * as reports from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as preparation from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as whole from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-executor";
import { bindWholeOriginalReader } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";
const payload = 'first(event.payload("/amount")) gt 0';
const sequence =
  'sequence([window(page { page.path neq "/excluded" },@range.start,[0ms,604799999ms]),window(event { event.name eq "qualifier" },@range.start,[0ms,604799999ms])]) exists';
// Complete original registry DTOs captured before the transport migration.
const expectedPayload = {
  value: {
    interval: "day",
    series: [
      {
        key: "qualifier",
        eventName: "qualifier",
        label: "qualifier",
        events: 6,
        sessions: 5,
        visitors: 3,
      },
      {
        key: "other",
        eventName: "Other",
        label: "Other",
        events: 3,
        sessions: 3,
        visitors: 3,
        isOther: true,
      },
    ],
    data: [
      {
        bucket: 0,
        timestampMs: 1699920000000,
        totalEvents: 1,
        eventsBySeries: { other: 1 },
      },
      {
        bucket: 1,
        timestampMs: 1700006400000,
        totalEvents: 1,
        eventsBySeries: { qualifier: 1 },
      },
      {
        bucket: 2,
        timestampMs: 1700092800000,
        totalEvents: 0,
        eventsBySeries: {},
      },
      {
        bucket: 3,
        timestampMs: 1700179200000,
        totalEvents: 3,
        eventsBySeries: { other: 1, qualifier: 2 },
      },
      {
        bucket: 4,
        timestampMs: 1700265600000,
        totalEvents: 2,
        eventsBySeries: { qualifier: 2 },
      },
      {
        bucket: 5,
        timestampMs: 1700352000000,
        totalEvents: 0,
        eventsBySeries: {},
      },
      {
        bucket: 6,
        timestampMs: 1700438400000,
        totalEvents: 2,
        eventsBySeries: { other: 1, qualifier: 1 },
      },
      {
        bucket: 7,
        timestampMs: 1700524800000,
        totalEvents: 0,
        eventsBySeries: {},
      },
    ],
  },
};
const expectedSequence = {
  value: {
    interval: "day",
    series: [
      {
        key: "qualifier",
        eventName: "qualifier",
        label: "qualifier",
        events: 6,
        sessions: 5,
        visitors: 3,
      },
      {
        key: "other",
        eventName: "Other",
        label: "Other",
        events: 4,
        sessions: 4,
        visitors: 3,
        isOther: true,
      },
    ],
    data: [
      {
        bucket: 0,
        timestampMs: 1699920000000,
        totalEvents: 1,
        eventsBySeries: { other: 1 },
      },
      {
        bucket: 1,
        timestampMs: 1700006400000,
        totalEvents: 1,
        eventsBySeries: { qualifier: 1 },
      },
      {
        bucket: 2,
        timestampMs: 1700092800000,
        totalEvents: 1,
        eventsBySeries: { other: 1 },
      },
      {
        bucket: 3,
        timestampMs: 1700179200000,
        totalEvents: 3,
        eventsBySeries: { other: 1, qualifier: 2 },
      },
      {
        bucket: 4,
        timestampMs: 1700265600000,
        totalEvents: 2,
        eventsBySeries: { qualifier: 2 },
      },
      {
        bucket: 5,
        timestampMs: 1700352000000,
        totalEvents: 0,
        eventsBySeries: {},
      },
      {
        bucket: 6,
        timestampMs: 1700438400000,
        totalEvents: 2,
        eventsBySeries: { other: 1, qualifier: 1 },
      },
      {
        bucket: 7,
        timestampMs: 1700524800000,
        totalEvents: 0,
        eventsBySeries: {},
      },
    ],
  },
};
const original = {
  "api/event/payload/other": {
    value: expectedPayload,
    sqlCount: 6,
    sqlFingerprint:
      "87e68b57e3efbadcf82655cd28b38146c3e4d8cb9250014b433c60c15ab80c04",
    coreCalls: 1,
    strategies: ["bounded-core"],
  },
  "api/event/same-id": {
    value: expectedPayload,
    sqlCount: 6,
    sqlFingerprint:
      "ea9a34072964ab68e417e9bb7f44c1d4de8a7eea672f4dffbda9a3dc5cd3d282",
    coreCalls: 1,
    strategies: ["bounded-core"],
  },
  "api/visitor/sequence": {
    value: expectedSequence,
    sqlCount: 5,
    sqlFingerprint:
      "650bd674cf425cedf48becb649afab3b1af9444df1ad21e7e1150afd1780e824",
    coreCalls: 0,
    strategies: ["sql-membership"],
  },
  "api/event/series-root-null": {
    value: expectedPayload,
    sqlCount: 6,
    sqlFingerprint:
      "87e68b57e3efbadcf82655cd28b38146c3e4d8cb9250014b433c60c15ab80c04",
    coreCalls: 1,
    strategies: ["bounded-core"],
  },
  "api/event/points-original-error": {
    value: null,
    sqlCount: 5,
    sqlFingerprint:
      "373d6808930ec96d3ba5676cec2bb584db5a126ce2d21b8b95ff60a6f5f67720",
    coreCalls: 1,
    strategies: ["bounded-core"],
  },
};
const samples = [
  { key: "api/event/payload/other", scope: "event", mode: "normal" },
  { key: "api/event/same-id", scope: "event", mode: "same-id" },
  { key: "api/visitor/sequence", scope: "visitor", mode: "sequence" },
  { key: "api/event/series-root-null", scope: "event", mode: "null-root" },
  {
    key: "api/event/points-original-error",
    scope: "event",
    mode: "points-error",
  },
] as const;
for (const sample of samples)
  it(`${sample.key} reuses finite serial completion`, async () => {
    const database = createMigratedDatabase();
    for (const sql of buildJourneyEventFieldsCostFixture(24).seed)
      database.exec(sql);
    if (sample.mode === "same-id") {
      database.exec(
        "UPDATE custom_events SET event_id=visit_id WHERE event_name_id=1",
      );
      expect(
        (
          database
            .prepare(
              "SELECT count(*) AS n FROM custom_events e JOIN visits v ON e.event_id=v.visit_id",
            )
            .get() as { n: number }
        ).n,
      ).toBeGreaterThan(0);
    }
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const diagnostics = createD1ReadDiagnostics();
    const registry = createD1SiteProviderRegistry({
      env: {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: "w84-original-secret",
      } as Env,
      siteId: SEED_SITE_ID,
      diagnostics,
    });
    let owner: { filters: FilterDocument } | undefined;
    registry.useMiddleware(async (_operation, input, next) => {
      owner = input as typeof owner;
      return next(input);
    });
    const request = prepareScopedQuery("event-trend", {
      context: siteQueryContext(SEED_SITE_ID, "api-v1"),
      scopePreference: sample.scope,
      time: createQueryTime(
        SEED_BASE_MS,
        SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
        "UTC",
        SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
      ),
      filters: parseFilterDsl(
        sample.mode === "sequence" ? sequence : payload,
        analyticsFilterRegistry,
      ),
      interval: "day" as const,
      limit: 1,
    });
    const marker = new Error("original-trend-points-error"),
      reactions: string[] = [];
    const actual = reports.queryAnalyticsReportOutputRowsFromD1;
    const read = vi
      .spyOn(reports, "queryAnalyticsReportOutputRowsFromD1")
      .mockImplementation((...args) => {
        const pending = actual(...args);
        reactions.push(args[2]);
        if (sample.mode === "null-root" && args[2] === "event-trend-series")
          void pending.then(() => {
            Reflect.set(owner!.filters, "root", null);
            reactions.push("root-null-after-series");
          });
        if (sample.mode === "points-error" && args[2] === "event-trend-points")
          return pending.then(() => {
            reactions.push("original-error");
            throw marker;
          });
        return pending;
      });
    const register = vi.spyOn(bridge, "registerPreparedMembership"),
      resolve = vi.spyOn(bridge, "resolvePreparedMembership"),
      execute = vi.spyOn(stage, "executeAnalyticsLogicalStage"),
      old = vi.spyOn(whole, "evaluateWholeFilterMembership"),
      evaluate = vi.spyOn(core, "evaluateFilterDocument"),
      create = vi.spyOn(preparation, "createPageVisitQualificationPreparation"),
      bind = vi.spyOn(preparation, "bindPageVisitQualificationPreparation");
    const before = database.prepare("SELECT total_changes() AS writes").get();
    try {
      const pending = registry.resolve("event-trend")!.execute(request);
      pending.then(
        () => reactions.push("resolved"),
        () => reactions.push("rejected"),
      );
      const baseline = original[sample.key];
      if (sample.mode === "points-error")
        await expect(pending).rejects.toBe(marker);
      else expect(await pending).toEqual(baseline.value);
      expect(trace.preparedSql).toHaveLength(baseline.sqlCount);
      expect(
        createHash("sha256")
          .update(JSON.stringify([trace.preparedSql, trace.bindings]))
          .digest("hex"),
      ).toBe(baseline.sqlFingerprint);
      expect(
        diagnostics.advancedFilterExecutionHistory?.map((row) => row.strategy),
      ).toEqual(baseline.strategies);
      expect(evaluate).toHaveBeenCalledTimes(baseline.coreCalls);
      expect(register).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(old).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(bind).toHaveBeenCalledTimes(
        sample.mode === "points-error" ? 2 : 3,
      );
      expect(create.mock.calls[0]![0]).toMatchObject({
        siteId: SEED_SITE_ID,
        maxBindings: 3,
        maxSourcesPerRole: 1,
        qualificationSemantics: "whole-original",
        dependencyRef:
          sample.scope === "event"
            ? EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY
            : EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
      });
      expect(
        bind.mock.calls.every(
          ([input]) => input.preparation === create.mock.results[0]!.value,
        ),
      ).toBe(true);
      expect(
        bind.mock.calls.map(([input]) => input.plan.outputs.map((o) => o.id)),
      ).toEqual(
        sample.mode === "points-error"
          ? [["event-trend-series"], ["event-trend-points"]]
          : [
              ["event-trend-series"],
              ["event-trend-points"],
              ["event-trend-other"],
            ],
      );
      for (const [input] of bind.mock.calls)
        expect(
          input.plan.nodes
            .filter((n) => n.kind === "source")
            .map((n) => ({
              entity: n.entity,
              refs: n.selection?.qualificationDependencyRefs,
            })),
        ).toEqual([
          {
            entity: "event",
            refs: [
              sample.scope === "event"
                ? EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY
                : EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
            ],
          },
        ]);
      expect(reactions).toEqual(
        sample.mode === "points-error"
          ? [
              "event-trend-series",
              "event-trend-points",
              "original-error",
              "rejected",
            ]
          : sample.mode === "null-root"
            ? [
                "event-trend-series",
                "root-null-after-series",
                "event-trend-points",
                "event-trend-other",
                "resolved",
              ]
            : [
                "event-trend-series",
                "event-trend-points",
                "event-trend-other",
                "resolved",
              ],
      );
      const metadata = scopedFilterMetadata(owner!.filters)!;
      expect(
        bindWholeOriginalReader({
          owner: { ...owner },
          consumer: {
            kind: "event-trend",
            configuration: { interval: "day", limit: 1 },
            stage: { kind: "series" },
          },
          siteId: SEED_SITE_ID,
          filters: owner!.filters,
          queryTime: metadata.time,
          scopePlan: metadata.plan,
          readerQueryTime: metadata.time,
        }),
      ).toBeUndefined();
      expect(() =>
        bindWholeOriginalReader({
          owner: owner!,
          consumer: {
            kind: "event-trend",
            configuration: { interval: "day", limit: 1 },
            stage: { kind: "series" },
          },
          siteId: SEED_SITE_ID,
          filters: owner!.filters,
          queryTime: metadata.time,
          scopePlan: metadata.plan,
          readerQueryTime: metadata.time,
        }),
      ).toThrow("event_trend_whole_reader_stage_mismatch");
      expect(create).toHaveBeenCalledTimes(1);
      expect(
        database.prepare("SELECT total_changes() AS writes").get(),
      ).toEqual(before);
    } finally {
      read.mockRestore();
      register.mockRestore();
      resolve.mockRestore();
      execute.mockRestore();
      old.mockRestore();
      evaluate.mockRestore();
      create.mockRestore();
      bind.mockRestore();
      database.close();
    }
  });

it("real scoped empty filter range retains the finite two-report terminal schedule", async () => {
  const database = createMigratedDatabase();
  for (const sql of buildJourneyEventFieldsCostFixture(24).seed)
    database.exec(sql);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const request = prepareScopedQuery("event-trend", {
    context: siteQueryContext(SEED_SITE_ID, "api-v1"),
    scopePreference: "session",
    time: createQueryTime(
      SEED_BASE_MS,
      SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
      "UTC",
      SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
    ),
    filters: parseFilterDsl(
      payload + " AND time gte @range.end AND time lt @range.end",
      analyticsFilterRegistry,
    ),
    interval: "day" as const,
    limit: 1,
  });
  expect(scopedFilterMetadata(request.filters)?.time?.filterRangeEmpty).toBe(
    true,
  );
  expect(scopedFilterMetadata(request.filters)?.plan).toMatchObject({
    mode: "entity",
    scope: "session",
  });
  const register = vi.spyOn(bridge, "registerPreparedMembership"),
    resolve = vi.spyOn(bridge, "resolvePreparedMembership"),
    execute = vi.spyOn(stage, "executeAnalyticsLogicalStage"),
    evaluate = vi.spyOn(core, "evaluateFilterDocument"),
    create = vi.spyOn(preparation, "createPageVisitQualificationPreparation"),
    bind = vi.spyOn(preparation, "bindPageVisitQualificationPreparation");
  const before = database.prepare("SELECT total_changes() AS writes").get();
  try {
    const registry = createD1SiteProviderRegistry({
      env: {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET: "w84-original-secret",
      } as Env,
      siteId: SEED_SITE_ID,
    });
    expect(await registry.resolve("event-trend")!.execute(request)).toEqual({
      value: {
        interval: "day",
        series: [],
        data: [
          {
            bucket: 0,
            timestampMs: 1699920000000,
            totalEvents: 0,
            eventsBySeries: {},
          },
          {
            bucket: 1,
            timestampMs: 1700006400000,
            totalEvents: 0,
            eventsBySeries: {},
          },
          {
            bucket: 2,
            timestampMs: 1700092800000,
            totalEvents: 0,
            eventsBySeries: {},
          },
          {
            bucket: 3,
            timestampMs: 1700179200000,
            totalEvents: 0,
            eventsBySeries: {},
          },
          {
            bucket: 4,
            timestampMs: 1700265600000,
            totalEvents: 0,
            eventsBySeries: {},
          },
          {
            bucket: 5,
            timestampMs: 1700352000000,
            totalEvents: 0,
            eventsBySeries: {},
          },
          {
            bucket: 6,
            timestampMs: 1700438400000,
            totalEvents: 0,
            eventsBySeries: {},
          },
          {
            bucket: 7,
            timestampMs: 1700524800000,
            totalEvents: 0,
            eventsBySeries: {},
          },
        ],
      },
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({
      maxBindings: 3,
      maxSourcesPerRole: 1,
      dependencyRef: "event-filter-entity-membership-v1",
      qualificationSemantics: "whole-original",
      scopePlan: { mode: "entity", scope: "session" },
    });
    expect(bind).toHaveBeenCalledTimes(2);
    expect(trace.preparedSql).toHaveLength(2);
    expect(
      bind.mock.calls.map(([input]) => input.plan.outputs.map((o) => o.id)),
    ).toEqual([["event-trend-series"], ["event-trend-points"]]);
    expect(database.prepare("SELECT total_changes() AS writes").get()).toEqual(
      before,
    );
  } finally {
    register.mockRestore();
    resolve.mockRestore();
    execute.mockRestore();
    evaluate.mockRestore();
    create.mockRestore();
    bind.mockRestore();
    database.close();
  }
});
