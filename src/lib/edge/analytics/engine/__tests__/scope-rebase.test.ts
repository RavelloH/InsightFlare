import { describe, expect, it } from "vitest";

import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
} from "@/lib/edge/analytics/contract/types";
import {
  createCandidateScopeUniverse,
  createNativeMatchConverter,
  type LogicalPlan,
  LogicalPlanBuilder,
  type LogicalRelationHandle,
  lowerFilterCondition,
  printLogicalPlan,
  resolveScopeFilterSelection,
  scopeConversionContract,
  validateLogicalPlan,
  validateNativeMatchRelation,
  validateScopeUniverse,
} from "@/lib/edge/analytics/engine";
import type {
  LogicalFilterScope,
  ResolvedAnalyticsScope,
} from "@/lib/edge/analytics/engine/semantic/entities";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { semanticRelationship } from "@/lib/edge/analytics/engine/semantic/relationships";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { analyzeFilterDocument } from "@/lib/filter-contract/filter-semantics";
import {
  type FilterCondition,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

const CANDIDATE_RANGE = {
  startMs: 1_000 as EpochMs,
  endExclusiveMs: 2_000 as EpochMs,
};
const HISTORICAL_RANGE = {
  startMs: 0 as EpochMs,
  endExclusiveMs: 900 as EpochMs,
};

function createBuilder(
  scope: ResolvedAnalyticsScope = resolveAnalyticsScope("auto"),
): LogicalPlanBuilder {
  return new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: ["site-a" as SiteId],
    }),
    time: createSemanticTemporalDomains({
      candidate: CANDIDATE_RANGE,
      read: { kind: "bounded", range: HISTORICAL_RANGE },
      reportingTimeZone: "UTC" as ReportingTimeZone,
      capturedAtMs: CANDIDATE_RANGE.endExclusiveMs,
    }),
    scope,
  });
}

function primitiveMatch(
  builder: LogicalPlanBuilder,
  nativeEntity: LogicalFilterScope,
  temporalDomain: "candidate" | "read" = "read",
) {
  const raw =
    nativeEntity === "observation"
      ? {
          kind: "condition" as const,
          target: { kind: "field" as const, field: "page.path" },
          operator: "eq",
          value: "/history",
        }
      : nativeEntity === "session"
        ? {
            kind: "condition" as const,
            target: { kind: "field" as const, field: "session.views" },
            operator: "gte",
            value: 2,
          }
        : {
            kind: "condition" as const,
            target: { kind: "field" as const, field: "visitor.sessions" },
            operator: "gte",
            value: 2,
          };
  const document = normalizeFilterDocument(
    { version: 1, root: raw },
    analyticsFilterRegistry,
  );
  const condition = document.root as FilterCondition;
  const analysis = analyzeFilterDocument(document, analyticsFilterRegistry);
  const lowered = lowerFilterCondition(
    builder,
    analysis,
    condition,
    temporalDomain,
  );
  if (lowered.kind !== "supported") {
    throw new Error(`primitive_match_unsupported:${lowered.code}`);
  }
  return lowered.match;
}

function finishWithEntityOutput(
  builder: LogicalPlanBuilder,
  relation: ReturnType<LogicalPlanBuilder["source"]>,
): LogicalPlan {
  builder.output("selection", relation, [{ name: "entity", slot: "entity" }]);
  return builder.finish();
}

function roundTripAndPrint(plan: LogicalPlan): string {
  const parsed = JSON.parse(JSON.stringify(plan)) as LogicalPlan;
  return printLogicalPlan(validateLogicalPlan(parsed));
}

const SCOPE_PAIRS: readonly {
  readonly from: LogicalFilterScope;
  readonly to: LogicalFilterScope;
}[] = [
  { from: "observation", to: "observation" },
  { from: "observation", to: "session" },
  { from: "observation", to: "visitor" },
  { from: "session", to: "observation" },
  { from: "session", to: "session" },
  { from: "session", to: "visitor" },
  { from: "visitor", to: "observation" },
  { from: "visitor", to: "session" },
  { from: "visitor", to: "visitor" },
];

