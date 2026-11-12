import { EVENT_RECORD_PAGE_OUTPUT_ID } from "@/lib/edge/analytics/engine/event-record-page-plan";
import type { SlotId } from "@/lib/edge/analytics/engine/logical/ids";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { SemanticScalarValueType } from "@/lib/edge/analytics/engine/semantic/value-types";
import { queryAnalyticsReportOutputRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import type { Env } from "@/lib/edge/types";

import type { EventRecordRow } from "./core";
import type { QualificationExecutionInputs } from "./qualification-execution-inputs";

export interface EventRecordPageCursorRow extends EventRecordRow {
  eventPk: number;
}

const STRING_VALUE = { kind: "scalar", scalar: "string" } as const;
const NUMBER_VALUE = { kind: "scalar", scalar: "number" } as const;
const DATETIME_VALUE = { kind: "scalar", scalar: "datetime" } as const;

export const EVENT_RECORD_PAGE_OUTPUT_TYPES: Readonly<
  Record<keyof EventRecordPageCursorRow, SemanticScalarValueType>
> = {
  eventPk: NUMBER_VALUE,
  eventId: STRING_VALUE,
  eventName: STRING_VALUE,
  occurredAt: DATETIME_VALUE,
  receivedAt: DATETIME_VALUE,
  sequence: NUMBER_VALUE,
  visitId: STRING_VALUE,
  sessionId: STRING_VALUE,
  visitorId: STRING_VALUE,
  pathname: STRING_VALUE,
  title: STRING_VALUE,
  hostname: STRING_VALUE,
  referrerHost: STRING_VALUE,
  country: STRING_VALUE,
  region: STRING_VALUE,
  city: STRING_VALUE,
  browser: STRING_VALUE,
  browserVersion: STRING_VALUE,
  os: STRING_VALUE,
  osVersion: STRING_VALUE,
  deviceType: STRING_VALUE,
  nodeCount: NUMBER_VALUE,
  valueCount: NUMBER_VALUE,
};

export { EVENT_RECORD_PAGE_OUTPUT_ID };

declare const eventRecordPageOutputBrand: unique symbol;

/** Row aliases were checked against the validated Logical output contract. */
export type EventRecordPageOutputRow = {
  readonly [K in keyof EventRecordPageCursorRow]: unknown;
} & { readonly [eventRecordPageOutputBrand]: true };

function failOutputContract(reason: string): never {
  throw new Error(`event_record_page_output_contract:${reason}`);
}

export function assertEventRecordPageOutputContract(
  plan: ValidatedLogicalPlan,
): void {
  const output = plan.outputs.find(
    (candidate) => candidate.id === EVENT_RECORD_PAGE_OUTPUT_ID,
  );
  if (!output) failOutputContract("missing_output");
  const outputRelation = plan.nodes.find((node) => node.id === output.relation);
  if (!outputRelation) failOutputContract("missing_output_relation");
  const relationSlots = new Set(outputRelation.output);
  const slots = new Map(plan.slots.map((slot) => [slot.id, slot] as const));
  const names = new Set<string>();
  const slotIds = new Set<SlotId>();
  for (const field of output.fields) {
    if (names.has(field.name))
      failOutputContract(`duplicate_alias:${field.name}`);
    names.add(field.name);
    if (!Object.hasOwn(EVENT_RECORD_PAGE_OUTPUT_TYPES, field.name))
      failOutputContract(`unexpected_alias:${field.name}`);
    const expected =
      EVENT_RECORD_PAGE_OUTPUT_TYPES[
        field.name as keyof EventRecordPageCursorRow
      ];
    const slot = slots.get(field.slot);
    if (!slot) failOutputContract(`missing_slot:${field.name}`);
    if (!relationSlots.has(field.slot))
      failOutputContract(`slot_not_in_output_relation:${field.name}`);
    if (slotIds.has(field.slot))
      failOutputContract(`duplicate_slot:${field.slot}`);
    slotIds.add(field.slot);
    if (
      slot.type.kind !== "scalar" ||
      slot.type.scalar !== expected.scalar ||
      slot.type.unit !== expected.unit
    )
      failOutputContract(
        `value_type:${field.name}:expected=${expected.scalar}${expected.unit ? `:${expected.unit}` : ""}`,
      );
  }
  for (const name of Object.keys(EVENT_RECORD_PAGE_OUTPUT_TYPES))
    if (!names.has(name)) failOutputContract(`missing_alias:${name}`);
}

export async function queryEventRecordPageOutputRowsFromD1(
  env: Env,
  plan: ValidatedLogicalPlan,
  qualificationExecutionInputs?: QualificationExecutionInputs,
): Promise<EventRecordPageOutputRow[]> {
  assertEventRecordPageOutputContract(plan);
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    EVENT_RECORD_PAGE_OUTPUT_ID,
    "event_record_page_output_missing",
    undefined,
    qualificationExecutionInputs,
  );
  return rows.map((row) => row as EventRecordPageOutputRow);
}
