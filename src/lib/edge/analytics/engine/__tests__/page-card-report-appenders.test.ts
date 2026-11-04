import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  constant,
  lowerLogicalPlan,
  project,
  union,
} from "@/lib/db";
import type { LogicalQueryNode, QuerySource } from "@/lib/db/query/plan";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { SourceNode } from "@/lib/edge/analytics/engine/logical/nodes";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import {
  appendPageCardDetailTitlesOutput,
  appendPageCardDetailTrendOutput,
  appendPageCardTitleRows,
  appendPageCardTitlesOutput,
  appendPageCardTrendOutput,
  appendPageCardTrendRows,
  buildPageCardDetailsPlan,
  buildPageCardTitlesPlan,
  buildPageCardTrendPlan,
  PAGE_CARD_DETAILS_OUTPUT_IDS,
} from "@/lib/edge/analytics/engine/page-card-details-report-plan";
import {
  appendPageCardMetricsPage,
  appendPageCardMetricsPageOutput,
  appendPageCardMetricsRollup,
  appendPageCardMetricsRollupOutput,
  buildPageCardMetricsPlan,
  buildPageCardMetricsRollupPlan,
  PAGE_CARD_METRICS_OUTPUT_ID,
  PAGE_CARD_METRICS_ROLLUP_OUTPUT_ID,
  type PageCardMetricsSourceInput,
} from "@/lib/edge/analytics/engine/page-card-metrics-report-plan";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";

const SITE_ID = "wave97c-page-card";
const CURRENT_START = Date.UTC(2026, 0, 2);
const DAY = 24 * 60 * 60 * 1000;
const CURRENT_TIME = createQueryTime(
  CURRENT_START,
  CURRENT_START + 2 * DAY,
  "UTC",
  CURRENT_START + 2 * DAY,
);
const PREPARATION_TIME = createQueryTime(
  CURRENT_START,
  CURRENT_START + 2 * DAY,
  "UTC",
  CURRENT_START + 2 * DAY,
);
const PREVIOUS_TIME = createQueryTime(
  CURRENT_START - 3 * DAY,
  CURRENT_START - DAY,
  "UTC",
  CURRENT_START + 2 * DAY,
);
const DETAIL_PATHNAMES = ["/docs", "/tie", "\u00a0/unicode\u00a0"] as const;
const ARTIFACT_DIRECTORY = process.env.WAVE97C_ARTIFACT_DIR?.trim();
const ARTIFACT_PHASE = process.env.WAVE97C_ARTIFACT_PHASE?.trim() || "after";
const BASELINE_DIRECTORY = process.env.WAVE97C_BASELINE_DIR?.trim();

type SourceMode = "ordinary" | "prepared-native" | "prepared-reader-window";
type BuilderName =
  "metrics-rollup" | "metrics-page" | "titles" | "trend" | "details";

