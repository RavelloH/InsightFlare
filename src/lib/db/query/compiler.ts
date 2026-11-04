import {
  assertD1StatementBudget,
  D1_MAX_BOUND_PARAMETERS,
  D1StatementBudgetError,
} from "@/lib/db/d1-budget";
import {
  getParameterPlaceholderOffsets,
  parameter,
  type SqlFragment,
  text,
} from "@/lib/db/sql/fragment";
import { identifier } from "@/lib/db/sql/identifier";
import type {
  DatabasePhysicalPlanShape,
  DatabaseStatement,
} from "@/lib/db/types";

import {
  compileConditionalLookupCondition,
  type PhysicalConditionalLookupChoice,
} from "./physical/conditional-lookup";
import type {
  PhysicalNativeNullOrderingChoice,
  PhysicalSingletonRankChoice,
} from "./physical/contracts";
import type { PhysicalLexicographicComparisonChoice } from "./physical/lexicographic-comparison";
import { rowPipelineShape } from "./physical/row-pipeline";
import type {
  PhysicalSelfMembershipChoice,
  PhysicalSelfMembershipWitness,
} from "./physical/self-membership";
import type { PhysicalSharedRelationInterfaceView } from "./physical/shared-relation-interfaces";
import {
  assertPhysicalSharedRelationInterfaceViewMatches,
  findPhysicalSharedRelationInterface,
} from "./physical/shared-relation-interfaces";
import {
  type CompileOrderSharedReference,
  renderCompileOrderCrossJoin,
  renderCompileOrderGuard,
  renderCompileOrderHelper,
  type RenderedCompileOrderHelper,
  scheduledCompileOrderLeaves,
} from "./render/compile-order";
import {
  createFinalRenderSession,
  type FinalRenderEmissionCounts,
  type FinalRenderSession,
  type FinalRenderTestDiagnostic,
} from "./render/final-render-session";
import {
  concat,
  finalRenderEmissionCounts,
  inheritFinalRenderProvenance,
  join,
  parenthesize,
  recordFinalRenderEmission,
} from "./render/fragment-provenance";
import { renderMaterializedRelationReference } from "./render/materialized-relation-reference";
import { renderWindowOrderBy } from "./render/order-by";
import type { CompiledQuery } from "./compiled";
import { DatabaseCompilerError } from "./errors";
import type {
  AnyExpression,
  AnyInListExpression,
  RelationScope,
  SqlExpression,
} from "./expression";
import {
  type ConstantFilterJoinProjection,
  hasSamePhysicalMembershipOptimization,
  lowerLogicalPlan,
  optimizePhysicalMembershipBudget,
  optimizePhysicalParameterSlots,
  type PassthroughProjectFusion,
  type PhysicalJoinOrderStrategy,
  type PhysicalMembershipUsage,
  type PhysicalParameterSlotLayout,
  type PhysicalQueryPlan,
  type PhysicalRowPipelineChoice,
  type PhysicalSemiMembershipChoice,
  type PhysicalTextRowStrategy,
  type PhysicalTextRowUsage,
  type PositiveTupleMembershipCandidate,
  recursiveClosureCount,
  type SharedRelationDefinition,
  validatePhysicalQueryPlan,
} from "./physical-plan";
import type {
  JoinNode,
  JsonScalarArrayNode,
  LogicalQueryNode,
  QuerySource,
  Relation,
  SemiJoinNode,
  ValuesRelationNode,
  WindowNode,
} from "./plan";
import type { ProjectNode } from "./plan";

export interface ScopeBinding {
  readonly alias: string;
  readonly fieldNames?: readonly string[];
}

interface RenderContext {
  scanAlias: number;
  queryAlias: number;
  leftAlias: number;
  rightAlias: number;
  recursiveCteAlias: number;
  readonly reservedIdentifiers: Set<string>;
  readonly generatedAliases: Set<string>;
  readonly sharedRelations: ReadonlyMap<LogicalQueryNode, string>;
  readonly directScanProjections: ReadonlyMap<
    ProjectNode,
    PhysicalQueryPlan<object>["directScanProjections"][number]
  >;
  readonly passthroughProjectFusions: ReadonlyMap<
    ProjectNode,
    PassthroughProjectFusion
  >;
  readonly rowPipelines: ReadonlyMap<
    LogicalQueryNode,
    PhysicalRowPipelineChoice
  >;
  readonly singletonRankChoices: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSingletonRankChoice
  >;
  readonly singletonRankEmissions: Map<PhysicalSingletonRankChoice, number>;
  readonly singletonRankFusionEnabled: boolean;
  finalRenderSession?: FinalRenderSession;
  suppressFinalRenderEmissions?: boolean;
  readonly nativeNullOrderingChoices: ReadonlyMap<
    WindowNode,
    readonly PhysicalNativeNullOrderingChoice[]
  >;
  readonly lexicographicComparisons: ReadonlyMap<
    SqlExpression,
    PhysicalLexicographicComparisonChoice
  >;
  readonly lexicographicComparisonEmissions: Map<
    PhysicalLexicographicComparisonChoice,
    number
  >;
  readonly sharedRelationInterfaces?: PhysicalSharedRelationInterfaceView;
  readonly constantFilterJoinProjections: ReadonlyMap<
    ProjectNode,
    ConstantFilterJoinProjection
  >;
  readonly sparseJoinOutputs: ReadonlyMap<JoinNode, ReadonlySet<number>>;
  readonly positiveTupleMemberships: ReadonlyMap<
    ProjectNode,
    PositiveTupleMembershipCandidate
  >;
  readonly selfMembershipChoices: ReadonlyMap<
    ProjectNode,
    PhysicalSelfMembershipChoice
  >;
  readonly semiMemberships: ReadonlyMap<
    SemiJoinNode,
    PhysicalSemiMembershipChoice
  >;
  readonly semiMembershipEmissions: Map<PhysicalSemiMembershipChoice, number>;
  readonly joinOrderStrategies: ReadonlyMap<
    JoinNode,
    PhysicalJoinOrderStrategy
  >;
  readonly conditionalLookupChoices: ReadonlyMap<
    JoinNode,
    PhysicalConditionalLookupChoice
  >;
  readonly membershipStrategies?: ReadonlyMap<
    AnyInListExpression,
    { readonly strategy: "native" | "json-text"; readonly jsonText?: string }
  >;
  readonly membershipUsage?: Map<AnyInListExpression, number>;
  readonly textRowStrategies?: ReadonlyMap<
    ValuesRelationNode,
    {
      readonly strategy: "native" | "json-rows";
      readonly jsonSegments?: readonly string[];
    }
  >;
  readonly textRowUsage?: Map<ValuesRelationNode, number>;
  readonly projectionTransportSimplifications: boolean;
  readonly compactGeneratedColumnAliases: boolean;
  compileOrderRoot?: Extract<LogicalQueryNode, { readonly kind: "sort" }>;
  compileOrderHelper?: RenderedCompileOrderHelper;
  bypassSharedNode?: LogicalQueryNode;
}

function recordContextFinalRenderEmission(
  context: RenderContext,
  fragment: SqlFragment,
  emission: Parameters<typeof recordFinalRenderEmission>[2],
): SqlFragment {
  return context.suppressFinalRenderEmissions
    ? fragment
    : recordFinalRenderEmission(context.finalRenderSession, fragment, emission);
}

function nextAlias(
  context: RenderContext,
  prefix: "t" | "q" | "l" | "r",
): string {
  const key =
    prefix === "t"
      ? "scanAlias"
      : prefix === "q"
        ? "queryAlias"
        : prefix === "l"
          ? "leftAlias"
          : "rightAlias";
  const value = context[key];
  context[key]++;
  const alias = `${prefix}${value}`;
  context.generatedAliases.add(alias);
  return alias;
}

const SAFE_GENERATED_IDENTIFIER =
  /^(?:[qlrt][0-9]+|_c[0-9]+|_d1_shared_[0-9]+)$/u;

function generatedIdentifier(value: string): SqlFragment {
  return SAFE_GENERATED_IDENTIFIER.test(value)
    ? text(value)
    : identifier(value);
}

function generatedColumn(
  index: number,
  alias: string,
  fieldName?: string,
): SqlFragment {
  return concat(
    generatedIdentifier(alias),
    text("."),
    fieldName === undefined
      ? generatedIdentifier(`_c${index}`)
      : identifier(fieldName),
  );
}

function generatedColumnOutputAlias(
  context: RenderContext,
  index: number,
): SqlFragment {
  return concat(
    text(context.compactGeneratedColumnAliases ? " " : " AS "),
    generatedIdentifier(`_c${index}`),
  );
}

function outputList(
  context: RenderContext,
  width: number,
  alias: string,
  outputOffset = 0,
): SqlFragment[] {
  if (
    context.projectionTransportSimplifications &&
    width > 0 &&
    outputOffset === 0
  )
    return [concat(generatedIdentifier(alias), text(".*"))];
  return Array.from({ length: width }, (_, index) =>
    concat(
      generatedColumn(index, alias),
      generatedColumnOutputAlias(context, index + outputOffset),
    ),
  );
}

function isIdentityProject(node: LogicalQueryNode): node is ProjectNode {
  return (
    node.kind === "project" &&
    node.projections.length === node.input.fields.length &&
    node.projections.every(
      ({ expression }, index) =>
        expression.kind === "column" &&
        expression.scope === node.input.scope &&
        expression.index === index,
    )
  );
}

const MAX_D1_JSON_SCALAR_ARRAY_BYTES = 1_000_000;

function jsonScalarArraySegments(node: JsonScalarArrayNode): readonly string[] {
  const encoder = new TextEncoder();
  const segments: string[] = [];
  let cells: string[] = [];
  let bytes = 2; // []
  for (const value of node.values) {
    const cell = JSON.stringify(value);
    if (cell === undefined)
      throw new DatabaseCompilerError(
        "invalid_plan",
        "JSON scalar array contains a non-serializable value",
      );
    const cellBytes = encoder.encode(cell).byteLength;
    if (cellBytes + 2 > MAX_D1_JSON_SCALAR_ARRAY_BYTES)
      throw new DatabaseCompilerError(
        "invalid_plan",
        "A JSON scalar array value exceeds the per-segment encoding limit",
      );
    const nextBytes = bytes + (cells.length === 0 ? 0 : 1) + cellBytes;
    if (cells.length > 0 && nextBytes > MAX_D1_JSON_SCALAR_ARRAY_BYTES) {
      segments.push(`[${cells.join(",")}]`);
      cells = [];
      bytes = 2;
    }
    cells.push(cell);
    bytes += (cells.length === 1 ? 0 : 1) + cellBytes;
  }
  if (cells.length > 0) segments.push(`[${cells.join(",")}]`);
  return segments;
}

function constantSql(value: string | number | null): SqlFragment {
  if (value === null) return text("NULL");
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new DatabaseCompilerError(
        "invalid_plan",
        "SQL constants must be safe integers",
      );
    return text(Object.is(value, -0) ? "0" : String(value));
  }
  if (value.includes("\0"))
    throw new DatabaseCompilerError(
      "invalid_plan",
      "SQL text constants cannot contain NUL",
    );
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new DatabaseCompilerError(
          "invalid_plan",
          "SQL text constants must contain well-formed UTF-16",
        );
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new DatabaseCompilerError(
        "invalid_plan",
        "SQL text constants must contain well-formed UTF-16",
      );
    }
  }
  return text(`'${value.replaceAll("'", "''")}'`);
}

function compileSharedRelationDefinition(
  shared: SharedRelationDefinition,
  body: SqlFragment,
  definitionIndex: number,
  finalRenderSession: FinalRenderSession,
): SqlFragment {
  const definition = concat(
    generatedIdentifier(shared.name),
    text(
      shared.materialization === "materialized"
        ? " AS MATERIALIZED ("
        : " AS (",
    ),
    body,
    text(")"),
  );
  const selection = shared.materializationSelection;
  return selection
    ? recordFinalRenderEmission(finalRenderSession, definition, {
        kind: "materialization-definition",
        definition: shared.node,
        definitionIndex,
        selectionKind: selection.kind,
        choiceIndex: selection.choiceIndex,
      })
    : definition;
}

function resolveColumn(
  expression: Extract<SqlExpression, { kind: "column" }>,
  scopes: ReadonlyMap<RelationScope, ScopeBinding>,
  context: RenderContext,
): SqlFragment {
  const binding = scopes.get(expression.scope);
  if (!binding)
    throw new DatabaseCompilerError(
      "invalid_plan",
      `No SQL scope is available for column "${expression.name}"`,
    );
  return concat(
    context.generatedAliases.has(binding.alias)
      ? generatedIdentifier(binding.alias)
      : identifier(binding.alias),
    text("."),
    binding.fieldNames?.[expression.index] === undefined
      ? generatedIdentifier(`_c${expression.index}`)
      : identifier(binding.fieldNames[expression.index]!),
  );
}

