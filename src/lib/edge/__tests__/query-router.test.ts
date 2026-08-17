import { describe, expect, it } from "vitest";

import {
  applyPublicQueryPolicy,
  DASHBOARD_QUERY_PATHS,
  operationForQueryRoute,
  PUBLIC_QUERY_PATHS,
} from "@/lib/edge/query/router";
import {
  assertOperationAllowed,
  siteQueryContext,
} from "@/lib/edge/query-contract";

describe("query route policy", () => {
  it("exposes only the intended public paths", () => {
    expect(PUBLIC_QUERY_PATHS).toContain("overview");
    expect(PUBLIC_QUERY_PATHS).toContain("filter-options");
    expect(PUBLIC_QUERY_PATHS).not.toContain("page-query");
    expect(PUBLIC_QUERY_PATHS).not.toContain("page-hash");
    expect(PUBLIC_QUERY_PATHS).not.toContain("overview-source-link");
    expect(DASHBOARD_QUERY_PATHS).toContain("event-record-detail");
    expect(DASHBOARD_QUERY_PATHS).toContain("funnels");
  });

  it("maps protocol paths to typed operation capabilities", () => {
    expect(operationForQueryRoute("overview")).toBe("overview");
    expect(operationForQueryRoute("event-type-fields")).toBe("event-fields");
    expect(operationForQueryRoute("session-detail")).toBe("session-detail");
    expect(operationForQueryRoute("browser-radar")).toBe("radar");
    expect(operationForQueryRoute("client-cross-breakdown")).toBe(
      "cross-dimension",
    );
  });

  it("denies public sensitive filters and dimensions before source selection", () => {
    for (const query of [
      "?query=secret",
      "?sourceLink=https%3A%2F%2Fexample.com%2Fsecret",
      "?filterKey=sourceLink",
      "?primaryDimension=page.query",
      "?secondaryDimension=referrer.url",
    ]) {
      expect(
        applyPublicQueryPolicy(new URL(`https://edge.test/share${query}`))
          .allowed,
      ).toBe(false);
    }
  });

  it("removes public detail switches without changing permitted inputs", () => {
    const source = new URL(
      "https://edge.test/share/pages?details=true&fullUrl=true&preset=today",
    );
    const decision = applyPublicQueryPolicy(source);
    expect(decision.allowed).toBe(true);
    expect(decision.url.searchParams.has("details")).toBe(false);
    expect(decision.url.searchParams.has("fullUrl")).toBe(false);
    expect(decision.url.searchParams.get("preset")).toBe("today");
  });

  it("does not grant private-only operations to public contexts", () => {
    const publicContext = siteQueryContext("site-1", "public-share");
    expect(
      assertOperationAllowed(publicContext, "event-record-detail"),
    ).toMatchObject({
      kind: "capability-denied",
    });
    expect(assertOperationAllowed(publicContext, "overview")).toBeNull();
  });
});
