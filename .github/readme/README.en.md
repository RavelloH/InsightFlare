# InsightFlare

<!-- auto-readme-i18n-switcher start -->
| English | [中文](/.github/readme/README.zh.md) |
<!-- auto-readme-i18n-switcher end -->

> A powerful, privacy-friendly open source web analytics tool that runs entirely on Cloudflare.

Demo: [http://insight-demo.ravelloh.com](http://insight-demo.ravelloh.com/)

![ScreenShot](/.github/screenshot/001.webp)

Fully compliant with GDPR, with no cookies, so visits can be tracked legally without asking users for consent. Its original smart tracking intensity mechanism automatically adjusts visitor identifier persistence based on regional privacy regulations, balancing data integrity with privacy protection.

The frontend analytics SDK is only about 3 KB after gzip compression and is distributed through Cloudflare's global CDN for excellent performance. The SDK includes custom event tracking (`data-insightflare-event`) and performance metric tracking.

The multilingual dashboard uses unprecedented visualizations to give you a clear picture of traffic data. Its original multilingual place-name translation feature automatically translates more than 95% of place names worldwide, making it easy to understand where visitors come from.

Cloudflare's free quotas can support free tracking for 100,000 visits per day, with excellent performance from edge computing.

InsightFlare does not store raw IP information. It relies on Cloudflare for geolocation resolution, protecting user privacy while still providing highly accurate analytics.

---

## Quick Start

Just click the button below:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FRavelloH%2FInsightFlare)

Cloudflare will automatically clone this repository and create and bind the required resources. You need to fill in the following two secrets:

| Name                       | Purpose                                                                       |
| -------------------------- | -----------------------------------------------------------------------       |
| `MAIN_SECRET`              | Root secret used to derive visitor salts, session keys, and API key hash keys |
| `BOOTSTRAP_ADMIN_PASSWORD` | Initial administrator password                                                |

