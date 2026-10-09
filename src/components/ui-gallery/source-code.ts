import {
  type ElementType,
  Fragment,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

import { resolveComponentSourceImport } from "./code-import-map";
import { type UiGalleryEntry, uiGalleryRegistry } from "./registry";

interface ComponentImport {
  readonly type: ElementType;
  readonly name: string;
  readonly source: string;
  readonly memberPath?: readonly string[];
}

const rechartsComponents = new Set([
  "Area",
  "AreaChart",
  "Bar",
  "BarChart",
  "CartesianGrid",
  "Cell",
  "Legend",
  "Line",
  "LineChart",
  "Pie",
  "PieChart",
  "PolarAngleAxis",
  "PolarGrid",
  "PolarRadiusAxis",
  "Radar",
  "RadarChart",
  "ReferenceArea",
  "ReferenceLine",
  "ResponsiveContainer",
  "Tooltip",
  "XAxis",
  "YAxis",
]);

function getStableDisplayName(type: ElementType) {
  if (typeof type === "string") return type;
  const component = type as {
    displayName?: string;
    render?: { displayName?: string };
  };
  return component.displayName || component.render?.displayName || null;
}

function toPascalCase(value: string) {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

function getComponentSource(name: string, entry: UiGalleryEntry) {
  if (name.startsWith("Ri")) return "@remixicon/react";
  if (rechartsComponents.has(name)) return "recharts";
  return entry.apiEntry;
}

function walkNode(
  node: unknown,
  visit: (element: ReactElement<Record<string, unknown>>) => void,
  visited: WeakSet<object>,
) {
  if (node === null || typeof node !== "object") return;
  if (visited.has(node)) return;
  visited.add(node);

  if (isValidElement<Record<string, unknown>>(node)) {
    visit(node);
    for (const value of Object.values(node.props)) {
      walkNode(value, visit, visited);
    }
    return;
  }

  if (Array.isArray(node)) {
    for (const value of node) walkNode(value, visit, visited);
    return;
  }

  if (node instanceof Date) return;
  for (const value of Object.values(node)) {
    walkNode(value, visit, visited);
  }
}

function getImportForType(
  type: ElementType,
  entry: UiGalleryEntry,
  registeredComponents: ReadonlyMap<ElementType, ComponentImport>,
): ComponentImport {
  const publicImport = resolveComponentSourceImport(type);
  if (publicImport) return { type, ...publicImport };

  const registeredComponent = registeredComponents.get(type);
  if (registeredComponent) return registeredComponent;

  const name = getStableDisplayName(type);
  if (!name) {
    throw new Error(
      `Missing a public source import mapping for a component rendered by ${entry.contract.title}.`,
    );
  }

  return {
    type,
    name,
    source: getComponentSource(name, entry),
  };
}

function collectImports(node: ReactNode, entry: UiGalleryEntry) {
  const registeredComponents = new Map<ElementType, ComponentImport>();
  for (const registeredEntry of uiGalleryRegistry) {
    const { componentType } = registeredEntry.contract;
    if (componentType && !registeredComponents.has(componentType)) {
      registeredComponents.set(componentType, {
        type: componentType,
        name: toPascalCase(registeredEntry.contract.title) || "Component",
        source: registeredEntry.apiEntry,
      });
    }
  }

  const components = new Map<ElementType, ComponentImport>();
  let needsSonnerToastImport = false;
  walkNode(
    node,
    (element) => {
      if (
        Object.values(element.props).some(
          (value) =>
            typeof value === "function" &&
            Function.prototype.toString.call(value).includes("toast."),
        )
      ) {
        needsSonnerToastImport = true;
      }
      if (element.type === Fragment || typeof element.type === "string") return;
      const type = element.type as ElementType;
      if (!components.has(type)) {
        components.set(
          type,
          getImportForType(type, entry, registeredComponents),
        );
      }
    },
    new WeakSet(),
  );

  const imports = [...components.values()];
  const bindingKey = (source: string, name: string) => `${source}\0${name}`;
  const bindings = new Map<string, { name: string; source: string }>();
  for (const item of imports) {
    const key = bindingKey(item.source, item.name);
    if (!bindings.has(key)) {
      bindings.set(key, { name: item.name, source: item.source });
    }
  }

  const sameNameCount = new Map<string, number>();
  for (const binding of bindings.values()) {
    sameNameCount.set(binding.name, (sameNameCount.get(binding.name) ?? 0) + 1);
  }

  const bindingIdentifiers = new Map<string, string>();
  const usedIdentifiers = new Set<string>();
  for (const [key, binding] of bindings) {
    const moduleSegment = binding.source.split("/").at(-1) ?? "Component";
    const aliasBase =
      (sameNameCount.get(binding.name) ?? 0) > 1
        ? `${binding.name}${toPascalCase(moduleSegment)}`
        : binding.name;
    let identifier = aliasBase;
    let suffix = 2;
    while (usedIdentifiers.has(identifier)) {
      identifier = `${aliasBase}${suffix}`;
      suffix += 1;
    }
    usedIdentifiers.add(identifier);
    bindingIdentifiers.set(key, identifier);
  }

  const identifiers = new Map<ElementType, string>();
  for (const item of imports) {
    const bindingIdentifier = bindingIdentifiers.get(
      bindingKey(item.source, item.name),
    )!;
    identifiers.set(
      item.type,
      [bindingIdentifier, ...(item.memberPath ?? [])].join("."),
    );
  }

  const bySource = new Map<string, Map<string, string>>();
  for (const [key, binding] of bindings) {
    const sourceImports =
      bySource.get(binding.source) ?? new Map<string, string>();
    sourceImports.set(binding.name, bindingIdentifiers.get(key)!);
    bySource.set(binding.source, sourceImports);
  }

  const importLines = [...bySource.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, namedImports]) => {
      const specifiers = [...namedImports.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, identifier]) =>
          name === identifier ? name : `${name} as ${identifier}`,
        );
      return `import { ${specifiers.join(", ")} } from ${JSON.stringify(source)};`;
    });

  if (needsSonnerToastImport) {
    importLines.push('import { toast } from "sonner";');
  }

  return { identifiers, importLines };
}

