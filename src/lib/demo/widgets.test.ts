// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  generateDemoWidgetData,
  handleDemoWidgetApi,
  readDemoWidget,
} from "./widgets";

const teamId = "demo-team-001";
const endpoint = `https://demo.test/api/private/widgets/teams/${teamId}`;
const fixtureUuid = "11111111-1111-4111-8111-111111111111";
const createUuid = "ab7f92ce-43f1-4289-b42d-1001e4092388";

function send(
  path: string,
  method = "GET",
  data?: unknown,
  origin = "https://demo.test",
) {
  return handleDemoWidgetApi(
    new Request(path, {
      method,
      headers: { origin, "content-type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    }),
  );
}

describe("demo widgets runtime", () => {
  it("lists sample widgets without requiring D1 or KV", async () => {
    const response = await send(endpoint);
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      ok: boolean;
      data: { uuid: string }[];
      nextCursor: null;
    };
    expect(result.ok).toBe(true);
    expect(result.data.map((record) => record.uuid)).toContain(fixtureUuid);
    expect(result.nextCursor).toBeNull();
    expect((await send(endpoint.replace(teamId, "other-team"))).status).toBe(
      404,
    );
  });

  it("supplies each preview shape from synthetic aggregates", async () => {
    const record = readDemoWidget(fixtureUuid)!;
    for (const type of [
      "metric",
      "trend",
      "ranking",
      "distribution",
      "geo",
    ] as const) {
      const config = { ...record.draft, type };
      const response = await send(`${endpoint}/preview`, "POST", {
        siteId: record.siteId,
        config,
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        data: ReturnType<typeof generateDemoWidgetData>;
      };
      expect(result.data.type).toBe(type);
      expect(result.data.metric).toBe(config.metric);
      if (result.data.type === "ranking")
        expect(result.data.rows).toHaveLength(5);
      if (result.data.type === "trend")
        expect(result.data.points).toHaveLength(7);
      if (result.data.type === "geo") {
        expect(result.data.points.length).toBeGreaterThan(10);
        expect(result.data.points.some((point) => point.country === "SG")).toBe(
          true,
        );
        expect(result.data.unmapped).toBe(0);
      }
    }
  });

  it("supports P1/P2 mock values and public data shapes", async () => {
    const record = readDemoWidget(fixtureUuid)!;
    const examples = [
      { type: "ranking", rankingStyle: "bars" },
      { type: "metric", metric: "bounceRate" },
      { type: "distribution", distributionDimension: "client.deviceType" },
      { type: "trend", trendMetrics: ["visitors", "views", "sessions"] },
      { type: "conversion", conversionKind: "event", eventName: "sign_up" },
      {
        type: "conversion",
        conversionKind: "goal",
        goalId: "demo-goal-signup",
      },
    ] as const;
    for (const extra of examples) {
      const config = { ...record.draft, ...extra };
      const response = await send(`${endpoint}/preview`, "POST", {
        siteId: record.siteId,
        config,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: ReturnType<typeof generateDemoWidgetData>;
      };
      expect(body.data.type).toBe(config.type);
      if (body.data.type === "distribution") {
        expect(body.data.rows.length).toBeGreaterThan(0);
        expect(body.data.rows[0]?.percent).toBeGreaterThan(0);
      }
      if (body.data.type === "trend" && config.type === "trend") {
        expect(body.data.series).toHaveLength(3);
      }
      if (body.data.type === "conversion") {
        expect(body.data.points).toHaveLength(7);
        expect(body.data.value).toBeGreaterThan(0);
        if (body.data.kind === "goal")
          expect(body.data.rate).toBeGreaterThan(0);
      }
    }
  });

  it("rejects cross-origin mutations and invalid team/site", async () => {
    const record = readDemoWidget(fixtureUuid)!;
    const input = {
      uuid: createUuid,
      siteId: record.siteId,
      config: record.draft,
    };
    expect(
      (await send(endpoint, "POST", input, "https://other.test")).status,
    ).toBe(403);
    expect(
      (await send(endpoint, "POST", { ...input, siteId: "another-site" }))
        .status,
    ).toBe(400);
  });

  it("creates, updates, publishes, unpublishes and deletes demo-only widgets", async () => {
    const fixture = readDemoWidget(fixtureUuid)!;
    const input = {
      uuid: createUuid,
      siteId: fixture.siteId,
      config: fixture.draft,
    };
    const created = await send(endpoint, "POST", input);
    expect(created.status).toBe(201);
    expect(readDemoWidget(createUuid)?.status).toBe("draft");
    const edited = { ...fixture.draft, title: "Demo edited widget" };
    expect(
      (await send(`${endpoint}/${createUuid}`, "PUT", { config: edited }))
        .status,
    ).toBe(200);
    expect(readDemoWidget(createUuid)?.draft.title).toBe("Demo edited widget");
    expect(
      (
        await send(`${endpoint}/${createUuid}/publish`, "POST", {
          config: edited,
        })
      ).status,
    ).toBe(200);
    expect(readDemoWidget(createUuid)?.status).toBe("published");
    expect(readDemoWidget(createUuid)?.published?.title).toBe(
      "Demo edited widget",
    );
    expect(
      (await send(`${endpoint}/${createUuid}/unpublish`, "POST", {})).status,
    ).toBe(200);
    expect(readDemoWidget(createUuid)?.status).toBe("unpublished");
    expect((await send(`${endpoint}/${createUuid}`, "DELETE")).status).toBe(
      204,
    );
    expect(readDemoWidget(createUuid)).toBeNull();
  });
});

describe("demo widget coverage for every supported visual variant", () => {
  const base = readDemoWidget(fixtureUuid)!.draft;
  const siteId = readDemoWidget(fixtureUuid)!.siteId;

  it.each([
    ["badge", 0, 0, 0],
    ["trend", 30, 0, 0],
    ["map", 0, 8, 0],
    ["pages", 0, 0, 5],
  ] as const)(
    "creates %s realtime fixture aggregates with bounded content",
    (realtimeLayout, bars, points, rows) => {
      const data = generateDemoWidgetData(siteId, {
        ...base,
        type: "realtime",
        metric: "visitors",
        realtimeLayout,
      });
      expect(data.type).toBe("realtime");
      if (data.type !== "realtime") throw new Error("wrong type");
      expect(data.activeNow).toBeGreaterThan(30);
      expect(data.bars).toHaveLength(bars);
      expect(data.points).toHaveLength(points);
      expect(data.rows).toHaveLength(rows);
      expect(data).not.toHaveProperty("visitorId");
    },
  );

  it.each([
    ["bounceRate", 0.38],
    ["avgDurationMs", 71500],
    ["viewsPerSession", 2.45],
  ] as const)("provides normalized synthetic %s values", (metric, value) => {
    expect(
      generateDemoWidgetData(siteId, {
        ...base,
        type: "metric",
        metric,
      }),
    ).toMatchObject({ type: "metric", value });
  });

  it("honors 30-day windows and comparison opt-out", () => {
    const data = generateDemoWidgetData(siteId, {
      ...base,
      type: "trend",
      metric: "sessions",
      range: "30d",
    });
    expect(data.type).toBe("trend");
    if (data.type !== "trend") throw new Error("wrong type");
    expect(data.points).toHaveLength(30);
    expect(data.series).toBeUndefined();
    expect(
      generateDemoWidgetData(siteId, {
        ...base,
        type: "metric",
        metric: "views",
        comparison: false,
      }),
    ).toMatchObject({ change: null });
  });

  it.each([
    ["page.path", "/"],
    ["source.domain", "google.com"],
    ["geo.country", "US"],
  ] as const)(
    "keeps ranked %s preview labels consistent with the real aggregator",
    (dimension, expected) => {
      const data = generateDemoWidgetData(siteId, {
        ...base,
        type: "ranking",
        dimension,
      });
      expect(data.type).toBe("ranking");
      if (data.type !== "ranking") throw new Error("wrong type");
      expect(data.rows[0]?.label).toBe(expected);
    },
  );

  it.each([
    ["client.deviceType", "Desktop"],
    ["client.browser", "Chrome"],
    ["utm.source", "google"],
    ["source.domain", "google.com"],
  ] as const)(
    "generates %s synthetic distributions with complete normalized percentages",
    (distributionDimension, expected) => {
      const data = generateDemoWidgetData(siteId, {
        ...base,
        type: "distribution",
        distributionDimension,
        limit: 5,
      });
      expect(data.type).toBe("distribution");
      if (data.type !== "distribution") throw new Error("wrong type");
      expect(data.rows[0]?.label).toBe(expected);
      const total = data.rows.reduce((sum, row) => sum + row.percent, 0);
      expect(total).toBeCloseTo(1);
    },
  );

  it.each(["event", "goal"] as const)(
    "produces %s conversion previews without individual session records",
    (conversionKind) => {
      const data = generateDemoWidgetData(siteId, {
        ...base,
        type: "conversion",
        conversionKind,
        eventName: "signup",
        goalId: "demo-goal-signup",
      });
      expect(data).toMatchObject({
        type: "conversion",
        kind: conversionKind,
        rate: conversionKind === "goal" ? 0.2 : null,
      });
      if (data.type !== "conversion") throw new Error("wrong type");
      expect(data.points).toHaveLength(7);
    },
  );
});

describe("demo Widget HTTP route validation", () => {
  it("rejects malformed paths and unsupported methods", async () => {
    expect((await send(endpoint + "/not-a-uuid", "DELETE")).status).toBe(404);
    expect((await send(endpoint + "/unexpected/path", "POST", {})).status).toBe(
      404,
    );
    expect((await send(endpoint, "PATCH")).status).toBe(404);
    expect(
      (await send(endpoint + "/" + fixtureUuid + "/preview", "POST", {}))
        .status,
    ).toBe(404);
  });

  it.each([
    {
      description: "no UUID",
      data: {
        siteId: readDemoWidget(fixtureUuid)!.siteId,
        config: readDemoWidget(fixtureUuid)!.draft,
      },
    },
    {
      description: "invalid config",
      data: {
        uuid: createUuid,
        siteId: readDemoWidget(fixtureUuid)!.siteId,
        config: {},
      },
    },
    {
      description: "non-boolean publish",
      data: {
        uuid: createUuid,
        siteId: readDemoWidget(fixtureUuid)!.siteId,
        config: readDemoWidget(fixtureUuid)!.draft,
        publish: "yes",
      },
    },
  ])("refuses demo creation with $description", async ({ data }) => {
    expect((await send(endpoint, "POST", data)).status).toBe(400);
  });

  it("rejects malformed preview and untrusted site before synthesizing data", async () => {
    const siteId = readDemoWidget(fixtureUuid)!.siteId;
    expect(
      (await send(endpoint + "/preview", "POST", { siteId, config: {} }))
        .status,
    ).toBe(400);
    expect(
      (
        await send(endpoint + "/preview", "POST", {
          siteId: "foreign-site",
          config: readDemoWidget(fixtureUuid)!.draft,
        })
      ).status,
    ).toBe(400);
    expect((await send(endpoint + "/preview", "POST", [1, 2])).status).toBe(
      400,
    );
  });

  it("rejects editing or publishing with invalid configuration while preserving existing publication", async () => {
    const current = readDemoWidget(fixtureUuid)!;
    const invalid = { config: { invalid: true } };
    expect(
      (await send(endpoint + "/" + fixtureUuid, "PUT", invalid)).status,
    ).toBe(400);
    expect(
      (await send(endpoint + "/" + fixtureUuid + "/publish", "POST", invalid))
        .status,
    ).toBe(400);
    expect(readDemoWidget(fixtureUuid)?.revision).toBe(current.revision);
  });

  it("supports retrying an existing creation token without resetting published data", async () => {
    const item = readDemoWidget(fixtureUuid)!;
    const id = "baa596b0-af33-41d7-82c4-a8126b528e82";
    const input = {
      uuid: id,
      siteId: item.siteId,
      config: item.draft,
      publish: true,
    };
    const first = await send(endpoint, "POST", input);
    const second = await send(endpoint, "POST", { ...input, publish: false });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(readDemoWidget(id)?.status).toBe("published");
    expect((await send(endpoint + "/" + id, "DELETE")).status).toBe(204);
    expect((await send(endpoint + "/" + id, "DELETE")).status).toBe(404);
  });
});
