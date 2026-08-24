import { describe, expect, it } from "vitest";

import {
  type QueryOperation,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  handleEventFieldValuesContract,
  handleEventRecordDetailContract,
  handleEventRecordsContract,
  handleEventsSummaryContract,
  handleEventsTrendContract,
  handleEventTypeContextContract,
  handleEventTypeDetailContract,
  handleEventTypeFieldsContract,
  handleEventTypesContract,
} from "@/lib/edge/analytics/providers/d1/internal/events-contract-adapter";
import { handleFilterValuesContract } from "@/lib/edge/analytics/providers/d1/internal/filter-values-contract-adapter";
import { handleFunnelAnalysisContract } from "@/lib/edge/analytics/providers/d1/internal/funnels-contract-adapter";
import {
  handleSessionDetailContract,
  handleSessionsContract,
  handleVisitorDetailContract,
  handleVisitorsContract,
} from "@/lib/edge/analytics/providers/d1/internal/journeys-contract-adapter";
import { handleOverviewGeoPointsContract } from "@/lib/edge/analytics/providers/d1/internal/overview-extras-contract-adapter";
import {
  handlePagesContract,
  handlePagesDashboardContract,
  handleReferrersContract,
} from "@/lib/edge/analytics/providers/d1/internal/pages-contract-adapter";
import {
  handleBrowserVersionBreakdownContract,
  handleClientDimensionTrendContract,
  handleCrossBreakdownContract,
  handleUtmDimensionTrendContract,
} from "@/lib/edge/analytics/providers/d1/internal/technology-contract-adapter";
import type { Env } from "@/lib/edge/types";

function emptyEnv(): Env {
  const statement = {
    bind() {
      return statement;
    },
    all: async () => ({ results: [] }),
    first: async () => null,
  };
  return { DB: { prepare: () => statement } } as unknown as Env;
}

const env = emptyEnv();
const siteId = "site-contract";
const invalidWindow = new URL("https://edge.test/query?from=20&to=10");
const context = undefined;

