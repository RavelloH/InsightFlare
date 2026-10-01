import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import ts from "typescript";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
);
const sourceEntries = Object.values(packageJson.exports)
  .map((entry) => entry?.development)
  .filter(
    (entry) =>
      typeof entry === "string" &&
      (entry.endsWith(".ts") || entry.endsWith(".tsx")),
  )
  .map((entry) => path.join(packageRoot, entry));

await rm(path.join(packageRoot, "dist"), { recursive: true, force: true });

const configPath = path.join(packageRoot, "tsconfig.build.json");
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  throw new Error(
    ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
  );
}
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, packageRoot);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length > 0) {
  const host = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => packageRoot,
    getNewLine: () => "\n",
  };
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
  process.exitCode = 1;
  process.exit();
}
const emitted = program.emit();
if (emitted.emitSkipped) {
  throw new Error("TypeScript declaration emit failed.");
}

await build({
  absWorkingDir: packageRoot,
  entryPoints: sourceEntries,
  outbase: path.join(packageRoot, "src"),
  outdir: path.join(packageRoot, "dist"),
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  packages: "external",
  jsx: "automatic",
  entryNames: "[dir]/[name]",
  chunkNames: "chunks/[name]-[hash]",
});
