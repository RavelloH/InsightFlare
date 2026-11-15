import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PREFIX = "if-e2e-";
const OWNER_FILE = ".insightflare-e2e-owner.json";
// Leave room below legacy Windows path limits, including SQLite's WAL suffix.
const PERSISTENCE_PATH_BUDGET = 240;

export interface E2ePersistenceDirectory {
  readonly directory: string;
  readonly parentDirectory: string;
  readonly runId: string;
  readonly statePath: string;
  readonly token: string;
}

function assertDirectChild(parent: string, child: string): void {
  const relative = path.relative(parent, child);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.dirname(relative) !== "."
  ) {
    throw new Error(
      "Refusing to remove an E2E directory outside its owned parent.",
    );
  }
}

export async function createE2ePersistenceDirectory(
  runId: string,
): Promise<E2ePersistenceDirectory> {
  const parentDirectory = await fs.realpath(tmpdir());
  const worker = `insightflare-e2e-${runId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
  const sqlitePath = path.join(
    parentDirectory,
    `${PREFIX}XXXXXX`,
    "state",
    "v3",
    "do",
    `${worker}-IngestDurableObject`,
    `${"f".repeat(64)}.sqlite-wal`,
  );
  if (sqlitePath.length >= PERSISTENCE_PATH_BUDGET) {
    throw new Error(
      "The E2E temporary directory is too long for local SQLite storage. " +
        "Use a shorter task-local TEMP/TMP directory before starting E2E.",
    );
  }
  const directory = await fs.mkdtemp(path.join(parentDirectory, PREFIX));
  const token = Buffer.from(randomBytes(24)).toString("hex");
  const statePath = path.join(directory, "state");
  await fs.writeFile(
    path.join(directory, OWNER_FILE),
    JSON.stringify({ runId, token }),
    { flag: "wx" },
  );
  await fs.mkdir(statePath);
  return { directory, parentDirectory, runId, statePath, token };
}

export async function removeE2ePersistenceDirectory(
  ownership: E2ePersistenceDirectory,
): Promise<void> {
  const directory = path.resolve(ownership.directory);
  const parent = await fs.realpath(ownership.parentDirectory);
  assertDirectChild(parent, directory);
  if (
    !path.basename(directory).startsWith(PREFIX) ||
    ownership.statePath !== path.join(directory, "state") ||
    (await fs.lstat(directory)).isSymbolicLink()
  ) {
    throw new Error("Refusing to remove an unowned E2E persistence directory.");
  }
  const resolved = await fs.realpath(directory);
  assertDirectChild(parent, resolved);
  if (
    resolved !== directory ||
    (await fs.readFile(path.join(directory, OWNER_FILE), "utf8")) !==
      JSON.stringify({ runId: ownership.runId, token: ownership.token })
  ) {
    throw new Error("E2E persistence ownership no longer matches this run.");
  }
  await fs.rm(resolved, { recursive: true, force: true });
}

export async function removeE2eRunDirectory(
  directory: string,
  runId: string,
): Promise<void> {
  const parentPath = path.resolve(".tmp", "e2e");
  const target = path.resolve(directory);
  assertDirectChild(parentPath, target);
  if (
    path.basename(target) !== runId ||
    (await fs.lstat(target)).isSymbolicLink()
  ) {
    throw new Error("Refusing to remove another E2E run directory.");
  }
  const parent = await fs.realpath(parentPath);
  const resolved = await fs.realpath(target);
  assertDirectChild(parent, resolved);
  if (resolved !== path.join(parent, runId)) {
    throw new Error(
      "E2E run directory no longer resolves to its owned parent.",
    );
  }
  await fs.rm(resolved, { recursive: true, force: true });
}
