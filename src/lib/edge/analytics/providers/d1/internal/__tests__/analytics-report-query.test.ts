import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import {
  type AnalyticsReportMultiOutputSelection,
  queryAnalyticsReportOutputSetRowsFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import type { Env } from "@/lib/edge/types";

const SITE_ID = "report-multi-output-site";
const STRING = { kind: "scalar", scalar: "string" } as const;

function createContext() {
  const range = { startMs: 0, endExclusiveMs: 1_000 };
  return {
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE_ID as never],
    }),
    time: createSemanticTemporalDomains({
      candidate: range as never,
      read: { kind: "bounded", range: range as never },
      reportingTimeZone: "UTC" as never,
      capturedAtMs: 1_000 as never,
    }),
    scope: resolveAnalyticsScope("auto"),
  };
}

function createPlan(): ValidatedLogicalPlan {
  const builder = new LogicalPlanBuilder(createContext());
  const pages = builder.source("page", {
    temporalDomain: "candidate",
    attributes: ["page.path"],
    relationships: ["page.session"],
  });
  const path = builder.slot(pages, "attribute:page.path");

  const emptyPages = builder.filter(
    pages,
    builder.compare("eq", path, builder.literal("/no-row", STRING)),
  );
  const scalar = builder.aggregate(emptyPages, {}, [
    { name: "count", kind: "count-rows" },
  ]);
  const scalarRow = builder.project(scalar, {
    label: builder.literal(null, STRING),
    kind: builder.literal("summary", STRING),
    count: builder.slot(scalar, "count"),
  });
  builder.output("scalar-empty", scalarRow, [
    { name: "label", slot: "label" },
    { name: "kind", slot: "kind" },
    { name: "count", slot: "count" },
  ]);

  const grouped = builder.aggregate(pages, { label: path }, [
    { name: "count", kind: "count-rows" },
  ]);
  const groupedRows = builder.project(grouped, {
    label: builder.slot(grouped, "label"),
    kind: builder.literal("path", STRING),
    count: builder.slot(grouped, "count"),
  });
  // The declaration order intentionally differs from the requested order.
  builder.output("paths", groupedRows, [
    { name: "count", slot: "count" },
    { name: "kind", slot: "kind" },
    { name: "label", slot: "label" },
  ]);
  builder.output("paths-copy", groupedRows, [
    { name: "label", slot: "label" },
    { name: "kind", slot: "kind" },
    { name: "count", slot: "count" },
  ]);

  const sessions = builder.distinctEntity(
    pages,
    "relationship:page.session",
    "session",
  );
  builder.output("entity-output", sessions, [
    { name: "entity", slot: "session" },
  ]);

  const textRelation = builder.project(pages, {
    value: builder.literal("text", STRING),
  });
  builder.output("text-type", textRelation, [{ name: "value", slot: "value" }]);
  const numberRelation = builder.project(pages, {
    value: builder.literal(5, { kind: "scalar", scalar: "number" }),
  });
  builder.output("number-type", numberRelation, [
    { name: "value", slot: "value" },
  ]);

  return builder.finish();
}

function createDatabase(): {
  readonly database: DatabaseSync;
  readonly sitePk: number;
} {
  const database = createMigratedDatabase();
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
  for (const [index, pathname] of ["/zeta", "/alpha", "/alpha"].entries()) {
    database
      .prepare(
        `INSERT INTO visits (
          visit_id, site_id, site_pk, visitor_id, session_id, status,
          started_at, last_activity_at, pathname, hostname
        ) VALUES (?, ?, ?, ?, ?, 'closed', 100, 100, ?, 'report.test')`,
      )
      .run(
        `visit-${index}`,
        SITE_ID,
        sitePk,
        `visitor-${index}`,
        `session-${index}`,
        pathname,
      );
  }
  return { database, sitePk };
}

function createEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
  } as unknown as Env;
}

function trace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

const PATH_SELECTION: AnalyticsReportMultiOutputSelection = {
  outputIds: ["scalar-empty", "paths", "paths-copy"],
  fields: ["label", "kind", "count"],
  orderBy: [
    { field: "label", direction: "asc", nulls: "first" },
    { field: "kind", direction: "asc", nulls: "first" },
  ],
};

