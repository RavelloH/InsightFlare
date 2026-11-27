import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { generateStaticHeaders } from "./generate-static-headers";

it("only caches versioned static assets and preserves custom configuration", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "insightflare-headers-"),
  );
  const target = path.join(directory, "_headers");
  try {
    await generateStaticHeaders(directory);
    const content = await readFile(target, "utf8");
    expect(content.split("\n").filter((line) => line.startsWith("/"))).toEqual([
      "/assets/*",
      "/images/flagpack/*",
      "/widgets/embed.js",
    ]);
    expect(content.match(/max-age=31536000, immutable/g)).toHaveLength(2);
    // The unversioned widget loader revalidates instead of being immutable.
    expect(content).toContain(
      "/widgets/embed.js\n  Cache-Control: public, max-age=3600, stale-while-revalidate=86400",
    );
    await generateStaticHeaders(directory);
    expect(await readFile(target, "utf8")).toBe(content);
    await writeFile(target, "/custom\n  X-Test: yes\n");
    await expect(generateStaticHeaders(directory)).rejects.toThrow("custom");
    expect(await readFile(target, "utf8")).toBe("/custom\n  X-Test: yes\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
