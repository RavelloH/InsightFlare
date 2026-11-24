import { describe, expect, it } from "vitest";

import {
  interpret,
  splitPrefix,
} from "@/components/dashboard/search/interpret";

const uuid = "0b6f1c2e-1111-4222-8333-944445555666";

describe("search query interpretation", () => {
  it("offers page and event lookups for plain text outside data pages", () => {
    expect(interpret("sign", "overview").lookups).toEqual([
      { kind: "page", value: "sign" },
      { kind: "event", value: "sign" },
    ]);
    expect(interpret("sign", "events").lookups).toEqual([
      { kind: "event", value: "sign" },
    ]);
  });

  it("recognises paths, domains, own-site URLs and ids", () => {
    expect(interpret("/docs", "overview")).toMatchObject({
      focused: true,
      lookups: [{ kind: "page", value: "/docs" }],
    });
    expect(interpret("Google.com.", "overview").lookups).toEqual([
      { kind: "referrer", value: "google.com" },
    ]);
    expect(
      interpret("https://a.example/pricing", "overview", "a.example").lookups,
    ).toEqual([{ kind: "page", value: "/pricing" }]);
    expect(interpret(uuid.toUpperCase(), "overview").lookups).toEqual([
      { kind: "id", value: uuid },
    ]);
    expect(interpret("a".repeat(64), "overview").lookups).toEqual([
      { kind: "session", value: "a".repeat(64) },
    ]);
  });

  it("applies the type filter unless the text names its own type", () => {
    expect(interpret(uuid, "overview", undefined, "visitor")).toMatchObject({
      prefix: "visitor",
      lookups: [{ kind: "visitor", value: uuid }],
    });
    expect(
      interpret("google", "overview", undefined, "referrer").lookups,
    ).toEqual([{ kind: "referrer", value: "google" }]);
    expect(interpret("page:/x", "overview", undefined, "event")).toMatchObject({
      prefix: "page",
      lookups: [{ kind: "page", value: "/x" }],
    });
    expect(interpret("", "overview", undefined, "event")).toMatchObject({
      prefix: "event",
      lookups: [],
      error: undefined,
    });
  });

  it("rejects values the lookup endpoints would refuse", () => {
    expect(interpret("page:", "overview").error).toBe("enterValue");
    expect(interpret("page:/a?b=1", "overview").error).toBe("invalid");
    expect(interpret("referrer:not a domain", "overview").error).toBe(
      "invalid",
    );
    expect(interpret("event:" + "a".repeat(513), "overview").error).toBe(
      "invalid",
    );
  });

  it("splits only known prefixes", () => {
    expect(splitPrefix("visitor: abc")).toEqual({
      prefix: "visitor",
      rest: "abc",
    });
    expect(splitPrefix("https://x.dev")).toEqual({ rest: "https://x.dev" });
  });
});
