import { z } from "zod";

import type { ApiV1ErrorCode } from "@/lib/api-v1/errors";
import { apiV1SuccessEnvelopeSchema } from "@/lib/api-v1/wire";

export type ApiV1CoreRouteId =
  | "core.root"
  | "core.token.get"
  | "core.token.check"
  | "core.capabilities"
  | "core.team.get"
  | "core.team.usage";

export interface ApiV1CoreRouteDescriptor<Id extends ApiV1CoreRouteId> {
  readonly id: Id;
  readonly lifecycle: "exposed";
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly scopes: readonly string[];
  readonly requestSchema: z.ZodType;
  readonly responseSchema: z.ZodType;
  readonly declaredErrors: readonly ApiV1ErrorCode[];
}

export const RootDataSchema = z
  .object({
    version: z.string(),
    service: z.literal("insightflare"),
    links: z
      .object({
        openapi: z.string(),
        skills: z.string(),
        token: z.string(),
        capabilities: z.string(),
        team: z.string(),
        sites: z.string(),
        batch: z.string(),
      })
      .strict(),
  })
  .strict();
export const TokenCheckSchema = z
  .object({
    checks: z
      .array(
        z
          .object({
            scope: z.string().min(1),
            siteId: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const TokenCheckDataSchema = z
  .object({
    checks: z.array(
      z
        .object({
          scope: z.string(),
          siteId: z.string().optional(),
          allowed: z.boolean(),
          reason: z
            .enum(["missing_scope", "site_not_allowed", "token_inactive"])
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();
export const TokenDataSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    createdAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    team: z.object({ id: z.string(), name: z.string() }).strict(),
    scopes: z.array(z.string()),
    siteAccess: z
      .object({
        mode: z.enum(["all", "restricted"]),
        siteIds: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export const CapabilitiesDataSchema = z
  .object({
    apiVersion: z.string(),
    features: z.record(z.string(), z.boolean()),
    limits: z.record(z.string(), z.number()),
    links: z.record(z.string(), z.string()),
  })
  .strict();
export const TeamDataSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string().nullable(),
    links: z.record(z.string(), z.string()),
  })
  .strict();
export const TeamUsageDataSchema = z
  .object({ sites: z.number().int().nonnegative() })
  .strict();

export type TokenCheckInput = z.input<typeof TokenCheckSchema>;
export type RootData = z.infer<typeof RootDataSchema>;
export type TokenCheckData = z.infer<typeof TokenCheckDataSchema>;
export type TokenData = z.infer<typeof TokenDataSchema>;
export type CapabilitiesData = z.infer<typeof CapabilitiesDataSchema>;
export type TeamData = z.infer<typeof TeamDataSchema>;
export type TeamUsageData = z.infer<typeof TeamUsageDataSchema>;

/** Core discovery/auth contracts are first-class registry entries, not special cases. */
export const apiV1CoreRouteRegistry = [
  {
    id: "core.root",
    lifecycle: "exposed",
    method: "GET",
    path: "/api/v1",
    scopes: [],
    requestSchema: z.undefined(),
    responseSchema: apiV1SuccessEnvelopeSchema(RootDataSchema),
    declaredErrors: ["method_not_allowed", "internal_error"],
  },
  {
    id: "core.token.get",
    lifecycle: "exposed",
    method: "GET",
    path: "/api/v1/token",
    scopes: [],
    requestSchema: z.undefined(),
    responseSchema: apiV1SuccessEnvelopeSchema(TokenDataSchema),
    declaredErrors: ["missing_scope", "method_not_allowed", "internal_error"],
  },
  {
    id: "core.token.check",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/token/check",
    scopes: [],
    requestSchema: TokenCheckSchema,
    responseSchema: apiV1SuccessEnvelopeSchema(TokenCheckDataSchema),
    declaredErrors: [
      "validation_failed",
      "method_not_allowed",
      "internal_error",
    ],
  },
  {
    id: "core.capabilities",
    lifecycle: "exposed",
    method: "GET",
    path: "/api/v1/capabilities",
    scopes: [],
    requestSchema: z.undefined(),
    responseSchema: apiV1SuccessEnvelopeSchema(CapabilitiesDataSchema),
    declaredErrors: ["method_not_allowed", "internal_error"],
  },
  {
    id: "core.team.get",
    lifecycle: "exposed",
    method: "GET",
    path: "/api/v1/team",
    scopes: [],
    requestSchema: z.undefined(),
    responseSchema: apiV1SuccessEnvelopeSchema(TeamDataSchema),
    declaredErrors: ["method_not_allowed", "internal_error"],
  },
  {
    id: "core.team.usage",
    lifecycle: "exposed",
    method: "GET",
    path: "/api/v1/team/usage",
    scopes: [],
    requestSchema: z.undefined(),
    responseSchema: apiV1SuccessEnvelopeSchema(TeamUsageDataSchema),
    declaredErrors: ["method_not_allowed", "internal_error"],
  },
] as const satisfies readonly ApiV1CoreRouteDescriptor<ApiV1CoreRouteId>[];