const CASES: readonly {
  readonly builder: BuilderName;
  readonly mode: SourceMode;
  readonly outputIds: readonly string[];
}[] = [
  {
    builder: "metrics-rollup",
    mode: "ordinary",
    outputIds: [PAGE_CARD_METRICS_ROLLUP_OUTPUT_ID],
  },
  {
    builder: "metrics-rollup",
    mode: "prepared-native",
    outputIds: [PAGE_CARD_METRICS_ROLLUP_OUTPUT_ID],
  },
  {
    builder: "metrics-rollup",
    mode: "prepared-reader-window",
    outputIds: [PAGE_CARD_METRICS_ROLLUP_OUTPUT_ID],
  },
  {
    builder: "metrics-page",
    mode: "ordinary",
    outputIds: [PAGE_CARD_METRICS_OUTPUT_ID],
  },
  {
    builder: "metrics-page",
    mode: "prepared-native",
    outputIds: [PAGE_CARD_METRICS_OUTPUT_ID],
  },
  {
    builder: "metrics-page",
    mode: "prepared-reader-window",
    outputIds: [PAGE_CARD_METRICS_OUTPUT_ID],
  },
  {
    builder: "titles",
    mode: "ordinary",
    outputIds: [PAGE_CARD_DETAILS_OUTPUT_IDS.titles],
  },
  {
    builder: "titles",
    mode: "prepared-native",
    outputIds: [PAGE_CARD_DETAILS_OUTPUT_IDS.titles],
  },
  {
    builder: "titles",
    mode: "prepared-reader-window",
    outputIds: [PAGE_CARD_DETAILS_OUTPUT_IDS.titles],
  },
  {
    builder: "trend",
    mode: "ordinary",
    outputIds: [PAGE_CARD_DETAILS_OUTPUT_IDS.trend],
  },
  {
    builder: "trend",
    mode: "prepared-native",
    outputIds: [PAGE_CARD_DETAILS_OUTPUT_IDS.trend],
  },
  {
    builder: "trend",
    mode: "prepared-reader-window",
    outputIds: [PAGE_CARD_DETAILS_OUTPUT_IDS.trend],
  },
  {
    builder: "details",
    mode: "ordinary",
    outputIds: [
      PAGE_CARD_DETAILS_OUTPUT_IDS.detailTitles,
      PAGE_CARD_DETAILS_OUTPUT_IDS.detailTrend,
    ],
  },
  {
    builder: "details",
    mode: "prepared-native",
    outputIds: [
      PAGE_CARD_DETAILS_OUTPUT_IDS.detailTitles,
      PAGE_CARD_DETAILS_OUTPUT_IDS.detailTrend,
    ],
  },
  {
    builder: "details",
    mode: "prepared-reader-window",
    outputIds: [
      PAGE_CARD_DETAILS_OUTPUT_IDS.detailTitles,
      PAGE_CARD_DETAILS_OUTPUT_IDS.detailTrend,
    ],
  },
];

let database: DatabaseSync;
let preparedFilters: FilterDocument;
let preparedScopePlan: NonNullable<
  ReturnType<typeof scopedFilterMetadata>
>["plan"];

