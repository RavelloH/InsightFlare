import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export interface ArchitectureViolation {
  readonly rule: string;
  readonly source: string;
  readonly specifier: string;
  readonly target: string;
  readonly line: number;
  readonly message: string;
}

interface ImportReference {
  readonly specifier: string;
  readonly line: number;
  readonly kind: "static" | "dynamic";
}

interface LegacyAllowlistEntry {
  readonly rule: string;
  readonly source: string;
  readonly specifier: string;
  readonly reason: string;
  readonly todo: string;
}

interface DemoDynamicImportEntry {
  readonly source: string;
  readonly specifier: string;
  readonly reason: string;
}

interface UnsafeDatabaseImportEntry {
  readonly source: string;
  readonly specifier: string;
  readonly reason: string;
}

// Keep this list exact: each exception identifies one existing import and has
// a removal task. New imports cannot inherit an exception from the same file.
const LEGACY_ALLOWLIST: readonly LegacyAllowlistEntry[] = [
  {
    rule: "edge-ui-isolation",
    source: "src/lib/notifications/edge/email-renderer.tsx",
    specifier: "react",
    reason:
      "Notification delivery currently uses React to preserve its existing email markup.",
    todo: "Replace email SSR with behavior-equivalent Edge-safe rendering.",
  },
  {
    rule: "edge-ui-isolation",
    source: "src/lib/notifications/edge/email-renderer.tsx",
    specifier: "react-dom/server",
    reason:
      "Notification delivery currently uses React to preserve its existing email markup.",
    todo: "Replace email SSR with behavior-equivalent Edge-safe rendering.",
  },
  {
    rule: "edge-ui-isolation",
    source: "src/lib/notifications/edge/email-renderer.tsx",
    specifier: "@/components/email/notification-email",
    reason:
      "Notification delivery currently uses React to preserve its existing email markup.",
    todo: "Replace email SSR with behavior-equivalent Edge-safe rendering.",
  },
];

// These imports are reached only from explicit demo-build branches. Keep the
// exception exact so new Edge-to-Demo dependencies still fail the check.
const DEMO_DYNAMIC_IMPORT_ALLOWLIST: readonly DemoDynamicImportEntry[] = [
  {
    source: "src/lib/edge/auth/site-access.ts",
    specifier: "@/lib/demo/data/site-profiles",
    reason: "Private-site lookup is selected only in the demo build branch.",
  },
  {
    source: "src/lib/edge/admin/service/index.ts",
    specifier: "@/lib/demo/admin/service",
    reason:
      "Admin service dispatches to Demo only when VITE_DEMO_MODE is enabled.",
  },
];

// Add only exact operational adapters here. Application services and request
// handlers must use the typed database client instead of the raw escape hatch.
const UNSAFE_DATABASE_IMPORT_ALLOWLIST: readonly UnsafeDatabaseImportEntry[] =
  [];

const FORBIDDEN_TOP_LEVEL_FILE_PREFIXES = [
  "admin-",
  "ingest-",
  "client-",
  "filter-",
  "demo-",
] as const;

const LEGACY_PREFIX_FILES = new Set<string>();

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"];
const RUNTIME_BOUNDARY_PACKAGES = [
  "react",
  "react-dom",
  "hono",
  "@tanstack/react-router",
  "@tanstack/router-core",
] as const;

function slash(value: string): string {
  return value.replaceAll("\\", "/");
}

function isWithin(file: string, directory: string): boolean {
  return file === directory || file.startsWith(`${directory}/`);
}

function runtimeBoundaryPackageTarget(specifier: string): string | null {
  const packageName = RUNTIME_BOUNDARY_PACKAGES.find(
    (candidate) =>
      specifier === candidate || specifier.startsWith(`${candidate}/`),
  );
  return packageName ? `__package__:${packageName}` : null;
}

function walk(directory: string): string[] {
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (
      entry.isFile() &&
      SOURCE_EXTENSIONS.includes(path.extname(entry.name))
    )
      files.push(absolute);
  }
  return files;
}

