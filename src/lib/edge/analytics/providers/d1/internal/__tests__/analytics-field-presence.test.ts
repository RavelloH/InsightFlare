import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { compileD1Query, createD1DatabaseClient } from "@/lib/db";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import {
  LogicalPlanBuilder,
  lowerFilterDocumentToScope,
} from "@/lib/edge/analytics/engine";
import { semanticAttribute } from "@/lib/edge/analytics/engine/semantic/attributes";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { lowerAnalyticsPagePathToSessionQuery } from "@/lib/edge/analytics/providers/d1/internal/analytics-page-session-lowering";
import {
  nativePrimitiveFieldContract,
  type NativePrimitiveFieldId,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-primitive-predicate-lowering";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import {
  analyticsFilterRegistry,
  filterConditionEntity,
} from "@/lib/filter-contract/filter-registry";
import { analyzeFilterDocument } from "@/lib/filter-contract/filter-semantics";
import {
  type FilterConditionEntity,
  type FilterDocument,
  type FilterOperator,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

const SITE_A = "wave30-presence-a";
const SITE_B = "wave30-presence-b";
const CANDIDATE_RANGE = { startMs: 100, endExclusiveMs: 200 } as const;
const FILTER_RANGE = { startMs: 200, endExclusiveMs: 300 } as const;
const READ_RANGE = { startMs: 0, endExclusiveMs: 100 } as const;
const PRESENCE_OPERATORS = [
  "exists",
  "notExists",
  "isEmpty",
  "notEmpty",
] as const;
type PresenceOperator = (typeof PRESENCE_OPERATORS)[number];

type NativeFieldOracle = {
  readonly field: NativePrimitiveFieldId;
  /** Physical storage column, hand-frozen independently of the adapter map. */
  readonly column: string;
  readonly activity: "page" | "event";
  readonly value: string;
  readonly valueKind: "string" | "enum";
  readonly profile: "trimmed-text" | "case-folded-text" | "direct-referrer";
  readonly comparison: "case-sensitive" | "case-insensitive";
  readonly storageNullable: boolean;
  readonly nullable: boolean;
};

/**
 * Independent field-to-storage and value-semantics oracle for all 26 native
 * string/enum fields: the prior 18 raw fields followed by the 8 Wave30 fields.
 * Expected SQL and result sets below use this table and literal raw-SQL rules,
 * never nativePrimitiveFieldContract or a production predicate helper.
 */
const NATIVE_FIELD_ORACLE = [
  {
    field: "page.path",
    column: "pathname",
    activity: "page",
    value: "/native-path",
    valueKind: "string",
    profile: "trimmed-text",
    comparison: "case-sensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "page.title",
    column: "title",
    activity: "page",
    value: "Native Title",
    valueKind: "string",
    profile: "trimmed-text",
    comparison: "case-sensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "page.query",
    column: "query_string",
    activity: "page",
    value: "utm_source=wave30",
    valueKind: "string",
    profile: "trimmed-text",
    comparison: "case-sensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "page.hash",
    column: "hash_fragment",
    activity: "page",
    value: "section-wave30",
    valueKind: "string",
    profile: "trimmed-text",
    comparison: "case-sensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "event.name",
    column: "name",
    activity: "event",
    value: "purchase",
    valueKind: "string",
    profile: "trimmed-text",
    comparison: "case-sensitive",
    storageNullable: false,
    nullable: false,
  },
  {
    field: "utm.source",
    column: "utm_source",
    activity: "page",
    value: "newsletter",
    valueKind: "string",
    profile: "trimmed-text",
    comparison: "case-sensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "utm.medium",
    column: "utm_medium",
    activity: "page",
    value: "email",
    valueKind: "string",
    profile: "trimmed-text",
    comparison: "case-sensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "utm.campaign",
    column: "utm_campaign",
    activity: "page",
    value: "wave30-launch",
    valueKind: "string",
    profile: "trimmed-text",
    comparison: "case-sensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "utm.term",
    column: "utm_term",
    activity: "page",
    value: "running-shoes",
    valueKind: "string",
    profile: "trimmed-text",
    comparison: "case-sensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "utm.content",
    column: "utm_content",
    activity: "page",
    value: "hero-link",
    valueKind: "string",
    profile: "trimmed-text",
    comparison: "case-sensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "client.browser",
    column: "browser",
    activity: "page",
    value: "Orion",
    valueKind: "string",
    profile: "trimmed-text",
    comparison: "case-sensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "client.browserVersion",
    column: "browser_version",
    activity: "page",
    value: "125.4",
    valueKind: "string",
    profile: "trimmed-text",
    comparison: "case-sensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "client.os",
    column: "os",
    activity: "page",
    value: "LumenOS",
    valueKind: "string",
    profile: "trimmed-text",
    comparison: "case-sensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "client.language",
    column: "language",
    activity: "page",
    value: "en-GB",
    valueKind: "string",
    profile: "trimmed-text",
    comparison: "case-sensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "geo.timeZone",
    column: "timezone",
    activity: "page",
    value: "Europe/London",
    valueKind: "string",
    profile: "trimmed-text",
    comparison: "case-sensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "geo.organization",
    column: "as_organization",
    activity: "page",
    value: "Example Networks",
    valueKind: "string",
    profile: "trimmed-text",
    comparison: "case-sensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "user.id",
    column: "user_id",
    activity: "page",
    value: "user-73",
    valueKind: "string",
    profile: "trimmed-text",
    comparison: "case-sensitive",
    storageNullable: true,
    nullable: true,
  },
  {
    field: "user.name",
    column: "user_name",
    activity: "page",
    value: "Casey Example",
    valueKind: "string",
    profile: "trimmed-text",
    comparison: "case-sensitive",
    storageNullable: true,
    nullable: true,
  },
  {
    field: "page.hostname",
    column: "hostname",
    activity: "page",
    value: "insightflare.example",
    valueKind: "string",
    profile: "case-folded-text",
    comparison: "case-insensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "referrer.domain",
    column: "referrer_host",
    activity: "page",
    value: "search.example",
    valueKind: "string",
    profile: "direct-referrer",
    comparison: "case-insensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "referrer.url",
    column: "referrer_url",
    activity: "page",
    value: "https://search.example/result?q=wave30",
    valueKind: "string",
    profile: "direct-referrer",
    comparison: "case-insensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "client.deviceType",
    column: "device_type",
    activity: "page",
    value: "desktop",
    valueKind: "enum",
    profile: "case-folded-text",
    comparison: "case-insensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "geo.country",
    column: "country",
    activity: "page",
    value: "GB",
    valueKind: "enum",
    profile: "case-folded-text",
    comparison: "case-insensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "geo.region",
    column: "region",
    activity: "page",
    value: "West Midlands",
    valueKind: "string",
    profile: "case-folded-text",
    comparison: "case-insensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "geo.city",
    column: "city",
    activity: "page",
    value: "Birmingham",
    valueKind: "string",
    profile: "case-folded-text",
    comparison: "case-insensitive",
    storageNullable: false,
    nullable: true,
  },
  {
    field: "geo.continent",
    column: "continent",
    activity: "page",
    value: "EU",
    valueKind: "enum",
    profile: "case-folded-text",
    comparison: "case-insensitive",
    storageNullable: false,
    nullable: true,
  },
] as const satisfies readonly NativeFieldOracle[];

const CONDITION_ENTITY_ORACLE: Readonly<
  Record<NativePrimitiveFieldId, FilterConditionEntity>
> = {
  "page.path": "page",
  "page.title": "page",
  "page.query": "page",
  "page.hash": "page",
  "event.name": "event",
  "utm.source": "activity",
  "utm.medium": "activity",
  "utm.campaign": "activity",
  "utm.term": "activity",
  "utm.content": "activity",
  "client.browser": "activity",
  "client.browserVersion": "activity",
  "client.os": "activity",
  "client.language": "activity",
  "geo.timeZone": "activity",
  "geo.organization": "activity",
  "user.id": "activity",
  "user.name": "activity",
  "page.hostname": "page",
  "referrer.domain": "activity",
  "referrer.url": "activity",
  "client.deviceType": "activity",
  "geo.country": "activity",
  "geo.region": "activity",
  "geo.city": "activity",
  "geo.continent": "activity",
};

const PAGE_FIELDS = NATIVE_FIELD_ORACLE.filter(
  (field) => field.activity === "page",
);
const CASE_FOLD_FIELDS = NATIVE_FIELD_ORACLE.filter(
  (field) => field.comparison === "case-insensitive",
);
const RAW_VALUES = [
  { key: "empty", value: "" },
  { key: "space", value: " \t" },
  { key: "nbsp", value: "\u00a0" },
  { key: "unicode", value: "café 東京 🐈" },
  { key: "nul", value: "left\u0000right" },
  { key: "direct", value: "__direct__" },
  { key: "value", value: "Wave30 Value" },
] as const;
const RAW_PRESENCE_EXPECTATIONS: Readonly<
  Record<PresenceOperator, readonly string[]>
> = {
  exists: [
    "s-empty",
    "s-null-user-id",
    "s-null-user-name",
    "s-direct",
    "s-nbsp",
    "s-nul",
    "s-space",
    "s-unicode",
    "s-value",
  ],
  notExists: [],
  isEmpty: ["s-empty"],
  notEmpty: [
    "s-null-user-id",
    "s-null-user-name",
    "s-direct",
    "s-nbsp",
    "s-nul",
    "s-space",
    "s-unicode",
    "s-value",
  ],
};
const ALL_CANDIDATE_SESSION_IDS = [
  "s-empty",
  "s-direct",
  "s-null-user-id",
  "s-null-user-name",
  "s-nbsp",
  "s-nul",
  "s-space",
  "s-unicode",
  "s-value",
  "s-event-empty",
  "s-event-nbsp",
  "s-event-nul",
  "s-event-direct",
  "s-event-space",
  "s-event-unicode",
  "s-event-value",
  "s-event-no-evidence",
  "s-event-foreign-name",
] as const;
const RANGE_BY_DOMAIN = {
  candidate: CANDIDATE_RANGE,
  filter: FILTER_RANGE,
  read: READ_RANGE,
} as const;

/** Explicit raw SQL oracle for SQL NULL and exact empty-string presence. */
const RAW_PRESENCE_SQL: Readonly<
  Record<PresenceOperator, (column: string) => string>
> = {
  exists: (column) => column + " IS NOT NULL",
  notExists: (column) => column + " IS NULL",
  isEmpty: (column) => column + " IS NOT NULL AND " + column + " = ''",
  notEmpty: (column) => column + " IS NOT NULL AND " + column + " != ''",
};

function fieldCondition(
  field: string,
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

function planContext(
  targetScope: "session" | "visitor" = "session",
  siteIds: readonly string[] = [SITE_A],
) {
  return {
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: siteIds as never,
    }),
    time: createSemanticTemporalDomains({
      candidate: CANDIDATE_RANGE as never,
      filter: FILTER_RANGE as never,
      read: { kind: "bounded", range: READ_RANGE as never },
      reportingTimeZone: "UTC" as never,
      capturedAtMs: 300 as never,
    }),
    scope: resolveAnalyticsScope(targetScope),
  };
}

