<div align="center">

# InsightFlare

### Own your analytics. Run it on Cloudflare.

Privacy-aware, open-source web analytics with real-time insights, user journeys, funnels, and AI-agent access — on infrastructure you control.

[**Live demo**](https://insight-demo.ravelloh.com/) &nbsp;·&nbsp; [**Deploy to Cloudflare**](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FRavelloH%2FInsightFlare) &nbsp;·&nbsp; [**Source code**](https://github.com/RavelloH/InsightFlare)

[![GitHub stars](https://img.shields.io/github/stars/RavelloH/InsightFlare?style=flat-square&logo=github)](https://github.com/RavelloH/InsightFlare/stargazers) [![Latest release](https://img.shields.io/github/v/release/RavelloH/InsightFlare?style=flat-square)](https://github.com/RavelloH/InsightFlare/releases) [![License: MIT](https://img.shields.io/github/license/RavelloH/InsightFlare?style=flat-square)](/LICENSE)

<!-- auto-readme-i18n-switcher start -->
| English | [日本語](/.github/readme/README.ja.md) | [中文（台灣）](/.github/readme/README.zh-tw.md) | [中文](/.github/readme/README.zh.md) |
<!-- auto-readme-i18n-switcher end -->

</div>

<a href="https://insight-demo.ravelloh.com/"><img src="/.github/screenshot/001.webp" alt="InsightFlare analytics dashboard" width="100%"></a>

## Why InsightFlare?

Go beyond pageview counts without outsourcing your analytics. InsightFlare runs on your own Cloudflare account and brings website traffic, user behavior, and operational visibility together in one dashboard.

- **Your infrastructure, your data.** Self-host on Cloudflare Workers with D1 and Durable Objects. No third-party analytics dashboard account required.
- **Understand what visitors do.** Inspect sessions, journeys, funnels, custom events, UTM campaigns, and traffic-source quality.
- **See what's happening now.** Follow real-time activity, site performance, geography, browsers, and devices.
- **Filter out the noise.** Investigate bots, abnormal requests, and the difference between traffic volume and useful visits.
- **Bring your AI agent.** Connect through the published Skills endpoint and scoped APIs to ask questions about your analytics.
- **Start small, grow as needed.** One-click deployment, multiple sites and teams, optional R2 archiving, and flexible configuration.

**Privacy & pricing:** The tracker is designed to be cookieless and does not store raw IP addresses. Regulatory requirements and Cloudflare usage costs depend on your deployment, settings, traffic, and jurisdiction.

## Explore the dashboard

A few highlights from the live interface. Select any image for its full-size view.

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/004.webp"><img src="/.github/screenshot/004.webp" alt="Real-time activity" width="100%"><br><strong>Real-time activity</strong></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/018.webp"><img src="/.github/screenshot/018.webp" alt="Visitor sessions" width="100%"><br><strong>Visitor sessions</strong></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/054.webp"><img src="/.github/screenshot/054.webp" alt="Event funnels" width="100%"><br><strong>Event funnels</strong></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/010.webp"><img src="/.github/screenshot/010.webp" alt="Traffic sources" width="100%"><br><strong>Traffic sources</strong></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/026.webp"><img src="/.github/screenshot/026.webp" alt="Geography" width="100%"><br><strong>Geography</strong></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/058.webp"><img src="/.github/screenshot/058.webp" alt="Bot observability" width="100%"><br><strong>Bot observability</strong></a></td>
  </tr>
</table>

## Feature gallery

Browse the real interface below. Screenshots are grouped by task, and each thumbnail opens the full-size image.

### Traffic overview & acquisition

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/001.webp"><img src="/.github/screenshot/001.webp" width="100%" alt="Comprehensive Traffic Dimension Tracking" title="Comprehensive Traffic Dimension Tracking"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/002.webp"><img src="/.github/screenshot/002.webp" width="100%" alt="Comprehensive Traffic Dimension Tracking" title="Comprehensive Traffic Dimension Tracking"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/003.webp"><img src="/.github/screenshot/003.webp" width="100%" alt="Comprehensive Traffic Dimension Tracking" title="Comprehensive Traffic Dimension Tracking"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/004.webp"><img src="/.github/screenshot/004.webp" width="100%" alt="Real-Time Visitor Monitoring" title="Real-Time Visitor Monitoring"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/005.webp"><img src="/.github/screenshot/005.webp" width="100%" alt="Real-Time Visitor Monitoring" title="Real-Time Visitor Monitoring"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/006.webp"><img src="/.github/screenshot/006.webp" width="100%" alt="Page-Level Traffic Analytics" title="Page-Level Traffic Analytics"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/007.webp"><img src="/.github/screenshot/007.webp" width="100%" alt="Track Real Visitor Performance" title="Track Real Visitor Performance"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/008.webp"><img src="/.github/screenshot/008.webp" width="100%" alt="Track Real Visitor Performance" title="Track Real Visitor Performance"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/009.webp"><img src="/.github/screenshot/009.webp" width="100%" alt="Track Real Visitor Performance" title="Track Real Visitor Performance"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/010.webp"><img src="/.github/screenshot/010.webp" width="100%" alt="Compare Traffic Quality Across Sources" title="Compare Traffic Quality Across Sources"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/011.webp"><img src="/.github/screenshot/011.webp" width="100%" alt="Compare Traffic Quality Across Sources" title="Compare Traffic Quality Across Sources"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/012.webp"><img src="/.github/screenshot/012.webp" width="100%" alt="Compare Traffic Quality Across Sources" title="Compare Traffic Quality Across Sources"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/013.webp"><img src="/.github/screenshot/013.webp" width="100%" alt="Track UTM Campaign Performance" title="Track UTM Campaign Performance"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/014.webp"><img src="/.github/screenshot/014.webp" width="100%" alt="Track UTM Campaign Performance" title="Track UTM Campaign Performance"></a></td>
    <td width="33%"></td>
  </tr>
</table>

### Events, sessions & visitor journeys

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/015.webp"><img src="/.github/screenshot/015.webp" width="100%" alt="Record and Analyze Custom Events" title="Record and Analyze Custom Events"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/016.webp"><img src="/.github/screenshot/016.webp" width="100%" alt="Record and Analyze Custom Events" title="Record and Analyze Custom Events"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/017.webp"><img src="/.github/screenshot/017.webp" width="100%" alt="Record and Analyze Custom Events" title="Record and Analyze Custom Events"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/018.webp"><img src="/.github/screenshot/018.webp" width="100%" alt="Inspect Every Session" title="Inspect Every Session"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/019.webp"><img src="/.github/screenshot/019.webp" width="100%" alt="Inspect Every Session" title="Inspect Every Session"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/020.webp"><img src="/.github/screenshot/020.webp" width="100%" alt="Inspect Every Session" title="Inspect Every Session"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/021.webp"><img src="/.github/screenshot/021.webp" width="100%" alt="Inspect Every Session" title="Inspect Every Session"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/022.webp"><img src="/.github/screenshot/022.webp" width="100%" alt="Understand Every Visitor" title="Understand Every Visitor"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/023.webp"><img src="/.github/screenshot/023.webp" width="100%" alt="Understand Every Visitor" title="Understand Every Visitor"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/024.webp"><img src="/.github/screenshot/024.webp" width="100%" alt="Track Return Visits" title="Track Return Visits"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/025.webp"><img src="/.github/screenshot/025.webp" width="100%" alt="Track Return Visits" title="Track Return Visits"></a></td>
    <td width="33%"></td>
  </tr>
</table>

### Audience, devices & geography

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/026.webp"><img src="/.github/screenshot/026.webp" width="100%" alt="Understand Geographic Distribution and Market Intelligence" title="Understand Geographic Distribution and Market Intelligence"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/027.webp"><img src="/.github/screenshot/027.webp" width="100%" alt="Understand Geographic Distribution and Market Intelligence" title="Understand Geographic Distribution and Market Intelligence"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/028.webp"><img src="/.github/screenshot/028.webp" width="100%" alt="Understand Geographic Distribution and Market Intelligence" title="Understand Geographic Distribution and Market Intelligence"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/029.webp"><img src="/.github/screenshot/029.webp" width="100%" alt="View Visitor Device Details" title="View Visitor Device Details"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/030.webp"><img src="/.github/screenshot/030.webp" width="100%" alt="View Visitor Device Details" title="View Visitor Device Details"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/031.webp"><img src="/.github/screenshot/031.webp" width="100%" alt="View Visitor Device Details" title="View Visitor Device Details"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/032.webp"><img src="/.github/screenshot/032.webp" width="100%" alt="Understand Browsers and Their Capabilities" title="Understand Browsers and Their Capabilities"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/033.webp"><img src="/.github/screenshot/033.webp" width="100%" alt="Understand Browsers and Their Capabilities" title="Understand Browsers and Their Capabilities"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/034.webp"><img src="/.github/screenshot/034.webp" width="100%" alt="Understand Browsers and Their Capabilities" title="Understand Browsers and Their Capabilities"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/035.webp"><img src="/.github/screenshot/035.webp" width="100%" alt="Understand Browsers and Their Capabilities" title="Understand Browsers and Their Capabilities"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/036.webp"><img src="/.github/screenshot/036.webp" width="100%" alt="Understand Browsers and Their Capabilities" title="Understand Browsers and Their Capabilities"></a></td>
    <td width="33%"></td>
  </tr>
</table>

### Configuration, teams & sharing

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/037.webp"><img src="/.github/screenshot/037.webp" width="100%" alt="Adjust Tracking Settings Anytime, Without Changing the Frontend SDK" title="Adjust Tracking Settings Anytime, Without Changing the Frontend SDK"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/038.webp"><img src="/.github/screenshot/038.webp" width="100%" alt="Adjust Tracking Settings Anytime, Without Changing the Frontend SDK" title="Adjust Tracking Settings Anytime, Without Changing the Frontend SDK"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/039.webp"><img src="/.github/screenshot/039.webp" width="100%" alt="Designed for Team Collaboration" title="Designed for Team Collaboration"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/040.webp"><img src="/.github/screenshot/040.webp" width="100%" alt="Designed for Team Collaboration" title="Designed for Team Collaboration"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/041.webp"><img src="/.github/screenshot/041.webp" width="100%" alt="Understand System Health at a Glance" title="Understand System Health at a Glance"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/042.webp"><img src="/.github/screenshot/042.webp" width="100%" alt="Understand System Health at a Glance" title="Understand System Health at a Glance"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/043.webp"><img src="/.github/screenshot/043.webp" width="100%" alt="Complete Multilingual Translation" title="Complete Multilingual Translation"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/044.webp"><img src="/.github/screenshot/044.webp" width="100%" alt="Complete Multilingual Translation" title="Complete Multilingual Translation"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/045.webp"><img src="/.github/screenshot/045.webp" width="100%" alt="Public Sharing System" title="Public Sharing System"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/046.webp"><img src="/.github/screenshot/046.webp" width="100%" alt="Public Sharing System" title="Public Sharing System"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/047.webp"><img src="/.github/screenshot/047.webp" width="100%" alt="Clearly Scoped API System" title="Clearly Scoped API System"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/048.webp"><img src="/.github/screenshot/048.webp" width="100%" alt="Scheduled Tasks" title="Scheduled Tasks"></a></td>
  </tr>
</table>

### Deep event analysis & funnels

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/049.webp"><img src="/.github/screenshot/049.webp" width="100%" alt="Deep Analysis for JSON Custom Events" title="Deep Analysis for JSON Custom Events"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/050.webp"><img src="/.github/screenshot/050.webp" width="100%" alt="Deep Analysis for JSON Custom Events" title="Deep Analysis for JSON Custom Events"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/051.webp"><img src="/.github/screenshot/051.webp" width="100%" alt="Deep Analysis for JSON Custom Events" title="Deep Analysis for JSON Custom Events"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/052.webp"><img src="/.github/screenshot/052.webp" width="100%" alt="Deep Analysis for JSON Custom Events" title="Deep Analysis for JSON Custom Events"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/053.webp"><img src="/.github/screenshot/053.webp" width="100%" alt="Deep Analysis for JSON Custom Events" title="Deep Analysis for JSON Custom Events"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/054.webp"><img src="/.github/screenshot/054.webp" width="100%" alt="Analyze Visits and Events with Funnels" title="Analyze Visits and Events with Funnels"></a></td>
  </tr>
</table>

### Operations, alerts & bot protection

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/055.webp"><img src="/.github/screenshot/055.webp" width="100%" alt="Receive Scheduled or Conditional Email Notifications" title="Receive Scheduled or Conditional Email Notifications"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/056.webp"><img src="/.github/screenshot/056.webp" width="100%" alt="Receive Scheduled or Conditional Email Notifications" title="Receive Scheduled or Conditional Email Notifications"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/057.webp"><img src="/.github/screenshot/057.webp" width="100%" alt="Receive Scheduled or Conditional Email Notifications" title="Receive Scheduled or Conditional Email Notifications"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/058.webp"><img src="/.github/screenshot/058.webp" width="100%" alt="Multi-Dimensional Bot Protection and Request Observation" title="Multi-Dimensional Bot Protection and Request Observation"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/059.webp"><img src="/.github/screenshot/059.webp" width="100%" alt="Multi-Dimensional Bot Protection and Request Observation" title="Multi-Dimensional Bot Protection and Request Observation"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/060.webp"><img src="/.github/screenshot/060.webp" width="100%" alt="Multi-Dimensional Bot Protection and Request Observation" title="Multi-Dimensional Bot Protection and Request Observation"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/061.webp"><img src="/.github/screenshot/061.webp" width="100%" alt="Multi-Dimensional Bot Protection and Request Observation" title="Multi-Dimensional Bot Protection and Request Observation"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/062.webp"><img src="/.github/screenshot/062.webp" width="100%" alt="Multi-Dimensional Bot Protection and Request Observation" title="Multi-Dimensional Bot Protection and Request Observation"></a></td>
    <td width="33%"></td>
  </tr>
</table>

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

---

## Advanced Configuration

### Enable Analytics Engine for Deep Analysis

Analytics Engine is InsightFlare's optional high-throughput analytical layer. It keeps request observability and future traffic/event projections separate from the primary database:

- `REQUEST_ANALYTICS` → request observation and abnormal traffic
- `TRAFFIC_ANALYTICS` → sampled traffic facts
- `EVENT_ANALYTICS` → sampled custom-event facts

This requires enabling Analytics Engine manually. Open the [Cloudflare Dashboard](https://dash.cloudflare.com/?to=/:account/workers/analytics-engine) and click the "Enable" button on the right. After that, InsightFlare will automatically bind Analytics Engine to your Cloudflare account during deployment.

Once enabled, InsightFlare writes the three datasets above. The current version uses the new `REQUEST_ANALYTICS` dataset for the Request Observation page; the Traffic and Event datasets are accumulated for future Analytics Engine providers. Reading the datasets requires an API Token. In system settings, enter your Cloudflare Account ID and an API Token with the "Account Analytics" read permission. Reader configuration remains in the primary D1 database. See the "Guide" button in the InsightFlare dashboard settings page for details.

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

#### Identify Users

Associate the current visit with a signed-in user without changing the anonymous visitor boundary:

```html
<script>
  window.insightflare.identify("user-123", { name: "Alice" });
</script>
```

Call `identify` after sign-in so the current and subsequent visits can be analyzed together. Calling it before the first page view is also supported. On logout, call `reset()` to end the current identity, create a new anonymous visitor boundary, and prevent later events from inheriting the old account:

```js
window.insightflare.reset();
window.insightflare.identify("user-456", { name: "Bob" });
```

Use `reset()` before switching accounts. Calling `identify("user-456")` alone does not create a new visitor boundary.

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

```

## Tech Stack

| Layer    | Technologies                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Frontend | TanStack Start 1, TanStack Router, Vite 8, React 19, Tailwind CSS 4, Radix UI, shadcn, Recharts, deck.gl, maplibre-gl, Motion |
| Backend  | Cloudflare Workers, Durable Objects, D1, R2, KV                                                                               |
| Build    | Cloudflare Vite Plugin, Wrangler 4, TypeScript 5                                                                              |

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
2. Install dependencies: `pnpm install`
3. Create the local database: `pnpm run db:migrate:local`
4. Set environment variables by referring to `.dev.vars.example`
5. Start the development server: `pnpm run dev`

`pnpm run dev:ui` starts the Vite development server in Demo Mode and uses frontend mock data for UI testing. To enable Demo Mode with `pnpm run dev`, set `DEMO_MODE=1`.

## Common Commands

| Command                                       | Purpose                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm run dev`                                 | Vite + Cloudflare Workers local development (use `http://localhost:3000`)     |
| `pnpm run dev:ui`                              | Start the Vite dashboard development server in Demo Mode                      |
| `pnpm run preview:local`                       | Build with local resources and run Wrangler preview                           |
| `pnpm run build`                               | Cloudflare managed build entrypoint                                           |
| `pnpm run build:local`                         | Local precheck + local D1 migration + build                                   |
| `pnpm run build:demo`                          | Demo build without resource bindings                                          |
| `pnpm run deploy`                              | Cloudflare managed deploy entrypoint                                          |
| `pnpm run publish`                             | Build and publish from an allowed Cloudflare environment                      |
| `pnpm run publish:demo`                        | Build and publish the demo Worker                                             |
| `pnpm run check`                               | Auto-fix format/lint, then run build + typecheck + i18n + tests + spec checks |
| `pnpm run check:verify`                        | Run the full check suite without automatic fixes                              |
| `pnpm run typecheck`                           | TypeScript type checking                                                      |
| `pnpm run lint` / `lint:fix`                   | ESLint                                                                        |
| `pnpm run format` / `format:check`             | Prettier                                                                      |
| `pnpm run check:i18n`                          | Validate translation key completeness                                         |
| `pnpm run db:migrate:local`                    | Local D1 migration                                                            |
| `pnpm run db:migrate:cf`                       | Cloudflare D1 migration                                                       |
| `pnpm run db:migration:create`                 | Create a new migration file                                                   |
| `pnpm run ops:secret:main`                     | Set the `MAIN_SECRET` Worker secret                                           |
| `pnpm run ops:secret:bootstrap-admin-password` | Set the bootstrap admin password secret                                       |
| `pnpm run ops:tail`                            | View online Worker logs                                                       |

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
