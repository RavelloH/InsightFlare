import { AnalyticsProviderDomainError } from "@/lib/edge/analytics/application/errors";
import type { TypedQueryProviderMiddleware } from "@/lib/edge/analytics/application/provider-registry";
import {
  attachScopedFilterMetadata,
  type QueryTime,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import type { Env } from "@/lib/edge/types";
import { filterDocumentUsesAdvancedExpressions } from "@/lib/filter-contract/filter-types";
import type { FilterDocument } from "@/lib/filter-contract/filters";

import { queryD1All } from "./core-sources";
import type { D1ReadDiagnostics } from "./diagnostics";

interface FilterQuerySide {
  readonly filters?: FilterDocument;
  readonly time?: QueryTime;
  readonly [key: string]: unknown;
}

function invalidCoverage(): AnalyticsProviderDomainError {
  return new AnalyticsProviderDomainError({
    kind: "invalid-input",
    issues: [
      { path: "readRange", code: "filter_evaluation_range_unavailable" },
    ],
  });
}

/**
 * Determine authorized retained history without reading or interpreting any
 * analytics activity in JavaScript. The query still performs every predicate,
 * payload lookup, reducer, time window and relation inside SQLite.
 */
export function resolveFilterSqlCoverageTime(
  time: QueryTime,
  siteIds: readonly string[],
  coverage: ReadonlyMap<string, number>,
): QueryTime {
  const createdTimes = siteIds.map((siteId) => coverage.get(siteId));
  if (
    !createdTimes.length ||
    createdTimes.some(
      (created) => created === undefined || !Number.isSafeInteger(created),
    )
  ) {
    throw invalidCoverage();
  }
  // A site can be created after the requested report period. Its empty
  // contribution must not invalidate queries for the other authorized sites.
  const authorizedEnd = time.capturedAtMs + 1;
  const earliest = createdTimes.reduce<number>(
    (start, created) => Math.min(start, created!),
    time.capturedAtMs,
  );
  const readRange = time.fullHistory
    ? { startMs: earliest, endExclusiveMs: authorizedEnd }
    : (time.readRange ?? time.range);
  const { startMs, endExclusiveMs } = readRange;
  if (
    typeof startMs !== "number" ||
    typeof endExclusiveMs !== "number" ||
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endExclusiveMs) ||
    startMs >= endExclusiveMs ||
    endExclusiveMs > authorizedEnd
  ) {
    throw invalidCoverage();
  }
  return {
    ...time,
    readRange: readRange as QueryTime["range"],
    ...(time.filterRange
      ? {
          filterRange: {
            ...time.filterRange,
            startMs: time.filterRange.startMs ?? earliest,
            endExclusiveMs: time.filterRange.endExclusiveMs ?? authorizedEnd,
          },
        }
      : {}),
  };
}

async function readSiteCoverage(
  env: Env,
  siteIds: readonly string[],
  diagnostics?: D1ReadDiagnostics,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, number>> {
  const coverage = new Map<string, number>();
  for (let index = 0; index < siteIds.length; index += 90) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const chunk = siteIds.slice(index, index + 90);
    const rows = await queryD1All<{
      siteId: string;
      createdAtSeconds: number | null;
    }>(
      env,
      `SELECT id AS siteId, created_at AS createdAtSeconds
         FROM sites WHERE id IN (${chunk.map(() => "?").join(", ")})`,
      [...chunk],
      diagnostics,
    );
    for (const row of rows) {
      if (Number.isFinite(row.createdAtSeconds)) {
        coverage.set(row.siteId, Math.trunc(row.createdAtSeconds! * 1000));
      }
    }
  }
  return coverage;
}

function advancedSide(side: FilterQuerySide): boolean {
  return Boolean(
    side.filters?.root && filterDocumentUsesAdvancedExpressions(side.filters),
  );
}

/** Read coverage once, even when Comparison contains two advanced sides. */
export function d1FilterSqlHistoryMiddleware(
  env: Env,
  diagnostics?: D1ReadDiagnostics,
): TypedQueryProviderMiddleware {
  return async (_operation, input, next, execution) => {
    const query = input as FilterQuerySide & {
      readonly context: {
        readonly subject:
          | { readonly kind: "site"; readonly siteId: string }
          | {
              readonly kind: "team";
              readonly authorizedSiteIds: readonly string[];
            };
      };
      readonly current?: FilterQuerySide;
      readonly reference?: FilterQuerySide;
    };
    const comparison = Boolean(query.current && query.reference);
    const sides = comparison ? [query.current!, query.reference!] : [query];
    if (!sides.some(advancedSide)) return next(input);
    const subject = query.context.subject;
    const siteIds =
      subject.kind === "site"
        ? [subject.siteId]
        : [...subject.authorizedSiteIds];
    const coverage = await readSiteCoverage(
      env,
      siteIds,
      diagnostics,
      execution?.signal,
    );
    const prepare = (side: FilterQuerySide): FilterQuerySide => {
      if (!advancedSide(side)) return side;
      const metadata = scopedFilterMetadata(side.filters);
      if (!metadata || !side.filters) {
        throw new AnalyticsProviderDomainError({
          kind: "invalid-input",
          issues: [
            { path: "filters", code: "scoped_dataset_metadata_required" },
          ],
        });
      }
      const time = resolveFilterSqlCoverageTime(
        metadata.time,
        metadata.siteIds.length ? metadata.siteIds : siteIds,
        coverage,
      );
      return {
        ...side,
        time,
        filters: attachScopedFilterMetadata(side.filters, {
          ...metadata,
          time,
        }),
      };
    };
    if (comparison) {
      return next({
        ...query,
        current: prepare(query.current!),
        reference: prepare(query.reference!),
      });
    }
    return next(prepare(query));
  };
}