export function compileD1Expression(
  expression: SqlExpression,
  scopes: ReadonlyMap<RelationScope, ScopeBinding>,
  context: RenderContext = renderContext(new Map()),
): SqlFragment {
  const lexicographicChoice = context.lexicographicComparisons.get(expression);
  if (lexicographicChoice) {
    if (!context.suppressFinalRenderEmissions)
      context.lexicographicComparisonEmissions.set(
        lexicographicChoice,
        (context.lexicographicComparisonEmissions.get(lexicographicChoice) ??
          0) + 1,
      );
    return recordContextFinalRenderEmission(
      context,
      parenthesize(
        concat(
          text("("),
          join(
            lexicographicChoice.components.map(({ left }) =>
              compileD1Expression(left, scopes, context),
            ),
          ),
          text(`) ${lexicographicChoice.direction} (`),
          join(
            lexicographicChoice.components.map(({ right }) =>
              compileD1Expression(right, scopes, context),
            ),
          ),
          text(")"),
        ),
      ),
      { kind: "lexicographic", choice: lexicographicChoice },
    );
  }
  switch (expression.kind) {
    case "column":
      return resolveColumn(expression, scopes, context);
    case "parameter":
      return parameter(expression.value);
    case "excluded":
      return concat(
        identifier("excluded"),
        text("."),
        identifier(expression.name),
      );
    case "binary":
      return parenthesize(
        concat(
          compileD1Expression(expression.left, scopes, context),
          text(` ${expression.operator} `),
          compileD1Expression(expression.right, scopes, context),
        ),
      );
    case "distinct-from":
      return parenthesize(
        concat(
          compileD1Expression(expression.left, scopes, context),
          text(" IS NOT "),
          compileD1Expression(expression.right, scopes, context),
        ),
      );
    case "cast-integer":
      return concat(
        text("CAST("),
        compileD1Expression(expression.expression, scopes, context),
        text(" AS INTEGER)"),
      );
    case "cast-real":
      return concat(
        text("CAST("),
        compileD1Expression(expression.expression, scopes, context),
        text(" AS REAL)"),
      );
    case "cast-text":
      return concat(
        text("CAST("),
        compileD1Expression(expression.expression, scopes, context),
        text(" AS TEXT)"),
      );
    case "text-position":
      return concat(
        text("INSTR("),
        compileD1Expression(expression.text, scopes, context),
        text(", "),
        compileD1Expression(expression.needle, scopes, context),
        text(")"),
      );
    case "text-substring":
      return concat(
        text("SUBSTR("),
        compileD1Expression(expression.text, scopes, context),
        text(", "),
        compileD1Expression(expression.start, scopes, context),
        ...(expression.length
          ? [
              text(", "),
              compileD1Expression(expression.length, scopes, context),
            ]
          : []),
        text(")"),
      );
    case "text-like":
      return parenthesize(
        concat(
          compileD1Expression(expression.text, scopes, context),
          text(" LIKE "),
          compileD1Expression(expression.pattern, scopes, context),
          ...(expression.escape === undefined
            ? []
            : [text(" ESCAPE "), parameter(expression.escape)]),
        ),
      );
    case "constant":
      return constantSql(expression.value);
    case "boolean":
      return parenthesize(
        join(
          expression.expressions.map((item) =>
            compileD1Expression(item, scopes, context),
          ),
          text(` ${expression.operator} `),
        ),
      );
    case "not":
      return concat(
        text("NOT "),
        parenthesize(
          compileD1Expression(expression.expression, scopes, context),
        ),
      );
    case "null-check":
      return concat(
        compileD1Expression(expression.expression, scopes, context),
        text(expression.not ? " IS NOT NULL" : " IS NULL"),
      );
    case "in-list": {
      if (expression.values.length === 0) return text("(0)");
      const operand = compileD1Expression(
        expression.expression,
        scopes,
        context,
      );
      if (context.membershipUsage)
        context.membershipUsage.set(
          expression,
          (context.membershipUsage.get(expression) ?? 0) + 1,
        );
      const strategy = context.membershipStrategies?.get(expression);
      if (strategy?.strategy === "json-text") {
        if (typeof strategy.jsonText !== "string")
          throw new DatabaseCompilerError(
            "invalid_plan",
            "JSON membership strategy is missing its encoded values",
          );
        return concat(
          operand,
          text(" IN (SELECT value FROM json_each("),
          parameter(strategy.jsonText),
          text("))"),
        );
      }
      return concat(
        operand,
        text(" IN ("),
        join(expression.values.map((value) => parameter(value))),
        text(")"),
      );
    }
    case "in-subquery":
      return concat(
        compileD1Expression(expression.expression, scopes, context),
        text(" IN ("),
        compileQuerySource(expression.query, context, scopes),
        text(")"),
      );
    case "function":
      if (expression.name === "storage-class")
        return concat(
          text("typeof("),
          compileD1Expression(expression.arguments[0]!, scopes, context),
          text(")"),
        );
      if (expression.name === "byte-length")
        return concat(
          text("LENGTH(CAST("),
          compileD1Expression(expression.arguments[0]!, scopes, context),
          text(" AS BLOB))"),
        );
      if (expression.name === "concat-text") {
        return parenthesize(
          join(
            expression.arguments.map((item) =>
              compileD1Expression(item, scopes, context),
            ),
            text(" || "),
          ),
        );
      }
      if (
        expression.name === "text-contains" ||
        expression.name === "text-starts-with" ||
        expression.name === "text-ends-with"
      ) {
        const input = expression.arguments[0];
        const pattern = expression.arguments[1];
        if (
          expression.arguments.length !== 2 ||
          !input ||
          !pattern ||
          pattern.kind !== "parameter" ||
          typeof pattern.value !== "string"
        )
          throw new DatabaseCompilerError(
            "invalid_plan",
            `${expression.name}() must have a TEXT input and string parameter`,
          );

        // The empty literal is a match for every non-NULL string. Including
        // NULL in this OR expression preserves SQL's NULL result without
        // leaving an unused pattern binding in the compiled statement.
        if (pattern.value.length === 0)
          return parenthesize(
            concat(
              compileD1Expression(input, scopes, context),
              text(" IS NOT NULL OR NULL"),
            ),
          );

        const renderedInput = compileD1Expression(input, scopes, context);
        const renderedPattern = () =>
          compileD1Expression(pattern, scopes, context);
        if (expression.name === "text-ends-with")
          return parenthesize(
            concat(
              text("SUBSTR(CAST("),
              renderedInput,
              text(" AS BLOB), -LENGTH(CAST("),
              renderedPattern(),
              text(" AS BLOB))) = CAST("),
              renderedPattern(),
              text(" AS BLOB)"),
            ),
          );

        return parenthesize(
          concat(
            text("INSTR(CAST("),
            renderedInput,
            text(" AS BLOB), CAST("),
            renderedPattern(),
            text(" AS BLOB))"),
            text(expression.name === "text-contains" ? " > 0" : " = 1"),
          ),
        );
      }
      if (expression.name === "trim-spaces") {
        return concat(
          text("TRIM("),
          compileD1Expression(expression.arguments[0]!, scopes, context),
          text(")"),
        );
      }
      if (expression.name === "trim-characters") {
        return concat(
          text("TRIM("),
          compileD1Expression(expression.arguments[0]!, scopes, context),
          text(", "),
          compileD1Expression(expression.arguments[1]!, scopes, context),
          text(")"),
        );
      }
      if (expression.name === "trim") {
        // Match ECMAScript String.prototype.trim(), used by Filter v1's
        // trimmed-text fields. SQLite's default TRIM() only removes U+0020.
        return concat(
          text("TRIM("),
          compileD1Expression(expression.arguments[0]!, scopes, context),
          text(
            ", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))",
          ),
        );
      }
      return concat(
        text(expression.name.toUpperCase()),
        text("("),
        join(
          expression.arguments.map((item) =>
            compileD1Expression(item, scopes, context),
          ),
        ),
        text(")"),
      );
    case "aggregate":
      return concat(
        text(expression.name),
        text("("),
        expression.distinct ? text("DISTINCT ") : text(""),
        expression.expression
          ? compileD1Expression(expression.expression, scopes, context)
          : text("*"),
        text(")"),
      );
    case "coalesce":
      return concat(
        text("COALESCE("),
        join(
          expression.expressions.map((item) =>
            compileD1Expression(item, scopes, context),
          ),
        ),
        text(")"),
      );
    case "case":
      return concat(
        text("CASE"),
        ...expression.branches.map((branch) =>
          concat(
            text(" WHEN "),
            compileD1Expression(branch.when, scopes, context),
            text(" THEN "),
            compileD1Expression(branch.then, scopes, context),
          ),
        ),
        ...(expression.else
          ? [
              concat(
                text(" ELSE "),
                compileD1Expression(expression.else, scopes, context),
              ),
            ]
          : []),
        text(" END"),
      );
    case "unixepoch":
      return text("unixepoch()");
    case "scalar-subquery":
      return parenthesize(
        compileQuerySource(expression.query, context, scopes),
      );
  }
}

function extendScopes(
  outerScopes: ReadonlyMap<RelationScope, ScopeBinding>,
  bindings: readonly (readonly [RelationScope, ScopeBinding])[],
): Map<RelationScope, ScopeBinding> {
  return new Map([...outerScopes, ...bindings]);
}

function sameOutputFields(
  left: QuerySource["fields"],
  right: QuerySource["fields"],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (field, index) =>
        field.name === right[index]?.name &&
        field.affinity === right[index]?.affinity &&
        field.nullable === right[index]?.nullable,
    )
  );
}

function sameStringList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameMaterializationSelection(
  left: SharedRelationDefinition["materializationSelection"],
  right: SharedRelationDefinition["materializationSelection"],
): boolean {
  return left?.kind === right?.kind && left?.choiceIndex === right?.choiceIndex;
}

