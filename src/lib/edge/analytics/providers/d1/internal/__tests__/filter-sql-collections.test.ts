// @vitest-environment node
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { composeBoundCtes } from "@/lib/edge/analytics/providers/d1/internal/filter-qualification";
import { compileCollectionSqlQualification } from "@/lib/edge/analytics/providers/d1/internal/filter-sql-collections";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const SOURCE = `
scope_raw_visits(site_pk, site_id, visit_id, session_id, visitor_id, pathname, duration_ms, started_at) AS (
  VALUES
    (1, 'a', 'v1', 's1', 'u1', '/pricing', 20, 10),
    (1, 'a', 'v2', 's1', 'u1', '/home', 20, 20),
    (1, 'a', 'v3', 's2', 'u2', '/home', 20, 30),
    (2, 'b', 'v1', 's1', 'u1', '/home', 20, 40)
),
scope_raw_events(site_pk, site_id, event_pk, event_id, visit_id, session_id, visitor_id, pathname, event_name, occurred_at) AS (
  VALUES
    (1, 'a', 101, 'e1', 'v2', 's1', 'u1', '/home', 'purchase', 25),
    (1, 'a', 102, 'e2', 'v3', 's2', 'u2', '/home', 'view', 35),
    (2, 'b', 201, 'e1', 'v1', 's1', 'u1', '/home', 'view', 45)
)`;

function qualified(
  expression: string,
  scope: "event" | "session" | "visitor",
  clock?: {
    nowMs: number;
    rangeStartMs: number;
    rangeEndExclusiveMs: number;
    timeZone: string;
  },
  sourceSql: string = SOURCE,
) {
  const document = parseFilterDsl(expression, analyticsFilterRegistry);
  const output = compileCollectionSqlQualification(document, scope, {}, clock);
  const { ctes, bindings } = composeBoundCtes(output.ctes);
  const database = new DatabaseSync(":memory:");
  try {
    if (output.kind === "entity") {
      return database
        .prepare(
          `WITH ${sourceSql}, ${ctes}
        SELECT site_pk, entity_id FROM ${output.qualifiedEntityRelation}
        ORDER BY site_pk, entity_id`,
        )
        .all(...bindings.map((value) => value.value));
    }
    return database
      .prepare(
        `WITH ${sourceSql}, ${ctes}
      SELECT 'visit' AS source, site_pk, visit_id AS id
      FROM ${output.matchedVisitRelation}
      UNION ALL
      SELECT 'event' AS source, site_pk, event_id AS id
      FROM ${output.matchedEventRelation}
      ORDER BY site_pk, source, id`,
      )
      .all(...bindings.map((value) => value.value));
  } finally {
    database.close();
  }
}

