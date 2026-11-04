import { factEntityKindsForFilter } from "@/lib/edge/analytics/contract";
import type { SourceNode } from "@/lib/edge/analytics/engine/logical/nodes";
import { buildLegacyScopedDataset } from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scoped-dataset";
import type {
  AnalyticsDbRelation,
  LoweredAnalyticsSource,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";

import type { AnalyticsScopedSourceContext } from "./context";
import type { ScopedSourceMembership } from "./membership";
import { selectedPageRows } from "./membership";
import {
  postObservationPageRows,
  type ScopedPostObservationLowerer,
} from "./post-observation";
import { remapPageSourceValues } from "./source-projection";

export class ScopedPageSourceLowerer {
  readonly #context: AnalyticsScopedSourceContext;
  readonly #membership: ScopedSourceMembership;
  readonly #postObservation: ScopedPostObservationLowerer;
  constructor(
    context: AnalyticsScopedSourceContext,
    membership: ScopedSourceMembership,
    postObservation: ScopedPostObservationLowerer,
  ) {
    this.#context = context;
    this.#membership = membership;
    this.#postObservation = postObservation;
  }

  lower(
    node: SourceNode,
    path: string,
    source: LoweredAnalyticsSource,
  ): LoweredAnalyticsSource {
    const selection = node.selection;
    if (!selection) return source;
    if (node.entity !== "page")
      throw new Error(
        `${path}.selection: Scoped Page selection requires a Page report Source.`,
      );
    if (node.temporalDomain !== "candidate")
      throw new Error(
        `${path}.temporalDomain: Scoped Page report Sources currently require the candidate domain.`,
      );
    if (
      selection.profile !== "direct-page-analytics-v1" &&
      selection.profile !== "direct-page-session-compat-v1" &&
      selection.profile !== "direct-page-entity-only-compat-v1" &&
      selection.profile !== "prepared-scoped-v1" &&
      selection.profile !== "prepared-page-reader-window-v1" &&
      selection.profile !== "prepared-scoped-reader-window-v1"
    )
      throw new Error(`${path}.selection: Invalid Page source profile.`);
    if (selection.eventNameGate)
      throw new Error(
        `${path}.selection: Page report Sources do not support Event-name gates.`,
      );

    const pageAttributes = node.values.flatMap((binding) =>
      binding.kind === "attribute" ? [binding.attribute] : [],
    );
    let relation: AnalyticsDbRelation;
    if (selection.postObservationFilter) {
      const bundle = this.#postObservation.postObservationBundle(
        selection,
        pageAttributes,
      );
      relation = postObservationPageRows(bundle.dataset, bundle.stageSelection);
    } else {
      const usesEntityRows =
        selection.mode === "entity" &&
        (selection.profile !== "direct-page-session-compat-v1" ||
          factEntityKindsForFilter(selection.filter.root).size > 0);
      const qualifiedEntities = usesEntityRows
        ? this.#membership.matchingEntityQualifications(
            selection,
            node.temporalDomain,
          )
        : undefined;
      const dataset = buildLegacyScopedDataset({
        selection,
        storage: this.#context.storage,
        requiredPageAttributes: pageAttributes,
      });
      relation = selectedPageRows(
        dataset,
        selection,
        this.#membership.matchingPageEventOwnerPairs(dataset, selection),
        qualifiedEntities,
      ).relation;
    }
    return {
      relation,
      values: remapPageSourceValues(node, relation, source.values),
      providerBindings: [],
    };
  }
}
