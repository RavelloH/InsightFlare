import type { GoalVisualizationProps } from "./goal-visualization";

export interface GoalVisualizationLabels {
  readonly visitors: string;
  readonly sessions: string;
  readonly visitorConversion: string;
  readonly visitorConversionComparison: string;
}

/** Replaces every visible label in goal visualization props. */
export function withGoalVisualizationLabels(
  props: GoalVisualizationProps,
  labels: GoalVisualizationLabels,
): GoalVisualizationProps {
  const { visitorConversion } = props;
  return {
    visitors: { ...props.visitors, label: labels.visitors },
    sessions: { ...props.sessions, label: labels.sessions },
    visitorConversion: {
      ...visitorConversion,
      label: labels.visitorConversion,
      comparison: visitorConversion.comparison
        ? {
            ...visitorConversion.comparison,
            label: labels.visitorConversionComparison,
          }
        : null,
    },
  };
}
