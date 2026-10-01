import { compileD1Query, filter, inList, project, scan } from "@/lib/db";
import { schema } from "@/lib/db/schema";
import { currentD1Operation } from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

import { queryD1CompiledAll } from "./core-sources";
import type { D1ReadDiagnostics } from "./diagnostics";

const SITE_CHUNK_SIZE = 90;

function siteChunks(siteIds: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < siteIds.length; index += SITE_CHUNK_SIZE) {
    chunks.push(siteIds.slice(index, index + SITE_CHUNK_SIZE));
  }
  return chunks;
}

export async function siteCoverage(
  env: Env,
  siteIds: readonly string[],
  diagnostics?: D1ReadDiagnostics,
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const coverage = new Map<string, number>();
  const sites = scan(schema.sites);
  for (const chunk of siteChunks(siteIds)) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const selectedSites = filter(sites, inList(sites.columns.id, chunk));
    const query = compileD1Query(
      project(selectedSites, {
        siteId: selectedSites.columns.id,
        createdAtSeconds: selectedSites.columns.created_at,
      }),
      { tag: currentD1Operation() ?? "analytics.query.all" },
    );
    const rows = await queryD1CompiledAll(env, query, diagnostics);
    for (const row of rows) {
      if (
        typeof row.siteId === "string" &&
        typeof row.createdAtSeconds === "number"
      ) {
        coverage.set(row.siteId, Math.trunc(row.createdAtSeconds * 1_000));
      }
    }
  }
  return coverage;
}
