import {
  findPhysicalSharedRelationInterface,
  type PhysicalSharedRelationInterfaceView,
} from "@/lib/db/query/physical/shared-relation-interfaces";
import type { LogicalQueryNode, QuerySource } from "@/lib/db/query/plan";
import type { SqlFragment } from "@/lib/db/sql/fragment";
import { text } from "@/lib/db/sql/fragment";
import { identifier } from "@/lib/db/sql/identifier";

import type { FinalRenderSession } from "./final-render-session";
import {
  concat,
  parenthesize,
  recordFinalRenderEmission,
} from "./fragment-provenance";

const SAFE_GENERATED_IDENTIFIER =
  /^(?:[qlrt][0-9]+|_c[0-9]+|_d1_shared_[0-9]+)$/u;

function generatedIdentifier(value: string): SqlFragment {
  return SAFE_GENERATED_IDENTIFIER.test(value)
    ? text(value)
    : identifier(value);
}

function sameFields(
  source: QuerySource,
  fields: readonly {
    readonly name: string;
    readonly affinity: string;
    readonly nullable: boolean;
  }[],
): boolean {
  return (
    source.fields.length === fields.length &&
    source.fields.every((field, index) => {
      const candidate = fields[index];
      return (
        candidate !== undefined &&
        field.name === candidate.name &&
        field.affinity === candidate.affinity &&
        field.nullable === candidate.nullable
      );
    })
  );
}

export interface MaterializedRelationReferenceInput {
  readonly source: QuerySource;
  readonly producer: LogicalQueryNode | null;
  readonly interfaces?: PhysicalSharedRelationInterfaceView;
  readonly definitionName?: string;
  readonly sourceSql: SqlFragment;
  readonly alias: string;
  readonly session?: FinalRenderSession;
}

/** Reuse one exact, currently licensed materialized relation as a FROM operand. */
export function renderMaterializedRelationReference(
  input: MaterializedRelationReferenceInput,
): SqlFragment {
  const {
    source,
    producer,
    interfaces,
    definitionName,
    sourceSql,
    alias,
    session,
  } = input;
  const fallback = () =>
    concat(parenthesize(sourceSql), text(" AS "), generatedIdentifier(alias));
  if (!interfaces || !definitionName || sourceSql.bindings.length !== 0)
    return fallback();
  if (
    source.scope !== source.node.scope ||
    !sameFields(source, source.node.fields)
  )
    return fallback();
  const definitionIndex = interfaces.layout.findIndex(
    (definition) => definition.node === source.node,
  );
  const definition = interfaces.layout[definitionIndex];
  if (
    !definition ||
    definitionIndex < 0 ||
    definition.scope !== source.scope ||
    definition.name !== definitionName ||
    definition.materialization !== "materialized" ||
    !sameFields(source, definition.fields)
  )
    return fallback();
  const currentProducer = producer ?? interfaces.root;
  const producerIndex = producer
    ? interfaces.layout.findIndex(({ node }) => node === producer)
    : interfaces.layout.length;
  const currentInterface = findPhysicalSharedRelationInterface(
    interfaces,
    source.node,
    currentProducer,
  );
  if (
    source.node === currentProducer ||
    (producer !== null && producerIndex < 0) ||
    definitionIndex >= producerIndex ||
    !currentInterface ||
    currentInterface.definition !== definition ||
    currentInterface.boundary.kind !== "materialized-relation" ||
    currentInterface.license.kind.length === 0 ||
    currentInterface.closure.kind !== "scope-and-exported-columns-closed" ||
    currentInterface.totality.kind !== "checked-through-current-boundaries"
  )
    return fallback();

  const reference = concat(
    generatedIdentifier(definition.name),
    text(" AS "),
    generatedIdentifier(alias),
  );
  const typedReference = recordFinalRenderEmission(session, reference, {
    kind: "shared-reference",
    definition: source.node,
    definitionIndex,
  });
  return recordFinalRenderEmission(session, typedReference, {
    kind: "materialized-reference",
    definition: source.node,
    definitionIndex,
    fieldCount: source.fields.length,
  });
}
