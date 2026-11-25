import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { icons } from "@iconify-json/flagpack";

/** Generate the exact Flagpack paths as individually cacheable same-origin SVGs. */
export async function generateFlagAssets(publicDir: string) {
  const revision = createHash("sha256")
    .update("flagpack-svg-v1")
    .update(JSON.stringify(icons))
    .digest("hex")
    .slice(0, 12);
  const base = "/images/flagpack/" + revision;
  const directory = path.join(publicDir, "images", "flagpack", revision);
  await mkdir(directory, { recursive: true });
  const names = Object.keys(icons.icons).sort();
  await Promise.all(
    names.map(async (name) => {
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid Flagpack name");
      const icon = icons.icons[name]!;
      const width = icon.width ?? icons.width ?? 32;
      const height = icon.height ?? icons.height ?? 24;
      const left = icon.left ?? icons.left ?? 0;
      const top = icon.top ?? icons.top ?? 0;
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' +
        [left, top, width, height].join(" ") +
        '">' +
        icon.body +
        "</svg>";
      const file = path.join(directory, name + ".svg");
      if ((await readFile(file, "utf8").catch(() => null)) !== svg)
        await writeFile(file, svg);
    }),
  );
  return { base, names };
}