function assertCurrentSelfMembershipWitness(
  choice: PhysicalSelfMembershipChoice,
  witness: PhysicalSelfMembershipWitness,
  context: RenderContext,
): void {
  const interfaces = context.sharedRelationInterfaces;
  const producer = context.bypassSharedNode ?? interfaces?.root;
  const producerIndex = interfaces
    ? producer === interfaces.root
      ? interfaces.layout.length
      : interfaces.layout.findIndex(
          (definition) => definition.node === producer,
        )
    : -1;
  const definition = interfaces?.layout[witness.definitionIndex];
  const evidence = interfaces
    ? findPhysicalSharedRelationInterface(
        interfaces,
        witness.definition.node,
        producer ?? interfaces.root,
      )
    : undefined;
  if (
    !interfaces ||
    !producer ||
    producer !== witness.producer ||
    producerIndex !== witness.producerIndex ||
    witness.definitionIndex < 0 ||
    witness.definitionIndex >= producerIndex ||
    definition?.node !== witness.definition.node ||
    definition.name !== witness.definition.name ||
    definition.materialization !== "materialized" ||
    definition.scope !== witness.definition.scope ||
    !sameStringList(definition.dependencies, witness.definition.dependencies) ||
    !sameMaterializationSelection(
      definition.materializationSelection,
      witness.definition.materializationSelection,
    ) ||
    !sameOutputFields(definition.fields, witness.definition.fields) ||
    !sameOutputFields(definition.fields, witness.definition.node.fields) ||
    context.sharedRelations.get(witness.definition.node) !== definition.name ||
    witness.source.node !== witness.definition.node ||
    witness.source.scope !== witness.definition.node.scope ||
    !sameOutputFields(witness.source.fields, witness.definition.node.fields) ||
    !evidence ||
    evidence.definition.name !== witness.boundary.definition.name ||
    evidence.definition.node !== witness.boundary.definition.node ||
    evidence.definition.scope !== witness.boundary.definition.scope ||
    evidence.definition.materialization !==
      witness.boundary.definition.materialization ||
    !sameStringList(
      evidence.definition.dependencies,
      witness.boundary.definition.dependencies,
    ) ||
    !sameMaterializationSelection(
      evidence.definition.materializationSelection,
      witness.boundary.definition.materializationSelection,
    ) ||
    !sameOutputFields(
      evidence.definition.fields,
      witness.boundary.definition.fields,
    ) ||
    evidence.selective !== witness.boundary.selective ||
    evidence.license.kind !== witness.boundary.license.kind ||
    evidence.boundary.kind !== witness.boundary.boundary.kind ||
    evidence.closure.kind !== witness.boundary.closure.kind ||
    evidence.closure.scopeCount !== witness.boundary.closure.scopeCount ||
    evidence.closure.referencedScopeCount !==
      witness.boundary.closure.referencedScopeCount ||
    evidence.closure.referencedColumnCount !==
      witness.boundary.closure.referencedColumnCount ||
    evidence.totality.kind !== witness.boundary.totality.kind ||
    evidence.totality.stoppedAt.length !==
      witness.boundary.totality.stoppedAt.length ||
    evidence.totality.stoppedAt.some(
      (node, index) => node !== witness.boundary.totality.stoppedAt[index],
    ) ||
    choice.join.left.scope !== choice.join.left.node.scope ||
    !sameOutputFields(choice.join.left.fields, choice.join.left.node.fields) ||
    choice.leftKeyIndexes.length !== choice.rightKeyIndexes.length ||
    witness.sourceKeyIndexes.length !== choice.rightKeyIndexes.length ||
    witness.sourceKeyIndexes.some(
      (index) =>
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= witness.source.fields.length,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Derived self-membership witness does not match the current producer interface",
    );
}

function compileNode(
  node: LogicalQueryNode,
  context: RenderContext,
  outerScopes: ReadonlyMap<RelationScope, ScopeBinding>,
): SqlFragment {
  const sharedName = context.sharedRelations.get(node);
  if (sharedName && context.bypassSharedNode !== node) {
    const alias = nextAlias(context, "q");
    const rendered = concat(
      text("SELECT "),
      join(outputList(context, node.fields.length, alias)),
      text(" FROM "),
      generatedIdentifier(sharedName),
      text(" AS "),
      generatedIdentifier(alias),
    );
    const definitionIndex =
      context.sharedRelationInterfaces?.layout.findIndex(
        (definition) => definition.node === node,
      ) ?? -1;
    if (context.finalRenderSession && definitionIndex < 0)
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Shared relation reference is outside the current physical layout",
      );
    return definitionIndex < 0
      ? rendered
      : recordContextFinalRenderEmission(context, rendered, {
          kind: "shared-reference",
          definition: node,
          definitionIndex,
        });
  }
  const rowPipeline = context.rowPipelines.get(node);
  if (rowPipeline) {
    const singletonRankChoice = context.singletonRankChoices.get(node);
    const emitSingletonRankFusion =
      singletonRankChoice !== undefined &&
      canRenderSingletonRankFusion(singletonRankChoice, context);
    const scanLeaf =
      rowPipeline.leaf.node.kind === "scan" ? rowPipeline.leaf.node : undefined;
    const leafIndexes = scanLeaf
      ? [
          ...new Set([
            ...rowPipeline.outputColumnIndexes,
            ...rowPipeline.filters.flatMap(
              ({ predicateColumnIndexes }) => predicateColumnIndexes,
            ),
          ]),
        ].sort((left, right) => left - right)
      : Array.from(
          { length: rowPipeline.leaf.fields.length },
          (_unused, index) => index,
        );
    const leafIndexOffsets = new Map(
      leafIndexes.map((index, offset) => [index, offset] as const),
    );
    const source =
      emitSingletonRankFusion && singletonRankChoice
        ? compileSingletonRankWindow(singletonRankChoice, context, outerScopes)
        : scanLeaf
          ? (() => {
              const alias = nextAlias(context, "t");
              const columns = Object.values(scanLeaf.table.columns);
              const selections = leafIndexes.map((index, offset) => {
                const column = columns[index];
                if (!column)
                  throw new DatabaseCompilerError(
                    "invalid_plan",
                    "Row-pipeline scan column is outside its source schema",
                  );
                return concat(
                  generatedIdentifier(alias),
                  text("."),
                  identifier(column.sqlName),
                  generatedColumnOutputAlias(context, offset),
                );
              });
              return concat(
                text("SELECT "),
                join(selections),
                text(" FROM "),
                identifier(scanLeaf.table.name),
                text(" AS "),
                generatedIdentifier(alias),
              );
            })()
          : compileNode(rowPipeline.leaf.node, context, outerScopes);
    const alias = nextAlias(context, "q");
    const scopes = new Map(outerScopes);
    scopes.set(rowPipeline.leaf.scope, {
      alias,
      fieldNames: rowPipeline.leaf.fields.map((_field, index) => {
        const offset = leafIndexOffsets.get(index);
        return `_c${offset ?? index}`;
      }),
    });
    for (const filter of rowPipeline.filters)
      scopes.set(filter.filter.input.scope, {
        alias,
        fieldNames: filter.inputColumnIndexes.map(
          (index) => `_c${leafIndexOffsets.get(index) ?? index}`,
        ),
      });
    const selections = rowPipeline.outputColumnIndexes.map(
      (inputIndex, index) =>
        concat(
          generatedColumn(
            leafIndexOffsets.get(inputIndex) ?? inputIndex,
            alias,
          ),
          generatedColumnOutputAlias(context, index),
        ),
    );
    const predicates = rowPipeline.filters.flatMap(({ filter }) => {
      if (emitSingletonRankFusion && filter === singletonRankChoice.filter)
        return [];
      return [compileD1Expression(filter.predicate, scopes, context)];
    });
    if (emitSingletonRankFusion && !context.suppressFinalRenderEmissions)
      context.singletonRankEmissions.set(
        singletonRankChoice,
        (context.singletonRankEmissions.get(singletonRankChoice) ?? 0) + 1,
      );
    const rendered = concat(
      text("SELECT "),
      join(selections),
      text(" FROM "),
      renderSourceFrom(rowPipeline.leaf, source, alias, context),
      ...(predicates.length === 0
        ? []
        : [text(" WHERE "), join(predicates, text(" AND "))]),
    );
    return emitSingletonRankFusion && singletonRankChoice
      ? recordContextFinalRenderEmission(context, rendered, {
          kind: "singleton-rank",
          choice: singletonRankChoice,
        })
      : rendered;
  }
  switch (node.kind) {
    case "json-scalar-array": {
      if (node.values.length === 0)
        return concat(
          text("SELECT NULL"),
          generatedColumnOutputAlias(context, 0),
          text(" WHERE 0"),
        );
      const segments = jsonScalarArraySegments(node);
      return join(
        segments.map((segment) =>
          concat(
            concat(
              text('SELECT "_json_scalar".value'),
              generatedColumnOutputAlias(context, 0),
              text(" FROM json_each("),
            ),
            parameter(segment),
            text(') AS "_json_scalar"'),
          ),
        ),
        text(" UNION ALL "),
      );
    }
    case "values-relation": {
      if (context.textRowUsage)
        context.textRowUsage.set(
          node,
          (context.textRowUsage.get(node) ?? 0) + 1,
        );
      const strategy = context.textRowStrategies?.get(node);
      const selections = node.fields.map((_field, index) =>
        concat(
          strategy?.strategy === "json-rows"
            ? concat(
                text('json_extract("_tuple".value, \'$['),
                text(String(index)),
                text("]')"),
              )
            : concat(
                identifier("_values"),
                text("."),
                identifier(`column${index + 1}`),
              ),
          generatedColumnOutputAlias(context, index),
        ),
      );
      if (node.rows.length === 0)
        return concat(
          text("SELECT "),
          join(
            node.fields.map((_field, index) =>
              concat(text("NULL"), generatedColumnOutputAlias(context, index)),
            ),
          ),
          text(" WHERE 0"),
        );
      if (strategy?.strategy === "json-rows") {
        const segments = strategy.jsonSegments ?? [];
        return concat(
          text("SELECT "),
          join(selections),
          text(" FROM (VALUES "),
          join(
            segments.map((segment) =>
              concat(text("("), parameter(segment), text(")")),
            ),
          ),
          text(
            ') AS "_segments" JOIN json_each("_segments".column1) AS "_tuple"',
          ),
        );
      }
      return concat(
        text("SELECT "),
        join(selections),
        text(" FROM (VALUES "),
        join(
          node.rows.map((row) =>
            concat(
              text("("),
              join(row.map((value) => parameter(value))),
              text(")"),
            ),
          ),
        ),
        text(') AS "_values"'),
      );
    }
    case "scan": {
      const alias = nextAlias(context, "t");
      const columns = Object.values(node.table.columns);
      const selections = columns.map((item, index) =>
        concat(
          generatedIdentifier(alias),
          text("."),
          identifier(item.sqlName),
          generatedColumnOutputAlias(context, index),
        ),
      );
      return concat(
        text("SELECT "),
        join(selections),
        text(" FROM "),
        identifier(node.table.name),
        text(" AS "),
        generatedIdentifier(alias),
      );
    }
    case "filter": {
      const source = compileNode(node.input.node, context, outerScopes);
      const alias = nextAlias(context, "q");
      const scopes = extendScopes(outerScopes, [[node.input.scope, { alias }]]);
      return concat(
        text("SELECT "),
        join(outputList(context, node.fields.length, alias)),
        text(" FROM "),
        renderSourceFrom(node.input, source, alias, context),
        text(" WHERE "),
        compileD1Expression(node.predicate, scopes, context),
      );
    }
    case "project": {
      if (context.projectionTransportSimplifications && isIdentityProject(node))
        return compileNode(node.input.node, context, outerScopes);
      const directScanProjection = context.directScanProjections.get(node);
      if (directScanProjection) {
        const alias = nextAlias(context, "t");
        const selections = directScanProjection.sqlColumnNames.map(
          (sqlColumnName, index) =>
            concat(
              generatedIdentifier(alias),
              text("."),
              identifier(sqlColumnName),
              generatedColumnOutputAlias(context, index),
            ),
        );
        return concat(
          text("SELECT "),
          join(selections),
          text(" FROM "),
          identifier(directScanProjection.scan.table.name),
          text(" AS "),
          generatedIdentifier(alias),
        );
      }
      const constantFilterJoin =
        context.constantFilterJoinProjections.get(node);
      if (constantFilterJoin) {
        const source = compileNode(
          constantFilterJoin.join,
          context,
          outerScopes,
        );
        const alias = nextAlias(context, "q");
        const scopes = extendScopes(outerScopes, [
          [constantFilterJoin.filter.input.scope, { alias }],
        ]);
        return concat(
          text("SELECT "),
          join(
            node.projections.map((projection, index) =>
              concat(
                compileD1Expression(projection.expression, scopes, context),
                generatedColumnOutputAlias(context, index),
              ),
            ),
          ),
          text(" FROM "),
          renderSourceFrom(
            constantFilterJoin.filter.input,
            source,
            alias,
            context,
          ),
          text(" WHERE "),
          compileD1Expression(
            constantFilterJoin.filter.predicate,
            scopes,
            context,
          ),
        );
      }
      const positiveTupleMembership =
        context.positiveTupleMemberships.get(node);
      const selfMembership = context.selfMembershipChoices.get(node);
      if (selfMembership) {
        if (selfMembership.witness)
          assertCurrentSelfMembershipWitness(
            selfMembership,
            selfMembership.witness,
            context,
          );
        const leftSource = compileNode(
          selfMembership.join.left.node,
          context,
          outerScopes,
        );
        if (selfMembership.witness) {
          const priorSession = context.finalRenderSession;
          const priorSuppression = context.suppressFinalRenderEmissions;
          context.finalRenderSession = undefined;
          context.suppressFinalRenderEmissions = true;
          let discardedRightSource: SqlFragment;
          try {
            discardedRightSource = compileNode(
              selfMembership.join.right.node,
              context,
              outerScopes,
            );
          } finally {
            context.finalRenderSession = priorSession;
            context.suppressFinalRenderEmissions = priorSuppression;
          }
          if (discardedRightSource.bindings.length !== 0)
            throw new DatabaseCompilerError(
              "invalid_plan",
              "Derived self-membership cannot discard a parameterized right source",
            );
        }
        const leftAlias = nextAlias(context, "q");
        const leftScopes = extendScopes(outerScopes, [
          [selfMembership.join.scope, { alias: leftAlias }],
        ]);
        const selections = node.projections.map((projection, index) =>
          concat(
            compileD1Expression(projection.expression, leftScopes, context),
            generatedColumnOutputAlias(context, index),
          ),
        );
        const nullableKeyChecks = selfMembership.nullableKeyIndexes.map(
          (index) =>
            concat(generatedColumn(index, leftAlias), text(" IS NOT NULL")),
        );
        const emitted = concat(
          text("SELECT "),
          join(selections),
          text(" FROM "),
          renderSourceFrom(
            selfMembership.join.left,
            leftSource,
            leftAlias,
            context,
          ),
          ...(nullableKeyChecks.length === 0
            ? []
            : [text(" WHERE "), join(nullableKeyChecks, text(" AND "))]),
        );
        return selfMembership.witness
          ? recordContextFinalRenderEmission(context, emitted, {
              kind: "derived-self-membership",
              choice: selfMembership,
            })
          : emitted;
      }
      if (positiveTupleMembership) {
        const joinNode = positiveTupleMembership.join;
        const leftSource = compileNode(
          joinNode.left.node,
          context,
          outerScopes,
        );
        const rightSource = compileNode(
          joinNode.right.node,
          context,
          outerScopes,
        );
        const leftAlias = nextAlias(context, "q");
        const rightAlias = nextAlias(context, "q");
        const leftScopes = extendScopes(outerScopes, [
          [joinNode.scope, { alias: leftAlias }],
        ]);
        const leftTuple = positiveTupleMembership.leftKeyIndexes.map((index) =>
          generatedColumn(index, leftAlias),
        );
        const rightTuple = positiveTupleMembership.rightKeyIndexes.map(
          (index) => generatedColumn(index, rightAlias),
        );
        const selections = node.projections.map((projection, index) =>
          concat(
            compileD1Expression(projection.expression, leftScopes, context),
            generatedColumnOutputAlias(context, index),
          ),
        );
        return concat(
          text("SELECT "),
          join(selections),
          text(" FROM "),
          renderSourceFrom(joinNode.left, leftSource, leftAlias, context),
          text(" WHERE "),
          parenthesize(join(leftTuple)),
          text(" IN (SELECT "),
          join(rightTuple),
          text(" FROM "),
          renderSourceFrom(joinNode.right, rightSource, rightAlias, context),
          text(")"),
        );
      }
      const fusedInput = context.passthroughProjectFusions.get(node)?.input;
      const input = fusedInput ?? node.input;
      const source = compileNode(input.node, context, outerScopes);
      const alias = nextAlias(context, "q");
      const scopes = extendScopes(outerScopes, [[input.scope, { alias }]]);
      const selections = node.projections.map((projection, index) =>
        concat(
          compileD1Expression(projection.expression, scopes, context),
          generatedColumnOutputAlias(context, index),
        ),
      );
      return concat(
        text("SELECT "),
        join(selections),
        text(" FROM "),
        renderSourceFrom(input, source, alias, context),
      );
    }
    case "join": {
      const leftSql = compileNode(node.left.node, context, outerScopes);
      const rightSql = compileNode(node.right.node, context, outerScopes);
      const leftAlias = nextAlias(context, "l");
      const rightAlias = nextAlias(context, "r");
      const scopes = extendScopes(outerScopes, [
        [node.left.scope, { alias: leftAlias }],
        [node.right.scope, { alias: rightAlias }],
      ]);
      const sparseOutputs = context.sparseJoinOutputs.get(node);
      const joinOrder = context.joinOrderStrategies.get(node);
      const conditionalLookup = context.conditionalLookupChoices.get(node);
      const joinCondition = conditionalLookup
        ? compileConditionalLookupCondition(conditionalLookup)
        : node.condition;
      const selections = sparseOutputs
        ? node.fields.map((_field, index) => {
            if (!sparseOutputs.has(index))
              return concat(
                text("NULL"),
                generatedColumnOutputAlias(context, index),
              );
            return index < node.left.fields.length
              ? concat(
                  generatedColumn(index, leftAlias),
                  generatedColumnOutputAlias(context, index),
                )
              : concat(
                  generatedColumn(index - node.left.fields.length, rightAlias),
                  generatedColumnOutputAlias(context, index),
                );
          })
        : [
            ...outputList(context, node.left.fields.length, leftAlias),
            ...outputList(
              context,
              node.right.fields.length,
              rightAlias,
              node.left.fields.length,
            ),
          ];
      return concat(
        text("SELECT "),
        join(selections),
        text(" FROM "),
        joinOrder?.driver === "right"
          ? concat(
              renderSourceFrom(node.right, rightSql, rightAlias, context),
              text(" CROSS JOIN "),
              renderSourceFrom(node.left, leftSql, leftAlias, context),
              text(" WHERE "),
              compileD1Expression(joinCondition, scopes, context),
            )
          : joinOrder?.driver === "left"
            ? concat(
                renderSourceFrom(node.left, leftSql, leftAlias, context),
                text(" CROSS JOIN "),
                renderSourceFrom(node.right, rightSql, rightAlias, context),
                text(" WHERE "),
                compileD1Expression(joinCondition, scopes, context),
              )
            : concat(
                renderSourceFrom(node.left, leftSql, leftAlias, context),
                text(node.joinType === "left" ? " LEFT JOIN " : " INNER JOIN "),
                renderSourceFrom(node.right, rightSql, rightAlias, context),
                text(" ON "),
                compileD1Expression(joinCondition, scopes, context),
              ),
      );
    }
    case "semi-join":
    case "anti-join": {
      const leftSql = compileNode(node.left.node, context, outerScopes);
      const rightSql = compileNode(node.right.node, context, outerScopes);
      const leftAlias = nextAlias(context, "l");
      const rightAlias = nextAlias(context, "r");
      const semiMembership =
        node.kind === "semi-join"
          ? context.semiMemberships.get(node)
          : undefined;
      if (semiMembership && canRenderSemiMembership(semiMembership, context)) {
        const leftKeys = semiMembership.leftKeyIndexes.map((index) =>
          generatedColumn(index, leftAlias),
        );
        const rightKeys = semiMembership.rightKeyIndexes.map((index) =>
          generatedColumn(index, rightAlias),
        );
        if (!context.suppressFinalRenderEmissions)
          context.semiMembershipEmissions.set(
            semiMembership,
            (context.semiMembershipEmissions.get(semiMembership) ?? 0) + 1,
          );
        return recordContextFinalRenderEmission(
          context,
          concat(
            text("SELECT "),
            join(outputList(context, node.fields.length, leftAlias)),
            text(" FROM "),
            renderSourceFrom(node.left, leftSql, leftAlias, context),
            text(" WHERE "),
            parenthesize(join(leftKeys)),
            text(" IN (SELECT "),
            join(rightKeys),
            text(" FROM "),
            renderSourceFrom(node.right, rightSql, rightAlias, context),
            text(")"),
          ),
          { kind: "semi-membership", choice: semiMembership },
        );
      }
      const scopes = extendScopes(outerScopes, [
        [node.left.scope, { alias: leftAlias }],
        [node.right.scope, { alias: rightAlias }],
      ]);
      return concat(
        text("SELECT "),
        join(outputList(context, node.fields.length, leftAlias)),
        text(" FROM "),
        renderSourceFrom(node.left, leftSql, leftAlias, context),
        text(
          node.kind === "semi-join"
            ? " WHERE EXISTS (SELECT 1 FROM "
            : " WHERE NOT EXISTS (SELECT 1 FROM ",
        ),
        renderSourceFrom(node.right, rightSql, rightAlias, context),
        text(" WHERE "),
        compileD1Expression(node.condition, scopes, context),
        text(")"),
      );
    }
    case "aggregate": {
      const source = compileNode(node.input.node, context, outerScopes);
      const alias = nextAlias(context, "q");
      const scopes = extendScopes(outerScopes, [[node.input.scope, { alias }]]);
      const projected = [...node.groups, ...node.aggregates].map(
        (projection, index) =>
          concat(
            compileD1Expression(projection.expression, scopes, context),
            generatedColumnOutputAlias(context, index),
          ),
      );
      return concat(
        text("SELECT "),
        join(projected),
        text(" FROM "),
        renderSourceFrom(node.input, source, alias, context),
        ...(node.groups.length === 0
          ? []
          : [
              text(" GROUP BY "),
              join(
                node.groups.map((group) =>
                  compileD1Expression(group.expression, scopes, context),
                ),
              ),
            ]),
      );
    }
    case "distinct": {
      const source = compileNode(node.input.node, context, outerScopes);
      const alias = nextAlias(context, "q");
      return concat(
        text("SELECT DISTINCT "),
        join(outputList(context, node.fields.length, alias)),
        text(" FROM "),
        renderSourceFrom(node.input, source, alias, context),
      );
    }
    case "window": {
      const source = compileNode(node.input.node, context, outerScopes);
      const alias = nextAlias(context, "q");
      const scopes = extendScopes(outerScopes, [[node.input.scope, { alias }]]);
      const selections = node.windows.map(({ specification }, index) => {
        const partitions = specification.partitionBy;
        const partition =
          partitions.length === 0
            ? []
            : [
                text("PARTITION BY "),
                join(
                  partitions.map((expression) =>
                    compileD1Expression(expression, scopes, context),
                  ),
                ),
              ];
        const functionSql =
          specification.kind === "row-number"
            ? concat(
                text("ROW_NUMBER()"),
                text(" OVER ("),
                ...partition,
                ...(partitions.length > 0 ? [text(" ")] : []),
                text("ORDER BY "),
                renderWindowOrderBy({
                  keys: specification.orderBy,
                  windowIndex: index,
                  choices: context.nativeNullOrderingChoices.get(node) ?? [],
                  renderExpression: (expression) =>
                    compileD1Expression(expression, scopes, context),
                  session: context.finalRenderSession,
                }),
                text(")"),
              )
            : concat(text("COUNT(*) OVER ("), ...partition, text(")"));
        return concat(
          functionSql,
          generatedColumnOutputAlias(context, node.input.fields.length + index),
        );
      });
      return concat(
        text("SELECT "),
        join([
          ...outputList(context, node.input.fields.length, alias),
          ...selections,
        ]),
        text(" FROM "),
        renderSourceFrom(node.input, source, alias, context),
      );
    }
    case "sort": {
      const source = compileNode(node.input.node, context, outerScopes);
      const alias = nextAlias(context, "q");
      const scopes = extendScopes(outerScopes, [[node.input.scope, { alias }]]);
      const compileOrderHelper =
        context.compileOrderRoot === node
          ? context.compileOrderHelper
          : undefined;
      return concat(
        text("SELECT "),
        join(outputList(context, node.fields.length, alias)),
        text(" FROM "),
        ...(compileOrderHelper
          ? [
              renderCompileOrderCrossJoin(compileOrderHelper),
              text(" CROSS JOIN "),
            ]
          : []),
        renderSourceFrom(node.input, source, alias, context),
        ...(compileOrderHelper
          ? [text(" WHERE "), renderCompileOrderGuard(compileOrderHelper)]
          : []),
        text(" ORDER BY "),
        join(
          node.keys.map((key) =>
            concat(
              compileD1Expression(key.expression, scopes, context),
              text(` ${key.direction}`),
            ),
          ),
        ),
      );
    }
    case "limit": {
      const source = compileNode(node.input.node, context, outerScopes);
      const alias = nextAlias(context, "q");
      return concat(
        text("SELECT "),
        join(outputList(context, node.fields.length, alias)),
        text(" FROM "),
        renderSourceFrom(node.input, source, alias, context),
        text(" LIMIT "),
        compileD1Expression(node.count, outerScopes, context),
        ...(node.offset
          ? [
              text(" OFFSET "),
              compileD1Expression(node.offset, outerScopes, context),
            ]
          : []),
      );
    }
    case "union": {
      const leftSql = compileNode(node.left.node, context, outerScopes);
      const rightSql = compileNode(node.right.node, context, outerScopes);
      const leftAlias = nextAlias(context, "l");
      const rightAlias = nextAlias(context, "r");
      return concat(
        text("SELECT "),
        join(outputList(context, node.fields.length, leftAlias)),
        text(" FROM "),
        parenthesize(leftSql),
        text(" AS "),
        generatedIdentifier(leftAlias),
        text(node.all ? " UNION ALL " : " UNION "),
        text("SELECT "),
        join(outputList(context, node.fields.length, rightAlias)),
        text(" FROM "),
        parenthesize(rightSql),
        text(" AS "),
        generatedIdentifier(rightAlias),
      );
    }
    case "recursive-closure":
      return compileRecursiveClosure(node, context);
  }
}

