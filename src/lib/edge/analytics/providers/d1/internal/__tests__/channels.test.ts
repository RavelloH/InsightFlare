import { describe, expect, it, vi } from "vitest";

import {
  buildDomainDiscoverySqlPredicate,
  buildTrafficChannelSqlExpression,
  buildUtmMediumSqlPredicate,
} from "@/lib/analytics/traffic-channel-rules";
import { queryChannelsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/channels";

describe("channel aggregate query", () => {
  it("classifies discovery before tagged and referral traffic using shared SQL", () => {
    const sql = buildTrafficChannelSqlExpression();
    const organic = buildDomainDiscoverySqlPredicate("organic_search");
    const social = buildDomainDiscoverySqlPredicate("social");
    const paidSearch = buildUtmMediumSqlPredicate("paid_search");

    expect(sql.indexOf(organic)).toBeGreaterThanOrEqual(0);
    expect(sql.indexOf(social)).toBeGreaterThan(sql.indexOf(organic));
    expect(sql.indexOf(paidSearch)).toBeGreaterThan(sql.indexOf(social));
    expect(sql).toContain("THEN 'campaign'");
    expect(sql).toContain("THEN 'referral'");
    expect(sql).toContain("THEN 'direct'");
  });

  it("executes one typed report query and preserves the channel DTO", async () => {
    const all = vi.fn().mockResolvedValue({
      results: [
        { channel: "organic_search", views: 5, sessions: 3, visitors: 2 },
      ],
      meta: {},
    });
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));
    const env = { DB: { prepare } } as never;

    await expect(
      queryChannelsFromD1(
        env,
        "site-1",
        { startMs: 10, endExclusiveMs: 20, nowMs: 20, timeZone: "UTC" },
        { version: 1, root: null },
        20,
      ),
    ).resolves.toEqual([
      { channel: "organic_search", views: 5, sessions: 3, visitors: 2 },
    ]);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledTimes(1);
    const sql = String((prepare.mock.calls as unknown[][])[0]?.[0]);
    expect(sql).toContain("visits");
    expect(sql).toContain("session_id");
    expect(sql).toContain("visitor_id");
    expect(sql).toContain("ORDER BY");
  });
});
