import { DatabaseCompilerError } from "@/lib/db/query/errors";
import type { RelationScope } from "@/lib/db/query/expression";
import type { SharedRelationDefinition } from "@/lib/db/query/physical/contracts";
import type { LogicalQueryNode, OutputField } from "@/lib/db/query/plan";

export type PhysicalSharedRelationLicenseKind =
  | "bounded-group-summary"
  | "bounded-summary-derived"
  | "shared-membership-input"
  | "shared-scalar-count"
  | "bounded-admission"
  | "bounded-admission-counter"
  | "complete-keyed-lookup"
  | "rank-one-project"
  | "rank-one-fact-filter"
  | "strict-generic-facts"
  | "strict-serial-rank-stage"
  | "wide-count-project-reuse"
  | "stage-derived-auto"
  | "current-boundary-derived-auto";

export type PhysicalSharedRelationInterfaceVetoReason =
  | "automatic-materialization-is-not-a-license"
  | "not-in-current-logical-graph"
  | "definition-metadata-mismatch"
  | "dependency-layout-mismatch"
  | "no-current-license"
  | "not-total-through-certified-boundaries"
  | "forbidden-boundary-shape"
  | "scope-or-column-not-closed";

export interface PhysicalSharedRelationFieldIdentity {
  readonly name: string;
  readonly affinity: OutputField["affinity"];
  readonly nullable: boolean;
}

/** Value-free copy of the exact shared definition in one physical layout. */
export interface PhysicalSharedRelationDefinitionIdentity {
  readonly name: string;
  readonly node: LogicalQueryNode;
  readonly scope: RelationScope;
  readonly fields: readonly PhysicalSharedRelationFieldIdentity[];
  readonly dependencies: readonly string[];
  readonly materialization: SharedRelationDefinition["materialization"];
  readonly materializationSelection?: SharedRelationDefinition["materializationSelection"];
}

/**
 * Evidence consumed while analyzing one current materialized boundary.
 * Boundary readability, closure, totality, and its specialized license stay
 * distinct so later optimizers cannot treat one as a blanket trust bit.
 */
export interface PhysicalSharedRelationBoundaryEvidence {
  readonly definition: SharedRelationDefinition;
  readonly boundary: { readonly kind: "materialized-relation" };
  readonly selective: boolean;
  readonly license: { readonly kind: PhysicalSharedRelationLicenseKind };
  readonly closure: {
    readonly kind: "scope-and-exported-columns-closed";
    readonly scopeCount: number;
    readonly referencedScopeCount: number;
    readonly referencedColumnCount: number;
  };
  readonly totality: {
    readonly kind: "checked-through-current-boundaries";
    readonly stoppedAt: readonly LogicalQueryNode[];
  };
}

export interface PhysicalSharedRelationInterface {
  readonly definition: PhysicalSharedRelationDefinitionIdentity;
  readonly boundary: { readonly kind: "materialized-relation" };
  readonly selective: boolean;
  readonly license: { readonly kind: PhysicalSharedRelationLicenseKind };
  readonly closure: PhysicalSharedRelationBoundaryEvidence["closure"];
  readonly totality: PhysicalSharedRelationBoundaryEvidence["totality"];
}

export interface PhysicalSharedRelationUnlicensedDefinition {
  readonly definition: PhysicalSharedRelationDefinitionIdentity;
  readonly reason: PhysicalSharedRelationInterfaceVetoReason;
}

export interface PhysicalSharedRelationInterfaceAnalysisCounts {
  /** One fresh canonical shared-graph analysis for this validation call. */
  readonly sharedGraphPasses: 1;
  /** Baseline and returned final-layout license passes; provisional probes are excluded. */
  readonly materializedBoundaryPasses: number;
  /** Definition checks across the baseline and returned final layout. */
  readonly materializedDefinitionsChecked: number;
}

