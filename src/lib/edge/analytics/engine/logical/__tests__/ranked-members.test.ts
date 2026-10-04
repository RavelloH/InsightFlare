import { describe, expect, it } from "vitest";

import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
} from "@/lib/edge/analytics/contract/types";
import {
  type LogicalPlan,
  LogicalPlanBuilder,
  printLogicalPlan,
  validateLogicalPlan,
} from "@/lib/edge/analytics/engine/logical";
import { slotId } from "@/lib/edge/analytics/engine/logical/ids";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";

function createBuilder(): LogicalPlanBuilder {
  const candidate = {
    startMs: 0 as EpochMs,
    endExclusiveMs: 10_000 as EpochMs,
  };
  return new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: ["site-a" as SiteId],
    }),
    time: createSemanticTemporalDomains({
      candidate,
      read: { kind: "bounded", range: candidate },
      reportingTimeZone: "UTC" as ReportingTimeZone,
      capturedAtMs: 10_000 as EpochMs,
    }),
    scope: resolveAnalyticsScope("auto"),
  });
}

function rankedPlan() {
  const builder = createBuilder();
  const pages = builder.source("page", {
    attributes: [
      "page.report.pathname",
      "page.report.title",
      "page.report.startedAt",
    ],
  });
  const grouped = builder.aggregate(
    pages,
    {
      pathname: builder.slot(pages, "attribute:page.report.pathname"),
      title: builder.slot(pages, "attribute:page.report.title"),
    },
    [{ name: "views", kind: "count-rows" }],
  );
  const ranked = builder.rankedMembers(grouped, {
    groups: ["pathname"],
    order: [
      { slot: "views", direction: "desc", nulls: "last" },
      { slot: "title", direction: "asc", nulls: "first" },
    ],
  });
  builder.output("ranked", ranked, [
    { name: "pathname", slot: "pathname" },
    { name: "title", slot: "title" },
    { name: "rank", slot: "rank" },
  ]);
  return { builder, grouped, ranked, plan: builder.finish() };
}

describe("logical ranked-members and bucket-index", () => {
  it("adds a deterministic ordinal while retaining the full input grain and bag", () => {
    const { grouped, ranked, plan } = rankedPlan();
    const inputNode = plan.nodes.find((node) => node.id === grouped.id)!;
    const node = plan.nodes.find((item) => item.id === ranked.id);
    const rankSlot = plan.slots.find((slot) => slot.id === ranked.slots.rank);

    expect(node).toMatchObject({
      kind: "ranked-members",
      groups: [grouped.slots.pathname],
      order: [
        {
          slot: grouped.slots.views,
          direction: "desc",
          nulls: "last",
        },
        {
          slot: grouped.slots.title,
          direction: "asc",
          nulls: "first",
        },
      ],
      grain: grouped.grain,
    });
    expect(node?.output).toEqual([...inputNode.output, ranked.slots.rank]);
    expect(rankSlot).toMatchObject({
      type: { kind: "scalar", scalar: "number" },
      nullable: false,
      lineage: {
        kind: "derived",
        operation: "ranked-members",
        inputs: [
          grouped.slots.pathname,
          grouped.slots.views,
          grouped.slots.title,
        ],
      },
    });
    expect(printLogicalPlan(plan)).toContain("RankedMembers");
    expect(
      validateLogicalPlan(JSON.parse(JSON.stringify(plan)) as LogicalPlan),
    ).toEqual(plan);
  });

  it("rejects invalid rank grain, ordering, output, and rank slot declarations", () => {
    const { plan, ranked } = rankedPlan();
    const index = plan.nodes.findIndex((node) => node.id === ranked.id);
    const node = plan.nodes[index]!;

    const forgedOrder = {
      ...plan,
      nodes: plan.nodes.map((item, itemIndex) =>
        itemIndex === index && item.kind === "ranked-members"
          ? {
              ...item,
              order: [{ ...item.order[0]!, direction: "sideways" as never }],
            }
          : item,
      ),
    };
    expect(() => validateLogicalPlan(forgedOrder as LogicalPlan)).toThrow(
      "Ranked member order direction is invalid",
    );

    const forgedCoverage = {
      ...plan,
      nodes: plan.nodes.map((item, itemIndex) =>
        itemIndex === index && item.kind === "ranked-members"
          ? { ...item, order: [item.order[0]!] }
          : item,
      ),
    };
    expect(() => validateLogicalPlan(forgedCoverage as LogicalPlan)).toThrow(
      "cover the complete scalar input grain",
    );

    const forgedOutput = {
      ...plan,
      nodes: plan.nodes.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, output: item.output.slice(0, -1) }
          : item,
      ),
    };
    expect(() => validateLogicalPlan(forgedOutput as LogicalPlan)).toThrow(
      "Node output does not match derived visible slots",
    );

    const forgedRank = {
      ...plan,
      slots: plan.slots.map((slot) =>
        slot.id === ranked.slots.rank ? { ...slot, nullable: true } : slot,
      ),
    };
    expect(() => validateLogicalPlan(forgedRank as LogicalPlan)).toThrow(
      "Rank output must be a new non-null unitless numeric derived slot",
    );
    expect(node.kind).toBe("ranked-members");
  });

  it("exposes calendar bucket indexes as nullable unitless numbers only", () => {
    const builder = createBuilder();
    const pages = builder.source("page", {
      attributes: ["page.report.startedAt"],
    });
    const bucket = builder.timeBucket(
      builder.slot(pages, "attribute:page.report.startedAt"),
      "day",
    );
    const index = builder.bucketIndex(bucket);
    expect(index.type).toEqual({ kind: "scalar", scalar: "number" });
    expect(index.nullable).toBe(true);

    const projected = builder.project(pages, { bucketIndex: index });
    builder.output("bucket-index", projected, [
      { name: "bucketIndex", slot: "bucketIndex" },
    ]);
    const plan = builder.finish();
    expect(printLogicalPlan(plan)).toContain("BUCKET_INDEX(TIME_BUCKET(");

    const invalidBuilder = createBuilder();
    expect(() =>
      invalidBuilder.bucketIndex(
        invalidBuilder.literal(0, { kind: "scalar", scalar: "number" }),
      ),
    ).toThrow("Bucket indexes require a calendar bucket expression");
  });

  it("rejects source rows as ranked-member keyed inputs", () => {
    const builder = createBuilder();
    const pages = builder.source("page", {
      attributes: ["page.report.pathname", "page.report.title"],
    });
    expect(() =>
      builder.rankedMembers(pages, {
        groups: ["attribute:page.report.pathname"],
        order: [
          {
            slot: "attribute:page.report.title",
            direction: "asc",
            nulls: "last",
          },
        ],
      }),
    ).toThrow("logical_builder_ranked_members_requires_keyed_input");
  });
});
