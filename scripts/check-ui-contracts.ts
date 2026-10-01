import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

const root = process.cwd();
const uiContractsDirectory = path.join(root, "packages/ui/src/components/ui");
const productContractsDirectory = path.join(root, "packages/product-ui/src");
const registryPath = path.join(root, "src/components/ui-gallery/registry.ts");

function contractFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return contractFiles(absolute);
    return entry.name.endsWith(".contract.tsx") ? [absolute] : [];
  });
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

const sourceFiles = [
  ...contractFiles(uiContractsDirectory),
  ...contractFiles(productContractsDirectory),
];
const contractIds: string[] = [];
const fixtureIds: string[] = [];
const issues: string[] = [];
function stringProperty(
  object: ts.ObjectLiteralExpression,
  propertyName: string,
): string | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    const resolvedName =
      ts.isIdentifier(name) || ts.isStringLiteralLike(name)
        ? name.text
        : undefined;
    if (
      resolvedName === propertyName &&
      ts.isStringLiteralLike(property.initializer)
    ) {
      return property.initializer.text;
    }
  }
  return undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function fixtureArrayIds(expression: ts.Expression): string[] {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isArrayLiteralExpression(unwrapped)) return [];
  return unwrapped.elements.flatMap((element) => {
    if (!ts.isObjectLiteralExpression(element)) return [];
    const id = stringProperty(element, "id");
    return id ? [id] : [];
  });
}

function contractData(
  sourcePath: string,
  source: string,
): {
  contractIds: string[];
  fixtureIds: string[];
} {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const fixturesByName = new Map<string, string[]>();
  const contractIds: string[] = [];
  const fixtureIds: string[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        !ts.isArrayLiteralExpression(unwrapExpression(declaration.initializer))
      ) {
        continue;
      }
      fixturesByName.set(
        declaration.name.text,
        fixtureArrayIds(declaration.initializer),
      );
    }
  }

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineComponentContract" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const definition = node.arguments[0];
      const id = stringProperty(definition, "id");
      if (id) contractIds.push(id);
      for (const property of definition.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          !ts.isIdentifier(property.name) ||
          property.name.text !== "fixtures"
        ) {
          continue;
        }
        const initializer = property.initializer;
        if (ts.isIdentifier(initializer)) {
          fixtureIds.push(...(fixturesByName.get(initializer.text) ?? []));
        } else {
          fixtureIds.push(...fixtureArrayIds(initializer));
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { contractIds, fixtureIds };
}

