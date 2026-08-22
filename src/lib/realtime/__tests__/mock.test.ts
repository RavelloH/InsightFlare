import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMockRealtimeSocket,
  handleDemoRequest,
  type RealtimeSocketLike,
} from "@/lib/realtime/mock";
import { handleDemoNotificationEmailPreview } from "@/lib/realtime/mock/notification-email-preview";

const SITE_ID = "demo-site-001";
const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_FROM = Date.UTC(2026, 0, 5);
const FIXED_TO = FIXED_FROM + 2 * DAY_MS;
const ANALYTICS_PARAMS = {
  siteId: SITE_ID,
  from: FIXED_FROM,
  to: FIXED_TO,
  timeZone: "UTC",
};

function ok(result: unknown): { ok: boolean; data: unknown } {
  return result as { ok: boolean; data: unknown };
}

function asRecord(result: unknown): Record<string, unknown> {
  return result as Record<string, unknown>;
}

function dataRows(result: unknown): Array<Record<string, unknown>> {
  const data = asRecord(result).data;
  expect(Array.isArray(data)).toBe(true);
  return data as Array<Record<string, unknown>>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("mock — handleDemoRequest", () => {
  describe("write operations", () => {
    it("returns user+teams for POST /api/public/session", () => {
      const res = ok(
        handleDemoRequest({ path: "/api/public/session", method: "POST" }),
      );
      expect(res.ok).toBe(true);
      const data = res.data as Record<string, unknown>;
      expect(data.user).toBeTruthy();
      expect(Array.isArray(data.teams)).toBe(true);
    });

    it("returns user+teams for GET /api/private/session", () => {
      const res = ok(handleDemoRequest({ path: "/api/private/session" }));
      expect(res.ok).toBe(true);
    });

    it("PATCH /profile merges body into demo user", () => {
      const res = ok(
        handleDemoRequest({
          path: "/api/private/admin/profile",
          method: "PATCH",
          body: { name: "New Name", timeZone: "Asia/Shanghai" },
        }),
      );
      expect(res.ok).toBe(true);
      const data = res.data as Record<string, unknown>;
      expect(data.name).toBe("New Name");
      expect(data.timeZone).toBeTruthy();
    });

    it("PATCH /profile keeps existing timeZone when key is absent", () => {
      const res = ok(
        handleDemoRequest({
          path: "/api/private/admin/profile",
          method: "PATCH",
          body: { name: "Only Name" },
        }),
      );
      const data = res.data as Record<string, unknown>;
      expect(data.name).toBe("Only Name");
      expect("timeZone" in data).toBe(true);
    });

    it("routes demo notification write operations", () => {
      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/admin/notification-email/test",
            method: "POST",
          }),
        ).data,
      ).toMatchObject({ provider: "resend" });
      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/admin/notification-test",
            method: "POST",
            body: { teamId: "demo-team-001", userId: "demo-user-001" },
          }),
        ).data,
      ).toMatchObject({ message: expect.any(Object) });
      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/notifications",
            method: "PATCH",
          }),
        ).data,
      ).toEqual({ updated: 1 });
      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/notifications/demo-notification-message-attention",
            method: "PATCH",
            params: { teamId: "demo-team-001" },
          }),
        ).data,
      ).toMatchObject({ id: "demo-notification-message-attention" });
      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/notifications/missing",
            method: "PATCH",
            params: { teamId: "demo-team-001" },
          }),
        ).data,
      ).toBeNull();
    });

    it("routes demo notification rule and email config mutations", () => {
      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/admin/notification-rules/preview",
            method: "POST",
            body: { ruleId: "demo-notification-rule-conversion-drop" },
          }),
        ).data,
      ).toMatchObject({
        status: "triggered",
        message: {
          type: "threshold",
          title: expect.stringContaining("traffic threshold reached"),
          bodyText: expect.stringContaining("Threshold: < 120"),
        },
      });
      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/admin/notification-rules/run",
            method: "POST",
            body: { ruleId: "demo-notification-rule-daily" },
          }),
        ).data,
      ).toMatchObject({
        evaluation: { status: "triggered" },
        messageCount: 1,
        messages: [expect.objectContaining({ type: "report" })],
      });
      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/admin/notification-rules",
            method: "DELETE",
            params: { id: "rule-1" },
          }),
        ).data,
      ).toEqual({ id: "rule-1", removed: true });
      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/admin/notification-rules",
            method: "POST",
            body: { name: "New rule", teamId: "demo-team-001" },
          }),
        ).data,
      ).toMatchObject({ name: "New rule" });
      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/admin/notification-email",
            method: "DELETE",
          }),
        ).data,
      ).toMatchObject({ enabled: false, resend: { configured: false } });
      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/admin/notification-email",
            method: "PATCH",
            body: {
              enabled: true,
              provider: "none",
              fromName: "Demo",
              fromEmail: "demo@example.test",
              replyTo: "reply@example.test",
              resendApiKey: "re_demo",
            },
          }),
        ).data,
      ).toMatchObject({
        enabled: true,
        provider: "none",
        fromName: "Demo",
        fromEmail: "demo@example.test",
        replyTo: "reply@example.test",
        resend: { configured: true, apiKeyHint: "••••demo" },
      });
      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/admin/notification-email",
            method: "PATCH",
            body: { resendApiKey: "re_demo", clearResendApiKey: true },
          }),
        ).data,
      ).toMatchObject({ resend: { configured: false } });
    });

    it("covers notification rule preview and run variants", () => {
      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/admin/notification-rules/preview",
            method: "POST",
            body: { id: "demo-notification-rule-daily" },
          }),
        ).data,
      ).toMatchObject({
        status: "triggered",
        message: { type: "report", data: { reportType: expect.any(String) } },
      });

      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/admin/notification-rules/preview",
            method: "POST",
            body: { ruleId: "demo-notification-rule-no-data" },
          }),
        ).data,
      ).toMatchObject({
        status: "triggered",
        message: { type: "health", severity: "critical" },
      });

      const fallback = ok(
        handleDemoRequest({
          path: "/api/private/admin/notification-rules/preview",
          method: "POST",
          body: null,
        }),
      ).data as Record<string, unknown>;
      expect(fallback.status).toBe("triggered");

      const run = ok(
        handleDemoRequest({
          path: "/api/private/admin/notification-rules/run",
          method: "POST",
          body: { ruleId: "missing-rule-id" },
        }),
      ).data as Record<string, unknown>;
      expect(run.summary).toEqual(
        expect.objectContaining({
          rulesScanned: 1,
          messagesCreated: expect.any(Number),
        }),
      );
    });

    it("routes funnel and API key write variants", () => {
      expect(
        handleDemoRequest({
          path: "/api/private/funnels",
          method: "POST",
          params: { siteId: SITE_ID },
          body: { name: "Checkout", steps: [] },
        }),
      ).toBeDefined();
      expect(
        handleDemoRequest({
          path: "/api/private/funnels",
          method: "DELETE",
          params: { siteId: SITE_ID, id: "funnel-1" },
        }),
      ).toBeDefined();

      const created = ok(
        handleDemoRequest({
          path: "/api/private/admin/api-keys",
          method: "POST",
          params: { teamId: "demo-team-001" },
          body: {
            name: "Created key",
            scopes: ["analytics:read"],
            siteIds: [SITE_ID],
          },
        }),
      ).data as Record<string, unknown>;
      expect(created).toMatchObject({
        key: {
          name: "Created key",
          scopes: ["analytics:read"],
          siteIds: [SITE_ID],
        },
        secret: expect.stringContaining("if_demo_"),
      });

      const key = (created.key as Record<string, unknown>).id;
      const revoked = ok(
        handleDemoRequest({
          path: "/api/private/admin/api-keys",
          method: "PATCH",
          body: { keyId: key, teamId: "demo-team-001" },
        }),
      ).data as Record<string, unknown>;
      expect(revoked.status).toBe("revoked");
    });

    it("routes demo site writes with fallback body handling", () => {
      const updated = ok(
        handleDemoRequest({
          path: "/api/private/admin/site",
          method: "PATCH",
          body: {
            siteId: "site-new",
            teamId: "demo-team-001",
            name: "Updated",
            domain: "updated.example.test",
            publicEnabled: false,
            publicSlug: "updated",
          },
        }),
      ).data as Record<string, unknown>;
      expect(updated).toMatchObject({
        id: "site-new",
        name: "Updated",
        domain: "updated.example.test",
        publicEnabled: false,
        publicSlug: "updated",
      });

      const fallback = ok(
        handleDemoRequest({
          path: "/api/private/admin/site",
          method: "POST",
          body: null,
        }),
      ).data as Record<string, unknown>;
      expect(fallback.id).toBeTruthy();
    });

    it("PATCH /profile tolerates non-object bodies", () => {
      const res = ok(
        handleDemoRequest({
          path: "/api/private/admin/profile",
          method: "PATCH",
          body: "not-an-object",
        }),
      );
      expect(res.ok).toBe(true);
    });

    it("PUT /site-config merges config body", () => {
      const res = ok(
        handleDemoRequest({
          path: "/api/private/admin/site-config",
          method: "PUT",
          body: { config: { foo: "bar" } },
        }),
      );
      expect(res.ok).toBe(true);
    });

    it("PUT /site-config tolerates missing config", () => {
      const res = ok(
        handleDemoRequest({
          path: "/api/private/admin/site-config",
          method: "PUT",
          body: {},
        }),
      );
      expect(res.ok).toBe(true);
    });

    it("returns generic success for unrecognized writes", () => {
      const res = ok(
        handleDemoRequest({ path: "/api/private/unknown", method: "DELETE" }),
      );
      expect(res.ok).toBe(true);
    });
  });

  describe("admin routes", () => {
    it("returns auth/me data", () => {
      const res = ok(handleDemoRequest({ path: "/api/private/session" }));
      expect(res.ok).toBe(true);
    });

    it("returns users", () => {
      const res = ok(handleDemoRequest({ path: "/api/private/admin/users" }));
      expect(Array.isArray(res.data)).toBe(true);
      expect((res.data as unknown[]).length).toBeGreaterThan(1);
    });

    it("returns teams", () => {
      const res = ok(handleDemoRequest({ path: "/api/private/admin/teams" }));
      expect(Array.isArray(res.data)).toBe(true);
    });

    it("returns sites", () => {
      const res = ok(handleDemoRequest({ path: "/api/private/admin/sites" }));
      expect(Array.isArray(res.data)).toBe(true);
    });

    it("returns members", () => {
      const res = ok(handleDemoRequest({ path: "/api/private/admin/members" }));
      expect(Array.isArray(res.data)).toBe(true);
    });

    it("returns team invites", () => {
      const res = ok(
        handleDemoRequest({
          path: "/api/private/admin/team-invites",
          params: { teamId: "demo-team-001" },
        }),
      );
      expect(res.data).toEqual([
        expect.objectContaining({
          code: expect.stringContaining("demo_"),
          url: expect.stringContaining("/invite#token="),
        }),
        expect.any(Object),
        expect.any(Object),
      ]);
    });

    it("returns site config", () => {
      const res = ok(
        handleDemoRequest({ path: "/api/private/admin/site-config" }),
      );
      expect(res.ok).toBe(true);
    });

    it("returns script snippet", () => {
      const res = ok(
        handleDemoRequest({
          path: "/api/private/admin/script-snippet",
          params: { siteId: SITE_ID },
        }),
      );
      expect(res.ok).toBe(true);
    });

    it("returns system performance metrics", () => {
      const res = ok(
        handleDemoRequest({ path: "/api/private/admin/system-performance" }),
      );
      expect(res.ok).toBe(true);
    });

    it("returns DO diagnostic", () => {
      const res = ok(
        handleDemoRequest({ path: "/api/private/admin/do-diagnostic" }),
      );
      expect(res.ok).toBe(true);
    });

    it("limits bot analytics overview data and paginates detail rows", () => {
      const path = "/api/private/admin/bot-analytics";
      const params = {
        from: FIXED_FROM,
        to: FIXED_FROM + 60 * 60 * 1000,
        limit: 7,
      };
      const overview = asRecord(handleDemoRequest({ path, params }));
      const abnormal = overview.abnormal as Record<string, unknown>;
      const normal = overview.normal as Record<string, unknown>;
      const abnormalEvents = overview.events as unknown[];
      const normalEvents = overview.normalEvents as unknown[];

      expect(abnormalEvents).toHaveLength(7);
      expect(normalEvents).toHaveLength(7);
      expect(abnormal.events).toEqual(abnormalEvents);
      expect(normal.events).toEqual(normalEvents);
      expect(abnormal.hasMore).toBe(true);
      expect(normal.hasMore).toBe(true);

      const nextPage = asRecord(
        handleDemoRequest({
          path,
          params: {
            ...params,
            page: "abnormal",
            cursor: JSON.stringify(abnormal.nextCursor),
          },
        }),
      ).page as Record<string, unknown>;

      const nextPageEvents = nextPage.events as unknown[];
      expect(nextPageEvents).toHaveLength(7);
      expect(nextPageEvents).not.toEqual(abnormalEvents);
      expect((nextPageEvents[0] as Record<string, unknown>).traceId).not.toBe(
        (abnormalEvents[0] as Record<string, unknown>).traceId,
      );
      expect(nextPage.hasMore).toBe(true);
      expect(nextPage.nextCursor).toEqual(expect.any(Object));
    });

    it("returns notification admin lists", () => {
      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/admin/api-keys",
            params: { teamId: "demo-team-001" },
          }),
        ).data,
      ).toEqual(expect.any(Array));
      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/admin/notification-rules",
            params: { teamId: "demo-team-001" },
          }),
        ).data,
      ).toEqual(expect.any(Array));
      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/notifications",
            params: { teamId: "demo-team-001", locale: "zh" },
          }),
        ).data,
      ).toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({
            type: "threshold",
            title: expect.stringContaining("访问量达到阈值"),
          }),
          expect.objectContaining({ type: "milestone" }),
          expect.objectContaining({ type: "change" }),
        ]),
        unreadAttentionCount: expect.any(Number),
      });
      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/admin/notification-email",
          }),
        ).data,
      ).toMatchObject({ resend: { configured: false } });
      expect(
        handleDemoRequest({
          path: "/api/private/admin/scheduled-tasks",
          params: { teamId: "demo-team-001" },
        }),
      ).toBeDefined();
    });

    it("returns system-performance with different windowMinutes values", () => {
      for (const minutes of [5, 30, 180, 720, 1440]) {
        const res = handleDemoRequest({
          path: "/api/private/admin/system-performance",
          params: { windowMinutes: minutes },
        });
        expect(res).toBeDefined();
      }
    });

    it("honors supported system-performance minutes and falls back otherwise", () => {
      for (const [minutes, bucketSizeMs] of [
        [15, 60_000],
        [60, 5 * 60_000],
        [360, 30 * 60_000],
        [1440, 60 * 60_000],
      ] as const) {
        const res = asRecord(
          handleDemoRequest({
            path: "/api/private/admin/system-performance",
            params: { minutes },
          }),
        );
        const window = res.window as Record<string, unknown>;
        expect(window.minutes).toBe(minutes);
        expect(window.bucketSizeMs).toBe(bucketSizeMs);
      }

      const fallback = asRecord(
        handleDemoRequest({
          path: "/api/private/admin/system-performance",
          params: { minutes: 999 },
        }),
      );
      expect((fallback.window as Record<string, unknown>).minutes).toBe(60);
    });
  });

  describe("analytics queries", () => {
    const now = Date.now();
    const baseParams = {
      siteId: SITE_ID,
      from: now - 3_600_000,
      to: now,
    };

    const routes = [
      "/api/private/filter-values",
      "/api/private/overview",
      "/api/private/overview-page-path",
      "/api/private/overview-page-title",
      "/api/private/overview-page-hostname",
      "/api/private/overview-page-entry",
      "/api/private/overview-page-exit",
      "/api/private/overview-source-domain",
      "/api/private/overview-source-link",
      "/api/private/overview-client-browser",
      "/api/private/overview-client-os-version",
      "/api/private/overview-client-device-type",
      "/api/private/overview-client-language",
      "/api/private/overview-client-screen-size",
      "/api/private/overview-geo-country",
      "/api/private/overview-geo-region",
      "/api/private/overview-geo-city",
      "/api/private/overview-geo-continent",
      "/api/private/overview-geo-timezone",
      "/api/private/overview-geo-organization",
      "/api/private/overview-geo-points",
      "/api/private/trend",
      "/api/private/sessions",
      "/api/private/pages",
      "/api/private/referrers",
      "/api/private/visitors",
      "/api/private/countries",
      "/api/private/devices",
      "/api/private/page-hash",
      "/api/private/page-query",
      "/api/private/event-types",
      "/api/private/events-summary",
      "/api/private/events-trend",
      "/api/private/events-records",
      "/api/private/pages-dashboard",
      "/api/private/retention",
      "/api/private/performance",
      "/api/private/browser-cross-breakdown",
      "/api/private/browser-version-breakdown",
      "/api/private/browser-radar",
      "/api/private/referrer-radar",
      "/api/private/referrer-dimension-trend",
      "/api/private/browser-trend",
      "/api/private/browser-engine-trend",
      "/api/private/client-dimension-trend",
      "/api/private/utm-dimension-trend",
      "/api/private/utm-source",
      "/api/private/utm-medium",
      "/api/private/utm-campaign",
      "/api/private/utm-term",
      "/api/private/utm-content",
    ];

    it.each(routes)("returns a defined result for %s", (route) => {
      const res = handleDemoRequest({ path: route, params: baseParams });
      expect(res).toBeDefined();
    });

    it("client-cross-breakdown handles missing dimensions gracefully", () => {
      const res = handleDemoRequest({
        path: "/api/private/client-cross-breakdown",
        params: baseParams,
      }) as Record<string, unknown>;
      expect(res).toMatchObject({
        ok: true,
        data: {
          columns: expect.any(Array),
          rows: expect.any(Array),
          totalVisitors: 0,
        },
      });
    });

    it("client-cross-breakdown returns data for valid dimensions", () => {
      const res = handleDemoRequest({
        path: "/api/private/client-cross-breakdown",
        params: {
          ...baseParams,
          primaryDimension: "browser",
          secondaryDimension: "deviceType",
        },
      }) as Record<string, unknown>;
      expect(res).toBeDefined();
    });

    it("returns ok for team dashboard", () => {
      const res = ok(
        handleDemoRequest({
          path: "/api/private/team-dashboard",
          params: baseParams,
        }),
      );
      expect(res).toBeDefined();
    });

    it("returns session detail", () => {
      const res = handleDemoRequest({
        path: "/api/private/session-detail",
        params: { ...baseParams, sessionId: "demo-site-001-s-00001" },
      });
      expect(res).toBeDefined();
    });

    it("returns visitor detail", () => {
      const res = handleDemoRequest({
        path: "/api/private/visitor-detail",
        params: { ...baseParams, visitorId: "v-001-000001" },
      });
      expect(res).toBeDefined();
    });

    it("returns overview change rates and detail trend when requested", () => {
      const res = asRecord(
        handleDemoRequest({
          path: "/api/private/overview",
          params: {
            ...ANALYTICS_PARAMS,
            includeChange: "true",
            includeDetail: "1",
            interval: "hour",
            tz: "Asia/Shanghai",
          },
        }),
      );

      expect(res.ok).toBe(true);
      expect(res.previousData).toBeTruthy();
      expect(res.changeRates).toEqual(
        expect.objectContaining({
          views: expect.any(Number),
          sessions: expect.any(Number),
        }),
      );
      expect(res.detail).toEqual(
        expect.objectContaining({
          interval: "hour",
          data: expect.any(Array),
        }),
      );
    }, 20000);

    it("falls back to a single trend bucket for an inverted time window", () => {
      const res = asRecord(
        handleDemoRequest({
          path: "/api/private/trend",
          params: {
            siteId: SITE_ID,
            from: FIXED_TO,
            to: FIXED_FROM,
            interval: "hour",
          },
        }),
      );

      expect(res.ok).toBe(true);
      expect(res.interval).toBe("hour");
      expect(res.data).toEqual([
        expect.objectContaining({
          bucket: 0,
          views: 0,
          visitors: 0,
          sessions: 0,
        }),
      ]);
    });

    it("returns event detail, context cards, and payload field values", () => {
      const eventRows = dataRows(
        handleDemoRequest({
          path: "/api/private/events-records",
          params: { ...ANALYTICS_PARAMS, pageSize: 10 },
        }),
      );
      expect(eventRows.length).toBeGreaterThan(0);
      const event = eventRows[0];
      const eventId = String(event.eventId);
      const eventName = String(event.eventName);

      const detail = ok(
        handleDemoRequest({
          path: "/api/private/event-record-detail",
          params: { ...ANALYTICS_PARAMS, eventId },
        }),
      ).data as Record<string, unknown>;
      expect(detail.event).toEqual(expect.objectContaining({ eventId }));
      expect(detail.eventData).toEqual(
        expect.objectContaining({
          plan: expect.any(String),
          page: expect.any(Object),
          flags: expect.any(Object),
          items: expect.any(Array),
        }),
      );

      const typeDetail = asRecord(
        handleDemoRequest({
          path: "/api/private/event-type-detail",
          params: { ...ANALYTICS_PARAMS, eventName, interval: "hour" },
        }),
      );
      expect(typeDetail.eventName).toBe(eventName);
      expect(typeDetail.summary).toEqual(
        expect.objectContaining({ eventTypes: 1 }),
      );
      expect(typeDetail.breakdowns).toEqual(
        expect.objectContaining({
          pages: expect.any(Array),
          countries: expect.any(Array),
          devices: expect.any(Array),
          browsers: expect.any(Array),
        }),
      );
      expect(typeDetail.cards).toEqual(
        expect.objectContaining({
          page: expect.any(Object),
          source: expect.any(Object),
          client: expect.any(Object),
          geo: expect.any(Object),
        }),
      );
      expect(typeDetail.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "/plan", valueType: "string" }),
          expect.objectContaining({ path: "/value", valueType: "number" }),
          expect.objectContaining({
            path: "/flags/signedIn",
            valueType: "boolean",
          }),
          expect.objectContaining({ path: "/items/*", valueType: "null" }),
        ]),
      );

      const fieldValues = dataRows(
        handleDemoRequest({
          path: "/api/private/event-type-field-values",
          params: {
            ...ANALYTICS_PARAMS,
            eventName,
            fieldPath: "/plan",
            fieldValueType: "string",
            limit: 5,
          },
        }),
      );
      expect(fieldValues.length).toBeGreaterThan(0);
      expect(fieldValues[0]).toEqual(
        expect.objectContaining({
          value: expect.any(String),
          occurrences: expect.any(Number),
        }),
      );

      const fields = asRecord(
        handleDemoRequest({
          path: "/api/private/event-type-fields",
          params: { ...ANALYTICS_PARAMS, eventName },
        }),
      );
      expect(fields).toMatchObject({ ok: true, eventName });
      expect(fields.fields).toEqual(expect.any(Array));

      const apiV1Fields = asRecord(
        handleDemoRequest({
          path: `/api/v1/sites/${SITE_ID}/event-fields`,
          params: { ...ANALYTICS_PARAMS, eventName },
        }),
      );
      expect(apiV1Fields).toMatchObject({ ok: true, eventName });

      const apiV1FieldValues = asRecord(
        handleDemoRequest({
          path: `/api/v1/sites/${SITE_ID}/event-fields/values`,
          params: {
            ...ANALYTICS_PARAMS,
            eventName,
            fieldPath: "/plan",
            fieldValueType: "string",
            search: "pro",
          },
        }),
      );
      expect(apiV1FieldValues.data).toEqual(expect.any(Array));
    });

    it("supports event payload filters for scalar and array values", () => {
      const planMiss = dataRows(
        handleDemoRequest({
          path: "/api/private/events-records",
          params: {
            ...ANALYTICS_PARAMS,
            "filter[event.payload][/plan]": "not-a-demo-plan",
          },
        }),
      );
      expect(planMiss).toHaveLength(0);

      const planNeRows = dataRows(
        handleDemoRequest({
          path: "/api/private/events-records",
          params: {
            ...ANALYTICS_PARAMS,
            pageSize: 3,
            "filter[event.payload][/plan]": "neq:not-a-demo-plan",
          },
        }),
      );
      expect(planNeRows.length).toBeGreaterThan(0);

      const nullArrayRows = dataRows(
        handleDemoRequest({
          path: "/api/private/events-records",
          params: {
            ...ANALYTICS_PARAMS,
            pageSize: 3,
            "filter[event.payload][/items/*]": "isNull",
          },
        }),
      );
      expect(nullArrayRows.length).toBeGreaterThan(0);

      const numberMiss = dataRows(
        handleDemoRequest({
          path: "/api/private/events-records",
          params: {
            ...ANALYTICS_PARAMS,
            "filter[event.payload][/value]": "eq:json:999999",
          },
        }),
      );
      expect(numberMiss).toHaveLength(0);
    });

    it("groups less common event names into an Other trend series", () => {
      const res = asRecord(
        handleDemoRequest({
          path: "/api/private/events-trend",
          params: {
            ...ANALYTICS_PARAMS,
            interval: "hour",
            limit: 1,
          },
        }),
      );

      expect(res.ok).toBe(true);
      expect(res.series).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "other", isOther: true }),
        ]),
      );
      expect(res.data).toEqual(expect.any(Array));
    });

    it("returns empty event field values when required params are absent", () => {
      const res = asRecord(
        handleDemoRequest({
          path: "/api/private/event-type-field-values",
          params: ANALYTICS_PARAMS,
        }),
      );

      expect(res.ok).toBe(true);
      expect(res.data).toEqual([]);
    });

    it.each([
      "page.path",
      "page.title",
      "page.hostname",
      "page.query",
      "page.hash",
      "session.entryPath",
      "session.exitPath",
      "referrer.domain",
      "referrer.url",
      "client.browser",
      "client.browserVersion",
      "client.browserEngine",
      "client.os",
      "client.osVersion",
      "client.deviceType",
      "client.language",
      "client.screenSize",
      "geo.country",
      "geo.region",
      "geo.city",
      "geo.continent",
      "geo.timeZone",
      "geo.organization",
      "event.name",
      "utm.source",
      "utm.medium",
      "utm.campaign",
      "utm.term",
      "utm.content",
    ])("returns canonical filter values for %s", (filterKey) => {
      const res = ok(
        handleDemoRequest({
          path: "/api/private/filter-values",
          params: { ...ANALYTICS_PARAMS, filterKey, limit: 8 },
        }),
      );

      expect(res.ok).toBe(true);
      expect(asRecord(res).field).toBe(filterKey);
      expect(Array.isArray(res.data)).toBe(true);
      const values = (res.data as Array<{ value: string }>).map(
        (item) => item.value,
      );
      expect(new Set(values).size).toBe(values.length);
    });

    it("excludes the current canonical condition before finding filter values", () => {
      const res = asRecord(
        handleDemoRequest({
          path: "/api/private/filter-values",
          params: {
            ...ANALYTICS_PARAMS,
            filterKey: "page.path",
            "filter[page.path]": "/not-present-in-demo",
          },
        }),
      );
      expect(res).toMatchObject({ ok: true, field: "page.path" });
      expect(res.data).toEqual(expect.any(Array));
    });

    it("removes nested NOT and OR branches for the active canonical field", () => {
      const res = asRecord(
        handleDemoRequest({
          path: "/api/private/filter-values",
          params: {
            ...ANALYTICS_PARAMS,
            filterKey: "page.path",
            "filter[page.path][not]": "/private",
            "filter[page.title][not]": "Internal",
            "filter[page.path][or:0.0]": "/",
            "filter[page.title][or:0.1]": "Home",
          },
        }),
      );
      expect(res).toMatchObject({ ok: true, field: "page.path" });
    });

    it("returns an empty event-fields response when eventName is absent", () => {
      const res = asRecord(
        handleDemoRequest({
          path: "/api/private/event-type-fields",
          params: ANALYTICS_PARAMS,
        }),
      );
      expect(res).toMatchObject({ ok: true, eventName: "", fields: [] });
    });

    it("limits public filter values to public canonical fields", () => {
      const denied = asRecord(
        handleDemoRequest({
          path: "/api/public/share/some-token/filter-values",
          params: { ...ANALYTICS_PARAMS, filterKey: "page.query" },
        }),
      );
      expect(denied).toMatchObject({ ok: false, data: [] });
    });

    it("returns hierarchical geo point counts with and without region filters", () => {
      const countryRes = asRecord(
        handleDemoRequest({
          path: "/api/private/overview-geo-points",
          params: {
            ...ANALYTICS_PARAMS,
            geo: "US",
            applyGeoFilter: "true",
            limit: 50,
          },
        }),
      );
      expect(countryRes.ok).toBe(true);
      expect(countryRes.data).toEqual(expect.any(Array));
      expect(countryRes.countryCounts).toEqual(expect.any(Array));
      expect(countryRes.regionCounts).toEqual(expect.any(Array));

      const region = (countryRes.regionCounts as Array<{ value: string }>)[0];
      if (region) {
        const regionRes = asRecord(
          handleDemoRequest({
            path: "/api/private/overview-geo-points",
            params: {
              ...ANALYTICS_PARAMS,
              geo: region.value,
              applyGeoFilter: 1,
              limit: 50,
            },
          }),
        );
        expect(regionRes.cityCounts).toEqual(expect.any(Array));
      }
    });

    it.each([
      "browser",
      "operatingSystem",
      "osVersion",
      "deviceType",
      "language",
      "screenSize",
    ])("routes client dimension trend for %s", (dimension) => {
      const res = asRecord(
        handleDemoRequest({
          path: "/api/private/client-dimension-trend",
          params: {
            ...ANALYTICS_PARAMS,
            dimension,
            interval: "hour",
            limit: 2,
          },
        }),
      );

      expect(res.ok).toBe(true);
      expect(res.series).toEqual(expect.any(Array));
      expect(res.data).toEqual(expect.any(Array));
    });

    it.each(["source", "medium", "campaign", "term", "content"])(
      "routes UTM trend for %s",
      (dimension) => {
        const res = asRecord(
          handleDemoRequest({
            path: "/api/private/utm-dimension-trend",
            params: {
              ...ANALYTICS_PARAMS,
              dimension,
              interval: "hour",
              limit: 2,
            },
          }),
        );

        expect(res.ok).toBe(true);
        expect(res.series).toEqual(expect.any(Array));
        expect(res.data).toEqual(expect.any(Array));
      },
    );

    it("returns browser and client cross breakdowns with other buckets", () => {
      const browserCross = asRecord(
        handleDemoRequest({
          path: "/api/private/browser-cross-breakdown",
          params: {
            ...ANALYTICS_PARAMS,
            browserLimit: 1,
            osLimit: 1,
            deviceTypeLimit: 1,
          },
        }),
      );
      expect(browserCross.ok).toBe(true);
      expect(browserCross.operatingSystem).toEqual(
        expect.objectContaining({
          columns: expect.any(Array),
          rows: expect.any(Array),
        }),
      );

      const sameDimension = asRecord(
        handleDemoRequest({
          path: "/api/private/client-cross-breakdown",
          params: {
            ...ANALYTICS_PARAMS,
            primaryDimension: "browser",
            secondaryDimension: "browser",
          },
        }),
      );
      expect(sameDimension).toMatchObject({
        ok: true,
        data: {
          columns: [],
          rows: [],
          totalVisitors: 0,
        },
      });

      const clientCross = asRecord(
        handleDemoRequest({
          path: "/api/private/client-cross-breakdown",
          params: {
            ...ANALYTICS_PARAMS,
            primaryDimension: "browser",
            secondaryDimension: "language",
            primaryLimit: 1,
            secondaryLimit: 1,
          },
        }),
      );
      expect(clientCross).toMatchObject({
        ok: true,
        data: {
          columns: expect.any(Array),
          rows: expect.any(Array),
        },
      });
    });

    it("returns empty shaped data for inverted-window trend and radar routes", () => {
      const invertedParams = {
        siteId: SITE_ID,
        from: FIXED_TO,
        to: FIXED_FROM,
        interval: "hour",
      };

      const clientTrend = asRecord(
        handleDemoRequest({
          path: "/api/private/client-dimension-trend",
          params: { ...invertedParams, dimension: "browser" },
        }),
      );
      expect(clientTrend).toMatchObject({
        ok: true,
        interval: "hour",
        series: [],
        data: [],
      });

      const utmTrend = asRecord(
        handleDemoRequest({
          path: "/api/private/utm-dimension-trend",
          params: { ...invertedParams, dimension: "source" },
        }),
      );
      expect(utmTrend).toMatchObject({
        ok: true,
        interval: "hour",
        series: [],
        data: [],
      });

      const browserRadar = asRecord(
        handleDemoRequest({
          path: "/api/private/browser-radar",
          params: invertedParams,
        }),
      );
      expect(browserRadar).toMatchObject({ ok: true, data: [] });

      const referrerRadar = asRecord(
        handleDemoRequest({
          path: "/api/private/referrer-radar",
          params: invertedParams,
        }),
      );
      expect(referrerRadar).toMatchObject({ ok: true, data: [] });

      const browserCross = asRecord(
        handleDemoRequest({
          path: "/api/private/browser-cross-breakdown",
          params: invertedParams,
        }),
      );
      expect(browserCross.operatingSystem).toEqual({
        columns: [],
        rows: [],
        totalVisitors: 0,
      });

      const clientCross = asRecord(
        handleDemoRequest({
          path: "/api/private/client-cross-breakdown",
          params: {
            ...invertedParams,
            primaryDimension: "browser",
            secondaryDimension: "language",
          },
        }),
      );
      expect(clientCross).toMatchObject({
        ok: true,
        data: {
          columns: [],
          rows: [],
          totalVisitors: 0,
        },
      });
    });

    it("limits browser versions and includes nested version rows", () => {
      const rows = dataRows(
        handleDemoRequest({
          path: "/api/private/browser-version-breakdown",
          params: {
            ...ANALYTICS_PARAMS,
            browserLimit: 1,
            versionLimit: 1,
          },
        }),
      );

      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].versions).toEqual(expect.any(Array));
    });

    it("paginates pages, sessions, visitors, and event records", () => {
      const pages = asRecord(
        handleDemoRequest({
          path: "/api/private/pages-dashboard",
          params: { ...ANALYTICS_PARAMS, page: 1, pageSize: 2 },
        }),
      );
      expect(pages.meta).toEqual(
        expect.objectContaining({ page: 1, pageSize: 2, returned: 2 }),
      );

      const visitors = asRecord(
        handleDemoRequest({
          path: "/api/private/visitors",
          params: {
            ...ANALYTICS_PARAMS,
            pageSize: 2,
            sortBy: "views",
            sortDir: "asc",
            search: "/",
          },
        }),
      );
      expect(visitors.meta).toEqual(
        expect.objectContaining({
          pageSize: 2,
          nextCursor: expect.any(String),
        }),
      );
      expect(visitors.data).toEqual(expect.any(Array));

      const sessions = asRecord(
        handleDemoRequest({
          path: "/api/private/sessions",
          params: {
            ...ANALYTICS_PARAMS,
            pageSize: 2,
            sortBy: "durationMs",
            sortDir: "asc",
            q: "/",
          },
        }),
      );
      expect(sessions.meta).toEqual(
        expect.objectContaining({
          pageSize: 2,
          nextCursor: expect.any(String),
        }),
      );

      const events = asRecord(
        handleDemoRequest({
          path: "/api/private/events-records",
          params: {
            ...ANALYTICS_PARAMS,
            page: 1,
            pageSize: 2,
            sortBy: "eventName",
            sortDir: "asc",
            search: "/",
          },
        }),
      );
      expect(events.meta).toEqual(
        expect.objectContaining({ page: 1, pageSize: 2 }),
      );
    });

    it("builds visitor and session details from IDs returned by list routes", () => {
      const visitor = dataRows(
        handleDemoRequest({
          path: "/api/private/visitors",
          params: { ...ANALYTICS_PARAMS, page: 1, pageSize: 1 },
        }),
      )[0];
      expect(visitor).toBeTruthy();

      const visitorDetail = ok(
        handleDemoRequest({
          path: "/api/private/visitor-detail",
          params: {
            ...ANALYTICS_PARAMS,
            visitorId: String(visitor.visitorId),
          },
        }),
      ).data as Record<string, unknown>;
      expect(visitorDetail).toEqual(
        expect.objectContaining({
          visitor: expect.objectContaining({
            visitorId: String(visitor.visitorId),
          }),
          metrics: expect.any(Object),
          sessions: expect.any(Array),
          events: expect.any(Array),
          activity: expect.any(Array),
          performance: expect.any(Object),
        }),
      );

      const session = dataRows(
        handleDemoRequest({
          path: "/api/private/sessions",
          params: { ...ANALYTICS_PARAMS, page: 1, pageSize: 1 },
        }),
      )[0];
      expect(session).toBeTruthy();

      const sessionDetail = ok(
        handleDemoRequest({
          path: "/api/private/session-detail",
          params: {
            ...ANALYTICS_PARAMS,
            sessionId: String(session.sessionId),
          },
        }),
      ).data as Record<string, unknown>;
      expect(sessionDetail).toEqual(
        expect.objectContaining({
          session: expect.objectContaining({
            sessionId: String(session.sessionId),
          }),
          locationPoints: expect.any(Array),
          events: expect.any(Array),
          visitedPages: expect.any(Array),
          eventDistribution: expect.any(Array),
          performance: expect.any(Object),
        }),
      );
    });

    it("returns null details when journey IDs are missing", () => {
      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/visitor-detail",
            params: ANALYTICS_PARAMS,
          }),
        ).data,
      ).toBeNull();
      expect(
        ok(
          handleDemoRequest({
            path: "/api/private/session-detail",
            params: ANALYTICS_PARAMS,
          }),
        ).data,
      ).toBeNull();
    });

    it("normalizes retention granularity and returns monthly cohorts", () => {
      const invalid = asRecord(
        handleDemoRequest({
          path: "/api/private/retention",
          params: { ...ANALYTICS_PARAMS, granularity: "quarter" },
        }),
      );
      expect(invalid.granularity).toBe("week");

      const monthly = asRecord(
        handleDemoRequest({
          path: "/api/private/retention",
          params: { ...ANALYTICS_PARAMS, granularity: "month" },
        }),
      );
      expect(monthly.granularity).toBe("month");
      expect(monthly.cohorts).toEqual(expect.any(Array));
    });
  });

  describe("public routes", () => {
    const now = Date.now();
    const params = {
      siteId: SITE_ID,
      from: now - 3_600_000,
      to: now,
    };

    it("dispatches overview to the same generator", () => {
      const res = handleDemoRequest({
        path: "/api/public/share/some-token/overview",
        params,
      });
      expect(res).toBeDefined();
    });

    it("returns public site metadata and not-found for missing public slugs", () => {
      expect(
        ok(
          handleDemoRequest({
            path: "/api/public/share/demo-site-001/site",
            params,
          }),
        ),
      ).toMatchObject({
        ok: true,
        data: {
          id: expect.any(String),
          slug: "demo-site-001",
          name: expect.any(String),
          domain: expect.any(String),
        },
      });

      expect(
        ok(
          handleDemoRequest({
            path: "/api/public/share/no-such-demo-public-site-999/site",
            params,
          }),
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "not_found", message: "Not Found" },
      });

      expect(
        ok(
          handleDemoRequest({
            path: "/api/public/share/no-such-demo-public-site-999/unknown",
            params,
          }),
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "not_found", message: "Not Found" },
      });
    });

    it("dispatches trend to the same generator", () => {
      const res = handleDemoRequest({
        path: "/api/public/share/some-token/trend",
        params,
      });
      expect(res).toBeDefined();
    });

    it("dispatches pages to the same generator", () => {
      const res = handleDemoRequest({
        path: "/api/public/share/some-token/pages",
        params,
      });
      expect(res).toBeDefined();
    });

    it("dispatches referrers to the same generator", () => {
      const res = handleDemoRequest({
        path: "/api/public/share/some-token/referrers",
        params,
      });
      expect(res).toBeDefined();
    });

    it("returns fallback for unknown public sub-paths", () => {
      const res = ok(
        handleDemoRequest({
          path: "/api/public/share/some-token/unknown",
          params,
        }),
      );
      expect(res.ok).toBe(false);
      expect(res).toMatchObject({
        error: { code: "not_found", message: "Not Found" },
      });
    });

    it.each([
      "performance",
      "countries",
      "filter-values",
      "overview-geo-points",
      "overview-client-browser",
      "overview-client-os-version",
      "overview-client-device-type",
      "overview-client-language",
      "overview-client-screen-size",
      "overview-geo-country",
      "overview-geo-region",
      "overview-geo-city",
      "overview-geo-continent",
      "overview-geo-timezone",
      "overview-geo-organization",
      "browser-trend",
      "browser-engine-trend",
      "browser-version-breakdown",
      "browser-cross-breakdown",
      "browser-radar",
      "referrer-radar",
      "referrer-dimension-trend",
      "client-dimension-trend",
      "client-cross-breakdown",
    ])("dispatches public %s routes", (subPath) => {
      const res = handleDemoRequest({
        path: `/api/public/share/some-token/${subPath}`,
        params: {
          ...params,
          dimension: "browser",
          filterKey: "client.browser",
          primaryDimension: "browser",
          secondaryDimension: "language",
        },
      });

      expect(res).toBeDefined();
      expect(ok(res).ok).toBe(true);
    });

    it("falls back for unsupported public client and geo tabs", () => {
      expect(
        ok(
          handleDemoRequest({
            path: "/api/public/share/some-token/overview-geo-unknown",
            params,
          }),
        ),
      ).toMatchObject({ ok: true });
    });
  });

  describe("email preview", () => {
    it("renders demo notification previews in html, text, and json formats", async () => {
      await expect(
        handleDemoNotificationEmailPreview({
          type: "report",
          locale: "zh",
          format: "html",
        }),
      ).resolves.toContain("<");
      await expect(
        handleDemoNotificationEmailPreview({
          type: "threshold",
          locale: "en",
          format: "text",
        }),
      ).resolves.toEqual(expect.any(String));
      await expect(
        handleDemoNotificationEmailPreview({
          type: "health",
          locale: "en",
          format: "json",
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          subject: expect.any(String),
          html: expect.any(String),
          text: expect.any(String),
        }),
      );
    });
  });

  describe("fallback", () => {
    it("returns a not-found error for unrecognized GET paths", () => {
      const res = ok(
        handleDemoRequest({ path: "/api/private/totally-unknown" }),
      );
      expect(res.ok).toBe(false);
      expect(res).toMatchObject({
        error: { code: "not_found", message: "Not Found" },
      });
    });
  });
});

