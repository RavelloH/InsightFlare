import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({
  // Keep default OpenNext Cloudflare behavior; custom route orchestration
  // is done in `cf-worker.ts`.
});

