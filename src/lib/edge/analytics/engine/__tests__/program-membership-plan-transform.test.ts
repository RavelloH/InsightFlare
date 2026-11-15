// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { TeamId } from "@/lib/edge/analytics/contract/types";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { SourceNode } from "@/lib/edge/analytics/engine/logical/nodes";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import { transformQualifiedPageProgramSources } from "@/lib/edge/analytics/engine/program-membership-plan-transform";
import type { ProgramMembershipOutput } from "@/lib/edge/analytics/engine/program-membership-source";
import { buildReferrerSummaryPlan } from "@/lib/edge/analytics/engine/referrer-report-plan";
import { pageRoleDependencyRefs } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const STRING = { kind: "scalar", scalar: "string" } as const;
const SITE = "program-transform-site";

function fixture(scope: "session" | "visitor" = "session") {
  const time = createQueryTime(100, 200, "UTC", 300);
  const prepared = prepareScopedQuery("pages", {
    context: siteQueryContext(SITE, "private-dashboard"),
    time,
    filters: parseFilterDsl("count(page) gt 0", analyticsFilterRegistry),
    scopePreference: scope,
  });
  if (!prepared.filters) throw Error("expected_prepared_filters");
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!metadata) throw Error("expected_actual_metadata");
  const common = {
    siteId: SITE,
    queryTime: time,
    filters: prepared.filters,
    scopePlan: metadata.plan,
    qualificationDependencyRefs: pageRoleDependencyRefs(metadata.plan),
  };
  return {
    common,
    canonical: buildReferrerSummaryPlan({ ...common, topN: 3 }),
  };
}

function producer(
  canonical: ValidatedLogicalPlan,
  kinded: boolean,
  teamId?: TeamId,
): ProgramMembershipOutput {
  const builder = new LogicalPlanBuilder({
    ...canonical.context,
    // F is deliberately distinct from the canonical reader's R.
    time: semanticTemporalDomainsFromQueryTime(
      createQueryTime(0, 100, "UTC", 300),
    ),
    subject: teamId
      ? createSemanticSubjectDomain({ ...canonical.context.subject, teamId })
      : canonical.context.subject,
  });
  const pages = builder.source("page");
  const fields = kinded
    ? ["site_id", "match_kind", "match_id"]
    : ["site_id", "entity_id"];
  const projected = builder.project(
    pages,
    Object.fromEntries(
      fields.map((name) => [
        name,
        builder.literal(
          name === "site_id"
            ? SITE
            : name === "match_kind"
              ? "entity"
              : "member-a",
          STRING,
        ),
      ]),
    ),
  );
  const identities = builder.distinct(
    projected,
    fields.map((input) => ({ input })),
  );
  builder.output(
    "whole-identities",
    identities,
    fields.map((name) => ({ name, slot: name })),
  );
  const plan = builder.finish();
  const output = plan.outputs[0];
  if (!output) throw Error("expected_actual_output");
  return { plan, output };
}

function sources(plan: ValidatedLogicalPlan): SourceNode[] {
  return plan.nodes.filter(
    (node): node is SourceNode => node.kind === "source",
  );
}

function expectPreserved(
  canonical: ValidatedLogicalPlan,
  converted: ValidatedLogicalPlan,
  actual: ProgramMembershipOutput,
) {
  expect(converted.outputs).toBe(canonical.outputs);
  expect(converted.slots.slice(0, canonical.slots.length)).toEqual(
    canonical.slots,
  );
  for (const [index, slot] of canonical.slots.entries())
    expect(converted.slots[index]).toBe(slot);
  expect(
    converted.nodes.slice(-canonical.nodes.length).map((node) => node.id),
  ).toEqual(canonical.nodes.map((node) => node.id));
  for (const original of canonical.nodes) {
    const result = converted.nodes.find((node) => node.id === original.id);
    if (original.kind !== "source") {
      expect(result).toBe(original);
      continue;
    }
    if (
      !result ||
      result.kind !== "source" ||
      !result.selection ||
      !original.selection
    )
      throw Error("expected_converted_source");
    const { selection: oldSelection, ...oldFields } = original;
    const { selection: newSelection, membershipInputs, ...newFields } = result;
    expect(newFields).toEqual(oldFields);
    const { qualificationDependencyRefs, ...oldSelectionFields } = oldSelection;
    expect(qualificationDependencyRefs).toHaveLength(1);
    expect(newSelection).toEqual(oldSelectionFields);
    expect(membershipInputs).toHaveLength(1);
  }
  const imports = converted.nodes.filter(
    (node) => node.kind === "analysis-result",
  );
  expect(imports).toHaveLength(sources(canonical).length);
  for (const node of imports) {
    expect(node.execution).toBe("program");
    expect(node.childPlan).toBe(actual.plan);
    expect(node.outputId).toBe(actual.output.id);
  }
  const maxRelation = Math.max(...canonical.nodes.map((node) => node.id));
  const maxSlot = Math.max(...canonical.slots.map((slot) => slot.id));
  expect(
    converted.nodes
      .slice(0, -canonical.nodes.length)
      .every((node) => node.id > maxRelation),
  ).toBe(true);
  expect(
    converted.slots
      .slice(canonical.slots.length)
      .every((slot) => slot.id > maxSlot),
  ).toBe(true);
}

