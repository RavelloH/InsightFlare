import { describe, expect, it } from "vitest";

import {
  buildUtmLink,
  type UtmParameters,
} from "@/components/dashboard/campaigns/utm-link";

const parameters: UtmParameters = {
  source: "newsletter",
  medium: "email",
  campaign: "summer_launch",
  content: "",
  term: "",
};

describe("buildUtmLink", () => {
  it("generates the three required campaign parameters", () => {
    expect(buildUtmLink("https://example.com/landing", parameters)).toEqual({
      url: "https://example.com/landing?utm_source=newsletter&utm_medium=email&utm_campaign=summer_launch",
      error: null,
    });
  });

  it("keeps unrelated repeated parameters and the anchor while replacing duplicate UTM values", () => {
    const result = buildUtmLink(
      "https://example.com/path?tag=a&tag=b&coupon=SAVE%2020&utm_source=old&utm_source=duplicate&utm_campaign=old&utm_content=old&utm_term=old#pricing",
      parameters,
    );
    const url = new URL(result.url!);
    expect(url.pathname).toBe("/path");
    expect(url.hash).toBe("#pricing");
    expect(url.searchParams.getAll("tag")).toEqual(["a", "b"]);
    expect(url.searchParams.get("coupon")).toBe("SAVE 20");
    expect(url.searchParams.getAll("utm_source")).toEqual(["newsletter"]);
    expect(url.searchParams.get("utm_campaign")).toBe("summer_launch");
    expect(url.searchParams.has("utm_content")).toBe(false);
    expect(url.searchParams.has("utm_term")).toBe(false);
  });

  it("trims fields and encodes Unicode and reserved characters exactly once", () => {
    const input = {
      source: " 微信 ",
      medium: " social ",
      campaign: " 夏日 & 优惠=20% ",
      content: " button + banner#top ",
      term: " 流量/分析? ",
    };
    const result = buildUtmLink(" https://example.com/ ", input);
    const url = new URL(result.url!);
    for (const key of Object.keys(input) as (keyof UtmParameters)[]) {
      expect(url.searchParams.get(`utm_${key}`)).toBe(input[key].trim());
    }
  });

  it.each([
    "",
    "example.com",
    "/relative",
    "https://",
    "not a url",
    "javascript:alert(1)",
    "mailto:test@example.com",
    "ftp://example.com",
    "https://user@example.com",
    "https://user:pass@example.com",
  ])("rejects unsupported destination %s", (destination) => {
    expect(buildUtmLink(destination, parameters)).toEqual({
      url: null,
      error: "url",
    });
  });

  it.each(["source", "medium", "campaign"] as const)(
    "requires a nonempty %s",
    (key) => {
      expect(
        buildUtmLink("https://example.com", { ...parameters, [key]: "  " }),
      ).toEqual({ url: null, error: "required" });
    },
  );

  it("accepts HTTP links with a port and omits whitespace-only optional fields", () => {
    expect(
      buildUtmLink("http://localhost:8080/path", {
        ...parameters,
        content: " ",
        term: "\t",
      }).url,
    ).toBe(
      "http://localhost:8080/path?utm_source=newsletter&utm_medium=email&utm_campaign=summer_launch",
    );
  });
});
