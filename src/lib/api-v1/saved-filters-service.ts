import {
  AnalysisDefinitionIntegrityError,
  parseSavedFilterDsl,
} from "@/lib/api-v1/analysis-definition-reader";
import {
  type ApiV1ApplicationContext,
  type ApiV1ApplicationOutcome,
  type ApiV1ApplicationService,
  type GetTeamVisibleSavedFilterInput,
  type ListTeamVisibleSavedFiltersInput,
  type SavedFilterDefinition,
  type SavedFilterPage,
} from "@/lib/api-v1/application-registry";
import type { Env } from "@/lib/edge/types";
import type { SavedFilterScopePreference } from "@/lib/saved-filters";

const MAX_CURSOR_BYTES = 12_288;

interface SavedFilterRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly scopePreference: SavedFilterScopePreference;
  readonly filterDsl: string;
  readonly filterDslVersion: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface SavedFilterCursor {
  readonly version: 1;
  readonly siteId: string;
  readonly teamId: string;
  readonly updatedAt: number;
  readonly id: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

async function encodeCursor(
  cursor: SavedFilterCursor,
  secret: string,
): Promise<string> {
  const payload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(cursor)),
  );
  const signature = bytesToBase64Url(await hmac(secret, payload));
  return `${payload}.${signature}`;
}

async function decodeCursor(
  raw: string,
  secret: string,
): Promise<SavedFilterCursor | null> {
  if (new TextEncoder().encode(raw).byteLength > MAX_CURSOR_BYTES) return null;
  const [payload, signature, extra] = raw.split(".");
  if (!payload || !signature || extra) return null;
  const expected = await hmac(secret, payload);
  const actual = base64UrlToBytes(signature);
  const encoded = base64UrlToBytes(payload);
  if (!actual || !encoded || !equalBytes(expected, actual)) return null;
  try {
    const value = JSON.parse(
      new TextDecoder().decode(encoded),
    ) as Partial<SavedFilterCursor>;
    if (
      value.version !== 1 ||
      typeof value.siteId !== "string" ||
      typeof value.teamId !== "string" ||
      typeof value.id !== "string" ||
      !Number.isSafeInteger(value.updatedAt)
    ) {
      return null;
    }
    return value as SavedFilterCursor;
  } catch {
    return null;
  }
}

function isSiteAllowed(
  context: ApiV1ApplicationContext,
  siteId: string,
): boolean {
  return context.siteIds.length === 0 || context.siteIds.includes(siteId);
}

function abortOrDeadline(execution: {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}): boolean {
  return (
    Boolean(execution.signal?.aborted) ||
    (typeof execution.deadlineMs === "number" &&
      Date.now() >= execution.deadlineMs)
  );
}

function toDefinition(row: SavedFilterRow): SavedFilterDefinition {
  const filter = parseSavedFilterDsl(row);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: "team",
    scopePreference: row.scopePreference ?? "auto",
    filter,
    createdAt: new Date(row.createdAt * 1000).toISOString(),
    updatedAt: new Date(row.updatedAt * 1000).toISOString(),
  };
}

