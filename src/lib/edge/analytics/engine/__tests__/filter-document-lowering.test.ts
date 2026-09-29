import { describe, expect, it } from "vitest";

import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
} from "@/lib/edge/analytics/contract/types";
import {
  type FilterConditionTimeDomainContext,
  type FilterDocumentLoweringOptions,
  type FilterDocumentLoweringResult,
  type LogicalPlan,
  LogicalPlanBuilder,
  lowerFilterDocumentToScope,
  printLogicalPlan,
  validateLogicalPlan,
} from "@/lib/edge/analytics/engine";
import type { LogicalExpr } from "@/lib/edge/analytics/engine/logical/expression";
import type {
  RelationId,
  SlotId,
} from "@/lib/edge/analytics/engine/logical/ids";
import type { LogicalNode } from "@/lib/edge/analytics/engine/logical/nodes";
import { createNativeMatchConverter } from "@/lib/edge/analytics/engine/scope-rebase";
import type { LogicalFilterScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import {
  createSemanticTemporalDomains,
  type TemporalDomainRef,
} from "@/lib/edge/analytics/engine/semantic/time";
import { parseFilterDsl } from "@/lib/filter-contract/filter-dsl";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import {
  type AnalyzedFilterDocument,
  analyzeFilterDocument,
} from "@/lib/filter-contract/filter-semantics";
import {
  type FilterCondition,
  type FilterDocument,
  type FilterExpression,
  type FilterOperator,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

const CANDIDATE_RANGE = {
  startMs: 1_000 as EpochMs,
  endExclusiveMs: 2_000 as EpochMs,
};
const FILTER_RANGE = {
  startMs: 200,
  endExclusiveMs: 800,
};
const READ_RANGE = {
  startMs: 0 as EpochMs,
  endExclusiveMs: 900 as EpochMs,
};
const SITE_ID = "site-a" as SiteId;

function createBuilder(
  scope = resolveAnalyticsScope("auto"),
): LogicalPlanBuilder {
  return new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE_ID],
    }),
    time: createSemanticTemporalDomains({
      candidate: CANDIDATE_RANGE,
      filter: FILTER_RANGE,
      read: { kind: "bounded", range: READ_RANGE },
      reportingTimeZone: "UTC" as ReportingTimeZone,
      capturedAtMs: CANDIDATE_RANGE.endExclusiveMs,
    }),
    scope,
  });
}

function analyzeDocument(document: FilterDocument): AnalyzedFilterDocument {
  const normalized = normalizeFilterDocument(document, analyticsFilterRegistry);
  return analyzeFilterDocument(normalized, analyticsFilterRegistry);
}

function analyzeExpression(root: FilterExpression | null) {
  return analyzeDocument({ version: 1, root });
}

function fieldCondition(
  field: string,
  operator: FilterOperator,
  value?: unknown,
): FilterCondition {
  return {
    kind: "condition",
    target: { kind: "field", field } as FilterCondition["target"],
    operator,
    ...(value === undefined
      ? {}
      : ({ value } as Pick<FilterCondition, "value">)),
  };
}

function explicitDomain(
  domain: TemporalDomainRef,
): FilterDocumentLoweringOptions["resolveTemporalDomain"] {
  return () => domain;
}

function outputPlan(
  builder: LogicalPlanBuilder,
  result: Extract<FilterDocumentLoweringResult, { kind: "supported" }>,
): LogicalPlan {
  builder.output("matches", result.selection.relation, [
    { name: "entity", slot: "entity" },
  ]);
  const plan = builder.finish();
  return validateLogicalPlan(JSON.parse(JSON.stringify(plan)) as LogicalPlan);
}

function evaluatePredicate(
  expression: LogicalExpr,
  row: Map<SlotId, unknown>,
): unknown {
  switch (expression.kind) {
    case "slot":
      return row.get(expression.slot);
    case "literal":
      return expression.value;
    case "comparison": {
      const left = evaluatePredicate(expression.left, row);
      const right = evaluatePredicate(expression.right, row);
      if (left == null || right == null) return false;
      const normalize = (value: unknown) => {
        if (typeof value !== "string" || !expression.stringNormalization)
          return value;
        const trimmed = value.trim();
        return expression.stringNormalization === "trim-case-fold"
          ? trimmed.toLowerCase()
          : trimmed;
      };
      const a = normalize(left) as string | number;
      const b = normalize(right) as string | number;
      switch (expression.operator) {
        case "eq":
          return a === b;
        case "neq":
          return a !== b;
        case "gt":
          return a > b;
        case "gte":
          return a >= b;
        case "lt":
          return a < b;
        case "lte":
          return a <= b;
      }
      break;
    }
    case "boolean":
      return expression.operator === "and"
        ? expression.terms.every(
            (term) => evaluatePredicate(term, row) === true,
          )
        : expression.terms.some(
            (term) => evaluatePredicate(term, row) === true,
          );
    case "not":
      return evaluatePredicate(expression.input, row) !== true;
    case "null-test":
      return (
        (evaluatePredicate(expression.input, row) == null) !==
        expression.negated
      );
    default:
      throw new Error(`set_fixture_unhandled_expression:${expression.kind}`);
  }
  throw new Error("set_fixture_unhandled_comparison");
}

