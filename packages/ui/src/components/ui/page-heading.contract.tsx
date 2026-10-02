import {
  type ComponentFixture,
  defineComponentContract,
} from "../../contracts/component-contract";
import { Button } from "./button";
import { PageHeading, type PageHeadingProps } from "./page-heading";

const pageHeadingFixtures = [
  {
    id: "page-heading.scenario.default",
    title: "Page heading",
    presentation: { kind: "scenario", scenario: "without actions" },
    props: {
      title: "Goals",
      subtitle:
        "Measure conversion from a single reusable event or page condition.",
    },
  },
  {
    id: "page-heading.scenario.actions",
    title: "With actions",
    presentation: { kind: "scenario", scenario: "with actions" },
    props: {
      title: "Goals",
      subtitle:
        "Measure conversion from a single reusable event or page condition.",
      actions: <Button>New goal</Button>,
    },
  },
] as const satisfies readonly ComponentFixture<PageHeadingProps>[];

export const pageHeadingContract = defineComponentContract<PageHeadingProps>({
  id: "page-heading",
  title: "Page heading",
  category: "Foundations",
  categoryId: "foundations",
  description: "A responsive page title, subtitle, and optional action group.",
  fixtures: pageHeadingFixtures,
  render: (props) => <PageHeading {...props} />,
});