describe("qualified Page graphs rewritten to actual Program dependencies", () => {
  it("preserves the real two-output Referrers summary graph and exact kinded child", () => {
    const { canonical } = fixture();
    expect(canonical.outputs).toHaveLength(2);
    expect(sources(canonical)).toHaveLength(1);
    const actual = producer(canonical, true);
    const converted = transformQualifiedPageProgramSources(canonical, actual);
    expectPreserved(canonical, converted, actual);
    expect(converted.nodes.slice(0, 4).map((node) => node.kind)).toEqual([
      "analysis-result",
      "filter",
      "project",
      "distinct",
    ]);
    expect(converted.context).toBe(canonical.context);
  });

  it("rewrites both genuine builder Sources with SQL-pair children while preserving independent F and R", () => {
    const { common, canonical: originalCanonical } = fixture("visitor");
    const { builder, pages } = createPageReportSource({
      ...common,
      attributes: ["page.report.pathname"],
    });
    const original = originalCanonical.nodes.find(
      (node) => node.kind === "source",
    );
    if (!original?.selection)
      throw Error("expected_canonical_source_selection");
    const second = builder.source("page", {
      temporalDomain: "candidate",
      attributes: ["page.report.pathname"],
      selection: original.selection,
    });
    builder.output("first-path", pages, [
      { name: "pathname", slot: "attribute:page.report.pathname" },
    ]);
    builder.output("second-path", second, [
      { name: "pathname", slot: "attribute:page.report.pathname" },
    ]);
    const canonical = builder.finish();
    expect(sources(canonical)).toHaveLength(2);
    const actual = producer(canonical, false);
    expect(actual.plan.context.time).not.toEqual(canonical.context.time);
    const converted = transformQualifiedPageProgramSources(canonical, actual);
    expectPreserved(canonical, converted, actual);
    expect(converted.nodes.slice(0, 6).map((node) => node.kind)).toEqual([
      "analysis-result",
      "project",
      "distinct",
      "analysis-result",
      "project",
      "distinct",
    ]);
    expect(converted.context.time).toBe(canonical.context.time);
    for (const [i, source] of sources(converted).entries())
      expect(source.selection?.time).toBe(
        sources(canonical)[i]?.selection?.time,
      );
  });

  it("adds only the actual authenticated producer teamId uniformly without rewriting source policy", () => {
    const { canonical } = fixture();
    const teamId = "authenticated-team" as TeamId;
    const actual = producer(canonical, true, teamId);
    const converted = transformQualifiedPageProgramSources(canonical, actual);
    expect(converted.context.subject).toBe(actual.plan.context.subject);
    for (const [i, source] of sources(converted).entries()) {
      const old = sources(canonical)[i]?.selection;
      if (!source.selection || !old) throw Error("expected_source_selection");
      expect(source.selection.subject).toBe(actual.plan.context.subject);
      const {
        subject: oldSubject,
        qualificationDependencyRefs,
        ...oldRest
      } = old;
      const { subject: newSubject, ...newRest } = source.selection;
      expect(oldSubject.teamId).toBeUndefined();
      expect(qualificationDependencyRefs).toHaveLength(1);
      expect(newSubject.teamId).toBe(teamId);
      expect(newRest).toEqual(oldRest);
    }
    expect(canonical.context.subject.teamId).toBeUndefined();
  });

  it("rejects overwrite or removal of a teamId already declared by the canonical graph", () => {
    const { canonical } = fixture();
    const actual = producer(canonical, true, "original-team" as TeamId);
    const subject = actual.plan.context.subject;
    const withTeam = validateLogicalPlan({
      ...canonical,
      context: { ...canonical.context, subject },
      nodes: canonical.nodes.map((node) =>
        node.kind === "source" && node.selection
          ? { ...node, selection: { ...node.selection, subject } }
          : node,
      ),
    });
    expect(() =>
      transformQualifiedPageProgramSources(
        withTeam,
        producer(canonical, true, "other-team" as TeamId),
      ),
    ).toThrow("program_membership_transform_team_mismatch");
    expect(() =>
      transformQualifiedPageProgramSources(withTeam, producer(canonical, true)),
    ).toThrow("program_membership_transform_team_mismatch");
    expect(
      transformQualifiedPageProgramSources(withTeam, actual).context.subject,
    ).toBe(subject);
  });

  it("rejects a copied output and a mixed carrier graph without modifying its old graph", () => {
    const { common, canonical } = fixture();
    const actual = producer(canonical, true);
    expect(() =>
      transformQualifiedPageProgramSources(canonical, {
        ...actual,
        output: { ...actual.output },
      }),
    ).toThrow("program_membership_output_identity_mismatch");
    const { builder, pages } = createPageReportSource({
      ...common,
      attributes: ["page.report.pathname"],
    });
    const unqualified = builder.source("page", {
      attributes: ["page.report.pathname"],
    });
    builder.output("qualified", pages, [
      { name: "pathname", slot: "attribute:page.report.pathname" },
    ]);
    builder.output("unqualified", unqualified, [
      { name: "pathname", slot: "attribute:page.report.pathname" },
    ]);
    const mixed = builder.finish();
    const beforeNodes = [...mixed.nodes];
    expect(() => transformQualifiedPageProgramSources(mixed, actual)).toThrow(
      "program_membership_transform_source_unsupported",
    );
    expect(mixed.nodes).toEqual(beforeNodes);
    expect(mixed.nodes.some((node) => node.kind === "analysis-result")).toBe(
      false,
    );
  });
});
