import { describe, expect, it } from "vitest";

import type { Env } from "@/lib/edge/types";
import type { WidgetConfig } from "@/lib/widgets/contract";
import {
  createWidget,
  deleteWidget,
  listTeamWidgets,
  publishWidget,
  readWidget,
  unpublishWidget,
  updateWidgetDraft,
  WidgetConflictError,
  WidgetStorageUnavailableError,
} from "@/lib/widgets/store";

class MemoryKv {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(
    options: { prefix?: string; cursor?: string; limit?: number } = {},
  ) {
    const prefix = options.prefix ?? "";
    const names = [...this.values.keys()].filter((key) =>
      key.startsWith(prefix),
    );
    const offset = Number(options.cursor ?? 0);
    const limit = options.limit ?? 1000;
    const keys = names.slice(offset, offset + limit).map((name) => ({ name }));
    const nextOffset = offset + keys.length;
    const listComplete = nextOffset >= names.length;
    return {
      keys,
      list_complete: listComplete,
      cursor: listComplete ? undefined : String(nextOffset),
    };
  }
}

const uuid = "aef8f0db-ccdd-468f-bd9c-344339264cae";
const config: WidgetConfig = {
  title: "Visitors",
  type: "metric",
  metric: "visitors",
  range: "30d",
  timeZone: "UTC",
  locale: "en",
  theme: "auto",
  embedMode: "restricted",
  allowedOrigins: ["https://example.com"],
  comparison: true,
  dimension: "page.path",
  limit: 5,
  rankingStyle: "list",
  pageLinksEnabled: false,
  distributionStyle: "bars",
  trendStyle: "line",
  distributionDimension: "client.deviceType",
  trendMetrics: [],
  conversionKind: "event",
  eventName: "",
  goalId: "",
  geoProjection: "flat",
  realtimeLayout: "badge",
};

function environment(kv = new MemoryKv()): { env: Env; kv: MemoryKv } {
  return {
    env: { SITE_SETTINGS_KV: kv as unknown as KVNamespace } as Env,
    kv,
  };
}

