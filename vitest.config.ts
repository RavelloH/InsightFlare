import { cpus as osCpus } from "node:os";
import process from "node:process";

import path from "path";
import { defineConfig } from "vitest/config";
import { parse } from "yaml";

import { regenerateAppMessages } from "./scripts/i18n-check/prune";

// Keep the test pool bounded on high-core machines.  V8 coverage writes one
// temporary file per worker; an unbounded pool makes that merge flaky under
// the full check and can also starve the integration tests of CPU.
const VITEST_MAX_WORKERS = Math.min(4, Math.max(1, osCpus().length));

// Vitest must not inherit the shell's production mode. React 19 deliberately
// omits act() from its production export; tests require its development export.
process.env.NODE_ENV = "test";

// Vitest 4 removed environmentMatchGlobs; use disjoint projects so Node's
// built-in modules (node:sqlite/async_hooks) are never browser-externalized.
const NODE_TEST_SCOPES = [
  "src/lib/edge/**",
  "src/lib/api-v1/**",
  "src/lib/hono/**",
  "src/lib/db/**",
  "src/lib/notifications/edge/**",
  "scripts/**",
  "src/__tests__/middleware.test.ts",
];
const NODE_TEST_FILES = [
  ...NODE_TEST_SCOPES.slice(0, -1).map(
    (scope) => `${scope}/*.{test,spec}.{ts,tsx,js,jsx}`,
  ),
  NODE_TEST_SCOPES[NODE_TEST_SCOPES.length - 1],
];

const config = defineConfig({
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
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          // Isolate native node:sqlite and V8 coverage from shared worker threads on Windows.
          pool: process.platform === "win32" ? "forks" : "threads",
          include: NODE_TEST_FILES,
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "happy-dom",
          setupFiles: ["./src/test/setup-react-act.ts"],
          include: ["**/*.{test,spec}.{ts,tsx,js,jsx}"],
          exclude: NODE_TEST_SCOPES,
        },
      },
    ],
    environmentOptions: {
      happyDOM: {
        // Keep URL parsing deterministic across local and Linux CI runs. Without
        // an explicit origin, happy-dom may start at about:blank, whose pathname
        // is "blank" and makes history.replaceState-based browser tests flaky.
        url: "http://localhost:3000/",
      },
    },
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
      "**/plan/**",
    ],
    coverage: {
      thresholds: {
        statements: 95,
        branches: 88,
        functions: 98,
        lines: 96,
      },
      include: [
        // The default project measures server/business logic only. UI route
        // modules and the browser SDK are measured by separate coverage
        // projects so their execution model does not distort this aggregate.
        "src/components/dashboard/**/*.ts",
        "src/hooks/**/*.ts",
        "src/lib/**/*.ts",
        "src/schemas/**/*.ts",
        "src/middleware.ts",
      ],
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.test.{ts,tsx}",
        "src/**/*.spec.{ts,tsx}",
        "src/**/__tests__/**",
        // Reserve React route/component coverage for a separate UI project;
        // keep browser rendering out of the server/business aggregate.
        "src/routes/**",
        "src/components/**/*.tsx",
        "src/app/.well-known/**",
        "src/**/types.ts",
        "src/**/*types*.ts",
        "src/**/core.ts",
        "src/**/technology.ts",
        "src/**/fact-builder.ts",
        "src/**/analytics.ts",
        "src/**/management.ts",
        "src/lib/i18n/messages.ts",
        "src/lib/i18n/generated/**",
        "src/tracker/*.min.ts",
        "src/tracker/sdk.no-perf.min.ts",
        "src/lib/dashboard-api/contract/types/**",
        // Hono route registration is covered through endpoint integration tests;
        // keep its large callback matrix out of the global query-logic budget.
        "src/lib/hono/routes/v1/site-analytics.ts",
        // API v1 provider assembly is a source-wiring matrix; operation
        // behavior is covered by the handler and route integration suites.
        "src/lib/edge/analytics/composition/api-v1-provider-registry.ts",
        "src/lib/demo/data/site-profiles-types.ts",
        "src/lib/demo/realtime/handler.ts",
        "src/lib/edge/ingest/flush-types.ts",
        "src/lib/edge/ingest/types.ts",
        "src/lib/demo/realtime/events-helpers.ts",
        "src/lib/system-performance.ts",
        "src/components/dashboard/site-pages/use-dashboard-query.ts",
        // The query provider is browser orchestration. Its hydration and
        // route-sync behavior has a focused component test, while its broad
        // control-state matrix is not part of the global query coverage budget.
        "src/components/dashboard/dashboard-query-provider.tsx",
        // Browser-only perception persistence and authorization lifecycle are
        // validated through focused unit and Playwright integration tests.
        "src/lib/perception-search/index.ts",
        "src/lib/perception-search/runtime.ts",
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

export default defineConfig(async () => {
  await regenerateAppMessages();
  return config;
});
