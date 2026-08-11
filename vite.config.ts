import path from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { parse } from "yaml";

import packageJson from "./package.json";

function ssrMapStubs() {
  const stubPath = path.resolve(
    import.meta.dirname,
    "./src/lib/ssr-map-stubs.tsx",
  );
  const stubs = new Set([
    "react-map-gl/maplibre",
    "@deck.gl/layers",
    "@deck.gl/mapbox",
  ]);

  return {
    name: "insightflare:ssr-map-stubs",
    enforce: "pre" as const,
    resolveId(
      source: string,
      _importer: string | undefined,
      options: { ssr?: boolean },
    ) {
      if (options.ssr && stubs.has(source)) {
        return stubPath;
      }
      return null;
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const isE2E = process.env.INSIGHTFLARE_E2E === "1";
  const e2eGithubApiBase = process.env.INSIGHTFLARE_E2E_GITHUB_API_BASE;
  if (isE2E && !e2eGithubApiBase) {
    throw new Error("INSIGHTFLARE_E2E_GITHUB_API_BASE is required for E2E.");
  }
  const demoMode =
    !isE2E &&
    (mode === "demo" || (process.env.DEMO_MODE ?? env.DEMO_MODE) === "1")
      ? "1"
      : "0";
  const configPath =
    process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH ||
    (demoMode === "1"
      ? "./wrangler.demo.toml"
      : mode === "local" || mode === "development"
        ? "./wrangler.dev.toml"
        : "./wrangler.toml");
  const persistencePath = process.env.INSIGHTFLARE_LOCAL_PERSISTENCE_PATH;
  const port = Number(process.env.INSIGHTFLARE_PORT || "3000");

  return {
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(packageJson.version),
      "import.meta.env.VITE_COMMIT_SHA": JSON.stringify(
        process.env.COMMIT_SHA || "",
      ),
      "import.meta.env.VITE_DEMO_MODE": JSON.stringify(demoMode),
      "import.meta.env.VITE_GITHUB_API_BASE": JSON.stringify(
        e2eGithubApiBase || "https://api.github.com",
      ),
      "import.meta.env.VITE_INSIGHTFLARE_ANALYTICS_ENGINE_DISABLED":
        JSON.stringify("0"),
    },
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },
    plugins: [
      {
        name: "yaml-as-json",
        transform(code, id) {
          if (!/\.ya?ml$/.test(id)) return null;
          return {
            code: `export default ${JSON.stringify(parse(code))};`,
            map: null,
          };
        },
      },
      ssrMapStubs(),
      cloudflare({
        configPath,
        persistState: persistencePath ? { path: persistencePath } : true,
        viteEnvironment: { name: "ssr" },
      }),
      tanstackStart(),
      react(),
      tailwindcss(),
    ],
    server: {
      host: "127.0.0.1",
      hmr: isE2E ? false : undefined,
      port: Number.isInteger(port) && port > 0 ? port : 3000,
      strictPort: true,
      watch: {
        ignored: ["**/.tmp/e2e/**"],
      },
    },
  };
});
