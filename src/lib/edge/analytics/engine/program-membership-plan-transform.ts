import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { SourceNode } from "@/lib/edge/analytics/engine/logical/nodes";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import {
  appendProgramMembershipSourceInput,
  type ProgramMembershipOutput,
} from "@/lib/edge/analytics/engine/program-membership-source";
import { EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { sameSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";

/** Copy one data field while retaining every other own field/descriptor. */
function replaceDataField<T extends object, K extends keyof T>(
  value: T,
  field: K,
  replacement: T[K],
): T {
  const descriptors = Object.fromEntries(
    Reflect.ownKeys(value).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor))
        throw new Error("program_membership_transform_data_required");
      return [
        key,
        key === field ? { ...descriptor, value: replacement } : descriptor,
      ];
    }),
  );
  return Object.freeze(Object.defineProperties({ ...value }, descriptors));
}

/** Convert an already-built, already-checked qualified Page graph.
 * This is not producer admission or completion proof: the physical program
 * still requires its exact declared child and actual successfully run frame. */
export function transformQualifiedPageProgramSources(
  canonical: ValidatedLogicalPlan,
  producer: ProgramMembershipOutput,
): ValidatedLogicalPlan {
  validateLogicalPlan(canonical);
  validateLogicalPlan(producer.plan);
  if (
    producer.plan.outputs.filter((output) => output === producer.output)
      .length !== 1
  )
    throw new Error("program_membership_output_identity_mismatch");
  const scope = canonical.context.scope.logicalScope;
  const oldSubject = canonical.context.subject;
  const producerSubject = producer.plan.context.subject;
  if (
    (scope !== "session" && scope !== "visitor") ||
    canonical.context.scope.contractScope !== scope ||
    producer.plan.context.scope.logicalScope !== scope ||
    producer.plan.context.scope.contractScope !== scope
  )
    throw new Error("program_membership_transform_scope_mismatch");
  if (
    oldSubject.origin !== "site" ||
    producerSubject.origin !== "site" ||
    oldSubject.siteIds.length !== 1 ||
    producerSubject.siteIds.length !== 1 ||
    oldSubject.siteIds[0] !== producerSubject.siteIds[0]
  )
    throw new Error("program_membership_transform_subject_mismatch");
  const oldHasTeam = Object.hasOwn(oldSubject, "teamId");
  const producerHasTeam = Object.hasOwn(producerSubject, "teamId");
  if (
    oldHasTeam &&
    (!producerHasTeam || oldSubject.teamId !== producerSubject.teamId)
  )
    throw new Error("program_membership_transform_team_mismatch");
  if (
    !oldHasTeam &&
    producerHasTeam &&
    (typeof producerSubject.teamId !== "string" ||
      producerSubject.teamId.length === 0)
  )
    throw new Error("program_membership_transform_team_mismatch");
  // A nested analysis domain needs its own explicit rewrite contract. Do not
  // leave physical refs hidden in children or silently mix imported programs.
  if (canonical.nodes.some((node) => node.kind === "analysis-result"))
    throw new Error("program_membership_transform_nested_domain_unsupported");
  const sources = canonical.nodes.filter(
    (node): node is SourceNode => node.kind === "source",
  );
  if (sources.length === 0)
    throw new Error("program_membership_transform_source_missing");
  // Check the entire old graph before changing any subject or allocating IDs.
  for (const source of sources) {
    const selection = source.selection;
    if (
      source.entity !== "page" ||
      !selection ||
      source.membershipInputs !== undefined ||
      selection.preparedMembership !== undefined ||
      selection.mode !== "entity" ||
      selection.scope !== scope ||
      selection.entityKind !== scope ||
      selection.qualificationDependencyRefs?.length !== 1 ||
      selection.qualificationDependencyRefs[0] !==
        EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY
    )
      throw new Error("program_membership_transform_source_unsupported");
    if (
      !sameSemanticSubjectDomain(selection.subject, oldSubject) ||
      selection.authorizedSiteIds.length !== 1 ||
      selection.authorizedSiteIds[0] !== oldSubject.siteIds[0]
    )
      throw new Error("program_membership_transform_source_subject_mismatch");
  }
  // Explicit, narrowly authorized graph delta: only add the authenticated
  // producer's previously omitted teamId; never remove or overwrite a teamId.
  const addAuthenticatedTeam = !oldHasTeam && producerHasTeam;
  const base = addAuthenticatedTeam
    ? replaceDataField(
        replaceDataField(
          canonical,
          "context",
          replaceDataField(canonical.context, "subject", producerSubject),
        ),
        "nodes",
        canonical.nodes.map((node) =>
          node.kind === "source" && node.selection
            ? replaceDataField(
                node,
                "selection",
                replaceDataField(node.selection, "subject", producerSubject),
              )
            : node,
        ),
      )
    : canonical;
  const builder = LogicalPlanBuilder.forSourceMembershipRewrite(base);
  for (const source of base.nodes) {
    if (source.kind !== "source") continue;
    const appended = appendProgramMembershipSourceInput(builder, producer, {
      mode: "entity",
      entity: "page",
    });
    builder.replaceSourceMembershipInputs(source, appended.sourceInputs);
  }
  return builder.finish();
}
