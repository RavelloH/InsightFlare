// @vitest-environment node
import { createHash } from "node:crypto";

import { afterEach, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as diagnosticsModule from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as preparation from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as reader from "@/lib/edge/analytics/providers/d1/internal/referrers";
import * as completion from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";

// Full DTO and ordered SQL/parameter fingerprints were observed at the same
// actual registry boundary in the old/new 24-visit comparison. Public samples
// exercise this provider contract only; this does not grant HTTP access.
const samples = [
  {
    key: "api/session/payload",
    audience: "api-v1",
    scope: "session",
    dsl: 'first(event.payload("/amount")) gt 0',
    variant: "summary",
    expected: {
      value: {
        totalViews: 11,
        directViews: 3,
        externalViews: 8,
        uniqueDomains: 4,
        uniqueLinks: 8,
        truncated: true,
        topSources: [
          {
            referrer: "github.com",
            views: 3,
          },
          {
            referrer: "duckduckgo.com",
            views: 2,
          },
        ],
      },
      source: "raw",
    },
    core: 1,
    register: 0,
    resolve: 0,
    sqlCount: 4,
    sqlFingerprint:
      "2ec503236f4dc3e61c00eafdfdfc9c9503b96a1e3c99eb9d731689d0c7717ea7",
    reason: "count_sql_requires_numeric_target",
    lateRoot: false,
    coreError: false,
    ownerChecks: true,
  },
  {
    key: "api/visitor/sequence",
    audience: "api-v1",
    scope: "visitor",
    dsl: 'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"',
    variant: "summary",
    expected: {
      value: {
        totalViews: 26,
        directViews: 7,
        externalViews: 19,
        uniqueDomains: 8,
        uniqueLinks: 19,
        truncated: true,
        topSources: [
          {
            referrer: "duckduckgo.com",
            views: 3,
          },
          {
            referrer: "github.com",
            views: 3,
          },
        ],
      },
      source: "raw",
    },
    core: 1,
    register: 0,
    resolve: 0,
    sqlCount: 3,
    sqlFingerprint:
      "659f29f4a8d3c7344903382e1b8aff8ff549ec8eac483f4d959d6855b5a111dd",
    reason: "sequence_sql_independent_time_domains",
    lateRoot: false,
    coreError: false,
    ownerChecks: false,
  },
  {
    key: "api/session/real-empty",
    audience: "api-v1",
    scope: "session",
    dsl: 'count(event { event.name eq "qualifier" }) gt 0 AND time gte @range.end AND time lt @range.end',
    variant: "summary",
    expected: {
      value: {
        totalViews: 0,
        directViews: 0,
        externalViews: 0,
        uniqueDomains: 0,
        uniqueLinks: 0,
        truncated: false,
        topSources: [],
      },
      source: "raw",
    },
    core: 0,
    register: 0,
    resolve: 0,
    sqlCount: 1,
    sqlFingerprint:
      "29d9efdc892edd4ffc75f3ef9123cf7ae440454e18d91bc9a59f705dce964547",
    reason: undefined,
    lateRoot: false,
    coreError: false,
    ownerChecks: false,
  },
  {
    key: "api/visitor/root-null-after-Core",
    audience: "api-v1",
    scope: "visitor",
    dsl: 'first(event.payload("/amount")) gt 0',
    variant: "summary",
    expected: {
      value: {
        totalViews: 20,
        directViews: 5,
        externalViews: 15,
        uniqueDomains: 8,
        uniqueLinks: 15,
        truncated: true,
        topSources: [
          {
            referrer: "duckduckgo.com",
            views: 3,
          },
          {
            referrer: "github.com",
            views: 3,
          },
        ],
      },
      source: "raw",
    },
    core: 1,
    register: 0,
    resolve: 0,
    sqlCount: 4,
    sqlFingerprint:
      "e887690202ee846793b5318cc0a07c8d3a901b2fc12bb126e093d72bcd648d48",
    reason: "count_sql_requires_numeric_target",
    lateRoot: true,
    coreError: false,
    ownerChecks: false,
  },
  {
    key: "api/session/original-Core-error",
    audience: "api-v1",
    scope: "session",
    dsl: 'first(event.payload("/amount")) gt 0',
    variant: "summary",
    expected: undefined,
    core: 1,
    register: 0,
    resolve: 0,
    sqlCount: 3,
    sqlFingerprint:
      "0dd9bf69589a41136b99a0d06ba2d326bc546709cc8ba64801623f5ba0f8b5d4",
    reason: "count_sql_requires_numeric_target",
    lateRoot: false,
    coreError: true,
    ownerChecks: false,
  },
  {
    key: "public-provider-only/session/unchanged",
    audience: "public-share",
    scope: "session",
    dsl: 'first(event.payload("/amount")) gt 0',
    variant: "summary",
    expected: {
      value: {
        totalViews: 11,
        directViews: 3,
        externalViews: 8,
        uniqueDomains: 4,
        uniqueLinks: 8,
        truncated: true,
        topSources: [
          {
            referrer: "github.com",
            views: 3,
          },
          {
            referrer: "duckduckgo.com",
            views: 2,
          },
        ],
      },
      source: "raw",
    },
    core: 1,
    register: 1,
    resolve: 1,
    sqlCount: 4,
    sqlFingerprint:
      "2ec503236f4dc3e61c00eafdfdfc9c9503b96a1e3c99eb9d731689d0c7717ea7",
    reason: "count_sql_requires_numeric_target",
    lateRoot: false,
    coreError: false,
    ownerChecks: false,
  },
  {
    key: "api/visitor/list-still-original",
    audience: "api-v1",
    scope: "visitor",
    dsl: 'first(event.payload("/amount")) gt 0',
    variant: "list",
    expected: {
      value: {
        items: [
          {
            referrer: "",
            views: 5,
            sessions: 5,
            visitors: 2,
          },
          {
            referrer: "duckduckgo.com",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
        ],
        pagination: {
          limit: 2,
          returned: 2,
          hasMore: true,
          nextCursor:
            "eyJ2IjoxLCJiaW5kaW5nIjoiYTgwZjc0ZGZhNTUyOTVjMWMzMTI5MWY0NDI1ZDJhNzc4MzIyNzY2MzU2MTA2ZTg3OWUzYzBkODJiZmRlMTA2YSIsImtleSI6eyJwcmltYXJ5IjozLCJyZWZlcnJlciI6ImR1Y2tkdWNrZ28uY29tIiwic2Vjb25kYXJ5IjozfX0.tW4MJcG5zBtsNpGJWjSzjUrLbU6T58bvJ8Zw8AcKQ_o",
        },
      },
      source: "raw",
    },
    core: 1,
    register: 1,
    resolve: 1,
    sqlCount: 4,
    sqlFingerprint:
      "a9ea713d1148db81e35a4999665f250c05a478187735ac1efc004e4947e451fa",
    reason: "count_sql_requires_numeric_target",
    lateRoot: false,
    coreError: false,
    ownerChecks: false,
  },
  {
    key: "api/event/observation-not-admitted",
    audience: "api-v1",
    scope: "event",
    dsl: 'first(event.payload("/amount")) gt 0',
    variant: "summary",
    expected: {
      value: {
        totalViews: 11,
        directViews: 3,
        externalViews: 8,
        uniqueDomains: 4,
        uniqueLinks: 8,
        truncated: true,
        topSources: [
          {
            referrer: "github.com",
            views: 3,
          },
          {
            referrer: "duckduckgo.com",
            views: 2,
          },
        ],
      },
      source: "raw",
    },
    core: 1,
    register: 1,
    resolve: 1,
    sqlCount: 4,
    sqlFingerprint:
      "184022b79859f6a2f14195628271329700351bc61aca004cba735b9b23d10eef",
    reason: "count_sql_requires_session_or_visitor_scope",
    lateRoot: false,
    coreError: false,
    ownerChecks: false,
  },
] as const;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
for (const sample of samples)
  it(sample.key, async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("network_forbidden");
    });
    const database = createMigratedDatabase();
    for (const sql of buildJourneyEventFieldsCostFixture(24).seed)
      database.exec(sql);
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET: "w127-local-test-secret",
    } as Env;
    const diagnostics = diagnosticsModule.createD1ReadDiagnostics();
    const time = createQueryTime(
      SEED_BASE_MS,
      SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
      "UTC",
      SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
    );
    const q = prepareScopedQuery("referrers", {
      context: siteQueryContext(SEED_SITE_ID, sample.audience),
      time,
      scopePreference: sample.scope,
      filters: parseFilterDsl(sample.dsl, analyticsFilterRegistry),
      variant: sample.variant,
      topN: 2,
      limit: 2,
      includeFullUrl: false,
      ...(sample.variant === "list"
        ? { page: { limit: 2, cursor: null } }
        : {}),
    });
    const metadata = scopedFilterMetadata(q.filters);
    expect(metadata).toBeDefined();
    if (sample.key.endsWith("real-empty"))
      expect(metadata?.time?.filterRangeEmpty).toBe(true);
    const sentinel = new Error("original_Core_sentinel");
    const actualCore = core.evaluateFilterDocument;
    const evaluated = vi
      .spyOn(core, "evaluateFilterDocument")
      .mockImplementation((...args) => {
        if (sample.coreError) throw sentinel;
        const result = actualCore(...args);
        if (sample.lateRoot)
          expect(Reflect.set(q.filters, "root", null)).toBe(true);
        return result;
      });
    const registered = vi.spyOn(bridge, "registerPreparedMembership");
    const resolved = vi.spyOn(bridge, "resolvePreparedMembership");
    const minted = vi.spyOn(
      preparation,
      "createPageVisitQualificationPreparation",
    );
    const bound = vi.spyOn(
      preparation,
      "bindPageVisitQualificationPreparation",
    );
    const actualReader = reader.queryReferrerSummaryFromD1;
    let ownerChecks = 0;
    vi.spyOn(reader, "queryReferrerSummaryFromD1").mockImplementation(
      (...args) => {
        if (sample.ownerChecks) {
          const owner = args[8];
          if (!owner) throw new Error("actual_completion_owner_missing");
          const actualMetadata = scopedFilterMetadata(args[3]);
          if (!actualMetadata?.time || !actualMetadata.plan)
            throw new Error("actual_reader_metadata_missing");
          const input = {
            owner,
            consumer: {
              kind: "page" as const,
              family: "referrers" as const,
              reader: {
                kind: "referrers-summary" as const,
                configuration: { topN: 2 },
              },
            },
            siteId: args[1],
            filters: args[3],
            queryTime: actualMetadata.time,
            scopePlan: actualMetadata.plan,
          };
          // A copied owner has no association and grants no execution inputs.
          const sqlBeforeCopiedOwner = trace.preparedSql.length;
          expect(
            completion.bindWholeOriginalReader({
              ...input,
              owner: { ...owner },
            }),
          ).toBeUndefined();
          expect(trace.preparedSql).toHaveLength(sqlBeforeCopiedOwner);
          expect(minted).not.toHaveBeenCalled();
          expect(bound).not.toHaveBeenCalled();
          ownerChecks++;
          for (const wrong of [
            { ...input, siteId: "foreign-site" },
            { ...input, filters: { ...input.filters } },
          ]) {
            const sqlBefore = trace.preparedSql.length;
            expect(() => completion.bindWholeOriginalReader(wrong)).toThrow();
            expect(trace.preparedSql).toHaveLength(sqlBefore);
            expect(minted).not.toHaveBeenCalled();
            expect(bound).not.toHaveBeenCalled();
            ownerChecks++;
          }
        }
        return actualReader(...args);
      },
    );
    const before = database.prepare("SELECT total_changes() AS changes").get();
    try {
      const provider = createD1SiteProviderRegistry({
        env,
        siteId: SEED_SITE_ID,
        diagnostics,
      }).resolve("referrers");
      if (!provider) throw new Error("registered_referrers_provider_missing");
      const pending = provider.execute(q);
      if (sample.coreError) await expect(pending).rejects.toBe(sentinel);
      else expect(await pending).toEqual(sample.expected);
      expect(evaluated).toHaveBeenCalledTimes(sample.core);
      expect(registered).toHaveBeenCalledTimes(sample.register);
      expect(resolved).toHaveBeenCalledTimes(sample.resolve);
      expect(trace.preparedSql).toHaveLength(sample.sqlCount);
      expect(
        createHash("sha256")
          .update(
            JSON.stringify(
              trace.preparedSql.map((sql, index) => ({
                sql,
                params: trace.bindings[index],
              })),
            ),
          )
          .digest("hex"),
      ).toBe(sample.sqlFingerprint);
      expect(diagnostics.advancedFilterExecution?.reason).toBe(sample.reason);
      expect(
        database.prepare("SELECT total_changes() AS changes").get(),
      ).toEqual(before);
      if (sample.ownerChecks) expect(ownerChecks).toBe(3);
      if (sample.lateRoot) expect(q.filters.root).toBeNull();
      if (sample.register === 0 && !sample.coreError) {
        expect(minted).toHaveBeenCalledTimes(1);
        expect(bound).toHaveBeenCalledTimes(1);
        expect(minted.mock.calls[0]?.[0]).toMatchObject({
          maxBindings: 1,
          maxSourcesPerRole: 1,
          qualificationSemantics: "whole-original",
          dependencyRef: "event-filter-entity-membership-v1",
        });
        const binding = bound.mock.calls[0]?.[0];
        expect(binding?.preparation).toBe(minted.mock.results[0]?.value);
        expect(binding?.plan.outputs.map((output) => output.id)).toEqual([
          "referrer-summary",
          "referrer-top-sources",
        ]);
        const sources = binding?.plan.nodes.filter(
          (node) => node.kind === "source",
        );
        expect(sources?.map((source) => source.entity)).toEqual(["page"]);
        expect(
          sources?.map(
            (source) => source.selection?.qualificationDependencyRefs,
          ),
        ).toEqual([["event-filter-entity-membership-v1"]]);
      } else {
        expect(minted).not.toHaveBeenCalled();
        expect(bound).not.toHaveBeenCalled();
      }
    } finally {
      database.close();
    }
  });
