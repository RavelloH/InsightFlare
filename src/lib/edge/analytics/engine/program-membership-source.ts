import type {
  LogicalPlanBuilder,
  LogicalSourceOptions,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { SourceMembershipInput } from "@/lib/edge/analytics/engine/logical/nodes";
import type {
  LogicalOutput,
  ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";

/** Actual producer graph output; completion is checked by the physical program. */
export interface ProgramMembershipOutput {
  readonly plan: ValidatedLogicalPlan;
  readonly output: LogicalOutput;
}

/** Import and normalize a role using visible relational operators only. */
export function appendProgramMembershipSourceInput(
  builder: LogicalPlanBuilder,
  producer: ProgramMembershipOutput,
  selection: {
    readonly mode: "entity" | "observation";
    readonly entity: "page" | "event";
  },
): {
  readonly sourceInputs: NonNullable<LogicalSourceOptions["membershipInputs"]>;
  readonly semanticInputs: readonly SourceMembershipInput[];
} {
  if (
    producer.plan.outputs.filter((output) => output === producer.output)
      .length !== 1
  )
    throw new Error("program_membership_output_identity_mismatch");
  const fields = producer.output.fields;
  const kinded =
    fields.length === 3 &&
    fields[0]?.name === "site_id" &&
    fields[1]?.name === "match_kind" &&
    fields[2]?.name === "match_id";
  const entityPair =
    fields.length === 2 &&
    fields[0]?.name === "site_id" &&
    fields[1]?.name === "entity_id";
  if (!kinded && !(entityPair && selection.mode === "entity"))
    throw new Error("program_membership_output_schema_mismatch");
  const imported = builder.importProgramAnalysisResult(
    producer.plan,
    producer.output.id,
    fields.map(({ name }) => ({ field: name })),
  );
  const role =
    selection.mode === "entity"
      ? "entity"
      : selection.entity === "page"
        ? "visit"
        : "event";
  // SQL entity output already has the exact pair schema. Core/raw output keeps
  // kind visible until the explicit role filter. Both arms normalize via IR.
  const roleRows = kinded
    ? builder.filter(
        imported,
        builder.compare(
          "eq",
          builder.slot(imported, "match_kind"),
          builder.literal(role, { kind: "scalar", scalar: "string" }),
        ),
      )
    : imported;
  const projected = builder.project(roleRows, {
    site_id: builder.slot(roleRows, "site_id"),
    member_id: builder.slot(roleRows, kinded ? "match_id" : "entity_id"),
  });
  const relation = builder.distinct(projected, [
    { input: "site_id" },
    { input: "member_id" },
  ]);
  const sourceInputs = Object.freeze([
    Object.freeze({ relation, role, siteId: "site_id", memberId: "member_id" }),
  ]);
  const siteId = relation.slots.site_id;
  const memberId = relation.slots.member_id;
  if (siteId === undefined || memberId === undefined)
    throw new Error("program_membership_relation_keys_missing");
  const semanticInputs = Object.freeze([
    Object.freeze({ input: relation.id, role, siteId, memberId }),
  ]);
  return Object.freeze({ sourceInputs, semanticInputs });
}