export function isGeneratedFile(
  relativePath: string,
  sourceText: string,
): boolean {
  const normalized = slash(relativePath).toLowerCase();
  if (
    normalized.split("/").includes("generated") ||
    /(?:^|[.-])(?:generated|gen)\.[^.]+$/.test(normalized)
  )
    return true;
  return /(?:@generated|automatically generated|generated file|generated (?:from|by)|do not edit.*generated)/i.test(
    sourceText.slice(0, 1200),
  );
}

function typedDalConvergenceViolations(
  relativePath: string,
  sourceText: string,
): ArchitectureViolation[] {
  if (
    !isWithin(relativePath, "src/lib/notifications/edge") &&
    relativePath !==
      "src/lib/edge/analytics/interfaces/dashboard/saved-filters.ts"
  )
    return [];

  const source = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations: ArchitectureViolation[] = [];
  const forbidden = new Set(["createDatabaseRuntime", "DatabaseStatement"]);
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && forbidden.has(node.text)) {
      const line =
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      violations.push({
        rule: "typed-dal-runtime-forbidden",
        source: relativePath,
        specifier: node.text,
        target: relativePath,
        line,
        message:
          "This module must use the typed D1 client and must not reference createDatabaseRuntime or DatabaseStatement.",
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

function importsIn(sourceText: string, fileName: string): ImportReference[] {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports: ImportReference[] = [];
  const push = (
    specifier: ts.Expression,
    node: ts.Node,
    kind: ImportReference["kind"],
  ) => {
    if (ts.isStringLiteralLike(specifier)) {
      imports.push({
        specifier: specifier.text,
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        kind,
      });
    }
  };

  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isExportDeclaration(statement)
    ) {
      if (statement.moduleSpecifier)
        push(statement.moduleSpecifier, statement, "static");
    }
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    )
      push(node.arguments[0]!, node, "dynamic");
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

function resolveInternalImport(
  root: string,
  sourceAbsolute: string,
  specifier: string,
): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.join(root, "src", specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(sourceAbsolute), specifier);
  } else {
    return null;
  }

  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) =>
      path.join(base, `index${extension}`),
    ),
  ];
  const resolved = candidates.find((candidate) =>
    statSync(candidate, { throwIfNoEntry: false })?.isFile(),
  );
  if (resolved) return slash(path.relative(root, resolved));

  // Only report an unresolved project alias. Relative imports to non-source
  // assets (CSS, JSON, images) are outside this check's scope.
  return specifier.startsWith("@/")
    ? `__unresolved__/${specifier.slice(2)}`
    : null;
}

