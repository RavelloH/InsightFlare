import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { compileD1Query, lowerLogicalPlan } from "@/lib/db";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import {
  createSemanticSubjectDomain,
  type SemanticSubjectDomain,
} from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import {
  AnalyticsLogicalToDbLowerer,
  AnalyticsRelationalLoweringError,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import {
  type AnalyticsRelationalStorageContext,
  normalizeAnalyticsRelationalSiteIds,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";

const SITE = "relational-lowering-contract-site";
const STRING = { kind: "scalar", scalar: "string" } as const;
const RANGE = {
  startMs: 0 as never,
  endExclusiveMs: 1_000 as never,
};

function createTime() {
  return createSemanticTemporalDomains({
    candidate: { startMs: 100 as never, endExclusiveMs: 200 as never },
    read: { kind: "bounded", range: RANGE },
    reportingTimeZone: "UTC" as never,
    capturedAtMs: 1_000 as never,
  });
}

function createBuilder(
  subject: SemanticSubjectDomain = createSemanticSubjectDomain({
    origin: "site",
    siteIds: [SITE as never],
  }),
): LogicalPlanBuilder {
  return new LogicalPlanBuilder({
    subject,
    time: createTime(),
    scope: resolveAnalyticsScope("auto"),
  });
}

function createLowerer(plan: ReturnType<LogicalPlanBuilder["finish"]>) {
  return new AnalyticsLogicalToDbLowerer(plan, {
    siteId: SITE,
    time: plan.context.time,
  });
}

function compileOutput(
  plan: ReturnType<LogicalPlanBuilder["finish"]>,
  storageContext: AnalyticsRelationalStorageContext,
) {
  const output = plan.outputs[0]!;
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, storageContext);
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(
    lowered,
    output.fields.map(({ name, slot }) => ({ name, slot })),
  );
  return compileD1Query(lowerLogicalPlan(relation));
}

function addSite(database: DatabaseSync): number {
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE);
  return Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE) as { readonly site_pk: number }
    ).site_pk,
  );
}

function addVisit(
  database: DatabaseSync,
  sitePk: number,
  input: {
    readonly id: string;
    readonly pathname: string;
    readonly durationMs?: number | null;
  },
): void {
  database
    .prepare(
      "INSERT INTO visits (visit_id, site_id, site_pk, visitor_id, session_id, status, started_at, last_activity_at, duration_ms, pathname, hostname) " +
        "VALUES (?, ?, ?, 'contract-visitor', ?, 'closed', 500, 500, ?, ?, 'contract.test')",
    )
    .run(
      input.id,
      SITE,
      sitePk,
      input.id,
      input.durationMs ?? null,
      input.pathname,
    );
}