export interface PhysicalSharedRelationInterfaceView {
  readonly root: LogicalQueryNode;
  readonly layout: readonly PhysicalSharedRelationDefinitionIdentity[];
  readonly interfaces: readonly PhysicalSharedRelationInterface[];
  readonly unlicensed: readonly PhysicalSharedRelationUnlicensedDefinition[];
  readonly analysis: PhysicalSharedRelationInterfaceAnalysisCounts;
}

const validatedViewBrand = Symbol(
  "validated physical shared-relation interface view",
);
const licenseKinds = new Set<PhysicalSharedRelationLicenseKind>([
  "bounded-group-summary",
  "bounded-summary-derived",
  "shared-membership-input",
  "shared-scalar-count",
  "bounded-admission",
  "bounded-admission-counter",
  "complete-keyed-lookup",
  "rank-one-project",
  "rank-one-fact-filter",
  "strict-generic-facts",
  "strict-serial-rank-stage",
  "wide-count-project-reuse",
  "stage-derived-auto",
  "current-boundary-derived-auto",
]);

function invalidPlan(message: string): never {
  throw new DatabaseCompilerError("invalid_plan", message);
}

function ownDataValue(
  value: object,
  key: PropertyKey,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) return { ok: false };
  return { ok: true, value: descriptor.value };
}

function denseArrayValues(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !length ||
    !("value" in length) ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0
  )
    return undefined;
  const values: unknown[] = [];
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !("value" in descriptor)) return undefined;
    values.push(descriptor.value);
  }
  return values;
}

function denseArray(value: unknown): value is readonly unknown[] {
  return denseArrayValues(value) !== undefined;
}

function snapshotFields(
  value: unknown,
): readonly PhysicalSharedRelationFieldIdentity[] | undefined {
  const values = denseArrayValues(value);
  if (!values) return undefined;
  const fields: PhysicalSharedRelationFieldIdentity[] = [];
  for (let index = 0; index < values.length; index++) {
    const current = values[index];
    if (!current || typeof current !== "object" || Array.isArray(current))
      return undefined;
    const name = ownDataValue(current, "name");
    const affinity = ownDataValue(current, "affinity");
    const nullable = ownDataValue(current, "nullable");
    if (
      !name.ok ||
      typeof name.value !== "string" ||
      !affinity.ok ||
      typeof affinity.value !== "string" ||
      !nullable.ok ||
      typeof nullable.value !== "boolean"
    )
      return undefined;
    fields.push(
      Object.freeze({
        name: name.value,
        affinity: affinity.value as OutputField["affinity"],
        nullable: nullable.value,
      }),
    );
  }
  return Object.freeze(fields);
}

function sameFields(
  left: readonly PhysicalSharedRelationFieldIdentity[],
  right: readonly PhysicalSharedRelationFieldIdentity[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const leftField = left[index];
    const rightField = right[index];
    if (
      !leftField ||
      !rightField ||
      leftField.name !== rightField.name ||
      leftField.affinity !== rightField.affinity ||
      leftField.nullable !== rightField.nullable
    )
      return false;
  }
  return true;
}

