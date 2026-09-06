import { cpus as osCpus } from "node:os";

import path from "path";
import { defineConfig } from "vitest/config";

const VITEST_MAX_WORKERS = Math.min(16, Math.max(1, osCpus().length));

export default defineConfig({
  oxc: false,
  esbuild: {
    jsx: "automatic",
  },
  define: {
    BUILD_PERFORMANCE: true,
  },
  test: {
    environment: "happy-dom",
    environmentOptions: {
      happyDOM: {
        url: "http://localhost:3000/",
      },
    },
    globals: true,
    pool: "threads",
    maxWorkers: VITEST_MAX_WORKERS,
    include: ["src/tracker/__tests__/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.cache/**",
      "**/.tmp/**",
      "**/e2e/**",
    ],
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "cloudflare:workers": path.resolve(
        __dirname,
        "./src/test/shims/cloudflare-workers.ts",
      ),
    },
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/tracker",
      include: [
        "src/tracker/sdk.ts",
        "src/tracker/auto-track.ts",
        "src/tracker/performance.ts",
        "src/tracker/ua-client-hints.ts",
      ],
      exclude: ["src/tracker/__tests__/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "cloudflare:workers": path.resolve(
        __dirname,
        "./src/test/shims/cloudflare-workers.ts",
      ),
    },
  },
});
