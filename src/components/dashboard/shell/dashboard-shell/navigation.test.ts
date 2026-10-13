import { describe, expect, it } from "vitest";

import { normalizeLocalePath } from "./navigation";

describe("normalizeLocalePath", () => {
  it("strips the Traditional Chinese locale prefix", () => {
    expect(normalizeLocalePath("/zh-tw/app/team/site")).toBe("/app/team/site");
  });

  it("continues to strip existing locale prefixes", () => {
    expect(normalizeLocalePath("/zh/app/team/site")).toBe("/app/team/site");
    expect(normalizeLocalePath("/en/app/team/site")).toBe("/app/team/site");
    expect(normalizeLocalePath("/ja/app/team/site")).toBe("/app/team/site");
  });
});
