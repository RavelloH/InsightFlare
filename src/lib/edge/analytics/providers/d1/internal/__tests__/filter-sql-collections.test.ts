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

function qualified(expression: string, scope: "event" | "session" | "visitor") {
  const document = parseFilterDsl(expression, analyticsFilterRegistry);
  const output = compileCollectionSqlQualification(document, scope);
  const { ctes, bindings } = composeBoundCtes(output.ctes);
  const database = new DatabaseSync(":memory:");
  try {
    if (output.kind === "entity") {
      return database
        .prepare(
          `WITH ${SOURCE}, ${ctes}
        SELECT site_pk, entity_id FROM ${output.qualifiedEntityRelation}
        ORDER BY site_pk, entity_id`,
        )
        .all(...bindings.map((value) => value.value));
    }
    return database
      .prepare(
        `WITH ${SOURCE}, ${ctes}
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

  it("does not quietly accept an unsupported P3/P4 scalar form", () => {
    expect(() =>
      compileCollectionSqlQualification(
        parseFilterDsl(
          'first(EVENT).name eq "purchase"',
          analyticsFilterRegistry,
        ),
        "session",
      ),
    ).toThrow(/not implemented/);
  });
});