describe("candidate scope universes", () => {
  it.each(["observation", "session", "visitor"] as const)(
    "builds a unary non-null %s universe from candidate observations",
    (scope) => {
      const builder = createBuilder();
      const universe = createCandidateScopeUniverse(builder, scope);
      expect(validateScopeUniverse(universe, builder)).toEqual([]);
      expect(universe).toMatchObject({
        scope,
        entitySlot: "entity",
        temporalDomain: "candidate",
        relation: {
          grain: { kind: "entity", entity: scope },
          slots: { entity: expect.any(Number) },
        },
      });
      expect(Object.keys(universe.relation.slots)).toEqual(["entity"]);
      const key = builder.slot(universe.relation, "entity");
      expect(key).toMatchObject({
        type: { kind: "entity", entity: scope },
        nullable: false,
      });

      const plan = finishWithEntityOutput(builder, universe.relation);
      expect(plan.context.subject).toEqual(builder.context.subject);
      const sources = plan.nodes.filter((node) => node.kind === "source");
      expect(sources.every((node) => node.temporalDomain === "candidate")).toBe(
        true,
      );
      if (scope === "observation") {
        expect(sources).toHaveLength(1);
        expect(plan.nodes.some((node) => node.kind === "distinct")).toBe(false);
      } else {
        expect(sources).toHaveLength(1);
        expect(sources[0]).toMatchObject({
          entity: "observation",
          values: expect.arrayContaining([
            {
              kind: "related-entity",
              slot: expect.any(Number),
              relationship:
                scope === "session"
                  ? "observation.session"
                  : "observation.visitor",
            },
          ]),
        });
        expect(plan.nodes).toContainEqual(
          expect.objectContaining({
            kind: "distinct",
            excludeNull: true,
            grain: expect.objectContaining({ kind: "entity", entity: scope }),
          }),
        );
      }
    },
  );

  it("prints each candidate universe with its source and temporal domain", () => {
    const snapshots = (["observation", "session", "visitor"] as const).map(
      (scope) => {
        const builder = createBuilder();
        const universe = createCandidateScopeUniverse(builder, scope);
        return roundTripAndPrint(
          finishWithEntityOutput(builder, universe.relation),
        );
      },
    );
    expect(snapshots).toMatchInlineSnapshot(`
      [
        "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<observation> grain=Entity<observation>[s0] domain=candidate
        VALUE self -> s0:Entity<observation>!{entity:observation}
        OUTPUT s0:Entity<observation>!{entity:observation}

      Outputs
        "selection" from r0
          "entity" -> s0:Entity<observation>!{entity:observation}
      ",
        "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<observation> grain=Entity<observation>[s0] domain=candidate
        VALUE self -> s0:Entity<observation>!{entity:observation}
        VALUE relationship=observation.session -> s1:Entity<session>?{relationship:observation.session}
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Entity<session>?{relationship:observation.session}

      r1 Distinct grain=Entity<session>[s2] excludeNull=true
        KEY s2:Entity<session>!{alias:s1} := s1:Entity<session>?{relationship:observation.session}
        OUTPUT s2:Entity<session>!{alias:s1}

      Outputs
        "selection" from r1
          "entity" -> s2:Entity<session>!{alias:s1}
      ",
        "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<observation> grain=Entity<observation>[s0] domain=candidate
        VALUE self -> s0:Entity<observation>!{entity:observation}
        VALUE relationship=observation.visitor -> s1:Entity<visitor>?{relationship:observation.visitor}
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Entity<visitor>?{relationship:observation.visitor}

      r1 Distinct grain=Entity<visitor>[s2] excludeNull=true
        KEY s2:Entity<visitor>!{alias:s1} := s1:Entity<visitor>?{relationship:observation.visitor}
        OUTPUT s2:Entity<visitor>!{alias:s1}

      Outputs
        "selection" from r1
          "entity" -> s2:Entity<visitor>!{alias:s1}
      ",
      ]
    `);
  });

  it("keeps a resolved logical scope and lets unresolved auto use its target", () => {
    const resolved = createBuilder(resolveAnalyticsScope("visitor"));
    expect(createCandidateScopeUniverse(resolved, "visitor").scope).toBe(
      "visitor",
    );
    expect(() => createCandidateScopeUniverse(resolved, "session")).toThrow(
      "candidate_scope_conflicts_with_resolved_scope",
    );
    expect(createCandidateScopeUniverse(createBuilder(), "session").scope).toBe(
      "session",
    );
  });

  it("rejects candidate universes with forged provenance, shape, or ownership", () => {
    const builder = createBuilder();
    const candidate = createCandidateScopeUniverse(builder, "visitor");

    expect(validateScopeUniverse(null as never)).toEqual([
      "universe: relation handle is invalid",
    ]);
    expect(
      validateScopeUniverse({ ...candidate, temporalDomain: "read" as never }),
    ).toContain("temporalDomain: candidate universe must use candidate");
    expect(
      validateScopeUniverse({
        ...candidate,
        relation: {
          ...candidate.relation,
          temporalDomains: ["read"],
        } as LogicalRelationHandle,
      }),
    ).toContain("relation: candidate universe source domain must be candidate");

    const entity = candidate.relation.slots.entity!;
    expect(
      validateScopeUniverse({
        ...candidate,
        entitySlot: "alias",
        relation: {
          ...candidate.relation,
          slots: { alias: entity },
        } as LogicalRelationHandle,
      }),
    ).toContain("relation: candidate universe must expose one entity key");
    expect(
      validateScopeUniverse({
        ...candidate,
        relation: {
          ...candidate.relation,
          slots: { ...candidate.relation.slots, extra: entity },
        } as LogicalRelationHandle,
      }),
    ).toContain("relation: candidate universe must expose one entity key");

    const nullableSource = builder.source("observation", {
      temporalDomain: "candidate",
      relationships: ["observation.visitor"],
    });
    expect(
      validateScopeUniverse(
        {
          ...candidate,
          relation: nullableSource,
          entitySlot: "relationship:observation.visitor",
        },
        builder,
      ),
    ).toContain("entitySlot: candidate entity key must be non-null");

    const foreignBuilder = createBuilder();
    const foreignCandidate = createCandidateScopeUniverse(
      foreignBuilder,
      "visitor",
    );
    expect(validateScopeUniverse(foreignCandidate, builder)).toContain(
      "relation: not owned by builder or entity slot is not visible",
    );
  });
});

