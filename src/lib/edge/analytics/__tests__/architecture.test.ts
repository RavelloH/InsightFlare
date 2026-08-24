import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const srcRoot = path.join(projectRoot, "src");
const edgeRoot = path.join(srcRoot, "lib", "edge");
const analyticsRoot = path.join(edgeRoot, "analytics");

function source(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function productionFiles(relativeDirectory: string): string[] {
  const directory = path.join(projectRoot, relativeDirectory);
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "__tests__") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (/\.(ts|tsx)$/u.test(entry.name)) files.push(fullPath);
    }
  };
  visit(directory);
  return files;
}

describe("analytics architecture", () => {
  it("keeps the canonical query layers in analytics", () => {
    for (const relativePath of [
      "contract/index.ts",
      "contract/operations/index.ts",
      "application/service.ts",
      "application/operation-registry.ts",
      "application/provider-registry.ts",
      "application/planner.ts",
      "application/cache.ts",
      "application/cost.ts",
      "application/errors.ts",
      "providers/d1/index.ts",
      "providers/realtime/index.ts",
      "providers/mock/index.ts",
      "adapters/api-v1.ts",
      "adapters/mock.ts",
      "adapters/private.ts",
      "adapters/public.ts",
      "adapters/ssr.ts",
      "composition/create-provider-registry.ts",
      "composition/create-query-service.ts",
      "index.ts",
    ]) {
      expect(existsSync(path.join(analyticsRoot, relativePath))).toBe(true);
    }

    for (const legacyDirectory of [
      "query",
      "query-adapters",
      "query-contract",
      "query-runtime",
    ]) {
      const directory = path.join(edgeRoot, legacyDirectory);
      if (existsSync(directory)) {
        expect(readdirSync(directory)).toHaveLength(0);
      }
    }
  });

  it("makes registries the only provider entry point", () => {
    const service = source("src/lib/edge/analytics/application/service.ts");
    const typedApplication = source(
      "src/lib/edge/analytics/contract/application.ts",
    );

    expect(service).toContain("readonly providerRegistry:");
    expect(service).not.toContain("readonly provider?:");
    expect(service).not.toMatch(/async\s+(overview|trend)\s*\(/u);
    expect(typedApplication).not.toContain(
      "(() => Promise<TypedQueryProviderResult",
    );
    expect(typedApplication).not.toContain(
      "reader: () => Promise<AnalyticsResult",
    );
  });

  it("routes every typed-query runtime through a registry", () => {
    const files = [
      ...productionFiles("src/lib/edge/analytics/providers"),
      path.join(projectRoot, "src/lib/dashboard/route-data.ts"),
    ];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      if (
        !content.includes("executeTypedApplicationOperation") &&
        !content.includes("executeTypedApplicationResult")
      ) {
        continue;
      }
      expect(content).toMatch(
        /create(?:TypedQuery(?:Result)?|SsrTeamDashboard)ProviderRegistry|new TypedQueryProviderRegistry/u,
      );
    }
  });

  it("keeps service consumers on the registry boundary", () => {
    for (const file of productionFiles("src/lib/api-v1")) {
      const content = readFileSync(file, "utf8");
      if (!content.includes("new TypedQueryApplicationService")) continue;
      expect(content).toMatch(
        /providerRegistry|TypedApplicationProviderRegistry/u,
      );
    }
    expect(source("src/lib/dashboard/route-data.ts")).toContain(
      "createSsrTeamDashboardProviderRegistry",
    );
    expect(source("src/lib/edge/analytics/adapters/mock.ts")).toContain(
      "createMockProviderRegistry",
    );
  });

  it("does not allow legacy query module imports", () => {
    const legacyImport =
      /@\/lib\/edge\/(?:query(?:-contract|-runtime|-adapters)?|realtime-provider)(?:["/])/u;
    for (const file of productionFiles("src/lib")) {
      expect(readFileSync(file, "utf8")).not.toMatch(legacyImport);
    }
  });
});
