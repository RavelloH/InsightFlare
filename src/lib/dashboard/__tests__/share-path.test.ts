import { describe, expect, it } from "vitest";

import { sharePath } from "@/lib/dashboard/share-path";

describe("sharePath", () => {
  it("preserves the locale in the public share URL", () => {
    expect(sharePath("zh", "public site")).toBe("/zh/share/public%20site");
  });

  it("preserves the requested public dashboard section", () => {
    expect(sharePath("en", "public-site", "pages")).toBe(
      "/en/share/public-site/pages",
    );
  });
});
