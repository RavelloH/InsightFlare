import { z } from "zod";

import { createEnvelopeSchema, registerSchema } from "./common";

// ─── Output ─────────────────────────────────────────────────────────────

export const RealtimeEventSchema = z
  .object({
    id: z.string(),
    eventType: z.string(),
    eventKind: z
      .enum(["pageview", "custom_event", "leave", "visibility", "identify"])
      .optional(),
    eventAt: z.number().int().describe("Event timestamp (Unix ms)"),
    siteId: z.string().optional(),
    traceId: z.string().optional(),
    receivedAt: z.number().int().nullable().optional(),
    sequence: z.number().int().nullable().optional(),
    eventId: z.string().optional(),
    eventData: z.unknown().optional(),
    visitId: z.string(),
    sessionId: z.string().optional(),
    visitorId: z.string(),
    userId: z.string().optional(),
    userName: z.string().optional(),
    pathname: z.string().optional(),
    queryString: z.string().optional(),
    hash: z.string().optional(),
    title: z.string().optional(),
    hostname: z.string().optional(),
    referrerUrl: z.string().optional(),
    referrerHost: z.string().optional(),
    utmSource: z.string().optional(),
    utmMedium: z.string().optional(),
    utmCampaign: z.string().optional(),
    utmTerm: z.string().optional(),
    utmContent: z.string().optional(),
    country: z.string().optional(),
    region: z.string().optional(),
    regionCode: z.string().optional(),
    city: z.string().optional(),
    continent: z.string().optional(),
    postalCode: z.string().optional(),
    metroCode: z.string().optional(),
    timezone: z.string().optional(),
    organization: z.string().optional(),
    uaRaw: z.string().optional(),
    browser: z.string().optional(),
    browserVersion: z.string().optional(),
    os: z.string().optional(),
    osVersion: z.string().optional(),
    deviceType: z.string().optional(),
    language: z.string().optional(),
    screenSize: z.string().optional(),
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
    latitude: z.number().nullable().optional(),
    longitude: z.number().nullable().optional(),
    eventName: z
      .string()
      .optional()
      .describe("Present only for custom_event type"),
  })
  .describe("Individual real-time event from a visitor");

export const RealtimeSnapshotDataSchema = z
  .object({
    activeNow: z
      .number()
      .int()
      .describe("Number of distinct visitors active in the last 5 minutes"),
    events: z.array(RealtimeEventSchema),
  })
  .describe("Real-time activity snapshot for a site");

export const ActiveVisitorsSchema = z.object({
  activeNow: z
    .number()
    .int()
    .describe("Number of distinct visitors active in the last 5 minutes"),
});

// ─── Responses ──────────────────────────────────────────────────────────

export const RealtimeSnapshotResponseSchema = createEnvelopeSchema(
  RealtimeSnapshotDataSchema,
);
export const ActiveVisitorsResponseSchema =
  createEnvelopeSchema(ActiveVisitorsSchema);

// ─── Register ───────────────────────────────────────────────────────────

registerSchema("RealtimeEvent", RealtimeEventSchema);
registerSchema("RealtimeSnapshotData", RealtimeSnapshotDataSchema);
registerSchema("ActiveVisitors", ActiveVisitorsSchema);
registerSchema("RealtimeSnapshotResponse", RealtimeSnapshotResponseSchema);
registerSchema("ActiveVisitorsResponse", ActiveVisitorsResponseSchema);

// ─── Types ──────────────────────────────────────────────────────────────

export type RealtimeEvent = z.infer<typeof RealtimeEventSchema>;
export type RealtimeSnapshotData = z.infer<typeof RealtimeSnapshotDataSchema>;
