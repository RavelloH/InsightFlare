import nextWorker from "../.open-next/worker.js";
import { runHourlyAggregation } from "../src/lib/edge/hourly-rollup";
import { IngestDurableObject as BaseIngestDurableObject } from "../src/lib/edge/ingest-do";
import { getScheduledTaskDefinition } from "../src/lib/edge/scheduled-task-registry";
import { runScheduledTask } from "../src/lib/edge/scheduled-task-runner";
import apiApp from "../src/lib/hono/app";
import { shouldUseHono } from "../src/lib/hono/path-match";

export class IngestDurableObject extends BaseIngestDurableObject {}

function shouldSkipScheduledTasks(env) {
  return env.DISABLE_CRON_TASKS === "1" || env.NEXT_PUBLIC_DEMO_MODE === "1";
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (shouldUseHono(url.pathname)) {
      return apiApp.fetch(request, env, ctx);
    }
    return nextWorker.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (shouldSkipScheduledTasks(env)) {
      console.info(
        JSON.stringify({
          event: "scheduled_tasks_skipped",
          reason: "disabled_by_environment",
        }),
      );
      return;
    }
    const task = getScheduledTaskDefinition("visit_hourly_rollup");
    ctx.waitUntil(
      runScheduledTask(
        env,
        {
          key: task?.key || "visit_hourly_rollup",
          name: task?.name || "Hourly visit aggregation",
          triggerType: "cron",
        },
        controller.scheduledTime,
        ({ logger }) =>
          runHourlyAggregation(env, controller.scheduledTime, { logger }),
      ),
    );
  },
};
