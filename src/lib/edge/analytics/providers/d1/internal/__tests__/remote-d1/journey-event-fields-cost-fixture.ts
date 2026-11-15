import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expandCustomEventData } from "@/lib/edge/ingest/custom-event-json";

import {
  buildDataStatements,
  buildSiteStatements,
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_SITE_ID,
} from "./seed";

const sql = (value: unknown) => {
  if (value === null) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error("c01_next_fixture_invalid_sql_value");
};
export const NEXT_FUNNEL_ID = "c01-next-funnel";
export function nextFamilyFixtureStatements() {
  const statements: string[] = [];
  // Same visitor returns in two later buckets; both returns qualify independently.
  for (const day of [3, 4]) {
    const at = SEED_BASE_MS + day * SEED_DAY_MS + 1000;
    statements.push(
      `INSERT INTO visits (visit_id,site_id,site_pk,visitor_id,session_id,status,started_at,last_activity_at,pathname,hostname,created_at,updated_at) VALUES ('c01-return-${day}',${sql(SEED_SITE_ID)},1,'vis0','c01-return-${day}','closed',${at},${at + 100},'/qualifier','c01.example.invalid',${Math.floor(at / 1000)},${Math.floor(at / 1000)})`,
    );
    statements.push(
      `INSERT INTO custom_events (event_id,site_id,site_pk,visit_id,event_name_id,occurred_at,received_at,sequence,node_count,value_count,created_at) VALUES ('c01-return-event-${day}',${sql(SEED_SITE_ID)},1,'c01-return-${day}',1,${at + 1},${at + 1},0,0,0,${Math.floor(at / 1000)})`,
    );
  }
  const config = {
    filterDslVersion: 1,
    progressionScope: "session",
    conversionWindowMs: null,
    steps: [
      { id: "landing", filterDsl: 'page.path eq "/qualifier"' },
      { id: "qualified", filterDsl: 'event.name eq "qualifier"' },
    ],
  };
  statements.push(
    `INSERT INTO analysis_definitions (id,site_id,kind,name,config_json,config_version,created_at,updated_at) VALUES (${sql(NEXT_FUNNEL_ID)},${sql(SEED_SITE_ID)},'funnel','C01 next family',${sql(JSON.stringify(config))},2,0,0)`,
  );
  const payload = expandCustomEventData({
    plan: "pro",
    amount: 42,
    active: true,
  });
  if (!payload.ok)
    throw new Error(`next_payload_fixture_invalid:${payload.error}`);
  const keyId = new Map(
    payload.data.keys.map((key, index) => [key, index + 1]),
  );
  const pathId = new Map(
    payload.data.paths.map((path, index) => [path, index + 1]),
  );
  for (const [key, id] of keyId)
    statements.push(
      `INSERT INTO custom_event_json_keys (id,site_id,site_pk,key,last_seen_at,created_at) VALUES (${id},${sql(SEED_SITE_ID)},1,${sql(key)},0,0)`,
    );
  for (const [path, id] of pathId)
    statements.push(
      `INSERT INTO custom_event_json_paths (id,site_id,site_pk,path,last_seen_at,created_at) VALUES (${id},${sql(SEED_SITE_ID)},1,${sql(path)},0,0)`,
    );
  for (const node of payload.data.nodes)
    statements.push(
      `INSERT INTO custom_event_json_nodes (event_pk,node_id,parent_node_id,key_id,path_id,value_type,member_order,array_index,depth) SELECT event_pk,${node.nodeId},${sql(node.parentNodeId)},${sql(node.key === null ? null : keyId.get(node.key))},${pathId.get(node.path)},${node.valueType},${sql(node.memberOrder)},${sql(node.arrayIndex)},${node.depth} FROM custom_events WHERE event_name_id=1`,
    );
  for (const value of payload.data.values)
    statements.push(
      `INSERT INTO custom_event_json_values (event_pk,node_id,site_id,event_name_id,path_id,occurred_at,scope_node_id,value_type,string_value,string_hash,number_value,boolean_value,site_pk) SELECT event_pk,${value.nodeId},site_id,event_name_id,${pathId.get(value.path)},occurred_at,${sql(value.scopeNodeId)},${value.valueType},${sql(value.stringValue)},${sql(value.stringHash)},${sql(value.numberValue)},${sql(value.booleanValue)},site_pk FROM custom_events WHERE event_name_id=1`,
    );
  statements.push(
    `UPDATE custom_events SET node_count=${payload.data.nodes.length},value_count=${payload.data.values.length} WHERE event_name_id=1`,
  );
  return statements;
}

/** Independent seed: never reuse/reset the approved original remote fixture. */
export function buildJourneyEventFieldsCostFixture(visits: number) {
  if (!Number.isSafeInteger(visits) || visits < 1 || visits > 10000)
    throw new Error("c01_next_fixture_invalid_scale");
  const seed = [
    ...buildSiteStatements(),
    ...buildDataStatements({ visits }),
    ...nextFamilyFixtureStatements(),
  ];
  const schemaSql = readFileSync(resolve("docs/schema.sql"), "utf8").replace(
    /\r\n/gu,
    "\n",
  );
  return {
    seed,
    schemaSql,
    fingerprint: createHash("sha256")
      .update(JSON.stringify([schemaSql, seed]))
      .digest("hex"),
  };
}
