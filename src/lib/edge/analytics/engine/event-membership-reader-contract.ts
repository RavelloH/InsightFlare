import type { QueryTime } from "@/lib/edge/analytics/contract";
import { EVENT_CONTEXT_REPORT_OUTPUT } from "@/lib/edge/analytics/engine/event-context-report-plan";
import { EVENT_FIELD_VALUES_PAGE_OUTPUT } from "@/lib/edge/analytics/engine/event-field-values-plan";
import { EVENT_FIELDS_PAGE_OUTPUT } from "@/lib/edge/analytics/engine/event-fields-plan";
import { EVENT_RECORD_PAGE_OUTPUT_ID } from "@/lib/edge/analytics/engine/event-record-page-plan";
import { EVENT_SUMMARY_CARD_OUTPUTS } from "@/lib/edge/analytics/engine/event-summary-cards-plan";
import { EVENT_TREND_OUTPUTS } from "@/lib/edge/analytics/engine/event-trend-plan";
import { EVENT_TYPE_OVERVIEW_OUTPUTS } from "@/lib/edge/analytics/engine/event-type-overview-plan";
import { EVENT_TYPE_SUMMARY_OUTPUTS } from "@/lib/edge/analytics/engine/event-type-summary-plan";
import {
  EVENT_CONTEXT_CARD_KEYS,
  EVENT_CONTEXT_CARDS,
  type EventContextCardKey,
} from "@/lib/edge/analytics/engine/semantic/event-context-cards";
import {
  EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
} from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type {
  ExactMembershipSourceUse,
  ExactOutputDescriptor,
} from "@/lib/edge/analytics/engine/whole-filter-reader-contract";

/** Only canonical reader shape. This does not grant request/audience authority,
 * validate configuration, normalize raw reader data, or authorize preparation. */
export type EventReaderConsumer =
  | { readonly kind: "event-summary" }
  | { readonly kind: "event-types" }
  | { readonly kind: "event-name-dimension" }
  | { readonly kind: "event-records" }
  | { readonly kind: "event-fields" }
  | { readonly kind: "event-field-values" }
  | {
      readonly kind: "event-context";
      readonly selectedKeys?: readonly EventContextCardKey[];
    }
  | { readonly kind: "event-trend"; readonly stage: EventTrendReaderStage }
  | {
      readonly kind: "event-type-detail";
      readonly includeBreakdowns: boolean;
      readonly includeContext: boolean;
      readonly selectedKeys?: readonly EventContextCardKey[];
    };

export type EventTrendReaderStage =
  | { readonly kind: "series" }
  | { readonly kind: "points"; readonly seriesNames: readonly string[] }
  | { readonly kind: "other"; readonly seriesNames: readonly string[] };

export interface EventReaderStageDescription {
  readonly scheduling:
    "single" | "parallel" | "serial-stage" | "empty-before-qualification";
  readonly outputs: readonly ExactOutputDescriptor[];
}

function selectedCards(keys: readonly EventContextCardKey[] | undefined) {
  const selected = new Set(keys ?? EVENT_CONTEXT_CARD_KEYS);
  return EVENT_CONTEXT_CARD_KEYS.filter((key) => selected.has(key));
}

/** Same projection as the existing mapped series rows, without normalization.
 * In particular anomalous NULL names are not replaced by invented strings.
 * These values are not capabilities; the binder owns actual stage sequencing. */
export function eventTrendStageAfterSeries(
  rows: readonly { readonly eventName: string }[],
): Extract<EventTrendReaderStage, { kind: "points" }> {
  return Object.freeze({
    kind: "points",
    seriesNames: Object.freeze(rows.map((row) => row.eventName)),
  });
}

/** Caller supplies the already mapped point rows, at the original await site.
 * The literal is the existing Event trend's closed Other token, not a new input. */
export function eventTrendStageAfterPoints(
  stage: Extract<EventTrendReaderStage, { kind: "points" }>,
  rows: readonly { readonly seriesKey: string }[],
): Extract<EventTrendReaderStage, { kind: "other" }> | undefined {
  if (!rows.some((row) => String(row.seriesKey) === "__share_trend_other__"))
    return undefined;
  return Object.freeze({
    kind: "other",
    seriesNames: Object.freeze([...stage.seriesNames]),
  });
}

