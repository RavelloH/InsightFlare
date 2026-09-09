#!/usr/bin/env tsx

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT_DIR = process.cwd();
const SRC_DIR = path.join(ROOT_DIR, "src");
const LAYER_DIR = `${path.join("src", "components", "ui", "layer")}${path.sep}`;
const INFRASTRUCTURE_ALLOWLIST = new Set([
  path.join("src", "components", "ui", "overlay-scrollbar.tsx"),
]);

const forbiddenPatterns: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "legacy layer symbol",
    pattern:
      /(?:MODAL_LAYER_Z_INDEX|DETAIL_DRAWER_Z_INDEX|EVENT_FILTER_DIALOG_Z_INDEX|EVENT_RECORD_DRAWER_Z_INDEX|NESTED_DETAIL_DRAWER_Z_INDEX|getFloatingLayerZIndexAbove|getTopFloatingLayerZIndex|hasHigherFloatingLayer|detailDrawerLayerStore|modalLayerStore)/g,
  },
  {
    label: "legacy floating-layer attribute",
    pattern: /data-dashboard-floating-layer-z/g,
  },
  {
    label: "magic overlay utility class",
    pattern: /\bz-(?:50|\[96\]|\[1000\]|\[1100\]|\[1200\])\b/g,
  },
  {
    label: "raw body portal",
    pattern: /createPortal\([\s\S]{0,500}?document\.body/g,
  },
  {
    label: "raw Radix/Vaul portal",
    pattern:
      /(?:DialogPrimitive|SheetPrimitive|AlertDialogPrimitive|DrawerPrimitive|DropdownMenuPrimitive|TooltipPrimitive|PopoverPrimitive)\.Portal/g,
  },
];

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(absolutePath)));
      continue;
    }
    if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) files.push(absolutePath);
  }
  return files;
}

function lineNumber(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

async function main() {
  const diagnostics: string[] = [];
  for (const absolutePath of await sourceFiles(SRC_DIR)) {
    const relativePath = path.relative(ROOT_DIR, absolutePath);
    const normalizedPath = relativePath.split(path.sep).join(path.sep);
    if (normalizedPath.startsWith(LAYER_DIR)) continue;
    if (INFRASTRUCTURE_ALLOWLIST.has(normalizedPath)) continue;

    const source = await fs.readFile(absolutePath, "utf8");
    for (const { label, pattern } of forbiddenPatterns) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        diagnostics.push(
          `${normalizedPath}:${lineNumber(source, match.index ?? 0)}: ${label}: ${match[0]}`,
        );
      }
    }
  }

  if (diagnostics.length > 0) {
    console.error("Layer contract violations detected:");
    console.error(diagnostics.join("\n"));
    process.exitCode = 1;
    return;
  }

  console.log("Layer contract check passed.");
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
