import type { FilterScopePreference } from "@/lib/edge/analytics/contract";
import {
  attachSavedFilterScopePreference,
  type FilterDocument,
  parseApiV1FilterDocument,
} from "@/lib/edge/analytics/contract";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import type { Env } from "@/lib/edge/types";
import {
  analyticsFilterRegistry,
  FILTER_DSL_MAX_LENGTH,
  FILTER_DSL_VERSION,
  parseFilterDsl,
} from "@/lib/filter-contract";

interface SavedFilterDefinitionRow {
  readonly filterDsl: string;
  readonly filterDslVersion: number;
  readonly scopePreference?: FilterScopePreference | null;
}

export interface ResolvedSavedFilter {
  readonly document: FilterDocument;
  readonly fingerprint: string;
  readonly scopePreference?: FilterScopePreference;
}

export interface AnalysisDefinitionReader {
  resolveTeamVisibleSavedFilter(input: {
    readonly siteId: string;
    readonly id: string;
    readonly signal?: AbortSignal;
  }): Promise<ResolvedSavedFilter | null>;
}

export class AnalysisDefinitionIntegrityError extends Error {
  constructor() {
    super("Saved filter definition is invalid.");
    this.name = "AnalysisDefinitionIntegrityError";
  }
}

export class AnalysisDefinitionReadCancelledError extends Error {
  constructor() {
    super("Saved filter definition read was cancelled.");
    this.name = "AnalysisDefinitionReadCancelledError";
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AnalysisDefinitionReadCancelledError();
}

async function definitionFingerprint(
  filterDsl: string,
  filterDslVersion: number,
): Promise<string> {
  const value = JSON.stringify([filterDslVersion, filterDsl]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `saved-filter-v1:${filterDslVersion}:${Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function parseSavedFilterDsl(
  row: SavedFilterDefinitionRow,
): FilterDocument {
  if (
    row.filterDslVersion !== FILTER_DSL_VERSION ||
    typeof row.filterDsl !== "string" ||
    row.filterDsl.length === 0 ||
    row.filterDsl.length > FILTER_DSL_MAX_LENGTH
  ) {
    throw new AnalysisDefinitionIntegrityError();
  }
  try {
    return parseApiV1FilterDocument(
      parseFilterDsl(row.filterDsl, analyticsFilterRegistry),
    );
  } catch {
    throw new AnalysisDefinitionIntegrityError();
  }
}

/**
 * Composition-root D1 adapter for the API v1 saved-filter reference seam.
 * The query deliberately does not select owner or any display-only metadata.
 */
export function createAnalysisDefinitionReader(
  env: Pick<Env, "DB">,
  principal: Pick<ApiKeyPrincipal, "teamId">,
): AnalysisDefinitionReader {
  return {
    async resolveTeamVisibleSavedFilter({ siteId, id, signal }) {
      assertNotAborted(signal);
      const row = await env.DB.prepare(
        `SELECT sf.filter_dsl AS filterDsl,
                sf.filter_dsl_version AS filterDslVersion,
                COALESCE(sf.scope_preference, 'auto') AS scopePreference
         FROM saved_filters sf
         INNER JOIN sites s ON s.id = sf.site_id
         WHERE sf.site_id = ?
           AND sf.id = ?
           AND sf.visibility = 'team'
           AND s.team_id = ?
         LIMIT 1`,
      )
        .bind(siteId, id, principal.teamId)
        .first<SavedFilterDefinitionRow>();
      assertNotAborted(signal);
      if (!row) return null;

      const document = attachSavedFilterScopePreference(
        parseSavedFilterDsl(row),
        row.scopePreference ?? "auto",
      );
      return {
        document,
        scopePreference: row.scopePreference ?? "auto",
        fingerprint: await definitionFingerprint(
          row.filterDsl,
          row.filterDslVersion,
        ),
      };
    },
  };
}
