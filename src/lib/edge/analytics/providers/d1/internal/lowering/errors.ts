import type { RelationId } from "@/lib/edge/analytics/engine/logical/ids";

export class AnalyticsRelationalLoweringError extends Error {
  constructor(
    readonly node: string,
    reason: string,
  ) {
    super(reason);
    this.name = "AnalyticsRelationalLoweringError";
  }
}

export function nodePath(id: RelationId): string {
  return `nodes[${String(id)}]`;
}

export function reject(node: string, reason: string): never {
  throw new AnalyticsRelationalLoweringError(node, reason);
}
