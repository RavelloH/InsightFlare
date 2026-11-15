import {
  caseWhen,
  compileD1Query,
  constant,
  isNull,
  lowerLogicalPlan,
  sort,
  union,
} from "@/lib/db";
import type { AnyExpression } from "@/lib/db/query/expression";
import type {
  LogicalOutput,
  ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import type {
  WholeMembershipCoreNode,
  WholeMembershipNode,
} from "@/lib/edge/analytics/engine/logical/whole-membership";
import { WHOLE_MEMBERSHIP_CORE_OUTPUT } from "@/lib/edge/analytics/engine/whole-membership-stage-plan";
import { requireWholeMembershipStage } from "@/lib/edge/analytics/engine/whole-membership-stage-transition";

import { AnalyticsLogicalToDbLowerer } from "./analytics-relational-lowering";
import type { AnalyticsDbRelation } from "./analytics-relational-storage";
import type {
  AnalyticsReportMultiOutputSelection,
  SelectedOutputField,
} from "./analytics-report-output-selection";
import type { D1ExecutionOptions } from "./execution-options";
import type { D1LogicalProgramExecution } from "./logical-program-execution";
import type { QualificationExecutionInputs } from "./qualification-execution-inputs";
import { compileWholeMembershipReadPlan } from "./whole-membership-read-lowering";

/** The common physical dispatch distinguishes a SQL relation, a finite program,
 * and the fixed bounded host operation. No program is represented as fake SQL. */
export type LoweredAnalyticsLogicalCommand =
  | ReturnType<typeof compileWholeMembershipReadPlan>
  | {
      readonly kind: "logical-sql";
      readonly plan: ValidatedLogicalPlan;
      readonly outputId: string;
      readonly source: "logical-plan-output";
      readonly query: ReturnType<typeof compileD1Query>;
    }
  | {
      readonly kind: "whole-membership-program";
      readonly plan: ValidatedLogicalPlan;
      readonly outputId: string;
      readonly node: WholeMembershipNode;
    }
  | {
      readonly kind: "bounded-filter-core";
      readonly plan: ValidatedLogicalPlan;
      readonly outputId: typeof WHOLE_MEMBERSHIP_CORE_OUTPUT;
      readonly node: WholeMembershipCoreNode;
    };

export function lowerAnalyticsLogicalCommand(
  plan: ValidatedLogicalPlan,
  outputId: string,
  operation: string,
  program?: D1LogicalProgramExecution,
): LoweredAnalyticsLogicalCommand {
  validateLogicalPlan(plan);
  const output = plan.outputs.find((item) => item.id === outputId);
  if (!output)
    throw new Error(`analytics_logical_command_output_missing:${outputId}`);
  const root = plan.nodes.find((node) => node.id === output.relation);
  if (!root) throw new Error("analytics_logical_command_root_missing");
  if (root.kind === "whole-filter-membership") {
    const node = requireWholeMembershipStage(plan);
    return { kind: "whole-membership-program", plan, outputId, node };
  }
  if (root.kind === "whole-filter-core") {
    // The raw completion profile preserves the original evaluator's finite
    // entity/visit/event result. Ordinary Page/channels still expose two keys.
    const kinded =
      root.profile === "whole-original-completion-single-site-entity-v1" ||
      root.profile === "whole-original-completion-team-entity-v1";
    const expectedNames = kinded
      ? ["site_id", "match_kind", "match_id"]
      : ["site_id", "entity_id"];
    if (
      !Object.isFrozen(plan) ||
      plan.nodes.length !== 1 ||
      plan.outputs.length !== 1 ||
      outputId !== WHOLE_MEMBERSHIP_CORE_OUTPUT ||
      output.fields.length !== expectedNames.length ||
      output.fields.some(
        (field, index) =>
          field.name !== expectedNames[index] ||
          field.slot !== root.output[index],
      )
    )
      throw new Error("analytics_logical_core_stage_invalid");
    return { kind: "bounded-filter-core", plan, outputId, node: root };
  }
  if (root.kind === "membership-read") {
    const command = compileWholeMembershipReadPlan(plan, operation);
    return command;
  }
  // Existing one-statement plans use the exact common relation lowering chain.
  const lowerer = new AnalyticsLogicalToDbLowerer(
    plan,
    {
      siteIds: plan.context.subject.siteIds,
      time: plan.context.time,
    },
    program ? { program } : {},
  );
  const relation = lowerer.projectOutput(
    lowerer.lower(output),
    output.fields.map(({ name, slot }) => ({ name, slot })),
  );
  return {
    kind: "logical-sql",
    source: "logical-plan-output",
    plan,
    outputId,
    query: compileD1Query(lowerLogicalPlan(relation), { tag: operation }),
  };
}

export function createAnalyticsReportLowerer(
  plan: ValidatedLogicalPlan,
  errorPrefix: string,
  qualificationExecutionInputs?: QualificationExecutionInputs,
  execution?: D1ExecutionOptions,
): AnalyticsLogicalToDbLowerer {
  const siteIds = plan.context.subject.siteIds;
  const siteCount = Array.isArray(siteIds) ? siteIds.length : "invalid";
  if (
    !Array.isArray(siteIds) ||
    siteIds.length === 0 ||
    siteIds.some((siteId) => typeof siteId !== "string" || siteId.length === 0)
  )
    throw new Error(`${errorPrefix}_site_subject_unsupported:${siteCount}`);
  return new AnalyticsLogicalToDbLowerer(
    plan,
    siteIds.length === 1
      ? { siteId: siteIds[0]!, time: plan.context.time }
      : { siteIds, time: plan.context.time },
    {
      ...(qualificationExecutionInputs ? { qualificationExecutionInputs } : {}),
      ...(execution?.program ? { program: execution.program } : {}),
    },
  );
}

/** The existing ordered output-set IR -> DBIR lowering, shared by both
 * execution paths. This performs one lowerMany, UNION ALL and final sort. */
export function lowerAnalyticsReportOutputSetRelation(
  plan: ValidatedLogicalPlan,
  outputs: readonly LogicalOutput[],
  outputSchemas: readonly (readonly SelectedOutputField[])[],
  selection: AnalyticsReportMultiOutputSelection,
  qualificationExecutionInputs?: QualificationExecutionInputs,
  execution?: D1ExecutionOptions,
): AnalyticsDbRelation {
  const lowerer = createAnalyticsReportLowerer(
    plan,
    "analytics_report_multi_output",
    qualificationExecutionInputs,
    execution,
  );
  const loweredOutputs = lowerer.lowerMany(outputs);
  const branches = outputs.map((output, index) =>
    lowerer.projectOutput(
      loweredOutputs[index]!,
      outputSchemas[index]!.map(({ name, slot }) => ({ name, slot })),
    ),
  );
  let combined = branches[0]!;
  for (const branch of branches.slice(1))
    combined = union(combined, branch, true) as AnalyticsDbRelation;

  const sortKeys = selection.orderBy.flatMap((key) => {
    const expression = combined.columns[key.field] as AnyExpression | undefined;
    if (!expression)
      throw new Error(
        `analytics_report_multi_output_order_field_missing:${key.field}`,
      );
    const direction: "ASC" | "DESC" = key.direction === "asc" ? "ASC" : "DESC";
    const nativeNulls = key.direction === "asc" ? "first" : "last";
    return [
      ...(key.nulls === nativeNulls
        ? []
        : [
            {
              expression: caseWhen(
                [
                  {
                    when: isNull(expression),
                    then: constant(key.nulls === "first" ? 0 : 1),
                  },
                ],
                constant(key.nulls === "first" ? 1 : 0),
              ),
              direction: "ASC" as const,
            },
          ]),
      { expression, direction },
    ];
  });
  return sortKeys.length > 0 ? sort(combined, sortKeys) : combined;
}

/** One real SQL command for the entire selected output set, never N queries. */
export interface LoweredAnalyticsLogicalOutputSetCommand {
  readonly kind: "logical-output-set-sql";
  readonly source: "logical-plan-output-set";
  readonly plan: ValidatedLogicalPlan;
  readonly outputs: readonly LogicalOutput[];
  readonly relation: AnalyticsDbRelation;
}

export function lowerAnalyticsLogicalOutputSetCommand(
  plan: ValidatedLogicalPlan,
  outputs: readonly LogicalOutput[],
  outputSchemas: readonly (readonly SelectedOutputField[])[],
  selection: AnalyticsReportMultiOutputSelection,
  program: D1LogicalProgramExecution,
  qualificationExecutionInputs?: QualificationExecutionInputs,
): LoweredAnalyticsLogicalOutputSetCommand {
  const relation = lowerAnalyticsReportOutputSetRelation(
    plan,
    outputs,
    outputSchemas,
    selection,
    qualificationExecutionInputs,
    { program },
  );
  return Object.freeze({
    kind: "logical-output-set-sql",
    source: "logical-plan-output-set",
    plan,
    outputs,
    relation,
  });
}
