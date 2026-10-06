import type { DatabaseSync } from "node:sqlite";
import { type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { compileD1Query, lowerLogicalPlan } from "@/lib/db";
import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
} from "@/lib/edge/analytics/contract/types";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";

const SITE_ID = "analysis-result-composition";
const STRING = { kind: "scalar", scalar: "string" } as const;

function buildPeriodPlan(
  startMs: number,
  endExclusiveMs: number,
  capturedAtMs: number,
) {
  const range = { startMs, endExclusiveMs };
  const builder = new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE_ID as SiteId],
    }),
    time: createSemanticTemporalDomains({
      candidate: range as never,
      read: { kind: "bounded", range: range as never },
      reportingTimeZone: "UTC" as ReportingTimeZone,
      capturedAtMs: capturedAtMs as EpochMs,
    }),
    scope: resolveAnalyticsScope("session"),
  });
  const pages = builder.source("page", {
    temporalDomain: "candidate",
    attributes: ["page.report.pathname"],
  });
  const rollup = builder.aggregate(
    pages,
    {
      key: builder.coalesce(
        builder.slot(pages, "attribute:page.report.pathname"),
        builder.literal("", STRING),
      ),
    },
    [{ name: "views", kind: "count-rows" }],
  );
  builder.output("rollup", rollup, [
    { name: "key", slot: "key" },
    { name: "views", slot: "views" },
  ]);
  return builder.finish();
}