function insertPage(input: {
  readonly id: string;
  readonly time: number;
  readonly pathname: string | null;
  readonly sessionId: string | null;
  readonly visitorId: string | null;
  readonly durationMs: number | null;
  readonly title: string | null;
}): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname, duration_ms, title
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'wave97c.test', ?, ?)`,
    )
    .run(
      input.id,
      SITE_ID,
      1,
      input.visitorId ?? "__NULL_VISITOR__",
      input.sessionId ?? "__NULL_SESSION__",
      input.time,
      input.time,
      input.pathname ?? "__NULL_PATH__",
      input.durationMs,
      input.title ?? "__NULL_TITLE__",
    );
}

function createFixture(): DatabaseSync {
  const result = createMigratedDatabase();
  database = result;
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'wave97c-team', 'Page-card Appenders', 'wave97c.test', 0)`,
    )
    .run(SITE_ID);

  const currentAt = CURRENT_START + 60 * 60 * 1000;
  const previousAt = CURRENT_START - 2 * DAY;
  const currentPages = [
    ["current-docs-a1", "/docs", "shared", "visitor-a", 10, "Beta"],
    ["current-docs-a2", "/docs", "shared", "visitor-a", -5, "Alpha"],
    ["current-docs-b", "/docs", "solo", "visitor-b", null, "Alpha "],
    ["current-padded-docs", " /docs ", "padded", "visitor-p", 45.5, "Alpha"],
    [
      "current-unicode",
      "\u00a0/unicode\u00a0",
      "unicode",
      "visitor-u",
      20,
      " Unicode ",
    ],
    ["current-tie-z", "/tie", "tie-z", "visitor-z", 5, "Zed"],
    ["current-tie-a", "/tie", "tie-a", "visitor-a", 5, "A"],
    ["current-tie-empty", "/tie", "tie-empty", null, 0, ""],
    ["current-null-path", null, null, "", 100, null],
    ["current-blank-path", "   ", "blank", "blank", 100, "   "],
    ["current-empty-path", "", "empty", "empty", 100, ""],
  ] as const;
  for (const [
    id,
    pathname,
    sessionId,
    visitorId,
    durationMs,
    title,
  ] of currentPages)
    insertPage({
      id,
      time: currentAt,
      pathname,
      sessionId,
      visitorId,
      durationMs,
      title,
    });
  const previousPages = [
    ["previous-docs", "/docs", "previous", "visitor-prev", 30, "Previous"],
    [
      "previous-padded-docs",
      " /docs ",
      "previous-padded",
      "visitor-prev-padded",
      15,
      "Previous padded",
    ],
    [
      "previous-unicode",
      "\u00a0/unicode\u00a0",
      "previous-unicode",
      "visitor-prev-unicode",
      8,
      "Previous unicode",
    ],
  ] as const;
  for (const [
    id,
    pathname,
    sessionId,
    visitorId,
    durationMs,
    title,
  ] of previousPages)
    insertPage({
      id,
      time: previousAt,
      pathname,
      sessionId,
      visitorId,
      durationMs,
      title,
    });

  const columns = database.prepare("PRAGMA table_info(visits)").all() as {
    name: string;
  }[];
  const viewColumns = columns.map(({ name }) => {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const sentinel =
      name === "visitor_id"
        ? "__NULL_VISITOR__"
        : name === "session_id"
          ? "__NULL_SESSION__"
          : name === "pathname"
            ? "__NULL_PATH__"
            : name === "title"
              ? "__NULL_TITLE__"
              : null;
    return sentinel
      ? `CASE WHEN ${quoted} = '${sentinel}' THEN NULL ELSE ${quoted} END AS ${quoted}`
      : quoted;
  });
  database.exec("ALTER TABLE visits RENAME TO visits_storage");
  database.exec(
    `CREATE VIEW visits AS SELECT ${viewColumns.join(", ")} FROM visits_storage`,
  );

  const prepared = prepareScopedQuery("pages", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: PREPARATION_TIME,
    filters: EMPTY_FILTER_DOCUMENT,
    scopePreference: "session",
  } as never) as { readonly filters?: FilterDocument };
  if (!prepared.filters) throw new Error("wave97c_prepared_filter_missing");
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!metadata) throw new Error("wave97c_prepared_plan_missing");
  preparedFilters = prepared.filters;
  preparedScopePlan = metadata.plan;
  return database;
}

function sourceFor(mode: SourceMode): PageCardMetricsSourceInput {
  if (mode === "ordinary")
    return {
      siteId: SITE_ID,
      queryTime: CURRENT_TIME,
      filters: EMPTY_FILTER_DOCUMENT,
    };
  if (mode === "prepared-native")
    return {
      siteId: SITE_ID,
      queryTime: PREPARATION_TIME,
      filters: preparedFilters,
      scopePlan: preparedScopePlan,
    };
  return {
    siteId: SITE_ID,
    queryTime: PREVIOUS_TIME,
    filters: preparedFilters,
    scopePlan: preparedScopePlan,
    preparedTimePolicy: "reader-window-v1",
  };
}

function buildPlan(
  builder: BuilderName,
  source: PageCardMetricsSourceInput,
): ValidatedLogicalPlan {
  switch (builder) {
    case "metrics-rollup":
      return buildPageCardMetricsRollupPlan(source);
    case "metrics-page":
      return buildPageCardMetricsPlan({
        ...source,
        search: "/",
        sort: "views",
        direction: "desc",
        limit: 20,
      });
    case "titles":
      return buildPageCardTitlesPlan({
        ...source,
        pathnames: DETAIL_PATHNAMES,
        titleLimit: 2,
      });
    case "trend":
      return buildPageCardTrendPlan({
        ...source,
        pathnames: DETAIL_PATHNAMES,
        interval: "day",
      });
    case "details":
      return buildPageCardDetailsPlan({
        ...source,
        pathnames: DETAIL_PATHNAMES,
        titleLimit: 2,
        interval: "day",
      });
  }
}

