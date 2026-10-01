import {
  type ComponentFixture,
  defineComponentContract,
} from "../../contracts/component-contract";
import { Button, type ButtonProps } from "./button";

export const buttonFixtures = [
  {
    id: "button.variant.default",
    title: "Default",
    presentation: { kind: "axis", axis: "variant", value: "default" },
    props: { variant: "default", children: "Save" } satisfies ButtonProps,
  },
  {
    id: "button.variant.outline",
    title: "Outline",
    presentation: { kind: "axis", axis: "variant", value: "outline" },
    props: { variant: "outline", children: "Cancel" } satisfies ButtonProps,
  },
  {
    id: "button.variant.destructive",
    title: "Destructive",
    presentation: { kind: "axis", axis: "variant", value: "destructive" },
    props: { variant: "destructive", children: "Delete" } satisfies ButtonProps,
  },
  {
    id: "button.size.sm",
    title: "Small",
    presentation: { kind: "axis", axis: "size", value: "sm" },
    props: { size: "sm", children: "Compact" } satisfies ButtonProps,
  },
  {
    id: "button.state.disabled",
    title: "Disabled",
    presentation: { kind: "scenario", scenario: "disabled" },
    props: { disabled: true, children: "Unavailable" } satisfies ButtonProps,
  },
] as const satisfies readonly ComponentFixture<ButtonProps>[];

export const buttonContract = defineComponentContract<ButtonProps>({
  id: "button",
  title: "Button",
  category: "Inputs",
  categoryId: "inputs",
  description: "Actions with shared variants, sizes, and disabled behavior.",
  fixtures: buttonFixtures,
  render: (props) => <Button {...props} />,
});
