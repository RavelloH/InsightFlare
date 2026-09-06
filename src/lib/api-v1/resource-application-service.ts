import type { z } from "zod";

import {
  type ApiV1ApplicationContext,
  type ApiV1ApplicationOperationId,
  type ApiV1ApplicationOperationMap,
  type ApiV1ApplicationOutcome,
  type ApiV1ApplicationService,
  type FunnelResourceSchema,
  type PrivacySettingsSchema,
  type SharingSettingsSchema,
  type SiteResourceSchema,
  type TrackingScriptSchema,
  type TrackingSettingsSchema,
} from "@/lib/api-v1/application-registry";
import {
  createSiteWithDefaultSettings,
  deleteSiteData,
  ensurePublicSlugAvailable,
} from "@/lib/edge/admin-sites";
import {
  decodeFunnelConfig,
  encodeFunnelConfig,
  type FunnelConfigV2,
  FunnelConfigValidationError,
  funnelSemanticFingerprint,
} from "@/lib/edge/analytics/contract";
import {
  readSiteScriptSettings,
  upsertSiteScriptSettings,
} from "@/lib/edge/site-settings-store";
import type { Env } from "@/lib/edge/types";
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  InvalidCursorError,
  pageResponse,
  pageResult,
  paginationBinding,
} from "@/lib/pagination";
import { DEFAULT_SITE_SCRIPT_SETTINGS } from "@/lib/site-settings";

type SiteResource = z.infer<typeof SiteResourceSchema>;
type FunnelResource = z.infer<typeof FunnelResourceSchema>;
type TrackingSettings = z.infer<typeof TrackingSettingsSchema>;
type PrivacySettings = z.infer<typeof PrivacySettingsSchema>;
type SharingSettings = z.infer<typeof SharingSettingsSchema>;
type TrackingScript = z.infer<typeof TrackingScriptSchema>;
type ResourceOperation = Exclude<
  ApiV1ApplicationOperationId,
  "savedFilters.list" | "savedFilters.get"
>;
type ResourceOutcome = ApiV1ApplicationOutcome<unknown, string>;

interface SiteRow {
  readonly id: string;
  readonly teamId: string;
  readonly name: string;
  readonly domain: string;
  readonly publicEnabled: number;
  readonly publicSlug: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface FunnelRow {
  readonly id: string;
  readonly site_id: string;
  readonly name: string;
  readonly config_json: string;
  readonly config_version?: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface ResourcePageKey {
  readonly createdAt: number;
  readonly id: string;
}

function decodeResourcePageKey(value: unknown): ResourcePageKey | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ["createdAt", "id"])) return null;
  return typeof record.createdAt === "number" &&
    Number.isSafeInteger(record.createdAt) &&
    record.createdAt >= 0 &&
    typeof record.id === "string" &&
    record.id.length > 0
    ? { createdAt: record.createdAt, id: record.id }
    : null;
}

async function resourcePaginationBinding(
  context: ApiV1ApplicationContext,
  operation: "sites" | "funnels",
  siteId?: string,
): Promise<string> {
  return paginationBinding([
    "api-v1-resource-pagination-v1",
    operation,
    context.teamId,
    [...new Set(context.siteIds)].sort(),
    siteId ?? null,
  ]);
}

function iso(seconds: number): string {
  return new Date(seconds * 1_000).toISOString();
}

function siteLinks(siteId: string): Record<string, string> {
  const base = `/api/v1/sites/${encodeURIComponent(siteId)}`;
  return {
    self: base,
    settingsTracking: `${base}/settings/tracking`,
    settingsPrivacy: `${base}/settings/privacy`,
    settingsSharing: `${base}/settings/sharing`,
    funnels: `${base}/funnels`,
    analyticsOverview: `${base}/analytics/overview`,
  };
}

function siteResource(row: SiteRow): SiteResource {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    sharing: {
      publicEnabled: row.publicEnabled === 1,
      publicSlug: row.publicSlug,
    },
    links: siteLinks(row.id),
  };
}

function funnelConfig(row: FunnelRow): FunnelConfigV2 {
  return decodeFunnelConfig(
    Number.isSafeInteger(row.config_version) ? row.config_version! : 1,
    row.config_json,
  );
}

