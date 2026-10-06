import { describe, expect, it } from "vitest";

import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
  TeamId,
} from "@/lib/edge/analytics/contract/types";
import {
  type LogicalPlan,
  LogicalPlanBuilder,
  LogicalPlanError,
  validateLogicalPlan,
} from "@/lib/edge/analytics/engine/logical";
import { slotId } from "@/lib/edge/analytics/engine/logical/ids";
import type { AnalysisResultNode } from "@/lib/edge/analytics/engine/logical/nodes";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import {
  createSemanticSubjectDomain,
  type SemanticSubjectDomain,
} from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";

const NUMBER = { kind: "scalar", scalar: "number" } as const;
const RATIO = { kind: "scalar", scalar: "number", unit: "ratio" } as const;

function context(
  siteId = "analysis-result-site",
  subject?: SemanticSubjectDomain,
) {
  const range = { startMs: 0, endExclusiveMs: 1_000 };
  return {
    subject:
      subject ??
      createSemanticSubjectDomain({
        origin: "site",
        siteIds: [siteId as SiteId],
      }),
    time: createSemanticTemporalDomains({
      candidate: range as never,
      read: { kind: "bounded", range: range as never },
      reportingTimeZone: "UTC" as ReportingTimeZone,
      capturedAtMs: 1_000 as EpochMs,
    }),
    scope: resolveAnalyticsScope("session"),
  };
}

function keyedChild(
  withKeyAlias = false,
  subject?: SemanticSubjectDomain,
): ValidatedLogicalPlan {
  const builder = new LogicalPlanBuilder(
    context("analysis-result-site", subject),
  );
  const pages = builder.source("page", { attributes: ["page.path"] });
  const grouped = builder.aggregate(
    pages,
    { key: builder.slot(pages, "attribute:page.path") },
    [{ name: "rows", kind: "count-rows" }],
  );
  builder.output("rollup", grouped, [
    { name: "key", slot: "key" },
    ...(withKeyAlias ? [{ name: "keyAlias", slot: "key" }] : []),
    { name: "rows", slot: "rows" },
  ]);
  return builder.finish();
}

function importingParent(
  child: ValidatedLogicalPlan,
  subject?: SemanticSubjectDomain,
): {
  readonly builder: LogicalPlanBuilder;
  readonly imported: ReturnType<LogicalPlanBuilder["importAnalysisResult"]>;
} {
  const builder = new LogicalPlanBuilder(
    context("analysis-result-site", subject),
  );
  const imported = builder.importAnalysisResult(child, "rollup", [
    { field: "key" },
    { field: "rows" },
  ]);
  builder.output("imported", imported, [
    { name: "key", slot: "key" },
    { name: "rows", slot: "rows" },
  ]);
  return { builder, imported };
}

function withAnalysisResultNode(
  plan: LogicalPlan,
  update: (node: AnalysisResultNode) => AnalysisResultNode,
): LogicalPlan {
  let found = false;
  const nodes = plan.nodes.map((node) => {
    if (node.kind !== "analysis-result") return node;
    found = true;
    return update(node);
  });
  if (!found) throw new Error("missing_analysis_result_node");
  return { ...plan, nodes };
}

function expectLogicalIssue(
  plan: LogicalPlan,
  expected: {
    readonly code: string;
    readonly path: string;
    readonly message: string;
  },
): void {
  try {
    validateLogicalPlan(plan);
  } catch (error) {
    expect(error).toBeInstanceOf(LogicalPlanError);
    expect((error as LogicalPlanError).issues).toEqual([expected]);
    return;
  }
  throw new Error("expected_logical_plan_error");
}

