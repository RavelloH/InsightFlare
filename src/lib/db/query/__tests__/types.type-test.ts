import {
  and,
  callFunction,
  caseWhen,
  castInteger,
  castText,
  coalesce,
  compileD1Query,
  concatText,
  constant,
  eq,
  excluded,
  filter,
  insert,
  inSubquery,
  isDistinctFrom,
  join,
  jsonScalarArray,
  onConflictDoUpdate,
  param,
  project,
  recursiveClosure,
  rowNumber,
  scan,
  textContains,
  textEndsWith,
  textLike,
  textPosition,
  textStartsWith,
  textSubstring,
  trimSpaces,
  union,
  unixepoch,
  update,
  valuesRelation,
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
import type { TextRowRelationSchema } from "@/lib/db/query/plan";
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
  const requiredTextMatch = textContains(users.columns.email, "example");
  const nullableTextMatch = textStartsWith(visits.columns.user_name, "A");
  const nullableSuffixMatch = textEndsWith(visits.columns.user_name, "Z");
  type RequiredTextMatchResult = Assert<
    Equal<
      ExpressionResultOf<typeof requiredTextMatch>,
      ExpressionResultType<"integer", false>
    >
  >;
  type NullableTextMatchResult = Assert<
    Equal<
      ExpressionResultOf<typeof nullableTextMatch>,
      ExpressionResultType<"integer", true>
    >
  >;
  type NullableTextMatchValue = Assert<
    Equal<ExpressionValue<typeof nullableTextMatch>, boolean | null>
  >;
  const textMatchChecks: [
    RequiredTextMatchResult,
    NullableTextMatchResult,
    NullableTextMatchValue,
  ] = [true, true, true];
  void textMatchChecks;
  // @ts-expect-error Numeric expressions are not string matching inputs.
  textContains(visits.columns.started_at, "1");
  // @ts-expect-error Matching patterns are non-null string literals.
  textContains(users.columns.email, null);
  // @ts-expect-error Matching patterns must be strings.
  textStartsWith(users.columns.email, 1);
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

  const widenedNullable: boolean = true;
  const widenedSchema = {
    optional_text: { affinity: "text", nullable: widenedNullable },
  } as const satisfies TextRowRelationSchema;
  const widenedRows = valuesRelation(widenedSchema, [{ optional_text: null }]);
  type WidenedNullableTextIncludesNull = Assert<
    Equal<
      ExpressionValue<typeof widenedRows.columns.optional_text>,
      string | null
    >
  >;
  const widenedNullableFixture: WidenedNullableTextIncludesNull = true;
  void widenedNullableFixture;
  const literalRequiredSchema = {
    required_text: { affinity: "text", nullable: false },
  } as const satisfies TextRowRelationSchema;
  // @ts-expect-error Literal nullable=false excludes a NULL cell.
  valuesRelation(literalRequiredSchema, [{ required_text: null }]);

  const castTextValue = castText(users.columns.email);
  const positionValue = textPosition(users.columns.email, param("@"));
  const substringValue = textSubstring(
    users.columns.email,
    param(-2),
    param(2),
  );
  const likeValue = textLike(users.columns.email, param("%@%"));
  const literalValue = constant("O'Brien");
  const jsonTextValues = jsonScalarArray("text", ["first", "second"]);
  const jsonNumericValues = jsonScalarArray("numeric", [1, 2.5, -0]);
  type CastTextValueIsString = Assert<
    Equal<ExpressionValue<typeof castTextValue>, string>
  >;
  type PositionValueIsNumber = Assert<
    Equal<ExpressionValue<typeof positionValue>, number>
  >;
  type SubstringValueIsString = Assert<
    Equal<ExpressionValue<typeof substringValue>, string>
  >;
  type LikeValueIsBoolean = Assert<
    Equal<ExpressionValue<typeof likeValue>, boolean>
  >;
  type ConstantRetainsItsLiteral = Assert<
    Equal<ExpressionValue<typeof literalValue>, "O'Brien">
  >;
  type JsonTextArrayColumnMetadata = Assert<
    Equal<
      ExpressionResultOf<typeof jsonTextValues.columns.value>,
      ExpressionResultType<"text", false>
    >
  >;
  type JsonNumericArrayColumnMetadata = Assert<
    Equal<
      ExpressionResultOf<typeof jsonNumericValues.columns.value>,
      ExpressionResultType<"numeric", false>
    >
  >;
  const primitiveTypeChecks: [
    CastTextValueIsString,
    PositionValueIsNumber,
    SubstringValueIsString,
    LikeValueIsBoolean,
    ConstantRetainsItsLiteral,
    JsonTextArrayColumnMetadata,
    JsonNumericArrayColumnMetadata,
  ] = [true, true, true, true, true, true, true];
  void primitiveTypeChecks;

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
  // @ts-expect-error castText does not accept predicate/boolean expressions.
  castText(eq(users.columns.id, param("user-1")));
  // @ts-expect-error textPosition requires text-compatible expressions.
  textPosition(users.columns.email, sites.columns.created_at);
  // @ts-expect-error jsonScalarArray numeric cells must be numbers.
  jsonScalarArray("numeric", [1, true]);
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

  const jsonNodes = scan(schema.custom_event_json_nodes);
  const closureTuples = project(jsonNodes, {
    eventPk: jsonNodes.columns.event_pk,
    nodeId: jsonNodes.columns.node_id,
    parentNodeId: jsonNodes.columns.parent_node_id,
  });
  const selectedClosure = recursiveClosure(
    closureTuples,
    closureTuples,
    (current, candidate) =>
      and(
        eq(current.eventPk, candidate.eventPk),
        eq(current.parentNodeId, candidate.nodeId),
      ),
  );
  const compiledClosure = compileD1Query(selectedClosure);
  type ClosureRow =
    typeof compiledClosure extends CompiledQuery<infer Row> ? Row : never;
  type ClosurePreservesCompleteTuple = Assert<
    Equal<keyof ClosureRow, "eventPk" | "nodeId" | "parentNodeId">
  >;
  type ClosureKeepsNamespace = Assert<Equal<ClosureRow["eventPk"], number>>;
  type ClosureKeepsNullableParent = Assert<
    Equal<
      ExpressionResultOf<typeof selectedClosure.columns.parentNodeId>,
      ExpressionResultType<"integer", true>
    >
  >;
  const closureTypeChecks: [
    ClosurePreservesCompleteTuple,
    ClosureKeepsNamespace,
    ClosureKeepsNullableParent,
  ] = [true, true, true];
  void closureTypeChecks;
  const missingClosureField = project(jsonNodes, {
    eventPk: jsonNodes.columns.event_pk,
    node: jsonNodes.columns.node_id,
  });
  // @ts-expect-error Candidate closure tuples must have every seed field.
  recursiveClosure(closureTuples, missingClosureField, () =>
    eq(param(1), param(1)),
  );
  const incompatibleClosureField = project(jsonNodes, {
    eventPk: param("wrong-affinity"),
    nodeId: jsonNodes.columns.node_id,
    parentNodeId: jsonNodes.columns.parent_node_id,
  });
  // @ts-expect-error Corresponding closure field affinities must be compatible.
  recursiveClosure(closureTuples, incompatibleClosureField, () =>
    eq(param(1), param(1)),
  );
  const extraClosureField = project(jsonNodes, {
    eventPk: jsonNodes.columns.event_pk,
    nodeId: jsonNodes.columns.node_id,
    parentNodeId: jsonNodes.columns.parent_node_id,
    extra: jsonNodes.columns.depth,
  });
  // @ts-expect-error Recursive closure tuples cannot add extra fields.
  recursiveClosure(closureTuples, extraClosureField, () =>
    eq(param(1), param(1)),
  );

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
