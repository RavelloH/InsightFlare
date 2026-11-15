// @vitest-environment node
import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import type * as DatabaseApi from "@/lib/db";
import {
  callFunction,
  caseWhen,
  coalesce,
  constant,
  eq,
  inSubquery,
  join,
  not,
  project,
  scalar,
  sort,
  valuesRelation,
} from "@/lib/db";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import type { CompiledQuery } from "@/lib/db/query/compiled";
import { compileD1Query } from "@/lib/db/query/compiler";
import { compileD1AdaptiveQueryForTest } from "@/lib/db/query/compiler";
import type {
  ColumnExpression,
  ExpressionResultType,
} from "@/lib/db/query/expression";
import { rebindColumn } from "@/lib/db/query/expression";
import type { PhysicalQueryPlan } from "@/lib/db/query/physical/contracts";
import { deriveRuntimeBooleanMembership } from "@/lib/db/query/physical/runtime-boolean-membership";
import { lowerLogicalQuerySource } from "@/lib/db/query/physical-plan";
import type { QuerySource } from "@/lib/db/query/plan";
import type { Relation } from "@/lib/db/query/plan";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import { siteQueryContext } from "@/lib/edge/analytics/contract";
import {
  buildJourneyEventFieldsCostFixture,
  NEXT_FUNNEL_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  COST_TIME,
  observeCostDatabase,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/referrers-cost-harness";
import { SEED_SITE_ID } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
function asRelation(source: QuerySource): Relation {
  return {
    ...source,
    kind: "relation",
    columns: Object.fromEntries(
      source.fields.map((field, index) => [
        field.name,
        rebindColumn(source.scope, index, field.name, {
          affinity: field.affinity,
          nullable: field.nullable,
        }),
      ]),
    ),
  };
}
const state = vi.hoisted(() => ({
  adaptive: true,
  plans: [] as PhysicalQueryPlan<object>[],
}));
vi.mock("@/lib/db", async (importOriginal) => {
  const db = await importOriginal<typeof DatabaseApi>();
  const compiler = await import("@/lib/db/query/compiler");
  const planner = await import("@/lib/db/query/physical-plan");
  return {
    ...db,
    lowerLogicalPlan: planner.lowerLogicalPlan,
    compileD1Query: (
      source: Relation<object> | PhysicalQueryPlan<object>,
      options: Parameters<typeof compiler.compileD1Query>[1],
    ) => {
      const physical =
        source.kind === "physical-query"
          ? source
          : planner.lowerLogicalPlan(source);
      const q = compiler.compileD1Query(physical, options);
      if (physical.runtimeAdaptiveCandidate) state.plans.push(physical);
      return state.adaptive ? q : { ...q };
    },
  };
});
for (const scope of ["session", "visitor"] as const) {
  for (const stage of ["provider-parity", "physical-proof"] as const) {
    it(`preserves dirty Sessions DTO and cursors through the default adaptive compiler and keeps overflowing false branches lazy (${scope}/${stage})`, async () => {
      const native = createMigratedDatabase();
      for (const sql of buildJourneyEventFieldsCostFixture(120).seed)
        native.exec(sql);
      native.exec(
        "UPDATE visits SET duration_ms='invalid-duration' WHERE visit_id='v1'",
      );
      try {
        const run = async (adaptive: boolean, cursor: string | null = null) => {
          state.adaptive = adaptive;
          state.plans = [];
          const observed = observeCostDatabase(createSqliteD1Database(native));
          const runtime = createD1SiteQueryRuntime({
            env: {
              DB: observed.database,
              MAIN_SECRET: "session-aggregate-regression",
            } as never,
            siteId: SEED_SITE_ID,
            diagnostics: createD1ReadDiagnostics(),
          });
          const dto = await runtime.execute(
            "sessions",
            {
              context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
              time: COST_TIME,
              scopePreference: scope,
              filters: parseFilterDsl(
                "count(page { page.durationMs gt 5 }) gte 1",
                analyticsFilterRegistry,
              ),
              analysisContext: {
                type: "funnel",
                funnelId: NEXT_FUNNEL_ID,
                stepId: "qualified",
              },
              page: { limit: 3, cursor },
              sort: { key: "startedAt", direction: "desc" },
            },
            {
              onProviderError(e) {
                throw e;
              },
            },
          );
          if (!dto.ok) throw new Error(JSON.stringify(dto));
          return {
            dto,
            observations: observed.observations,
            plans: [...state.plans],
          };
        };
        if (stage === "provider-parity") {
          const ordinary = await run(false),
            adaptive = await run(true);
          expect(adaptive.dto).toEqual(ordinary.dto);
          expect(adaptive.observations).toHaveLength(
            ordinary.observations.length,
          );
          expect(adaptive.observations.at(-1)?.sql).toContain(
            "_d1_adaptive_guard",
          );
          expect(ordinary.observations.at(-1)?.sql).not.toContain(
            "_d1_adaptive_guard",
          );
          expect(adaptive.plans).toHaveLength(1);
          const cursor = ordinary.dto.data.pagination.nextCursor;
          expect(cursor).not.toBeNull();
          expect((await run(true, cursor)).dto).toEqual(
            (await run(false, cursor)).dto,
          );
          return;
        }
        const adaptive = await run(true);
        const p = adaptive.plans[0]!;
        const recipe = p.runtimeAdaptiveCandidate!;
        expect(recipe.positiveMembership).toHaveLength(2);
        expect(recipe.negativeMembership).toHaveLength(1);
        const anti = recipe.negativeMembership[0]!;
        expect(anti.kind).toBe("anti-join");
        expect(adaptive.observations.at(-1)?.sql).toContain("IS NOT TRUE");
        expect(adaptive.observations.at(-1)?.sql).not.toContain("NOT EXISTS");
        const negative = recipe.negativeMembership;
        try {
          Reflect.set(recipe, "negativeMembership", []);
          expect(() => compileD1Query(p)).toThrow(/inconsistent/);
        } finally {
          Reflect.set(recipe, "negativeMembership", negative);
        }
        const condition = anti.condition;
        if (condition.kind !== "binary" || condition.right.kind !== "column") {
          throw new Error("Expected complete direct anti-key equality");
        }
        for (const changed of [
          { ...condition, operator: "<>" },
          { ...condition, right: { ...condition.right, index: 999 } },
          { ...condition, right: { ...condition.right, scope: {} } },
          { ...condition, right: { ...condition.right, name: "wrong" } },
          {
            ...condition,
            right: {
              ...condition.right,
              resultType: { affinity: "integer", nullable: true },
            },
          },
        ]) {
          try {
            Reflect.set(anti, "condition", changed);
            expect(
              deriveRuntimeBooleanMembership(p).filter(
                (c) => c.observation === "negative-boolean-membership",
              ),
            ).toHaveLength(0);
          } finally {
            Reflect.set(anti, "condition", condition);
          }
        }
        const antiRelation = asRelation({
          node: anti,
          scope: anti.scope,
          fields: anti.fields,
        });
        const rawKey = Object.values(antiRelation.columns)[0]!;
        expect(rawKey.resultType.affinity).toBe("text");
        const key = rawKey as ColumnExpression<
          string | null,
          ExpressionResultType<"text", true>
        >;
        const observed = project(antiRelation, { value: key });
        const singleton = valuesRelation(
          { one: { affinity: "text", nullable: false } },
          [{ one: "one" }],
        );
        const expressions = [
          scalar(observed),
          callFunction(
            "lower",
            coalesce(scalar(observed), constant("missing")),
          ),
          caseWhen(
            [
              {
                when: eq(singleton.columns.one, constant("one")),
                then: scalar(observed),
              },
            ],
            constant("missing"),
          ),
          inSubquery(singleton.columns.one, observed),
          not(inSubquery(singleton.columns.one, observed)),
        ];
        for (const expression of expressions) {
          const side = project(singleton, { observed: expression });
          const paired = join(
            asRelation({ node: p.root, scope: p.scope, fields: p.fields }),
            side,
            eq(constant(1), constant(1)),
          );
          const fresh = lowerLogicalQuerySource(
            sort(paired, [
              { expression: paired.columns.left_sessionId!, direction: "ASC" },
            ]),
          );
          const choices = deriveRuntimeBooleanMembership(fresh);
          expect(
            choices.filter(
              (c) => c.observation === "negative-boolean-membership",
            ),
          ).toHaveLength(0);
          expect(
            choices.filter(
              (c) => c.observation === "positive-boolean-membership",
            ),
          ).toHaveLength(2);
        }
        const compiled = compileD1AdaptiveQueryForTest(p);
        expect(compiled.query).toBeDefined();
        const execute = (query: CompiledQuery<object>) => {
          const s = native.prepare(query.sql);
          s.setReadBigInts(true);
          return s.all(
            ...(query.bindings ?? []).map((v) => {
              if (typeof v === "boolean") return Number(v);
              if (
                v === null ||
                typeof v === "number" ||
                typeof v === "string" ||
                typeof v === "bigint" ||
                v instanceof Uint8Array
              )
                return v;
              throw new Error("Unexpected fixture binding");
            }),
          );
        };
        native.exec("SAVEPOINT aggregate_boundary");
        try {
          for (const value of [
            "3",
            "9007199254",
            "9007199255",
            "1.5",
            "'invalid-duration'",
            "NULL",
            "9223372036854775807",
          ]) {
            native.exec(`UPDATE visits SET duration_ms=${value}`);
            const rows = execute(compiled.query!);
            expect(rows[0]?.["_d1_adaptive_tag"]).toBe(0n);
            if (["9007199255", "1.5", "9223372036854775807"].includes(value)) {
              expect(rows).toHaveLength(1);
              expect(rows[0]?.["_d1_adaptive_allowed"]).toBe(0n);
            } else {
              const raw = execute(compiled.original);
              const decoded = rows
                .slice(1)
                .map((r) =>
                  Object.fromEntries(
                    Object.entries(r).filter(
                      ([k]) => !k.startsWith("_d1_adaptive_"),
                    ),
                  ),
                );
              expect(decoded).toEqual(raw);
            }
            if (value === "9223372036854775807")
              expect(() => execute(compiled.original)).toThrow(
                "integer overflow",
              );
          }
          let terminal = p.root;
          while (terminal.kind !== "limit" && "input" in terminal)
            terminal = terminal.input.node;
          if (terminal.kind !== "limit" || terminal.count.kind !== "parameter")
            throw new Error("Expected real terminal limit");
          const savedLimit = terminal.count.value;
          Reflect.set(terminal.count, "value", 0);
          try {
            expect(() => compileD1AdaptiveQueryForTest(p)).toThrow(
              "Physical runtime adaptive candidate is inconsistent",
            );
            const zero = compileD1AdaptiveQueryForTest({
              ...p,
              runtimeAdaptiveCandidate: undefined,
            });
            expect(zero.query).toBeUndefined();
            expect(zero.derivation).toMatchObject({
              eligible: false,
              reason: "unsafe-terminal-path",
            });
            expect(execute(zero.original)).toEqual([]);
          } finally {
            Reflect.set(terminal.count, "value", savedLimit);
          }
        } finally {
          native.exec("ROLLBACK TO aggregate_boundary");
          native.exec("RELEASE aggregate_boundary");
        }
      } finally {
        native.close();
      }
    }, 30000);
  }
}
