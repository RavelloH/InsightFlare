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
} from "@/lib/realtime/mock/funnels";
import type { ErrorEnvelope } from "@/lib/response-envelope";

const SITE_ID = "demo-site-001";

type FunnelResult = ReturnType<typeof generateDemoFunnels>;

function listOf(result: FunnelResult): FunnelDefinition[] {
  if (result.ok === true && "data" in result && "items" in result.data) {
    return result.data.items;
  }
  throw new Error("expected funnel list");
}

function detailOf(result: FunnelResult): FunnelDetailData["data"] {
  if (result.ok === true && "data" in result && "analysis" in result.data) {
    return result.data;
  }
  throw new Error("expected funnel detail");
}

function createdOf(
  result: ReturnType<typeof createDemoFunnel>,
): FunnelMutationData["data"] {
  if (result.ok === true) return result.data;
  throw new Error("expected created funnel");
}

function errorOf(result: { ok: boolean }): ErrorEnvelope {
  if (result.ok === false && "error" in result) {
    return result as unknown as ErrorEnvelope;
  }
  throw new Error("expected error envelope");
}

describe("mock/funnels", () => {
  describe("generateDemoFunnels", () => {
    it("returns a list of funnels when no id param is provided", () => {
      const result = generateDemoFunnels(SITE_ID, {});
      expect(result.ok).toBe(true);
      const funnels = listOf(result);
      expect(funnels.length).toBeGreaterThanOrEqual(2);
      for (const funnel of funnels) {
        expect(funnel.siteId).toBe(SITE_ID);
        expect(funnel.steps.length).toBeGreaterThanOrEqual(2);
      }
    });

    it("returns detail with analysis when a matching id is provided", () => {
      const list = generateDemoFunnels(SITE_ID, {});
      const firstId = listOf(list)[0]?.id;
      expect(firstId).toBeDefined();

      const detail = generateDemoFunnels(SITE_ID, { id: firstId! });
      expect(detail.ok).toBe(true);
      const data = detailOf(detail);
      expect(data.analysis.steps.length).toBeGreaterThan(0);
      expect(data.analysis.summary.totalSessions).toBeGreaterThan(0);
      expect(data.analysis.summary.convertedSessions).toBeGreaterThanOrEqual(0);
      expect(
        data.analysis.summary.overallConversionRate,
      ).toBeGreaterThanOrEqual(0);
      expect(data.analysis.summary.overallConversionRate).toBeLessThanOrEqual(
        1,
      );
    });

    it("returns a standard not-found error when the id does not match", () => {
      const detail = generateDemoFunnels(SITE_ID, { id: "nonexistent-id" });
      expect(detail.ok).toBe(false);
      const error = errorOf(detail);
      expect(error.error.code).toBe("not_found");
    });

    it("includes template funnels for non-demo-site-001 sites", () => {
      const result = generateDemoFunnels("other-site", {});
      expect(result.ok).toBe(true);
      for (const funnel of listOf(result)) {
        expect(funnel.siteId).toBe("other-site");
      }
    });

    it("returns analysis steps with correct conversion math", () => {
      const detail = generateDemoFunnels(SITE_ID, {
        id: "demo-funnel-signup",
      });
      const { steps, summary } = detailOf(detail).analysis;
      expect(steps[0].dropOffSessions).toBe(0);
      expect(steps[0].conversionRate).toBe(1);
      for (let i = 1; i < steps.length; i++) {
        expect(steps[i].dropOffSessions).toBeGreaterThanOrEqual(0);
        expect(steps[i].stepConversionRate).toBeLessThanOrEqual(1);
      }
      expect(summary.totalSessions).toBe(steps[0].sessions);
      expect(summary.convertedSessions).toBe(steps[steps.length - 1].sessions);
    });

    it("tracks the largest drop-off step index", () => {
      const detail = generateDemoFunnels(SITE_ID, {
        id: "demo-funnel-checkout",
      });
      const analysis = detailOf(detail).analysis;
      expect(analysis.summary.largestDropOffStepIndex).not.toBeNull();
      expect(analysis.summary.largestDropOffStepIndex!).toBeGreaterThanOrEqual(
        1,
      );
    });

    it("handles empty id string (whitespace) as list request", () => {
      const result = generateDemoFunnels(SITE_ID, { id: "   " });
      expect(result.ok).toBe(true);
      expect(listOf(result).length).toBeGreaterThan(0);
    });
  });

  describe("createDemoFunnel", () => {
    it("creates a funnel with the provided name and steps", () => {
      const result = createDemoFunnel(SITE_ID, {
        name: "Custom funnel",
        steps: [
          { type: "pageview", value: "/home" },
          { type: "event", value: "signup" },
        ],
      });
      expect(result.ok).toBe(true);
      const funnel = createdOf(result).funnel;
      expect(funnel.name).toBe("Custom funnel");
      expect(funnel.steps).toHaveLength(2);
      expect(funnel.steps[0]).toEqual({
        type: "pageview",
        value: "/home",
      });
      expect(funnel.steps[1]).toEqual({
        type: "event",
        value: "signup",
      });
      expect(funnel.id).toMatch(/^demo-funnel-custom-/);
    });

    it("returns a standard error when name is missing", () => {
      const result = createDemoFunnel(SITE_ID, {
        steps: [
          { type: "pageview", value: "/a" },
          { type: "event", value: "b" },
        ],
      });
      expect(result.ok).toBe(false);
      expect(errorOf(result).error.message).toBe("Name is required");
    });

    it("returns a standard error when fewer than 2 steps are provided", () => {
      const result = createDemoFunnel(SITE_ID, {
        name: "Sparse",
        steps: [{ type: "pageview", value: "/only-one" }],
      });
      expect(result.ok).toBe(false);
      expect(errorOf(result).error.message).toBe(
        "At least 2 steps are required",
      );
    });

    it("returns a standard error when steps is not an array", () => {
      const result = createDemoFunnel(SITE_ID, { name: "Bad", steps: "nope" });
      expect(result.ok).toBe(false);
      expect(errorOf(result).error.message).toBe(
        "At least 2 steps are required",
      );
    });

    it("filters out invalid step entries", () => {
      const result = createDemoFunnel(SITE_ID, {
        name: "Mixed",
        steps: [
          { type: "pageview", value: "/start" },
          null,
          { type: "invalid", value: "/x" },
          { type: "event", value: "" },
          { type: "event", value: "end" },
        ],
      });
      expect(result.ok).toBe(true);
      const funnel = createdOf(result).funnel;
      expect(funnel.steps).toHaveLength(2);
      expect(funnel.steps[0].value).toBe("/start");
      expect(funnel.steps[1].value).toBe("end");
    });

    it("truncates steps to a maximum of 12", () => {
      const steps = Array.from({ length: 15 }, (_, i) => ({
        type: "pageview" as const,
        value: `/step-${i}`,
      }));
      const result = createDemoFunnel(SITE_ID, { name: "Long", steps });
      expect(result.ok).toBe(true);
      expect(createdOf(result).funnel.steps.length).toBeLessThanOrEqual(12);
    });

    it("assigns a unique incremental id", () => {
      const a = createDemoFunnel(SITE_ID, {
        name: "A",
        steps: [
          { type: "pageview", value: "/a" },
          { type: "event", value: "b" },
        ],
      });
      const b = createDemoFunnel(SITE_ID, {
        name: "B",
        steps: [
          { type: "pageview", value: "/c" },
          { type: "event", value: "d" },
        ],
      });
      expect(createdOf(a).funnel.id).not.toBe(createdOf(b).funnel.id);
    });

    it("returns a standard error for null/undefined body", () => {
      const result = createDemoFunnel(SITE_ID, null);
      expect(result.ok).toBe(false);
      expect(errorOf(result).error.message).toBe("Name is required");
    });

    it("sets createdAt and updatedAt to current time", () => {
      const before = Math.floor(Date.now() / 1000);
      const result = createDemoFunnel(SITE_ID, {
        name: "Timestamped",
        steps: [
          { type: "pageview", value: "/a" },
          { type: "event", value: "b" },
        ],
      });
      const after = Math.floor(Date.now() / 1000) + 1;
      const funnel = createdOf(result).funnel;
      expect(funnel.createdAt).toBeGreaterThanOrEqual(before);
      expect(funnel.createdAt).toBeLessThanOrEqual(after);
      expect(funnel.updatedAt).toBe(funnel.createdAt);
    });
  });

  describe("deleteDemoFunnel", () => {
    it("returns ok: true when deleting an existing funnel", () => {
      const created = createDemoFunnel(SITE_ID, {
        name: "To delete",
        steps: [
          { type: "pageview", value: "/del" },
          { type: "event", value: "gone" },
        ],
      });
      const result = deleteDemoFunnel(SITE_ID, {
        id: createdOf(created).funnel.id,
      });
      expect(result.ok).toBe(true);
    });

    it("returns ok: true even when the funnel id does not exist", () => {
      const result = deleteDemoFunnel(SITE_ID, { id: "nonexistent" });
      expect(result.ok).toBe(true);
    });

    it("returns ok: true when siteId does not match", () => {
      const result = deleteDemoFunnel("wrong-site", {
        id: "demo-funnel-signup",
      });
      expect(result.ok).toBe(true);
    });

    it("returns a standard error when id is missing", () => {
      const result = deleteDemoFunnel(SITE_ID, {});
      expect(result.ok).toBe(false);
      expect(errorOf(result).error.message).toBe("Funnel id is required");
    });
  });
});