export function createSavedFilterApplicationService(
  env: Pick<Env, "DB">,
  cursorSecret: string,
): ApiV1ApplicationService {
  const get = async (
    context: ApiV1ApplicationContext,
    input: GetTeamVisibleSavedFilterInput,
    execution: { readonly signal?: AbortSignal; readonly deadlineMs?: number },
  ): Promise<
    ApiV1ApplicationOutcome<
      SavedFilterDefinition,
      "not_found" | "internal_error"
    >
  > => {
    if (abortOrDeadline(execution)) {
      return { ok: false, error: { code: "internal_error" } };
    }
    if (!isSiteAllowed(context, input.siteId)) {
      return { ok: false, error: { code: "not_found" } };
    }
    try {
      const row = await env.DB.prepare(
        `SELECT sf.id, sf.name, sf.description,
                sf.scope_preference AS scopePreference,
                sf.filter_dsl AS filterDsl, sf.filter_dsl_version AS filterDslVersion,
                sf.created_at AS createdAt, sf.updated_at AS updatedAt
         FROM saved_filters sf
         INNER JOIN sites s ON s.id = sf.site_id
         WHERE sf.site_id = ? AND sf.id = ?
           AND sf.visibility = 'team' AND s.team_id = ?
         LIMIT 1`,
      )
        .bind(input.siteId, input.id, context.teamId)
        .first<SavedFilterRow>();
      if (!row) return { ok: false, error: { code: "not_found" } };
      return { ok: true, value: toDefinition(row) };
    } catch (error) {
      if (error instanceof AnalysisDefinitionIntegrityError) {
        return { ok: false, error: { code: "internal_error" } };
      }
      return { ok: false, error: { code: "internal_error" } };
    }
  };

  const list = async (
    context: ApiV1ApplicationContext,
    input: ListTeamVisibleSavedFiltersInput,
    execution: { readonly signal?: AbortSignal; readonly deadlineMs?: number },
  ): Promise<
    ApiV1ApplicationOutcome<
      SavedFilterPage,
      "internal_error" | "invalid_cursor"
    >
  > => {
    if (abortOrDeadline(execution)) {
      return { ok: false, error: { code: "internal_error" } };
    }
    if (!isSiteAllowed(context, input.siteId)) {
      return {
        ok: true,
        value: {
          items: [],
          page: {
            kind: "keyset",
            limit: input.limit,
            nextCursor: null,
            hasMore: false,
          },
        },
      };
    }
    let cursor: SavedFilterCursor | null = null;
    if (input.cursor) {
      cursor = await decodeCursor(input.cursor, cursorSecret);
      if (
        !cursor ||
        cursor.siteId !== input.siteId ||
        cursor.teamId !== context.teamId
      ) {
        return { ok: false, error: { code: "invalid_cursor" } };
      }
    }
    try {
      const cursorClause = cursor
        ? "AND (sf.updated_at < ? OR (sf.updated_at = ? AND sf.id < ?))"
        : "";
      const bindings: Array<string | number> = cursor
        ? [
            input.siteId,
            context.teamId,
            cursor.updatedAt,
            cursor.updatedAt,
            cursor.id,
            input.limit + 1,
          ]
        : [input.siteId, context.teamId, input.limit + 1];
      const rows = await env.DB.prepare(
        `SELECT sf.id, sf.name, sf.description,
                sf.scope_preference AS scopePreference,
                sf.filter_dsl AS filterDsl, sf.filter_dsl_version AS filterDslVersion,
                sf.created_at AS createdAt, sf.updated_at AS updatedAt
         FROM saved_filters sf
         INNER JOIN sites s ON s.id = sf.site_id
         WHERE sf.site_id = ? AND sf.visibility = 'team' AND s.team_id = ?
           ${cursorClause}
         ORDER BY sf.updated_at DESC, sf.id DESC
         LIMIT ?`,
      )
        .bind(...bindings)
        .all<SavedFilterRow>();
      const hasMore = rows.results.length > input.limit;
      const visibleRows = hasMore
        ? rows.results.slice(0, input.limit)
        : rows.results;
      const items = visibleRows.map(toDefinition);
      const last = visibleRows.at(-1);
      return {
        ok: true,
        value: {
          items,
          page: {
            kind: "keyset",
            limit: input.limit,
            hasMore,
            nextCursor:
              hasMore && last
                ? await encodeCursor(
                    {
                      version: 1,
                      siteId: input.siteId,
                      teamId: context.teamId,
                      updatedAt: last.updatedAt,
                      id: last.id,
                    },
                    cursorSecret,
                  )
                : null,
          },
        },
      };
    } catch (error) {
      if (error instanceof AnalysisDefinitionIntegrityError) {
        return { ok: false, error: { code: "internal_error" } };
      }
      return { ok: false, error: { code: "internal_error" } };
    }
  };

  async function execute(
    context: ApiV1ApplicationContext,
    operation: "savedFilters.list",
    input: ListTeamVisibleSavedFiltersInput,
    execution: { readonly signal?: AbortSignal; readonly deadlineMs?: number },
  ): Promise<Awaited<ReturnType<typeof list>>>;
  async function execute(
    context: ApiV1ApplicationContext,
    operation: "savedFilters.get",
    input: GetTeamVisibleSavedFilterInput,
    execution: { readonly signal?: AbortSignal; readonly deadlineMs?: number },
  ): Promise<Awaited<ReturnType<typeof get>>>;
  async function execute(
    context: ApiV1ApplicationContext,
    operation: "savedFilters.list" | "savedFilters.get",
    input: ListTeamVisibleSavedFiltersInput | GetTeamVisibleSavedFilterInput,
    execution: { readonly signal?: AbortSignal; readonly deadlineMs?: number },
  ): Promise<
    Awaited<ReturnType<typeof list>> | Awaited<ReturnType<typeof get>>
  > {
    if (operation === "savedFilters.get") {
      return get(context, input as GetTeamVisibleSavedFilterInput, execution);
    }
    return list(context, input as ListTeamVisibleSavedFiltersInput, execution);
  }

  return { execute };
}
