import type { ReactNode } from "react";
import { Button } from "@insightflare/ui/button";
import { Input } from "@insightflare/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@insightflare/ui/select";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiDeleteBinLine,
} from "@remixicon/react";

import {
  analyticsFilterRegistry,
  type FilterDurationTarget,
  type FilterDurationUnit,
  type FilterEntityRoot,
  type FilterExpression,
  type FilterTargetExpression,
  inferFilterTargetType,
} from "@/lib/filter-contract";
import type { AppMessages } from "@/lib/i18n/messages";

import { createDefaultFilterTarget } from "./advanced-editor-model";
import { allowedFields } from "./field-catalog";
import type { FilterPanelAudience } from "./model";

type Target = FilterTargetExpression;
type Reducer = Extract<Target, { kind: "reducer" }>["reducer"];
type Arithmetic = Extract<Target, { kind: "arithmetic" }>["operator"];
type Renderer = (
  predicate: FilterExpression,
  onChange: (next: FilterExpression) => void,
  entity: FilterEntityRoot | undefined,
  onRemoveLastCondition: () => void,
) => ReactNode;
interface Props {
  target: Target;
  onChange: (next: Target) => void;
  audience: FilterPanelAudience;
  messages: AppMessages;
  renderPredicate: Renderer;
  depth?: number;
  showKind?: boolean;
  entity?: FilterEntityRoot;
  role?: TargetRole;
}

const entities = ["page", "event", "session", "visitor"] as const;
const periods = ["h", "d", "w", "mo", "y"] as const;
const durations = ["ms", "s", "m", "h", "d", "w"] as const;
const reducers: Reducer[] = [
  "count",
  "first",
  "last",
  "nth",
  "sum",
  "avg",
  "min",
  "max",
  "countDistinct",
];
const arithmetic: Arithmetic[] = ["add", "sub", "mul", "div"];
const targetKinds = [
  "field",
  "event-payload",
  "current-payload",
  "entity-root",
  "context-root",
  "member",
  "selector",
  "projection",
  "reducer",
  "arithmetic",
  "occurrence-time",
  "time-anchor",
  "duration",
  "bucket",
  "window",
  "periods",
  "sequence",
  "adjacent",
  "without",
  "context-intrinsic",
] as const;
type TargetKind = (typeof targetKinds)[number];
type TargetRole =
  | "any"
  | "collection"
  | "activity"
  | "numeric"
  | "scalar"
  | "sequence"
  | "anchor"
  | "occurrence"
  | "object";
const kindsByRole: Record<Exclude<TargetRole, "any">, readonly TargetKind[]> = {
  collection: [
    "entity-root",
    "selector",
    "projection",
    "bucket",
    "window",
    "periods",
    "sequence",
    "adjacent",
    "without",
  ],
  activity: ["entity-root", "selector"],
  numeric: [
    "field",
    "event-payload",
    "current-payload",
    "member",
    "reducer",
    "arithmetic",
  ],
  scalar: [
    "field",
    "event-payload",
    "current-payload",
    "member",
    "reducer",
    "arithmetic",
    "time-anchor",
    "occurrence-time",
    "duration",
  ],
  sequence: ["sequence", "adjacent", "without"],
  anchor: ["time-anchor", "reducer"],
  occurrence: ["reducer"],
  object: ["context-root", "reducer", "member"],
};
const reducerOptionsByRole: Partial<Record<TargetRole, readonly Reducer[]>> = {
  occurrence: ["first", "last", "nth"],
  object: ["first", "last", "nth"],
  anchor: ["first", "last", "nth"],
  numeric: ["count", "countDistinct", "sum", "avg", "min", "max"],
};

