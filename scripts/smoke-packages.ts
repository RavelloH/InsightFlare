import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { type Browser, chromium } from "@playwright/test";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "insightflare-package-smoke-"),
);
const tarballDirectory = path.join(temporaryRoot, "tarballs");
const consumerDirectory = path.join(temporaryRoot, "consumer");
const workspaceDirectory = path.join(temporaryRoot, "npm-workspace");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
let consumerPreview: ChildProcess | undefined;
let browser: Browser | undefined;

interface PackedFile {
  path: string;
}

interface PackedPackage {
  filename?: string;
  files?: PackedFile[];
}

interface DependencyNode {
  version?: string;
  dependencies?: Record<string, DependencyNode>;
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      [
        command + " " + args.join(" ") + " failed in " + cwd,
        result.stdout,
        result.stderr,
      ].join("\n"),
    );
  }
  return result.stdout ?? "";
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to reserve a local preview port.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForPreview(
  child: ChildProcess,
  port: number,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  const url = `http://127.0.0.1:${port}`;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("External consumer preview exited early:\n" + output());
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The preview server has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("External consumer preview did not start:\n" + output());
}

async function stopPreview(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill();
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function write(relativePath: string, content: string): Promise<void> {
  const destination = path.join(consumerDirectory, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
}

async function writeWorkspace(
  relativePath: string,
  content: string,
): Promise<void> {
  const destination = path.join(workspaceDirectory, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
}

try {
  await mkdir(tarballDirectory, { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });
  await mkdir(workspaceDirectory, { recursive: true });

  for (const packageName of ["ui", "product-ui"]) {
    await cp(
      path.join(repositoryRoot, "packages", packageName),
      path.join(workspaceDirectory, "packages", packageName),
      {
        recursive: true,
        filter: (source) => !source.split(path.sep).includes("node_modules"),
      },
    );
  }

  await writeWorkspace(
    "package.json",
    JSON.stringify(
      {
        name: "insightflare-npm-workspace-smoke",
        private: true,
        workspaces: ["packages/*"],
        dependencies: {
          "@insightflare/ui": "0.7.1",
          "@insightflare/product-ui": "0.7.1",
          "@types/react": "^19.0.0",
          "@types/react-dom": "^19.0.0",
          react: "^19.2.8",
          "react-dom": "^19.2.8",
          tailwindcss: "^4.3.0",
        },
      },
      null,
      2,
    ),
  );
  run(
    npmCommand,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    workspaceDirectory,
  );
  for (const packageName of ["ui", "product-ui"]) {
    const installedPath = path.join(
      workspaceDirectory,
      "node_modules",
      "@insightflare",
      packageName,
    );
    const expectedPath = path.join(workspaceDirectory, "packages", packageName);
    if ((await realpath(installedPath)) !== (await realpath(expectedPath))) {
      throw new Error(
        "npm did not link @insightflare/" + packageName + " as a workspace",
      );
    }
  }

  const packageArchives: Record<"ui" | "product-ui", string> = {
    ui: "",
    "product-ui": "",
  };
  for (const [packageName, packageDirectory] of [
    ["ui", "packages/ui"],
    ["product-ui", "packages/product-ui"],
  ] as const) {
    const packageRoot = path.join(repositoryRoot, packageDirectory);
    const packed = JSON.parse(
      run(
        npmCommand,
        ["pack", "--json", "--pack-destination", tarballDirectory],
        packageRoot,
      ),
    ) as PackedPackage[];
    const archive = packed[0]?.filename;
    if (!archive)
      throw new Error("npm pack returned no tarball for " + packageDirectory);
    const archiveFiles = new Set(
      (packed[0]?.files ?? []).map((file) => file.path.replaceAll("\\", "/")),
    );
    for (const entry of archiveFiles) {
      if (/\/(?:__tests__|tests)\/|\.(?:test|spec)\.[^.]+$/u.test(entry)) {
        throw new Error("npm pack included a test file: " + entry);
      }
      if (
        /^(?:src\/components\/dashboard|src\/lib\/edge|wrangler\.toml|\.env)/u.test(
          entry,
        )
      ) {
        throw new Error(
          "npm pack included application or environment code: " + entry,
        );
      }
    }
    const requiredFiles =
      packageName === "ui"
        ? [
            "package.json",
            "src/styles.css",
            "styles/tokens.css",
            "dist/index.js",
            "dist/index.d.ts",
          ]
        : [
            "package.json",
            "styles.css",
            "dist/goals/index.js",
            "dist/goals/index.d.ts",
            "dist/realtime/index.js",
            "dist/realtime/index.d.ts",
            "dist/funnel/index.js",
            "dist/funnel/index.d.ts",
            "dist/sharing/index.js",
            "dist/sharing/index.d.ts",
          ];
    for (const requiredFile of requiredFiles) {
      if (!archiveFiles.has(requiredFile)) {
        throw new Error(
          "npm pack omitted " + requiredFile + " from " + packageName,
        );
      }
    }
    packageArchives[packageName] = archive;
  }

  const packageJson = {
    name: "insightflare-external-consumer-smoke",
    private: true,
    type: "module",
    scripts: {
      build: "vite build",
      typecheck: "tsc --noEmit -p tsconfig.json",
    },
    dependencies: {
      "@insightflare/ui": "file:../tarballs/" + packageArchives.ui,
      "@insightflare/product-ui":
        "file:../tarballs/" + packageArchives["product-ui"],
      "@tailwindcss/vite": "4.3.3",
      "@vitejs/plugin-react": "6.1.1",
      react: "^19.2.8",
      "react-dom": "^19.2.8",
      tailwindcss: "^4.3.0",
      typescript: "^5.9.3",
      vite: "8.3.0",
    },
  };
  await write("package.json", JSON.stringify(packageJson, null, 2));
  await write(
    "index.html",
    '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Package smoke</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
  );
  await write(
    "vite.config.ts",
    'import tailwindcss from "@tailwindcss/vite";\nimport react from "@vitejs/plugin-react";\nimport { defineConfig } from "vite";\nexport default defineConfig({ plugins: [react(), tailwindcss()] });\n',
  );
  await write(
    "tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          skipLibCheck: true,
          jsx: "react-jsx",
          noEmit: true,
        },
        include: ["src"],
      },
      null,
      2,
    ),
  );
  await write(
    "src/main.tsx",
    [
      'import { StrictMode } from "react";',
      'import { createRoot } from "react-dom/client";',
      'import { Button } from "@insightflare/ui/button";',
      'import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@insightflare/ui/dialog";',
      'import { Card, CardContent, CardHeader, CardTitle } from "@insightflare/ui/card";',
      'import { Input } from "@insightflare/ui/input";',
      'import { LayerManagerProvider } from "@insightflare/ui/layer-manager";',
      'import { TooltipProvider } from "@insightflare/ui/tooltip";',
      'import { GoalVisualization, goalVisualizationContract } from "@insightflare/product-ui/goals";',
      'import { RealtimeTrafficTrendView, realtimeTrafficTrendContract } from "@insightflare/product-ui/realtime";',
      'import { FunnelVisualization, funnelVisualizationContract } from "@insightflare/product-ui/funnel";',
      'import { ShareBreakdownView, shareBreakdownContract } from "@insightflare/product-ui/sharing";',
      'import "@insightflare/ui/styles.css";',
      'import "@insightflare/product-ui/styles.css";',
      "",
      "const goalFixture = goalVisualizationContract.fixtures[0];",
      "const realtimeFixture = realtimeTrafficTrendContract.fixtures[0];",
      "const funnelFixture = funnelVisualizationContract.fixtures[0];",
      "const shareFixture = shareBreakdownContract.fixtures[0];",
      'const root = createRoot(document.getElementById("root")!);',
      "root.render(",
      "  <StrictMode>",
      "    <LayerManagerProvider>",
      "      <TooltipProvider>",
      '      <main data-theme="light" className="space-y-6 bg-background p-8 font-mono text-foreground">',
      '        <section className="flex gap-3">',
      "          <Button>Packaged button</Button>",
      '          <Button variant="outline">Outline</Button>',
      "        </section>",
      '        <Card className="rounded-md">',
      "          <CardHeader><CardTitle>Packaged card</CardTitle></CardHeader>",
      '          <CardContent><Input aria-label="Workspace name" placeholder="Workspace name" /></CardContent>',
      "        </Card>",
      "        <Dialog>",
      '          <DialogTrigger asChild><Button variant="outline">Open dialog</Button></DialogTrigger>',
      "          <DialogContent><DialogTitle>Packaged dialog</DialogTitle></DialogContent>",
      "        </Dialog>",
      '        <div data-theme="dark" className="dark space-y-4 rounded-md border bg-background p-4 text-foreground">',
      '          <Button className="dark:bg-card">Dark theme</Button>',
      "          <GoalVisualization {...goalFixture.props} />",
      "          <RealtimeTrafficTrendView {...realtimeFixture.props} />",
      "          <FunnelVisualization {...funnelFixture.props} />",
      "          <ShareBreakdownView {...shareFixture.props} />",
      "        </div>",
      "      </main>",
      "      </TooltipProvider>",
      "    </LayerManagerProvider>",
      "  </StrictMode>,",
      ");",
      "",
    ].join("\n"),
  );

  run(
    npmCommand,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    consumerDirectory,
  );
  run(
    npmCommand,
    ["exec", "--", "tsc", "--noEmit", "-p", "tsconfig.json"],
    consumerDirectory,
  );
  run(npmCommand, ["exec", "--", "vite", "build"], consumerDirectory);

  const cssDirectory = path.join(consumerDirectory, "dist", "assets");
  const cssFiles = (await readdir(cssDirectory)).filter((file) =>
    file.endsWith(".css"),
  );
  const css = (
    await Promise.all(
      cssFiles.map((file) => readFile(path.join(cssDirectory, file), "utf8")),
    )
  ).join("\n");
  for (const requiredStyle of [
    ".bg-primary",
    ".border-input",
    ".grid-cols-2",
    "--background",
    "--chart-secondary",
    "os-theme-insightflare",
    "--radius",
    ".font-mono",
    "font-family",
    ".dark",
    ".dark\\:bg-card",
    "border-radius",
    "z-index",
    "@keyframes",
  ]) {
    if (!css.includes(requiredStyle)) {
      throw new Error("External CSS output is missing " + requiredStyle);
    }
  }
  if (!/\.dark\s*\{[^}]*--background:/u.test(css)) {
    throw new Error("External CSS output is missing dark theme token values");
  }

  const previewPort = await reservePort();
  let previewOutput = "";
  consumerPreview = spawn(
    process.execPath,
    [
      path.join(consumerDirectory, "node_modules", "vite", "bin", "vite.js"),
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(previewPort),
      "--strictPort",
    ],
    { cwd: consumerDirectory, stdio: ["ignore", "pipe", "pipe"] },
  );
  consumerPreview.stdout?.on("data", (chunk: Buffer) => {
    previewOutput += chunk.toString();
  });
  consumerPreview.stderr?.on("data", (chunk: Buffer) => {
    previewOutput += chunk.toString();
  });
  await waitForPreview(consumerPreview, previewPort, () => previewOutput);
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 960 },
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  const response = await page.goto(`http://127.0.0.1:${previewPort}`, {
    waitUntil: "domcontentloaded",
  });
  if (!response?.ok()) {
    throw new Error("The external consumer preview did not return a page.");
  }

  const packagedButton = page.getByRole("button", { name: "Packaged button" });
  await page.waitForTimeout(500);
  if ((await packagedButton.count()) === 0) {
    throw new Error(
      [
        "The external consumer did not render its packaged Button.",
        "Browser errors: " + pageErrors.join("; "),
        "Consumer root: " + (await page.locator("#root").innerHTML()),
      ].join("\n"),
    );
  }
  await packagedButton.waitFor({ state: "visible" });
  const buttonStyles = await packagedButton.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      background: styles.backgroundColor,
      paddingLeft: styles.paddingLeft,
      fontFamily: styles.fontFamily,
    };
  });
  if (
    buttonStyles.background === "rgba(0, 0, 0, 0)" ||
    buttonStyles.paddingLeft === "0px" ||
    !buttonStyles.fontFamily
  ) {
    throw new Error("Packaged Button styles are not applied in the browser.");
  }

  const themeBackgrounds = await page
    .locator("main, [data-theme='dark']")
    .evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).backgroundColor),
    );
  if (
    themeBackgrounds.length !== 2 ||
    themeBackgrounds[0] === themeBackgrounds[1]
  ) {
    throw new Error(
      "External consumer light and dark themes did not render differently.",
    );
  }

  await page.getByRole("button", { name: "Open dialog" }).click();
  await page.getByRole("dialog").waitFor({ state: "visible" });
  const dialogStyles = await page.getByRole("dialog").evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      background: styles.backgroundColor,
      paddingTop: styles.paddingTop,
      position: styles.position,
    };
  });
  if (
    dialogStyles.background === "rgba(0, 0, 0, 0)" ||
    dialogStyles.paddingTop === "0px" ||
    dialogStyles.position !== "fixed"
  ) {
    throw new Error(
      "Packaged Dialog styles are missing in the browser: " +
        JSON.stringify(dialogStyles),
    );
  }
  if ((await page.getByRole("progressbar").count()) === 0) {
    throw new Error("The packed Product UI did not render its Goal view.");
  }
  if ((await page.locator('[data-slot="chart"] svg').count()) === 0) {
    throw new Error("The packed Realtime Product UI did not render its chart.");
  }
  if (pageErrors.length > 0) {
    throw new Error(
      "External consumer browser errors: " + pageErrors.join("; "),
    );
  }

  const uiDist = path.join(
    consumerDirectory,
    "node_modules",
    "@insightflare",
    "ui",
    "dist",
  );
  const productDist = path.join(
    consumerDirectory,
    "node_modules",
    "@insightflare",
    "product-ui",
    "dist",
  );
  for (const packageDist of [uiDist, productDist]) {
    const files: string[] = [];
    async function walk(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts"))
          files.push(absolute);
      }
    }
    await walk(packageDist);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (
        source.includes("@/") ||
        source.includes("packages/ui/src") ||
        source.includes("packages/product-ui/src")
      ) {
        throw new Error(
          "Published output contains a workspace-only path: " +
            path.relative(consumerDirectory, file),
        );
      }
    }
  }

  const treeText = run(
    npmCommand,
    ["ls", "react", "--all", "--json"],
    consumerDirectory,
  );
  const tree = JSON.parse(treeText) as DependencyNode;
  const reactVersions = new Set();
  function collectReactVersions(
    node: DependencyNode | undefined,
    dependencyName = "",
  ) {
    if (!node) return;
    if (dependencyName === "react" && node.version) {
      reactVersions.add(node.version);
    }
    for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
      collectReactVersions(dependency, name);
    }
  }
  collectReactVersions(tree);
  if (reactVersions.size !== 1) {
    throw new Error(
      "Expected one installed React version, found " +
        [...reactVersions].join(", "),
    );
  }

  console.log(
    "Package smoke passed: npm pack, clean npm install, TypeScript, Vite build, browser styles and Product UI, and React dedupe.",
  );
} finally {
  await browser?.close();
  if (consumerPreview) await stopPreview(consumerPreview);
  await rm(temporaryRoot, { recursive: true, force: true });
}