describe("native match scope rebase", () => {
  it.each(SCOPE_PAIRS)(
    "converts $from match to $to candidate subset",
    ({ from, to }) => {
      const builder = createBuilder();
      const candidate = createCandidateScopeUniverse(builder, to);
      const match = primitiveMatch(builder, from, "read");
      const converted = createNativeMatchConverter(builder).convert(
        match,
        candidate,
      );
      expect(converted).toMatchObject({
        grain: { kind: "entity", entity: to },
        slots: { entity: expect.any(Number) },
      });
      expect(converted.temporalDomains).toEqual(["candidate", "read"]);
      expect(Object.keys(converted.slots)).toEqual(["entity"]);
      const key = builder.slot(converted, "entity");
      expect(key).toMatchObject({ type: { kind: "entity", entity: to } });
      expect(key.nullable).toBe(false);

      const plan = finishWithEntityOutput(builder, converted);
      const resultNode = plan.nodes.find((node) => node.id === converted.id);
      expect(resultNode).toMatchObject({
        kind: "set-operation",
        operation: "intersect",
      });
      if (from !== to) {
        const relationshipId = scopeConversionContract(from, to)
          ?.relationships[0];
        if (!relationshipId) throw new Error("scope_relationship_missing");
        const relationship = semanticRelationship(relationshipId);
        if (!relationship) throw new Error("scope_relationship_undefined");
        const lookups = plan.nodes.filter(
          (node) =>
            node.kind === "relationship-lookup" &&
            node.relationship === relationshipId,
        );
        expect(lookups).toHaveLength(1);
        const lookup = lookups[0]!;
        if (lookup.kind !== "relationship-lookup") {
          throw new Error("scope_relationship_lookup_expected");
        }
        expect(lookup).toMatchObject({
          timeSemantics: "identity-no-activity-filter",
        });
        if (relationship.from === from) {
          expect(
            plan.nodes.find((node) => node.id === lookup.input)?.kind,
          ).toBe("distinct");
        } else {
          expect(lookup.input).toBe(candidate.relation.id);
        }
        if (from === "visitor" && to === "session") {
          expect(
            plan.nodes.some(
              (node) =>
                node.kind === "source" &&
                node.entity === "session" &&
                node.temporalDomain === "candidate",
            ),
          ).toBe(false);
        }
      }
      roundTripAndPrint(plan);
    },
  );

  it("prints representative evidence-domain and candidate-side rebase plans", () => {
    const snapshots = [
      ["observation", "session"],
      ["visitor", "session"],
      ["session", "observation"],
      ["visitor", "visitor"],
    ].map(([from, to]) => {
      const builder = createBuilder();
      const target = createCandidateScopeUniverse(
        builder,
        to as LogicalFilterScope,
      );
      const match = primitiveMatch(builder, from as LogicalFilterScope, "read");
      const result = createNativeMatchConverter(builder).convert(match, target);
      return roundTripAndPrint(finishWithEntityOutput(builder, result));
    });
    expect(snapshots).toMatchInlineSnapshot(`
      [
        "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<observation> grain=Entity<observation>[s0] domain=candidate
        VALUE self -> s0:Entity<observation>!{entity:observation}
        VALUE relationship=observation.session -> s1:Entity<session>?{relationship:observation.session}
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Entity<session>?{relationship:observation.session}

      r1 Distinct grain=Entity<session>[s2] excludeNull=true
        KEY s2:Entity<session>!{alias:s1} := s1:Entity<session>?{relationship:observation.session}
        OUTPUT s2:Entity<session>!{alias:s1}

      r2 Source<observation> grain=Entity<observation>[s3] domain=read
        VALUE self -> s3:Entity<observation>!{entity:observation}
        VALUE attribute=page.path -> s4:Scalar<string>?{attribute:page.path}
        OUTPUT s3:Entity<observation>!{entity:observation}, s4:Scalar<string>?{attribute:page.path}

      r3 Filter grain=Entity<observation>[s3] input=r2
        WHERE (s4 eq "/history":Scalar<string> normalization=trim)
        OUTPUT s3:Entity<observation>!{entity:observation}, s4:Scalar<string>?{attribute:page.path}

      r4 Project grain=Entity<observation>[s5] input=r3
        s5:Entity<observation>!{alias:s3} := s3
        OUTPUT s5:Entity<observation>!{alias:s3}

      r5 Distinct grain=Entity<observation>[s6] excludeNull=true
        KEY s6:Entity<observation>!{alias:s5} := s5:Entity<observation>!{alias:s3}
        OUTPUT s6:Entity<observation>!{alias:s5}

      r6 RelationshipLookup<observation.session> grain=Entity<observation>[s6] input=r5 time=identity-no-activity-filter
        LOOKUP observation.session BY s6:Entity<observation>!{alias:s5} -> s7:Entity<session>?{relationship:observation.session} (identity read; no activity-time filter)
        OUTPUT s6:Entity<observation>!{alias:s5}, s7:Entity<session>?{relationship:observation.session}

      r7 Project grain=Entity<observation>[s9] input=r6
        s8:Entity<session>?{alias:s7} := s7
        s9:Entity<observation>!{alias:s6} := s6
        OUTPUT s8:Entity<session>?{alias:s7}, s9:Entity<observation>!{alias:s6}

      r8 Distinct grain=Entity<session>[s10] excludeNull=true
        KEY s10:Entity<session>!{alias:s8} := s8:Entity<session>?{alias:s7}
        OUTPUT s10:Entity<session>!{alias:s8}

      r9 Intersect grain=Entity<session>[s11] inputs=[r1, r8]
        INPUT r1
        INPUT r8
        OUTPUT s11:Entity<session>!{derived:set:intersect(s2,s10)}

      Outputs
        "selection" from r9
          "entity" -> s11:Entity<session>!{derived:set:intersect(s2,s10)}
      ",
        "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<observation> grain=Entity<observation>[s0] domain=candidate
        VALUE self -> s0:Entity<observation>!{entity:observation}
        VALUE relationship=observation.session -> s1:Entity<session>?{relationship:observation.session}
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Entity<session>?{relationship:observation.session}

      r1 Distinct grain=Entity<session>[s2] excludeNull=true
        KEY s2:Entity<session>!{alias:s1} := s1:Entity<session>?{relationship:observation.session}
        OUTPUT s2:Entity<session>!{alias:s1}

      r2 Source<visitor> grain=Entity<visitor>[s3] domain=read
        VALUE self -> s3:Entity<visitor>!{entity:visitor}
        VALUE attribute=visitor.sessions -> s4:Scalar<number>!{attribute:visitor.sessions}
        OUTPUT s3:Entity<visitor>!{entity:visitor}, s4:Scalar<number>!{attribute:visitor.sessions}

      r3 Filter grain=Entity<visitor>[s3] input=r2
        WHERE (s4 gte 2:Scalar<number>)
        OUTPUT s3:Entity<visitor>!{entity:visitor}, s4:Scalar<number>!{attribute:visitor.sessions}

      r4 Project grain=Entity<visitor>[s5] input=r3
        s5:Entity<visitor>!{alias:s3} := s3
        OUTPUT s5:Entity<visitor>!{alias:s3}

      r5 Distinct grain=Entity<visitor>[s6] excludeNull=true
        KEY s6:Entity<visitor>!{alias:s5} := s5:Entity<visitor>!{alias:s3}
        OUTPUT s6:Entity<visitor>!{alias:s5}

      r6 RelationshipLookup<session.visitor> grain=Entity<session>[s2] input=r1 time=identity-no-activity-filter
        LOOKUP session.visitor BY s2:Entity<session>!{alias:s1} -> s7:Entity<visitor>?{relationship:session.visitor} (identity read; no activity-time filter)
        OUTPUT s2:Entity<session>!{alias:s1}, s7:Entity<visitor>?{relationship:session.visitor}

      r7 SemiJoin grain=Entity<session>[s2]
        LEFT r6
        RIGHT r5
        ON s7:Entity<visitor>?{relationship:session.visitor} = s6:Entity<visitor>!{alias:s5}
        OUTPUT s2:Entity<session>!{alias:s1}, s7:Entity<visitor>?{relationship:session.visitor}

      r8 Project grain=Entity<session>[s8] input=r7
        s8:Entity<session>!{alias:s2} := s2
        OUTPUT s8:Entity<session>!{alias:s2}

      r9 Distinct grain=Entity<session>[s9] excludeNull=true
        KEY s9:Entity<session>!{alias:s8} := s8:Entity<session>!{alias:s2}
        OUTPUT s9:Entity<session>!{alias:s8}

      r10 Intersect grain=Entity<session>[s10] inputs=[r1, r9]
        INPUT r1
        INPUT r9
        OUTPUT s10:Entity<session>!{derived:set:intersect(s2,s9)}

      Outputs
        "selection" from r10
          "entity" -> s10:Entity<session>!{derived:set:intersect(s2,s9)}
      ",
        "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<observation> grain=Entity<observation>[s0] domain=candidate
        VALUE self -> s0:Entity<observation>!{entity:observation}
        OUTPUT s0:Entity<observation>!{entity:observation}

      r1 Source<session> grain=Entity<session>[s1] domain=read
        VALUE self -> s1:Entity<session>!{entity:session}
        VALUE attribute=session.views -> s2:Scalar<number>!{attribute:session.views}
        OUTPUT s1:Entity<session>!{entity:session}, s2:Scalar<number>!{attribute:session.views}

      r2 Filter grain=Entity<session>[s1] input=r1
        WHERE (s2 gte 2:Scalar<number>)
        OUTPUT s1:Entity<session>!{entity:session}, s2:Scalar<number>!{attribute:session.views}

      r3 Project grain=Entity<session>[s3] input=r2
        s3:Entity<session>!{alias:s1} := s1
        OUTPUT s3:Entity<session>!{alias:s1}

      r4 Distinct grain=Entity<session>[s4] excludeNull=true
        KEY s4:Entity<session>!{alias:s3} := s3:Entity<session>!{alias:s1}
        OUTPUT s4:Entity<session>!{alias:s3}

      r5 RelationshipLookup<observation.session> grain=Entity<observation>[s0] input=r0 time=identity-no-activity-filter
        LOOKUP observation.session BY s0:Entity<observation>!{entity:observation} -> s5:Entity<session>?{relationship:observation.session} (identity read; no activity-time filter)
        OUTPUT s0:Entity<observation>!{entity:observation}, s5:Entity<session>?{relationship:observation.session}

      r6 SemiJoin grain=Entity<observation>[s0]
        LEFT r5
        RIGHT r4
        ON s5:Entity<session>?{relationship:observation.session} = s4:Entity<session>!{alias:s3}
        OUTPUT s0:Entity<observation>!{entity:observation}, s5:Entity<session>?{relationship:observation.session}

      r7 Project grain=Entity<observation>[s6] input=r6
        s6:Entity<observation>!{alias:s0} := s0
        OUTPUT s6:Entity<observation>!{alias:s0}

      r8 Distinct grain=Entity<observation>[s7] excludeNull=true
        KEY s7:Entity<observation>!{alias:s6} := s6:Entity<observation>!{alias:s0}
        OUTPUT s7:Entity<observation>!{alias:s6}

      r9 Intersect grain=Entity<observation>[s8] inputs=[r0, r8]
        INPUT r0
        INPUT r8
        OUTPUT s8:Entity<observation>!{derived:set:intersect(s0,s7)}

      Outputs
        "selection" from r9
          "entity" -> s8:Entity<observation>!{derived:set:intersect(s0,s7)}
      ",
        "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<observation> grain=Entity<observation>[s0] domain=candidate
        VALUE self -> s0:Entity<observation>!{entity:observation}
        VALUE relationship=observation.visitor -> s1:Entity<visitor>?{relationship:observation.visitor}
        OUTPUT s0:Entity<observation>!{entity:observation}, s1:Entity<visitor>?{relationship:observation.visitor}

      r1 Distinct grain=Entity<visitor>[s2] excludeNull=true
        KEY s2:Entity<visitor>!{alias:s1} := s1:Entity<visitor>?{relationship:observation.visitor}
        OUTPUT s2:Entity<visitor>!{alias:s1}

      r2 Source<visitor> grain=Entity<visitor>[s3] domain=read
        VALUE self -> s3:Entity<visitor>!{entity:visitor}
        VALUE attribute=visitor.sessions -> s4:Scalar<number>!{attribute:visitor.sessions}
        OUTPUT s3:Entity<visitor>!{entity:visitor}, s4:Scalar<number>!{attribute:visitor.sessions}

      r3 Filter grain=Entity<visitor>[s3] input=r2
        WHERE (s4 gte 2:Scalar<number>)
        OUTPUT s3:Entity<visitor>!{entity:visitor}, s4:Scalar<number>!{attribute:visitor.sessions}

      r4 Project grain=Entity<visitor>[s5] input=r3
        s5:Entity<visitor>!{alias:s3} := s3
        OUTPUT s5:Entity<visitor>!{alias:s3}

      r5 Distinct grain=Entity<visitor>[s6] excludeNull=true
        KEY s6:Entity<visitor>!{alias:s5} := s5:Entity<visitor>!{alias:s3}
        OUTPUT s6:Entity<visitor>!{alias:s5}

      r6 Intersect grain=Entity<visitor>[s7] inputs=[r1, r5]
        INPUT r1
        INPUT r5
        OUTPUT s7:Entity<visitor>!{derived:set:intersect(s2,s6)}

      Outputs
        "selection" from r6
          "entity" -> s7:Entity<visitor>!{derived:set:intersect(s2,s6)}
      ",
      ]
    `);
  });

  it("uses explicit read evidence for historical matches and candidate evidence for targets", () => {
    for (const [from, to] of [
      ["observation", "session"],
      ["observation", "visitor"],
      ["session", "observation"],
      ["visitor", "observation"],
      ["visitor", "session"],
    ] as const) {
      const builder = createBuilder();
      const target = createCandidateScopeUniverse(builder, to);
      const match = primitiveMatch(builder, from, "read");
      const converted = createNativeMatchConverter(builder).convert(
        match,
        target,
      );
      const plan = finishWithEntityOutput(builder, converted);
      const set = plan.nodes.find((node) => node.id === converted.id);
      expect(set).toMatchObject({
        kind: "set-operation",
        operation: "intersect",
      });
      expect(
        plan.nodes.some(
          (node) =>
            node.kind === "source" &&
            node.entity === from &&
            node.temporalDomain === "read",
        ),
      ).toBe(true);
      if (from === "observation") {
        expect(
          plan.nodes.some(
            (node) =>
              node.kind === "source" &&
              node.entity === "observation" &&
              node.temporalDomain === "read",
          ),
        ).toBe(true);
      } else {
        const targetSources = plan.nodes
          .filter((node) => node.kind === "source")
          .filter((node) => node.entity === to);
        expect(
          targetSources.every((node) => node.temporalDomain === "candidate"),
        ).toBe(true);
      }
    }
  });

  it("keeps Visitor→Session correct when the candidate observation has no visitor link", () => {
    const builder = createBuilder();
    const candidateObservations = builder.source("observation", {
      temporalDomain: "candidate",
      relationships: ["observation.session", "observation.visitor"],
    });
    const candidateSessions = builder.distinctEntity(
      candidateObservations,
      "relationship:observation.session",
      "entity",
    );
    const target = {
      scope: "session",
      relation: candidateSessions,
      entitySlot: "entity",
      temporalDomain: "candidate",
    } as const;
    const visitorMatches = builder.source("visitor", {
      temporalDomain: "read",
    });
    const converted = createNativeMatchConverter(builder).convert(
      {
        nativeEntity: "visitor",
        relation: visitorMatches,
        entitySlot: "entity",
        temporalDomain: "read",
      },
      target,
    );
    const plan = finishWithEntityOutput(builder, converted);

    const lookup = plan.nodes.find(
      (node) =>
        node.kind === "relationship-lookup" &&
        node.relationship === "session.visitor",
    );
    expect(lookup).toMatchObject({
      input: candidateSessions.id,
      timeSemantics: "identity-no-activity-filter",
    });
    expect(
      plan.nodes.some(
        (node) =>
          node.kind === "source" &&
          node.entity === "session" &&
          node.temporalDomain === "candidate",
      ),
    ).toBe(false);

    const fixtureSources = new Map<string, readonly Record<string, unknown>[]>([
      [
        "observation:candidate",
        [
          {
            entity: "O",
            "relationship:observation.session": "S",
            "relationship:observation.visitor": null,
          },
        ],
      ],
      ["visitor:read", [{ entity: "V" }]],
    ]);
    const identityRows = [
      {
        siteId: "site-a",
        relationship: "session.visitor",
        from: "S",
        to: "V",
        establishedAt: 500,
      },
    ];
    const rowsByRelation = new Map<number, Map<number, unknown>[]>();
    for (const node of plan.nodes) {
      if (node.kind === "source") {
        const rows = fixtureSources.get(
          `${node.entity}:${node.temporalDomain}`,
        );
        if (!rows) throw new Error("cross_window_fixture_source_missing");
        rowsByRelation.set(
          node.id,
          rows.map(
            (row) =>
              new Map(
                node.values.map((binding) => {
                  const name =
                    binding.kind === "self"
                      ? "entity"
                      : binding.kind === "related-entity"
                        ? `relationship:${binding.relationship}`
                        : "unmodeled";
                  return [binding.slot, row[name]];
                }),
              ),
          ),
        );
      } else if (node.kind === "relationship-lookup") {
        const siteId = plan.context.subject.siteIds[0];
        rowsByRelation.set(
          node.id,
          rowsByRelation.get(node.input)!.map((row) => {
            const identity = identityRows.find(
              (candidate) =>
                candidate.siteId === siteId &&
                candidate.relationship === node.relationship &&
                candidate.from === row.get(node.inputKey),
            );
            return new Map([...row, [node.relatedSlot, identity?.to ?? null]]);
          }),
        );
      } else if (node.kind === "project") {
        rowsByRelation.set(
          node.id,
          rowsByRelation.get(node.input)!.map(
            (row) =>
              new Map(
                node.projections.map((projection) => {
                  if (projection.expression.kind !== "slot") {
                    throw new Error(
                      "cross_window_fixture_projection_unsupported",
                    );
                  }
                  return [projection.slot, row.get(projection.expression.slot)];
                }),
              ),
          ),
        );
      } else if (node.kind === "distinct") {
        const unique = new Map<string, Map<number, unknown>>();
        for (const row of rowsByRelation.get(node.input)!) {
          const values = node.keys.map((key) => row.get(key.input));
          if (node.excludeNull && values.some((value) => value == null))
            continue;
          unique.set(
            JSON.stringify(values),
            new Map(node.keys.map((key, index) => [key.output, values[index]])),
          );
        }
        rowsByRelation.set(node.id, [...unique.values()]);
      } else if (node.kind === "semi-join") {
        const rightRows = rowsByRelation.get(node.right)!;
        rowsByRelation.set(
          node.id,
          rowsByRelation
            .get(node.left)!
            .filter((left) =>
              rightRows.some((right) =>
                node.keys.every(
                  (key) => left.get(key.left) === right.get(key.right),
                ),
              ),
            ),
        );
      } else if (node.kind === "set-operation") {
        const [firstId, secondId] = node.inputs;
        if (node.operation !== "intersect" || secondId === undefined) {
          throw new Error("cross_window_fixture_set_operation_unsupported");
        }
        const firstNode = plan.nodes.find(
          (candidate) => candidate.id === firstId,
        )!;
        const secondNode = plan.nodes.find(
          (candidate) => candidate.id === secondId,
        )!;
        const secondRows = rowsByRelation.get(secondId)!;
        const result = rowsByRelation
          .get(firstId!)!
          .filter((first) =>
            secondRows.some((second) =>
              firstNode.output.every(
                (slot, index) =>
                  first.get(slot) === second.get(secondNode.output[index]!),
              ),
            ),
          );
        rowsByRelation.set(
          node.id,
          result.map(
            (row) =>
              new Map(
                node.output.map((output, index) => [
                  output,
                  row.get(firstNode.output[index]!),
                ]),
              ),
          ),
        );
      } else {
        throw new Error(`cross_window_fixture_unhandled_node:${node.kind}`);
      }
    }

    if (converted.grain.kind !== "entity") {
      throw new Error("cross_window_result_entity_grain_expected");
    }
    const resultEntityKey = converted.grain.key;
    expect(
      rowsByRelation.get(converted.id)!.map((row) => row.get(resultEntityKey)),
    ).toEqual(["S"]);
    expect(identityRows[0]?.establishedAt).toBeLessThan(
      CANDIDATE_RANGE.startMs,
    );
    const candidateObservation = plan.nodes.find(
      (node) =>
        node.kind === "source" &&
        node.entity === "observation" &&
        node.temporalDomain === "candidate",
    );
    if (candidateObservation?.kind !== "source") {
      throw new Error("cross_window_candidate_observation_source_missing");
    }
    const visitorBinding = candidateObservation.values.find(
      (binding) =>
        binding.kind === "related-entity" &&
        binding.relationship === "observation.visitor",
    );
    if (visitorBinding?.kind !== "related-entity") {
      throw new Error("cross_window_candidate_visitor_link_missing");
    }
    expect(
      fixtureSources.get("observation:candidate")?.[0]?.[
        `relationship:${visitorBinding.relationship}`
      ],
    ).toBeNull();
    roundTripAndPrint(plan);
  });

  it("drops nullable relationship identities and preserves empty-root unfiltered behavior", () => {
    for (const scope of ["session", "visitor"] as const) {
      const builder = createBuilder();
      const candidate = createCandidateScopeUniverse(builder, scope);
      const source = builder.source("observation", {
        temporalDomain: "read",
        relationships: [
          scope === "session" ? "observation.session" : "observation.visitor",
        ],
      });
      const relationName =
        scope === "session"
          ? "relationship:observation.session"
          : "relationship:observation.visitor";
      expect(builder.slot(source, relationName).nullable).toBe(true);
      const match = primitiveMatch(builder, "observation", "read");
      const converted = createNativeMatchConverter(builder).convert(
        match,
        candidate,
      );
      const plan = finishWithEntityOutput(builder, converted);
      expect(
        plan.nodes
          .filter((node) => node.kind === "distinct")
          .every((node) => node.excludeNull),
      ).toBe(true);
      expect(builder.slot(converted, "entity").nullable).toBe(false);
    }

    const builder = createBuilder();
    const candidate = createCandidateScopeUniverse(builder, "session");
    const before = builder.finish().nodes.length;
    const selection = resolveScopeFilterSelection(
      builder,
      candidate,
      null,
      createNativeMatchConverter(builder),
    );
    expect(selection).toEqual({ kind: "unfiltered" });
    expect(builder.finish().nodes).toHaveLength(before);
  });

  it("rejects malformed grain, invisible or foreign handles, and invalid time metadata", () => {
    const builder = createBuilder();
    const target = createCandidateScopeUniverse(builder, "visitor");
    const match = primitiveMatch(builder, "session", "read");
    const converter = createNativeMatchConverter(builder);
    expect(() =>
      converter.convert({ ...match, nativeEntity: "visitor" }, target),
    ).toThrow("native_match_native_entity_grain_mismatch");
    expect(() =>
      converter.convert({ ...match, relation: null as never }, target),
    ).toThrow("native_match_invalid_relation");
    expect(() =>
      converter.convert({ ...match, entitySlot: "missing" }, target),
    ).toThrow("native_match_relation_not_owned_or_entity_slot_not_visible");
    expect(() =>
      converter.convert(
        { ...match, entitySlot: "attribute:session.views" },
        target,
      ),
    ).toThrow("native_match_entity_slot_is_not_grain_key");
    expect(() =>
      converter.convert({ ...match, temporalDomain: "filter" }, target),
    ).toThrow("native_match_invalid_temporal_domain");
    expect(() =>
      converter.convert({ ...match, temporalDomain: "candidate" }, target),
    ).toThrow("native_match_temporal_domain_mismatch");

    const foreignBuilder = createBuilder();
    const foreignMatch = primitiveMatch(foreignBuilder, "session", "read");
    expect(() => converter.convert(foreignMatch, target)).toThrow(
      "native_match_relation_not_owned_or_entity_slot_not_visible",
    );
    expect(() =>
      converter.convert(match, {
        ...target,
        scope: "session",
      }),
    ).toThrow("native_match_invalid_target");

    let converterInvoked = false;
    expect(() =>
      resolveScopeFilterSelection(
        builder,
        target,
        { kind: "match", value: { ...match, nativeEntity: "visitor" } },
        {
          convert: () => {
            converterInvoked = true;
            return target.relation;
          },
        },
      ),
    ).toThrow("native_match_native_entity_grain_mismatch");
    expect(converterInvoked).toBe(false);
  });

  it("rejects invalid match handles and converter results at the boundary", () => {
    const builder = createBuilder();
    const target = createCandidateScopeUniverse(builder, "visitor");
    expect(() => validateNativeMatchRelation(builder, null as never)).toThrow(
      "native_match_invalid_input",
    );

    const match = primitiveMatch(builder, "observation", "read");
    const broadRelation = builder.source("observation", {
      temporalDomain: "candidate",
      relationships: ["observation.visitor"],
    });
    expect(() =>
      resolveScopeFilterSelection(
        builder,
        target,
        { kind: "match", value: match },
        {
          convert: () => broadRelation,
        },
      ),
    ).toThrow("scope_conversion_result_must_be_unary_entity_set");

    const foreignBuilder = createBuilder();
    const foreignVisitor = foreignBuilder.source("visitor", {
      temporalDomain: "candidate",
    });
    expect(() =>
      resolveScopeFilterSelection(
        builder,
        target,
        { kind: "match", value: match },
        {
          convert: () => foreignVisitor,
        },
      ),
    ).toThrow("scope_conversion_result_not_owned_or_key_not_visible");

    const resolvedBuilder = createBuilder(resolveAnalyticsScope("visitor"));
    const resolvedMatch = primitiveMatch(
      resolvedBuilder,
      "observation",
      "read",
    );
    const foreignTarget = createCandidateScopeUniverse(
      createBuilder(),
      "session",
    );
    expect(() =>
      createNativeMatchConverter(resolvedBuilder).convert(
        resolvedMatch,
        foreignTarget,
      ),
    ).toThrow("native_match_target_conflicts_with_resolved_scope");
  });
});
