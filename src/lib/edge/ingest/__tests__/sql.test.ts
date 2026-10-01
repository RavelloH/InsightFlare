import { describe, expect, it } from "vitest";

import type { VisitBindingRow } from "@/lib/edge/ingest/sql";
import {
  CREATE_BUFFERED_CUSTOM_EVENTS_SQL,
  VISIT_D1_COLUMNS,
  visitBindings,
} from "@/lib/edge/ingest/sql";
function visitRow(overrides: Partial<VisitBindingRow> = {}): VisitBindingRow {
  return {
    visitId: "visit-1",
    siteId: "site-1",
    visitorId: "visitor-1",
    sessionId: "session-1",
    status: "closed",
    startedAt: 1,
    lastActivityAt: 2,
    endedAt: 3,
    finalizedAt: 4,
    durationMs: 5,
    durationSource: "client",
    exitReason: "leave",
    pathname: "/docs",
    queryString: "ref=home",
    hashFragment: "#intro",
    hostname: "example.com",
    title: "Docs",
    referrerUrl: "https://ref.example/start",
    referrerHost: "ref.example",
    utmSource: "newsletter",
    utmMedium: "email",
    utmCampaign: "launch",
    utmTerm: "term",
    utmContent: "hero",
    isEU: 0,
    country: "US",
    region: "California",
    regionCode: "CA",
    city: "San Francisco",
    continent: "NA",
    latitude: 37.7,
    longitude: -122.4,
    postalCode: "94105",
    metroCode: "807",
    timezone: "America/Los_Angeles",
    asOrganization: "Example ISP",
    uaRaw: "Mozilla/5.0",
    browser: "Chrome",
    browserVersion: "120",
    os: "macOS",
    osVersion: "14",
    deviceType: "desktop",
    screenWidth: 1440,
    screenHeight: 900,
    language: "en-US",
    userId: "user-1",
    userName: "Ada",
    perfTtfbMs: 12.3,
    perfFcpMs: 45.6,
    perfLcpMs: 78.9,
    perfCls: 0.123,
    perfInpMs: 111,
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}
describe("ingest visit SQL bindings", () => {
  it("keeps visit binding order aligned with D1 columns", () => {
    const row = visitRow();
    const bindings = visitBindings(row);

    expect(bindings).toHaveLength(VISIT_D1_COLUMNS.length);
    expect(
      Object.fromEntries(
        VISIT_D1_COLUMNS.map((column, index) => [column, bindings[index]]),
      ),
    ).toMatchObject({
      visit_id: "visit-1",
      site_id: "site-1",
      status: "closed",
      started_at: 1,
      duration_source: "client",
      exit_reason: "leave",
      pathname: "/docs",
      query_string: "ref=home",
      perf_ttfb_ms: 12.3,
      perf_fcp_ms: 45.6,
      perf_lcp_ms: 78.9,
      perf_cls: 0.123,
      perf_inp_ms: 111,
      ae_synced_at: null,
      created_at: 10,
      updated_at: 20,
    });
  });

  it("stores blank optional strings as null for D1 visit rows", () => {
    const values = Object.fromEntries(
      VISIT_D1_COLUMNS.map((column, index) => [
        column,
        visitBindings(
          visitRow({
            durationSource: "",
            exitReason: "",
            userId: "",
            userName: "",
          }),
        )[index],
      ]),
    );

    expect(values.duration_source).toBeNull();
    expect(values.exit_reason).toBeNull();
    expect(values.user_id).toBeNull();
    expect(values.user_name).toBeNull();
  });

  it("defines buffered custom event schema fields used by flush bookkeeping", () => {
    expect(CREATE_BUFFERED_CUSTOM_EVENTS_SQL).toContain("user_id TEXT");
    expect(CREATE_BUFFERED_CUSTOM_EVENTS_SQL).toContain("dirty INTEGER");
    expect(CREATE_BUFFERED_CUSTOM_EVENTS_SQL).toContain(
      "flush_attempts INTEGER",
    );
    expect(CREATE_BUFFERED_CUSTOM_EVENTS_SQL).toContain(
      "last_flush_error TEXT",
    );
  });
});
