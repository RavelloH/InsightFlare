import {
  and,
  compileD1Mutation,
  compileD1Query,
  createD1DatabaseClient,
  deleteFrom,
  eq,
  filter,
  insert,
  join,
  limit as queryLimit,
  lt,
  neq,
  or,
  param,
  project,
  scan,
  schema,
  sort,
  unixepoch,
  update,
} from "@/lib/db";
import { parseJson } from "@/lib/edge/admin/response";
import type { EdgeSessionClaims } from "@/lib/edge/auth/session-auth";
import type { Env } from "@/lib/edge/types";
import {
  analyticsFilterRegistry,
  assertFilterAudience,
  FILTER_DSL_MAX_LENGTH,
  parseFilterDsl,
} from "@/lib/filter-contract";
import {
  decodePageCursor,
  encodePageCursor,
  InvalidCursorError,
  paginationBinding,
} from "@/lib/pagination";
import { bad, forb, jsonResponseFor, na, nf } from "@/lib/response";
import {
  SAVED_FILTER_DSL_VERSION,
  SAVED_FILTER_SCOPE_PREFERENCES,
  SAVED_FILTER_VISIBILITIES,
  type SavedFilter,
  type SavedFilterScopePreference,
  type SavedFilterVisibility,
} from "@/lib/saved-filters";
const MAX_FILTER_ID_LENGTH = 120;
const MAX_FILTER_NAME_LENGTH = 120;
const MAX_FILTER_DESCRIPTION_LENGTH = 2_000;
interface SavedFilterRow {
  id: string;
  siteId: string;
  ownerUserId: string;
  authorName: string;
  visibility: SavedFilterVisibility;
  scopePreference?: SavedFilterScopePreference | null;
  name: string;
  description: string;
  filterDsl: string;
  filterDslVersion: number;
  createdAt: number;
  updatedAt: number;
}
function savedFilterReadRelation() {
  const savedFilters = scan(schema.saved_filters);
  const users = scan(schema.users);
  return join(
    savedFilters,
    users,
    eq(savedFilters.columns.owner_user_id, users.columns.id),
  );
}
function savedFilterProjection(
  relation: ReturnType<typeof savedFilterReadRelation>,
) {
  return project(relation, {
    id: relation.columns.left_id,
    siteId: relation.columns.left_site_id,
    ownerUserId: relation.columns.left_owner_user_id,
    authorDisplayName: relation.columns.right_name,
    authorUsername: relation.columns.right_username,
    visibility: relation.columns.left_visibility,
    scopePreference: relation.columns.left_scope_preference,
    name: relation.columns.left_name,
    description: relation.columns.left_description,
    filterDsl: relation.columns.left_filter_dsl,
    filterDslVersion: relation.columns.left_filter_dsl_version,
    createdAt: relation.columns.left_created_at,
    updatedAt: relation.columns.left_updated_at,
  });
}
type SavedFilterQueryRow = NonNullable<
  ReturnType<typeof savedFilterProjection>["__row"]