function ruleViolations(
  source: string,
  target: string,
): Array<Pick<ArchitectureViolation, "rule" | "message">> {
  const findings: Array<Pick<ArchitectureViolation, "rule" | "message">> = [];
  const analytics = "src/lib/edge/analytics";
  const analyticsLayer = (layer: string) =>
    isWithin(target, `${analytics}/${layer}`);
  const targetDashboard =
    isWithin(target, "src/lib/dashboard") ||
    isWithin(target, "src/components/dashboard");
  const sourceDashboard =
    isWithin(source, "src/lib/dashboard") ||
    isWithin(source, "src/components/dashboard");
  const apiV1 = isWithin(target, "src/lib/api-v1");
  const edgeImplementation =
    isWithin(target, "src/lib/edge") &&
    !isWithin(target, `${analytics}/contract`) &&
    !isWithin(target, `${analytics}/application`);
  const provider = isWithin(target, `${analytics}/providers`);
  const interfaceLayer = isWithin(target, `${analytics}/interfaces`);
  const composition = isWithin(target, `${analytics}/composition`);
  const hono = isWithin(target, "src/lib/hono");
  const ui = isWithin(target, "src/components");
  const reactRuntime =
    target === "__package__:react" || target === "__package__:react-dom";
  const routerRuntime =
    target === "__package__:@tanstack/react-router" ||
    target === "__package__:@tanstack/router-core";
  const honoRuntime = target === "__package__:hono";
  const databaseFoundation = [
    "src/lib/db/schema",
    "src/lib/db/query",
    "src/lib/db/mutation",
    "src/lib/db/sql",
  ].some((directory) => isWithin(source, directory));

  if (
    databaseFoundation &&
    (isWithin(target, "src/lib/edge") ||
      isWithin(target, "src/lib/analytics") ||
      isWithin(target, "src/lib/dashboard") ||
      isWithin(target, "src/lib/hono") ||
      isWithin(target, "src/components") ||
      honoRuntime ||
      reactRuntime ||
      routerRuntime)
  )
    findings.push({
      rule: "database-foundation-isolation",
      message:
        "Database schema, query, mutation, and SQL compiler modules must remain independent of Edge, Analytics, Dashboard, Hono, and React runtime modules.",
    });

  if (isWithin(source, `${analytics}/contract`)) {
    if (
      analyticsLayer("application") ||
      provider ||
      interfaceLayer ||
      composition ||
      targetDashboard ||
      apiV1 ||
      hono ||
      ui ||
      reactRuntime ||
      routerRuntime ||
      honoRuntime ||
      edgeImplementation ||
      isWithin(target, "src/tracker")
    )
      findings.push({
        rule: "analytics-contract-direction",
        message:
          "Analytics contract must stay independent of application, interfaces, providers, composition, API v1, Dashboard, HTTP, and UI.",
      });
  }

  if (isWithin(source, `${analytics}/application`)) {
    if (
      interfaceLayer ||
      composition ||
      provider ||
      apiV1 ||
      hono ||
      targetDashboard ||
      ui ||
      reactRuntime ||
      routerRuntime ||
      honoRuntime ||
      edgeImplementation ||
      isWithin(target, "src/tracker")
    )
      findings.push({
        rule: "analytics-application-direction",
        message:
          "Analytics application may depend on the contract, not interfaces, composition, API v1, Hono, Dashboard, UI, or concrete providers.",
      });
  }

  if (isWithin(source, `${analytics}/providers`)) {
    if (
      targetDashboard ||
      apiV1 ||
      interfaceLayer ||
      composition ||
      hono ||
      ui ||
      reactRuntime ||
      routerRuntime ||
      honoRuntime ||
      isWithin(target, "src/tracker")
    )
      findings.push({
        rule: "analytics-provider-direction",
        message:
          "Analytics providers must not depend on Dashboard, API v1, inbound interfaces, UI, or Tracker.",
      });
  }

  if (
    isWithin(source, "src/lib/api-v1/analytics") ||
    isWithin(source, "src/lib/api-v1")
  ) {
    if (isWithin(target, `${analytics}/application/provider-registry`))
      findings.push({
        rule: "api-v1-provider-registry",
        message:
          "API v1 must execute canonical queries through the Analytics runtime instead of importing its provider registry.",
      });
    if (provider)
      findings.push({
        rule: "api-v1-concrete-provider",
        message:
          "API v1 must use Analytics composition/application boundaries instead of concrete provider modules.",
      });
  }

  if (isWithin(source, `${analytics}/interfaces`) && provider)
    findings.push({
      rule: "analytics-interface-concrete-provider",
      message:
        "Analytics interfaces must use the runtime boundary; concrete source selection belongs in composition.",
    });

  if (sourceDashboard && provider)
    findings.push({
      rule: "dashboard-concrete-provider",
      message:
        "Dashboard must use the Analytics runtime boundary instead of concrete providers.",
    });

  if (isWithin(source, "src/tracker")) {
    if (
      targetDashboard ||
      isWithin(target, "src/lib/edge") ||
      reactRuntime ||
      routerRuntime ||
      honoRuntime
    )
      findings.push({
        rule: "tracker-runtime-isolation",
        message:
          "Tracker must not depend on Dashboard or Edge runtime implementation.",
      });
  }

  const sharedDomainRoots = [
    "src/lib/auth",
    "src/lib/blocking",
    "src/lib/filter-contract",
    "src/lib/notifications",
  ];
  const sourceSharedDomain = sharedDomainRoots.some(
    (directory) =>
      isWithin(source, directory) &&
      !(
        directory === "src/lib/notifications" &&
        isWithin(source, "src/lib/notifications/edge")
      ),
  );
  if (
    sourceSharedDomain &&
    (isWithin(target, "src/lib/edge") ||
      ui ||
      reactRuntime ||
      routerRuntime ||
      honoRuntime)
  )
    findings.push({
      rule: "shared-domain-runtime-isolation",
      message:
        "Shared domain modules must remain independent of Edge, React UI, Router, and Hono runtime implementations.",
    });

  if (
    isWithin(source, "src/lib/edge") ||
    isWithin(source, "src/lib/notifications/edge")
  ) {
    if (ui || reactRuntime || routerRuntime)
      findings.push({
        rule: "edge-ui-isolation",
        message: "Edge implementation must not depend on React UI.",
      });
    if (
      isWithin(source, "src/lib/edge") &&
      !isWithin(source, `${analytics}/providers/mock`) &&
      isWithin(target, "src/lib/demo")
    )
      findings.push({
        rule: "production-demo-isolation",
        message:
          "Production Edge code must not depend on Demo or mock implementations.",
      });
  }

  return findings;
}

