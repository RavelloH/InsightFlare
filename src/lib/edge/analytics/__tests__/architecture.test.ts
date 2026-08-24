import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { analyticsOperationRegistry } from "@/lib/edge/analytics/application/operation-registry";
import {
  API_V1_QUERY_OPERATION_MAP,
  canonicalQueryOperationFor,
} from "@/lib/edge/analytics/application/query-operation-map";

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
      "application/query-validation.ts",
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
      "composition/api-v1-provider-registry.ts",
      "composition/d1-site-query-runtime.ts",
      "composition/query-protocol.ts",
      "composition/query-runtime.ts",
      "composition/ssr-query-runtime.ts",
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
    expect(
      existsSync(
        path.join(analyticsRoot, "composition", "d1-contract-adapters.ts"),
      ),
    ).toBe(false);
  });

  it("makes registries the only provider entry point", () => {
    const service = source("src/lib/edge/analytics/application/service.ts");
    const registry = source(
      "src/lib/edge/analytics/application/provider-registry.ts",
    );
    const typedApplication = source(
      "src/lib/edge/analytics/contract/application.ts",
    );

    expect(registry).toContain("class AnalyticsProviderRegistry");
    expect(service).toContain("readonly providerRegistry:");
    expect(service).toContain('kind: "typed-query"');
    expect(service).not.toContain("AnalyticsOperationInvocation");
    expect(service).not.toMatch(/async\s+(overview|trend)\s*\(/u);
    expect(typedApplication).not.toContain(
      "(() => Promise<TypedQueryProviderResult",
    );
    expect(typedApplication).not.toContain(
      "reader: () => Promise<TypedQueryProviderResult",
    );
    expect(typedApplication).toContain("new TypedQueryApplicationService");
    expect(typedApplication).toContain(".execute(invocation)");
    expect(typedApplication).not.toContain("providerRegistry.resolve");
    expect(typedApplication).not.toContain("assertOperationAllowed");
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
        /create(?:TypedQuery(?:Result)?|SsrTeamDashboard)ProviderRegistry|createReaderProviderRegistry|createTeamDashboardQueryRuntime|new AnalyticsProviderRegistry/u,
      );
    }
  });

  it("keeps service consumers on the registry boundary", () => {
    for (const file of productionFiles("src/lib/api-v1")) {
      if (file.endsWith(`${path.sep}query-application.ts`)) continue;
      const content = readFileSync(file, "utf8");
      if (!content.includes("new TypedQueryApplicationService")) continue;
      expect(content).toMatch(
        /providerRegistry|createApiV1QueryApplicationAdapter/u,
      );
    }
    for (const file of productionFiles("src/lib/api-v1")) {
      expect(readFileSync(file, "utf8")).not.toContain(
        "createCallbackProviderRegistry",
      );
    }
    expect(source("src/lib/hono/routes/v1/index.ts")).toContain(
      "registerV1SiteAnalyticsRoutes",
    );
    expect(source("src/lib/hono/routes/v1/index.ts")).toContain(
      "registerV1TeamAnalyticsRoutes",
    );
    expect(
      source("src/lib/edge/analytics/composition/api-v1-provider-registry.ts"),
    ).toContain("canonicalQueryOperationFor");
    expect(source("src/lib/dashboard/route-data.ts")).toContain(
      "createTeamDashboardQueryRuntime",
    );
    expect(source("src/lib/edge/analytics/adapters/mock.ts")).toContain(
      "createMockProviderRegistry",
    );
  });

  it("maps every public API v1 operation to the canonical query vocabulary", () => {
    for (const descriptor of analyticsOperationRegistry) {
      expect(API_V1_QUERY_OPERATION_MAP[descriptor.id]).toBeDefined();
      expect(canonicalQueryOperationFor(descriptor.id)).toBe(
        API_V1_QUERY_OPERATION_MAP[descriptor.id],
      );
    }
  });

  it("does not allow legacy query module imports", () => {
    const legacyImport =
      /@\/lib\/edge\/(?:query(?:-contract|-runtime|-adapters)?|realtime-provider)(?:["/])/u;
    for (const file of productionFiles("src/lib")) {
      expect(readFileSync(file, "utf8")).not.toMatch(legacyImport);
    }
  });

  it("keeps protocol adapters and routes behind composition", () => {
    for (const file of productionFiles("src/lib/edge/analytics/adapters")) {
      const content = readFileSync(file, "utf8");
      expect(content).not.toMatch(
        /(?:@\/lib\/edge\/analytics\/providers|\.\.\/providers)(?:\/|["'])/u,
      );
      expect(content).not.toContain("composition/d1-contract-adapters");
      expect(content).not.toContain("assertOperationAllowed");
    }
    for (const directory of [
      "src/lib/hono/routes/private",
      "src/lib/hono/routes/public",
    ]) {
      for (const file of productionFiles(directory)) {
        const content = readFileSync(file, "utf8");
        expect(content).not.toMatch(
          /@\/lib\/edge\/analytics\/providers(?:\/|["'])/u,
        );
        expect(content).not.toContain("composition/d1-contract-adapters");
      }
    }
  });

  it("keeps the provider registry canonical", () => {
    const registry = source(
      "src/lib/edge/analytics/application/provider-registry.ts",
    );
    for (const legacySymbol of [
      "TypedApplicationProviderRegistry",
      "TypedQueryProviderRegistry",
      "AnalyticsOperationProvider",
      "registerQuery",
      "registerResult",
      "resolveResult",
      "resultMode",
      "queryProviders",
      "resultProviders",
    ]) {
      expect(registry).not.toMatch(new RegExp(`\\b${legacySymbol}\\b`, "u"));
    }
    expect(registry.match(/new Map/g)).toHaveLength(1);
    expect(registry).toMatch(/Map<\s*QueryOperation/u);
  });

  it("keeps API v1 provider assembly in composition", () => {
    for (const file of [
      "src/lib/hono/routes/v1/site-analytics.ts",
      "src/lib/hono/routes/v1/team-analytics.ts",
    ]) {
      const content = source(file);
      expect(content).toContain("createApiV1ProviderRegistry");
      expect(content).not.toContain("createReaderProviderRegistry");
      expect(content).not.toMatch(/analytics\/providers(?:\/|["'])/u);
      expect(content).not.toContain("readSite");
      expect(content).not.toContain("readTeam");
    }
  });

  it("keeps the D1 provider free of application policy context", () => {
    for (const file of productionFiles("src/lib/edge/analytics/providers/d1")) {
      const content = readFileSync(file, "utf8");
      for (const forbidden of [
        "QueryContext",
        "siteQueryContext",
        "teamQueryContext",
        "assertOperationAllowed",
        "assertFilterAudience",
        "validateTypedQueryFilters",
      ]) {
        expect(content, `${file} contains ${forbidden}`).not.toContain(
          forbidden,
        );
      }
    }
  });

  it("keeps site D1 composition on canonical query inputs", () => {
    const runtime = source(
      "src/lib/edge/analytics/composition/d1-site-query-runtime.ts",
    );
    expect(runtime).toContain("typedQueryProvider");
    expect(runtime).toContain('register("overview"');
    expect(runtime).toContain('register("trend"');
    expect(runtime).not.toContain("siteQueryContext");
    expect(runtime).not.toContain("assertOperationAllowed");
    expect(runtime).not.toContain("input.context");
  });

  it("keeps legacy protocol adapters free of provider callbacks", () => {
    for (const file of productionFiles(
      "src/lib/edge/analytics/composition/legacy",
    )) {
      const content = readFileSync(file, "utf8");
      expect(content, `${file} creates a local query provider`).not.toMatch(
        /createTypedQueryProviderRegistry|new AnalyticsProviderRegistry|typedQueryProvider|executeTypedApplicationOperation/u,
      );
    }
  });

  it("registers every migrated site query operation in the D1 runtime", () => {
    const runtime = source(
      "src/lib/edge/analytics/composition/d1-site-query-runtime.ts",
    );
    for (const operation of [
      "event-types",
      "event-summary",
      "event-trend",
      "event-records",
      "event-field-values",
      "event-fields",
      "event-context",
      "event-type-detail",
      "event-record-detail",
      "visitors",
      "sessions",
      "visitor-detail",
      "session-detail",
      "funnel-analysis",
      "share-trend",
      "radar",
      "cross-dimension",
    ]) {
      expect(runtime).toContain(`"${operation}"`);
    }
  });
});
