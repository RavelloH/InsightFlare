import {
  callFunction,
  coalesce,
  compileD1Query,
  eq,
  insert,
  join,
  param,
  project,
  scan,
  union,
  unixepoch,
  update,
} from "@/lib/db";
import * as databaseFacade from "@/lib/db";
import type { CompiledQuery } from "@/lib/db/query/compiled";
import type {
  ExpressionResultOf,
  ExpressionResultType,
  ExpressionValue,
} from "@/lib/db/query/expression";
import { schema } from "@/lib/db/schema";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;

export function compileTimeDatabaseTypeAssertions(): void {
  // @ts-expect-error Raw SQL helpers are only exported from @/lib/db/unsafe.
  void databaseFacade.unsafeRawSql;
  // @ts-expect-error Raw mutation helpers are only exported from @/lib/db/unsafe.
  void databaseFacade.unsafeRawMutation;

  const users = scan(schema.users);
  eq(users.columns.id, param("user-1"));
  // @ts-expect-error A TEXT id cannot be compared with a number.
  eq(users.columns.id, param(42));

  const selected = project(users, { email: users.columns.email });
  const compiled = compileD1Query(selected);
  type SelectedRow =
    typeof compiled extends CompiledQuery<infer Row> ? Row : never;
  type ProjectionIsNarrow = Assert<Equal<keyof SelectedRow, "email">>;
  type ProjectionValueIsText = Assert<Equal<SelectedRow["email"], string>>;
  type ProjectionMetadataIsCatalogMetadata = Assert<
    Equal<
      ExpressionResultOf<typeof selected.columns.email>,
      ExpressionResultType<"text", false>
    >
  >;
  const projectionChecks: [ProjectionIsNarrow, ProjectionValueIsText] = [
    true,
    true,
  ];
  void projectionChecks;

  const events = scan(schema.custom_events);
  const names = scan(schema.custom_event_names);
  const left = join(
    events,
    names,
    eq(events.columns.event_name_id, names.columns.id),
    "left",
  );
  type LeftJoinValue = ExpressionValue<typeof left.columns.right_name>;
  type LeftJoinMakesRightNullable = Assert<
    Equal<Extract<LeftJoinValue, null>, null>
  >;
  type LeftJoinMetadataIsNullable = Assert<
    Equal<
      ExpressionResultOf<typeof left.columns.right_name>,
      ExpressionResultType<"text", true>
    >
  >;
  const leftJoinChecks: LeftJoinMakesRightNullable = true;
  void leftJoinChecks;

  const sites = scan(schema.sites);
  const mixedFallback = coalesce(param("text"), param(1), param("again"));
  type MixedFallbackAffinityStaysUnknown = Assert<
    Equal<
      ExpressionResultOf<typeof mixedFallback>,
      ExpressionResultType<"unknown", false>
    >
  >;
  const mixedFallbackCheck: MixedFallbackAffinityStaysUnknown = true;
  void mixedFallbackCheck;
  insert(schema.configs, {
    config_key: "typed",
    value_json: "{}",
    // @ts-expect-error INSERT expression affinity must match the target value type.
    created_at: "not-a-timestamp",
    updated_at: unixepoch(),
  });
  // @ts-expect-error A TEXT id cannot be compared with a number.
  eq(sites.columns.id, param(42));
  // @ts-expect-error lower() accepts text expressions.
  callFunction("lower", sites.columns.created_at);
  // @ts-expect-error length() accepts text or blob expressions.
  callFunction("length", sites.columns.created_at);
  // @ts-expect-error abs() accepts numeric expressions.
  callFunction("abs", sites.columns.name);

  const nullableSlug = project(sites, { slug: sites.columns.public_slug });
  const requiredSlug = project(sites, { slug: sites.columns.name });
  const combined = union(nullableSlug, requiredSlug, true);
  type UnionMetadataWidensNullability = Assert<
    Equal<
      ExpressionResultOf<typeof combined.columns.slug>,
      ExpressionResultType<"text", true>
    >
  >;
  type UnionValueWidensNullability = Assert<
    Equal<ExpressionValue<typeof combined.columns.slug>, string | null>
  >;
  const unionChecks: [
    UnionMetadataWidensNullability,
    UnionValueWidensNullability,
  ] = [true, true];
  void unionChecks;

  // @ts-expect-error The non-null email column is required by the generated catalog.
  insert(schema.users, { name: "No email" });
  // @ts-expect-error Insert values cannot contain fields outside the table catalog.
  insert(schema.users, { email: "user@example.test", not_a_column: true });

  update(schema.users, (columns) => ({
    // @ts-expect-error email is TEXT, so a numeric assignment is rejected.
    set: { email: 123 },
    where: eq(columns.id, param("user-1")),
  }));
}
