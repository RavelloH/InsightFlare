import {
  and,
  compileD1Query,
  createD1DatabaseClient,
  eq,
  filter,
  join,
  limit,
  param,
  project,
  scan,
} from "@/lib/db";
import { schema } from "@/lib/db/schema";
import type { Env } from "@/lib/edge/types";
import type { WidgetConfig, WidgetRecord } from "@/lib/widgets/contract";
import { widgetRecordSchema, widgetUuidSchema } from "@/lib/widgets/contract";

const WIDGET_KEY_PREFIX = "widget:";
const TEAM_INDEX_PREFIX = "widget:team:";
const LIST_PAGE_SIZE = 100;

export class WidgetStorageUnavailableError extends Error {
  constructor() {
    super("widget_storage_unavailable");
    this.name = "WidgetStorageUnavailableError";
  }
}

export class WidgetConflictError extends Error {
  constructor() {
    super("widget_conflict");
    this.name = "WidgetConflictError";
  }
}

function nextPublicRevision(previous: number): number {
  const entropy = new Uint16Array(1);
  crypto.getRandomValues(entropy);
  const timestampRevision = Date.now() * 1000 + (entropy[0] % 1000);
  return Math.max(previous + 1, timestampRevision);
}

function widgetKv(env: Env): KVNamespace {
  if (!env.SITE_SETTINGS_KV) throw new WidgetStorageUnavailableError();
  return env.SITE_SETTINGS_KV;
}

function widgetKey(uuid: string): string {
  return `${WIDGET_KEY_PREFIX}${uuid}`;
}

function teamIndexKey(teamId: string, uuid: string): string {
  return `${TEAM_INDEX_PREFIX}${teamId}:${uuid}`;
}

async function publicWidgetUuid(
  teamId: string,
  siteId: string,
  retryToken: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([teamId, siteId, retryToken])),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseWidgetRecord(value: string | null): WidgetRecord | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = widgetRecordSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function readWidget(
  env: Env,
  uuid: string,
): Promise<WidgetRecord | null> {
  const parsedUuid = widgetUuidSchema.safeParse(uuid);
  if (!parsedUuid.success) return null;
  return parseWidgetRecord(await widgetKv(env).get(widgetKey(parsedUuid.data)));
}

export async function widgetSiteBelongsToTeam(
  env: Env,
  teamId: string,
  siteId: string,
): Promise<boolean> {
  const sites = scan(schema.sites);
  const teams = scan(schema.teams);
  const siteTeams = join(
    sites,
    teams,
    eq(sites.columns.team_id, teams.columns.id),
    "inner",
  );
  const matching = filter(
    siteTeams,
    and(
      eq(siteTeams.columns.left_id, param(siteId)),
      eq(siteTeams.columns.right_id, param(teamId)),
    ),
  );
  const selected = limit(
    project(matching, { siteId: matching.columns.left_id }),
    1,
  );
  const row = await createD1DatabaseClient(env.DB).first(
    compileD1Query(selected, { tag: "widgets.site.belongs_to_team" }),
  );
  return row?.siteId === siteId;
}

export async function listTeamWidgets(
  env: Env,
  teamId: string,
  cursor?: string | null,
): Promise<{ data: WidgetRecord[]; nextCursor: string | null }> {
  const kv = widgetKv(env);
  const listed = await kv.list({
    prefix: `${TEAM_INDEX_PREFIX}${teamId}:`,
    cursor: cursor || undefined,
    limit: LIST_PAGE_SIZE,
  });
  const records = await Promise.all(
    listed.keys.map(async ({ name }) => {
      const uuid = name.slice(`${TEAM_INDEX_PREFIX}${teamId}:`.length);
      if (!widgetUuidSchema.safeParse(uuid).success) return null;
      const record = await readWidget(env, uuid);
      if (!record || record.teamId !== teamId) return null;
      return record;
    }),
  );
  return {
    data: records.filter((record): record is WidgetRecord => record !== null),
    nextCursor: listed.list_complete ? null : listed.cursor,
  };
}

export async function createWidget(
  env: Env,
  input: {
    uuid: string;
    teamId: string;
    siteId: string;
    config: WidgetConfig;
    publish?: boolean;
  },
): Promise<WidgetRecord> {
  const retryToken = widgetUuidSchema.parse(input.uuid);
  const uuid = await publicWidgetUuid(input.teamId, input.siteId, retryToken);
  const existing = await readWidget(env, uuid);
  if (existing) {
    if (existing.teamId === input.teamId && existing.siteId === input.siteId) {
      return existing;
    }
    throw new WidgetConflictError();
  }

  const now = Date.now();
  const record = widgetRecordSchema.parse({
    schemaVersion: 1,
    uuid,
    teamId: input.teamId,
    siteId: input.siteId,
    draft: input.config,
    published: input.publish ? input.config : null,
    status: input.publish ? "published" : "draft",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  const kv = widgetKv(env);
  await kv.put(teamIndexKey(record.teamId, uuid), uuid);
  // Keep the index retryable. Listing tolerates an index without a record.
  await kv.put(widgetKey(uuid), JSON.stringify(record));
  return record;
}

export async function updateWidgetDraft(
  env: Env,
  teamId: string,
  uuid: string,
  config: WidgetConfig,
): Promise<WidgetRecord | null> {
  const current = await readWidget(env, uuid);
  if (!current || current.teamId !== teamId) return null;
  const record = widgetRecordSchema.parse({
    ...current,
    draft: config,
    updatedAt: Date.now(),
  });
  await widgetKv(env).put(widgetKey(uuid), JSON.stringify(record));
  return record;
}

export async function publishWidget(
  env: Env,
  teamId: string,
  uuid: string,
  config?: WidgetConfig,
): Promise<WidgetRecord | null> {
  const current = await readWidget(env, uuid);
  if (!current || current.teamId !== teamId) return null;
  const record = widgetRecordSchema.parse({
    ...current,
    draft: config ?? current.draft,
    published: config ?? current.draft,
    status: "published",
    revision: nextPublicRevision(current.revision),
    updatedAt: Date.now(),
  });
  await widgetKv(env).put(widgetKey(uuid), JSON.stringify(record));
  return record;
}

export async function unpublishWidget(
  env: Env,
  teamId: string,
  uuid: string,
): Promise<WidgetRecord | null> {
  const current = await readWidget(env, uuid);
  if (!current || current.teamId !== teamId) return null;
  if (current.status !== "published") return current;
  const record = widgetRecordSchema.parse({
    ...current,
    status: "unpublished",
    revision: nextPublicRevision(current.revision),
    updatedAt: Date.now(),
  });
  await widgetKv(env).put(widgetKey(uuid), JSON.stringify(record));
  return record;
}

export async function deleteWidget(
  env: Env,
  teamId: string,
  uuid: string,
): Promise<boolean> {
  const parsedUuid = widgetUuidSchema.safeParse(uuid);
  if (!parsedUuid.success) return false;
  const current = await readWidget(env, parsedUuid.data);
  const kv = widgetKv(env);
  if (!current) {
    await kv.delete(teamIndexKey(teamId, parsedUuid.data));
    return false;
  }
  if (current.teamId !== teamId) throw new WidgetConflictError();
  await kv.delete(widgetKey(parsedUuid.data));
  await kv.delete(teamIndexKey(teamId, parsedUuid.data));
  return true;
}