>;
function savedFilterRow(row: SavedFilterQueryRow): SavedFilterRow {
  if (typeof row.id !== "string") {
    throw new Error("saved filter row has no id");
  }
  if (
    !SAVED_FILTER_VISIBILITIES.includes(row.visibility as SavedFilterVisibility)
  ) {
    throw new Error("saved filter row has invalid visibility");
  }
  const scopePreference = row.scopePreference ?? "auto";
  if (
    !SAVED_FILTER_SCOPE_PREFERENCES.includes(
      scopePreference as SavedFilterScopePreference,
    )
  ) {
    throw new Error("saved filter row has invalid scope preference");
  }
  return {
    id: row.id,
    siteId: row.siteId,
    ownerUserId: row.ownerUserId,
    authorName:
      typeof row.authorDisplayName === "string" && row.authorDisplayName !== ""
        ? row.authorDisplayName
        : typeof row.authorUsername === "string" && row.authorUsername !== ""
          ? row.authorUsername
          : "Unknown",
    visibility: row.visibility as SavedFilterVisibility,
    scopePreference: scopePreference as SavedFilterScopePreference,
    name: row.name,
    description: row.description,
    filterDsl: row.filterDsl,
    filterDslVersion: row.filterDslVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
interface SavedFilterInput {
  readonly name: string;
  readonly description: string;
  readonly visibility: SavedFilterVisibility;
  readonly scopePreference: SavedFilterScopePreference;
  readonly filterDsl: string;
}
interface SavedFilterCursor {
  readonly updatedAt: number;
  readonly id: string;
}
function savedFilterCursor(value: unknown): SavedFilterCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" &&
    Number.isSafeInteger(candidate.updatedAt)
    ? { id: candidate.id, updatedAt: candidate.updatedAt as number }
    : null;
}
function parseListLimit(url: URL): number {
  const value = Number(url.searchParams.get("limit") ?? "100");
  return Number.isFinite(value)
    ? Math.max(1, Math.min(100, Math.trunc(value)))
    : 100;
}
function asSavedFilter(row: SavedFilterRow, actorUserId: string): SavedFilter {
  return {
    ...row,
    scopePreference: row.scopePreference ?? "auto",
    isOwner: row.ownerUserId === actorUserId,
  };
}
function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length > maxLength) return null;
  return value;
}
function filterId(value: string | undefined): string | null {
  const id = value?.trim() ?? "";
  return id.length > 0 && id.length <= MAX_FILTER_ID_LENGTH ? id : null;
}
function savedFilterInput(
  body: Record<string, unknown>,
): SavedFilterInput | Response {
  const rawName = text(body.name, MAX_FILTER_NAME_LENGTH);
  const rawDescription = text(
    body.description ?? "",
    MAX_FILTER_DESCRIPTION_LENGTH,
  );
  const rawDsl = text(body.filterDsl, FILTER_DSL_MAX_LENGTH);
  const rawVisibility = body.visibility;
  const rawScopePreference =
    body.scopePreference === undefined ? "auto" : body.scopePreference;
  if (rawName === null || !rawName.trim()) {
    return bad("name is required", "invalid_saved_filter_name");
  }
  if (rawDescription === null) {
    return bad("description is invalid", "invalid_saved_filter_description");
  }
  if (
    typeof rawVisibility !== "string" ||
    !SAVED_FILTER_VISIBILITIES.includes(rawVisibility as SavedFilterVisibility)
  ) {
    return bad("visibility is invalid", "invalid_saved_filter_visibility");
  }
  if (
    typeof rawScopePreference !== "string" ||
    !SAVED_FILTER_SCOPE_PREFERENCES.includes(
      rawScopePreference as SavedFilterScopePreference,
    )
  ) {
    return bad(
      "scopePreference is invalid",
      "invalid_saved_filter_scope_preference",
    );
  }
  if (rawDsl === null) {
    return bad("filterDsl is invalid", "invalid_saved_filter_dsl");
  }
  try {
    const document = parseFilterDsl(rawDsl, analyticsFilterRegistry);
    if (!document.root) {
      return bad("filterDsl must contain a filter", "empty_saved_filter_dsl");
    }
    assertFilterAudience(
      document,
      analyticsFilterRegistry,
      "private-dashboard",
    );
  } catch {
    return bad("filterDsl is invalid", "invalid_saved_filter_dsl");
  }
  return {
    name: rawName.trim(),
    description: rawDescription,
    visibility: rawVisibility as SavedFilterVisibility,
    scopePreference: rawScopePreference as SavedFilterScopePreference,
    filterDsl: rawDsl,
  };
}
async function savedFilterById(
  env: Env,
  siteId: string,
  id: string,
): Promise<SavedFilterRow | null> {
  const joined = savedFilterReadRelation();
  const matching = filter(
    joined,
    and(
      eq(joined.columns.left_site_id, param(siteId)),
      eq(joined.columns.left_id, param(id)),
    ),
  );
  const selected = savedFilterProjection(queryLimit(matching, 1));
  const row = await createD1DatabaseClient(env.DB).first(
    compileD1Query(selected, { tag: "analytics.saved_filters.first" }),
  );
  return row ? savedFilterRow(row) : null;
}
export async function handleSavedFilters(
  request: Request,
  env: Env,
  input: {
    readonly siteId: string;
    readonly session: EdgeSessionClaims;
    readonly filterId?: string;
  },
): Promise<Response> {
  const { siteId, session } = input;
  const id = filterId(input.filterId);

  if (request.method === "GET" && !input.filterId) {
    const url = new URL(request.url);
    const limit = parseListLimit(url);
    const binding = await paginationBinding([
      "private-saved-filters-v1",
      "private-dashboard",
      siteId,
      session.userId,
      "updatedAt:desc,id:desc",
    ]);
    let cursor: SavedFilterCursor | null = null;
    try {
      cursor = await decodePageCursor(
        env,
        binding,
        url.searchParams.get("cursor"),
        "saved-filters",
        savedFilterCursor,
      );
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        return bad("Invalid saved filter cursor", "invalid_cursor", request);
      }
      throw error;
    }
    const joined = savedFilterReadRelation();
    const visible = filter(
      joined,
      and(
        eq(joined.columns.left_site_id, param(siteId)),
        or(
          eq(joined.columns.left_owner_user_id, param(session.userId)),
          eq(joined.columns.left_visibility, param("team")),
        ),
      ),
    );
    const afterCursor = cursor
      ? filter(
          visible,
          or(
            lt(visible.columns.left_updated_at, param(cursor.updatedAt)),
            and(
              eq(visible.columns.left_updated_at, param(cursor.updatedAt)),
              lt(visible.columns.left_id, param(cursor.id)),
            ),
          ),
        )
      : visible;
    const ordered = sort(afterCursor, [
      { expression: afterCursor.columns.left_updated_at, direction: "DESC" },
      { expression: afterCursor.columns.left_id, direction: "DESC" },
    ]);
    const selected = savedFilterProjection(queryLimit(ordered, limit + 1));
    const rows = await createD1DatabaseClient(env.DB).all(
      compileD1Query(selected, { tag: "analytics.saved_filters.all" }),
    );
    const hasMore = rows.results.length > limit;
    const pageRows = hasMore ? rows.results.slice(0, limit) : rows.results;
    const items = pageRows.map((row) =>
      asSavedFilter(savedFilterRow(row), session.userId),
    );
    const last = pageRows[pageRows.length - 1];
    return jsonResponseFor(request, {
      items,
      pagination: {
        limit,
        returned: items.length,
        hasMore,
        nextCursor:
          hasMore && last
            ? await encodePageCursor(env, binding, {
                updatedAt: last.updatedAt,
                id: last.id,
              })
            : null,
      },
    });
  }

  if (request.method === "POST" && !input.filterId) {
    const parsed = savedFilterInput(await parseJson(request));
    if (parsed instanceof Response) return parsed;
    const savedFilters = scan(schema.saved_filters);
    const duplicateMatches = filter(
      savedFilters,
      and(
        eq(savedFilters.columns.site_id, param(siteId)),
        eq(savedFilters.columns.owner_user_id, param(session.userId)),
        eq(savedFilters.columns.filter_dsl, param(parsed.filterDsl)),
        eq(
          savedFilters.columns.scope_preference,
          param(parsed.scopePreference),
        ),
      ),
    );
    const duplicateLimit = queryLimit(duplicateMatches, 1);
    const duplicateQuery = project(duplicateLimit, {
      id: duplicateLimit.columns.id,
    });
    const duplicate = await createD1DatabaseClient(env.DB).first(
      compileD1Query(duplicateQuery, {
        tag: "analytics.saved_filters.first",
      }),
    );
    if (duplicate) {
      return bad(
        "An identical saved filter already exists",
        "duplicate_saved_filter_dsl",
        request,
      );
    }
    const createdId = crypto.randomUUID();
    await createD1DatabaseClient(env.DB).run(
      compileD1Mutation(
        insert(schema.saved_filters, {
          id: createdId,
          site_id: siteId,
          owner_user_id: session.userId,
          visibility: parsed.visibility,
          name: parsed.name,
          description: parsed.description,
          scope_preference: parsed.scopePreference,
          filter_dsl: parsed.filterDsl,
          filter_dsl_version: SAVED_FILTER_DSL_VERSION,
          created_at: unixepoch(),
          updated_at: unixepoch(),
        }),
        { tag: "analytics.saved_filters.insert" },
      ),
    );
    const created = await savedFilterById(env, siteId, createdId);
    if (!created) throw new Error("saved filter was not created");
    return jsonResponseFor(
      request,
      { filter: asSavedFilter(created, session.userId) },
      201,
    );
  }

  if (!id) {
    return input.filterId
      ? bad("filter id is invalid", "invalid_saved_filter_id", request)
      : na(request);
  }

  const existing = await savedFilterById(env, siteId, id);
  if (!existing) return nf("Saved filter not found", undefined, request);
  const canRead =
    existing.ownerUserId === session.userId || existing.visibility === "team";

  if (request.method === "GET") {
    if (!canRead) return nf("Saved filter not found", undefined, request);
    return jsonResponseFor(request, {
      filter: asSavedFilter(existing, session.userId),
    });
  }

  if (existing.ownerUserId !== session.userId) {
    return forb("Only the filter owner can modify it", undefined, request);
  }

  if (request.method === "PUT") {
    const parsed = savedFilterInput(await parseJson(request));
    if (parsed instanceof Response) return parsed;
    const savedFilters = scan(schema.saved_filters);
    const duplicateMatches = filter(
      savedFilters,
      and(
        eq(savedFilters.columns.site_id, param(siteId)),
        eq(savedFilters.columns.owner_user_id, param(session.userId)),
        eq(savedFilters.columns.filter_dsl, param(parsed.filterDsl)),
        eq(
          savedFilters.columns.scope_preference,
          param(parsed.scopePreference),
        ),
        neq(savedFilters.columns.id, param(id)),
      ),
    );
    const duplicateLimit = queryLimit(duplicateMatches, 1);
    const duplicateQuery = project(duplicateLimit, {
      id: duplicateLimit.columns.id,
    });
    const duplicate = await createD1DatabaseClient(env.DB).first(
      compileD1Query(duplicateQuery, {
        tag: "analytics.saved_filters.first",
      }),
    );
    if (duplicate) {
      return bad(
        "An identical saved filter already exists",
        "duplicate_saved_filter_dsl",
        request,
      );
    }
    await createD1DatabaseClient(env.DB).run(
      compileD1Mutation(
        update(schema.saved_filters, (columns) => ({
          set: {
            visibility: parsed.visibility,
            scope_preference: parsed.scopePreference,
            name: parsed.name,
            description: parsed.description,
            filter_dsl: parsed.filterDsl,
            filter_dsl_version: SAVED_FILTER_DSL_VERSION,
            updated_at: unixepoch(),
          },
          where: and(
            eq(columns.id, param(id)),
            eq(columns.site_id, param(siteId)),
            eq(columns.owner_user_id, param(session.userId)),
          ),
        })),
        { tag: "analytics.saved_filters.update" },
      ),
    );
    const updated = await savedFilterById(env, siteId, id);
    if (!updated) throw new Error("saved filter was not updated");
    return jsonResponseFor(request, {
      filter: asSavedFilter(updated, session.userId),
    });
  }

  if (request.method === "DELETE") {
    await createD1DatabaseClient(env.DB).run(
      compileD1Mutation(
        deleteFrom(schema.saved_filters, (columns) =>
          and(
            eq(columns.id, param(id)),
            eq(columns.site_id, param(siteId)),
            eq(columns.owner_user_id, param(session.userId)),
          ),
        ),
        { tag: "analytics.saved_filters.delete" },
      ),
    );
    return jsonResponseFor(request, { deletedId: id });
  }

  return na(request);
}