`MAIN_SECRET` is used for security-related features and must be a random string longer than 16 characters. You can generate one at [https://random.ravelloh.com/str/32](https://random.ravelloh.com/str/32). Refresh the page to get a new random string.

`BOOTSTRAP_ADMIN_PASSWORD` is the default administrator password. Sign in to the dashboard with the `admin` account and this password. You can change the username and password later on the personal settings page.

After filling in the variables, wait about 3 minutes for the deployment to finish. You can then sign in to the dashboard and start tracking traffic data. You can also customize the domain name on the project settings page. The default URL is `https://insightflare.<your-cloudflare-username>.workers.dev`.

## Features

### Comprehensive Traffic Dimension Tracking

![001](/.github/screenshot/001.webp)
![002](/.github/screenshot/002.webp)
![003](/.github/screenshot/003.webp)

### Real-Time Visitor Monitoring

![004](/.github/screenshot/004.webp)
![005](/.github/screenshot/005.webp)

### Page-Level Traffic Analytics

![006](/.github/screenshot/006.webp)

### Track Real Visitor Performance

![007](/.github/screenshot/007.webp)
![008](/.github/screenshot/008.webp)
![009](/.github/screenshot/009.webp)

### Compare Traffic Quality Across Sources

![010](/.github/screenshot/010.webp)
![011](/.github/screenshot/011.webp)
![012](/.github/screenshot/012.webp)

### Track UTM Campaign Performance

![013](/.github/screenshot/013.webp)
![014](/.github/screenshot/014.webp)

### Record and Analyze Custom Events

![015](/.github/screenshot/015.webp)
![016](/.github/screenshot/016.webp)
![017](/.github/screenshot/017.webp)

### Inspect Every Session

![018](/.github/screenshot/018.webp)
![019](/.github/screenshot/019.webp)
![020](/.github/screenshot/020.webp)
![021](/.github/screenshot/021.webp)

### Understand Every Visitor

![022](/.github/screenshot/022.webp)
![023](/.github/screenshot/023.webp)

### Track Return Visits

![024](/.github/screenshot/024.webp)
![025](/.github/screenshot/025.webp)

### Understand Geographic Distribution and Market Intelligence

![026](/.github/screenshot/026.webp)
![027](/.github/screenshot/027.webp)
![028](/.github/screenshot/028.webp)

### View Visitor Device Details

![029](/.github/screenshot/029.webp)
![030](/.github/screenshot/030.webp)
![031](/.github/screenshot/031.webp)

### Understand Browsers and Their Capabilities

![032](/.github/screenshot/032.webp)
![033](/.github/screenshot/033.webp)
![034](/.github/screenshot/034.webp)
![035](/.github/screenshot/035.webp)
![036](/.github/screenshot/036.webp)

### Adjust Tracking Settings Anytime, Without Changing the Frontend SDK

![037](/.github/screenshot/037.webp)
![038](/.github/screenshot/038.webp)

### Designed for Team Collaboration

![039](/.github/screenshot/039.webp)
![040](/.github/screenshot/040.webp)

### Understand System Health at a Glance

![041](/.github/screenshot/041.webp)
![042](/.github/screenshot/042.webp)

### Complete Multilingual Translation

![043](/.github/screenshot/043.webp)
![044](/.github/screenshot/044.webp)

---

## Advanced Configuration

### Connect AI Agents for Analysis

InsightFlare exposes Skills for AI Agents. You can connect your InsightFlare deployment to agents such as OpenClaw, Codex, Claude Code, and others, so they can access InsightFlare data directly for analysis and report generation.  
Send the following instruction to your Agent, replacing the domain with your deployed InsightFlare instance. Your Agent will guide you to the dashboard to create a dedicated API key for accessing InsightFlare data.

```txt
Read https://<your InsightFlare domain>/.well-known/skills.json, connect to this web analytics system, and guide me through authorization.
```

Then you can ask your Agent questions in natural language, for example:

```txt
"How did my site perform last month? Where did most visitors come from among the highest-traffic sites? Which pages were the most popular?"
```

### Override Wrangler Configuration with Cloudflare Variables

In Cloudflare build environments, you can use project variables and secrets to override deployment-specific values from `wrangler.toml`. `build:pre` reads these values before deployment, writes them into the active Wrangler config, and the following `wrangler deploy` uses the resolved config.

Common variables:

| Name                                       | Overrides                             |
| -------------------------------------      | ------------------------------------- |
| `INSIGHTFLARE_WORKER_NAME`                 | Worker name                           |
| `INSIGHTFLARE_D1_DATABASE`                 | D1 database name                      |
| `INSIGHTFLARE_D1_DATABASE_ID`              | D1 database ID for the `DB` binding   |
| `INSIGHTFLARE_SITE_SETTINGS_KV_ID`         | KV namespace ID for `SITE_SETTINGS_KV`|
| `INSIGHTFLARE_ARCHIVE_BUCKET_NAME`         | R2 bucket for `ARCHIVE_BUCKET`        |
| `INSIGHTFLARE_ARCHIVE_PREVIEW_BUCKET_NAME` | R2 preview bucket                     |
| `SESSION_WINDOW_MINUTES`                   | Session window in minutes             |
| `SCRIPT_CACHE_TTL_SECONDS`                 | `/script.js` CDN cache TTL            |
| `PARQUET_WASM_URL`                         | Parquet wasm URL                      |
| `INSIGHTFLARE_EDGE_URL`                    | InsightFlare service base URL         |

You can also write arbitrary `[vars]` entries with `INSIGHTFLARE_VAR_<NAME>`. For example, `INSIGHTFLARE_VAR_FEATURE_FLAG=1` becomes `FEATURE_FLAG = "1"`. When deploying with `--env production`, environment-specific names such as `INSIGHTFLARE_PRODUCTION_D1_DATABASE_ID` and `INSIGHTFLARE_PRODUCTION_VAR_INSIGHTFLARE_EDGE_URL` target `[env.production]`.

### Configure an R2 Bucket for Cold Archive

You only need to manually create an R2 bucket if you want to enable cold archive to R2. By default, traffic data is retained for 1 year. Expired data is compressed and retained so trends and data can still be viewed, but it cannot be filtered. R2 is optional, and the Deploy Button does not require an R2 binding by default. After R2 is enabled, you can run detailed queries on data older than 1 year.

Create a bucket named `insightflare-archive` in Cloudflare. Then uncomment `[[r2_buckets]]` in `wrangler.toml` as shown below:

```toml
[[r2_buckets]]
binding = "ARCHIVE_BUCKET"
bucket_name = "insightflare-archive"
preview_bucket_name = "insightflare-archive-preview"
```

### Stay Updated

InsightFlare includes a pioneering GitHub App based automatic update system to provide the simplest update experience.

Keeping your deployment updated only takes two steps:

1. Install the GitHub App for your repository. This is only required once. **Only select the repository where you deployed InsightFlare**: [Install InsightFlare Sync](https://github.com/apps/insightflare-sync/installations/new)
2. When upstream updates are available, a PR will be submitted to your repository automatically. You only need to merge that request.

_Want to make your own project easy to sync downstream? Implementation details: [RavelloH/upstream-sync-bot](https://github.com/RavelloH/upstream-sync-bot) (open source template) + [RavelloH/InsightFlare-Bot](https://github.com/RavelloH/InsightFlare-Bot) (this project's bot instance)._

### Custom Event Reporting

The InsightFlare frontend SDK supports reporting custom events either through manual calls or automatically through DOM attributes.

#### Manual Calls

```html
<script defer src="/script.js?siteId=YOUR_SITE_ID"></script>
<script>
  window.addEventListener("DOMContentLoaded", () => {
    window.insightflare.track("signup_click", {
      plan: "pro",
      source: "pricing",
    });
  });
</script>
```

Available methods:

- `track(eventName, eventData?)`: Report a custom event.
- `trackOnce(eventName, eventData?)`: Report the same event name only once during the current page lifecycle.
- `setGlobalProperties(props)`: Add shared properties to subsequent events.
- `clearGlobalProperties()`: Clear shared properties.

#### Automatic Reporting via DOM Attributes

```html
<!-- 1. Default click trigger -->
<button data-insightflare-event="signup_click">Sign up now</button>
<!-- This reports: { eventName: "signup_click" } -->

<!-- 2. Click trigger with extra fields through data-insightflare-event-* -->
<button
  data-insightflare-event="signup_click"
  data-insightflare-event-plan="pro"
  data-insightflare-event-source="pricing"
>
  Sign up now
</button>
<!-- This reports: { eventName: "signup_click", eventData: { plan: "pro", source: "pricing" } } -->

<!-- 3. Click trigger with JSON extra fields -->
<button
  data-insightflare-event="signup_click"
  data-insightflare-event-data='{"plan":"pro","source":"pricing"}'
>
  Sign up now
</button>
<!-- This reports: { eventName: "signup_click", eventData: { plan: "pro", source: "pricing" } } -->

<!-- 4. Form submit trigger -->
<form
  data-insightflare-event="contact_submit"
  data-insightflare-event-trigger="submit"
  data-insightflare-event-data='{"plan":"pro","source":"landing"}'
>
  ...
</form>

<!-- 5. Trigger once when an element enters the viewport -->
<section
  data-insightflare-event="pricing_viewed"
  data-insightflare-event-trigger="enterviewport"
  data-insightflare-event-plan="pro"
>
  ...
</section>
```

## Tech Stack

| Layer    | Technologies                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------- |
| Frontend | Next.js 16, React 19, Tailwind CSS 4, Radix UI, shadcn, Recharts, deck.gl, maplibre-gl, Motion |
| Backend  | Cloudflare Workers, Durable Objects, D1, R2, KV                                                |
| Build    | OpenNext for Cloudflare, Wrangler 4, TypeScript 5                                              |

---

## Manual Deployment

If you do not use the deploy button, deploy with the steps below:

1. Fork or clone this repository to your GitHub account
2. Create the following resources in Cloudflare:
   - D1 database
   - KV namespace
   - R2 bucket (optional, only required for cold archive to R2)
3. Edit `wrangler.toml` and bind the D1 and KV resources to the Worker
4. Fill in environment variables by referring to `.dev.vars.example`
5. Import this repository from the Worker page

### Local Development

1. Clone this repository locally: `git clone https://github.com/RavelloH/InsightFlare`
2. Install dependencies: `npm install`
3. Create the local database: `npm run d1:migrate:local`
4. Set environment variables by referring to `.dev.vars.example`
5. Start the development server: `npm run dev`

Set `NEXT_PUBLIC_DEMO_MODE=1` to make the development server automatically enable Demo Mode and use frontend mock data for UI testing.

## Common Commands

| Command                           | Purpose                                     |
| --------------------------------- | ------------------------------------------- |
| `npm run dev`                     | Local dashboard development                 |
| `npm run check`                   | Run typecheck + lint + format + i18n + tests + spec checks |
| `npm run typecheck`               | TypeScript type checking                    |
| `npm run lint` / `lint:fix`       | ESLint                                      |
| `npm run format` / `format:check` | Prettier                                    |
| `npm run check:i18n`              | Validate translation key completeness       |
| `npm run d1:migrate:local`        | Local D1 migration                          |
| `npm run d1:migrate:remote`       | Remote D1 migration                         |
| `npm run d1:migration:create`     | Create a new migration file                 |
| `npm run cf:tail`                 | View online Worker logs                     |

---

## Key Configuration

| Name                                | Meaning                                  |
| ----------------------------------- | ---------------------------------------- |
| `SESSION_WINDOW_MINUTES`            | Session window in minutes (default `30`) |
| `SCRIPT_CACHE_TTL_SECONDS`          | CDN cache TTL for `/script.js`           |
| `PARQUET_WASM_URL`                  | Parquet wasm download URL                |
| `INSIGHTFLARE_EDGE_URL`             | InsightFlare service base URL            |
| `MAIN_SECRET` (Secret)              | Root secret for derived security keys    |
| `BOOTSTRAP_ADMIN_PASSWORD` (Secret) | Initial administrator password           |
| `DAILY_SALT_SECRET` (Secret)        | Legacy fallback for `MAIN_SECRET`        |
| `DASHBOARD_SESSION_SECRET` (Secret) | Optional session signing override        |

---

## License

[MIT](/LICENSE) Copyright 2026 RavelloH
