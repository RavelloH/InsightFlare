import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  createD1DatabaseClient,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
  type DatabaseQueryObserver,
} from "@/lib/db";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  LogicalPlanBuilder,
  lowerFilterDocumentToScope,
} from "@/lib/edge/analytics/engine";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import type { NativePrimitiveFieldId } from "@/lib/edge/analytics/providers/d1/internal/analytics-primitive-predicate-lowering";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { analyzeFilterDocument } from "@/lib/filter-contract/filter-semantics";
import {
  type FilterDocument,
  type FilterOperator,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

const SITE_A = "native-text-site-a";
const SITE_B = "native-text-site-b";
const CANDIDATE_RANGE = { startMs: 100, endExclusiveMs: 200 } as const;
const FILTER_RANGE = { startMs: 200, endExclusiveMs: 300 } as const;
const READ_RANGE = { startMs: 0, endExclusiveMs: 100 } as const;

/** Frozen expected physical mapping, intentionally independent of production contracts. */
const NATIVE_TEXT_FIELDS = [
  { field: "utm.source", column: "utm_source", value: "newsletter" },
  { field: "utm.medium", column: "utm_medium", value: "email" },
  { field: "utm.campaign", column: "utm_campaign", value: "fall-launch" },
  { field: "utm.term", column: "utm_term", value: "running shoes" },
  { field: "utm.content", column: "utm_content", value: "hero-link" },
  { field: "client.browser", column: "browser", value: "Orion" },
  { field: "client.browserVersion", column: "browser_version", value: "125.4" },
  { field: "client.os", column: "os", value: "LumenOS" },
  { field: "client.language", column: "language", value: "en-GB" },
  { field: "geo.timeZone", column: "timezone", value: "Europe/London" },
  {
    field: "geo.organization",
    column: "as_organization",
    value: "Example Networks",
  },
  { field: "user.id", column: "user_id", value: "user-73" },
  { field: "user.name", column: "user_name", value: "Casey Example" },
] as const satisfies readonly {
  readonly field: NativePrimitiveFieldId;
  readonly column: string;
  readonly value: string;
}[];

const ECMASCRIPT_TRIM_CHARACTERS =
  "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

type NativeField = (typeof NATIVE_TEXT_FIELDS)[number];

function context(siteIds: readonly string[] = [SITE_A]) {
  return {
    subject: createSemanticSubjectDomain({
      siteIds: siteIds as never,
      origin: "site",
    }),
    time: createSemanticTemporalDomains({
      candidate: CANDIDATE_RANGE as never,
      filter: FILTER_RANGE as never,
      read: { kind: "bounded", range: READ_RANGE as never },
      reportingTimeZone: "UTC" as never,
      capturedAtMs: 300 as never,
    }),
    scope: resolveAnalyticsScope("session"),
  };
}

function insertSite(db: DatabaseSync, siteId: string): number {
  db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(siteId);
  return (
    db
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get(siteId) as {
      readonly site_pk: number;
    }
  ).site_pk;
}

function insertVisit(
  db: DatabaseSync,
  sitePk: number,
  siteId: string,
  visitId: string,
  sessionId: string,
  startedAt: number,
  values: Readonly<Record<string, string | null>> = {},
): void {
  db.prepare(
    `INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, status, started_at,
      last_activity_at, pathname, hostname, site_pk
    ) VALUES (?, ?, ?, ?, 'complete', ?, ?, '/native-text', 'example.test', ?)`,
  ).run(
    visitId,
    siteId,
    `visitor-${visitId}`,
    sessionId,
    startedAt,
    startedAt,
    sitePk,
  );
  for (const [column, value] of Object.entries(values)) {
    // Column names enter only from this test's hand-written fixtures/oracle.
    db.prepare(`UPDATE visits SET ${column} = ? WHERE visit_id = ?`).run(
      value,
      visitId,
    );
  }
}

function fieldValues(overrides: Readonly<Record<string, string | null>> = {}) {
  return Object.fromEntries([
    ...NATIVE_TEXT_FIELDS.map(({ column, value }) => [column, value] as const),
    ...Object.entries(overrides),
  ]);
}

function fieldCondition(
  field: NativePrimitiveFieldId,
  operator: FilterOperator,
  value?: string | readonly string[],
) {
  return {
    kind: "condition",
    target: { kind: "field", field },
    operator,
    ...(value === undefined ? {} : { value }),
  } as const;
}

function document(root: unknown): FilterDocument {
  return { version: 1, root } as unknown as FilterDocument;
}

function lowerDocument(
  input: unknown,
  temporalDomain: "candidate" | "filter" | "read" = "read",
) {
  const normalized = normalizeFilterDocument(input, analyticsFilterRegistry);
  const builder = new LogicalPlanBuilder(context());
  const lowered = lowerFilterDocumentToScope(
    builder,
    analyzeFilterDocument(normalized, analyticsFilterRegistry),
    { targetScope: "session", resolveTemporalDomain: () => temporalDomain },
  );
  if (lowered.kind !== "supported") {
    throw new Error(
      `Expected native text FilterDocument to lower; got ${lowered.kind}.`,
    );
  }
  builder.output("selected-sessions", lowered.selection.relation, [
    { name: "session", slot: "entity" },
  ]);
  const plan = builder.finish();
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId: SITE_A,
    time: plan.context.time,
  });
  const loweredOutput = lowerer.lower(plan.outputs[0]!);
  return {
    plan,
    query: compileD1Query(
      lowerer.projectOutput(loweredOutput, [
        {
          name: "site_pk",
          slot: plan.outputs[0]!.fields[0]!.slot,
          component: 0,
        },
        {
          name: "session_id",
          slot: plan.outputs[0]!.fields[0]!.slot,
          component: 1,
        },
      ]),
    ),
  };
}

