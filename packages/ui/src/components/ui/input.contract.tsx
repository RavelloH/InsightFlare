import {
  type ComponentFixture,
  defineComponentContract,
} from "../../contracts/component-contract";
import { Input, type InputProps } from "./input";

export const inputFixtures = [
  {
    id: "input.state.default",
    title: "Default",
    presentation: { kind: "scenario", scenario: "default" },
    props: { placeholder: "Enter a value" } satisfies InputProps,
  },
  {
    id: "input.state.invalid",
    title: "Invalid",
    presentation: { kind: "scenario", scenario: "invalid" },
    props: {
      value: "invalid@example",
      "aria-invalid": true,
      readOnly: true,
    } satisfies InputProps,
  },
  {
    id: "input.state.disabled",
    title: "Disabled",
    presentation: { kind: "scenario", scenario: "disabled" },
    props: { placeholder: "Unavailable", disabled: true } satisfies InputProps,
  },
] as const satisfies readonly ComponentFixture<InputProps>[];

export const inputContract = defineComponentContract<InputProps>({
  id: "input",
  title: "Input",
  category: "Inputs",
  categoryId: "inputs",
  description: "Text entry with focus, invalid, and disabled states.",
  fixtures: inputFixtures,
  render: (props) => <Input {...props} />,
});