function insertSite(db: DatabaseSync, siteId: string): number {
  db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(siteId);
  return (
    db
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get(siteId) as { readonly site_pk: number }
  ).site_pk;
}

function insertVisit(
  db: DatabaseSync,
  siteId: string,
  sitePk: number,
  visitId: string,
  sessionId: string,
  startedAt: number,
  values: Readonly<Record<string, string | null>> = {},
  visitorId = "visitor-" + visitId,
): void {
  db.prepare(
    "INSERT INTO visits (" +
      "visit_id, site_id, visitor_id, session_id, status, started_at, " +
      "last_activity_at, pathname, hostname, site_pk" +
      ") VALUES (?, ?, ?, ?, 'complete', ?, ?, '/wave30', 'example.test', ?)",
  ).run(visitId, siteId, visitorId, sessionId, startedAt, startedAt, sitePk);
  for (const [column, value] of Object.entries(values)) {
    // Column names are supplied only by the frozen test oracle above.
    db.prepare("UPDATE visits SET " + column + " = ? WHERE visit_id = ?").run(
      value,
      visitId,
    );
  }
}

function insertEventName(
  db: DatabaseSync,
  siteId: string,
  sitePk: number,
  name: string,
): number {
  db.prepare(
    "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) " +
      "VALUES (?, ?, 1, ?) ON CONFLICT(site_pk, name) DO NOTHING",
  ).run(siteId, name, sitePk);
  return (
    db
      .prepare(
        "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?",
      )
      .get(sitePk, name) as { readonly id: number }
  ).id;
}

