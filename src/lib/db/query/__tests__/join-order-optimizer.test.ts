import type { DatabaseSync } from "node:sqlite";
import { type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  aggregate,
  castText,
  compileD1Query,
  count,
  distinct,
  eq,
  filter,
  inList,
  join,
  limit,
  lowerLogicalPlan,
  max,
  param,
  project,
  rowNumber,
  scalar,
  scan,
  sort,
  union,
  unixepoch,
  valuesRelation,
  window,
} from "@/lib/db";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import type { Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

function makeTargetRows(selector: "single" | "multi" | "domain-only") {
  const visits = scan(schema.visits);
  let selectedVisits = visits;
  if (selector === "single")
    selectedVisits = filter(
      visits,
      eq(visits.columns.visitor_id, param("target-visitor")),
    );
  else if (selector === "multi")
    selectedVisits = filter(
      visits,
      inList(visits.columns.visitor_id, ["visitor-a", "visitor-b"]),
    );
  else {
    const sites = scan(schema.site_identities);
    const selectedSite = filter(
      sites,
      eq(sites.columns.site_id, param("target-site")),
    );
    const scopedVisits = join(
      visits,
      selectedSite,
      eq(visits.columns.site_id, selectedSite.columns.site_id),
    );
    return project(scopedVisits, {
      visitId: scopedVisits.columns.left_visit_id,
      visitorId: scopedVisits.columns.left_visitor_id,
      sessionId: scopedVisits.columns.left_session_id,
      startedAt: scopedVisits.columns.left_started_at,
      siteId: scopedVisits.columns.left_site_id,
      status: scopedVisits.columns.left_status,
    });
  }
  return project(selectedVisits, {
    visitId: selectedVisits.columns.visit_id,
    visitorId: selectedVisits.columns.visitor_id,
    sessionId: selectedVisits.columns.session_id,
    startedAt: selectedVisits.columns.started_at,
    siteId: selectedVisits.columns.site_id,
    status: selectedVisits.columns.status,
  });
}

function buildQuery(input: {
  readonly selector?: "single" | "multi" | "domain-only";
  readonly nameJoin?: "inner" | "left";
  readonly sideLookup?: "none" | "partial-unique" | "one-to-many";
  readonly nameLookupValue?: "single" | "null" | "multi";
  readonly ownerAggregation?: "stable" | "volatile" | "subquery";
  readonly extraGroupKey?: boolean;
  readonly rightBarrier?: "window" | "set" | "sort" | "limit" | "distinct";
}) {
  const targetRows = makeTargetRows(input.selector ?? "single");
  const ownerInput = project(targetRows, {
    visitId: targetRows.columns.visitId,
    ownerId: targetRows.columns.visitorId,
  });
  const scalarSource = valuesRelation(
    { value: { affinity: "text", nullable: false } } as const,
    [{ value: "scalar-owner" }] as const,
  );
  const ownerValue =
    input.ownerAggregation === "volatile"
      ? castText(unixepoch())
      : input.ownerAggregation === "subquery"
        ? castText(scalar(scalarSource))
        : ownerInput.columns.ownerId;
  const ownerGroups = input.extraGroupKey
    ? aggregate(ownerInput, {
        groupBy: {
          visitId: ownerInput.columns.visitId,
          ownerPartition: ownerInput.columns.ownerId,
        },
        aggregates: {
          ownerId: max(ownerValue as typeof ownerInput.columns.ownerId),
        },
      })
    : aggregate(ownerInput, {
        groupBy: { visitId: ownerInput.columns.visitId },
        aggregates: {
          ownerId: max(ownerValue as typeof ownerInput.columns.ownerId),
        },
      });
  const owners = project(ownerGroups, {
    visitId: ownerGroups.columns.visitId,
    ownerId: ownerGroups.columns.ownerId,
  });
  let rightOwners = owners;
  if (input.rightBarrier === "window")
    rightOwners = window(rightOwners, {
      rank: rowNumber({
        orderBy: [
          { expression: rightOwners.columns.visitId, direction: "ASC" },
        ],
      }),
    });
  else if (input.rightBarrier === "set")
    rightOwners = union(rightOwners, rightOwners, true);
  else if (input.rightBarrier === "sort")
    rightOwners = sort(rightOwners, [
      { expression: rightOwners.columns.visitId, direction: "ASC" },
    ]);
  else if (input.rightBarrier === "limit") rightOwners = limit(rightOwners, 20);
  else if (input.rightBarrier === "distinct")
    rightOwners = distinct(rightOwners);

  const events = scan(schema.custom_events);
  let eventRows: Relation = events;
  let eventVisitId: typeof events.columns.visit_id = events.columns.visit_id;
  if (input.sideLookup === "partial-unique") {
    const members = scan(schema.team_members);
    const selectedMembers = filter(
      members,
      eq(members.columns.team_id, param("target-team")),
    );
    eventRows = join(
      events,
      selectedMembers,
      eq(events.columns.user_id, selectedMembers.columns.user_id),
    );
    eventVisitId = eventRows.columns["left_visit_id"] as typeof eventVisitId;
  } else if (input.sideLookup === "one-to-many") {
    const visits = scan(schema.visits);
    const selectedVisits = filter(
      visits,
      eq(visits.columns.session_id, param("target-session")),
    );
    eventRows = join(
      events,
      selectedVisits,
      eq(events.columns.visit_id, selectedVisits.columns.session_id),
    );
    eventVisitId = eventRows.columns["left_visit_id"] as typeof eventVisitId;
  } else {
    const names = scan(schema.custom_event_names);
    const selectedNameFilter =
      input.nameLookupValue === "null"
        ? filter(names, eq(names.columns.id, param(null)))
        : input.nameLookupValue === "multi"
          ? filter(names, inList(names.columns.id, [17, 18]))
          : filter(names, eq(names.columns.id, param(17)));
    const selectedName = project(selectedNameFilter, {
      id: selectedNameFilter.columns.id,
    });
    eventRows = join(
      events,
      selectedName,
      eq(events.columns.event_name_id, selectedName.columns.id),
      input.nameJoin ?? "inner",
    );
    eventVisitId = eventRows.columns["left_visit_id"] as typeof eventVisitId;
  }

  const ownedEvents = join(
    eventRows,
    rightOwners,
    eq(eventVisitId, rightOwners.columns.visitId),
  );
  const eventCounts = aggregate(ownedEvents, {
    groupBy: { visitorId: ownedEvents.columns.right_ownerId },
    aggregates: { count: count() },
  });
  const eventBranch = project(eventCounts, {
    visitorId: eventCounts.columns.visitorId,
    count: eventCounts.columns.count,
  });
  const summaryBranch = () => {
    const summary = aggregate(targetRows, {
      groupBy: { visitorId: targetRows.columns.visitorId },
      aggregates: { count: count() },
    });
    return project(summary, {
      visitorId: summary.columns.visitorId,
      count: summary.columns.count,
    });
  };
  return {
    output: union(
      union(eventBranch, summaryBranch(), true),
      summaryBranch(),
      true,
    ),
    targetRows,
    eventNameJoin: input.nameJoin ?? "inner",
  };
}

function rows(
  db: DatabaseSync,
  query: { sql: string; bindings?: readonly unknown[] },
) {
  return db
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[]))
    .map((row) => JSON.stringify(row))
    .sort();
}