/** Exact finite declarations for existing readers only. All output IDs and
 * Source occurrences are catalog-owned. No arbitrary fanout/max is accepted.
 * QueryTime/config freshness and canonical builder identity stay with binder. */
export function describeEventMembershipReader(input: {
  readonly consumer: EventReaderConsumer;
  readonly queryTime: QueryTime;
  readonly mode: "entity" | "observation";
}): EventReaderStageDescription | undefined {
  if (input.mode !== "entity" && input.mode !== "observation") return undefined;
  const eventUse: ExactMembershipSourceUse = Object.freeze({
    entity: "event",
    dependencyRef:
      input.mode === "entity"
        ? EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY
        : EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
  });
  const pageUse: ExactMembershipSourceUse = Object.freeze({
    entity: "page",
    dependencyRef:
      input.mode === "entity"
        ? EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY
        : EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
  });
  const event = Object.freeze([eventUse]);
  const contextUses = (selected: readonly EventContextCardKey[]) =>
    Object.freeze(
      selected.some(
        (key) => EVENT_CONTEXT_CARDS[key].kind === "session-boundary",
      )
        ? [eventUse, pageUse]
        : [eventUse],
    );
  const outputs: ExactOutputDescriptor[] = [];
  const add = (
    readerKey: string,
    ids: readonly string[],
    sources: readonly ExactMembershipSourceUse[],
  ) => {
    for (const outputId of ids)
      outputs.push(
        Object.freeze({
          key: `${readerKey}:${outputId}`,
          readerKey,
          preparationKey: "original",
          outputId,
          queryTime: input.queryTime,
          sources,
        }),
      );
  };
  let scheduling: EventReaderStageDescription["scheduling"] = "single";
  const c = input.consumer;
  switch (c.kind) {
    case "event-summary":
      add(c.kind, Object.values(EVENT_SUMMARY_CARD_OUTPUTS), event);
      break;
    case "event-types":
      add(c.kind, [EVENT_TYPE_SUMMARY_OUTPUTS.page], event);
      break;
    case "event-name-dimension":
      add(c.kind, [EVENT_TYPE_SUMMARY_OUTPUTS.list], event);
      break;
    case "event-records":
      add(c.kind, [EVENT_RECORD_PAGE_OUTPUT_ID], event);
      break;
    case "event-fields":
      add(c.kind, [EVENT_FIELDS_PAGE_OUTPUT], event);
      break;
    case "event-field-values":
      add(c.kind, [EVENT_FIELD_VALUES_PAGE_OUTPUT], event);
      break;
    case "event-context": {
      const selected = selectedCards(c.selectedKeys);
      if (selected.length === 0) scheduling = "empty-before-qualification";
      else add(c.kind, [EVENT_CONTEXT_REPORT_OUTPUT], contextUses(selected));
      break;
    }
    case "event-trend":
      if (
        c.stage.kind !== "series" &&
        c.stage.kind !== "points" &&
        c.stage.kind !== "other"
      )
        return undefined;
      scheduling = "serial-stage";
      add(
        `event-trend:${c.stage.kind}`,
        [EVENT_TREND_OUTPUTS[c.stage.kind]],
        event,
      );
      break;
    case "event-type-detail": {
      scheduling = "parallel";
      add(
        "event-type-detail:overview",
        c.includeBreakdowns
          ? Object.values(EVENT_TYPE_OVERVIEW_OUTPUTS)
          : [EVENT_TYPE_OVERVIEW_OUTPUTS.summary],
        Object.freeze([eventUse, eventUse]),
      );
      add("event-type-detail:trend", [EVENT_TREND_OUTPUTS.typePoints], event);
      if (c.includeContext) {
        const selected = selectedCards(c.selectedKeys);
        if (selected.length > 0)
          add(
            "event-type-detail:context",
            [EVENT_CONTEXT_REPORT_OUTPUT],
            contextUses(selected),
          );
      }
      break;
    }
    default:
      return undefined;
  }
  return Object.freeze({ scheduling, outputs: Object.freeze(outputs) });
}
