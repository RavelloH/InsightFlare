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
      "interfaces/mock.ts",
      "interfaces/dashboard/private.ts",
      "interfaces/dashboard/public.ts",
      "interfaces/dashboard/protocol/overview.ts",
      "composition/site-realtime-providers.ts",
      "composition/mock-runtime.ts",
      "composition/comparison-query-providers.ts",
      "composition/site-runtime.ts",
      "composition/team-runtime.ts",
      "composition/edge-runtime.ts",
      "composition/d1/index.ts",
      "composition/d1/shared.ts",
      "composition/d1/overview.ts",
      "composition/d1/site.ts",
      "composition/d1/events.ts",
      "composition/d1/journeys.ts",
      "composition/d1/technology.ts",
      "composition/d1/funnels.ts",
      "composition/d1/goals.ts",
      "composition/d1/create-site-runtime.ts",
      "composition/d1/create-team-runtime.ts",
      "interfaces/dashboard/protocol/router.ts",
      "interfaces/dashboard/protocol/parsers.ts",
      "interfaces/dashboard/protocol/responses.ts",
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
    expect(
      existsSync(path.join(analyticsRoot, "composition", "d1-provider.ts")),
    ).toBe(false);
    const legacyDirectory = path.join(analyticsRoot, "composition", "legacy");
    if (existsSync(legacyDirectory)) {
      expect(readdirSync(legacyDirectory)).toHaveLength(0);
    }
    for (const file of productionFiles(
      "src/lib/edge/analytics/providers/d1/internal",
    )) {
      expect(file).not.toMatch(/-contract-adapter\.ts$/u);
    }
  });

  it("keeps provider registries behind the canonical query executor", () => {
    const service = source("src/lib/edge/analytics/application/service.ts");
    const registry = source(
      "src/lib/edge/analytics/application/provider-registry.ts",
    );
    const typedApplication = source(
      "src/lib/edge/analytics/application/typed-application.ts",
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
    const runtime = source(
      "src/lib/edge/analytics/composition/query-runtime.ts",
    );
    expect(runtime).not.toContain("readonly providerRegistry:");
    expect(service).toContain("providerRegistry.resolve");
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

  it("keeps API v1 consumers on the query executor boundary", () => {
    for (const file of productionFiles("src/lib/api-v1")) {
      const content = readFileSync(file, "utf8");
      expect(content, `${file} imports the provider registry`).not.toContain(
        "AnalyticsProviderRegistry",
      );
      expect(
        content,
        `${file} imports a concrete analytics provider`,
      ).not.toMatch(/analytics\/providers(?:\/|["'])/u);
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
      existsSync(
        path.join(analyticsRoot, "composition", "api-v1-provider-registry.ts"),
      ),
    ).toBe(false);
    const queryApplication = source(
      "src/lib/api-v1/analytics/query-application.ts",
    );
    expect(queryApplication).toContain("canonicalQueryOperationFor");
    expect(queryApplication).toContain("invocation.executor.execute");
    expect(queryApplication).not.toContain("AnalyticsProviderRegistry");
    expect(source("src/lib/dashboard/route-data.ts")).toContain(
      "createTeamDashboardQueryRuntime",
    );
    expect(source("src/lib/edge/analytics/interfaces/mock.ts")).toContain(
      "createMockAnalyticsQueryRuntime",
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
    for (const file of productionFiles("src/lib/edge/analytics/interfaces")) {
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

  it("keeps filter compilation behind the canonical application and dataset layers", () => {
    const boundaryFiles = [
      ...productionFiles("src/lib/api-v1"),
      ...productionFiles("src/lib/hono/routes"),
      ...productionFiles("src/lib/edge/analytics/interfaces"),
    ];
    for (const file of boundaryFiles) {
      const content = readFileSync(file, "utf8");
      expect(
        content,
        `${file} bypasses the canonical filter runtime`,
      ).not.toMatch(
        /(?:compileFilterDocument|buildVisitFilterSql|buildEventFilterSql|scopedDatasetFor|compileScopedDatasetSql|analytics\/providers\/d1\/internal\/(?:core-filters|scoped-dataset))/u,
      );
    }

    expect(source("src/lib/edge/analytics/application/service.ts")).toContain(
      "prepareScopedQuery",
    );
    expect(
      source("src/lib/edge/analytics/composition/query-runtime.ts"),
    ).toContain("createAnalyticsQueryApplicationService");
    expect(
      source("src/lib/edge/analytics/composition/query-application-service.ts"),
    ).toContain("TypedQueryApplicationService");
    expect(
      source("src/lib/edge/analytics/providers/d1/internal/scoped-dataset.ts"),
    ).toContain("planObservationFilter");

    const coreFilters = source(
      "src/lib/edge/analytics/providers/d1/internal/core-filters.ts",
    );
    for (const legacyMembershipSymbol of [
      "membershipSetSql",
      "buildEntityMembershipPredicate",
      "scope_universe",
    ]) {
      expect(
        coreFilters,
        `legacy membership implementation returned: ${legacyMembershipSymbol}`,
      ).not.toContain(legacyMembershipSymbol);
    }
  });

  it("does not reintroduce legacy D1 entity-membership SQL", () => {
    const legacyPatterns = [
      /membershipSetSql/u,
      /buildEntityMembershipPredicate/u,
      /fullEntityFilterCtes/u,
      /entityExpansionSql/u,
      /calculated_visits/u,
      /matched_entities/u,
      /matched_sessions/u,
      /matched_visitors/u,
      /scope_visit_source/u,
      /scope_event_source/u,
      /scope_set_/u,
      /scope_empty/u,
      /entity_membership/u,
    ];
    for (const file of productionFiles(
      "src/lib/edge/analytics/providers/d1/internal",
    )) {
      const content = readFileSync(file, "utf8");
      for (const pattern of legacyPatterns) {
        expect(
          content,
          `${file} reintroduced legacy entity-membership SQL: ${pattern}`,
        ).not.toMatch(pattern);
      }
    }
  });

  it("does not reintroduce the generic D1 provider barrel", () => {
    for (const file of productionFiles("src/lib")) {
      expect(readFileSync(file, "utf8")).not.toContain(
        "analytics/composition/d1-provider",
      );
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

  it("routes API v1 queries through complete site and team runtimes", () => {
    const siteRoutes = source("src/lib/hono/routes/v1/site-analytics.ts");
    const teamRoutes = source("src/lib/hono/routes/v1/team-analytics.ts");
    const edgeRuntime = source(
      "src/lib/edge/analytics/composition/edge-runtime.ts",
    );
    const siteRuntime = source(
      "src/lib/edge/analytics/composition/site-runtime.ts",
    );
    const teamRuntime = source(
      "src/lib/edge/analytics/composition/team-runtime.ts",
    );
    expect(siteRoutes).toContain("createEdgeSiteAnalyticsRuntime");
    expect(teamRoutes).toContain("createEdgeTeamAnalyticsRuntime");
    expect(edgeRuntime).toContain("createD1SiteProviderRegistry");
    expect(edgeRuntime).toContain("registerSiteRealtimeProviders");
    expect(edgeRuntime).toContain("registerComparisonQueryProviders");
    expect(siteRuntime).not.toMatch(/\bD1[A-Za-z]*Options\b/u);
    expect(teamRuntime).not.toMatch(/\bD1[A-Za-z]*Options\b/u);
    for (const content of [siteRoutes, teamRoutes]) {
      expect(content).not.toContain("providerRegistry");
      expect(content).not.toContain("AnalyticsProviderRegistry");
      expect(content).not.toContain("createApiV1ProviderRegistry");
      expect(content).not.toContain("createComparisonRuntime");
      expect(content).not.toMatch(/analytics\/providers(?:\/|["'])/u);
      expect(content).not.toContain("readSite");
      expect(content).not.toContain("readTeam");
    }
  });

  it("never selects canonical providers from API v1 audience", () => {
    const composition = productionFiles("src/lib/edge/analytics/composition")
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(composition).not.toMatch(
      /audience\s*===\s*["']api-v1["'][\s\S]{0,240}(?:provider|registry)|(?:provider|registry)[\s\S]{0,240}audience\s*===\s*["']api-v1["']/u,
    );
    expect(composition).not.toContain("queryMode");
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
    const runtime = productionFiles("src/lib/edge/analytics/composition/d1")
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(runtime).toContain("typedQueryProvider");
    expect(runtime).toContain('register("overview"');
    expect(runtime).toContain('register("trend"');
    expect(runtime).not.toContain("siteQueryContext");
    expect(runtime).not.toContain("assertOperationAllowed");
    expect(runtime).not.toContain("input.context");
  });

  it("keeps protocol adapters free of provider callbacks", () => {
    for (const file of productionFiles("src/lib/edge/analytics/interfaces")) {
      const content = readFileSync(file, "utf8");
      expect(content, `${file} creates a local query provider`).not.toMatch(
        /create\w*ProviderRegistry|new AnalyticsProviderRegistry|typedQueryProvider|executeTypedApplicationOperation/u,
      );
      expect(content, `${file} imports a concrete provider`).not.toMatch(
        /analytics\/providers(?:\/|["'])/u,
      );
    }
  });

  it("runs analytics-specific runtime boundary rules in the architecture check", () => {
    const checker = source("scripts/check-architecture.ts");
    for (const rule of [
      "analytics-provider-audience-selection",
      "analytics-untyped-query-variant",
      "api-v1-provider-registry",
      "api-v1-local-provider-selection",
      "analytics-interface-local-provider-registry",
      "analytics-interface-concrete-provider",
      "canonical-operation-map-missing-coverage-check",
      "canonical-query-index-signature",
      "analytics-interface-d1-definition-repository",
    ]) {
      expect(checker).toContain(rule);
    }
  });

  it("maps every canonical operation and keeps Goal/Funnel D1 repositories behind resources", () => {
    const operationMap = source(
      "src/lib/edge/analytics/contract/canonical-operation-map.ts",
    );
    expect(operationMap).toContain("CanonicalOperationMap");
    expect(operationMap).toMatch(
      /Exclude<\s*QueryOperation,\s*keyof CanonicalOperationMap\s*>/u,
    );
    expect(operationMap).toContain("AssertNever<MissingCanonicalOperations>");
    expect(operationMap).not.toMatch(
      /readonly\s*\[\s*key\s*:\s*string\s*\]\s*:\s*unknown/u,
    );

    for (const directory of [
      "src/lib/api-v1",
      "src/lib/edge/analytics/interfaces/dashboard",
    ]) {
      for (const file of productionFiles(directory)) {
        const content = readFileSync(file, "utf8");
        expect(
          content,
          `${file} imports a Goal/Funnel D1 repository`,
        ).not.toMatch(
          /(?:composition\/d1\/(?:goals|funnels)|providers\/d1\/(?:internal|resources)\/(?:goals|funnels))/u,
        );
      }
    }
  });

  it("registers every migrated site query operation in the D1 runtime", () => {
    const runtime = productionFiles("src/lib/edge/analytics/composition/d1")
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
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
      "goal-summary",
      "goal-timeseries",
      "share-trend",
      "radar",
      "cross-dimension",
    ]) {
      expect(runtime).toContain(`"${operation}"`);
    }
  });
});