function buildComposedPlan(): ValidatedLogicalPlan {
  const source = sourceFor("ordinary");
  const { builder, pages } = createPageReportSource({
    ...source,
    attributes: [
      "page.report.pathname",
      "page.report.sessionId",
      "page.report.visitorId",
      "page.report.durationMs",
      "page.report.title",
      "page.report.startedAt",
    ],
  });
  const pathname = builder.slot(pages, "attribute:page.report.pathname");
  const normalizedPathname = builder.normalizeString(
    builder.coalesce(
      pathname,
      builder.literal("", { kind: "scalar", scalar: "string" }),
    ),
    "trim-ascii-space",
  );
  const selectedPagePaths = builder.filter(
    pages,
    builder.and(
      builder.compare(
        "neq",
        normalizedPathname,
        builder.literal("", { kind: "scalar", scalar: "string" }),
      ),
      builder.in(
        normalizedPathname,
        DETAIL_PATHNAMES.map((value) =>
          builder.literal(value, { kind: "scalar", scalar: "string" }),
        ),
      ),
    ),
  );
  const selectedPaths = builder.distinct(selectedPagePaths, [
    { input: "attribute:page.report.pathname", output: "pathname" },
  ]);
  const selectedPages = builder.semiJoin(pages, selectedPaths, [
    { left: "attribute:page.report.pathname", right: "pathname" },
  ]);

  const metrics = appendPageCardMetricsRollup({
    builder,
    pages,
    pathnames: DETAIL_PATHNAMES,
  });
  appendPageCardMetricsRollupOutput(builder, metrics);
  const metricRows = appendPageCardMetricsPage(builder, metrics, {
    search: "/",
    sort: "views",
    direction: "desc",
    limit: 20,
  });
  appendPageCardMetricsPageOutput(builder, metricRows);

  const titleRows = appendPageCardTitleRows(builder, pages, selectedPages, 2);
  appendPageCardTitlesOutput(builder, titleRows);
  appendPageCardDetailTitlesOutput(builder, titleRows);

  const trendRows = appendPageCardTrendRows(
    builder,
    pages,
    selectedPages,
    "day",
  );
  appendPageCardTrendOutput(builder, trendRows);
  appendPageCardDetailTrendOutput(builder, trendRows);

  return builder.finish();
}

function readRows(plan: ValidatedLogicalPlan, outputId: string) {
  const captured = capturePlan(plan, [outputId]);
  return captured.outputs[0]!.rows;
}

function composeTaggedOutputs(plan: ValidatedLogicalPlan) {
  const siteIds = plan.context.subject.siteIds;
  if (!Array.isArray(siteIds) || siteIds.length !== 1)
    throw new Error("wave97c_expected_single_site_plan");
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId: siteIds[0]!,
    time: plan.context.time,
  });
  const lowered = lowerer.lowerMany(plan.outputs);
  const sourceNodeSets = lowered.map(({ relation }) =>
    reachableQueryNodes(relation),
  );
  const commonNodeKinds = [...sourceNodeSets[0]!]
    .filter((node) => sourceNodeSets.every((nodes) => nodes.has(node)))
    .map(({ kind }) => kind);
  const tagged = lowered.map((loweredOutput) => {
    const { output } = loweredOutput;
    const outputRelation = lowerer.projectOutput(
      loweredOutput,
      output.fields.map(({ name, slot }) => ({ name, slot })),
    );
    return project(outputRelation, {
      report: constant(output.id),
      pathname: outputRelation.columns.pathname!,
    });
  });
  const combined = tagged
    .slice(1)
    .reduce((left, right) => union(left, right, true), tagged[0]!);
  const physical = lowerLogicalPlan(combined);
  return {
    commonNodeKinds,
    physicalSharedRelationKinds: physical.sharedRelations.map(
      ({ node }) => node.kind,
    ),
    sql: compileD1Query(physical).sql,
  };
}

