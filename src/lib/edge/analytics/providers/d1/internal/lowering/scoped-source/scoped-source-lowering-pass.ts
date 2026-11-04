import type { SourceNode } from "@/lib/edge/analytics/engine/logical/nodes";
import type {
  AnalyticsRelationalStorageContext,
  LoweredAnalyticsSource,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";

import { AnalyticsScopedSourceContext } from "./context";
import { ScopedEventSourceLowerer } from "./event-source";
import { ScopedSourceMembership } from "./membership";
import { ScopedPageSourceLowerer } from "./page-source";
import { ScopedPostObservationLowerer } from "./post-observation";

export class ScopedSourceLoweringPass {
  readonly #page: ScopedPageSourceLowerer;
  readonly #event: ScopedEventSourceLowerer;
  constructor(
    storage: AnalyticsRelationalStorageContext,
    sources: readonly SourceNode[] = [],
  ) {
    const context = new AnalyticsScopedSourceContext(storage, sources);
    const membership = new ScopedSourceMembership(context);
    const postObservation = new ScopedPostObservationLowerer(
      context,
      membership,
    );
    this.#page = new ScopedPageSourceLowerer(
      context,
      membership,
      postObservation,
    );
    this.#event = new ScopedEventSourceLowerer(
      context,
      membership,
      postObservation,
    );
  }
  lowerSelectedReportSource(
    node: SourceNode,
    path: string,
    source: LoweredAnalyticsSource,
  ): LoweredAnalyticsSource {
    if (!node.selection) return source;
    if (node.entity === "page")
      return this.lowerPageReportSource(node, path, source);
    if (node.entity === "event")
      return this.lowerEventReportSource(node, path, source);
    throw new Error(
      String(path) +
        ".selection: Scoped selection is supported only on Page and Event report Sources.",
    );
  }
  lowerPageReportSource(
    node: SourceNode,
    path: string,
    source: LoweredAnalyticsSource,
  ): LoweredAnalyticsSource {
    return this.#page.lower(node, path, source);
  }
  lowerEventReportSource(
    node: SourceNode,
    path: string,
    source: LoweredAnalyticsSource,
  ): LoweredAnalyticsSource {
    return this.#event.lower(node, path, source);
  }
}
