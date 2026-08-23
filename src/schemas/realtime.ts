import { z } from "zod";

import { createEnvelopeSchema, registerSchema } from "./common";

// ─── Output ─────────────────────────────────────────────────────────────

export const RealtimeEventKindSchema = z.enum([
  "pageview",
  "custom_event",
  "leave",
  "visibility",
  "identify",
]);

export const RealtimeEventSchema = z
  .object({
    id: z.string(),
    eventType: z.string(),
    eventKind: RealtimeEventKindSchema.optional(),
    eventAt: z.number().int().describe("Event timestamp in milliseconds"),
    siteId: z.string().optional(),
    traceId: z.string().optional(),
    receivedAt: z.number().int().nullable().optional(),
    sequence: z.number().int().nullable().optional(),
    eventId: z.string().optional(),
    eventData: z.unknown().optional(),
    visitId: z.string(),
    sessionId: z.string().default(""),
    startedAt: z.number().int().nullable().optional(),
    previousVisitId: z.string().optional(),
    previousVisitStartedAt: z.number().int().nullable().optional(),
    visitorId: z.string(),
    userId: z.string().optional(),
    userName: z.string().optional(),
    isEU: z.boolean().nullable().optional(),
    pathname: z.string().default("/"),
    queryString: z.string().optional(),
    hash: z.string().default(""),
    title: z.string().default(""),
    hostname: z.string().default(""),
    referrerUrl: z.string().default(""),
    referrerHost: z.string().default(""),
    utmSource: z.string().optional(),
    utmMedium: z.string().optional(),
    utmCampaign: z.string().optional(),
    utmTerm: z.string().optional(),
    utmContent: z.string().optional(),
    country: z.string().default(""),
    region: z.string().default(""),
    regionCode: z.string().default(""),
    city: z.string().default(""),
    continent: z.string().default(""),
    postalCode: z.string().optional(),
    metroCode: z.string().optional(),
    timezone: z.string().default(""),
    organization: z.string().default(""),
    uaRaw: z.string().optional(),
    browser: z.string().default(""),
    browserVersion: z.string().optional(),
    os: z.string().optional(),
    osVersion: z.string().default(""),
    deviceType: z.string().default(""),
    language: z.string().default(""),
    screenSize: z.string().default(""),
    screenWidth: z.number().nullable().optional(),
    screenHeight: z.number().nullable().optional(),
    status: z.string().optional(),
    hiddenAt: z.number().int().nullable().optional(),
    endedAt: z.number().int().nullable().optional(),
    finalizedAt: z.number().int().nullable().optional(),
    durationMs: z.number().nullable().optional(),
    durationSource: z.string().optional(),
    exitReason: z.string().optional(),
    leaveAt: z.number().int().nullable().optional(),
    performanceVisitId: z.string().optional(),
    performance: z.unknown().nullable().optional(),
    visibilityState: z.string().optional(),
    latitude: z.number().nullable().default(null),
    longitude: z.number().nullable().default(null),
    eventName: z
      .string()
      .optional()
      .describe("Present only for custom_event type"),
  })
  .strict()
  .describe("Individual real-time event from a visitor");

export const RealtimeVisitSchema = z
  .object({
    visitId: z.string(),
    visitorId: z.string(),
    sessionId: z.string(),
    startedAt: z.number().int(),
    lastActivityAt: z.number().int(),
    pathname: z.string(),
    hash: z.string(),
    title: z.string(),
    hostname: z.string(),
    referrerUrl: z.string(),
    referrerHost: z.string(),
    queryString: z.string().optional(),
    utmSource: z.string().optional(),
    utmMedium: z.string().optional(),
    utmCampaign: z.string().optional(),
    utmTerm: z.string().optional(),
    utmContent: z.string().optional(),
    userId: z.string().optional(),
    userName: z.string().optional(),
    isEU: z.boolean().nullable().optional(),
    country: z.string(),
    region: z.string(),
    regionCode: z.string(),
    city: z.string(),
    continent: z.string(),
    timezone: z.string(),
    organization: z.string(),
    uaRaw: z.string().optional(),
    browserVersion: z.string().optional(),
    os: z.string().optional(),
    browser: z.string(),
    osVersion: z.string(),
    deviceType: z.string(),
    language: z.string(),
    screenSize: z.string().default(""),
    siteId: z.string().optional(),
    postalCode: z.string().optional(),
    metroCode: z.string().optional(),
    screenWidth: z.number().nullable().optional(),
    screenHeight: z.number().nullable().optional(),
    status: z.string().optional(),
    hiddenAt: z.number().int().nullable().optional(),
    endedAt: z.number().int().nullable().optional(),
    finalizedAt: z.number().int().nullable().optional(),
    durationMs: z.number().nullable().optional(),
    durationSource: z.string().optional(),
    exitReason: z.string().optional(),
    performance: z.unknown().nullable().optional(),
    latitude: z.number().nullable().default(null),
    longitude: z.number().nullable().default(null),
  })
  .strict()
  .describe("Active real-time visit from a visitor");

export const RealtimeSnapshotDataSchema = z
  .object({
    activeNow: z
      .number()
      .int()
      .nonnegative()
      .describe("Number of distinct visitors active in the last 5 minutes"),
    events: z.array(RealtimeEventSchema),
    visits: z.array(RealtimeVisitSchema),
  })
  .strict()
  .describe("Real-time activity snapshot for a site");

export const ActiveVisitorsSchema = z
  .object({
    activeNow: z
      .number()
      .int()
      .nonnegative()
      .describe("Number of distinct visitors active in the last 5 minutes"),
  })
  .strict();

// ─── Responses ──────────────────────────────────────────────────────────

export const RealtimeSnapshotResponseSchema = createEnvelopeSchema(
  RealtimeSnapshotDataSchema,
);
export const ActiveVisitorsResponseSchema =
  createEnvelopeSchema(ActiveVisitorsSchema);

// ─── Register ───────────────────────────────────────────────────────────

registerSchema("RealtimeEvent", RealtimeEventSchema);
registerSchema("RealtimeVisit", RealtimeVisitSchema);
registerSchema("RealtimeSnapshotData", RealtimeSnapshotDataSchema);
registerSchema("ActiveVisitors", ActiveVisitorsSchema);
registerSchema("RealtimeSnapshotResponse", RealtimeSnapshotResponseSchema);
registerSchema("ActiveVisitorsResponse", ActiveVisitorsResponseSchema);

// ─── Types ──────────────────────────────────────────────────────────────

export type RealtimeEvent = z.infer<typeof RealtimeEventSchema>;
export type RealtimeEventKind = z.infer<typeof RealtimeEventKindSchema>;
export type RealtimeVisit = z.infer<typeof RealtimeVisitSchema>;
export type RealtimeSnapshotData = z.infer<typeof RealtimeSnapshotDataSchema>;
