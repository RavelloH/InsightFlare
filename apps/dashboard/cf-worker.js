import edgeApp, { IngestDurableObject } from "../edge/src/index";
import nextWorker from "./.open-next/worker.js";

const EDGE_EXACT_PATHS = new Set(["/script.js", "/collect", "/admin/ws", "/healthz"]);
const EDGE_PREFIX_PATHS = ["/api/private/", "/api/public/"];

function shouldRouteToEdge(pathname) {
  if (EDGE_EXACT_PATHS.has(pathname)) {
    return true;
  }
  for (const prefix of EDGE_PREFIX_PATHS) {
    if (pathname.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

export default {
  async fetch(request, env, ctx) {
    const pathname = new URL(request.url).pathname;
    if (shouldRouteToEdge(pathname)) {
      return edgeApp.fetch(request, env, ctx);
    }
    return nextWorker.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof edgeApp.scheduled === "function") {
      await edgeApp.scheduled(controller, env, ctx);
    }
  },
};

export { IngestDurableObject };