describe("Analytics report multi-output adapter", () => {
  it("aligns aliases, preserves UNION ALL duplicates, sorts nulls, and executes once", async () => {
    const { database } = createDatabase();
    try {
      const queryTrace = trace();
      const rows = await queryAnalyticsReportOutputSetRowsFromD1(
        createEnv(database, queryTrace),
        createPlan(),
        PATH_SELECTION,
      );
      expect(rows).toEqual([
        { label: null, kind: "summary", count: 0 },
        { label: "/alpha", kind: "path", count: 2 },
        { label: "/alpha", kind: "path", count: 2 },
        { label: "/zeta", kind: "path", count: 1 },
        { label: "/zeta", kind: "path", count: 1 },
      ]);
      expect(queryTrace.preparedSql).toHaveLength(1);
      expect(queryTrace.bindings).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("rejects unknown, duplicate, incompatible, and entity outputs before execution", async () => {
    const { database } = createDatabase();
    try {
      const plan = createPlan();
      const cases: Array<{
        readonly selection: AnalyticsReportMultiOutputSelection;
        readonly message: string;
      }> = [
        {
          selection: {
            ...PATH_SELECTION,
            outputIds: ["missing"],
          },
          message: "analytics_report_multi_output_missing:missing",
        },
        {
          selection: {
            ...PATH_SELECTION,
            outputIds: ["paths", "paths"],
          },
          message: "analytics_report_multi_output_ids_duplicate",
        },
        {
          selection: {
            ...PATH_SELECTION,
            outputIds: ["text-type", "number-type"],
            fields: ["value"],
            orderBy: [{ field: "value", direction: "asc", nulls: "first" }],
          },
          message: "analytics_report_multi_output_field_incompatible:1:value",
        },
        {
          selection: {
            ...PATH_SELECTION,
            outputIds: ["entity-output"],
            fields: ["entity"],
            orderBy: [{ field: "entity", direction: "asc", nulls: "first" }],
          },
          message: "analytics_report_multi_output_entity_unsupported:entity",
        },
      ];
      for (const item of cases) {
        const queryTrace = trace();
        await expect(
          queryAnalyticsReportOutputSetRowsFromD1(
            createEnv(database, queryTrace),
            plan,
            item.selection,
          ),
        ).rejects.toThrow(item.message);
        expect(queryTrace.preparedSql).toHaveLength(0);
      }
    } finally {
      database.close();
    }
  });

  it("rejects invalid final order descriptions before execution", async () => {
    const { database } = createDatabase();
    try {
      const invalidSelections = [
        {
          ...PATH_SELECTION,
          orderBy: [{ field: "label", direction: "sideways", nulls: "last" }],
        },
        {
          ...PATH_SELECTION,
          orderBy: [
            { field: "not-selected", direction: "asc", nulls: "first" },
          ],
        },
        {
          ...PATH_SELECTION,
          orderBy: [{ field: "label", direction: "asc", nulls: "sideways" }],
        },
      ] as unknown as AnalyticsReportMultiOutputSelection[];
      for (const invalid of invalidSelections) {
        const queryTrace = trace();
        await expect(
          queryAnalyticsReportOutputSetRowsFromD1(
            createEnv(database, queryTrace),
            createPlan(),
            invalid,
          ),
        ).rejects.toThrow("analytics_report_multi_output_order_invalid");
        expect(queryTrace.preparedSql).toHaveLength(0);
      }
    } finally {
      database.close();
    }
  });

  it("rejects malformed selection and projection contracts before execution", async () => {
    const { database } = createDatabase();
    try {
      const plan = createPlan();
      const pathOutput = plan.outputs.find((output) => output.id === "paths")!;
      const duplicateDeclaredPlan = {
        ...plan,
        outputs: plan.outputs.map((output) =>
          output.id === "paths"
            ? {
                ...output,
                fields: [
                  ...output.fields,
                  {
                    name: output.fields[0]!.name,
                    slot: output.fields[0]!.slot,
                  },
                ],
              }
            : output,
        ),
      } as ValidatedLogicalPlan;
      const missingSlotPlan = {
        ...plan,
        slots: plan.slots.filter(
          (slot) =>
            slot.id !==
            pathOutput.fields.find((field) => field.name === "label")!.slot,
        ),
      } as ValidatedLogicalPlan;
      const invalidSelections: Array<{
        readonly selection: AnalyticsReportMultiOutputSelection;
        readonly plan?: ValidatedLogicalPlan;
        readonly message: string;
      }> = [
        {
          selection: null as unknown as AnalyticsReportMultiOutputSelection,
          message: "analytics_report_multi_output_selection_invalid",
        },
        {
          selection: {
            ...PATH_SELECTION,
            extra: true,
          } as unknown as AnalyticsReportMultiOutputSelection,
          message: "analytics_report_multi_output_selection_invalid",
        },
        {
          selection: {
            ...PATH_SELECTION,
            outputIds: [],
          },
          message: "analytics_report_multi_output_ids_invalid",
        },
        {
          selection: {
            ...PATH_SELECTION,
            fields: [],
          },
          message: "analytics_report_multi_output_fields_invalid",
        },
        {
          selection: {
            ...PATH_SELECTION,
            fields: ["label", "label"],
          },
          message: "analytics_report_multi_output_fields_duplicate",
        },
        {
          selection: {
            ...PATH_SELECTION,
            orderBy: [
              { field: "label", direction: "asc", nulls: "first" },
              { field: "label", direction: "desc", nulls: "last" },
            ],
          },
          message: "analytics_report_multi_output_order_duplicate",
        },
        {
          plan: duplicateDeclaredPlan,
          selection: {
            ...PATH_SELECTION,
            outputIds: ["paths"],
          },
          message: "analytics_report_multi_output_declared_fields_duplicate",
        },
        {
          selection: {
            ...PATH_SELECTION,
            outputIds: ["paths"],
            fields: ["missing"],
            orderBy: [],
          },
          message: "analytics_report_multi_output_field_missing:missing",
        },
        {
          plan: missingSlotPlan,
          selection: {
            ...PATH_SELECTION,
            outputIds: ["paths"],
            fields: ["label"],
            orderBy: [],
          },
          message: "analytics_report_multi_output_slot_missing:",
        },
      ];

      for (const invalid of invalidSelections) {
        const queryTrace = trace();
        await expect(
          queryAnalyticsReportOutputSetRowsFromD1(
            createEnv(database, queryTrace),
            invalid.plan ?? plan,
            invalid.selection,
          ),
        ).rejects.toThrow(invalid.message);
        expect(queryTrace.preparedSql).toHaveLength(0);
      }
    } finally {
      database.close();
    }
  });
});