function serializeValue(
  value: unknown,
  depth: number,
  identifiers: ReadonlyMap<ElementType, string>,
): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "Number.NaN";
    if (!Number.isFinite(value))
      return value > 0
        ? "Number.POSITIVE_INFINITY"
        : "Number.NEGATIVE_INFINITY";
    return String(value);
  }
  if (typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "function") {
    const source = Function.prototype.toString
      .call(value)
      .replace(/__vite_ssr_import_\d+__\.toast/g, "toast")
      .trim();
    return source.includes("toast.") ? source : "() => {}";
  }
  if (typeof value === "symbol") return "undefined";
  if (value instanceof Date)
    return `new Date(${JSON.stringify(value.toISOString())})`;
  if (isValidElement<Record<string, unknown>>(value)) {
    return serializeElement(value, depth, identifiers);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const indent = "  ".repeat(depth);
    const childIndent = "  ".repeat(depth + 1);
    return (
      `[` +
      `\n${value
        .map(
          (item) =>
            `${childIndent}${serializeValue(item, depth + 1, identifiers)},`,
        )
        .join("\n")}\n${indent}]`
    );
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, item]) => item !== undefined,
  );
  if (entries.length === 0) return "{}";
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  return `{
${entries
  .map(
    ([key, item]) =>
      `${childIndent}${JSON.stringify(key)}: ${serializeValue(item, depth + 1, identifiers)},`,
  )
  .join("\n")}
${indent}}`;
}

function serializeChild(
  node: unknown,
  depth: number,
  identifiers: ReadonlyMap<ElementType, string>,
): string {
  if (node === null || node === undefined || typeof node === "boolean")
    return "";
  if (typeof node === "string" || typeof node === "number") {
    return `${"  ".repeat(depth)}{${serializeValue(node, depth, identifiers)}}`;
  }
  if (Array.isArray(node)) {
    return node
      .map((child) => serializeChild(child, depth, identifiers))
      .filter(Boolean)
      .join("\n");
  }
  if (isValidElement<Record<string, unknown>>(node)) {
    return serializeElement(node, depth, identifiers);
  }
  return "";
}

function serializeElement(
  element: ReactElement<Record<string, unknown>>,
  depth: number,
  identifiers: ReadonlyMap<ElementType, string>,
): string {
  const indent = "  ".repeat(depth);
  if (element.type === Fragment) {
    const children = serializeChild(
      element.props.children,
      depth + 1,
      identifiers,
    );
    return children
      ? `${indent}<>\n${children}\n${indent}</>`
      : `${indent}<></>`;
  }

  const name =
    typeof element.type === "string"
      ? element.type
      : (identifiers.get(element.type as ElementType) ?? "Component");
  const attributes = Object.entries(element.props)
    .filter(
      ([key, value]) =>
        !["children", "key", "ref"].includes(key) && value !== undefined,
    )
    .map(([key, value]) => {
      if (value === true) return key;
      if (typeof value === "string") return `${key}=${JSON.stringify(value)}`;
      if (typeof value === "number" || typeof value === "boolean") {
        return `${key}={${serializeValue(value, depth + 1, identifiers)}}`;
      }
      return `${key}={${serializeValue(value, depth + 1, identifiers)}}`;
    });
  const opening =
    attributes.length > 0
      ? `${indent}<${name}\n${attributes
          .map((attribute) => `${indent}  ${attribute}`)
          .join("\n")}\n${indent}`
      : `${indent}<${name}`;
  const children = serializeChild(
    element.props.children,
    depth + 1,
    identifiers,
  );
  if (!children) return `${opening} />`;
  return `${opening}>\n${children}\n${indent}</${name}>`;
}

export function createUiGallerySource(entry: UiGalleryEntry, node: ReactNode) {
  const { identifiers, importLines } = collectImports(node, entry);
  const jsx = serializeChild(node, 0, identifiers);
  return [importLines.join("\n"), jsx].filter(Boolean).join("\n\n");
}
