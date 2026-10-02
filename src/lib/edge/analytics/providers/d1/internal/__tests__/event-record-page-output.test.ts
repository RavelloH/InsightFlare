import { describe, expect, it } from "vitest";

import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { buildEventRecordPagePlan } from "@/lib/edge/analytics/engine/event-record-page-plan";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import {
  assertEventRecordPageOutputContract,
  EVENT_RECORD_PAGE_OUTPUT_ID,
} from "@/lib/edge/analytics/providers/d1/internal/event-record-page-output";

const plan = buildEventRecordPagePlan({
  siteId: "event-record-output-site",
  queryTime: createQueryTime(0, 100, "UTC", 100),
  filters: EMPTY_FILTER_DOCUMENT,
  options: {
    limit: 20,
    sort: { key: "occurredAt", direction: "desc" },
  },
});

function withOutputFields(fields: readonly unknown[]): ValidatedLogicalPlan {
  return {
    ...plan,
    outputs: plan.outputs.map((output) =>
      output.id === EVENT_RECORD_PAGE_OUTPUT_ID
        ? { ...output, fields }
        : output,
    ),
  } as ValidatedLogicalPlan;
}

describe("event record page output contract", () => {
  it("accepts the logical page output schema", () => {
    expect(() => assertEventRecordPageOutputContract(plan)).not.toThrow();
  });

  it("rejects missing outputs, aliases, slots, and incompatible values", () => {
    const output = plan.outputs.find(
      (candidate) => candidate.id === EVENT_RECORD_PAGE_OUTPUT_ID,
    )!;
    const outputRelation = plan.nodes.find(
      (node) => node.id === output.relation,
    )!;
    const [first, second, ...rest] = output.fields;
    const offOutputSlot = plan.slots.find(
      (slot) => !outputRelation.output.includes(slot.id),
    )!;

    const cases: readonly [ValidatedLogicalPlan, string][] = [
      [
        { ...plan, outputs: [] } as ValidatedLogicalPlan,
        "event_record_page_output_contract:missing_output",
      ],
      [
        {
          ...plan,
          nodes: plan.nodes.map((node) =>
            node.id === output.relation
              ? { ...node, id: "missing-output-relation" }
              : node,
          ),
        } as ValidatedLogicalPlan,
        "event_record_page_output_contract:missing_output_relation",
      ],
      [
        withOutputFields([...output.fields, first!]),
        "event_record_page_output_contract:duplicate_alias:eventPk",
      ],
      [
        withOutputFields([{ ...first!, name: "unexpected" }, second!, ...rest]),
        "event_record_page_output_contract:unexpected_alias:unexpected",
      ],
      [
        withOutputFields([
          { ...first!, slot: "missing-slot" },
          second!,
          ...rest,
        ]),
        "event_record_page_output_contract:missing_slot:eventPk",
      ],
      [
        withOutputFields([
          { ...first!, slot: offOutputSlot.id },
          second!,
          ...rest,
        ]),
        "event_record_page_output_contract:slot_not_in_output_relation:eventPk",
      ],
      [
        withOutputFields([first!, { ...second!, slot: first!.slot }, ...rest]),
        `event_record_page_output_contract:duplicate_slot:${first!.slot}`,
      ],
      [
        withOutputFields([{ ...first!, slot: second!.slot }, second!, ...rest]),
        "event_record_page_output_contract:value_type:eventPk:expected=number",
      ],
      [
        withOutputFields([second!, ...rest]),
        "event_record_page_output_contract:missing_alias:eventPk",
      ],
    ];

    for (const [invalidPlan, message] of cases)
      expect(() => assertEventRecordPageOutputContract(invalidPlan)).toThrow(
        message,
      );
  });
});
