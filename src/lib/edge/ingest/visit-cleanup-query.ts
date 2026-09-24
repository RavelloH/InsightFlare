import type { IngestSqlAccess } from "./sql-access";

export function readVisitCleanupDueAt(sql: IngestSqlAccess): number | null {
  const row = sql.sqlOne<{ metadataValue: number | null }>(
    `
      SELECT metadata_value AS metadataValue
      FROM ingest_schema_metadata
      WHERE metadata_key = 'buffered_visits_cleanup_due_at'
        AND version = 1
      LIMIT 1
    `,
  );
  const dueAt = row?.metadataValue;
  return typeof dueAt === "number" && Number.isFinite(dueAt)
    ? Math.trunc(dueAt)
    : null;
}

export function hasOpenVisitsForVisitor(
  sql: IngestSqlAccess,
  siteId: string,
  visitorId: string,
): boolean {
  const row = sql.sqlOne<{ ok: number }>(
    `
      SELECT 1 AS ok
      FROM buffered_visits
      WHERE site_id = ?
        AND visitor_id = ?
        AND status = 'open'
      LIMIT 1
    `,
    siteId,
    visitorId,
  );
  return row !== null;
}
