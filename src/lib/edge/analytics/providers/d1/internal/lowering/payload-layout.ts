import type { LogicalValueType } from "@/lib/edge/analytics/engine/semantic/value-types";

/** Provider-only physical facts retained by selected payload node carriers. */
export const EVENT_PAYLOAD_NODE_FIELDS = {
  eventKey: { type: { kind: "entity", entity: "event" }, nullable: false },
  eventPk: { type: { kind: "scalar", scalar: "number" }, nullable: false },
  nodeId: { type: { kind: "scalar", scalar: "number" }, nullable: false },
  parentNodeId: { type: { kind: "scalar", scalar: "number" }, nullable: true },
  key: { type: { kind: "scalar", scalar: "string" }, nullable: true },
  path: { type: { kind: "scalar", scalar: "string" }, nullable: false },
  valueType: { type: { kind: "scalar", scalar: "number" }, nullable: false },
  arrayIndex: { type: { kind: "scalar", scalar: "number" }, nullable: true },
  stringValue: { type: { kind: "scalar", scalar: "string" }, nullable: true },
  numberValue: { type: { kind: "scalar", scalar: "number" }, nullable: true },
  booleanValue: { type: { kind: "scalar", scalar: "boolean" }, nullable: true },
  valueCompatible: {
    type: { kind: "scalar", scalar: "boolean" },
    nullable: false,
  },
} as const satisfies Readonly<
  Record<
    string,
    {
      readonly type: LogicalValueType;
      readonly nullable: boolean;
    }
  >
>;

export type EventPayloadNodeField = keyof typeof EVENT_PAYLOAD_NODE_FIELDS;
