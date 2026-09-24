import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectArchitectureViolations,
  detectForbiddenPrefixFiles,
  isGeneratedFile,
} from "../../../../scripts/check-architecture";
const temporaryDirectories: string[] = [];
function fixture(): string {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "insightflare-architecture-"),
  );
  temporaryDirectories.push(root);
  mkdirSync(path.join(root, "src/lib/edge/analytics/contract"), {
    recursive: true,
  });
  mkdirSync(path.join(root, "src/lib/dashboard"), { recursive: true });
  writeFileSync(
    path.join(root, "src/lib/dashboard/runtime.ts"),
    "export const runtime = true;\n",
  );
  return root;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
describe("architecture checker", () => {
  it("parses imports and re-exports and reports forbidden contract edges", () => {
    const root = fixture();
    writeFileSync(
      path.join(root, "src/lib/edge/analytics/contract/query.ts"),
      'import { runtime } from "@/lib/dashboard/runtime";\nexport { runtime } from "@/lib/dashboard/runtime";\n',
    );

    const violations = collectArchitectureViolations(root);

    expect(violations).toHaveLength(2);
    expect(violations.map(({ rule }) => rule)).toEqual([
      "analytics-contract-direction",
      "analytics-contract-direction",
    ]);
  });

  it("keeps Analytics contracts and shared domains out of runtime modules", () => {
    const root = fixture();
    const files: Record<string, string> = {
      "src/lib/edge/runtime/worker.ts": "export const worker = true;\n",
      "src/lib/edge/types.ts": "export interface Env {}\n",
      "src/lib/edge/analytics/contract/runtime-edge.ts":
        'import { worker } from "@/lib/edge/runtime/worker";\nexport { worker };\n',
      "src/lib/filter-contract/filter.ts":
        'import { worker } from "@/lib/edge/runtime/worker";\nexport { worker };\n',
      "src/lib/notifications/message.ts":
        'import { useState } from "react";\nexport { useState };\n',
      "src/lib/notifications/edge/store.ts":
        'import type { Env } from "@/lib/edge/types";\nexport type { Env };\n',
    };
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.join(root, relativePath);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content);
    }

    expect(
      collectArchitectureViolations(root).map(({ rule, source }) => ({
        rule,
        source,
      })),
    ).toEqual([
      {
        rule: "analytics-contract-direction",
        source: "src/lib/edge/analytics/contract/runtime-edge.ts",
      },
      {
        rule: "shared-domain-runtime-isolation",
        source: "src/lib/filter-contract/filter.ts",
      },
      {
        rule: "shared-domain-runtime-isolation",
        source: "src/lib/notifications/message.ts",
      },
    ]);
  });

  it("ignores generated source and recognizes only new top-level prefix files", () => {
    expect(isGeneratedFile("src/lib/generated/client.ts", "export {}")).toBe(
      true,
    );
    expect(
      isGeneratedFile("src/routeTree.gen.ts", "// automatically generated"),
    ).toBe(true);
    expect(
      isGeneratedFile(
        "src/lib/api-v1/generated-client/index.ts",
        "/* Generated from ApiV1RouteRegistry. */",
      ),
    ).toBe(true);
    expect(
      detectForbiddenPrefixFiles([
        "src/lib/admin-users.ts",
        "src/lib/admin-sites.ts",
        "src/lib/admin-roles.ts",
        "src/lib/admin/users.ts",
        "src/lib/dashboard/client/data/index.ts",
        "src/lib/dashboard/client-data.ts",
        "src/lib/dashboard/client-state.ts",
        "src/lib/dashboard/client-query.ts",
        "src/lib/dashboard/server-pages.ts",
        "src/lib/edge/admin-users.ts",
        "src/lib/edge/admin-teams.ts",
        "src/lib/edge/admin-sites.ts",
        "src/lib/edge/admin/users.ts",
      ]),
    ).toEqual([
      "src/lib/admin-roles.ts",
      "src/lib/admin-sites.ts",
      "src/lib/admin-users.ts",
      "src/lib/dashboard/client-data.ts",
      "src/lib/dashboard/client-query.ts",
      "src/lib/dashboard/client-state.ts",
      "src/lib/edge/admin-sites.ts",
      "src/lib/edge/admin-teams.ts",
      "src/lib/edge/admin-users.ts",
    ]);
  });

  it("checks dynamic imports and unresolved project aliases", () => {
    const root = fixture();
    writeFileSync(
      path.join(root, "src/lib/edge/analytics/contract/query.ts"),
      'export const load = () => import("@/lib/dashboard/missing");\n',
    );

    const violations = collectArchitectureViolations(root);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      rule: "unresolved-internal-import",
      specifier: "@/lib/dashboard/missing",
    });
  });

  it("enforces Dashboard, Tracker, Edge, and Analytics runtime boundaries", () => {
    const root = fixture();
    const files: Record<string, string> = {
      "src/lib/edge/analytics/providers/d1/reader.ts":
        "export const read = true;\n",
      "src/lib/edge/runtime/worker.ts": "export const worker = true;\n",
      "src/lib/edge/observability/logger.ts": "export const logger = true;\n",
      "src/lib/analytics/query.ts": "export const query = true;\n",
      "src/components/dashboard/shell/page.tsx": "export const page = true;\n",
      "src/lib/dashboard/query.ts":
        'import { read } from "@/lib/edge/analytics/providers/d1/reader";\nexport { read };\n',
      "src/lib/edge/analytics/application/service.ts":
        'import { Hono } from "hono";\nimport { logger } from "@/lib/edge/observability/logger";\nimport { cache } from "./cache";\nexport const service = [Hono, logger, cache];\n',
      "src/lib/edge/analytics/application/cache.ts":
        "export const cache = true;\n",
      "src/lib/edge/collector/endpoint.ts":
        'import { jsx } from "react/jsx-runtime";\nexport { jsx };\n',
      "src/lib/notifications/edge/worker.ts":
        'import { jsx } from "react/jsx-runtime";\nexport { jsx };\n',
      "src/tracker/runtime.ts": [
        'import "react";',
        'import "@tanstack/react-router";',
        'import { worker } from "@/lib/edge/runtime/worker";',
        'import { page } from "@/components/dashboard/shell/page";',
        "export { worker, page };",
        "",
      ].join("\n"),
    };
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.join(root, relativePath);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content);
    }

    const violations = collectArchitectureViolations(root);

    expect(violations.map(({ rule }) => rule)).toEqual([
      "dashboard-concrete-provider",
      "analytics-application-direction",
      "analytics-application-direction",
      "edge-ui-isolation",
      "edge-ui-isolation",
      "tracker-runtime-isolation",
      "tracker-runtime-isolation",
      "tracker-runtime-isolation",
      "tracker-runtime-isolation",
    ]);
  });

  it("skips generated files when scanning forbidden imports", () => {
    const root = fixture();
    const generatedPath = path.join(
      root,
      "src/lib/edge/analytics/contract/query.generated.ts",
    );
    writeFileSync(
      generatedPath,
      'import { runtime } from "@/lib/dashboard/runtime";\nexport { runtime };\n',
    );

    expect(collectArchitectureViolations(root)).toEqual([]);
  });

  it("requires exact exceptions for demo-build dynamic imports", () => {
    const root = fixture();
    const files: Record<string, string> = {
      "src/lib/demo/data/site-profiles.ts": "export const profiles = [];\n",
      "src/lib/demo/admin/service.ts": "export const execute = () => null;\n",
      "src/lib/edge/auth/site-access.ts":
        'const isDemoBuild = true;\nexport const load = () => isDemoBuild ? import("@/lib/demo/data/site-profiles") : null;\n',
      "src/lib/edge/admin/service/index.ts":
        'export const dispatch = () => import("@/lib/demo/admin/service");\n',
      "src/lib/edge/admin/reports.ts":
        'export const load = () => import("@/lib/demo/data/site-profiles");\n',
    };
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.join(root, relativePath);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content);
    }

    expect(collectArchitectureViolations(root)).toMatchObject([
      {
        rule: "production-demo-isolation",
        source: "src/lib/edge/admin/reports.ts",
        specifier: "@/lib/demo/data/site-profiles",
      },
    ]);
  });
});
