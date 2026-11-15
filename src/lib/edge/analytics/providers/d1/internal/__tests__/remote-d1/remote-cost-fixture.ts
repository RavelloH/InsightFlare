import {
  assertDisposableDatabase,
  createRemoteD1Database,
  execRemote,
  type RemoteD1Options,
} from "./remote-d1-database";

export const C01_ACCOUNT_ID = "442fe5198bff93bdf60d4223d9618033";

/** Shared destructive fixture operation. Callers must explicitly authorize a
 * reset; a failed fingerprint/transport/metadata probe is never that authority. */
export async function resetRemoteCostFixture(
  options: RemoteD1Options,
  schemaStatements: readonly string[],
  seedStatements: readonly string[],
) {
  if (options.accountId !== C01_ACCOUNT_ID)
    throw new Error("c01_refuses_unapproved_account_id");
  await assertDisposableDatabase(options);
  const result = await createRemoteD1Database(options)
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    )
    .all<{ name: string }>();
  let remaining = result.results.map((row) => {
    if (!/^[A-Za-z0-9_]+$/u.test(row.name))
      throw new Error("c01_reset_schema_name_invalid");
    return row.name;
  });
  for (let pass = 0; remaining.length > 0 && pass < 10; pass += 1) {
    const blocked: string[] = [];
    for (const name of remaining) {
      try {
        await execRemote(options, `DROP TABLE IF EXISTS "${name}"`);
      } catch (error) {
        // Only dependency order is retried. Lost transport or missing genuine
        // server metrics must stop this explicit reset immediately.
        if (
          !(error instanceof Error) ||
          !/foreign key constraint failed/iu.test(error.message)
        )
          throw error;
        blocked.push(name);
      }
    }
    remaining = blocked;
  }
  if (remaining.length)
    throw new Error(`c01_cannot_clear_database:${remaining.join(",")}`);
  for (const statement of [...schemaStatements, ...seedStatements])
    await execRemote(options, statement);
}
