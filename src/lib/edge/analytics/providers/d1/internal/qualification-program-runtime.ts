import { type CompiledQuery, D1StatementBudgetError } from "@/lib/db";
import { AnalyticsProviderDomainError } from "@/lib/edge/analytics/application/errors";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";

import type { AdvancedCountSqlFallbackReason } from "./diagnostics";
import {
  type QualificationCompatibilityField,
  type QualificationCompatibilityMismatch,
  validateQualificationCompatibilityFields,
} from "./qualification-compatibility";

export type QualificationSignal =
  AbortSignal | readonly (AbortSignal | undefined)[] | undefined;

export type QualificationCompilation<T extends object> =
  | { readonly kind: "compiled"; readonly query: CompiledQuery<T> }
  | {
      readonly kind: "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    };

export function assertQualificationNotAborted(
  signal: QualificationSignal,
): void {
  const signals = Array.isArray(signal) ? signal : [signal];
  if (signals.some((candidate) => candidate?.aborted))
    throw new DOMException("Aborted", "AbortError");
}

export function compileQualificationQuery<T extends object>(
  compile: () => CompiledQuery<T>,
  signal?: QualificationSignal,
): QualificationCompilation<T> {
  assertQualificationNotAborted(signal);
  let query: CompiledQuery<T>;
  try {
    query = compile();
  } catch (error) {
    assertQualificationNotAborted(signal);
    if (!(error instanceof D1StatementBudgetError)) throw error;
    return {
      kind: "unavailable",
      fallbackReason: {
        kind: "compile-budget",
        item: error.item,
        actual: error.actual,
        limit: error.limit,
      },
    };
  }
  assertQualificationNotAborted(signal);
  return { kind: "compiled", query };
}

export async function executeQualificationQuery<T>(
  signal: QualificationSignal,
  execute: () => Promise<T>,
): Promise<T> {
  assertQualificationNotAborted(signal);
  const result = await execute();
  assertQualificationNotAborted(signal);
  return result;
}

export interface QualificationControl {
  readonly rawCount: number;
  readonly nullActivityIdCount: number;
  readonly siteIdentityMismatchCount: number;
  readonly invalidIdentityCount: number;
  readonly duplicateIdentityCount: number;
  readonly compatibilityMismatches: readonly QualificationCompatibilityMismatch[];
}

export function decodeQualificationControl(input: {
  readonly read: (name: string) => unknown;
  readonly compatibilityFields: readonly QualificationCompatibilityField[];
  readonly errorLabel: (field: string) => string;
}): QualificationControl {
  const compatibilityFields = validateQualificationCompatibilityFields(
    input.compatibilityFields,
  );
  const readInteger = (field: string) => {
    const value = input.read(field);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new Error(input.errorLabel(field));
    return value;
  };
  const rawCount = readInteger("rawCount");
  const nullActivityIdCount = readInteger("nullActivityIdCount");
  const siteIdentityMismatchCount = readInteger("siteIdentityMismatchCount");
  const invalidIdentityCount = readInteger("invalidIdentityCount");
  const duplicateIdentityCount = readInteger("duplicateIdentityCount");
  const compatibilityMismatches: QualificationCompatibilityMismatch[] = [];
  for (const field of compatibilityFields) {
    if (readInteger(field.outputName) === 0) continue;
    if (field.kind === "numeric") {
      compatibilityMismatches.push(
        Object.freeze({ kind: "numeric", fieldId: field.fieldId }),
      );
    } else {
      compatibilityMismatches.push(
        Object.freeze({
          kind: "comparison",
          fieldId: field.fieldId,
          semanticProfile: field.semanticProfile,
          adapterDomain: field.adapterDomain,
        }),
      );
    }
  }
  return {
    rawCount,
    nullActivityIdCount,
    siteIdentityMismatchCount,
    invalidIdentityCount,
    duplicateIdentityCount,
    compatibilityMismatches: Object.freeze(compatibilityMismatches),
  };
}

export type QualificationControlJudgment =
  | { readonly kind: "safe" }
  | {
      readonly kind: "fallback";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    };

export function judgeQualificationControl(
  control: QualificationControl,
  input: {
    readonly reportRowCount: number;
    readonly gateViolation: () => Error;
    readonly invalidIdentity: () => Error;
    readonly duplicateIdentity: () => Error;
  },
): QualificationControlJudgment {
  if (control.rawCount > ADVANCED_FILTER_MAX_ACTIVITIES)
    throw new AnalyticsProviderDomainError({
      kind: "invalid-input",
      issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
    });
  const fallback = (
    fallbackReason: AdvancedCountSqlFallbackReason,
  ): QualificationControlJudgment => {
    if (input.reportRowCount > 0) throw input.gateViolation();
    return { kind: "fallback", fallbackReason };
  };
  if (control.nullActivityIdCount > 0)
    return fallback({ kind: "null-activity-id" });
  if (control.siteIdentityMismatchCount > 0)
    return fallback({ kind: "site-identity-mismatch" });
  const numericFieldIds = control.compatibilityMismatches
    .filter((mismatch) => mismatch.kind === "numeric")
    .map(({ fieldId }) => fieldId)
    .sort();
  if (numericFieldIds.length > 0)
    return fallback({ kind: "numeric-data-domain", fieldIds: numericFieldIds });
  const comparisonFields = control.compatibilityMismatches
    .filter(
      (
        mismatch,
      ): mismatch is Extract<
        QualificationCompatibilityMismatch,
        { readonly kind: "comparison" }
      > => mismatch.kind === "comparison",
    )
    .map(({ fieldId, semanticProfile, adapterDomain }) =>
      Object.freeze({ fieldId, semanticProfile, adapterDomain }),
    )
    .sort((left, right) => left.fieldId.localeCompare(right.fieldId));
  if (comparisonFields.length > 0)
    return fallback({
      kind: "comparison-data-domain",
      fields: Object.freeze(comparisonFields),
    });
  if (control.invalidIdentityCount > 0) throw input.invalidIdentity();
  if (control.duplicateIdentityCount > 0) throw input.duplicateIdentity();
  return { kind: "safe" };
}
