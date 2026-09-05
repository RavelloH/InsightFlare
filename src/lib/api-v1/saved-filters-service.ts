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
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  InvalidCursorError,
  paginationBinding,
} from "@/lib/pagination";
import type { SavedFilterScopePreference } from "@/lib/saved-filters";

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
  readonly updatedAt: number;
  readonly id: string;
}

function savedFiltersBinding(siteId: string, teamId: string): Promise<string> {
  return paginationBinding([
    "api-v1-saved-filters-v1",
    "api-v1",
    siteId,
    teamId,
    "updatedAt:desc,id:desc",
  ]);
}

function decodeSavedFilterCursor(value: unknown): SavedFilterCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, ["updatedAt", "id"]) &&
    typeof candidate.id === "string" &&
    Number.isSafeInteger(candidate.updatedAt)
    ? { id: candidate.id, updatedAt: candidate.updatedAt as number }
    : null;
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
  _cursorSecret: string,
): ApiV1ApplicationService {
  const cursorSource = { MAIN_SECRET: _cursorSecret };
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
          pagination: {
            limit: input.page.limit,
            nextCursor: null,
            hasMore: false,
            returned: 0,
          },
        },
      };
    }
    let cursor: SavedFilterCursor | null = null;
    try {
      cursor = await decodePageCursor(
        cursorSource,
        await savedFiltersBinding(input.siteId, context.teamId),
        input.page.cursor,
        "saved-filters",
        decodeSavedFilterCursor,
      );
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        return { ok: false, error: { code: "invalid_cursor" } };
      }
      throw error;
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
            input.page.limit + 1,
          ]
        : [input.siteId, context.teamId, input.page.limit + 1];
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
      const hasMore = rows.results.length > input.page.limit;
      const visibleRows = hasMore
        ? rows.results.slice(0, input.page.limit)
        : rows.results;
      const items = visibleRows.map(toDefinition);
      const last = visibleRows.at(-1);
      return {
        ok: true,
        value: {
          items,
          pagination: {
            limit: input.page.limit,
            hasMore,
            returned: items.length,
            nextCursor:
              hasMore && last
                ? await encodePageCursor(
                    cursorSource,
                    await savedFiltersBinding(input.siteId, context.teamId),
                    { updatedAt: last.updatedAt, id: last.id },
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
