// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("widget asset manifest", () => {
  it("retries hashing after a failed first attempt", async () => {
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("digest unavailable"));
    const { widgetDocumentAssets } = await import("@/lib/widgets/assets");
    await expect(widgetDocumentAssets("metric")).rejects.toThrow(
      "digest unavailable",
    );
    const assets = await widgetDocumentAssets("realtime");
    expect(assets.script).toMatch(
      /^\/api\/public\/widgets\/assets\/widget-realtime\.[0-9a-f]{16}\.js$/,
    );
    expect(assets.stylesheet).toMatch(/widget\.[0-9a-f]{16}\.css$/);
    expect(digest.mock.calls.length).toBeGreaterThan(1);
  });

  it("uses the base script for placeholders and keeps hashes stable", async () => {
    const { widgetDocumentAssets } = await import("@/lib/widgets/assets");
    const placeholder = await widgetDocumentAssets(null);
    const metric = await widgetDocumentAssets("metric");
    expect(placeholder).toEqual(metric);
    expect(placeholder.script).toContain("/widget-base.");
    expect(await widgetDocumentAssets("distribution")).not.toEqual(metric);
  });
});
