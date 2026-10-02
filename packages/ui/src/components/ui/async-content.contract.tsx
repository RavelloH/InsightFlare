import {
  type ComponentFixture,
  defineComponentContract,
} from "../../contracts/component-contract";
import { AsyncContent, type AsyncContentProps } from "./async-content";

const asyncContentFixtures = [
  {
    id: "async-content.scenario.content",
    title: "Content",
    presentation: { kind: "scenario", scenario: "content" },
    props: {
      loading: false,
      hasContent: true,
      loadingLabel: "Loading report…",
      emptyContent: "No report data available.",
      children: (
        <div className="flex min-h-20 items-center justify-center border bg-card p-4">
          Report content
        </div>
      ),
    },
  },
  {
    id: "async-content.scenario.loading",
    title: "Loading",
    presentation: { kind: "scenario", scenario: "loading" },
    props: {
      loading: true,
      hasContent: false,
      loadingLabel: "Loading report…",
      emptyContent: "No report data available.",
      children: null,
    },
  },
  {
    id: "async-content.scenario.empty",
    title: "Empty",
    presentation: { kind: "scenario", scenario: "empty" },
    props: {
      loading: false,
      hasContent: false,
      loadingLabel: "Loading report…",
      emptyContent: "No report data available.",
      children: null,
    },
  },
] as const satisfies readonly ComponentFixture<AsyncContentProps>[];

export const asyncContentContract = defineComponentContract<AsyncContentProps>({
  id: "async-content",
  title: "Async content",
  category: "Feedback",
  categoryId: "feedback",
  description: "Animated loading, empty, and content states for async views.",
  fixtures: asyncContentFixtures,
  render: (props) => <AsyncContent {...props} />,
});
