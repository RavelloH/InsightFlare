import { z } from "zod";

import { createEnvelopeSchema, registerSchema } from "./common";

// ─── Shared ─────────────────────────────────────────────────────────────

export const FunnelStepSchema = z
  .object({
    type: z
      .enum(["pageview", "event"])
      .describe("pageview = match pathname, event = match event name"),
    value: z
      .string()
      .trim()
      .min(1)
      .describe("Pathname pattern or event name to match"),
  })
  .strict();

// ─── Output ─────────────────────────────────────────────────────────────

export const FunnelDefinitionSchema = z
  .object({
    id: z.string().uuid(),
    siteId: z.string(),
    name: z.string(),
    steps: z.array(FunnelStepSchema),
    createdAt: z.number().int().describe("Unix timestamp in seconds"),
    updatedAt: z.number().int().describe("Unix timestamp in seconds"),
  })
  .describe("Saved funnel definition with ordered steps");

export const FunnelAnalysisStepSchema = z.object({
  index: z.number().int(),
  label: z.string(),
  type: z.enum(["pageview", "event"]),
  sessions: z.number().int(),
  visitors: z.number().int(),
  conversionRate: z
    .number()
    .describe("Conversion rate from first step (0-100)"),
  stepConversionRate: z
    .number()
    .describe("Conversion rate from previous step (0-100)"),
  dropOffSessions: z.number().int(),
  dropOffRate: z.number().describe("Drop-off rate from previous step (0-100)"),
});

export const FunnelAnalysisSummarySchema = z.object({
  totalSessions: z.number().int(),
  convertedSessions: z.number().int(),
  totalVisitors: z.number().int(),
  convertedVisitors: z.number().int(),
  overallConversionRate: z.number(),
  largestDropOffStepIndex: z.number().int().nullable(),
});

// ─── Input ──────────────────────────────────────────────────────────────

export const FunnelCreateInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    steps: z.array(FunnelStepSchema).min(2).max(10),
  })
  .strict();

export const FunnelAnalyzeInputSchema = z
  .object({
    steps: z.array(FunnelStepSchema).min(2).max(10),
  })
  .strict();

export const FunnelUpdateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    steps: z.array(FunnelStepSchema).min(2).max(10).optional(),
  })
  .strict();

// ─── Responses ──────────────────────────────────────────────────────────

export const FunnelListResponseSchema = createEnvelopeSchema(
  z.object({
    funnels: z.array(FunnelDefinitionSchema),
  }),
);

export const FunnelCreateResponseSchema = createEnvelopeSchema(
  z.object({
    funnel: FunnelDefinitionSchema,
  }),
);

export const FunnelAnalyzeResponseSchema = createEnvelopeSchema(
  z.object({
    steps: z.array(FunnelAnalysisStepSchema),
    summary: FunnelAnalysisSummarySchema,
  }),
);

// ─── Register ───────────────────────────────────────────────────────────

registerSchema("FunnelStep", FunnelStepSchema);
registerSchema("FunnelDefinition", FunnelDefinitionSchema);
registerSchema("FunnelAnalysisStep", FunnelAnalysisStepSchema);
registerSchema("FunnelAnalysisSummary", FunnelAnalysisSummarySchema);
registerSchema("FunnelCreateInput", FunnelCreateInputSchema);
registerSchema("FunnelAnalyzeInput", FunnelAnalyzeInputSchema);
registerSchema("FunnelUpdateInput", FunnelUpdateInputSchema);
registerSchema("FunnelListResponse", FunnelListResponseSchema);
registerSchema("FunnelCreateResponse", FunnelCreateResponseSchema);
registerSchema("FunnelAnalyzeResponse", FunnelAnalyzeResponseSchema);

// ─── Types ──────────────────────────────────────────────────────────────

export type FunnelStep = z.infer<typeof FunnelStepSchema>;
export type FunnelDefinition = z.infer<typeof FunnelDefinitionSchema>;
export type FunnelCreateInput = z.infer<typeof FunnelCreateInputSchema>;
export type FunnelAnalyzeInput = z.infer<typeof FunnelAnalyzeInputSchema>;
export type FunnelUpdateInput = z.infer<typeof FunnelUpdateInputSchema>;
