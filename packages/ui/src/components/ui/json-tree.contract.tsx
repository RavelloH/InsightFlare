import {
  type ComponentFixture,
  defineComponentContract,
} from "../../contracts/component-contract";
import { JsonTreePanel, type JsonTreePanelProps } from "./json-tree";

const labels = {
  expandField: "Expand field",
  collapseField: "Collapse field",
  copyJson: "Copy JSON",
  copiedJson: "JSON copied",
  copyJsonFailed: "Could not copy JSON",
  copyValue: "Copy value",
  copiedValue: "Value copied",
  copyValueFailed: "Could not copy value",
};

const jsonTreeFixtures = [
  {
    id: "json-tree.scenario.event",
    title: "Event payload",
    presentation: { kind: "scenario", scenario: "nested object" },
    props: {
      value: {
        event: "checkout.completed",
        visitor: { id: "visitor_1284", returning: true },
        properties: { currency: "USD", total: 84.5 },
      },
      labels,
    },
  },
  {
    id: "json-tree.scenario.array",
    title: "Array payload",
    presentation: { kind: "scenario", scenario: "array values" },
    props: {
      value: ["direct", "search", "social"],
      labels,
    },
  },
] as const satisfies readonly ComponentFixture<JsonTreePanelProps>[];

export const jsonTreeContract = defineComponentContract<JsonTreePanelProps>({
  id: "json-tree",
  title: "JSON tree",
  category: "Data display",
  categoryId: "data-display",
  description: "An expandable JSON viewer with copy actions for values.",
  fixtures: jsonTreeFixtures,
  render: (props) => <JsonTreePanel {...props} />,
});
