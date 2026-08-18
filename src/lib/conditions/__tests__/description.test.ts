import { describe, expect, it } from "vitest";

import {
  type ConditionDescriptionNode,
  describeConditionTree,
} from "@/lib/conditions/description";

describe("condition descriptions", () => {
  const options = {
    empty: "No conditions",
    conjunction: "and",
    disjunction: "or",
    describeCondition: (condition: string) => condition,
    negate: (description: string) => `not (${description})`,
  };

  it("uses parentheses for nested boolean groups", () => {
    const node: ConditionDescriptionNode<string> = {
      kind: "and",
      children: [
        { kind: "condition", condition: "Page is pricing" },
        {
          kind: "or",
          children: [
            { kind: "condition", condition: "Referrer is Google" },
            { kind: "condition", condition: "Device is mobile" },
          ],
        },
      ],
    };

    expect(describeConditionTree(node, options)).toBe(
      "Page is pricing and (Referrer is Google or Device is mobile)",
    );
  });

  it("preserves negation and returns the localized empty state", () => {
    expect(
      describeConditionTree(
        {
          kind: "not",
          child: {
            kind: "or",
            children: [
              { kind: "condition", condition: "Country is CN" },
              { kind: "condition", condition: "Country is JP" },
            ],
          },
        },
        options,
      ),
    ).toBe("not (Country is CN or Country is JP)");
    expect(describeConditionTree(null, options)).toBe("No conditions");
  });
});