type FixtureRow = Map<SlotId, unknown>;
interface IdentityRow {
  readonly siteId: SiteId;
  readonly relationship: string;
  readonly from: string;
  readonly to: string;
}

function evaluateEntitySet(
  plan: LogicalPlan,
  fixtureSources: ReadonlyMap<string, readonly Record<string, unknown>[]>,
  identities: readonly IdentityRow[],
  outputRelation: RelationId,
): ReadonlySet<string> {
  const rows = new Map<RelationId, FixtureRow[]>();
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));

  for (const node of plan.nodes) {
    switch (node.kind) {
      case "source": {
        const sourceRows = fixtureSources.get(
          `${node.entity}:${node.temporalDomain}`,
        );
        if (!sourceRows) {
          throw new Error(
            `set_fixture_missing_source:${node.entity}:${node.temporalDomain}`,
          );
        }
        rows.set(
          node.id,
          sourceRows.map((sourceRow) => {
            const result = new Map<SlotId, unknown>();
            for (const binding of node.values) {
              if (binding.kind === "self") {
                result.set(binding.slot, sourceRow.entity);
              } else if (binding.kind === "related-entity") {
                result.set(
                  binding.slot,
                  sourceRow[`relationship:${binding.relationship}`] ?? null,
                );
              } else if (binding.kind === "attribute") {
                result.set(
                  binding.slot,
                  sourceRow[`attribute:${binding.attribute}`] ?? null,
                );
              } else {
                result.set(binding.slot, sourceRow.occurrenceTime ?? null);
              }
            }
            return result;
          }),
        );
        break;
      }
      case "filter":
        rows.set(
          node.id,
          rows
            .get(node.input)!
            .filter((row) => evaluatePredicate(node.predicate, row) === true),
        );
        break;
      case "project":
        rows.set(
          node.id,
          rows.get(node.input)!.map((input) => {
            const result = new Map<SlotId, unknown>();
            for (const projection of node.projections) {
              result.set(
                projection.slot,
                evaluatePredicate(projection.expression, input),
              );
            }
            return result;
          }),
        );
        break;
      case "relationship-lookup": {
        const siteId = plan.context.subject.siteIds[0];
        rows.set(
          node.id,
          rows.get(node.input)!.map((input) => {
            const identity = identities.find(
              (candidate) =>
                candidate.siteId === siteId &&
                candidate.relationship === node.relationship &&
                candidate.from === input.get(node.inputKey),
            );
            return new Map([
              ...input,
              [node.relatedSlot, identity?.to ?? null] as const,
            ]);
          }),
        );
        break;
      }
      case "distinct": {
        const unique = new Map<string, FixtureRow>();
        for (const input of rows.get(node.input)!) {
          const values = node.keys.map((key) => input.get(key.input));
          if (node.excludeNull && values.some((value) => value == null))
            continue;
          const key = JSON.stringify(values);
          unique.set(
            key,
            new Map(
              node.keys.map((item, index) => [item.output, values[index]]),
            ),
          );
        }
        rows.set(node.id, [...unique.values()]);
        break;
      }
      case "set-operation": {
        const inputNodes = node.inputs.map((id) => byId.get(id)!);
        const inputRows = node.inputs.map((id) => rows.get(id)!);
        const keys = inputRows.map((set, index) => {
          const inputNode = inputNodes[index]!;
          return new Set(
            set.map((row) =>
              JSON.stringify(inputNode.output.map((slot) => row.get(slot))),
            ),
          );
        });
        const firstNode = inputNodes[0]!;
        const firstRows = inputRows[0]!;
        const selected = firstRows.filter((row) => {
          const key = JSON.stringify(
            firstNode.output.map((slot) => row.get(slot)),
          );
          if (node.operation === "intersect")
            return keys.slice(1).every((other) => other.has(key));
          if (node.operation === "difference") return !keys[1]!.has(key);
          return true;
        });
        const rowsWithValues =
          node.operation === "union"
            ? inputRows.flatMap((set, setIndex) =>
                set.map((row) =>
                  inputNodes[setIndex]!.output.map((slot) => row.get(slot)),
                ),
              )
            : selected.map((row) =>
                firstNode.output.map((slot) => row.get(slot)),
              );
        const unique = new Map<string, FixtureRow>();
        for (const values of rowsWithValues) {
          const key = JSON.stringify(values);
          unique.set(
            key,
            new Map(node.output.map((slot, index) => [slot, values[index]])),
          );
        }
        rows.set(node.id, [...unique.values()]);
        break;
      }
      default:
        throw new Error(`set_fixture_unhandled_node:${node.kind}`);
    }
  }

  const relationRows = rows.get(outputRelation);
  const relation = byId.get(outputRelation);
  if (!relationRows || !relation || relation.grain.kind !== "entity") {
    throw new Error("set_fixture_output_entity_set_expected");
  }
  const grain = relation.grain;
  return new Set(relationRows.map((row) => String(row.get(grain.key))));
}

