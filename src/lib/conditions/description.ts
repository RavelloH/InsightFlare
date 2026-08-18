export type ConditionDescriptionNode<TCondition> =
  | {
      readonly kind: "condition";
      readonly condition: TCondition;
    }
  | {
      readonly kind: "and" | "or";
      readonly children: readonly ConditionDescriptionNode<TCondition>[];
    }
  | {
      readonly kind: "not";
      readonly child: ConditionDescriptionNode<TCondition>;
    };

export interface ConditionDescriptionOptions<TCondition> {
  readonly empty: string;
  readonly conjunction: string;
  readonly disjunction: string;
  readonly describeCondition: (condition: TCondition) => string;
  readonly negate: (description: string) => string;
}

function describeNode<TCondition>(
  node: ConditionDescriptionNode<TCondition>,
  options: ConditionDescriptionOptions<TCondition>,
  nested: boolean,
): string {
  if (node.kind === "condition") {
    return options.describeCondition(node.condition).trim();
  }

  if (node.kind === "not") {
    const child = describeNode(node.child, options, false);
    return child ? options.negate(child) : "";
  }

  const descriptions = node.children
    .map((child) => describeNode(child, options, true))
    .filter(Boolean);
  if (descriptions.length === 0) return "";

  const separator =
    node.kind === "and" ? options.conjunction : options.disjunction;
  const description = descriptions.join(` ${separator} `);
  return nested && descriptions.length > 1 ? `(${description})` : description;
}

export function describeConditionTree<TCondition>(
  node: ConditionDescriptionNode<TCondition> | null | undefined,
  options: ConditionDescriptionOptions<TCondition>,
): string {
  if (!node) return options.empty;
  return describeNode(node, options, false) || options.empty;
}
