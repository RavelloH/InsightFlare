import type { ReactNode } from "react";

export type ComponentCategoryId =
  | "inputs"
  | "feedback"
  | "foundations"
  | "navigation"
  | "data-display"
  | "overlays"
  | "product-analytics"
  | "product-management"
  | "product-realtime";

export type ComponentFixturePresentation =
  | { readonly kind: "axis"; readonly axis: string; readonly value: string }
  | {
      readonly kind: "matrix";
      readonly matrix: string;
      readonly row: string;
      readonly column: string;
    }
  | { readonly kind: "scenario"; readonly scenario: string };

export interface ComponentFixture<Props> {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly presentation?: ComponentFixturePresentation;
  readonly props: Props;
}

export interface ComponentContract<Props> {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly categoryId: ComponentCategoryId;
  readonly description?: string;
  readonly fixtures: readonly ComponentFixture<Props>[];
  render(props: Props): ReactNode;
  renderFixture(fixtureId: string): ReactNode | null;
}

export type ComponentContractDefinition<Props> = Omit<
  ComponentContract<Props>,
  "renderFixture"
>;

export function defineComponentContract<Props>(
  definition: ComponentContractDefinition<Props>,
): ComponentContract<Props> {
  return {
    ...definition,
    renderFixture(fixtureId) {
      const fixture = definition.fixtures.find(
        (candidate) => candidate.id === fixtureId,
      );
      if (!fixture) return null;
      return definition.render(fixture.props);
    },
  };
}
