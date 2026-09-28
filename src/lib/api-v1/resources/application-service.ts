import type { z } from "zod";

import {
  type ApiV1ApplicationContext,
  type ApiV1ApplicationOperationId,
  type ApiV1ApplicationOperationMap,
  type ApiV1ApplicationOutcome,
  type ApiV1ApplicationService,
} from "@/lib/api-v1/application/registry";
import {
  type FunnelResourceSchema,
  type GoalResourceSchema,
  type PrivacySettingsSchema,
  type SharingSettingsSchema,
  type SiteResourceSchema,
  type TrackingScriptSchema,
  type TrackingSettingsSchema,
} from "@/lib/api-v1/contract/resources";
import {
  and,
  compileD1Mutation,
  compileD1Query,
  createD1DatabaseClient,
  eq,
  filter,
  gt,
  inList,
  insert,
  isNull,
  limit,
  lt,
  or,
  param,
  project,
  scan,
  schema,
  sort,
  unixepoch,
  update,
} from "@/lib/db";
import {
  createSiteWithDefaultSettings,
  deleteSiteData,
  ensurePublicSlugAvailable,
} from "@/lib/edge/admin/sites/handler";
import {
  decodeFunnelConfig,
  encodeFunnelConfig,
  type FunnelConfigV2,
  FunnelConfigValidationError,
  funnelSemanticFingerprint,
} from "@/lib/edge/analytics/contract";
import {
  decodeGoalConfig,
  encodeGoalConfig,
  type GoalConfigV1,
  GoalConfigValidationError,
  goalSemanticFingerprint,
} from "@/lib/edge/analytics/contract/goal-config";
import {
  readSiteScriptSettings,
  upsertSiteScriptSettings,
} from "@/lib/edge/sites/settings-store";
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
type GoalResource = z.infer<typeof GoalResourceSchema>;
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
interface GoalRow {
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
  operation: "sites" | "funnels" | "goals",
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
    goals: `${base}/goals`,
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
function goalConfig(row: GoalRow): GoalConfigV1 {
  return decodeGoalConfig(
    Number.isSafeInteger(row.config_version) ? row.config_version! : 0,
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
      analysis: `/api/v1/sites/${row.site_id}/analytics/funnel-analysis`,
    },
  };
}
async function goalResource(row: GoalRow): Promise<GoalResource> {
  const config = goalConfig(row);
  return {
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    filterDslVersion: config.filterDslVersion,
    filterDsl: config.filterDsl,
    semanticFingerprint: await goalSemanticFingerprint(config),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    links: {
      self: `/api/v1/sites/${row.site_id}/goals/${row.id}`,
      summary: `/api/v1/sites/${row.site_id}/analytics/goals/summary`,
      timeseries: `/api/v1/sites/${row.site_id}/analytics/goals/timeseries`,
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
function database(env: Pick<Env, "DB">) {
  return createD1DatabaseClient(env.DB);
}
function requireResourceId<Row extends { readonly id: string | null }>(
  row: Row,
  resource: string,
): asserts row is Row & { readonly id: string } {
  if (typeof row.id !== "string") {
    throw new Error(`${resource}_row_missing_id`);
  }
}
async function siteById(
  env: Pick<Env, "DB">,
  context: ApiV1ApplicationContext,
  siteId: string,
): Promise<SiteRow | null> {
  if (!isAllowed(context, siteId)) return null;
  const sites = scan(schema.sites);
  const matching = filter(
    sites,
    and(
      eq(sites.columns.id, param(siteId)),
      eq(sites.columns.team_id, param(context.teamId)),
    ),
  );
  const query = compileD1Query(
    limit(
      project(matching, {
        id: matching.columns.id,
        teamId: matching.columns.team_id,
        name: matching.columns.name,
        domain: matching.columns.domain,
        publicEnabled: matching.columns.public_enabled,
        publicSlug: matching.columns.public_slug,
        createdAt: matching.columns.created_at,
        updatedAt: matching.columns.updated_at,
      }),
      1,
    ),
    { tag: "api-v1.sites.first" },
  );
  const row = await database(env).first(query);
  if (!row) return null;
  requireResourceId(row, "site");
  return row;
}
async function funnelById(
  env: Pick<Env, "DB">,
  siteId: string,
  funnelId: string,
): Promise<FunnelRow | null> {
  const definitions = scan(schema.analysis_definitions);
  const matching = filter(
    definitions,
    and(
      eq(definitions.columns.id, param(funnelId)),
      eq(definitions.columns.site_id, param(siteId)),
      eq(definitions.columns.kind, param("funnel")),
      isNull(definitions.columns.archived_at),
    ),
  );
  const query = compileD1Query(
    limit(
      project(matching, {
        id: matching.columns.id,
        site_id: matching.columns.site_id,
        name: matching.columns.name,
        config_json: matching.columns.config_json,
        config_version: matching.columns.config_version,
        created_at: matching.columns.created_at,
        updated_at: matching.columns.updated_at,
      }),
      1,
    ),
    { tag: "api-v1.analysis_definitions.first" },
  );
  const row = await database(env).first(query);
  if (!row) return null;
  requireResourceId(row, "funnel");
  return row;
}
async function goalById(
  env: Pick<Env, "DB">,
  siteId: string,
  goalId: string,
): Promise<GoalRow | null> {
  const definitions = scan(schema.analysis_definitions);
  const matching = filter(
    definitions,
    and(
      eq(definitions.columns.id, param(goalId)),
      eq(definitions.columns.site_id, param(siteId)),
      eq(definitions.columns.kind, param("goal")),
      isNull(definitions.columns.archived_at),
    ),
  );
  const query = compileD1Query(
    limit(
      project(matching, {
        id: matching.columns.id,
        site_id: matching.columns.site_id,
        name: matching.columns.name,
        config_json: matching.columns.config_json,
        config_version: matching.columns.config_version,
        created_at: matching.columns.created_at,
        updated_at: matching.columns.updated_at,
      }),
      1,
    ),
    { tag: "api-v1.analysis_definitions.first" },
  );
  const row = await database(env).first(query);
  if (!row) return null;
  requireResourceId(row, "goal");
  return row;
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
  options: {
    readonly validateFunnelConfigForStorage?: (config: FunnelConfigV2) => void;
  } = {},
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
        readonly goalId?: string;
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
        const sites = scan(schema.sites);
        let matching = filter(
          sites,
          eq(sites.columns.team_id, param(context.teamId)),
        );
        if (allowedSiteIds.length > 0) {
          matching = filter(
            matching,
            inList(matching.columns.id, allowedSiteIds),
          );
        }
        if (cursor) {
          matching = filter(
            matching,
            or(
              lt(matching.columns.created_at, param(cursor.createdAt)),
              and(
                eq(matching.columns.created_at, param(cursor.createdAt)),
                gt(matching.columns.id, param(cursor.id)),
              ),
            ),
          );
        }
        const projected = project(matching, {
          id: matching.columns.id,
          teamId: matching.columns.team_id,
          name: matching.columns.name,
          domain: matching.columns.domain,
          publicEnabled: matching.columns.public_enabled,
          publicSlug: matching.columns.public_slug,
          createdAt: matching.columns.created_at,
          updatedAt: matching.columns.updated_at,
        });
        const query = compileD1Query(
          limit(
            sort(projected, [
              { expression: projected.columns.createdAt, direction: "DESC" },
              { expression: projected.columns.id, direction: "ASC" },
            ]),
            value.page.limit + 1,
          ),
          { tag: "api-v1.sites.all" },
        );
        const rows = await database(env).all(query);
        const siteRows = rows.results.map((row) => {
          requireResourceId(row, "site");
          return row;
        });
        const page = pageResult(siteRows, value.page.limit);
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
        await database(env).run(
          compileD1Mutation(
            update(schema.sites, (columns) => ({
              set: {
                name: param(value.name ?? site.name),
                domain: param(domain),
                public_enabled: param(publicEnabled ? 1 : 0),
                public_slug: param(publicSlug),
                updated_at: unixepoch(),
              },
              where: and(
                eq(columns.id, param(site.id)),
                eq(columns.team_id, param(context.teamId)),
              ),
            })),
            { tag: "api_v1.sites.update" },
          ),
        );
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
        await database(env).run(
          compileD1Mutation(
            update(schema.sites, (columns) => ({
              set: {
                public_enabled: param(sharing.publicEnabled ? 1 : 0),
                public_slug: param(sharing.publicSlug),
                updated_at: unixepoch(),
              },
              where: and(
                eq(columns.id, param(site.id)),
                eq(columns.team_id, param(context.teamId)),
              ),
            })),
            { tag: "api_v1.sites.update_sharing" },
          ),
        );
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
        const definitions = scan(schema.analysis_definitions);
        let matching = filter(
          definitions,
          and(
            eq(definitions.columns.site_id, param(site.id)),
            eq(definitions.columns.kind, param("funnel")),
            isNull(definitions.columns.archived_at),
          ),
        );
        if (cursor) {
          matching = filter(
            matching,
            or(
              lt(matching.columns.created_at, param(cursor.createdAt)),
              and(
                eq(matching.columns.created_at, param(cursor.createdAt)),
                gt(matching.columns.id, param(cursor.id)),
              ),
            ),
          );
        }
        const projected = project(matching, {
          id: matching.columns.id,
          site_id: matching.columns.site_id,
          name: matching.columns.name,
          config_json: matching.columns.config_json,
          config_version: matching.columns.config_version,
          created_at: matching.columns.created_at,
          updated_at: matching.columns.updated_at,
        });
        const query = compileD1Query(
          limit(
            sort(projected, [
              { expression: projected.columns.created_at, direction: "DESC" },
              { expression: projected.columns.id, direction: "ASC" },
            ]),
            value.page.limit + 1,
          ),
          { tag: "api-v1.analysis_definitions.all" },
        );
        const rows = await database(env).all(query);
        const funnelRows = rows.results.map((row) => {
          requireResourceId(row, "funnel");
          return row;
        });
        const page = pageResult(funnelRows, value.page.limit);
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
          options.validateFunnelConfigForStorage?.(config);
          encoded = encodeFunnelConfig(config);
        } catch (error) {
          if (error instanceof FunnelConfigValidationError) {
            return failed("invalid_input") as never;
          }
          throw error;
        }
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1_000);
        await database(env).run(
          compileD1Mutation(
            insert(schema.analysis_definitions, {
              id: param(id),
              site_id: param(site.id),
              kind: param("funnel"),
              name: param(value.name),
              config_json: param(encoded.configJson),
              config_version: param(encoded.configVersion),
              created_at: param(now),
              updated_at: param(now),
            }),
            { tag: "api_v1.funnels.insert" },
          ),
        );
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
      if (operation === "goals.list") {
        const value =
          input as ApiV1ApplicationOperationMap["goals.list"]["input"];
        const site = await siteById(env, context, value.siteId);
        if (!site) return failed("not_found") as never;
        const binding = await resourcePaginationBinding(
          context,
          "goals",
          site.id,
        );
        let cursor: ResourcePageKey | null;
        try {
          cursor = await decodePageCursor(
            env,
            binding,
            value.page.cursor,
            "api-v1-goals",
            decodeResourcePageKey,
          );
        } catch (error) {
          if (error instanceof InvalidCursorError)
            return failed("invalid_cursor") as never;
          throw error;
        }
        const definitions = scan(schema.analysis_definitions);
        let matching = filter(
          definitions,
          and(
            eq(definitions.columns.site_id, param(site.id)),
            eq(definitions.columns.kind, param("goal")),
            isNull(definitions.columns.archived_at),
          ),
        );
        if (cursor) {
          matching = filter(
            matching,
            or(
              lt(matching.columns.created_at, param(cursor.createdAt)),
              and(
                eq(matching.columns.created_at, param(cursor.createdAt)),
                lt(matching.columns.id, param(cursor.id)),
              ),
            ),
          );
        }
        const projected = project(matching, {
          id: matching.columns.id,
          site_id: matching.columns.site_id,
          name: matching.columns.name,
          config_json: matching.columns.config_json,
          config_version: matching.columns.config_version,
          created_at: matching.columns.created_at,
          updated_at: matching.columns.updated_at,
        });
        const query = compileD1Query(
          limit(
            sort(projected, [
              { expression: projected.columns.created_at, direction: "DESC" },
              { expression: projected.columns.id, direction: "DESC" },
            ]),
            value.page.limit + 1,
          ),
          { tag: "api-v1.analysis_definitions.all" },
        );
        const rows = await database(env).all(query);
        const goalRows = rows.results.map((row) => {
          requireResourceId(row, "goal");
          return row;
        });
        const page = pageResult(goalRows, value.page.limit);
        const nextCursor =
          page.hasMore && page.last
            ? await encodePageCursor(env, binding, {
                createdAt: page.last.created_at,
                id: page.last.id,
              })
            : null;
        return ok(
          pageResponse(
            await Promise.all(page.rows.map(goalResource)),
            value.page.limit,
            nextCursor,
          ),
        ) as never;
      }
      if (operation === "goals.create") {
        const value =
          input as ApiV1ApplicationOperationMap["goals.create"]["input"];
        const site = await siteById(env, context, value.siteId);
        if (!site) return failed("not_found") as never;
        let encoded;
        try {
          encoded = encodeGoalConfig({
            filterDslVersion: value.filterDslVersion,
            filterDsl: value.filterDsl,
          });
        } catch (error) {
          if (error instanceof GoalConfigValidationError)
            return failed("invalid_input") as never;
          throw error;
        }
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1_000);
        await database(env).run(
          compileD1Mutation(
            insert(schema.analysis_definitions, {
              id: param(id),
              site_id: param(site.id),
              kind: param("goal"),
              name: param(value.name.trim()),
              config_json: param(encoded.configJson),
              config_version: param(encoded.configVersion),
              created_at: param(now),
              updated_at: param(now),
            }),
            { tag: "api_v1.goals.insert" },
          ),
        );
        return ok(
          await goalResource({
            id,
            site_id: site.id,
            name: value.name.trim(),
            config_json: encoded.configJson,
            config_version: encoded.configVersion,
            created_at: now,
            updated_at: now,
          }),
        ) as never;
      }
      if (
        operation === "goals.get" ||
        operation === "goals.update" ||
        operation === "goals.delete"
      ) {
        if (!request.goalId) return failed("not_found") as never;
        const goal = await goalById(env, site.id, request.goalId);
        if (!goal) return failed("not_found") as never;
        if (operation === "goals.get") {
          return ok(await goalResource(goal)) as never;
        }
        if (operation === "goals.delete") {
          const now = Math.floor(Date.now() / 1_000);
          await database(env).run(
            compileD1Mutation(
              update(schema.analysis_definitions, (columns) => ({
                set: {
                  archived_at: param(now),
                  updated_at: param(now),
                },
                where: and(
                  eq(columns.id, param(goal.id)),
                  eq(columns.site_id, param(site.id)),
                  eq(columns.kind, param("goal")),
                  isNull(columns.archived_at),
                ),
              })),
              { tag: "api_v1.goals.archive" },
            ),
          );
          return ok(undefined) as never;
        }
        const value =
          input as ApiV1ApplicationOperationMap["goals.update"]["input"];
        const current = goalConfig(goal);
        let encoded;
        try {
          encoded = encodeGoalConfig({
            filterDslVersion:
              value.filterDslVersion ?? current.filterDslVersion,
            filterDsl: value.filterDsl ?? current.filterDsl,
          });
        } catch (error) {
          if (error instanceof GoalConfigValidationError)
            return failed("invalid_input") as never;
          throw error;
        }
        const now = Math.floor(Date.now() / 1_000);
        const name = value.name?.trim() || goal.name;
        await database(env).run(
          compileD1Mutation(
            update(schema.analysis_definitions, (columns) => ({
              set: {
                name: param(name),
                config_json: param(encoded.configJson),
                config_version: param(encoded.configVersion),
                updated_at: param(now),
              },
              where: and(
                eq(columns.id, param(goal.id)),
                eq(columns.site_id, param(site.id)),
                eq(columns.kind, param("goal")),
                isNull(columns.archived_at),
              ),
            })),
            { tag: "api_v1.goals.update" },
          ),
        );
        return ok(
          await goalResource({
            ...goal,
            name,
            config_json: encoded.configJson,
            config_version: encoded.configVersion,
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
        await database(env).run(
          compileD1Mutation(
            update(schema.analysis_definitions, (columns) => ({
              set: {
                archived_at: param(now),
                updated_at: param(now),
              },
              where: and(
                eq(columns.id, param(funnel.id)),
                eq(columns.site_id, param(site.id)),
                eq(columns.kind, param("funnel")),
                isNull(columns.archived_at),
              ),
            })),
            { tag: "api_v1.funnels.archive" },
          ),
        );
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
        options.validateFunnelConfigForStorage?.(config);
        encoded = encodeFunnelConfig(config);
      } catch (error) {
        if (error instanceof FunnelConfigValidationError) {
          return failed("invalid_input") as never;
        }
        throw error;
      }
      const now = Math.floor(Date.now() / 1_000);
      const name = value.name ?? funnel.name;
      await database(env).run(
        compileD1Mutation(
          update(schema.analysis_definitions, (columns) => ({
            set: {
              name: param(name),
              config_json: param(encoded.configJson),
              config_version: param(encoded.configVersion),
              updated_at: param(now),
            },
            where: and(
              eq(columns.id, param(funnel.id)),
              eq(columns.site_id, param(site.id)),
              eq(columns.kind, param("funnel")),
              isNull(columns.archived_at),
            ),
          })),
          { tag: "api_v1.funnels.update" },
        ),
      );
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
