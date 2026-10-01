import type { SlotId } from "@/lib/edge/analytics/engine/logical/ids";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { SemanticScalarValueType } from "@/lib/edge/analytics/engine/semantic/value-types";
import { queryAnalyticsReportOutputRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import type { Env } from "@/lib/edge/types";

import type { EventRecordRow } from "./core";

export interface EventRecordDetailRow extends EventRecordRow {
  userId: string;
  userName: string;
  queryString: string;
  hash: string;
  referrerUrl: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmTerm: string;
  utmContent: string;
  isEU: number | boolean | string | null;
  regionCode: string;
  continent: string;
  latitude: number | null;
  longitude: number | null;
  postalCode: string;
  metroCode: string;
  timezone: string;
  organization: string;
  language: string;
  userAgent: string;
  screenWidth: number | null;
  screenHeight: number | null;
  status: string;
  startedAt: number;
  previousVisitId: string;
  previousVisitStartedAt: number | null;
  lastActivityAt: number;
  endedAt: number | null;
  finalizedAt: number | null;
  durationMs: number | null;
  durationSource: string;
  exitReason: string;
  perfTtfbMs: number | null;
  perfFcpMs: number | null;
  perfLcpMs: number | null;
  perfCls: number | null;
  perfInpMs: number | null;
}

const STRING_VALUE = { kind: "scalar", scalar: "string" } as const;
const NUMBER_VALUE = { kind: "scalar", scalar: "number" } as const;
const DATETIME_VALUE = { kind: "scalar", scalar: "datetime" } as const;
const NUMBER_MS_VALUE = {
  kind: "scalar",
  scalar: "number",
  unit: "ms",
} as const;
const NUMBER_PX_VALUE = {
  kind: "scalar",
  scalar: "number",
  unit: "px",
} as const;
const NUMBER_RATIO_VALUE = {
  kind: "scalar",
  scalar: "number",
  unit: "ratio",
} as const;

// This exact key map ties every legacy detail field to the expected output slot
// metadata. Nullability is deliberately excluded: owner presence is filtered in
// this report, but the logical LEFT relationship is not globally refined.
const EVENT_RECORD_DETAIL_OUTPUT_TYPES: {
  readonly [K in keyof EventRecordDetailRow]: SemanticScalarValueType;
} = {
  eventId: STRING_VALUE,
  eventName: STRING_VALUE,
  occurredAt: DATETIME_VALUE,
  receivedAt: DATETIME_VALUE,
  sequence: NUMBER_VALUE,
  visitId: STRING_VALUE,
  sessionId: STRING_VALUE,
  visitorId: STRING_VALUE,
  userId: STRING_VALUE,
  userName: STRING_VALUE,
  status: STRING_VALUE,
  startedAt: DATETIME_VALUE,
  previousVisitId: STRING_VALUE,
  previousVisitStartedAt: DATETIME_VALUE,
  lastActivityAt: DATETIME_VALUE,
  endedAt: DATETIME_VALUE,
  finalizedAt: DATETIME_VALUE,
  durationMs: NUMBER_MS_VALUE,
  durationSource: STRING_VALUE,
  exitReason: STRING_VALUE,
  pathname: STRING_VALUE,
  queryString: STRING_VALUE,
  hash: STRING_VALUE,
  title: STRING_VALUE,
  hostname: STRING_VALUE,
  referrerUrl: STRING_VALUE,
  referrerHost: STRING_VALUE,
  utmSource: STRING_VALUE,
  utmMedium: STRING_VALUE,
  utmCampaign: STRING_VALUE,
  utmTerm: STRING_VALUE,
  utmContent: STRING_VALUE,
  isEU: NUMBER_VALUE,
  country: STRING_VALUE,
  region: STRING_VALUE,
  regionCode: STRING_VALUE,
  city: STRING_VALUE,
  continent: STRING_VALUE,
  latitude: NUMBER_VALUE,
  longitude: NUMBER_VALUE,
  postalCode: STRING_VALUE,
  metroCode: STRING_VALUE,
  timezone: STRING_VALUE,
  organization: STRING_VALUE,
  browser: STRING_VALUE,
  browserVersion: STRING_VALUE,
  os: STRING_VALUE,
  osVersion: STRING_VALUE,
  deviceType: STRING_VALUE,
  userAgent: STRING_VALUE,
  language: STRING_VALUE,
  screenWidth: NUMBER_PX_VALUE,
  screenHeight: NUMBER_PX_VALUE,
  perfTtfbMs: NUMBER_MS_VALUE,
  perfFcpMs: NUMBER_MS_VALUE,
  perfLcpMs: NUMBER_MS_VALUE,
  perfCls: NUMBER_RATIO_VALUE,
  perfInpMs: NUMBER_MS_VALUE,
  nodeCount: NUMBER_VALUE,
  valueCount: NUMBER_VALUE,
};

export const EVENT_RECORD_DETAIL_OUTPUT_ID = "event-record-detail";

declare const eventRecordDetailOutputBrand: unique symbol;

/** Output aliases proven by the report contract; values remain raw SQLite data. */
export type EventRecordDetailOutputRow = {
  readonly [K in keyof EventRecordDetailRow]: unknown;
} & { readonly [eventRecordDetailOutputBrand]: true };

function failOutputContract(reason: string): never {
  throw new Error(`event_record_detail_output_contract:${reason}`);
}

/** Checks the selected output's complete aliases and logical slot metadata. */
export function assertEventRecordDetailOutputContract(
  plan: ValidatedLogicalPlan,
): void {
  const output = plan.outputs.find(
    (candidate) => candidate.id === EVENT_RECORD_DETAIL_OUTPUT_ID,
  );
  if (!output) failOutputContract("missing_output");

  const outputRelation = plan.nodes.find((node) => node.id === output.relation);
  if (!outputRelation) failOutputContract("missing_output_relation");
  const relationSlots = new Set(outputRelation.output);
  const slots = new Map(plan.slots.map((slot) => [slot.id, slot]));
  const names = new Set<string>();
  const slotIds = new Set<SlotId>();

  for (const field of output.fields) {
    if (names.has(field.name))
      failOutputContract(`duplicate_alias:${field.name}`);
    names.add(field.name);
    if (!Object.hasOwn(EVENT_RECORD_DETAIL_OUTPUT_TYPES, field.name))
      failOutputContract(`unexpected_alias:${field.name}`);

    const expected =
      EVENT_RECORD_DETAIL_OUTPUT_TYPES[
        field.name as keyof EventRecordDetailRow
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

  for (const name of Object.keys(EVENT_RECORD_DETAIL_OUTPUT_TYPES)) {
    if (!names.has(name)) failOutputContract(`missing_alias:${name}`);
  }
}

/** Validates the Event detail output shape before compiling or executing SQL. */
export async function queryEventRecordDetailOutputRowsFromD1(
  env: Env,
  plan: ValidatedLogicalPlan,
): Promise<EventRecordDetailOutputRow[]> {
  assertEventRecordDetailOutputContract(plan);
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    EVENT_RECORD_DETAIL_OUTPUT_ID,
    "event_record_detail_output_missing",
  );
  return rows.map((row) => row as EventRecordDetailOutputRow);
}
