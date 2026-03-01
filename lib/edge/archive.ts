import type { Env } from "./types";
import { tableToIPC } from "apache-arrow/ipc/serialization";
import { tableFromArrays } from "apache-arrow/table";
import initParquetWasm, {
  Compression,
  Table as WasmArrowTable,
  WriterPropertiesBuilder,
  writeParquet,
} from "parquet-wasm/esm";
import { ONE_DAY_MS, ONE_HOUR_MS } from "./utils";

const DEFAULT_PARQUET_WASM_URL =
  "https://cdn.jsdelivr.net/npm/parquet-wasm@0.7.1/esm/parquet_wasm_bg.wasm";

let parquetWasmInitPromise: Promise<void> | null = null;

function resolveParquetWasmUrl(env: Env): string {
  const configured = (env.PARQUET_WASM_URL || "").trim();
  return configured.length > 0 ? configured : DEFAULT_PARQUET_WASM_URL;
}

async function ensureParquetWasm(env: Env): Promise<void> {
  if (parquetWasmInitPromise) {
    return parquetWasmInitPromise;
  }
  const wasmUrl = resolveParquetWasmUrl(env);
  parquetWasmInitPromise = initParquetWasm(wasmUrl).then(() => undefined);
  try {
    await parquetWasmInitPromise;
  } catch (error) {
    parquetWasmInitPromise = null;
    throw error;
  }
}

const HOT_ARCHIVE_RETENTION_DAYS = 365;
const COLD_DELETE_SAFETY_DAYS = 7;
const COLD_BATCH_MAX_HOURS = 48;

const ARCHIVE_LOCK_KEY = "job:archive:hourly:lock";
const ARCHIVE_LOCK_TTL_SECONDS = 15 * 60;
const COLD_LAST_HOUR_KEY = "job:archive:cold:last_processed_hour";

type ArchiveGranularity = "hour" | "day" | "week" | "month" | "year";

interface ColdArchiveGroup {
  siteId: string;
  startHour: number;
  endHour: number;
  granularity: ArchiveGranularity;
  key: string;
}

function epochHour(ms: number): number {
  return Math.floor(ms / ONE_HOUR_MS);
}

