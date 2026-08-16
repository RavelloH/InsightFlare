import { describe, expect, it } from "vitest";

import { sharePath } from "@/lib/dashboard/share-path";

describe("sharePath", () => {
  it("creates a language-neutral public share URL", () => {
    expect(sharePath("zh", "public site")).toBe("/share/public%20site");
  });

  it("preserves the requested public dashboard section", () => {
    expect(sharePath("en", "public-site", "pages")).toBe(
      "/share/public-site/pages",
    );
  });
});
