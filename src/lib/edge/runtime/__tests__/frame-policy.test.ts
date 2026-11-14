import { describe, expect, it } from "vitest";

import { framePolicy } from "@/lib/edge/runtime/frame-policy";

describe("framePolicy", () => {
  it("denies all framing outside demo mode", () => {
    expect(framePolicy(false)).toEqual({
      frameOptions: "DENY",
      frameAncestors: "'none'",
    });
  });

  it("allows the project website to frame the demo deployment", () => {
    const policy = framePolicy(true);
    expect(policy.frameOptions).toBeNull();
    expect(policy.frameAncestors.split(" ")).toEqual(
      expect.arrayContaining([
        "'self'",
        "https://insightflare.net",
        "https://www.insightflare.net",
      ]),
    );
    expect(policy.frameAncestors).not.toContain("'none'");
    expect(policy.frameAncestors).not.toMatch(/(^|\s)\*(\s|$)/);
  });
});
