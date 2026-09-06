import { describe, expect, it } from "vitest";

import type {
  FunnelDefinition,
  FunnelDetailData,
  FunnelMutationData,
} from "@/lib/edge-client";
import {
  createDemoFunnel,
  deleteDemoFunnel,
  generateDemoFunnels,
  updateDemoFunnel,
} from "@/lib/realtime/mock/funnels";

const SITE_ID = "demo-site-001";

function listOf(
  result: ReturnType<typeof generateDemoFunnels>,
): FunnelDefinition[] {
  if (result.ok && "items" in result.data) return result.data.items;
  throw new Error("expected funnel list");
}

function detailOf(
  result: ReturnType<typeof generateDemoFunnels>,
): FunnelDetailData["data"] {
  if (result.ok && "analysis" in result.data) return result.data;
  throw new Error("expected funnel detail");
}

function mutationOf(
  result: ReturnType<typeof createDemoFunnel>,
): FunnelMutationData["data"] {
  if (result.ok) return result.data;
  throw new Error("expected funnel mutation");
}

describe("mock/funnels v2", () => {
  it("returns v2 definitions and progression analysis", () => {
    const list = listOf(generateDemoFunnels(SITE_ID, {}));
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0]).toMatchObject({
      filterDslVersion: 1,
      semanticFingerprint: expect.any(String),
    });
    expect(list[0]?.steps[0]).toHaveProperty("filterDsl");

    const detail = detailOf(generateDemoFunnels(SITE_ID, { id: list[0]!.id }));
    expect(detail.analysis.progressionScope).toBe(list[0]!.progressionScope);
    expect(detail.analysis.steps[0]).toHaveProperty("progression");
    expect(detail.analysis.summary).toHaveProperty("totalProgressions");
  });

  it("creates, updates, and deletes a v2 funnel", () => {
    const input = {
      name: "Custom funnel",
      progressionScope: "visitor" as const,
      conversionWindowMs: 86_400_000,
      steps: [
        { id: "start", filterDsl: 'page.path eq "/start"' },
        { id: "finish", filterDsl: 'event.name eq "finish"' },
      ],
    };
    const created = mutationOf(createDemoFunnel(SITE_ID, input));
    expect(created.funnel).toMatchObject({
      name: input.name,
      progressionScope: "visitor",
    });
    expect(created.funnel.steps).toEqual(input.steps);

    const updated = mutationOf(
      updateDemoFunnel(SITE_ID, { id: created.funnel.id }, { name: "Renamed" }),
    );
    expect(updated.funnel.name).toBe("Renamed");
    expect(updated.funnel.semanticFingerprint).toBe(
      created.funnel.semanticFingerprint,
    );
    expect(deleteDemoFunnel(SITE_ID, { id: created.funnel.id })).toEqual({
      ok: true,
    });
  });

  it("rejects invalid v2 input", () => {
    const result = createDemoFunnel(SITE_ID, {
      name: "Bad",
      progressionScope: "visitor",
      conversionWindowMs: null,
      steps: [
        { id: "one", filterDsl: 'page.path eq "/one"' },
        { id: "two", filterDsl: 'page.path eq "/two"' },
      ],
    });
    expect(result.ok).toBe(false);
  });
});
