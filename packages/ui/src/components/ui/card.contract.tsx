import {
  type ComponentFixture,
  defineComponentContract,
} from "../../contracts/component-contract";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  type CardProps,
  CardTitle,
} from "./card";

const cardFixtures = [
  {
    id: "card.scenario.metric",
    title: "Metric card",
    presentation: { kind: "scenario", scenario: "content composition" },
    props: {
      children: (
        <>
          <CardHeader>
            <CardTitle>Active visitors</CardTitle>
            <CardDescription>Compared with the previous period</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-2xl font-semibold tabular-nums">
              1,284
            </p>
          </CardContent>
        </>
      ),
    },
  },
  {
    id: "card.scenario.summary",
    title: "Summary card",
    presentation: { kind: "scenario", scenario: "summary content" },
    props: {
      children: (
        <>
          <CardHeader>
            <CardTitle>Conversion rate</CardTitle>
            <CardDescription>Visitors who completed a goal</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-2xl font-semibold tabular-nums">
              12.5%
            </p>
          </CardContent>
        </>
      ),
    },
  },
] as const satisfies readonly ComponentFixture<CardProps>[];

export const cardContract = defineComponentContract<CardProps>({
  id: "card",
  title: "Card",
  category: "Data display",
  categoryId: "data-display",
  description: "A composed surface with header, supporting copy, and body.",
  fixtures: cardFixtures,
  render: (props) => <Card {...props} />,
});
