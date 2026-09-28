import {
  AnalysisDefinitionIntegrityError,
  parseSavedFilterDsl,
} from "@/lib/api-v1/analytics/analysis-definition-reader";
import {
  type ApiV1ApplicationContext,
  type ApiV1ApplicationOutcome,
  type ApiV1ApplicationService,
} from "@/lib/api-v1/application/registry";
import {
  type GetTeamVisibleSavedFilterInput,
  type ListTeamVisibleSavedFiltersInput,
  type SavedFilterDefinition,
  type SavedFilterPage,
} from "@/lib/api-v1/contract/resources";
import {
  and,
  compileD1Query,
  createD1DatabaseClient,
  eq,
  filter,
  join,
  limit,
  lt,
  or,
  param,
  project,
  scan,
  schema,
  sort,
} from "@/lib/db";
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
interface SavedFilterQueryRow extends Omit<
  SavedFilterRow,
  "id" | "scopePreference"
> {
  readonly id: string | null;
  readonly scopePreference: string | null;
}
interface SavedFilterCursor {
  readonly updatedAt: number;
  readonly id: string;
}
function isSavedFilterScopePreference(
  value: string,
): value is SavedFilterScopePreference {
  return (
    value === "auto" ||
    value === "event" ||
    value === "session" ||
    value === "visitor"
  );
}
function savedFilterRow(row: SavedFilterQueryRow): SavedFilterRow {
  if (
    typeof row.id !== "string" ||
    (row.scopePreference !== null &&
      !isSavedFilterScopePreference(row.scopePreference))
  ) {
    throw new AnalysisDefinitionIntegrityError();
  }
  return {
    ...row,
    id: row.id,
    scopePreference: row.scopePreference ?? "auto",
  };
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
      const savedFilters = scan(schema.saved_filters);
      const sites = scan(schema.sites);
      const savedFiltersWithSites = join(
        savedFilters,
        sites,
        eq(savedFilters.columns.site_id, sites.columns.id),
        "inner",
      );
      const matchingDefinitions = filter(
        savedFiltersWithSites,
        and(
          eq(savedFiltersWithSites.columns.left_site_id, param(input.siteId)),
          eq(savedFiltersWithSites.columns.left_id, param(input.id)),
          eq(savedFiltersWithSites.columns.left_visibility, param("team")),
          eq(
            savedFiltersWithSites.columns.right_team_id,
            param(context.teamId),
          ),
        ),
      );
      const selectedDefinitions = project(matchingDefinitions, {
        id: matchingDefinitions.columns.left_id,
        name: matchingDefinitions.columns.left_name,
        description: matchingDefinitions.columns.left_description,
        scopePreference: matchingDefinitions.columns.left_scope_preference,
        filterDsl: matchingDefinitions.columns.left_filter_dsl,
        filterDslVersion: matchingDefinitions.columns.left_filter_dsl_version,
        createdAt: matchingDefinitions.columns.left_created_at,
        updatedAt: matchingDefinitions.columns.left_updated_at,
      });
      const row = await createD1DatabaseClient(env.DB).first(
        compileD1Query(limit(selectedDefinitions, 1), {
          tag: "api-v1.saved_filters.first",
        }),
      );
      if (!row) return { ok: false, error: { code: "not_found" } };
      return { ok: true, value: toDefinition(savedFilterRow(row)) };
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
      const savedFilters = scan(schema.saved_filters);
      const sites = scan(schema.sites);
      const savedFiltersWithSites = join(
        savedFilters,
        sites,
        eq(savedFilters.columns.site_id, sites.columns.id),
        "inner",
      );
      const basePredicate = and(
        eq(savedFiltersWithSites.columns.left_site_id, param(input.siteId)),
        eq(savedFiltersWithSites.columns.left_visibility, param("team")),
        eq(savedFiltersWithSites.columns.right_team_id, param(context.teamId)),
      );
      const cursorPredicate = cursor
        ? or(
            lt(
              savedFiltersWithSites.columns.left_updated_at,
              param(cursor.updatedAt),
            ),
            and(
              eq(
                savedFiltersWithSites.columns.left_updated_at,
                param(cursor.updatedAt),
              ),
              lt(savedFiltersWithSites.columns.left_id, param(cursor.id)),
            ),
          )
        : null;
      const matchingDefinitions = filter(
        savedFiltersWithSites,
        cursorPredicate ? and(basePredicate, cursorPredicate) : basePredicate,
      );
      const selectedDefinitions = project(matchingDefinitions, {
        id: matchingDefinitions.columns.left_id,
        name: matchingDefinitions.columns.left_name,
        description: matchingDefinitions.columns.left_description,
        scopePreference: matchingDefinitions.columns.left_scope_preference,
        filterDsl: matchingDefinitions.columns.left_filter_dsl,
        filterDslVersion: matchingDefinitions.columns.left_filter_dsl_version,
        createdAt: matchingDefinitions.columns.left_created_at,
        updatedAt: matchingDefinitions.columns.left_updated_at,
      });
      const orderedDefinitions = sort(selectedDefinitions, [
        {
          expression: selectedDefinitions.columns.updatedAt,
          direction: "DESC",
        },
        {
          expression: selectedDefinitions.columns.id,
          direction: "DESC",
        },
      ]);
      const rows = await createD1DatabaseClient(env.DB).all(
        compileD1Query(limit(orderedDefinitions, input.page.limit + 1), {
          tag: "api-v1.saved_filters.all",
        }),
      );
      const hasMore = rows.results.length > input.page.limit;
      const visibleRows = hasMore
        ? rows.results.slice(0, input.page.limit)
        : rows.results;
      const savedFilterRows = visibleRows.map(savedFilterRow);
      const items = savedFilterRows.map(toDefinition);
      const last = savedFilterRows.at(-1);
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
