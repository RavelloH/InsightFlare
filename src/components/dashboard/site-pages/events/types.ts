import type { EventField } from "@/lib/dashboard-api/client/edge";
import type { FilterValue } from "@/lib/filter-contract/index";
import type { AppMessages } from "@/lib/i18n/messages";

export type EventPayloadFilterValue = FilterValue;

export interface EventPayloadFilterRule {
  path: string;
  operator: "eq" | "neq";
  value: EventPayloadFilterValue;
}

export type SortDirection = "asc" | "desc";

export type EventRecordSortKey = "occurredAt" | "eventName" | "pathname";

export interface EventRecordSortState {
  key: EventRecordSortKey;
  direction: SortDirection;
}

export const EVENT_RECORD_TABLE_COLUMN_IDS = [
  "visitor",
  "eventName",
  "eventId",
  "occurredAt",
  "page",
  "referrer",
  "location",
  "os",
  "browser",
  "device",
  "payload",
  "nodeCount",
] as const;

export type EventRecordTableColumnId =
  (typeof EVENT_RECORD_TABLE_COLUMN_IDS)[number];

export type EventPageCopy = AppMessages["events"];

export interface EventFieldTreeNode {
  path: string;
  segment: string;
  fields: EventField[];
  children: EventFieldTreeNode[];
}

export type EventMetricSummary = {
  events: number;
  eventTypes: number;
  sessions: number;
  visitors: number;
  avgEventsPerSession: number;
  shareOfAllEvents?: number;
};
