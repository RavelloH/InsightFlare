import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { icons } from "@iconify-json/flagpack";
import { expect, it } from "vitest";

import { generateFlagAssets } from "./generate-flag-assets";

it("generates every original flag with its SVG body and stable revision", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "insightflare-flags-"),
  );
  try {
    const assets = await generateFlagAssets(directory);
    expect(assets.names).toEqual(Object.keys(icons.icons).sort());
    expect(assets.base).toMatch(/^\/images\/flagpack\/[a-f0-9]{12}$/);
    const assetDir = path.join(directory, assets.base.slice(1));
    expect(await readdir(assetDir)).toHaveLength(assets.names.length);
    expect(await readFile(path.join(assetDir, "us.svg"), "utf8")).toContain(
      icons.icons.us!.body,
    );
    expect(await generateFlagAssets(directory)).toEqual(assets);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