function createMigratedFixtureDatabase() {
  const db = createMigratedDatabase();
  db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run("site-a");
  const sitePk = (
    db
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get("site-a") as { readonly site_pk: number }
  ).site_pk;
  const visitColumns = [
    "visit_id",
    "site_id",
    "visitor_id",
    "session_id",
    "status",
    "started_at",
    "last_activity_at",
    "ended_at",
    "duration_ms",
    "pathname",
    "hostname",
    "user_id",
    "user_name",
    "country",
    "region",
    "region_code",
    "city",
    "referrer_host",
    "referrer_url",
    "browser",
    "browser_version",
    "os",
    "os_version",
    "device_type",
    "screen_width",
    "screen_height",
    "latitude",
    "longitude",
    "site_pk",
  ];
  const insertVisit = (
    visitId: string,
    visitorId: string,
    sessionId: string,
    startedAt: number,
  ) => {
    const values: SQLInputValue[] = [
      visitId,
      "site-a",
      visitorId,
      sessionId,
      "closed",
      startedAt,
      startedAt,
      null,
      null,
      `/${visitId}`,
      "join-order.fixture",
      null,
      null,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      null,
      null,
      null,
      null,
      sitePk,
    ];
    db.prepare(
      `INSERT INTO visits (${visitColumns.join(", ")}) VALUES (${visitColumns.map(() => "?").join(", ")})`,
    ).run(...values);
  };
  insertVisit("visit-a", "target-visitor", "session-a", 10);
  insertVisit("visit-b", "target-visitor", "session-b", 20);
  insertVisit("visit-c", "other-visitor", "session-c", 30);
  for (const [id, name] of [
    [17, "click"],
    [18, "view"],
  ] as const)
    db.prepare(
      "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, 30, ?)",
    ).run(id, "site-a", name, sitePk);
  for (const [eventId, visitId, nameId, occurredAt] of [
    ["event-a1", "visit-a", 17, 10],
    ["event-a2", "visit-a", 17, 11],
    ["event-b", "visit-b", 18, 20],
    ["event-c", "visit-c", 17, 30],
  ] as const)
    db.prepare(
      "INSERT INTO custom_events (event_id, site_id, visit_id, event_name_id, occurred_at, received_at, node_count, value_count, site_pk) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)",
    ).run(eventId, "site-a", visitId, nameId, occurredAt, occurredAt, sitePk);
  return db;
}

