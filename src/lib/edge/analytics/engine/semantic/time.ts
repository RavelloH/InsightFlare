import type {
  EpochMs,
  QueryTime,
  ReportingTimeZone,
  TimeRange,
} from "@/lib/edge/analytics/contract/types";
import type { FilterEvaluationDomain } from "@/lib/filter-contract/filter-history";

export type SemanticReadExtent =
  | { readonly kind: "bounded"; readonly range: TimeRange }
  | { readonly kind: "retained-history" };

export interface SemanticTemporalDomains {
  readonly candidate: TimeRange;
  readonly filter?: FilterEvaluationDomain;
  readonly read: SemanticReadExtent;
  readonly reportingTimeZone: ReportingTimeZone;
  readonly capturedAtMs: EpochMs;
}

export class SemanticTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticTimeError";
  }
}

function validRange(range: TimeRange): boolean {
  return (
    Number.isFinite(range.startMs) &&
    Number.isFinite(range.endExclusiveMs) &&
    range.startMs < range.endExclusiveMs
  );
}

export function createSemanticTemporalDomains(
  input: SemanticTemporalDomains,
): SemanticTemporalDomains {
  if (!validRange(input.candidate)) {
    throw new SemanticTimeError("The candidate time range must be non-empty.");
  }
  if (input.read.kind === "bounded" && !validRange(input.read.range)) {
    throw new SemanticTimeError("The bounded read range must be non-empty.");
  }
  if (input.filter) {
    const { startMs, endExclusiveMs } = input.filter;
    if (
      (startMs !== undefined && !Number.isFinite(startMs)) ||
      (endExclusiveMs !== undefined && !Number.isFinite(endExclusiveMs)) ||
      (startMs !== undefined &&
        endExclusiveMs !== undefined &&
        startMs > endExclusiveMs)
    ) {
      throw new SemanticTimeError("The filter time domain is invalid.");
    }
  }
  if (
    typeof input.reportingTimeZone !== "string" ||
    input.reportingTimeZone.length === 0 ||
    !Number.isFinite(input.capturedAtMs)
  ) {
    throw new SemanticTimeError(
      "A reporting time zone and finite captured time are required.",
    );
  }
  return Object.freeze({
    candidate: Object.freeze({ ...input.candidate }),
    ...(input.filter ? { filter: Object.freeze({ ...input.filter }) } : {}),
    read:
      input.read.kind === "bounded"
        ? Object.freeze({
            kind: "bounded" as const,
            range: Object.freeze({ ...input.read.range }),
          })
        : Object.freeze({ kind: "retained-history" as const }),
    reportingTimeZone: input.reportingTimeZone,
    capturedAtMs: input.capturedAtMs,
  });
}

export function semanticTemporalDomainsFromQueryTime(
  queryTime: QueryTime,
): SemanticTemporalDomains {
  const filter = queryTime.filterRangeEmpty
    ? {
        startMs: queryTime.capturedAtMs,
        endExclusiveMs: queryTime.capturedAtMs,
      }
    : queryTime.filterRange;
  return createSemanticTemporalDomains({
    candidate: queryTime.range,
    ...(filter ? { filter } : {}),
    read: queryTime.fullHistory
      ? { kind: "retained-history" }
      : { kind: "bounded", range: queryTime.readRange ?? queryTime.range },
    reportingTimeZone: queryTime.reportingTimeZone,
    capturedAtMs: queryTime.capturedAtMs,
  });
}

export type TemporalDomainRef = "candidate" | "filter" | "read";

export function temporalDomainExists(
  domains: SemanticTemporalDomains,
  reference: TemporalDomainRef,
): boolean {
  if (reference === "candidate") return true;
  if (reference === "filter") return domains.filter !== undefined;
  if (reference === "read") return domains.read !== undefined;
  return false;
}