describe("Logical analysis-result imports", () => {
  it("snapshots a keyed child and remaps every key and scalar output", () => {
    const child = keyedChild();
    const { builder, imported } = importingParent(child);
    const plan = builder.finish();
    const node = plan.nodes.find((item) => item.kind === "analysis-result");

    expect(imported.grain.kind).toBe("keyed");
    expect(node?.kind).toBe("analysis-result");
    if (node?.kind !== "analysis-result") throw new Error("missing node");
    expect(node.output).toEqual(Object.values(imported.slots));
    expect(Object.isFrozen(node.childPlan)).toBe(true);
    expect(Object.isFrozen(node.childPlan.context.time.candidate)).toBe(true);
    expect(validateLogicalPlan(plan)).toBe(plan);
  });

  it("renames public fields while preserving keyed grain, types, nullability, and child provenance", () => {
    const child = keyedChild();
    const childOutput = child.outputs.find((output) => output.id === "rollup");
    if (!childOutput) throw new Error("missing child output");
    const builder = new LogicalPlanBuilder(context());
    const imported = builder.importAnalysisResult(child, "rollup", [
      { field: "key", as: "pathname" },
      { field: "rows", as: "pageViews" },
    ]);
    builder.output("renamed", imported, [
      { name: "path", slot: "pathname" },
      { name: "views", slot: "pageViews" },
    ]);
    const plan = builder.finish();
    const node = plan.nodes.find((item) => item.kind === "analysis-result");
    if (node?.kind !== "analysis-result") throw new Error("missing node");

    expect(imported.grain).toEqual({
      kind: "keyed",
      keys: [imported.slots.pathname],
    });
    expect(node.output).toEqual([
      imported.slots.pathname,
      imported.slots.pageViews,
    ]);
    expect(node.mappings).toEqual([
      { field: "key", slot: imported.slots.pathname },
      { field: "rows", slot: imported.slots.pageViews },
    ]);
    expect(
      node.childPlan.outputs.find((output) => output.id === "rollup"),
    ).toEqual(childOutput);
    for (const mapping of node.mappings) {
      const sourceField = childOutput.fields.find(
        (field) => field.name === mapping.field,
      );
      const sourceSlot = child.slots.find(
        (slot) => slot.id === sourceField?.slot,
      );
      const targetSlot = plan.slots.find((slot) => slot.id === mapping.slot);
      expect(sourceSlot).toBeDefined();
      expect(targetSlot).toBeDefined();
      expect(targetSlot?.type).toEqual(sourceSlot?.type);
      expect(targetSlot?.nullable).toBe(sourceSlot?.nullable);
      expect(targetSlot?.lineage).toEqual({
        kind: "analysis-result",
        relation: node.id,
        outputId: "rollup",
        field: mapping.field,
        sourceSlot: sourceField?.slot,
      });
    }
    expect(validateLogicalPlan(plan)).toBe(plan);

    expect(() =>
      new LogicalPlanBuilder(context()).importAnalysisResult(child, "rollup", [
        { field: "key", as: "shared" },
        { field: "rows", as: "shared" },
      ]),
    ).toThrow("logical_builder_duplicate_analysis_result_name");
    expect(() =>
      new LogicalPlanBuilder(context()).importAnalysisResult(child, "rollup", [
        { field: "key", as: "" },
      ]),
    ).toThrow("logical_builder_duplicate_analysis_result_name");
  });

  it("keeps a detached snapshot when the caller mutates its child plan", () => {
    const source = keyedChild();
    const mutable = structuredClone(source) as LogicalPlan;
    const { builder } = importingParent(mutable as ValidatedLogicalPlan);
    const childSource = mutable.nodes.find((node) => node.kind === "source");
    if (childSource?.kind !== "source") throw new Error("missing source");
    (childSource as { entity: "page" | "event" }).entity = "event";
    const plan = builder.finish();
    const child = plan.nodes.find((node) => node.kind === "analysis-result");

    expect(child?.kind).toBe("analysis-result");
    if (child?.kind !== "analysis-result") throw new Error("missing node");
    expect(
      child.childPlan.nodes.find((node) => node.kind === "source"),
    ).toMatchObject({
      kind: "source",
      entity: "page",
    });
  });

  it("rejects mismatched subjects, unknown outputs, and omitted keyed-grain keys", () => {
    const child = keyedChild();
    const wrongSubjectBuilder = new LogicalPlanBuilder(context("other-site"));
    expect(() =>
      wrongSubjectBuilder.importAnalysisResult(child, "rollup", [
        { field: "key" },
        { field: "rows" },
      ]),
    ).toThrow("subject_mismatch");

    const builder = new LogicalPlanBuilder(context());
    expect(() =>
      builder.importAnalysisResult(child, "missing", [{ field: "key" }]),
    ).toThrow("unknown_analysis_result_output");
    expect(() =>
      builder.importAnalysisResult(child, "rollup", [{ field: "rows" }]),
    ).toThrow("key_not_mapped");
    expect(() =>
      builder.importAnalysisResult(child, "rollup", [
        { field: "not-declared" },
      ]),
    ).toThrow("unknown_analysis_result_field");

    const teamA = createSemanticSubjectDomain({
      origin: "team",
      teamId: "team-a" as TeamId,
      siteIds: ["analysis-result-site" as SiteId],
    });
    const teamB = createSemanticSubjectDomain({
      origin: "team",
      teamId: "team-b" as TeamId,
      siteIds: ["analysis-result-site" as SiteId],
    });
    const teamChild = keyedChild(false, teamA);
    expect(() =>
      new LogicalPlanBuilder(
        context("analysis-result-site", teamB),
      ).importAnalysisResult(teamChild, "rollup", [
        { field: "key" },
        { field: "rows" },
      ]),
    ).toThrow("subject_mismatch");
    expect(() =>
      new LogicalPlanBuilder(context()).importAnalysisResult(
        teamChild,
        "rollup",
        [{ field: "key" }, { field: "rows" }],
      ),
    ).toThrow("subject_mismatch");

    const explicitUndefinedTeamId = {
      ...createSemanticSubjectDomain({
        origin: "site",
        siteIds: ["analysis-result-site" as SiteId],
      }),
      teamId: undefined,
    } as SemanticSubjectDomain;
    expect(() =>
      new LogicalPlanBuilder(
        context("analysis-result-site", explicitUndefinedTeamId),
      ).importAnalysisResult(child, "rollup", [
        { field: "key" },
        { field: "rows" },
      ]),
    ).toThrow("subject_mismatch");
  });

  it("imports scalar report outputs without inventing keyed grain", () => {
    const childBuilder = new LogicalPlanBuilder(context());
    const pages = childBuilder.source("page");
    const total = childBuilder.aggregate(pages, {}, [
      { name: "rows", kind: "count-rows" },
    ]);
    childBuilder.output("scalar", total, [{ name: "rows", slot: "rows" }]);
    const child = childBuilder.finish();
    const parentBuilder = new LogicalPlanBuilder(context());
    const imported = parentBuilder.importAnalysisResult(child, "scalar", [
      { field: "rows" },
    ]);
    parentBuilder.output("scalar-import", imported, [
      { name: "rows", slot: "rows" },
    ]);
    const plan = parentBuilder.finish();
    expect(imported.grain).toEqual({ kind: "scalar" });
    expect(validateLogicalPlan(plan)).toBe(plan);
  });

  it("rejects entity, bag, and nested analysis results", () => {
    const entityBuilder = new LogicalPlanBuilder(context());
    const page = entityBuilder.source("page");
    entityBuilder.output("entity", page, [{ name: "page", slot: "entity" }]);
    const entity = entityBuilder.finish();
    expect(() =>
      new LogicalPlanBuilder(context()).importAnalysisResult(entity, "entity", [
        { field: "page" },
      ]),
    ).toThrow(/scalar/u);

    const bagBuilder = new LogicalPlanBuilder(context());
    const pages = bagBuilder.source("page", { attributes: ["page.path"] });
    const firstProjection = bagBuilder.project(pages, {
      value: bagBuilder.slot(pages, "attribute:page.path"),
    });
    const second = bagBuilder.project(pages, {
      value: bagBuilder.slot(pages, "attribute:page.path"),
    });
    const bag = bagBuilder.appendRows([firstProjection, second], ["value"]);
    bagBuilder.output("bag", bag, [{ name: "value", slot: "value" }]);
    const bagPlan = bagBuilder.finish();
    expect(() =>
      new LogicalPlanBuilder(context()).importAnalysisResult(bagPlan, "bag", [
        { field: "value" },
      ]),
    ).toThrow("scalar_or_keyed_grain");

    const first = importingParent(keyedChild()).builder.finish();
    expect(() =>
      new LogicalPlanBuilder(context()).importAnalysisResult(
        first,
        "imported",
        [{ field: "key" }, { field: "rows" }],
      ),
    ).toThrow("nested_analysis_result_unsupported");
  });

  it("revalidates field provenance and rejects cyclic imported plan graphs", () => {
    const { builder } = importingParent(keyedChild());
    const parent = builder.finish();
    const imported = parent.nodes.find(
      (node) => node.kind === "analysis-result",
    );
    if (imported?.kind !== "analysis-result") throw new Error("missing node");
    const targetSlot = imported.mappings[0]!.slot;
    const forged: LogicalPlan = {
      ...parent,
      slots: parent.slots.map((slot) =>
        slot.id === targetSlot ? { ...slot, type: NUMBER } : slot,
      ),
    };
    expect(() => validateLogicalPlan(forged)).toThrow(
      /type, unit, and nullability/u,
    );

    const rowSlot = imported.mappings.find(
      (mapping) => mapping.field === "rows",
    )?.slot;
    if (!rowSlot) throw new Error("missing imported measure slot");
    const forgedUnit: LogicalPlan = {
      ...parent,
      slots: parent.slots.map((slot) =>
        slot.id === rowSlot ? { ...slot, type: RATIO } : slot,
      ),
    };
    expect(() => validateLogicalPlan(forgedUnit)).toThrow(
      /type, unit, and nullability/u,
    );
    const forgedNullability: LogicalPlan = {
      ...parent,
      slots: parent.slots.map((slot) =>
        slot.id === rowSlot ? { ...slot, nullable: true } : slot,
      ),
    };
    expect(() => validateLogicalPlan(forgedNullability)).toThrow(
      /type, unit, and nullability/u,
    );

    const cyclic: any = { ...parent, nodes: [] };
    cyclic.nodes = parent.nodes.map((node) =>
      node.kind === "analysis-result" ? { ...node, childPlan: cyclic } : node,
    );
    expect(() => validateLogicalPlan(cyclic)).toThrow(
      "object graph must be acyclic",
    );

    const childSubjectMismatch = structuredClone(parent) as LogicalPlan;
    const importedCopy = childSubjectMismatch.nodes.find(
      (node) => node.kind === "analysis-result",
    );
    if (importedCopy?.kind !== "analysis-result")
      throw new Error("missing copied analysis result");
    const changedChild = structuredClone(importedCopy.childPlan) as LogicalPlan;
    (changedChild as { context: LogicalPlan["context"] }).context = {
      ...changedChild.context,
      subject: createSemanticSubjectDomain({
        origin: "site",
        siteIds: ["other-site" as SiteId],
      }),
    };
    const forgedSubject: LogicalPlan = {
      ...childSubjectMismatch,
      nodes: childSubjectMismatch.nodes.map((node) =>
        node.id === importedCopy.id
          ? { ...node, childPlan: changedChild }
          : node,
      ),
    };
    expect(() => validateLogicalPlan(forgedSubject)).toThrow(
      /exact same Semantic subject/u,
    );
  });

  it("revalidates one-to-one child source mappings when a child declares aliases", () => {
    const child = keyedChild(true);
    expect(() =>
      new LogicalPlanBuilder(context()).importAnalysisResult(child, "rollup", [
        { field: "key" },
        { field: "keyAlias" },
        { field: "rows" },
      ]),
    ).toThrow("duplicate_analysis_result_source_slot");

    const { builder } = importingParent(child);
    const parent = builder.finish();
    const imported = parent.nodes.find(
      (node) => node.kind === "analysis-result",
    );
    if (imported?.kind !== "analysis-result") throw new Error("missing node");
    const childOutput = imported.childPlan.outputs.find(
      (output) => output.id === imported.outputId,
    );
    const aliasSource = childOutput?.fields.find(
      (field) => field.name === "keyAlias",
    );
    const existingTarget = parent.slots.find(
      (slot) => slot.id === imported.mappings[0]!.slot,
    );
    if (!aliasSource || !existingTarget)
      throw new Error("missing forged mapping source");
    const aliasSlotId = slotId(
      Math.max(...parent.slots.map((slot) => slot.id)) + 1,
    );
    const aliasSlot = {
      ...existingTarget,
      id: aliasSlotId,
      lineage: {
        ...existingTarget.lineage,
        field: "keyAlias",
        sourceSlot: aliasSource.slot,
      },
    };
    const forged: LogicalPlan = {
      ...parent,
      slots: [...parent.slots, aliasSlot],
      nodes: parent.nodes.map((node) => {
        if (node.id !== imported.id || node.kind !== "analysis-result")
          return node;
        return {
          ...node,
          mappings: [
            ...node.mappings,
            { field: "keyAlias", slot: aliasSlotId },
          ],
          output: [...node.output, aliasSlotId],
        };
      }),
    };
    expect(() => validateLogicalPlan(forged)).toThrow(/one-to-one/u);
  });

  it("independently rejects forged analysis-result output, field, target, provenance, and key mappings", () => {
    const base = importingParent(keyedChild()).builder.finish();
    const baseNodeIndex = base.nodes.findIndex(
      (node) => node.kind === "analysis-result",
    );
    if (baseNodeIndex < 0) throw new Error("missing analysis result");
    const baseNode = base.nodes[baseNodeIndex];
    if (baseNode?.kind !== "analysis-result")
      throw new Error("missing analysis result");
    const keySlot = baseNode.mappings.find(
      (mapping) => mapping.field === "key",
    )?.slot;
    if (keySlot === undefined) throw new Error("missing key mapping");
    const path = `nodes[${baseNodeIndex}]`;

    expectLogicalIssue(
      withAnalysisResultNode(base, (node) => ({ ...node, outputId: "" })),
      {
        code: "invalid-topology",
        path,
        message: "Analysis result output and field mappings are required.",
      },
    );
    expectLogicalIssue(
      withAnalysisResultNode(base, (node) => ({ ...node, mappings: [] })),
      {
        code: "invalid-topology",
        path,
        message: "Analysis result output and field mappings are required.",
      },
    );
    expectLogicalIssue(
      withAnalysisResultNode(base, (node) => ({
        ...node,
        outputId: "undeclared-output",
      })),
      {
        code: "invalid-output",
        path: `${path}.outputId`,
        message: "Analysis result must reference a declared child output.",
      },
    );
    expectLogicalIssue(
      withAnalysisResultNode(base, (node) => ({
        ...node,
        mappings: node.mappings.map((mapping, index) =>
          index === 0 ? { ...mapping, field: "unknown-field" } : mapping,
        ),
      })),
      {
        code: "invalid-output",
        path: `${path}.mappings[0].field`,
        message:
          "Mapping must name a scalar field of the declared child output.",
      },
    );

    const undeclaredSlot = slotId(
      Math.max(...base.slots.map((slot) => slot.id)) + 1,
    );
    expectLogicalIssue(
      withAnalysisResultNode(base, (node) => ({
        ...node,
        mappings: node.mappings.map((mapping, index) =>
          index === 0 ? { ...mapping, slot: undeclaredSlot } : mapping,
        ),
      })),
      {
        code: "invisible-slot",
        path: `${path}.mappings[0].slot`,
        message: "Mapped parent slot is not declared.",
      },
    );

    const forgedProvenance: LogicalPlan = {
      ...base,
      slots: base.slots.map((slot) =>
        slot.id === keySlot && slot.lineage.kind === "analysis-result"
          ? { ...slot, lineage: { ...slot.lineage, field: "forged-field" } }
          : slot,
      ),
    };
    expectLogicalIssue(forgedProvenance, {
      code: "invalid-output",
      path: `${path}.mappings[0].slot`,
      message:
        "Imported slot provenance does not match the declared child output.",
    });

    expectLogicalIssue(
      withAnalysisResultNode(base, (node) => ({
        ...node,
        mappings: node.mappings.filter((mapping) => mapping.field !== "key"),
        output: node.output.filter((slot) => slot !== keySlot),
      })),
      {
        code: "invalid-grain",
        path: `${path}.mappings`,
        message: "Every child keyed-grain key must be declared and mapped.",
      },
    );
  });

  it("rejects a valid keyed time-bucket child at both public import boundaries", () => {
    const childBuilder = new LogicalPlanBuilder(context());
    const pages = childBuilder.source("page", {
      attributes: ["page.report.startedAt"],
    });
    const grouped = childBuilder.aggregate(
      pages,
      {
        day: childBuilder.timeBucket(
          childBuilder.slot(pages, "attribute:page.report.startedAt"),
          "day",
        ),
      },
      [{ name: "rows", kind: "count-rows" }],
    );
    childBuilder.output("bucketed", grouped, [
      { name: "day", slot: "day" },
      { name: "rows", slot: "rows" },
    ]);
    const bucketChild = childBuilder.finish();
    const childOutput = bucketChild.outputs.find(
      (output) => output.id === "bucketed",
    );
    if (!childOutput) throw new Error("missing bucket output");
    const childKey = childOutput.fields.find((field) => field.name === "day");
    if (!childKey) throw new Error("missing bucket key");
    expect(
      bucketChild.nodes.find((node) => node.id === childOutput.relation),
    ).toMatchObject({
      kind: "aggregate",
      grain: { kind: "keyed", keys: [childKey.slot] },
    });
    expect(
      bucketChild.slots.find((slot) => slot.id === childKey.slot)?.type,
    ).toMatchObject({
      kind: "bucket",
    });

    expect(() =>
      new LogicalPlanBuilder(context()).importAnalysisResult(
        bucketChild,
        "bucketed",
        [{ field: "day" }, { field: "rows" }],
      ),
    ).toThrow("logical_builder_analysis_result_fields_must_be_scalar");

    const base = importingParent(keyedChild()).builder.finish();
    const index = base.nodes.findIndex(
      (node) => node.kind === "analysis-result",
    );
    if (index < 0) throw new Error("missing analysis result");
    const forgedBucketChild = withAnalysisResultNode(base, (node) => ({
      ...node,
      childPlan: bucketChild,
      outputId: "bucketed",
    }));
    expectLogicalIssue(forgedBucketChild, {
      code: "invalid-grain",
      path: `nodes[${index}].childPlan.outputs`,
      message: "Every imported child output field must be scalar.",
    });
  });
});
