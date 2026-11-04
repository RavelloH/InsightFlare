import type { SqlFragment } from "@/lib/db/sql/fragment";

declare const finalRenderSessionBrand: unique symbol;

/** A request-local token that owns one concrete rendering attempt. */
export interface FinalRenderSession {
  readonly [finalRenderSessionBrand]: true;
}

export type FinalRenderEmission =
  | { readonly kind: "lexicographic"; readonly choice: object }
  | { readonly kind: "semi-membership"; readonly choice: object }
  | { readonly kind: "singleton-rank"; readonly choice: object }
  | { readonly kind: "native-null-ordering"; readonly choice: object }
  | {
      readonly kind: "materialized-reference";
      readonly definition: object;
      readonly definitionIndex: number;
      readonly fieldCount: number;
    }
  | {
      readonly kind: "materialization-definition";
      readonly definition: object;
      readonly definitionIndex: number;
      readonly selectionKind:
        | "strict-serial-rank-stage"
        | "stage-derived-auto"
        | "current-boundary-derived-auto";
      readonly choiceIndex: number;
    }
  | {
      readonly kind: "shared-reference";
      readonly definition: object;
      readonly definitionIndex: number;
    }
  | {
      readonly kind: "compile-order-helper";
      readonly helper: object;
      readonly leafDefinitionIndexes: readonly number[];
      readonly strategy: "dead-branch-materialization-order";
    }
  | { readonly kind: "derived-self-membership"; readonly choice: object };

export interface FinalRenderEmissionCounts {
  readonly lexicographic: ReadonlyMap<object, number>;
  readonly semiMembership: ReadonlyMap<object, number>;
  readonly singletonRank: ReadonlyMap<object, number>;
  readonly nativeNullOrdering: ReadonlyMap<object, number>;
  readonly materializedReferences: ReadonlyMap<
    object,
    {
      readonly definitionIndex: number;
      readonly fieldCount: number;
      readonly emissionCount: number;
    }
  >;
  readonly materializationDefinitions: ReadonlyMap<
    object,
    {
      readonly definitionIndex: number;
      readonly selectionKind:
        | "strict-serial-rank-stage"
        | "stage-derived-auto"
        | "current-boundary-derived-auto";
      readonly choiceIndex: number;
      readonly emissionCount: number;
    }
  >;
  readonly sharedReferences: ReadonlyMap<
    object,
    { readonly definitionIndex: number; readonly emissionCount: number }
  >;
  readonly compileOrderHelpers: ReadonlyMap<
    object,
    {
      readonly leafDefinitionIndexes: readonly number[];
      readonly strategy: "dead-branch-materialization-order";
      readonly emissionCount: number;
    }
  >;
  readonly derivedSelfMembership: ReadonlyMap<object, number>;
  readonly totalEmissionCount: number;
}

export interface FinalRenderTestDiagnostic {
  /** Exact final fragment after typed parameter-slot rewriting. */
  readonly fragment: SqlFragment;
  readonly emissionCounts: FinalRenderEmissionCounts;
}

export function createFinalRenderSession(): FinalRenderSession {
  return Object.freeze({}) as FinalRenderSession;
}
