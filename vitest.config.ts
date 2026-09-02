import { cpus as osCpus } from "node:os";

import path from "path";
import { defineConfig } from "vitest/config";
import { parse } from "yaml";

// Keep the test pool bounded on high-core machines.  V8 coverage writes one
// temporary file per worker; an unbounded pool makes that merge flaky under
// the full check and can also starve the integration tests of CPU.
const VITEST_MAX_WORKERS = Math.min(8, Math.max(1, osCpus().length));

export default defineConfig({
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
  ],
  oxc: false,
  esbuild: {
    jsx: "automatic",
  },
  define: {
    BUILD_PERFORMANCE: true,
  },
  test: {
    environment: "happy-dom",
    globals: true,
    pool: "threads",
    maxWorkers: VITEST_MAX_WORKERS,
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "cloudflare:workers": path.resolve(
        __dirname,
        "./src/test/shims/cloudflare-workers.ts",
      ),
    },
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.cache/**",
      "**/.tmp/**",
      "**/e2e/**",
    ],
    coverage: {
      thresholds: {
        statements: 95,
        branches: 88,
        functions: 98,
        lines: 96,
      },
      include: [
        "src/routes/**/*.ts",
        "src/components/dashboard/**/*.ts",
        "src/hooks/**/*.ts",
        "src/lib/**/*.ts",
        "src/schemas/**/*.ts",
        "src/middleware.ts",
        "src/tracker/sdk.ts",
      ],
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.test.{ts,tsx}",
        "src/**/*.spec.{ts,tsx}",
        "src/**/__tests__/**",
        "src/app/.well-known/**",
        "src/**/types.ts",
        "src/**/*types*.ts",
        "src/**/core.ts",
        "src/**/technology.ts",
        "src/**/fact-builder.ts",
        "src/**/analytics.ts",
        "src/**/management.ts",
        "src/lib/i18n/messages.ts",
        "src/tracker/*.min.ts",
        "src/tracker/sdk.no-perf.min.ts",
        "src/lib/edge-client-types/**",
        // Hono route registration is covered through endpoint integration tests;
        // keep its large callback matrix out of the global query-logic budget.
        "src/lib/hono/routes/v1/site-analytics.ts",
        // API v1 provider assembly is a source-wiring matrix; operation
        // behavior is covered by the handler and route integration suites.
        "src/lib/edge/analytics/composition/api-v1-provider-registry.ts",
        "src/lib/realtime/demo-site-profiles-types.ts",
        "src/lib/realtime/mock.ts",
        "src/lib/edge/ingest-flush-types.ts",
        "src/lib/edge/ingest-types.ts",
        "src/lib/realtime/mock/events-helpers.ts",
        "src/tracker/sdk.ts",
        "src/lib/system-performance.ts",
        "src/components/dashboard/site-pages/use-dashboard-query.ts",
      ],
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
