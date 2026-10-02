import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { compileD1Query, createD1DatabaseClient } from "@/lib/db";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import {
  LogicalPlanBuilder,
  lowerFilterDocumentToScope,
} from "@/lib/edge/analytics/engine";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { analyticsScopeFactContract } from "@/lib/edge/analytics/providers/d1/internal/analytics-scope-fact-storage";
import {
  buildCanonicalFilterScopeFacts,
  type FilterActivityFact,
} from "@/lib/filter-contract/filter-facts";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { analyzeFilterDocument } from "@/lib/filter-contract/filter-semantics";
import {
  type FilterConditionValue,
  type FilterOperator,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

const SITE_A = "wave32-count-facts-a";
const SITE_B = "wave32-count-facts-b";
const TEAM_ID = "wave32-count-facts-team";
type TimeRange = Readonly<{
  startMs: number;
  endExclusiveMs: number;
}>;
const RANGE: TimeRange = { startMs: 100, endExclusiveMs: 200 };
const FILTER_RANGE: TimeRange = { startMs: 50, endExclusiveMs: 260 };

type FactEntity = "session" | "visitor";
type SessionFactAttribute =
  "session.views" | "session.events" | "session.bounce";
type VisitorFactAttribute =
  "visitor.sessions" | "visitor.views" | "visitor.events";
type CountFactAttribute = SessionFactAttribute | VisitorFactAttribute;

const SESSION_FACTS = [
  "session.views",
  "session.events",
  "session.bounce",
] as const satisfies readonly SessionFactAttribute[];
const VISITOR_FACTS = [
  "visitor.sessions",
  "visitor.views",
  "visitor.events",
] as const satisfies readonly VisitorFactAttribute[];

type Site = Readonly<{ id: string; pk: number }>;
type RawActivity = Readonly<{
  kind: "page" | "event";
  activityId: string;
  visitorId: string;
  sessionId: string;
  time: number;
  path: string | null;
}>;
type FactResult = Readonly<Record<string, string | number | null>>;
type NamedOutput = Readonly<{
  name: string;
  attributes: readonly CountFactAttribute[];
  countOnly?: boolean;
}>;

function createPlanContext(
  entity: FactEntity | "observation",
  siteIds: readonly string[],
  filterRange: TimeRange = RANGE,
) {
  return {
    subject: createSemanticSubjectDomain({
      origin: siteIds.length > 1 ? "team" : "site",
      siteIds: siteIds as never,
      ...(siteIds.length > 1 ? { teamId: TEAM_ID as never } : {}),
    }),
    time: createSemanticTemporalDomains({
      candidate: RANGE as never,
      filter: filterRange as never,
      read: { kind: "bounded", range: filterRange as never },
      reportingTimeZone: "UTC" as never,
      capturedAtMs: 300 as never,
    }),
    scope: resolveAnalyticsScope(entity === "observation" ? "event" : entity),
  };
}

function insertSite(db: DatabaseSync, id: string): Site {
  db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(id);
  const row = db
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(id) as { readonly site_pk: number };
  return { id, pk: row.site_pk };
}

function insertPage(
  db: DatabaseSync,
  site: Site,
  input: {
    readonly id: string | null;
    readonly sessionId: string;
    readonly visitorId: string;
    readonly time: number;
    readonly path?: string;
  },
): void {
  db.prepare(
    "INSERT INTO visits (visit_id, site_id, visitor_id, session_id, status, " +
      "started_at, last_activity_at, pathname, hostname, site_pk) " +
      "VALUES (?, ?, ?, ?, 'complete', ?, ?, ?, 'count-facts.example', ?)",
  ).run(
    input.id,
    site.id,
    input.visitorId,
    input.sessionId,
    input.time,
    input.time,
    input.path ?? "/",
    site.pk,
  );
}

function insertEventName(db: DatabaseSync, site: Site, name: string): number {
  db.prepare(
    "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) " +
      "VALUES (?, ?, 1, ?)",
  ).run(site.id, name, site.pk);
  return (
    db
      .prepare(
        "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?",
      )
      .get(site.pk, name) as { readonly id: number }
  ).id;
}

function insertEvent(
  db: DatabaseSync,
  site: Site,
  input: {
    readonly id: string;
    readonly ownerVisitId: string;
    readonly eventNameId: number;
    readonly time: number;
  },
): void {
  db.prepare(
    "INSERT INTO custom_events (event_id, site_id, site_pk, visit_id, " +
      "event_name_id, occurred_at, received_at, node_count, value_count) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)",
  ).run(
    input.id,
    site.id,
    site.pk,
    input.ownerVisitId,
    input.eventNameId,
    input.time,
    input.time,
  );
}

/**
 * Frozen test oracle for eligible activity rows. It reads ordinary migrated
 * tables directly and deliberately uses raw, site-scoped owner and dictionary
 * joins; it does not inspect the new count-fact Source or scoped-facts tables.
 */
function rawEligibleActivityRows(
  db: DatabaseSync,
  sitePk: number,
  range: TimeRange = RANGE,
): RawActivity[] {
  return db
    .prepare(
      "SELECT 'page' AS kind, visit_id AS activity_id, visitor_id, session_id, " +
        "started_at AS activity_time, pathname AS path FROM visits " +
        "WHERE site_pk = ? AND started_at >= ? AND started_at < ? " +
        "UNION ALL " +
        "SELECT 'event' AS kind, event.event_id AS activity_id, " +
        "owner.visitor_id, owner.session_id, event.occurred_at AS activity_time, " +
        "NULL AS path FROM custom_events AS event " +
        "JOIN visits AS owner ON owner.site_pk = event.site_pk " +
        "AND owner.visit_id = event.visit_id " +
        "JOIN custom_event_names AS dictionary " +
        "ON dictionary.site_pk = event.site_pk " +
        "AND dictionary.id = event.event_name_id " +
        "WHERE event.site_pk = ? AND event.occurred_at >= ? " +
        "AND event.occurred_at < ? " +
        "ORDER BY kind, activity_id",
    )
    .all(
      sitePk,
      range.startMs,
      range.endExclusiveMs,
      sitePk,
      range.startMs,
      range.endExclusiveMs,
    )
    .map((row) => {
      const value = row as {
        readonly kind: "page" | "event";
        readonly activity_id: string;
        readonly visitor_id: string;
        readonly session_id: string;
        readonly activity_time: number;
        readonly path: string | null;
      };
      return {
        kind: value.kind,
        activityId: value.activity_id,
        visitorId: value.visitor_id,
        sessionId: value.session_id,
        time: value.activity_time,
        path: value.path,
      };
    });
}

/** Frozen candidate Observation rows, deliberately independent of fact eligibility. */
function rawCandidateObservationRows(
  db: DatabaseSync,
  sitePk: number,
): RawActivity[] {
  return db
    .prepare(
      "SELECT 'page' AS kind, visit_id AS activity_id, visitor_id, session_id, " +
        "started_at AS activity_time, pathname AS path FROM visits " +
        "WHERE site_pk = ? AND started_at >= ? AND started_at < ? " +
        "UNION ALL " +
        "SELECT 'event' AS kind, event.event_id AS activity_id, " +
        "owner.visitor_id, owner.session_id, event.occurred_at AS activity_time, " +
        "NULL AS path FROM custom_events AS event " +
        "JOIN visits AS owner ON owner.site_pk = event.site_pk " +
        "AND owner.visit_id = event.visit_id " +
        "WHERE event.site_pk = ? AND event.occurred_at >= ? " +
        "AND event.occurred_at < ? " +
        "ORDER BY kind, activity_id",
    )
    .all(
      sitePk,
      RANGE.startMs,
      RANGE.endExclusiveMs,
      sitePk,
      RANGE.startMs,
      RANGE.endExclusiveMs,
    )
    .map((row) => {
      const value = row as {
        readonly kind: "page" | "event";
        readonly activity_id: string;
        readonly visitor_id: string;
        readonly session_id: string;
        readonly activity_time: number;
        readonly path: string | null;
      };
      return {
        kind: value.kind,
        activityId: value.activity_id,
        visitorId: value.visitor_id,
        sessionId: value.session_id,
        time: value.activity_time,
        path: value.path,
      };
    });
}

function canonicalExpectedRows(
  db: DatabaseSync,
  sites: readonly Site[],
  entity: FactEntity,
  attributes: readonly CountFactAttribute[],
  range: TimeRange = RANGE,
): FactResult[] {
  const rows: FactResult[] = [];
  for (const site of sites) {
    const activities: FilterActivityFact[] = rawEligibleActivityRows(
      db,
      site.pk,
      range,
    ).map((activity) => ({
      kind: activity.kind,
      id: activity.activityId,
      time: activity.time,
      sessionId: activity.sessionId,
      visitorId: activity.visitorId,
      fields:
        activity.kind === "page" && activity.path !== null
          ? { "page.path": activity.path }
          : {},
    }));
    const canonical = buildCanonicalFilterScopeFacts(activities);
    const facts =
      entity === "session" ? canonical.sessions : canonical.visitors;
    for (const [id, values] of facts) {
      rows.push({
        site_pk: site.pk,
        entity_id: id,
        ...Object.fromEntries(
          attributes.map((attribute) => [
            attribute,
            attribute === "session.bounce"
              ? Number(values[attribute])
              : values[attribute],
          ]),
        ),
      });
    }
  }
  return sortRows(rows);
}

function sortRows(rows: readonly FactResult[]): FactResult[] {
  return [...rows].sort((left, right) => {
    const siteDifference = Number(left.site_pk) - Number(right.site_pk);
    if (siteDifference !== 0) return siteDifference;
    const leftId = String(left.entity_id ?? "");
    const rightId = String(right.entity_id ?? "");
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

function sortObservationRows(rows: readonly FactResult[]): FactResult[] {
  return [...rows].sort((left, right) => {
    const siteDifference = Number(left.site_pk) - Number(right.site_pk);
    if (siteDifference !== 0) return siteDifference;
    const leftKind = String(left.observation_kind ?? "");
    const rightKind = String(right.observation_kind ?? "");
    if (leftKind !== rightKind) return leftKind < rightKind ? -1 : 1;
    const leftId = String(left.entity_id ?? "");
    const rightId = String(right.entity_id ?? "");
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

function buildFactPlan(
  entity: FactEntity,
  siteIds: readonly string[],
  declaredAttributes: readonly CountFactAttribute[],
) {
  const builder = new LogicalPlanBuilder(createPlanContext(entity, siteIds));
  const source = builder.source(entity, {
    temporalDomain: "candidate",
    attributes: declaredAttributes,
  });

  const outputs: NamedOutput[] = [];
  const addOutput = (
    name: string,
    attributes: readonly CountFactAttribute[],
  ) => {
    builder.output(name, source, [
      { name: "identity", slot: "entity" },
      ...attributes.map((attribute) => ({
        name: attribute,
        slot: `attribute:${attribute}`,
      })),
    ]);
    outputs.push({ name, attributes });
  };

  addOutput("all-facts-a", declaredAttributes);
  addOutput("identity-only", []);
  addOutput("single-fact", [declaredAttributes[0]!]);
  addOutput("all-facts-a-repeat", declaredAttributes);

  const identityOnlySource = builder.source(entity, {
    temporalDomain: "candidate",
    attributes: [],
  });
  builder.output("identity-only-source", identityOnlySource, [
    { name: "identity", slot: "entity" },
  ]);
  outputs.push({ name: "identity-only-source", attributes: [] });

  const singleFactSource = builder.source(entity, {
    temporalDomain: "candidate",
    attributes: [declaredAttributes[0]!],
  });
  builder.output("single-fact-source", singleFactSource, [
    { name: "identity", slot: "entity" },
    {
      name: declaredAttributes[0]!,
      slot: `attribute:${declaredAttributes[0]!}`,
    },
  ]);
  outputs.push({
    name: "single-fact-source",
    attributes: [declaredAttributes[0]!],
  });

  const counts = builder.aggregate(source, {}, [
    { name: "sourceRows", kind: "count-rows" },
  ]);
  const countName = "hidden-source-row-count";
  builder.output(countName, counts, [
    { name: "sourceRows", slot: "sourceRows" },
  ]);
  outputs.push({
    name: countName,
    attributes: [],
    countOnly: true,
  });

  const plan = builder.finish();
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteIds,
    time: plan.context.time,
  });
  return { plan, lowerer, outputs };
}

function buildFieldSelectionPlan(input: {
  readonly targetScope: FactEntity | "observation";
  readonly siteIds: readonly string[];
  readonly attribute: CountFactAttribute;
  readonly operator: FilterOperator;
  readonly value?: FilterConditionValue;
}) {
  const root = {
    kind: "condition",
    target: { kind: "field", field: input.attribute },
    operator: input.operator,
    ...(input.value === undefined ? {} : { value: input.value }),
  };
  return buildFilterSelectionPlan({
    targetScope: input.targetScope,
    siteIds: input.siteIds,
    root,
  });
}

function buildFilterSelectionPlan(input: {
  readonly targetScope: FactEntity | "observation";
  readonly siteIds: readonly string[];
  readonly root: unknown;
}) {
  const builder = new LogicalPlanBuilder(
    createPlanContext(input.targetScope, input.siteIds, FILTER_RANGE),
  );
  const document = normalizeFilterDocument(
    {
      version: 1,
      root: input.root,
    },
    analyticsFilterRegistry,
  );
  const analysis = analyzeFilterDocument(document, analyticsFilterRegistry);
  const selection = lowerFilterDocumentToScope(builder, analysis, {
    targetScope: input.targetScope,
    resolveTemporalDomain: () => "filter",
  });
  if (selection.kind !== "supported")
    throw new Error(`count_fact_filter_lowering_failed:${selection.kind}`);
  builder.output("matches", selection.selection.relation, [
    { name: "identity", slot: "entity" },
  ]);
  const logicalPlan = builder.finish();
  const lowerer = new AnalyticsLogicalToDbLowerer(logicalPlan, {
    siteIds: input.siteIds,
    time: logicalPlan.context.time,
  });
  return { logicalPlan, lowerer };
}

function compileFieldSelection(
  plan: ReturnType<typeof buildFieldSelectionPlan>,
  scope: FactEntity | "observation",
) {
  const output = plan.logicalPlan.outputs[0];
  if (!output) throw new Error("Count fact selection output is missing.");
  const identity = output.fields.find((field) => field.name === "identity");
  if (!identity) throw new Error("Count fact selection omitted its identity.");
  const columns =
    scope === "observation"
      ? [
          { name: "site_pk", slot: identity.slot, component: 0 as const },
          {
            name: "observation_kind",
            slot: identity.slot,
            component: 1 as const,
          },
          { name: "entity_id", slot: identity.slot, component: 2 as const },
        ]
      : [
          { name: "site_pk", slot: identity.slot, component: 0 as const },
          { name: "entity_id", slot: identity.slot, component: 1 as const },
        ];
  const lowered = plan.lowerer.lower(output);
  return compileD1Query(plan.lowerer.projectOutput(lowered, columns));
}

async function executeFieldSelection(
  db: DatabaseSync,
  plan: ReturnType<typeof buildFieldSelectionPlan>,
  scope: FactEntity | "observation",
): Promise<FactResult[]> {
  const query = compileFieldSelection(plan, scope);
  const result = await createD1DatabaseClient(createSqliteD1Database(db)).all(
    query,
  );
  return [...(result.results as FactResult[])].sort((left, right) => {
    const siteDifference = Number(left.site_pk) - Number(right.site_pk);
    if (siteDifference !== 0) return siteDifference;
    const leftKind = String(left.observation_kind ?? "");
    const rightKind = String(right.observation_kind ?? "");
    if (leftKind !== rightKind) return leftKind < rightKind ? -1 : 1;
    const leftId = String(left.entity_id ?? "");
    const rightId = String(right.entity_id ?? "");
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

async function executeNamedOutput(
  db: DatabaseSync,
  plan: ReturnType<typeof buildFactPlan>,
  outputSpec: NamedOutput,
): Promise<FactResult[]> {
  const output = plan.plan.outputs.find(
    (candidate) => candidate.id === outputSpec.name,
  );
  if (!output) throw new Error(`Missing logical output ${outputSpec.name}.`);
  const lowered = plan.lowerer.lower(output);
  if (outputSpec.countOnly) {
    const count = output.fields.find((field) => field.name === "sourceRows");
    if (!count) throw new Error("COUNT_ROWS output omitted its value.");
    const query = compileD1Query(
      plan.lowerer.projectOutput(lowered, [
        { name: "sourceRows", slot: count.slot },
      ]),
    );
    const result = await createD1DatabaseClient(createSqliteD1Database(db)).all(
      query,
    );
    return result.results as FactResult[];
  }
  const identity = output.fields.find((field) => field.name === "identity");
  if (!identity) throw new Error("Count fact output omitted its identity.");
  const columns = [
    { name: "site_pk", slot: identity.slot, component: 0 as const },
    { name: "entity_id", slot: identity.slot, component: 1 as const },
    ...outputSpec.attributes.map((attribute) => {
      const field = output.fields.find(
        (candidate) => candidate.name === attribute,
      );
      if (!field) throw new Error(`Count fact output omitted ${attribute}.`);
      return { name: attribute, slot: field.slot };
    }),
  ];
  const query = compileD1Query(plan.lowerer.projectOutput(lowered, columns));
  const result = await createD1DatabaseClient(createSqliteD1Database(db)).all(
    query,
  );
  return sortRows(result.results as FactResult[]);
}

function seedNormalActivityScenario(db: DatabaseSync): Site[] {
  db.exec("PRAGMA foreign_keys = OFF");
  const siteA = insertSite(db, SITE_A);
  const siteB = insertSite(db, SITE_B);
  const eventNameA = insertEventName(db, siteA, "purchase");
  const eventNameB = insertEventName(db, siteB, "purchase");

  const pagesA = [
    ["a-main-100", "s-main-1", "v-main", 100, "/first"],
    ["a-main-199", "s-main-1", "v-main", 199, "/last"],
    ["a-main-session-2", "s-main-2", "v-main", 150, "/second-session"],
    ["a-shared-alpha", "s-shared", "v-alpha", 140, "/alpha"],
    ["a-shared-beta", "s-shared", "v-beta", 160, "/beta"],
    ["a-empty-session", "", "v-main", 120, "/empty-session"],
    ["a-space-session", " ", " ", 125, "/space"],
    ["a-nbsp-session", "\u00a0", "\u00a0", 126, "/nbsp"],
    ["a-unicode-session", "会话", "访客", 127, "/unicode"],
    ["a-case-session", "Case", "Case", 128, "/case"],
    ["a-lower-session", "case", "case", 129, "/lowercase"],
    ["a-empty-visitor", "s-empty-visitor", "", 130, "/empty-visitor"],
    ["a-page-only", "s-page-only", "v-page-only", 180, "/page-only"],
    ["a-event-only-owner", "s-event-only", "v-event-only", 250, "/outside"],
    ["a-before", "s-before", "v-before", 99, "/before"],
    ["a-at-end", "s-at-end", "v-at-end", 200, "/end"],
  ] as const;
  for (const [id, sessionId, visitorId, time, path] of pagesA) {
    insertPage(db, siteA, { id, sessionId, visitorId, time, path });
  }
  insertPage(db, siteA, {
    id: "a-history-only",
    sessionId: "s-history-only",
    visitorId: "v-history-only",
    time: 220,
    path: "/history-only",
  });
  insertPage(db, siteB, {
    id: "b-same-raw-identities",
    sessionId: "s-main-1",
    visitorId: "v-main",
    time: 110,
    path: "/other-site",
  });

  const eventsA = [
    ["event-a-at-start", "a-main-100", eventNameA, 100],
    ["event-a-before-end", "a-main-199", eventNameA, 199],
    ["event-a-before-range", "a-main-100", eventNameA, 99],
    ["event-a-at-end", "a-main-100", eventNameA, 200],
    ["event-a-outside-owner", "a-event-only-owner", eventNameA, 150],
    ["event-a-shared-a", "a-shared-alpha", eventNameA, 170],
  ] as const;
  for (const [id, ownerVisitId, eventNameId, time] of eventsA) {
    insertEvent(db, siteA, { id, ownerVisitId, eventNameId, time });
  }
  insertEvent(db, siteA, {
    id: "event-a-history-only",
    ownerVisitId: "a-history-only",
    eventNameId: eventNameA,
    time: 230,
  });
  insertEvent(db, siteA, {
    id: "event-a-event-only-owner-again",
    ownerVisitId: "a-event-only-owner",
    eventNameId: eventNameA,
    time: 175,
  });
  insertEvent(db, siteA, {
    id: "event-a-missing-dictionary",
    ownerVisitId: "a-main-100",
    eventNameId: 9_999_999,
    time: 140,
  });
  insertEvent(db, siteA, {
    id: "event-a-foreign-dictionary",
    ownerVisitId: "a-main-100",
    eventNameId: eventNameB,
    time: 141,
  });
  insertEvent(db, siteA, {
    id: "event-a-missing-owner",
    ownerVisitId: "missing-owner",
    eventNameId: eventNameA,
    time: 142,
  });
  insertEvent(db, siteA, {
    id: "event-a-cross-site-owner",
    ownerVisitId: "b-same-raw-identities",
    eventNameId: eventNameA,
    time: 143,
  });
  insertEvent(db, siteB, {
    id: "event-b-same-raw-identities",
    ownerVisitId: "b-same-raw-identities",
    eventNameId: eventNameB,
    time: 150,
  });
  return [siteA, siteB];
}

describe("typed Session and Visitor canonical count-fact Sources", () => {
  it("matches the migrated activity oracle and keeps every output on one row domain", async () => {
    const db = createMigratedDatabase();
    try {
      const sites = seedNormalActivityScenario(db);
      for (const entity of ["session", "visitor"] as const) {
        const declared = entity === "session" ? SESSION_FACTS : VISITOR_FACTS;
        const plan = buildFactPlan(
          entity,
          sites.map((site) => site.id),
          declared,
        );
        const expected = canonicalExpectedRows(db, sites, entity, declared);
        const allA = await executeNamedOutput(db, plan, plan.outputs[0]!);
        const identityOnly = await executeNamedOutput(
          db,
          plan,
          plan.outputs[1]!,
        );
        const singleFact = await executeNamedOutput(db, plan, plan.outputs[2]!);
        const allARepeat = await executeNamedOutput(db, plan, plan.outputs[3]!);
        const identityOnlySource = await executeNamedOutput(
          db,
          plan,
          plan.outputs[4]!,
        );
        const singleFactSource = await executeNamedOutput(
          db,
          plan,
          plan.outputs[5]!,
        );
        const hiddenCount = await executeNamedOutput(
          db,
          plan,
          plan.outputs[6]!,
        );

        expect(allA).toEqual(expected);
        expect(
          identityOnly.map(({ site_pk, entity_id }) => ({
            site_pk,
            entity_id,
          })),
        ).toEqual(
          expected.map(({ site_pk, entity_id }) => ({ site_pk, entity_id })),
        );
        expect(
          singleFact.map(({ site_pk, entity_id }) => ({
            site_pk,
            entity_id,
          })),
        ).toEqual(
          expected.map(({ site_pk, entity_id }) => ({ site_pk, entity_id })),
        );
        expect(allARepeat).toEqual(allA);
        expect(
          identityOnlySource.map(({ site_pk, entity_id }) => ({
            site_pk,
            entity_id,
          })),
        ).toEqual(
          expected.map(({ site_pk, entity_id }) => ({ site_pk, entity_id })),
        );
        expect(singleFactSource).toEqual(
          expected.map(({ site_pk, entity_id, [declared[0]!]: value }) => ({
            site_pk,
            entity_id,
            [declared[0]!]: value,
          })),
        );
        expect(hiddenCount).toEqual([{ sourceRows: expected.length }]);
      }

      const sessionRows = canonicalExpectedRows(
        db,
        sites,
        "session",
        SESSION_FACTS,
      );
      const visitorRows = canonicalExpectedRows(
        db,
        sites,
        "visitor",
        VISITOR_FACTS,
      );
      const session = (id: string, sitePk = sites[0]!.pk) =>
        sessionRows.find(
          (row) => row.site_pk === sitePk && row.entity_id === id,
        );
      const visitor = (id: string, sitePk = sites[0]!.pk) =>
        visitorRows.find(
          (row) => row.site_pk === sitePk && row.entity_id === id,
        );

      expect(session("s-main-1")).toMatchObject({
        "session.views": 2,
        "session.events": 2,
        "session.bounce": 0,
      });
      expect(visitor("v-main")).toMatchObject({
        "visitor.sessions": 2,
        "visitor.views": 4,
        "visitor.events": 2,
      });
      expect(session("s-shared")).toMatchObject({
        "session.views": 2,
        "session.events": 1,
      });
      expect(visitor("v-alpha")).toMatchObject({
        "visitor.sessions": 1,
        "visitor.views": 1,
        "visitor.events": 1,
      });
      expect(visitor("v-beta")).toMatchObject({ "visitor.sessions": 1 });
      expect(session("s-page-only")).toMatchObject({
        "session.views": 1,
        "session.events": 0,
        "session.bounce": 1,
      });
      expect(session("s-event-only")).toMatchObject({
        "session.views": 0,
        "session.events": 2,
        "session.bounce": 0,
      });
      expect(visitor("v-event-only")).toMatchObject({
        "visitor.sessions": 1,
        "visitor.views": 0,
        "visitor.events": 2,
      });
      expect(session("")).toBeUndefined();
      expect(visitor("")).toBeUndefined();
      for (const rawId of [" ", "\u00a0", "会话", "Case", "case"]) {
        expect(session(rawId)).toBeDefined();
      }
      for (const rawId of [" ", "\u00a0", "访客", "Case", "case"]) {
        expect(visitor(rawId)).toBeDefined();
      }
      expect(session("s-main-1", sites[1]!.pk)).toMatchObject({
        "session.views": 1,
        "session.events": 1,
      });
      expect(visitor("v-main", sites[1]!.pk)).toMatchObject({
        "visitor.sessions": 1,
        "visitor.views": 1,
        "visitor.events": 1,
      });
    } finally {
      db.close();
    }
  });

  it("counts nullable Page local-id anomalies from SQL without the JS fact oracle", async () => {
    const db = createMigratedDatabase();
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      const site = insertSite(db, SITE_A);
      insertPage(db, site, {
        id: null,
        sessionId: "session-null-local-id",
        visitorId: "visitor-null-local-id",
        time: 125,
      });

      const sqlOracle = db
        .prepare(
          "SELECT session_id, visitor_id, COUNT(*) AS page_rows " +
            "FROM visits WHERE site_pk = ? AND started_at >= ? " +
            "AND started_at < ? GROUP BY session_id, visitor_id",
        )
        .all(site.pk, RANGE.startMs, RANGE.endExclusiveMs) as Array<{
        readonly session_id: string;
        readonly visitor_id: string;
        readonly page_rows: number;
      }>;
      expect(sqlOracle).toEqual([
        {
          session_id: "session-null-local-id",
          visitor_id: "visitor-null-local-id",
          page_rows: 1,
        },
      ]);

      for (const [entity, attributes] of [
        ["session", SESSION_FACTS],
        ["visitor", VISITOR_FACTS],
      ] as const) {
        const plan = buildFactPlan(entity, [site.id], attributes);
        const row = await executeNamedOutput(db, plan, plan.outputs[0]!);
        expect(row).toHaveLength(1);
        expect(row[0]).toMatchObject(
          entity === "session"
            ? {
                entity_id: "session-null-local-id",
                "session.views": sqlOracle[0]!.page_rows,
                "session.events": 0,
                "session.bounce": 1,
              }
            : {
                entity_id: "visitor-null-local-id",
                "visitor.sessions": 1,
                "visitor.views": sqlOracle[0]!.page_rows,
                "visitor.events": 0,
              },
        );
      }
    } finally {
      db.close();
    }
  });

  it("keeps FilterDocument fact matches inside each candidate scope", async () => {
    const db = createMigratedDatabase();
    try {
      const sites = seedNormalActivityScenario(db);
      for (const item of [
        {
          entity: "session",
          attribute: "session.views",
          attributes: SESSION_FACTS,
        },
        {
          entity: "visitor",
          attribute: "visitor.views",
          attributes: VISITOR_FACTS,
        },
      ] as const) {
        const siteIds = sites.map((site) => site.id);
        const historicalFacts = canonicalExpectedRows(
          db,
          sites,
          item.entity,
          item.attributes,
          FILTER_RANGE,
        ).filter((fact) => {
          const value = Number(fact[item.attribute]);
          return value >= 1 && value <= 5;
        });
        const candidateFacts = canonicalExpectedRows(
          db,
          sites,
          item.entity,
          item.attributes,
        );
        const matchedKeys = new Set(
          historicalFacts.map(
            (fact) => `${fact.site_pk}:${String(fact.entity_id)}`,
          ),
        );
        const candidateKeys = new Set(
          candidateFacts.map(
            (fact) => `${fact.site_pk}:${String(fact.entity_id)}`,
          ),
        );
        const expectedNative = sortRows(
          historicalFacts
            .filter((fact) =>
              candidateKeys.has(`${fact.site_pk}:${String(fact.entity_id)}`),
            )
            .map(({ site_pk, entity_id }) => ({ site_pk, entity_id })),
        );
        const nativePlan = buildFieldSelectionPlan({
          targetScope: item.entity,
          siteIds,
          attribute: item.attribute,
          operator: "between",
          value: [1, 5],
        });
        const nativeRows = await executeFieldSelection(
          db,
          nativePlan,
          item.entity,
        );
        expect(nativeRows).toEqual(expectedNative);
        const historyEntityId =
          item.entity === "session" ? "s-history-only" : "v-history-only";
        expect(matchedKeys).toContain(`${sites[0]!.pk}:${historyEntityId}`);
        expect(nativeRows).not.toContainEqual({
          site_pk: sites[0]!.pk,
          entity_id: historyEntityId,
        });

        const identityField =
          item.entity === "session" ? "session_id" : "visitor_id";
        const expectedObservations = sites.flatMap((site) =>
          rawCandidateObservationRows(db, site.pk).flatMap((activity) => {
            const factIdentity =
              identityField === "session_id"
                ? activity.sessionId
                : activity.visitorId;
            if (factIdentity === "") return [];
            if (!matchedKeys.has(`${site.pk}:${factIdentity}`)) return [];
            return [
              {
                site_pk: site.pk,
                observation_kind: activity.kind,
                entity_id: activity.activityId,
              },
            ];
          }),
        );
        const observationPlan = buildFieldSelectionPlan({
          targetScope: "observation",
          siteIds,
          attribute: item.attribute,
          operator: "between",
          value: [1, 5],
        });
        const observationRows = await executeFieldSelection(
          db,
          observationPlan,
          "observation",
        );
        const sortObservations = (rows: readonly FactResult[]) =>
          [...rows].sort((left, right) => {
            const siteDifference = Number(left.site_pk) - Number(right.site_pk);
            if (siteDifference !== 0) return siteDifference;
            const leftKind = String(left.observation_kind ?? "");
            const rightKind = String(right.observation_kind ?? "");
            if (leftKind !== rightKind) return leftKind < rightKind ? -1 : 1;
            const leftId = String(left.entity_id ?? "");
            const rightId = String(right.entity_id ?? "");
            return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
          });
        expect(observationRows).toEqual(sortObservations(expectedObservations));
        expect(observationRows).not.toContainEqual({
          site_pk: sites[0]!.pk,
          observation_kind: "page",
          entity_id: "a-history-only",
        });
        expect(observationRows).not.toContainEqual({
          site_pk: sites[0]!.pk,
          observation_kind: "event",
          entity_id: "event-a-history-only",
        });
      }
    } finally {
      db.close();
    }
  });

  it("compares the integer-backed Session bounce fact as a Filter boolean", async () => {
    const db = createMigratedDatabase();
    try {
      const sites = seedNormalActivityScenario(db);
      const siteIds = sites.map((site) => site.id);
      const historicalFacts = canonicalExpectedRows(
        db,
        sites,
        "session",
        SESSION_FACTS,
        FILTER_RANGE,
      );
      const candidateKeys = new Set(
        canonicalExpectedRows(db, sites, "session", SESSION_FACTS).map(
          (fact) => `${fact.site_pk}:${String(fact.entity_id)}`,
        ),
      );

      for (const bounce of [true, false] as const) {
        const expected = sortRows(
          historicalFacts
            .filter(
              (fact) =>
                Boolean(fact["session.bounce"]) === bounce &&
                candidateKeys.has(`${fact.site_pk}:${String(fact.entity_id)}`),
            )
            .map(({ site_pk, entity_id }) => ({ site_pk, entity_id })),
        );
        const plan = buildFieldSelectionPlan({
          targetScope: "session",
          siteIds,
          attribute: "session.bounce",
          operator: "eq",
          value: bounce,
        });
        expect(await executeFieldSelection(db, plan, "session")).toEqual(
          expected,
        );
      }

      for (const operator of ["in", "notIn"] as const) {
        expect(() =>
          buildFieldSelectionPlan({
            targetScope: "session",
            siteIds,
            attribute: "session.bounce",
            operator,
            value: [true, false],
          }),
        ).toThrow(/Operator is not allowed for this field/u);
      }
    } finally {
      db.close();
    }
  });

  it("executes scalar, set, presence, and null predicates on fact sources", async () => {
    const db = createMigratedDatabase();
    try {
      const sites = seedNormalActivityScenario(db);
      const siteIds = sites.map((site) => site.id);
      const cases = [
        {
          entity: "session",
          attribute: "session.views",
          attributes: SESSION_FACTS,
        },
        {
          entity: "visitor",
          attribute: "visitor.sessions",
          attributes: VISITOR_FACTS,
        },
      ] as const;
      const operators: ReadonlyArray<{
        readonly operator: FilterOperator;
        readonly value?: FilterConditionValue;
        readonly matches: (value: number) => boolean;
      }> = [
        { operator: "eq", value: 2, matches: (value) => value === 2 },
        { operator: "neq", value: 2, matches: (value) => value !== 2 },
        { operator: "gt", value: 2, matches: (value) => value > 2 },
        { operator: "gte", value: 2, matches: (value) => value >= 2 },
        { operator: "lt", value: 2, matches: (value) => value < 2 },
        { operator: "lte", value: 2, matches: (value) => value <= 2 },
        {
          operator: "in",
          value: [1, 3],
          matches: (value) => value === 1 || value === 3,
        },
        {
          operator: "notIn",
          value: [1, 3],
          matches: (value) => value !== 1 && value !== 3,
        },
        { operator: "exists", matches: () => true },
        { operator: "notExists", matches: () => false },
        { operator: "isNull", matches: () => false },
        { operator: "notNull", matches: () => true },
      ];

      for (const item of cases) {
        const historicalFacts = canonicalExpectedRows(
          db,
          sites,
          item.entity,
          item.attributes,
          FILTER_RANGE,
        );
        const candidateFacts = canonicalExpectedRows(
          db,
          sites,
          item.entity,
          item.attributes,
        );
        for (const predicate of operators) {
          const matchedHistoryKeys = new Set(
            historicalFacts
              .filter((fact) => predicate.matches(Number(fact[item.attribute])))
              .map((fact) => `${fact.site_pk}:${String(fact.entity_id)}`),
          );
          const expectedNative = sortRows(
            candidateFacts
              .filter((fact) =>
                matchedHistoryKeys.has(
                  `${fact.site_pk}:${String(fact.entity_id)}`,
                ),
              )
              .map(({ site_pk, entity_id }) => ({ site_pk, entity_id })),
          );
          const nativePlan = buildFieldSelectionPlan({
            targetScope: item.entity,
            siteIds,
            attribute: item.attribute,
            operator: predicate.operator,
            ...(predicate.value === undefined
              ? {}
              : { value: predicate.value }),
          });
          expect(
            await executeFieldSelection(db, nativePlan, item.entity),
          ).toEqual(expectedNative);

          const expectedObservations = sites.flatMap((site) =>
            rawCandidateObservationRows(db, site.pk).flatMap((activity) => {
              const factIdentity =
                item.entity === "session"
                  ? activity.sessionId
                  : activity.visitorId;
              if (
                factIdentity === "" ||
                !matchedHistoryKeys.has(`${site.pk}:${factIdentity}`)
              )
                return [];
              return [
                {
                  site_pk: site.pk,
                  observation_kind: activity.kind,
                  entity_id: activity.activityId,
                },
              ];
            }),
          );
          const observationPlan = buildFieldSelectionPlan({
            targetScope: "observation",
            siteIds,
            attribute: item.attribute,
            operator: predicate.operator,
            ...(predicate.value === undefined
              ? {}
              : { value: predicate.value }),
          });
          expect(
            await executeFieldSelection(db, observationPlan, "observation"),
          ).toEqual(sortObservationRows(expectedObservations));
        }
      }

      const unsupportedBuilder = new LogicalPlanBuilder(
        createPlanContext("session", siteIds),
      );
      expect(() =>
        normalizeFilterDocument(
          {
            version: 1,
            root: {
              kind: "condition",
              target: { kind: "field", field: "session.views" },
              operator: "isEmpty",
            },
          },
          analyticsFilterRegistry,
        ),
      ).toThrow(/Operator is not allowed for this field/u);
      expect(unsupportedBuilder.finish().nodes).toEqual([]);

      const largeNumericSet = buildFieldSelectionPlan({
        targetScope: "session",
        siteIds,
        attribute: "session.views",
        operator: "in",
        value: Array.from({ length: 100 }, (_, index) => index),
      });
      expect(() => compileFieldSelection(largeNumericSet, "session")).toThrow(
        expect.objectContaining({
          code: "d1_statement_budget_exceeded",
          item: "bindings",
          limit: 100,
        }),
      );
    } finally {
      db.close();
    }
  });

  it("preserves AND, OR, and root NOT for Session and Visitor facts", async () => {
    const db = createMigratedDatabase();
    try {
      const sites = seedNormalActivityScenario(db);
      const siteIds = sites.map((site) => site.id);
      const cases = [
        {
          entity: "session",
          attributes: SESSION_FACTS,
          root: {
            kind: "and",
            children: [
              {
                kind: "condition",
                target: { kind: "field", field: "session.views" },
                operator: "gte",
                value: 2,
              },
              {
                kind: "or",
                children: [
                  {
                    kind: "condition",
                    target: { kind: "field", field: "session.events" },
                    operator: "neq",
                    value: 0,
                  },
                  {
                    kind: "condition",
                    target: { kind: "field", field: "session.bounce" },
                    operator: "eq",
                    value: true,
                  },
                ],
              },
            ],
          },
          matches: (fact: FactResult) =>
            Number(fact["session.views"]) >= 2 &&
            (Number(fact["session.events"]) !== 0 ||
              Boolean(fact["session.bounce"])),
          matchesObservation: (fact: FactResult | undefined) =>
            fact !== undefined &&
            Number(fact["session.views"]) >= 2 &&
            (Number(fact["session.events"]) !== 0 ||
              Boolean(fact["session.bounce"])),
        },
        {
          entity: "visitor",
          attributes: VISITOR_FACTS,
          root: {
            kind: "not",
            child: {
              kind: "or",
              children: [
                {
                  kind: "condition",
                  target: { kind: "field", field: "visitor.sessions" },
                  operator: "eq",
                  value: 0,
                },
                {
                  kind: "condition",
                  target: { kind: "field", field: "visitor.events" },
                  operator: "gte",
                  value: 2,
                },
              ],
            },
          },
          matches: (fact: FactResult) =>
            !(
              Number(fact["visitor.sessions"]) === 0 ||
              Number(fact["visitor.events"]) >= 2
            ),
          matchesObservation: (fact: FactResult | undefined) =>
            fact === undefined ||
            !(
              Number(fact["visitor.sessions"]) === 0 ||
              Number(fact["visitor.events"]) >= 2
            ),
        },
      ] as const;

      for (const item of cases) {
        const historicalFacts = canonicalExpectedRows(
          db,
          sites,
          item.entity,
          item.attributes,
          FILTER_RANGE,
        );
        const candidateFacts = canonicalExpectedRows(
          db,
          sites,
          item.entity,
          item.attributes,
        );
        const matchedHistoryKeys = new Set(
          historicalFacts
            .filter(item.matches)
            .map((fact) => `${fact.site_pk}:${String(fact.entity_id)}`),
        );
        const historicalByIdentity = new Map(
          historicalFacts.map((fact) => [
            `${fact.site_pk}:${String(fact.entity_id)}`,
            fact,
          ]),
        );
        const expectedNative = sortRows(
          candidateFacts
            .filter((fact) =>
              matchedHistoryKeys.has(
                `${fact.site_pk}:${String(fact.entity_id)}`,
              ),
            )
            .map(({ site_pk, entity_id }) => ({ site_pk, entity_id })),
        );
        const nativePlan = buildFilterSelectionPlan({
          targetScope: item.entity,
          siteIds,
          root: item.root,
        });
        expect(
          await executeFieldSelection(db, nativePlan, item.entity),
        ).toEqual(expectedNative);

        const expectedObservations = sites.flatMap((site) =>
          rawCandidateObservationRows(db, site.pk).flatMap((activity) => {
            const factIdentity =
              item.entity === "session"
                ? activity.sessionId
                : activity.visitorId;
            if (
              !item.matchesObservation(
                historicalByIdentity.get(`${site.pk}:${factIdentity}`),
              )
            )
              return [];
            return [
              {
                site_pk: site.pk,
                observation_kind: activity.kind,
                entity_id: activity.activityId,
              },
            ];
          }),
        );
        const observationPlan = buildFilterSelectionPlan({
          targetScope: "observation",
          siteIds,
          root: item.root,
        });
        expect(
          await executeFieldSelection(db, observationPlan, "observation"),
          `${item.entity} Observation`,
        ).toEqual(sortObservationRows(expectedObservations));
      }
    } finally {
      db.close();
    }
  });

  it("returns no facts for an empty temporal activity domain", async () => {
    const db = createMigratedDatabase();
    try {
      const site = insertSite(db, SITE_A);
      for (const [entity, attributes] of [
        ["session", SESSION_FACTS],
        ["visitor", VISITOR_FACTS],
      ] as const) {
        const plan = buildFactPlan(entity, [site.id], attributes);
        expect(await executeNamedOutput(db, plan, plan.outputs[0]!)).toEqual(
          [],
        );
      }
    } finally {
      db.close();
    }
  });

  it("rejects cross-entity facts, session.visitor, and duration declarations", () => {
    expect(() =>
      analyticsScopeFactContract("session.unknown", "session", "$.values"),
    ).toThrow(/not a supported canonical Session\/Visitor fact/u);
    expect(() =>
      analyticsScopeFactContract("session.views", "visitor", "$.values"),
    ).toThrow(/no longer matches the canonical D1 scope-fact contract/u);

    const crossEntityBuilder = new LogicalPlanBuilder(
      createPlanContext("visitor", [SITE_A]),
    );
    expect(() =>
      crossEntityBuilder.source("visitor", {
        temporalDomain: "candidate",
        attributes: ["session.views"],
      }),
    ).toThrow(/logical_source_invalid_attribute/u);

    const durationBuilder = new LogicalPlanBuilder(
      createPlanContext("session", [SITE_A]),
    );
    const durationSource = durationBuilder.source("session", {
      temporalDomain: "candidate",
      attributes: ["session.durationMs"],
    });
    durationBuilder.output("unused-unsupported-duration", durationSource, [
      { name: "identity", slot: "entity" },
    ]);
    const durationPlan = durationBuilder.finish();
    const durationLowerer = new AnalyticsLogicalToDbLowerer(durationPlan, {
      siteIds: [SITE_A],
      time: durationPlan.context.time,
    });
    expect(() => durationLowerer.lower(durationPlan.outputs[0]!)).toThrow();

    const relationshipBuilder = new LogicalPlanBuilder(
      createPlanContext("session", [SITE_A]),
    );
    const relationshipSource = relationshipBuilder.source("session", {
      temporalDomain: "candidate",
      relationships: ["session.visitor"],
    });
    relationshipBuilder.output("unsupported-visitor", relationshipSource, [
      { name: "visitor", slot: "relationship:session.visitor" },
    ]);
    const relationshipPlan = relationshipBuilder.finish();
    const relationshipLowerer = new AnalyticsLogicalToDbLowerer(
      relationshipPlan,
      { siteIds: [SITE_A], time: relationshipPlan.context.time },
    );
    expect(() =>
      relationshipLowerer.lower(relationshipPlan.outputs[0]!),
    ).toThrow();

    const occurrenceBuilder = new LogicalPlanBuilder(
      createPlanContext("session", [SITE_A]),
    );
    expect(() =>
      occurrenceBuilder.source("session", {
        temporalDomain: "candidate",
        includeOccurrenceTime: true,
      }),
    ).toThrow(/logical_source_occurrence_time_unavailable/u);
    expect(occurrenceBuilder.finish().nodes).toHaveLength(0);

    const baseContext = createPlanContext("session", [SITE_A]);
    const retainedContext = {
      ...baseContext,
      time: createSemanticTemporalDomains({
        candidate: RANGE as never,
        read: { kind: "retained-history" },
        reportingTimeZone: "UTC" as never,
        capturedAtMs: 300 as never,
      }),
    };
    const retainedBuilder = new LogicalPlanBuilder(retainedContext);
    const retainedSource = retainedBuilder.source("session", {
      temporalDomain: "read",
      attributes: SESSION_FACTS,
    });
    retainedBuilder.output("unsupported-retained-facts", retainedSource, [
      { name: "identity", slot: "entity" },
    ]);
    const retainedPlan = retainedBuilder.finish();
    const retainedLowerer = new AnalyticsLogicalToDbLowerer(retainedPlan, {
      siteIds: [SITE_A],
      time: retainedPlan.context.time,
    });
    expect(() => retainedLowerer.lower(retainedPlan.outputs[0]!)).toThrow(
      /not a safe bounded D1 range/u,
    );
  });
});