function snapshotDefinition(
  value: unknown,
): PhysicalSharedRelationDefinitionIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const name = ownDataValue(value, "name");
  const node = ownDataValue(value, "node");
  const scope = ownDataValue(value, "scope");
  const fieldsValue = ownDataValue(value, "fields");
  const dependenciesValue = ownDataValue(value, "dependencies");
  const materialization = ownDataValue(value, "materialization");
  const selectionDescriptor = Object.getOwnPropertyDescriptor(
    value,
    "materializationSelection",
  );
  const selectionValue = selectionDescriptor
    ? ownDataValue(value, "materializationSelection")
    : undefined;
  const dependencyValues = dependenciesValue.ok
    ? denseArrayValues(dependenciesValue.value)
    : undefined;
  if (
    !name.ok ||
    typeof name.value !== "string" ||
    !node.ok ||
    !node.value ||
    typeof node.value !== "object" ||
    !scope.ok ||
    scope.value === null ||
    scope.value === undefined ||
    !fieldsValue.ok ||
    !dependencyValues ||
    !materialization.ok ||
    (materialization.value !== "auto" &&
      materialization.value !== "materialized") ||
    (selectionDescriptor !== undefined &&
      (!selectionValue?.ok ||
        !selectionValue.value ||
        typeof selectionValue.value !== "object" ||
        Array.isArray(selectionValue.value)))
  )
    return undefined;
  let materializationSelection:
    SharedRelationDefinition["materializationSelection"] | undefined;
  if (selectionValue?.ok) {
    const selection = selectionValue.value as Record<string, unknown>;
    const kind = ownDataValue(selection, "kind");
    const choiceIndex = ownDataValue(selection, "choiceIndex");
    const keys = Object.getOwnPropertyNames(selection);
    if (
      !kind.ok ||
      (kind.value !== "strict-serial-rank-stage" &&
        kind.value !== "stage-derived-auto" &&
        kind.value !== "current-boundary-derived-auto") ||
      !choiceIndex.ok ||
      !Number.isSafeInteger(choiceIndex.value) ||
      (choiceIndex.value as number) < 0 ||
      keys.length !== 2 ||
      Object.getOwnPropertySymbols(selection).length !== 0 ||
      keys.some((key) => key !== "kind" && key !== "choiceIndex")
    )
      return undefined;
    materializationSelection = Object.freeze({
      kind: kind.value,
      choiceIndex: choiceIndex.value as number,
    });
  }
  const fields = snapshotFields(fieldsValue.value);
  if (!fields) return undefined;
  const dependencies: string[] = [];
  for (let index = 0; index < dependencyValues.length; index++) {
    const dependency = dependencyValues[index];
    if (typeof dependency !== "string") return undefined;
    dependencies.push(dependency);
  }
  const nodeScope = ownDataValue(node.value, "scope");
  const nodeFieldsValue = ownDataValue(node.value, "fields");
  if (!nodeScope.ok || !nodeFieldsValue.ok) return undefined;
  const nodeFields = snapshotFields(nodeFieldsValue.value);
  if (
    !nodeFields ||
    nodeScope.value !== scope.value ||
    !sameFields(fields, nodeFields)
  )
    return undefined;
  return Object.freeze({
    name: name.value,
    node: node.value as LogicalQueryNode,
    scope: scope.value as RelationScope,
    fields,
    dependencies: Object.freeze(dependencies),
    materialization: materialization.value,
    ...(materializationSelection ? { materializationSelection } : {}),
  });
}

/** Fail closed on sparse arrays, accessors, and malformed shared definitions. */
export function snapshotPhysicalSharedRelationLayout(
  root: LogicalQueryNode,
  definitions: unknown,
): readonly PhysicalSharedRelationDefinitionIdentity[] | undefined {
  try {
    const definitionValues = denseArrayValues(definitions);
    if (!root || typeof root !== "object" || !definitionValues)
      return undefined;
    const result: PhysicalSharedRelationDefinitionIdentity[] = [];
    const nodes = new Set<LogicalQueryNode>();
    const names = new Set<string>();
    for (let index = 0; index < definitionValues.length; index++) {
      const definition = snapshotDefinition(definitionValues[index]);
      if (
        !definition ||
        nodes.has(definition.node) ||
        names.has(definition.name)
      )
        return undefined;
      nodes.add(definition.node);
      names.add(definition.name);
      result.push(definition);
    }
    return Object.freeze(result);
  } catch {
    return undefined;
  }
}

export function samePhysicalSharedRelationDefinitionIdentity(
  left: PhysicalSharedRelationDefinitionIdentity,
  right: PhysicalSharedRelationDefinitionIdentity,
): boolean {
  if (
    left.name !== right.name ||
    left.node !== right.node ||
    left.scope !== right.scope ||
    left.materialization !== right.materialization ||
    left.materializationSelection?.kind !==
      right.materializationSelection?.kind ||
    left.materializationSelection?.choiceIndex !==
      right.materializationSelection?.choiceIndex ||
    left.dependencies.length !== right.dependencies.length ||
    !sameFields(left.fields, right.fields)
  )
    return false;
  for (let index = 0; index < left.dependencies.length; index++) {
    if (left.dependencies[index] !== right.dependencies[index]) return false;
  }
  return true;
}