function compileRecursiveClosure(
  node: Extract<LogicalQueryNode, { kind: "recursive-closure" }>,
  context: RenderContext,
): SqlFragment {
  const cteName = recursiveCteName(context);
  const recursiveAlias = nextAlias(context, "r");
  const candidateAlias = nextAlias(context, "l");
  const outputAlias = nextAlias(context, "q");
  const cteColumns = node.fields.map((_field, index) => `_c${index}`);
  const anchor = compileQuerySource(node.seed, context, new Map());
  const candidate = compileQuerySource(node.candidates, context, new Map());
  const predicateScopes = extendScopes(new Map(), [
    [node.currentScope, { alias: recursiveAlias, fieldNames: cteColumns }],
    [
      node.candidateScope,
      {
        alias: candidateAlias,
        fieldNames: node.candidates.fields.map(({ name }) => name),
      },
    ],
  ]);
  const recursiveStep = concat(
    text("SELECT "),
    join(
      node.candidates.fields.map((field, index) =>
        concat(
          generatedColumn(index, candidateAlias, field.name),
          generatedColumnOutputAlias(context, index),
        ),
      ),
    ),
    text(" FROM "),
    identifier(cteName),
    text(" AS "),
    generatedIdentifier(recursiveAlias),
    text(" INNER JOIN "),
    parenthesize(candidate),
    text(" AS "),
    generatedIdentifier(candidateAlias),
    text(" ON "),
    compileD1Expression(node.predicate, predicateScopes, context),
  );
  return concat(
    text("WITH RECURSIVE "),
    identifier(cteName),
    text(" ("),
    join(cteColumns.map(generatedIdentifier)),
    text(") AS ("),
    anchor,
    text(" UNION "),
    recursiveStep,
    text(") SELECT "),
    join(outputList(context, node.fields.length, outputAlias)),
    text(" FROM "),
    identifier(cteName),
    text(" AS "),
    generatedIdentifier(outputAlias),
  );
}

function compileQuerySource(
  source: QuerySource,
  context: RenderContext,
  outerScopes: ReadonlyMap<RelationScope, ScopeBinding>,
): SqlFragment {
  const inner = compileNode(source.node, context, outerScopes);
  const alias = nextAlias(context, "q");
  const projections = source.fields.map((field, index) =>
    concat(generatedColumn(index, alias), text(" AS "), identifier(field.name)),
  );
  return concat(
    text("SELECT "),
    join(projections),
    text(" FROM "),
    parenthesize(inner),
    text(" AS "),
    generatedIdentifier(alias),
  );
}

function renderSourceFrom(
  source: QuerySource,
  sourceSql: SqlFragment,
  alias: string,
  context: RenderContext,
): SqlFragment {
  return renderMaterializedRelationReference({
    source,
    producer: context.bypassSharedNode ?? null,
    interfaces: context.sharedRelationInterfaces,
    definitionName: context.sharedRelations.get(source.node),
    sourceSql,
    alias,
    session: context.finalRenderSession,
  });
}

function canRenderSingletonRankFusion(
  choice: PhysicalSingletonRankChoice,
  context: RenderContext,
): boolean {
  const interfaces = context.sharedRelationInterfaces;
  if (!context.singletonRankFusionEnabled || !interfaces) return false;
  const producer = context.bypassSharedNode ?? null;
  const producerIndex = producer
    ? interfaces.layout.findIndex((definition) => definition.node === producer)
    : interfaces.layout.length;
  if (producer && producerIndex < 0) return false;
  if (
    !choice.renderContexts.some(
      (candidate) =>
        candidate.producer === producer &&
        candidate.producerIndex === producerIndex,
    )
  )
    return false;
  for (const dependency of choice.boundaryDependencies) {
    if (
      dependency.consumerProducer !== producer ||
      dependency.consumerProducerIndex !== producerIndex
    )
      continue;
    const layoutIndex = interfaces.layout.findIndex(
      (definition) => definition.node === dependency.node,
    );
    const boundary = interfaces.interfaces.find(
      (candidate) => candidate.definition.node === dependency.node,
    );
    if (
      layoutIndex !== dependency.producerIndex ||
      layoutIndex < 0 ||
      layoutIndex >= producerIndex ||
      interfaces.layout[layoutIndex]?.name !== dependency.definitionName ||
      interfaces.layout[layoutIndex]?.materialization !== "materialized" ||
      boundary?.definition.name !== dependency.definitionName ||
      !findPhysicalSharedRelationInterface(
        interfaces,
        dependency.node,
        producer ?? interfaces.root,
      )
    )
      return false;
  }
  return true;
}

function compileSingletonRankWindow(
  choice: PhysicalSingletonRankChoice,
  context: RenderContext,
  outerScopes: ReadonlyMap<RelationScope, ScopeBinding>,
): SqlFragment {
  const { window } = choice;
  const source = compileNode(window.input.node, context, outerScopes);
  const alias = nextAlias(context, "q");
  const selections = window.input.fields.map((_field, index) =>
    concat(
      generatedColumn(index, alias),
      generatedColumnOutputAlias(context, index),
    ),
  );
  selections.push(
    concat(
      text("1"),
      generatedColumnOutputAlias(context, choice.rankOutputIndex),
    ),
  );
  return concat(
    text("SELECT DISTINCT "),
    join(selections),
    text(" FROM "),
    renderSourceFrom(window.input, source, alias, context),
  );
}

function renderContext(
  sharedRelations: ReadonlyMap<LogicalQueryNode, string>,
  membershipStrategies?: RenderContext["membershipStrategies"],
  membershipUsage?: RenderContext["membershipUsage"],
  directScanProjections: RenderContext["directScanProjections"] = new Map(),
  reservedIdentifiers: ReadonlySet<string> = new Set(),
  textRowStrategies?: RenderContext["textRowStrategies"],
  textRowUsage?: RenderContext["textRowUsage"],
  passthroughProjectFusions: RenderContext["passthroughProjectFusions"] = new Map(),
  constantFilterJoinProjections: RenderContext["constantFilterJoinProjections"] = new Map(),
  sparseJoinOutputs: RenderContext["sparseJoinOutputs"] = new Map(),
  positiveTupleMemberships: RenderContext["positiveTupleMemberships"] = new Map(),
  selfMembershipChoices: RenderContext["selfMembershipChoices"] = new Map(),
  projectionTransportSimplifications = true,
  joinOrderStrategies: RenderContext["joinOrderStrategies"] = new Map(),
  conditionalLookupChoices: RenderContext["conditionalLookupChoices"] = new Map(),
  rowPipelines: RenderContext["rowPipelines"] = new Map(),
  compactGeneratedColumnAliases = false,
  lexicographicChoices: readonly PhysicalLexicographicComparisonChoice[] = [],
  sharedRelationInterfaces?: PhysicalSharedRelationInterfaceView,
  semiMembershipChoices: readonly PhysicalSemiMembershipChoice[] = [],
  singletonRankChoices: readonly PhysicalSingletonRankChoice[] = [],
  singletonRankFusionEnabled = true,
  finalRenderSession?: FinalRenderSession,
  nativeNullOrderingChoices: readonly PhysicalNativeNullOrderingChoice[] = [],
): RenderContext {
  const lexicographicComparisons = new Map(
    lexicographicChoices.map((choice) => [choice.expression, choice] as const),
  );
  const nullOrderingByWindow = new Map<
    WindowNode,
    PhysicalNativeNullOrderingChoice[]
  >();
  for (const choice of nativeNullOrderingChoices) {
    const choices = nullOrderingByWindow.get(choice.window) ?? [];
    choices.push(choice);
    nullOrderingByWindow.set(choice.window, choices);
  }
  return {
    scanAlias: 0,
    queryAlias: 0,
    leftAlias: 0,
    rightAlias: 0,
    recursiveCteAlias: 0,
    reservedIdentifiers: new Set(reservedIdentifiers),
    generatedAliases: new Set(),
    sharedRelations,
    directScanProjections,
    passthroughProjectFusions,
    rowPipelines,
    singletonRankChoices: new Map(
      singletonRankChoices.map(
        (choice) => [choice.pipeline.root, choice] as const,
      ),
    ),
    singletonRankEmissions: new Map(),
    singletonRankFusionEnabled,
    nativeNullOrderingChoices: nullOrderingByWindow,
    ...(finalRenderSession ? { finalRenderSession } : {}),
    lexicographicComparisons,
    lexicographicComparisonEmissions: new Map(),
    ...(sharedRelationInterfaces ? { sharedRelationInterfaces } : {}),
    constantFilterJoinProjections,
    sparseJoinOutputs,
    positiveTupleMemberships,
    selfMembershipChoices,
    semiMemberships: new Map(
      semiMembershipChoices.map((choice) => [choice.node, choice] as const),
    ),
    semiMembershipEmissions: new Map(),
    joinOrderStrategies,
    conditionalLookupChoices,
    projectionTransportSimplifications,
    compactGeneratedColumnAliases,
    ...(membershipStrategies ? { membershipStrategies } : {}),
    ...(membershipUsage ? { membershipUsage } : {}),
    ...(textRowStrategies ? { textRowStrategies } : {}),
    ...(textRowUsage ? { textRowUsage } : {}),
  };
}

