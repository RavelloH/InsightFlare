import {
  callFunction,
  caseWhen,
  castInteger,
  coalesce,
  compileD1Query,
  concatText,
  eq,
  excluded,
  filter,
  insert,
  inSubquery,
  isDistinctFrom,
  join,
  onConflictDoUpdate,
  param,
  project,
  rowNumber,
  scan,
  trimSpaces,
  union,
  unixepoch,
  update,
  window,
  windowCountRows,
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

  const visits = scan(schema.visits);
  const nonNullableTrim = trimSpaces(users.columns.email);
  const nullableTrim = trimSpaces(visits.columns.user_name);
  type TrimSpacesNonNullability = Assert<
    Equal<
      ExpressionResultOf<typeof nonNullableTrim>,
      ExpressionResultType<"text", false>
    >
  >;
  type TrimSpacesKeepsNullability = Assert<
    Equal<
      ExpressionResultOf<typeof nullableTrim>,
      ExpressionResultType<"text", true>
    >
  >;
  type NullableTrimSpacesValue = Assert<
    Equal<ExpressionValue<typeof nullableTrim>, string | null>
  >;
  const trimSpacesChecks: [
    TrimSpacesNonNullability,
    TrimSpacesKeepsNullability,
    NullableTrimSpacesValue,
  ] = [true, true, true];
  void trimSpacesChecks;
  const requiredConcat = concatText(param("task:"), param(-7));
  const nullableConcat = concatText(param("task:"), param(null), param("雪"));
  type ConcatValueIsString = Assert<
    Equal<ExpressionValue<typeof requiredConcat>, string>
  >;
  type ConcatMetadataIsRequiredText = Assert<
    Equal<
      ExpressionResultOf<typeof requiredConcat>,
      ExpressionResultType<"text", false>
    >
  >;
  type NullableConcatValueIncludesNull = Assert<
    Equal<ExpressionValue<typeof nullableConcat>, string | null>
  >;
  const concatChecks: [
    ConcatValueIsString,
    ConcatMetadataIsRequiredText,
    NullableConcatValueIncludesNull,
  ] = [true, true, true];
  void concatChecks;
  // @ts-expect-error Text concatenation requires at least two operands.
  concatText(param("only-one"));
  // @ts-expect-error BLOB operands have no portable SQLite text coercion contract.
  concatText(param("prefix"), param(new Uint8Array([1])));

  const scheduledRuns = scan(schema.scheduled_task_runs);
  const scheduledRunRows = project(scheduledRuns, {
    taskKey: scheduledRuns.columns.task_key,
    startedAt: scheduledRuns.columns.started_at_ms,
  });
  const rankedRuns = window(scheduledRuns, {
    latestRank: rowNumber({
      partitionBy: [scheduledRuns.columns.task_key],
      orderBy: [
        { expression: scheduledRuns.columns.started_at_ms, direction: "DESC" },
      ],
    }),
  });
  filter(rankedRuns, eq(rankedRuns.columns.latestRank, param(1)));
  const countedRuns = window(scheduledRunRows, {
    count: windowCountRows(),
    partitionCount: windowCountRows({
      partitionBy: [scheduledRunRows.columns.taskKey],
    }),
  });
  type CountWindowReturnsNumber = Assert<
    Equal<ExpressionValue<typeof countedRuns.columns.count>, number>
  >;
  type PartitionCountWindowReturnsNumber = Assert<
    Equal<ExpressionValue<typeof countedRuns.columns.partitionCount>, number>
  >;
  const countWindowChecks: [
    CountWindowReturnsNumber,
    PartitionCountWindowReturnsNumber,
  ] = [true, true];
  void countWindowChecks;
  filter(countedRuns, eq(countedRuns.columns.partitionCount, param(1)));
  // @ts-expect-error A window count descriptor is not a SQL expression.
  project(scheduledRunRows, { count: windowCountRows() });
  const unconsumedRank = rowNumber({
    orderBy: [
      { expression: scheduledRuns.columns.started_at_ms, direction: "DESC" },
    ],
  });
  // @ts-expect-error A window descriptor is not a SQL expression.
  project(scheduledRuns, { rank: unconsumedRank });
  const replacementRank = rowNumber({
    orderBy: [
      { expression: rankedRuns.columns.started_at_ms, direction: "DESC" },
    ],
  });
  // @ts-expect-error Window output names cannot replace input fields.
  window(rankedRuns, { latestRank: replacementRank });
  // @ts-expect-error rowNumber requires at least one ordering key.
  rowNumber({ partitionBy: [scheduledRuns.columns.task_key], orderBy: [] });
  // @ts-expect-error SQLite TRIM accepts text and unknown-affinity expressions only.
  trimSpaces(visits.columns.started_at);
  const castNonNullable = castInteger(visits.columns.started_at);
  const castNullable = castInteger(visits.columns.ended_at);
  type CastIntegerKeepsNonNullability = Assert<
    Equal<
      ExpressionResultOf<typeof castNonNullable>,
      ExpressionResultType<"integer", false>
    >
  >;
  type CastIntegerKeepsNullability = Assert<
    Equal<
      ExpressionResultOf<typeof castNullable>,
      ExpressionResultType<"integer", true>
    >
  >;
  type CastIntegerNullableValue = Assert<
    Equal<ExpressionValue<typeof castNullable>, number | null>
  >;
  const castChecks: [
    CastIntegerKeepsNonNullability,
    CastIntegerKeepsNullability,
    CastIntegerNullableValue,
  ] = [true, true, true];
  void castChecks;
  // @ts-expect-error CAST AS INTEGER accepts numeric expressions only.
  castInteger(users.columns.id);

  const nullableDistinct = isDistinctFrom(visits.columns.ended_at, param(null));
  const nullableMetric: number | null = 1;
  isDistinctFrom(visits.columns.perf_ttfb_ms, param(nullableMetric));
  type DistinctResultIsNonNullableInteger = Assert<
    Equal<
      ExpressionResultOf<typeof nullableDistinct>,
      ExpressionResultType<"integer", false>
    >
  >;
  type DistinctValueIsBoolean = Assert<
    Equal<ExpressionValue<typeof nullableDistinct>, boolean>
  >;
  const distinctChecks: [
    DistinctResultIsNonNullableInteger,
    DistinctValueIsBoolean,
  ] = [true, true];
  void distinctChecks;
  // @ts-expect-error A TEXT column cannot be compared with a numeric parameter.
  isDistinctFrom(users.columns.id, param(42));

  const guardedConfigUpsert = onConflictDoUpdate(
    insert(schema.configs, { config_key: "typed", value_json: "{}" }),
    ["config_key"],
    (columns) => ({
      set: {
        value_json: excluded(schema.configs.columns.value_json),
      },
      where: isDistinctFrom(columns.updated_at, param(0)),
    }),
  );
  void guardedConfigUpsert;

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
  const identities = scan(schema.site_identities);
  const selectedIdentity = project(identities, {
    site_id: identities.columns.site_id,
  });
  const membership = inSubquery(identities.columns.site_id, selectedIdentity);
  type MembershipResultIsNonNullableInteger = Assert<
    Equal<
      ExpressionResultOf<typeof membership>,
      ExpressionResultType<"integer", false>
    >
  >;
  type MembershipValueIsBoolean = Assert<
    Equal<ExpressionValue<typeof membership>, boolean>
  >;
  const membershipChecks: [
    MembershipResultIsNonNullableInteger,
    MembershipValueIsBoolean,
  ] = [true, true];
  void membershipChecks;
  const nullableSlugRelation = project(sites, {
    slug: sites.columns.public_slug,
  });
  const nullableMembership = inSubquery(
    sites.columns.public_slug,
    nullableSlugRelation,
  );
  type MembershipNullabilityIncludesEitherOperand = Assert<
    Equal<
      ExpressionResultOf<typeof nullableMembership>,
      ExpressionResultType<"integer", true>
    >
  >;
  type NullableMembershipValueIncludesNull = Assert<
    Equal<ExpressionValue<typeof nullableMembership>, boolean | null>
  >;
  const nullableMembershipChecks: [
    MembershipNullabilityIncludesEitherOperand,
    NullableMembershipValueIncludesNull,
  ] = [true, true];
  void nullableMembershipChecks;
  const selectedSiteId = project(identities, {
    site_id: identities.columns.site_id,
  });
  // @ts-expect-error Integer site_pk cannot be compared with a TEXT site_id.
  inSubquery(identities.columns.site_pk, selectedSiteId);
  const mixedFallback = coalesce(param("text"), param(1), param("again"));
  type MixedFallbackAffinityStaysUnknown = Assert<
    Equal<
      ExpressionResultOf<typeof mixedFallback>,
      ExpressionResultType<"unknown", false>
    >
  >;
  const mixedFallbackCheck: MixedFallbackAffinityStaysUnknown = true;
  void mixedFallbackCheck;

  const typedCase = caseWhen(
    [
      {
        when: eq(users.columns.id, param("user-1")),
        then: param("matched"),
      },
    ],
    param("fallback"),
  );
  type CaseValueIsText = Assert<
    ExpressionValue<typeof typedCase> extends string ? true : false
  >;
  type CaseMetadataIsNonNullableText = Assert<
    Equal<
      ExpressionResultOf<typeof typedCase>,
      ExpressionResultType<"text", false>
    >
  >;
  const caseChecks: [CaseValueIsText, CaseMetadataIsNonNullableText] = [
    true,
    true,
  ];
  void caseChecks;

  const nullableCase = caseWhen([
    {
      when: eq(users.columns.id, param("user-1")),
      then: param("matched"),
    },
  ]);
  type CaseWithoutElseIncludesNull = Assert<
    Equal<Extract<ExpressionValue<typeof nullableCase>, null>, null>
  >;
  type CaseWithoutElseIsNullable = Assert<
    Equal<
      ExpressionResultOf<typeof nullableCase>,
      ExpressionResultType<"text", true>
    >
  >;
  const nullableCaseChecks: [
    CaseWithoutElseIncludesNull,
    CaseWithoutElseIsNullable,
  ] = [true, true];
  void nullableCaseChecks;

  // @ts-expect-error Searched CASE requires at least one WHEN branch.
  caseWhen([]);
  // @ts-expect-error WHEN must be a predicate, not an arbitrary text expression.
  caseWhen([{ when: users.columns.email, then: param("matched") }]);
  // @ts-expect-error CASE result branches must have compatible affinities.
  caseWhen([
    { when: eq(users.columns.id, param("user-1")), then: param("matched") },
    { when: eq(users.columns.id, param("user-2")), then: param(1) },
  ]);

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
  // @ts-expect-error Direct access to the default-trim SQL operation stays on the typed helper.
  callFunction("trim-spaces", sites.columns.name);

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