function seedPage(
  database: DatabaseSync,
  sitePk: number,
  visitId: string,
  pathname: string,
  startedAt: number,
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname
      ) VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, ?, 'example.test')`,
    )
    .run(
      visitId,
      SITE_ID,
      sitePk,
      `visitor-${visitId}`,
      `session-${visitId}`,
      startedAt,
      startedAt,
      pathname,
    );
}

describe("Logical analysis-result composition", () => {
  it.each([
    {
      name: "plain imports preserve cross-period key aggregation",
      aliasesDerived: false,
      expectedRows: [
        { key: "/a", views: 1 },
        { key: "/b", views: 3 },
        { key: "/c", views: 1 },
      ],
    },
    {
      name: "aliased derived imports preserve cross-period key aggregation",
      aliasesDerived: true,
      expectedRows: [
        { key: "/a@derived", views: 1 },
        { key: "/b@derived", views: 3 },
        { key: "/c@derived", views: 1 },
      ],
    },
  ])(
    "$name in one executable SQLite statement",
    ({ aliasesDerived, expectedRows }) => {
      const database = createMigratedDatabase();
      try {
        database
          .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
          .run(SITE_ID);
        const site = database
          .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
          .get(SITE_ID) as { readonly site_pk: number };
        seedPage(database, site.site_pk, "current-a", "/a", 110);
        seedPage(database, site.site_pk, "current-b-1", "/b", 120);
        seedPage(database, site.site_pk, "current-b-2", "/b", 130);
        seedPage(database, site.site_pk, "reference-b", "/b", 220);
        seedPage(database, site.site_pk, "reference-c", "/c", 230);

        const current = buildPeriodPlan(100, 200, 250);
        const reference = buildPeriodPlan(200, 300, 350);
        const parentBuilder = new LogicalPlanBuilder(current.context);
        const currentResult = parentBuilder.importAnalysisResult(
          current,
          "rollup",
          aliasesDerived
            ? [{ field: "key", as: "path" }, { field: "views" }]
            : [{ field: "key" }, { field: "views" }],
        );
        expect(() =>
          parentBuilder.relationshipLookup(currentResult, "page.observation"),
        ).toThrow("relationship_lookup_requires_entity");
        const referenceResult = parentBuilder.importAnalysisResult(
          reference,
          "rollup",
          aliasesDerived
            ? [{ field: "key", as: "path" }, { field: "views" }]
            : [{ field: "key" }, { field: "views" }],
        );
        const importedKey = aliasesDerived ? "path" : "key";
        const currentRows = aliasesDerived
          ? parentBuilder.project(currentResult, {
              key: parentBuilder.concatText(
                parentBuilder.slot(currentResult, importedKey),
                parentBuilder.literal("@derived", STRING),
              ),
              views: parentBuilder.slot(currentResult, "views"),
            })
          : currentResult;
        const referenceRows = aliasesDerived
          ? parentBuilder.project(referenceResult, {
              key: parentBuilder.concatText(
                parentBuilder.slot(referenceResult, importedKey),
                parentBuilder.literal("@derived", STRING),
              ),
              views: parentBuilder.slot(referenceResult, "views"),
            })
          : referenceResult;
        const combined = parentBuilder.appendRows(
          [currentRows, referenceRows],
          ["key", "views"],
        );
        const totals = parentBuilder.aggregate(
          combined,
          { key: parentBuilder.slot(combined, "key") },
          [
            {
              name: "views",
              kind: "sum",
              expression: parentBuilder.slot(combined, "views"),
            },
          ],
        );
        parentBuilder.output("combined", totals, [
          { name: "key", slot: "key" },
          { name: "views", slot: "views" },
        ]);
        const plan = parentBuilder.finish();
        expect(current.outputs[0]?.fields.map((field) => field.name)).toEqual([
          "key",
          "views",
        ]);
        expect(reference.outputs[0]?.fields.map((field) => field.name)).toEqual(
          ["key", "views"],
        );
        const importedSnapshots = plan.nodes.filter(
          (node) => node.kind === "analysis-result",
        );
        expect(
          importedSnapshots.map((node) =>
            node.kind === "analysis-result"
              ? {
                  outputId: node.outputId,
                  childFields: node.childPlan.outputs[0]?.fields.map(
                    (field) => field.name,
                  ),
                  mappedFields: node.mappings.map((mapping) => mapping.field),
                  candidate: node.childPlan.context.time.candidate,
                }
              : undefined,
          ),
        ).toEqual([
          {
            outputId: "rollup",
            childFields: ["key", "views"],
            mappedFields: ["key", "views"],
            candidate: { startMs: 100, endExclusiveMs: 200 },
          },
          {
            outputId: "rollup",
            childFields: ["key", "views"],
            mappedFields: ["key", "views"],
            candidate: { startMs: 200, endExclusiveMs: 300 },
          },
        ]);
        const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
          siteId: SITE_ID,
          time: plan.context.time,
        });
        expect(lowerer.candidateActivity(currentResult.id)).toBeUndefined();
        expect(
          lowerer.isCandidateActivitySessionRestricted(currentResult.id),
        ).toBe(false);
        const loweredCurrent = lowerer.lower({
          id: "current-imported-result",
          relation: currentResult.id,
          fields: [
            { name: importedKey, slot: currentResult.slots[importedKey]! },
          ],
        });
        expect(
          loweredCurrent.slots.get(currentResult.slots[importedKey]!)
            ?.candidateBounded,
        ).toBe(false);
        const output = plan.outputs[0]!;
        const lowered = lowerer.lower(output);
        const query = compileD1Query(
          lowerLogicalPlan(
            lowerer.projectOutput(
              lowered,
              output.fields.map((field) => ({
                name: field.name,
                slot: field.slot,
              })),
            ),
          ),
        );
        const rows = database
          .prepare(query.sql)
          .all(...((query.bindings ?? []) as SQLInputValue[])) as Array<{
          key: string;
          views: number;
        }>;
        rows.sort((left, right) => left.key.localeCompare(right.key));

        expect(rows).toEqual(expectedRows);
        expect(current.context.time.candidate).toEqual({
          startMs: 100,
          endExclusiveMs: 200,
        });
        expect(reference.context.time.candidate).toEqual({
          startMs: 200,
          endExclusiveMs: 300,
        });
        expect(current.context.time.capturedAtMs).toBe(250);
        expect(reference.context.time.capturedAtMs).toBe(350);
        expect(query.sql.length).toBeGreaterThan(0);
        expect(query.bindings?.length ?? 0).toBeLessThanOrEqual(100);
      } finally {
        database.close();
      }
    },
  );
});
