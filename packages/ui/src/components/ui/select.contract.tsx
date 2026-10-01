import {
  type ComponentFixture,
  defineComponentContract,
} from "../../contracts/component-contract";
import type { SelectProps } from "./select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

interface SelectScenarioProps extends SelectProps {
  readonly defaultValue: "daily" | "weekly";
}

export const selectFixtures = [
  {
    id: "select.state.daily",
    title: "Daily value",
    presentation: { kind: "scenario", scenario: "selected value" },
    props: {
      defaultValue: "daily",
      children: (
        <>
          <SelectTrigger aria-label="Reporting interval">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="daily">Daily</SelectItem>
            <SelectItem value="weekly">Weekly</SelectItem>
          </SelectContent>
        </>
      ),
    },
  },
  {
    id: "select.state.weekly",
    title: "Weekly value",
    presentation: { kind: "scenario", scenario: "selected value" },
    props: {
      defaultValue: "weekly",
      children: (
        <>
          <SelectTrigger aria-label="Reporting interval">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="daily">Daily</SelectItem>
            <SelectItem value="monthly">Monthly</SelectItem>
          </SelectContent>
        </>
      ),
    },
  },
] as const satisfies readonly ComponentFixture<SelectScenarioProps>[];

export const selectContract = defineComponentContract<SelectScenarioProps>({
  id: "select",
  title: "Select",
  category: "Inputs",
  categoryId: "inputs",
  description: "A keyboard-accessible selection control.",
  fixtures: selectFixtures,
  render: ({ defaultValue, children, ...props }) => (
    <Select defaultValue={defaultValue} {...props}>
      {children}
    </Select>
  ),
});