async function funnelResource(row: FunnelRow): Promise<FunnelResource> {
  const config = funnelConfig(row);
  return {
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    filterDslVersion: config.filterDslVersion,
    progressionScope: config.progressionScope,
    conversionWindowMs: config.conversionWindowMs,
    steps: [...config.steps],
    semanticFingerprint: await funnelSemanticFingerprint(config),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    links: {
      self: `/api/v1/sites/${row.site_id}/funnels/${row.id}`,
      analysis: `/api/v1/sites/${row.site_id}/funnels/${row.id}/analysis`,
    },
  };
}

function trackingSettings(
  settings: typeof DEFAULT_SITE_SCRIPT_SETTINGS,
  domain: string,
): TrackingSettings {
  return {
    trackPageviews: true,
    trackQuery: settings.trackQueryParams,
    trackHash: settings.trackHash,
    trackCustomEvents: true,
    trackEngagement: true,
    trackWebVitals: settings.performanceSampleRate > 0,
    autoTrackOutboundLinks: settings.autoTrackOutboundLinks,
    trackingStrength: settings.trackingStrength,
    allowedDomains: [domain, ...settings.domainWhitelist],
    excludedPaths: settings.pathBlacklist,
  };
}

function privacySettings(
  settings: typeof DEFAULT_SITE_SCRIPT_SETTINGS,
): PrivacySettings {
  return {
    respectDoNotTrack: !settings.ignoreDoNotTrack,
    anonymizeIp: true,
    euMode: settings.trackingStrength === "weak",
    visitorTokenMode: "daily",
    dataRetentionDays: 180,
  };
}

function isAllowed(context: ApiV1ApplicationContext, siteId: string): boolean {
  return context.siteIds.length === 0 || context.siteIds.includes(siteId);
}

function stopped(execution: {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}): boolean {
  return Boolean(
    execution.signal?.aborted ||
    (execution.deadlineMs !== undefined && Date.now() >= execution.deadlineMs),
  );
}

async function siteById(
  env: Pick<Env, "DB">,
  context: ApiV1ApplicationContext,
  siteId: string,
): Promise<SiteRow | null> {
  if (!isAllowed(context, siteId)) return null;
  return (
    (await env.DB.prepare(
      `SELECT id, team_id AS teamId, name, domain,
              public_enabled AS publicEnabled, public_slug AS publicSlug,
              created_at AS createdAt, updated_at AS updatedAt
       FROM sites WHERE id=? AND team_id=? LIMIT 1`,
    )
      .bind(siteId, context.teamId)
      .first<SiteRow>()) ?? null
  );
}

async function funnelById(
  env: Pick<Env, "DB">,
  siteId: string,
  funnelId: string,
): Promise<FunnelRow | null> {
  return (
    (await env.DB.prepare(
      `SELECT id, site_id, name, config_json, config_version, created_at, updated_at
       FROM analysis_definitions
       WHERE id=? AND site_id=? AND kind='funnel' AND archived_at IS NULL
       LIMIT 1`,
    )
      .bind(funnelId, siteId)
      .first<FunnelRow>()) ?? null
  );
}

function ok<T>(value: T): ApiV1ApplicationOutcome<T, never> {
  return { ok: true, value };
}

function failed(
  code:
    | "not_found"
    | "conflict"
    | "forbidden"
    | "invalid_input"
    | "internal_error"
    | "invalid_cursor",
): ResourceOutcome {
  return { ok: false, error: { code } };
}

