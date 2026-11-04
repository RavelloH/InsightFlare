import { constant, eq, filter } from "@/lib/db";
import type { SourceNode } from "@/lib/edge/analytics/engine/logical/nodes";
import { buildLegacyScopedDataset } from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scoped-dataset";
import type {
  AnalyticsDbRelation,
  LoweredAnalyticsSource,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";

import type { AnalyticsScopedSourceContext } from "./context";
import type { ScopedSourceMembership } from "./membership";
import {
  observationEventMatches,
  selectedEventRelation,
  selectedEventRows,
} from "./membership";
import type { ScopedPostObservationLowerer } from "./post-observation";
import {
  EVENT_REPORT_PROPERTIES_METADATA_COLUMNS,
  POST_OBSERVATION_EVENT_PROPERTIES_METADATA_COLUMNS,
  remapEventPayloadKeyBindings,
  remapEventSourceValues,
} from "./source-projection";

export class ScopedEventSourceLowerer {
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
    if (node.entity !== "event")
      throw new Error(
        `${path}.selection: Scoped selection is currently supported only on Event report Sources.`,
      );
    if (selection.profile === "prepared-page-reader-window-v1")
      throw new Error(
        `${path}.selection: Page reader-window selections are unsupported on Event report Sources.`,
      );
    if (node.temporalDomain !== "candidate")
      throw new Error(
        `${path}.temporalDomain: Scoped Event report Sources currently require the candidate domain.`,
      );
    const report = source.relation;
    const sitePk = report.columns.site_pk;
    const eventId = report.columns.event_id;
    const ownerPresent = report.columns.owner_site_pk;
    const eventName = report.columns.event_name;
    if (!sitePk || !eventId || !ownerPresent || !eventName)
      throw new Error(
        `${path}.selection: The report carrier is missing a legacy owner/name dependency.`,
      );
    if (selection.profile === "direct-page-entity-only-compat-v1") {
      const empty = filter(report, eq(constant(1), constant(0)));
      const values = remapEventSourceValues(node, empty, source.values);
      return {
        relation: empty,
        values,
        providerBindings: remapEventPayloadKeyBindings(
          node,
          path,
          empty,
          values,
          source.providerBindings,
          EVENT_REPORT_PROPERTIES_METADATA_COLUMNS,
        ),
      };
    }
    // The legacy Event source inner-joins the event-name dictionary, but it
    // does not require the stored label itself to be non-NULL. Keep owner
    // presence here; consumers such as summaries need raw NULL labels to
    // remain in the row domain for COUNT(*) while applying their own
    // COALESCE/TRIM behavior.
    let selected: AnalyticsDbRelation;
    if (selection.postObservationFilter) {
      const bundle = this.#postObservation.postObservationBundle(selection);
      const matches = observationEventMatches(
        bundle.dataset,
        bundle.stageSelection,
      );
      selected = selectedEventRows(bundle.dataset, matches).relation;
    } else {
      const dataset = buildLegacyScopedDataset({
        selection,
        storage: this.#context.storage,
      });
      const qualifiedEntities = this.#membership.matchingEntityQualifications(
        selection,
        node.temporalDomain,
      );
      const matches = this.#membership.matchingEventRows(
        dataset,
        selection,
        qualifiedEntities,
      );
      // Preserve the logical Event Source carrier. It can expose projection
      // columns (for example owner page title) absent from the scoped dataset.
      selected = selectedEventRelation(source.relation, matches);
    }
    const values = remapEventSourceValues(node, selected, source.values);
    return {
      relation: selected,
      values,
      providerBindings: remapEventPayloadKeyBindings(
        node,
        path,
        selected,
        values,
        source.providerBindings,
        selection.postObservationFilter
          ? POST_OBSERVATION_EVENT_PROPERTIES_METADATA_COLUMNS
          : EVENT_REPORT_PROPERTIES_METADATA_COLUMNS,
      ),
    };
  }
}
