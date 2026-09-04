import {
  analyticsFilterRegistry,
  assertFilterAudience,
  FILTER_DSL_MAX_LENGTH,
  parseFilterDsl,
} from "@/lib/filter-contract";
import { bad, forb, jsonResponseFor, na, nf } from "@/lib/response";
import {
  SAVED_FILTER_DSL_VERSION,
  SAVED_FILTER_SCOPE_PREFERENCES,
  SAVED_FILTER_VISIBILITIES,
  type SavedFilter,
  type SavedFilterScopePreference,
  type SavedFilterVisibility,
} from "@/lib/saved-filters";

import { parseJson } from "./admin-response";
import type { EdgeSessionClaims } from "./session-auth";
import type { Env } from "./types";

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

interface SavedFilterInput {
  readonly name: string;
  readonly description: string;
  readonly visibility: SavedFilterVisibility;
  readonly scopePreference: SavedFilterScopePreference;
  readonly filterDsl: string;
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

const savedFilterColumns = `
  sf.id,
  sf.site_id AS siteId,
  sf.owner_user_id AS ownerUserId,
  COALESCE(NULLIF(u.name, ''), NULLIF(u.username, ''), 'Unknown') AS authorName,
  sf.visibility,
  sf.scope_preference AS scopePreference,
  sf.name,
  sf.description,
  sf.filter_dsl AS filterDsl,
  sf.filter_dsl_version AS filterDslVersion,
  sf.created_at AS createdAt,
  sf.updated_at AS updatedAt
`;

async function savedFilterById(
  env: Env,
  siteId: string,
  id: string,
): Promise<SavedFilterRow | null> {
  return env.DB.prepare(
    `SELECT ${savedFilterColumns}
     FROM saved_filters sf
     INNER JOIN users u ON u.id = sf.owner_user_id
     WHERE sf.site_id = ? AND sf.id = ?
     LIMIT 1`,
  )
    .bind(siteId, id)
    .first<SavedFilterRow>();
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
    const rows = await env.DB.prepare(
      `SELECT ${savedFilterColumns}
       FROM saved_filters sf
       INNER JOIN users u ON u.id = sf.owner_user_id
       WHERE sf.site_id = ?
         AND (sf.owner_user_id = ? OR sf.visibility = 'team')
       ORDER BY sf.updated_at DESC, sf.id DESC`,
    )
      .bind(siteId, session.userId)
      .all<SavedFilterRow>();
    return jsonResponseFor(request, {
      filters: rows.results.map((row) => asSavedFilter(row, session.userId)),
    });
  }

  if (request.method === "POST" && !input.filterId) {
    const parsed = savedFilterInput(await parseJson(request));
    if (parsed instanceof Response) return parsed;
    const duplicate = await env.DB.prepare(
      `SELECT id FROM saved_filters
       WHERE site_id = ? AND owner_user_id = ? AND filter_dsl = ?
         AND scope_preference = ?
       LIMIT 1`,
    )
      .bind(siteId, session.userId, parsed.filterDsl, parsed.scopePreference)
      .first<{ id: string }>();
    if (duplicate) {
      return bad(
        "An identical saved filter already exists",
        "duplicate_saved_filter_dsl",
        request,
      );
    }
    const createdId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO saved_filters (
        id, site_id, owner_user_id, visibility, name, description,
        scope_preference, filter_dsl, filter_dsl_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`,
    )
      .bind(
        createdId,
        siteId,
        session.userId,
        parsed.visibility,
        parsed.name,
        parsed.description,
        parsed.scopePreference,
        parsed.filterDsl,
        SAVED_FILTER_DSL_VERSION,
      )
      .run();
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
    const duplicate = await env.DB.prepare(
      `SELECT id FROM saved_filters
       WHERE site_id = ? AND owner_user_id = ? AND filter_dsl = ?
         AND scope_preference = ? AND id <> ?
       LIMIT 1`,
    )
      .bind(
        siteId,
        session.userId,
        parsed.filterDsl,
        parsed.scopePreference,
        id,
      )
      .first<{ id: string }>();
    if (duplicate) {
      return bad(
        "An identical saved filter already exists",
        "duplicate_saved_filter_dsl",
        request,
      );
    }
    await env.DB.prepare(
      `UPDATE saved_filters
       SET visibility = ?, scope_preference = ?, name = ?, description = ?,
           filter_dsl = ?, filter_dsl_version = ?, updated_at = unixepoch()
       WHERE id = ? AND site_id = ? AND owner_user_id = ?`,
    )
      .bind(
        parsed.visibility,
        parsed.scopePreference,
        parsed.name,
        parsed.description,
        parsed.filterDsl,
        SAVED_FILTER_DSL_VERSION,
        id,
        siteId,
        session.userId,
      )
      .run();
    const updated = await savedFilterById(env, siteId, id);
    if (!updated) throw new Error("saved filter was not updated");
    return jsonResponseFor(request, {
      filter: asSavedFilter(updated, session.userId),
    });
  }

  if (request.method === "DELETE") {
    await env.DB.prepare(
      "DELETE FROM saved_filters WHERE id = ? AND site_id = ? AND owner_user_id = ?",
    )
      .bind(id, siteId, session.userId)
      .run();
    return jsonResponseFor(request, { deletedId: id });
  }

  return na(request);
}
