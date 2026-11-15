import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  createD1DatabaseClient,
  lowerLogicalPlan,
} from "@/lib/db";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createTimeRange } from "@/lib/edge/analytics/contract";
import type { SiteId } from "@/lib/edge/analytics/contract/types";
import {
  appendAdvancedEventCandidateCountQualification,
  createAdvancedCountQualificationBuilder,
} from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import { classifyAdvancedEventCandidateCountFilter } from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const SITE_ID = "wave97ea-event-candidate-kernel" as SiteId;
const OUTPUT_ID = "wave97ea-event-candidate-matches";
const RANGE = createTimeRange(120, 130);

interface CandidateMatch {
  readonly siteId: string;
  readonly entityId: string;
  readonly candidateKind: "page" | "event";
  readonly visitId: string | null;
}

let database: DatabaseSync;
let sitePk: number;

function insertVisit(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly path: string;
  readonly startedAt?: number;
}): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, 125, ?, 'kernel.test')`,
    )
    .run(
      input.id,
      SITE_ID,
      sitePk,
      `visitor-${input.id}`,
      input.sessionId,
      input.startedAt ?? 125,
      input.path,
    );
}

function insertEvent(input: {
  readonly id: string;
  readonly visitId: string;
  readonly nameId: number;
}): void {
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, 125, 777, 1, 1, 1)`,
    )
    .run(input.id, SITE_ID, sitePk, input.visitId, input.nameId);
}

function insertEventName(id: number, name: string): void {
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (?, ?, ?, 1, ?)`,
    )
    .run(id, SITE_ID, name, sitePk);
}

beforeAll(() => {
  database = createMigratedDatabase();
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { readonly site_pk: number }
    ).site_pk,
  );
  insertEventName(1, "collision-event");
  insertEventName(2, "outside-event");
  insertEventName(3, "white-event");

  // The Page and Event have the same local ID. Their sessions are empty, so
  // Count falls back to that ID while each candidate keeps its own visitId.
  insertVisit({
    id: "collision",
    sessionId: "",
    path: "/collision-page",
  });
  insertVisit({
    id: "collision-owner",
    sessionId: "",
    path: "/collision-owner",
    startedAt: 110,
  });
  insertEvent({
    id: "collision",
    visitId: "collision-owner",
    nameId: 1,
  });

  insertVisit({ id: "page-only", sessionId: "", path: "/page-only" });

  // These owner Pages are outside the candidate range; Event candidates still
  // carry their owner visit IDs and can read the owner Page context.
  insertVisit({
    id: "outside-owner",
    sessionId: "outside-session",
    path: "/outside-owner",
    startedAt: 110,
  });
  insertEvent({
    id: "outside-event-id",
    visitId: "outside-owner",
    nameId: 2,
  });
  insertVisit({
    id: "white-owner",
    sessionId: " ",
    path: "/white-owner",
    startedAt: 110,
  });
  insertEvent({
    id: "white-event-id",
    visitId: "white-owner",
    nameId: 3,
  });
});

afterAll(() => database.close());

describe("Event-candidate Count qualification output", () => {
  it("executes typed Page/Event membership with each candidate's visit ID", async () => {
    const document = parseFilterDsl(
      '(count(page) eq 1 AND count(event) eq 1 AND page.path eq "/collision-owner" AND event.name eq "collision-event") OR (count(page) eq 1 AND count(event) eq 0 AND page.path eq "/page-only") OR (count(page) eq 0 AND count(event) eq 1 AND page.path eq "/outside-owner" AND event.name eq "outside-event") OR (count(page) eq 0 AND count(event) eq 1 AND page.path eq "/white-owner" AND event.name eq "white-event")',
      analyticsFilterRegistry,
    );
    const support = classifyAdvancedEventCandidateCountFilter(document);
    if (support.kind !== "supported")
      throw new Error("wave97ea_event_candidate_kernel_filter_unsupported");

    const input = {
      subject: createSemanticSubjectDomain({
        origin: "site",
        siteIds: [SITE_ID],
      }),
      candidateRange: RANGE,
      readRange: RANGE,
      expressionRange: RANGE,
      expressionUsesExplicitRange: false,
      lowerBounds: [{ siteId: SITE_ID, startMs: RANGE.startMs }],
      scope: "event",
      candidateAnchor: { kind: "event-candidate" },
      reportingTimeZone: "UTC",
      capturedAtMs: 500,
      analysis: support.analysis,
    } as const;
    const builder = createAdvancedCountQualificationBuilder(input);
    const qualification = appendAdvancedEventCandidateCountQualification(
      builder,
      input,
    );
    builder.output(
      OUTPUT_ID,
      qualification.matches,
      ["siteId", "entityId", "candidateKind", "visitId"].map((name) => ({
        name,
        slot: name,
      })),
    );
    builder.output(
      `${OUTPUT_ID}-controls`,
      qualification.controls,
      Object.keys(qualification.controls.slots).map((name) => ({
        name,
        slot: name,
      })),
    );
    const plan = builder.finish();
    const output = plan.outputs.find((candidate) => candidate.id === OUTPUT_ID);
    if (!output) throw new Error("wave97ea_event_candidate_output_missing");
    const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
      siteIds: [SITE_ID],
      time: plan.context.time,
    });
    const lowered = lowerer.lower(output);
    const projected = lowerer.projectOutput(
      lowered,
      output.fields.map((field) => ({ name: field.name, slot: field.slot })),
    );
    const compiled = compileD1Query(lowerLogicalPlan(projected), {
      tag: "analytics.event_candidate.count_matches_contract",
    });
    const result = await createD1DatabaseClient(
      createSqliteD1Database(database),
    ).all<CandidateMatch>(compiled as never);
    const matches = [...result.results].sort((left, right) =>
      left.entityId.localeCompare(right.entityId),
    );

    const evidencePath = process.env.WAVE97EA_KERNEL_EVIDENCE_PATH;
    if (evidencePath) {
      const absoluteEvidencePath = resolve(evidencePath);
      mkdirSync(dirname(absoluteEvidencePath), { recursive: true });
      writeFileSync(
        absoluteEvidencePath,
        JSON.stringify(
          {
            kind: "wave97ea-event-candidate-count-kernel-sql-contract",
            query: {
              sql: compiled.sql,
              bindings: compiled.bindings ?? [],
              sqlUtf8Bytes: new TextEncoder().encode(compiled.sql).byteLength,
              bindingCount: compiled.bindings?.length ?? 0,
            },
            candidateGrain: qualification.candidateGrain,
            scope: qualification.scope,
            groupedSummaryRelationIds: [
              qualification.groupedSummary.id,
              ...(qualification.additionalGroupedSummaries ?? []).map(
                (relation) => relation.id,
              ),
            ],
            matches,
          },
          null,
          2,
        ),
        "utf8",
      );
    }

    expect(qualification.scope).toBe("event");
    expect(qualification.candidateGrain).toBe("event-candidate");
    expect(matches).toEqual([
      {
        siteId: SITE_ID,
        entityId: "collision",
        candidateKind: "event",
        visitId: "collision-owner",
      },
      {
        siteId: SITE_ID,
        entityId: "outside-event-id",
        candidateKind: "event",
        visitId: "outside-owner",
      },
      {
        siteId: SITE_ID,
        entityId: "page-only",
        candidateKind: "page",
        visitId: "page-only",
      },
      {
        siteId: SITE_ID,
        entityId: "white-event-id",
        candidateKind: "event",
        visitId: "white-owner",
      },
    ]);
    expect(compiled.sql).toContain("candidateKind");
  });
});
