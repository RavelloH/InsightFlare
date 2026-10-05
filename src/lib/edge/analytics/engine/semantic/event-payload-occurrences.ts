import type { LogicalValueType } from "./value-types";

export interface EventPayloadOccurrenceFieldDefinition {
  readonly type: LogicalValueType;
  readonly nullable: boolean;
}

/** Internal, finite schema for one stored custom Event payload occurrence. */
export const EVENT_PAYLOAD_OCCURRENCE_FIELDS = {
  path: {
    type: { kind: "scalar", scalar: "string" },
    nullable: false,
  },
  valueType: {
    type: { kind: "scalar", scalar: "number" },
    nullable: false,
  },
  occurredAt: {
    type: { kind: "scalar", scalar: "datetime" },
    nullable: false,
  },
  stringValue: {
    type: { kind: "scalar", scalar: "string" },
    nullable: true,
  },
  numberValue: {
    type: { kind: "scalar", scalar: "number" },
    nullable: true,
  },
  booleanValue: {
    type: { kind: "scalar", scalar: "number" },
    nullable: true,
  },
  internalEventKey: {
    type: { kind: "scalar", scalar: "number" },
    nullable: false,
  },
} as const satisfies Readonly<
  Record<string, EventPayloadOccurrenceFieldDefinition>
>;

export type EventPayloadOccurrenceField =
  keyof typeof EVENT_PAYLOAD_OCCURRENCE_FIELDS;

export function isEventPayloadOccurrenceField(
  value: string,
): value is EventPayloadOccurrenceField {
  return Object.hasOwn(EVENT_PAYLOAD_OCCURRENCE_FIELDS, value);
}