describe("Analytics to Generic relational lowering contracts", () => {
  it("binds untrusted text and preserves duplicate source rows through filtering", () => {
    const builder = createBuilder();
    const pages = builder.source("page", {
      temporalDomain: "read",
      attributes: ["page.report.pathname"],
    });
    const requestedPath = "/x' OR 1 = 1 --";
    const matching = builder.filter(
      pages,
      builder.compare(
        "eq",
        builder.slot(pages, "attribute:page.report.pathname"),
        builder.literal(requestedPath, STRING),
      ),
    );
    builder.output("matching-paths", matching, [
      { name: "path", slot: "attribute:page.report.pathname" },
    ]);
    const plan = builder.finish();
    const lowerer = createLowerer(plan);
    const output = plan.outputs[0]!;
    const lowered = lowerer.lower(output);
    const relation = lowerer.projectOutput(lowered, [
      { name: "path", slot: output.fields[0]!.slot },
    ]);
    const query = compileD1Query(lowerLogicalPlan(relation));

    const database = createMigratedDatabase();
    try {
      const sitePk = addSite(database);
      addVisit(database, sitePk, { id: "matching-a", pathname: requestedPath });
      addVisit(database, sitePk, { id: "matching-b", pathname: requestedPath });
      addVisit(database, sitePk, { id: "other", pathname: "/other" });

      const rows = database
        .prepare(query.sql)
        .all(...(query.bindings as SQLInputValue[])) as Array<{
        readonly path: string;
      }>;
      expect(query.sql).not.toContain(requestedPath);
      expect(
        (query.bindings ?? []).filter((value) => value === requestedPath),
      ).toHaveLength(1);
      expect(rows.map(({ path }) => path)).toEqual([
        requestedPath,
        requestedPath,
      ]);
    } finally {
      database.close();
    }
  });

  it("canonicalizes storage site sets and rejects authority wider than the Semantic subject", () => {
    const time = createTime();
    expect(
      normalizeAnalyticsRelationalSiteIds({
        siteIds: ["site-b", "site-a", "site-b"],
        time,
      }),
    ).toEqual(["site-a", "site-b"]);
    expect(
      normalizeAnalyticsRelationalSiteIds({ siteId: "site-a", time }),
    ).toEqual(["site-a"]);
    expect(() =>
      normalizeAnalyticsRelationalSiteIds({
        siteId: "site-a",
        siteIds: ["site-a"],
        time,
      } as never),
    ).toThrow("analytics_relational_site_context_requires_siteId_or_siteIds");
    expect(() =>
      normalizeAnalyticsRelationalSiteIds({ siteIds: [], time }),
    ).toThrow("analytics_relational_site_context_requires_non_empty_ids");

    const subject = createSemanticSubjectDomain({
      origin: "team",
      teamId: "relational-lowering-team" as never,
      siteIds: ["site-b" as never, "site-a" as never],
    });
    const builder = createBuilder(subject);
    const pages = builder.source("page", { temporalDomain: "read" });
    const count = builder.aggregate(pages, {}, [
      { name: "rows", kind: "count-rows" },
    ]);
    builder.output("page-count", count, [{ name: "rows", slot: "rows" }]);
    const plan = builder.finish();
    const canonical = compileOutput(plan, {
      siteIds: ["site-a", "site-b"],
      time: plan.context.time,
    });
    const reorderedWithDuplicate = compileOutput(plan, {
      siteIds: ["site-b", "site-a", "site-a"],
      time: plan.context.time,
    });
    expect(reorderedWithDuplicate).toEqual(canonical);

    expect(
      () =>
        new AnalyticsLogicalToDbLowerer(plan, {
          siteIds: ["site-a", "site-b", "outside-site"],
          time: plan.context.time,
        }),
    ).toThrow(
      expect.objectContaining({
        name: "AnalyticsRelationalLoweringError",
        node: "context.subject",
        message:
          "Storage site IDs must exactly match the authorized Semantic subject.",
      }),
    );
  });

  it("preserves explicit NULL ordering when lowering a nullable Page metric", () => {
    const builder = createBuilder();
    const pages = builder.source("page", {
      temporalDomain: "read",
      attributes: ["page.report.durationMs"],
    });
    const sorted = builder.sort(pages, [
      {
        slot: "attribute:page.report.durationMs",
        direction: "asc",
        nulls: "last",
      },
    ]);
    builder.output("durations", sorted, [
      { name: "durationMs", slot: "attribute:page.report.durationMs" },
    ]);
    const plan = builder.finish();
    const query = compileOutput(plan, {
      siteId: SITE,
      time: plan.context.time,
    });

    const database = createMigratedDatabase();
    try {
      const sitePk = addSite(database);
      addVisit(database, sitePk, { id: "duration-null", pathname: "/null" });
      addVisit(database, sitePk, {
        id: "duration-two",
        pathname: "/two",
        durationMs: 2,
      });
      addVisit(database, sitePk, {
        id: "duration-one",
        pathname: "/one",
        durationMs: 1,
      });
      const rows = database
        .prepare(query.sql)
        .all(...(query.bindings as SQLInputValue[])) as Array<{
        readonly durationMs: number | null;
      }>;

      expect(rows.map(({ durationMs }) => durationMs)).toEqual([1, 2, null]);
    } finally {
      database.close();
    }
  });
});
