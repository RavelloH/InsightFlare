// @vitest-environment node
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { compileD1Query, eq, filter, param, project } from "@/lib/db";
import {
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  type SiteId,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import { buildLegacyScopedDataset } from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scoped-dataset";
import type { AnalyticsLegacyText } from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scoped-types";
import {
  entityEventMatches,
  entityUniverse,
} from "@/lib/edge/analytics/providers/d1/internal/lowering/scoped-source/membership";
import type { IdentityRelation } from "@/lib/edge/analytics/providers/d1/internal/lowering/scoped-source/primitives";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

import { COST_TIME } from "./remote-d1/referrers-cost-harness";
import {
  buildDataStatements,
  buildSiteStatements,
  SEED_BASE_MS,
  SEED_SITE_ID,
} from "./remote-d1/seed";

describe("unrestricted entity Event membership", () => {
  let database: DatabaseSync;
  beforeAll(() => {
    database = createMigratedDatabase();
    for (const sql of [
      ...buildSiteStatements(),
      ...buildDataStatements({ visits: 96 }),
    ])
      database.exec(sql);
    // Empty and space-only keys are excluded, while tabs and padded nonblank
    // keys retain the existing SQLite TRIM semantics and their raw values.
    database.exec(`
      PRAGMA foreign_keys = OFF;
      UPDATE visits SET session_id = '', visitor_id = '' WHERE visit_id = 'v0';
      UPDATE visits SET session_id = '   ', visitor_id = '   ' WHERE visit_id = 'v1';
      UPDATE visits SET session_id = char(9), visitor_id = char(9) WHERE visit_id = 'v2';
      UPDATE visits SET session_id = ' raw ', visitor_id = ' raw ' WHERE visit_id = 'v3';
      UPDATE visits SET session_id = X'726177', visitor_id = X'726177' WHERE visit_id = 'v4';
      INSERT INTO site_identities (site_pk, site_id) VALUES (2, 'foreign-site');
      INSERT INTO custom_event_names (id, site_id, site_pk, name, created_at, last_seen_at)
      VALUES (20, 'foreign-site', 2, 'foreign-name', 0, 0);
      INSERT INTO custom_events (event_id, site_id, site_pk, visit_id, event_name_id, occurred_at, received_at, node_count, value_count)
      VALUES ('event-only', '${SEED_SITE_ID}', 1, 'v4', 1, ${SEED_BASE_MS + 100}, ${SEED_BASE_MS + 100}, 0, 0),
             ('foreign-owner', '${SEED_SITE_ID}', 1, 'v4', 20, ${SEED_BASE_MS + 101}, ${SEED_BASE_MS + 101}, 0, 0),
             ('padded-owner', '${SEED_SITE_ID}', 1, 'v3', 1, ${SEED_BASE_MS + 101}, ${SEED_BASE_MS + 101}, 0, 0),
             ('missing-owner', '${SEED_SITE_ID}', 1, 'absent', 1, ${SEED_BASE_MS + 102}, ${SEED_BASE_MS + 102}, 0, 0),
             ('outside-window', '${SEED_SITE_ID}', 1, 'v4', 1, ${SEED_BASE_MS - 1}, ${SEED_BASE_MS - 1}, 0, 0);
    `);
  });
  afterAll(() => database?.close());

  function fixture(
    kind: "session" | "visitor",
    eventName?: string,
    filterDsl?: string,
  ) {
    const filters = filterDsl
      ? parseFilterDsl(filterDsl, analyticsFilterRegistry)
      : EMPTY_FILTER_DOCUMENT;
    const query = prepareScopedQuery("event-records", {
      context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
      time: COST_TIME,
      filters,
      scopePreference: kind,
    });
    const time = semanticTemporalDomainsFromQueryTime(query.time);
    const selection = createSemanticScopedSourceSelection({
      profile: "prepared-scoped-v1",
      filters: query.filters!,
      subject: createSemanticSubjectDomain({
        origin: "site",
        siteIds: [SEED_SITE_ID as SiteId],
      }),
      time,
      expectedPlan: query.scopePlan,
      preparedPlanOperation: "event-records",
      ...(eventName !== undefined ? { eventName } : {}),
    });
    return {
      selection,
      dataset: buildLegacyScopedDataset({
        selection,
        storage: { siteId: SEED_SITE_ID, time },
      }),
    };
  }

  function rows(relation: IdentityRelation) {
    const compiled = compileD1Query(relation);
    return database
      .prepare(compiled.sql)
      .all(...((compiled.bindings ?? []) as SQLInputValue[]))
      .map((row) => ({ ...row }))
      .sort((a, b) => String(a.event_id).localeCompare(String(b.event_id)));
  }

  for (const kind of ["session", "visitor"] as const) {
    it.each(["site_pk", "event_id", "entity_id"] as const)(
      `${kind}: preserves NULL %s rejection from the original joins`,
      (key) => {
        const { dataset, selection } = fixture(kind);
        const source = dataset.readEvents.relation;
        const nullableColumn =
          key === "entity_id"
            ? kind === "session"
              ? "session_id"
              : "visitor_id"
            : key;
        const relation = project(source, {
          ...source.columns,
          [nullableColumn]: param(null),
        });
        const nullable = {
          ...dataset,
          readEvents: {
            ...dataset.readEvents,
            relation,
            sessionId: relation.columns.session_id! as AnalyticsLegacyText,
            visitorId: relation.columns.visitor_id! as AnalyticsLegacyText,
          },
        };
        const original = entityEventMatches(
          nullable,
          selection,
          entityUniverse(nullable, kind),
        );
        expect(rows(original)).toEqual([]);
        expect(rows(entityEventMatches(nullable, selection))).toEqual([]);
      },
    );

    it.each([undefined, "qualifier", " other ", "foreign-name", "absent"])(
      `${kind}: preserves the original universe join with name gate %s`,
      (eventName) => {
        const { dataset, selection } = fixture(kind, eventName);
        const actual = entityEventMatches(dataset, selection);
        // Supplying the original universe exercises the retained join path,
        // independently of the new unrestricted-selection rule.
        const original = entityEventMatches(
          dataset,
          selection,
          entityUniverse(dataset, kind),
        );
        expect(rows(actual)).toEqual(rows(original));
        expect(compileD1Query(actual).sql).not.toContain("UNION");
        expect(compileD1Query(original).sql).toContain("UNION");
      },
    );

    it(`${kind}: keeps owner presence, time and legacy ID-only name association`, () => {
      const { dataset, selection } = fixture(kind);
      const ids = rows(entityEventMatches(dataset, selection)).map(
        (row) => row.event_id,
      );
      expect(ids).toContain("event-only");
      expect(ids).toContain("foreign-owner");
      expect(ids).toContain("padded-owner");
      expect(ids).toContain("e2q");
      expect(ids).not.toContain("missing-owner");
      expect(ids).not.toContain("outside-window");
      expect(ids).not.toContain("e0o");
    });

    it(`${kind}: preserves an explicitly restricted entity relation`, () => {
      const { dataset, selection } = fixture(kind);
      const universe = entityUniverse(dataset, kind);
      const restricted = filter(
        universe,
        eq(
          universe.columns.entity_id! as AnalyticsLegacyText,
          param(kind === "session" ? "ses20" : "vis10"),
        ),
      );
      const result = rows(entityEventMatches(dataset, selection, restricted));
      expect(result.length).toBeGreaterThan(0);
      expect(result.length).toBeLessThan(
        rows(entityEventMatches(dataset, selection)).length,
      );
      expect(
        compileD1Query(entityEventMatches(dataset, selection, restricted)).sql,
      ).toContain("UNION");
    });

    it(`${kind}: still evaluates a nonempty native filter`, () => {
      const { dataset, selection } = fixture(
        kind,
        undefined,
        'page.path eq "/qualifier"',
      );
      const actual = entityEventMatches(dataset, selection);
      const original = entityEventMatches(
        dataset,
        selection,
        entityUniverse(dataset, kind),
      );
      expect(rows(actual).length).toBeGreaterThan(0);
      expect(compileD1Query(actual).bindings).toContain("/qualifier");
      expect(rows(actual).length).toBeLessThan(rows(original).length);
    });
  }
});
