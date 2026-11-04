import { describe, expect, it } from "vitest";

import {
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  type QueryContext,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { sessionListQualificationConfigurationFromQuery } from "@/lib/edge/analytics/providers/d1/internal/session-list-qualification-request";
import { visitorListQualificationConfigurationFromQuery } from "@/lib/edge/analytics/providers/d1/internal/visitor-list-qualification-request";

const SITE_ID = "list-qualification-audience";
const TIME = createQueryTime(0, 1_000, "UTC", 1_000);

type ListOperation = "visitors" | "sessions" | "visitor-sessions";

function queryFor(
  operation: ListOperation,
  context: QueryContext,
  extra: Record<string, unknown> = {},
): QueryInput & Record<string, unknown> {
  const prepared = prepareScopedQuery(operation, {
    context,
    time: TIME,
    filters: EMPTY_FILTER_DOCUMENT,
    scopePreference: operation === "visitors" ? "visitor" : "session",
  } as QueryInput & { readonly time: QueryTime });
  const sortKey = context.policy.audience === "api-v1" ? "field" : "key";
  const sort =
    operation === "visitors"
      ? { [sortKey]: "lastSeenAt", direction: "desc" }
      : { [sortKey]: "startedAt", direction: "desc" };
  const apiV1RouteFields =
    context.policy.audience === "api-v1"
      ? {
          filter: { type: "dsl", expression: "count(page) gte 1" },
          timeRange: {
            kind: "absolute",
            from: new Date(0).toISOString(),
            to: new Date(1_000).toISOString(),
            timeZone: "UTC",
          },
          scope: operation === "visitors" ? "visitor" : "session",
          siteId: SITE_ID,
          startMs: 0,
          endExclusiveMs: 1_000,
          timeZone: "UTC",
        }
      : {};
  return {
    ...prepared,
    ...(operation === "visitor-sessions" ? {} : { sort }),
    ...apiV1RouteFields,
    ...extra,
  } as QueryInput & Record<string, unknown>;
}

function siteQuery(
  operation: ListOperation,
  audience: "api-v1" | "private-dashboard" | "public-share",
  extra: Record<string, unknown> = {},
) {
  return queryFor(operation, siteQueryContext(SITE_ID, audience), extra);
}

describe("visitor list qualification audience", () => {
  it("preserves the actual supported site audience", () => {
    expect(
      visitorListQualificationConfigurationFromQuery(
        siteQuery("visitors", "api-v1"),
      )?.audience,
    ).toBe("api-v1");
    expect(
      visitorListQualificationConfigurationFromQuery(
        siteQuery("visitors", "private-dashboard"),
      )?.audience,
    ).toBe("private-dashboard");
  });

  it("rejects API v1 analysis contexts while retaining private Goal requests", () => {
    const goal = { type: "goal", goalId: "goal-1" };
    expect(
      visitorListQualificationConfigurationFromQuery(
        siteQuery("visitors", "api-v1", { analysisContext: goal }),
      ),
    ).toBeUndefined();
    expect(
      visitorListQualificationConfigurationFromQuery(
        siteQuery("visitors", "api-v1", { analysisContext: undefined }),
      ),
    ).toBeUndefined();
    expect(
      visitorListQualificationConfigurationFromQuery(
        siteQuery("visitors", "private-dashboard", {
          analysisContext: goal,
        }),
      )?.analysisContext,
    ).toEqual(goal);
  });

  it("does not qualify public-share or team subjects", () => {
    expect(
      visitorListQualificationConfigurationFromQuery(
        siteQuery("visitors", "public-share"),
      ),
    ).toBeUndefined();
    expect(
      visitorListQualificationConfigurationFromQuery(
        queryFor(
          "visitors",
          teamQueryContext("team-1", "private-dashboard", [SITE_ID]),
        ),
      ),
    ).toBeUndefined();
  });

  it("requires the API route site, range, and scope to match the canonical query", () => {
    const query = siteQuery("visitors", "api-v1");
    expect(
      visitorListQualificationConfigurationFromQuery({
        ...query,
        siteId: "another-site",
      }),
    ).toBeUndefined();
    expect(
      visitorListQualificationConfigurationFromQuery({
        ...query,
        startMs: 1,
      }),
    ).toBeUndefined();
    expect(
      visitorListQualificationConfigurationFromQuery({
        ...query,
        scope: "session",
      }),
    ).toBeUndefined();
  });
});

describe("session list qualification audience", () => {
  it("accepts API v1 only for ordinary Sessions search", () => {
    expect(
      sessionListQualificationConfigurationFromQuery(
        siteQuery("sessions", "api-v1"),
        "sessions",
      )?.audience,
    ).toBe("api-v1");
    expect(
      sessionListQualificationConfigurationFromQuery(
        siteQuery("sessions", "api-v1", {
          analysisContext: { type: "goal", goalId: "goal-1" },
        }),
        "sessions",
      ),
    ).toBeUndefined();
    expect(
      sessionListQualificationConfigurationFromQuery(
        siteQuery("visitor-sessions", "api-v1", {
          visitorId: "visitor-1",
        }),
        "visitor-sessions",
      ),
    ).toBeUndefined();
  });

  it("preserves private Goal Sessions and Visitor Sessions requests", () => {
    const goal = { type: "goal", goalId: "goal-1" };
    expect(
      sessionListQualificationConfigurationFromQuery(
        siteQuery("sessions", "private-dashboard", {
          analysisContext: goal,
        }),
        "sessions",
      )?.analysisContext,
    ).toEqual(goal);
    const visitorSessions = sessionListQualificationConfigurationFromQuery(
      siteQuery("visitor-sessions", "private-dashboard", {
        visitorId: "visitor-1",
      }),
      "visitor-sessions",
    );
    expect(visitorSessions?.audience).toBe("private-dashboard");
    expect(visitorSessions?.visitorId).toBe("visitor-1");
  });

  it("does not qualify public-share or team subjects", () => {
    expect(
      sessionListQualificationConfigurationFromQuery(
        siteQuery("sessions", "public-share"),
        "sessions",
      ),
    ).toBeUndefined();
    expect(
      sessionListQualificationConfigurationFromQuery(
        queryFor(
          "sessions",
          teamQueryContext("team-1", "private-dashboard", [SITE_ID]),
        ),
        "sessions",
      ),
    ).toBeUndefined();
  });

  it("requires the API route site, range, and scope to match the canonical query", () => {
    const query = siteQuery("sessions", "api-v1");
    expect(
      sessionListQualificationConfigurationFromQuery(
        { ...query, siteId: "another-site" },
        "sessions",
      ),
    ).toBeUndefined();
    expect(
      sessionListQualificationConfigurationFromQuery(
        { ...query, endExclusiveMs: 999 },
        "sessions",
      ),
    ).toBeUndefined();
    expect(
      sessionListQualificationConfigurationFromQuery(
        { ...query, scope: "visitor" },
        "sessions",
      ),
    ).toBeUndefined();
  });
});
