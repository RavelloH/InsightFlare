import { describe, expect, it } from "vitest";

import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  queryFilterValuesFromD1,
  queryFilterValuesPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/filter-values";
import type { Env } from "@/lib/edge/types";

const window: QueryWindow = {
  startMs: Date.UTC(2026, 0, 1),
  endExclusiveMs: Date.UTC(2026, 0, 2),
  nowMs: Date.UTC(2026, 0, 3),
  timeZone: "UTC",
};

function envWithRows(): Env {
  const statement = {
    bind() {
      return statement;
    },
    all: async () => ({
      results: [
        {
          value: "/docs",
          referrer: "Google",
          views: 4,
          sessions: 3,
          visitors: 2,
        },
      ],
    }),
  };
  return {
    DB: { prepare: () => statement },
    DAILY_SALT_SECRET: "filter-values-test-secret",
  } as unknown as Env;
}

function envWithDirectReferrer(): Env {
  const statement = {
    bind() {
      return statement;
    },
    all: async () => ({
      results: [
        { value: null, referrer: "", views: null, sessions: 3, visitors: 2 },
        { value: "/exit", referrer: null, views: 2, sessions: 2, visitors: 1 },
      ],
    }),
  };
  return { DB: { prepare: () => statement } } as unknown as Env;
}

function envWithChannelRows(): Env {
  const statement = {
    bind() {
      return statement;
    },
    all: async () => ({
      results: [
        { value: "organic_search", views: 7, sessions: 4, visitors: 3 },
        { value: "social", views: 2, sessions: 2, visitors: 2 },
      ],
    }),
  };
  return { DB: { prepare: () => statement } } as unknown as Env;
}

describe("canonical filter value reader", () => {
  it("routes event, referrer, session, and visit fields through their typed sources", async () => {
    const env = envWithRows();
    const [eventName, referrer, sessionPath, pagePath] = await Promise.all([
      queryFilterValuesFromD1(
        env,
        "site-1",
        window,
        EMPTY_FILTER_DOCUMENT,
        "event.name",
        10,
        "doc",
      ),
      queryFilterValuesFromD1(
        env,
        "site-1",
        window,
        EMPTY_FILTER_DOCUMENT,
        "referrer.domain",
        10,
        "goo",
      ),
      queryFilterValuesFromD1(
        env,
        "site-1",
        window,
        EMPTY_FILTER_DOCUMENT,
        "session.entryPath",
        10,
        "doc",
      ),
      queryFilterValuesFromD1(
        env,
        "site-1",
        window,
        EMPTY_FILTER_DOCUMENT,
        "page.path",
        10,
        "DOC",
      ),
    ]);

    expect(eventName).toEqual([{ value: "/docs", occurrences: 4 }]);
    expect(referrer).toEqual([{ value: "Google", occurrences: 4 }]);
    expect(sessionPath).toEqual([{ value: "/docs", occurrences: 4 }]);
    expect(pagePath).toEqual([{ value: "/docs", occurrences: 4 }]);
  });

  it("rejects dynamic payload and unknown fields from canonical value search", async () => {
    const env = envWithRows();
    await expect(
      queryFilterValuesFromD1(
        env,
        "site-1",
        window,
        EMPTY_FILTER_DOCUMENT,
        "event.payload",
        10,
      ),
    ).resolves.toEqual([]);
    await expect(
      queryFilterValuesFromD1(
        env,
        "site-1",
        window,
        EMPTY_FILTER_DOCUMENT,
        "missing.field",
        10,
      ),
    ).resolves.toEqual([]);
  });

  it("preserves the direct-referrer fallback and filters empty or unmatched candidates", async () => {
    const env = envWithDirectReferrer();
    await expect(
      queryFilterValuesFromD1(
        env,
        "site-1",
        window,
        EMPTY_FILTER_DOCUMENT,
        "referrer.url",
        10,
      ),
    ).resolves.toEqual([
      { value: "__direct__", occurrences: 0 },
      { value: "__direct__", occurrences: 2 },
    ]);
    await expect(
      queryFilterValuesFromD1(
        env,
        "site-1",
        window,
        EMPTY_FILTER_DOCUMENT,
        "page.path",
        10,
      ),
    ).resolves.toEqual([{ value: "/exit", occurrences: 2 }]);
    await expect(
      queryFilterValuesFromD1(
        env,
        "site-1",
        window,
        EMPTY_FILTER_DOCUMENT,
        "session.exitPath",
        10,
        "missing",
      ),
    ).resolves.toEqual([]);
  });

  it("searches values from the derived traffic channel dimension", async () => {
    await expect(
      queryFilterValuesFromD1(
        envWithChannelRows(),
        "site-1",
        window,
        EMPTY_FILTER_DOCUMENT,
        "traffic.channel",
        10,
        "organic",
      ),
    ).resolves.toEqual([{ value: "organic_search", occurrences: 7 }]);
  });

  it("routes paginated candidates through every registered source", async () => {
    const fields = [
      "event.name",
      "referrer.domain",
      "referrer.url",
      "session.entryPath",
      "session.exitPath",
      "traffic.channel",
      "page.path",
    ];
    for (const field of fields) {
      await expect(
        queryFilterValuesPageFromD1(
          envWithRows(),
          "site-1",
          window,
          EMPTY_FILTER_DOCUMENT,
          field,
          10,
          null,
          "doc",
          "public-share",
        ),
      ).resolves.toMatchObject({
        items: expect.any(Array),
        pagination: {
          limit: 10,
          returned: expect.any(Number),
          hasMore: false,
          nextCursor: null,
        },
      });
    }
    await expect(
      queryFilterValuesPageFromD1(
        envWithRows(),
        "site-1",
        window,
        EMPTY_FILTER_DOCUMENT,
        "event.payload",
        10,
      ),
    ).resolves.toMatchObject({
      items: [],
      pagination: { hasMore: false, nextCursor: null },
    });
    await expect(
      queryFilterValuesPageFromD1(
        envWithRows(),
        "site-1",
        window,
        EMPTY_FILTER_DOCUMENT,
        "missing.field",
        10,
      ),
    ).resolves.toMatchObject({ items: [], pagination: { returned: 0 } });
  });

  it("rejects a cursor before querying each paginated candidate source", async () => {
    for (const field of [
      "event.name",
      "referrer.domain",
      "session.entryPath",
      "traffic.channel",
    ]) {
      await expect(
        queryFilterValuesPageFromD1(
          envWithRows(),
          "site-1",
          window,
          EMPTY_FILTER_DOCUMENT,
          field,
          10,
          "invalid-cursor",
        ),
      ).rejects.toThrow("invalid-cursor");
    }
  });
});
