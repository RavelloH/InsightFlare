import { createOperationCacheKey } from "./cache";

export const comparisonCachePolicy = {
  ttlMs: 30_000,
  maxEntries: 256,
} as const;

export async function comparisonCacheKey(input: {
  readonly operation: string;
  readonly subjectFingerprint: string;
  readonly policyRevision: string;
  readonly query: unknown;
}): Promise<string> {
  return createOperationCacheKey({
    contractRevision: "comparison-v2",
    operation: input.operation,
    operationRevision: "2",
    subjectFingerprint: input.subjectFingerprint,
    policyRevision: input.policyRevision,
    query: input.query,
  });
}