describe("P2 collection SQL qualification", () => {
  it("counts matching events per site-scoped Session and includes zero", () => {
    expect(
      qualified('count(EVENT { $.name eq "purchase" }) eq 1', "session"),
    ).toEqual([{ site_pk: 1, entity_id: "s1" }]);
    expect(
      qualified('count(EVENT { $.name eq "purchase" }) eq 0', "session"),
    ).toEqual([
      { site_pk: 1, entity_id: "s2" },
      { site_pk: 2, entity_id: "s1" },
    ]);
  });

  it("allows independent Selectors to match different Pages but binds AND within one Page", () => {
    expect(
      qualified(
        'PAGE { $.path eq "/pricing" } exists AND PAGE { $.path eq "/home" } exists',
        "session",
      ),
    ).toEqual([{ site_pk: 1, entity_id: "s1" }]);
    expect(
      qualified(
        'PAGE { $.path eq "/pricing" AND $.path eq "/home" } exists',
        "session",
      ),
    ).toEqual([]);
  });

  it("uses NOT EXISTS relative to entity universe rather than row predicate", () => {
    expect(
      qualified('NOT PAGE { $.path eq "/pricing" } exists', "session"),
    ).toEqual([
      { site_pk: 1, entity_id: "s2" },
      { site_pk: 2, entity_id: "s1" },
    ]);
    expect(
      qualified('PAGE { $.path neq "/pricing" } exists', "session"),
    ).toEqual([
      { site_pk: 1, entity_id: "s1" },
      { site_pk: 1, entity_id: "s2" },
      { site_pk: 2, entity_id: "s1" },
    ]);
  });

  it("binds nested Session → Event collections to the same Visitor and Session", () => {
    expect(
      qualified(
        'SESSION { EVENT { $.name eq "purchase" } exists } exists',
        "visitor",
      ),
    ).toEqual([{ site_pk: 1, entity_id: "u1" }]);
  });

  it("keeps Event-only conditions inapplicable to Visit even under NOT", () => {
    expect(qualified('NOT event.name eq "purchase"', "event")).toEqual([
      { source: "event", site_pk: 1, id: "e2" },
      { source: "event", site_pk: 2, id: "e1" },
    ]);
    expect(
      qualified('event.name eq "purchase" OR page.path eq "/pricing"', "event"),
    ).toEqual([
      { source: "event", site_pk: 1, id: "e1" },
      { source: "visit", site_pk: 1, id: "v1" },
    ]);
  });

  it("separates qualification universe U from historical filter domain F", () => {
    const historical = `
scope_history_events(site_pk, site_id, event_pk, event_id, visit_id, session_id, visitor_id, pathname, event_name, occurred_at) AS (
 VALUES (1,'a',301,'h1','v3','s2','u2','/home','purchase',-50),
        (2,'b',302,'h2','v1','s1','u1','/home','purchase',-40)
)`;
    const document = parseFilterDsl(
      'count(EVENT { $.name eq "purchase" }) eq 1',
      analyticsFilterRegistry,
    );
    const qualification = compileCollectionSqlQualification(
      document,
      "session",
      {
        universeVisits: "scope_raw_visits",
        universeEvents: "scope_raw_events",
        filterEvents: "scope_history_events",
      },
    );
    expect(qualification.kind).toBe("entity");
    if (qualification.kind !== "entity")
      throw new Error("Expected entity qualification");
    const compiled = composeBoundCtes(qualification.ctes);
    const db = new DatabaseSync(":memory:");
    try {
      expect(
        db
          .prepare(
            `WITH ${SOURCE}, ${historical}, ${compiled.ctes}
        SELECT site_pk, entity_id FROM ${qualification.qualifiedEntityRelation}
        ORDER BY site_pk, entity_id`,
          )
          .all(...compiled.bindings.map((binding) => binding.value)),
      ).toEqual([
        { site_pk: 1, entity_id: "s2" },
        { site_pk: 2, entity_id: "s1" },
      ]);
      expect(() =>
        compileCollectionSqlQualification(document, "session", {
          filterEvents: "scope_history_events;DROP",
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("uses Session → Visitor identity without a nonexistent Session column on Visitor", () => {
    expect(qualified("VISITOR exists", "session")).toEqual([
      { site_pk: 1, entity_id: "s1" },
      { site_pk: 1, entity_id: "s2" },
      { site_pk: 2, entity_id: "s1" },
    ]);
  });

  it("evaluates mixed Event/Session Fact boolean domains and complements", () => {
    expect(
      qualified('session.views gte 2 AND event.name eq "purchase"', "event"),
    ).toEqual([{ source: "event", site_pk: 1, id: "e1" }]);
    expect(qualified("NOT session.views gte 2", "event")).toEqual([
      { source: "event", site_pk: 1, id: "e2" },
      { source: "visit", site_pk: 1, id: "v3" },
      { source: "event", site_pk: 2, id: "e1" },
      { source: "visit", site_pk: 2, id: "v1" },
    ]);
  });

  it("P3-01 uses UTF-8 BINARY tie-breakers for same-millisecond Page/Event IDs per site", () => {
    // Input is intentionally reverse identity order. A < é < 😀 in UTF-8 BINARY.
    const sameTime = `
    scope_raw_visits(site_pk, site_id, visit_id, session_id, visitor_id, pathname, duration_ms, started_at) AS (
      VALUES (1,'a','v😀','s1','u1','/emoji',10,100),
             (1,'a','vé','s1','u1','/accent',10,100),
             (1,'a','vA','s1','u1','/ascii',10,100),
             (2,'b','vA','s1','u1','/other',10,100)
    ),
    scope_raw_events(site_pk, site_id, event_pk, event_id, visit_id, session_id, visitor_id, pathname, event_name, occurred_at) AS (
      VALUES (1,'a',101,'e😀','vA','s1','u1','/ascii','emoji',200),
             (1,'a',102,'eé','vA','s1','u1','/ascii','accent',200),
             (1,'a',103,'eA','vA','s1','u1','/ascii','ascii',200),
             (2,'b',201,'eA','vA','s1','u1','/other','other',200)
    )`;
    const match = (expression: string) =>
      qualified(expression, "session", undefined, sameTime);
    const firstSite = [{ site_pk: 1, entity_id: "s1" }];
    expect(match('first(PAGE).path eq "/ascii"')).toEqual(firstSite);
    expect(match('nth(PAGE,2).path eq "/accent"')).toEqual(firstSite);
    expect(match('last(PAGE).path eq "/emoji"')).toEqual(firstSite);
    expect(match('first(EVENT).name eq "ascii"')).toEqual(firstSite);
    expect(match('nth(EVENT,2).name eq "accent"')).toEqual(firstSite);
    expect(match('last(EVENT).name eq "emoji"')).toEqual(firstSite);
    expect(match("nth(EVENT,4) notExists")).toEqual([
      { site_pk: 1, entity_id: "s1" },
      { site_pk: 2, entity_id: "s1" },
    ]);
    expect(match('first(EVENT).name eq "other"')).toEqual([
      { site_pk: 2, entity_id: "s1" },
    ]);
  });

  it("orders first/last/nth occurrences in SQL and handles empty input", () => {
    expect(qualified('first(EVENT).name eq "purchase"', "session")).toEqual([
      { site_pk: 1, entity_id: "s1" },
    ]);
    expect(qualified('last(PAGE).path eq "/home"', "session")).toEqual([
      { site_pk: 1, entity_id: "s1" },
      { site_pk: 1, entity_id: "s2" },
      { site_pk: 2, entity_id: "s1" },
    ]);
    expect(qualified('nth(PAGE, 2).path eq "/home"', "session")).toEqual([
      { site_pk: 1, entity_id: "s1" },
    ]);
  });

  it("matches correlated Scalar strings with binary case sensitivity and literal wildcards", () => {
    expect(qualified('first(EVENT).name contains "pur"', "session")).toEqual([
      { site_pk: 1, entity_id: "s1" },
    ]);
    expect(qualified('first(EVENT).name contains "PUR"', "session")).toEqual(
      [],
    );
    expect(qualified('first(EVENT).name startsWith "pur"', "session")).toEqual([
      { site_pk: 1, entity_id: "s1" },
    ]);
    expect(qualified('first(EVENT).name startsWith "PUR"', "session")).toEqual(
      [],
    );
    expect(qualified('first(EVENT).name endsWith "chase"', "session")).toEqual([
      { site_pk: 1, entity_id: "s1" },
    ]);
    expect(qualified('first(EVENT).name endsWith "CHASE"', "session")).toEqual(
      [],
    );
    expect(qualified('first(EVENT).name contains "%"', "session")).toEqual([]);
    expect(qualified('first(EVENT).name contains "_"', "session")).toEqual([]);
    expect(qualified('first(EVENT).name endsWith ""', "session")).toEqual([
      { site_pk: 1, entity_id: "s1" },
      { site_pk: 1, entity_id: "s2" },
      { site_pk: 2, entity_id: "s1" },
    ]);
  });

  it("compiles Projection aggregates and arithmetic as correlated SQLite Scalars", () => {
    expect(qualified("sum(PAGE -> durationMs) eq 40", "session")).toEqual([
      { site_pk: 1, entity_id: "s1" },
    ]);
    expect(qualified("avg(PAGE -> durationMs) eq 20", "session")).toEqual([
      { site_pk: 1, entity_id: "s1" },
      { site_pk: 1, entity_id: "s2" },
      { site_pk: 2, entity_id: "s1" },
    ]);
    expect(qualified("countDistinct(PAGE -> path) eq 2", "session")).toEqual([
      { site_pk: 1, entity_id: "s1" },
    ]);
    expect(qualified("add(count(EVENT), count(PAGE)) eq 3", "session")).toEqual(
      [{ site_pk: 1, entity_id: "s1" }],
    );
  });

  it("evaluates correlated Window anchors, SQL time literals and half-open bounds", () => {
    expect(
      qualified(
        'count(window(EVENT { $.name eq "purchase" }, first(EVENT), [0ms, 10ms])) eq 1',
        "session",
      ),
    ).toEqual([{ site_pk: 1, entity_id: "s1" }]);
    const clock = {
      nowMs: 100,
      rangeStartMs: 20,
      rangeEndExclusiveMs: 40,
      timeZone: "UTC",
    };
    expect(
      qualified(
        "count(window(EVENT, @range.start, [0ms, 20ms])) eq 1",
        "session",
        clock,
      ),
    ).toEqual([
      { site_pk: 1, entity_id: "s1" },
      { site_pk: 1, entity_id: "s2" },
    ]);
    expect(
      qualified(
        "time(first(EVENT)) between [@range.start, @range.end]",
        "session",
        clock,
      ),
    ).toEqual([
      { site_pk: 1, entity_id: "s1" },
      { site_pk: 1, entity_id: "s2" },
    ]);
  });

  it("P4-01 executes DST 23h/25h natural Periods and half-open Window in SQL", () => {
    for (const [startText, endText, hourCount] of [
      ["2026-03-08T08:00:00.000Z", "2026-03-09T07:00:00.000Z", 23],
      ["2026-11-01T07:00:00.000Z", "2026-11-02T08:00:00.000Z", 25],
    ] as const) {
      const start = Date.parse(startText);
      const end = Date.parse(endText);
      expect(end - start).toBe(hourCount * 3600000);
      const src = [
        "scope_raw_visits(site_pk,site_id,visit_id,session_id,visitor_id,pathname,duration_ms,started_at) AS (VALUES " +
          "(1,'a','v1','s1','u1','/home',10," +
          start +
          ")," +
          "(1,'a','v2','s2','u2','/home',10," +
          end +
          ")," +
          "(2,'b','v1','s1','u1','/home',10," +
          (start - 1) +
          "))",
        "scope_raw_events(site_pk,site_id,event_pk,event_id,visit_id,session_id,visitor_id,pathname,event_name,occurred_at) AS (VALUES " +
          "(1,'a',101,'e1','v1','s1','u1','/home','inside'," +
          start +
          ")," +
          "(1,'a',102,'e2','v1','s1','u1','/home','inside'," +
          (end - 1) +
          ")," +
          "(1,'a',103,'e3','v2','s2','u2','/home','outside'," +
          end +
          ")," +
          "(2,'b',201,'e1','v1','s1','u1','/home','outside'," +
          (start - 1) +
          "))",
      ].join(", ");
      const clock = {
        nowMs: end,
        rangeStartMs: start,
        rangeEndExclusiveMs: end,
        timeZone: "America/Los_Angeles",
      };
      const match = (expr: string) => qualified(expr, "session", clock, src);
      const site1 = [{ site_pk: 1, entity_id: "s1" }];
      expect(
        match(
          "count(window(EVENT, @range.start, [0ms, " + hourCount + "h])) eq 2",
        ),
      ).toEqual(site1);
      expect(match("count(periods(EVENT, 1d)) eq 1")).toEqual(site1);
      expect(match("periods(EVENT, 1d) { count($items) eq 2 } exists")).toEqual(
        site1,
      );
      expect(match("countDistinct(bucket(EVENT, 1d)) eq 1")).toEqual(site1);
      expect(
        match(
          "count(window(EVENT, @range.start, [0ms, " + hourCount + "h])) eq 0",
        ),
      ).toEqual([
        { site_pk: 1, entity_id: "s2" },
        { site_pk: 2, entity_id: "s1" },
      ]);
    }
  });

  it("only enumerates nonempty natural Periods and binds $items to the active Period", () => {
    const clock = {
      nowMs: 100,
      rangeStartMs: 0,
      rangeEndExclusiveMs: 86_400_000,
      timeZone: "UTC",
    };
    expect(
      qualified("count(periods(PAGE, 1d)) eq 1", "session", clock),
    ).toEqual([
      { site_pk: 1, entity_id: "s1" },
      { site_pk: 1, entity_id: "s2" },
      { site_pk: 2, entity_id: "s1" },
    ]);
    expect(
      qualified(
        "periods(PAGE, 1d) { count($items) gte 2 } exists",
        "session",
        clock,
      ),
    ).toEqual([{ site_pk: 1, entity_id: "s1" }]);
  });

  it("evaluates top-level Filter time against the current scope's activities", () => {
    const clock = {
      nowMs: 100,
      rangeStartMs: 20,
      rangeEndExclusiveMs: 40,
      timeZone: "UTC",
    };
    expect(
      qualified(
        "time gte @range.start AND time lt @range.end",
        "session",
        clock,
      ),
    ).toEqual([
      { site_pk: 1, entity_id: "s1" },
      { site_pk: 1, entity_id: "s2" },
    ]);
    expect(
      qualified(
        'time gte @range.start AND time lt @range.end AND count(EVENT { $.name eq "view" }) eq 1',
        "session",
        clock,
      ),
    ).toEqual([{ site_pk: 1, entity_id: "s2" }]);
  });

  it("performs IANA Bucketing and typed distinct labels on SQL observations", () => {
    const clock = {
      nowMs: 100,
      rangeStartMs: 0,
      rangeEndExclusiveMs: 86_400_000,
      timeZone: "UTC",
    };
    expect(
      qualified("countDistinct(bucket(PAGE, 1d)) eq 1", "session", clock),
    ).toEqual([
      { site_pk: 1, entity_id: "s1" },
      { site_pk: 1, entity_id: "s2" },
      { site_pk: 2, entity_id: "s1" },
    ]);
  });

  it("rejects natural Periods if the required query time context was not provided", () => {
    expect(() =>
      compileCollectionSqlQualification(
        parseFilterDsl("periods(EVENT, 1w) exists", analyticsFilterRegistry),
        "session",
      ),
    ).toThrow(/IANA time context/);
  });
});