describe("widget KV store", () => {
  it("stores versioned JSON under stable keys and makes creation retry-safe", async () => {
    const { env, kv } = environment();

    const created = await createWidget(env, {
      uuid,
      teamId: "team-a",
      siteId: "site-a",
      config,
    });
    const retried = await createWidget(env, {
      uuid,
      teamId: "team-a",
      siteId: "site-a",
      config: { ...config, title: "Retry must preserve the stored draft" },
    });

    expect(created.schemaVersion).toBe(1);
    expect(created.uuid).not.toBe(uuid);
    expect(created).toEqual(retried);
    expect([...kv.values.keys()]).toEqual([
      `widget:team:team-a:${created.uuid}`,
      `widget:${created.uuid}`,
    ]);
    expect(await readWidget(env, created.uuid)).toEqual(created);
  });

  it("scopes a retry token to its team and site", async () => {
    const { env } = environment();
    const first = await createWidget(env, {
      uuid,
      teamId: "team-a",
      siteId: "site-a",
      config,
    });
    const second = await createWidget(env, {
      uuid,
      teamId: "team-b",
      siteId: "site-b",
      config,
    });

    expect(second.uuid).not.toBe(first.uuid);
    expect(second.teamId).toBe("team-b");
  });

  it("can create a published widget in one write after confirmation", async () => {
    const { env } = environment();
    const created = await createWidget(env, {
      uuid,
      teamId: "team-a",
      siteId: "site-a",
      config,
      publish: true,
    });

    expect(created.status).toBe("published");
    expect(created.published).toEqual(config);
    expect(created.revision).toBe(1);
  });

  it("keeps the published configuration and revision stable while editing a draft", async () => {
    const { env } = environment();
    const created = await createWidget(env, {
      uuid,
      teamId: "team-a",
      siteId: "site-a",
      config,
    });
    const firstPublication = await publishWidget(env, "team-a", created.uuid);
    const revisedDraft = await updateWidgetDraft(env, "team-a", created.uuid, {
      ...config,
      type: "trend",
      title: "Visitors trend",
    });

    expect(firstPublication?.revision).toBeGreaterThan(0);
    expect(revisedDraft?.revision).toBe(firstPublication?.revision);
    expect(revisedDraft?.published).toEqual(config);
    expect(revisedDraft?.draft.type).toBe("trend");

    const secondPublication = await publishWidget(env, "team-a", created.uuid);
    expect(secondPublication?.revision).toBeGreaterThan(
      firstPublication?.revision ?? 0,
    );
    expect(secondPublication?.published?.type).toBe("trend");
    expect(secondPublication?.status).toBe("published");
  });

  it("keeps published data while unpublishing and advances its public revision", async () => {
    const { env } = environment();
    const created = await createWidget(env, {
      uuid,
      teamId: "team-a",
      siteId: "site-a",
      config,
    });
    const published = await publishWidget(env, "team-a", created.uuid);

    const unpublished = await unpublishWidget(env, "team-a", created.uuid);

    expect(unpublished?.status).toBe("unpublished");
    expect(unpublished?.published).toEqual(config);
    expect(unpublished?.revision).toBeGreaterThan(published?.revision ?? 0);
    expect(await unpublishWidget(env, "team-a", created.uuid)).toEqual(
      unpublished,
    );
  });

  it("publishes a submitted unsaved config in one record update", async () => {
    const { env } = environment();
    const created = await createWidget(env, {
      uuid,
      teamId: "team-a",
      siteId: "site-a",
      config,
    });
    const newConfig = { ...config, title: "New title" };

    const published = await publishWidget(
      env,
      "team-a",
      created.uuid,
      newConfig,
    );

    expect(published?.draft).toEqual(newConfig);
    expect(published?.published).toEqual(newConfig);
  });

  it("omits incomplete or cross-team indexes from paged team listings", async () => {
    const { env, kv } = environment();
    const created = await createWidget(env, {
      uuid,
      teamId: "team-a",
      siteId: "site-a",
      config,
    });
    const otherUuid = "00a93487-55d0-469d-8d96-e2d0e1860c72";
    await kv.put(`widget:team:team-a:${otherUuid}`, otherUuid);
    await kv.put(
      `widget:${otherUuid}`,
      JSON.stringify({ schemaVersion: 1, uuid: otherUuid, teamId: "team-b" }),
    );

    const listed = await listTeamWidgets(env, "team-a");

    expect(listed.data.map((record) => record.uuid)).toEqual([created.uuid]);
    expect(listed.nextCursor).toBeNull();
  });

  it("removes both records and allows retries to clean an orphaned index", async () => {
    const { env, kv } = environment();
    const created = await createWidget(env, {
      uuid,
      teamId: "team-a",
      siteId: "site-a",
      config,
    });

    expect(await deleteWidget(env, "team-a", created.uuid)).toBe(true);
    expect(await readWidget(env, created.uuid)).toBeNull();
    expect(kv.values.has(`widget:team:team-a:${created.uuid}`)).toBe(false);
    expect(await deleteWidget(env, "team-a", created.uuid)).toBe(false);
  });

  it("cleans only the caller's index when the primary record is not visible", async () => {
    const kv = new MemoryKv();
    const { env } = environment(kv);
    const primaryKey = `widget:${uuid}`;
    await kv.put(primaryKey, "belongs to a different team");
    await kv.put(`widget:team:team-a:${uuid}`, uuid);
    const currentGet = kv.get.bind(kv);
    kv.get = async (key: string) =>
      key === primaryKey ? null : currentGet(key);

    expect(await deleteWidget(env, "team-a", uuid)).toBe(false);
    expect(kv.values.has(primaryKey)).toBe(true);
    expect(kv.values.has(`widget:team:team-a:${uuid}`)).toBe(false);
  });
});