export function createPhysicalSharedRelationInterfaceView(args: {
  readonly root: LogicalQueryNode;
  readonly definitions: readonly SharedRelationDefinition[];
  readonly boundaries: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >;
  readonly vetoes: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationInterfaceVetoReason
  >;
  readonly materializedBoundaryPasses: number;
  readonly materializedDefinitionsChecked: number;
}): PhysicalSharedRelationInterfaceView {
  const layout = snapshotPhysicalSharedRelationLayout(
    args.root,
    args.definitions,
  );
  if (!layout)
    invalidPlan("Physical shared relation interface layout is malformed");
  const interfaces: PhysicalSharedRelationInterface[] = [];
  const unlicensed: PhysicalSharedRelationUnlicensedDefinition[] = [];
  const certifiedNodes = new Set<LogicalQueryNode>();
  for (let index = 0; index < layout.length; index++) {
    const definition = layout[index]!;
    const boundary = args.boundaries.get(definition.node);
    if (definition.materialization === "auto") {
      unlicensed.push(
        Object.freeze({
          definition,
          reason: "automatic-materialization-is-not-a-license",
        }),
      );
      continue;
    }
    if (!boundary) {
      unlicensed.push(
        Object.freeze({
          definition,
          reason: args.vetoes.get(definition.node) ?? "no-current-license",
        }),
      );
      continue;
    }
    const boundaryDefinition = snapshotDefinition(boundary.definition);
    const stoppedAtValues = denseArrayValues(boundary.totality?.stoppedAt);
    if (
      !boundaryDefinition ||
      !samePhysicalSharedRelationDefinitionIdentity(
        definition,
        boundaryDefinition,
      ) ||
      boundary.license === null ||
      typeof boundary.license !== "object" ||
      !licenseKinds.has(boundary.license.kind) ||
      boundary.boundary?.kind !== "materialized-relation" ||
      boundary.closure?.kind !== "scope-and-exported-columns-closed" ||
      typeof boundary.selective !== "boolean" ||
      !Number.isSafeInteger(boundary.closure.scopeCount) ||
      boundary.closure.scopeCount < 0 ||
      !Number.isSafeInteger(boundary.closure.referencedScopeCount) ||
      boundary.closure.referencedScopeCount < 0 ||
      boundary.closure.referencedScopeCount > boundary.closure.scopeCount ||
      !Number.isSafeInteger(boundary.closure.referencedColumnCount) ||
      boundary.closure.referencedColumnCount < 0 ||
      boundary.totality?.kind !== "checked-through-current-boundaries" ||
      !stoppedAtValues
    )
      invalidPlan("Physical shared relation interface proof is inconsistent");
    const stoppedAt: LogicalQueryNode[] = [];
    for (
      let boundaryIndex = 0;
      boundaryIndex < stoppedAtValues.length;
      boundaryIndex++
    ) {
      const dependency = stoppedAtValues[boundaryIndex];
      if (
        !dependency ||
        typeof dependency !== "object" ||
        !certifiedNodes.has(dependency as LogicalQueryNode)
      )
        invalidPlan(
          "Physical shared relation interface dependency is not current",
        );
      stoppedAt.push(dependency as LogicalQueryNode);
    }
    interfaces.push(
      Object.freeze({
        definition,
        boundary: Object.freeze({ kind: "materialized-relation" as const }),
        selective: boundary.selective,
        license: Object.freeze({ kind: boundary.license.kind }),
        closure: Object.freeze({ ...boundary.closure }),
        totality: Object.freeze({
          kind: "checked-through-current-boundaries" as const,
          stoppedAt: Object.freeze([...stoppedAt]),
        }),
      }),
    );
    certifiedNodes.add(definition.node);
  }
  const view = {
    root: args.root,
    layout,
    interfaces: Object.freeze(interfaces),
    unlicensed: Object.freeze(unlicensed),
    analysis: Object.freeze({
      sharedGraphPasses: 1 as const,
      materializedBoundaryPasses: args.materializedBoundaryPasses,
      materializedDefinitionsChecked: args.materializedDefinitionsChecked,
    }),
  };
  Object.defineProperty(view, validatedViewBrand, { value: true });
  return Object.freeze(view);
}

