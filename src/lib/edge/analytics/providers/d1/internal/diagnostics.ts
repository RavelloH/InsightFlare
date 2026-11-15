import type { D1StatementBudgetItem } from "@/lib/db";
import type {
  FilterScope,
  FilterScopePreference,
  ScopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import type { AdvancedFilterExecutionDecision } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";

import type { QualificationCompatibilityMismatch } from "./qualification-compatibility";

export type AdvancedCountSqlFallbackReason =
  | {
      readonly kind:
        "invalid-range" | "null-activity-id" | "site-identity-mismatch";
    }
  | {
      readonly kind: "compile-budget";
      readonly item: D1StatementBudgetItem;
      readonly actual: number;
      readonly limit: number;
    }
  | {
      readonly kind: "numeric-data-domain";
      readonly fieldIds: readonly string[];
    }
  | {
      readonly kind: "comparison-data-domain";
      readonly fields: readonly Omit<
        Extract<
          QualificationCompatibilityMismatch,
          { readonly kind: "comparison" }
        >,
        "kind"
      >[];
    }
  | {
      readonly kind: "payload-data-domain";
      readonly controls: readonly (
        | "missing-event-fact"
        | "invalid-structure"
        | "invalid-value"
        | "event-fact-multiplicity"
      )[];
    }
  | {
      readonly kind: "grouped-summary-unavailable";
      readonly groupWidth: number | null;
    }
  | {
      readonly kind: "compiler-unavailable";
    };

export type AnalyticsDataSource = "raw" | "rollup" | "mixed" | "mock";

export interface D1EventRecordsCompilationEvidence {
  readonly statementTag: string;
  readonly sql: string;
  readonly bindings: readonly unknown[];
  readonly sqlBytes: number;
  readonly bindingCount: number;
  readonly groupWidth: number;
  readonly sharedRelationCount: number;
  readonly rootKind: string;
  readonly physicalScanKinds: readonly string[];
  readonly logicalPlan: unknown;
}

export interface D1ReadDiagnostics {
  rowsRead: number;
  rowsReadAvailable: boolean;
  requestedScope?: FilterScopePreference;
  resolvedScope?: FilterScope;
  requiredSources?: readonly string[];
  requiresRawSource?: boolean;
  /** Internal reason an otherwise supported count tree used the old evaluator. */
  advancedCountSqlFallbackReason?: AdvancedCountSqlFallbackReason;
  /** Internal executed strategy decisions; never included in public headers. */
  advancedFilterExecution?: AdvancedFilterExecutionDecision;
  advancedFilterExecutionHistory?: AdvancedFilterExecutionDecision[];
  /** Test/runtime audit hook; absent from normal request diagnostics. */
  onEventRecordsQualificationCompile?: (
    evidence: D1EventRecordsCompilationEvidence,
  ) => void;
}

export function recordAdvancedFilterExecution(
  diagnostics: D1ReadDiagnostics | undefined,
  decision: AdvancedFilterExecutionDecision,
): void {
  if (!diagnostics) return;
  diagnostics.advancedFilterExecution = decision;
  (diagnostics.advancedFilterExecutionHistory ??= []).push(decision);
}

interface D1ResultWithMeta {
  meta?: {
    rows_read?: unknown;
  };
}

export function createD1ReadDiagnostics(): D1ReadDiagnostics {
  return { rowsRead: 0, rowsReadAvailable: true };
}

export function recordScopedFilterDiagnostics(
  diagnostics: D1ReadDiagnostics | undefined,
  metadata: ScopedFilterMetadata | undefined,
): void {
  if (!diagnostics || !metadata) return;
  diagnostics.requestedScope = metadata.requestedScope;
  diagnostics.resolvedScope = metadata.resolvedScope;
  diagnostics.requiredSources = [...metadata.plan.requiredSources].sort();
  diagnostics.requiresRawSource = metadata.plan.requiresRawSource;
}

export function recordD1RowsRead(
  diagnostics: D1ReadDiagnostics | undefined,
  result: D1ResultWithMeta,
): void {
  if (!diagnostics) return;
  const rowsRead = result.meta?.rows_read;
  if (typeof rowsRead !== "number" || !Number.isFinite(rowsRead)) {
    diagnostics.rowsReadAvailable = false;
    return;
  }
  diagnostics.rowsRead += Math.max(0, Math.trunc(rowsRead));
}

export function analyticsDiagnosticHeaders(
  source: AnalyticsDataSource,
  diagnostics: D1ReadDiagnostics,
): Record<string, string> {
  return {
    "x-insightflare-data-source": source,
    "x-insightflare-d1-rows-read": diagnostics.rowsReadAvailable
      ? String(diagnostics.rowsRead)
      : "unavailable",
    ...(diagnostics.requestedScope
      ? { "x-insightflare-scope-requested": diagnostics.requestedScope }
      : {}),
    ...(diagnostics.resolvedScope
      ? { "x-insightflare-scope-resolved": diagnostics.resolvedScope }
      : {}),
    ...(diagnostics.requiredSources
      ? {
          "x-insightflare-scope-required-sources":
            diagnostics.requiredSources.join(","),
        }
      : {}),
    ...(diagnostics.requiresRawSource === undefined
      ? {}
      : {
          "x-insightflare-scope-requires-raw": String(
            diagnostics.requiresRawSource,
          ),
        }),
  };
}