function isAllowlisted(violation: ArchitectureViolation): boolean {
  return LEGACY_ALLOWLIST.some(
    (entry) =>
      entry.rule === violation.rule &&
      entry.source === violation.source &&
      entry.specifier === violation.specifier &&
      entry.reason.trim().length > 0 &&
      entry.todo.trim().length > 0,
  );
}

function isAllowlistedDemoDynamicImport(
  source: string,
  specifier: string,
): boolean {
  return DEMO_DYNAMIC_IMPORT_ALLOWLIST.some(
    (entry) =>
      entry.source === source &&
      entry.specifier === specifier &&
      entry.reason.trim().length > 0,
  );
}

function isAllowedUnsafeDatabaseImport(
  source: string,
  specifier: string,
): boolean {
  if (
    isWithin(source, "src/lib/db") ||
    isWithin(source, "src/lib/edge/analytics")
  )
    return true;
  return UNSAFE_DATABASE_IMPORT_ALLOWLIST.some(
    (entry) =>
      entry.source === source &&
      entry.specifier === specifier &&
      entry.reason.trim().length > 0,
  );
}

export function detectForbiddenPrefixFiles(
  relativePaths: readonly string[],
): string[] {
  const candidates = relativePaths.map(slash).flatMap((file) => {
    if (LEGACY_PREFIX_FILES.has(file)) return [];
    if (isWithin(file, "src/lib/edge")) {
      const name = file.slice("src/lib/edge/".length);
      if (name.includes("/")) return [];
      const prefix = ["admin-", "ingest-", "scheduled-task-"].find(
        (candidate) => name.startsWith(candidate),
      );
      return prefix ? [{ file, family: `edge:${prefix}` }] : [];
    }
    if (isWithin(file, "src/lib/dashboard")) {
      const name = file.slice("src/lib/dashboard/".length);
      if (name.includes("/")) return [];
      const prefix = ["client-", "server-"].find((candidate) =>
        name.startsWith(candidate),
      );
      return prefix ? [{ file, family: `dashboard:${prefix}` }] : [];
    }
    if (!isWithin(file, "src/lib")) return [];
    const name = file.slice("src/lib/".length);
    if (name.includes("/")) return [];
    const prefix = FORBIDDEN_TOP_LEVEL_FILE_PREFIXES.find((candidate) =>
      name.startsWith(candidate),
    );
    return prefix ? [{ file, family: `lib:${prefix}` }] : [];
  });
  const familyCounts = new Map<string, number>();
  for (const candidate of candidates) {
    familyCounts.set(
      candidate.family,
      (familyCounts.get(candidate.family) ?? 0) + 1,
    );
  }
  return candidates
    .filter((candidate) => familyCounts.get(candidate.family)! >= 3)
    .map(({ file }) => file)
    .sort();
}

