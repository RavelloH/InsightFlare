import { describe, expect, it } from "vitest";

import {
  inspectJsonBudget,
  readBoundedBody,
  readBoundedJson,
  serializedUtf8ByteLength,
  utf8ByteLength,
} from "@/lib/api-v1/application/request-budget";
describe("API v1 request budgets", () => {
  it("measures UTF-8 bytes rather than UTF-16 code units", () => {
    expect(utf8ByteLength("😀")).toBe(4);
    expect(serializedUtf8ByteLength({ value: "😀" })).toBe(
      new TextEncoder().encode('{"value":"😀"}').byteLength,
    );
  });

  it("walks recursive JSON iteratively and rejects depth/node/string limits", () => {
    expect(inspectJsonBudget({ a: { b: 1 } }, { maxDepth: 2 }).ok).toBe(true);
    expect(inspectJsonBudget({ a: { b: 1 } }, { maxDepth: 1 })).toMatchObject({
      ok: false,
      reason: "depth",
    });
    expect(inspectJsonBudget([1, 2], { maxNodes: 2 })).toMatchObject({
      ok: false,
      reason: "nodes",
    });
    expect(
      inspectJsonBudget({ value: "é" }, { maxStringBytes: 1 }),
    ).toMatchObject({
      ok: false,
      reason: "string",
    });
    expect(inspectJsonBudget([1, 2], { maxArrayLength: 1 })).toMatchObject({
      ok: false,
      reason: "array",
    });
  });

  it("caps actual stream bytes even when Content-Length is absent", async () => {
    const request = new Request("https://app.test", {
      method: "POST",
      body: "123456789",
    });
    await expect(readBoundedBody(request, 8)).resolves.toMatchObject({
      ok: false,
      reason: "too_large",
    });
  });

  it("reuses an exact single chunk and copies sliced or multi-chunk buffers", async () => {
    const read = (chunks: Uint8Array[]) =>
      readBoundedBody(
        {
          headers: new Headers(),
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(chunk);
              controller.close();
            },
          }),
        },
        8,
      );
    const whole = new Uint8Array([1, 2, 3]);
    const one = await read([whole]);
    expect(one.ok && one.bytes).toBe(whole);
    const slice = whole.subarray(1);
    const partial = await read([slice]);
    expect(partial).toEqual({ ok: true, bytes: new Uint8Array([2, 3]) });
    expect(partial.ok && partial.bytes.buffer).not.toBe(whole.buffer);
    const many = await read([whole, new Uint8Array([4, 5])]);
    expect(many).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3, 4, 5]) });
  });

  it("uses a declared length as an early upper-bound and handles empty bodies", async () => {
    const declared = {
      headers: new Headers({ "content-length": "100" }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("ok"));
          controller.close();
        },
      }),
    };
    await expect(readBoundedBody(declared, 8)).resolves.toMatchObject({
      ok: false,
      reason: "too_large",
    });
    const malformedLength = {
      headers: new Headers({ "content-length": "not-a-number" }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("ok"));
          controller.close();
        },
      }),
    };
    await expect(readBoundedBody(malformedLength, 8)).resolves.toMatchObject({
      ok: true,
    });
    const empty = new Request("https://app.test", { method: "POST" });
    await expect(readBoundedBody(empty, 8)).resolves.toMatchObject({
      ok: false,
      reason: "empty",
    });
    await expect(
      readBoundedJson(
        new Request("https://app.test", {
          method: "POST",
          body: "not-json",
        }),
      ),
    ).rejects.toThrow("invalid_json");
    await expect(
      readBoundedJson(
        new Request("https://app.test", {
          method: "POST",
          body: "123456789",
        }),
        8,
      ),
    ).rejects.toThrow("body_too_large");
    await expect(
      readBoundedJson(
        new Request("https://app.test", {
          method: "POST",
          body: JSON.stringify(Array.from({ length: 1_001 }, () => 0)),
        }),
      ),
    ).rejects.toThrow("invalid_body");
  });
});
