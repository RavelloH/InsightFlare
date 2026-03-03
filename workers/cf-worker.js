import { IngestDurableObject } from "../src/lib/edge/ingest-do";
import { runHourlyArchive } from "../src/lib/edge/archive";
import nextWorker from "../.open-next/worker.js";

async function handleAdminWs(request, env) {
  const incomingUrl = new URL(request.url);
  const siteId = incomingUrl.searchParams.get("siteId") || "default";
  const doId = env.INGEST_DO.idFromName(siteId);
  const stub = env.INGEST_DO.get(doId);
  const forwardUrl = "https://ingest.internal/ws" + incomingUrl.search;
  return stub.fetch(new Request(forwardUrl, request));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname === "/admin/ws") {
      return handleAdminWs(request, env);
    }
    return nextWorker.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runHourlyArchive(env, controller.scheduledTime));
  },
};

export { IngestDurableObject };

