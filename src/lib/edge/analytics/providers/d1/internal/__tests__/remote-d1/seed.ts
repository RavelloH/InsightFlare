/**
 * Deterministic synthetic analytics data for the D1 cost baseline. One list of
 * literal SQL statements is the single source of truth: it is applied to a
 * local SQLite database and to the remote benchmark database so both hold
 * identical rows and results can be compared.
 */

export const SEED_SITE_ID = "c01-site";
export const SEED_BASE_MS = 1_700_000_000_000;
export const SEED_DAY_MS = 86_400_000;
export const SEED_DAYS = 7;

export interface SeedConfig {
  readonly visits: number;
}

const PATHS = [
  "/qualifier",
  "/qualifier",
  "/qualifier",
  "/pricing",
  "/docs/intro",
  "/docs/api",
  "/docs/guide",
  "/blog/a",
  "/blog/b",
  "/blog/c",
  "/about",
  "/contact",
  "/excluded",
  "/",
  "/",
  "/",
] as const;
const REFERRERS = [
  "",
  "",
  "google.com",
  "bing.com",
  "news.ycombinator.com",
  "github.com",
  "twitter.com",
  "reddit.com",
  "duckduckgo.com",
  "t.co",
] as const;
const BROWSERS = ["Chrome", "Safari", "Firefox", "Edge"] as const;
const COUNTRIES = ["US", "DE", "CN", "JP", "GB", "FR", "BR", "IN"] as const;

function pick<T>(items: readonly T[], seed: number): T {
  return items[Math.abs(seed) % items.length]!;
}

function literal(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (!/^[A-Za-z0-9_./:\- ]*$/u.test(value))
    throw new Error(`seed_literal_unsafe:${value}`);
  return `'${value}'`;
}

function insert(
  table: string,
  columns: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
  rowsPerStatement: number,
): string[] {
  const statements: string[] = [];
  for (let index = 0; index < rows.length; index += rowsPerStatement) {
    const chunk = rows.slice(index, index + rowsPerStatement);
    statements.push(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${chunk
        .map((row) => `(${row.map(literal).join(", ")})`)
        .join(", ")}`,
    );
  }
  return statements;
}

/** Statements that create the one site this baseline reads. */
export function buildSiteStatements(): string[] {
  return [
    `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ('c01-user', 'c01@example.invalid', 'c01', 0, 0)`,
    `INSERT INTO teams (id, name, slug, owner_user_id, created_at, updated_at) VALUES ('c01-team', 'c01', 'c01-team', 'c01-user', 0, 0)`,
    `INSERT INTO site_identities (site_pk, site_id) VALUES (1, '${SEED_SITE_ID}')`,
    `INSERT INTO sites (id, team_id, name, domain, created_at, updated_at) VALUES ('${SEED_SITE_ID}', 'c01-team', 'c01', 'c01.example.invalid', 0, 0)`,
    `INSERT INTO custom_event_names (id, site_id, name, created_at, last_seen_at, site_pk) VALUES (1, '${SEED_SITE_ID}', 'qualifier', 0, 0, 1), (2, '${SEED_SITE_ID}', 'other', 0, 0, 1)`,
  ];
}

/** Visits and events spread over SEED_DAYS days, sessions of three visits. */
export function buildDataStatements(config: SeedConfig): string[] {
  const span = SEED_DAYS * SEED_DAY_MS;
  const visitRows: (string | number | null)[][] = [];
  const eventRows: (string | number | null)[][] = [];
  for (let index = 0; index < config.visits; index += 1) {
    const startedAt = SEED_BASE_MS + Math.floor((index * span) / config.visits);
    const path = pick(PATHS, index * 7 + 3);
    const referrer = pick(REFERRERS, index * 13 + 5);
    const duration = 1_000 + ((index * 977) % 90_000);
    const visitId = `v${index}`;
    visitRows.push([
      visitId,
      SEED_SITE_ID,
      `vis${Math.floor(index / 6)}`,
      `ses${Math.floor(index / 3)}`,
      "closed",
      startedAt,
      startedAt + duration,
      startedAt + duration,
      path,
      "c01.example.invalid",
      referrer === "" ? "" : `https://${referrer}/r${index % 17}`,
      referrer,
      pick(COUNTRIES, index * 11),
      pick(BROWSERS, index * 3),
      "Windows",
      "desktop",
      duration,
      1,
      Math.floor(startedAt / 1000),
      Math.floor(startedAt / 1000),
    ]);
    if (path === "/qualifier")
      eventRows.push([
        `e${index}q`,
        SEED_SITE_ID,
        visitId,
        1,
        startedAt + 1,
        startedAt + 1,
        0,
        0,
        0,
        1,
        Math.floor(startedAt / 1000),
      ]);
    if (index % 5 === 0)
      eventRows.push([
        `e${index}o`,
        SEED_SITE_ID,
        visitId,
        2,
        startedAt + 2,
        startedAt + 2,
        1,
        0,
        0,
        1,
        Math.floor(startedAt / 1000),
      ]);
  }
  return [
    ...insert(
      "visits",
      [
        "visit_id",
        "site_id",
        "visitor_id",
        "session_id",
        "status",
        "started_at",
        "last_activity_at",
        "ended_at",
        "pathname",
        "hostname",
        "referrer_url",
        "referrer_host",
        "country",
        "browser",
        "os",
        "device_type",
        "duration_ms",
        "site_pk",
        "created_at",
        "updated_at",
      ],
      visitRows,
      120,
    ),
    ...insert(
      "custom_events",
      [
        "event_id",
        "site_id",
        "visit_id",
        "event_name_id",
        "occurred_at",
        "received_at",
        "sequence",
        "node_count",
        "value_count",
        "site_pk",
        "created_at",
      ],
      eventRows,
      250,
    ),
  ];
}