export function assertPhysicalSharedRelationInterfaceViewMatches(
  view: PhysicalSharedRelationInterfaceView,
  root: LogicalQueryNode,
  definitions: unknown,
): void {
  try {
    const brand = Object.getOwnPropertyDescriptor(view, validatedViewBrand);
    if (!brand || brand.value !== true || view.root !== root)
      invalidPlan("Physical shared relation interface view is not current");
    const current = snapshotPhysicalSharedRelationLayout(root, definitions);
    if (
      !current ||
      !denseArray(view.layout) ||
      !denseArray(view.interfaces) ||
      !denseArray(view.unlicensed) ||
      current.length !== view.layout.length
    )
      invalidPlan("Physical shared relation interface layout changed");
    for (let index = 0; index < current.length; index++) {
      if (
        !samePhysicalSharedRelationDefinitionIdentity(
          current[index]!,
          view.layout[index]!,
        )
      )
        invalidPlan("Physical shared relation interface layout changed");
    }
    if (view.interfaces.length + view.unlicensed.length !== view.layout.length)
      invalidPlan("Physical shared relation interface view is incomplete");
    const classifiedNodes = new Set<LogicalQueryNode>();
    for (let index = 0; index < view.interfaces.length; index++) {
      const currentInterface = view.interfaces[index];
      if (
        !currentInterface ||
        !licenseKinds.has(currentInterface.license.kind) ||
        currentInterface.boundary.kind !== "materialized-relation" ||
        currentInterface.definition.materialization !== "materialized" ||
        !view.layout.includes(currentInterface.definition) ||
        classifiedNodes.has(currentInterface.definition.node)
      )
        invalidPlan("Physical shared relation interface proof is malformed");
      classifiedNodes.add(currentInterface.definition.node);
    }
    for (let index = 0; index < view.unlicensed.length; index++) {
      const unlicensed = view.unlicensed[index];
      if (
        !unlicensed ||
        !view.layout.includes(unlicensed.definition) ||
        classifiedNodes.has(unlicensed.definition.node)
      )
        invalidPlan(
          "Physical shared relation interface classification is malformed",
        );
      classifiedNodes.add(unlicensed.definition.node);
    }
    if (classifiedNodes.size !== view.layout.length)
      invalidPlan(
        "Physical shared relation interface classification is incomplete",
      );
  } catch (error) {
    if (error instanceof DatabaseCompilerError && error.code === "invalid_plan")
      throw error;
    invalidPlan("Physical shared relation interface view is malformed");
  }
}

/** A producer cannot consume its own materialized-boundary proof. */
export function findPhysicalSharedRelationInterface(
  view: PhysicalSharedRelationInterfaceView,
  node: LogicalQueryNode,
  currentProducer: LogicalQueryNode,
): PhysicalSharedRelationInterface | undefined {
  try {
    const brand = Object.getOwnPropertyDescriptor(view, validatedViewBrand);
    if (!brand || !("value" in brand) || brand.value !== true) return undefined;
  } catch {
    return undefined;
  }
  if (node === currentProducer) return undefined;
  const producerIndex = view.layout.findIndex(
    (definition) => definition.node === currentProducer,
  );
  if (currentProducer !== view.root && producerIndex < 0) return undefined;
  for (let index = 0; index < view.interfaces.length; index++) {
    const candidate = view.interfaces[index];
    if (candidate?.definition.node !== node) continue;
    const definitionIndex = view.layout.indexOf(candidate.definition);
    if (
      definitionIndex < 0 ||
      (producerIndex >= 0 && definitionIndex >= producerIndex)
    )
      return undefined;
    return candidate;
  }
  return undefined;
}
