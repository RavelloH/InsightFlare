import type { DatabaseSync } from "node:sqlite";

import { afterAll } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
const TEAM = "b04-team",
  SITE_A = "b04-site-a",
  SITE_B = "b04-site-b",
  SITE_C = "b04-site-c";
const databases = new Set<DatabaseSync>();
afterAll(() => {
  for (const db of databases) db.close();
});
interface SeedVisit {
  readonly id: string;
  readonly sessionId: string;
  readonly visitorId: string;
  readonly path: string;
  readonly at: number;
  readonly event: boolean;
}

function seedSite(
  database: DatabaseSync,
  siteId: string,
  eventNameId: number,
  visits: readonly SeedVisit[],
): void {
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(siteId);
  const sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(siteId) as { readonly site_pk: number }
    ).site_pk,
  );
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0)`,
    )
    .run(siteId, TEAM, siteId, `${siteId}.test`);
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (?, ?, 'qualifier', 150, ?)`,
    )
    .run(eventNameId, siteId, sitePk);
  for (const visit of visits) {
    database
      .prepare(
        `INSERT INTO visits (
           visit_id, site_id, site_pk, visitor_id, session_id, status,
           started_at, last_activity_at, pathname, hostname, duration_ms
         ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, 10)`,
      )
      .run(
        `${siteId}:${visit.id}`,
        siteId,
        sitePk,
        visit.visitorId,
        visit.sessionId,
        visit.at,
        visit.at,
        visit.path,
        `${siteId}.test`,
      );
    if (visit.event)
      database
        .prepare(
          `INSERT INTO custom_events (
             event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
             received_at, sequence, node_count, value_count
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
        )
        .run(
          `event-${siteId}:${visit.id}`,
          siteId,
          sitePk,
          `${siteId}:${visit.id}`,
          eventNameId,
          visit.at,
          visit.at,
        );
  }
}

/**
 * Every site reuses the same session and visitor ids. Site A qualifies s1,
 * site B qualifies s2 and site C qualifies both, so a membership that crossed
 * sites would change the totals.
 */
export function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  seedSite(database, SITE_A, 1, [
    {
      id: "a1",
      sessionId: "s1",
      visitorId: "v1",
      path: "/q",
      at: 110,
      event: true,
    },
    {
      id: "a2",
      sessionId: "s1",
      visitorId: "v1",
      path: "/p",
      at: 111,
      event: false,
    },
    {
      id: "a3",
      sessionId: "s2",
      visitorId: "v2",
      path: "/p",
      at: 112,
      event: false,
    },
  ]);
  seedSite(database, SITE_B, 2, [
    {
      id: "b1",
      sessionId: "s1",
      visitorId: "v1",
      path: "/p",
      at: 120,
      event: false,
    },
    {
      id: "b2",
      sessionId: "s2",
      visitorId: "v2",
      path: "/q",
      at: 121,
      event: true,
    },
    {
      id: "b3",
      sessionId: "s2",
      visitorId: "v2",
      path: "/p",
      at: 122,
      event: false,
    },
    {
      id: "b4",
      sessionId: "s2",
      visitorId: "v2",
      path: "/p",
      at: 123,
      event: false,
    },
  ]);
  seedSite(database, SITE_C, 3, [
    {
      id: "c1",
      sessionId: "s1",
      visitorId: "v1",
      path: "/q",
      at: 130,
      event: true,
    },
    {
      id: "c2",
      sessionId: "s2",
      visitorId: "v2",
      path: "/q",
      at: 131,
      event: true,
    },
  ]);
  return database;
}
