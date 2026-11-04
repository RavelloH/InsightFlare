import type { SourceNode } from "@/lib/edge/analytics/engine/logical/nodes";

import { ScopedSourceLoweringPass } from "./lowering/scoped-source/scoped-source-lowering-pass";
import type {
  AnalyticsRelationalStorageContext,
  LoweredAnalyticsSource,
} from "./analytics-relational-storage";

export {
  entityQualificationCacheKey,
  pageEventOwnerPairCacheKey,
} from "./lowering/scoped-source/selection-compatibility";

/** Compatibility facade retained for historical tests and callers. Production uses ScopedSourceLoweringPass directly. */
export class AnalyticsLegacyScopedStorage {
  readonly #pass: ScopedSourceLoweringPass;
  constructor(
    storage: AnalyticsRelationalStorageContext,
    sources: readonly SourceNode[] = [],
  ) {
    this.#pass = new ScopedSourceLoweringPass(storage, sources);
  }
  lowerSelectedReportSource(
    node: SourceNode,
    path: string,
    source: LoweredAnalyticsSource,
  ): LoweredAnalyticsSource {
    return this.#pass.lowerSelectedReportSource(node, path, source);
  }
  lowerPageReportSource(
    node: SourceNode,
    path: string,
    source: LoweredAnalyticsSource,
  ): LoweredAnalyticsSource {
    return this.#pass.lowerPageReportSource(node, path, source);
  }
  lowerEventReportSource(
    node: SourceNode,
    path: string,
    source: LoweredAnalyticsSource,
  ): LoweredAnalyticsSource {
    return this.#pass.lowerEventReportSource(node, path, source);
  }
}