function rootEntity(target: Target): FilterEntityRoot | undefined {
  if (target.kind === "entity-root") return target.entity;
  if (target.kind === "selector") return rootEntity(target.collection);
  if (target.kind === "projection") return rootEntity(target.collection);
  if (target.kind === "reducer") return rootEntity(target.input);
  if (target.kind === "member") return rootEntity(target.object);
  return undefined;
}
function sourceEntity(target: Target): FilterEntityRoot | undefined {
  try {
    const type = inferFilterTargetType(target, analyticsFilterRegistry);
    if (
      type.kind === "collection" &&
      entities.includes(type.entity as FilterEntityRoot)
    )
      return type.entity as FilterEntityRoot;
    if (
      type.kind === "entity" &&
      entities.includes(type.entity as FilterEntityRoot)
    )
      return type.entity as FilterEntityRoot;
  } catch {
    /* the input may temporarily be incomplete */
  }
  return rootEntity(target);
}
function defaultPredicate(entity: FilterEntityRoot): FilterExpression {
  if (entity === "event")
    return {
      kind: "condition",
      target: {
        kind: "member",
        object: { kind: "context-root", context: "current" },
        member: "name",
      },
      operator: "eq",
      value: "signup",
    };
  return {
    kind: "condition",
    target: {
      kind: "member",
      object: { kind: "context-root", context: "current" },
      member:
        entity === "page"
          ? "path"
          : entity === "session"
            ? "entryPath"
            : "sessions",
    },
    operator: "exists",
  };
}
function createKind(
  kind: TargetKind,
  audience: FilterPanelAudience,
  role: TargetRole = "any",
): Target {
  if (kind === "field" && role === "numeric") {
    const field =
      allowedFields(audience).find(
        (candidate) =>
          analyticsFilterRegistry.get(candidate.id)?.valueKind === "number",
      )?.id ?? "page.durationMs";
    return { kind: "field", field: field as never };
  }
  if (kind === "reducer" && ["occurrence", "object", "anchor"].includes(role))
    return {
      kind: "reducer",
      reducer: "first",
      input: { kind: "entity-root", entity: "event" },
    };
  if (kind === "selector")
    return {
      kind,
      collection: { kind: "entity-root", entity: "event" },
      predicate: defaultPredicate("event"),
    };
  if (kind === "projection")
    return {
      kind,
      collection: { kind: "entity-root", entity: "page" },
      member: "durationMs",
    };
  if (kind === "member")
    return {
      kind,
      object: {
        kind: "reducer",
        reducer: "first",
        input: { kind: "entity-root", entity: "page" },
      },
      member: role === "numeric" ? "durationMs" : "path",
    };
  if (kind === "context-intrinsic")
    return { kind, context: "sequence", intrinsic: "span" };
  return createDefaultFilterTarget(kind, audience);
}
/** Preserve the collection when switching reducers and choose a typed,
 * valid scalar projection for numeric reducers. */
export function changeReducerKind(
  target: Extract<Target, { kind: "reducer" }>,
  reducer: Reducer,
): Extract<Target, { kind: "reducer" }> {
  const numeric =
    reducer === "sum" ||
    reducer === "avg" ||
    reducer === "min" ||
    reducer === "max";
  let input = target.input;
  if (numeric && input.kind !== "projection") {
    const entity = sourceEntity(input) ?? "page";
    const member =
      entity === "event"
        ? "payload"
        : entity === "page"
          ? "durationMs"
          : entity === "session"
            ? "views"
            : "sessions";
    input = {
      kind: "projection",
      collection: input,
      member,
      ...(member === "payload" ? { path: "/amount" as never } : {}),
    };
  }
  return {
    ...target,
    reducer,
    input,
    index: reducer === "nth" ? (target.index ?? 1) : undefined,
  };
}