function insertEvent(
  db: DatabaseSync,
  input: {
    readonly siteId: string;
    readonly sitePk: number;
    readonly visitId: string;
    readonly eventId: string;
    readonly eventNameId: number;
    readonly occurredAt: number;
  },
): void {
  db.prepare(
    "INSERT INTO custom_events (" +
      "event_id, site_id, site_pk, visit_id, event_name_id, occurred_at, " +
      "received_at, node_count, value_count" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)",
  ).run(
    input.eventId,
    input.siteId,
    input.sitePk,
    input.visitId,
    input.eventNameId,
    input.occurredAt,
    input.occurredAt,
  );
}

function pageValues(value: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    PAGE_FIELDS.map(({ column }) => [column, value] as const),
  );
}

function lowerDocument(
  input: unknown,
  options: {
    readonly temporalDomain?: "candidate" | "filter" | "read";
    readonly targetScope?: "session" | "visitor";
  } = {},
) {
  const targetScope = options.targetScope ?? "session";
  const temporalDomain = options.temporalDomain ?? "read";
  const normalized = normalizeFilterDocument(input, analyticsFilterRegistry);
  const builder = new LogicalPlanBuilder(planContext(targetScope));
  const lowered = lowerFilterDocumentToScope(
    builder,
    analyzeFilterDocument(normalized, analyticsFilterRegistry),
    {
      targetScope,
      resolveTemporalDomain: () => temporalDomain,
    },
  );
  if (lowered.kind !== "supported") {
    return { kind: "unsupported" as const, lowered, builder };
  }
  builder.output("selected-native-entities", lowered.selection.relation, [
    { name: "entity", slot: "entity" },
  ]);
  const plan = builder.finish();
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId: SITE_A,
    time: plan.context.time,
  });
  const loweredOutput = lowerer.lower(plan.outputs[0]!);
  const query = compileD1Query(
    lowerer.projectOutput(loweredOutput, [
      {
        name: "site_pk",
        slot: plan.outputs[0]!.fields[0]!.slot,
        component: 0,
      },
      {
        name: "entity_id",
        slot: plan.outputs[0]!.fields[0]!.slot,
        component: 1,
      },
    ]),
  );
  return { kind: "supported" as const, plan, query };
}

async function executeDocument(
  db: DatabaseSync,
  input: unknown,
  options: {
    readonly temporalDomain?: "candidate" | "filter" | "read";
    readonly targetScope?: "session" | "visitor";
  } = {},
): Promise<string[]> {
  const lowered = lowerDocument(input, options);
  if (lowered.kind !== "supported") {
    throw new Error(
      "Expected a supported FilterDocument, received " + lowered.lowered.kind,
    );
  }
  const result = await createD1DatabaseClient(createSqliteD1Database(db)).all(
    lowered.query,
  );
  return (result.results as Array<{ readonly entity_id: string }>)
    .map(({ entity_id }) => entity_id)
    .sort();
}

function rawPresenceSql(operator: PresenceOperator, column: string): string {
  return RAW_PRESENCE_SQL[operator](column);
}

function referencePagePresence(
  db: DatabaseSync,
  sitePk: number,
  field: Extract<(typeof NATIVE_FIELD_ORACLE)[number], { activity: "page" }>,
  operator: PresenceOperator,
  domain: "candidate" | "filter" | "read",
): string[] {
  const range = RANGE_BY_DOMAIN[domain];
  const column = 'evidence."' + field.column + '"';
  const sql =
    "SELECT DISTINCT candidate.session_id AS entity_id " +
    "FROM visits AS evidence " +
    "JOIN visits AS candidate " +
    "ON candidate.site_pk = evidence.site_pk " +
    "AND candidate.session_id = evidence.session_id " +
    "WHERE candidate.site_pk = ? " +
    "AND candidate.started_at >= ? AND candidate.started_at < ? " +
    "AND evidence.started_at >= ? AND evidence.started_at < ? " +
    "AND candidate.status = 'complete' " +
    "AND evidence.status = 'complete' " +
    "AND candidate.session_id != '' " +
    "AND evidence.session_id != '' " +
    "AND " +
    rawPresenceSql(operator, column) +
    " ORDER BY entity_id";
  const rows = db
    .prepare(sql)
    .all(
      sitePk,
      CANDIDATE_RANGE.startMs,
      CANDIDATE_RANGE.endExclusiveMs,
      range.startMs,
      range.endExclusiveMs,
    ) as Array<{ readonly entity_id: string }>;
  return rows.map(({ entity_id }) => entity_id);
}