/** A shadow main render owns only disposable counters and emission maps. */
function forkRenderContextForProbe(context: RenderContext): RenderContext {
  return {
    ...context,
    reservedIdentifiers: new Set(context.reservedIdentifiers),
    generatedAliases: new Set(context.generatedAliases),
    lexicographicComparisonEmissions: new Map(),
    singletonRankEmissions: new Map(),
    semiMembershipEmissions: new Map(),
    ...(context.membershipUsage ? { membershipUsage: new Map() } : {}),
    ...(context.textRowUsage ? { textRowUsage: new Map() } : {}),
    bypassSharedNode: undefined,
    compileOrderRoot: undefined,
    compileOrderHelper: undefined,
  };
}

function compileOrderReferencesForFragment(
  session: FinalRenderSession,
  fragment: SqlFragment,
): readonly CompileOrderSharedReference[] {
  return [...finalRenderEmissionCounts(session, fragment).sharedReferences].map(
    ([definition, reference]) => ({
      definition: definition as LogicalQueryNode,
      definitionIndex: reference.definitionIndex,
      emissionCount: reference.emissionCount,
    }),
  );
}

function canRenderSemiMembership(
  choice: PhysicalSemiMembershipChoice,
  context: RenderContext,
): boolean {
  const interfaces = context.sharedRelationInterfaces;
  if (!interfaces) return false;
  const currentProducer = context.bypassSharedNode ?? interfaces.root;
  for (const stop of choice.materializedStops) {
    if (!context.sharedRelations.has(stop)) return false;
    const evidence = findPhysicalSharedRelationInterface(
      interfaces,
      stop,
      currentProducer,
    );
    if (
      !evidence ||
      evidence.boundary.kind !== "materialized-relation" ||
      evidence.closure.kind !== "scope-and-exported-columns-closed" ||
      evidence.totality.kind !== "checked-through-current-boundaries"
    )
      return false;
  }
  return true;
}

function recursiveCteName(context: RenderContext): string {
  let name: string;
  do {
    name = `_d1_recursive_${context.recursiveCteAlias++}`;
  } while (context.reservedIdentifiers.has(name));
  context.reservedIdentifiers.add(name);
  return name;
}

function reservePlanIdentifiers(
  physical: PhysicalQueryPlan<object>,
): Set<string> {
  const identifiers = new Set(physical.sharedRelations.map(({ name }) => name));
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.kind === "scan") identifiers.add(node.table.name);
    const children =
      node.kind === "scan" ||
      node.kind === "values-relation" ||
      node.kind === "json-scalar-array"
        ? []
        : node.kind === "filter" ||
            node.kind === "project" ||
            node.kind === "aggregate" ||
            node.kind === "distinct" ||
            node.kind === "window" ||
            node.kind === "sort" ||
            node.kind === "limit"
          ? [node.input]
          : node.kind === "recursive-closure"
            ? [node.seed, node.candidates]
            : [node.left, node.right];
    for (const child of children) visit(child.node);
    const expressions =
      node.kind === "filter"
        ? [node.predicate]
        : node.kind === "project"
          ? node.projections.map(({ expression }) => expression)
          : node.kind === "join" ||
              node.kind === "semi-join" ||
              node.kind === "anti-join"
            ? [node.condition]
            : node.kind === "aggregate"
              ? [
                  ...node.groups.map(({ expression }) => expression),
                  ...node.aggregates.map(({ expression }) => expression),
                ]
              : node.kind === "sort"
                ? node.keys.map(({ expression }) => expression)
                : node.kind === "window"
                  ? node.windows.flatMap(({ specification }) => [
                      ...specification.partitionBy,
                      ...(specification.kind === "row-number"
                        ? specification.orderBy.map(
                            ({ expression }) => expression,
                          )
                        : []),
                    ])
                  : node.kind === "limit"
                    ? [node.count, ...(node.offset ? [node.offset] : [])]
                    : node.kind === "recursive-closure"
                      ? [node.predicate]
                      : [];
    const visitExpressionQueries = (expression: SqlExpression): void => {
      switch (expression.kind) {
        case "binary":
        case "distinct-from":
          visitExpressionQueries(expression.left);
          visitExpressionQueries(expression.right);
          break;
        case "boolean":
          expression.expressions.forEach(visitExpressionQueries);
          break;
        case "not":
        case "null-check":
        case "cast-integer":
        case "cast-real":
        case "cast-text":
          visitExpressionQueries(expression.expression);
          break;
        case "text-position":
          visitExpressionQueries(expression.text);
          visitExpressionQueries(expression.needle);
          break;
        case "text-substring":
          visitExpressionQueries(expression.text);
          visitExpressionQueries(expression.start);
          if (expression.length) visitExpressionQueries(expression.length);
          break;
        case "text-like":
          visitExpressionQueries(expression.text);
          visitExpressionQueries(expression.pattern);
          break;
        case "in-list":
          visitExpressionQueries(expression.expression);
          break;
        case "in-subquery":
          visitExpressionQueries(expression.expression);
          visit(expression.query.node);
          break;
        case "function":
          expression.arguments.forEach(visitExpressionQueries);
          break;
        case "aggregate":
          if (expression.expression)
            visitExpressionQueries(expression.expression);
          break;
        case "coalesce":
          expression.expressions.forEach(visitExpressionQueries);
          break;
        case "case":
          expression.branches.forEach((branch) => {
            visitExpressionQueries(branch.when);
            visitExpressionQueries(branch.then);
          });
          if (expression.else) visitExpressionQueries(expression.else);
          break;
        case "scalar-subquery":
          visit(expression.query.node);
          break;
        case "column":
        case "parameter":
        case "excluded":
        case "unixepoch":
        case "constant":
          break;
      }
    };
    expressions.forEach(visitExpressionQueries);
  };
  visit(physical.root);
  return identifiers;
}

function reserveCompileOrderIdentifiers(
  physical: PhysicalQueryPlan<object>,
  current: ReadonlySet<string>,
): Set<string> {
  const identifiers = new Set(current);
  for (const field of physical.fields) identifiers.add(field.name);
  for (const definition of physical.sharedRelations)
    for (const field of definition.fields) identifiers.add(field.name);
  return identifiers;
}

export interface D1CompileOptions {
  readonly tag?: string;
}

interface FinalRenderCompileCapture {
  compiledQuery?: CompiledQuery<object>;
  diagnostic?: FinalRenderTestDiagnostic;
  compileOrderGraph?: {
    readonly mainReferences: readonly {
      readonly definitionIndex: number;
      readonly emissionCount: number;
    }[];
    readonly definitionReferences: readonly {
      readonly definitionIndex: number;
      readonly referenceIndexes: readonly number[];
    }[];
    readonly scheduledDefinitionIndexes: readonly number[] | null;
  };
}

export type D1CompilePhase =
  | "lower-physical-validation-and-selection"
  | "sql-render-parameter-layout-budget"
  | "compiler-total";
export type D1CompilePhaseReporter = (
  phase: D1CompilePhase,
  elapsedMs: number,
) => void;

