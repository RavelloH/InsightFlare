import { describe, expect, it } from "vitest";

import {
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { LogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { semanticSubjectFromQuerySubject } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";

function fixture() {
  const context = siteQueryContext("source-program-site", "private-dashboard");
  const time = createQueryTime(0, 100, "UTC", 100);
  const prepared = prepareScopedQuery("event-records", {
    context,
    time,
    filters: EMPTY_FILTER_DOCUMENT,
    scopePreference: "session",
  });
  const logicalContext = {
    subject: semanticSubjectFromQuerySubject(context.subject),
    time: semanticTemporalDomainsFromQueryTime(time),
    scope: resolveAnalyticsScope("session"),
  };
  const producer = new LogicalPlanBuilder(logicalContext);
  const pages = producer.source("page");
  const projected = producer.project(pages, {
    siteId: producer.literal("source-program-site", {
      kind: "scalar",
      scalar: "string",
    }),
    memberId: producer.literal("session-a", {
      kind: "scalar",
      scalar: "string",
    }),
  });
  const identities = producer.distinct(projected, [
    { input: "siteId", output: "siteId" },
    { input: "memberId", output: "memberId" },
  ]);
  producer.output("identities", identities, [
    { name: "siteId", slot: "siteId" },
    { name: "memberId", slot: "memberId" },
  ]);
  const child = producer.finish();
  const builder = new LogicalPlanBuilder(logicalContext);
  const imported = builder.importProgramAnalysisResult(child, "identities", [
    { field: "siteId" },
    { field: "memberId" },
  ]);
  const membership = {
    input: imported.id,
    role: "entity" as const,
    siteId: imported.slots.siteId!,
    memberId: imported.slots.memberId!,
  };
  const selection = createSemanticScopedSourceSelection(
    {
      profile: "prepared-scoped-v1",
      filters: prepared.filters!,
      expectedPlan: prepared.scopePlan!,
      subject: logicalContext.subject,
      time: logicalContext.time,
    },
    [membership],
  );
  const source = builder.source("event", {
    selection,
    membershipInputs: [
      {
        relation: imported,
        role: "entity",
        siteId: "siteId",
        memberId: "memberId",
      },
    ],
  });
  builder.output("events", source, [{ name: "event", slot: "entity" }]);
  return { child, builder, plan: builder.finish() };
}

function changeSource(
  plan: LogicalPlan,
  update: (
    node: Extract<LogicalPlan["nodes"][number], { kind: "source" }>,
  ) => Extract<LogicalPlan["nodes"][number], { kind: "source" }>,
): LogicalPlan {
  return {
    ...plan,
    nodes: plan.nodes.map((node) =>
      node.kind === "source" ? update(node) : node,
    ),
  };
}

describe("explicit program Source dependencies", () => {
  it("keeps the actual producer identity in a visible program edge", () => {
    const { child, plan } = fixture();
    const imported = plan.nodes.find(
      (node) => node.kind === "analysis-result",
    )!;
    expect(imported.childPlan).toBe(child);
    expect(imported.execution).toBe("program");
    const source = plan.nodes.find((node) => node.kind === "source")!;
    expect(source.membershipInputs?.[0]?.input).toBe(imported.id);
    expect(source.selection?.preparedMembership).toBeUndefined();
    expect(source.selection?.qualificationDependencyRefs).toBeUndefined();
  });

  it("rejects a Source edge pointing to a missing predecessor", () => {
    const { plan } = fixture();
    expect(() =>
      validateLogicalPlan(
        changeSource(plan, (node) => ({
          ...node,
          membershipInputs: node.membershipInputs!.map((input) => ({
            ...input,
            input: node.id,
          })),
        })),
      ),
    ).toThrow();
  });

  it("rejects aliased identity keys and duplicate roles", () => {
    const { plan } = fixture();
    expect(() =>
      validateLogicalPlan(
        changeSource(plan, (node) => ({
          ...node,
          membershipInputs: node.membershipInputs!.map((input) => ({
            ...input,
            memberId: input.siteId,
          })),
        })),
      ),
    ).toThrow("deduplicated site and member keys");
    expect(() =>
      validateLogicalPlan(
        changeSource(plan, (node) => ({
          ...node,
          membershipInputs: [
            node.membershipInputs![0]!,
            node.membershipInputs![0]!,
          ],
        })),
      ),
    ).toThrow("roles must be unique");
  });

  it("preserves detached snapshots for ordinary analysis imports", () => {
    const { child, builder } = fixture();
    const imported = builder.importAnalysisResult(child, "identities", [
      { field: "siteId" },
      { field: "memberId" },
    ]);
    const plan = builder.finish();
    const node = plan.nodes.find((candidate) => candidate.id === imported.id)!;
    expect(node.kind).toBe("analysis-result");
    if (node.kind !== "analysis-result") throw new Error("import missing");
    expect(node.childPlan).not.toBe(child);
    expect(Object.isFrozen(node.childPlan)).toBe(true);
    expect(node.execution).toBeUndefined();
  });
});
