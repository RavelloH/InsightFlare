import { afterEach, describe, expect, it, vi } from "vitest";

import {
  constant,
  isNotNull,
  isNull,
  project,
  rowNumber,
  scan,
  window,
} from "@/lib/db";
import * as d1Budget from "@/lib/db/d1-budget";
import {
  compileD1Query,
  compileD1QueryWithFinalRenderForTest,
} from "@/lib/db/query/compiler";
import { createFinalRenderSession } from "@/lib/db/query/render/final-render-session";
import {
  concat,
  finalRenderEmissionCounts,
  recordFinalRenderEmission,
} from "@/lib/db/query/render/fragment-provenance";
import { schema } from "@/lib/db/schema";
import { text } from "@/lib/db/sql/fragment";

afterEach(() => vi.restoreAllMocks());

function rankByNullableDuration(notNull: boolean) {
  const source = scan(schema.visits);
  const duration = source.columns.duration_ms!;
  const ranked = window(source, {
    rank: rowNumber({
      orderBy: [
        {
          expression: notNull ? isNotNull(duration) : isNull(duration),
          direction: "ASC",
        },
        { expression: duration, direction: "DESC" },
      ],
    }),
  });
  return project(ranked, {
    id: ranked.columns.visit_id!,
    rank: ranked.columns.rank!,
    marker: constant(notNull ? "not-null" : "nullable"),
  });
}

describe("request-local final render sessions", () => {
  it("counts repeated reachable emissions but drops discarded trial fragments", () => {
    const session = createFinalRenderSession();
    const choice = {};
    const discardedChoice = {};
    const emitted = recordFinalRenderEmission(session, text("native"), {
      kind: "native-null-ordering",
      choice,
    });
    const discarded = recordFinalRenderEmission(session, text("trial"), {
      kind: "native-null-ordering",
      choice: discardedChoice,
    });
    const finalFragment = concat(emitted, emitted);
    const counts = finalRenderEmissionCounts(session, finalFragment);

    expect(counts.nativeNullOrdering.get(choice)).toBe(2);
    expect(counts.nativeNullOrdering.has(discardedChoice)).toBe(false);
    expect(counts.totalEmissionCount).toBe(2);
    expect(
      finalRenderEmissionCounts(session, discarded).totalEmissionCount,
    ).toBe(1);
    expect(
      finalRenderEmissionCounts(session, text("ordinary query"))
        .totalEmissionCount,
    ).toBe(0);
  });

  it("keeps two production compiles isolated and reports the exact returned query", () => {
    const first = compileD1QueryWithFinalRenderForTest(
      rankByNullableDuration(false),
    );
    const second = compileD1QueryWithFinalRenderForTest(
      rankByNullableDuration(true),
    );

    expect(first.finalRender.query).toBe(first.query);
    expect(second.finalRender.query).toBe(second.query);
    expect(first.finalRender.fragment.text).toBe(first.query.sql);
    expect(second.finalRender.fragment.text).toBe(second.query.sql);
    expect(first.finalRender.emissionCounts.nativeNullOrdering.size).toBe(1);
    expect(second.finalRender.emissionCounts.nativeNullOrdering.size).toBe(1);
    expect(first.query.sql).toContain("NULLS LAST");
    expect(second.query.sql).toContain("NULLS FIRST");
  });

  it("leaves ordinary query shapes on their existing version", () => {
    const source = scan(schema.site_identities);
    const query = compileD1Query(
      project(source, { siteId: source.columns.site_id! }),
    );

    expect(query.physicalPlanShape?.version).toBe(1);
  });

  it("captures the fresh frame after the optimizer SQL-budget fallback render", () => {
    const budgetError = new d1Budget.D1StatementBudgetError(
      "sql_bytes",
      100_001,
      100_000,
      "final-render-session-fallback",
    );
    const budgetSpy = vi
      .spyOn(d1Budget, "assertD1StatementBudget")
      .mockImplementationOnce(() => {
        throw budgetError;
      });

    const result = compileD1QueryWithFinalRenderForTest(
      rankByNullableDuration(false),
      { tag: "final-render-session-fallback" },
    );

    expect(budgetSpy).toHaveBeenCalledTimes(2);
    expect(result.finalRender.query).toBe(result.query);
    expect(result.finalRender.fragment.text).toBe(result.query.sql);
    expect(result.finalRender.emissionCounts.nativeNullOrdering.size).toBe(1);
    expect(
      result.query.physicalPlanShape?.version === 12
        ? result.query.physicalPlanShape.nativeNullOrderingCount
        : 0,
    ).toBe(1);
  });

  it("rejects fragment composition across render owners", () => {
    const first = createFinalRenderSession();
    const second = createFinalRenderSession();
    const left = recordFinalRenderEmission(first, text("left"), {
      kind: "native-null-ordering",
      choice: {},
    });
    const right = recordFinalRenderEmission(second, text("right"), {
      kind: "native-null-ordering",
      choice: {},
    });
    expect(() => concat(left, right)).toThrow(
      "sql_fragments_from_different_render_sessions",
    );
  });
});