function TargetSelect({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full" aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
const entityOptions = entities.map((entity) => ({
  value: entity,
  label: entity.toUpperCase(),
}));
const unitOptions = (units: readonly string[]) =>
  units.map((unit) => ({
    value: unit,
    label: unit,
  }));
function DurationInput({
  value,
  onChange,
  calendar = false,
  messages,
}: {
  value: FilterDurationTarget;
  onChange: (next: FilterDurationTarget) => void;
  calendar?: boolean;
  messages: AppMessages;
}) {
  const units: readonly string[] = calendar ? periods : durations;
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(5rem,0.65fr)] gap-2">
      <Input
        type="number"
        step={calendar ? 1 : "any"}
        aria-label={messages.filterBuilder.advancedEditor.durationAmount}
        value={value.amount}
        onChange={(event) => {
          if (event.target.value.trim() === "") return;
          const next = Number(event.target.value);
          if (
            Number.isFinite(next) &&
            (!calendar || (Number.isSafeInteger(next) && next > 0))
          )
            onChange({ ...value, amount: next });
        }}
      />
      <TargetSelect
        ariaLabel={messages.filterBuilder.durationUnit}
        value={value.unit}
        options={unitOptions(units)}
        onChange={(unit) =>
          onChange({ ...value, unit: unit as FilterDurationUnit })
        }
      />
    </div>
  );
}
function duration(
  amount: number,
  unit: FilterDurationUnit = "d",
): FilterDurationTarget {
  return { kind: "duration", amount, unit };
}
function ScalarMemberSelect({
  entity,
  value,
  onChange,
  audience,
  messages,
}: {
  entity: FilterEntityRoot | undefined;
  value: string;
  onChange: (member: string) => void;
  audience: FilterPanelAudience;
  messages: AppMessages;
}) {
  const fields = allowedFields(audience).filter((field) => {
    if (!entity) return true;
    return (
      field.id.startsWith(entity + ".") ||
      (!field.id.startsWith("page.") &&
        !field.id.startsWith("event.") &&
        !field.id.startsWith("session.") &&
        !field.id.startsWith("visitor."))
    );
  });
  const options = fields.map((field) => {
    const member = field.id.startsWith(entity + ".")
      ? field.id.slice(entity!.length + 1)
      : field.id;
    return {
      value: member,
      label: messages.filterBuilder.fieldLabels[field.id] ?? member,
    };
  });
  // Keep imported, valid member paths available even if they are not in the
  // current audience's suggestions.
  if (value && !options.some((option) => option.value === value))
    options.unshift({ value, label: value });
  if (
    entity === "event" &&
    !options.some((option) => option.value === "payload")
  )
    options.push({ value: "payload", label: "payload(...)" });
  return (
    <TargetSelect
      value={value}
      options={options}
      ariaLabel={messages.filterBuilder.advancedEditor.correlationTarget}
      onChange={onChange}
    />
  );
}

