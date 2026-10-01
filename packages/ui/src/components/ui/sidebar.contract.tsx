import {
  type ComponentFixture,
  defineComponentContract,
} from "../../contracts/component-contract";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  type SidebarProps,
  SidebarProvider,
} from "./sidebar";

interface SidebarScenarioProps extends Pick<
  SidebarProps,
  "side" | "variant" | "collapsible"
> {
  readonly activeItem: string;
  readonly defaultOpen?: boolean;
  readonly open?: boolean;
}

const sidebarFixtures = [
  {
    id: "sidebar.scenario.navigation",
    title: "Navigation",
    presentation: { kind: "scenario", scenario: "active item" },
    props: { activeItem: "Overview" },
  },
] as const satisfies readonly ComponentFixture<SidebarScenarioProps>[];

export const sidebarContract = defineComponentContract<SidebarScenarioProps>({
  id: "sidebar",
  title: "Sidebar",
  category: "Navigation",
  categoryId: "navigation",
  description: "Responsive navigation with keyboard accessible menu items.",
  fixtures: sidebarFixtures,
  render: ({
    activeItem,
    side = "left",
    variant = "sidebar",
    collapsible = "none",
    defaultOpen = true,
    open,
  }) => (
    <SidebarProvider defaultOpen={defaultOpen} open={open}>
      <div className="flex min-h-52 w-full border">
        <Sidebar
          side={side}
          variant={variant}
          collapsible={collapsible}
          className="relative h-auto"
        >
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Analytics</SidebarGroupLabel>
              <SidebarMenu>
                {["Overview", "Pages", "Goals"].map((item) => (
                  <SidebarMenuItem key={item}>
                    <SidebarMenuButton isActive={item === activeItem}>
                      {item}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
      </div>
    </SidebarProvider>
  ),
});
