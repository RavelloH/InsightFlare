import { z } from "zod";

import {
  analyticsFilterRegistry,
  assertFilterAudience,
  type FilterDocument,
  normalizeFilterDocument,
} from "@/lib/edge/analytics/contract";
import {
  FunnelCreateInputSchema,
  FunnelUpdateInputSchema,
} from "@/schemas/funnel";
import { SiteCreateInputSchema, SiteUpdateInputSchema } from "@/schemas/site";

const savedFilterExpressionSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("condition"),
        target: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("field"), field: z.string() }).strict(),
          z
            .object({ kind: z.literal("event-payload"), path: z.string() })
            .strict(),
        ]),
        operator: z.string(),
        value: z
          .union([
            z.string(),
            z.number().finite(),
            z.boolean(),
            z.null(),
            z.array(
              z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
            ),
          ])
          .optional(),
      })
      .strict(),
    z
      .object({
        kind: z.enum(["and", "or"]),
        children: z.array(savedFilterExpressionSchema),
      })
      .strict(),
    z
      .object({ kind: z.literal("not"), child: savedFilterExpressionSchema })
      .strict(),
  ]),
);

export const SavedFilterDefinitionSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(120),
    description: z.string().max(2_000),
    visibility: z.literal("team"),
    scopePreference: z.enum(["auto", "event", "session", "visitor"]),
    filter: z
      .object({
        version: z.literal(1),
        root: savedFilterExpressionSchema.nullable(),
      })
      .strict(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const SavedFilterPageSchema = z
  .object({
    items: z.array(SavedFilterDefinitionSchema),
    page: z
      .object({
        kind: z.literal("keyset"),
        limit: z.number().int().min(1).max(1000),
        nextCursor: z.string().max(12_288).nullable(),
        hasMore: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const ListTeamVisibleSavedFiltersInputSchema = z
  .object({
    siteId: z.string().min(1).max(256),
    limit: z.number().int().min(1).max(1000).default(100),
    cursor: z.string().min(1).max(12_288).nullable().default(null),
  })
  .strict();

export const GetTeamVisibleSavedFilterInputSchema = z
  .object({
    siteId: z.string().min(1).max(256),
    id: z.string().min(1).max(256),
  })
  .strict();

export type SavedFilterDefinition = z.infer<typeof SavedFilterDefinitionSchema>;
export type SavedFilterPage = z.infer<typeof SavedFilterPageSchema>;
export type ListTeamVisibleSavedFiltersInput = z.infer<
  typeof ListTeamVisibleSavedFiltersInputSchema
>;
export type GetTeamVisibleSavedFilterInput = z.infer<
  typeof GetTeamVisibleSavedFilterInputSchema
>;

const SiteIdSchema = z.string().min(1).max(256);

export const SiteResourceSchema = z
  .object({
    id: SiteIdSchema,
    name: z.string().min(1).max(120),
    domain: z.string().min(1).max(255),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    sharing: z
      .object({ publicEnabled: z.boolean(), publicSlug: z.string().nullable() })
      .strict(),
    links: z.record(z.string(), z.string()),
  })
  .strict();

export const TrackingSettingsSchema = z
  .object({
    trackPageviews: z.literal(true),
    trackQuery: z.boolean(),
    trackHash: z.boolean(),
    trackCustomEvents: z.literal(true),
    trackEngagement: z.literal(true),
    trackWebVitals: z.boolean(),
    autoTrackOutboundLinks: z.boolean(),
    trackingStrength: z.enum(["strong", "smart", "weak"]),
    allowedDomains: z.array(z.string()),
    excludedPaths: z.array(z.string()),
  })
  .strict();

export const PrivacySettingsSchema = z
  .object({
    respectDoNotTrack: z.boolean(),
    anonymizeIp: z.literal(true),
    euMode: z.boolean(),
    visitorTokenMode: z.literal("daily"),
    dataRetentionDays: z.literal(180),
  })
  .strict();

export const SharingSettingsSchema = z
  .object({ publicEnabled: z.boolean(), publicSlug: z.string().nullable() })
  .strict();

export const TrackingScriptSchema = z
  .object({ siteId: SiteIdSchema, src: z.string().url(), snippet: z.string() })
  .strict();

const FunnelStepSchema = z
  .object({ type: z.enum(["pageview", "event"]), value: z.string().min(1) })
  .strict();
export const FunnelResourceSchema = z
  .object({
    id: SiteIdSchema,
    siteId: SiteIdSchema,
    name: z.string().min(1).max(200),
    steps: z.array(FunnelStepSchema).min(2).max(10),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    links: z.record(z.string(), z.string()),
  })
  .strict();

export const ListSitesInputSchema = z.object({}).strict();
export const CreateSiteInputSchema = SiteCreateInputSchema;
export const GetSiteInputSchema = z.object({ siteId: SiteIdSchema }).strict();
const sitePatchRefinement = (value: z.infer<typeof SiteUpdateInputSchema>) =>
  value.name !== undefined ||
  value.domain !== undefined ||
  value.publicEnabled !== undefined ||
  value.publicSlug !== undefined;
export const UpdateSiteBodySchema = SiteUpdateInputSchema.refine(
  sitePatchRefinement,
  "A site patch must change at least one field",
);
export const UpdateSiteInputSchema = SiteUpdateInputSchema.extend({
  siteId: SiteIdSchema,
})
  .strict()
  .refine(sitePatchRefinement, "A site patch must change at least one field");
export const DeleteSiteInputSchema = GetSiteInputSchema;
export const SiteSettingsInputSchema = GetSiteInputSchema;
export const TrackingScriptInputSchema = SiteSettingsInputSchema.extend({
  origin: z.string().url(),
}).strict();
const TrackingSettingsPatchFieldsSchema = z
  .object({
    trackQuery: z.boolean().optional(),
    trackHash: z.boolean().optional(),
    trackWebVitals: z.boolean().optional(),
    autoTrackOutboundLinks: z.boolean().optional(),
    trackingStrength: z.enum(["strong", "smart", "weak"]).optional(),
    allowedDomains: z.array(z.string()).optional(),
    excludedPaths: z.array(z.string()).optional(),
  })
  .strict();
const trackingSettingsPatchRefinement = (
  value: z.infer<typeof TrackingSettingsPatchFieldsSchema>,
) =>
  value.trackQuery !== undefined ||
  value.trackHash !== undefined ||
  value.trackWebVitals !== undefined ||
  value.autoTrackOutboundLinks !== undefined ||
  value.trackingStrength !== undefined ||
  value.allowedDomains !== undefined ||
  value.excludedPaths !== undefined;
export const UpdateTrackingSettingsBodySchema =
  TrackingSettingsPatchFieldsSchema.refine(
    trackingSettingsPatchRefinement,
    "A tracking settings patch must change at least one field",
  );
export const UpdateTrackingSettingsInputSchema =
  TrackingSettingsPatchFieldsSchema.extend({
    siteId: SiteIdSchema,
  }).refine(
    trackingSettingsPatchRefinement,
    "A tracking settings patch must change at least one field",
  );
const PrivacySettingsPatchFieldsSchema = PrivacySettingsSchema.pick({
  respectDoNotTrack: true,
  euMode: true,
})
  .partial()
  .strict();
const privacySettingsPatchRefinement = (
  value: z.infer<typeof PrivacySettingsPatchFieldsSchema>,
) => value.respectDoNotTrack !== undefined || value.euMode !== undefined;
export const UpdatePrivacySettingsBodySchema =
  PrivacySettingsPatchFieldsSchema.refine(
    privacySettingsPatchRefinement,
    "A privacy settings patch must change at least one field",
  );
export const UpdatePrivacySettingsInputSchema =
  PrivacySettingsPatchFieldsSchema.extend({
    siteId: SiteIdSchema,
  }).refine(
    privacySettingsPatchRefinement,
    "A privacy settings patch must change at least one field",
  );
const SharingSettingsPatchFieldsSchema = z
  .object({
    publicEnabled: z.boolean().optional(),
    publicSlug: z.string().nullable().optional(),
  })
  .strict();
const sharingSettingsPatchRefinement = (
  value: z.infer<typeof SharingSettingsPatchFieldsSchema>,
) => value.publicEnabled !== undefined || value.publicSlug !== undefined;
export const UpdateSharingSettingsBodySchema =
  SharingSettingsPatchFieldsSchema.refine(
    sharingSettingsPatchRefinement,
    "A sharing settings patch must change at least one field",
  );
export const UpdateSharingSettingsInputSchema =
  SharingSettingsPatchFieldsSchema.extend({
    siteId: SiteIdSchema,
  }).refine(
    sharingSettingsPatchRefinement,
    "A sharing settings patch must change at least one field",
  );
export const CreateFunnelInputSchema = FunnelCreateInputSchema.extend({
  siteId: SiteIdSchema,
}).strict();
export const GetFunnelInputSchema = z
  .object({ siteId: SiteIdSchema, funnelId: SiteIdSchema })
  .strict();
const funnelPatchRefinement = (
  value: z.infer<typeof FunnelUpdateInputSchema>,
) => value.name !== undefined || value.steps !== undefined;
export const UpdateFunnelBodySchema = FunnelUpdateInputSchema.refine(
  funnelPatchRefinement,
  "A funnel patch must change at least one field",
);
export const UpdateFunnelInputSchema = FunnelUpdateInputSchema.extend({
  siteId: SiteIdSchema,
  funnelId: SiteIdSchema,
})
  .strict()
  .refine(
    funnelPatchRefinement,
    "A funnel patch must change at least one field",
  );

export type SiteResource = z.infer<typeof SiteResourceSchema>;
export type TrackingSettings = z.infer<typeof TrackingSettingsSchema>;
export type PrivacySettings = z.infer<typeof PrivacySettingsSchema>;
export type SharingSettings = z.infer<typeof SharingSettingsSchema>;
export type TrackingScript = z.infer<typeof TrackingScriptSchema>;
export type FunnelResource = z.infer<typeof FunnelResourceSchema>;

export type ApiV1ApplicationErrorCode =
  | "not_found"
  | "internal_error"
  | "invalid_cursor";

export interface ApiV1ApplicationSuccess<Result, Meta = undefined> {
  readonly data: Result;
  readonly meta: Meta;
}

export type ApiV1ApplicationOutcome<Result, ErrorCode extends string> =
  | { readonly ok: true; readonly value: Result }
  | { readonly ok: false; readonly error: { readonly code: ErrorCode } };

export interface ApiV1ApplicationOperationMap {
  "savedFilters.list": {
    input: ListTeamVisibleSavedFiltersInput;
    result: SavedFilterPage;
    error: "internal_error" | "invalid_cursor";
  };
  "savedFilters.get": {
    input: GetTeamVisibleSavedFilterInput;
    result: SavedFilterDefinition;
    error: "not_found" | "internal_error";
  };
  "sites.list": {
    input: z.infer<typeof ListSitesInputSchema>;
    result: readonly z.infer<typeof SiteResourceSchema>[];
    error: "internal_error";
  };
  "sites.create": {
    input: z.infer<typeof CreateSiteInputSchema>;
    result: z.infer<typeof SiteResourceSchema>;
    error: "conflict" | "forbidden" | "internal_error";
  };
  "sites.get": {
    input: z.infer<typeof GetSiteInputSchema>;
    result: z.infer<typeof SiteResourceSchema>;
    error: "not_found" | "internal_error";
  };
  "sites.update": {
    input: z.infer<typeof UpdateSiteInputSchema>;
    result: z.infer<typeof SiteResourceSchema>;
    error: "not_found" | "conflict" | "internal_error";
  };
  "sites.delete": {
    input: z.infer<typeof DeleteSiteInputSchema>;
    result: undefined;
    error: "not_found" | "internal_error";
  };
  "settings.tracking.get": {
    input: z.infer<typeof SiteSettingsInputSchema>;
    result: z.infer<typeof TrackingSettingsSchema>;
    error: "not_found" | "internal_error";
  };
  "settings.tracking.update": {
    input: z.infer<typeof UpdateTrackingSettingsInputSchema>;
    result: z.infer<typeof TrackingSettingsSchema>;
    error: "not_found" | "internal_error";
  };
  "settings.privacy.get": {
    input: z.infer<typeof SiteSettingsInputSchema>;
    result: z.infer<typeof PrivacySettingsSchema>;
    error: "not_found" | "internal_error";
  };
  "settings.privacy.update": {
    input: z.infer<typeof UpdatePrivacySettingsInputSchema>;
    result: z.infer<typeof PrivacySettingsSchema>;
    error: "not_found" | "internal_error";
  };
  "settings.sharing.get": {
    input: z.infer<typeof SiteSettingsInputSchema>;
    result: z.infer<typeof SharingSettingsSchema>;
    error: "not_found" | "internal_error";
  };
  "settings.sharing.update": {
    input: z.infer<typeof UpdateSharingSettingsInputSchema>;
    result: z.infer<typeof SharingSettingsSchema>;
    error: "not_found" | "conflict" | "internal_error";
  };
  "settings.trackingScript.get": {
    input: z.infer<typeof TrackingScriptInputSchema>;
    result: z.infer<typeof TrackingScriptSchema>;
    error: "not_found" | "internal_error";
  };
  "funnels.list": {
    input: z.infer<typeof SiteSettingsInputSchema>;
    result: readonly z.infer<typeof FunnelResourceSchema>[];
    error: "not_found" | "internal_error";
  };
  "funnels.create": {
    input: z.infer<typeof CreateFunnelInputSchema>;
    result: z.infer<typeof FunnelResourceSchema>;
    error: "not_found" | "internal_error";
  };
  "funnels.get": {
    input: z.infer<typeof GetFunnelInputSchema>;
    result: z.infer<typeof FunnelResourceSchema>;
    error: "not_found" | "internal_error";
  };
  "funnels.update": {
    input: z.infer<typeof UpdateFunnelInputSchema>;
    result: z.infer<typeof FunnelResourceSchema>;
    error: "not_found" | "internal_error";
  };
  "funnels.delete": {
    input: z.infer<typeof GetFunnelInputSchema>;
    result: undefined;
    error: "not_found" | "internal_error";
  };
}

export type ApiV1ApplicationOperationId = keyof ApiV1ApplicationOperationMap;

export interface ApiV1ApplicationContext {
  readonly teamId: string;
  readonly siteIds: readonly string[];
}

export interface ApiV1ApplicationService {
  execute<K extends ApiV1ApplicationOperationId>(
    context: ApiV1ApplicationContext,
    operation: K,
    input: ApiV1ApplicationOperationMap[K]["input"],
    execution: { readonly signal?: AbortSignal; readonly deadlineMs?: number },
  ): Promise<
    ApiV1ApplicationOutcome<
      ApiV1ApplicationOperationMap[K]["result"],
      ApiV1ApplicationOperationMap[K]["error"]
    >
  >;
}

/** Runtime field definitions remain owned by the filter registry, not this wire contract. */
export function assertSavedFilterDocument(document: FilterDocument): void {
  if (document.version !== 1) throw new Error("unsupported_filter_version");
  if (document.root) {
    // Re-validate through the canonical registry before a definition crosses the API boundary.
    const normalized = normalizeFilterDocument(
      document,
      analyticsFilterRegistry,
    );
    assertFilterAudience(normalized, analyticsFilterRegistry, "api-v1");
  }
}