function reachableQueryNodes(source: QuerySource): Set<LogicalQueryNode> {
  const nodes = new Set<LogicalQueryNode>();
  const visit = (current: QuerySource) => {
    const { node } = current;
    if (nodes.has(node)) return;
    nodes.add(node);
    const children: readonly QuerySource[] =
      node.kind === "filter" ||
      node.kind === "project" ||
      node.kind === "aggregate" ||
      node.kind === "distinct" ||
      node.kind === "window" ||
      node.kind === "sort" ||
      node.kind === "limit"
        ? [node.input]
        : node.kind === "join" ||
            node.kind === "semi-join" ||
            node.kind === "anti-join" ||
            node.kind === "union"
          ? [node.left, node.right]
          : node.kind === "recursive-closure"
            ? [node.seed, node.candidates]
            : [];
    children.forEach(visit);
  };
  visit(source);
  return nodes;
}

function capturePlan(plan: ValidatedLogicalPlan, outputIds: readonly string[]) {
  const siteIds = plan.context.subject.siteIds;
  if (!Array.isArray(siteIds) || siteIds.length !== 1)
    throw new Error("wave97c_expected_single_site_plan");
  const sourceNodes = plan.nodes.filter(
    (node): node is SourceNode & { readonly entity: "page" } =>
      node.kind === "source" && node.entity === "page",
  );
  const outputs = outputIds.map((outputId) => {
    const output = plan.outputs.find((candidate) => candidate.id === outputId);
    if (!output) throw new Error(`wave97c_output_missing:${outputId}`);
    const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
      siteId: siteIds[0]!,
      time: plan.context.time,
    });
    const lowered = lowerer.lower(output);
    const relation = lowerer.projectOutput(
      lowered,
      output.fields.map(({ name, slot }) => ({ name, slot })),
    );
    const query = compileD1Query(lowerLogicalPlan(relation));
    const rows = database
      .prepare(query.sql)
      .all(...((query.bindings ?? []) as SQLInputValue[])) as Record<
      string,
      unknown
    >[];
    return {
      outputId,
      fields: output.fields.map(({ name, slot }) => ({ name, slot })),
      sql: query.sql,
      bindings: query.bindings ?? [],
      rows,
    };
  });
  return {
    logicalPlan: plan,
    pageSourceCount: sourceNodes.length,
    pageSources: sourceNodes.map((node) => {
      const selection = node.selection;
      if (!selection) throw new Error("wave97c_page_source_selection_missing");
      return {
        id: node.id,
        profile: selection.profile,
        attributes: node.values.flatMap((binding) =>
          binding.kind === "attribute" ? [binding.attribute] : [],
        ),
        time: selection.time,
        preparationTime: selection.preparationTime ?? null,
      };
    }),
    outputs,
  };
}

function caseId(builder: BuilderName, mode: SourceMode): string {
  return `${builder}-${mode}`;
}

