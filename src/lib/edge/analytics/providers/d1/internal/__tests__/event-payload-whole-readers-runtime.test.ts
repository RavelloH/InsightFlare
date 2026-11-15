import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as source from "@/lib/edge/analytics/engine/event-payload-report-source";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as report from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import {
  queryEventFieldsPageFromD1,
  queryEventFieldValuesPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-fields";
import * as fieldsReader from "@/lib/edge/analytics/providers/d1/internal/events-fields";
import { queryEventRecordPageFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-records";
import * as prep from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import { bindWholeOriginalReader } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import type { Env } from "@/lib/edge/types";
import type { FilterDocument } from "@/lib/filter-contract";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";
const time = createQueryTime(
  SEED_BASE_MS,
  SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);
const window = {
  startMs: time.range.startMs,
  endExclusiveMs: time.range.endExclusiveMs,
  nowMs: time.capturedAtMs,
  timeZone: "UTC",
};
const dsl =
  'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"';
function fixture() {
  const database = createMigratedDatabase();
  for (const sql of buildJourneyEventFieldsCostFixture(24).seed)
    database.exec(sql);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "w34-local-slots",
  } as unknown as Env;
  return { database, trace, env };
}
for (const scope of ["session", "visitor"] as const)
  it(`${scope}: validates unknown values before empty without minting a slot; one valid read consumes the existing slot`, async () => {
    const f = fixture(),
      create = vi.spyOn(prep, "createPageVisitQualificationPreparation"),
      build = vi.spyOn(source, "buildEventPayloadReportSource");
    let owner: { filters: FilterDocument } | undefined;
    try {
      const registry = createD1SiteProviderRegistry({
        env: f.env,
        siteId: SEED_SITE_ID,
      });
      registry.useMiddleware(async (_op, input, next) => {
        owner = input as { filters: FilterDocument };
        return next(input);
      });
      const result = await registry.resolve("event-field-values")!.execute(
        prepareScopedQuery("event-field-values", {
          context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
          time,
          filters: parseFilterDsl(dsl, analyticsFilterRegistry),
          scopePreference: scope,
          limit: 1,
          fieldPath: "/plan",
          fieldValueType: "unknown",
        }),
      );
      expect(result.value.data.items).toEqual([]);
      expect(build).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();
      const filters = owner!.filters,
        metadata = scopedFilterMetadata(filters)!;
      expect(metadata).toBeDefined();
      const input = {
        owner: owner!,
        siteId: SEED_SITE_ID,
        filters,
        queryTime: metadata.time!,
        readerQueryTime: time,
        scopePlan: metadata.plan,
        consumer: {
          kind: "event-field-values" as const,
          configuration: { fieldPath: "/plan", valueTypeCode: null, limit: 1 },
        },
      };
      expect(
        bindWholeOriginalReader({ ...input, owner: { ...owner! } }),
      ).toBeUndefined();
      expect(() =>
        bindWholeOriginalReader({
          ...input,
          consumer: { kind: "event-fields", configuration: { limit: 1 } },
        }),
      ).toThrow("whole_filter_reader_consumer_mismatch");
      const copiedFilters = attachScopedFilterMetadata(
        { ...filters },
        metadata,
      );
      expect(() =>
        bindWholeOriginalReader({ ...input, filters: copiedFilters }),
      ).toThrow("qualification_execution_plan_snapshot_mismatch");
      expect(() =>
        bindWholeOriginalReader({ ...input, queryTime: { ...metadata.time! } }),
      ).toThrow("qualification_execution_plan_snapshot_mismatch");
      expect(create).not.toHaveBeenCalled();
      const marker = new Error("canonical-source-first");
      build.mockImplementationOnce(() => {
        throw marker;
      });
      await expect(
        queryEventFieldValuesPageFromD1(
          f.env,
          SEED_SITE_ID,
          window,
          filters,
          undefined,
          "/plan",
          "unknown",
          1,
          undefined,
          undefined,
          "private-dashboard",
          owner,
        ),
      ).rejects.toBe(marker);
      expect(create).not.toHaveBeenCalled();
      const value = await queryEventFieldValuesPageFromD1(
        f.env,
        SEED_SITE_ID,
        window,
        filters,
        undefined,
        "/plan",
        "string",
        1,
        undefined,
        undefined,
        "private-dashboard",
        owner,
      );
      expect(value.items.length).toBe(1);
      expect(create).toHaveBeenCalledTimes(1);
      await expect(
        queryEventFieldValuesPageFromD1(
          f.env,
          SEED_SITE_ID,
          window,
          filters,
          undefined,
          "/plan",
          "string",
          1,
          undefined,
          undefined,
          "private-dashboard",
          owner,
        ),
      ).rejects.toThrow("qualification_execution_preparation_replayed");
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      create.mockRestore();
      build.mockRestore();
      f.database.close();
    }
  });
it("retains omitted report arguments for ordinary fields, values and records", async () => {
  const f = fixture(),
    read = vi.spyOn(report, "queryAnalyticsReportOutputRowsFromD1");
  const filters = parseFilterDsl("", analyticsFilterRegistry);
  try {
    await queryEventFieldsPageFromD1(
      f.env,
      SEED_SITE_ID,
      window,
      filters,
      undefined,
      1,
    );
    expect(read.mock.calls[0]).toHaveLength(3);
    read.mockClear();
    await queryEventFieldValuesPageFromD1(
      f.env,
      SEED_SITE_ID,
      window,
      filters,
      undefined,
      "/plan",
      "string",
      1,
    );
    expect(read.mock.calls[0]).toHaveLength(3);
    read.mockClear();
    await queryEventRecordPageFromD1(f.env, SEED_SITE_ID, window, filters, {
      limit: 1,
      sort: { key: "occurredAt", direction: "desc" },
    });
    expect(read.mock.calls[0]).toHaveLength(6);
  } finally {
    read.mockRestore();
    f.database.close();
  }
});

for (const scope of ["session", "visitor"] as const)
  for (const operation of [
    "event-fields",
    "event-field-values",
    "event-records",
  ] as const) {
    it(`${scope} ${operation}: retains whole-result rows across successful null/native Core mutation`, async () => {
      const f = fixture(),
        register = vi.spyOn(bridge, "registerPreparedMembership"),
        actual = core.evaluateFilterDocument;
      let currentFilters: FilterDocument;
      const execute = () => {
        const q = prepareScopedQuery(operation, {
          context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
          time,
          filters: parseFilterDsl(dsl, analyticsFilterRegistry),
          scopePreference: scope,
          limit: 1,
          fieldPath: "/plan",
          fieldValueType: "string",
        });
        currentFilters = q.filters;
        return createD1SiteProviderRegistry({
          env: f.env,
          siteId: SEED_SITE_ID,
        })
          .resolve(operation)!
          .execute(q);
      };
      try {
        const control = await execute();
        for (const mutation of ["null", "native"] as const) {
          const evaluate = vi
            .spyOn(core, "evaluateFilterDocument")
            .mockImplementation((...args) => {
              const value = actual(...args);
              Object.assign(currentFilters, {
                root:
                  mutation === "null"
                    ? null
                    : parseFilterDsl(
                        'page.path eq "/excluded"',
                        analyticsFilterRegistry,
                      ).root,
              });
              return value;
            });
          try {
            const value = await execute();
            const rows = (x: unknown) => {
              const v = Reflect.get(x as object, "value");
              return Reflect.get(v, "data")?.items ?? Reflect.get(v, "items");
            };
            expect(rows(value)).toEqual(rows(control));
            expect(evaluate).toHaveBeenCalledTimes(1);
          } finally {
            evaluate.mockRestore();
          }
        }
        expect(register).not.toHaveBeenCalled();
      } finally {
        register.mockRestore();
        f.database.close();
      }
    });
    it(`${scope} ${operation}: preserves original Core Error over abort, mutation and bad cursor`, async () => {
      const f = fixture(),
        marker = new Error("whole-original-Core-identity"),
        abort = new AbortController(),
        read = vi.spyOn(report, "queryAnalyticsReportOutputRowsFromD1");
      const q = prepareScopedQuery(operation, {
        context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
        time,
        filters: parseFilterDsl(dsl, analyticsFilterRegistry),
        scopePreference: scope,
        limit: 1,
        fieldPath: "/plan",
        fieldValueType: "string",
        cursor: "invalid",
        page: { limit: 1, cursor: "invalid" },
      });
      const evaluate = vi
        .spyOn(core, "evaluateFilterDocument")
        .mockImplementation(() => {
          Object.assign(scopedFilterMetadata(q.filters)!.plan, {
            scope: scope === "session" ? "visitor" : "session",
          });
          abort.abort();
          throw marker;
        });
      try {
        await expect(
          createD1SiteProviderRegistry({ env: f.env, siteId: SEED_SITE_ID })
            .resolve(operation)!
            .execute(q, { signal: abort.signal }),
        ).rejects.toBe(marker);
        expect(evaluate).toHaveBeenCalledTimes(1);
        expect(read).not.toHaveBeenCalled();
      } finally {
        evaluate.mockRestore();
        read.mockRestore();
        f.database.close();
      }
    });
  }
for (const operation of ["event-fields", "event-field-values"] as const)
  it(`${operation}: uses filters captured before its original decoder await`, async () => {
    const f = fixture(),
      register = vi.spyOn(bridge, "registerPreparedMembership");
    let owner: object | undefined;
    const request = () =>
      prepareScopedQuery(operation, {
        context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
        time,
        filters: parseFilterDsl(dsl, analyticsFilterRegistry),
        scopePreference: "session",
        limit: 1,
        fieldPath: "/plan",
        fieldValueType: "string",
      });
    try {
      const control = await createD1SiteProviderRegistry({
        env: f.env,
        siteId: SEED_SITE_ID,
      })
        .resolve(operation)!
        .execute(request());
      const start = f.trace.preparedSql.length;
      const registry = createD1SiteProviderRegistry({
        env: f.env,
        siteId: SEED_SITE_ID,
      });
      registry.useMiddleware(async (_operation, input, next) => {
        owner = input as object;
        return next(input);
      });
      const originalField = fieldsReader.decodeEventFieldCursor,
        originalValue = fieldsReader.decodeEventFieldValueCursor;
      const decode =
        operation === "event-fields"
          ? vi
              .spyOn(fieldsReader, "decodeEventFieldCursor")
              .mockImplementation(async (...args) => {
                const value = await originalField(...args);
                Object.assign(owner!, {
                  filters: JSON.parse(JSON.stringify(args[3])),
                });
                return value;
              })
          : vi
              .spyOn(fieldsReader, "decodeEventFieldValueCursor")
              .mockImplementation(async (...args) => {
                const value = await originalValue(...args);
                Object.assign(owner!, {
                  filters: JSON.parse(JSON.stringify(args[3])),
                });
                return value;
              });
      try {
        expect(await registry.resolve(operation)!.execute(request())).toEqual(
          control,
        );
        expect(f.trace.preparedSql.slice(start)).toEqual(
          f.trace.preparedSql.slice(0, start),
        );
        expect(f.trace.bindings.slice(start)).toEqual(
          f.trace.bindings.slice(0, start),
        );
        expect(register).not.toHaveBeenCalled();
      } finally {
        decode.mockRestore();
      }
    } finally {
      register.mockRestore();
      f.database.close();
    }
  });