function compileClockNow(): number {
  try {
    const value = globalThis.performance?.now() ?? Date.now();
    return Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}

export function compileD1Query<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
>(
  relation: Relation<Row, Columns>,
  options?: D1CompileOptions,
): CompiledQuery<Row>;
export function compileD1Query<Row extends object>(
  plan: PhysicalQueryPlan<Row>,
  options?: D1CompileOptions,
): CompiledQuery<Row>;
export function compileD1Query(
  plan:
    | Relation<object, Readonly<Record<string, AnyExpression>>>
    | PhysicalQueryPlan<object>,
  options: D1CompileOptions = {},
): CompiledQuery<object> {
  return compileD1QueryInternal(plan, options, true);
}

/** @internal Exposes the exact final render frame to focused compiler tests. */
export function compileD1QueryWithFinalRenderForTest(
  plan:
    | Relation<object, Readonly<Record<string, AnyExpression>>>
    | PhysicalQueryPlan<object>,
  options: D1CompileOptions = {},
): {
  readonly query: CompiledQuery<object>;
  readonly finalRender: FinalRenderTestDiagnostic & {
    readonly query: CompiledQuery<object>;
  };
} {
  const capture: FinalRenderCompileCapture = {};
  const query = compileD1QueryInternal(
    plan,
    options,
    true,
    true,
    true,
    false,
    true,
    true,
    false,
    true,
    capture,
  );
  if (capture.compiledQuery !== query || capture.diagnostic === undefined)
    throw new Error("final_render_capture_did_not_match_compiled_query");
  return {
    query,
    finalRender: { ...capture.diagnostic, query },
  };
}

/** @internal Captures one exact compile attempt and request-local phase timings. */
export function compileD1QueryWithDiagnosticsForTest(
  plan:
    | Relation<object, Readonly<Record<string, AnyExpression>>>
    | PhysicalQueryPlan<object>,
  options: D1CompileOptions = {},
  reportPhase?: D1CompilePhaseReporter,
): {
  readonly query: CompiledQuery<object>;
  readonly finalRender: FinalRenderTestDiagnostic & {
    readonly query: CompiledQuery<object>;
  };
  readonly compileOrderGraph?: FinalRenderCompileCapture["compileOrderGraph"];
} {
  const capture: FinalRenderCompileCapture = {};
  const query = compileD1QueryInternal(
    plan,
    options,
    true,
    true,
    true,
    false,
    true,
    true,
    false,
    true,
    capture,
    false,
    reportPhase,
  );
  if (capture.compiledQuery !== query || capture.diagnostic === undefined)
    throw new Error("compile_diagnostic_capture_did_not_match_query");
  return {
    query,
    finalRender: { ...capture.diagnostic, query },
    ...(capture.compileOrderGraph
      ? { compileOrderGraph: capture.compileOrderGraph }
      : {}),
  };
}

/** Internal, budget-checked expansion path for compiler differential tests. */
export function compileD1QueryUnoptimizedForTest(
  plan:
    | Relation<object, Readonly<Record<string, AnyExpression>>>
    | PhysicalQueryPlan<object>,
  options: D1CompileOptions = {},
): CompiledQuery<object> {
  return compileD1QueryInternal(plan, options, false, false, false, false);
}

/** Exercise the defensive non-tuple renderer for final-choice tests. */
export function compileD1QueryTupleMembershipFallbackForTest(
  plan:
    | Relation<object, Readonly<Record<string, AnyExpression>>>
    | PhysicalQueryPlan<object>,
  options: D1CompileOptions = {},
): CompiledQuery<object> {
  return compileD1QueryInternal(plan, options, true, true, true, true, true);
}

/** Keep all physical choices enabled except Generic SemiJoin membership. */
export function compileD1QuerySemiMembershipFallbackForTest(
  plan:
    | Relation<object, Readonly<Record<string, AnyExpression>>>
    | PhysicalQueryPlan<object>,
  options: D1CompileOptions = {},
): CompiledQuery<object> {
  return compileD1QueryInternal(
    plan,
    options,
    true,
    true,
    true,
    false,
    true,
    false,
  );
}

/**
 * Emit freshly validated safe candidates while bypassing only default cost
 * selection. Domain, totality, validator, and producer checks still run.
 */
export function compileD1QuerySemiMembershipForceSafeForTest(
  plan:
    | Relation<object, Readonly<Record<string, AnyExpression>>>
    | PhysicalQueryPlan<object>,
): CompiledQuery<object> {
  return compileD1QueryInternal(
    plan,
    {},
    true,
    true,
    true,
    false,
    true,
    true,
    true,
  );
}

/** @internal Keep every existing optimizer enabled while disabling only singleton-rank fusion. */
export function compileD1QueryWithoutSingletonRankFusionForTest(
  plan:
    | Relation<object, Readonly<Record<string, AnyExpression>>>
    | PhysicalQueryPlan<object>,
  options: D1CompileOptions = {},
): CompiledQuery<object> {
  return compileD1QueryInternal(
    plan,
    options,
    true,
    true,
    true,
    false,
    true,
    true,
    false,
    false,
  );
}

/** @internal Disable only the materialization compile-order helper for differential tests. */
export function compileD1QueryWithoutCompileOrderForTest(
  plan:
    | Relation<object, Readonly<Record<string, AnyExpression>>>
    | PhysicalQueryPlan<object>,
  options: D1CompileOptions = {},
): CompiledQuery<object> {
  return compileD1QueryInternal(
    plan,
    options,
    true,
    true,
    true,
    false,
    true,
    true,
    false,
    true,
    undefined,
    true,
  );
}

function compileD1QueryInternal(
  plan:
    | Relation<object, Readonly<Record<string, AnyExpression>>>
    | PhysicalQueryPlan<object>,
  options: D1CompileOptions,
  includeSharedRelations: boolean,
  includePassthroughProjectFusions = includeSharedRelations,
  includeConstantFilterJoinProjections = includeSharedRelations,
  forceTupleMembershipFallbackForTest = false,
  includeRowPipelines = includeSharedRelations,
  includeSemiMemberships = includeSharedRelations,
  forceSafeSemiMembershipsForTest = false,
  enableSingletonRankFusion = true,
  finalRenderCapture?: FinalRenderCompileCapture,
  disableCompileOrderForTest = false,
  reportPhase?: D1CompilePhaseReporter,
): CompiledQuery<object> {
  const compilerStartedAt = reportPhase ? compileClockNow() : 0;
  const physical = (
    "kind" in plan && plan.kind === "physical-query"
      ? plan
      : lowerLogicalPlan(plan)
  ) as PhysicalQueryPlan<object>;
  const sharedRelationInterfaces = validatePhysicalQueryPlan(physical);
  const {
    physical: canonicalPhysical,
    nativeQuery,
    finalRenderSession,
  } = optimizeForFinalShape(
    physical,
    includePassthroughProjectFusions,
    includeConstantFilterJoinProjections,
    includeSharedRelations,
    forceTupleMembershipFallbackForTest,
    includeRowPipelines,
    includeSharedRelations,
    sharedRelationInterfaces,
    includeSemiMemberships,
    forceSafeSemiMembershipsForTest,
    enableSingletonRankFusion,
  );
  if (reportPhase)
    reportPhase(
      "lower-physical-validation-and-selection",
      compileClockNow() - compilerStartedAt,
    );
  const runFinalCompile = (
    compile: () => CompiledQuery<object>,
  ): CompiledQuery<object> => {
    if (!reportPhase) return compile();
    const renderStartedAt = compileClockNow();
    try {
      return compile();
    } finally {
      const finishedAt = compileClockNow();
      reportPhase(
        "sql-render-parameter-layout-budget",
        finishedAt - renderStartedAt,
      );
      reportPhase("compiler-total", finishedAt - compilerStartedAt);
    }
  };
  if (
    physical.membershipOptimization !== undefined &&
    !hasSamePhysicalMembershipOptimization(
      physical.membershipOptimization,
      canonicalPhysical.membershipOptimization!,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical query membership strategy does not match its measured budget",
    );

  if (includeSharedRelations) {
    const membershipOptimization = canonicalPhysical.membershipOptimization!;
    const hasJsonStrategy =
      membershipOptimization.strategies.some(
        (strategy) => strategy.strategy === "json-text",
      ) ||
      (membershipOptimization.rowStrategies ?? []).some(
        (strategy) => strategy.strategy === "json-rows",
      ) ||
      (membershipOptimization.tupleMemberships ?? []).length > 0;
    if (!hasJsonStrategy && !canonicalPhysical.compileOrderPolicy) {
      try {
        return runFinalCompile(() =>
          compileAndBudget(
            nativeQuery,
            options,
            undefined,
            (emissions) =>
              physicalPlanShape(canonicalPhysical, true, emissions),
            finalRenderSession,
            finalRenderCapture,
          ),
        );
      } catch (error) {
        if (
          !(error instanceof D1StatementBudgetError) ||
          error.item !== "sql_bytes"
        )
          throw error;
        return runFinalCompile(() =>
          renderAndBudget(
            canonicalPhysical,
            options,
            true,
            sharedRelationInterfaces,
            membershipOptimization.strategies,
            membershipOptimization.selectedBindingCount,
            membershipOptimization.rowStrategies ?? [],
            includePassthroughProjectFusions,
            includeConstantFilterJoinProjections,
            includeRowPipelines,
            true,
            false,
            includeSemiMemberships,
            forceSafeSemiMembershipsForTest,
            enableSingletonRankFusion,
            finalRenderCapture,
            disableCompileOrderForTest,
          ),
        );
      }
    }
    return runFinalCompile(() =>
      renderAndBudget(
        canonicalPhysical,
        options,
        true,
        sharedRelationInterfaces,
        membershipOptimization.strategies,
        membershipOptimization.selectedBindingCount,
        membershipOptimization.rowStrategies ?? [],
        includePassthroughProjectFusions,
        includeConstantFilterJoinProjections,
        includeRowPipelines,
        false,
        true,
        includeSemiMemberships,
        forceSafeSemiMembershipsForTest,
        enableSingletonRankFusion,
        finalRenderCapture,
        disableCompileOrderForTest,
      ),
    );
  }

  return runFinalCompile(() =>
    renderAndBudget(
      physical,
      options,
      false,
      sharedRelationInterfaces,
      undefined,
      undefined,
      [],
      includePassthroughProjectFusions,
      includeConstantFilterJoinProjections,
      includeRowPipelines,
      false,
      true,
      includeSemiMemberships,
      forceSafeSemiMembershipsForTest,
      enableSingletonRankFusion,
      finalRenderCapture,
      disableCompileOrderForTest,
    ),
  );
}

function optimizeForFinalShape(
  physical: PhysicalQueryPlan<object>,
  includePassthroughProjectFusions: boolean,
  includeConstantFilterJoinProjections: boolean,
  includePositiveTupleMemberships = true,
  forceTupleMembershipFallbackForTest = false,
  includeRowPipelines = includePositiveTupleMemberships,
  includeLexicographicComparisons = true,
  sharedRelationInterfaces: PhysicalSharedRelationInterfaceView,
  includeSemiMemberships = true,
  forceSafeSemiMembershipsForTest = false,
  enableSingletonRankFusion = true,
): {
  readonly physical: PhysicalQueryPlan<object>;
  readonly nativeQuery: SqlFragment;
  readonly lexicographicEmissions: ReadonlyMap<
    PhysicalLexicographicComparisonChoice,
    number
  >;
  readonly semiMembershipEmissions: ReadonlyMap<
    PhysicalSemiMembershipChoice,
    number
  >;
  readonly singletonRankEmissions: ReadonlyMap<
    PhysicalSingletonRankChoice,
    number
  >;
  readonly finalRenderSession: FinalRenderSession;
} {
  assertPhysicalSharedRelationInterfaceViewMatches(
    sharedRelationInterfaces,
    physical.root,
    physical.sharedRelations,
  );
  const source: QuerySource = {
    node: physical.root,
    scope: physical.scope,
    fields: physical.fields,
  };
  const sharedRelations = physical.sharedRelations;
  const sharedNames = new Map(
    sharedRelations.map(({ node, name }) => [node, name] as const),
  );
  const directScanProjections = new Map(
    physical.directScanProjections.map(
      (choice) => [choice.project, choice] as const,
    ),
  );
  const passthroughProjectFusions = new Map(
    includePassthroughProjectFusions
      ? physical.passthroughProjectFusions.map(
          (choice) => [choice.project, choice] as const,
        )
      : [],
  );
  const constantFilterJoinProjections = new Map(
    includeConstantFilterJoinProjections
      ? physical.constantFilterJoinProjections.map(
          (choice) => [choice.project, choice] as const,
        )
      : [],
  );
  const sparseJoinOutputs = new Map(
    includeConstantFilterJoinProjections
      ? physical.constantFilterJoinProjections.map(
          ({ join, referencedOutputColumns }) =>
            [join, new Set(referencedOutputColumns)] as const,
        )
      : [],
  );
  const renderNative = (
    tupleMemberships: readonly PositiveTupleMembershipCandidate[] = [],
  ) => {
    assertPhysicalSharedRelationInterfaceViewMatches(
      sharedRelationInterfaces,
      physical.root,
      physical.sharedRelations,
    );
    const membershipUsage = new Map<AnyInListExpression, number>();
    const textRowUsage = new Map<ValuesRelationNode, number>();
    const finalRenderSession = createFinalRenderSession();
    const context = renderContext(
      sharedNames,
      undefined,
      membershipUsage,
      directScanProjections,
      reservePlanIdentifiers(physical),
      undefined,
      textRowUsage,
      passthroughProjectFusions,
      constantFilterJoinProjections,
      sparseJoinOutputs,
      new Map(tupleMemberships.map((item) => [item.project, item] as const)),
      new Map(
        (includePositiveTupleMemberships
          ? physical.selfMembershipChoices
          : []
        ).map((item) => [item.project, item] as const),
      ),
      true,
      new Map(
        physical.joinOrderStrategies.map(
          (strategy) => [strategy.join, strategy] as const,
        ),
      ),
      new Map(
        physical.conditionalLookupChoices.map(
          (choice) => [choice.join, choice] as const,
        ),
      ),
      new Map(
        includeRowPipelines
          ? physical.rowPipelineChoices.map(
              (choice) => [choice.root, choice] as const,
            )
          : [],
      ),
      false,
      includeLexicographicComparisons
        ? physical.lexicographicComparisonChoices
        : [],
      sharedRelationInterfaces,
      semiMembershipChoicesForRender(
        physical,
        includeSemiMemberships,
        forceSafeSemiMembershipsForTest,
      ),
      includeRowPipelines ? physical.singletonRankChoices : [],
      enableSingletonRankFusion,
      finalRenderSession,
      physical.nativeNullOrderingChoices,
    );
    const definitions = sharedRelations.map((shared, definitionIndex) => {
      context.bypassSharedNode = shared.node;
      const body = compileNode(shared.node, context, new Map());
      context.bypassSharedNode = undefined;
      return compileSharedRelationDefinition(
        shared,
        body,
        definitionIndex,
        finalRenderSession,
      );
    });
    const main = compileQuerySource(source, context, new Map());
    const query =
      definitions.length === 0
        ? main
        : concat(text("WITH "), join(definitions, text(", ")), text(" "), main);
    return {
      query,
      finalRenderSession,
      facts: {
        nativeBindingCount: query.bindings.length,
        usage: [...membershipUsage].map(
          ([expression, occurrences]) =>
            ({ expression, occurrences }) satisfies PhysicalMembershipUsage,
        ),
        rowUsage: [...textRowUsage].map(
          ([node, occurrences]) =>
            ({ node, occurrences }) satisfies PhysicalTextRowUsage,
        ),
        lexicographicEmissions: new Map(
          context.lexicographicComparisonEmissions,
        ),
        semiMembershipEmissions: new Map(context.semiMembershipEmissions),
        singletonRankEmissions: new Map(context.singletonRankEmissions),
      },
    };
  };

  const budgetPhysical = includePositiveTupleMemberships
    ? physical
    : { ...physical, positiveTupleMembershipCandidates: [] };
  const unselected = renderNative();
  const firstChoice = optimizePhysicalMembershipBudget(
    budgetPhysical,
    unselected.facts,
    D1_MAX_BOUND_PARAMETERS,
  );
  const tupleMemberships =
    firstChoice.membershipOptimization?.tupleMemberships ?? [];
  if (tupleMemberships.length === 0)
    return {
      physical: firstChoice,
      nativeQuery: unselected.query,
      finalRenderSession: unselected.finalRenderSession,
      lexicographicEmissions: unselected.facts.lexicographicEmissions,
      semiMembershipEmissions: unselected.facts.semiMembershipEmissions,
      singletonRankEmissions: unselected.facts.singletonRankEmissions,
    };

  // Re-measure the selected relational shape before finalizing packing metadata.
  const selected = renderNative(tupleMemberships);
  const finalChoice = optimizePhysicalMembershipBudget(
    budgetPhysical,
    selected.facts,
    D1_MAX_BOUND_PARAMETERS,
  );
  if (
    !forceTupleMembershipFallbackForTest &&
    hasSamePhysicalMembershipOptimization(
      finalChoice.membershipOptimization,
      firstChoice.membershipOptimization!,
    )
  )
    return {
      physical: finalChoice,
      nativeQuery: selected.query,
      finalRenderSession: selected.finalRenderSession,
      lexicographicEmissions: selected.facts.lexicographicEmissions,
      semiMembershipEmissions: selected.facts.semiMembershipEmissions,
      singletonRankEmissions: selected.facts.singletonRankEmissions,
    };

  // If a structural rewrite changes packed-choice costs, keep the measured
  // original Join plan rather than allowing choices to oscillate. The
  // test-only seam forces this path to verify final SQL and budget metadata.
  const fallbackOptimization = firstChoice.membershipOptimization;
  if (!fallbackOptimization)
    return {
      physical: firstChoice,
      nativeQuery: unselected.query,
      finalRenderSession: unselected.finalRenderSession,
      lexicographicEmissions: unselected.facts.lexicographicEmissions,
      semiMembershipEmissions: unselected.facts.semiMembershipEmissions,
      singletonRankEmissions: unselected.facts.singletonRankEmissions,
    };
  return {
    physical: {
      ...firstChoice,
      membershipOptimization: {
        ...fallbackOptimization,
        tupleMemberships: [],
      },
    },
    nativeQuery: unselected.query,
    finalRenderSession: unselected.finalRenderSession,
    lexicographicEmissions: unselected.facts.lexicographicEmissions,
    semiMembershipEmissions: unselected.facts.semiMembershipEmissions,
    singletonRankEmissions: unselected.facts.singletonRankEmissions,
  };
}

function semiMembershipChoicesForRender(
  physical: PhysicalQueryPlan<object>,
  includeSemiMemberships: boolean,
  forceSafeSemiMembershipsForTest: boolean,
): readonly PhysicalSemiMembershipChoice[] {
  if (!includeSemiMemberships) return [];
  if (forceSafeSemiMembershipsForTest) return physical.semiMembershipChoices;
  return physical.semiMembershipCostSelections.flatMap((selection) =>
    selection.strategy === "in" ? [selection.choice] : [],
  );
}

function renderAndBudget(
  physical: PhysicalQueryPlan<object>,
  options: D1CompileOptions,
  includeSharedRelations: boolean,
  sharedRelationInterfaces: PhysicalSharedRelationInterfaceView,
  strategies?: NonNullable<
    PhysicalQueryPlan<object>["membershipOptimization"]
  >["strategies"],
  expectedBindingCount?: number,
  rowStrategies: readonly PhysicalTextRowStrategy[] = [],
  includePassthroughProjectFusions = true,
  includeConstantFilterJoinProjections = true,
  includeRowPipelines = includeSharedRelations,
  compactGeneratedColumnAliases = false,
  allowCompactGeneratedColumnAliasRetry = true,
  includeSemiMemberships = true,
  forceSafeSemiMembershipsForTest = false,
  enableSingletonRankFusion = true,
  finalRenderCapture?: FinalRenderCompileCapture,
  disableCompileOrderForTest = false,
): CompiledQuery<object> {
  assertPhysicalSharedRelationInterfaceViewMatches(
    sharedRelationInterfaces,
    physical.root,
    physical.sharedRelations,
  );
  const source: QuerySource = {
    node: physical.root,
    scope: physical.scope,
    fields: physical.fields,
  };
  const sharedRelations = includeSharedRelations
    ? physical.sharedRelations
    : [];
  const finalRenderSession = createFinalRenderSession();
  const sharedNames = new Map(
    sharedRelations.map(({ node, name }) => [node, name] as const),
  );
  const directScanProjections = new Map(
    physical.directScanProjections.map(
      (choice) => [choice.project, choice] as const,
    ),
  );
  const passthroughProjectFusions = new Map(
    includePassthroughProjectFusions
      ? physical.passthroughProjectFusions.map(
          (choice) => [choice.project, choice] as const,
        )
      : [],
  );
  const constantFilterJoinProjections = new Map(
    includeConstantFilterJoinProjections
      ? physical.constantFilterJoinProjections.map(
          (choice) => [choice.project, choice] as const,
        )
      : [],
  );
  const sparseJoinOutputs = new Map(
    includeConstantFilterJoinProjections
      ? physical.constantFilterJoinProjections.map(
          ({ join, referencedOutputColumns }) =>
            [join, new Set(referencedOutputColumns)] as const,
        )
      : [],
  );
  const membershipStrategies = strategies
    ? new Map(
        strategies.map(
          (item) =>
            [
              item.expression,
              {
                strategy: item.strategy,
                ...(item.jsonText === undefined
                  ? {}
                  : { jsonText: item.jsonText }),
              },
            ] as const,
        ),
      )
    : undefined;
  const textRowStrategies =
    rowStrategies.length === 0
      ? undefined
      : new Map(
          rowStrategies.map(
            (item) =>
              [
                item.node,
                {
                  strategy: item.strategy,
                  ...(item.jsonSegments === undefined
                    ? {}
                    : {
                        jsonSegments: item.jsonSegments.map(
                          ({ jsonText }) => jsonText,
                        ),
                      }),
                },
              ] as const,
          ),
        );
  const positiveTupleMemberships = new Map(
    (physical.membershipOptimization?.tupleMemberships ?? []).map(
      (item) => [item.project, item] as const,
    ),
  );
  const context = includeSharedRelations
    ? renderContext(
        sharedNames,
        membershipStrategies,
        undefined,
        directScanProjections,
        reservePlanIdentifiers(physical),
        textRowStrategies,
        undefined,
        passthroughProjectFusions,
        constantFilterJoinProjections,
        sparseJoinOutputs,
        positiveTupleMemberships,
        new Map(
          (includeSharedRelations ? physical.selfMembershipChoices : []).map(
            (item) => [item.project, item] as const,
          ),
        ),
        includeSharedRelations,
        new Map(
          physical.joinOrderStrategies.map(
            (strategy) => [strategy.join, strategy] as const,
          ),
        ),
        new Map(
          physical.conditionalLookupChoices.map(
            (choice) => [choice.join, choice] as const,
          ),
        ),
        new Map(
          includeRowPipelines
            ? physical.rowPipelineChoices.map(
                (choice) => [choice.root, choice] as const,
              )
            : [],
        ),
        compactGeneratedColumnAliases,
        includeSharedRelations ? physical.lexicographicComparisonChoices : [],
        sharedRelationInterfaces,
        semiMembershipChoicesForRender(
          physical,
          includeSemiMemberships,
          forceSafeSemiMembershipsForTest,
        ),
        includeRowPipelines ? physical.singletonRankChoices : [],
        enableSingletonRankFusion,
        finalRenderSession,
        physical.nativeNullOrderingChoices,
      )
    : renderContext(
        sharedNames,
        membershipStrategies,
        undefined,
        new Map(),
        reservePlanIdentifiers(physical),
        textRowStrategies,
        undefined,
        passthroughProjectFusions,
        constantFilterJoinProjections,
        sparseJoinOutputs,
        positiveTupleMemberships,
        new Map(),
        includeSharedRelations,
        new Map(),
        new Map(
          physical.conditionalLookupChoices.map(
            (choice) => [choice.join, choice] as const,
          ),
        ),
        new Map(
          includeRowPipelines
            ? physical.rowPipelineChoices.map(
                (choice) => [choice.root, choice] as const,
              )
            : [],
        ),
        compactGeneratedColumnAliases,
        includeSharedRelations ? physical.lexicographicComparisonChoices : [],
        sharedRelationInterfaces,
        semiMembershipChoicesForRender(
          physical,
          includeSemiMemberships,
          forceSafeSemiMembershipsForTest,
        ),
        includeRowPipelines ? physical.singletonRankChoices : [],
        enableSingletonRankFusion,
        finalRenderSession,
        physical.nativeNullOrderingChoices,
      );
  const definitionBodies: SqlFragment[] = [];
  const definitions = sharedRelations.map((shared, definitionIndex) => {
    context.bypassSharedNode = shared.node;
    const body = compileNode(shared.node, context, new Map());
    context.bypassSharedNode = undefined;
    definitionBodies.push(body);
    return compileSharedRelationDefinition(
      shared,
      body,
      definitionIndex,
      finalRenderSession,
    );
  });
  let main: SqlFragment;
  let compileOrderHelper: RenderedCompileOrderHelper | undefined;
  let compileOrderGraph: FinalRenderCompileCapture["compileOrderGraph"];
  if (
    includeSharedRelations &&
    physical.compileOrderPolicy &&
    !disableCompileOrderForTest
  ) {
    const probeContext = forkRenderContextForProbe(context);
    const probeMain = compileQuerySource(source, probeContext, new Map());
    const definitionReferences = definitionBodies.map((body) =>
      compileOrderReferencesForFragment(finalRenderSession, body),
    );
    const mainReferences = compileOrderReferencesForFragment(
      finalRenderSession,
      probeMain,
    );
    const scheduledDefinitionIndexes = scheduledCompileOrderLeaves({
      policy: physical.compileOrderPolicy,
      definitions: sharedRelations,
      referencesByDefinition: definitionReferences,
      mainReferences,
    });
    compileOrderGraph = Object.freeze({
      mainReferences: Object.freeze(
        mainReferences.map(({ definitionIndex, emissionCount }) => ({
          definitionIndex,
          emissionCount,
        })),
      ),
      definitionReferences: Object.freeze(
        definitionReferences.map((references, definitionIndex) =>
          Object.freeze({
            definitionIndex,
            referenceIndexes: Object.freeze(
              references
                .map(({ definitionIndex: referenceIndex }) => referenceIndex)
                .sort((left, right) => left - right),
            ),
          }),
        ),
      ),
      scheduledDefinitionIndexes: scheduledDefinitionIndexes ?? null,
    });
    if (scheduledDefinitionIndexes) {
      const reservedIdentifiers = reserveCompileOrderIdentifiers(
        physical,
        probeContext.reservedIdentifiers,
      );
      compileOrderHelper = renderCompileOrderHelper({
        definitions: sharedRelations,
        definitionIndexes: scheduledDefinitionIndexes,
        reservedIdentifiers,
        session: finalRenderSession,
      });
      const finalMainContext = forkRenderContextForProbe(context);
      finalMainContext.reservedIdentifiers.add(compileOrderHelper.cteName);
      finalMainContext.reservedIdentifiers.add(compileOrderHelper.alias);
      finalMainContext.reservedIdentifiers.add(compileOrderHelper.marker);
      finalMainContext.compileOrderRoot = physical.compileOrderPolicy.rootSort;
      finalMainContext.compileOrderHelper = compileOrderHelper;
      main = compileQuerySource(source, finalMainContext, new Map());
    } else {
      main = probeMain;
    }
  } else {
    main = compileQuerySource(source, context, new Map());
  }
  const allDefinitions = compileOrderHelper
    ? [...definitions, compileOrderHelper.definition]
    : definitions;
  const query =
    allDefinitions.length === 0
      ? main
      : concat(
          text("WITH "),
          join(allDefinitions, text(", ")),
          text(" "),
          main,
        );
  try {
    const compiled = compileAndBudget(
      query,
      options,
      expectedBindingCount,
      includeSharedRelations
        ? (emissions) =>
            physicalPlanShape(physical, true, emissions, strategies)
        : undefined,
      finalRenderSession,
      finalRenderCapture,
    );
    if (finalRenderCapture && compileOrderGraph)
      finalRenderCapture.compileOrderGraph = compileOrderGraph;
    return compiled;
  } catch (error) {
    if (
      !allowCompactGeneratedColumnAliasRetry ||
      compactGeneratedColumnAliases ||
      !(error instanceof D1StatementBudgetError) ||
      error.item !== "sql_bytes"
    )
      throw error;
    return renderAndBudget(
      physical,
      options,
      includeSharedRelations,
      sharedRelationInterfaces,
      strategies,
      expectedBindingCount,
      rowStrategies,
      includePassthroughProjectFusions,
      includeConstantFilterJoinProjections,
      includeRowPipelines,
      true,
      false,
      includeSemiMemberships,
      forceSafeSemiMembershipsForTest,
      enableSingletonRankFusion,
      finalRenderCapture,
      disableCompileOrderForTest,
    );
  }
}

function physicalPlanShape(
  physical: PhysicalQueryPlan<object>,
  includeSharedRelations: boolean,
  emissions: FinalRenderEmissionCounts,
  strategies = physical.membershipOptimization?.strategies ?? [],
): DatabasePhysicalPlanShape {
  const helpers = [...emissions.compileOrderHelpers.values()].filter(
    ({ emissionCount }) => emissionCount > 0,
  );
  const base = physicalPlanShapeBase(
    physical,
    includeSharedRelations,
    emissions,
    strategies,
  );
  if (helpers.length === 0) return base;
  if (
    helpers.length !== 1 ||
    helpers[0]!.emissionCount !== 1 ||
    base.version !== 13 ||
    helpers[0]!.leafDefinitionIndexes.length < 2 ||
    helpers[0]!.leafDefinitionIndexes.length > 100
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Compile-order helper emission is inconsistent with the final query",
    );
  return {
    ...base,
    version: 14,
    cteCount: base.cteCount + 1,
    compileOrder: {
      helperCount: 1,
      leafCount: helpers[0]!.leafDefinitionIndexes.length,
      definitionIndexes: [...helpers[0]!.leafDefinitionIndexes],
      strategy: helpers[0]!.strategy,
    },
  };
}

function physicalPlanShapeBase(
  physical: PhysicalQueryPlan<object>,
  includeSharedRelations: boolean,
  emissions: FinalRenderEmissionCounts,
  strategies = physical.membershipOptimization?.strategies ?? [],
): DatabasePhysicalPlanShape {
  const lexicographicEmissions = emissions.lexicographic as ReadonlyMap<
    PhysicalLexicographicComparisonChoice,
    number
  >;
  const semiMembershipEmissions = emissions.semiMembership as ReadonlyMap<
    PhysicalSemiMembershipChoice,
    number
  >;
  const singletonRankEmissions = emissions.singletonRank as ReadonlyMap<
    PhysicalSingletonRankChoice,
    number
  >;
  let nativeMembershipCount = 0;
  let jsonMembershipCount = 0;
  let nativeRowRelationCount = 0;
  let jsonRowRelationCount = 0;
  for (const strategy of strategies) {
    if (strategy.strategy === "json-text") jsonMembershipCount += 1;
    else nativeMembershipCount += 1;
  }
  const common = {
    cteCount: includeSharedRelations
      ? physical.sharedRelations.length + recursiveClosureCount(physical.root)
      : recursiveClosureCount(physical.root),
    directScanProjectionCount: includeSharedRelations
      ? physical.directScanProjections.length
      : 0,
    nativeMembershipCount,
    jsonMembershipCount,
  };
  const rowStrategies = physical.membershipOptimization?.rowStrategies ?? [];
  for (const strategy of rowStrategies) {
    if (strategy.strategy === "json-rows") jsonRowRelationCount += 1;
    else nativeRowRelationCount += 1;
  }
  const rightAnchorJoinOrderCount = physical.joinOrderStrategies.filter(
    ({ kind }) => kind === "right-anchor",
  ).length;
  const uniqueLookupJoinOrderCount = physical.joinOrderStrategies.filter(
    ({ kind }) => kind === "unique-lookup",
  ).length;
  const factLocalIndexedJoinStrategies = physical.joinOrderStrategies
    .filter((strategy) => strategy.kind === "fact-local-indexed")
    .map(({ tableName, indexName, keyColumns }) => ({
      tableName,
      indexName,
      keyColumns: keyColumns.map(({ name, leftIndex, rightIndex }) => ({
        name,
        leftIndex,
        rightIndex,
      })),
    }));
  const conditionalLookupStrategies = physical.conditionalLookupChoices.map(
    ({ tableName, indexName, keyColumns, selectedKey, guardConjuncts }) => ({
      tableName,
      indexName,
      keyColumns: keyColumns.map(({ name, leftIndex, rightIndex }) => ({
        name,
        leftIndex,
        rightIndex,
      })),
      selectedKey: {
        name: selectedKey.name,
        leftIndex: selectedKey.leftIndex,
        rightIndex: selectedKey.rightIndex,
      },
      guardConjunctCount: guardConjuncts.length,
    }),
  );
  const selfMembershipCount = physical.selfMembershipChoices.length;
  const rowPipelineShapes = physical.rowPipelineChoices.map(rowPipelineShape);
  const lexicographicComparisons =
    physical.lexicographicComparisonChoices.flatMap((choice) => {
      const emissionCount = lexicographicEmissions.get(choice) ?? 0;
      return emissionCount > 0
        ? [
            {
              direction: choice.direction,
              componentCount: choice.components.length,
              emissionCount,
            },
          ]
        : [];
    });
  const emittedSemiMemberships = [...semiMembershipEmissions].flatMap(
    ([choice, emissionCount]) =>
      emissionCount > 0
        ? [{ keyCount: choice.leftKeyIndexes.length, emissionCount }]
        : [],
  );
  const emittedSingletonRankFusions = [...singletonRankEmissions].flatMap(
    ([choice, emissionCount]) =>
      emissionCount > 0
        ? [
            {
              partitionFieldCount: choice.partitionColumnIndexes.length,
              keyFieldCount: choice.keyFields.length,
              consumerCertificateCount: choice.consumerCertificates.length,
              emissionCount,
              distinct: true as const,
            },
          ]
        : [],
  );
  const nativeWindowIndexes = new Map<LogicalQueryNode, Map<number, number>>();
  let nextNativeWindowIndex = 0;
  for (const choice of physical.nativeNullOrderingChoices) {
    let specifications = nativeWindowIndexes.get(choice.window);
    if (!specifications) {
      specifications = new Map();
      nativeWindowIndexes.set(choice.window, specifications);
    }
    if (!specifications.has(choice.windowIndex))
      specifications.set(choice.windowIndex, nextNativeWindowIndex++);
  }
  const emittedNativeNullOrderings = physical.nativeNullOrderingChoices.flatMap(
    (choice) => {
      const emissionCount = emissions.nativeNullOrdering.get(choice) ?? 0;
      return emissionCount > 0
        ? [
            {
              windowIndex: nativeWindowIndexes
                .get(choice.window)!
                .get(choice.windowIndex)!,
              pairIndex: choice.pairIndex,
              columnIndex: choice.columnIndex,
              valueDirection: choice.valueDirection,
              nullPlacement: choice.nullPlacement,
              emissionCount,
            },
          ]
        : [];
    },
  );
  const emittedMaterializedReferences = physical.sharedRelations.flatMap(
    (definition, definitionIndex) => {
      const emission = emissions.materializedReferences.get(definition.node);
      return emission && emission.emissionCount > 0
        ? [
            {
              definitionIndex,
              fieldCount: emission.fieldCount,
              emissionCount: emission.emissionCount,
            },
          ]
        : [];
    },
  );
  const emittedMaterializationSelections = physical.sharedRelations.flatMap(
    (definition, definitionIndex) => {
      const emission = emissions.materializationDefinitions.get(
        definition.node,
      );
      const selection = definition.materializationSelection;
      return emission &&
        selection &&
        emission.emissionCount > 0 &&
        emission.definitionIndex === definitionIndex &&
        emission.selectionKind === selection.kind &&
        emission.choiceIndex === selection.choiceIndex
        ? [
            {
              definitionIndex,
              kind: emission.selectionKind,
              choiceIndex: emission.choiceIndex,
              emissionCount: emission.emissionCount,
            },
          ]
        : [];
    },
  );
  const emittedDerivedSelfMemberships = physical.selfMembershipChoices.flatMap(
    (choice) => {
      const emissionCount = emissions.derivedSelfMembership.get(choice) ?? 0;
      return choice.witness && emissionCount > 0
        ? [
            {
              definitionIndex: choice.witness.definitionIndex,
              producerIndex: choice.witness.producerIndex,
              tupleWidth: choice.leftKeyIndexes.length,
              nullableGuardCount: choice.nullableKeyIndexes.length,
              emissionCount,
            },
          ]
        : [];
    },
  );
  if (
    emittedMaterializationSelections.length > 0 ||
    emittedDerivedSelfMemberships.length > 0
  )
    return {
      version: 13,
      ...common,
      nativeRowRelationCount,
      jsonRowRelationCount,
      rightAnchorJoinOrderCount,
      uniqueLookupJoinOrderCount,
      factLocalIndexedJoinStrategies,
      conditionalLookupCount: conditionalLookupStrategies.length,
      conditionalLookupStrategies,
      selfMembershipCount,
      rowPipelineChoices: rowPipelineShapes,
      lexicographicComparisonCount: lexicographicComparisons.length,
      lexicographicComparisons,
      semiMembershipCount: emittedSemiMemberships.length,
      semiMemberships: emittedSemiMemberships,
      singletonRankFusionCount: emittedSingletonRankFusions.length,
      singletonRankFusions: emittedSingletonRankFusions,
      nativeNullOrderingCount: emittedNativeNullOrderings.length,
      nativeNullOrderings: emittedNativeNullOrderings,
      directMaterializedReferenceCount: emittedMaterializedReferences.length,
      directMaterializedReferences: emittedMaterializedReferences,
      materializationSelectionCount: emittedMaterializationSelections.length,
      materializationSelections: emittedMaterializationSelections,
      derivedSelfMembershipCount: emittedDerivedSelfMemberships.length,
      derivedSelfMemberships: emittedDerivedSelfMemberships,
    };
  if (
    emittedNativeNullOrderings.length > 0 ||
    emittedMaterializedReferences.length > 0
  )
    return {
      version: 12,
      ...common,
      nativeRowRelationCount,
      jsonRowRelationCount,
      rightAnchorJoinOrderCount,
      uniqueLookupJoinOrderCount,
      factLocalIndexedJoinStrategies,
      conditionalLookupCount: conditionalLookupStrategies.length,
      conditionalLookupStrategies,
      selfMembershipCount,
      rowPipelineChoices: rowPipelineShapes,
      lexicographicComparisonCount: lexicographicComparisons.length,
      lexicographicComparisons,
      semiMembershipCount: emittedSemiMemberships.length,
      semiMemberships: emittedSemiMemberships,
      singletonRankFusionCount: emittedSingletonRankFusions.length,
      singletonRankFusions: emittedSingletonRankFusions,
      nativeNullOrderingCount: emittedNativeNullOrderings.length,
      nativeNullOrderings: emittedNativeNullOrderings,
      directMaterializedReferenceCount: emittedMaterializedReferences.length,
      directMaterializedReferences: emittedMaterializedReferences,
    };
  if (emittedSingletonRankFusions.length > 0)
    return {
      version: 11,
      ...common,
      nativeRowRelationCount,
      jsonRowRelationCount,
      rightAnchorJoinOrderCount,
      uniqueLookupJoinOrderCount,
      factLocalIndexedJoinStrategies,
      conditionalLookupCount: conditionalLookupStrategies.length,
      conditionalLookupStrategies,
      selfMembershipCount,
      rowPipelineChoices: rowPipelineShapes,
      lexicographicComparisonCount: lexicographicComparisons.length,
      lexicographicComparisons,
      semiMembershipCount: emittedSemiMemberships.length,
      semiMemberships: emittedSemiMemberships,
      singletonRankFusionCount: emittedSingletonRankFusions.length,
      singletonRankFusions: emittedSingletonRankFusions,
    };
  if (emittedSemiMemberships.length > 0)
    return {
      version: 10,
      ...common,
      nativeRowRelationCount,
      jsonRowRelationCount,
      rightAnchorJoinOrderCount,
      uniqueLookupJoinOrderCount,
      factLocalIndexedJoinStrategies,
      conditionalLookupCount: conditionalLookupStrategies.length,
      conditionalLookupStrategies,
      selfMembershipCount,
      rowPipelineChoices: rowPipelineShapes,
      lexicographicComparisonCount: lexicographicComparisons.length,
      lexicographicComparisons,
      semiMembershipCount: emittedSemiMemberships.length,
      semiMemberships: emittedSemiMemberships,
    };
  if (lexicographicComparisons.length > 0)
    return {
      version: 9,
      ...common,
      nativeRowRelationCount,
      jsonRowRelationCount,
      rightAnchorJoinOrderCount,
      uniqueLookupJoinOrderCount,
      factLocalIndexedJoinStrategies,
      conditionalLookupCount: conditionalLookupStrategies.length,
      conditionalLookupStrategies,
      selfMembershipCount,
      rowPipelineChoices: rowPipelineShapes,
      lexicographicComparisonCount: lexicographicComparisons.length,
      lexicographicComparisons,
    };
  if (rowPipelineShapes.length > 0)
    return {
      version: 8,
      ...common,
      nativeRowRelationCount,
      jsonRowRelationCount,
      rightAnchorJoinOrderCount,
      uniqueLookupJoinOrderCount,
      factLocalIndexedJoinStrategies,
      conditionalLookupCount: conditionalLookupStrategies.length,
      conditionalLookupStrategies,
      selfMembershipCount,
      rowPipelineChoices: rowPipelineShapes,
    };
  if (selfMembershipCount > 0)
    return {
      version: 7,
      ...common,
      nativeRowRelationCount,
      jsonRowRelationCount,
      rightAnchorJoinOrderCount,
      uniqueLookupJoinOrderCount,
      factLocalIndexedJoinStrategies,
      conditionalLookupCount: conditionalLookupStrategies.length,
      conditionalLookupStrategies,
      selfMembershipCount,
    };
  if (conditionalLookupStrategies.length > 0)
    return {
      version: 6,
      ...common,
      nativeRowRelationCount,
      jsonRowRelationCount,
      rightAnchorJoinOrderCount,
      uniqueLookupJoinOrderCount,
      factLocalIndexedJoinStrategies,
      conditionalLookupCount: conditionalLookupStrategies.length,
      conditionalLookupStrategies,
    };
  if (factLocalIndexedJoinStrategies.length > 0)
    return {
      version: 5,
      ...common,
      nativeRowRelationCount,
      jsonRowRelationCount,
      rightAnchorJoinOrderCount,
      uniqueLookupJoinOrderCount,
      factLocalIndexedJoinStrategies,
    };
  if (rightAnchorJoinOrderCount + uniqueLookupJoinOrderCount > 0)
    return {
      version: 4,
      ...common,
      nativeRowRelationCount,
      jsonRowRelationCount,
      rightAnchorJoinOrderCount,
      uniqueLookupJoinOrderCount,
    };
  return rowStrategies.length === 0
    ? { version: 1, ...common }
    : {
        version: 2,
        ...common,
        nativeRowRelationCount,
        jsonRowRelationCount,
      };
}

function compileAndBudget(
  query: SqlFragment,
  options: D1CompileOptions,
  expectedBindingCount?: number,
  createShape?: (
    emissions: FinalRenderEmissionCounts,
  ) => DatabasePhysicalPlanShape,
  finalRenderSession?: FinalRenderSession,
  finalRenderCapture?: FinalRenderCompileCapture,
): CompiledQuery<object> {
  if (
    expectedBindingCount !== undefined &&
    query.bindings.length !== expectedBindingCount
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical membership strategy binding cost does not match its SQL",
    );
  let finalQuery = query;
  let finalShape: DatabasePhysicalPlanShape | undefined;
  if (createShape !== undefined || finalRenderCapture !== undefined) {
    if (!finalRenderSession)
      throw new Error("final_render_session_required_for_metadata");
  }
  if (createShape !== undefined) {
    if (!finalRenderSession)
      throw new Error("final_render_session_required_for_physical_shape");
    const parameterLayout = optimizePhysicalParameterSlots(query.bindings);
    if (parameterLayout) {
      const numberedQuery = renderNumberedParameterSlots(
        query,
        parameterLayout,
      );
      if (numberedQuery) {
        finalQuery = numberedQuery;
      }
    }
    const emissions = finalRenderEmissionCounts(finalRenderSession, finalQuery);
    finalShape = createShape(emissions);
    if (parameterLayout && finalQuery !== query)
      finalShape = withParameterSlotShape(finalShape, parameterLayout);
  } else if (finalRenderSession) {
    finalRenderEmissionCounts(finalRenderSession, finalQuery);
  }
  const statement: DatabaseStatement = {
    sql: finalQuery.text,
    bindings: finalQuery.bindings,
    ...(finalShape === undefined ? {} : { physicalPlanShape: finalShape }),
    ...(options.tag === undefined ? {} : { tag: options.tag }),
  };
  assertD1StatementBudget(statement);
  const compiledQuery = {
    ...statement,
    kind: "query",
  } as CompiledQuery<object>;
  if (finalRenderCapture && finalRenderSession) {
    finalRenderCapture.compiledQuery = compiledQuery;
    finalRenderCapture.diagnostic = {
      fragment: finalQuery,
      emissionCounts: finalRenderEmissionCounts(finalRenderSession, finalQuery),
    };
  }
  return compiledQuery;
}

function renderNumberedParameterSlots(
  query: SqlFragment,
  layout: PhysicalParameterSlotLayout,
): SqlFragment | undefined {
  const offsets = getParameterPlaceholderOffsets(query);
  if (
    offsets === undefined ||
    offsets.length !== query.bindings.length ||
    offsets.length !== layout.occurrenceSlots.length
  )
    return undefined;

  const sql: string[] = [];
  let copiedThrough = 0;
  for (let index = 0; index < offsets.length; index += 1) {
    const offset = offsets[index]!;
    if (
      !Number.isInteger(offset) ||
      offset < copiedThrough ||
      query.text[offset] !== "?"
    )
      return undefined;
    sql.push(query.text.slice(copiedThrough, offset));
    sql.push(`?${layout.occurrenceSlots[index]!}`);
    copiedThrough = offset + 1;
  }
  sql.push(query.text.slice(copiedThrough));
  return inheritFinalRenderProvenance(query, {
    text: sql.join(""),
    bindings: layout.bindings,
  });
}

function withParameterSlotShape(
  shape: DatabasePhysicalPlanShape,
  layout: PhysicalParameterSlotLayout,
): DatabasePhysicalPlanShape {
  if (shape.version === 14)
    return {
      ...shape,
      parameterStrategy: layout.strategy,
      parameterOccurrenceCount: layout.occurrenceCount,
      parameterSlotCount: layout.slotCount,
    };
  if (
    shape.version === 11 ||
    shape.version === 12 ||
    shape.version === 10 ||
    shape.version === 9 ||
    shape.version === 8 ||
    shape.version === 4 ||
    shape.version === 5 ||
    shape.version === 6 ||
    shape.version === 7
  )
    return {
      ...shape,
      parameterStrategy: layout.strategy,
      parameterOccurrenceCount: layout.occurrenceCount,
      parameterSlotCount: layout.slotCount,
    };
  return {
    version: 3,
    cteCount: shape.cteCount,
    directScanProjectionCount: shape.directScanProjectionCount,
    nativeMembershipCount: shape.nativeMembershipCount,
    jsonMembershipCount: shape.jsonMembershipCount,
    nativeRowRelationCount:
      shape.version === 1 ? 0 : shape.nativeRowRelationCount,
    jsonRowRelationCount: shape.version === 1 ? 0 : shape.jsonRowRelationCount,
    parameterStrategy: layout.strategy,
    parameterOccurrenceCount: layout.occurrenceCount,
    parameterSlotCount: layout.slotCount,
  };
}
