"use client";

import { useMemo, useState } from "react";
import { Database, LoaderCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type DuckDbModule = typeof import("@duckdb/duckdb-wasm");
type AsyncDuckDB = import("@duckdb/duckdb-wasm").AsyncDuckDB;

interface ArchiveManifestFile {
  archiveKey: string;
  format: string;
  rowCount: number;
  sizeBytes: number;
  fetchUrl?: string;
}

interface PrecisionQueryProps {
  siteId: string;
  from: number;
  to: number;
}

let duckdbInstancePromise: Promise<{ module: DuckDbModule; db: AsyncDuckDB }> | null = null;

async function getDuckDb(): Promise<{ module: DuckDbModule; db: AsyncDuckDB }> {
  if (duckdbInstancePromise) {
    return duckdbInstancePromise;
  }

  duckdbInstancePromise = (async () => {
    const module = await import("@duckdb/duckdb-wasm/dist/duckdb-browser.mjs");
    const bundles = module.getJsDelivrBundles();
    const bundle = await module.selectBundle(bundles);
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], {
        type: "text/javascript",
      }),
    );
    const worker = new Worker(workerUrl);
    URL.revokeObjectURL(workerUrl);

    const logger = new module.ConsoleLogger();
    const db = new module.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    return { module, db };
  })();

  return duckdbInstancePromise;
}

function defaultSql(siteId: string): string {
  return [
    "SELECT",
    "  date_trunc('day', to_timestamp(event_at / 1000.0)) AS day,",
    "  count(*) AS views,",
    "  count(DISTINCT session_id) AS sessions",
    "FROM archive_events",
    `WHERE site_id = '${siteId.replace(/'/g, "''")}'`,
    "GROUP BY 1",
    "ORDER BY 1 DESC",
    "LIMIT 60;",
  ].join("\n");
}

export function PrecisionQuery({ siteId, from, to }: PrecisionQueryProps): React.JSX.Element {
  const [sql, setSql] = useState<string>(() => defaultSql(siteId));
  const [status, setStatus] = useState<string>("Idle");
  const [running, setRunning] = useState(false);
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [fileCount, setFileCount] = useState(0);
  const rangeLabel = useMemo(() => `${new Date(from).toLocaleString()} ~ ${new Date(to).toLocaleString()}`, [from, to]);

  async function runQuery(): Promise<void> {
    setRunning(true);
    setStatus("Loading archive manifest...");
    setColumns([]);
    setRows([]);
    const registeredFiles: string[] = [];
    let conn: Awaited<ReturnType<AsyncDuckDB["connect"]>> | null = null;

    try {
      const manifestRes = await fetch(
        `/api/archive/manifest?siteId=${encodeURIComponent(siteId)}&from=${from}&to=${to}`,
        { cache: "no-store" },
      );
      if (!manifestRes.ok) {
        throw new Error(await manifestRes.text());
      }
      const manifest = (await manifestRes.json()) as {
        ok: boolean;
        files?: ArchiveManifestFile[];
      };
      const files = (manifest.files || []).filter((file) => file.format === "parquet" && file.fetchUrl);
      setFileCount(files.length);

      setStatus(`Initializing duckdb-wasm (${files.length} files)...`);
      const { db, module } = await getDuckDb();
      conn = await db.connect();

      await conn.query("DROP TABLE IF EXISTS archive_events");
      if (files.length === 0) {
        await conn.query(`
          CREATE TABLE archive_events (
            id VARCHAR,
            team_id VARCHAR,
            site_id VARCHAR,
            event_type VARCHAR,
            event_at BIGINT,
            pathname VARCHAR,
            query_string VARCHAR,
            hash_fragment VARCHAR,
            referer VARCHAR,
            referer_host VARCHAR,
            visitor_id VARCHAR,
            session_id VARCHAR,
            duration_ms BIGINT,
            country VARCHAR,
            device_type VARCHAR,
            browser VARCHAR,
            os VARCHAR,
            language VARCHAR
          )
        `);
      } else {
        let idx = 0;
        for (const file of files) {
          setStatus(`Registering remote parquet ${idx + 1}/${files.length}...`);
          const absoluteUrl = new URL(file.fetchUrl as string, window.location.origin).toString();
          const vfsName = `archive_${Date.now()}_${idx}.parquet`;
          await db.registerFileURL(vfsName, absoluteUrl, module.DuckDBDataProtocol.HTTP, false);
          registeredFiles.push(vfsName);
          if (idx === 0) {
            await conn.query(`CREATE TABLE archive_events AS SELECT * FROM read_parquet('${vfsName}')`);
          } else {
            await conn.query(`INSERT INTO archive_events SELECT * FROM read_parquet('${vfsName}')`);
          }
          idx += 1;
        }
      }

      setStatus("Running SQL...");
      const result = await conn.query(sql);
      const table = result as unknown as {
        schema?: { fields?: Array<{ name: string }> };
        toArray?: () => unknown[];
      };
      const colNames = table.schema?.fields?.map((field) => field.name) || [];
      const outRows = (table.toArray ? table.toArray() : []).map((row) => {
        if (row && typeof row === "object" && "toJSON" in (row as object)) {
          try {
            return ((row as { toJSON: () => Record<string, unknown> }).toJSON());
          } catch {
            return row as Record<string, unknown>;
          }
        }
        return row as Record<string, unknown>;
      });
      setColumns(colNames);
      setRows(outRows);
      setStatus(`Done. ${outRows.length} rows returned.`);
    } catch (error) {
      setStatus(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try {
        if (registeredFiles.length > 0) {
          const { db } = await getDuckDb();
          await db.dropFiles(registeredFiles);
        }
      } catch {
        // ignore best-effort cleanup failures
      }
      if (conn) {
        try {
          await conn.close();
        } catch {
          // ignore close errors
        }
      }
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl font-[var(--font-display)]">
            <Database className="h-5 w-5 text-accent" />
            DuckDB-WASM Precision Mode
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-slate-600">Range: {rangeLabel}</p>
          <p className="text-sm text-slate-600">Archive files in scope: {fileCount}</p>
          <label className="space-y-1">
            <span className="text-xs uppercase tracking-[0.12em] text-slate-500">SQL</span>
            <textarea
              value={sql}
              onChange={(event) => setSql(event.target.value)}
              className="min-h-[180px] w-full rounded-xl2 border border-slate-300 bg-white p-3 text-sm font-mono text-slate-800"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => void runQuery()} disabled={running}>
              {running ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
              Run Precision Query
            </Button>
            <Badge variant="outline">{status}</Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-[var(--font-display)]">Result</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-slate-600">No rows.</p>
          ) : (
            <div className="overflow-auto rounded-xl2 border border-slate-200">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    {columns.map((col) => (
                      <th key={col} className="px-3 py-2 font-medium text-slate-600">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => (
                    <tr key={idx} className="border-t border-slate-100">
                      {columns.map((col) => (
                        <td key={col} className="px-3 py-2 text-slate-700">
                          {String((row as Record<string, unknown>)[col] ?? "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
