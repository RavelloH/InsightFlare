import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface FoundationDeployManifestInput {
  configPath: string;
  dryRun: boolean;
  envName?: string;
  rootDir: string;
  target: string;
}

export interface FoundationDeployManifest {
  configPath: string;
  configSha256: string;
  dryRun: boolean;
  envName: string | null;
  expectedBindings: string[];
  generatedAt: string;
  migration: {
    file: string;
    sha256: string;
  };
  target: string;
}

const REQUIRED_FOUNDATION_BINDINGS = [
  "QUERY_DIAGNOSTICS",
  "CF_VERSION_METADATA",
] as const;

function sha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function hasBinding(value: unknown, binding: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasBinding(entry, binding));
  }
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  if (record.binding === binding) return true;
  return Object.values(record).some((entry) => hasBinding(entry, binding));
}

function bindingIsPresent(content: string, binding: string): boolean {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    try {
      return hasBinding(JSON.parse(trimmed), binding);
    } catch {
      return false;
    }
  }

  return new RegExp(
    `^\\s*binding\\s*=\\s*["']${binding}["']\\s*(?:#.*)?$`,
    "m",
  ).test(content);
}

export function assertFoundationDeployConfig(configContent: string): void {
  const missing = REQUIRED_FOUNDATION_BINDINGS.filter(
    (binding) => !bindingIsPresent(configContent, binding),
  );
  if (missing.length > 0) {
    throw new Error(
      `Foundation deploy requires bindings: ${missing.join(", ")}. Refusing Analytics Engine fallback.`,
    );
  }
}

export function writeFoundationDeployManifest(
  input: FoundationDeployManifestInput,
): FoundationDeployManifest | null {
  if (input.dryRun) return null;

  const configContent = fs.readFileSync(input.configPath, "utf8");
  const migrationPath = path.join(
    input.rootDir,
    "migrations",
    "0033_performance_foundation_controls.sql",
  );
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`Missing Foundation migration: ${migrationPath}`);
  }

  const manifest: FoundationDeployManifest = {
    configPath: path
      .relative(input.rootDir, input.configPath)
      .replace(/\\/g, "/"),
    configSha256: sha256(configContent),
    dryRun: false,
    envName: input.envName ?? null,
    expectedBindings: [...REQUIRED_FOUNDATION_BINDINGS],
    generatedAt: new Date().toISOString(),
    migration: {
      file: "migrations/0033_performance_foundation_controls.sql",
      sha256: sha256(fs.readFileSync(migrationPath)),
    },
    target: input.target,
  };

  const cacheDir = path.join(input.rootDir, ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, "foundation-deploy-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