async function executeDocument(
  db: DatabaseSync,
  input: unknown,
  temporalDomain: "candidate" | "filter" | "read" = "read",
): Promise<string[]> {
  const lowered = lowerDocument(input, temporalDomain);
  const rows = (
    await createD1DatabaseClient(createSqliteD1Database(db)).all(lowered.query)
  ).results as Array<{ readonly site_pk: number; readonly session_id: string }>;
  expect(rows.every((row) => Number.isSafeInteger(row.site_pk))).toBe(true);
  return rows.map((row) => row.session_id).sort();
}

function selectorDocument(
  operator: "exists" | "notExists",
  predicate: unknown,
): FilterDocument {
  return document({
    kind: "condition",
    target: {
      kind: "selector",
      collection: { kind: "entity-root", entity: "page" },
      predicate,
    },
    operator,
  });
}

function directPageQuery(
  db: DatabaseSync,
  options: {
    readonly domain: "candidate" | "filter" | "read";
    readonly field?: NativeField;
    readonly values?: readonly string[];
  },
) {
  const planContext = context();
  const builder = new LogicalPlanBuilder(planContext);
  const pages = builder.source("page", {
    temporalDomain: options.domain,
    attributes: NATIVE_TEXT_FIELDS.map(({ field }) => field),
  });
  const filtered = options.field
    ? builder.filter(
        pages,
        builder.compare(
          "eq",
          builder.slot(pages, `attribute:${options.field.field}`),
          builder.literal(options.values?.[0] ?? options.field.value, {
            kind: "scalar",
            scalar: "string",
          }),
          "trim",
        ),
      )
    : pages;
  builder.output("native-page-columns", filtered, [
    { name: "visit", slot: "entity" },
    ...NATIVE_TEXT_FIELDS.map(({ column, field }) => ({
      name: column,
      slot: `attribute:${field}`,
    })),
  ]);
  const plan = builder.finish();
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId: SITE_A,
    time: plan.context.time,
  });
  const lowered = lowerer.lower(plan.outputs[0]!);
  const query = compileD1Query(
    lowerer.projectOutput(lowered, [
      {
        name: "visit_id",
        slot: plan.outputs[0]!.fields[0]!.slot,
        component: 1,
      },
      ...plan.outputs[0]!.fields.slice(1).map(({ name, slot }) => ({
        name,
        slot,
      })),
    ]),
  );
  return { query, client: createD1DatabaseClient(createSqliteD1Database(db)) };
}

