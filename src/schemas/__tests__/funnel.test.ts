import { describe, expect, it } from "vitest";

import {
  FunnelAnalysisStepSchema,
  FunnelAnalysisSummarySchema,
  FunnelAnalyzeInputSchema,
  FunnelCreateInputSchema,
  FunnelDefinitionSchema,
  FunnelStepSchema,
} from "@/schemas/funnel";

const steps = [
  { id: "landing", filterDsl: 'page.path eq "/landing"' },
  { id: "signup", filterDsl: 'event.name eq "signup"' },
] as const;

describe("Funnel v2 schemas", () => {
  it("accepts a definition, create input, and analysis input", () => {
    const config = {
      filterDslVersion: 1,
      progressionScope: "session" as const,
      conversionWindowMs: null,
      steps,
    };
    expect(FunnelStepSchema.safeParse(steps[0]).success).toBe(true);
    expect(
      FunnelCreateInputSchema.safeParse({ name: "Signup", ...config }).success,
    ).toBe(true);
    expect(FunnelAnalyzeInputSchema.safeParse(config).success).toBe(true);
    expect(
      FunnelDefinitionSchema.safeParse({
        id: "550e8400-e29b-41d4-a716-446655440000",
        siteId: "site-1",
        name: "Signup",
        ...config,
        semanticFingerprint: "funnel-v2:abc",
        createdAt: 1,
        updatedAt: 2,
      }).success,
    ).toBe(true);
  });

  it("requires unique step ids and rejects more than ten steps", () => {
    expect(
      FunnelCreateInputSchema.safeParse({
        name: "Duplicate",
        filterDslVersion: 1,
        progressionScope: "session",
        conversionWindowMs: null,
        steps: [steps[0], steps[0]],
      }).success,
    ).toBe(false);
    expect(
      FunnelCreateInputSchema.safeParse({
        name: "Long",
        filterDslVersion: 1,
        progressionScope: "session",
        conversionWindowMs: null,
        steps: Array.from({ length: 11 }, (_, index) => ({
          id: `step-${index}`,
          filterDsl: `page.path eq "/step-${index}"`,
        })),
      }).success,
    ).toBe(false);
  });

  it("requires a positive visitor conversion window", () => {
    expect(
      FunnelCreateInputSchema.safeParse({
        name: "Visitors",
        filterDslVersion: 1,
        progressionScope: "visitor",
        conversionWindowMs: 86_400_000,
        steps,
      }).success,
    ).toBe(true);
    expect(
      FunnelAnalyzeInputSchema.safeParse({
        filterDslVersion: 1,
        progressionScope: "visitor",
        conversionWindowMs: 0,
        steps,
      }).success,
    ).toBe(false);
  });

  it("validates the v2 analysis shape", () => {
    expect(
      FunnelAnalysisStepSchema.safeParse({
        stepId: "landing",
        index: 0,
        sessions: 10,
        visitors: 8,
        progression: {
          count: 10,
          conversionRate: 1,
          stepConversionRate: 1,
          dropOffCount: 0,
          dropOffRate: 0,
        },
      }).success,
    ).toBe(true);
    expect(
      FunnelAnalysisSummarySchema.safeParse({
        totalProgressions: 10,
        convertedProgressions: 4,
        overallConversionRate: 0.4,
        largestDropOffStepIndex: null,
      }).success,
    ).toBe(true);
  });
});