function referenceEventPresence(
  db: DatabaseSync,
  sitePk: number,
  operator: PresenceOperator,
  domain: "candidate" | "filter" | "read",
): string[] {
  const range = RANGE_BY_DOMAIN[domain];
  const sql =
    "SELECT DISTINCT candidate.session_id AS entity_id " +
    "FROM visits AS candidate " +
    "JOIN visits AS owner " +
    "ON owner.site_pk = candidate.site_pk " +
    "AND owner.session_id = candidate.session_id " +
    "JOIN custom_events AS evidence " +
    "ON evidence.site_pk = owner.site_pk " +
    "AND evidence.visit_id = owner.visit_id " +
    "JOIN custom_event_names AS native_name " +
    "ON native_name.site_pk = evidence.site_pk " +
    "AND native_name.id = evidence.event_name_id " +
    "WHERE candidate.site_pk = ? " +
    "AND candidate.started_at >= ? AND candidate.started_at < ? " +
    "AND evidence.occurred_at >= ? AND evidence.occurred_at < ? " +
    "AND candidate.status = 'complete' " +
    "AND owner.status = 'complete' " +
    "AND candidate.session_id != '' " +
    "AND owner.session_id != '' " +
    "AND " +
    rawPresenceSql(operator, 'native_name."name"') +
    " ORDER BY entity_id";
  const rows = db
    .prepare(sql)
    .all(
      sitePk,
      CANDIDATE_RANGE.startMs,
      CANDIDATE_RANGE.endExclusiveMs,
      range.startMs,
      range.endExclusiveMs,
    ) as Array<{ readonly entity_id: string }>;
  return rows.map(({ entity_id }) => entity_id);
}

function selectorDocument(
  operator: "exists" | "notExists",
  collection: "page" | "event",
  predicate: unknown,
): FilterDocument {
  return document({
    kind: "condition",
    target: {
      kind: "selector",
      collection: { kind: "entity-root", entity: collection },
      predicate,
    },
    operator,
  });
}

function lowerPublicDocument(input: unknown) {
  return lowerAnalyticsPagePathToSessionQuery({
    document: input,
    siteIds: [SITE_A] as never,
    candidateRange: CANDIDATE_RANGE as never,
    readRange: READ_RANGE as never,
    reportingTimeZone: "UTC" as never,
    capturedAtMs: 300 as never,
  });
}

