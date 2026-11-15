// @vitest-environment node
// Pure semantic descriptor witness only. No DB, invocation or physical capability.
import { expect, it } from "vitest";

import {
  createQueryTime,
  createTimeRange,
  siteQueryContext,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  snapshotLogicalPlan,
  type ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import { semanticSubjectFromQuerySubject } from "@/lib/edge/analytics/engine/semantic/subject";
import { planWholeMembershipCoreReads } from "@/lib/edge/analytics/engine/whole-membership-core-read-plan";
import {
  buildChannelsMembershipStage,
  buildWholeMembershipCoreStage,
  WHOLE_MEMBERSHIP_CORE_OUTPUT,
} from "@/lib/edge/analytics/engine/whole-membership-stage-plan";
import {
  advanceWholeMembershipStage,
  beginWholeMembershipStage,
} from "@/lib/edge/analytics/engine/whole-membership-stage-transition";
import { lowerAnalyticsLogicalCommand } from "@/lib/edge/analytics/providers/d1/internal/analytics-logical-command-lowering";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
const teamSubject = semanticSubjectFromQuerySubject(
  teamQueryContext(
    "w133-plan-only",
    "private-dashboard",
    Array.from(
      { length: 91 },
      (_, index) => `w133-${index.toString().padStart(3, "0")}`,
    ),
  ).subject,
);
const sites = teamSubject.siteIds;
for (const read of [createTimeRange(300, 350), createTimeRange(150, 220)])
  it(`91-site chunk outer / C union R inner ${read.startMs}`, () => {
    const time = { ...createQueryTime(100, 200, "UTC", 400), readRange: read };
    const filters = parseFilterDsl(
      'first(event.payload("/amount")) gt 0',
      analyticsFilterRegistry,
    );
    const stage = buildChannelsMembershipStage({
      subject: teamSubject,
      filters,
      queryTime: time,
      scope: "session",
      coverageSource: "read",
      profile: "whole-original-completion-team-entity-v1",
    });
    let state = beginWholeMembershipStage(stage);
    expect(state.kind).toBe("coverage");
    // Test-only pure transition input. This map is never passed to any physical
    // frame/preparer: it grants no authority and is not a coverage provenance test.
    state = advanceWholeMembershipStage(state, {
      kind: "coverage",
      coverage: new Map(sites.map((site) => [site, 0])),
    });
    while (state.kind === "sql-alternative")
      state = advanceWholeMembershipStage(state, { kind: "sql-refused" });
    if (state.kind !== "core-inputs")
      throw Error("expected bounded-original-Core descriptor state");
    const program = planWholeMembershipCoreReads(state, {
      root: filters.root,
      candidateRange: time.range,
      readRange: read,
    });
    const ranges =
      read.startMs === 300
        ? [{ startMs: 100, endExclusiveMs: 200 }, read]
        : [{ startMs: 100, endExclusiveMs: 220 }];
    const expected = [sites.slice(0, 90), sites.slice(90)].flatMap((siteIds) =>
      ranges.map((range) => ({ siteIds, range })),
    );
    expect(
      program.activities.map(({ siteIds, range }) => ({ siteIds, range })),
    ).toEqual(expected);
    expect(
      program.payloads.map(({ siteIds, range }) => ({ siteIds, range })),
    ).toEqual(expected);
    expect(
      program.payloads.every(
        (node) =>
          node.paths.length === 1 &&
          node.paths[0] === "/amount" &&
          !node.wholePayload,
      ),
    ).toBe(true);
    expect(program.activities.every((node) => node.siteIds.length <= 90)).toBe(
      true,
    );
    expect(program.coreBounds).toBe(state.job.bounds);
  });

it("the Team Core profile preserves site/kind/id while ordinary Page Core keeps two fields", () => {
  const filters = parseFilterDsl(
      'first(event.payload("/amount")) gt 0',
      analyticsFilterRegistry,
    ),
    time = createQueryTime(100, 200, "UTC", 300);
  for (const profile of [
    "whole-original-completion-team-entity-v1",
    "page-role-single-site-entity-v1",
  ] as const) {
    const subject =
      profile === "whole-original-completion-team-entity-v1"
        ? teamSubject
        : semanticSubjectFromQuerySubject(
            siteQueryContext(sites[0]!, "private-dashboard").subject,
          );
    const stage = buildChannelsMembershipStage({
      subject,
      filters,
      queryTime: time,
      scope: "session",
      coverageSource: "read",
      profile,
    });
    let state = beginWholeMembershipStage(stage);
    state = advanceWholeMembershipStage(state, {
      kind: "coverage",
      coverage: new Map(subject.siteIds.map((site) => [site, 0])),
    });
    while (state.kind === "sql-alternative")
      state = advanceWholeMembershipStage(state, { kind: "sql-refused" });
    if (state.kind !== "core-inputs")
      throw Error("expected original Core descriptor state");
    const core = buildWholeMembershipCoreStage({
      stage,
      filters,
      queryTime: time,
      readRange: time.range,
      fullHistoryAtEntry: false,
      bounds: state.job.bounds,
    });
    const expected =
      profile === "whole-original-completion-team-entity-v1"
        ? ["site_id", "match_kind", "match_id"]
        : ["site_id", "entity_id"];
    expect(core.outputs[0]?.fields.map((field) => field.name)).toEqual(
      expected,
    );
    const lowered = lowerAnalyticsLogicalCommand(
      core,
      WHOLE_MEMBERSHIP_CORE_OUTPUT,
      "w133-plan-only",
    );
    expect(lowered.kind).toBe("bounded-filter-core");
    const wrongSchema = snapshotLogicalPlan({
      ...core,
      outputs: core.outputs.map((output) => ({
        ...output,
        fields: output.fields.map((field, index) =>
          index === 1
            ? {
                ...field,
                name: field.name === "match_kind" ? "entity_id" : "match_kind",
              }
            : field,
        ),
      })),
    });
    expect(() =>
      lowerAnalyticsLogicalCommand(
        // Deliberately forge only the compile-time brand: the actual lowerer
        // must revalidate and reject this invalid runtime schema.
        wrongSchema as ValidatedLogicalPlan,
        WHOLE_MEMBERSHIP_CORE_OUTPUT,
        "w133-plan-only",
      ),
    ).toThrow();
    if (profile === "whole-original-completion-team-entity-v1") {
      const foreignProfile = snapshotLogicalPlan({
        ...core,
        nodes: core.nodes.map((node) =>
          node.kind === "whole-filter-core"
            ? { ...node, profile: "page-role-single-site-entity-v1" as const }
            : node,
        ),
      });
      expect(() =>
        lowerAnalyticsLogicalCommand(
          // Exercise the real lowerer with an invalid branded runtime input.
          foreignProfile as ValidatedLogicalPlan,
          WHOLE_MEMBERSHIP_CORE_OUTPUT,
          "w133-plan-only",
        ),
      ).toThrow();
    }
  }
});