export function collectArchitectureViolations(
  rootDirectory = process.cwd(),
): ArchitectureViolation[] {
  const root = path.resolve(rootDirectory);
  const sourceRoot = path.join(root, "src");
  const violations: ArchitectureViolation[] = [];

  for (const absolute of walk(sourceRoot)) {
    const relative = slash(path.relative(root, absolute));
    if (
      relative
        .split("/")
        .some((part) => part === "__tests__" || part === "generated") ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative)
    )
      continue;
    const sourceText = readFileSync(absolute, "utf8");
    if (isGeneratedFile(relative, sourceText)) continue;

    violations.push(...typedDalConvergenceViolations(relative, sourceText));

    const addSourceRuleViolation = (
      rule: string,
      pattern: RegExp,
      message: string,
    ) => {
      const match = pattern.exec(sourceText);
      if (match?.index === undefined) return;
      violations.push({
        rule,
        source: relative,
        specifier: "<source text>",
        target: relative,
        line: sourceText.slice(0, match.index).split(/\r?\n/u).length,
        message,
      });
    };

    if (isWithin(relative, "src/lib/api-v1")) {
      addSourceRuleViolation(
        "api-v1-provider-registry",
        /\bAnalyticsProviderRegistry\b/u,
        "API v1 must use the Analytics query executor and must not reference AnalyticsProviderRegistry.",
      );
      addSourceRuleViolation(
        "api-v1-local-provider-selection",
        /\b(?:create\w*ProviderRegistry|typedQueryProvider)\b/u,
        "API v1 must not assemble provider registries or select concrete providers.",
      );
    }

    if (isWithin(relative, "src/lib/edge/analytics/interfaces")) {
      addSourceRuleViolation(
        "analytics-interface-local-provider-registry",
        /\b(?:create\w*ProviderRegistry|new\s+AnalyticsProviderRegistry|typedQueryProvider)\b/u,
        "Analytics interfaces must not create provider registries; source selection belongs in composition.",
      );
    }

    if (isWithin(relative, "src/lib/edge/analytics/composition")) {
      addSourceRuleViolation(
        "analytics-provider-audience-selection",
        /audience\s*===\s*["']api-v1["'][\s\S]{0,240}(?:provider|registry)|(?:provider|registry)[\s\S]{0,240}audience\s*===\s*["']api-v1["']/u,
        "Canonical provider selection must not depend on the API v1 audience.",
      );
      addSourceRuleViolation(
        "analytics-untyped-query-variant",
        /\bqueryMode\b/u,
        "Canonical operation variants must use their typed mode contract instead of queryMode.",
      );
    }

    if (
      relative === "src/lib/edge/analytics/contract/canonical-operation-map.ts"
    ) {
      if (
        !/Exclude<\s*QueryOperation,\s*keyof CanonicalOperationMap\s*>/u.test(
          sourceText,
        ) ||
        !/AssertNever<MissingCanonicalOperations>/u.test(sourceText)
      ) {
        violations.push({
          rule: "canonical-operation-map-missing-coverage-check",
          source: relative,
          specifier: "<source text>",
          target: relative,
          line: 1,
          message:
            "CanonicalOperationMap must assert that every QueryOperation is mapped.",
        });
      }
      addSourceRuleViolation(
        "canonical-query-index-signature",
        /readonly\s*\[\s*key\s*:\s*string\s*\]\s*:\s*unknown/u,
        "Canonical operation queries must use declared fields instead of an unknown index signature.",
      );
    }

    for (const imported of importsIn(sourceText, absolute)) {
      const resolved = resolveInternalImport(
        root,
        absolute,
        imported.specifier,
      );
      if (!resolved) {
        const packageTarget = runtimeBoundaryPackageTarget(imported.specifier);
        if (packageTarget) {
          const source = relative;
          const target = packageTarget;
          for (const finding of ruleViolations(source, target))
            violations.push({
              ...finding,
              source,
              target,
              specifier: imported.specifier,
              line: imported.line,
            });
        }
        continue;
      }
      if (resolved.startsWith("__unresolved__/")) {
        violations.push({
          rule: "unresolved-internal-import",
          source: relative,
          specifier: imported.specifier,
          target: resolved,
          line: imported.line,
          message: "Project alias does not resolve to a source module.",
        });
        continue;
      }
      if (
        resolved === "src/lib/db/unsafe.ts" &&
        !isAllowedUnsafeDatabaseImport(relative, imported.specifier)
      ) {
        violations.push({
          rule: "unsafe-database-import-boundary",
          source: relative,
          specifier: imported.specifier,
          target: resolved,
          line: imported.line,
          message:
            "Raw SQL helpers are limited to database internals, Analytics SQL adapters, and explicitly registered infrastructure adapters.",
        });
      }
      if (
        (isWithin(relative, "src/lib/api-v1") ||
          isWithin(relative, "src/lib/edge/analytics/interfaces/dashboard")) &&
        /src\/lib\/edge\/analytics\/(?:composition\/d1\/(?:goals|funnels)|providers\/d1\/(?:internal|resources)\/(?:goals|funnels))/u.test(
          resolved,
        )
      ) {
        violations.push({
          rule: "analytics-interface-d1-definition-repository",
          source: relative,
          specifier: imported.specifier,
          target: resolved,
          line: imported.line,
          message:
            "API v1 and Dashboard interfaces must access Goal/Funnel definitions through analytics resources composed by the runtime.",
        });
      }
      for (const finding of ruleViolations(relative, resolved)) {
        if (
          finding.rule === "production-demo-isolation" &&
          imported.kind === "dynamic" &&
          isAllowlistedDemoDynamicImport(relative, imported.specifier)
        )
          continue;
        violations.push({
          ...finding,
          source: relative,
          target: resolved,
          specifier: imported.specifier,
          line: imported.line,
        });
      }
    }
  }

  return violations.sort((left, right) =>
    `${left.source}:${left.line}:${left.rule}`.localeCompare(
      `${right.source}:${right.line}:${right.rule}`,
    ),
  );
}

