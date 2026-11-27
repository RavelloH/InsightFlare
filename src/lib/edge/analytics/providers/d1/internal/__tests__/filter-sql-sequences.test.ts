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
  uniqueLocalOccurrences = false,
) {
  const qualification = compileCollectionSqlQualification(
    parseFilterDsl(expression, analyticsFilterRegistry),
    "session",
    { uniqueLocalOccurrences },
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
  it("joins each filtered Sequence step before its complete timeline lookup", () => {
    const expression =
      'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) exists';
    const compiled = compileCollectionSqlQualification(
      parseFilterDsl(expression, analyticsFilterRegistry),
      "session",
    );
    if (compiled.kind !== "entity")
      throw new Error("Expected entity qualification");
    const sql = composeBoundCtes(compiled.ctes).ctes;
    expect(sql).toContain(
      "CROSS JOIN scope_filter_timeline sequence_activity_1",
    );
    expect(sql).toContain(
      "CROSS JOIN scope_filter_timeline sequence_activity_2",
    );
    expect(sql).toContain(
      "sequence_activity_2.session_key = sequence_activity_1.session_key",
    );
    const db = fixture();
    try {
      expect(qualified(db, expression)).toEqual([
        { site_pk: 1, entity_id: "s1" },
        { site_pk: 1, entity_id: "s2" },
        { site_pk: 2, entity_id: "s1" },
      ]);
    } finally {
      db.close();
    }
  });

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

  it("uses cardinality and ordering extrema only for eligible plain existential sequences", () => {
    const db = fixture();
    try {
      const expressions = [
        'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) exists',
        'sequence([EVENT { $.name eq "purchase" }, EVENT { $.name eq "signup" }]) notExists',
        "sequence([EVENT, EVENT, EVENT, EVENT]) exists",
        "sequence([EVENT, EVENT, EVENT, EVENT, EVENT]) notExists",
      ];
      const sql = (expression: string, unique: boolean) =>
        composeBoundCtes(
          compileCollectionSqlQualification(
            parseFilterDsl(expression, analyticsFilterRegistry),
            "session",
            { uniqueLocalOccurrences: unique },
          ).ctes,
        ).ctes;
      const variants = [
        source,
        source.replace("'signup',20)", "'signup',30)"),
        source.replace("'pricing',1,25)", "'pricing',1,20)"),
      ];
      for (const expression of expressions) {
        expect(sql(expression, true)).toMatch(
          /ORDER BY (occurred_at|started_at) ASC,|LIMIT 1 OFFSET|SELECT MIN\((started_at|occurred_at)\)/,
        );
        expect(sql(expression, false)).not.toMatch(
          /ORDER BY (occurred_at|started_at) ASC,|LIMIT 1 OFFSET|SELECT MIN\((started_at|occurred_at)\)/,
        );
        for (const variant of variants)
          expect(qualified(db, expression, variant, undefined, true)).toEqual(
            qualified(db, expression, variant),
          );
      }
      for (const expression of [
        "count(sequence([EVENT,EVENT])) eq 1",
        "adjacent(sequence([EVENT,EVENT])) exists",
        "without(sequence([EVENT,EVENT]), PAGE) exists",
        "sequence([EVENT,EVENT]) { $span lte 10ms } exists",
      ])
        expect(sql(expression, true)).not.toMatch(
          /ORDER BY (occurred_at|started_at) ASC,|LIMIT 1 OFFSET|SELECT MIN\((started_at|occurred_at)\)/,
        );
    } finally {
      db.close();
    }
  });
  it("groups canonical global identical occurrences without losing universe or time range semantics", () => {
    const db = fixture();
    try {
      const base = source
        .replace("'purchase',30)", "'purchase',35)")
        .replace("'signup',15)", "'signup',18)")
        // Sessionless observations may share a timeline key with a real
        // Session, but must not supply occurrences to its qualification.
        .replace(
          "(2,'b','v1','s1','u1','/landing',1,10)",
          "(2,'b','v1','s1','u1','/landing',1,10), (1,'a','s2','','u2','/landing',1,18)",
        )
        .replace(
          "(2,'b',202,'e2','v1','s1','u1','/landing','purchase',30)",
          "(2,'b',202,'e2','v1','s1','u1','/landing','purchase',30), (1,'a',107,'e7','s2','','u2','/landing','purchase',18)",
        );
      const variants = [
        { sql: base, sources: {}, clock: undefined },
        {
          sql:
            base +
            `, scope_filter_f AS (SELECT * FROM scope_raw_events WHERE occurred_at >= 25), scope_filter_u AS (SELECT * FROM scope_raw_visits WHERE started_at >= 20)`,
          sources: {
            filterEvents: "scope_filter_f",
            universeVisits: "scope_filter_u",
            universeEvents: "scope_filter_f",
            readEvents: "scope_raw_events",
          },
          clock: {
            nowMs: 50,
            rangeStartMs: 10,
            rangeEndExclusiveMs: 50,
            timeZone: "UTC",
            filterRangeExplicit: true,
            filterStartMs: 25,
            filterEndExclusiveMs: 50,
            readStartMs: 10,
            readEndExclusiveMs: 50,
          },
        },
        {
          sql:
            base +
            `, scope_filter_f AS (SELECT * FROM scope_raw_events WHERE occurred_at >= 25)`,
          sources: {
            filterEvents: "scope_filter_f",
            readEvents: "scope_raw_events",
          },
          clock: {
            nowMs: 50,
            rangeStartMs: 10,
            rangeEndExclusiveMs: 50,
            timeZone: "UTC",
            filterRangeExplicit: false,
            filterStartMs: 25,
            filterEndExclusiveMs: 50,
            readStartMs: 10,
            readEndExclusiveMs: 50,
          },
        },
      ] as const;
      const expressions = [
        "sequence([EVENT,EVENT]) exists",
        'without(sequence([EVENT { $.name eq "signup" },EVENT { $.name eq "purchase" }]),EVENT { $.name eq "noise" }) notExists',
        "without(sequence([EVENT,EVENT]), EVENT) exists",
        "without(sequence([EVENT,EVENT,EVENT]), EVENT) exists",
        'without(sequence([EVENT,EVENT { $.name eq "purchase" },EVENT]), EVENT { $.name eq "noise" }) notExists',
        "adjacent(sequence([EVENT,EVENT])) exists",
        "adjacent(sequence([PAGE,EVENT])) notExists",
        'adjacent(sequence([EVENT { $.name eq "signup" },EVENT { $.name eq "purchase" }])) exists',
        "adjacent(sequence([EVENT,EVENT,EVENT])) notExists",
        'sequence([EVENT { $.name eq "signup" },EVENT { $.name eq "noise" },EVENT { $.name eq "purchase" }]) exists',
        'sequence([EVENT,EVENT { $.name eq "purchase" },EVENT]) notExists',
        'sequence([EVENT { $.name eq "signup" },EVENT,EVENT { $.name eq "purchase" },EVENT]) exists',
        'sequence([EVENT,EVENT { $.payload("/sku") eq "alpha" },EVENT { $.name eq "purchase" },EVENT,EVENT]) notExists',
        "sequence([EVENT,EVENT,EVENT]) { $gap(1,2) lte 10ms } exists",
        "sequence([EVENT,EVENT,EVENT]) { $gap(2,3) gte 0ms } notExists",
        "sequence([EVENT,EVENT,EVENT,EVENT]) { $gap(2,3) lt 1ms } exists",
        'sequence([EVENT { $.name eq "purchase" },EVENT { $.name eq "purchase" },EVENT { $.name eq "purchase" }]) { $gap(1,2) gt 1ms } exists',
        "sequence([EVENT,EVENT]) { $same($.name) } exists",
        'sequence([EVENT,EVENT]) { $same($.payload("/sku")) } notExists',
        'sequence([EVENT { $.name eq "signup" },EVENT]) { $same($.payload("/sku")) } exists',
        'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) exists',
        'sequence([EVENT { $.name eq "purchase" }, EVENT { $.name eq "signup" }]) notExists',
        'sequence([EVENT, EVENT { $.name eq "signup" }]) exists',
        'sequence([EVENT, EVENT { $.name eq "signup" }]) { $span lte 0ms } exists',
        'sequence([EVENT, EVENT { $.name eq "signup" }]) { $span gte 0ms } notExists',
        'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "missing" }]) { $gap(1,2) lt 10ms } notExists',
        "sequence([EVENT,EVENT]) { $span lte 10ms } exists",
        "sequence([EVENT,EVENT,EVENT]) { $span gt 5ms } exists",
        "sequence([EVENT,EVENT,EVENT]) { $gap(1,3) gte 0ms } notExists",
        "sequence([EVENT,EVENT,EVENT,EVENT]) { $span lte 0ms } exists",
        "sequence([EVENT,EVENT,EVENT]) notExists",
        "sequence([EVENT,EVENT,EVENT,EVENT]) exists",
        'sequence([EVENT { $.name eq "purchase" OR $.name eq "signup" }, EVENT { $.name eq "purchase" OR $.name eq "signup" }]) exists',
        'sequence([PAGE { $.path eq "/landing" }, PAGE { $.path eq "/landing" }]) exists',
        'NOT (sequence([PAGE { $.path eq "/landing" }, PAGE { $.path eq "/landing" }]) exists)',
        'sequence([EVENT { $.name eq "purchase" }, EVENT { $.name eq "purchase" }]) exists',
        'sequence([PAGE { $.path eq "/landing" }, PAGE { $.path eq "/landing" }]) notExists',
        'sequence([EVENT { $.payload("/sku") eq "beta" }, EVENT { $.payload("/sku") eq "beta" }]) exists',
        'sequence([EVENT { $.name eq "purchase" }, EVENT { $.name eq "purchase" }]) exists OR sequence([PAGE { $.path eq "/landing" }, PAGE { $.path eq "/landing" }]) notExists',
      ];
      for (const scope of ["session", "visitor"] as const) {
        for (const variant of variants) {
          for (const expression of expressions) {
            const compile = (uniqueGlobalOccurrences: boolean) =>
              compileCollectionSqlQualification(
                parseFilterDsl(expression, analyticsFilterRegistry),
                scope,
                { ...variant.sources, uniqueGlobalOccurrences },
                variant.clock,
              );
            const read = (unique: boolean) => {
              const plan = compile(unique);
              if (plan.kind !== "entity")
                throw Error("expected entity qualification");
              const c = composeBoundCtes(plan.ctes);
              if (
                unique &&
                !(
                  (expression.startsWith("adjacent(") ||
                    expression.startsWith("without(")) &&
                  variant.clock?.filterRangeExplicit
                )
              )
                expect(c.ctes).toContain("scope_global_sequence_0 AS");
              else expect(c.ctes).not.toContain("scope_global_sequence_0 AS");
              return db
                .prepare(
                  `WITH ${variant.sql}, ${c.ctes} SELECT site_pk,entity_id FROM ${plan.qualifiedEntityRelation} ORDER BY site_pk,entity_id`,
                )
                .all(...c.bindings.map((x) => x.value));
            };
            expect(read(true)).toEqual(read(false));
          }
        }
      }
      for (const expression of [
        "sequence([PAGE,EVENT]) exists",
        "sequence([PAGE,EVENT,EVENT]) exists",
        'sequence([EVENT,EVENT { $.name eq "purchase" },EVENT]) { $span lte 10ms } exists',
        'sequence([EVENT,EVENT { $.name eq "purchase" },EVENT,EVENT,EVENT,EVENT]) exists',
        'count(sequence([EVENT,EVENT { $.name eq "purchase" },EVENT])) eq 1',
        "sequence([PAGE,PAGE]) { $same($.path) } exists",
        "sequence([EVENT,EVENT]) { $same($.name) AND $span lte 10ms } exists",
        'sequence([EVENT,EVENT { $.name eq "signup" },EVENT]) { $same($.name) } exists',
        "count(sequence([EVENT,EVENT]) { $same($.name) }) eq 1",
        "sequence([PAGE,PAGE]) exists",
        "sequence([PAGE,PAGE]) notExists",
        "count(sequence([EVENT,EVENT])) eq 1",
        "count(adjacent(sequence([EVENT,EVENT]))) eq 1",
        "adjacent(sequence([EVENT,EVENT,EVENT,EVENT,EVENT,EVENT])) exists",
        "without(sequence([EVENT,EVENT]), PAGE) exists",
        "without(sequence([EVENT,EVENT,EVENT]), PAGE) exists",
        "without(sequence([EVENT,EVENT,EVENT,EVENT,EVENT,EVENT]), EVENT) exists",
        "without(sequence([PAGE,EVENT]), EVENT) exists",
        "count(without(sequence([EVENT,EVENT]), PAGE)) eq 1",
        "sequence([PAGE,PAGE,PAGE]) { $gap(1,2) lte 10ms } exists",
        "sequence([EVENT,EVENT,EVENT]) { $gap(1,2) eq 10ms } exists",
        "sequence([EVENT,EVENT,EVENT]) { $gap(1,2) lte 10ms AND $span gte 0ms } exists",
        "sequence([EVENT,EVENT]) { $span eq 10ms } exists",
      ]) {
        const sql = composeBoundCtes(
          compileCollectionSqlQualification(
            parseFilterDsl(expression, analyticsFilterRegistry),
            "session",
            { uniqueGlobalOccurrences: true },
          ).ctes,
        ).ctes;
        expect(sql).not.toContain("scope_global_sequence_0 AS");
      }
    } finally {
      db.close();
    }
  });
  it("uses typed value extrema for two-step Payload existence only on proven sources", () => {
    const db = fixture();
    try {
      const pair =
        'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) { $same($.payload("/sku")) }';
      const expressions = [
        pair + " exists",
        pair + " notExists",
        'sequence([EVENT { $.name eq "purchase" }, EVENT { $.name eq "signup" }]) { $same($.payload("/sku")) } exists',
        'sequence([EVENT,EVENT]) { $same($.payload("/missing")) } notExists',
        'sequence([EVENT,EVENT]) { $same($.payload("/sku")) } exists',
        "count(" + pair + ") eq 1",
        'sequence([EVENT,EVENT,EVENT]) { $same($.payload("/sku")) } exists',
        'sequence([EVENT,EVENT]) { $same($.payload("/sku")) AND $span lte 10ms } exists',
      ];
      const optimizedSql = (expression: string, unique: boolean) =>
        composeBoundCtes(
          compileCollectionSqlQualification(
            parseFilterDsl(expression, analyticsFilterRegistry),
            "session",
            { uniqueLocalOccurrences: unique },
          ).ctes,
        ).ctes;
      expect(optimizedSql(expressions[0]!, true)).toContain("AS step_index");
      expect(optimizedSql(expressions[4]!, true)).toContain(
        "HAVING COUNT(*) >= 2",
      );
      expect(optimizedSql(expressions[4]!, false)).not.toContain(
        "HAVING COUNT(*) >= 2",
      );
      expect(
        qualified(
          db,
          'sequence([EVENT { $.name eq "signup" },EVENT { $.name eq "signup" }]) { $same($.payload("/sku")) } exists',
          source,
          undefined,
          true,
        ),
      ).toEqual([]);
      expect(optimizedSql(expressions[0]!, false)).not.toContain(
        "AS step_index",
      );
      for (const expression of expressions.slice(5))
        expect(optimizedSql(expression, true)).not.toContain("AS step_index");
      const globalRead = (
        expression: string,
        scope: "session" | "visitor",
        uniqueGlobalOccurrences: boolean,
        sourceSql = source,
      ) => {
        const compiled = compileCollectionSqlQualification(
          parseFilterDsl(expression, analyticsFilterRegistry),
          scope,
          { uniqueGlobalOccurrences },
        );
        if (compiled.kind !== "entity") throw Error("expected entity");
        const c = composeBoundCtes(compiled.ctes);
        return db
          .prepare(
            `WITH ${sourceSql}, ${c.ctes} SELECT site_pk,entity_id FROM ${compiled.qualifiedEntityRelation} ORDER BY site_pk,entity_id`,
          )
          .all(...c.bindings.map((x) => x.value));
      };
      const globalExpressions = [
        ...expressions,
        "sequence([EVENT,EVENT]) { $same($.name) } exists",
        "sequence([EVENT,EVENT,EVENT]) { $same($.name) } notExists",
        "sequence([EVENT { $.name exists },EVENT]) { $same($.name) } exists",
        'sequence([EVENT { $.name eq "signup" },EVENT]) { $same($.payload("/sku")) } notExists',
      ];
      for (const expression of globalExpressions) {
        const sql = composeBoundCtes(
          compileCollectionSqlQualification(
            parseFilterDsl(expression, analyticsFilterRegistry),
            "session",
            { uniqueGlobalOccurrences: true },
          ).ctes,
        ).ctes;
        if (expression.startsWith("count(") || expression.includes("AND $span"))
          expect(sql).not.toContain("scope_global_sequence_0 AS");
        else expect(sql).toContain("scope_global_sequence_0 AS");
      }
      const check = () => {
        for (const expression of expressions)
          expect(qualified(db, expression, source, undefined, true)).toEqual(
            qualified(db, expression),
          );
        for (const scope of ["session", "visitor"] as const)
          for (const expression of globalExpressions)
            expect(globalRead(expression, scope, true)).toEqual(
              globalRead(expression, scope, false),
            );
      };
      check();
      // Missing, JSON null, containers, and different primitive types must
      // not be conflated with matching typed scalar values.
      db.exec(
        "UPDATE custom_event_json_nodes SET value_type=0 WHERE event_pk=101 AND key_id=1",
      );
      check();
      db.exec(
        "UPDATE custom_event_json_nodes SET value_type=4 WHERE event_pk=101 AND key_id=1",
      );
      check();
      db.exec(
        "UPDATE custom_event_json_nodes SET value_type=2 WHERE event_pk=101 AND key_id=1; UPDATE custom_event_json_values SET value_type=2,number_value=1 WHERE event_pk=101",
      );
      check();
      db.exec(
        "UPDATE custom_event_json_nodes SET value_type=3 WHERE event_pk=103 AND key_id=1; UPDATE custom_event_json_values SET value_type=3,boolean_value=1 WHERE event_pk=103",
      );
      check();
      db.exec(
        "UPDATE custom_event_json_nodes SET value_type=2 WHERE event_pk=103 AND key_id=1; UPDATE custom_event_json_values SET value_type=2,number_value=1 WHERE event_pk=103",
      );
      check();
      const ties = source.replace("'signup',20)", "'signup',30)");
      for (const scope of ["session", "visitor"] as const)
        for (const expression of globalExpressions)
          expect(globalRead(expression, scope, true, ties)).toEqual(
            globalRead(expression, scope, false, ties),
          );
      expect(qualified(db, pair + " exists", ties, undefined, true)).toEqual(
        qualified(db, pair + " exists", ties),
      );
    } finally {
      db.close();
    }
  });
  it("short-circuits scalar same only for supported local pairs", () => {
    const db = fixture();
    try {
      const expressions = [
        "sequence([EVENT,EVENT]) { $same($.name) } exists",
        "sequence([EVENT,EVENT]) { $same($.name) } notExists",
        'sequence([EVENT { $.name eq "signup" },EVENT { $.name eq "purchase" }]) { $same($.name) } notExists',
        'sequence([EVENT { $.name exists },EVENT { $.name eq "purchase" }]) { $same($.name) } exists',
        "sequence([PAGE,PAGE]) { $same($.path) } exists",
        "sequence([PAGE,PAGE]) { $same($.path) } notExists",
      ];
      const sql = (expression: string, unique: boolean) =>
        composeBoundCtes(
          compileCollectionSqlQualification(
            parseFilterDsl(expression, analyticsFilterRegistry),
            "session",
            { uniqueLocalOccurrences: unique },
          ).ctes,
        ).ctes;
      for (const expression of expressions) {
        expect(sql(expression, true)).toMatch(
          /AS step_index|HAVING COUNT\(\*\) >= 2/,
        );
        expect(sql(expression, false)).not.toMatch(
          /AS step_index|HAVING COUNT\(\*\) >= 2/,
        );
        for (const variant of [
          source,
          source.replace("'signup',20)", "'signup',30)"),
          source.replaceAll("'/pricing'", "'/landing'"),
          source.replaceAll("'/pricing'", "NULL"),
        ])
          expect(qualified(db, expression, variant, undefined, true)).toEqual(
            qualified(db, expression, variant),
          );
      }
      for (const expression of [
        "count(sequence([EVENT,EVENT]) { $same($.name) }) eq 1",
        'sequence([EVENT,EVENT { $.name eq "signup" },EVENT]) { $same($.name) } exists',
        "sequence([EVENT,EVENT]) { $same($.name) AND $span lte 10ms } exists",
      ]) {
        expect(sql(expression, true)).not.toMatch(
          /AS step_index|HAVING COUNT\(\*\) >= 2/,
        );
        expect(qualified(db, expression, source, undefined, true)).toEqual(
          qualified(db, expression),
        );
      }
    } finally {
      db.close();
    }
  });

  it("uses filtered time neighbors and extrema for identical two-step time bounds", () => {
    const db = fixture();
    try {
      const expressions = [
        "sequence([EVENT,EVENT]) { $span lte 5ms } exists",
        "sequence([EVENT,EVENT]) { $span lt 5ms } notExists",
        "sequence([EVENT,EVENT]) { $span gte 5ms } exists",
        "sequence([EVENT,EVENT]) { $span gt 5ms } notExists",
        "sequence([EVENT,EVENT]) { $gap(1,2) lte 0ms } exists",
        "sequence([PAGE,PAGE]) { $gap(1,2) gt 10ms } exists",
        'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "signup" }]) { $span gte 0ms } exists',
      ];
      const sql = (expression: string, unique: boolean) =>
        composeBoundCtes(
          compileCollectionSqlQualification(
            parseFilterDsl(expression, analyticsFilterRegistry),
            "session",
            { uniqueLocalOccurrences: unique },
          ).ctes,
        ).ctes;
      for (const expression of expressions) {
        expect(sql(expression, true)).toMatch(
          /AS span_delta|HAVING COUNT\(\*\) >= 2/,
        );
        expect(sql(expression, false)).not.toMatch(
          /AS span_delta|HAVING COUNT\(\*\) >= 2/,
        );
        for (const variant of [
          source,
          source.replace("'signup',20)", "'signup',30)"),
          source.replace("'pricing',1,25)", "'pricing',1,10)"),
        ])
          expect(qualified(db, expression, variant, undefined, true)).toEqual(
            qualified(db, expression, variant),
          );
      }
      for (const expression of [
        "sequence([EVENT,EVENT]) { $span eq 5ms } exists",
        "count(sequence([EVENT,EVENT]) { $span lte 5ms }) eq 1",
        "sequence([EVENT,EVENT]) { $span lte 10ms AND $gap(1,2) gt 5ms } exists",
      ]) {
        expect(sql(expression, true)).not.toMatch(
          /AS span_delta|HAVING COUNT\(\*\) >= 2/,
        );
        expect(qualified(db, expression, source, undefined, true)).toEqual(
          qualified(db, expression),
        );
      }
    } finally {
      db.close();
    }
  });

  it("uses one collection for repeated multi-step equality and full-span bounds", () => {
    const db = fixture();
    try {
      const expressions = [
        "sequence([EVENT,EVENT,EVENT]) { $same($.name) } exists",
        "sequence([EVENT,EVENT,EVENT,EVENT]) { $same($.name) } notExists",
        "sequence([PAGE,PAGE,PAGE]) { $same($.path) } notExists",
        'sequence([EVENT,EVENT,EVENT]) { $same($.payload("/sku")) } exists',
        'sequence([EVENT,EVENT,EVENT]) { $same($.payload("/missing")) } notExists',
        "sequence([EVENT,EVENT,EVENT]) { $span lte 10ms } exists",
        "sequence([EVENT,EVENT,EVENT,EVENT]) { $span gt 5ms } exists",
        "sequence([EVENT,EVENT,EVENT]) { $gap(1,3) lt 10ms } notExists",
        "sequence([PAGE,PAGE,PAGE]) { $span gte 0ms } exists",
      ];
      const sql = (expression: string, unique: boolean) =>
        composeBoundCtes(
          compileCollectionSqlQualification(
            parseFilterDsl(expression, analyticsFilterRegistry),
            "session",
            { uniqueLocalOccurrences: unique },
          ).ctes,
        ).ctes;
      const repeated = source
        .replaceAll("'noise'", "'signup'")
        .replaceAll("'purchase'", "'signup'");
      for (const expression of expressions) {
        expect(sql(expression, true)).toMatch(
          /AS span_delta|HAVING COUNT\(\*\) >= [34]/,
        );
        expect(sql(expression, false)).not.toMatch(
          /AS span_delta|HAVING COUNT\(\*\) >= [34]/,
        );
        for (const variant of [
          source,
          repeated,
          repeated.replace("'signup',20)", "'signup',30)"),
          source.replaceAll("'/pricing'", "'/landing'"),
        ])
          expect(qualified(db, expression, variant, undefined, true)).toEqual(
            qualified(db, expression, variant),
          );
      }
      for (const expression of [
        'sequence([EVENT,EVENT { $.name eq "signup" },EVENT]) { $same($.name) } exists',
        "count(sequence([EVENT,EVENT,EVENT]) { $same($.name) }) eq 1",
      ]) {
        expect(sql(expression, true)).not.toMatch(
          /AS span_delta|HAVING COUNT\(\*\) >= [34]/,
        );
        expect(qualified(db, expression, source, undefined, true)).toEqual(
          qualified(db, expression),
        );
      }
    } finally {
      db.close();
    }
  });

  it("uses strict ordered predecessors and extrema for different two-step time bounds", () => {
    const db = fixture();
    try {
      const pairs = [
        'EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }',
        'EVENT { $.name eq "purchase" }, EVENT { $.name eq "signup" }',
        "EVENT { $.name exists }, EVENT",
        'EVENT { $.name eq "signup" }, EVENT { $.name eq "missing" }',
        "PAGE, EVENT",
        "EVENT, PAGE",
        "PAGE { $.path exists }, PAGE",
      ];
      for (const pair of pairs)
        for (const constraint of [
          "$span lte 0ms",
          "$span lt 10ms",
          "$span gte 0ms",
          "$gap(1,2) gt 10ms",
        ])
          for (const operator of ["exists", "notExists"]) {
            const expression = `sequence([${pair}]) { ${constraint} } ${operator}`;
            const sql = composeBoundCtes(
              compileCollectionSqlQualification(
                parseFilterDsl(expression, analyticsFilterRegistry),
                "session",
                { uniqueLocalOccurrences: true },
              ).ctes,
            ).ctes;
            const mixed = pair === "PAGE, EVENT" || pair === "EVENT, PAGE";
            const pagePair = pair.startsWith("PAGE {");
            if (mixed || pagePair) {
              expect(sql).not.toContain("AS span_delta");
            } else {
              expect(sql).toContain("AS span_delta");
            }
            for (const variant of [
              source,
              source.replace("'signup',20)", "'signup',30)"),
              source.replace("'pricing',1,25)", "'pricing',1,20)"),
            ])
              expect(
                qualified(db, expression, variant, undefined, true),
              ).toEqual(qualified(db, expression, variant));
          }
    } finally {
      db.close();
    }
  });

  it.each([
    { entity: "EVENT", count: 3 },
    { entity: "EVENT", count: 4 },
    { entity: "EVENT", count: 5 },
    { entity: "PAGE", count: 3 },
    { entity: "PAGE", count: 4 },
    { entity: "PAGE", count: 5 },
  ])(
    "reserves prefix and suffix occurrences for $entity internal gaps with $count identical steps",
    ({ entity, count }) => {
      const db = fixture();
      try {
        const dense = source
          .replace(
            "(1,'a','v3','s2'",
            "(1,'a','v4','s1','u1','/landing',1,25),(1,'a','v5','s1','u1','/pricing',1,29),(1,'a','v6','s1','u1','/landing',1,50),(1,'a','v3','s2'",
          )
          .replace(
            "(1,'a',105,'e5'",
            "(1,'a',107,'e7','v4','s1','u1','/landing','purchase',35),(1,'a',108,'e8','v5','s1','u1','/pricing','signup',41),(1,'a',105,'e5'",
          );
        for (let from = 1; from < count; from++)
          for (let to = from + 1; to <= count; to++) {
            if (from === 1 && to === count) continue;
            for (const comparison of [
              "lt 10ms",
              "lte 0ms",
              "gte 0ms",
              "gt 10ms",
            ])
              for (const operator of ["exists", "notExists"]) {
                const expression = `sequence([${Array(count).fill(entity).join(",")}]) { $gap(${from},${to}) ${comparison} } ${operator}`;
                const sql = composeBoundCtes(
                  compileCollectionSqlQualification(
                    parseFilterDsl(expression, analyticsFilterRegistry),
                    "session",
                    { uniqueLocalOccurrences: true },
                  ).ctes,
                ).ctes;
                if (entity === "PAGE" && comparison.startsWith("gt"))
                  expect(sql).not.toContain("AS span_delta");
                else expect(sql).toContain("AS span_delta");
                for (const variant of [
                  source,
                  dense,
                  dense.replace("'signup',20)", "'signup',30)"),
                ])
                  expect(
                    qualified(db, expression, variant, undefined, true),
                  ).toEqual(qualified(db, expression, variant));
              }
          }
      } finally {
        db.close();
      }
    },
  );

  it.each([3, 4, 5])(
    "uses feasible per-entity ranks for global internal gaps with %s steps",
    (count) => {
      const db = fixture();
      try {
        const dense = source.replace(
          "(1,'a',105,'e5'",
          "(1,'a',107,'e7','v2','s1','u1','/pricing','purchase',35),(1,'a',108,'e8','v2','s1','u1','/pricing','signup',41),(1,'a',105,'e5'",
        );
        const split = dense.replace(
          "'e7','v2','s1','u1'",
          "'e7','v2','s3','u1'",
        );
        const variants = [
          source,
          dense,
          split.replace("'signup',20)", "'signup',30)"),
        ];
        for (const scope of ["session", "visitor"] as const) {
          for (let from = 1; from < count; from++)
            for (let to = from + 1; to <= count; to++) {
              if (from === 1 && to === count) continue;
              for (const comparison of [
                "lt 10ms",
                "lte 0ms",
                "gte 0ms",
                "gt 10ms",
              ])
                for (const operator of ["exists", "notExists"]) {
                  const expression = `sequence([${Array(count).fill("EVENT").join(",")}]) { $gap(${from},${to}) ${comparison} } ${operator}`;
                  const read = (
                    variant: string,
                    uniqueGlobalOccurrences: boolean,
                  ) => {
                    const plan = compileCollectionSqlQualification(
                      parseFilterDsl(expression, analyticsFilterRegistry),
                      scope,
                      { uniqueGlobalOccurrences },
                    );
                    if (plan.kind !== "entity") throw Error("expected entity");
                    const c = composeBoundCtes(plan.ctes);
                    if (uniqueGlobalOccurrences)
                      expect(c.ctes).toContain("scope_global_sequence_0 AS");
                    else
                      expect(c.ctes).not.toContain(
                        "scope_global_sequence_0 AS",
                      );
                    return db
                      .prepare(
                        `WITH ${variant}, ${c.ctes} SELECT site_pk,entity_id FROM ${plan.qualifiedEntityRelation} ORDER BY site_pk,entity_id`,
                      )
                      .all(...c.bindings.map((x) => x.value));
                  };
                  for (const variant of variants)
                    expect(read(variant, true)).toEqual(read(variant, false));
                }
            }
        }
      } finally {
        db.close();
      }
    },
  );
  it("propagates strict earliest reachable Event prefixes independently for each entity", () => {
    const db = fixture();
    try {
      const dense = source.replace(
        "(1,'a',105,'e5'",
        "(1,'a',107,'e7','v2','s1','u1','/pricing','purchase',35),(1,'a',108,'e8','v2','s1','u1','/pricing','signup',41),(1,'a',105,'e5'",
      );
      const variants = [
        source,
        dense,
        dense.replace("'signup',20)", "'signup',30)"),
        dense.replace("'e7','v2','s1','u1'", "'e7','v2','s3','u1'"),
        dense.replace("'e7','v2','s1','u1'", "'e7','v2','','u1'"),
      ];
      const selectors = [
        'EVENT { $.name eq "signup" }',
        'EVENT { $.name eq "purchase" }',
        "EVENT { $.name exists }",
        'EVENT { $.name eq "missing" }',
        'EVENT { $.payload("/sku") eq "alpha" }',
        "EVENT",
      ];
      const sequences = [
        [0, 1, 1],
        [1, 0, 1],
        [0, 2, 1],
        [2, 0, 2],
        [0, 3, 1],
        [4, 2, 1],
        [0, 1, 1, 1],
        [2, 0, 1, 2],
        [0, 2, 4, 1],
        [2, 0, 2, 1, 2],
        [0, 1, 1, 0, 1],
      ];
      for (const scope of ["session", "visitor"] as const)
        for (const indices of sequences)
          for (const operator of ["exists", "notExists"]) {
            const expression = `sequence([${indices.map((i) => selectors[i]).join(",")}]) ${operator}`;
            const read = (
              variant: string,
              uniqueGlobalOccurrences: boolean,
            ) => {
              const plan = compileCollectionSqlQualification(
                parseFilterDsl(expression, analyticsFilterRegistry),
                scope,
                { uniqueGlobalOccurrences },
              );
              if (plan.kind !== "entity") throw Error("expected entity");
              const c = composeBoundCtes(plan.ctes);
              if (uniqueGlobalOccurrences)
                expect(c.ctes).toContain("reachable_1 AS");
              else expect(c.ctes).not.toContain("reachable_1 AS");
              return db
                .prepare(
                  `WITH ${variant}, ${c.ctes} SELECT site_pk,entity_id FROM ${plan.qualifiedEntityRelation} ORDER BY site_pk,entity_id`,
                )
                .all(...c.bindings.map((x) => x.value));
            };
            for (const variant of variants)
              expect(read(variant, true)).toEqual(read(variant, false));
          }
    } finally {
      db.close();
    }
  });

  it("matches global adjacent stages on the complete ordered timeline", () => {
    const db = fixture();
    try {
      const dense = source.replace(
        "(1,'a',105,'e5'",
        "(1,'a',107,'e7','v2','s1','u1','/pricing','purchase',35),(1,'a',108,'e8','v2','s1','u1','/pricing','signup',41),(1,'a',105,'e5'",
      );
      const variants = [
        source,
        dense,
        dense.replace("'signup',20)", "'signup',30)"),
        dense.replace("'e7','v2','s1','u1'", "'e7','v2','s3','u1'"),
        // A sessionless occurrence whose visit ID collides with a real
        // session key occupies a timeline position, but cannot qualify it.
        dense.replace(
          "(1,'a','v3','s2'",
          "(1,'a','s1','','u1','/landing',1,33),(1,'a','v3','s2'",
        ),
      ];
      const sequences = [
        "EVENT,EVENT",
        'EVENT { $.name eq "missing" },EVENT',
        'PAGE,EVENT { $.payload("/sku") eq "beta" }',
        'EVENT { $.name eq "signup" },EVENT { $.name eq "signup" }',
        "PAGE,PAGE",
        "EVENT,EVENT,EVENT",
        "PAGE,EVENT",
        "EVENT,PAGE",
        'EVENT { $.name eq "signup" },EVENT { $.name eq "purchase" }',
        'EVENT { $.name exists },EVENT { $.payload("/sku") eq "alpha" },EVENT',
        'PAGE { $.path eq "/landing" },EVENT,PAGE,EVENT',
        "EVENT,EVENT,EVENT,EVENT,EVENT",
      ];
      for (const scope of ["session", "visitor"] as const)
        for (const sequence of sequences)
          for (const operator of ["exists", "notExists"]) {
            const expression = `adjacent(sequence([${sequence}])) ${operator}`;
            const read = (
              variant: string,
              uniqueGlobalOccurrences: boolean,
            ) => {
              const plan = compileCollectionSqlQualification(
                parseFilterDsl(expression, analyticsFilterRegistry),
                scope,
                { uniqueGlobalOccurrences },
              );
              if (plan.kind !== "entity") throw Error("expected entity");
              const c = composeBoundCtes(plan.ctes);
              if (
                uniqueGlobalOccurrences &&
                sequence.includes("EVENT") &&
                (sequence.split(",").length === 2 || !sequence.includes("PAGE"))
              )
                expect(c.ctes).toContain("candidate_entities AS MATERIALIZED");
              else expect(c.ctes).not.toContain("scope_global_sequence_0 AS");
              return db
                .prepare(
                  `WITH ${variant}, ${c.ctes} SELECT site_pk,entity_id FROM ${plan.qualifiedEntityRelation} ORDER BY site_pk,entity_id`,
                )
                .all(...c.bindings.map((x) => x.value));
            };
            for (const variant of variants)
              expect(read(variant, true)).toEqual(read(variant, false));
          }
    } finally {
      db.close();
    }
  });

  it("prunes absent Adjacent stages without treating overlapping witnesses as a match", () => {
    const db = fixture();
    try {
      const one = source.replace(
        ",\n           (1,'a',106,'e6','v3','s2','u2','/landing','purchase',18)",
        "",
      );
      const sequences = [
        'EVENT,EVENT { $.name eq "missing" }',
        'EVENT { $.name eq "signup" },EVENT { $.name exists }',
        'EVENT { $.name eq "signup" },EVENT { $.payload("/sku") eq "beta" }',
        'EVENT,EVENT { $.name eq "purchase" },EVENT',
        'EVENT,EVENT { $.name exists },EVENT { $.payload("/sku") eq "beta" },EVENT',
        'EVENT,EVENT { $.name exists },EVENT { $.name eq "purchase" },EVENT,EVENT',
      ];
      const read = (
        variant: string,
        scope: "session" | "visitor",
        sequence: string,
        operator: string,
        uniqueGlobalOccurrences: boolean,
      ) => {
        const plan = compileCollectionSqlQualification(
          parseFilterDsl(
            `adjacent(sequence([${sequence}])) ${operator}`,
            analyticsFilterRegistry,
          ),
          scope,
          { uniqueGlobalOccurrences },
        );
        if (plan.kind !== "entity") throw Error("expected entity");
        const c = composeBoundCtes(plan.ctes);
        if (uniqueGlobalOccurrences) {
          expect(c.ctes).toContain("candidate_entities AS MATERIALIZED");
          if (sequence.includes("$.payload")) {
            expect(c.ctes).not.toContain("HAVING COUNT(*) >=");
          } else {
            expect(c.ctes).toContain("HAVING COUNT(*) >=");
            expect(c.ctes).toContain("MAX(CASE WHEN");
          }
        }
        return db
          .prepare(
            `WITH ${variant}, ${c.ctes} SELECT site_pk,entity_id FROM ${plan.qualifiedEntityRelation} ORDER BY site_pk,entity_id`,
          )
          .all(...c.bindings.map((x) => x.value));
      };
      expect(one).not.toBe(source);
      for (const scope of ["session", "visitor"] as const) {
        for (const seq of sequences)
          for (const operator of ["exists", "notExists"])
            for (const variant of [
              source,
              one,
              source.replace("'purchase',18)", "'purchase',15)"),
            ])
              expect(read(variant, scope, seq, operator, true)).toEqual(
                read(variant, scope, seq, operator, false),
              );
        expect(read(source, scope, sequences[0]!, "exists", true)).toEqual([]);
        expect(read(one, scope, sequences[2]!, "exists", true)).toEqual([]);
      }
    } finally {
      db.close();
    }
  });

  it("keeps sessionless collision blockers and does not borrow candidate keys across sites", () => {
    const db = fixture();
    try {
      const expression =
        'adjacent(sequence([EVENT { $.name eq "signup" },EVENT { $.name eq "purchase" }])) exists';
      const blocked = source.replace(
        "(1,'a','v3','s2','u2','/landing',1,10),",
        "(1,'a','v3','s2','u2','/landing',1,10),(1,'a','s2','','u9','/landing',1,16),",
      );
      const read = (
        variant: string,
        scope: "session" | "visitor",
        uniqueGlobalOccurrences: boolean,
      ) => {
        const plan = compileCollectionSqlQualification(
          parseFilterDsl(expression, analyticsFilterRegistry),
          scope,
          { uniqueGlobalOccurrences },
        );
        if (plan.kind !== "entity") throw Error("expected entity");
        const c = composeBoundCtes(plan.ctes);
        if (uniqueGlobalOccurrences)
          expect(c.ctes).toContain("candidate_entities AS MATERIALIZED");
        return db
          .prepare(
            `WITH ${variant}, ${c.ctes} SELECT site_pk,entity_id FROM ${plan.qualifiedEntityRelation} ORDER BY site_pk,entity_id`,
          )
          .all(...c.bindings.map((x) => x.value));
      };
      expect(read(source, "session", true)).toEqual([
        { site_pk: 1, entity_id: "s2" },
        { site_pk: 2, entity_id: "s1" },
      ]);
      expect(read(blocked, "session", true)).toEqual([
        { site_pk: 2, entity_id: "s1" },
      ]);
      expect(read(blocked, "visitor", true)).toEqual([
        { site_pk: 1, entity_id: "u2" },
        { site_pk: 2, entity_id: "u1" },
      ]);
      for (const scope of ["session", "visitor"] as const)
        expect(read(blocked, scope, true)).toEqual(read(blocked, scope, false));
    } finally {
      db.close();
    }
  });

  it.each(["session", "visitor"] as const)(
    "compares the latest strictly preceding start and exclusion for global Without (%s)",
    (scope) => {
      const db = fixture();
      try {
        const dense = source.replace(
          "(1,'a',105,'e5'",
          "(1,'a',107,'e7','v2','s1','u1','/pricing','signup',27),(1,'a',108,'e8','v2','s1','u1','/pricing','noise',30),(1,'a',105,'e5'",
        );
        const variants = [
          source,
          dense,
          dense.replace("'signup',27)", "'signup',30)"),
          dense.replace("'e7','v2','s1','u1'", "'e7','v2','s3','u1'"),
          dense
            .replace(
              "(1,'a','v3','s2'",
              "(1,'a','s1','','u1','/landing',1,28),(1,'a','v3','s2'",
            )
            .replace(
              "(1,'a',105,'e5'",
              "(1,'a',109,'e9','s1','','u1','/landing','noise',29),(1,'a',105,'e5'",
            ),
        ];
        const pairs = [
          "EVENT,EVENT",
          'EVENT { $.name eq "signup" },EVENT { $.name eq "purchase" }',
          'EVENT { $.name eq "purchase" },EVENT { $.name eq "signup" }',
          'EVENT { $.payload("/sku") eq "alpha" },EVENT { $.name exists }',
          'EVENT { $.name eq "missing" },EVENT',
        ];
        const exclusions = [
          "EVENT",
          "PAGE",
          'EVENT { $.name eq "noise" }',
          'EVENT { $.name eq "signup" }',
          'EVENT { $.name eq "purchase" }',
          'EVENT { $.payload("/sku") eq "alpha" }',
          'PAGE { $.path eq "/pricing" }',
        ];
        for (const pair of pairs)
          for (const excluded of exclusions)
            for (const operator of ["exists", "notExists"]) {
              const expression = `without(sequence([${pair}]),${excluded}) ${operator}`;
              const read = (
                variant: string,
                uniqueGlobalOccurrences: boolean,
              ) => {
                const plan = compileCollectionSqlQualification(
                  parseFilterDsl(expression, analyticsFilterRegistry),
                  scope,
                  { uniqueGlobalOccurrences },
                );
                if (plan.kind !== "entity") throw Error("expected entity");
                const c = composeBoundCtes(plan.ctes);
                if (uniqueGlobalOccurrences && !excluded.startsWith("PAGE"))
                  expect(c.ctes).toContain("last_excluded");
                else expect(c.ctes).not.toContain("scope_global_sequence_0 AS");
                return db
                  .prepare(
                    `WITH ${variant}, ${c.ctes} SELECT site_pk,entity_id FROM ${plan.qualifiedEntityRelation} ORDER BY site_pk,entity_id`,
                  )
                  .all(...c.bindings.map((x) => x.value));
              };
              for (const variant of variants)
                expect(read(variant, true)).toEqual(read(variant, false));
            }
      } finally {
        db.close();
      }
    },
  );

  it.each([
    ["session", 3, 0],
    ["session", 3, 1],
    ["visitor", 3, 0],
    ["visitor", 3, 1],
    ["session", 4, 0],
    ["session", 4, 1],
    ["visitor", 4, 0],
    ["visitor", 4, 1],
    ["session", 5, 0],
    ["session", 5, 1],
    ["visitor", 5, 0],
    ["visitor", 5, 1],
  ] as const)(
    "propagates valid global Without prefixes (%s, %i stages, group %i)",
    (scope, count, group) => {
      const db = fixture();
      try {
        const dense = source.replace(
          "(1,'a',105,'e5'",
          "(1,'a',107,'e7','v2','s1','u1','/pricing','signup',27),(1,'a',108,'e8','v2','s1','u1','/pricing','noise',30),(1,'a',110,'e10','v2','s1','u1','/pricing','purchase',31),(1,'a',111,'e11','v2','s1','u1','/pricing','purchase',32),(1,'a',112,'e12','v2','s1','u1','/pricing','purchase',33),(1,'a',113,'e13','v2','s1','u1','/pricing','signup',34),(1,'a',105,'e5'",
        );
        const variants = [
          source,
          dense,
          dense.replace("'signup',27)", "'signup',30)"),
          dense.replace("'e7','v2','s1','u1'", "'e7','v2','s3','u1'"),
          dense
            .replace(
              "(1,'a','v3','s2'",
              "(1,'a','s1','','u1','/landing',1,28),(1,'a','v3','s2'",
            )
            .replace(
              "(1,'a',105,'e5'",
              "(1,'a',109,'e9','s1','','u1','/landing','noise',29),(1,'a',105,'e5'",
            ),
        ];
        const signup = 'EVENT { $.name eq "signup" }';
        const purchase = 'EVENT { $.name eq "purchase" }';
        const noise = 'EVENT { $.name eq "noise" }';
        const payload = 'EVENT { $.payload("/sku") eq "alpha" }';
        const pairs = [
          Array(count).fill("EVENT").join(","),
          [signup, ...Array(count - 2).fill("EVENT"), purchase].join(","),
          [purchase, ...Array(count - 2).fill(purchase), signup].join(","),
          [payload, ...Array(count - 2).fill(purchase), purchase].join(","),
          [noise, ...Array(count - 2).fill(signup), noise].join(","),
          [
            signup,
            ...Array(count - 2).fill('EVENT { $.name eq "missing" }'),
            purchase,
          ].join(","),
        ];
        const exclusions = [
          "EVENT",
          'EVENT { $.name eq "noise" }',
          'EVENT { $.name eq "signup" }',
          'EVENT { $.name eq "purchase" }',
          'EVENT { $.payload("/sku") eq "alpha" }',
        ];
        for (const pair of pairs.slice(group * 3, group * 3 + 3))
          for (const excluded of exclusions)
            for (const operator of ["exists", "notExists"]) {
              const expression = `without(sequence([${pair}]),${excluded}) ${operator}`;
              const read = (
                variant: string,
                uniqueGlobalOccurrences: boolean,
              ) => {
                const plan = compileCollectionSqlQualification(
                  parseFilterDsl(expression, analyticsFilterRegistry),
                  scope,
                  { uniqueGlobalOccurrences },
                );
                if (plan.kind !== "entity") throw Error("expected entity");
                const c = composeBoundCtes(plan.ctes);
                if (uniqueGlobalOccurrences)
                  expect(c.ctes).toContain("prefix_" + (count - 1));
                else expect(c.ctes).not.toContain("scope_global_sequence_0 AS");
                return db
                  .prepare(
                    `WITH ${variant}, ${c.ctes} SELECT site_pk,entity_id FROM ${plan.qualifiedEntityRelation} ORDER BY site_pk,entity_id`,
                  )
                  .all(...c.bindings.map((x) => x.value));
              };
              for (const variant of variants)
                expect(read(variant, true)).toEqual(read(variant, false));
            }
      } finally {
        db.close();
      }
    },
  );

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