describe("Wave29 native Page text fields through migrated SQLite", () => {
  it("projects the hand-mapped visit columns and executes equality for all 13 fields", async () => {
    const db = createMigratedDatabase();
    try {
      const siteAPk = insertSite(db, SITE_A);
      insertSite(db, SITE_B);
      insertVisit(
        db,
        siteAPk,
        SITE_A,
        "all-native-columns",
        "s-all-columns",
        50,
        fieldValues(),
      );

      const projected = directPageQuery(db, { domain: "read" });
      const rows = (await projected.client.all(projected.query))
        .results as Array<Record<string, string | null>>;
      expect(rows).toEqual([
        {
          visit_id: "all-native-columns",
          ...Object.fromEntries(
            NATIVE_TEXT_FIELDS.map(({ column, value }) => [column, value]),
          ),
        },
      ]);

      for (const field of NATIVE_TEXT_FIELDS) {
        const visitId = `eq-${field.column}`;
        insertVisit(db, siteAPk, SITE_A, visitId, `s-${field.column}`, 51, {
          [field.column]: `\u00a0 ${field.value} \ufeff`,
        });
        const query = directPageQuery(db, { domain: "read", field });
        const eqRows = (await query.client.all(query.query)).results as Array<{
          readonly visit_id: string;
        }>;
        expect(eqRows.map((row) => row.visit_id).sort(), field.field).toEqual(
          ["all-native-columns", visitId].sort(),
        );
      }

      for (const domain of ["candidate", "filter", "read"] as const) {
        const time = { candidate: 150, filter: 250, read: 75 }[domain];
        const id = `domain-${domain}`;
        insertVisit(
          db,
          siteAPk,
          SITE_A,
          id,
          `s-domain-${domain}`,
          time,
          fieldValues(),
        );
        const result = directPageQuery(db, { domain });
        const domainRows = (await result.client.all(result.query))
          .results as Array<{
          readonly visit_id: string;
        }>;
        expect(
          domainRows.map((row) => row.visit_id),
          domain,
        ).toContain(id);
      }
    } finally {
      db.close();
    }
  });

  it("applies half-open boundaries to candidate, filter, and read Page sources", async () => {
    const db = createMigratedDatabase();
    try {
      const siteAPk = insertSite(db, SITE_A);
      const browserField = NATIVE_TEXT_FIELDS.find(
        ({ field }) => field === "client.browser",
      );
      if (!browserField)
        throw new Error("Expected client.browser oracle field.");

      const ranges = {
        candidate: CANDIDATE_RANGE,
        filter: FILTER_RANGE,
        read: READ_RANGE,
      } as const;
      for (const domain of ["candidate", "filter", "read"] as const) {
        const { startMs, endExclusiveMs } = ranges[domain];
        const marker = `half-open-${domain}-unique-marker`;
        const boundaryVisits = [
          { suffix: "before-start", time: startMs - 1 },
          { suffix: "at-start", time: startMs },
          { suffix: "before-end", time: endExclusiveMs - 1 },
          { suffix: "at-end", time: endExclusiveMs },
        ] as const;
        for (const visit of boundaryVisits) {
          insertVisit(
            db,
            siteAPk,
            SITE_A,
            `${domain}-${visit.suffix}`,
            `s-${domain}-${visit.suffix}`,
            visit.time,
            { browser: marker },
          );
        }

        const query = directPageQuery(db, {
          domain,
          field: browserField,
          values: [marker],
        });
        const rows = (await query.client.all(query.query)).results as Array<{
          readonly visit_id: string;
        }>;
        expect(
          rows.map((row) => row.visit_id).sort(),
          `${domain} uses [start, endExclusive)`,
        ).toEqual([`${domain}-at-start`, `${domain}-before-end`].sort());
      }
    } finally {
      db.close();
    }
  });

  it("uses the selected native Page field as evidence, with candidate, filter, and read domains", async () => {
    const db = createMigratedDatabase();
    try {
      const siteAPk = insertSite(db, SITE_A);
      const siteBPk = insertSite(db, SITE_B);
      for (const field of NATIVE_TEXT_FIELDS) {
        const sessionId = `s-${field.column}`;
        insertVisit(
          db,
          siteAPk,
          SITE_A,
          `candidate-${field.column}`,
          sessionId,
          150,
          fieldValues(),
        );
        insertVisit(
          db,
          siteAPk,
          SITE_A,
          `read-${field.column}`,
          sessionId,
          50,
          {
            [field.column]: ` ${field.value} `,
          },
        );
        insertVisit(
          db,
          siteAPk,
          SITE_A,
          `cross-field-candidate-${field.column}`,
          `x-${field.column}`,
          150,
          fieldValues(),
        );
        insertVisit(
          db,
          siteAPk,
          SITE_A,
          `cross-field-${field.column}`,
          `x-${field.column}`,
          50,
          {
            [field.column]: `other-${field.value}`,
          },
        );
      }
      // The same local session identity on a different site must not collide with Site A.
      insertVisit(
        db,
        siteBPk,
        SITE_B,
        "site-b-candidate",
        "s-utm_source",
        150,
        fieldValues(),
      );
      insertVisit(
        db,
        siteBPk,
        SITE_B,
        "site-b-read",
        "s-utm_source",
        50,
        fieldValues(),
      );

      for (const field of NATIVE_TEXT_FIELDS) {
        const selected = await executeDocument(
          db,
          document(fieldCondition(field.field, "eq", field.value)),
        );
        expect(selected, field.field).toEqual([`s-${field.column}`]);
      }

      const domainValue = "domain-mark";
      for (const domain of ["candidate", "filter", "read"] as const) {
        insertVisit(
          db,
          siteAPk,
          SITE_A,
          `domain-candidate-${domain}`,
          `s-domain-${domain}`,
          150,
          {
            ...fieldValues(),
            browser: domain === "candidate" ? domainValue : "candidate-other",
          },
        );
        if (domain === "filter") {
          insertVisit(
            db,
            siteAPk,
            SITE_A,
            "domain-filter-evidence",
            "s-domain-filter",
            250,
            {
              browser: domainValue,
            },
          );
        }
        if (domain === "read") {
          insertVisit(
            db,
            siteAPk,
            SITE_A,
            "domain-read-evidence",
            "s-domain-read",
            50,
            {
              browser: domainValue,
            },
          );
        }
      }
      expect(
        await executeDocument(
          db,
          document(fieldCondition("client.browser", "eq", domainValue)),
          "candidate",
        ),
      ).toEqual(["s-domain-candidate"]);
      expect(
        await executeDocument(
          db,
          document(fieldCondition("client.browser", "eq", domainValue)),
          "filter",
        ),
      ).toEqual(["s-domain-filter"]);
      expect(
        await executeDocument(
          db,
          document(fieldCondition("client.browser", "eq", domainValue)),
          "read",
        ),
      ).toEqual(["s-domain-read"]);
    } finally {
      db.close();
    }
  });

  it("covers trimmed text operators, ECMAScript whitespace, case, NUL, wildcards, and empty values", async () => {
    const db = createMigratedDatabase();
    try {
      const siteAPk = insertSite(db, SITE_A);
      const candidate = (name: string) =>
        insertVisit(
          db,
          siteAPk,
          SITE_A,
          `candidate-${name}`,
          `s-${name}`,
          150,
          {
            browser: "candidate-value",
            user_name: "candidate-user",
          },
        );
      const read = (
        name: string,
        browser: string | null,
        userName: string | null = "present",
      ) => {
        candidate(name);
        insertVisit(db, siteAPk, SITE_A, `read-${name}`, `s-${name}`, 50, {
          browser,
          user_name: userName,
        });
      };

      read(
        "trim-all-whitespace",
        `${ECMASCRIPT_TRIM_CHARACTERS}Needle${[...ECMASCRIPT_TRIM_CHARACTERS].reverse().join("")}`,
      );
      read("case-lower", "needle");
      read("contains", "alpha-middle-omega");
      read("starts", "prefix-middle-suffix");
      read("ends", "another-middle-suffix");
      read("percent-underscore", "literal%_marker");
      read("percent-underscore-near", "literalXY_marker");
      read("nul", "prefix\u0000suffix");
      read("empty", "");
      read("whitespace-empty", "\u00a0 \t\ufeff");
      read("null-name", "ordinary", null);
      read("other-name", "ordinary", "Casey");

      expect(
        await executeDocument(
          db,
          document(fieldCondition("client.browser", "eq", "Needle")),
        ),
      ).toEqual(["s-trim-all-whitespace"]);
      expect(
        await executeDocument(
          db,
          document(fieldCondition("client.browser", "eq", "Needle")),
        ),
      ).not.toContain("s-case-lower");

      const cases: readonly {
        readonly name: string;
        readonly field: NativePrimitiveFieldId;
        readonly operator: FilterOperator;
        readonly value?: string | readonly string[];
        readonly expected: readonly string[];
      }[] = [
        {
          name: "eq",
          field: "client.browser",
          operator: "eq",
          value: "needle",
          expected: ["s-case-lower"],
        },
        {
          name: "neq",
          field: "client.browser",
          operator: "neq",
          value: "needle",
          expected: [
            "s-contains",
            "s-ends",
            "s-empty",
            "s-nul",
            "s-null-name",
            "s-other-name",
            "s-percent-underscore",
            "s-percent-underscore-near",
            "s-starts",
            "s-trim-all-whitespace",
            "s-whitespace-empty",
          ],
        },
        {
          name: "in",
          field: "client.browser",
          operator: "in",
          value: ["alpha-middle-omega", "another-middle-suffix"],
          expected: ["s-contains", "s-ends"],
        },
        {
          name: "notIn",
          field: "client.browser",
          operator: "notIn",
          value: ["alpha-middle-omega", "another-middle-suffix"],
          expected: [
            "s-case-lower",
            "s-empty",
            "s-nul",
            "s-null-name",
            "s-other-name",
            "s-percent-underscore",
            "s-percent-underscore-near",
            "s-starts",
            "s-trim-all-whitespace",
            "s-whitespace-empty",
          ],
        },
        {
          name: "contains",
          field: "client.browser",
          operator: "contains",
          value: "middle",
          expected: ["s-contains", "s-ends", "s-starts"],
        },
        {
          name: "startsWith",
          field: "client.browser",
          operator: "startsWith",
          value: "prefix",
          expected: ["s-nul", "s-starts"],
        },
        {
          name: "endsWith",
          field: "client.browser",
          operator: "endsWith",
          value: "suffix",
          expected: ["s-ends", "s-nul", "s-starts"],
        },
        {
          name: "literal percent/underscore",
          field: "client.browser",
          operator: "contains",
          value: "%_",
          expected: ["s-percent-underscore"],
        },
        {
          name: "NUL equality",
          field: "client.browser",
          operator: "eq",
          value: "prefix\u0000suffix",
          expected: ["s-nul"],
        },
        {
          name: "empty equality",
          field: "client.browser",
          operator: "eq",
          value: "",
          expected: ["s-empty", "s-whitespace-empty"],
        },
        {
          name: "nullable user.name isNull",
          field: "user.name",
          operator: "isNull",
          expected: ["s-null-name"],
        },
        {
          name: "nullable user.name notNull",
          field: "user.name",
          operator: "notNull",
          expected: [
            "s-case-lower",
            "s-contains",
            "s-empty",
            "s-ends",
            "s-nul",
            "s-other-name",
            "s-percent-underscore",
            "s-percent-underscore-near",
            "s-starts",
            "s-trim-all-whitespace",
            "s-whitespace-empty",
          ],
        },
      ];
      for (const item of cases) {
        expect(
          await executeDocument(
            db,
            document(fieldCondition(item.field, item.operator, item.value)),
          ),
          item.name,
        ).toEqual([...item.expected].sort());
      }

      expect(ECMASCRIPT_TRIM_CHARACTERS).toHaveLength(25);
    } finally {
      db.close();
    }
  });

  it("uses raw Page evidence for root Page exists/notExists without adding an Observation anchor", async () => {
    const db = createMigratedDatabase();
    try {
      const siteAPk = insertSite(db, SITE_A);
      const seed = (name: string, browser: string) => {
        insertVisit(
          db,
          siteAPk,
          SITE_A,
          `candidate-${name}`,
          `s-${name}`,
          150,
          {
            browser: "candidate",
          },
        );
        insertVisit(db, siteAPk, SITE_A, `read-${name}`, `s-${name}`, 50, {
          browser,
        });
      };
      seed("page-hit", "Unique Native Page Value");
      seed("page-miss", "unrelated");
      insertVisit(
        db,
        siteAPk,
        SITE_A,
        "candidate-event-owner-only",
        "s-event-owner-only",
        150,
        {
          browser: "candidate",
        },
      );
      insertVisit(
        db,
        siteAPk,
        SITE_A,
        "outside-read-event-owner",
        "s-event-owner-only",
        350,
        {
          browser: "Unique Native Page Value",
        },
      );
      db.prepare(
        `INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk)
         VALUES (?, ?, ?, ?)`,
      ).run(SITE_A, "activity", 1, siteAPk);
      const eventNameId = (
        db
          .prepare(
            "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?",
          )
          .get(siteAPk, "activity") as { readonly id: number }
      ).id;
      db.prepare(
        `INSERT INTO custom_events (
          event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
          received_at, node_count, value_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      ).run(
        "event-on-owner-page",
        SITE_A,
        siteAPk,
        "outside-read-event-owner",
        eventNameId,
        50,
        50,
      );

      const predicate = fieldCondition(
        "client.browser",
        "eq",
        "Unique Native Page Value",
      );
      const existsDoc = selectorDocument("exists", predicate);
      const notExistsDoc = selectorDocument("notExists", predicate);
      const exists = await executeDocument(db, existsDoc);
      const notExists = await executeDocument(db, notExistsDoc);
      expect(exists).toEqual(["s-page-hit"]);
      expect(notExists).toEqual(["s-event-owner-only", "s-page-miss"]);
      expect(exists).not.toContain("s-event-owner-only");

      const normalized = normalizeFilterDocument(
        existsDoc,
        analyticsFilterRegistry,
      );
      const builder = new LogicalPlanBuilder(context());
      const lowered = lowerFilterDocumentToScope(
        builder,
        analyzeFilterDocument(normalized, analyticsFilterRegistry),
        { targetScope: "session", resolveTemporalDomain: () => "read" },
      );
      expect(lowered.kind).toBe("supported");
      const finalPlan = builder.finish();
      const observationAttributeBindings = finalPlan.nodes.flatMap((node) =>
        node.kind === "source" && node.entity === "observation"
          ? node.values.filter((binding) => binding.kind === "attribute")
          : [],
      );
      expect(
        observationAttributeBindings,
        "candidate Observation identity may bound the Session universe but cannot carry Page text attributes",
      ).toEqual([]);
      const pageAttributeBindings = finalPlan.nodes.flatMap((node) =>
        node.kind === "source" && node.entity === "page"
          ? node.values.filter((binding) => binding.kind === "attribute")
          : [],
      );
      expect(
        pageAttributeBindings.some(
          (binding) =>
            binding.kind === "attribute" &&
            binding.attribute === "client.browser",
        ),
      ).toBe(true);
      expect(
        finalPlan.nodes.some(
          (node) => node.kind === "source" && node.entity === "event",
        ),
      ).toBe(false);

      const eventRootDocument = document({
        kind: "condition",
        target: {
          kind: "selector",
          collection: { kind: "entity-root", entity: "event" },
          predicate,
        },
        operator: "exists",
      });
      const eventBuilder = new LogicalPlanBuilder(context());
      const eventLowering = lowerFilterDocumentToScope(
        eventBuilder,
        analyzeFilterDocument(
          normalizeFilterDocument(eventRootDocument, analyticsFilterRegistry),
          analyticsFilterRegistry,
        ),
        { targetScope: "session", resolveTemporalDomain: () => "read" },
      );
      expect(eventLowering).toMatchObject({
        kind: "unsupported",
        code: "unsupported-native-entity",
        fieldId: "client.browser",
      });
      expect(eventBuilder.finish().nodes).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("propagates native Page projection demand across A/B/A logical outputs", async () => {
    const db = createMigratedDatabase();
    try {
      const siteAPk = insertSite(db, SITE_A);
      insertVisit(db, siteAPk, SITE_A, "page-a", "s-a", 50, {
        browser: "Browser A",
        as_organization: "Organization A",
      });
      insertVisit(db, siteAPk, SITE_A, "page-b", "s-b", 51, {
        browser: "Browser B",
        as_organization: "Organization B",
      });

      const builder = new LogicalPlanBuilder(context());
      const pages = builder.source("page", {
        temporalDomain: "read",
        attributes: ["client.browser", "geo.organization"],
      });
      const outputFields = {
        browser: [
          { name: "visit", slot: "entity" },
          { name: "browser", slot: "attribute:client.browser" },
        ],
        organization: [
          { name: "visit", slot: "entity" },
          { name: "organization", slot: "attribute:geo.organization" },
        ],
      } as const;
      builder.output("A", pages, outputFields.browser);
      builder.output("B", pages, outputFields.organization);
      builder.output("AAgain", pages, outputFields.browser);
      const plan = builder.finish();
      const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
        siteId: SITE_A,
        time: plan.context.time,
      });
      const queries = plan.outputs.map((output) => {
        const lowered = lowerer.lower(output);
        return compileD1Query(
          lowerer.projectOutput(
            lowered,
            output.fields.map(({ name, slot }) =>
              name === "visit" ? { name, slot, component: 1 } : { name, slot },
            ),
          ),
        );
      });

      expect(queries[0]!.sql).toBe(queries[2]!.sql);
      expect(queries[0]!.bindings).toEqual(queries[2]!.bindings);
      expect(queries[0]!.physicalPlanShape).toEqual(
        queries[2]!.physicalPlanShape,
      );
      const selectedColumns = queries.map((query) =>
        query.sql.slice(0, query.sql.indexOf(" FROM ")),
      );
      expect(selectedColumns[0]).toContain('AS "visit"');
      expect(selectedColumns[0]).toContain('AS "browser"');
      expect(selectedColumns[0]).not.toContain('AS "organization"');
      expect(selectedColumns[1]).toContain('AS "visit"');
      expect(selectedColumns[1]).toContain('AS "organization"');
      expect(selectedColumns[1]).not.toContain('AS "browser"');

      const queryHashes: Array<string | null> = [];
      const completedQueries: Array<Promise<void>> = [];
      const observer: DatabaseQueryObserver = {
        begin({ statementCount }) {
          let releaseSession!: () => void;
          const completed = new Promise<void>((resolve) => {
            releaseSession = resolve;
          });
          completedQueries.push(completed);
          return {
            statementIndexes: Array.from(
              { length: statementCount },
              (_, index) => index,
            ),
            includeBatchSummary: false,
            record(event) {
              queryHashes.push(event.physicalPlanHash);
            },
            release: releaseSession,
          };
        },
      };
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const client = createD1DatabaseClient(createSqliteD1Database(db, trace), {
        observer,
      });
      const results: Array<Array<Record<string, string>>> = [];
      for (const [index, query] of queries.entries()) {
        const result = await client.all(query);
        results.push(
          (result.results as Array<Record<string, string>>).sort(
            (left, right) => left.visit!.localeCompare(right.visit!),
          ),
        );
        await completedQueries[index];
      }

      expect(results).toEqual([
        [
          { visit: "page-a", browser: "Browser A" },
          { visit: "page-b", browser: "Browser B" },
        ],
        [
          { visit: "page-a", organization: "Organization A" },
          { visit: "page-b", organization: "Organization B" },
        ],
        [
          { visit: "page-a", browser: "Browser A" },
          { visit: "page-b", browser: "Browser B" },
        ],
      ]);
      expect(trace.preparedSql).toEqual(queries.map(({ sql }) => sql));
      expect(trace.preparedSql).toHaveLength(3);
      const aQueryCost = {
        sqlUtf8Bytes: new TextEncoder().encode(queries[0]!.sql).length,
        bindingCount: queries[0]!.bindings?.length ?? 0,
      };
      expect(aQueryCost.sqlUtf8Bytes).toBeLessThanOrEqual(
        D1_MAX_SQL_UTF8_BYTES,
      );
      expect(aQueryCost.bindingCount).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      const aQueryPlan = explainQueryPlan(db, queries[0]!).join("\n");
      expect(aQueryPlan).toMatch(
        /SEARCH \w+ USING INDEX idx_visits_site_pk_started_at \(site_pk=\? AND started_at>\? AND started_at<\?\)/u,
      );
      expect(queryHashes).toHaveLength(3);
      expect(queryHashes[0]).toMatch(/^v8:/u);
      expect(queryHashes[0]).toBe(queryHashes[2]);
      expect(queryHashes[0]).not.toBe(queryHashes[1]);
    } finally {
      db.close();
    }
  });

  it("keeps candidate session identities bounded and compiles 1,200-string membership within D1 budgets", async () => {
    const db = createMigratedDatabase();
    try {
      const siteAPk = insertSite(db, SITE_A);
      insertVisit(db, siteAPk, SITE_A, "candidate-empty-local-id", "", 150, {
        browser: "match",
      });
      insertVisit(db, siteAPk, SITE_A, "candidate-bulk", "s-bulk", 150, {
        browser: "target-1199",
      });
      insertVisit(db, siteAPk, SITE_A, "read-bulk", "s-bulk", 50, {
        browser: "target-1199",
      });

      const bulkBuilder = new LogicalPlanBuilder(context());
      const bulkPages = bulkBuilder.source("page", {
        temporalDomain: "read",
        attributes: ["client.browser"],
      });
      const bulkBrowser = bulkBuilder.slot(
        bulkPages,
        "attribute:client.browser",
      );
      const values = Array.from(
        { length: 1200 },
        (_, index) => `target-${index}`,
      );
      const literals = values.map((value) =>
        bulkBuilder.literal(value, { kind: "scalar", scalar: "string" }),
      );
      const bulkFiltered = bulkBuilder.filter(
        bulkPages,
        bulkBuilder.in(bulkBrowser, literals, false, "trim"),
      );
      bulkBuilder.output("bulk-page", bulkFiltered, [
        { name: "visit", slot: "entity" },
      ]);
      const bulkPlan = bulkBuilder.finish();
      const bulkLowerer = new AnalyticsLogicalToDbLowerer(bulkPlan, {
        siteId: SITE_A,
        time: bulkPlan.context.time,
      });
      const bulkOutput = bulkLowerer.lower(bulkPlan.outputs[0]!);
      const bulkQuery = compileD1Query(
        bulkLowerer.projectOutput(bulkOutput, [
          {
            name: "visit_id",
            slot: bulkPlan.outputs[0]!.fields[0]!.slot,
            component: 1,
          },
        ]),
      );
      expect(
        new TextEncoder().encode(bulkQuery.sql).length,
      ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(bulkQuery.bindings?.length ?? 0).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      const bulkRows = (
        await createD1DatabaseClient(createSqliteD1Database(db)).all(bulkQuery)
      ).results as Array<{ readonly visit_id: string }>;
      expect(bulkRows).toEqual([{ visit_id: "read-bulk" }]);

      const notExists = await executeDocument(
        db,
        selectorDocument(
          "notExists",
          fieldCondition("client.browser", "eq", "match"),
        ),
      );
      expect(notExists).toEqual(["s-bulk"]);
      expect(notExists).not.toContain("");
    } finally {
      db.close();
    }
  });
});
