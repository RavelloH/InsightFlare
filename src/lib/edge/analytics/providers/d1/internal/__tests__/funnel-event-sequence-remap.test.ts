import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { compileD1Query, createD1DatabaseClient } from "@/lib/db";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import {
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
} from "@/lib/edge/analytics/contract";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import {
  createSemanticPostObservationFilter,
  createSemanticScopedSourceSelection,
} from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";

const SITE_ID = "funnel-sequence-remap-site";

describe("selected funnel Event report remapping", () => {
  it("preserves the stored sequence on a post-observation-selected Event", async () => {
    const database = createMigratedDatabase();
    try {
      database
        .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
        .run(SITE_ID);
      const sitePk = Number(
        (
          database
            .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
            .get(SITE_ID) as { readonly site_pk: number }
        ).site_pk,
      );
      database
        .prepare(
          "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?)",
        )
        .run(SITE_ID, "activity", 150, sitePk);
      const eventNameId = Number(
        (
          database
            .prepare("SELECT id FROM custom_event_names WHERE site_pk = ?")
            .get(sitePk) as { readonly id: number }
        ).id,
      );
      database
        .prepare(
          `
          INSERT INTO visits (
            visit_id, site_id, site_pk, visitor_id, session_id, status,
            started_at, last_activity_at, pathname, hostname
          ) VALUES ('owner', ?, ?, 'visitor-a', 'session-a', 'complete', 120, 120, '/owner', 'example.test')
        `,
        )
        .run(SITE_ID, sitePk);
      database
        .prepare(
          `
          INSERT INTO custom_events (
            event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
            received_at, sequence, node_count, value_count
          ) VALUES ('event-a', ?, ?, 'owner', ?, 150, 150, 7, 0, 0)
        `,
        )
        .run(SITE_ID, sitePk, eventNameId);

      const range = { startMs: 100, endExclusiveMs: 200 } as const;
      const subject = createSemanticSubjectDomain({
        origin: "site",
        siteIds: [SITE_ID as never],
      });
      const time = createSemanticTemporalDomains({
        candidate: range as never,
        read: { kind: "bounded", range: range as never },
        reportingTimeZone: "UTC" as never,
        capturedAtMs: 200 as never,
      });
      const postObservationFilter = createSemanticPostObservationFilter({
        filter: {
          version: 1,
          root: {
            kind: "condition",
            target: { kind: "field", field: "event.name" },
            operator: "eq",
            value: "activity",
          },
        } as FilterDocument,
      });
      const selection = createSemanticScopedSourceSelection({
        profile: "direct-event-analytics-v1",
        filters: EMPTY_FILTER_DOCUMENT,
        subject,
        time,
        postObservationFilter,
      });
      const builder = new LogicalPlanBuilder({
        subject,
        time,
        scope: resolveAnalyticsScope("session"),
      });
      const events = builder.source("event", {
        temporalDomain: "candidate",
        attributes: ["event.report.localId", "event.report.sequence"],
        selection,
      });
      builder.output("selectedEvents", events, [
        { name: "eventId", slot: "attribute:event.report.localId" },
        { name: "sequence", slot: "attribute:event.report.sequence" },
      ]);
      const plan = builder.finish();
      const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
        siteId: SITE_ID,
        time: plan.context.time,
      });
      const output = plan.outputs[0]!;
      const query = compileD1Query(
        lowerer.projectOutput(
          lowerer.lower(output),
          output.fields.map(({ name, slot }) => ({ name, slot })),
        ),
      );
      const rows = (
        await createD1DatabaseClient(createSqliteD1Database(database)).all(
          query,
        )
      ).results;
      expect(rows).toEqual([{ eventId: "event-a", sequence: 7 }]);
    } finally {
      database.close();
    }
  });
});