describe("mock — createMockRealtimeSocket", () => {
  function closeSocket(socket: RealtimeSocketLike) {
    try {
      socket.close();
    } catch {
      // ignore
    }
  }

  it("returns a socket-like object", () => {
    const socket = createMockRealtimeSocket({ siteId: SITE_ID });
    expect(typeof socket.close).toBe("function");
    expect(socket.readyState).toBeGreaterThanOrEqual(0);
    closeSocket(socket);
  });

  it("can be closed twice without error", () => {
    const socket = createMockRealtimeSocket({ siteId: SITE_ID });
    socket.close();
    expect(() => socket.close()).not.toThrow();
  });

  it("respects custom activeWindowMs", () => {
    const socket = createMockRealtimeSocket({
      siteId: SITE_ID,
      activeWindowMs: 60_000,
    });
    expect(socket).toBeDefined();
    closeSocket(socket);
  });

  it("opens, emits a snapshot, and closes cleanly on the timer path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TO);
    const randomSpy = vi
      .spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValue(0.5);
    const socket = createMockRealtimeSocket({ siteId: SITE_ID });
    const onopen = vi.fn();
    const onmessage = vi.fn();
    const onclose = vi.fn();
    socket.onopen = onopen;
    socket.onmessage = onmessage;
    socket.onclose = onclose;

    await vi.advanceTimersByTimeAsync(120);

    expect(randomSpy).toHaveBeenCalled();
    expect(socket.readyState).toBe(1);
    expect(onopen).toHaveBeenCalledTimes(1);
    expect(onmessage).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.stringContaining('"type":"snapshot"'),
      }),
    );

    socket.close(4001, "done");
    expect(socket.readyState).toBe(3);
    expect(onclose).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 4001,
        reason: "done",
        wasClean: false,
      }),
    );
  });

  it("emits an error when the mock handshake fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TO);
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.1)
      .mockReturnValue(0.5);
    const socket = createMockRealtimeSocket({ siteId: SITE_ID });
    const onerror = vi.fn();
    const onopen = vi.fn();
    socket.onerror = onerror;
    socket.onopen = onopen;

    await vi.advanceTimersByTimeAsync(120);

    expect(onerror).toHaveBeenCalledTimes(1);
    expect(onopen).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(0);
    closeSocket(socket);
  });

  it("does not open when closed before the handshake timer completes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TO);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const socket = createMockRealtimeSocket({ siteId: SITE_ID });
    const onopen = vi.fn();
    const onclose = vi.fn();
    socket.onopen = onopen;
    socket.onclose = onclose;

    socket.close();
    await vi.advanceTimersByTimeAsync(780);

    expect(socket.readyState).toBe(3);
    expect(onopen).not.toHaveBeenCalled();
    expect(onclose).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 1000,
        reason: "mock closed",
        wasClean: true,
      }),
    );
  });

  it("emits realtime events after the initial snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TO);
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValue(1);
    const socket = createMockRealtimeSocket({ siteId: SITE_ID });
    const onmessage = vi.fn();
    socket.onmessage = onmessage;

    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(41_000);

    const messages = onmessage.mock.calls.map(([event]) =>
      JSON.parse((event as MessageEvent).data as string),
    ) as Array<{ type: string; data: Record<string, unknown> }>;
    const eventMessage = messages.find((message) => message.type === "event");
    expect(eventMessage?.data).toMatchObject({
      eventType: expect.any(String),
      visitorId: expect.any(String),
      sessionId: expect.any(String),
      pathname: expect.any(String),
      hash: "",
    });
    closeSocket(socket);
  });

  it("emits an error on the scheduled disconnect path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TO);
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValue(0);
    const socket = createMockRealtimeSocket({ siteId: SITE_ID });
    const onerror = vi.fn();
    socket.onerror = onerror;

    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(18_000);

    expect(onerror).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(1);
    closeSocket(socket);
  });
});