describe("Wave30 native field presence and raw-source D1 lowering", () => {
  it("freezes the 26 field mappings and value/profile/comparison metadata", async () => {
    const db = createMigratedDatabase();
    try {
      const sitePk = insertSite(db, SITE_A);
      const eventField = NATIVE_FIELD_ORACLE.find(
        ({ activity }) => activity === "event",
      );
      if (!eventField) throw new Error("Expected the event.name oracle entry.");
      insertVisit(
        db,
        SITE_A,
        sitePk,
        "native-map-visit",
        "s-native-map",
        50,
        Object.fromEntries(
          PAGE_FIELDS.map(({ column, value }) => [column, value] as const),
        ),
      );
      const eventNameId = insertEventName(db, SITE_A, sitePk, eventField.value);
      insertEvent(db, {
        siteId: SITE_A,
        sitePk,
        visitId: "native-map-visit",
        eventId: "native-map-event",
        eventNameId,
        occurredAt: 50,
      });

      expect(NATIVE_FIELD_ORACLE).toHaveLength(26);
      expect(PAGE_FIELDS).toHaveLength(25);
      expect(CASE_FOLD_FIELDS).toHaveLength(8);
      for (const field of NATIVE_FIELD_ORACLE) {
        const contract = nativePrimitiveFieldContract(field.field);
        const registryField = analyticsFilterRegistry.get(field.field);
        const semanticField = semanticAttribute(field.field);
        expect(contract, field.field).toBeDefined();
        expect(registryField, field.field).toBeDefined();
        expect(semanticField, field.field).toBeDefined();
        expect(contract).toMatchObject({
          id: field.field,
          activity: field.activity,
          storageSource: field.activity === "page" ? "visit" : "event",
          storageColumn:
            field.activity === "page" ? field.column : "event_name",
          storageNullable: field.storageNullable,
          nullable: field.nullable,
          valueKind: field.valueKind,
          profile: field.profile,
          comparison: field.comparison,
          compilerStrategy:
            field.activity === "page" ? "column." + field.column : "event.name",
        });
        const expectedKinds =
          field.activity === "page" ? ["page", "event"] : ["event"];
        expect(registryField).toMatchObject({
          id: field.field,
          valueKind: field.valueKind,
          profile: field.profile,
          comparison: field.comparison,
          source: field.activity === "page" ? "visit" : "event",
          nativeEntity: field.activity === "page" ? "visit" : "event",
          presence: "non-null-column",
          empty: "raw-empty-string",
          evaluation: "observation",
          nullable: field.nullable,
        });
        expect(filterConditionEntity(registryField!)).toBe(
          CONDITION_ENTITY_ORACLE[field.field],
        );
        expect([...registryField!.observationKinds].sort()).toEqual(
          expectedKinds
            .map((kind) => (kind === "page" ? "visit" : "event"))
            .sort(),
        );
        expect(semanticField).toMatchObject({
          id: field.field,
          nativeEntity: field.activity,
          observationKinds: [...expectedKinds].sort(),
          nullable: field.nullable,
          evaluation: "observation",
          presence: "non-null",
          empty: "empty-string-is-value",
          comparison: field.comparison,
          valueType: { kind: "scalar", scalar: "string" },
        });
      }

      const builder = new LogicalPlanBuilder(planContext());
      const pages = builder.source("page", {
        temporalDomain: "read",
        attributes: PAGE_FIELDS.map(({ field }) => field),
      });
      builder.output("frozen-page-columns", pages, [
        { name: "visit", slot: "entity" },
        ...PAGE_FIELDS.map(({ field, column }) => ({
          name: column,
          slot: "attribute:" + field,
        })),
      ]);
      const pagePlan = builder.finish();
      const pageLowerer = new AnalyticsLogicalToDbLowerer(pagePlan, {
        siteId: SITE_A,
        time: pagePlan.context.time,
      });
      const pageOutput = pageLowerer.lower(pagePlan.outputs[0]!);
      const pageQuery = compileD1Query(
        pageLowerer.projectOutput(pageOutput, [
          {
            name: "visit_id",
            slot: pagePlan.outputs[0]!.fields[0]!.slot,
            component: 1,
          },
          ...pagePlan.outputs[0]!.fields.slice(1).map(({ name, slot }) => ({
            name,
            slot,
          })),
        ]),
      );
      const pageRows = (
        await createD1DatabaseClient(createSqliteD1Database(db)).all(pageQuery)
      ).results as Array<Record<string, string | null>>;
      expect(pageRows).toEqual([
        {
          visit_id: "native-map-visit",
          ...Object.fromEntries(
            PAGE_FIELDS.map(({ column, value }) => [column, value] as const),
          ),
        },
      ]);

      const eventBuilder = new LogicalPlanBuilder(planContext());
      const events = eventBuilder.source("event", {
        temporalDomain: "read",
        attributes: [eventField.field],
      });
      eventBuilder.output("frozen-event-name", events, [
        { name: "event", slot: "entity" },
        { name: "name", slot: "attribute:" + eventField.field },
      ]);
      const eventPlan = eventBuilder.finish();
      const eventLowerer = new AnalyticsLogicalToDbLowerer(eventPlan, {
        siteId: SITE_A,
        time: eventPlan.context.time,
      });
      const eventOutput = eventLowerer.lower(eventPlan.outputs[0]!);
      const eventQuery = compileD1Query(
        eventLowerer.projectOutput(eventOutput, [
          {
            name: "event_id",
            slot: eventPlan.outputs[0]!.fields[0]!.slot,
            component: 1,
          },
          { name: "name", slot: eventPlan.outputs[0]!.fields[1]!.slot },
        ]),
      );
      const eventRows = (
        await createD1DatabaseClient(createSqliteD1Database(db)).all(eventQuery)
      ).results as Array<{ readonly event_id: string; readonly name: string }>;
      expect(eventRows).toEqual([
        { event_id: "native-map-event", name: eventField.value },
      ]);
    } finally {
      db.close();
    }
  });

  it("executes raw presence operators for all 26 fields against independent SQLite oracles", async () => {
    const db = createMigratedDatabase();
    try {
      const sitePk = insertSite(db, SITE_A);
      const siteBPk = insertSite(db, SITE_B);
      for (const state of RAW_VALUES) {
        const sessionId = "s-" + state.key;
        const visitorId = "v-" + state.key;
        insertVisit(
          db,
          SITE_A,
          sitePk,
          "candidate-" + state.key,
          sessionId,
          150,
          pageValues("candidate-" + state.key),
          visitorId,
        );
        insertVisit(
          db,
          SITE_A,
          sitePk,
          "read-" + state.key,
          sessionId,
          50,
          pageValues(state.value),
          visitorId,
        );
      }
      for (const field of ["user.id", "user.name"] as const) {
        const userIdNull = field === "user.id";
        const sessionId = userIdNull ? "s-null-user-id" : "s-null-user-name";
        const visitorId = userIdNull ? "v-null-user-id" : "v-null-user-name";
        const nullColumn = userIdNull ? "user_id" : "user_name";
        insertVisit(
          db,
          SITE_A,
          sitePk,
          "candidate-" + sessionId,
          sessionId,
          150,
          pageValues("candidate-" + sessionId),
          visitorId,
        );
        insertVisit(
          db,
          SITE_A,
          sitePk,
          "read-" + sessionId,
          sessionId,
          50,
          { ...pageValues("Other Value"), [nullColumn]: null },
          visitorId,
        );
      }

      const eventField = NATIVE_FIELD_ORACLE.find(
        ({ activity }) => activity === "event",
      );
      if (!eventField) throw new Error("Expected the event.name oracle entry.");
      for (const state of RAW_VALUES) {
        const sessionId = "s-event-" + state.key;
        const visitorId = "v-event-" + state.key;
        insertVisit(
          db,
          SITE_A,
          sitePk,
          "candidate-event-" + state.key,
          sessionId,
          150,
          pageValues("candidate-event-" + state.key),
          visitorId,
        );
        const ownerId = "event-owner-" + state.key;
        insertVisit(
          db,
          SITE_A,
          sitePk,
          ownerId,
          sessionId,
          350,
          pageValues("owner-" + state.key),
          visitorId,
        );
        const eventNameId = insertEventName(db, SITE_A, sitePk, state.value);
        insertEvent(db, {
          siteId: SITE_A,
          sitePk,
          visitId: ownerId,
          eventId: "event-" + state.key,
          eventNameId,
          occurredAt: 50,
        });
      }
      insertVisit(
        db,
        SITE_A,
        sitePk,
        "candidate-event-no-evidence",
        "s-event-no-evidence",
        150,
        pageValues("candidate-only"),
        "v-event-no-evidence",
      );

      // A foreign-site dictionary ID is a real custom Event row, but it does
      // not become native `event.name` evidence for this site.
      const foreignNameId = insertEventName(
        db,
        SITE_B,
        siteBPk,
        "foreign-dictionary-name",
      );
      insertVisit(
        db,
        SITE_A,
        sitePk,
        "candidate-event-foreign-name",
        "s-event-foreign-name",
        150,
        pageValues("candidate-only"),
        "v-event-foreign-name",
      );
      insertVisit(
        db,
        SITE_A,
        sitePk,
        "owner-event-foreign-name",
        "s-event-foreign-name",
        350,
        pageValues("foreign-owner"),
        "v-event-foreign-name",
      );
      insertEvent(db, {
        siteId: SITE_A,
        sitePk,
        visitId: "owner-event-foreign-name",
        eventId: "event-foreign-dictionary-name",
        eventNameId: foreignNameId,
        occurredAt: 50,
      });

      // Same local session key on another site must not leak into Page evidence.
      insertVisit(
        db,
        SITE_B,
        siteBPk,
        "site-b-candidate",
        "s-empty",
        150,
        pageValues("site-b"),
        "v-site-b",
      );
      insertVisit(
        db,
        SITE_B,
        siteBPk,
        "site-b-read",
        "s-empty",
        50,
        pageValues("site-b"),
        "v-site-b",
      );

      expect(NATIVE_FIELD_ORACLE).toHaveLength(26);
      expect(RAW_PRESENCE_SQL.exists('"column"')).toBe('"column" IS NOT NULL');
      expect(RAW_PRESENCE_SQL.notExists('"column"')).toBe('"column" IS NULL');
      expect(RAW_PRESENCE_SQL.isEmpty('"column"')).toBe(
        '"column" IS NOT NULL AND "column" = ' + "''",
      );
      expect(RAW_PRESENCE_SQL.notEmpty('"column"')).toBe(
        '"column" IS NOT NULL AND "column" != ' + "''",
      );

      for (const field of PAGE_FIELDS) {
        for (const operator of PRESENCE_OPERATORS) {
          const actual = await executeDocument(
            db,
            document(fieldCondition(field.field, operator)),
          );
          const reference = referencePagePresence(
            db,
            sitePk,
            field,
            operator,
            "read",
          );
          expect(actual, field.field + " " + operator).toEqual(reference);
        }
      }
      for (const operator of PRESENCE_OPERATORS) {
        const actual = await executeDocument(
          db,
          document(fieldCondition(eventField.field, operator)),
        );
        const reference = referenceEventPresence(db, sitePk, operator, "read");
        expect(actual, "event.name " + operator).toEqual(reference);
      }

      for (const operator of PRESENCE_OPERATORS) {
        const actual = await executeDocument(
          db,
          document(fieldCondition("page.hostname", operator)),
        );
        const expected =
          operator === "notExists"
            ? []
            : operator === "isEmpty"
              ? [...RAW_PRESENCE_EXPECTATIONS.isEmpty]
              : operator === "notEmpty"
                ? [...RAW_PRESENCE_EXPECTATIONS.notEmpty]
                : [...RAW_PRESENCE_EXPECTATIONS.exists];
        expect(actual, "page.hostname " + operator).toEqual(expected.sort());
      }
      expect(
        await executeDocument(
          db,
          document(fieldCondition("user.id", "notExists")),
        ),
      ).toEqual(["s-null-user-id"]);
      expect(
        await executeDocument(
          db,
          document(fieldCondition("user.name", "notExists")),
        ),
      ).toEqual(["s-null-user-name"]);
      expect(
        await executeDocument(
          db,
          document(fieldCondition("user.id", "isEmpty")),
        ),
      ).toEqual(["s-empty"]);
      expect(
        await executeDocument(
          db,
          document(fieldCondition("user.name", "isEmpty")),
        ),
      ).toEqual(["s-empty"]);
      const userIdExists = await executeDocument(
        db,
        document(fieldCondition("user.id", "exists")),
      );
      const userIdNotNull = await executeDocument(
        db,
        document(fieldCondition("user.id", "notNull")),
      );
      const userIdNotExists = await executeDocument(
        db,
        document(fieldCondition("user.id", "notExists")),
      );
      const userIdIsNull = await executeDocument(
        db,
        document(fieldCondition("user.id", "isNull")),
      );
      expect(userIdExists).toEqual(userIdNotNull);
      expect(userIdNotExists).toEqual(userIdIsNull);

      // The historical direct-referrer marker is a raw, present, nonempty
      // value for these presence operators; no comparison semantics are used.
      for (const field of ["referrer.domain", "referrer.url"] as const) {
        expect(
          await executeDocument(db, document(fieldCondition(field, "exists"))),
        ).toContain("s-direct");
        expect(
          await executeDocument(db, document(fieldCondition(field, "isEmpty"))),
        ).not.toContain("s-direct");
        expect(
          await executeDocument(
            db,
            document(fieldCondition(field, "notEmpty")),
          ),
        ).toContain("s-direct");
      }

      // Every new Page field goes through selector-local shared primitive
      // lowering for each presence operation, using raw SQLite as oracle.
      for (const field of CASE_FOLD_FIELDS) {
        if (field.activity !== "page") {
          throw new Error("Wave30 case-fold fields are native Page fields.");
        }
        for (const operator of PRESENCE_OPERATORS) {
          const selector = selectorDocument(
            "exists",
            "page",
            fieldCondition(field.field, operator),
          );
          const actual = await executeDocument(db, selector);
          const reference = referencePagePresence(
            db,
            sitePk,
            field,
            operator,
            "read",
          );
          expect(
            actual,
            "Page selector " + field.field + " " + operator,
          ).toEqual(reference);
        }
      }

      for (const operator of PRESENCE_OPERATORS) {
        const actual = await executeDocument(
          db,
          document(fieldCondition(eventField.field, operator)),
        );
        const expected =
          operator === "notExists"
            ? []
            : operator === "isEmpty"
              ? ["s-event-empty"]
              : operator === "notEmpty"
                ? RAW_VALUES.filter(({ key }) => key !== "empty").map(
                    ({ key }) => "s-event-" + key,
                  )
                : RAW_VALUES.map(({ key }) => "s-event-" + key);
        expect(actual, "event.name " + operator).toEqual([...expected].sort());

        const eventSelector = selectorDocument(
          "exists",
          "event",
          fieldCondition(eventField.field, operator),
        );
        expect(
          await executeDocument(db, eventSelector),
          "Event selector " + operator,
        ).toEqual(referenceEventPresence(db, sitePk, operator, "read"));
      }

      // A root NOT complements event evidence over candidate sessions, while a
      // raw event.name notExists leaf only sees actual events with NULL names.
      expect(
        await executeDocument(
          db,
          document({
            kind: "not",
            child: fieldCondition(eventField.field, "exists"),
          }),
        ),
      ).toEqual(
        [
          ...RAW_PRESENCE_EXPECTATIONS.exists,
          "s-event-no-evidence",
          "s-event-foreign-name",
        ].sort(),
      );

      const eventCollectionNotExists = selectorDocument(
        "notExists",
        "event",
        fieldCondition(eventField.field, "exists"),
      );
      expect(await executeDocument(db, eventCollectionNotExists)).toEqual(
        ALL_CANDIDATE_SESSION_IDS.filter(
          (sessionId) =>
            !RAW_VALUES.some(({ key }) => sessionId === "s-event-" + key),
        ).sort(),
      );

      const pageSelector = selectorDocument(
        "exists",
        "page",
        fieldCondition("page.hostname", "isEmpty"),
      );
      expect(await executeDocument(db, pageSelector)).toEqual(["s-empty"]);
      const pageCollectionNotExists = selectorDocument(
        "notExists",
        "page",
        fieldCondition("page.hostname", "exists"),
      );
      expect(await executeDocument(db, pageCollectionNotExists)).toEqual(
        ALL_CANDIDATE_SESSION_IDS.filter((sessionId) =>
          sessionId.startsWith("s-event-"),
        ).sort(),
      );

      const booleanExpression = document({
        kind: "and",
        children: [
          fieldCondition("page.hostname", "exists"),
          {
            kind: "or",
            children: [
              fieldCondition("page.hostname", "isEmpty"),
              fieldCondition("page.hostname", "notEmpty"),
            ],
          },
        ],
      });
      expect(await executeDocument(db, booleanExpression)).toEqual(
        [...RAW_PRESENCE_EXPECTATIONS.exists].sort(),
      );
      expect(
        await executeDocument(
          db,
          document({
            kind: "not",
            child: fieldCondition("page.hostname", "isEmpty"),
          }),
        ),
      ).toEqual(
        ALL_CANDIDATE_SESSION_IDS.filter(
          (sessionId) => sessionId !== "s-empty",
        ).sort(),
      );
    } finally {
      db.close();
    }
  });

  it("keeps Page candidate/filter/read ranges half-open and site-scoped", async () => {
    const db = createMigratedDatabase();
    try {
      const sitePk = insertSite(db, SITE_A);
      const siteBPk = insertSite(db, SITE_B);
      const field = NATIVE_FIELD_ORACLE.find(
        ({ field: id }) => id === "user.id",
      );
      if (!field || field.activity !== "page") {
        throw new Error("Expected the user.id Page oracle.");
      }

      for (const domain of ["candidate", "filter", "read"] as const) {
        const range = RANGE_BY_DOMAIN[domain];
        for (const edge of [
          { suffix: "before-start", time: range.startMs - 1 },
          { suffix: "at-start", time: range.startMs },
          { suffix: "before-end", time: range.endExclusiveMs - 1 },
          { suffix: "at-end", time: range.endExclusiveMs },
        ] as const) {
          const sessionId = domain + "-" + edge.suffix;
          if (domain !== "candidate") {
            insertVisit(
              db,
              SITE_A,
              sitePk,
              "candidate-" + sessionId,
              sessionId,
              150,
              { ...pageValues("candidate-value"), user_id: null },
              "v-" + sessionId,
            );
          }
          insertVisit(
            db,
            SITE_A,
            sitePk,
            "evidence-" + sessionId,
            sessionId,
            edge.time,
            {
              ...pageValues("other"),
              [field.column]:
                (domain === "filter" && edge.suffix === "before-start") ||
                (domain === "read" && edge.suffix === "at-end")
                  ? null
                  : "range-marker",
            },
            "v-" + sessionId,
          );
        }
      }
      insertVisit(
        db,
        SITE_B,
        siteBPk,
        "site-b-candidate",
        "read-at-start",
        150,
        pageValues("range-marker"),
        "v-site-b",
      );
      insertVisit(
        db,
        SITE_B,
        siteBPk,
        "site-b-read",
        "read-at-start",
        50,
        pageValues("range-marker"),
        "v-site-b",
      );

      for (const domain of ["candidate", "filter", "read"] as const) {
        const expected = [domain + "-at-start", domain + "-before-end"].sort();
        const actual = await executeDocument(
          db,
          document(fieldCondition(field.field, "exists")),
          { temporalDomain: domain },
        );
        const reference = referencePagePresence(
          db,
          sitePk,
          field,
          "exists",
          domain,
        );
        expect(actual, domain + " range").toEqual(expected);
        expect(actual, domain + " raw SQL reference").toEqual(reference);
      }
    } finally {
      db.close();
    }
  });

  it("keeps public comparisons on the eight case-fold fields explicitly unsupported", () => {
    expect(CASE_FOLD_FIELDS).toHaveLength(8);
    const unsupportedComparisons = [
      { operator: "eq", value: "ordinary value" },
      { operator: "neq", value: "ordinary value" },
      { operator: "in", value: ["ordinary value"] },
      { operator: "notIn", value: ["ordinary value"] },
    ] as const satisfies readonly {
      readonly operator: FilterOperator;
      readonly value: string | readonly string[];
    }[];
    const stringMatches = [
      { operator: "contains", value: "ordinary" },
      { operator: "startsWith", value: "ordinary" },
      { operator: "endsWith", value: "value" },
    ] as const satisfies readonly {
      readonly operator: FilterOperator;
      readonly value: string;
    }[];
    for (const field of CASE_FOLD_FIELDS) {
      const fieldComparisons =
        field.valueKind === "string"
          ? [...unsupportedComparisons, ...stringMatches]
          : unsupportedComparisons;
      for (const condition of fieldComparisons) {
        const result = lowerPublicDocument(
          document(
            fieldCondition(field.field, condition.operator, condition.value),
          ),
        );
        expect(result, field.field + " " + condition.operator).toMatchObject({
          kind: "unsupported",
          capability: "session-boolean-plan-shape",
          node: "nodes[1].predicate",
        });
        if (result.kind === "unsupported") {
          const stringMatch = stringMatches.some(
            ({ operator }) => operator === condition.operator,
          );
          expect(result.reason, field.field + " " + condition.operator).toMatch(
            stringMatch
              ? /case-insensitive matching is not supported/i
              : /case-fold normalization/i,
          );
        }
        expect("query" in result, field.field + " " + condition.operator).toBe(
          false,
        );
      }
      if (field.valueKind === "enum") {
        for (const condition of stringMatches) {
          const result = lowerPublicDocument(
            document(
              fieldCondition(field.field, condition.operator, condition.value),
            ),
          );
          expect(result, field.field + " " + condition.operator).toMatchObject({
            kind: "unsupported",
            capability: "valid-filter-document-required",
            node: "root",
            reason: expect.stringContaining("Operator is not allowed"),
          });
          expect(
            "query" in result,
            field.field + " " + condition.operator,
          ).toBe(false);
        }
      }
    }
  });

  it("lowers Page field presence into a Visitor-scoped logical selection", () => {
    const input = document(fieldCondition("referrer.domain", "notEmpty"));
    const normalized = normalizeFilterDocument(input, analyticsFilterRegistry);
    const builder = new LogicalPlanBuilder(planContext("visitor"));
    const lowered = lowerFilterDocumentToScope(
      builder,
      analyzeFilterDocument(normalized, analyticsFilterRegistry),
      {
        targetScope: "visitor",
        resolveTemporalDomain: () => "read",
      },
    );

    expect(lowered).toMatchObject({
      kind: "supported",
      scope: "visitor",
      selection: { kind: "matching", scope: "visitor" },
    });
    if (lowered.kind !== "supported" || lowered.selection.kind !== "matching") {
      throw new Error("Expected a Visitor-scoped matching selection.");
    }

    const entityKey = builder.slot(lowered.selection.relation, "entity");
    expect(entityKey.type).toEqual({ kind: "entity", entity: "visitor" });
    builder.output("visitor-presence", lowered.selection.relation, [
      { name: "entity", slot: "entity" },
    ]);
    const plan = builder.finish();
    expect(plan.outputs).toHaveLength(1);
    expect(plan.nodes.some((node) => node.kind === "source")).toBe(true);
    expect(plan.nodes.some((node) => node.kind === "filter")).toBe(true);
  });

  it("rejects non-text empty checks, payload presence, and derived values before plan pollution", () => {
    for (const field of ["page.durationMs", "session.bounce"] as const) {
      const builder = new LogicalPlanBuilder(planContext());
      expect(() =>
        normalizeFilterDocument(
          document(fieldCondition(field, "isEmpty")),
          analyticsFilterRegistry,
        ),
      ).toThrow("Operator is not allowed for this field.");
      expect(builder.finish().nodes, field).toEqual([]);
    }

    const payloadBuilder = new LogicalPlanBuilder(planContext());
    const payloadDocument = normalizeFilterDocument(
      document({
        kind: "condition",
        target: { kind: "event-payload", path: "/amount" },
        operator: "isEmpty",
      }),
      analyticsFilterRegistry,
    );
    const payloadResult = lowerFilterDocumentToScope(
      payloadBuilder,
      analyzeFilterDocument(payloadDocument, analyticsFilterRegistry),
      {
        targetScope: "session",
        resolveTemporalDomain: () => "read",
      },
    );
    expect(payloadResult).toMatchObject({
      kind: "unsupported",
      code: "unsupported-target",
    });
    expect(payloadBuilder.finish().nodes).toEqual([]);

    const derivedBuilder = new LogicalPlanBuilder(planContext());
    const derivedDocument = normalizeFilterDocument(
      document(fieldCondition("session.entryPath", "eq", "/native")),
      analyticsFilterRegistry,
    );
    const derivedResult = lowerFilterDocumentToScope(
      derivedBuilder,
      analyzeFilterDocument(derivedDocument, analyticsFilterRegistry),
      {
        targetScope: "session",
        resolveTemporalDomain: () => "read",
      },
    );
    expect(derivedResult).toMatchObject({
      kind: "unsupported",
      code: "unsupported-evaluation",
      fieldId: "session.entryPath",
    });
    expect(derivedBuilder.finish().nodes).toEqual([]);
  });
});
