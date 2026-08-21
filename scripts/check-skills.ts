#!/usr/bin/env tsx

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { createScriptLogger } from "./shared/logger";
import {
  renderSkillsManifest,
  serializeSkillsManifest,
  SKILLS_OUTPUT_PATH,
} from "./skills-manifest";

const root = resolve(import.meta.dirname, "..");
const rlog = createScriptLogger();

function appVersion(): string {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
}

const expected = serializeSkillsManifest(renderSkillsManifest(appVersion()));
const actual = readFileSync(SKILLS_OUTPUT_PATH, "utf8");

if (actual !== expected) {
  rlog.error(
    "docs/skills.json is stale. Run npm run generate:skills and commit the generated artifact.",
  );
  process.exitCode = 1;
} else {
  rlog.success("Skills manifest is synchronized with its template.");
}
