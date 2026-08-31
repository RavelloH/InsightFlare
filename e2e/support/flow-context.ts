import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expect, type Page } from "@playwright/test";

import {
  buildHistorySeed,
  type HistorySeedManifest,
} from "../../scripts/e2e/seed-history";
import {
  type OverviewMetrics,
  readSiteOverview as readSiteOverviewAt,
  siteQueryPath as siteQueryPathAt,
} from "./api";
import { createE2eControlClient } from "./control";

const execFileAsync = promisify(execFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is required. Start E2E through scripts/e2e.ts.`);
  return value;
}

export type User = {
  email: string;
  id: string;
  name: string;
  systemRole: "admin" | "user";
  username: string;
};
export type Team = {
  id: string;
  membershipRole?: "admin" | "member" | "owner";
  name: string;
  ownerUserId: string;
  slug: string;
};
export type Site = {
  domain: string;
  id: string;
  name: string;
  publicEnabled: boolean | number;
  publicSlug: string | null;
  teamId: string;
};
export type Member = {
  role: "admin" | "member" | "owner";
  siteIds: string[];
  teamId: string;
  userId: string;
  username: string;
};
export type ApiKey = {
  id: string;
  name: string;
  scopes: string[];
  siteIds: string[];
  status: "active" | "expired" | "revoked";
  teamId: string;
};
export type CreatedApiKey = { key: ApiKey; secret: string };
export type TeamInvite = {
  id: string;
  payload: { siteIds?: string[]; teamRole?: "admin" | "member" };
  status: "active" | "revoked" | "used" | "expired";
};
export type CreatedTeamInvite = { invite: TeamInvite; url: string };
export type NotificationMessage = {
  id: string;
  readAt: number | null;
  ruleId: string;
};
export type NotificationRule = {
  enabled: boolean;
  id: string;
  lastCheckedAt: number | null;
};
export type NotificationEvaluation = {
  data?: { metrics?: OverviewMetrics };
  status: "checked" | "skipped" | "triggered";
};
export type NotificationManualRun = {
  evaluation: NotificationEvaluation;
  messageCount: number;
  summary: { messagesCreated: number };
};
export type NotificationEmailConfig = {
  enabled: boolean;
  fromEmail: string;
  resend: { apiKeyHint: string; configured: boolean };
};
export type DashboardPage = {
  pathname: string;
  sessions: number;
  views: number;
};
export type EventType = { label: string; views: number };
export type DimensionMetric = {
  label: string;
  sessions: number;
  views: number;
  visitors: number;
};
export type ReferrerMetric = {
  referrer: string;
  sessions: number;
  views: number;
};
export type PerformancePayload = {
  routes?: Array<{
    metrics: { lcp: { p75: number | null; samples: number } };
    pathname: string;
    views: number;
  }>;
  summaries?: {
    lcp: { avg: number | null; p75: number | null; samples: number };
  };
};
export type TrackerExpectation = {
  customEvents: Array<{ eventName: string; pathname: string }>;
  overview: Pick<OverviewMetrics, "views">;
  pageviews: string[];
};

export type SeedManifest = {
  apiKeys: Partial<Record<"analyticsRead" | "revoked", CreatedApiKey>>;
  clock: {
    initialNow: string;
    nowMs: number;
    sessionWindowMinutes: number;
    timeZone: string;
  };
  invites: Partial<Record<"active" | "revoked", CreatedTeamInvite>>;
  notifications: Partial<Record<"dailyReport" | "threshold", NotificationRule>>;
  runId: string;
  history?: Partial<Record<"siteB", HistorySeedManifest>>;
  sites: Partial<Record<"siteA" | "siteB" | "siteC", Site>>;
  teams: Partial<Record<"teamA" | "teamB", Team>>;
  tracker?: Partial<Record<"siteA", TrackerExpectation>>;
  users: Partial<
    Record<
      "admin" | "memberA" | "outsider" | "ownerA" | "ownerB" | "restrictedA",
      User
    >
  >;
};

export type E2eContext = ReturnType<typeof createFlowContext>;

export function createFlowContext() {
  const adminPassword = required("INSIGHTFLARE_E2E_ADMIN_PASSWORD");
  const manifestPath = required("INSIGHTFLARE_E2E_MANIFEST");
  const runId = required("INSIGHTFLARE_E2E_RUN_ID");
  const testSiteURL = required("INSIGHTFLARE_E2E_TEST_SITE_URL");
  const controlToken = required("INSIGHTFLARE_E2E_CONTROL_TOKEN");
  const mockControlToken = required("INSIGHTFLARE_E2E_MOCK_CONTROL_TOKEN");
  const configPath = required("INSIGHTFLARE_E2E_CONFIG_PATH");
  const archiveBucketName = required("INSIGHTFLARE_E2E_ARCHIVE_BUCKET");
  const d1Name = required("INSIGHTFLARE_E2E_D1_NAME");
  const persistencePath = required("INSIGHTFLARE_E2E_PERSISTENCE_PATH");
  const e2eNowMs = Number(required("INSIGHTFLARE_E2E_NOW_MS"));
  if (!Number.isFinite(e2eNowMs))
    throw new Error("INSIGHTFLARE_E2E_NOW_MS must be a timestamp.");
  let currentE2eNowMs = e2eNowMs;
  const passwords = {
    memberA: "e2e-member-a-password",
    outsider: "e2e-outsider-password",
    ownerA: "e2e-owner-a-password",
    ownerB: "e2e-owner-b-password",
    restrictedA: "e2e-restricted-a-password",
  };
  const seed: SeedManifest = {
    apiKeys: {},
    clock: {
      initialNow: new Date(e2eNowMs).toISOString(),
      nowMs: e2eNowMs,
      sessionWindowMinutes: 30,
      timeZone: "Asia/Shanghai",
    },
    invites: {},
    notifications: {},
    runId,
    sites: {},
    teams: {},
    users: {
      admin: {
        email: "",
        id: "",
        name: "",
        systemRole: "admin",
        username: "admin",
      },
    },
  };
  const controls = createE2eControlClient({
    controlToken,
    mockControlToken,
    testSiteURL,
  });
  const saveManifest = () =>
    writeFile(manifestPath, `${JSON.stringify(seed, null, 2)}\n`);
  const browserNowMs = () => Date.now();
  const siteQueryPath = (siteId: string, pathValue: string) =>
    siteQueryPathAt(siteId, pathValue, browserNowMs());
  const readSiteOverview = (page: Page, siteId: string) =>
    readSiteOverviewAt(page, siteId, browserNowMs());
  async function advanceE2eClock(page: Page, deltaMs: number) {
    const result = await controls.e2eControlRequest<{ nowMs: number }>(
      page,
      "POST",
      "clock/advance",
      { deltaMs },
    );
    expect(result.status).toBe(200);
    const nowMs = result.payload?.data?.nowMs;
    if (typeof nowMs !== "number" || !Number.isFinite(nowMs))
      throw new Error("E2E clock advance did not return a timestamp.");
    currentE2eNowMs = nowMs;
    seed.clock.nowMs = nowMs;
    await saveManifest();
    return nowMs;
  }
  async function seedHistoricalVisits(siteId: string) {
    const history = buildHistorySeed({ nowMs: e2eNowMs, runId, siteId });
    const sqlPath = path.join(path.dirname(manifestPath), "history-seed.sql");
    await writeFile(sqlPath, history.sql);
    await execFileAsync(process.execPath, [
      path.join(
        process.cwd(),
        "node_modules",
        "wrangler",
        "bin",
        "wrangler.js",
      ),
      "d1",
      "execute",
      d1Name,
      "--config",
      configPath,
      "--file",
      sqlPath,
      "--local",
      "--persist-to",
      persistencePath,
    ]);
    return history.manifest;
  }
  async function seedArchiveObject(siteId: string) {
    const hour = Math.floor(e2eNowMs / 3_600_000);
    const archiveKey = `e2e/${siteId}/${hour}.parquet`;
    const content = "E2E archive\n";
    const directory = path.dirname(manifestPath);
    const archivePath = path.join(directory, "archive.parquet");
    const sqlPath = path.join(directory, "archive-seed.sql");
    await writeFile(archivePath, content);
    await execFileAsync(process.execPath, [
      path.join(
        process.cwd(),
        "node_modules",
        "wrangler",
        "bin",
        "wrangler.js",
      ),
      "r2",
      "object",
      "put",
      `${archiveBucketName}/${archiveKey}`,
      "--config",
      configPath,
      "--file",
      archivePath,
      "--local",
      "--persist-to",
      persistencePath,
    ]);
    const quote = (value: string | number) =>
      typeof value === "number"
        ? String(value)
        : `'${value.replaceAll("'", "''")}'`;
    const sitePk = `(SELECT site_pk FROM site_identities WHERE site_id = ${quote(siteId)})`;
    await writeFile(
      sqlPath,
      `INSERT OR IGNORE INTO site_identities (site_id) VALUES (${quote(siteId)});\nINSERT INTO archive_objects (archive_key, site_id, start_hour, end_hour, granularity, format, row_count, size_bytes, created_at, updated_at, site_pk) VALUES (${quote(archiveKey)}, ${quote(siteId)}, ${quote(hour)}, ${quote(hour)}, 'hour', 'parquet', 1, ${quote(content.length)}, ${quote(e2eNowMs)}, ${quote(e2eNowMs)}, ${sitePk});\n`,
    );
    await execFileAsync(process.execPath, [
      path.join(
        process.cwd(),
        "node_modules",
        "wrangler",
        "bin",
        "wrangler.js",
      ),
      "d1",
      "execute",
      d1Name,
      "--config",
      configPath,
      "--file",
      sqlPath,
      "--local",
      "--persist-to",
      persistencePath,
    ]);
    return { archiveKey, content, hour };
  }
  async function flushSite(page: Page, siteId: string) {
    const result = await controls.e2eControlRequest<{
      flushed: boolean;
      siteId: string;
    }>(page, "POST", "ingest/flush", { siteId });
    expect(result.status).toBe(200);
    expect(result.payload?.data).toEqual({ flushed: true, siteId });
  }
  return {
    ...controls,
    adminPassword,
    advanceE2eClock,
    browserNowMs,
    currentE2eNowMs: () => currentE2eNowMs,
    e2eNowMs,
    flushSite,
    passwords,
    readSiteOverview,
    runId,
    saveManifest,
    seed,
    seedArchiveObject,
    seedHistoricalVisits,
    siteQueryPath,
    testSiteURL,
  };
}
