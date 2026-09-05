import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchEventTypeFields,
  fetchEventTypeFieldValues,
  fetchFunnels,
  fetchPages,
} from "@/lib/dashboard/client-core-data";
import { fetchPageCardTabs } from "@/lib/dashboard/client-page-data";
import { fetchReferrers } from "@/lib/dashboard/client-referrer-data";
import { publicDashboardSiteId } from "@/lib/dashboard/client-request";
import {
  fetchEventTypesTab,
  fetchFilterValues,
  fetchOverviewSourceCardTab,
} from "@/lib/dashboard/client-tab-data";
import { normalizePaginatedCollection } from "@/lib/dashboard/client-utils";
import type { TimeWindow } from "@/lib/dashboard/query-state";

describe("paginated dashboard client requests", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }

  function collection<T>(items: T[] = []) {
    return {
      items,
      pagination: {
        limit: Math.max(1, items.length),
        returned: items.length,
        hasMore: false,
        nextCursor: null,
      },
    };
  }

  const window: TimeWindow = {
    preset: "30d",
    from: 100,
    to: 200,
    interval: "day",
    timeZone: "UTC",
  };

  it("remaps paginated pages and referrers requests to public URLs", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, data: collection([{ pathname: "/" }]) }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: collection([{ referrer: "example.com" }]),
        }),
      );
    globalThis.fetch = fetchMock;

    await fetchPages(
      publicDashboardSiteId("team site/one"),
      window,
      undefined,
      { limit: 17, cursor: "page-cursor", signal },
    );
    await fetchReferrers(
      publicDashboardSiteId("team site/one"),
      window,
      undefined,
      { limit: 9, cursor: "referrer-cursor", signal, fullUrl: true },
    );

    const pagesUrl = new URL(
      String(fetchMock.mock.calls[0][0]),
      "https://test.local",
    );
    expect(pagesUrl.pathname).toBe("/api/public/share/team%20site%2Fone/pages");
    expect(pagesUrl.searchParams.get("limit")).toBe("17");
    expect(pagesUrl.searchParams.get("cursor")).toBe("page-cursor");
    expect(pagesUrl.searchParams.get("details")).toBe("1");
    expect(pagesUrl.searchParams.has("siteId")).toBe(false);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      credentials: "omit",
      signal,
    });

    const referrersUrl = new URL(
      String(fetchMock.mock.calls[1][0]),
      "https://test.local",
    );
    expect(referrersUrl.pathname).toBe(
      "/api/public/share/team%20site%2Fone/referrers",
    );
    expect(referrersUrl.searchParams.get("limit")).toBe("9");
    expect(referrersUrl.searchParams.get("cursor")).toBe("referrer-cursor");
    expect(referrersUrl.searchParams.get("fullUrl")).toBe("1");
    expect(referrersUrl.searchParams.has("siteId")).toBe(false);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      credentials: "omit",
      signal,
    });
  });

  it("adds pagination options to event types and field values requests", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: collection() }))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          eventName: "Signup",
          data: collection(),
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          fieldPath: "payload.plan",
          fieldValueType: "string",
          data: collection(),
        }),
      );
    globalThis.fetch = fetchMock;

    await fetchEventTypesTab(
      publicDashboardSiteId("public-dashboard"),
      window,
      undefined,
      { limit: 11, cursor: "event-cursor", signal },
    );
    await fetchEventTypeFields(
      publicDashboardSiteId("public-dashboard"),
      window,
      "Signup",
      undefined,
      { limit: 13, cursor: "field-cursor", signal },
    );
    await fetchEventTypeFieldValues(
      publicDashboardSiteId("public-dashboard"),
      window,
      "Signup",
      "payload.plan",
      "string",
      undefined,
      { limit: 7, cursor: "value-cursor", signal },
    );

    expect(
      new URL(String(fetchMock.mock.calls[0][0]), "https://test.local"),
    ).toMatchObject({
      pathname: "/api/public/share/public-dashboard/event-types",
    });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      signal,
      credentials: "omit",
    });
    expect(
      new URL(
        String(fetchMock.mock.calls[0][0]),
        "https://test.local",
      ).searchParams.get("limit"),
    ).toBe("11");
    expect(
      new URL(
        String(fetchMock.mock.calls[0][0]),
        "https://test.local",
      ).searchParams.get("cursor"),
    ).toBe("event-cursor");

    const fieldsUrl = new URL(
      String(fetchMock.mock.calls[1][0]),
      "https://test.local",
    );
    expect(fieldsUrl.pathname).toBe(
      "/api/public/share/public-dashboard/event-type-fields",
    );
    expect(fieldsUrl.searchParams.get("eventName")).toBe("Signup");
    expect(fieldsUrl.searchParams.get("limit")).toBe("13");
    expect(fieldsUrl.searchParams.get("cursor")).toBe("field-cursor");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      signal,
      credentials: "omit",
    });

    const valuesUrl = new URL(
      String(fetchMock.mock.calls[2][0]),
      "https://test.local",
    );
    expect(valuesUrl.pathname).toBe(
      "/api/public/share/public-dashboard/event-type-field-values",
    );
    expect(valuesUrl.searchParams.get("eventName")).toBe("Signup");
    expect(valuesUrl.searchParams.get("fieldPath")).toBe("payload.plan");
    expect(valuesUrl.searchParams.get("limit")).toBe("7");
    expect(valuesUrl.searchParams.get("cursor")).toBe("value-cursor");
    expect(fetchMock.mock.calls[2][1]).toMatchObject({
      signal,
      credentials: "omit",
    });
  });

  it("uses paginated filter values and funnel list responses", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: collection() }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: collection() }));
    globalThis.fetch = fetchMock;

    await fetchFilterValues(
      publicDashboardSiteId("filters"),
      window,
      "geo.country",
      undefined,
      { limit: 5, cursor: "filter-cursor", signal, search: "uni" },
    );
    await fetchFunnels(publicDashboardSiteId("funnels"), {
      limit: 23,
      cursor: "funnel-cursor",
      signal,
    });

    const filterUrl = new URL(
      String(fetchMock.mock.calls[0][0]),
      "https://test.local",
    );
    expect(filterUrl.pathname).toBe("/api/public/share/filters/filter-values");
    expect(filterUrl.searchParams.get("filterKey")).toBe("geo.country");
    expect(filterUrl.searchParams.get("search")).toBe("uni");
    expect(filterUrl.searchParams.get("limit")).toBe("5");
    expect(filterUrl.searchParams.get("cursor")).toBe("filter-cursor");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      signal,
      credentials: "omit",
    });

    const funnelUrl = new URL(
      String(fetchMock.mock.calls[1][0]),
      "https://test.local",
    );
    expect(funnelUrl.pathname).toBe("/api/public/share/funnels/funnels");
    expect(funnelUrl.searchParams.get("limit")).toBe("23");
    expect(funnelUrl.searchParams.get("cursor")).toBe("funnel-cursor");
    expect(funnelUrl.searchParams.has("siteId")).toBe(false);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      signal,
      credentials: "omit",
    });
  });

  it("rejects legacy array collections at the pagination boundary", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: [{ label: "google.com", views: 4, sessions: 2, visitors: 1 }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: [{ value: "US", label: "US" }],
        }),
      );
    globalThis.fetch = fetchMock;

    await expect(
      fetchOverviewSourceCardTab("site-1", window, "domain"),
    ).rejects.toThrow("pagination_contract_violation");
  });

  it("rejects every malformed canonical collection shape", () => {
    expect(() =>
      normalizePaginatedCollection({ items: [], pagination: null }),
    ).toThrow("pagination_contract_violation");
    expect(() =>
      normalizePaginatedCollection({
        items: [],
        pagination: {
          limit: 1,
          returned: 0,
          hasMore: false,
          nextCursor: null,
          extra: true,
        },
      }),
    ).toThrow("pagination_contract_violation");
    expect(() =>
      normalizePaginatedCollection({
        items: [],
        pagination: {
          limit: 0,
          returned: 0,
          hasMore: false,
          nextCursor: null,
        },
      }),
    ).toThrow("pagination_contract_violation");
    expect(() => normalizePaginatedCollection([])).toThrow(
      "pagination_contract_violation",
    );
    expect(() =>
      normalizePaginatedCollection({ items: "not-an-array", pagination: {} }),
    ).toThrow("pagination_contract_violation");
  });

  it("passes pagination options through page card tab requests", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: collection(),
        tabs: {
          path: [],
          title: [],
          hostname: [],
          entry: [],
          exit: [],
        },
      }),
    );
    globalThis.fetch = fetchMock;

    await fetchPageCardTabs(
      publicDashboardSiteId("page-tabs"),
      window,
      undefined,
      { limit: 19, cursor: "tabs-cursor", signal },
    );

    const url = new URL(
      String(fetchMock.mock.calls[0][0]),
      "https://test.local",
    );
    expect(url.pathname).toBe("/api/public/share/page-tabs/pages");
    expect(url.searchParams.get("limit")).toBe("19");
    expect(url.searchParams.get("cursor")).toBe("tabs-cursor");
    expect(url.searchParams.has("siteId")).toBe(false);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      signal,
      credentials: "omit",
    });
  });
});
