import { expect, test } from "@playwright/test";

import { apiRequest, apiV1Request } from "../support/api";
import { signIn } from "../support/browser";
import type { E2eContext } from "../support/flow-context";

type SavedFilter = {
  filterDsl: string;
  id: string;
  isOwner: boolean;
  name: string;
  visibility: "private" | "team";
};

type TeamDashboard = {
  sites: Array<{ id: string; overview: { views: number } }>;
  trend: unknown[];
};

type TimeRange = {
  from: string;
  kind: "absolute";
  timeZone: "UTC";
  to: string;
};

function absoluteTimeRange(fromMs: number, toMs: number): TimeRange {
  return {
    from: new Date(fromMs).toISOString(),
    kind: "absolute",
    timeZone: "UTC",
    to: new Date(toMs).toISOString(),
  };
}

export function registerNonFunnelCoverageScenarios(context: E2eContext) {
  const { browserNowMs, flushSite, seed, testSiteURL } = context;
  const {
    memberA: memberAPassword,
    ownerA: ownerAPassword,
    outsider: outsiderPassword,
    restrictedA: restrictedAPassword,
  } = context.passwords;

  test("25. logout invalidates the private session and can recover", async ({
    page,
  }) => {
    await signIn(page, "owner-a", ownerAPassword);

    const loggedOut = await apiRequest<unknown>(
      page,
      "DELETE",
      "/api/public/session",
    );
    expect(loggedOut.status).toBe(200);

    const privateSession = await apiRequest<unknown>(
      page,
      "GET",
      "/api/private/session",
      undefined,
      "no-store",
    );
    expect(privateSession.status).toBe(401);

    await signIn(page, "owner-a", ownerAPassword);
    const recoveredSession = await apiRequest<unknown>(
      page,
      "GET",
      "/api/private/session",
      undefined,
      "no-store",
    );
    expect(recoveredSession.status).toBe(200);
  });

  test("26. notification preferences persist channel and attention settings", async ({
    page,
  }) => {
    await signIn(page, "owner-a", ownerAPassword);

    const initial = await apiRequest<{
      attention: { alertsCreateUnread: boolean };
      email: boolean;
      inApp: boolean;
      webPush: boolean;
    }>(
      page,
      "GET",
      "/api/private/notifications/preferences",
      undefined,
      "no-store",
    );
    expect(initial.status).toBe(200);
    expect(initial.payload.data).toMatchObject({
      email: true,
      inApp: true,
      webPush: false,
    });

    const updated = await apiRequest<typeof initial.payload.data>(
      page,
      "PATCH",
      "/api/private/notifications/preferences",
      { attention: { alertsCreateUnread: false }, email: false },
    );
    expect(updated.status).toBe(200);
    expect(updated.payload.data).toMatchObject({
      attention: { alertsCreateUnread: false },
      email: false,
      inApp: true,
      webPush: false,
    });

    const persisted = await apiRequest<typeof initial.payload.data>(
      page,
      "GET",
      "/api/private/notifications/preferences",
      undefined,
      "no-store",
    );
    expect(persisted.status).toBe(200);
    expect(persisted.payload.data).toMatchObject({
      attention: { alertsCreateUnread: false },
      email: false,
    });

    const restored = await apiRequest<typeof initial.payload.data>(
      page,
      "PATCH",
      "/api/private/notifications/preferences",
      { attention: { alertsCreateUnread: true }, email: true },
    );
    expect(restored.status).toBe(200);
    expect(restored.payload.data).toMatchObject({
      attention: { alertsCreateUnread: true },
      email: true,
    });
  });

  test("27. collector deduplicates IDs and rejects a non-whitelisted origin", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const siteA = seed.sites.siteA;
    expect(siteA).toBeDefined();

    await signIn(page, "owner-a", ownerAPassword);
    const scriptResponse = await page.request.get(
      `/script.js?siteId=${encodeURIComponent(siteA?.id || "")}`,
    );
    expect(scriptResponse.status()).toBe(200);
    const script = await scriptResponse.text();
    const configMatch = script.match(/runtime_config__"\]\s*=\s*(\{.*?\});/u);
    expect(configMatch?.[1]).toBeTruthy();
    const config = JSON.parse(configMatch?.[1] || "{}") as {
      collectToken?: string;
    };
    expect(config.collectToken).toMatch(/^eyJ/);

    const before = await context.readSiteOverview(page, siteA?.id || "");
    const now = browserNowMs();
    const visitId = `e2e-dedupe-visit-${context.runId}`;
    const common = {
      collectToken: config.collectToken,
      hostname: "127.0.0.1",
      siteId: siteA?.id || "",
      timestamp: now,
      visitorId: `e2e-dedupe-visitor-${context.runId}`,
      visitId,
    };
    const allowedOrigin = new URL(testSiteURL).origin;
    const collect = (payload: Record<string, unknown>, origin?: string) =>
      page.request.post("/collect", {
        data: payload,
        headers: {
          origin: origin || allowedOrigin,
          "content-type": "application/json",
        },
      });

    const firstVisit = await collect({
      ...common,
      kind: "pageview",
      pathname: "/e2e-dedupe",
    });
    expect(firstVisit.status()).toBe(204);
    const duplicateVisit = await collect({
      ...common,
      kind: "pageview",
      pathname: "/e2e-dedupe",
    });
    expect(duplicateVisit.status()).toBe(204);
    await flushSite(page, siteA?.id || "");

    const event = {
      ...common,
      eventData: { source: "e2e" },
      eventId: `e2e-dedupe-event-${context.runId}`,
      eventName: "e2e_idempotent_event",
      kind: "custom_event",
      pathname: "/e2e-dedupe",
    };
    const firstEvent = await collect(event);
    expect(firstEvent.status()).toBe(204);
    const duplicateEvent = await collect(event);
    expect(duplicateEvent.status()).toBe(204);
    await flushSite(page, siteA?.id || "");

    const afterDuplicates = await context.readSiteOverview(
      page,
      siteA?.id || "",
    );
    expect(afterDuplicates.views).toBe(before.views + 1);
    const eventTypes = await apiRequest<
      Array<{ label: string; views: number }>
    >(
      page,
      "GET",
      context.siteQueryPath(siteA?.id || "", "event-types"),
      undefined,
      "no-store",
    );
    expect(eventTypes.status).toBe(200);
    expect(eventTypes.payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "e2e_idempotent_event", views: 1 }),
      ]),
    );

    const blocked = await collect(
      {
        ...common,
        kind: "pageview",
        pathname: "/e2e-blocked-origin",
        timestamp: now + 1,
        visitId: `${visitId}-blocked`,
      },
      "https://blocked.example.test",
    );
    expect(blocked.status()).toBe(204);
    await flushSite(page, siteA?.id || "");
    expect(await context.readSiteOverview(page, siteA?.id || "")).toEqual(
      afterDuplicates,
    );
  });

  test("28. public sharing exposes analytics but enforces privacy policy", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const siteA = seed.sites.siteA;
    expect(siteA).toBeDefined();

    await signIn(page, "owner-a", ownerAPassword);
    const privateOverview = await context.readSiteOverview(
      page,
      siteA?.id || "",
    );
    const enabled = await apiRequest<{
      id: string;
      publicEnabled: boolean;
      publicSlug: string;
    }>(page, "PATCH", "/api/private/admin/sites", {
      publicEnabled: true,
      publicSlug: "e2e-public-analytics",
      siteId: siteA?.id || "",
    });
    expect(enabled.status).toBe(200);
    expect(enabled.payload.data).toMatchObject({
      id: siteA?.id,
      publicEnabled: true,
      publicSlug: "e2e-public-analytics",
    });

    await page.context().clearCookies();
    const query = `from=0&to=${browserNowMs()}`;
    const publicOverview = await apiRequest<{ views: number }>(
      page,
      "GET",
      `/api/public/share/e2e-public-analytics/overview?${query}`,
      undefined,
      "no-store",
    );
    expect(publicOverview.status).toBe(200);
    expect(publicOverview.payload.data).toMatchObject({
      views: privateOverview.views,
    });

    const publicPages = await apiRequest<
      Array<{ pathname: string; views: number }>
    >(
      page,
      "GET",
      `/api/public/share/e2e-public-analytics/pages?${query}`,
      undefined,
      "no-store",
    );
    expect(publicPages.status).toBe(200);
    expect(publicPages.payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pathname: "/", views: 1 }),
        expect.objectContaining({ pathname: "/product", views: 1 }),
      ]),
    );

    const hiddenFilter = await apiRequest<unknown>(
      page,
      "GET",
      `/api/public/share/e2e-public-analytics/overview?${query}&query=secret`,
      undefined,
      "no-store",
    );
    expect(hiddenFilter.status).toBe(404);

    const hiddenDimension = await apiRequest<unknown>(
      page,
      "GET",
      `/api/public/share/e2e-public-analytics/client-cross-breakdown?${query}&primaryDimension=page.query&secondaryDimension=device.type`,
      undefined,
      "no-store",
    );
    expect(hiddenDimension.status).toBe(404);

    await signIn(page, "owner-a", ownerAPassword);
    const disabled = await apiRequest<{
      publicEnabled: boolean;
      publicSlug: string;
    }>(page, "PATCH", "/api/private/admin/sites", {
      publicEnabled: false,
      siteId: siteA?.id || "",
    });
    expect(disabled.status).toBe(200);
    expect(disabled.payload.data).toMatchObject({
      publicEnabled: false,
      publicSlug: "",
    });
    await page.context().clearCookies();
    const unavailable = await apiRequest<unknown>(
      page,
      "GET",
      `/api/public/share/e2e-public-analytics/overview?${query}`,
      undefined,
      "no-store",
    );
    expect(unavailable.status).toBe(404);
  });

  test("29. team dashboard aggregates sites and enforces site scope", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const teamA = seed.teams.teamA;
    const siteA = seed.sites.siteA;
    const siteB = seed.sites.siteB;
    const historyFromMs = seed.history?.siteB?.fromMs;
    expect(teamA).toBeDefined();
    expect(siteA).toBeDefined();
    expect(siteB).toBeDefined();
    expect(historyFromMs).toEqual(expect.any(Number));

    const dashboardPath = `/api/private/team-dashboard?teamId=${encodeURIComponent(teamA?.id || "")}&from=${historyFromMs}&to=${browserNowMs()}&interval=day&timeZone=UTC`;

    await signIn(page, "owner-a", ownerAPassword);
    const ownerDashboard = await apiRequest<TeamDashboard>(
      page,
      "GET",
      dashboardPath,
      undefined,
      "no-store",
    );
    expect(ownerDashboard.status).toBe(200);
    expect(
      ownerDashboard.payload.data?.sites.map((site) => site.id).sort(),
    ).toEqual([siteA?.id, siteB?.id].sort());
    expect(ownerDashboard.payload.data?.sites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: siteA?.id,
          overview: expect.objectContaining({ views: expect.any(Number) }),
        }),
        expect.objectContaining({
          id: siteB?.id,
          overview: expect.objectContaining({ views: 120 }),
        }),
      ]),
    );
    expect(ownerDashboard.payload.data?.trend).toEqual(expect.any(Array));

    const oversizedDashboard = await apiRequest<unknown>(
      page,
      "GET",
      `/api/private/team-dashboard?teamId=${encodeURIComponent(teamA?.id || "")}&from=0&to=${browserNowMs()}&interval=day&timeZone=UTC`,
      undefined,
      "no-store",
    );
    expect(oversizedDashboard.status).toBe(422);
    expect(oversizedDashboard.payload).toMatchObject({
      ok: false,
      error: { code: "too_many_buckets" },
    });

    await signIn(page, "restricted-a", restrictedAPassword);
    const restrictedDashboard = await apiRequest<TeamDashboard>(
      page,
      "GET",
      dashboardPath,
      undefined,
      "no-store",
    );
    expect(restrictedDashboard.status).toBe(200);
    expect(
      restrictedDashboard.payload.data?.sites.map((site) => site.id),
    ).toEqual([siteA?.id]);

    await signIn(page, "outsider", outsiderPassword);
    const deniedDashboard = await apiRequest<unknown>(
      page,
      "GET",
      dashboardPath,
      undefined,
      "no-store",
    );
    expect(deniedDashboard.status).toBe(404);
  });

  test("30. saved filters preserve ownership, visibility, and update/delete rules", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const siteA = seed.sites.siteA;
    const memberA = seed.users.memberA;
    expect(siteA).toBeDefined();
    expect(memberA).toBeDefined();

    const filterPath = `/api/private/saved-filters?siteId=${encodeURIComponent(siteA?.id || "")}`;
    const filterItemPath = (filterId: string) =>
      `/api/private/saved-filters/${encodeURIComponent(filterId)}?siteId=${encodeURIComponent(siteA?.id || "")}`;
    const teamFilterInput = {
      description: "Shared E2E filter",
      filterDsl: 'page.path eq "/e2e-saved-filter"',
      name: "E2E shared filter",
      visibility: "team",
    };
    const privateFilterInput = {
      description: "Private E2E filter",
      filterDsl: 'geo.country eq "CN"',
      name: "E2E private filter",
      visibility: "private",
    };

    await signIn(page, "owner-a", ownerAPassword);
    const createdTeam = await apiRequest<{ filter: SavedFilter }>(
      page,
      "POST",
      filterPath,
      teamFilterInput,
    );
    expect(createdTeam.status).toBe(201);
    expect(createdTeam.payload.filter).toMatchObject({
      filterDsl: teamFilterInput.filterDsl,
      isOwner: true,
      name: teamFilterInput.name,
      visibility: "team",
    });
    const teamFilterId = createdTeam.payload.filter?.id || "";

    const duplicate = await apiRequest<unknown>(
      page,
      "POST",
      filterPath,
      teamFilterInput,
    );
    expect(duplicate.status).toBe(400);
    expect(JSON.stringify(duplicate.payload)).toContain(
      "duplicate_saved_filter_dsl",
    );

    const createdPrivate = await apiRequest<{ filter: SavedFilter }>(
      page,
      "POST",
      filterPath,
      privateFilterInput,
    );
    expect(createdPrivate.status).toBe(201);
    const privateFilterId = createdPrivate.payload.filter?.id || "";

    await signIn(page, "member-a", memberAPassword);
    const memberList = await apiRequest<{ filters: SavedFilter[] }>(
      page,
      "GET",
      filterPath,
      undefined,
      "no-store",
    );
    expect(memberList.status).toBe(200);
    expect(memberList.payload.filters).toEqual([
      expect.objectContaining({ id: teamFilterId, isOwner: false }),
    ]);

    const sharedDetail = await apiRequest<{ filter: SavedFilter }>(
      page,
      "GET",
      filterItemPath(teamFilterId),
      undefined,
      "no-store",
    );
    expect(sharedDetail.status).toBe(200);
    expect(sharedDetail.payload.filter).toMatchObject({
      id: teamFilterId,
      isOwner: false,
    });
    const hiddenPrivate = await apiRequest<unknown>(
      page,
      "GET",
      filterItemPath(privateFilterId),
      undefined,
      "no-store",
    );
    expect(hiddenPrivate.status).toBe(404);

    const memberUpdate = await apiRequest<unknown>(
      page,
      "PUT",
      filterItemPath(teamFilterId),
      teamFilterInput,
    );
    expect(memberUpdate.status).toBe(403);

    await signIn(page, "owner-a", ownerAPassword);
    const updated = await apiRequest<{ filter: SavedFilter }>(
      page,
      "PUT",
      filterItemPath(teamFilterId),
      {
        ...teamFilterInput,
        description: "Updated shared E2E filter",
        filterDsl: 'page.path eq "/e2e-saved-filter-updated"',
        name: "E2E updated shared filter",
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.payload.filter).toMatchObject({
      description: "Updated shared E2E filter",
      filterDsl: 'page.path eq "/e2e-saved-filter-updated"',
      name: "E2E updated shared filter",
    });

    for (const filterId of [teamFilterId, privateFilterId]) {
      const deleted = await apiRequest<{ deletedId: string }>(
        page,
        "DELETE",
        filterItemPath(filterId),
      );
      expect(deleted.status).toBe(200);
      expect(deleted.payload.deletedId).toBe(filterId);
    }
  });

  test("31. V1 analytics read endpoints return typed data for a scoped key", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const siteA = seed.sites.siteA;
    const analyticsKey = seed.apiKeys.analyticsRead?.secret;
    expect(siteA).toBeDefined();
    expect(analyticsKey).toBeTruthy();

    await signIn(page, "owner-a", ownerAPassword);
    const fromMs =
      seed.history?.siteB?.fromMs ?? browserNowMs() - 120 * 24 * 60 * 60 * 1000;
    const timeRange = absoluteTimeRange(fromMs, browserNowMs());
    const base = `/api/v1/sites/${encodeURIComponent(siteA?.id || "")}/analytics`;
    const requests: Array<{
      body: Record<string, unknown>;
      name: string;
      path: string;
    }> = [
      {
        body: { timeRange, interval: "day" },
        name: "timeseries",
        path: "timeseries",
      },
      {
        body: { timeRange, limit: 10 },
        name: "breakdown",
        path: "breakdowns/page.path",
      },
      {
        body: {
          primaryDimension: "page.path",
          primaryLimit: 5,
          secondaryDimension: "client.browser",
          secondaryLimit: 5,
          timeRange,
        },
        name: "cross-breakdowns",
        path: "cross-breakdowns",
      },
      { body: { timeRange, limit: 10 }, name: "pages", path: "pages" },
      { body: { timeRange, limit: 10 }, name: "referrers", path: "referrers" },
      { body: { timeRange, limit: 10 }, name: "channels", path: "channels" },
      {
        body: { field: "page.path", timeRange },
        name: "filter-values",
        path: "filter-values",
      },
      {
        body: { granularity: "day", timeRange },
        name: "retention",
        path: "retention/cohorts",
      },
      {
        body: { timeRange },
        name: "performance-summary",
        path: "performance/summary",
      },
      {
        body: { interval: "day", timeRange },
        name: "performance-timeseries",
        path: "performance/timeseries",
      },
      { body: { timeRange }, name: "events-summary", path: "events/summary" },
      {
        body: { timeRange, interval: "day" },
        name: "events-timeseries",
        path: "events/timeseries",
      },
      { body: { timeRange }, name: "event-types", path: "event-types" },
    ];

    const schema = await apiV1Request<{
      dimensions: unknown[];
      operations: unknown[];
    }>(page, "GET", `${base}/schema`, analyticsKey || "");
    expect(schema.status).toBe(200);
    expect(schema.payload.data?.dimensions).toEqual(expect.any(Array));
    expect(schema.payload.data?.operations).toEqual(expect.any(Array));

    for (const request of requests) {
      const response = await apiV1Request<unknown>(
        page,
        "POST",
        `${base}/${request.path}`,
        analyticsKey || "",
        request.body,
      );
      expect(response.status, request.name).toBe(200);
      expect(response.payload.data, request.name).toBeDefined();
      expect(response.payload.meta, request.name).toBeDefined();
    }

    const unsupportedDimension = await apiV1Request<unknown>(
      page,
      "POST",
      `${base}/cross-breakdowns`,
      analyticsKey || "",
      {
        primaryDimension: "page.path",
        secondaryDimension: "device.type",
        timeRange,
      },
    );
    expect(unsupportedDimension.status).toBe(422);
    expect(unsupportedDimension.payload).toMatchObject({
      error: { code: "dimension_not_supported" },
    });
  });
}