for (const sourcePath of sourceFiles) {
  const source = readFileSync(sourcePath, "utf8");
  if (/Math\.random\s*\(|Date\.now\s*\(|new Date\s*\(\s*\)/u.test(source)) {
    issues.push(
      `Non-deterministic value in component contract: ${path.relative(root, sourcePath)}`,
    );
  }
  const data = contractData(sourcePath, source);
  contractIds.push(...data.contractIds);
  fixtureIds.push(...data.fixtureIds);
}

const registry = readFileSync(registryPath, "utf8");
const slugs = [...registry.matchAll(/\bslug:\s*["']([^"']+)["']/gu)].map(
  (match) => match[1],
);
const uiPackage = JSON.parse(
  readFileSync(path.join(root, "packages/ui/package.json"), "utf8"),
) as { exports: Record<string, unknown> };
const productPackage = JSON.parse(
  readFileSync(path.join(root, "packages/product-ui/package.json"), "utf8"),
) as { exports: Record<string, unknown> };
const publicComponentSubpaths = Object.keys(uiPackage.exports)
  .filter((entry) => entry.startsWith("./"))
  .map((entry) => entry.slice(2))
  .filter(
    (entry) =>
      entry !== "styles.css" &&
      entry !== "contracts" &&
      entry !== "layer-manager" &&
      entry !== "layer-portal" &&
      entry !== "use-mobile",
  );
const productComponentSubpaths = Object.keys(productPackage.exports)
  .filter((entry) => entry.startsWith("./"))
  .map((entry) => entry.slice(2))
  .filter((entry) => entry !== "styles.css" && entry !== "tabbed-table");

const registrySource = ts.createSourceFile(
  registryPath,
  registry,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const productContractImports: Array<{ binding: string; subpath: string }> = [];
for (const statement of registrySource.statements) {
  if (!ts.isImportDeclaration(statement)) continue;
  if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
  const match = statement.moduleSpecifier.text.match(
    /^@insightflare\/product-ui\/(.+)$/u,
  );
  if (!match || !statement.importClause?.namedBindings) continue;
  const bindings = statement.importClause.namedBindings;
  if (!ts.isNamedImports(bindings)) continue;
  for (const element of bindings.elements) {
    productContractImports.push({
      binding: element.name.text,
      subpath: match[1],
    });
  }
}

function variableInitializer(name: string): ts.Expression | undefined {
  for (const statement of registrySource.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration.initializer;
      }
    }
  }
  return undefined;
}

function propertyName(
  property: ts.ObjectLiteralElementLike,
): string | undefined {
  if (!("name" in property) || !property.name) return undefined;
  return ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
    ? property.name.text
    : undefined;
}

const galleryContractBindings = new Map<string, string>();
const galleryContractsInitializer = variableInitializer("galleryContracts");
if (galleryContractsInitializer) {
  const contracts = unwrapExpression(galleryContractsInitializer);
  if (ts.isObjectLiteralExpression(contracts)) {
    for (const property of contracts.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = propertyName(property);
      const initializer = unwrapExpression(property.initializer);
      if (
        key &&
        ts.isCallExpression(initializer) &&
        initializer.arguments[0] &&
        ts.isIdentifier(initializer.arguments[0])
      ) {
        galleryContractBindings.set(key, initializer.arguments[0].text);
      }
    }
  }
}

const productGalleryEntries: Array<{
  slug: string;
  subpath: string;
  contractBinding: string | undefined;
}> = [];
const galleryRegistryInitializer = variableInitializer("uiGalleryRegistry");
if (galleryRegistryInitializer) {
  const entries = unwrapExpression(galleryRegistryInitializer);
  if (ts.isArrayLiteralExpression(entries)) {
    for (const element of entries.elements) {
      if (!ts.isObjectLiteralExpression(element)) continue;
      if (stringProperty(element, "packageType") !== "product-ui") continue;
      const slug = stringProperty(element, "slug");
      const apiEntry = stringProperty(element, "apiEntry");
      const contract = element.properties.find(
        (property) =>
          ts.isPropertyAssignment(property) &&
          propertyName(property) === "contract",
      );
      const contractInitializer =
        contract && ts.isPropertyAssignment(contract)
          ? unwrapExpression(contract.initializer)
          : undefined;
      const contractKey =
        contractInitializer &&
        ts.isPropertyAccessExpression(contractInitializer) &&
        ts.isIdentifier(contractInitializer.expression) &&
        contractInitializer.expression.text === "galleryContracts"
          ? contractInitializer.name.text
          : undefined;
      const subpath = apiEntry?.match(
        /^@insightflare\/product-ui\/(.+)$/u,
      )?.[1];
      if (slug && subpath) {
        productGalleryEntries.push({
          slug,
          subpath,
          contractBinding: contractKey
            ? galleryContractBindings.get(contractKey)
            : undefined,
        });
      }
    }
  }
}

for (const id of duplicates(contractIds))
  issues.push(`Duplicate contract id: ${id}`);
for (const id of duplicates(fixtureIds))
  issues.push(`Duplicate fixture id: ${id}`);
for (const slug of duplicates(slugs))
  issues.push(`Duplicate gallery slug: ${slug}`);

const registrySlugs = new Set(slugs);
for (const subpath of publicComponentSubpaths) {
  if (!registrySlugs.has(subpath)) {
    issues.push(
      `Public UI component subpath is missing from the gallery: ${subpath}`,
    );
  }
}

const importedProductSubpaths = new Set(
  productContractImports.map(({ subpath }) => subpath),
);
for (const subpath of productComponentSubpaths) {
  const contractImport = productContractImports.find(
    (candidate) => candidate.subpath === subpath,
  );
  if (!contractImport) {
    issues.push(
      `Public Product UI subpath is missing a contract import: ${subpath}`,
    );
    continue;
  }
  if (
    !productGalleryEntries.some(
      (entry) =>
        entry.subpath === subpath &&
        entry.contractBinding === contractImport.binding,
    )
  ) {
    issues.push(
      `Product UI contract ${contractImport.binding} is not a Gallery target: ${subpath}`,
    );
  }
}
for (const subpath of importedProductSubpaths) {
  if (!productComponentSubpaths.includes(subpath)) {
    issues.push(`Gallery imports a non-public Product UI subpath: ${subpath}`);
  }
}
if (productGalleryEntries.length !== productComponentSubpaths.length) {
  issues.push(
    `Expected ${productComponentSubpaths.length} Product UI Gallery entries, found ${productGalleryEntries.length}.`,
  );
}

const productGallerySlugs = new Set(
  productGalleryEntries.map(({ slug }) => slug),
);
const publicUiSlugs = new Set(publicComponentSubpaths);
for (const slug of slugs) {
  if (!publicUiSlugs.has(slug) && !productGallerySlugs.has(slug)) {
    issues.push(`Gallery slug has no public package target: ${slug}`);
  }
}

if (issues.length > 0) {
  console.error(issues.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `UI contracts passed (${contractIds.length} contracts, ${fixtureIds.length} fixtures, ${slugs.length} gallery entries).`,
  );
}
