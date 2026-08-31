import {
  type SqlBinding,
  VISIT_D1_COLUMNS,
  type VisitBindingRow,
  visitBindings,
} from "../../src/lib/edge/ingest-sql";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface HistorySeedInput {
  nowMs: number;
  runId: string;
  siteId: string;
}

export interface HistorySeedManifest {
  fromMs: number;
  pages: Record<string, number>;
  totalVisits: number;
  toMs: number;
}

function sqlLiteral(value: SqlBinding): string {
  if (value === null) return "NULL";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "NULL";
  return `'${value.replaceAll("'", "''")}'`;
}

function visitRow(input: HistorySeedInput, index: number): VisitBindingRow {
  const pages = ["/", "/pricing", "/docs", "/checkout"] as const;
  const countries = ["CN", "US", "JP", "DE"] as const;
  const browsers = ["Chrome", "Firefox", "Safari", "Edge"] as const;
  const page = pages[index % pages.length];
  const country = countries[index % countries.length];
  const browser = browsers[index % browsers.length];
  const startedAt =
    input.nowMs - (120 - index) * DAY_MS + (index % 12) * 60 * 60 * 1000;
  const visitorIndex = index % 24;
  return {
    asOrganization: "InsightFlare E2E Network",
    browser,
    browserVersion: "1",
    city: country === "CN" ? "Shanghai" : country === "US" ? "New York" : "",
    continent:
      country === "CN" || country === "JP"
        ? "AS"
        : country === "US"
          ? "NA"
          : "EU",
    country,
    createdAt: startedAt,
    deviceType: index % 3 === 0 ? "mobile" : "desktop",
    durationMs: 5_000 + (index % 9) * 1_000,
    durationSource: "client",
    endedAt: startedAt + 5_000 + (index % 9) * 1_000,
    exitReason: "pagehide",
    finalizedAt: startedAt + 5_000 + (index % 9) * 1_000,
    hashFragment: "",
    hostname: "history.e2e.test",
    isEU: country === "DE" ? 1 : 0,
    language: country === "CN" ? "zh-CN" : "en-US",
    lastActivityAt: startedAt + 5_000 + (index % 9) * 1_000,
    latitude: null,
    longitude: null,
    metroCode: "",
    os: index % 3 === 0 ? "Android" : "Windows",
    osVersion: "1",
    pathname: page,
    perfCls: 0.01 * (index % 5),
    perfFcpMs: 600 + (index % 7) * 100,
    perfInpMs: 80 + (index % 6) * 10,
    perfLcpMs: 1_200 + (index % 8) * 100,
    perfTtfbMs: 100 + (index % 4) * 20,
    postalCode: "",
    queryString: page === "/pricing" ? "plan=pro" : "",
    referrerHost: index % 3 === 0 ? "google.com" : "",
    referrerUrl:
      index % 3 === 0 ? "https://google.com/search?q=insightflare" : "",
    region: "",
    regionCode: "",
    screenHeight: 900,
    screenWidth: index % 3 === 0 ? 390 : 1440,
    sessionId: `${input.runId}-history-session-${Math.floor(index / 3)}`,
    siteId: input.siteId,
    startedAt,
    status: "complete",
    timezone: country === "CN" ? "Asia/Shanghai" : "UTC",
    title: `E2E ${page}`,
    uaRaw: `E2E ${browser}`,
    updatedAt: startedAt,
    userId: "",
    userName: "",
    utmCampaign: index % 5 === 0 ? "summer-launch" : "",
    utmContent: "",
    utmMedium: index % 5 === 0 ? "email" : "",
    utmSource: index % 5 === 0 ? "newsletter" : "",
    utmTerm: "",
    visitorId: `${input.runId}-history-visitor-${visitorIndex}`,
    visitId: `${input.runId}-history-visit-${index}`,
  };
}

export function buildHistorySeed(input: HistorySeedInput): {
  manifest: HistorySeedManifest;
  sql: string;
} {
  const rows = Array.from({ length: 120 }, (_, index) =>
    visitRow(input, index),
  );
  const pages: Record<string, number> = {};
  for (const row of rows) pages[row.pathname] = (pages[row.pathname] || 0) + 1;
  const sitePkSql = `(SELECT site_pk FROM site_identities WHERE site_id = ${sqlLiteral(
    input.siteId,
  )})`;
  const sql = [
    `INSERT OR IGNORE INTO site_identities (site_id) VALUES (${sqlLiteral(input.siteId)});`,
    ...rows.map((row) => {
      const bindings = visitBindings(row);
      const values = VISIT_D1_COLUMNS.map((column, index) =>
        column === "site_pk" ? sitePkSql : sqlLiteral(bindings[index]),
      );
      return `INSERT INTO visits (${VISIT_D1_COLUMNS.join(", ")}) VALUES (${values.join(", ")});`;
    }),
  ].join("\n");
  return {
    manifest: {
      fromMs: Math.min(...rows.map((row) => row.startedAt)),
      pages,
      totalVisits: rows.length,
      toMs: Math.max(...rows.map((row) => row.startedAt)),
    },
    sql,
  };
}
