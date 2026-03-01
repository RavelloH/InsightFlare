import { IngestDurableObject } from "./lib/edge/ingest-do";
import { runHourlyArchive } from "./lib/edge/archive";
import nextWorker from "./.open-next/worker.js";

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

    const response = await nextWorker.fetch(request, env, ctx);
    const location = response.headers.get("location");
    if (!location || request.method !== "GET") {
      return response;
    }

    let target;
    try {
      target = new URL(location, url);
    } catch {
      return response;
    }

    const segments = pathname.split("/");
    const locale = segments[1] || "";
    const isLocaleAppPath = /^\/(en|zh)\/app(?:\/.*)?$/.test(pathname);
    const isSelfRedirect = target.pathname === pathname && target.search === url.search;

    // OpenNext can occasionally emit self-redirects on locale app routes.
    // Convert the loop into a recoverable login redirect.
    if (isLocaleAppPath && isSelfRedirect && (locale === "en" || locale === "zh")) {
      const recover = new URL(request.url);
      recover.pathname = `/${locale}/login`;
      recover.searchParams.set("error", "session_invalid");
      recover.searchParams.set("next", `${pathname}${url.search}`);
      return Response.redirect(recover.toString(), 307);
    }

    return response;
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runHourlyArchive(env, controller.scheduledTime));
  },
};

export { IngestDurableObject };
