<div align="center">

<a href="https://insightflare.net/en?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=website&amp;utm_content=readme_logo"><img src="/public/icon-1024.png" alt="InsightFlare" width="88"></a>

# InsightFlare

### Light as web analytics. Deep as product analytics.

A script under 4 KB brings traffic, visitor journeys, funnels, retention and behavior-based audiences into one dashboard. Deploy on your own Cloudflare account, without maintaining servers.

[Website](https://insightflare.net/en?utm_source=github&utm_medium=referral&utm_campaign=website&utm_content=readme_header) · [Documentation](https://insightflare.net/en/docs?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_header) · [Live demo](https://demo.insightflare.net/en/app/xeoos-team/dailypulse-news?utm_source=github&utm_medium=referral&utm_campaign=demo&utm_content=readme_header)

[![Deploy InsightFlare to Cloudflare](/.github/readme/deploy-insightflare.svg)](https://deploy.insightflare.net/en?utm_source=github&utm_medium=referral&utm_campaign=deploy&utm_content=readme_hero)

[![GitHub stars](https://img.shields.io/github/stars/RavelloH/InsightFlare?style=flat-square&logo=github)](https://github.com/RavelloH/InsightFlare/stargazers) [![Latest release](https://img.shields.io/github/v/release/RavelloH/InsightFlare?style=flat-square)](https://github.com/RavelloH/InsightFlare/releases) [![License: MIT](https://img.shields.io/github/license/RavelloH/InsightFlare?style=flat-square)](/LICENSE)

<!-- auto-readme-i18n-switcher start -->
| English | [日本語](/.github/readme/README.ja.md) | [中文（台灣）](/.github/readme/README.zh-tw.md) | [中文](/.github/readme/README.zh.md) |
<!-- auto-readme-i18n-switcher end -->

</div>

<a href="https://demo.insightflare.net/en/app/xeoos-team/dailypulse-news?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=demo&amp;utm_content=readme_screenshot"><img src="/.github/screenshot/001.webp" alt="InsightFlare dashboard" width="100%"></a>

| **&lt; 4 KB** | ```mermaid
flowchart TD
  B["Visitor browser"] --> W
  subgraph CF["Cloudflare"]
    W["Workers: collection, dashboard, API"] --> DO["Durable Objects: buffer, real time"]
    DO --> D1["D1: analytics and queries"]
    W --> D1
    W --> KV["KV: site settings"]
    W -.-> AE["Analytics Engine: observation (optional)"]
    W -.-> R2["R2: archive (optional)"]
  end
  U["You and your agents"] --> W
```

**10,000+** | **$0** |
| :---: | :---: | :---: |
| Tracking script | Daily events on a free account (tested) | Software license fee |

## Why InsightFlare?

- **Your infrastructure, your data.** Self-host on your own Cloudflare account.
- **Deep product analytics.** Funnels, retention, custom events and behavioral filters, without per-event or per-seat software fees.
- **Lightweight and edge-native.** A tracker under 4 KB and automatically scaling Workers.
- **Privacy-aware.** Cookieless tracking and configurable visitor identification.
- **Agent-ready.** Published Skills, versioned OpenAPI and scoped API keys.
- **Open source.** MIT licensed, with no paid feature gates in the self-hosted software.

## Quick start

Install the latest official build without forking, compiling or installing Wrangler.

[![Deploy InsightFlare to Cloudflare](/.github/readme/deploy-insightflare.svg)](https://deploy.insightflare.net/en?utm_source=github&utm_medium=referral&utm_campaign=deploy&utm_content=readme_quick_start)

1. Connect to Cloudflare, select an account and review the deployment plan.
2. Choose an address and administrator password, then install.
3. Sign in, create a site and paste its tracking snippet into your pages.
4. Visit your site and confirm activity in the real-time view.

[Quick start](https://insightflare.net/en/docs/getting-started/quick-start?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) · [Manual deployment](https://insightflare.net/en/docs/deployment/manual-deployment?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide)

## Explore features

<table>
  <tr>
    <td width="50%" valign="top"><a href="https://insightflare.net/en/features?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=features&amp;utm_content=readme_traffic"><img src="/.github/screenshot/004.webp" alt="Traffic &amp; acquisition" width="100%"><br><strong>Traffic &amp; acquisition</strong></a><br>Live traffic, pages, referrers and campaigns.</td>
    <td width="50%" valign="top"><a href="https://insightflare.net/en/features?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=features&amp;utm_content=readme_journeys"><img src="/.github/screenshot/018.webp" alt="Sessions &amp; visitor journeys" width="100%"><br><strong>Sessions &amp; visitor journeys</strong></a><br>Trace visits and custom events.</td>
  </tr>
  <tr>
    <td width="50%" valign="top"><a href="https://insightflare.net/en/features/funnels?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=features&amp;utm_content=readme_funnels"><img src="/.github/screenshot/054.webp" alt="Funnels &amp; goals" width="100%"><br><strong>Funnels &amp; goals</strong></a><br>Find drop-off by session or visitor.</td>
    <td width="50%" valign="top"><a href="https://insightflare.net/en/features/retention?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=features&amp;utm_content=readme_retention"><img src="/.github/screenshot/024.webp" alt="Retention" width="100%"><br><strong>Retention</strong></a><br>See who returns, grouped by first visit.</td>
  </tr>
  <tr>
    <td width="50%" valign="top"><a href="https://insightflare.net/en/features/filters?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=features&amp;utm_content=readme_filters"><img src="/.github/screenshot/049.webp" alt="Custom event analysis" width="100%"><br><strong>Advanced filters & custom events</strong></a><br>Describe audiences by behavior, attributes and sequence.</td>
    <td width="50%" valign="top"><a href="https://insightflare.net/en/features/experience?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=features&amp;utm_content=readme_experience"><img src="/.github/screenshot/007.webp" alt="Real user experience" width="100%"><br><strong>Real user experience</strong></a><br>Core Web Vitals, browsers and devices.</td>
  </tr>
  <tr>
    <td width="50%" valign="top"><a href="https://insightflare.net/en/features/geo?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=features&amp;utm_content=readme_geo"><img src="/.github/screenshot/026.webp" alt="Geo intelligence" width="100%"><br><strong>Geo intelligence</strong></a><br>Drill down from countries to cities.</td>
    <td width="50%" valign="top"><a href="https://insightflare.net/en/features/operations?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=features&amp;utm_content=readme_operations"><img src="/.github/screenshot/058.webp" alt="Observability &amp; protection" width="100%"><br><strong>Observability &amp; protection</strong></a><br>Request observation, bot rules and operational visibility.</td>
  </tr>
</table>

[Explore all features](https://insightflare.net/en/features?utm_source=github&utm_medium=referral&utm_campaign=features&utm_content=readme_gallery)

<details>
<summary>Full feature gallery (62 screenshots)</summary>

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

</details>

## AI agents & API

Let Claude Code, Codex, OpenClaw or your own tools explore analytics through published Skills and scoped API keys. Send your agent the instruction below, replacing the domain:

```text
Read https://your-instance.example.com/.well-known/skills.json, connect to this analytics system, and guide me through authorization.
```

> **Which device converts better from pricing to deployment, and where do mobile visitors drop off?**
>
> An agent can compare device funnels, inspect performance and traffic sources, and save a funnel for later comparison with the appropriate permissions.

[Agent access](https://insightflare.net/en/docs/ai-and-api/connect-an-agent?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) · [API reference](https://insightflare.net/en/docs/api?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide)

## Self-hosting & cost

InsightFlare runs on Cloudflare Workers, Durable Objects, D1 and KV. Analytics Engine and R2 are optional. Writes are buffered and batched; the edge network serves collection and dashboards.

**10,000+ events per day on a free Cloudflare account**, as reported by our website's test. Actual capacity depends on traffic, query frequency, data size and plan limits; this is not a guarantee. InsightFlare has no software fee, but Cloudflare usage may incur charges.

[Deployment, architecture & cost](https://insightflare.net/en/self-hosting?utm_source=github&utm_medium=referral&utm_campaign=website&utm_content=readme_cost)

## Privacy & data ownership

The tracker does not set or read cookies. Raw IP addresses are not stored with normal visitor records; when Analytics Engine is enabled, IPs of requests classified as bots and blocked may be recorded for investigation. Compliance depends on deployment, settings and applicable law.

[Cost & privacy](https://insightflare.net/en/docs/getting-started/cost-and-privacy?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) · [Visitor identification](https://insightflare.net/en/docs/tracking/privacy?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide)

## Documentation

| | |
| --- | --- |
| **Getting started** | [Quick start](https://insightflare.net/en/docs/getting-started/quick-start?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) · [Install tracking](https://insightflare.net/en/docs/tracking?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) · [Cost & privacy](https://insightflare.net/en/docs/getting-started/cost-and-privacy?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) |
| **Analytics** | [Advanced filters](https://insightflare.net/en/docs/usage/filters?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) · [Funnels & goals](https://insightflare.net/en/docs/usage/funnels-and-goals?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) · [Retention](https://insightflare.net/en/docs/usage/retention?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) |
| **Tracking** | [Custom events](https://insightflare.net/en/docs/tracking/custom-events?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) · [Identify users](https://insightflare.net/en/docs/tracking/identify?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) · [Tracking settings](https://insightflare.net/en/docs/tracking/tracking-settings?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) |
| **Deployment & operations** | [Updates](https://insightflare.net/en/docs/deployment/updating?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) · [Analytics Engine](https://insightflare.net/en/docs/deployment/analytics-engine?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) · [Manual deployment](https://insightflare.net/en/docs/deployment/manual-deployment?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) |
| **Integration & development** | [Agent access](https://insightflare.net/en/docs/ai-and-api/connect-an-agent?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) · [API reference](https://insightflare.net/en/docs/api?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) · [Local development](https://insightflare.net/en/docs/deployment/local-development?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) |

[Configuration](https://insightflare.net/en/docs/reference/configuration?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) · [R2 archive](https://insightflare.net/en/docs/deployment/r2-archive?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) · [Commands](https://insightflare.net/en/docs/reference/commands?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) · [FAQ](https://insightflare.net/en/docs/reference/faq?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide)

## Development

**TypeScript · React · TanStack Start · Cloudflare Workers · D1 · Durable Objects**

Requires Node.js 24 and pnpm 10.33. Configure .dev.vars according to the local development guide.

```bash
git clone https://github.com/RavelloH/InsightFlare
cd InsightFlare
pnpm install
pnpm run db:migrate:local
cp .dev.vars.example .dev.vars
```

After configuring the environment, run:

```bash
pnpm run dev
```

For UI-only work, run `pnpm run dev:ui` in Demo Mode without a database or secrets.

[Local development](https://insightflare.net/en/docs/deployment/local-development?utm_source=github&utm_medium=referral&utm_campaign=docs&utm_content=readme_guide) · [Contributing guide](/CONTRIBUTING.md)

## Community & ecosystem

InsightFlare is supported by independent open-source projects maintained in the organization and by its author.

| | |
| --- | --- |
| [**Deploy**](https://github.com/InsightFlare/deploy) | One-click installation and updates. |
| [**asn-blocklist**](https://github.com/InsightFlare/asn-blocklist) | ASN classification from PeeringDB. |
| [**map-relay**](https://github.com/InsightFlare/map-relay) | CARTO vector basemap proxy. |
| [**can-i-use-api**](https://github.com/RavelloH/can-i-use-api) | Static Can I Use compatibility API. |
| [**iso-3166-2-locale**](https://github.com/RavelloH/iso-3166-2-locale) | Multilingual geographical names. |
| [**meta**](https://gist.github.com/RavelloH/08cdb1493d09d2ad1eb0cf17d06e3078) | Webpage metadata extraction (Gist). |

[Explore the open-source ecosystem](https://insightflare.net/en/open-source?utm_source=github&utm_medium=referral&utm_campaign=website&utm_content=readme_ecosystem)

[Organization](https://github.com/InsightFlare) · [Report an issue](https://github.com/RavelloH/InsightFlare/issues) · [Contributing guide](/CONTRIBUTING.md) · [Releases](https://github.com/RavelloH/InsightFlare/releases)

## License

[MIT](/LICENSE) Copyright 2026 RavelloH

---

<div align="center">

### Start understanding your audience.

[![Deploy InsightFlare to Cloudflare](/.github/readme/deploy-insightflare.svg)](https://deploy.insightflare.net/en?utm_source=github&utm_medium=referral&utm_campaign=deploy&utm_content=readme_footer)

[Website](https://insightflare.net/en?utm_source=github&utm_medium=referral&utm_campaign=website&utm_content=readme_footer) · [Live demo](https://demo.insightflare.net/en/app/xeoos-team/dailypulse-news?utm_source=github&utm_medium=referral&utm_campaign=demo&utm_content=readme_footer)

</div>
