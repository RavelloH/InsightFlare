// @vitest-environment node
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { composeBoundCtes } from "@/lib/edge/analytics/providers/d1/internal/filter-qualification";
import { compileCollectionSqlQualification } from "@/lib/edge/analytics/providers/d1/internal/filter-sql-collections";
import { expandCustomEventData } from "@/lib/edge/ingest/custom-event-json";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const source = `
  scope_raw_visits(site_pk, site_id, visit_id, session_id, visitor_id, pathname, duration_ms, started_at) AS (
    VALUES (1,'a','v1','s1','u1','/landing',1,10),
           (1,'a','v2','s1','u1','/pricing',1,25),
           (1,'a','v3','s2','u2','/landing',1,10),
           (2,'b','v1','s1','u1','/landing',1,10)
  ),
  scope_raw_events(site_pk, site_id, event_pk, event_id, visit_id, session_id, visitor_id, pathname, event_name, occurred_at) AS (
    VALUES (1,'a',101,'e1','v1','s1','u1','/landing','signup',20),
           (1,'a',102,'e2','v2','s1','u1','/pricing','noise',26),
           (1,'a',103,'e3','v2','s1','u1','/pricing','purchase',30),
           (1,'a',104,'e4','v2','s1','u1','/pricing','purchase',35),
           (1,'a',105,'e5','v3','s2','u2','/landing','signup',15),
           (1,'a',106,'e6','v3','s2','u2','/landing','purchase',18),
           (2,'b',201,'e1','v1','s1','u1','/landing','signup',20),
           (2,'b',202,'e2','v1','s1','u1','/landing','purchase',30)
  )`;

const data = [
  [101, 1, "alpha"],
  [102, 1, "noise"],
  [103, 1, "alpha"],
  [104, 1, "different"],
  [105, 1, "beta"],
  [106, 1, "beta"],
  [201, 2, "gamma"],
  [202, 2, "delta"],
] as const;