function sourceFilesForDirectD1Scan(root: string): string[] {
  return walk(path.join(root, "src")).filter((absolute) => {
    const relative = slash(path.relative(root, absolute));
    return (
      !isWithin(relative, "src/lib/db") &&
      !relative
        .split("/")
        .some((part) => part === "__tests__" || part === "tests") &&
      !/\.(?:test|spec)\.[^.]+$/u.test(relative) &&
      !isGeneratedFile(relative, readFileSync(absolute, "utf8"))
    );
  });
}

function d1DatabaseAliases(source: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  const isDatabaseExpression = (expression: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(expression))
      return isDatabaseExpression(expression.expression);
    if (ts.isAsExpression(expression) || ts.isNonNullExpression(expression))
      return isDatabaseExpression(expression.expression);
    if (ts.isIdentifier(expression)) return aliases.has(expression.text);
    if (
      ts.isPropertyAccessExpression(expression) &&
      expression.name.text === "DB"
    )
      return true;
    if (
      ts.isElementAccessExpression(expression) &&
      expression.argumentExpression &&
      ts.isStringLiteralLike(expression.argumentExpression) &&
      expression.argumentExpression.text === "DB"
    )
      return true;
    return false;
  };

  const collect = () => {
    let changed = false;
    const visit = (node: ts.Node) => {
      if (ts.isParameter(node) && node.type) {
        const typeText = node.type.getText(source);
        if (/\bD1Database(?:Session)?\b/u.test(typeText)) {
          if (ts.isIdentifier(node.name) && !aliases.has(node.name.text)) {
            aliases.add(node.name.text);
            changed = true;
          }
        }
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (
          ts.isIdentifier(node.name) &&
          isDatabaseExpression(node.initializer) &&
          !aliases.has(node.name.text)
        ) {
          aliases.add(node.name.text);
          changed = true;
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const propertyName = element.propertyName ?? element.name;
            if (
              ts.isIdentifier(propertyName) &&
              propertyName.text === "DB" &&
              ts.isIdentifier(element.name) &&
              !aliases.has(element.name.text)
            ) {
              aliases.add(element.name.text);
              changed = true;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return changed;
  };
  while (collect()) {
    // Resolve short local alias chains such as `const database = db`.
  }
  return aliases;
}

function directD1Accesses(root: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const absolute of sourceFilesForDirectD1Scan(root)) {
    const relative = slash(path.relative(root, absolute));
    const sourceText = readFileSync(absolute, "utf8");
    const source = ts.createSourceFile(
      absolute,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      absolute.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const aliases = d1DatabaseAliases(source);
    const isDatabaseExpression = (expression: ts.Expression): boolean => {
      if (ts.isParenthesizedExpression(expression))
        return isDatabaseExpression(expression.expression);
      if (ts.isAsExpression(expression) || ts.isNonNullExpression(expression))
        return isDatabaseExpression(expression.expression);
      if (ts.isIdentifier(expression)) return aliases.has(expression.text);
      if (
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "DB"
      )
        return true;
      if (
        ts.isElementAccessExpression(expression) &&
        expression.argumentExpression &&
        ts.isStringLiteralLike(expression.argumentExpression) &&
        expression.argumentExpression.text === "DB"
      )
        return true;
      return false;
    };
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const name = ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : ts.isElementAccessExpression(expression) &&
              expression.argumentExpression &&
              ts.isStringLiteralLike(expression.argumentExpression)
            ? expression.argumentExpression.text
            : null;
        const receiver =
          ts.isPropertyAccessExpression(expression) ||
          ts.isElementAccessExpression(expression)
            ? expression.expression
            : null;
        if (
          receiver &&
          (name === "prepare" || name === "batch" || name === "exec") &&
          isDatabaseExpression(receiver)
        ) {
          counts.set(relative, (counts.get(relative) ?? 0) + 1);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return counts;
}

export function directD1AccessViolations(
  rootDirectory = process.cwd(),
): ArchitectureViolation[] {
  const root = path.resolve(rootDirectory);
  const actual = directD1Accesses(root);
  const violations: ArchitectureViolation[] = [];

  for (const [source, count] of actual) {
    violations.push({
      rule: "direct-d1-access-forbidden",
      source,
      specifier: "DB.prepare/batch/exec",
      target: source,
      line: 1,
      message: `${count} direct D1 access(es) remain outside src/lib/db; route them through DatabaseRuntime.`,
    });
  }
  return violations;
}

function legacyBaselineFileViolations(root: string): ArchitectureViolation[] {
  const baselinePath = path.join(
    root,
    "scripts/direct-d1-access-baseline.json",
  );
  if (statSync(baselinePath, { throwIfNoEntry: false })?.isFile()) {
    return [
      {
        rule: "direct-d1-access-baseline-forbidden",
        source: "scripts/direct-d1-access-baseline.json",
        specifier: "legacy baseline",
        target: "scripts/direct-d1-access-baseline.json",
        line: 1,
        message:
          "Remove the legacy direct-D1 baseline; all direct D1 access is forbidden.",
      },
    ];
  }
  return [];
}

function printFileSizeWarnings(root: string): void {
  for (const absolute of walk(path.join(root, "src"))) {
    const relative = slash(path.relative(root, absolute));
    if (
      relative
        .split("/")
        .some((part) => part === "__tests__" || part === "generated")
    )
      continue;
    const sourceText = readFileSync(absolute, "utf8");
    if (isGeneratedFile(relative, sourceText)) continue;
    const size = statSync(absolute).size;
    if (size < 20 * 1024) continue;
    const level =
      size >= 60 * 1024
        ? "review required"
        : size >= 40 * 1024
          ? "structural review"
          : "assess splitting";
    console.warn(
      `Architecture size warning (${level}): ${relative} is ${(size / 1024).toFixed(1)} KiB`,
    );
  }
}

export function runArchitectureCheck(rootDirectory = process.cwd()): number {
  const root = path.resolve(rootDirectory);
  const violations = [
    ...collectArchitectureViolations(root),
    ...directD1AccessViolations(root),
    ...legacyBaselineFileViolations(root),
  ];
  const errors = violations.filter((violation) => !isAllowlisted(violation));
  const legacy = violations.filter(isAllowlisted);
  const prefixFiles = detectForbiddenPrefixFiles(
    walk(path.join(root, "src", "lib")).map((file) =>
      slash(path.relative(root, file)),
    ),
  );

  printFileSizeWarnings(root);
  for (const violation of legacy)
    console.warn(
      `Legacy architecture exception: ${violation.source}:${violation.line} -> ${violation.specifier} (${violation.rule}); remove it per its allowlist TODO.`,
    );
  for (const violation of errors)
    console.error(
      `Architecture violation ${violation.rule}: ${violation.source}:${violation.line} -> ${violation.specifier}: ${violation.message}`,
    );
  for (const file of prefixFiles)
    console.error(
      `Architecture violation forbidden-prefix-file: ${file}: new top-level lib files must be grouped by subsystem.`,
    );

  if (errors.length || prefixFiles.length) {
    console.error(
      `Architecture check failed: ${errors.length} new/unallowlisted boundary violation(s), ${prefixFiles.length} forbidden prefix file(s).`,
    );
    return 1;
  }
  console.log(
    `Architecture check passed (${legacy.length} exact legacy exception(s)).`,
  );
  return 0;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry && fileURLToPath(import.meta.url) === entry) {
  process.exitCode = runArchitectureCheck();
}
