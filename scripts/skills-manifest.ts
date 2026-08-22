import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
export const SKILLS_TEMPLATE_PATH = resolve(
  ROOT,
  "scripts",
  "skills-template.json",
);
export const SKILLS_OUTPUT_PATH = resolve(ROOT, "docs", "skills.json");

const TEMPLATE_PLACEHOLDERS = new Set(["baseUrl", "version"]);
const PLACEHOLDER_PATTERN = /\$\{([^}]+)\}/g;

export type SkillsManifest = Record<string, unknown>;

export function readSkillsTemplate(
  path = SKILLS_TEMPLATE_PATH,
): SkillsManifest {
  return JSON.parse(readFileSync(path, "utf8")) as SkillsManifest;
}

function renderValue(
  value: unknown,
  variables: Record<string, string>,
): unknown {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
      if (!TEMPLATE_PLACEHOLDERS.has(name)) {
        throw new Error(`Unknown skills template placeholder: ${match}`);
      }
      return variables[name];
    });
  }
  if (Array.isArray(value))
    return value.map((item) => renderValue(item, variables));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      renderValue(item, variables),
    ]),
  );
}

export function renderSkillsManifest(
  version: string,
  template = readSkillsTemplate(),
): SkillsManifest {
  if (!version) throw new Error("Skills manifest version must not be empty.");
  return renderValue(template, {
    baseUrl: "${baseUrl}",
    version,
  }) as SkillsManifest;
}

export function serializeSkillsManifest(manifest: SkillsManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
