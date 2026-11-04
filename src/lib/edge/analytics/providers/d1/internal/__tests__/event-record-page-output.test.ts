import { describe, expect, it } from "vitest";

import type { EventRecordSortKey } from "@/lib/edge/analytics/contract";
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

  it.each([
    ["occurredAt", "asc", "event.report.occurredAt", ["asc", "asc", "asc"]],
    ["occurredAt", "desc", "event.report.occurredAt", ["desc", "desc", "desc"]],
    [
      "eventName",
      "asc",
      "event.report.eventName",
      ["asc", "desc", "desc", "desc"],
    ],
    [
      "eventName",
      "desc",
      "event.report.eventName",
      ["desc", "desc", "desc", "desc"],
    ],
    [
      "pathname",
      "asc",
      "event.report.ownerPathname",
      ["asc", "desc", "desc", "desc"],
    ],
    [
      "pathname",
      "desc",
      "event.report.ownerPathname",
      ["desc", "desc", "desc", "desc"],
    ],
  ] as const)(
    "keeps the original %s %s page order in the shared appender",
    (key, direction, firstAttribute, expectedDirections) => {
      const sortedPlan = buildEventRecordPagePlan({
        siteId: "event-record-output-site",
        queryTime: createQueryTime(0, 100, "UTC", 100),
        filters: EMPTY_FILTER_DOCUMENT,
        options: {
          limit: 3,
          sort: { key: key as EventRecordSortKey, direction },
        },
      });
      assertEventRecordPageOutputContract(sortedPlan);
      const sortNode = sortedPlan.nodes.find((node) => node.kind === "sort");
      expect(sortNode?.kind).toBe("sort");
      if (sortNode?.kind !== "sort")
        throw new Error("event_record_sort_missing");
      const slots = new Map(sortedPlan.slots.map((slot) => [slot.id, slot]));
      expect(
        sortNode.keys.map((sortKey) => {
          const slot = slots.get(sortKey.slot);
          return {
            attribute:
              slot?.lineage.kind === "attribute"
                ? slot.lineage.attribute
                : null,
            direction: sortKey.direction,
          };
        }),
      ).toEqual([
        { attribute: firstAttribute, direction: expectedDirections[0] },
        ...(key === "occurredAt"
          ? [
              {
                attribute: "event.report.localId",
                direction: expectedDirections[1],
              },
              {
                attribute: "event.report.internalPk",
                direction: expectedDirections[2],
              },
            ]
          : [
              {
                attribute: "event.report.occurredAt",
                direction: expectedDirections[1],
              },
              {
                attribute: "event.report.localId",
                direction: expectedDirections[2],
              },
              {
                attribute: "event.report.internalPk",
                direction: expectedDirections[3],
              },
            ]),
      ]);
    },
  );
});