function materialize(
  builder: LogicalPlanBuilder,
  analysis: AnalyzedFilterDocument,
  options: FilterDocumentLoweringOptions,
): {
  readonly result: FilterDocumentLoweringResult;
  readonly plan?: LogicalPlan;
} {
  const result = lowerFilterDocumentToScope(builder, analysis, options);
  if (result.kind !== "supported") return { result };
  const plan = outputPlan(builder, result);
  return { result, plan };
}

describe("FilterDocument Boolean lowering", () => {
  it("lowers one normalized condition into each concrete candidate scope", () => {
    const cases = [
      {
        field: "page.path",
        scope: "observation",
        domain: "read",
        value: "/docs",
      },
      { field: "session.views", scope: "session", domain: "filter", value: 2 },
      {
        field: "visitor.sessions",
        scope: "visitor",
        domain: "candidate",
        value: 3,
      },
    ] as const;

    for (const item of cases) {
      const builder = createBuilder();
      const analysis = analyzeExpression(
        fieldCondition(item.field, "eq", item.value),
      );
      const observedConditions: FilterCondition[] = [];
      const lowered = materialize(builder, analysis, {
        targetScope: item.scope,
        resolveTemporalDomain: ({ condition }) => {
          observedConditions.push(condition);
          return item.domain;
        },
      });

      expect(lowered.result).toMatchObject({
        kind: "supported",
        scope: item.scope,
      });
      expect(observedConditions[0]).toBe(analysis.document.root);
      const nativeSource =
        item.scope === "observation" ? "observation" : item.scope;
      expect(
        lowered.plan?.nodes.some(
          (node) =>
            node.kind === "source" &&
            node.entity === nativeSource &&
            node.temporalDomain === item.domain,
        ),
      ).toBe(true);
      expect(
        lowered.plan?.nodes.some(
          (node) =>
            node.kind === "source" &&
            node.entity === "observation" &&
            node.temporalDomain === "candidate",
        ),
      ).toBe(true);
      expect(printLogicalPlan(lowered.plan!)).toContain("OUTPUT");
    }
  });

  it("preserves nested AND/OR/NOT across mixed explicit time domains", () => {
    const root: FilterExpression = {
      kind: "and",
      children: [
        fieldCondition("page.path", "eq", "/docs"),
        {
          kind: "or",
          children: [
            fieldCondition("session.views", "gte", 2),
            {
              kind: "not",
              child: fieldCondition("visitor.sessions", "gte", 4),
            },
          ],
        },
      ],
    };
    const analysis = analyzeExpression(root);
    const domains: Readonly<Record<string, TemporalDomainRef>> = {
      "page.path": "read",
      "session.views": "filter",
      "visitor.sessions": "candidate",
    };
    const lowered = materialize(createBuilder(), analysis, {
      targetScope: "visitor",
      resolveTemporalDomain: ({ condition }) =>
        domains[(condition.target as { field: string }).field],
    });

    expect(lowered.result.kind).toBe("supported");
    const operations = lowered.plan?.nodes
      .filter((node) => node.kind === "set-operation")
      .map((node) => node.operation);
    expect(operations).toContain("intersect");
    expect(operations).toContain("union");
    expect(operations).toContain("difference");
    expect(
      lowered.plan?.nodes.some(
        (node) =>
          node.kind === "source" &&
          node.entity === "observation" &&
          node.temporalDomain === "read",
      ),
    ).toBe(true);
    expect(
      lowered.plan?.nodes.some(
        (node) =>
          node.kind === "source" &&
          node.entity === "session" &&
          node.temporalDomain === "filter",
      ),
    ).toBe(true);
    expect(
      lowered.plan?.nodes.some(
        (node) =>
          node.kind === "source" &&
          node.entity === "visitor" &&
          node.temporalDomain === "candidate",
      ),
    ).toBe(true);
    expect(printLogicalPlan(lowered.plan!)).toMatchInlineSnapshot(`
      "LogicalPlan v1
        SUBJECT site sites=[site-a]
        SCOPE requested=auto contract=auto logical=auto

      r0 Source<visitor> grain=Entity<visitor>[s0] domain=candidate
        VALUE self -> s0:Entity<visitor>!{entity:visitor}
        VALUE attribute=visitor.sessions -> s1:Scalar<number>!{attribute:visitor.sessions}
        OUTPUT s0:Entity<visitor>!{entity:visitor}, s1:Scalar<number>!{attribute:visitor.sessions}

      r1 Filter grain=Entity<visitor>[s0] input=r0
        WHERE (s1 gte 4:Scalar<number>)
        OUTPUT s0:Entity<visitor>!{entity:visitor}, s1:Scalar<number>!{attribute:visitor.sessions}

      r2 Source<session> grain=Entity<session>[s2] domain=filter
        VALUE self -> s2:Entity<session>!{entity:session}
        VALUE attribute=session.views -> s3:Scalar<number>!{attribute:session.views}
        OUTPUT s2:Entity<session>!{entity:session}, s3:Scalar<number>!{attribute:session.views}

      r3 Filter grain=Entity<session>[s2] input=r2
        WHERE (s3 gte 2:Scalar<number>)
        OUTPUT s2:Entity<session>!{entity:session}, s3:Scalar<number>!{attribute:session.views}

      r4 Source<observation> grain=Entity<observation>[s4] domain=read
        VALUE self -> s4:Entity<observation>!{entity:observation}
        VALUE attribute=page.path -> s5:Scalar<string>?{attribute:page.path}
        OUTPUT s4:Entity<observation>!{entity:observation}, s5:Scalar<string>?{attribute:page.path}

      r5 Filter grain=Entity<observation>[s4] input=r4
        WHERE (s5 eq "/docs":Scalar<string> normalization=trim)
        OUTPUT s4:Entity<observation>!{entity:observation}, s5:Scalar<string>?{attribute:page.path}

      r6 Source<observation> grain=Entity<observation>[s6] domain=candidate
        VALUE self -> s6:Entity<observation>!{entity:observation}
        VALUE relationship=observation.visitor -> s7:Entity<visitor>?{relationship:observation.visitor}
        OUTPUT s6:Entity<observation>!{entity:observation}, s7:Entity<visitor>?{relationship:observation.visitor}

      r7 Distinct grain=Entity<visitor>[s8] excludeNull=true
        KEY s8:Entity<visitor>!{alias:s7} := s7:Entity<visitor>?{relationship:observation.visitor}
        OUTPUT s8:Entity<visitor>!{alias:s7}

      r8 Project grain=Entity<visitor>[s9] input=r1
        s9:Entity<visitor>!{alias:s0} := s0
        OUTPUT s9:Entity<visitor>!{alias:s0}

      r9 Distinct grain=Entity<visitor>[s10] excludeNull=true
        KEY s10:Entity<visitor>!{alias:s9} := s9:Entity<visitor>!{alias:s0}
        OUTPUT s10:Entity<visitor>!{alias:s9}

      r10 Intersect grain=Entity<visitor>[s11] inputs=[r7, r9]
        INPUT r7
        INPUT r9
        OUTPUT s11:Entity<visitor>!{derived:set:intersect(s8,s10)}

      r11 Difference grain=Entity<visitor>[s12] inputs=[r7, r10]
        INPUT r7
        INPUT r10
        OUTPUT s12:Entity<visitor>!{derived:set:difference(s8,s11)}

      r12 Project grain=Entity<session>[s13] input=r3
        s13:Entity<session>!{alias:s2} := s2
        OUTPUT s13:Entity<session>!{alias:s2}

      r13 Distinct grain=Entity<session>[s14] excludeNull=true
        KEY s14:Entity<session>!{alias:s13} := s13:Entity<session>!{alias:s2}
        OUTPUT s14:Entity<session>!{alias:s13}

      r14 RelationshipLookup<session.visitor> grain=Entity<session>[s14] input=r13 time=identity-no-activity-filter
        LOOKUP session.visitor BY s14:Entity<session>!{alias:s13} -> s15:Entity<visitor>?{relationship:session.visitor} (identity read; no activity-time filter)
        OUTPUT s14:Entity<session>!{alias:s13}, s15:Entity<visitor>?{relationship:session.visitor}

      r15 Project grain=Entity<session>[s17] input=r14
        s16:Entity<visitor>?{alias:s15} := s15
        s17:Entity<session>!{alias:s14} := s14
        OUTPUT s16:Entity<visitor>?{alias:s15}, s17:Entity<session>!{alias:s14}

      r16 Distinct grain=Entity<visitor>[s18] excludeNull=true
        KEY s18:Entity<visitor>!{alias:s16} := s16:Entity<visitor>?{alias:s15}
        OUTPUT s18:Entity<visitor>!{alias:s16}

      r17 Intersect grain=Entity<visitor>[s19] inputs=[r7, r16]
        INPUT r7
        INPUT r16
        OUTPUT s19:Entity<visitor>!{derived:set:intersect(s8,s18)}

      r18 Union grain=Entity<visitor>[s20] inputs=[r11, r17]
        INPUT r11
        INPUT r17
        OUTPUT s20:Entity<visitor>!{derived:set:union(s12,s19)}

      r19 Project grain=Entity<observation>[s21] input=r5
        s21:Entity<observation>!{alias:s4} := s4
        OUTPUT s21:Entity<observation>!{alias:s4}

      r20 Distinct grain=Entity<observation>[s22] excludeNull=true
        KEY s22:Entity<observation>!{alias:s21} := s21:Entity<observation>!{alias:s4}
        OUTPUT s22:Entity<observation>!{alias:s21}

      r21 RelationshipLookup<observation.visitor> grain=Entity<observation>[s22] input=r20 time=identity-no-activity-filter
        LOOKUP observation.visitor BY s22:Entity<observation>!{alias:s21} -> s23:Entity<visitor>?{relationship:observation.visitor} (identity read; no activity-time filter)
        OUTPUT s22:Entity<observation>!{alias:s21}, s23:Entity<visitor>?{relationship:observation.visitor}

      r22 Project grain=Entity<observation>[s25] input=r21
        s24:Entity<visitor>?{alias:s23} := s23
        s25:Entity<observation>!{alias:s22} := s22
        OUTPUT s24:Entity<visitor>?{alias:s23}, s25:Entity<observation>!{alias:s22}

      r23 Distinct grain=Entity<visitor>[s26] excludeNull=true
        KEY s26:Entity<visitor>!{alias:s24} := s24:Entity<visitor>?{alias:s23}
        OUTPUT s26:Entity<visitor>!{alias:s24}

      r24 Intersect grain=Entity<visitor>[s27] inputs=[r7, r23]
        INPUT r7
        INPUT r23
        OUTPUT s27:Entity<visitor>!{derived:set:intersect(s8,s26)}

      r25 Intersect grain=Entity<visitor>[s28] inputs=[r18, r24]
        INPUT r18
        INPUT r24
        OUTPUT s28:Entity<visitor>!{derived:set:intersect(s20,s27)}

      Outputs
        "matches" from r25
          "entity" -> s28:Entity<visitor>!{derived:set:intersect(s20,s27)}
      "
    `);
  });

  it("keeps null roots unfiltered and leaves the builder empty", () => {
    const builder = createBuilder();
    const lowered = lowerFilterDocumentToScope(
      builder,
      analyzeExpression(null),
      { targetScope: "session", resolveTemporalDomain: () => undefined },
    );

    expect(lowered).toEqual({ kind: "unfiltered" });
    expect(builder.finish().nodes).toHaveLength(0);
  });

  it("allows a normalized one-child Boolean group and lowers repeated leaves independently", () => {
    const repeated = fieldCondition("session.views", "gte", 2);
    const repeatedWithDifferentValue = fieldCondition(
      "session.views",
      "gte",
      3,
    );
    const analysis = analyzeExpression({
      kind: "and",
      children: [repeated, repeatedWithDifferentValue],
    });
    const seen: FilterCondition[] = [];
    const lowered = materialize(createBuilder(), analysis, {
      targetScope: "session",
      resolveTemporalDomain: ({ condition }) => {
        seen.push(condition);
        return "read";
      },
    });

    expect(lowered.result.kind).toBe("supported");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(
      analysis.document.root?.kind === "and"
        ? analysis.document.root.children[0]
        : null,
    );
    expect(seen[1]).toBe(
      analysis.document.root?.kind === "and"
        ? analysis.document.root.children[1]
        : null,
    );
    expect(
      lowered.plan?.nodes.filter(
        (node) =>
          node.kind === "source" &&
          node.entity === "session" &&
          node.temporalDomain === "read",
      ),
    ).toHaveLength(2);

    const single = analyzeExpression({ kind: "and", children: [repeated] });
    expect(
      materialize(createBuilder(), single, {
        targetScope: "session",
        resolveTemporalDomain: explicitDomain("read"),
      }).result.kind,
    ).toBe("supported");
  });

  it("returns the first unsupported leaf atomically with its AST path", () => {
    const analysis = analyzeExpression({
      kind: "and",
      children: [
        fieldCondition("page.path", "eq", "/docs"),
        {
          kind: "condition",
          target: {
            kind: "event-payload",
            path: "/amount",
          } as FilterCondition["target"],
          operator: "eq",
          value: 4,
        },
      ],
    });
    const builder = createBuilder();
    const lowered = lowerFilterDocumentToScope(builder, analysis, {
      targetScope: "visitor",
      resolveTemporalDomain: explicitDomain("read"),
    });

    expect(lowered).toMatchObject({
      kind: "unsupported",
      code: "unsupported-target",
      path: `root.children[${(() => {
        const root = analysis.document.root;
        return root?.kind === "and"
          ? root.children.findIndex(
              (child) =>
                child.kind === "condition" &&
                child.target.kind === "event-payload",
            )
          : -1;
      })()}]`,
      conditionTarget: "event-payload:/amount",
      operator: "eq",
    });
    expect(builder.finish().nodes).toHaveLength(0);
  });

  it.each([
    ["selector", "page { page.path exists } exists"],
    ["reducer", "count(event) eq 2"],
    ["event payload", 'event.payload("/amount") eq 4'],
  ])(
    "reports unsupported %s targets without partial plans",
    (_label, source) => {
      const analysis = analyzeDocument(
        parseFilterDsl(source, analyticsFilterRegistry),
      );
      const builder = createBuilder();
      const lowered = lowerFilterDocumentToScope(builder, analysis, {
        targetScope: "observation",
        resolveTemporalDomain: explicitDomain("read"),
      });

      expect(lowered.kind).toBe("unsupported");
      expect(builder.finish().nodes).toHaveLength(0);
    },
  );

  it("rejects missing or invalid per-condition domains before mutating the builder", () => {
    const analysis = analyzeExpression(
      fieldCondition("page.path", "eq", "/docs"),
    );
    const missingBuilder = createBuilder();
    expect(
      lowerFilterDocumentToScope(missingBuilder, analysis, {
        targetScope: "observation",
        resolveTemporalDomain: () => undefined,
      }),
    ).toMatchObject({
      kind: "unsupported",
      code: "missing-condition-time-domain",
      path: "root",
    });
    expect(missingBuilder.finish().nodes).toHaveLength(0);

    const invalidBuilder = createBuilder();
    expect(
      lowerFilterDocumentToScope(invalidBuilder, analysis, {
        targetScope: "observation",
        resolveTemporalDomain: () => "missing" as TemporalDomainRef,
      }),
    ).toMatchObject({
      kind: "unsupported",
      code: "invalid-condition-time-domain",
      path: "root",
    });
    expect(invalidBuilder.finish().nodes).toHaveLength(0);
  });

  it("rejects stale sidecars, malformed empty groups, and non-concrete scopes", () => {
    const first = analyzeExpression(fieldCondition("page.path", "eq", "/docs"));
    const second = analyzeExpression(fieldCondition("session.views", "gte", 2));
    const stale = {
      ...first,
      document: second.document,
    } as AnalyzedFilterDocument;
    expect(
      lowerFilterDocumentToScope(createBuilder(), stale, {
        targetScope: "observation",
        resolveTemporalDomain: explicitDomain("read"),
      }),
    ).toMatchObject({ kind: "unsupported", code: "invalid-analysis" });

    const malformed = {
      version: 1,
      root: { kind: "and", children: [] },
    } as unknown as FilterDocument;
    const invalidAnalysis = {
      document: malformed,
      conditions: new WeakMap(),
    } as unknown as AnalyzedFilterDocument;
    expect(
      lowerFilterDocumentToScope(createBuilder(), invalidAnalysis, {
        targetScope: "observation",
        resolveTemporalDomain: explicitDomain("read"),
      }),
    ).toMatchObject({ kind: "unsupported", code: "invalid-document" });

    expect(
      lowerFilterDocumentToScope(createBuilder(), first, {
        targetScope: "auto" as LogicalFilterScope,
        resolveTemporalDomain: explicitDomain("read"),
      }),
    ).toMatchObject({ kind: "unsupported", code: "invalid-target-scope" });
  });

  it("rejects invalid builders, documents, resolved scopes, and missing selectors", () => {
    const analysis = analyzeExpression(
      fieldCondition("page.path", "eq", "/docs"),
    );
    expect(
      lowerFilterDocumentToScope({} as LogicalPlanBuilder, analysis, {
        targetScope: "observation",
        resolveTemporalDomain: explicitDomain("read"),
      }),
    ).toMatchObject({ kind: "unsupported", code: "invalid-analysis" });

    const invalidVersion = {
      document: { version: 2, root: null },
      conditions: new WeakMap(),
    } as unknown as AnalyzedFilterDocument;
    expect(
      lowerFilterDocumentToScope(createBuilder(), invalidVersion, {
        targetScope: "observation",
        resolveTemporalDomain: explicitDomain("read"),
      }),
    ).toMatchObject({ kind: "unsupported", code: "invalid-analysis" });

    const unparseable = {
      document: {
        version: 1,
        root: { kind: "not-a-filter-node" },
      },
      conditions: new WeakMap(),
    } as unknown as AnalyzedFilterDocument;
    expect(
      lowerFilterDocumentToScope(createBuilder(), unparseable, {
        targetScope: "observation",
        resolveTemporalDomain: explicitDomain("read"),
      }),
    ).toMatchObject({ kind: "unsupported", code: "invalid-analysis" });

    expect(
      lowerFilterDocumentToScope(
        createBuilder(resolveAnalyticsScope("session")),
        analysis,
        {
          targetScope: "visitor",
          resolveTemporalDomain: explicitDomain("read"),
        },
      ),
    ).toMatchObject({ kind: "unsupported", code: "invalid-target-scope" });

    expect(
      lowerFilterDocumentToScope(createBuilder(), analysis, {
        targetScope: "observation",
      } as FilterDocumentLoweringOptions),
    ).toMatchObject({
      kind: "unsupported",
      code: "missing-condition-time-domain",
      path: "root",
    });
  });

  it("reports temporal selector exceptions at the original condition path", () => {
    const analysis = analyzeExpression({
      kind: "not",
      child: fieldCondition("page.path", "eq", "/docs"),
    });
    for (const thrown of [new Error("selector failed"), "selector failed"]) {
      const lowered = lowerFilterDocumentToScope(createBuilder(), analysis, {
        targetScope: "observation",
        resolveTemporalDomain: () => {
          throw thrown;
        },
      });
      expect(lowered).toMatchObject({
        kind: "unsupported",
        code: "time-domain-resolution-failed",
        path: "root.child",
      });
      expect(lowered.kind === "unsupported" && lowered.reason).toContain(
        "selector failed",
      );
    }
  });

  it("rejects sidecars whose condition identity lookup throws", () => {
    const analysis = analyzeExpression(
      fieldCondition("page.path", "eq", "/docs"),
    );
    const brokenSidecar = {
      ...analysis,
      conditions: {
        get() {
          throw new Error("invalid condition map");
        },
      } as unknown as AnalyzedFilterDocument["conditions"],
    };

    expect(
      lowerFilterDocumentToScope(createBuilder(), brokenSidecar, {
        targetScope: "observation",
        resolveTemporalDomain: explicitDomain("read"),
      }),
    ).toMatchObject({
      kind: "unsupported",
      code: "invalid-analysis",
      path: "root",
    });
  });

  it("converts a condition-lowering sidecar failure into an atomic unsupported result", () => {
    const analysis = analyzeExpression(
      fieldCondition("page.path", "eq", "/docs"),
    );
    const condition = analysis.document.root as FilterCondition;
    const semantics = analysis.conditions.get(condition)!;
    let lookups = 0;
    const unstableSidecar = {
      ...analysis,
      conditions: {
        get() {
          lookups += 1;
          if (lookups === 2) throw new Error("sidecar changed during lowering");
          return semantics;
        },
      } as unknown as AnalyzedFilterDocument["conditions"],
    };
    const builder = createBuilder();

    expect(
      lowerFilterDocumentToScope(builder, unstableSidecar, {
        targetScope: "observation",
        resolveTemporalDomain: explicitDomain("read"),
      }),
    ).toMatchObject({
      kind: "unsupported",
      code: "condition-lowering-failed",
      path: "root",
    });
    expect(builder.finish().nodes).toHaveLength(0);
  });

  it("propagates a nested unsupported leaf without lowering its parent", () => {
    const analysis = analyzeExpression({
      kind: "not",
      child: {
        kind: "condition",
        target: {
          kind: "event-payload",
          path: "/amount",
        } as FilterCondition["target"],
        operator: "eq",
        value: 4,
      },
    });
    const builder = createBuilder();
    expect(
      lowerFilterDocumentToScope(builder, analysis, {
        targetScope: "visitor",
        resolveTemporalDomain: explicitDomain("read"),
      }),
    ).toMatchObject({
      kind: "unsupported",
      code: "unsupported-target",
      path: "root.child",
    });
    expect(builder.finish().nodes).toHaveLength(0);
  });

  it("executes cross-record AND over a shared visitor candidate set", () => {
    const analysis = analyzeExpression({
      kind: "and",
      children: [
        fieldCondition("page.path", "eq", "/keep"),
        fieldCondition("visitor.sessions", "gte", 3),
      ],
    });
    const builder = createBuilder();
    const lowered = materialize(builder, analysis, {
      targetScope: "visitor",
      resolveTemporalDomain: explicitDomain("read"),
    });
    expect(lowered.result.kind).toBe("supported");

    const entities = evaluateEntitySet(
      lowered.plan!,
      new Map([
        [
          "observation:candidate",
          [
            { entity: "O1", "relationship:observation.visitor": "V1" },
            { entity: "O2", "relationship:observation.visitor": "V2" },
          ],
        ],
        [
          "observation:read",
          [
            {
              entity: "O1",
              "attribute:page.path": "/keep",
            },
            {
              entity: "O3",
              "attribute:page.path": "/keep",
            },
          ],
        ],
        [
          "visitor:read",
          [
            { entity: "V1", "attribute:visitor.sessions": 3 },
            { entity: "V2", "attribute:visitor.sessions": 1 },
            { entity: "V3", "attribute:visitor.sessions": 8 },
          ],
        ],
      ]),
      [
        {
          siteId: SITE_ID,
          relationship: "observation.visitor",
          from: "O1",
          to: "V1",
        },
        {
          siteId: SITE_ID,
          relationship: "observation.visitor",
          from: "O3",
          to: "V3",
        },
      ],
      lowered.result.kind === "supported"
        ? lowered.result.selection.relation.id
        : (0 as RelationId),
    );

    expect(entities).toEqual(new Set(["V1"]));
  });

  it("defines NOT as candidate-universe complement and excludes historical-only visitors", () => {
    const analysis = analyzeExpression({
      kind: "not",
      child: fieldCondition("visitor.sessions", "gte", 3),
    });
    const lowered = materialize(createBuilder(), analysis, {
      targetScope: "visitor",
      resolveTemporalDomain: explicitDomain("read"),
    });
    expect(lowered.result.kind).toBe("supported");

    const difference = lowered.plan!.nodes.find(
      (node): node is Extract<LogicalNode, { kind: "set-operation" }> =>
        node.kind === "set-operation" && node.operation === "difference",
    );
    expect(difference).toBeDefined();
    expect(difference!.inputs).toHaveLength(2);

    const entities = evaluateEntitySet(
      lowered.plan!,
      new Map([
        [
          "observation:candidate",
          [
            { entity: "O1", "relationship:observation.visitor": "V1" },
            { entity: "O2", "relationship:observation.visitor": "V2" },
          ],
        ],
        [
          "visitor:read",
          [
            { entity: "V1", "attribute:visitor.sessions": 3 },
            { entity: "V2", "attribute:visitor.sessions": 1 },
            { entity: "V3", "attribute:visitor.sessions": 8 },
          ],
        ],
      ]),
      [],
      lowered.result.kind === "supported"
        ? lowered.result.selection.relation.id
        : (0 as RelationId),
    );

    expect(entities).toEqual(new Set(["V2"]));
  });
});