describe("Page-card report appender baseline and composition", () => {
  beforeAll(() => {
    createFixture();
  });

  afterAll(() => {
    database?.close();
  });

  it.each(CASES)(
    "captures exact pre-refactor $builder ($mode)",
    ({ builder, mode, outputIds }) => {
      const evidence = capturePlan(
        buildPlan(builder, sourceFor(mode)),
        outputIds,
      );
      expect(evidence.pageSourceCount).toBe(1);
      const id = caseId(builder, mode);
      if (ARTIFACT_DIRECTORY) {
        mkdirSync(ARTIFACT_DIRECTORY, { recursive: true });
        writeFileSync(
          join(ARTIFACT_DIRECTORY, `${ARTIFACT_PHASE}-${id}.json`),
          JSON.stringify(evidence, null, 2),
        );
      }
      if (BASELINE_DIRECTORY) {
        const baseline = JSON.parse(
          readFileSync(join(BASELINE_DIRECTORY, `before-${id}.json`), "utf8"),
        ) as typeof evidence;
        expect(evidence).toEqual(baseline);
      }
    },
  );

  it("composes all Page-card appenders over one selected Page bag", () => {
    const plan = buildComposedPlan();
    const evidence = capturePlan(
      plan,
      plan.outputs.map(({ id }) => id),
    );
    expect(evidence.pageSourceCount).toBe(1);

    const source = sourceFor("ordinary");
    const standalonePlans = [
      buildPageCardMetricsRollupPlan({
        ...source,
        pathnames: DETAIL_PATHNAMES,
      }),
      buildPageCardMetricsPlan({
        ...source,
        pathnames: DETAIL_PATHNAMES,
        search: "/",
        sort: "views",
        direction: "desc",
        limit: 20,
      }),
      buildPageCardTitlesPlan({
        ...source,
        pathnames: DETAIL_PATHNAMES,
        titleLimit: 2,
      }),
      buildPageCardTrendPlan({
        ...source,
        pathnames: DETAIL_PATHNAMES,
        interval: "day",
      }),
      buildPageCardDetailsPlan({
        ...source,
        pathnames: DETAIL_PATHNAMES,
        titleLimit: 2,
        interval: "day",
      }),
    ];
    const expectedRows = new Map<string, Record<string, unknown>[]>();
    for (const [index, plan] of standalonePlans.entries()) {
      for (const { outputId, rows } of capturePlan(
        plan,
        index === 0
          ? [PAGE_CARD_METRICS_ROLLUP_OUTPUT_ID]
          : index === 1
            ? [PAGE_CARD_METRICS_OUTPUT_ID]
            : index === 2
              ? [PAGE_CARD_DETAILS_OUTPUT_IDS.titles]
              : index === 3
                ? [PAGE_CARD_DETAILS_OUTPUT_IDS.trend]
                : [
                    PAGE_CARD_DETAILS_OUTPUT_IDS.detailTitles,
                    PAGE_CARD_DETAILS_OUTPUT_IDS.detailTrend,
                  ],
      ).outputs) {
        expectedRows.set(outputId, rows);
      }
    }
    for (const outputId of expectedRows.keys()) {
      const actual = evidence.outputs.find(
        (output) => output.outputId === outputId,
      )?.rows;
      expect(actual, outputId).toEqual(expectedRows.get(outputId));
    }

    const generic = composeTaggedOutputs(plan);
    expect(generic.commonNodeKinds).toContain("scan");
    expect(generic.physicalSharedRelationKinds.length).toBeGreaterThan(0);
    expect(generic.sql).toContain("_d1_shared_");
    if (ARTIFACT_DIRECTORY)
      writeFileSync(
        join(ARTIFACT_DIRECTORY, "after-composed-shared-generic.json"),
        JSON.stringify({ evidence, generic }, null, 2),
      );
  });

  it("preserves Page-card limits, empty details, and zero title limit", () => {
    const source = sourceFor("ordinary");
    const zeroLimit = buildPageCardMetricsPlan({ ...source, limit: 0 });
    expect(readRows(zeroLimit, PAGE_CARD_METRICS_OUTPUT_ID)).toEqual([]);

    const withoutLimit = buildPageCardMetricsPlan(source);
    const negativeLimit = buildPageCardMetricsPlan({ ...source, limit: -3 });
    expect(
      capturePlan(negativeLimit, [PAGE_CARD_METRICS_OUTPUT_ID]).outputs[0]?.sql,
    ).toBe(
      capturePlan(withoutLimit, [PAGE_CARD_METRICS_OUTPUT_ID]).outputs[0]?.sql,
    );
    expect(() => buildPageCardMetricsPlan({ ...source, limit: 1.5 })).toThrow(
      "logical_builder_invalid_limit",
    );

    const emptyDetails = buildPageCardDetailsPlan({
      ...source,
      pathnames: [],
      titleLimit: 2,
      interval: "day",
    });
    expect(
      capturePlan(emptyDetails, [
        PAGE_CARD_DETAILS_OUTPUT_IDS.detailTitles,
        PAGE_CARD_DETAILS_OUTPUT_IDS.detailTrend,
      ]).outputs.map(({ rows }) => rows),
    ).toEqual([[], []]);

    const emptyTitles = buildPageCardTitlesPlan({
      ...source,
      pathnames: DETAIL_PATHNAMES,
      titleLimit: 0,
    });
    expect(readRows(emptyTitles, PAGE_CARD_DETAILS_OUTPUT_IDS.titles)).toEqual(
      [],
    );
  });
});
