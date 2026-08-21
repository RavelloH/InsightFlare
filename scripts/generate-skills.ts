#!/usr/bin/env tsx

import { readFileSync, renameSync, writeFileSync } from "fs";
import { resolve } from "path";

import { createScriptLogger } from "./shared/logger";
import {
  renderSkillsManifest,
  serializeSkillsManifest,
  SKILLS_OUTPUT_PATH,
} from "./skills-manifest";

const ROOT = resolve(import.meta.dirname, "..");
const rlog = createScriptLogger();

function writeAtomically(path: string, content: string): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, content, "utf8");
  renameSync(temporaryPath, path);
}

function getAppVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  return pkg.version;
}

function generate() {
  writeAtomically(
    SKILLS_OUTPUT_PATH,
    serializeSkillsManifest(renderSkillsManifest(getAppVersion())),
  );
  rlog.success(`Generated ${SKILLS_OUTPUT_PATH}`);
}

generate();
