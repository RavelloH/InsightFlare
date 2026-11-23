// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { generateDemoWidgetData } from "./widgets";
import { handleDemoWidgetApi, readDemoWidget } from "./widgets";

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