function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE custom_event_json_keys(id INTEGER PRIMARY KEY, site_pk INTEGER, key TEXT);
    CREATE TABLE custom_event_json_nodes(event_pk INTEGER, node_id INTEGER, parent_node_id INTEGER,
      key_id INTEGER, path_id INTEGER, value_type INTEGER, member_order INTEGER, array_index INTEGER, depth INTEGER);
    CREATE TABLE custom_event_json_values(event_pk INTEGER, node_id INTEGER, site_pk INTEGER,
      value_type INTEGER, string_value TEXT, number_value REAL, boolean_value INTEGER);
    INSERT INTO custom_event_json_keys VALUES (1,1,'sku'),(2,2,'sku');
  `);
  const addNode = db.prepare(
    "INSERT INTO custom_event_json_nodes VALUES(?,?,?,?,?,?,?,?,?)",
  );
  const addValue = db.prepare(
    "INSERT INTO custom_event_json_values VALUES(?,?,?,?,?,?,?)",
  );
  for (const [eventPk, sitePk, sku] of data) {
    const expanded = expandCustomEventData({ sku });
    if (!expanded.ok) throw new Error(expanded.error);
    for (const node of expanded.data.nodes) {
      addNode.run(
        eventPk,
        node.nodeId,
        node.parentNodeId,
        node.key === null ? null : sitePk,
        1,
        node.valueType,
        node.memberOrder,
        node.arrayIndex,
        node.depth,
      );
    }
    for (const scalar of expanded.data.values) {
      addValue.run(
        eventPk,
        scalar.nodeId,
        sitePk,
        scalar.valueType,
        scalar.stringValue,
        scalar.numberValue,
        scalar.booleanValue,
      );
    }
  }
  return db;
}

function qualified(
  db: DatabaseSync,
  expression: string,
  sourceSql = source,
  clock?: Parameters<typeof compileCollectionSqlQualification>[3],
) {
  const qualification = compileCollectionSqlQualification(
    parseFilterDsl(expression, analyticsFilterRegistry),
    "session",
    {},
    clock,
  );
  if (qualification.kind !== "entity")
    throw new Error("Expected entity relation");
  const composed = composeBoundCtes(qualification.ctes);
  return db
    .prepare(
      `WITH ${sourceSql}, ${composed.ctes}
    SELECT site_pk,entity_id FROM ${qualification.qualifiedEntityRelation}
    ORDER BY site_pk,entity_id`,
    )
    .all(...composed.bindings.map((item) => item.value));
}

describe("P4 complete timeline and relational SQL", () => {
  it("orders same-millisecond Unicode identifiers deterministically and isolates sites", () => {
    const db = fixture();
    try {
      const ties = source
        .replace("(1,'a',101,'e1'", "(1,'a',101,'é'")
        .replace("(1,'a',102,'e2'", "(1,'a',102,'Z'")
        .replace("(1,'a',103,'e3'", "(1,'a',103,'ß'")
        .replace("'noise',26)", "'noise',20)")
        .replace("'purchase',30)", "'purchase',20)");
      const onlySiteOne = [{ site_pk: 1, entity_id: "s1" }];
      expect(
        qualified(
          db,
          'first(EVENT).name eq "noise" AND nth(EVENT,2).name eq "purchase"',
          ties,
        ),
      ).toEqual(onlySiteOne);
      expect(
        qualified(
          db,
          'adjacent(sequence([EVENT { $.name eq "noise" }, EVENT { $.name eq "purchase" }])) exists',
          ties,
        ),
      ).toEqual(onlySiteOne);
      expect(
        qualified(
          db,
          'count(sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }])) eq 1',
          ties,
        ),
      ).toEqual([
        { site_pk: 1, entity_id: "s1" },
        { site_pk: 1, entity_id: "s2" },
        { site_pk: 2, entity_id: "s1" },
      ]);
      expect(
        qualified(
          db,
          'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) exists',
          ties,
        ).map((row) => row.site_pk),
      ).toEqual([1, 1, 2]);
    } finally {
      db.close();
    }
  });

  it("obeys half-open Window start/end and empty windows", () => {
    const db = fixture();
    try {
      const clock = {
        nowMs: 40,
        rangeStartMs: 20,
        rangeEndExclusiveMs: 40,
        timeZone: "UTC",
      };
      expect(
        qualified(
          db,
          "count(window(EVENT, @range.start, [0ms,10ms])) eq 2",
          source,
          clock,
        ),
      ).toEqual([{ site_pk: 1, entity_id: "s1" }]);
      expect(
        qualified(
          db,
          "count(window(EVENT, @range.start, [0ms,10ms])) eq 1",
          source,
          clock,
        ),
      ).toEqual([{ site_pk: 2, entity_id: "s1" }]);
      expect(
        qualified(
          db,
          "count(window(EVENT, @range.start, [0ms,10ms])) eq 0",
          source,
          clock,
        ),
      ).toEqual([{ site_pk: 1, entity_id: "s2" }]);
    } finally {
      db.close();
    }
  });

  it("evaluates both 23-hour and 25-hour IANA natural days with exclusive end", () => {
    for (const [startIso, endIso, hours] of [
      ["2026-03-08T08:00:00.000Z", "2026-03-09T07:00:00.000Z", 23],
      ["2026-11-01T07:00:00.000Z", "2026-11-02T08:00:00.000Z", 25],
    ] as const) {
      const db = fixture();
      try {
        const start = Date.parse(startIso);
        const end = Date.parse(endIso);
        expect(end - start).toBe(hours * 3600000);
        const day =
          "scope_raw_visits(site_pk,site_id,visit_id,session_id,visitor_id,pathname,duration_ms,started_at) AS (" +
          "VALUES (1,'a','v1','s1','u1','/landing',1," +
          start +
          ")" +
          "),scope_raw_events(site_pk,site_id,event_pk,event_id,visit_id,session_id,visitor_id,pathname,event_name,occurred_at) AS (" +
          "VALUES (1,'a',101,'at-start','v1','s1','u1','/landing','signup'," +
          start +
          ")," +
          "(1,'a',103,'before-end','v1','s1','u1','/landing','purchase'," +
          (end - 1) +
          ")," +
          "(1,'a',104,'at-end','v1','s1','u1','/landing','purchase'," +
          end +
          "))";
        const clock = {
          nowMs: end + 1,
          rangeStartMs: start,
          rangeEndExclusiveMs: end,
          filterStartMs: start,
          filterEndExclusiveMs: end,
          timeZone: "America/Los_Angeles",
        };
        expect(
          qualified(
            db,
            "count(periods(EVENT, 1d) { count($items) eq 2 }) eq 1",
            day,
            clock,
          ),
        ).toEqual([{ site_pk: 1, entity_id: "s1" }]);
        expect(
          qualified(
            db,
            "count(window(EVENT, @range.start, [0ms," + hours + "h])) eq 2",
            day,
            clock,
          ),
        ).toEqual([{ site_pk: 1, entity_id: "s1" }]);
      } finally {
        db.close();
      }
    }
  });

  it("counts all combinations of ordered N-step Sequence occurrences", () => {
    const db = fixture();
    try {
      expect(
        qualified(
          db,
          'count(sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }])) eq 2',
        ),
      ).toEqual([{ site_pk: 1, entity_id: "s1" }]);
      expect(
        qualified(
          db,
          'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) exists',
        ),
      ).toEqual([
        { site_pk: 1, entity_id: "s1" },
        { site_pk: 1, entity_id: "s2" },
        { site_pk: 2, entity_id: "s1" },
      ]);
      expect(
        qualified(
          db,
          'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "noise" }, EVENT { $.name eq "purchase" }]) exists',
        ),
      ).toEqual([{ site_pk: 1, entity_id: "s1" }]);
    } finally {
      db.close();
    }
  });

  it("requires full timeline positions for adjacent, including unrelated Pages", () => {
    const db = fixture();
    try {
      expect(
        qualified(
          db,
          'adjacent(sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }])) exists',
        ),
      ).toEqual([
        { site_pk: 1, entity_id: "s2" },
        { site_pk: 2, entity_id: "s1" },
      ]);
    } finally {
      db.close();
    }
  });

  it("applies Without as a strict exclusion between the actual matched Steps", () => {
    const db = fixture();
    try {
      expect(
        qualified(
          db,
          'without(sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]), EVENT { $.name eq "noise" }) exists',
        ),
      ).toEqual([
        { site_pk: 1, entity_id: "s2" },
        { site_pk: 2, entity_id: "s1" },
      ]);
    } finally {
      db.close();
    }
  });

  it("evaluates $span, $gap and $same in a bound Sequence item", () => {
    const db = fixture();
    try {
      expect(
        qualified(
          db,
          'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) { $span lte 20ms AND $gap(1,2) gte 10ms } exists',
        ),
      ).toEqual([
        { site_pk: 1, entity_id: "s1" },
        { site_pk: 2, entity_id: "s1" },
      ]);
      expect(
        qualified(
          db,
          'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) { $same($.payload("/sku")) } exists',
        ),
      ).toEqual([
        { site_pk: 1, entity_id: "s1" },
        { site_pk: 1, entity_id: "s2" },
      ]);
    } finally {
      db.close();
    }
  });
});
