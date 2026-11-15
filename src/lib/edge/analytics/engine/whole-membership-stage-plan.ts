import type { EpochMs, QueryTime } from "@/lib/edge/analytics/contract/types";
import type { AdvancedFilterExecutionPlan } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import { relationId, slotId } from "@/lib/edge/analytics/engine/logical/ids";
import type { LogicalPlanContext } from "@/lib/edge/analytics/engine/logical/plan";
import {
  type LogicalPlan,
  snapshotLogicalPlan,
  type ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import {
  membershipReadFields,
  type MembershipReadSpec,
} from "@/lib/edge/analytics/engine/logical/whole-membership";
import type { ActivityReadRange } from "@/lib/edge/analytics/engine/semantic/activity-read-ranges";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import {
  createSemanticSubjectDomain,
  type SemanticSubjectDomain,
} from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import type { FilterDocument } from "@/lib/filter-contract/filters";

/** Only DSL document fields enter a semantic plan. Provider-owned symbols stay
 * on the captured invocation document. No normalization, JSON serialization,
 * undefined coercion, or metadata copying occurs at this checkpoint. The normal
 * plan snapshot still validates all values reachable from the semantic root. */
function semanticFilterDocument(input: FilterDocument): FilterDocument {
  return { version: input.version, root: input.root };
}

/** Declared QueryTime data only for the new raw completion profile. Optional
 * own undefined values have the same legacy meaning as omitted properties, but
 * are not semantic plan values. Retain the original live object in the physical
 * invocation; this projection does not normalize or alter its read checkpoints. */
function completionSemanticQueryTime(input: QueryTime): QueryTime {
  return {
    range: input.range,
    reportingTimeZone: input.reportingTimeZone,
    capturedAtMs: input.capturedAtMs,
    ...(input.filterRange !== undefined
      ? {
          filterRange: {
            ...(input.filterRange.startMs !== undefined
              ? { startMs: input.filterRange.startMs }
              : {}),
            ...(input.filterRange.endExclusiveMs !== undefined
              ? { endExclusiveMs: input.filterRange.endExclusiveMs }
              : {}),
          },
        }
      : {}),
    ...(input.filterRangeEmpty !== undefined
      ? { filterRangeEmpty: input.filterRangeEmpty }
      : {}),
    ...(input.readRange !== undefined ? { readRange: input.readRange } : {}),
    ...(input.fullHistory !== undefined
      ? { fullHistory: input.fullHistory }
      : {}),
    ...(input.paginationBinding !== undefined
      ? { paginationBinding: input.paginationBinding }
      : {}),
  };
}

export const WHOLE_MEMBERSHIP_OUTPUT = "channels-whole-membership";
export const WHOLE_MEMBERSHIP_READ_OUTPUT = "whole-membership-read";

export function buildChannelsMembershipStage(input: {
  readonly subject: SemanticSubjectDomain;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scope: "session" | "visitor" | "event";
  readonly coverageSource: "read" | "invocation-predecessor";
  readonly profile?:
    | "channels-single-site-entity-v1"
    | "page-role-single-site-entity-v1"
    | "whole-original-completion-single-site-entity-v1"
    | "whole-original-completion-team-entity-v1";
}): ValidatedLogicalPlan {
  const queryTime =
    input.profile === "whole-original-completion-single-site-entity-v1" ||
    input.profile === "whole-original-completion-team-entity-v1"
      ? completionSemanticQueryTime(input.queryTime)
      : input.queryTime;
  const site = slotId(0);
  const entity = slotId(1);
  const kind = slotId(2);
  const observation =
    input.scope === "event" ||
    input.profile === "whole-original-completion-team-entity-v1";
  const output = observation ? [site, kind, entity] : [site, entity];
  const relation = relationId(0);
  const plan: LogicalPlan = {
    version: 1,
    context: {
      subject: input.subject,
      time: semanticTemporalDomainsFromQueryTime(queryTime),
      scope: resolveAnalyticsScope(input.scope),
    },
    slots: output.map((id) => ({
      id,
      type: { kind: "scalar", scalar: "string" },
      nullable: false,
      lineage: {
        kind: "derived",
        operation: "whole-filter-membership",
        inputs: [],
      },
    })),
    nodes: [
      {
        id: relation,
        kind: "whole-filter-membership",
        output,
        grain: { kind: "keyed", keys: output },
        profile: input.profile ?? "channels-single-site-entity-v1",
        filters: semanticFilterDocument(input.filters),
        coverageSource: input.coverageSource,
        lateFilterInput: "captured-document-at-core-checkpoints",
        queryTime,
        executionScope: input.scope,
      },
    ],
    outputs: [
      {
        id: WHOLE_MEMBERSHIP_OUTPUT,
        relation,
        fields: observation
          ? [
              { name: "site_id", slot: site },
              { name: "match_kind", slot: kind },
              { name: "match_id", slot: entity },
            ]
          : [
              { name: "site_id", slot: site },
              { name: "entity_id", slot: entity },
            ],
      },
    ],
  };
  return validateLogicalPlan(snapshotLogicalPlan(plan));
}

/** One finite storage read; no SQL string or arbitrary field list is accepted. */
export function buildWholeMembershipReadPlan(input: {
  readonly stage: ValidatedLogicalPlan;
  readonly read: MembershipReadSpec;
  readonly siteIds?: SemanticSubjectDomain["siteIds"];
}): ValidatedLogicalPlan {
  if (input.siteIds === undefined)
    return buildReadForContext(input.stage.context, input.read);
  const subject = input.stage.context.subject;
  if (
    !input.siteIds.length ||
    input.siteIds.some((id) => !subject.siteIds.includes(id))
  )
    throw new Error("whole_membership_read_site_subset_invalid");
  return buildReadForContext(
    {
      ...input.stage.context,
      subject: createSemanticSubjectDomain({
        ...subject,
        siteIds: input.siteIds,
      }),
    },
    input.read,
  );
}

/** This plan is constructed at the old coverage-read checkpoint, before a
 * report or whole-filter stage exists. No dummy Stage 0 is fabricated. */
export function buildChannelsCoveragePredecessorPlan(input: {
  readonly subject: SemanticSubjectDomain;
  readonly queryTime: QueryTime;
  readonly scope: "session" | "visitor" | "event";
  readonly profile?: Parameters<
    typeof buildChannelsMembershipStage
  >[0]["profile"];
}): ValidatedLogicalPlan {
  const queryTime =
    input.profile === "whole-original-completion-single-site-entity-v1" ||
    input.profile === "whole-original-completion-team-entity-v1"
      ? completionSemanticQueryTime(input.queryTime)
      : input.queryTime;
  return buildReadForContext(
    {
      subject: input.subject,
      time: semanticTemporalDomainsFromQueryTime(queryTime),
      scope: resolveAnalyticsScope(input.scope),
    },
    { kind: "site-coverage" },
  );
}

function buildReadForContext(
  context: LogicalPlanContext,
  read: MembershipReadSpec,
): ValidatedLogicalPlan {
  const fields = membershipReadFields(read);
  const relation = relationId(0);
  // These numbers already have the original finite read validation. Branding
  // at the semantic boundary follows the existing Activity plan builder and
  // must not introduce safe-integer/range normalization or new errors.
  const range =
    read.kind === "payload-nodes"
      ? {
          startMs: read.range.startMs as EpochMs,
          endExclusiveMs: read.range.endExclusiveMs as EpochMs,
        }
      : undefined;
  const plan: LogicalPlan = {
    version: 1,
    context: {
      ...context,
      ...(range
        ? {
            time: {
              ...context.time,
              candidate: range,
              read: { kind: "bounded", range },
            },
          }
        : {}),
    },
    slots: fields.map((field, index) => ({
      id: slotId(index),
      type: { kind: "scalar", scalar: field.scalar },
      nullable: field.nullable,
      lineage: {
        kind: "derived",
        operation: `membership-read:${read.kind}:${field.name}`,
        inputs: [],
      },
    })),
    nodes: [
      {
        id: relation,
        kind: "membership-read",
        read,
        output: fields.map((_, index) => slotId(index)),
        grain: { kind: "bag" },
      },
    ],
    outputs: [
      {
        id: WHOLE_MEMBERSHIP_READ_OUTPUT,
        relation,
        fields: fields.map((field, index) => ({
          name: field.name,
          slot: slotId(index),
        })),
      },
    ],
  };
  return validateLogicalPlan(snapshotLogicalPlan(plan));
}

export const WHOLE_MEMBERSHIP_CORE_OUTPUT = "whole-membership-core";

/** Build only at the old synchronous evaluateFilterDocument checkpoint. The
 * preparation stage declares the port; this stage snapshots its actual value. */
export function buildWholeMembershipCoreStage(input: {
  readonly stage: ValidatedLogicalPlan;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly readRange: ActivityReadRange;
  readonly fullHistoryAtEntry: boolean;
  readonly bounds: AdvancedFilterExecutionPlan["decision"]["coreBounds"];
  /** Only original completion reads the captured plan scope again at Core2. */
  readonly lateExecutionScope?: "session" | "visitor" | "event";
}): ValidatedLogicalPlan {
  const producer = input.stage.nodes[0];
  if (producer?.kind !== "whole-filter-membership")
    throw new Error("whole_membership_core_predecessor_invalid");
  const kinded =
    producer.profile === "whole-original-completion-single-site-entity-v1" ||
    producer.profile === "whole-original-completion-team-entity-v1";
  if (input.lateExecutionScope !== undefined && !kinded)
    throw new Error("whole_membership_unexpected_late_scope");
  const scope = input.lateExecutionScope ?? producer.executionScope;
  const queryTime = kinded
    ? completionSemanticQueryTime(input.queryTime)
    : input.queryTime;
  const site = slotId(0);
  const entity = slotId(1);
  const kind = slotId(2);
  const output = kinded ? [site, kind, entity] : [site, entity];
  const relation = relationId(0);
  return validateLogicalPlan(
    snapshotLogicalPlan({
      version: 1,
      context: {
        subject: input.stage.context.subject,
        scope: kinded
          ? resolveAnalyticsScope(scope)
          : input.stage.context.scope,
        time: semanticTemporalDomainsFromQueryTime(queryTime),
      },
      slots: output.map((id) => ({
        id,
        type: { kind: "scalar" as const, scalar: "string" as const },
        nullable: false,
        lineage: {
          kind: "derived" as const,
          operation: "whole-filter-core",
          inputs: [],
        },
      })),
      nodes: [
        {
          id: relation,
          output,
          grain: { kind: "keyed", keys: output },
          kind: "whole-filter-core",
          profile: producer.profile,
          inputSource: "invocation-core-read-results",
          ...(kinded
            ? { resultScopeInput: "captured-scope-plan-after-core" as const }
            : {}),
          filters: semanticFilterDocument(input.filters),
          queryTime,
          executionScope: scope,
          readRange: input.readRange,
          fullHistoryAtEntry: input.fullHistoryAtEntry,
          bounds: input.bounds,
        },
      ],
      outputs: [
        {
          id: WHOLE_MEMBERSHIP_CORE_OUTPUT,
          relation,
          fields: kinded
            ? [
                { name: "site_id", slot: site },
                { name: "match_kind", slot: kind },
                { name: "match_id", slot: entity },
              ]
            : [
                { name: "site_id", slot: site },
                { name: "entity_id", slot: entity },
              ],
        },
      ],
    }),
  );
}
