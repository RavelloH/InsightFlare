import { z } from "zod";

import { FILTER_DSL_MAX_LENGTH } from "@/lib/filter-contract";

import { createEnvelopeSchema, registerSchema } from "./common";

// ─── Shared ─────────────────────────────────────────────────────────────

export const FunnelStepSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    name: z.string().max(120).optional(),
    filterDsl: z
      .string()
      .min(1)
      .max(FILTER_DSL_MAX_LENGTH)
      .refine((value) => value.trim().length > 0),
  })
  .strict();

// ─── Output ─────────────────────────────────────────────────────────────

export const FunnelDefinitionSchema = z
  .object({
    id: z.string().uuid(),
    siteId: z.string(),
    name: z.string(),
    filterDslVersion: z.literal(1),
    progressionScope: z.enum(["session", "visitor"]),
    conversionWindowMs: z.number().finite().nullable(),
    steps: z.array(FunnelStepSchema).min(1),
    semanticFingerprint: z.string().min(1),
    createdAt: z.number().int().describe("Unix timestamp in seconds"),
    updatedAt: z.number().int().describe("Unix timestamp in seconds"),
  })
  .describe("Saved funnel definition with ordered steps");

export const FunnelAnalysisStepSchema = z.object({
  stepId: z.string().min(1),
  index: z.number().int(),
  sessions: z.number().int(),
  visitors: z.number().int(),
  progression: z
    .object({
      count: z.number().int(),
      conversionRate: z.number(),
      stepConversionRate: z.number(),
      dropOffCount: z.number().int(),
      dropOffRate: z.number(),
    })
    .strict(),
});

export const FunnelAnalysisSummarySchema = z.object({
  totalProgressions: z.number().int(),
  convertedProgressions: z.number().int(),
  overallConversionRate: z.number(),
  largestDropOffStepIndex: z.number().int().nullable(),
});

// ─── Input ──────────────────────────────────────────────────────────────

export const FunnelCreateInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    filterDslVersion: z.literal(1).default(1),
    progressionScope: z.enum(["session", "visitor"]).default("session"),
    conversionWindowMs: z.number().finite().positive().nullable().default(null),
    steps: z.array(FunnelStepSchema).min(2).max(10),
  })
  .strict()
  .superRefine(validateFunnelConfigSemantics);

export const FunnelAnalyzeInputSchema = z
  .object({
    filterDslVersion: z.literal(1).default(1),
    progressionScope: z.enum(["session", "visitor"]).default("session"),
    conversionWindowMs: z.number().finite().positive().nullable().default(null),
    steps: z.array(FunnelStepSchema).min(2).max(10),
  })
  .strict()
  .superRefine(validateFunnelConfigSemantics);

export const FunnelUpdateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    filterDslVersion: z.literal(1).optional(),
    progressionScope: z.enum(["session", "visitor"]).optional(),
    conversionWindowMs: z.number().finite().positive().nullable().optional(),
    steps: z.array(FunnelStepSchema).min(2).max(10).optional(),
  })
  .strict();

// ─── Responses ──────────────────────────────────────────────────────────

export const FunnelListResponseSchema = createEnvelopeSchema(
  z.object({
    items: z.array(FunnelDefinitionSchema),
    pagination: z
      .object({
        limit: z.number().int().positive(),
        returned: z.number().int().nonnegative(),
        hasMore: z.boolean(),
        nextCursor: z.string().nullable(),
      })
      .strict(),
  }),
);

export const FunnelCreateResponseSchema = createEnvelopeSchema(
  z.object({
    funnel: FunnelDefinitionSchema,
  }),
);

export const FunnelAnalyzeResponseSchema = createEnvelopeSchema(
  z.object({
    progressionScope: z.enum(["session", "visitor"]),
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

function validateFunnelConfigSemantics(
  value: {
    progressionScope: "session" | "visitor";
    conversionWindowMs: number | null;
    steps: Array<{ id: string }>;
  },
  context: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  value.steps.forEach((step, index) => {
    if (ids.has(step.id)) {
      context.addIssue({
        code: "custom",
        path: ["steps", index, "id"],
        message: "Step ids must be unique",
      });
    }
    ids.add(step.id);
  });
  if (
    value.progressionScope === "session" &&
    value.conversionWindowMs !== null
  ) {
    context.addIssue({
      code: "custom",
      path: ["conversionWindowMs"],
      message: "Session funnels do not accept a conversion window",
    });
  }
  if (
    value.progressionScope === "visitor" &&
    (value.conversionWindowMs === null || value.conversionWindowMs <= 0)
  ) {
    context.addIssue({
      code: "custom",
      path: ["conversionWindowMs"],
      message: "Visitor funnels require a positive conversion window",
    });
  }
}
