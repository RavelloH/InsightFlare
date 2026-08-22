import { describe, expect, it } from "vitest";

import {
  buildDomainDiscoveryFilterDsl,
  buildDomainDiscoverySqlPredicate,
  buildTrafficChannelSqlExpression,
  buildUtmMediumSqlPredicate,
  classifyTrafficChannel,
} from "@/lib/analytics/traffic-channel-rules";

describe("traffic channel rules", () => {
  it("keeps discovery domains and the all-UTM-empty policy in the DSL", () => {
    const dsl = buildDomainDiscoveryFilterDsl("organic_search");

    expect(dsl).toContain('referrer.domain eq "google.com"');
    expect(dsl).toContain('referrer.domain endsWith ".google.com"');
    expect(dsl).toContain("utm.source notExists OR utm.source isEmpty");
    expect(dsl).toContain("utm.medium notExists OR utm.medium isEmpty");
    expect(dsl).toContain("utm.campaign notExists OR utm.campaign isEmpty");
  });

  it("builds a domain-safe SQL discovery predicate", () => {
    const sql = buildDomainDiscoverySqlPredicate("social");

    expect(sql).toContain("LOWER(TRIM(COALESCE(referrer_host, '')))");
    expect(sql).toContain("LIKE LOWER('%.facebook.com')");
    expect(sql).toContain("utm_source");
    expect(sql).toContain("utm_medium");
    expect(sql).toContain("utm_campaign");
  });

  it("uses the shared UTM medium map for paid traffic", () => {
    expect(buildUtmMediumSqlPredicate("paid_search")).toContain("'cpc'");
    expect(buildUtmMediumSqlPredicate("paid_social")).toContain(
      "'paid_social'",
    );
  });

  it("supports qualified columns for derived channel filters", () => {
    const sql = buildTrafficChannelSqlExpression({
      referrerHost: "vs.referrer_host",
      utmSource: "vs.utm_source",
      utmMedium: "vs.utm_medium",
      utmCampaign: "vs.utm_campaign",
    });

    expect(sql).toContain("vs.referrer_host");
    expect(sql).toContain("vs.utm_source");
    expect(sql).toContain("vs.utm_medium");
    expect(sql).toContain("vs.utm_campaign");
    expect(sql).toContain("THEN 'organic_search'");
    expect(sql).toContain("THEN 'other'");
  });

  it("classifies discovery, tagged, referral, and direct visits", () => {
    expect(classifyTrafficChannel({ referrerHost: "www.google.com" })).toBe(
      "organic_search",
    );
    expect(classifyTrafficChannel({ referrerHost: "l.facebook.com" })).toBe(
      "social",
    );
    expect(classifyTrafficChannel({ utmMedium: "cpc" })).toBe("paid_search");
    expect(classifyTrafficChannel({ utmMedium: "unknown" })).toBe("other");
    expect(classifyTrafficChannel({ referrerHost: "example.com" })).toBe(
      "referral",
    );
    expect(classifyTrafficChannel({})).toBe("direct");
  });
});