describe("widget storage failure isolation and pagination", () => {
  it("fails closed when KV binding is unavailable", async () => {
    const noKv = {} as Env;
    await expect(readWidget(noKv, uuid)).rejects.toBeInstanceOf(
      WidgetStorageUnavailableError,
    );
    await expect(listTeamWidgets(noKv, "team-a")).rejects.toBeInstanceOf(
      WidgetStorageUnavailableError,
    );
  });

  it("does not contact KV when the supplied widget ID is invalid", async () => {
    expect(await readWidget({} as Env, "not-a-uuid")).toBeNull();
    expect(await deleteWidget({} as Env, "team-a", "not-a-uuid")).toBe(false);
  });

  it("hides malformed JSON and malformed persisted records from public readers", async () => {
    const { kv, env } = environment();
    await kv.put(`widget:${uuid}`, "{bad-json");
    expect(await readWidget(env, uuid)).toBeNull();
    await kv.put(`widget:${uuid}`, JSON.stringify({ title: "invalid schema" }));
    expect(await readWidget(env, uuid)).toBeNull();
  });

  it("rejects a deterministic retry token if its existing record belongs to another team", async () => {
    const { env, kv } = environment();
    const created = await createWidget(env, {
      uuid,
      teamId: "team-a",
      siteId: "site-a",
      config,
    });
    await kv.put(
      `widget:${created.uuid}`,
      JSON.stringify({
        ...created,
        teamId: "team-b",
      }),
    );
    await expect(
      createWidget(env, {
        uuid,
        teamId: "team-a",
        siteId: "site-a",
        config,
      }),
    ).rejects.toBeInstanceOf(WidgetConflictError);
  });

  it("does not overwrite or unpublish another team's record", async () => {
    const { env, kv } = environment();
    const created = await createWidget(env, {
      uuid,
      teamId: "team-a",
      siteId: "site-a",
      config,
      publish: true,
    });
    expect(
      await updateWidgetDraft(env, "team-b", created.uuid, {
        ...config,
        title: "STOLEN",
      }),
    ).toBeNull();
    expect(await publishWidget(env, "team-b", created.uuid)).toBeNull();
    expect(await unpublishWidget(env, "team-b", created.uuid)).toBeNull();
    expect(kv.values.get(`widget:${created.uuid}`)).toContain(
      '"title":"Visitors"',
    );
  });

  it("never deletes an existing widget through the wrong team's index", async () => {
    const { env, kv } = environment();
    const created = await createWidget(env, {
      uuid,
      teamId: "team-a",
      siteId: "site-a",
      config,
    });
    await expect(
      deleteWidget(env, "team-b", created.uuid),
    ).rejects.toBeInstanceOf(WidgetConflictError);
    expect(kv.values.has(`widget:${created.uuid}`)).toBe(true);
  });

  it("supports opaque cursor pagination and filters orphaned and invalid indexes", async () => {
    const { env, kv } = environment();
    const created = await createWidget(env, {
      uuid,
      teamId: "team-a",
      siteId: "site-a",
      config,
    });
    await kv.put("widget:team:team-a:bad-uuid", "bad-uuid");
    await kv.put(
      "widget:team:team-a:aef8f0db-ccdd-468f-bd9c-344339264caf",
      "orphan",
    );
    const first = await listTeamWidgets(env, "team-a", "0");
    expect(first.data).toEqual([created]);
    expect(first.nextCursor).toBeNull();
    // Exercise the paginated KV contract with a non-complete first page.
    for (let i = 0; i < 105; i++) {
      await kv.put(`widget:team:team-a:invalid-${i}`, "orphan");
    }
    const firstPage = await listTeamWidgets(env, "team-a");
    expect(firstPage.nextCursor).toBeTruthy();
    const next = await listTeamWidgets(env, "team-a", firstPage.nextCursor);
    expect(next.data).toEqual([]);
    expect(next.nextCursor).toBeNull();
  });

  it("preserves invalid indexes of unrelated teams when cleaning retry tokens", async () => {
    const { env, kv } = environment();
    await kv.put(`widget:team:team-b:${uuid}`, uuid);
    expect(await deleteWidget(env, "team-a", uuid)).toBe(false);
    expect(kv.values.has(`widget:team:team-b:${uuid}`)).toBe(true);
  });

  it("does not increase a public revision if the widget was never published", async () => {
    const { env } = environment();
    const created = await createWidget(env, {
      uuid,
      teamId: "team-a",
      siteId: "site-a",
      config,
    });
    expect(await unpublishWidget(env, "team-a", created.uuid)).toEqual(created);
  });
});