function clampSiteId(siteId: string): string {
  return siteId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function granularityFromAgeOverRetentionDays(ageOverRetentionDays: number): ArchiveGranularity {
  if (ageOverRetentionDays <= 1) return "hour";
  if (ageOverRetentionDays <= 7) return "day";
  if (ageOverRetentionDays <= 30) return "week";
  if (ageOverRetentionDays <= 365) return "month";
  return "year";
}

function bucketHoursForGranularity(granularity: ArchiveGranularity): number {
  switch (granularity) {
    case "hour":
      return 1;
    case "day":
      return 24;
    case "week":
      return 24 * 7;
    case "month":
      return 24 * 30;
    case "year":
      return 24 * 365;
    default:
      return 24;
  }
}

function buildArchiveKey(input: {
  siteId: string;
  granularity: ArchiveGranularity;
  startHour: number;
  endHour: number;
}): string {
  return [
    "archive",
    "detail",
    "v1",
    `site=${clampSiteId(input.siteId)}`,
    `granularity=${input.granularity}`,
    `start=${input.startHour}`,
    `end=${input.endHour}.parquet`,
  ].join("/");
}

async function acquireArchiveLock(env: Env): Promise<{ owner: string } | null> {
  const owner = crypto.randomUUID();
  const nowSec = Math.floor(Date.now() / 1000);
  const staleBefore = nowSec - ARCHIVE_LOCK_TTL_SECONDS;
  const valueJson = JSON.stringify({
    owner,
    acquiredAt: nowSec,
  });

  const result = await env.DB.prepare(
    `
      INSERT INTO configs (config_key, value_json, created_at, updated_at)
      VALUES (?, ?, unixepoch(), unixepoch())
      ON CONFLICT(config_key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = unixepoch()
      WHERE configs.updated_at < ?
    `,
  )
    .bind(ARCHIVE_LOCK_KEY, valueJson, staleBefore)
    .run();

  const changed = Number(result.meta?.changes ?? 0);
  if (changed <= 0) {
    return null;
  }

  return { owner };
}

async function releaseArchiveLock(env: Env, owner: string): Promise<void> {
  const row = await env.DB.prepare("SELECT value_json FROM configs WHERE config_key = ? LIMIT 1")
    .bind(ARCHIVE_LOCK_KEY)
    .first<{ value_json: string | null }>();
  if (!row?.value_json) {
    return;
  }

  try {
    const payload = JSON.parse(row.value_json) as { owner?: string };
    if (payload.owner !== owner) {
      return;
    }
  } catch {
    return;
  }

  await env.DB.prepare("DELETE FROM configs WHERE config_key = ?").bind(ARCHIVE_LOCK_KEY).run();
}

async function getConfigInt(env: Env, key: string, fallback: number): Promise<number> {
  const row = await env.DB.prepare("SELECT value_json FROM configs WHERE config_key = ? LIMIT 1")
    .bind(key)
    .first<{ value_json: string | null }>();
  if (!row?.value_json) return fallback;
  try {
    const parsed = JSON.parse(row.value_json) as unknown;
    if (typeof parsed === "number" && Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
    if (typeof parsed === "string" && Number.isFinite(Number(parsed))) {
      return Math.floor(Number(parsed));
    }
    if (parsed && typeof parsed === "object" && "value" in parsed) {
      const n = Number((parsed as { value: unknown }).value);
      if (Number.isFinite(n)) {
        return Math.floor(n);
      }
    }
  } catch {
    // ignore malformed config json
  }
  return fallback;
}

async function setConfigInt(env: Env, key: string, value: number): Promise<void> {
  await env.DB.prepare(
    `
      INSERT INTO configs (config_key, value_json, created_at, updated_at)
      VALUES (?, ?, unixepoch(), unixepoch())
      ON CONFLICT(config_key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = unixepoch()
    `,
  )
    .bind(key, JSON.stringify(value))
    .run();
}

async function runHotArchive(env: Env, upperHour: number): Promise<void> {
  await env.DB.prepare(
    `
      WITH candidate AS (
        SELECT site_id, hour_bucket
        FROM pageviews
        WHERE hour_bucket <= ?
        GROUP BY site_id, hour_bucket
      )
      INSERT INTO pageviews_archive_hourly (
        site_id,
        hour_bucket,
        total_views,
        total_sessions,
        bounces,
        total_duration,
        visitors_json,
        path_stats_json,
        referer_stats_json,
        country_stats_json,
        region_stats_json,
        city_stats_json,
        device_stats_json,
        browser_stats_json,
        os_stats_json,
        screen_stats_json,
        language_stats_json,
        timezone_stats_json,
        created_at,
        updated_at
      )
      SELECT
        c.site_id,
        c.hour_bucket,
        (
          SELECT COUNT(*)
          FROM pageviews p
          WHERE p.site_id = c.site_id AND p.hour_bucket = c.hour_bucket
        ) AS total_views,
        (
          SELECT COUNT(DISTINCT p.session_id)
          FROM pageviews p
          WHERE p.site_id = c.site_id AND p.hour_bucket = c.hour_bucket
        ) AS total_sessions,
        (
          SELECT SUM(CASE WHEN COALESCE(p.duration_ms, 0) <= 0 THEN 1 ELSE 0 END)
          FROM pageviews p
          WHERE p.site_id = c.site_id AND p.hour_bucket = c.hour_bucket
        ) AS bounces,
        (
          SELECT SUM(COALESCE(p.duration_ms, 0))
          FROM pageviews p
          WHERE p.site_id = c.site_id AND p.hour_bucket = c.hour_bucket
        ) AS total_duration,
        COALESCE(
          (
            SELECT json_group_array(v.visitor_id)
            FROM (
              SELECT DISTINCT p.visitor_id AS visitor_id
              FROM pageviews p
              WHERE p.site_id = c.site_id AND p.hour_bucket = c.hour_bucket
            ) v
          ),
          '[]'
        ) AS visitors_json,
        COALESCE(
          (
            SELECT json_group_object(s.k, s.v)
            FROM (
              SELECT p.pathname AS k, COUNT(*) AS v
              FROM pageviews p
              WHERE p.site_id = c.site_id AND p.hour_bucket = c.hour_bucket
              GROUP BY p.pathname
            ) s
          ),
          '{}'
        ) AS path_stats_json,
        COALESCE(
          (
            SELECT json_group_object(s.k, s.v)
            FROM (
              SELECT COALESCE(p.referer_host, '') AS k, COUNT(*) AS v
              FROM pageviews p
              WHERE p.site_id = c.site_id AND p.hour_bucket = c.hour_bucket
              GROUP BY COALESCE(p.referer_host, '')
            ) s
          ),
          '{}'
        ) AS referer_stats_json,
        COALESCE(
          (
            SELECT json_group_object(s.k, s.v)
            FROM (
              SELECT COALESCE(p.country, '') AS k, COUNT(*) AS v
              FROM pageviews p
              WHERE p.site_id = c.site_id AND p.hour_bucket = c.hour_bucket
              GROUP BY COALESCE(p.country, '')
            ) s
          ),
          '{}'
        ) AS country_stats_json,
        COALESCE(
          (
            SELECT json_group_object(s.k, s.v)
            FROM (
              SELECT COALESCE(p.region, '') AS k, COUNT(*) AS v
              FROM pageviews p
              WHERE p.site_id = c.site_id AND p.hour_bucket = c.hour_bucket
              GROUP BY COALESCE(p.region, '')
            ) s
          ),
          '{}'
        ) AS region_stats_json,
        COALESCE(
          (
            SELECT json_group_object(s.k, s.v)
            FROM (
              SELECT COALESCE(p.city, '') AS k, COUNT(*) AS v
              FROM pageviews p
              WHERE p.site_id = c.site_id AND p.hour_bucket = c.hour_bucket
              GROUP BY COALESCE(p.city, '')
            ) s
          ),
          '{}'
        ) AS city_stats_json,
        COALESCE(
          (
            SELECT json_group_object(s.k, s.v)
            FROM (
              SELECT COALESCE(p.device_type, '') AS k, COUNT(*) AS v
              FROM pageviews p
              WHERE p.site_id = c.site_id AND p.hour_bucket = c.hour_bucket
              GROUP BY COALESCE(p.device_type, '')
            ) s
          ),
          '{}'
        ) AS device_stats_json,
        COALESCE(
          (
            SELECT json_group_object(s.k, s.v)
            FROM (
              SELECT COALESCE(p.browser, '') AS k, COUNT(*) AS v
              FROM pageviews p
              WHERE p.site_id = c.site_id AND p.hour_bucket = c.hour_bucket
              GROUP BY COALESCE(p.browser, '')
            ) s
          ),
          '{}'
        ) AS browser_stats_json,
        COALESCE(
          (
            SELECT json_group_object(s.k, s.v)
            FROM (
              SELECT COALESCE(p.os, '') AS k, COUNT(*) AS v
              FROM pageviews p
              WHERE p.site_id = c.site_id AND p.hour_bucket = c.hour_bucket
              GROUP BY COALESCE(p.os, '')
            ) s
          ),
          '{}'
        ) AS os_stats_json,
        COALESCE(
          (
            SELECT json_group_object(s.k, s.v)
            FROM (
              SELECT
                (COALESCE(CAST(p.screen_width AS TEXT), '0') || 'x' || COALESCE(CAST(p.screen_height AS TEXT), '0')) AS k,
                COUNT(*) AS v
              FROM pageviews p
              WHERE p.site_id = c.site_id AND p.hour_bucket = c.hour_bucket
              GROUP BY (COALESCE(CAST(p.screen_width AS TEXT), '0') || 'x' || COALESCE(CAST(p.screen_height AS TEXT), '0'))
            ) s
          ),
          '{}'
        ) AS screen_stats_json,
        COALESCE(
          (
            SELECT json_group_object(s.k, s.v)
            FROM (
              SELECT COALESCE(p.language, '') AS k, COUNT(*) AS v
              FROM pageviews p
              WHERE p.site_id = c.site_id AND p.hour_bucket = c.hour_bucket
              GROUP BY COALESCE(p.language, '')
            ) s
          ),
          '{}'
        ) AS language_stats_json,
        COALESCE(
          (
            SELECT json_group_object(s.k, s.v)
            FROM (
              SELECT COALESCE(p.timezone, '') AS k, COUNT(*) AS v
              FROM pageviews p
              WHERE p.site_id = c.site_id AND p.hour_bucket = c.hour_bucket
              GROUP BY COALESCE(p.timezone, '')
            ) s
          ),
          '{}'
        ) AS timezone_stats_json,
        unixepoch() AS created_at,
        unixepoch() AS updated_at
      FROM candidate c
      ON CONFLICT(site_id, hour_bucket) DO UPDATE SET
        total_views = excluded.total_views,
        total_sessions = excluded.total_sessions,
        bounces = excluded.bounces,
        total_duration = excluded.total_duration,
        visitors_json = excluded.visitors_json,
        path_stats_json = excluded.path_stats_json,
        referer_stats_json = excluded.referer_stats_json,
        country_stats_json = excluded.country_stats_json,
        region_stats_json = excluded.region_stats_json,
        city_stats_json = excluded.city_stats_json,
        device_stats_json = excluded.device_stats_json,
        browser_stats_json = excluded.browser_stats_json,
        os_stats_json = excluded.os_stats_json,
        screen_stats_json = excluded.screen_stats_json,
        language_stats_json = excluded.language_stats_json,
        timezone_stats_json = excluded.timezone_stats_json,
        updated_at = unixepoch()
    `,
  )
    .bind(upperHour)
    .run();
}

function buildColdGroups(input: {
  candidates: Array<{ site_id: string; hour_bucket: number }>;
  nowMs: number;
  windowUpperHour: number;
}): ColdArchiveGroup[] {
  const groups = new Map<string, ColdArchiveGroup>();

  for (const candidate of input.candidates) {
    const hourBucket = candidate.hour_bucket;
    const hourMs = hourBucket * ONE_HOUR_MS;
    const ageDays = Math.max(0, Math.floor((input.nowMs - hourMs) / ONE_DAY_MS));
    const ageOverRetentionDays = Math.max(0, ageDays - HOT_ARCHIVE_RETENTION_DAYS);
    const granularity = granularityFromAgeOverRetentionDays(ageOverRetentionDays);
    const bucketHours = bucketHoursForGranularity(granularity);

    const startHour = Math.floor(hourBucket / bucketHours) * bucketHours;
    const endHour = Math.min(startHour + bucketHours - 1, input.windowUpperHour);
    const key = buildArchiveKey({
      siteId: candidate.site_id,
      granularity,
      startHour,
      endHour,
    });

    if (!groups.has(key)) {
      groups.set(key, {
        siteId: candidate.site_id,
        startHour,
        endHour,
        granularity,
        key,
      });
    }
  }

  return Array.from(groups.values()).sort((a, b) => {
    if (a.startHour !== b.startHour) return a.startHour - b.startHour;
    return a.siteId.localeCompare(b.siteId);
  });
}

type ParquetScalar = string | number | boolean | null;

function normalizeParquetScalar(value: unknown): ParquetScalar {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toParquet(rows: Array<Record<string, unknown>>): Uint8Array {
  if (rows.length === 0) {
    return new Uint8Array();
  }
  const first = rows[0];
  const columns = Object.keys(first);
  const columnar: Record<string, ParquetScalar[]> = {};
  for (const column of columns) {
    columnar[column] = [];
  }

  for (const row of rows) {
    for (const column of columns) {
      columnar[column].push(normalizeParquetScalar(row[column]));
    }
  }

  const table = tableFromArrays(columnar);
  const ipc = tableToIPC(table, "stream");
  const wasmTable = WasmArrowTable.fromIPCStream(ipc);
  const writerProperties = new WriterPropertiesBuilder()
    .setCompression(Compression.ZSTD)
    .setDictionaryEnabled(true)
    .build();

  try {
    return writeParquet(wasmTable, writerProperties);
  } finally {
    writerProperties.free();
    wasmTable.free();
  }
}

async function runColdArchive(env: Env, nowMs: number): Promise<void> {
  const deleteBeforeHour = epochHour(
    nowMs - (HOT_ARCHIVE_RETENTION_DAYS + COLD_DELETE_SAFETY_DAYS) * ONE_DAY_MS,
  );
  if (deleteBeforeHour <= 0) {
    return;
  }

  const lastProcessedHour = await getConfigInt(env, COLD_LAST_HOUR_KEY, 0);
  const nextHour = Math.max(0, lastProcessedHour + 1);
  if (nextHour > deleteBeforeHour) {
    return;
  }

  const windowUpperHour = Math.min(deleteBeforeHour, nextHour + COLD_BATCH_MAX_HOURS - 1);

  const candidatesResult = await env.DB.prepare(
    `
      SELECT DISTINCT site_id, hour_bucket
      FROM pageviews
      WHERE hour_bucket BETWEEN ? AND ?
      ORDER BY hour_bucket ASC, site_id ASC
    `,
  )
    .bind(nextHour, windowUpperHour)
    .all<{ site_id: string; hour_bucket: number }>();

  const candidates = candidatesResult.results;
  if (candidates.length === 0) {
    await setConfigInt(env, COLD_LAST_HOUR_KEY, windowUpperHour);
    return;
  }

  const groups = buildColdGroups({
    candidates,
    nowMs,
    windowUpperHour,
  });

  if (env.ARCHIVE_BUCKET) {
    await ensureParquetWasm(env);
  }

  for (const group of groups) {
    const rowsResult = await env.DB.prepare(
      `
        SELECT
          id,
          team_id,
          site_id,
          event_type,
          event_at,
          received_at,
          hour_bucket,
          pathname,
          query_string,
          hash_fragment,
          title,
          hostname,
          referer,
          referer_host,
          utm_source,
          utm_medium,
          utm_campaign,
          utm_term,
          utm_content,
          visitor_id,
          session_id,
          duration_ms,
          is_eu,
          country,
          region,
          region_code,
          city,
          continent,
          latitude,
          longitude,
          postal_code,
          metro_code,
          timezone,
          colo,
          as_organization,
          bot_score,
          bot_verified,
          bot_security_json,
          ua_raw,
          browser,
          browser_version,
          os,
          os_version,
          device_type,
          screen_width,
          screen_height,
          language,
          ip,
          extra_json
        FROM pageviews
        WHERE site_id = ? AND hour_bucket BETWEEN ? AND ?
        ORDER BY event_at ASC
      `,
    )
      .bind(group.siteId, group.startHour, group.endHour)
      .all<Record<string, unknown>>();

    const rows = rowsResult.results;
    if (rows.length === 0) {
      continue;
    }

    const existing = await env.DB.prepare(
      "SELECT archive_key FROM archive_objects WHERE archive_key = ? LIMIT 1",
    )
      .bind(group.key)
      .first<{ archive_key: string }>();

    let format = "parquet";
    const rowCount = rows.length;
    let sizeBytes = 0;

    if (!existing?.archive_key) {
      if (env.ARCHIVE_BUCKET) {
        const body = toParquet(rows);
        sizeBytes = body.byteLength;
        await env.ARCHIVE_BUCKET.put(group.key, body, {
          httpMetadata: {
            contentType: "application/vnd.apache.parquet",
          },
          customMetadata: {
            siteId: group.siteId,
            granularity: group.granularity,
            startHour: String(group.startHour),
            endHour: String(group.endHour),
          },
        });
      } else {
        format = "none";
      }

      await env.DB.prepare(
        `
          INSERT INTO archive_objects (
            archive_key,
            site_id,
            start_hour,
            end_hour,
            granularity,
            format,
            row_count,
            size_bytes,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
          ON CONFLICT(archive_key) DO UPDATE SET
            format = excluded.format,
            row_count = excluded.row_count,
            size_bytes = excluded.size_bytes,
            updated_at = unixepoch()
        `,
      )
        .bind(
          group.key,
          group.siteId,
          group.startHour,
          group.endHour,
          group.granularity,
          format,
          rowCount,
          sizeBytes,
        )
        .run();
    }

    // Delete source detailed rows after successful cold archive metadata write.
    await env.DB.prepare(
      "DELETE FROM pageviews WHERE site_id = ? AND hour_bucket BETWEEN ? AND ?",
    )
      .bind(group.siteId, group.startHour, group.endHour)
      .run();
  }

  await setConfigInt(env, COLD_LAST_HOUR_KEY, windowUpperHour);
}

export async function runHourlyArchive(env: Env, scheduledTimeMs: number): Promise<void> {
  const lock = await acquireArchiveLock(env);
  if (!lock) {
    return;
  }

  try {
    const nowMs = scheduledTimeMs > 0 ? scheduledTimeMs : Date.now();
    const lastCompleteHour = epochHour(nowMs) - 1;
    const archiveBeforeHour = epochHour(nowMs - HOT_ARCHIVE_RETENTION_DAYS * ONE_DAY_MS);

    if (archiveBeforeHour <= 0 || lastCompleteHour <= 0) {
      return;
    }

    const upperHour = Math.min(lastCompleteHour, archiveBeforeHour);
    if (upperHour <= 0) {
      return;
    }

    await runHotArchive(env, upperHour);
    await runColdArchive(env, nowMs);
  } finally {
    await releaseArchiveLock(env, lock.owner);
  }
}