/** D1/KV-backed resource service. It has no HTTP, principal, or Hono dependency. */
export function createResourceApplicationService(
  env: Env,
): ApiV1ApplicationService {
  async function execute<K extends ResourceOperation>(
    context: ApiV1ApplicationContext,
    operation: K,
    input: ApiV1ApplicationOperationMap[K]["input"],
    execution: { readonly signal?: AbortSignal; readonly deadlineMs?: number },
  ): Promise<
    ApiV1ApplicationOutcome<
      ApiV1ApplicationOperationMap[K]["result"],
      ApiV1ApplicationOperationMap[K]["error"]
    >
  > {
    if (stopped(execution)) return failed("internal_error") as never;
    try {
      const request = input as {
        readonly siteId?: string;
        readonly funnelId?: string;
      };
      if (operation === "sites.list") {
        const value =
          input as ApiV1ApplicationOperationMap["sites.list"]["input"];
        const binding = await resourcePaginationBinding(context, "sites");
        let cursor: ResourcePageKey | null;
        try {
          cursor = await decodePageCursor(
            env,
            binding,
            value.page.cursor,
            "api-v1-sites",
            decodeResourcePageKey,
          );
        } catch (error) {
          if (error instanceof InvalidCursorError)
            return failed("invalid_cursor") as never;
          throw error;
        }
        const allowedSiteIds = [...new Set(context.siteIds)];
        const where = ["team_id=?"];
        const parameters: unknown[] = [context.teamId];
        if (allowedSiteIds.length > 0) {
          where.push(`id IN (${allowedSiteIds.map(() => "?").join(",")})`);
          parameters.push(...allowedSiteIds);
        }
        if (cursor) {
          where.push("(created_at < ? OR (created_at = ? AND id > ?))");
          parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
        }
        parameters.push(value.page.limit + 1);
        const rows = await env.DB.prepare(
          `SELECT id, team_id AS teamId, name, domain,
                  public_enabled AS publicEnabled, public_slug AS publicSlug,
                  created_at AS createdAt, updated_at AS updatedAt
           FROM sites WHERE ${where.join(" AND ")}
           ORDER BY created_at DESC, id ASC LIMIT ?`,
        )
          .bind(...parameters)
          .all<SiteRow>();
        const page = pageResult(rows.results, value.page.limit);
        const nextCursor =
          page.hasMore && page.last
            ? await encodePageCursor(env, binding, {
                createdAt: page.last.createdAt,
                id: page.last.id,
              })
            : null;
        return ok(
          pageResponse(
            page.rows.map(siteResource),
            value.page.limit,
            nextCursor,
          ),
        ) as never;
      }
      if (operation === "sites.create") {
        const value =
          input as ApiV1ApplicationOperationMap["sites.create"]["input"];
        if (context.siteIds.length > 0) return failed("forbidden") as never;
        const publicSlug = value.publicEnabled
          ? (value.publicSlug ?? null)
          : null;
        if (publicSlug && !(await ensurePublicSlugAvailable(env, publicSlug))) {
          return failed("conflict") as never;
        }
        const siteId = await createSiteWithDefaultSettings(env, {
          teamId: context.teamId,
          name: value.name,
          domain: value.domain,
          publicEnabled: value.publicEnabled,
          publicSlug,
        });
        const row = await siteById(env, { ...context, siteIds: [] }, siteId);
        return row
          ? (ok(siteResource(row)) as never)
          : (failed("internal_error") as never);
      }
      if (!request.siteId || !isAllowed(context, request.siteId)) {
        return failed("not_found") as never;
      }
      const site = await siteById(env, context, request.siteId);
      if (!site) return failed("not_found") as never;
      if (operation === "sites.get") return ok(siteResource(site)) as never;
      if (operation === "sites.delete") {
        await deleteSiteData(env, site.id);
        return ok(undefined) as never;
      }
      if (operation === "sites.update") {
        const value =
          input as ApiV1ApplicationOperationMap["sites.update"]["input"];
        const publicEnabled = value.publicEnabled ?? site.publicEnabled === 1;
        const publicSlug = publicEnabled
          ? (value.publicSlug ?? site.publicSlug)
          : null;
        if (
          publicSlug &&
          !(await ensurePublicSlugAvailable(env, publicSlug, site.id))
        ) {
          return failed("conflict") as never;
        }
        const domain = value.domain ?? site.domain;
        await env.DB.prepare(
          "UPDATE sites SET name=?, domain=?, public_enabled=?, public_slug=?, updated_at=unixepoch() WHERE id=? AND team_id=?",
        )
          .bind(
            value.name ?? site.name,
            domain,
            publicEnabled ? 1 : 0,
            publicSlug,
            site.id,
            context.teamId,
          )
          .run();
        await upsertSiteScriptSettings(env, site.id, { siteDomain: domain });
        const updated = await siteById(env, context, site.id);
        return updated
          ? (ok(siteResource(updated)) as never)
          : (failed("internal_error") as never);
      }
      if (operation.startsWith("settings.")) {
        const existing =
          (await readSiteScriptSettings(env, site.id)) ??
          DEFAULT_SITE_SCRIPT_SETTINGS;
        if (operation === "settings.tracking.get")
          return ok(trackingSettings(existing, site.domain)) as never;
        if (operation === "settings.privacy.get")
          return ok(privacySettings(existing)) as never;
        if (operation === "settings.sharing.get")
          return ok(siteResource(site).sharing) as never;
        if (operation === "settings.trackingScript.get") {
          const origin = (
            input as ApiV1ApplicationOperationMap["settings.trackingScript.get"]["input"]
          ).origin;
          const src = `${origin.replace(/\/$/u, "")}/script.js?siteId=${encodeURIComponent(site.id)}`;
          return ok({
            siteId: site.id,
            src,
            snippet: `<script defer src="${src}"></script>`,
          } satisfies TrackingScript) as never;
        }
        if (operation === "settings.tracking.update") {
          const value =
            input as ApiV1ApplicationOperationMap["settings.tracking.update"]["input"];
          const next = await upsertSiteScriptSettings(env, site.id, {
            siteDomain: site.domain,
            settings: {
              trackQueryParams: value.trackQuery,
              trackHash: value.trackHash,
              autoTrackOutboundLinks: value.autoTrackOutboundLinks,
              trackingStrength: value.trackingStrength,
              domainWhitelist: value.allowedDomains?.slice(1),
              pathBlacklist: value.excludedPaths,
              performanceSampleRate:
                value.trackWebVitals === undefined
                  ? undefined
                  : value.trackWebVitals
                    ? 100
                    : 0,
            },
          });
          return ok(trackingSettings(next, site.domain)) as never;
        }
        if (operation === "settings.privacy.update") {
          const value =
            input as ApiV1ApplicationOperationMap["settings.privacy.update"]["input"];
          const next = await upsertSiteScriptSettings(env, site.id, {
            siteDomain: site.domain,
            settings: {
              ...(value.respectDoNotTrack === undefined
                ? {}
                : { ignoreDoNotTrack: !value.respectDoNotTrack }),
              ...(value.euMode === undefined
                ? {}
                : { trackingStrength: value.euMode ? "weak" : "strong" }),
            },
          });
          return ok(privacySettings(next)) as never;
        }
        const value =
          input as ApiV1ApplicationOperationMap["settings.sharing.update"]["input"];
        const publicEnabled = value.publicEnabled ?? site.publicEnabled === 1;
        const publicSlug = publicEnabled
          ? (value.publicSlug ?? site.publicSlug)
          : null;
        if (
          publicSlug &&
          !(await ensurePublicSlugAvailable(env, publicSlug, site.id))
        ) {
          return failed("conflict") as never;
        }
        const sharing: SharingSettings = {
          publicEnabled,
          publicSlug,
        };
        await env.DB.prepare(
          "UPDATE sites SET public_enabled=?, public_slug=?, updated_at=unixepoch() WHERE id=? AND team_id=?",
        )
          .bind(
            sharing.publicEnabled ? 1 : 0,
            sharing.publicSlug,
            site.id,
            context.teamId,
          )
          .run();
        return ok(sharing) as never;
      }
      if (operation === "funnels.list") {
        const value =
          input as ApiV1ApplicationOperationMap["funnels.list"]["input"];
        const binding = await resourcePaginationBinding(
          context,
          "funnels",
          site.id,
        );
        let cursor: ResourcePageKey | null;
        try {
          cursor = await decodePageCursor(
            env,
            binding,
            value.page.cursor,
            "api-v1-funnels",
            decodeResourcePageKey,
          );
        } catch (error) {
          if (error instanceof InvalidCursorError)
            return failed("invalid_cursor") as never;
          throw error;
        }
        const where = ["site_id=?", "kind='funnel'", "archived_at IS NULL"];
        const parameters: unknown[] = [site.id];
        if (cursor) {
          where.push("(created_at < ? OR (created_at = ? AND id > ?))");
          parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
        }
        parameters.push(value.page.limit + 1);
        const rows = await env.DB.prepare(
          `SELECT id, site_id, name, config_json, config_version, created_at, updated_at
           FROM analysis_definitions WHERE ${where.join(" AND ")}
           ORDER BY created_at DESC, id ASC LIMIT ?`,
        )
          .bind(...parameters)
          .all<FunnelRow>();
        const page = pageResult(rows.results, value.page.limit);
        const nextCursor =
          page.hasMore && page.last
            ? await encodePageCursor(env, binding, {
                createdAt: page.last.created_at,
                id: page.last.id,
              })
            : null;
        return ok(
          pageResponse(
            await Promise.all(page.rows.map(funnelResource)),
            value.page.limit,
            nextCursor,
          ),
        ) as never;
      }
      if (operation === "funnels.create") {
        const value =
          input as ApiV1ApplicationOperationMap["funnels.create"]["input"];
        const config: FunnelConfigV2 = {
          filterDslVersion: value.filterDslVersion,
          progressionScope: value.progressionScope,
          conversionWindowMs: value.conversionWindowMs,
          steps: value.steps,
        };
        let encoded;
        try {
          encoded = encodeFunnelConfig(config);
        } catch (error) {
          if (error instanceof FunnelConfigValidationError) {
            return failed("invalid_input") as never;
          }
          throw error;
        }
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1_000);
        await env.DB.prepare(
          `INSERT INTO analysis_definitions (id, site_id, kind, name, config_json, config_version, created_at, updated_at)
           VALUES (?, ?, 'funnel', ?, ?, ?, ?, ?)`,
        )
          .bind(
            id,
            site.id,
            value.name,
            encoded.configJson,
            encoded.configVersion,
            now,
            now,
          )
          .run();
        return ok(
          await funnelResource({
            id,
            site_id: site.id,
            name: value.name,
            config_json: encoded.configJson,
            config_version: encoded.configVersion,
            created_at: now,
            updated_at: now,
          }),
        ) as never;
      }
      if (!request.funnelId) return failed("not_found") as never;
      const funnel = await funnelById(env, site.id, request.funnelId);
      if (!funnel) return failed("not_found") as never;
      if (operation === "funnels.get")
        return ok(await funnelResource(funnel)) as never;
      if (operation === "funnels.delete") {
        const now = Math.floor(Date.now() / 1_000);
        await env.DB.prepare(
          "UPDATE analysis_definitions SET archived_at=?, updated_at=? WHERE id=? AND site_id=? AND kind='funnel' AND archived_at IS NULL",
        )
          .bind(now, now, funnel.id, site.id)
          .run();
        return ok(undefined) as never;
      }
      const value =
        input as ApiV1ApplicationOperationMap["funnels.update"]["input"];
      let currentConfig: FunnelConfigV2;
      try {
        currentConfig = funnelConfig(funnel);
      } catch {
        return failed("internal_error") as never;
      }
      const config: FunnelConfigV2 = {
        filterDslVersion:
          value.filterDslVersion ?? currentConfig.filterDslVersion,
        progressionScope:
          value.progressionScope ?? currentConfig.progressionScope,
        conversionWindowMs:
          value.conversionWindowMs !== undefined
            ? value.conversionWindowMs
            : currentConfig.conversionWindowMs,
        steps: value.steps ?? currentConfig.steps,
      };
      let encoded;
      try {
        encoded = encodeFunnelConfig(config);
      } catch (error) {
        if (error instanceof FunnelConfigValidationError) {
          return failed("invalid_input") as never;
        }
        throw error;
      }
      const now = Math.floor(Date.now() / 1_000);
      const name = value.name ?? funnel.name;
      await env.DB.prepare(
        "UPDATE analysis_definitions SET name=?, config_json=?, config_version=?, updated_at=? WHERE id=? AND site_id=? AND kind='funnel' AND archived_at IS NULL",
      )
        .bind(
          name,
          encoded.configJson,
          encoded.configVersion,
          now,
          funnel.id,
          site.id,
        )
        .run();
      return ok(
        await funnelResource({
          ...funnel,
          name,
          config_json: encoded.configJson,
          config_version: encoded.configVersion,
          updated_at: now,
        }),
      ) as never;
    } catch {
      return failed("internal_error") as never;
    }
  }

  return { execute: execute as ApiV1ApplicationService["execute"] };
}