describe("typed join-order optimizer", () => {
  it("uses independently built shared target facts and a proven unique lookup without changing the result bag", () => {
    const { output, targetRows } = buildQuery({ selector: "single" });
    const physical = lowerLogicalPlan(output);
    const shared = physical.sharedRelations.find(
      ({ node }) => node === targetRows.node,
    );
    expect(shared).toMatchObject({ materialization: "materialized" });
    expect(physical.joinOrderStrategies.map(({ kind }) => kind)).toEqual([
      "right-anchor",
      "unique-lookup",
    ]);

    const db = createMigratedFixtureDatabase();
    try {
      const optimized = compileD1Query(physical);
      const mechanical = compileD1QueryUnoptimizedForTest(output);
      expect(optimized.sql.match(/CROSS JOIN/gu)).toHaveLength(2);
      expect(rows(db, optimized)).toEqual(rows(db, mechanical));

      const forged = {
        ...physical,
        joinOrderStrategies: physical.joinOrderStrategies.map((strategy) =>
          strategy.kind === "unique-lookup"
            ? { ...strategy, uniqueKey: "index:forged-expression-index" }
            : strategy,
        ),
      };
      expect(() => compileD1Query(forged as never)).toThrow(
        /join order strategies are inconsistent/u,
      );
    } finally {
      db.close();
    }
  });

  it.each([
    ["a domain-only unique lookup", { selector: "domain-only" as const }],
    ["a multi-value target selector", { selector: "multi" as const }],
  ])("does not infer a target anchor from %s", (_label, options) => {
    const { output } = buildQuery(options);
    expect(lowerLogicalPlan(output).joinOrderStrategies).toEqual([]);
  });

  it.each([
    ["a NULL lookup value", "null" as const],
    ["a multi-value lookup", "multi" as const],
  ])("does not select unique-lookup for %s", (_label, nameLookupValue) => {
    const { output } = buildQuery({ selector: "single", nameLookupValue });
    expect(
      lowerLogicalPlan(output).joinOrderStrategies.map(({ kind }) => kind),
    ).toEqual(["right-anchor"]);
  });

  it.each([
    ["volatile aggregate input", { ownerAggregation: "volatile" as const }],
    [
      "scalar-subquery aggregate input",
      { ownerAggregation: "subquery" as const },
    ],
    ["incomplete multi-column group key", { extraGroupKey: true }],
  ])(
    "rejects an unsafe or incomplete owner aggregate: %s",
    (_label, options) => {
      const { output } = buildQuery(options);
      expect(lowerLogicalPlan(output).joinOrderStrategies).toEqual([]);
    },
  );

  it.each(["window", "set", "sort", "limit", "distinct"] as const)(
    "does not push through a %s barrier between the grouped owner and event join",
    (rightBarrier) => {
      const { output } = buildQuery({ selector: "single", rightBarrier });
      expect(lowerLogicalPlan(output).joinOrderStrategies).toEqual([]);
    },
  );

  it.each([
    ["a partial unique index", "partial-unique" as const],
    ["a one-to-many lookup", "one-to-many" as const],
  ])("does not treat %s as a unique lookup proof", (_label, sideLookup) => {
    const { output } = buildQuery({ sideLookup });
    expect(lowerLogicalPlan(output).joinOrderStrategies).toEqual([]);
  });

  it("keeps a unique lookup on a LEFT JOIN nullable side out of join-order strategies", () => {
    const { output } = buildQuery({ selector: "single", nameJoin: "left" });
    const physical = lowerLogicalPlan(output);
    expect(physical.joinOrderStrategies.map(({ kind }) => kind)).toEqual([
      "right-anchor",
    ]);

    const db = createMigratedFixtureDatabase();
    try {
      expect(rows(db, compileD1Query(physical))).toEqual(
        rows(db, compileD1QueryUnoptimizedForTest(output)),
      );
    } finally {
      db.close();
    }
  });
});
