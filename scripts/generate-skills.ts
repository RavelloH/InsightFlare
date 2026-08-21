#!/usr/bin/env tsx

import { readFileSync, renameSync, writeFileSync } from "fs";
import { resolve } from "path";

import { apiV1RouteRegistry } from "@/lib/api-v1/route-registry";

import { createScriptLogger } from "./shared/logger";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT_PATH = resolve(ROOT, "docs/skills.json");
const rlog = createScriptLogger();

function writeAtomically(path: string, content: string): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, content, "utf8");
  renameSync(temporaryPath, path);
}

function getAppVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  return pkg.version;
}

function generate() {
  const analyticsRoutes = apiV1RouteRegistry.filter(
    (route) => route.path.includes("/analytics/") && route.method === "POST",
  );
  const manifest = {
    api: "InsightFlare Analytics API",
    version: getAppVersion(),
    description: "Privacy-focused web analytics platform.",
    baseUrl: "${baseUrl}",
    openapiUrl: "/.well-known/openapi.json",
    discovery: {
      root: "/api/v1",
      token: "/api/v1/token",
      capabilities: "/api/v1/capabilities",
      analyticsSchema: "/api/v1/sites/{siteId}/analytics/schema",
    },
    agentGuidance: {
      authentication: {
        required: true,
        instruction:
          "Use a user-provided API key as a Bearer token. Do not guess or fabricate credentials.",
      },
      defaultWorkflow: [
        "Call GET /api/v1/token to inspect the token.",
        "Call GET /api/v1/sites to list accessible sites.",
        "Call GET /api/v1/sites/{siteId}/analytics/schema before advanced analytics.",
        "Use typed POST analytics routes with a JSON body for overview, timeseries, breakdowns, and detail reads.",
        "Use the route registry and analytics schema to discover supported operations and filters.",
        "Use batch only for explicitly batch-eligible read operations.",
      ],
      timeRanges: {
        format:
          "{ kind: 'absolute', from, to } or { kind: 'preset', preset, timeZone }",
        semantics: "[from, to)",
        default:
          "If from, to, and preset are omitted, analytics endpoints default to the last 7 days ending at request time. The default timeZone is UTC.",
        presets: [
          "today",
          "yesterday",
          "last_7_days",
          "last_30_days",
          "this_week",
          "last_week",
          "this_month",
          "last_month",
        ],
      },
      filters:
        "Use the typed filter expression in the JSON body. Call analyticsSchema to discover supported fields.",
    },
    typedAnalyticsOperations: analyticsRoutes.map((route) => ({
      operationId: "operationId" in route ? route.operationId : route.id,
      method: route.method,
      path: route.path,
    })),
    taskRecipes: [
      {
        intent: "traffic_overview",
        description: "Summarize traffic for a site over a time range.",
        calls: [
          "POST /api/v1/sites/{siteId}/analytics/overview",
          "POST /api/v1/sites/{siteId}/analytics/timeseries",
        ],
      },
      {
        intent: "traffic_drop_analysis",
        description: "Find likely causes of a traffic drop.",
        calls: [
          "POST /api/v1/sites/{siteId}/analytics/timeseries",
          "POST /api/v1/sites/{siteId}/analytics/breakdowns/{dimension}",
        ],
      },
      {
        intent: "performance_analysis",
        description:
          "Analyze Core Web Vitals and identify weak pages or regions.",
        calls: [
          "POST /api/v1/sites/{siteId}/analytics/performance/summary",
          "POST /api/v1/sites/{siteId}/analytics/performance/timeseries",
          "POST /api/v1/sites/{siteId}/analytics/performance/breakdowns/{dimension}",
        ],
      },
      {
        intent: "custom_event_analysis",
        description: "Analyze custom events and event payload fields.",
        calls: [
          "POST /api/v1/sites/{siteId}/analytics/event-types",
          "POST /api/v1/sites/{siteId}/analytics/events/summary",
          "POST /api/v1/sites/{siteId}/analytics/events/timeseries",
          "POST /api/v1/sites/{siteId}/analytics/events/search",
        ],
      },
    ],
    errorHandling: {
      "400":
        "Check request parameters or JSON body against the OpenAPI schema.",
      "401": "Ask the user to provide a valid API key.",
      "403": "Explain that the API key lacks the required scope.",
      "404": "Treat inaccessible sites as not found.",
      "409": "Explain the conflict and ask the user for a different value.",
      "413": "Reduce the request body size or number of batched items.",
      "500":
        "Retry later or report that the service returned an internal error.",
    },
  };

  writeAtomically(OUTPUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  rlog.success(`Generated ${OUTPUT_PATH}`);
}

generate();
