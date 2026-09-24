import { describe, expect, it } from "vitest";

import {
  CUSTOM_EVENT_DATA_MAX_ARRAY_LENGTH,
  CUSTOM_EVENT_DATA_MAX_DEPTH,
  CUSTOM_EVENT_DATA_MAX_JSON_LENGTH,
  CUSTOM_EVENT_DATA_MAX_KEY_LENGTH,
  CUSTOM_EVENT_DATA_MAX_NODES,
  CUSTOM_EVENT_DATA_MAX_STRING_LENGTH,
  CUSTOM_EVENT_DATA_MAX_VALUES,
  CUSTOM_EVENT_JSON_TYPE,
  expandCustomEventData,
  expandCustomEventDataJson,
  hashCustomEventStringValue,
} from "@/lib/edge/ingest/custom-event-json";
describe("custom event JSON expansion", () => {
  it("hashes strings deterministically", () => {
    expect(hashCustomEventStringValue("hello")).toMatch(/^[0-9a-f]{16}$/);
    expect(hashCustomEventStringValue("hello")).toBe(
      hashCustomEventStringValue("hello"),
    );
    expect(hashCustomEventStringValue("hello")).not.toBe(
      hashCustomEventStringValue("world"),
    );
  });

  it("expands nested JSON objects into nodes, values, keys, and pointer paths", () => {
    const result = expandCustomEventData({
      user: { role: "admin", active: true },
      items: [{ sku: "A/1", qty: 2 }],
      empty: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.json).toBe(
      '{"user":{"role":"admin","active":true},"items":[{"sku":"A/1","qty":2}],"empty":null}',
    );
    expect(result.data.keys).toEqual([
      "active",
      "empty",
      "items",
      "qty",
      "role",
      "sku",
      "user",
    ]);
    expect(result.data.paths).toEqual([
      "/",
      "/empty",
      "/items",
      "/items/*",
      "/items/*/qty",
      "/items/*/sku",
      "/user",
      "/user/active",
      "/user/role",
    ]);
    expect(
      result.data.nodes.find((node) => node.path === "/items/*"),
    ).toMatchObject({
      parentNodeId: 5,
      arrayIndex: 0,
      depth: 2,
    });
    expect(result.data.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/user/role",
          valueType: CUSTOM_EVENT_JSON_TYPE.string,
          stringValue: "admin",
          numberValue: null,
          booleanValue: null,
        }),
        expect.objectContaining({
          path: "/user/active",
          valueType: CUSTOM_EVENT_JSON_TYPE.boolean,
          booleanValue: 1,
        }),
        expect.objectContaining({
          path: "/items/*/qty",
          valueType: CUSTOM_EVENT_JSON_TYPE.number,
          numberValue: 2,
        }),
        expect.objectContaining({
          path: "/empty",
          valueType: CUSTOM_EVENT_JSON_TYPE.null,
        }),
      ]),
    );
  });

  it("escapes JSON pointer path segments", () => {
    const result = expandCustomEventData({ "a/b": { "~key": "value" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.paths).toContain("/a~1b/~0key");
  });

  it("parses JSON strings before expansion", () => {
    const result = expandCustomEventDataJson('{"count":3}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.values[0]).toMatchObject({
      path: "/count",
      numberValue: 3,
    });
  });

  it("rejects invalid or unsupported top-level event data", () => {
    expect(expandCustomEventDataJson("{bad")).toEqual({
      ok: false,
      status: 422,
      error: "eventData must be valid JSON",
    });
    expect(expandCustomEventData(null)).toEqual({
      ok: false,
      status: 422,
      error: "eventData must be a JSON object",
    });
    expect(expandCustomEventData(["not", "object"])).toEqual({
      ok: false,
      status: 422,
      error: "eventData must be a JSON object",
    });
    expect(expandCustomEventData({ bad: undefined })).toEqual({
      ok: false,
      status: 422,
      error: "eventData contains unsupported JSON value",
    });
  });

  it("rejects circular and oversized JSON payloads", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(expandCustomEventData(circular)).toEqual({
      ok: false,
      status: 422,
      error: "eventData must be JSON serializable",
    });
    expect(
      expandCustomEventData({
        value: "x".repeat(CUSTOM_EVENT_DATA_MAX_JSON_LENGTH),
      }),
    ).toEqual({
      ok: false,
      status: 413,
      error: "eventData is too large",
    });
  });

  it("rejects deeply nested, too-wide, and unsupported scalar values", () => {
    let deep: Record<string, unknown> = { leaf: "ok" };
    for (let index = 0; index < CUSTOM_EVENT_DATA_MAX_DEPTH + 1; index += 1) {
      deep = { nested: deep };
    }
    expect(expandCustomEventData(deep)).toMatchObject({
      ok: false,
      status: 422,
      error: "eventData is too deeply nested",
    });

    expect(
      expandCustomEventData({
        items: Array.from(
          { length: CUSTOM_EVENT_DATA_MAX_ARRAY_LENGTH + 1 },
          () => 1,
        ),
      }),
    ).toMatchObject({
      ok: false,
      error: "eventData array is too long",
    });

    expect(
      expandCustomEventData({
        ["x".repeat(CUSTOM_EVENT_DATA_MAX_KEY_LENGTH + 1)]: "value",
      }),
    ).toMatchObject({
      ok: false,
      error: "eventData key is too long",
    });

    expect(
      expandCustomEventData({
        value: "x".repeat(CUSTOM_EVENT_DATA_MAX_STRING_LENGTH + 1),
      }),
    ).toMatchObject({
      ok: false,
      error: "eventData string value is too long",
    });

    expect(expandCustomEventData({ value: Number.NaN })).toMatchObject({
      ok: false,
      error: "eventData number value is not supported",
    });
    expect(
      expandCustomEventData({ value: Number.MAX_SAFE_INTEGER + 1 }),
    ).toMatchObject({
      ok: false,
      error: "eventData number value is not supported",
    });
  });

  it("rejects payloads with too many scalar values or nodes", () => {
    expect(
      expandCustomEventData(
        Object.fromEntries(
          Array.from(
            { length: CUSTOM_EVENT_DATA_MAX_VALUES + 1 },
            (_, index) => [`k${index}`, index],
          ),
        ),
      ),
    ).toMatchObject({
      ok: false,
      error: "eventData has too many scalar values",
    });

    expect(
      expandCustomEventData({
        ...Object.fromEntries(
          Array.from({ length: CUSTOM_EVENT_DATA_MAX_NODES }, (_, index) => [
            `node${index}`,
            {},
          ]),
        ),
      }),
    ).toMatchObject({
      ok: false,
      error: "eventData has too many nodes",
    });
  });
});