describe("typed query adapter validation branches", () => {
  it("enters event, journey, and funnel contract adapters before D1", async () => {
    const responses = await Promise.all([
      handleEventTypesContract(env, siteId, invalidWindow, context),
      handleEventsSummaryContract(env, siteId, invalidWindow, context),
      handleEventsTrendContract(env, siteId, invalidWindow, context),
      handleEventRecordsContract(env, siteId, invalidWindow, context),
      handleEventFieldValuesContract(env, siteId, invalidWindow, context),
      handleEventTypeFieldsContract(env, siteId, invalidWindow, context),
      handleEventTypeContextContract(env, siteId, invalidWindow, context),
      handleEventTypeDetailContract(env, siteId, invalidWindow, context),
      handleEventRecordDetailContract(env, siteId, invalidWindow, context),
      handleVisitorsContract(env, siteId, invalidWindow, context),
      handleSessionsContract(env, siteId, invalidWindow, context),
      handleVisitorDetailContract(env, siteId, invalidWindow, context),
      handleSessionDetailContract(env, siteId, invalidWindow, context),
      handleFunnelAnalysisContract(env, siteId, invalidWindow, context),
    ]);

    expect(responses).toHaveLength(14);
    expect(responses.every((response) => response instanceof Response)).toBe(
      true,
    );
    expect(responses.some((response) => response.status === 400)).toBe(true);
  });

  it("executes valid event, journey, and funnel reader branches", async () => {
    const valid = new URL(
      "https://edge.test/query?from=1767225600000&to=1767312000000&eventName=signup&fieldPath=plan&fieldValueType=string&cards=page.path&eventId=event-1&visitorId=visitor-1&sessionId=session-1&pageSize=5",
    );
    const responses = await Promise.all([
      handleEventTypesContract(env, siteId, valid),
      handleEventsSummaryContract(env, siteId, valid),
      handleEventsTrendContract(env, siteId, valid),
      handleEventRecordsContract(env, siteId, valid),
      handleEventFieldValuesContract(env, siteId, valid),
      handleEventTypeFieldsContract(env, siteId, valid),
      handleEventTypeContextContract(env, siteId, valid),
      handleEventTypeDetailContract(env, siteId, valid, undefined, undefined, {
        includeContext: false,
        includeBreakdowns: false,
        includeFields: false,
      }),
      handleEventRecordDetailContract(env, siteId, valid),
      handleVisitorsContract(env, siteId, valid),
      handleSessionsContract(env, siteId, valid),
      handleVisitorDetailContract(env, siteId, valid),
      handleSessionDetailContract(env, siteId, valid),
      handleFunnelAnalysisContract(env, siteId, valid),
    ]);

    expect(responses).toHaveLength(14);
    expect(responses.every((response) => response instanceof Response)).toBe(
      true,
    );
    expect(responses.some((response) => response.status === 200)).toBe(true);
  });

  it("covers typed pagination, detail options, and funnel lookup branches", async () => {
    const base =
      "https://edge.test/query?from=1767225600000&to=1767312000000&eventName=signup&fieldPath=plan&fieldValueType=string&cards=page.path&eventId=event-1&visitorId=visitor-1&sessionId=session-1";
    const responses = await Promise.all([
      handleVisitorsContract(env, siteId, new URL(base)),
      handleSessionsContract(env, siteId, new URL(base)),
      handleVisitorsContract(env, siteId, new URL(`${base}&cursor=invalid`)),
      handleSessionsContract(env, siteId, new URL(`${base}&cursor=invalid`)),
      handleEventTypeContextContract(
        env,
        siteId,
        new URL(`${base}&cards=not-a-card`),
      ),
      handleEventTypeDetailContract(env, siteId, new URL(base)),
      handleFunnelAnalysisContract(env, siteId, new URL(`${base}&id=missing`)),
    ]);

    expect(responses).toHaveLength(7);
    expect(responses.map((response) => response.status)).toEqual(
      expect.arrayContaining([400, 404]),
    );
  });

  it("covers filter, page, and technology contract option branches", async () => {
    const base =
      "https://edge.test/query?from=1767225600000&to=1767312000000&dimension=browser&primaryDimension=browser&secondaryDimension=os";
    const filterKeys = [
      "geo.country",
      "page.path",
      "referrer.url",
      "client.browser",
      "geo.region",
      "geo.continent",
    ];
    const responses = await Promise.all([
      ...filterKeys.map((filterKey) =>
        handleFilterValuesContract(
          env,
          siteId,
          new URL(`${base}&filterKey=${filterKey}`),
        ),
      ),
      handleOverviewGeoPointsContract(env, siteId, new URL(base)),
      handleOverviewGeoPointsContract(
        env,
        siteId,
        new URL(`${base}&applyGeoFilter=true`),
      ),
      handlePagesContract(env, siteId, new URL(`${base}&details=true`), true),
      handlePagesContract(env, siteId, new URL(`${base}&details=true`), false),
      handleReferrersContract(
        env,
        siteId,
        new URL(`${base}&fullUrl=true`),
        20,
        true,
      ),
      handleReferrersContract(
        env,
        siteId,
        new URL(`${base}&fullUrl=true`),
        8,
        false,
      ),
      handlePagesDashboardContract(
        env,
        siteId,
        new URL(`${base}&page=10000&pageSize=24`),
      ),
      handleBrowserVersionBreakdownContract(
        env,
        siteId,
        new URL(`${base}&browserLimit=4&versionLimit=12`),
      ),
      handleClientDimensionTrendContract(env, siteId, new URL(base)),
      handleUtmDimensionTrendContract(
        env,
        siteId,
        new URL(`${base}&dimension=source`),
      ),
      handleCrossBreakdownContract(env, siteId, new URL(base)),
      handleCrossBreakdownContract(
        env,
        siteId,
        new URL(`${base}&primaryDimension=browser&secondaryDimension=browser`),
      ),
    ]);

    expect(responses).toHaveLength(18);
    expect(responses.every((response) => response instanceof Response)).toBe(
      true,
    );
    expect(responses.some((response) => response.status === 400)).toBe(true);
  });

  it("does not expose private canonical fields from public filter-values", async () => {
    const response = await handleFilterValuesContract(
      env,
      siteId,
      new URL(
        "https://edge.test/query?from=1767225600000&to=1767312000000&filterKey=page.query",
      ),
      undefined,
      siteQueryContext(siteId, "public-share"),
    );
    expect(response.status).toBe(400);
  });

  it("validates canonical filter-value requests before returning candidates", async () => {
    const base = "https://edge.test/query?from=1767225600000&to=1767312000000";
    const deniedContext = {
      ...siteQueryContext(siteId, "private-dashboard"),
      policy: {
        ...siteQueryContext(siteId, "private-dashboard").policy,
        allowedOperations: new Set<QueryOperation>(),
      },
    };
    const [missingField, unknownField, invalidWindow, valid, denied] =
      await Promise.all([
        handleFilterValuesContract(env, siteId, new URL(base)),
        handleFilterValuesContract(
          env,
          siteId,
          new URL(`${base}&filterKey=missing.field`),
        ),
        handleFilterValuesContract(
          env,
          siteId,
          new URL("https://edge.test/query?filterKey=page.path&from=20&to=10"),
        ),
        handleFilterValuesContract(
          env,
          siteId,
          new URL(`${base}&filterKey=page.path&search=docs`),
        ),
        handleFilterValuesContract(
          env,
          siteId,
          new URL(`${base}&filterKey=page.path`),
          undefined,
          deniedContext,
        ),
      ]);

    expect(missingField.status).toBe(400);
    expect(unknownField.status).toBe(400);
    expect(invalidWindow.status).toBe(400);
    expect(valid.status).toBe(200);
    expect(denied.status).toBe(400);
  });
});