export function FilterTargetExpressionEditor({
  target,
  onChange,
  audience,
  messages,
  renderPredicate,
  depth = 0,
  showKind = true,
  entity,
  role = "any",
}: Props) {
  const update = (next: Target) => onChange(next);
  const nested = (
    value: Target,
    change: (next: Target) => void,
    nestedEntity = entity,
    nestedRole: TargetRole = "any",
  ) => (
    <FilterTargetExpressionEditor
      target={value}
      onChange={change}
      audience={audience}
      messages={messages}
      renderPredicate={renderPredicate}
      depth={depth + 1}
      entity={nestedEntity}
      role={nestedRole}
    />
  );
  const kindOptions = targetKinds
    .filter(
      (kind) =>
        role === "any" ||
        kindsByRole[role].includes(kind) ||
        kind === target.kind,
    )
    .filter(
      (kind) =>
        kind !== "current-payload" ||
        entity === "event" ||
        kind === target.kind,
    )
    .filter(
      (kind) =>
        kind !== "context-intrinsic" ||
        role === "scalar" ||
        kind === target.kind,
    )
    .map((kind) => ({
      value: kind,
      label: messages.filterBuilder.advancedEditor.targetKinds[kind],
    }));
  const kind = target.kind;
  return (
    <div
      className={
        depth > 0
          ? "min-w-0 space-y-2 border-l border-border pl-3"
          : "min-w-0 space-y-2"
      }
    >
      {showKind ? (
        <TargetSelect
          ariaLabel={messages.filterBuilder.expression}
          value={kind}
          options={kindOptions}
          onChange={(nextKind) =>
            update(createKind(nextKind as TargetKind, audience, role))
          }
        />
      ) : null}
      {kind === "field" ? (
        <TargetSelect
          ariaLabel={messages.filterBuilder.expression}
          value={target.field}
          options={allowedFields(audience)
            .filter(
              (field) =>
                role !== "numeric" ||
                analyticsFilterRegistry.get(field.id)?.valueKind === "number",
            )
            .map((field) => ({
              value: field.id,
              label: messages.filterBuilder.fieldLabels[field.id] ?? field.id,
            }))}
          onChange={(field) => update({ ...target, field: field as never })}
        />
      ) : null}
      {kind === "event-payload" || kind === "current-payload" ? (
        <Input
          aria-label={messages.filterBuilder.advancedEditor.jsonPointer}
          className="font-mono"
          value={target.path}
          placeholder={
            messages.filterBuilder.advancedEditor.jsonPointerPlaceholder
          }
          onChange={(event) =>
            update({ ...target, path: event.target.value as never })
          }
        />
      ) : null}
      {kind === "entity-root" ? (
        <TargetSelect
          ariaLabel={messages.filterBuilder.expression}
          value={target.entity}
          options={
            role === "activity"
              ? entityOptions.filter(
                  (option) =>
                    option.value === "page" || option.value === "event",
                )
              : entityOptions
          }
          onChange={(selected) =>
            update({ ...target, entity: selected as FilterEntityRoot })
          }
        />
      ) : null}
      {kind === "context-root" ? (
        <TargetSelect
          ariaLabel={messages.filterBuilder.expression}
          value={target.context}
          options={(role === "object"
            ? ["current"]
            : ["current", "sequence", "period", "bucket"]
          )
            .concat(target.context)
            .filter((value, index, values) => values.indexOf(value) === index)
            .map((value) => ({
              value,
              label: value === "current" ? "$" : "$" + value,
            }))}
          onChange={(context) =>
            update({ ...target, context: context as typeof target.context })
          }
        />
      ) : null}
      {kind === "member" ? (
        <>
          {target.object.kind === "context-root" &&
          target.object.context === "current"
            ? null
            : nested(
                target.object,
                (object) => update({ ...target, object }),
                entity,
                "object",
              )}
          <ScalarMemberSelect
            entity={sourceEntity(target.object)}
            value={target.member}
            onChange={(member) => update({ ...target, member })}
            audience={audience}
            messages={messages}
          />
        </>
      ) : null}
      {kind === "selector" ? (
        <>
          {nested(
            target.collection,
            (collection) => update({ ...target, collection }),
            entity,
            role === "activity" ? "activity" : "collection",
          )}
          {renderPredicate(
            target.predicate,
            (predicate) => update({ ...target, predicate }),
            sourceEntity(target.collection),
            () => update(target.collection),
          )}
        </>
      ) : null}
      {kind === "projection" ? (
        <>
          {nested(
            target.collection,
            (collection) => {
              const nextEntity = sourceEntity(collection);
              const currentEntity = sourceEntity(target.collection);
              update({
                ...target,
                collection,
                ...(nextEntity !== currentEntity
                  ? {
                      member:
                        nextEntity === "event"
                          ? "name"
                          : nextEntity === "page"
                            ? "path"
                            : nextEntity === "session"
                              ? "views"
                              : "sessions",
                      path: undefined,
                    }
                  : {}),
              });
            },
            entity,
            "collection",
          )}
          <ScalarMemberSelect
            entity={sourceEntity(target.collection)}
            value={target.member}
            onChange={(member) =>
              update({
                ...target,
                member,
                path:
                  member === "payload"
                    ? (target.path ?? ("/amount" as never))
                    : undefined,
              })
            }
            audience={audience}
            messages={messages}
          />
          {target.member === "payload" ? (
            <Input
              className="font-mono"
              value={target.path ?? "/amount"}
              aria-label={messages.filterBuilder.advancedEditor.jsonPointer}
              onChange={(event) =>
                update({ ...target, path: event.target.value as never })
              }
            />
          ) : null}
        </>
      ) : null}
      {kind === "reducer" ? (
        <>
          <TargetSelect
            ariaLabel={messages.filterBuilder.expression}
            value={target.reducer}
            options={(reducerOptionsByRole[role] ?? reducers)
              .concat(target.reducer)
              .filter((value, index, values) => values.indexOf(value) === index)
              .map((value) => ({
                value,
                label: value + "(...)",
              }))}
            onChange={(reducer) =>
              update(changeReducerKind(target, reducer as Reducer))
            }
          />
          {nested(
            target.input,
            (input) => update({ ...target, input }),
            entity,
            ["occurrence", "object", "anchor"].includes(role) &&
              ["first", "last", "nth"].includes(target.reducer)
              ? "activity"
              : "collection",
          )}
          {target.reducer === "nth" ? (
            <Input
              type="number"
              min={1}
              step={1}
              aria-label={messages.filterBuilder.advancedEditor.occurrenceIndex}
              value={target.index ?? 1}
              onChange={(event) => {
                const index = Number(event.target.value);
                if (Number.isSafeInteger(index) && index >= 1)
                  update({ ...target, index });
              }}
            />
          ) : null}
        </>
      ) : null}
      {kind === "arithmetic" ? (
        <>
          <TargetSelect
            ariaLabel={messages.filterBuilder.expression}
            value={target.operator}
            options={arithmetic.map((value) => ({
              value,
              label: value + "(...)",
            }))}
            onChange={(operator) =>
              update({ ...target, operator: operator as Arithmetic })
            }
          />
          {nested(
            target.left,
            (left) => update({ ...target, left }),
            entity,
            "numeric",
          )}
          {nested(
            target.right,
            (right) => update({ ...target, right }),
            entity,
            "numeric",
          )}
        </>
      ) : null}
      {kind === "occurrence-time"
        ? nested(
            target.input,
            (input) => update({ ...target, input }),
            entity,
            "occurrence",
          )
        : null}
      {kind === "duration" ? (
        <DurationInput value={target} onChange={update} messages={messages} />
      ) : null}
      {kind === "time-anchor" ? (
        <>
          <TargetSelect
            ariaLabel={messages.filterBuilder.expression}
            value={target.anchor}
            options={["now", "range.start", "range.end"].map((anchor) => ({
              value: anchor,
              label: "@" + anchor,
            }))}
            onChange={(anchor) =>
              update({ ...target, anchor: anchor as typeof target.anchor })
            }
          />
          <div className="flex min-w-0 items-center gap-2">
            <Button
              size="sm"
              type="button"
              variant="outline"
              aria-label={
                target.offset
                  ? messages.filterBuilder.advancedEditor.removeOffset
                  : messages.filterBuilder.advancedEditor.addOffset
              }
              onClick={() =>
                update({
                  ...target,
                  offset: target.offset ? undefined : duration(-1),
                })
              }
            >
              {target.offset ? <RiDeleteBinLine /> : <RiAddLine />}
            </Button>
            {target.offset ? (
              <div className="min-w-0 flex-1">
                <DurationInput
                  value={target.offset}
                  onChange={(offset) => update({ ...target, offset })}
                  messages={messages}
                />
              </div>
            ) : null}
          </div>
        </>
      ) : null}
      {kind === "bucket" ? (
        <>
          {nested(
            target.input,
            (input) => update({ ...target, input }),
            entity,
            "activity",
          )}
          <DurationInput
            value={target.interval}
            calendar
            messages={messages}
            onChange={(interval) => update({ ...target, interval })}
          />
        </>
      ) : null}
      {kind === "periods" ? (
        <>
          {nested(
            target.collection,
            (collection) => update({ ...target, collection }),
            entity,
            "collection",
          )}
          <DurationInput
            value={target.interval}
            calendar
            messages={messages}
            onChange={(interval) => update({ ...target, interval })}
          />
        </>
      ) : null}
      {kind === "window" ? (
        <>
          {nested(
            target.collection,
            (collection) => update({ ...target, collection }),
            entity,
            "collection",
          )}
          {nested(
            target.anchor,
            (anchor) => update({ ...target, anchor }),
            entity,
            "anchor",
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <DurationInput
              value={target.startOffset}
              messages={messages}
              onChange={(startOffset) => update({ ...target, startOffset })}
            />
            <DurationInput
              value={target.endOffset}
              messages={messages}
              onChange={(endOffset) => update({ ...target, endOffset })}
            />
          </div>
        </>
      ) : null}
      {kind === "sequence" ? (
        <>
          {target.steps.map((step, index) => (
            <div key={index} className="min-w-0 space-y-2">
              <div className="flex min-w-0 items-start gap-2">
                <span className="pt-2 text-xs text-muted-foreground tabular-nums">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  {nested(
                    step,
                    (replacement) =>
                      update({
                        ...target,
                        steps: target.steps.map((item, position) =>
                          position === index ? replacement : item,
                        ),
                      }),
                    entity,
                    "activity",
                  )}
                </div>
                <div className="flex shrink-0 flex-col">
                  <Button
                    size="icon"
                    variant="ghost"
                    type="button"
                    aria-label={
                      messages.filterBuilder.advancedEditor.moveStepUp
                    }
                    disabled={index === 0}
                    onClick={() => {
                      const steps = [...target.steps];
                      [steps[index - 1], steps[index]] = [
                        steps[index]!,
                        steps[index - 1]!,
                      ];
                      update({ ...target, steps });
                    }}
                  >
                    <RiArrowUpSLine />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    type="button"
                    aria-label={
                      messages.filterBuilder.advancedEditor.moveStepDown
                    }
                    disabled={index === target.steps.length - 1}
                    onClick={() => {
                      const steps = [...target.steps];
                      [steps[index + 1], steps[index]] = [
                        steps[index]!,
                        steps[index + 1]!,
                      ];
                      update({ ...target, steps });
                    }}
                  >
                    <RiArrowDownSLine />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    type="button"
                    aria-label={
                      messages.filterBuilder.advancedEditor.removeStep
                    }
                    disabled={target.steps.length <= 2}
                    onClick={() =>
                      update({
                        ...target,
                        steps: target.steps.filter((_, i) => i !== index),
                      })
                    }
                  >
                    <RiDeleteBinLine />
                  </Button>
                </div>
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              update({
                ...target,
                steps: [
                  ...target.steps,
                  {
                    kind: "selector",
                    collection: {
                      kind: "entity-root",
                      entity: sourceEntity(target.steps[0]!) ?? "event",
                    },
                    predicate: defaultPredicate(
                      sourceEntity(target.steps[0]!) ?? "event",
                    ),
                  },
                ],
              })
            }
          >
            <RiAddLine data-icon="inline-start" />
            {messages.filterBuilder.advancedEditor.addStep}
          </Button>
        </>
      ) : null}
      {kind === "adjacent"
        ? nested(
            target.sequence,
            (sequence) => update({ ...target, sequence }),
            entity,
            "sequence",
          )
        : null}
      {kind === "without" ? (
        <>
          {nested(
            target.sequence,
            (sequence) => update({ ...target, sequence }),
            entity,
            "sequence",
          )}
          {nested(
            target.excluded,
            (excluded) => update({ ...target, excluded }),
            entity,
            "activity",
          )}
        </>
      ) : null}
      {kind === "context-intrinsic" ? (
        <>
          <TargetSelect
            ariaLabel={messages.filterBuilder.expression}
            value={target.intrinsic}
            options={["span", "gap", "same", "items"].map((value) => ({
              value,
              label: value === "items" ? "$items" : "$" + value,
            }))}
            onChange={(intrinsic) => {
              const next: Target =
                intrinsic === "items"
                  ? { kind, context: "period", intrinsic: "items" }
                  : intrinsic === "gap"
                    ? {
                        kind,
                        context: "sequence",
                        intrinsic: "gap",
                        from: 1,
                        to: 2,
                      }
                    : intrinsic === "same"
                      ? {
                          kind,
                          context: "sequence",
                          intrinsic: "same",
                          input: {
                            kind: "current-payload",
                            path: "/productId" as never,
                          },
                        }
                      : { kind, context: "sequence", intrinsic: "span" };
              update(next);
            }}
          />
          {target.intrinsic === "gap" ? (
            <div className="grid grid-cols-2 gap-2">
              <Input
                type="number"
                min={1}
                step={1}
                aria-label={messages.filterBuilder.advancedEditor.fromStep}
                value={target.from}
                onChange={(event) => {
                  const from = Number(event.target.value);
                  if (
                    Number.isSafeInteger(from) &&
                    from > 0 &&
                    from < target.to
                  )
                    update({ ...target, from });
                }}
              />
              <Input
                type="number"
                min={2}
                step={1}
                aria-label={messages.filterBuilder.advancedEditor.toStep}
                value={target.to}
                onChange={(event) => {
                  const to = Number(event.target.value);
                  if (Number.isSafeInteger(to) && to > target.from)
                    update({ ...target, to });
                }}
              />
            </div>
          ) : null}
          {target.intrinsic === "same"
            ? nested(
                target.input,
                (input) => update({ ...target, input }),
                entity,
                "scalar",
              )
            : null}
        </>
      ) : null}
    </div>
  );
}
